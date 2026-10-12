#!/usr/bin/env node
// Node smoke test for the fem-wasm `Session` (task T-202, spec docs/specs/worker-protocol.md).
//
//   pnpm build:wasm && node crates/fem-wasm/tests/node-smoke.mjs
//
// Loads crates/fem-wasm/pkg with `initSync({ module: bytes })` (no fetch), then
//   1. runs the full sanity suite on an inline 24×8×4 cantilever: cold solve, carves,
//      a floating island, a cut that disconnects the load, error paths;
//   2. cold-solves and carves every committed stages/*.json;
//   3. prints the .wasm size and per-solve timings (cold + warm 3×3 surface carves) for
//      24×8×4 (W1-sized) and 40×12×12 (W4-sized), WASM single thread, tol = 1e-4.
// Any failed check throws, so the process exits non-zero.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const PKG = new URL('../pkg/', import.meta.url);
// FEM_SMOKE_STAGES=/abs/dir overrides the stage directory (e.g. a producer's worktree).
const STAGES = process.env.FEM_SMOKE_STAGES
  ? pathToFileURL(`${process.env.FEM_SMOKE_STAGES.replace(/\/$/, '')}/`)
  : new URL('../../../stages/', import.meta.url);
const WASM_FILE = new URL('fem_wasm_bg.wasm', PKG);

if (!existsSync(new URL('fem_wasm.js', PKG)) || !existsSync(WASM_FILE)) {
  console.error('crates/fem-wasm/pkg is missing — run `pnpm build:wasm` first');
  process.exit(1);
}

const wasm = await import(new URL('fem_wasm.js', PKG).href);
const wasmBytes = readFileSync(WASM_FILE);
wasm.initSync({ module: wasmBytes });
const { Session } = wasm;

const TOL = 1e-4;
const OPTIONS = JSON.stringify({ tol: TOL });

// --- stage helpers (stage-format.md) ------------------------------------------------

function encodeBits(bits) {
  const bytes = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((b, e) => {
    if (b) bytes[e >> 3] |= 1 << (e & 7);
  });
  return Buffer.from(bytes).toString('base64');
}

function decodeBits(b64, n) {
  const bytes = Buffer.from(b64, 'base64');
  return Array.from({ length: n }, (_, e) => ((bytes[e >> 3] ?? 0) & (1 << (e & 7))) !== 0);
}

const elemIndex = ([nx, ny], [x, y, z]) => x + nx * (y + ny * z);
const nodeIndex = ([nx, ny], i, j, k) => i + (nx + 1) * (j + (ny + 1) * k);
const elementCount = ([nx, ny, nz]) => nx * ny * nz;
const nodeCount = ([nx, ny, nz]) => (nx + 1) * (ny + 1) * (nz + 1);

/** Load cases as judged: `loadCases` if present, else `loads` as one case. */
function stageCases(stage) {
  return stage.loadCases?.length ? stage.loadCases : [{ name: 'default', loads: stage.loads }];
}

/**
 * Cantilever along x, clamped on x-, loaded downwards on the top edge of the free end.
 * The force is sized so the beam-theory root bending stress is ~ allowable / 2.
 */
function cantilever(nx, ny, nz) {
  const h = 0.01;
  const allowable = 120e6;
  const I = (nz * h * (ny * h) ** 3) / 12;
  const force = (0.5 * allowable * I) / (nx * h * ((ny * h) / 2));
  const n = nx * ny * nz;
  const cells = [];
  for (let z = 0; z < nz; z++) cells.push([nx - 1, ny - 1, z]);
  return {
    version: 1,
    id: `smoke-${nx}x${ny}x${nz}`,
    title: 'smoke cantilever',
    world: 0,
    grid: [nx, ny, nz],
    voxelSize: h,
    material: { E: 70e9, nu: 0.33, allowable },
    solid: encodeBits(new Array(n).fill(true)),
    keep: encodeBits(new Array(n).fill(false)),
    supports: [{ face: 'x-', fix: 'xyz' }],
    loads: [{ cells, force: [0, -force, 0] }],
    targets: { star1: 0.7, star2: 0.55, star3: 0.45 },
  };
}

/**
 * Elements the smoke test must not carve: keep, support and load cells, plus the cell
 * layer on any whole-face support (whether those count as keep is the solver's call).
 */
function protectedSet(stage) {
  const g = stage.grid;
  const n = elementCount(g);
  const prot = decodeBits(stage.keep, n);
  const mark = (c) => {
    prot[elemIndex(g, c)] = true;
  };
  for (const s of stage.supports) {
    if (s.cells) {
      s.cells.forEach(mark);
      continue;
    }
    const axis = { x: 0, y: 1, z: 2 }[s.face[0]];
    const layer = s.face[1] === '-' ? 0 : g[axis] - 1;
    for (let z = 0; z < g[2]; z++)
      for (let y = 0; y < g[1]; y++)
        for (let x = 0; x < g[0]; x++) if ([x, y, z][axis] === layer) mark([x, y, z]);
  }
  for (const c of stageCases(stage)) for (const l of c.loads) l.cells.forEach(mark);
  return prot;
}

// --- session helpers ------------------------------------------------------------------

/** begin + iterate in chunks until done (what the worker does, minus progress posts). */
function solve(s, chunk = 64) {
  const t0 = performance.now();
  s.begin();
  let st;
  let calls = 0;
  do {
    st = s.iterate(chunk);
    calls++;
    assert.ok(calls < 100_000, 'iterate never reported done');
  } while (!st.done);
  const ms = performance.now() - t0;
  return { ms, st, calls };
}

function readResults(s) {
  const t0 = performance.now();
  const cases = [];
  for (let c = 0; c < s.case_count(); c++) {
    cases.push({
      name: s.case_name(c),
      utilization: s.utilization(c),
      displacement: s.displacement(c),
      maxUtilization: s.judged_max_utilization(c),
      loadDisplacement: s.load_displacement(c),
    });
  }
  const floating = s.floating();
  const loadsConnected = s.loads_connected();
  return { cases, floating, loadsConnected, readMs: performance.now() - t0 };
}

const allFinite = (arr) => arr.every((v) => Number.isFinite(v));

/** Checks that hold for any converged solve of a connected structure. */
function checkSane(label, stage, s, { st }, res) {
  const g = stage.grid;
  assert.equal(st.done, true, `${label}: done`);
  assert.ok(Number.isFinite(st.rel_residual), `${label}: finite residual`);
  assert.ok(st.rel_residual <= TOL, `${label}: converged (rel residual ${st.rel_residual})`);
  assert.equal(res.loadsConnected, true, `${label}: loads connected`);
  const cases = stageCases(stage);
  assert.equal(res.cases.length, cases.length, `${label}: case count`);
  res.cases.forEach((r, ci) => {
    const tag = `${label} case ${ci} (${r.name})`;
    assert.equal(typeof r.name, 'string');
    assert.ok(r.utilization instanceof Float32Array, `${tag}: utilization is Float32Array`);
    assert.ok(r.displacement instanceof Float32Array, `${tag}: displacement is Float32Array`);
    assert.equal(r.utilization.length, elementCount(g), `${tag}: utilization length`);
    assert.equal(r.displacement.length, 3 * nodeCount(g), `${tag}: displacement length`);
    assert.ok(allFinite(r.utilization), `${tag}: utilization finite`);
    assert.ok(allFinite(r.displacement), `${tag}: displacement finite`);
    assert.ok(r.utilization.every((u) => u >= 0), `${tag}: utilization >= 0`);
    const maxU = r.utilization.reduce((a, b) => Math.max(a, b), 0);
    assert.ok(maxU > 0, `${tag}: some stress`);
    assert.ok(Number.isFinite(r.maxUtilization) && r.maxUtilization > 0, `${tag}: judged max`);
    assert.ok(r.maxUtilization <= maxU * (1 + 1e-5) + 1e-12, `${tag}: judged max <= max`);
    assert.ok(
      Number.isFinite(r.loadDisplacement) && r.loadDisplacement > 0,
      `${tag}: load displacement ${r.loadDisplacement}`,
    );
    // Every load's point of application moves along its force.
    for (const load of cases[ci].loads) {
      const mean = [0, 0, 0];
      let count = 0;
      for (const [x, y, z] of load.cells)
        for (const [di, dj, dk] of CORNERS) {
          const nidx = nodeIndex(g, x + di, y + dj, z + dk);
          for (let c = 0; c < 3; c++) mean[c] += r.displacement[3 * nidx + c];
          count++;
        }
      const dot = mean.reduce((a, m, c) => a + (m / count) * load.force[c], 0);
      assert.ok(dot > 0, `${tag}: load point moves along the force (u·f = ${dot})`);
    }
  });
}

const CORNERS = [
  [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
  [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
];

/** Deterministic PRNG (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A 3×3 patch on the top surface (y = ny-1) of a cantilever, clear of load/support. */
function topPatch(g, cx, cz) {
  const out = [];
  for (let z = Math.max(0, cz - 1); z <= Math.min(g[2] - 1, cz + 1); z++)
    for (let x = cx - 1; x <= cx + 1; x++) out.push(elemIndex(g, [x, g[1] - 1, z]));
  return Uint32Array.from(out);
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const fmt = (ms) => `${ms.toFixed(1)} ms`;

// --- 1. sanity suite on the inline cantilever --------------------------------------------

function cantileverSuite() {
  const stage = cantilever(24, 8, 4);
  const g = stage.grid;
  const json = JSON.stringify(stage);
  const s = new Session(json, OPTIONS);
  try {
    assert.equal(s.elements, elementCount(g));
    assert.equal(s.nodes, nodeCount(g));
    assert.ok(Number.isInteger(s.levels) && s.levels >= 0, 'levels');
    assert.equal(s.case_count(), 1);
    assert.equal(s.case_name(0), 'default');

    const cold = solve(s);
    const base = readResults(s);
    checkSane('cantilever cold', stage, s, cold, base);
    assert.equal(base.floating.length, 0, 'nothing floating initially');
    assert.ok(base.floating instanceof Uint32Array, 'floating is Uint32Array');
    // Clamped on x-, pushed down at the tip: the tip moves down (−y) the most.
    const tip = nodeIndex(g, g[0], g[1], 0);
    assert.ok(base.cases[0].displacement[3 * tip + 1] < 0, 'tip deflects downwards');

    // Carve a 3×3 surface patch: warm start converges, carved voxels carry no stress.
    const patch = topPatch(g, 8, 1);
    s.set_solid(patch, false);
    const warm = solve(s);
    const carved = readResults(s);
    checkSane('cantilever carved', stage, s, warm, carved);
    for (const e of patch) assert.equal(carved.cases[0].utilization[e], 0, `carved ${e} is 0`);
    assert.ok(
      carved.cases[0].loadDisplacement >= base.cases[0].loadDisplacement * (1 - 1e-3),
      'removing material does not make the beam stiffer',
    );

    // Floating island: isolate the top-front voxel (10, 7, 0) by removing its neighbours.
    const island = elemIndex(g, [10, 7, 0]);
    const ring = Uint32Array.from(
      [[9, 7, 0], [11, 7, 0], [10, 6, 0], [10, 7, 1]].map((c) => elemIndex(g, c)),
    );
    s.set_solid(ring, false);
    const isl = solve(s);
    const islRes = readResults(s);
    checkSane('cantilever island', stage, s, isl, islRes);
    assert.deepEqual([...islRes.floating], [island], 'the island floats');
    assert.equal(islRes.cases[0].utilization[island], 0, 'floating voxel is not stressed');
    s.set_solid(ring, true);

    // Cut through the whole beam at x = 12: the load is disconnected, no NaN, done.
    const slab = [];
    for (let z = 0; z < g[2]; z++) for (let y = 0; y < g[1]; y++) slab.push(elemIndex(g, [12, y, z]));
    const slabArr = Uint32Array.from(slab);
    s.set_solid(slabArr, false);
    const cut = solve(s);
    const cutRes = readResults(s);
    assert.equal(cut.st.done, true, 'cut: done');
    assert.equal(cutRes.loadsConnected, false, 'cut: loads disconnected');
    assert.equal(cutRes.floating.length, (g[0] - 13) * g[1] * g[2], 'cut: tip part floats');
    for (const r of cutRes.cases) {
      assert.ok(allFinite(r.utilization) && allFinite(r.displacement), 'cut: no NaN');
      assert.ok(Number.isFinite(r.maxUtilization), 'cut: judged max finite');
      assert.ok(Number.isFinite(r.loadDisplacement), 'cut: load displacement finite');
    }
    for (const e of cutRes.floating) assert.equal(cutRes.cases[0].utilization[e], 0);

    // Restore everything: back to the carved-patch solution.
    s.set_solid(slabArr, true);
    s.set_solid(patch, true);
    const back = solve(s);
    const backRes = readResults(s);
    checkSane('cantilever restored', stage, s, back, backRes);
    assert.equal(backRes.floating.length, 0);
    const rel = (a, b) => Math.abs(a - b) / Math.abs(b);
    assert.ok(
      rel(backRes.cases[0].maxUtilization, base.cases[0].maxUtilization) < 1e-2,
      `restored max utilisation matches the cold solve (${backRes.cases[0].maxUtilization} vs ${base.cases[0].maxUtilization})`,
    );
    assert.ok(
      rel(backRes.cases[0].loadDisplacement, base.cases[0].loadDisplacement) < 1e-2,
      'restored load displacement matches the cold solve',
    );

    // Error paths throw JS errors and leave the session usable.
    const throwsMsg = (fn, re) => assert.throws(fn, (err) => err instanceof Error && re.test(err.message));
    throwsMsg(() => new Session('{', OPTIONS), /stage/i);
    throwsMsg(() => new Session(json, '{"tol":-1}'), /tol/);
    throwsMsg(() => new Session(json, '{"preconditioner":"ilu"}'), /preconditioner/);
    // (1,1,1) is carvable; element 0 sits in the clamped wall layer, which is protected.
    throwsMsg(() => s.set_solid(Uint32Array.of(elemIndex(g, [1, 1, 1]), s.elements), false), /out of range/);
    const loadCell = elemIndex(g, stage.loads[0].cells[0]);
    throwsMsg(() => s.set_solid(Uint32Array.of(loadCell), false), /protected/);
    throwsMsg(() => s.utilization(1), /case/);
    throwsMsg(() => s.displacement(7), /case/);
    throwsMsg(() => s.case_name(1), /case/);
    const again = solve(s);
    checkSane('cantilever after errors', stage, s, again, readResults(s));
    console.log(
      `ok  cantilever 24×8×4 suite: cold ${fmt(cold.ms)}, carve ${fmt(warm.ms)}, ` +
        `island ${fmt(isl.ms)}, cut ${fmt(cut.ms)}, restore ${fmt(back.ms)}`,
    );
  } finally {
    s.free();
  }
}

// --- 2. committed stages --------------------------------------------------------------------

function stageSuite() {
  const files = existsSync(STAGES)
    ? readdirSync(STAGES).filter((f) => f.endsWith('.json')).sort()
    : [];
  if (files.length === 0) {
    console.log('--  no committed stages/*.json yet (inline cantilever only)');
    return;
  }
  for (const f of files) {
    const json = readFileSync(new URL(f, STAGES), 'utf8');
    const stage = JSON.parse(json);
    const g = stage.grid;
    const s = new Session(json, OPTIONS);
    try {
      assert.equal(s.elements, elementCount(g), `${f}: elements`);
      assert.equal(s.nodes, nodeCount(g), `${f}: nodes`);
      const cold = solve(s);
      const coldRes = readResults(s);
      checkSane(`${f} cold`, stage, s, cold, coldRes);
      const judged = coldRes.cases.map((c) => c.maxUtilization.toFixed(3)).join('/');
      // Carve up to 3 carvable surface voxels (highest y first) that keep the load connected.
      const n = elementCount(g);
      const solid = decodeBits(stage.solid, n);
      const prot = protectedSet(stage);
      const candidates = [];
      for (let e = 0; e < n; e++) if (solid[e] && !prot[e]) candidates.push(e);
      candidates.sort((a, b) => Math.floor(b / g[0]) % g[1] - (Math.floor(a / g[0]) % g[1]) || a - b);
      let carvedCount = 0;
      let carveMs = 0;
      for (const e of candidates) {
        if (carvedCount === 3) break;
        const one = Uint32Array.of(e);
        s.set_solid(one, false);
        const r = solve(s);
        const res = readResults(s);
        if (!res.loadsConnected || res.floating.length > 0) {
          s.set_solid(one, true); // would break the structure; try another voxel
          continue;
        }
        checkSane(`${f} carve ${e}`, stage, s, r, res);
        assert.equal(res.cases[0].utilization[e], 0);
        carvedCount++;
        carveMs += r.ms;
      }
      console.log(
        `ok  ${f} ${g.join('×')}: uncarved max util ${judged}, cold ${fmt(cold.ms)} ` +
          `(${cold.st.iterations} it), ${carvedCount} carves avg ` +
          `${fmt(carvedCount ? carveMs / carvedCount : 0)}`,
      );
    } finally {
      s.free();
    }
  }
}

// --- 3. timings -----------------------------------------------------------------------------

function bench(nx, ny, nz, carves = 10) {
  const stage = cantilever(nx, ny, nz);
  const g = stage.grid;
  const s = new Session(JSON.stringify(stage), OPTIONS);
  try {
    const cold = solve(s);
    const coldRes = readResults(s);
    checkSane(`bench ${g.join('×')} cold`, stage, s, cold, coldRes);
    const next = rng(42);
    const times = [];
    const iters = [];
    const reads = [];
    for (let i = 0; i < carves; i++) {
      const cx = 2 + Math.floor(next() * (nx - 4)); // patch x in [cx-1, cx+1] ⊂ [1, nx-2]
      const cz = Math.floor(next() * nz);
      const patch = topPatch(g, cx, cz);
      const t0 = performance.now();
      s.set_solid(patch, false);
      const r = solve(s);
      times.push(performance.now() - t0);
      iters.push(r.st.iterations);
      const res = readResults(s);
      reads.push(res.readMs);
      checkSane(`bench ${g.join('×')} carve ${i}`, stage, s, r, res);
      s.set_solid(patch, true);
      solve(s);
    }
    return {
      grid: g.join('×'),
      elements: s.elements,
      dofs: 3 * s.nodes,
      levels: s.levels,
      coldMs: cold.ms,
      coldIters: cold.st.iterations,
      warmMedianMs: median(times),
      warmMaxMs: Math.max(...times),
      warmMedianIters: median(iters),
      readMs: median(reads),
    };
  } finally {
    s.free();
  }
}

cantileverSuite();
stageSuite();

const raw = wasmBytes.length;
const gz = gzipSync(wasmBytes, { level: 9 }).length;
console.log(`wasm  fem_wasm_bg.wasm ${(raw / 1024).toFixed(1)} KiB raw, ${(gz / 1024).toFixed(1)} KiB gzip`);

const rows = [bench(24, 8, 4), bench(40, 12, 12)];
console.log('timings (WASM, single thread, tol 1e-4; warm = 3×3 top-surface carve, median of 10):');
console.log('  grid        elems   dofs  lv  cold ms (it)       warm med/max ms (it)   read ms');
for (const r of rows) {
  console.log(
    `  ${r.grid.padEnd(10)} ${String(r.elements).padStart(6)} ${String(r.dofs).padStart(6)} ` +
      `${String(r.levels).padStart(3)}  ${r.coldMs.toFixed(1).padStart(8)} (${String(r.coldIters).padStart(4)})` +
      `   ${r.warmMedianMs.toFixed(1).padStart(7)} / ${r.warmMaxMs.toFixed(1).padStart(7)} (${String(r.warmMedianIters).padStart(4)})` +
      `   ${r.readMs.toFixed(2).padStart(6)}`,
  );
}
console.log('✓ fem-wasm node smoke passed');
