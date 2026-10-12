// Reactive hash router (Svelte 5 runes) over routes.ts. One instance per app.

import { formatRoute, legacyRewrite, resolveRoute, sameRoute, type Route } from './routes.ts';

export class HashRouter {
  route = $state<Route>({ kind: 'title' });
  /** one-shot message for the select screen (e.g. unknown stage id) */
  notice = $state<string | null>(null);

  private readonly onHashChange = (): void => this.sync();

  constructor(
    private readonly win: Window,
    private readonly hasStage: (id: string) => boolean,
  ) {
    const loc = win.location;
    const legacy = legacyRewrite(loc.search, loc.hash);
    if (legacy) win.history.replaceState(win.history.state, '', `${loc.pathname}${legacy.search}${legacy.hash}`);
    this.sync();
    win.addEventListener('hashchange', this.onHashChange);
  }

  /** Go to `route`; `replace` keeps the back button from collecting tab switches. */
  navigate(route: Route, options: { replace?: boolean } = {}): void {
    if (sameRoute(route, this.route) && this.win.location.hash === formatRoute(route)) return;
    const hash = formatRoute(route);
    if (options.replace) {
      const loc = this.win.location;
      this.win.history.replaceState(this.win.history.state, '', `${loc.pathname}${loc.search}${hash}`);
      this.sync();
    } else {
      this.win.location.hash = hash; // fires hashchange → sync
    }
  }

  dispose(): void {
    this.win.removeEventListener('hashchange', this.onHashChange);
  }

  private sync(): void {
    const resolved = resolveRoute(this.win.location.hash, this.hasStage);
    if (!sameRoute(resolved.route, this.route)) this.route = resolved.route;
    this.notice = resolved.notice;
    // Normalise unknown / missing-stage hashes so the address bar matches the screen.
    const canonical = formatRoute(resolved.route);
    const hash = this.win.location.hash;
    if (hash !== canonical && !(resolved.route.kind === 'title' && (hash === '' || hash === '#'))) {
      const loc = this.win.location;
      this.win.history.replaceState(this.win.history.state, '', `${loc.pathname}${loc.search}${canonical}`);
    }
  }
}
