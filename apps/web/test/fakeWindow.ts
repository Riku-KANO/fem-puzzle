// Minimal `window` for HashRouter tests (location, history.replaceState, hashchange).

/** Minimal window: location + history + hashchange. */
export class FakeWindow {
  pathname = '/';
  search = '';
  hash = '';
  pushes = 0;
  private listeners = new Set<() => void>();

  readonly location = (() => {
    const self = this; // the accessor object below needs the fake instance
    return {
      get pathname() {
        return self.pathname;
      },
      get search() {
        return self.search;
      },
      get hash() {
        return self.hash;
      },
      set hash(h: string) {
        const next = h.startsWith('#') ? h : `#${h}`;
        if (next === self.hash) return;
        self.hash = next;
        self.pushes++;
        self.fire();
      },
    };
  })();

  readonly history = {
    state: null,
    replaceState: (_s: unknown, _t: string, url: string) => {
      const u = new URL(url, 'http://x');
      this.pathname = u.pathname;
      this.search = u.search;
      this.hash = u.hash;
    },
  };

  addEventListener(type: string, fn: () => void): void {
    if (type === 'hashchange') this.listeners.add(fn);
  }
  removeEventListener(type: string, fn: () => void): void {
    if (type === 'hashchange') this.listeners.delete(fn);
  }
  /** user edits the address bar / presses back */
  go(hash: string): void {
    this.hash = hash;
    this.fire();
  }
  private fire(): void {
    for (const fn of this.listeners) fn();
  }
  get listenerCount(): number {
    return this.listeners.size;
  }
}
