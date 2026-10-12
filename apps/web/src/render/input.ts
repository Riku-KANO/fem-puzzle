// Pointer input on the 3D canvas (design doc 操作):
//   left click / drag  → carve (one drag = one history entry)
//   left double-click  → move the orbit target to the hit point (the first click's carve
//                        is reverted, so double-clicking never eats material)
//   right click        → undo;  right drag → orbit (OrbitControls);  wheel → zoom
// Touch is left to OrbitControls for now (touch carving: T-409).

import type { CarveEntry } from '../game/carveState.ts';
import { ClickTracker, DoubleClickDetector } from './gesture.ts';
import type { VoxelHit } from './picking.ts';

export interface InputTarget {
  pick(clientX: number, clientY: number): VoxelHit | null;
  hover(hit: VoxelHit | null): void;
  strokeStart(hit: VoxelHit | null): void;
  strokeMove(hit: VoxelHit | null): void;
  strokeEnd(): CarveEntry | null;
  undo(): void;
  revert(entry: CarveEntry): void;
  retarget(hit: VoxelHit): void;
}

export function attachPointerInput(el: HTMLElement, t: InputTarget): () => void {
  const left = new ClickTracker();
  const right = new ClickTracker();
  const dbl = new DoubleClickDetector();
  let carving = false;
  let lastClickEntry: CarveEntry | null = null;
  let leftPointer = -1;

  const sample = (ev: PointerEvent) => ({ x: ev.clientX, y: ev.clientY, t: ev.timeStamp });

  const onDown = (ev: PointerEvent) => {
    if (ev.pointerType === 'touch') return;
    if (ev.button === 0) {
      ev.preventDefault();
      el.setPointerCapture?.(ev.pointerId);
      leftPointer = ev.pointerId;
      if (dbl.isSecondPress(sample(ev))) {
        if (lastClickEntry) t.revert(lastClickEntry);
        lastClickEntry = null;
        const hit = t.pick(ev.clientX, ev.clientY);
        if (hit) t.retarget(hit);
        carving = false;
        left.cancel();
        return;
      }
      left.down(sample(ev));
      carving = true;
      t.strokeStart(t.pick(ev.clientX, ev.clientY));
    } else if (ev.button === 2) {
      right.down(sample(ev));
      t.hover(null);
    }
  };

  const onMove = (ev: PointerEvent) => {
    if (ev.pointerType === 'touch') return;
    if (right.active) {
      right.move(sample(ev));
      return;
    }
    if (carving && ev.pointerId === leftPointer) {
      left.move(sample(ev));
      // coalesced events give smooth strokes on fast drags
      const events = ev.getCoalescedEvents?.() ?? [];
      for (const e of events.length ? events : [ev]) t.strokeMove(t.pick(e.clientX, e.clientY));
      return;
    }
    if (ev.buttons === 0) t.hover(t.pick(ev.clientX, ev.clientY));
  };

  const onUp = (ev: PointerEvent) => {
    if (ev.pointerType === 'touch') return;
    if (ev.button === 0 && ev.pointerId === leftPointer) {
      leftPointer = -1;
      if (!carving) return;
      carving = false;
      const entry = t.strokeEnd();
      if (left.up(sample(ev))) {
        dbl.clicked(sample(ev));
        lastClickEntry = entry;
      } else {
        dbl.reset();
        lastClickEntry = null;
      }
    } else if (ev.button === 2) {
      if (right.up(sample(ev))) t.undo();
      dbl.reset();
    }
  };

  const onCancel = (ev: PointerEvent) => {
    if (ev.pointerId === leftPointer && carving) {
      carving = false;
      t.strokeEnd();
    }
    left.cancel();
    right.cancel();
  };

  const onLeave = () => {
    if (!carving) t.hover(null);
  };
  const onContext = (ev: Event) => ev.preventDefault();

  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onCancel);
  el.addEventListener('pointerleave', onLeave);
  el.addEventListener('contextmenu', onContext);
  return () => {
    el.removeEventListener('pointerdown', onDown);
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onUp);
    el.removeEventListener('pointercancel', onCancel);
    el.removeEventListener('pointerleave', onLeave);
    el.removeEventListener('contextmenu', onContext);
  };
}
