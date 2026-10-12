// The optimiser's solution as a voxel layer in the 3D view (design doc 演出: 最適化解と半透明で
// 重ねて比較). A separate group under the scene's grid-unit `domain` — the player's voxel mesh
// and material are not touched; "only" mode merely hides the player's voxel group.
//
//   overlay: translucent ghost drawn over the player's design (polygon offset wins at faces the
//            two designs share, so shared surface reads tinted, benchmark-only material reads
//            as a ghost in the air, player-only material stays untinted);
//   only:    the benchmark opaque, the player's voxels hidden.

import * as THREE from 'three';
import type { Grid } from '../../game/grid.ts';
import { chunkLayout, meshChunk } from '../../render/mesher.ts';

export type OverlayMode = 'off' | 'overlay' | 'only';

export const OVERLAY_COLOR = 0x5cc8ff;
const GHOST_OPACITY = 0.32;

/** What the overlay needs from the 3D view (structurally `StageScene`). */
export interface OverlayHost {
  /** grid-unit group (scaled by the voxel size) */
  readonly domain: THREE.Object3D;
  /** the player's voxel surface */
  readonly voxels: { readonly group: THREE.Object3D };
}

/** Pure part: the benchmark surface as typed arrays (one mesh over the whole grid). */
export function benchmarkSurface(grid: Grid, flags: Uint8Array) {
  const layout = chunkLayout(grid, Math.max(grid.nx, grid.ny, grid.nz));
  return meshChunk(grid, layout, 0, flags);
}

export class BenchmarkOverlay {
  readonly group = new THREE.Group();
  private readonly geometry: THREE.BufferGeometry;
  private readonly edges: THREE.BufferGeometry;
  private readonly ghost: THREE.MeshLambertMaterial;
  private readonly opaque: THREE.MeshLambertMaterial;
  private readonly lineMat: THREE.LineBasicMaterial;
  private readonly mesh: THREE.Mesh;
  private mode: OverlayMode = 'off';
  private hidPlayer = false;

  constructor(
    private readonly host: OverlayHost,
    grid: Grid,
    flags: Uint8Array,
  ) {
    const s = benchmarkSurface(grid, flags);
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(s.positions, 3));
    this.geometry.setAttribute('normal', new THREE.BufferAttribute(s.normals, 3));
    this.geometry.setIndex(new THREE.BufferAttribute(s.indices, 1));
    this.geometry.computeBoundingSphere();
    // crease edges only (coplanar quad seams are dropped) → a readable outline of the shape
    this.edges = new THREE.EdgesGeometry(this.geometry, 1);

    const color = new THREE.Color(OVERLAY_COLOR);
    this.ghost = new THREE.MeshLambertMaterial({
      color,
      emissive: color.clone().multiplyScalar(0.35),
      transparent: true,
      opacity: GHOST_OPACITY,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -4,
    });
    this.opaque = new THREE.MeshLambertMaterial({ color, emissive: color.clone().multiplyScalar(0.12) });
    this.lineMat = new THREE.LineBasicMaterial({ color: 0xbfeaff, transparent: true, opacity: 0.85, depthWrite: false });

    this.mesh = new THREE.Mesh(this.geometry, this.ghost);
    this.mesh.renderOrder = 3;
    this.mesh.name = 'benchmark-surface';
    const lines = new THREE.LineSegments(this.edges, this.lineMat);
    lines.renderOrder = 4;
    lines.name = 'benchmark-edges';
    this.group.add(this.mesh, lines);
    this.group.name = 'benchmark-overlay';
    this.group.visible = false;
    host.domain.add(this.group);
  }

  get currentMode(): OverlayMode {
    return this.mode;
  }

  setMode(mode: OverlayMode): void {
    this.mode = mode;
    this.group.visible = mode !== 'off';
    this.mesh.material = mode === 'only' ? this.opaque : this.ghost;
    this.lineMat.opacity = mode === 'only' ? 0.35 : 0.85;
    const hide = mode === 'only';
    if (hide !== this.hidPlayer) {
      this.host.voxels.group.visible = !hide;
      this.hidPlayer = hide;
    }
  }

  dispose(): void {
    this.setMode('off');
    this.host.domain.remove(this.group);
    this.geometry.dispose();
    this.edges.dispose();
    this.ghost.dispose();
    this.opaque.dispose();
    this.lineMat.dispose();
  }
}
