// The T-307 environment assets (apps/web/public/assets, conventions in
// tools/blender/assets/README.md) as constants the placement maths and the debris physics
// need before (or without) loading the glbs. `assetSpec.test.ts` checks every number against
// `manifest.json` and the glb `extras`, so a re-export in Blender cannot drift silently.

import type { Vec3 } from '@stress-carve/protocol';

export type Aabb = { min: Vec3; max: Vec3 };

/** glb file stems in `public/assets/` */
export type AssetName =
  | 'workbench'
  | 'workshop'
  | 'jig_clamp'
  | 'jig_pin'
  | 'jig_roller'
  | 'jig_riser'
  | 'jig_cylinder'
  | 'jig_weight'
  | 'jig_spreader'
  | 'debris';

/**
 * Bench frame origin (= centre of the steel test-bed top) relative to the domain: the part
 * floats this far above the bed, at the domain's x/z centre (agreed T-102/T-307/T-302).
 */
export const BENCH_DROP = 0.16;

/** Local-frame bounds of each jig root (manifest `bounds`). */
export const JIG_BOUNDS: Record<
  'jig_clamp' | 'jig_pin' | 'jig_roller' | 'jig_riser' | 'jig_cylinder' | 'jig_weight' | 'jig_spreader',
  Aabb
> = {
  jig_clamp: { min: [-0.0605, -0.004, -0.0605], max: [0.0605, 0.054, 0.0605] },
  jig_pin: { min: [-0.045, 0, -0.0375], max: [0.045, 0.06, 0.0375] },
  jig_roller: { min: [-0.045, 0, -0.04], max: [0.045, 0.06, 0.04] },
  jig_riser: { min: [-0.035, 0, -0.035], max: [0.035, 1, 0.035] },
  jig_cylinder: { min: [-0.0329, 0, -0.0329], max: [0.0329, 0.244, 0.053] },
  jig_weight: { min: [-0.033, -0.123, -0.033], max: [0.033, 0, 0.033] },
  jig_spreader: { min: [-0.5, 0, -0.5], max: [0.5, 0.008, 0.5] },
};

export const CLAMP = {
  /** scale local X/Z by (patch + margin) / nominal */
  margin: 0.02,
  nominal: 0.1,
  depth: 0.054,
} as const;

export const PIN = {
  /** scale local X (pin axis) by patchLength / nominalLength */
  nominalLength: 0.08,
  depth: 0.06,
} as const;

export const CYLINDER = {
  padDiameter: 0.032,
  /** `cylinder_rod` retracts up to this far along local +Y from the rest pose */
  rodTravel: 0.04,
} as const;

export const SPREADER = { thickness: 0.008 } as const;

/** Weight stack drop when "unloaded" (T-302 stroke 0); not an asset number, a choice here. */
export const WEIGHT_LIFT = 0.02;

/** Debris colliders of the workbench, bench frame (workbench root `extras.colliders`). */
export const BENCH_COLLIDERS: readonly { name: string; center: Vec3; halfExtents: Vec3 }[] = [
  { name: 'bed', center: [0, -0.015, 0], halfExtents: [0.36, 0.015, 0.21] },
  { name: 'benchTop', center: [0, -0.06, 0], halfExtents: [0.8, 0.03, 0.4] },
  { name: 'floor', center: [0, -0.98, 1], halfExtents: [2, 0.05, 1.6] },
];

/** Steel test-bed top extent (bench frame, centred), for the shadow-catcher plane. */
export const BED_HALF: readonly [number, number] = [0.36, 0.21];

/** Debris pieces (debris.glb children): four convex chips and a curled swarf. */
export const PIECE_NAMES = ['chip_0', 'chip_1', 'chip_2', 'chip_3', 'swarf_0'] as const;
export type PieceName = (typeof PIECE_NAMES)[number];

/** Piece half extents (debris `extras.pieces`), m — the physics uses a box of this size. */
export const PIECE_HALF_EXTENTS: Record<PieceName, Vec3> = {
  chip_0: [0.00327, 0.00308, 0.00349],
  chip_1: [0.00438, 0.00169, 0.00326],
  chip_2: [0.00528, 0.002, 0.00215],
  chip_3: [0.00292, 0.00241, 0.00278],
  swarf_0: [0.00442, 0.00272, 0.00415],
};

/** Aluminium (debris `extras.density`). */
export const DEBRIS_DENSITY = 2700;
