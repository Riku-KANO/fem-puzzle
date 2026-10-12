#!/usr/bin/env node
// WASM benchmark of the fem solver (task T-204): the same scenarios as the native
// `crates/fem-bench` (keep the two in sync), run through the built `crates/fem-wasm/pkg`
// `Session` in Node — single thread, SIMD128 build.
//
//   pnpm build:wasm && node scripts/bench-wasm.mjs [options]
//
//   --grid 24x8x4[,..]        grids (repeatable / comma list); default: all five
//   --precond jacobi|multigrid|both   (alias mg; default both)
//   --carves N  --repeats N  --tol X  --seed N  --chunk N (iterate() chunk, default 64)
//   --out FILE                JSON report (default .artifacts/bench/wasm.json)
//   --quiet                   no progress / table
//
// FEM_WASM_PKG=/abs/pkg/dir benchmarks another build (e.g. a sibling worktree's).
//
// Scenario (identical to fem-bench): solid cantilever clamped on x-, loaded down on the
// top edge at x = nx-1. cold = `new Session` (setup) + begin/iterate from u = 0 (median of
// `repeats`); warm = set_solid(3×3 top-surface patch) + begin/iterate, warm-started, for
// `carves` mulberry32(seed) patches, each undone (and re-solved, untimed) before the next;
// post = reading what the worker posts after a move (utilisation, displacement, judged
// max, load displacement). Exit code 1 if any solve misses `tol`.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, arch, platform, release } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = 1;
const GRIDS = [
  [24, 8, 4],
  [32, 8, 8],
  [32, 12, 12],
  [40, 12, 12],
  [60, 20, 20],
];

// --- args -------------------------------------------------------------------------------

function parseGrid(s) {
  const d = s.split(/[x×]/).map((p) => Number(p.trim()));
  if (d.length !== 3 || !d.every(Number.isInteger) || d[0] < 5 || d[1] < 1 || d[2] < 1)
    throw new Error(`invalid grid ${JSON.stringify(s)} (expected e.g. 40x12x12, nx >= 5)`);
  return d;
}

function parseArgs(argv) {
  const a = {
    grids: [],
    preconds: ['jacobi', 'multigrid'],
    carves: 10,
    repeats: 3,
    tol: 1e-4,
    seed: 42,
    chunk: 64,
    out: resolve(ROOT, '.artifacts/bench/wasm.json'),
    quiet: false,
  };
  const num = (v, name, ok) => {
    const n = Number(v);
    if (!ok(n)) throw new Error(`${name}: invalid value ${JSON.stringify(v)}`);
    return n;
  };
  const int = (v, name, min) => num(v, name, (n) => Number.isInteger(n) && n >= min);
  for (let i = 0; i < argv.length; i++) {
    let [flag, inline] = argv[i].split(/=(.*)/s);
    const value = () => {
      const v = inline ?? argv[++i];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case '--grid':
        for (const g of value().split(',').filter(Boolean)) a.grids.push(parseGrid(g));
        break;
      case '--precond': {
        const v = value();
        const map = { jacobi: ['jacobi'], multigrid: ['multigrid'], mg: ['multigrid'], both: ['jacobi', 'multigrid'], all: ['jacobi', 'multigrid'] };
        if (!map[v]) throw new Error(`unknown preconditioner ${JSON.stringify(v)}`);
        a.preconds = map[v];
        break;
      }
      case '--carves': a.carves = int(value(), flag, 0); break;
      case '--repeats': a.repeats = int(value(), flag, 1); break;
      case '--seed': a.seed = int(value(), flag, 0) >>> 0; break;
      case '--chunk': a.chunk = int(value(), flag, 1); break;
      case '--tol': a.tol = num(value(), flag, (n) => n > 0 && n < 1); break;
      case '--out': a.out = resolve(value()); break;
      case '--quiet': a.quiet = true; break;
      case '-h':
      case '--help':
        console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 22).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
        process.exit(0);
      default:
        throw new Error(`unknown argument ${JSON.stringify(argv[i])}`);
    }
  }
  if (a.grids.length === 0) a.grids = GRIDS;
  return a;
}

// --- scenario (mirror of crates/fem-bench/src/lib.rs) ---------------------------------------

const gridName = ([nx, ny, nz]) => `${nx}x${ny}x${nz}`;

function encodeBits(n, value) {
  const bytes = new Uint8Array(Math.ceil(n / 8));
  if (value) for (let e = 0; e < n; e++) bytes[e >> 3] |= 1 << (e & 7);
  return Buffer.from(bytes).toString('base64');
}

function cantilever([nx, ny, nz]) {
  const h = 0.01;
  const allowable = 120e6;
  const inertia = (nz * h * (ny * h) ** 3) / 12;
  const force = (0.5 * allowable * inertia) / (nx * h * ((ny * h) / 2));
  const n = nx * ny * nz;
  const cells = [];
  for (let z = 0; z < nz; z++) cells.push([nx - 1, ny - 1, z]);
  return {
    version: 1,
    id: `bench-${gridName([nx, ny, nz])}`,
    title: 'bench cantilever',
    world: 0,
    grid: [nx, ny, nz],
    voxelSize: h,
    material: { E: 70e9, nu: 0.33, allowable },
    solid: encodeBits(n, true),
    keep: encodeBits(n, false),
    supports: [{ face: 'x-', fix: 'xyz' }],
    loads: [{ cells, force: [0, -force, 0] }],
    targets: { star1: 0.7, star2: 0.55, star3: 0.45 },
  };
}

/** mulberry32 — bit-identical to `fem_bench::Mulberry32`. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function carveCentres([nx, , nz], carves, seed) {
  const next = mulberry32(seed);
  return Array.from({ length: carves }, () => {
    const cx = 2 + Math.floor(next() * (nx - 4));
    const cz = Math.floor(next() * nz);
    return [cx, cz];
  });
}

function topPatch([nx, ny, nz], [cx, cz]) {
  const out = [];
  for (let z = Math.max(0, cz - 1); z <= Math.min(nz - 1, cz + 1); z++)
    for (let x = cx - 1; x <= cx + 1; x++) out.push(x + nx * (ny - 1 + ny * z));
  return Uint32Array.from(out);
}

function median(xs) {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// --- runtime ----------------------------------------------------------------------------

/** Count v128 locals in the code section: auto-vectorised code always has some. */
function simdInfo(bytes) {
  let p = 8; // magic + version
  const leb = () => {
    let r = 0;
    let shift = 0;
    let b;
    do {
      b = bytes[p++];
      r += (b & 0x7f) * 2 ** shift;
      shift += 7;
    } while (b & 0x80);
    return r;
  };
  while (p < bytes.length) {
    const id = bytes[p++];
    const size = leb();
    const end = p + size;
    if (id === 10) {
      let functions = 0;
      let v128Locals = 0;
      const count = leb();
      for (let f = 0; f < count; f++) {
        const bodySize = leb();
        const bodyEnd = p + bodySize;
        let has = false;
        const decls = leb();
        for (let d = 0; d < decls; d++) {
          const n = leb();
          const type = bytes[p++];
          if (type === 0x7b) {
            v128Locals += n;
            has = true;
          }
        }
        if (has) functions++;
        p = bodyEnd;
      }
      return { functionsWithV128: functions, v128Locals };
    }
    p = end;
  }
  return { functionsWithV128: 0, v128Locals: 0 };
}

function loadPkg() {
  const dir = process.env.FEM_WASM_PKG
    ? pathToFileURL(`${resolve(process.env.FEM_WASM_PKG)}/`)
    : pathToFileURL(`${ROOT}/crates/fem-wasm/pkg/`);
  const js = new URL('fem_wasm.js', dir);
  const wasmFile = new URL('fem_wasm_bg.wasm', dir);
  if (!existsSync(js) || !existsSync(wasmFile)) {
    throw new Error(`${fileURLToPath(dir)} has no fem_wasm.js / fem_wasm_bg.wasm — run \`pnpm build:wasm\` first`);
  }
  return { js, wasmFile };
}

function solve(s, chunk) {
  s.begin();
  let st;
  let calls = 0;
  do {
    st = s.iterate(chunk);
    if (++calls > 1_000_000) throw new Error('iterate never reported done');
  } while (!st.done);
  return st;
}

function postProcess(s) {
  let acc = 0;
  for (let c = 0; c < s.case_count(); c++) {
    const u = s.utilization(c);
    const d = s.displacement(c);
    acc += s.judged_max_utilization(c) + s.load_displacement(c) + u[0] + d[0];
  }
  return acc;
}

function runScenario(Session, dims, requested, cfg) {
  const json = JSON.stringify(cantilever(dims));
  const opts = JSON.stringify({ tol: cfg.tol, preconditioner: requested });
  const ok = (st) => st.done && st.rel_residual <= cfg.tol;
  let converged = true;
  const setup = [];
  const cold = [];
  let s = null;
  let coldSt = null;
  for (let r = 0; r < cfg.repeats; r++) {
    s?.free();
    let t = performance.now();
    s = new Session(json, opts);
    setup.push(performance.now() - t);
    t = performance.now();
    coldSt = solve(s, cfg.chunk);
    cold.push(performance.now() - t);
    converged &&= ok(coldSt);
  }
  try {
    const levels = s.levels;
    const warmMs = [];
    const warmIters = [];
    const post = [];
    let sink = 0;
    for (const centre of carveCentres(dims, cfg.carves, cfg.seed)) {
      const patch = topPatch(dims, centre);
      let t = performance.now();
      s.set_solid(patch, false);
      const st = solve(s, cfg.chunk);
      warmMs.push(performance.now() - t);
      warmIters.push(st.iterations);
      converged &&= ok(st);
      t = performance.now();
      sink += postProcess(s);
      post.push(performance.now() - t);
      s.set_solid(patch, true);
      converged &&= ok(solve(s, cfg.chunk));
    }
    if (Number.isNaN(sink)) converged = false;
    return {
      grid: gridName(dims),
      dims,
      elements: s.elements,
      dofs: 3 * s.nodes,
      requested,
      precond: levels > 0 ? 'multigrid' : 'jacobi',
      levels,
      setupMs: median(setup),
      coldMs: median(cold),
      coldIters: coldSt.iterations,
      coldRelResidual: coldSt.rel_residual,
      warmMs,
      warmIters,
      warmMedianMs: median(warmMs),
      warmMaxMs: warmMs.reduce((a, b) => Math.max(a, b), 0),
      warmMedianIters: median(warmIters),
      postMs: median(post),
      converged,
    };
  } finally {
    s.free();
  }
}

function table(results) {
  const pad = (v, n, left = false) => (left ? String(v).padEnd(n) : String(v).padStart(n));
  const lines = [
    `${pad('grid', 10, true)} ${pad('elems', 6)} ${pad('dofs', 6)} ${pad('precond', 9, true)} ${pad('lv', 2)} | ` +
      `${pad('setup ms', 8)} ${pad('cold ms', 9)} ${pad('it', 6)} | ${pad('warm med', 9)} ${pad('warm max', 9)} ${pad('it', 6)} | ${pad('post ms', 7)} ${pad('ok', 3)}`,
  ];
  for (const r of results) {
    const pc = r.precond === r.requested ? r.precond : `${r.precond}*`;
    lines.push(
      `${pad(r.grid, 10, true)} ${pad(r.elements, 6)} ${pad(r.dofs, 6)} ${pad(pc, 9, true)} ${pad(r.levels, 2)} | ` +
        `${pad(r.setupMs.toFixed(2), 8)} ${pad(r.coldMs.toFixed(1), 9)} ${pad(r.coldIters, 6)} | ` +
        `${pad(r.warmMedianMs.toFixed(1), 9)} ${pad(r.warmMaxMs.toFixed(1), 9)} ${pad(r.warmMedianIters, 6)} | ` +
        `${pad(r.postMs.toFixed(2), 7)} ${pad(r.converged ? 'yes' : 'NO', 3)}`,
    );
  }
  if (results.some((r) => r.precond !== r.requested))
    lines.push('* requested multigrid, solver fell back to jacobi (levels = 0)');
  return lines.join('\n');
}

async function main() {
  const cfg = parseArgs(process.argv.slice(2));
  const { js, wasmFile } = loadPkg();
  const wasm = await import(js.href);
  const bytes = readFileSync(wasmFile);
  wasm.initSync({ module: bytes });
  const results = [];
  for (const dims of cfg.grids) {
    for (const pc of cfg.preconds) {
      const r = runScenario(wasm.Session, dims, pc, cfg);
      if (!cfg.quiet)
        console.error(
          `bench-wasm: ${r.grid} ${pc.padEnd(9)} cold ${r.coldMs.toFixed(1)} ms (${r.coldIters} it), ` +
            `warm median ${r.warmMedianMs.toFixed(1)} ms (${r.warmMedianIters} it)`,
        );
      results.push(r);
    }
  }
  const report = {
    schema: SCHEMA,
    target: 'wasm',
    scenario: 'cantilever',
    machine: {
      os: platform(),
      osRelease: release(),
      arch: arch(),
      cpu: cpus()[0]?.model?.trim() ?? 'unknown',
      logicalCpus: cpus().length,
      threads: 1,
      unixTime: Math.floor(Date.now() / 1000),
      node: process.version,
      v8: process.versions.v8,
    },
    wasm: {
      file: fileURLToPath(wasmFile),
      bytes: bytes.length,
      version: typeof wasm.version === 'function' ? wasm.version() : null,
      simd: simdInfo(bytes),
    },
    config: { tol: cfg.tol, carves: cfg.carves, repeats: cfg.repeats, seed: cfg.seed, chunk: cfg.chunk },
    results,
  };
  mkdirSync(dirname(cfg.out), { recursive: true });
  writeFileSync(cfg.out, `${JSON.stringify(report, null, 2)}\n`);
  if (!cfg.quiet) {
    console.log(table(results));
    console.log(
      `wasm ${(bytes.length / 1024).toFixed(1)} KiB, SIMD: ${report.wasm.simd.functionsWithV128} functions with v128 locals; report → ${cfg.out}`,
    );
  }
  if (!results.every((r) => r.converged)) {
    console.error('bench-wasm: some solves did not reach tol');
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`bench-wasm: ${e instanceof Error ? e.message : e}`);
  process.exit(2);
});
