import type { TestReporter, TestRun, TestSuite, TestCase } from "bun:test";

// Lightweight Bun test reporter that highlights slow tests (>100ms) and prints durations.
export default class TimingReporter implements TestReporter {
  onStart(run: TestRun): void {
    console.log(`Starting ${run.files.length} test file(s)...`);
  }

  onTestEnd(_run: TestRun, test: TestCase): void {
    const ms = test.durationMs ?? 0;
    const slow = ms > 100 ? " (slow)" : "";
    console.log(`✔ ${test.name} - ${ms.toFixed(1)}ms${slow}`);
  }

  onSuiteEnd(_run: TestRun, suite: TestSuite): void {
    const ms = suite.durationMs ?? 0;
    console.log(`Finished suite ${suite.name} in ${ms.toFixed(1)}ms`);
  }

  onEnd(run: TestRun): void {
    const total = run.durationMs ?? 0;
    console.log(`All tests finished in ${total.toFixed(1)}ms`);
  }
}
