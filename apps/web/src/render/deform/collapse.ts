// Visual collapse bookkeeping for the load test (design doc 演出: 超過要素から順に崩れる). Pure.
// Breaking over-stressed elements can cut the structure; whatever loses its path to a support
// falls off as a rigid piece. Pieces that were already floating before the test (e.g. a
// protected load island) are not "collapse" and stay put.

import { connectivity } from '../../game/connectivity.ts';
import type { Grid } from '../../game/grid.ts';

/** 1 = flagged but not connected to any supported cell. */
export function floatingMask(g: Grid, flags: Uint8Array, supported: Uint8Array): Uint8Array {
  const { active } = connectivity(g, flags, supported);
  const out = new Uint8Array(g.n);
  for (let e = 0; e < g.n; e++) out[e] = flags[e] && !active[e] ? 1 : 0;
  return out;
}

/**
 * 6-connected components of cells that are flagged, cut off from every support, and were not
 * floating before (`before`). Each component is sorted ascending; components are ordered by
 * their smallest cell.
 */
export function detachedComponents(
  g: Grid,
  flags: Uint8Array,
  supported: Uint8Array,
  before: Uint8Array,
): number[][] {
  const floating = floatingMask(g, flags, supported);
  const seen = new Uint8Array(g.n);
  const out: number[][] = [];
  const sy = g.nx;
  const sz = g.nx * g.ny;
  for (let start = 0; start < g.n; start++) {
    if (!floating[start] || before[start] || seen[start]) continue;
    const comp = [start];
    seen[start] = 1;
    for (let i = 0; i < comp.length; i++) {
      const e = comp[i]!;
      const x = e % g.nx;
      const y = Math.floor(e / sy) % g.ny;
      const z = Math.floor(e / sz);
      const visit = (nb: number) => {
        if (floating[nb] && !before[nb] && !seen[nb]) {
          seen[nb] = 1;
          comp.push(nb);
        }
      };
      if (x > 0) visit(e - 1);
      if (x < g.nx - 1) visit(e + 1);
      if (y > 0) visit(e - sy);
      if (y < g.ny - 1) visit(e + sy);
      if (z > 0) visit(e - sz);
      if (z < g.nz - 1) visit(e + sz);
    }
    out.push(comp.sort((a, b) => a - b));
  }
  return out;
}
