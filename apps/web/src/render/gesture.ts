// Pointer gesture classification, kept pure for tests:
// - right button: a *click* (no movement) is undo, a *drag* orbits the camera;
// - left button: a press that follows a recent left click at the same spot is a
//   double-click (move the orbit target) rather than a new carve.

export const CLICK_SLOP_PX = 5;
export const DOUBLE_CLICK_MS = 350;

export interface PointerSample {
  x: number;
  y: number;
  /** ms timestamp */
  t: number;
}

/** Tracks one button press and reports whether it stayed a click. */
export class ClickTracker {
  private start: PointerSample | null = null;
  private moved = false;

  constructor(private readonly slop = CLICK_SLOP_PX) {}

  get active(): boolean {
    return this.start !== null;
  }

  down(p: PointerSample): void {
    this.start = p;
    this.moved = false;
  }

  move(p: { x: number; y: number }): void {
    if (!this.start || this.moved) return;
    if (Math.hypot(p.x - this.start.x, p.y - this.start.y) > this.slop) this.moved = true;
  }

  /** Ends the press; true if it never moved beyond the slop (a click). */
  up(p: { x: number; y: number }): boolean {
    if (!this.start) return false;
    this.move(p);
    const click = !this.moved;
    this.start = null;
    return click;
  }

  cancel(): void {
    this.start = null;
  }
}

/** Remembers the last completed left click to recognise the second press of a double-click. */
export class DoubleClickDetector {
  private last: PointerSample | null = null;

  constructor(
    private readonly windowMs = DOUBLE_CLICK_MS,
    private readonly slop = CLICK_SLOP_PX,
  ) {}

  /** Record a completed click (press + release without movement). */
  clicked(p: PointerSample): void {
    this.last = p;
  }

  /** A drag or any other gesture breaks the sequence. */
  reset(): void {
    this.last = null;
  }

  /** Is a press at `p` the second click of a double-click? Consumes the remembered click. */
  isSecondPress(p: PointerSample): boolean {
    const last = this.last;
    if (!last) return false;
    const hit =
      p.t - last.t <= this.windowMs && Math.hypot(p.x - last.x, p.y - last.y) <= this.slop;
    if (hit) this.last = null;
    return hit;
  }
}
