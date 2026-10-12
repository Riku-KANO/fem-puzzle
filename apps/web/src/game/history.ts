// Unlimited undo/redo stack (design doc 操作: 履歴は無制限).

export class History<E> {
  private done: E[] = [];
  private undone: E[] = [];

  get canUndo(): boolean {
    return this.done.length > 0;
  }

  get canRedo(): boolean {
    return this.undone.length > 0;
  }

  get undoDepth(): number {
    return this.done.length;
  }

  get redoDepth(): number {
    return this.undone.length;
  }

  /** Record a new action; clears the redo stack. */
  push(entry: E): void {
    this.done.push(entry);
    this.undone.length = 0;
  }

  /** Newest undoable entry (may be amended in place, e.g. floating debris). */
  peek(): E | undefined {
    return this.done[this.done.length - 1];
  }

  undo(): E | undefined {
    const e = this.done.pop();
    if (e !== undefined) this.undone.push(e);
    return e;
  }

  redo(): E | undefined {
    const e = this.undone.pop();
    if (e !== undefined) this.done.push(e);
    return e;
  }

  /** Drop the newest entry without making it redoable (the caller reverts its effect). */
  discardTop(): E | undefined {
    return this.done.pop();
  }

  clear(): void {
    this.done.length = 0;
    this.undone.length = 0;
  }
}
