// Keyboard shortcuts (design doc 操作). Pure mapping so it is testable without a DOM.

import type { BrushSize } from '../game/brush.ts';

export type ShortcutAction =
  | { kind: 'brush'; size: BrushSize }
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'loadTest' };

export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export function shortcutFor(ev: KeyLike): ShortcutAction | null {
  const mod = ev.ctrlKey || ev.metaKey;
  const key = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
  if (mod && !ev.altKey) {
    if (key === 'z') return ev.shiftKey ? { kind: 'redo' } : { kind: 'undo' };
    if (key === 'y' && !ev.shiftKey) return { kind: 'redo' };
    return null;
  }
  if (ev.altKey || ev.ctrlKey || ev.metaKey) return null;
  switch (ev.code ?? '') {
    case 'Digit1':
    case 'Numpad1':
      return { kind: 'brush', size: 1 };
    case 'Digit2':
    case 'Numpad2':
      return { kind: 'brush', size: 3 };
    case 'Digit3':
    case 'Numpad3':
      return { kind: 'brush', size: 5 };
    case 'Space':
      return { kind: 'loadTest' };
  }
  if (key === '1') return { kind: 'brush', size: 1 };
  if (key === '2') return { kind: 'brush', size: 3 };
  if (key === '3') return { kind: 'brush', size: 5 };
  if (key === ' ') return { kind: 'loadTest' };
  return null;
}
