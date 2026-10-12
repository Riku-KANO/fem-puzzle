// URL hash routing (no server): `#/` title, `#/select[/w<n>]` stage select, `#/stage/<id>`
// a stage. Pure parse/format; the reactive router is router.svelte.ts.
// `#/stage/<id>` is the stable deep link (e2e, sharing) and opens any stage, locked or not.
// The pre-T-304 `?stage=<id>` query is rewritten to it on load, keeping other parameters.

export type Route =
  | { kind: 'title' }
  | { kind: 'select'; world: number | null }
  | { kind: 'stage'; id: string };

const STAGE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Parse `location.hash`. Unknown paths → null (callers fall back to the title). */
export function parseHash(hash: string): Route | null {
  let path = hash.startsWith('#') ? hash.slice(1) : hash;
  const q = path.indexOf('?');
  if (q >= 0) path = path.slice(0, q);
  const parts = path.split('/').filter((p) => p.length > 0);
  const [head, arg, extra] = parts;
  if (head === undefined) return { kind: 'title' };
  if (extra !== undefined) return null;
  if (head === 'select') {
    if (arg === undefined) return { kind: 'select', world: null };
    const m = /^w?(\d{1,2})$/.exec(arg);
    return m ? { kind: 'select', world: Number(m[1]) } : null;
  }
  if (head === 'stage' && arg !== undefined) {
    let id: string;
    try {
      id = decodeURIComponent(arg);
    } catch {
      return null;
    }
    return STAGE_ID.test(id) ? { kind: 'stage', id } : null;
  }
  return null;
}

export function formatRoute(route: Route): string {
  switch (route.kind) {
    case 'title':
      return '#/';
    case 'select':
      return route.world === null ? '#/select' : `#/select/w${route.world}`;
    case 'stage':
      return `#/stage/${encodeURIComponent(route.id)}`;
  }
}

export function sameRoute(a: Route, b: Route): boolean {
  return formatRoute(a) === formatRoute(b);
}

/** A route checked against the stage catalogue, plus a notice for the player. */
export interface Resolved {
  route: Route;
  notice: string | null;
}

/** Unknown hashes go to the title; unknown stage ids to the select screen with a notice. */
export function resolveRoute(hash: string, hasStage: (id: string) => boolean): Resolved {
  const route = parseHash(hash);
  if (!route) return { route: { kind: 'title' }, notice: null };
  if (route.kind === 'stage' && !hasStage(route.id)) {
    return { route: { kind: 'select', world: null }, notice: `ステージ「${route.id}」は見つかりません` };
  }
  return { route, notice: null };
}

/**
 * Legacy `?stage=<id>`: the URL to replace the current one with (search without `stage`,
 * hash = the stage route unless a hash is already set), or null when there is nothing to do.
 */
export function legacyRewrite(search: string, hash: string): { search: string; hash: string } | null {
  const params = new URLSearchParams(search);
  const id = params.get('stage');
  if (id === null) return null;
  params.delete('stage');
  const rest = params.toString();
  const hasHash = hash.length > 0 && hash !== '#' && hash !== '#/';
  return {
    search: rest.length > 0 ? `?${rest}` : '',
    hash: hasHash || id === '' ? hash : formatRoute({ kind: 'stage', id }),
  };
}

/** Value for `<html data-screen>` (e2e waits on it). */
export function screenOf(route: Route): 'title' | 'select' | 'stage' {
  return route.kind;
}
