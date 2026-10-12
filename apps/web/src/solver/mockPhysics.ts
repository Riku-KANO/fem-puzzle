// Mock "physics" for the JS backend: exact connectivity plus a beam-slice stress heuristic.
// It is NOT FEM — it exists so the game is playable and testable without the WASM solver,
// and is qualitatively right: stress grows towards the clamp, peaks in the outer fibres and
// vanishes near the neutral axis, so carving the middle of a beam is cheap and carving the
// flanges is not.
//
// Model (per load case):
//  1. span axis a = the axis along which load points are farthest from the supported cells;
//     the two other axes b, c are transverse.
//  2. statics along a: cantilever (loads outside the support range, internal forces from the
//     free side) or simply supported (two reactions at the extreme fixed-node planes).
//  3. each slice ⊥ a is a beam section made of the active voxels in it: area, centroid,
//     second moments I_b, I_c. σ = N/A − M_b·d_b/I_b − M_c·d_c/I_c, parabolic shear
//     τ = 1.5·V/A·(1 − (d/c)²), von Mises √(σ² + 3τ²), utilisation = σ_vm / allowable.
//  4. displacement: Euler–Bernoulli deflection w'' = M/(EI) integrated slice by slice.

import { stageCases, effectiveKeep, type CaseResult, type Stage, type Vec3 } from '@stress-carve/protocol';
import { connectivity } from '../game/connectivity.ts';
import { cellIndex, makeGrid, nodeIndexOf, type Grid } from '../game/grid.ts';
import { supportModel } from '../game/supports.ts';

export interface LoadPoint {
  cell: number;
  /** cell centre (m) */
  pos: Vec3;
  /** this cell's share of the load (N) */
  force: Vec3;
}

export interface MockModel {
  grid: Grid;
  h: number;
  E: number;
  allowable: number;
  keep: Uint8Array;
  fixedNode: Uint8Array;
  supported: Uint8Array;
  cases: { name: string; points: LoadPoint[] }[];
  /** every load cell of every case (connectivity rule) */
  loadCells: Uint32Array;
}

export function buildMockModel(stage: Stage): MockModel {
  const grid = makeGrid(stage.grid);
  const h = stage.voxelSize;
  const { fixedNode, supported } = supportModel(stage);
  const loadCells = new Set<number>();
  const cases = stageCases(stage).map((lc) => ({
    name: lc.name,
    points: lc.loads.flatMap((load) =>
      load.cells.map((c): LoadPoint => {
        const k = load.cells.length;
        const cell = cellIndex(grid, c[0], c[1], c[2]);
        loadCells.add(cell);
        return {
          cell,
          pos: [(c[0] + 0.5) * h, (c[1] + 0.5) * h, (c[2] + 0.5) * h],
          force: [load.force[0] / k, load.force[1] / k, load.force[2] / k],
        };
      }),
    ),
  }));
  return {
    grid,
    h,
    E: stage.material.E,
    allowable: stage.material.allowable,
    keep: effectiveKeep(stage),
    fixedNode,
    supported,
    cases,
    loadCells: Uint32Array.from([...loadCells].sort((a, b) => a - b)),
  };
}

export interface MockFields {
  active: Uint8Array;
  floating: Uint32Array;
  loadsConnected: boolean;
  cases: CaseResult[];
}

export function computeMockFields(model: MockModel, solid: Uint8Array): MockFields {
  const { active, floating } = connectivity(model.grid, solid, model.supported);
  let loadsConnected = true;
  for (const e of model.loadCells) if (!active[e]) loadsConnected = false;
  const cases = model.cases.map((lc) => solveCase(model, active, lc.name, lc.points));
  return { active, floating, loadsConnected, cases };
}

interface PointForce {
  s: number;
  f: Vec3;
}

function solveCase(model: MockModel, active: Uint8Array, name: string, points: LoadPoint[]): CaseResult {
  const g = model.grid;
  const { h, E, allowable } = model;
  const utilization = new Float32Array(g.n);
  const displacement = new Float32Array(3 * g.nodes);
  const empty: CaseResult = { name, utilization, displacement, maxUtilization: 0, loadDisplacement: 0 };

  const pts = points.filter((p) => active[p.cell]);
  const supp: number[] = [];
  for (let e = 0; e < g.n; e++) if (active[e] && model.supported[e]) supp.push(e);
  if (pts.length === 0 || supp.length === 0) return empty;

  const dims = [g.nx, g.ny, g.nz];
  const coords = (e: number): [number, number, number] => {
    const x = e % g.nx;
    const y = Math.floor(e / g.nx) % g.ny;
    return [x, y, Math.floor(e / (g.nx * g.ny))];
  };

  // 1. span axis: mean |load − support| separation per axis
  const sep = [0, 0, 0];
  const suppCoords = supp.map(coords);
  for (const p of pts) {
    for (const sc of suppCoords) {
      for (let k = 0; k < 3; k++) sep[k]! += Math.abs(p.pos[k]! / h - (sc[k]! + 0.5));
    }
  }
  let a = 0;
  for (let k = 1; k < 3; k++) {
    if (sep[k]! > sep[a]! + 1e-9 || (Math.abs(sep[k]! - sep[a]!) <= 1e-9 && dims[k]! > dims[a]!)) a = k;
  }
  const b = (a + 1) % 3;
  const c = (a + 2) % 3;
  const na = dims[a]!;

  // 2. support range along a: extreme planes of fixed nodes of active supported elements
  let qmin = Infinity;
  let qmax = -Infinity;
  for (const sc of suppCoords) {
    for (let k = 0; k <= 1; k++)
      for (let j = 0; j <= 1; j++)
        for (let i = 0; i <= 1; i++) {
          const node = nodeIndexOf(g, sc[0] + i, sc[1] + j, sc[2] + k);
          if (!model.fixedNode[node]) continue;
          const q = sc[a]! + (a === 0 ? i : a === 1 ? j : k);
          if (q < qmin) qmin = q;
          if (q > qmax) qmax = q;
        }
  }
  const s1 = qmin * h;
  const s2 = qmax * h;
  const forces: PointForce[] = pts.map((p) => ({ s: p.pos[a]!, f: p.force }));
  const spanMode = qmax - qmin >= 2 && forces.some((f) => f.s > s1 && f.s < s2);
  if (spanMode) {
    const r1: Vec3 = [0, 0, 0];
    const r2: Vec3 = [0, 0, 0];
    for (const j of [b, c]) {
      let total = 0;
      let moment = 0;
      for (const f of forces) {
        total += f.f[j]!;
        moment += f.f[j]! * (f.s - s1);
      }
      r2[j] = -moment / (s2 - s1);
      r1[j] = -total - r2[j]!;
    }
    forces.push({ s: s1, f: r1 }, { s: s2, f: r2 });
  }

  // 3. section properties per slice
  const cnt = new Float64Array(na);
  const sumB = new Float64Array(na);
  const sumB2 = new Float64Array(na);
  const sumC = new Float64Array(na);
  const sumC2 = new Float64Array(na);
  const minB = new Float64Array(na).fill(Infinity);
  const maxB = new Float64Array(na).fill(-Infinity);
  const minC = new Float64Array(na).fill(Infinity);
  const maxC = new Float64Array(na).fill(-Infinity);
  const cell = [0, 0, 0];
  // visits active elements; `cell` holds the current element's coordinates during `fn`
  const forEachActive = (fn: (e: number, k: number, yb: number, yc: number) => void) => {
    for (let z = 0, e = 0; z < g.nz; z++) {
      for (let y = 0; y < g.ny; y++) {
        for (let x = 0; x < g.nx; x++, e++) {
          if (!active[e]) continue;
          cell[0] = x;
          cell[1] = y;
          cell[2] = z;
          fn(e, cell[a]!, (cell[b]! + 0.5) * h, (cell[c]! + 0.5) * h);
        }
      }
    }
  };
  forEachActive((_, k, yb, yc) => {
    cnt[k]! += 1;
    sumB[k]! += yb;
    sumB2[k]! += yb * yb;
    sumC[k]! += yc;
    sumC2[k]! += yc * yc;
    if (yb < minB[k]!) minB[k] = yb;
    if (yb > maxB[k]!) maxB[k] = yb;
    if (yc < minC[k]!) minC[k] = yc;
    if (yc > maxC[k]!) maxC[k] = yc;
  });
  const h2 = h * h;
  const h4 = h2 * h2;
  const area = new Float64Array(na);
  const cb = new Float64Array(na);
  const cc = new Float64Array(na);
  const ib = new Float64Array(na);
  const ic = new Float64Array(na);
  const halfB = new Float64Array(na);
  const halfC = new Float64Array(na);
  for (let k = 0; k < na; k++) {
    const n = cnt[k]!;
    if (n === 0) continue;
    area[k] = n * h2;
    cb[k] = sumB[k]! / n;
    cc[k] = sumC[k]! / n;
    ib[k] = (n * h4) / 12 + h2 * Math.max(0, sumB2[k]! - n * cb[k]! * cb[k]!);
    ic[k] = (n * h4) / 12 + h2 * Math.max(0, sumC2[k]! - n * cc[k]! * cc[k]!);
    halfB[k] = Math.max(cb[k]! - minB[k]!, maxB[k]! - cb[k]!) + h / 2;
    halfC[k] = Math.max(cc[k]! - minC[k]!, maxC[k]! - cc[k]!) + h / 2;
  }

  // internal forces at slice centres
  const mB = new Float64Array(na);
  const mC = new Float64Array(na);
  const vB = new Float64Array(na);
  const vC = new Float64Array(na);
  const nA = new Float64Array(na);
  for (let k = 0; k < na; k++) {
    const s = (k + 0.5) * h;
    // right free body (s_p > s) for spans and the + side of a cantilever, left one for the − side
    const right = spanMode || s > s2;
    const left = !spanMode && s < s1;
    if (!right && !left) continue;
    for (const f of forces) {
      if (right ? f.s <= s : f.s >= s) continue;
      const sign = right ? 1 : -1;
      mB[k]! += sign * (f.s - s) * f.f[b]!;
      mC[k]! += sign * (f.s - s) * f.f[c]!;
      vB[k]! += sign * f.f[b]!;
      vC[k]! += sign * f.f[c]!;
      nA[k]! += sign * f.f[a]!;
    }
  }

  // stresses
  let maxUtilization = 0;
  forEachActive((e, k, yb, yc) => {
    const A = area[k]!;
    const db = yb - cb[k]!;
    const dc = yc - cc[k]!;
    const sigma = nA[k]! / A - (mB[k]! * db) / ib[k]! - (mC[k]! * dc) / ic[k]!;
    const tb = ((1.5 * Math.abs(vB[k]!)) / A) * Math.max(0, 1 - (db / halfB[k]!) ** 2);
    const tc = ((1.5 * Math.abs(vC[k]!)) / A) * Math.max(0, 1 - (dc / halfC[k]!) ** 2);
    const u = Math.sqrt(sigma * sigma + 3 * (tb * tb + tc * tc)) / allowable;
    utilization[e] = u;
    if (!model.keep[e] && u > maxUtilization) maxUtilization = u;
  });

  // 4. deflection along a for both transverse axes
  const wB = deflection(na, h, qmin, qmax, spanMode, (k) => (ib[k]! > 0 ? mB[k]! / (E * ib[k]!) : 0));
  const wC = deflection(na, h, qmin, qmax, spanMode, (k) => (ic[k]! > 0 ? mC[k]! / (E * ic[k]!) : 0));
  const touched = new Uint8Array(g.nodes);
  forEachActive(() => {
    for (let dk = 0; dk <= 1; dk++)
      for (let dj = 0; dj <= 1; dj++)
        for (let di = 0; di <= 1; di++) touched[nodeIndexOf(g, cell[0]! + di, cell[1]! + dj, cell[2]! + dk)] = 1;
  });
  for (let k = 0, node = 0; k <= g.nz; k++) {
    for (let j = 0; j <= g.ny; j++) {
      for (let i = 0; i <= g.nx; i++, node++) {
        if (!touched[node]) continue;
        const q = a === 0 ? i : a === 1 ? j : k;
        const fixed = model.fixedNode[node]!;
        if (!(fixed & (1 << b))) displacement[3 * node + b] = wB[q]!;
        if (!(fixed & (1 << c))) displacement[3 * node + c] = wC[q]!;
      }
    }
  }

  let loadDisplacement = 0;
  for (const p of pts) {
    const [x, y, z] = coords(p.cell);
    for (let dk = 0; dk <= 1; dk++)
      for (let dj = 0; dj <= 1; dj++)
        for (let di = 0; di <= 1; di++) {
          const node = nodeIndexOf(g, x + di, y + dj, z + dk);
          const d = Math.hypot(displacement[3 * node]!, displacement[3 * node + 1]!, displacement[3 * node + 2]!);
          if (d > loadDisplacement) loadDisplacement = d;
        }
  }
  return { name, utilization, displacement, maxUtilization, loadDisplacement };
}

/** w(q) at node planes q = 0..na from slice curvatures κ(k) (w'' = κ, exact per slice). */
function deflection(
  na: number,
  h: number,
  qmin: number,
  qmax: number,
  spanMode: boolean,
  kappa: (k: number) => number,
): Float64Array {
  const w = new Float64Array(na + 1);
  if (spanMode) {
    let theta = 0;
    for (let q = 0; q < na; q++) {
      const kq = kappa(q);
      w[q + 1] = w[q]! + theta * h + (kq * h * h) / 2;
      theta += kq * h;
    }
    const w1 = w[qmin]!;
    const w2 = w[qmax]!;
    for (let q = 0; q <= na; q++) w[q] = w[q]! - (w1 + ((w2 - w1) * (q - qmin)) / (qmax - qmin));
    return w;
  }
  let theta = 0;
  for (let q = qmax; q < na; q++) {
    const kq = kappa(q);
    w[q + 1] = w[q]! + theta * h + (kq * h * h) / 2;
    theta += kq * h;
  }
  theta = 0;
  for (let q = qmin; q > 0; q--) {
    const kq = kappa(q - 1);
    w[q - 1] = w[q]! - theta * h + (kq * h * h) / 2;
    theta -= kq * h;
  }
  return w;
}
