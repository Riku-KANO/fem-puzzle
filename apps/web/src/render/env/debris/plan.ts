// Pure debris planning (design doc 演出: 削ったボクセルは小さな破片になって落ち、作業台に積もる):
// which effect runs, how many chips a removal spawns and with what initial state, how floating
// cells split into rigid chunks, chunk collider boxes, and the settle → pile / fade rule.
// Deterministic for a given seed. No Three.js, no Rapier.

import type { Vec3 } from '@stress-carve/protocol';
import type { Grid } from '../../../game/grid.ts';

/** physics = Rapier chips + chunks; fade = removed voxels fade out in place; off = nothing. */
export type DebrisMode = 'physics' | 'fade' | 'off';

export interface FxOptions {
  /** load the workshop/jig glbs (false: keep the T-102 placeholders) */
  env: boolean;
  debris: DebrisMode;
}

/**
 * Effect switches. Defaults: env on, debris physics; `prefers-reduced-motion` → fade (no
 * flying chips); the e2e build (`vite build --mode e2e`, T-306) → debris off so screenshots
 * and pixel counts stay deterministic. URL overrides: `?debris=physics|fade|off`, `?env=0`.
 */
export function resolveFx(input: { search: string; mode: string; reducedMotion: boolean }): FxOptions {
  const q = new URLSearchParams(input.search);
  let debris: DebrisMode = input.mode === 'e2e' ? 'off' : input.reducedMotion ? 'fade' : 'physics';
  const want = q.get('debris');
  if (want === 'physics' || want === 'fade' || want === 'off') debris = want;
  const envParam = q.get('env');
  return { env: envParam !== '0' && envParam !== 'off', debris };
}

/** mulberry32: small, fast, seedable PRNG in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- chips ---------------------------------------------------------------------

export interface ChipBudget {
  /** chips per removed voxel when there is room */
  perCell: number;
  /** most chips one removal may spawn (the rest of the cells spawn nothing) */
  max: number;
}

/**
 * Chips per removed cell under a budget: `perCell` each while it fits, otherwise an even,
 * deterministic spread of `max` chips over the cells (never more than `perCell` per cell).
 */
export function chipCounts(cellCount: number, budget: ChipBudget): Uint8Array {
  const out = new Uint8Array(cellCount);
  const total = Math.min(budget.max, cellCount * budget.perCell);
  if (total <= 0 || cellCount === 0) return out;
  // Bresenham-style spread of `total` over the cells
  let acc = 0;
  for (let i = 0; i < cellCount; i++) {
    const before = Math.floor((acc * total) / cellCount);
    acc++;
    const after = Math.floor((acc * total) / cellCount);
    out[i] = Math.min(budget.perCell, after - before);
  }
  return out;
}

/**
 * Outward direction of a removed cell: mean of the normals towards its non-solid neighbours
 * (outside the grid counts as empty), normalised; straight up when enclosed.
 */
export function outwardDir(g: Grid, solid: Uint8Array, cell: Vec3): Vec3 {
  const d: Vec3 = [0, 0, 0];
  for (let axis = 0; axis < 3; axis++) {
    for (const s of [-1, 1]) {
      const q: Vec3 = [cell[0], cell[1], cell[2]];
      q[axis] = q[axis]! + s;
      const inside = q[0] >= 0 && q[1] >= 0 && q[2] >= 0 && q[0] < g.nx && q[1] < g.ny && q[2] < g.nz;
      if (!inside || !solid[q[0] + g.nx * (q[1] + g.ny * q[2])]) d[axis] = d[axis]! + s;
    }
  }
  const n = Math.hypot(...d);
  return n > 1e-9 ? [d[0] / n, d[1] / n, d[2] / n] : [0, 1, 0];
}

export interface ChipSpawn {
  /** world position, m */
  position: Vec3;
  /** quaternion (x, y, z, w) */
  rotation: [number, number, number, number];
  linvel: Vec3;
  angvel: Vec3;
  /** index into the chip variants */
  variant: number;
  /** uniform size jitter */
  scale: number;
}

export interface ChipKinematics {
  /** voxel size, m */
  h: number;
  /** number of chip variants to choose from */
  variants: number;
  /** speed along the outward direction, m/s (min, max) */
  speed: readonly [number, number];
  /** extra upward pop, m/s (min, max) */
  pop: readonly [number, number];
  /** random lateral speed, m/s */
  jitter: number;
  /** max angular speed per axis, rad/s */
  spin: number;
}

export const CHIP_KINEMATICS: Omit<ChipKinematics, 'h' | 'variants'> = {
  speed: [0.12, 0.35],
  pop: [0.15, 0.45],
  jitter: 0.12,
  spin: 30,
};

/** Initial state of one chip thrown out of a removed cell centred at `center`. */
export function chipSpawn(rand: () => number, center: Vec3, outward: Vec3, k: ChipKinematics): ChipSpawn {
  const r = (a: number, b: number) => a + (b - a) * rand();
  const spread = 0.3 * k.h;
  const position: Vec3 = [center[0] + r(-spread, spread), center[1] + r(-spread, spread), center[2] + r(-spread, spread)];
  const speed = r(k.speed[0], k.speed[1]);
  const pop = r(k.pop[0], k.pop[1]);
  const linvel: Vec3 = [
    outward[0] * speed + r(-k.jitter, k.jitter),
    outward[1] * speed + pop,
    outward[2] * speed + r(-k.jitter, k.jitter),
  ];
  const angvel: Vec3 = [r(-k.spin, k.spin), r(-k.spin, k.spin), r(-k.spin, k.spin)];
  return {
    position,
    rotation: randomQuat(rand),
    linvel,
    angvel,
    variant: Math.min(k.variants - 1, Math.floor(rand() * k.variants)),
    scale: r(0.8, 1.15),
  };
}

/** Uniform random rotation (Shoemake). */
export function randomQuat(rand: () => number): [number, number, number, number] {
  const u1 = rand();
  const u2 = rand() * 2 * Math.PI;
  const u3 = rand() * 2 * Math.PI;
  const a = Math.sqrt(1 - u1);
  const b = Math.sqrt(u1);
  return [a * Math.sin(u2), a * Math.cos(u2), b * Math.sin(u3), b * Math.cos(u3)];
}

// --- floating chunks ---------------------------------------------------------------

/** 6-connected components of a cell set (element indices), each sorted ascending. */
export function components(g: Grid, cells: readonly number[]): number[][] {
  const inSet = new Set(cells);
  const seen = new Set<number>();
  const out: number[][] = [];
  const sy = g.nx;
  const sz = g.nx * g.ny;
  for (const start of cells) {
    if (seen.has(start)) continue;
    const comp = [start];
    seen.add(start);
    for (let i = 0; i < comp.length; i++) {
      const e = comp[i]!;
      const x = e % g.nx;
      const y = Math.floor(e / sy) % g.ny;
      const z = Math.floor(e / sz);
      const nbs: number[] = [];
      if (x > 0) nbs.push(e - 1);
      if (x < g.nx - 1) nbs.push(e + 1);
      if (y > 0) nbs.push(e - sy);
      if (y < g.ny - 1) nbs.push(e + sy);
      if (z > 0) nbs.push(e - sz);
      if (z < g.nz - 1) nbs.push(e + sz);
      for (const nb of nbs) {
        if (inSet.has(nb) && !seen.has(nb)) {
          seen.add(nb);
          comp.push(nb);
        }
      }
    }
    out.push(comp.sort((a, b) => a - b));
  }
  return out;
}

export interface CellBox {
  /** min corner, grid units */
  min: Vec3;
  /** exclusive max corner, grid units */
  max: Vec3;
}

/**
 * Greedy decomposition of a cell set into disjoint axis-aligned boxes (grow along x, then y,
 * then z), for a compound collider with far fewer shapes than cells. Exact cover.
 */
export function greedyBoxes(g: Grid, cells: readonly number[]): CellBox[] {
  const inSet = new Uint8Array(g.n);
  for (const e of cells) inSet[e] = 1;
  const used = new Uint8Array(g.n);
  const idx = (x: number, y: number, z: number) => x + g.nx * (y + g.ny * z);
  const free = (x: number, y: number, z: number) => inSet[idx(x, y, z)] === 1 && used[idx(x, y, z)] === 0;
  const out: CellBox[] = [];
  for (const e of [...cells].sort((a, b) => a - b)) {
    if (used[e]) continue;
    const x0 = e % g.nx;
    const y0 = Math.floor(e / g.nx) % g.ny;
    const z0 = Math.floor(e / (g.nx * g.ny));
    let x1 = x0 + 1;
    while (x1 < g.nx && free(x1, y0, z0)) x1++;
    let y1 = y0 + 1;
    grow: while (y1 < g.ny) {
      for (let x = x0; x < x1; x++) if (!free(x, y1, z0)) break grow;
      y1++;
    }
    let z1 = z0 + 1;
    growZ: while (z1 < g.nz) {
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (!free(x, y, z1)) break growZ;
      z1++;
    }
    for (let z = z0; z < z1; z++) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) used[idx(x, y, z)] = 1;
    out.push({ min: [x0, y0, z0], max: [x1, y1, z1] });
  }
  return out;
}

/** Chunk vs chips: tiny floating bits crumble into chips, larger ones fall as one piece. */
export const CHUNK_MIN_CELLS = 4;

// --- settling ------------------------------------------------------------------------

export interface SettleRule {
  /** below these speeds a body counts as resting */
  linear: number;
  angular: number;
  /** resting this long → settled, s */
  restTime: number;
  /** settled at or below this height (world y, m) → joins the pile, else fades out */
  pileMaxY: number;
  /** below this height → lost (fell off the world), removed */
  killY: number;
  /** still moving after this long → treated as settled, s */
  maxAge: number;
}

export type SettleVerdict = 'moving' | 'pile' | 'fade' | 'kill';

/** Settle decision for one chip given its state and how long it has been resting. */
export function settleVerdict(
  rule: SettleRule,
  y: number,
  speed: number,
  angSpeed: number,
  restFor: number,
  age: number,
  sleeping: boolean,
): SettleVerdict {
  if (y < rule.killY) return 'kill';
  const resting = sleeping || (speed < rule.linear && angSpeed < rule.angular && restFor >= rule.restTime);
  if (!resting && age < rule.maxAge) return 'moving';
  return y <= rule.pileMaxY ? 'pile' : 'fade';
}
