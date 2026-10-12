// 6-neighbour connectivity (docs/specs/stage-format.md "Connectivity"): solid cells reachable
// from a supported cell are active; the rest are floating debris.

import type { Grid } from './grid.ts';

export interface Connectivity {
  /** 1 = solid and connected to a support */
  active: Uint8Array;
  /** solid elements not connected to any support, ascending */
  floating: Uint32Array;
}

export function connectivity(g: Grid, solid: Uint8Array, supported: Uint8Array): Connectivity {
  const n = g.n;
  const active = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let e = 0; e < n; e++) {
    if (solid[e] && supported[e]) {
      active[e] = 1;
      queue[tail++] = e;
    }
  }
  const sy = g.nx;
  const sz = g.nx * g.ny;
  while (head < tail) {
    const e = queue[head++]!;
    const x = e % g.nx;
    const y = Math.floor(e / sy) % g.ny;
    const z = Math.floor(e / sz);
    if (x > 0) visit(e - 1);
    if (x < g.nx - 1) visit(e + 1);
    if (y > 0) visit(e - sy);
    if (y < g.ny - 1) visit(e + sy);
    if (z > 0) visit(e - sz);
    if (z < g.nz - 1) visit(e + sz);
  }
  function visit(nb: number): void {
    if (solid[nb] && !active[nb]) {
      active[nb] = 1;
      queue[tail++] = nb;
    }
  }
  let floatingCount = 0;
  for (let e = 0; e < n; e++) if (solid[e] && !active[e]) floatingCount++;
  const floating = new Uint32Array(floatingCount);
  for (let e = 0, i = 0; e < n; e++) if (solid[e] && !active[e]) floating[i++] = e;
  return { active, floating };
}

/**
 * Which floating cells fall as debris: whole floating components that contain no protected
 * cell. A component holding a keep/load cell stays in place (protected cells are never
 * removed, and the WASM solver rejects carving them) and shows up as "loads not connected".
 */
export function debrisCells(g: Grid, floating: ArrayLike<number>, keep: Uint8Array): number[] {
  const inSet = new Set<number>();
  for (let i = 0; i < floating.length; i++) inSet.add(floating[i]!);
  const seen = new Set<number>();
  const out: number[] = [];
  const sy = g.nx;
  const sz = g.nx * g.ny;
  const nbs = [0, 0, 0, 0, 0, 0];
  for (const start of inSet) {
    if (seen.has(start)) continue;
    const comp = [start];
    seen.add(start);
    let protectedComp = false;
    for (let i = 0; i < comp.length; i++) {
      const e = comp[i]!;
      if (keep[e]) protectedComp = true;
      const x = e % g.nx;
      const y = Math.floor(e / sy) % g.ny;
      const z = Math.floor(e / sz);
      nbs[0] = x > 0 ? e - 1 : -1;
      nbs[1] = x < g.nx - 1 ? e + 1 : -1;
      nbs[2] = y > 0 ? e - sy : -1;
      nbs[3] = y < g.ny - 1 ? e + sy : -1;
      nbs[4] = z > 0 ? e - sz : -1;
      nbs[5] = z < g.nz - 1 ? e + sz : -1;
      for (const nb of nbs) {
        if (nb >= 0 && inSet.has(nb) && !seen.has(nb)) {
          seen.add(nb);
          comp.push(nb);
        }
      }
    }
    if (!protectedComp) out.push(...comp);
  }
  return out.sort((a, b) => a - b);
}
