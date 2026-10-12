// Stage format — TypeScript twin of `crates/stage`. Normative spec: docs/specs/stage-format.md

export const STAGE_FORMAT_VERSION = 1;

export type Vec3 = [number, number, number];
export type Face = 'x-' | 'x+' | 'y-' | 'y+' | 'z-' | 'z+';
export const FACES: readonly Face[] = ['x-', 'x+', 'y-', 'y+', 'z-', 'z+'];

/** base64 bitmask over elements; bit e = byte e>>3, bit e&7 (LSB first). */
export type Bitmask = string;

export interface Material {
  /** Young's modulus (Pa) */
  E: number;
  nu: number;
  /** allowable von Mises stress (Pa) */
  allowable: number;
  /** kg/m³ (display only) */
  density?: number;
}

export interface Support {
  face: Face;
  /** non-empty subset of "xyz" */
  fix: string;
  cells?: Vec3[];
}

export interface Load {
  cells: Vec3[];
  /** total force (N), split equally among cells */
  force: Vec3;
}

export interface LoadCase {
  name: string;
  loads: Load[];
}

export interface Targets {
  star1: number;
  star2: number;
  star3: number;
}

export interface Benchmark {
  volume: number;
  solid: Bitmask;
  maxUtilization?: number;
  method?: string;
}

export interface Stage {
  version: 1;
  id: string;
  title: string;
  world: number;
  grid: Vec3;
  voxelSize: number;
  material: Material;
  solid: Bitmask;
  keep: Bitmask;
  block?: Bitmask;
  supports: Support[];
  loads: Load[];
  loadCases?: LoadCase[];
  maxDisplacement?: number;
  targets: Targets;
  benchmark?: Benchmark;
  hints?: string[];
}

// ---------------------------------------------------------------------------
// Indexing

export function elementCount(grid: Vec3): number {
  return grid[0] * grid[1] * grid[2];
}

export function nodeCount(grid: Vec3): number {
  return (grid[0] + 1) * (grid[1] + 1) * (grid[2] + 1);
}

/** e = x + nx * (y + ny * z) */
export function elementIndex(grid: Vec3, x: number, y: number, z: number): number {
  return x + grid[0] * (y + grid[1] * z);
}

export function elementCoords(grid: Vec3, e: number): Vec3 {
  const x = e % grid[0];
  const yz = (e - x) / grid[0];
  const y = yz % grid[1];
  const z = (yz - y) / grid[1];
  return [x, y, z];
}

/** n = i + (nx+1) * (j + (ny+1) * k) */
export function nodeIndex(grid: Vec3, i: number, j: number, k: number): number {
  return i + (grid[0] + 1) * (j + (grid[1] + 1) * k);
}

// ---------------------------------------------------------------------------
// Bitmask codec

export function encodeBitmask(bits: ArrayLike<boolean | number>): Bitmask {
  const bytes = new Uint8Array(Math.ceil(bits.length / 8));
  for (let e = 0; e < bits.length; e++) {
    if (bits[e]) bytes[e >> 3]! |= 1 << (e & 7);
  }
  return bytesToBase64(bytes);
}

/** Decode into a Uint8Array of 0/1 flags of length n. Throws on length mismatch. */
export function decodeBitmask(mask: Bitmask, n: number): Uint8Array {
  const bytes = base64ToBytes(mask);
  const expected = Math.ceil(n / 8);
  if (bytes.length !== expected) {
    throw new Error(`bitmask has ${bytes.length} bytes, expected ${expected} for ${n} elements`);
  }
  const out = new Uint8Array(n);
  for (let e = 0; e < n; e++) out[e] = (bytes[e >> 3]! >> (e & 7)) & 1;
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------
// Semantics shared with the solver

/** `loadCases` if present, otherwise `loads` as a single case. */
export function stageCases(stage: Stage): LoadCase[] {
  if (stage.loadCases && stage.loadCases.length > 0) return stage.loadCases;
  return [{ name: 'default', loads: stage.loads }];
}

const FACE_AXIS: Record<Face, 0 | 1 | 2> = { 'x-': 0, 'x+': 0, 'y-': 1, 'y+': 1, 'z-': 2, 'z+': 2 };

/**
 * Element indices of one support: the listed `cells`, or — for a face-only support — every
 * initially solid cell touching that grid face. Mirrors `Stage::support_cells` in Rust.
 */
export function supportCells(stage: Stage, support: Support, solid: Uint8Array): number[] {
  const g = stage.grid;
  if (support.cells) return support.cells.map((c) => elementIndex(g, c[0], c[1], c[2]));
  const axis = FACE_AXIS[support.face];
  const layer = support.face.endsWith('+') ? g[axis] - 1 : 0;
  const out: number[] = [];
  for (let z = 0; z < g[2]; z++) {
    for (let y = 0; y < g[1]; y++) {
      for (let x = 0; x < g[0]; x++) {
        const e = elementIndex(g, x, y, z);
        if ([x, y, z][axis] === layer && solid[e] === 1) out.push(e);
      }
    }
  }
  return out;
}

/** Supported cells of all supports as 0/1 flags (connectivity is measured from these). */
export function supportedCells(stage: Stage): Uint8Array {
  const n = elementCount(stage.grid);
  const solid = decodeBitmask(stage.solid, n);
  const out = new Uint8Array(n);
  for (const s of stage.supports) for (const e of supportCells(stage, s, solid)) out[e] = 1;
  return out;
}

/** keep ∪ supported cells ∪ load cells, as 0/1 flags. */
export function effectiveKeep(stage: Stage): Uint8Array {
  const keep = decodeBitmask(stage.keep, elementCount(stage.grid));
  const supported = supportedCells(stage);
  for (let e = 0; e < keep.length; e++) keep[e]! |= supported[e]!;
  for (const lc of stageCases(stage)) {
    for (const l of lc.loads) for (const c of l.cells) keep[elementIndex(stage.grid, c[0], c[1], c[2])] = 1;
  }
  return keep;
}

/** Validation mirroring `Stage::validate` in Rust. Returns a list of problems (empty = valid). */
export function validateStage(stage: Stage): string[] {
  const errors: string[] = [];
  if (stage.version !== STAGE_FORMAT_VERSION) errors.push(`unsupported version ${stage.version}`);
  const [nx, ny, nz] = stage.grid;
  if (!(nx > 0 && ny > 0 && nz > 0)) return [...errors, 'grid dimensions must be positive'];
  if (!(stage.voxelSize > 0)) errors.push('voxelSize must be positive');
  const m = stage.material;
  if (!(m.E > 0) || !(m.allowable > 0) || !(m.nu > -1 && m.nu < 0.5)) {
    errors.push('material constants out of range');
  }
  const n = elementCount(stage.grid);
  let solid: Uint8Array;
  let keep: Uint8Array;
  try {
    solid = decodeBitmask(stage.solid, n);
    keep = decodeBitmask(stage.keep, n);
  } catch (e) {
    return [...errors, String(e)];
  }
  if (!solid.some((s) => s === 1)) errors.push('solid is empty');
  if (keep.some((k, e) => k === 1 && solid[e] === 0)) errors.push('keep must be a subset of solid');
  if (stage.block) {
    try {
      const block = decodeBitmask(stage.block, n);
      if (block.some((b, e) => b === 1 && solid[e] === 1)) errors.push('block must not intersect solid');
    } catch (e) {
      errors.push(String(e));
    }
  }
  const solidCell = (c: Vec3) =>
    c[0] >= 0 && c[0] < nx && c[1] >= 0 && c[1] < ny && c[2] >= 0 && c[2] < nz &&
    solid[elementIndex(stage.grid, c[0], c[1], c[2])] === 1;
  if (stage.supports.length === 0) errors.push('at least one support is required');
  for (const s of stage.supports) {
    if (!/^[xyz]+$/.test(s.fix)) errors.push(`bad support fix ${JSON.stringify(s.fix)}`);
    for (const c of s.cells ?? []) if (!solidCell(c)) errors.push(`support cell ${c} is not a solid cell`);
  }
  for (const lc of stageCases(stage)) {
    if (lc.loads.length === 0) errors.push(`load case ${lc.name} has no loads`);
    for (const l of lc.loads) {
      if (l.cells.length === 0) errors.push('load without cells');
      for (const c of l.cells) if (!solidCell(c)) errors.push(`load cell ${c} is not a solid cell`);
    }
  }
  const t = stage.targets;
  if (!(t.star1 > t.star2 && t.star2 > t.star3 && t.star3 > 0 && t.star1 <= 1)) {
    errors.push('targets must satisfy 1 >= star1 > star2 > star3 > 0');
  }
  return errors;
}
