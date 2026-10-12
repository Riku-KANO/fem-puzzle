#!/usr/bin/env node
// Performance gate (task T-204): runs the native and WASM solver benchmarks, compares them
// with docs/perf-budget.json and exits non-zero on a violation. `scripts/verify.sh full`
// runs it (after `pnpm build:wasm`).
//
//   node scripts/bench-gate.mjs              run both benches, check, print a table
//   node scripts/bench-gate.mjs --reuse      check the existing .artifacts/bench/*.json
//   node scripts/bench-gate.mjs --record     ... and store the results as the new baseline
//                                            in docs/perf-budget.json (only if they pass the
//                                            limits; regressions vs the old baseline are
//                                            accepted — that is what recording is for)
//   node scripts/bench-gate.mjs --markdown   also print the results as a Markdown table
//   --only native|wasm                       run / check one target only
//
// Checks (all from docs/perf-budget.json):
//   1. every timed solve converged to `tol`;
//   2. `requireMultigrid`: rows that request multigrid really ran it (solver levels > 0);
//   3. absolute `limits` (e.g. WASM warm carve on 40×12×12 ≤ 500 ms), on any machine;
//   4. regression vs `baseline`: iteration counts everywhere (deterministic), times only
//      when the CPU model equals the baseline's (other machines are not comparable).
// Exit codes: 0 pass, 1 budget violation, 2 harness error (bench failed to run, bad JSON).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// PERF_BUDGET=/path/budget.json overrides the budget file (testing the gate itself).
const BUDGET = process.env.PERF_BUDGET ? resolve(process.env.PERF_BUDGET) : join(ROOT, 'docs/perf-budget.json');
const OUT_DIR = join(ROOT, '.artifacts/bench');
const ARTIFACT = { native: join(OUT_DIR, 'native.json'), wasm: join(OUT_DIR, 'wasm.json') };
const PKG_WASM = join(ROOT, 'crates/fem-wasm/pkg/fem_wasm_bg.wasm');
const TARGETS = ['native', 'wasm'];

class HarnessError extends Error {}

function parseArgs(argv) {
  const a = { reuse: false, record: false, markdown: false, targets: TARGETS };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--reuse') a.reuse = true;
    else if (arg === '--record') a.record = true;
    else if (arg === '--markdown') a.markdown = true;
    else if (arg === '--only' || arg.startsWith('--only=')) {
      const v = arg.includes('=') ? arg.split('=')[1] : argv[++i];
      if (!TARGETS.includes(v)) throw new HarnessError(`--only: expected native|wasm, got ${v}`);
      a.targets = [v];
    } else if (arg === '-h' || arg === '--help') {
      const text = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
      console.log(text.slice(1, 21).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
      process.exit(0);
    } else throw new HarnessError(`unknown argument ${JSON.stringify(arg)}`);
  }
  return a;
}

// --- running the benches -------------------------------------------------------------------

function run(cmd, args, { capture = false } = {}) {
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 << 20,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'pipe'],
  });
  if (r.error) throw new HarnessError(`${cmd}: ${r.error.message}`);
  return r;
}

function newestMtime(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs);
  }
  return newest;
}

/** Warn when the wasm package is older than the Rust sources it is built from. */
function wasmStaleness() {
  const sources = ['crates/fem/src', 'crates/fem-wasm/src', 'crates/stage/src']
    .map((d) => join(ROOT, d))
    .filter(existsSync)
    .map(newestMtime);
  const src = Math.max(...sources, statSync(join(ROOT, 'Cargo.lock')).mtimeMs);
  return statSync(PKG_WASM).mtimeMs < src;
}

function runNative() {
  console.log('perf-gate: native bench (cargo run -p fem-bench --release -- --json) …');
  const r = run('cargo', ['run', '--quiet', '-p', 'fem-bench', '--release', '--', '--json'], { capture: true });
  writeFileSync(join(OUT_DIR, 'native.log'), r.stderr ?? '');
  if (r.status !== 0 && !r.stdout?.trim().startsWith('{')) {
    process.stderr.write((r.stderr ?? '').split('\n').slice(-30).join('\n'));
    throw new HarnessError(`fem-bench exited with ${r.status} (log: .artifacts/bench/native.log)`);
  }
  writeFileSync(ARTIFACT.native, r.stdout);
}

function runWasm() {
  if (!existsSync(PKG_WASM))
    throw new HarnessError('crates/fem-wasm/pkg is missing — run `pnpm build:wasm` first');
  if (wasmStaleness())
    console.log('perf-gate: WARNING crates/fem-wasm/pkg is older than the Rust sources — run `pnpm build:wasm`');
  console.log('perf-gate: wasm bench (node scripts/bench-wasm.mjs) …');
  const r = run(process.execPath, [join(ROOT, 'scripts/bench-wasm.mjs'), '--quiet', '--out', ARTIFACT.wasm], {
    capture: true,
  });
  writeFileSync(join(OUT_DIR, 'wasm.log'), `${r.stdout ?? ''}${r.stderr ?? ''}`);
  // Exit 1 = ran but something did not converge (checked below); anything else is a crash.
  if (r.status !== 0 && r.status !== 1) {
    process.stderr.write((r.stderr ?? '').split('\n').slice(-30).join('\n'));
    throw new HarnessError(`bench-wasm exited with ${r.status} (log: .artifacts/bench/wasm.log)`);
  }
}

function readReport(target) {
  const file = ARTIFACT[target];
  if (!existsSync(file)) throw new HarnessError(`${relative(ROOT, file)} missing (run without --reuse)`);
  let report;
  try {
    report = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new HarnessError(`${relative(ROOT, file)}: ${e.message}`);
  }
  if (report.schema !== 1 || report.target !== target || !Array.isArray(report.results))
    throw new HarnessError(`${relative(ROOT, file)}: not a schema-1 ${target} bench report`);
  return report;
}

// --- checks ------------------------------------------------------------------------------

const key = (target, grid, precond) => `${target} ${grid} ${precond}`;
/** Derived metrics on top of what the benches report. */
const metric = (row, name) => (name === 'loadMs' ? row.setupMs + row.coldMs : row[name]);

function evaluate(budget, reports) {
  const rows = new Map();
  for (const rep of reports) for (const r of rep.results) rows.set(key(rep.target, r.grid, r.requested), { ...r, target: rep.target });
  const failures = []; // hard: convergence, multigrid, limits, config
  const regressions = []; // vs the recorded baseline (acceptable with --record)
  const notes = [];
  const checked = new Set(reports.map((r) => r.target));

  if (budget.tol !== undefined)
    for (const rep of reports)
      if (rep.config.tol !== budget.tol)
        failures.push(`${rep.target}: bench ran with tol ${rep.config.tol}, budget is for ${budget.tol}`);

  for (const r of rows.values()) {
    const id = key(r.target, r.grid, r.requested);
    r.flags = [];
    if (!r.converged) {
      failures.push(`${id}: a solve did not reach tol`);
      r.flags.push('no-conv');
    }
    if (budget.requireMultigrid && r.requested === 'multigrid' && r.precond !== 'multigrid') {
      failures.push(`${id}: requested multigrid but the solver ran ${r.precond} (levels ${r.levels})`);
      r.flags.push('no-mg');
    }
  }

  const limitRows = [];
  for (const lim of budget.limits ?? []) {
    if (!checked.has(lim.target)) continue;
    const r = rows.get(key(lim.target, lim.grid, lim.precond));
    if (!r) {
      failures.push(`${lim.name}: no ${lim.target} result for ${lim.grid} ${lim.precond}`);
      limitRows.push({ lim, value: NaN, ok: false });
      continue;
    }
    const value = metric(r, lim.metric);
    const ok = Number.isFinite(value) && value <= lim.max;
    if (!ok) {
      failures.push(`${lim.name}: ${lim.target} ${lim.grid} ${lim.metric} = ${value.toFixed(1)} > ${lim.max}`);
      r.flags.push('limit');
    }
    limitRows.push({ lim, value, ok });
    r.limit = Math.min(r.limit ?? Infinity, lim.metric === 'warmMedianMs' ? lim.max : Infinity);
  }

  const reg = budget.regression ?? {};
  for (const rep of reports) {
    const base = budget.baseline?.[rep.target];
    if (!base) {
      notes.push(`${rep.target}: no baseline recorded — regression check skipped (record one with --record)`);
      continue;
    }
    const sameMachine = base.machine?.cpu === rep.machine.cpu;
    if (!sameMachine)
      notes.push(
        `${rep.target}: CPU "${rep.machine.cpu}" ≠ baseline "${base.machine?.cpu}" — times not compared, iterations only`,
      );
    const baseRows = new Map(base.results.map((b) => [key(rep.target, b.grid, b.requested), b]));
    for (const r of rep.results) {
      const row = rows.get(key(rep.target, r.grid, r.requested));
      const b = baseRows.get(key(rep.target, r.grid, r.requested));
      if (!b) continue;
      const id = key(rep.target, r.grid, r.requested);
      if (b.precond === 'multigrid' && r.precond !== 'multigrid') {
        regressions.push(`${id}: baseline ran multigrid, now ${r.precond}`);
        row.flags.push('no-mg');
      }
      let worst = 0;
      for (const m of reg.iterMetrics ?? []) {
        const ratio = r[m] / Math.max(b[m], 1);
        worst = Math.max(worst, ratio);
        if (r[m] > b[m] * reg.iterRatio && r[m] - b[m] > (reg.minAbsIters ?? 0)) {
          regressions.push(`${id}: ${m} ${r[m]} vs baseline ${b[m]} (×${ratio.toFixed(2)} > ×${reg.iterRatio})`);
          row.flags.push('reg-it');
        }
      }
      if (sameMachine)
        for (const m of reg.timeMetrics ?? []) {
          const ratio = r[m] / b[m];
          worst = Math.max(worst, ratio);
          if (r[m] > b[m] * reg.timeRatio && r[m] - b[m] > (reg.minAbsMs ?? 0)) {
            regressions.push(
              `${id}: ${m} ${r[m].toFixed(1)} ms vs baseline ${b[m].toFixed(1)} (×${ratio.toFixed(2)} > ×${reg.timeRatio})`,
            );
            row.flags.push('reg-time');
          }
        }
      row.baseRatio = worst;
    }
  }
  return { rows: [...rows.values()], limitRows, failures, regressions, notes };
}

// --- output ------------------------------------------------------------------------------

const pad = (v, n, left = false) => (left ? String(v).padEnd(n) : String(v).padStart(n));
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '-');

function printTable(rows) {
  console.log(
    `${pad('target', 6, true)} ${pad('grid', 9, true)} ${pad('precond', 10, true)} ${pad('lv', 2)} ` +
      `${pad('load ms', 8)} ${pad('cold it', 7)} ${pad('warm ms', 8)} ${pad('max ms', 7)} ${pad('warm it', 7)} ` +
      `${pad('limit', 6)} ${pad('×base', 5)}  status`,
  );
  for (const r of rows) {
    const pc = r.precond === r.requested ? r.precond : `${r.requested}→${r.precond}`;
    console.log(
      `${pad(r.target, 6, true)} ${pad(r.grid, 9, true)} ${pad(pc, 10, true)} ${pad(r.levels, 2)} ` +
        `${pad(f1(r.setupMs + r.coldMs), 8)} ${pad(r.coldIters, 7)} ${pad(f1(r.warmMedianMs), 8)} ${pad(f1(r.warmMaxMs), 7)} ` +
        `${pad(r.warmMedianIters, 7)} ${pad(Number.isFinite(r.limit) ? r.limit : '-', 6)} ` +
        `${pad(r.baseRatio === undefined ? '-' : r.baseRatio.toFixed(2), 5)}  ${r.flags.length ? `FAIL ${r.flags.join(',')}` : 'ok'}`,
    );
  }
}

function printMarkdown(rows) {
  console.log('\n| grid | target | precond (levels) | setup ms | cold ms (it) | warm median ms (it) | warm max ms | post ms |');
  console.log('| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |');
  const order = (r) => [r.dims[0] * r.dims[1] * r.dims[2], r.target, r.requested].join('|');
  for (const r of [...rows].sort((a, b) => (a.dims[0] * a.dims[1] * a.dims[2] - b.dims[0] * b.dims[1] * b.dims[2]) || order(a).localeCompare(order(b)))) {
    const pc = r.precond === r.requested ? r.precond : `${r.requested}→${r.precond}`;
    console.log(
      `| ${r.grid.replaceAll('x', '×')} | ${r.target} | ${pc} (${r.levels}) | ${r.setupMs.toFixed(2)} | ` +
        `${r.coldMs.toFixed(1)} (${r.coldIters}) | ${r.warmMedianMs.toFixed(1)} (${r.warmMedianIters}) | ` +
        `${r.warmMaxMs.toFixed(1)} | ${r.postMs.toFixed(2)} |`,
    );
  }
}

/** `HEAD` short hash, `+dirty` when the solver sources have uncommitted changes. */
function gitHead() {
  const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) return null;
  const diff = spawnSync('git', ['diff', '--quiet', 'HEAD', '--', 'crates', 'Cargo.lock'], { cwd: ROOT });
  return `${r.stdout.trim()}${diff.status === 0 ? '' : '+dirty'}`;
}

function record(budget, reports) {
  budget.baseline = { ...(budget.baseline ?? {}) };
  const today = new Date().toISOString().slice(0, 10);
  for (const rep of reports) {
    budget.baseline[rep.target] = {
      recorded: today,
      commit: gitHead(),
      machine: { cpu: rep.machine.cpu, os: rep.machine.os, arch: rep.machine.arch },
      config: rep.config,
      results: rep.results.map((r) => ({
        grid: r.grid,
        requested: r.requested,
        precond: r.precond,
        levels: r.levels,
        setupMs: round(r.setupMs),
        coldMs: round(r.coldMs),
        coldIters: r.coldIters,
        warmMedianMs: round(r.warmMedianMs),
        warmMaxMs: round(r.warmMaxMs),
        warmMedianIters: r.warmMedianIters,
      })),
    };
  }
  writeFileSync(BUDGET, `${JSON.stringify(budget, null, 2)}\n`);
  console.log(`perf-gate: baseline for ${reports.map((r) => r.target).join(' + ')} recorded in ${relative(ROOT, BUDGET)}`);
}

const round = (x) => Math.round(x * 100) / 100;

// --- main --------------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv.slice(2));
  let budget;
  try {
    budget = JSON.parse(readFileSync(BUDGET, 'utf8'));
  } catch (e) {
    throw new HarnessError(`${relative(ROOT, BUDGET)}: ${e.message}`);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  if (!args.reuse) {
    if (args.targets.includes('native')) runNative();
    if (args.targets.includes('wasm')) runWasm();
  }
  const reports = args.targets.map(readReport);
  const { rows, limitRows, failures, regressions, notes } = evaluate(budget, reports);

  console.log(
    `\nperf gate — tol ${budget.tol}, single thread; warm = median of ${reports[0].config.carves} 3×3 carves; ` +
      `load = setup + cold solve`,
  );
  for (const rep of reports) console.log(`  ${rep.target}: ${rep.machine.cpu} (${rep.machine.os}/${rep.machine.arch})`);
  printTable(rows);
  console.log('\nlimits:');
  for (const { lim, value, ok } of limitRows)
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${pad(lim.name, 34, true)} ${lim.target} ${pad(lim.grid, 9, true)} ${pad(lim.metric, 13, true)} ${pad(f1(value), 8)} ≤ ${lim.max} ms`);
  for (const n of notes) console.log(`note: ${n}`);
  if (args.markdown) printMarkdown(rows);

  if (failures.length || regressions.length) {
    console.log('\nviolations:');
    for (const f of failures) console.log(`  ✗ ${f}`);
    for (const f of regressions) console.log(`  ✗ regression: ${f}`);
  }
  if (args.record) {
    if (failures.length) console.log('perf-gate: not recording a baseline that violates the budget');
    else {
      record(budget, reports);
      if (regressions.length) console.log('perf-gate: regressions accepted into the new baseline (--record)');
      console.log('✓ perf gate passed');
      return 0;
    }
  }
  if (failures.length || regressions.length) {
    console.log('✗ perf gate failed');
    return 1;
  }
  console.log('✓ perf gate passed');
  return 0;
}

try {
  process.exitCode = main();
} catch (e) {
  console.error(`perf-gate: ${e instanceof HarnessError ? e.message : e?.stack ?? e}`);
  process.exitCode = 2;
}
