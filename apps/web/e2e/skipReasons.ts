// Prints why tests were skipped (the `list` reporter shows only a dash), so a skipped wasm
// run is visible in `scripts/verify.sh full` logs. Playwright loads reporters by their
// default export — a tool-imposed exception to the no-default-exports rule.

import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';

export default class SkipReasons implements Reporter {
  private readonly skipped: string[] = [];

  onTestEnd(test: TestCase, result: TestResult): void {
    if (result.status !== 'skipped') return;
    const reason = test.annotations.find((a) => a.type === 'skip')?.description ?? 'no reason given';
    this.skipped.push(`  - ${test.titlePath().slice(1).join(' › ')}: ${reason}`);
  }

  onEnd(result: FullResult): void {
    void result;
    if (this.skipped.length === 0) return;
    console.log(`\nSkipped (${this.skipped.length}):\n${this.skipped.join('\n')}`);
  }

  printsToStdio(): boolean {
    return false;
  }
}
