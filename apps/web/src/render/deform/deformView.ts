// The load test's own voxel surface: chunk meshes of a private copy of the solid flags (so
// over-stressed cells can break off without touching the game state), carrying per-vertex
// displacement (`aDisp`, direct nodal lookup), the bent normals at full scale
// (`aNormalDelta`) and crack intensity (`aCrack`) for `deformMaterial.ts`.
// Geometry is in grid units, like `voxelMesh.ts`.

import * as THREE from 'three';
import type { Grid } from '../../game/grid.ts';
import { paintQuads, type PaintInput } from '../colormap.ts';
import { chunkLayout, chunksTouching, meshChunk, type ChunkLayout, type ChunkMesh } from '../mesher.ts';
import { normalDeltas, vertexDisplacements } from './deform.ts';
import { createDeformMaterial, createDeformUniforms, type DeformUniforms } from './deformMaterial.ts';

export interface DeformInput {
  /** cells to show (copied) */
  flags: Uint8Array;
  /** nodal displacement of the animated load case (m, 3 per node) */
  nodal: Float32Array;
  /** target exaggeration factor */
  scale: number;
  paint: PaintInput;
  /** per-element crack intensity 0..1 */
  crack: Float32Array;
}

/** Geometry for a set of chunk meshes, with the load-test attributes filled in. */
function buildGeometry(m: ChunkMesh, input: DeformInput, h: number, bakeFactor: number | null): THREE.BufferGeometry {
  const disp = vertexDisplacements(m.vertexNode, input.nodal, h);
  const nd = normalDeltas(m.positions, m.normals, disp, input.scale);
  const colors = new Float32Array(m.quadCount * 12);
  const flags = new Uint8Array(m.quadCount * 4);
  paintQuads(m.quadElement, input.paint, colors, flags);
  const crack = new Float32Array(m.quadCount * 4);
  for (let q = 0; q < m.quadCount; q++) crack.fill(input.crack[m.quadElement[q]!] ?? 0, q * 4, q * 4 + 4);

  let positions = m.positions;
  let normals = m.normals;
  if (bakeFactor !== null) {
    // rigid falling piece: freeze the current deformed shape, no further morphing
    positions = new Float32Array(m.positions);
    normals = new Float32Array(m.normals);
    const t = input.scale > 0 ? bakeFactor / input.scale : 0;
    for (let i = 0; i < positions.length; i++) positions[i] = positions[i]! + bakeFactor * disp[i]!;
    for (let v = 0; v < normals.length / 3; v++) {
      const x = normals[v * 3]! + t * nd[v * 3]!;
      const y = normals[v * 3 + 1]! + t * nd[v * 3 + 1]!;
      const z = normals[v * 3 + 2]! + t * nd[v * 3 + 2]!;
      const l = Math.hypot(x, y, z) || 1;
      normals[v * 3] = x / l;
      normals[v * 3 + 1] = y / l;
      normals[v * 3 + 2] = z / l;
    }
    disp.fill(0);
    nd.fill(0);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('aFlags', new THREE.BufferAttribute(flags, 1));
  geo.setAttribute('aDisp', new THREE.BufferAttribute(disp, 3));
  geo.setAttribute('aNormalDelta', new THREE.BufferAttribute(nd, 3));
  geo.setAttribute('aCrack', new THREE.BufferAttribute(crack, 1));
  geo.setIndex(new THREE.BufferAttribute(m.indices, 1));
  geo.computeBoundingSphere();
  if (geo.boundingSphere && bakeFactor === null) {
    // the vertex shader moves vertices by up to |aDisp|·scale: grow the culling sphere
    let maxD = 0;
    for (let v = 0; v < disp.length / 3; v++) {
      maxD = Math.max(maxD, Math.hypot(disp[v * 3]!, disp[v * 3 + 1]!, disp[v * 3 + 2]!));
    }
    geo.boundingSphere.radius += maxD * input.scale;
  }
  return geo;
}

/** Concatenate chunk meshes (falling pieces span several chunks). */
function mergeChunks(parts: ChunkMesh[]): ChunkMesh {
  const quads = parts.reduce((s, p) => s + p.quadCount, 0);
  const out: ChunkMesh = {
    quadCount: quads,
    positions: new Float32Array(quads * 12),
    normals: new Float32Array(quads * 12),
    indices: new Uint32Array(quads * 6),
    quadElement: new Uint32Array(quads),
    quadFace: new Uint8Array(quads),
    vertexNode: new Uint32Array(quads * 4),
  };
  let q = 0;
  for (const p of parts) {
    out.positions.set(p.positions, q * 12);
    out.normals.set(p.normals, q * 12);
    for (let i = 0; i < p.indices.length; i++) out.indices[q * 6 + i] = p.indices[i]! + q * 4;
    out.quadElement.set(p.quadElement, q);
    out.quadFace.set(p.quadFace, q);
    out.vertexNode.set(p.vertexNode, q * 4);
    q += p.quadCount;
  }
  return out;
}

export class DeformView {
  /** grid-unit group; add to the domain */
  readonly group = new THREE.Group();
  readonly uniforms: DeformUniforms = createDeformUniforms();
  readonly material: THREE.MeshLambertMaterial;
  /** same shader for falling pieces, but fading (transparent) and never morphing */
  readonly pieceMaterial: THREE.MeshLambertMaterial;
  private readonly layout: ChunkLayout;
  private readonly chunks: (THREE.Mesh | null)[];
  private input: DeformInput | null = null;
  private flags: Uint8Array;

  constructor(
    private readonly grid: Grid,
    private readonly h: number,
  ) {
    this.layout = chunkLayout(grid);
    this.chunks = new Array<THREE.Mesh | null>(this.layout.count).fill(null);
    this.flags = new Uint8Array(grid.n);
    this.material = createDeformMaterial(this.uniforms);
    // pieces share crack/flash state but are baked: aDisp = 0, so uDeform has no effect
    this.pieceMaterial = createDeformMaterial(this.uniforms);
    this.pieceMaterial.transparent = true;
    this.group.name = 'load-test-voxels';
  }

  /** Current (working) flags: the shown cells. */
  get shown(): Uint8Array {
    return this.flags;
  }

  /** Total quads currently shown (stats/tests). */
  get quadCount(): number {
    let n = 0;
    for (const c of this.chunks) if (c) n += (c.geometry.index?.count ?? 0) / 6;
    return n;
  }

  get meshCount(): number {
    return this.chunks.filter((c) => c !== null).length;
  }

  build(input: DeformInput): void {
    this.clear();
    this.input = input;
    this.flags = new Uint8Array(input.flags);
    for (let c = 0; c < this.layout.count; c++) this.rebuild(c);
  }

  /** Remove cells from the shown set and rebuild the chunks around them. */
  remove(cells: readonly number[]): void {
    if (cells.length === 0) return;
    for (const e of cells) this.flags[e] = 0;
    for (const c of chunksTouching(this.grid, this.layout, cells)) this.rebuild(c);
  }

  /** A standalone mesh of `cells`, frozen at deformation factor `factor` (falling piece). */
  pieceMesh(cells: readonly number[], factor: number): THREE.Mesh | null {
    const input = this.input;
    if (!input || cells.length === 0) return null;
    const only = new Uint8Array(this.grid.n);
    for (const e of cells) only[e] = 1;
    const touched = new Set<number>();
    for (const e of cells) {
      const x = e % this.grid.nx;
      const y = Math.floor(e / this.grid.nx) % this.grid.ny;
      const z = Math.floor(e / (this.grid.nx * this.grid.ny));
      const s = this.layout.size;
      touched.add(Math.floor(x / s) + this.layout.cx * (Math.floor(y / s) + this.layout.cy * Math.floor(z / s)));
    }
    const parts = [...touched].sort((a, b) => a - b).map((c) => meshChunk(this.grid, this.layout, c, only));
    const merged = mergeChunks(parts);
    if (merged.quadCount === 0) return null;
    const mesh = new THREE.Mesh(buildGeometry(merged, input, this.h, factor), this.pieceMaterial);
    mesh.name = 'load-test-piece';
    return mesh;
  }

  clear(): void {
    for (let c = 0; c < this.chunks.length; c++) {
      const m = this.chunks[c];
      if (m) {
        this.group.remove(m);
        m.geometry.dispose();
        this.chunks[c] = null;
      }
    }
    this.input = null;
  }

  dispose(): void {
    this.clear();
    this.material.dispose();
    this.pieceMaterial.dispose();
  }

  private rebuild(index: number): void {
    const old = this.chunks[index];
    if (old) {
      this.group.remove(old);
      old.geometry.dispose();
      this.chunks[index] = null;
    }
    if (!this.input) return;
    const m = meshChunk(this.grid, this.layout, index, this.flags);
    if (m.quadCount === 0) return;
    const mesh = new THREE.Mesh(buildGeometry(m, this.input, this.h, null), this.material);
    mesh.name = `load-test-chunk-${index}`;
    mesh.matrixAutoUpdate = false;
    this.chunks[index] = mesh;
    this.group.add(mesh);
  }
}
