// Section and X-ray views (design doc 3D表現・UI/UX: 断面ビュー, X線モード — seeing inside is the
// top UI priority). Pure: which cells a view draws opaque, draws translucent ("ghost") or
// hides, and what picking and the brush treat as present, so the player carves what they see.
//
// Section: an exact cut between two voxel layers. Cells beyond the plane are *hidden* — left
// out of the mesh — so the faces between kept and hidden solid cells become the cut face
// (cap), coloured by the utilisation of the cut cells like any other face. Hidden cells let
// picking rays through and count as empty for the brush's surface rule, so clicking the cut
// face carves the cut layer (hollowing a section from the inside).
// X-ray: solid cells whose utilisation is known and below a threshold are drawn translucent,
// so only the load path stays opaque. Ghost cells are still visible material: they stop
// picking rays, so the brush shaves the translucent skin (the material worth removing)
// instead of reaching through it into the load path.
//
// All masks are independent of the solid flags (mesh = solid & mask), so carving never has
// to touch them; they change only with the view settings or, in X-ray, the utilisation.

import type { Vec3 } from '@stress-carve/protocol';
import type { Axis, Grid } from '../../game/grid.ts';

export type ViewModeId = 'normal' | 'section' | 'xray';

export interface SectionSpec {
  axis: Axis;
  /** plane position along `axis` in layers, integer 0..n (n = grid size along the axis) */
  cut: number;
  /** false: keep cells with coordinate < cut (cut face looks towards +axis); true: keep ≥ cut */
  flip: boolean;
}

export interface ViewSpec {
  section: SectionSpec | null;
  /** X-ray threshold as a utilisation fraction (0.3 = 30 %); null = X-ray off */
  xray: number | null;
}

export const NORMAL_VIEW: ViewSpec = Object.freeze({ section: null, xray: null });
export const DEFAULT_XRAY_THRESHOLD = 0.3;

/** The settings behind the view-mode toggle (the UI keeps them in runes). */
export interface ViewSettingsLike {
  axis: Axis;
  cut: number;
  flip: boolean;
  /** X-ray threshold, fraction */
  threshold: number;
}

export function axisLength(g: Grid, axis: Axis): number {
  return axis === 0 ? g.nx : axis === 1 ? g.ny : g.nz;
}

/** Plane position snapped to a layer boundary inside the grid. */
export function clampCut(g: Grid, axis: Axis, cut: number): number {
  const n = axisLength(g, axis);
  if (!Number.isFinite(cut)) return Math.round(n / 2);
  return Math.min(n, Math.max(0, Math.round(cut)));
}

export function defaultCut(g: Grid, axis: Axis): number {
  return Math.round(axisLength(g, axis) / 2);
}

/**
 * The kept side that turns the cut face towards a viewer at `eye` (grid units): a viewer on
 * the + side of the grid centre sees the low half with its cap facing +axis, and vice versa.
 */
export function facingFlip(g: Grid, axis: Axis, eye: Vec3): boolean {
  return eye[axis] < axisLength(g, axis) / 2;
}

/** View for a mode + settings; settings are clamped (cut to a layer, threshold to 0..1). */
export function viewSpecFor(mode: ViewModeId, s: ViewSettingsLike, g: Grid): ViewSpec {
  switch (mode) {
    case 'section':
      return { section: { axis: s.axis, cut: clampCut(g, s.axis, s.cut), flip: s.flip }, xray: null };
    case 'xray':
      return { section: null, xray: Number.isFinite(s.threshold) ? Math.min(1, Math.max(0, s.threshold)) : DEFAULT_XRAY_THRESHOLD };
    default:
      return NORMAL_VIEW;
  }
}

/** Cell (x, y, z) lies on the kept side of the section (always true without one). */
export function keptBySection(s: SectionSpec | null, x: number, y: number, z: number): boolean {
  if (!s) return true;
  const c = s.axis === 0 ? x : s.axis === 1 ? y : z;
  return s.flip ? c >= s.cut : c < s.cut;
}

/**
 * X-ray ghost: utilisation known and below the threshold. Unsolved (null field), NaN and
 * over-stressed cells always stay opaque — failing material is never faded out.
 */
export function isGhost(threshold: number | null, util: Float32Array | null, e: number): boolean {
  if (threshold === null || !util) return false;
  const u = util[e];
  return u !== undefined && u < threshold;
}

export interface ViewMasks {
  /** 1 = cell on the kept side of the section; null = no section (everything kept) */
  section: Uint8Array | null;
  /** mesh mask of the opaque voxel mesh (kept, not ghost); null = every cell */
  opaque: Uint8Array | null;
  /** mesh mask of the translucent voxel mesh; null = no ghost cells */
  ghost: Uint8Array | null;
}

export const NO_MASKS: ViewMasks = Object.freeze({ section: null, opaque: null, ghost: null });

/** Per-cell masks of a view. `util` is the per-element utilisation (envelope) or null. */
export function viewMasks(g: Grid, spec: ViewSpec, util: Float32Array | null): ViewMasks {
  const s = spec.section;
  let section: Uint8Array | null = null;
  if (s) {
    section = new Uint8Array(g.n);
    let e = 0;
    for (let z = 0; z < g.nz; z++) {
      for (let y = 0; y < g.ny; y++) {
        for (let x = 0; x < g.nx; x++, e++) section[e] = keptBySection(s, x, y, z) ? 1 : 0;
      }
    }
  }
  if (spec.xray === null || !util) return { section, opaque: section, ghost: null };
  const opaque = new Uint8Array(g.n);
  const ghost = new Uint8Array(g.n);
  for (let e = 0; e < g.n; e++) {
    if (section && !section[e]) continue;
    if (isGhost(spec.xray, util, e)) ghost[e] = 1;
    else opaque[e] = 1;
  }
  return { section, opaque, ghost };
}

export type CellLook = 'empty' | 'hidden' | 'ghost' | 'opaque';

/** How the view shows a solid/empty cell (tests, debugging). */
export function cellLook(masks: ViewMasks, solid: Uint8Array, e: number): CellLook {
  if (!solid[e]) return 'empty';
  if (masks.section && !masks.section[e]) return 'hidden';
  return masks.ghost?.[e] ? 'ghost' : 'opaque';
}

/** Hidden by the view: does not stop picking rays, counts as empty for the brush. */
export function hiddenByView(masks: ViewMasks, e: number): boolean {
  return masks.section !== null && masks.section[e] === 0;
}

/**
 * Cells that stop picking rays: solid or obstacle cells that the view does not hide
 * (ghosts included — they are visible material).
 */
export function pickPredicate(
  masks: ViewMasks,
  cells: { solid: Uint8Array; block: Uint8Array },
): (e: number) => boolean {
  const { solid, block } = cells;
  const section = masks.section;
  if (!section) return (e) => solid[e] === 1 || block[e] === 1;
  return (e) => section[e] === 1 && (solid[e] === 1 || block[e] === 1);
}
