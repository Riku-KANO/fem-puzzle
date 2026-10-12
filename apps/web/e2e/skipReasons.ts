// Prints why tests were skipped (the `list` reporter shows only a dash), so a skipped wasm
// run is visible in `scripts/verify.sh full` logs. Playwright loads reporters by their
// default export — a tool-imposed exception to the no-default-exports rule.

import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';

export default class SkipReasons implements Reporter {
  /** one line per skipped test (deduplicated across --repeat-each) */
  private readonly skipped = new Set<string>();

  onTestEnd(test: TestCase, result: TestResult): void {
    if (result.status !== 'skipped') return;
    const note = test.annotations.find((a) => a.type === 'skip' || a.type === 'fixme');
    const reason = `${note?.type === 'fixme' ? '[fixme] ' : ''}${note?.description ?? 'no reason given'}`;
    this.skipped.add(`  - ${test.titlePath().slice(1).join(' › ')}: ${reason}`);
  }

  onEnd(result: FullResult): void {
    void result;
    if (this.skipped.size === 0) return;
    console.log(`\nSkipped (${this.skipped.size}):\n${[...this.skipped].join('\n')}`);
  }

  printsToStdio(): boolean {
    return false;
  }
}
