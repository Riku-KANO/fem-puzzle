// The constants in assetSpec.ts mirror the T-307 export; a Blender re-export that changes a
// jig or the bench must fail here instead of misplacing things at runtime.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BENCH_COLLIDERS,
  BED_HALF,
  CHIP_HALF_EXTENTS,
  CHIP_NAMES,
  CLAMP,
  CYLINDER,
  DEBRIS_DENSITY,
  JIG_BOUNDS,
  PIN,
  SPREADER,
} from './assetSpec.ts';

const assetsDir = new URL('../../../public/assets/', import.meta.url);

interface ManifestFile {
  bounds?: [[number, number, number], [number, number, number]];
  depth?: number;
  padDiameter?: number;
  rodTravel?: number;
  thickness?: number;
  nominalPatch?: [number, number];
  nodes?: string[];
}

const manifest = JSON.parse(readFileSync(new URL('manifest.json', assetsDir), 'utf8')) as {
  files: Record<string, ManifestFile>;
};

/** The root node's `extras` of a .glb (JSON chunk only). */
function rootExtras(file: string): Record<string, unknown> {
  const buf = readFileSync(new URL(file, assetsDir));
  const len = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + len).toString('utf8')) as {
    scenes: { nodes: number[] }[];
    nodes: { name: string; extras?: Record<string, unknown> }[];
  };
  const root = json.nodes[json.scenes[0]!.nodes[0]!]!;
  return root.extras ?? {};
}

describe('asset constants match apps/web/public/assets', () => {
  it('jig bounds', () => {
    for (const [name, box] of Object.entries(JIG_BOUNDS)) {
      const m = manifest.files[`${name}.glb`];
      expect(m, name).toBeDefined();
      expect([box.min, box.max]).toEqual(m!.bounds);
    }
  });

  it('jig parameters', () => {
    expect(CLAMP.depth).toBe(manifest.files['jig_clamp.glb']!.depth);
    expect(PIN.depth).toBe(manifest.files['jig_pin.glb']!.depth);
    expect(PIN.depth).toBe(manifest.files['jig_roller.glb']!.depth);
    expect(PIN.nominalLength).toBe(manifest.files['jig_pin.glb']!.nominalPatch![0]);
    expect(CYLINDER.padDiameter).toBe(manifest.files['jig_cylinder.glb']!.padDiameter);
    expect(CYLINDER.rodTravel).toBe(manifest.files['jig_cylinder.glb']!.rodTravel);
    expect(SPREADER.thickness).toBe(manifest.files['jig_spreader.glb']!.thickness);
  });

  it('animated / scaled node names exist', () => {
    expect(manifest.files['jig_cylinder.glb']!.nodes).toContain('cylinder_rod');
    expect(manifest.files['jig_weight.glb']!.nodes).toContain('weight_stack');
    expect(manifest.files['jig_riser.glb']!.nodes).toContain('riser_column');
  });

  it('workbench colliders and test-bed size', () => {
    const extras = rootExtras('workbench.glb');
    const got = extras.colliders as { name: string; center: number[]; halfExtents: number[] }[];
    expect(got.map((c) => c.name)).toEqual(BENCH_COLLIDERS.map((c) => c.name));
    got.forEach((c, i) => {
      const want = BENCH_COLLIDERS[i]!;
      for (let k = 0; k < 3; k++) {
        expect(c.center[k]).toBeCloseTo(want.center[k]!, 9);
        expect(c.halfExtents[k]).toBeCloseTo(want.halfExtents[k]!, 9);
      }
    });
    const bed = BENCH_COLLIDERS.find((c) => c.name === 'bed')!;
    expect([bed.halfExtents[0], bed.halfExtents[2]]).toEqual(BED_HALF);
    expect(extras.bedTopY).toBe(0);
  });

  it('debris pieces', () => {
    const extras = rootExtras('debris.glb') as {
      density: number;
      pieces: Record<string, { convex: boolean; halfExtents: number[] }>;
    };
    expect(extras.density).toBe(DEBRIS_DENSITY);
    for (const name of CHIP_NAMES) {
      expect(extras.pieces[name]!.convex).toBe(true);
      expect(extras.pieces[name]!.halfExtents).toEqual(CHIP_HALF_EXTENTS[name]);
    }
  });
});
