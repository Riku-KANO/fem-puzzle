// Three.js glue for the chunked voxel surface: one Mesh per non-empty chunk, rebuilt only
// when cells in or next to it change; colours repainted in place when utilisation arrives.
// Geometry is in grid units — the parent group scales by the voxel size.

import * as THREE from 'three';
import type { Grid } from '../game/grid.ts';
import {
  BLOCK_COLOR,
  KEEP_TINT,
  linearPalette,
  NEUTRAL,
  paintQuads,
  PALETTES,
  srgbToLinear,
  type PaintInput,
  type PaletteId,
} from './colormap.ts';
import { chunkLayout, chunksTouching, meshChunk, type ChunkLayout, type ChunkMesh } from './mesher.ts';

interface Chunk {
  data: ChunkMesh;
  mesh: THREE.Mesh;
  colors: THREE.BufferAttribute;
  flags: THREE.BufferAttribute;
}

/** Shared time uniform for the blink animation of over-stressed faces. */
export const timeUniform = { value: 0 };

/**
 * Lambert material with per-vertex flags (`aFlags`): bit 0 = protected (diagonal hatch),
 * bit 1 = over-stressed (pulsing glow), bit 2 = thinner than 2 voxels (T-308 warning dots),
 * plus thin voxel grid lines (faded out when zoomed far) so single voxels stay readable.
 * Flags are tested bitwise (`mod(floor(f / bit), 2.0)`). Clipping planes keep working (T-303).
 */
export function createVoxelMaterial(): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = timeUniform;
    const varyings = 'varying float vFlags;\nvarying vec3 vGridPos;\nvarying vec3 vObjNormal;';
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nattribute float aFlags;\n${varyings}`)
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nvObjNormal = objectNormal;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFlags = aFlags;\nvGridPos = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float uTime;\n${varyings}`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float scFlags = floor(vFlags + 0.5);
        if (mod(scFlags, 2.0) >= 1.0) {
          float stripe = step(0.5, fract((vGridPos.x + vGridPos.y + vGridPos.z) * 2.0));
          diffuseColor.rgb *= mix(0.62, 1.0, stripe);
        }
        // thin-wall warning (T-308): 3×3 dots per voxel face in grid space, dark ink on light
        // colours and light ink on dark ones; anti-aliased into an even tint when far away
        // (derivatives taken outside the per-quad branch)
        vec3 thinP = vGridPos * 3.0;
        float thinW = max(fwidth(thinP.x), max(fwidth(thinP.y), fwidth(thinP.z))) + 1e-4;
        if (mod(floor(scFlags / 4.0), 2.0) >= 1.0) {
          vec3 thinQ = abs(fract(thinP) - 0.5) * (1.0 - abs(vObjNormal));
          float thinDot = 1.0 - smoothstep(0.22 - thinW, 0.22 + thinW, length(thinQ));
          float thinLum = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
          vec3 thinInk = thinLum > 0.18
            ? diffuseColor.rgb * 0.3
            : mix(diffuseColor.rgb, vec3(1.0, 0.86, 0.55), 0.65);
          diffuseColor.rgb = mix(diffuseColor.rgb, thinInk, thinDot * 0.9);
        }
        {
          vec3 fw = fwidth(vGridPos);
          vec3 dist = abs(fract(vGridPos - 0.5) - 0.5);
          vec3 lines = 1.0 - smoothstep(fw * 0.4, fw * 1.4, dist);
          vec3 tangent = 1.0 - abs(vObjNormal);
          float edge = max(max(lines.x * tangent.x, lines.y * tangent.y), lines.z * tangent.z);
          edge *= 1.0 - smoothstep(0.12, 0.3, max(fw.x, max(fw.y, fw.z)));
          diffuseColor.rgb *= 1.0 - 0.2 * edge;
        }`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        if (mod(floor(scFlags / 2.0), 2.0) >= 1.0) {
          totalEmissiveRadiance += diffuseColor.rgb * (0.25 + 0.55 * (0.5 + 0.5 * sin(uTime * 7.0)));
        }`,
      );
  };
  mat.customProgramCacheKey = () => 'stress-carve-voxel-v3';
  return mat;
}

export class VoxelMesh {
  /** grid-unit group; add to a parent scaled by the voxel size */
  readonly group = new THREE.Group();
  private readonly layout: ChunkLayout;
  private readonly chunks: (Chunk | null)[];
  private readonly dirty = new Set<number>();
  private readonly material = createVoxelMaterial();
  private readonly paint: PaintInput;

  constructor(
    private readonly grid: Grid,
    /** live solid flags (mutated by the game state) */
    private readonly flags: Uint8Array,
    keep: Uint8Array,
    palette: PaletteId,
  ) {
    this.layout = chunkLayout(grid);
    this.chunks = new Array<Chunk | null>(this.layout.count).fill(null);
    this.paint = {
      palette: linearPalette(PALETTES[palette]),
      neutral: srgbToLinear(NEUTRAL),
      keepTint: srgbToLinear(KEEP_TINT),
      utilization: null,
      keep,
    };
    this.group.name = 'voxels';
    for (let c = 0; c < this.layout.count; c++) this.dirty.add(c);
    this.update();
  }

  /** Mark chunks around changed cells for rebuild at the next `update()`. */
  markDirty(cells: Iterable<number>): void {
    for (const c of chunksTouching(this.grid, this.layout, cells)) this.dirty.add(c);
  }

  /** Rebuild dirty chunks. Cheap when nothing changed; call every frame. */
  update(): void {
    if (this.dirty.size === 0) return;
    for (const c of this.dirty) this.rebuild(c);
    this.dirty.clear();
  }

  setUtilization(u: Float32Array | null): void {
    this.paint.utilization = u;
    this.repaintAll();
  }

  setPalette(id: PaletteId): void {
    this.paint.palette = linearPalette(PALETTES[id]);
    this.repaintAll();
  }

  /**
   * Thin-wall warning flags (T-308; live array — mark changed cells dirty), or null to hide
   * the tint.
   */
  setThin(thin: Uint8Array | null): void {
    this.paint.thin = thin;
    this.repaintAll();
  }

  /** Chunk meshes, e.g. for clipping/X-ray views (T-303) or deformation (T-302). */
  meshes(): { mesh: THREE.Mesh; data: ChunkMesh }[] {
    return this.chunks.filter((c): c is Chunk => c !== null).map((c) => ({ mesh: c.mesh, data: c.data }));
  }

  dispose(): void {
    for (const c of this.chunks) c?.mesh.geometry.dispose();
    this.material.dispose();
    this.group.clear();
  }

  private rebuild(index: number): void {
    const old = this.chunks[index];
    if (old) {
      this.group.remove(old.mesh);
      old.mesh.geometry.dispose();
      this.chunks[index] = null;
    }
    const data = meshChunk(this.grid, this.layout, index, this.flags);
    if (data.quadCount === 0) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
    const colors = new THREE.BufferAttribute(new Float32Array(data.quadCount * 12), 3);
    const flags = new THREE.BufferAttribute(new Uint8Array(data.quadCount * 4), 1);
    geo.setAttribute('color', colors);
    geo.setAttribute('aFlags', flags);
    geo.setIndex(new THREE.BufferAttribute(data.indices, 1));
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.name = `chunk-${index}`;
    mesh.matrixAutoUpdate = false;
    const chunk: Chunk = { data, mesh, colors, flags };
    this.repaint(chunk);
    this.chunks[index] = chunk;
    this.group.add(mesh);
  }

  private repaint(c: Chunk): void {
    paintQuads(c.data.quadElement, this.paint, c.colors.array as Float32Array, c.flags.array as Uint8Array);
    c.colors.needsUpdate = true;
    c.flags.needsUpdate = true;
  }

  private repaintAll(): void {
    for (const c of this.chunks) if (c) this.repaint(c);
  }
}

/** Static obstacle geometry (block cells), flat grey. */
export function buildBlockMesh(grid: Grid, block: Uint8Array): THREE.Group {
  const group = new THREE.Group();
  group.name = 'blocks';
  const layout = chunkLayout(grid);
  const color = new THREE.Color().setRGB(...srgbToLinear(BLOCK_COLOR));
  const material = new THREE.MeshLambertMaterial({ color });
  for (let c = 0; c < layout.count; c++) {
    const data = meshChunk(grid, layout, c, block);
    if (data.quadCount === 0) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
    geo.setIndex(new THREE.BufferAttribute(data.indices, 1));
    group.add(new THREE.Mesh(geo, material));
  }
  return group;
}
