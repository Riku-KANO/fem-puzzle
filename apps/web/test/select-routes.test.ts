import { describe, expect, it } from 'vitest';
import { buildCampaign, type StageRecord } from '../src/game/progress/index.ts';
import { HashRouter } from '../src/ui/select/router.svelte.ts';
import { FakeWindow } from './fakeWindow.ts';
import {
  formatRoute,
  legacyRewrite,
  parseHash,
  resolveRoute,
  screenOf,
  type Route,
} from '../src/ui/select/routes.ts';
import {
  cardAriaLabel,
  initialWorld,
  lockedWorldHint,
  stageLabel,
  starString,
  storageWarning,
  worldSummary,
} from '../src/ui/select/selectView.ts';

describe('hash routes', () => {
  it.each<[string, Route | null]>([
    ['', { kind: 'title' }],
    ['#', { kind: 'title' }],
    ['#/', { kind: 'title' }],
    ['#/select', { kind: 'select', world: null }],
    ['#/select/', { kind: 'select', world: null }],
    ['#/select/w2', { kind: 'select', world: 2 }],
    ['#/select/3', { kind: 'select', world: 3 }],
    ['#/stage/w1-01', { kind: 'stage', id: 'w1-01' }],
    ['#stage/w1-01', { kind: 'stage', id: 'w1-01' }],
    ['#/stage/w1-01?x=1', { kind: 'stage', id: 'w1-01' }],
    ['#/stage/demo_cantilever', { kind: 'stage', id: 'demo_cantilever' }],
    ['#/stage/w1%2D01', { kind: 'stage', id: 'w1-01' }],
    ['#/stage', null],
    ['#/stage/', null],
    ['#/stage/a%2Fb', null],
    ['#/stage/%E0%A4%A', null],
    ['#/stage/w1-01/extra', null],
    ['#/select/wx', null],
    ['#/nonsense', null],
  ])('parseHash(%j)', (hash, route) => {
    expect(parseHash(hash)).toEqual(route);
  });

  it('formatRoute round-trips through parseHash', () => {
    const routes: Route[] = [
      { kind: 'title' },
      { kind: 'select', world: null },
      { kind: 'select', world: 2 },
      { kind: 'stage', id: 'w2-03' },
    ];
    for (const r of routes) expect(parseHash(formatRoute(r))).toEqual(r);
    expect(formatRoute({ kind: 'stage', id: 'w1-01' })).toBe('#/stage/w1-01');
    expect(screenOf({ kind: 'select', world: null })).toBe('select');
  });

  it('resolveRoute: unknown stage → select with a notice; unknown path → title', () => {
    const has = (id: string) => id === 'w1-01';
    expect(resolveRoute('#/stage/w1-01', has)).toEqual({ route: { kind: 'stage', id: 'w1-01' }, notice: null });
    const missing = resolveRoute('#/stage/w9-99', has);
    expect(missing.route).toEqual({ kind: 'select', world: null });
    expect(missing.notice).toContain('w9-99');
    expect(resolveRoute('#/what', has)).toEqual({ route: { kind: 'title' }, notice: null });
  });

  it('legacy ?stage= is rewritten to the hash, keeping other query parameters', () => {
    expect(legacyRewrite('?stage=w1-02', '')).toEqual({ search: '', hash: '#/stage/w1-02' });
    expect(legacyRewrite('?backend=mock&stage=w1-02', '')).toEqual({
      search: '?backend=mock',
      hash: '#/stage/w1-02',
    });
    expect(legacyRewrite('?stage=w1-02&backend=wasm', '#/')).toEqual({
      search: '?backend=wasm',
      hash: '#/stage/w1-02',
    });
    // An explicit hash wins; the stale query is still dropped.
    expect(legacyRewrite('?stage=w1-02', '#/select')).toEqual({ search: '', hash: '#/select' });
    expect(legacyRewrite('?backend=mock', '')).toBeNull();
    expect(legacyRewrite('', '#/stage/w1-01')).toBeNull();
  });
});

function router(win: FakeWindow): HashRouter {
  return new HashRouter(win as unknown as Window, (id) => ['w1-01', 'w1-02'].includes(id));
}

describe('HashRouter', () => {
  it('starts on the title for a bare URL and follows hash changes', () => {
    const win = new FakeWindow();
    const r = router(win);
    expect(r.route).toEqual({ kind: 'title' });
    win.go('#/stage/w1-02');
    expect(r.route).toEqual({ kind: 'stage', id: 'w1-02' });
    win.go('#/select/w1');
    expect(r.route).toEqual({ kind: 'select', world: 1 });
  });

  it('rewrites a legacy ?stage= URL on start and keeps ?backend', () => {
    const win = new FakeWindow();
    win.search = '?backend=mock&stage=w1-02';
    const r = router(win);
    expect(r.route).toEqual({ kind: 'stage', id: 'w1-02' });
    expect(win.search).toBe('?backend=mock');
    expect(win.hash).toBe('#/stage/w1-02');
  });

  it('navigate pushes a history entry; replace does not', () => {
    const win = new FakeWindow();
    const r = router(win);
    r.navigate({ kind: 'select', world: null });
    expect(win.hash).toBe('#/select');
    expect(r.route).toEqual({ kind: 'select', world: null });
    expect(win.pushes).toBe(1);
    r.navigate({ kind: 'select', world: 1 }, { replace: true });
    expect(win.hash).toBe('#/select/w1');
    expect(r.route).toEqual({ kind: 'select', world: 1 });
    expect(win.pushes).toBe(1);
    r.navigate({ kind: 'select', world: 1 }); // same route: no-op
    expect(win.pushes).toBe(1);
  });

  it('an unknown stage id lands on the select screen with a notice and a clean hash', () => {
    const win = new FakeWindow();
    win.hash = '#/stage/w7-07';
    const r = router(win);
    expect(r.route).toEqual({ kind: 'select', world: null });
    expect(r.notice).toContain('w7-07');
    expect(win.hash).toBe('#/select');
    r.navigate({ kind: 'stage', id: 'w1-01' });
    expect(r.notice).toBeNull();
  });

  it('onBeforeChange runs before the route changes, for every kind of change', () => {
    const win = new FakeWindow();
    const r = router(win);
    const seen: string[] = [];
    r.onBeforeChange = (from, to) => {
      // still on the old screen while the hook runs
      expect(r.route).toEqual(from);
      seen.push(`${from.kind}→${to.kind}`);
    };
    r.navigate({ kind: 'stage', id: 'w1-01' }); // push (hashchange)
    win.go('#/select'); // back button / address bar
    r.navigate({ kind: 'select', world: 1 }, { replace: true }); // replace (no hashchange)
    r.navigate({ kind: 'select', world: 1 }); // same route: no change, no hook
    win.go('#/select/w1'); // address bar to the route already shown: no hook
    win.go('#/stage/w9-99'); // unknown stage resolves to #/select (all worlds): a change
    expect(seen).toEqual(['title→stage', 'stage→select', 'select→select', 'select→select']);
  });

  it('a throwing onBeforeChange still switches the route', () => {
    const win = new FakeWindow();
    const r = router(win);
    r.onBeforeChange = () => {
      throw new Error('boom');
    };
    expect(() => r.navigate({ kind: 'select', world: null })).toThrow('boom');
    expect(r.route).toEqual({ kind: 'select', world: null });
  });

  it('dispose stops listening', () => {
    const win = new FakeWindow();
    const r = router(win);
    expect(win.listenerCount).toBe(1);
    r.dispose();
    expect(win.listenerCount).toBe(0);
  });
});

describe('select screen view helpers', () => {
  const stages = [
    { id: 'w1-01', world: 1 },
    { id: 'w1-02', world: 1 },
    { id: 'w2-01', world: 2 },
  ];
  const rec = (stars: 0 | 1 | 2 | 3, beat = false): StageRecord => ({
    stars,
    volume: 0.4123,
    beatBenchmark: beat,
    clears: 1,
    firstAt: 0,
    lastAt: 0,
    solid: '',
  });

  it('initialWorld: requested if it exists, else the newest unlocked world', () => {
    const fresh = buildCampaign(stages, () => null);
    expect(initialWorld(fresh, null)).toBe(1);
    expect(initialWorld(fresh, 2)).toBe(2);
    expect(initialWorld(fresh, 7)).toBe(1);
    const w2 = buildCampaign(stages, (id) => (id.startsWith('w1') ? rec(1) : null));
    expect(initialWorld(w2, null)).toBe(2);
  });

  it('labels, stars and summaries', () => {
    expect(stageLabel({ world: 2, number: 3 })).toBe('2-3');
    expect(stageLabel({ world: 0, number: 1 })).toBe('1');
    expect(starString(0)).toBe('☆☆☆');
    expect(starString(2)).toBe('★★☆');
    const c = buildCampaign(stages, (id) => (id === 'w1-01' ? rec(3, true) : null));
    const [w1, w2] = c.worlds;
    expect(worldSummary(w1!, w2)).toBe('クリア 1 / 2 ・ あと 1 ステージで ワールド2 解放');
    expect(worldSummary(w2!, undefined)).toBe('まだ解放されていません');
    expect(lockedWorldHint(w1)).toBe('ワールド1 を 2 ステージクリアで解放');
    const s = c.byId.get('w1-01')!;
    expect(cardAriaLabel(s, 'はり', 0.6)).toBe('1-1 はり、星 3、最良 体積率 41.2%、最適化解超え、途中 体積率 60.0%');
    expect(cardAriaLabel(c.byId.get('w2-01')!, '橋', null)).toBe('2-1 橋、未解放');
  });

  it('storageWarning explains unavailable, corrupt and newer storage', () => {
    expect(storageWarning({ persistent: true, status: 'ok' })).toBeNull();
    expect(storageWarning({ persistent: true, status: 'empty' })).toBeNull();
    expect(storageWarning({ persistent: false, status: 'empty' })).toContain('保存できません');
    expect(storageWarning({ persistent: true, status: 'corrupt' })).toContain('リセット');
    expect(storageWarning({ persistent: true, status: 'newer' })).toContain('新しいバージョン');
  });
});
