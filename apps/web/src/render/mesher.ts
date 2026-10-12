// Chunked voxel surface mesher (design doc 描画とメモリ: 隣接面を間引いた外皮メッシュ、削った
// 周辺のチャンクだけを再生成). Pure: produces typed arrays in grid units (1 voxel = 1, origin at
// the grid's min corner); `voxelMesh.ts` turns them into Three.js geometry.
//
// A quad is emitted for every face between a flagged cell and a non-flagged cell (or the
// grid boundary). Mesh vertices are grid nodes, so each vertex also carries its node index —
// the deformation view (T-302) displaces vertices by direct lookup in the nodal solution.

import { FACE_DIRS, nodeIndexOf, type Grid } from '../game/grid.ts';

export const CHUNK_SIZE = 8;

export interface ChunkLayout {
  size: number;
  /** chunk counts per axis */
  cx: number;
  cy: number;
  cz: number;
  count: number;
}

export function chunkLayout(g: Grid, size = CHUNK_SIZE): ChunkLayout {
  const cx = Math.ceil(g.nx / size);
  const cy = Math.ceil(g.ny / size);
  const cz = Math.ceil(g.nz / size);
  return { size, cx, cy, cz, count: cx * cy * cz };
}

export function chunkOfCell(l: ChunkLayout, x: number, y: number, z: number): number {
  const s = l.size;
  return Math.floor(x / s) + l.cx * (Math.floor(y / s) + l.cy * Math.floor(z / s));
}

/**
 * Chunks whose surface may change when the given cells flip: each cell's own chunk plus the
 * chunk of any face neighbour in a different chunk.
 */
export function chunksTouching(g: Grid, l: ChunkLayout, cells: Iterable<number>): Set<number> {
  const out = new Set<number>();
  const s = l.size;
  for (const e of cells) {
    const x = e % g.nx;
    const yz = (e - x) / g.nx;
    const y = yz % g.ny;
    const z = (yz - y) / g.ny;
    out.add(chunkOfCell(l, x, y, z));
    if (x % s === 0 && x > 0) out.add(chunkOfCell(l, x - 1, y, z));
    if (x % s === s - 1 && x < g.nx - 1) out.add(chunkOfCell(l, x + 1, y, z));
    if (y % s === 0 && y > 0) out.add(chunkOfCell(l, x, y - 1, z));
    if (y % s === s - 1 && y < g.ny - 1) out.add(chunkOfCell(l, x, y + 1, z));
    if (z % s === 0 && z > 0) out.add(chunkOfCell(l, x, y, z - 1));
    if (z % s === s - 1 && z < g.nz - 1) out.add(chunkOfCell(l, x, y, z + 1));
  }
  return out;
}

export interface ChunkMesh {
  quadCount: number;
  /** 4 vertices × xyz per quad, grid units */
  positions: Float32Array;
  /** 4 vertices × xyz per quad */
  normals: Float32Array;
  /** 2 triangles per quad, counter-clockwise seen from outside */
  indices: Uint32Array;
  /** element index per quad (picking, colouring) */
  quadElement: Uint32Array;
  /** face direction 0..5 (x- x+ y- y+ z- z+) per quad */
  quadFace: Uint8Array;
  /** grid node index per vertex (deformation lookup) */
  vertexNode: Uint32Array;
}

/**
 * Corner offsets (in the two tangent axes u = axis+1, v = axis+2) of a face quad, ordered
 * counter-clockwise when seen from outside: u × v = +axis, so + faces go (0,0)(1,0)(1,1)(0,1)
 * and − faces the reverse.
 */
const CORNERS_POS: readonly (readonly [number, number])[] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];
const CORNERS_NEG: readonly (readonly [number, number])[] = [
  [0, 0],
  [0, 1],
  [1, 1],
  [1, 0],
];

/** Surface of `flags` restricted to the cells of one chunk. */
export function meshChunk(g: Grid, l: ChunkLayout, chunk: number, flags: Uint8Array): ChunkMesh {
  const s = l.size;
  const ccx = chunk % l.cx;
  const ccy = Math.floor(chunk / l.cx) % l.cy;
  const ccz = Math.floor(chunk / (l.cx * l.cy));
  const x0 = ccx * s;
  const y0 = ccy * s;
  const z0 = ccz * s;
  const x1 = Math.min(x0 + s, g.nx);
  const y1 = Math.min(y0 + s, g.ny);
  const z1 = Math.min(z0 + s, g.nz);
  const sx = 1;
  const sy = g.nx;
  const sz = g.nx * g.ny;

  // pass 1: count quads
  let quads = 0;
  for (let z = z0; z < z1; z++) {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const e = x + sy * y + sz * z;
        if (!flags[e]) continue;
        if (x === 0 || !flags[e - sx]) quads++;
        if (x === g.nx - 1 || !flags[e + sx]) quads++;
        if (y === 0 || !flags[e - sy]) quads++;
        if (y === g.ny - 1 || !flags[e + sy]) quads++;
        if (z === 0 || !flags[e - sz]) quads++;
        if (z === g.nz - 1 || !flags[e + sz]) quads++;
      }
    }
  }

  const positions = new Float32Array(quads * 12);
  const normals = new Float32Array(quads * 12);
  const indices = new Uint32Array(quads * 6);
  const quadElement = new Uint32Array(quads);
  const quadFace = new Uint8Array(quads);
  const vertexNode = new Uint32Array(quads * 4);

  // pass 2: emit
  let q = 0;
  const cell = [0, 0, 0];
  const p = [0, 0, 0];
  for (let z = z0; z < z1; z++) {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const e = x + sy * y + sz * z;
        if (!flags[e]) continue;
        cell[0] = x;
        cell[1] = y;
        cell[2] = z;
        for (let dir = 0; dir < 6; dir++) {
          if (!exposed(g, flags, e, x, y, z, dir)) continue;
          const { axis, sign, normal } = FACE_DIRS[dir]!;
          const u = (axis + 1) % 3;
          const v = (axis + 2) % 3;
          const corners = sign > 0 ? CORNERS_POS : CORNERS_NEG;
          for (let c = 0; c < 4; c++) {
            const corner = corners[c]!;
            p[0] = cell[0]!;
            p[1] = cell[1]!;
            p[2] = cell[2]!;
            p[axis] = cell[axis]! + (sign > 0 ? 1 : 0);
            p[u] = cell[u]! + corner[0];
            p[v] = cell[v]! + corner[1];
            const vi = q * 4 + c;
            positions[vi * 3] = p[0];
            positions[vi * 3 + 1] = p[1];
            positions[vi * 3 + 2] = p[2];
            normals[vi * 3] = normal[0];
            normals[vi * 3 + 1] = normal[1];
            normals[vi * 3 + 2] = normal[2];
            vertexNode[vi] = nodeIndexOf(g, p[0], p[1], p[2]);
          }
          const b = q * 4;
          indices.set([b, b + 1, b + 2, b, b + 2, b + 3], q * 6);
          quadElement[q] = e;
          quadFace[q] = dir;
          q++;
        }
      }
    }
  }
  return { quadCount: quads, positions, normals, indices, quadElement, quadFace, vertexNode };
}

function exposed(
  g: Grid,
  flags: Uint8Array,
  e: number,
  x: number,
  y: number,
  z: number,
  dir: number,
): boolean {
  switch (dir) {
    case 0:
      return x === 0 || !flags[e - 1];
    case 1:
      return x === g.nx - 1 || !flags[e + 1];
    case 2:
      return y === 0 || !flags[e - g.nx];
    case 3:
      return y === g.ny - 1 || !flags[e + g.nx];
    case 4:
      return z === 0 || !flags[e - g.nx * g.ny];
    default:
      return z === g.nz - 1 || !flags[e + g.nx * g.ny];
  }
}

/** Total quad count over all chunks (tests, stats). */
export function countSurfaceQuads(g: Grid, flags: Uint8Array, size = CHUNK_SIZE): number {
  const l = chunkLayout(g, size);
  let total = 0;
  for (let c = 0; c < l.count; c++) total += meshChunk(g, l, c, flags).quadCount;
  return total;
}
