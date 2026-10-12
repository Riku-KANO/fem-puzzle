// Three.js side of the section / X-ray views (see visibility.ts for the rules).
//
// Why meshing instead of GPU clipping planes + stencil caps: on a voxel grid the cut always
// lies on a layer boundary, so masking the cells and re-meshing is *exact* — the cap is made
// of ordinary mesher quads between kept and hidden solid cells, coloured by the cut cell's
// utilisation, carrying `quadElement`/`vertexNode` like every other quad (deformation, picking
// and overlays treat it like any surface). A remesh of a 40×12×12 grid costs ~0.5 ms, and only
// chunks whose mask changed are rebuilt. No stencil passes, no shader changes, no z-fighting.
//
// Layers: the scene's opaque `VoxelMesh` gets the opaque mask; a second `VoxelMesh` over the
// same live solid flags draws the X-ray ghost cells with a translucent copy of the voxel
// material; obstacles (block cells) are re-meshed with the section mask; a thin frame marks
// the cut plane.

import type { Vec3 } from '@stress-carve/protocol';
import * as THREE from 'three';
import type { Grid } from '../../game/grid.ts';
import type { PaletteId } from '../colormap.ts';
import { buildBlockMesh, VoxelMesh } from '../voxelMesh.ts';
import {
  facingFlip,
  hiddenByView,
  NO_MASKS,
  NORMAL_VIEW,
  pickPredicate,
  viewMasks,
  type SectionSpec,
  type ViewMasks,
  type ViewSpec,
} from './visibility.ts';

/** Opacity of X-ray ghost faces. */
export const GHOST_OPACITY = 0.14;
const OUTLINE_COLOR = 0xf0a23b;
/** frame margin around the grid and offset towards the viewer, grid units */
const OUTLINE_MARGIN = 0.25;
const OUTLINE_LIFT = 0.02;

export interface ViewCells {
  grid: Grid;
  /** live solid flags */
  solid: Uint8Array;
  keep: Uint8Array;
  block: Uint8Array;
}

export class ViewLayers {
  /** grid-unit group (ghost mesh, obstacles, cut frame); add to the voxel-size-scaled domain */
  readonly group = new THREE.Group();
  /** translucent X-ray mesh (T-302 hides `ghost.group` during the load test) */
  readonly ghost: VoxelMesh;
  private spec: ViewSpec = NORMAL_VIEW;
  private masks: ViewMasks = NO_MASKS;
  private util: Float32Array | null = null;
  private pick: (e: number) => boolean;
  private blocks: THREE.Group | null = null;
  private readonly hasBlocks: boolean;
  private readonly noGhosts: Uint8Array;
  private readonly outline: THREE.LineLoop;

  constructor(
    private readonly cells: ViewCells,
    /** the scene's opaque voxel mesh */
    private readonly voxels: VoxelMesh,
    palette: PaletteId,
    /** camera position in grid units (for the default cut side) */
    private readonly eye: () => Vec3,
  ) {
    const g = cells.grid;
    this.group.name = 'views';
    this.noGhosts = new Uint8Array(g.n);

    this.ghost = new VoxelMesh(g, cells.solid, cells.keep, palette);
    this.ghost.group.name = 'xray-ghost';
    const m = this.ghost.material;
    m.transparent = true;
    m.opacity = GHOST_OPACITY;
    m.depthWrite = false;
    this.ghost.setMask(this.noGhosts);
    this.ghost.update();
    this.group.add(this.ghost.group);

    this.hasBlocks = cells.block.some((b) => b === 1);
    this.rebuildBlocks();

    this.outline = new THREE.LineLoop(
      new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3)),
      new THREE.LineBasicMaterial({ color: OUTLINE_COLOR, transparent: true, opacity: 0.85 }),
    );
    this.outline.name = 'section-frame';
    this.outline.visible = false;
    this.outline.frustumCulled = false;
    this.group.add(this.outline);

    this.pick = pickPredicate(this.masks, cells);
  }

  get view(): ViewSpec {
    return this.spec;
  }

  /** Cells kept by the section (1) — null when no section is active (T-302 load test). */
  get sectionMask(): Uint8Array | null {
    return this.masks.section;
  }

  set(spec: ViewSpec): void {
    const sectionChanged = !sameSection(this.spec.section, spec.section);
    this.spec = spec;
    this.refresh();
    if (sectionChanged) {
      this.rebuildBlocks();
      this.placeOutline(spec.section);
    }
  }

  /** Default kept side for a new section on `axis`: the cut face looks at the camera. */
  facingFlip(axis: SectionSpec['axis']): boolean {
    return facingFlip(this.cells.grid, axis, this.eye());
  }

  /** Cell stops picking rays in the current view. */
  pickable(e: number): boolean {
    return this.pick(e);
  }

  /** Cell is hidden by the current view (brush: counts as empty, never carved). */
  isHidden(e: number): boolean {
    return hiddenByView(this.masks, e);
  }

  // --- forwarded from the scene ----------------------------------------------

  solidChanged(cells: readonly number[]): void {
    this.ghost.markDirty(cells);
  }

  setUtilization(u: Float32Array | null): void {
    this.util = u;
    this.ghost.setUtilization(u);
    if (this.spec.xray !== null) this.refresh();
  }

  setPalette(id: PaletteId): void {
    this.ghost.setPalette(id);
  }

  update(): void {
    this.ghost.update();
  }

  dispose(): void {
    this.ghost.dispose();
    this.disposeBlocks();
    this.outline.geometry.dispose();
    (this.outline.material as THREE.Material).dispose();
    this.group.clear();
  }

  // --- internals --------------------------------------------------------------

  private refresh(): void {
    this.masks = viewMasks(this.cells.grid, this.spec, this.util);
    this.voxels.setMask(this.masks.opaque);
    this.ghost.setMask(this.masks.ghost ?? this.noGhosts);
    this.pick = pickPredicate(this.masks, this.cells);
  }

  private rebuildBlocks(): void {
    if (!this.hasBlocks) return;
    this.disposeBlocks();
    const { block } = this.cells;
    const section = this.masks.section;
    let flags = block;
    if (section) {
      flags = new Uint8Array(block.length);
      for (let e = 0; e < block.length; e++) flags[e] = block[e] && section[e] ? 1 : 0;
    }
    this.blocks = buildBlockMesh(this.cells.grid, flags);
    this.group.add(this.blocks);
  }

  private disposeBlocks(): void {
    if (!this.blocks) return;
    this.group.remove(this.blocks);
    const materials = new Set<THREE.Material>();
    this.blocks.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        materials.add(o.material as THREE.Material);
      }
    });
    for (const m of materials) m.dispose();
    this.blocks = null;
  }

  private placeOutline(s: SectionSpec | null): void {
    this.outline.visible = s !== null;
    if (!s) return;
    const g = this.cells.grid;
    const dims = [g.nx, g.ny, g.nz];
    const a = s.axis;
    const u = (a + 1) % 3;
    const v = (a + 2) % 3;
    // lift the frame off the cap towards the hidden side (where the viewer looks from)
    const at = s.cut + (s.flip ? -OUTLINE_LIFT : OUTLINE_LIFT);
    const corners: [number, number][] = [
      [-OUTLINE_MARGIN, -OUTLINE_MARGIN],
      [dims[u]! + OUTLINE_MARGIN, -OUTLINE_MARGIN],
      [dims[u]! + OUTLINE_MARGIN, dims[v]! + OUTLINE_MARGIN],
      [-OUTLINE_MARGIN, dims[v]! + OUTLINE_MARGIN],
    ];
    const pos = this.outline.geometry.getAttribute('position') as THREE.BufferAttribute;
    const p = [0, 0, 0];
    corners.forEach(([cu, cv], i) => {
      p[a] = at;
      p[u] = cu;
      p[v] = cv;
      pos.setXYZ(i, p[0]!, p[1]!, p[2]!);
    });
    pos.needsUpdate = true;
  }
}

function sameSection(a: SectionSpec | null, b: SectionSpec | null): boolean {
  if (a === null || b === null) return a === b;
  return a.axis === b.axis && a.cut === b.cut && a.flip === b.flip;
}
