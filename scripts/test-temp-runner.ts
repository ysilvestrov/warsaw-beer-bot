import { TestRunner, type RunnerTestFile } from 'vitest';
import { tempCleanups } from './test-temp-lifecycle';

export default class TempCleanupRunner extends TestRunner {
  override onAfterRunFiles(files: RunnerTestFile[]): void {
    try {
      const failures: unknown[] = [];
      for (const cleanup of tempCleanups()) {
        try {
          cleanup();
        } catch (error) {
          failures.push(error);
        } finally {
          tempCleanups().delete(cleanup);
        }
      }
      if (failures.length) throw new AggregateError(failures, 'Test temporary directory cleanup failed');
    } finally {
      super.onAfterRunFiles(files);
    }
  }
}
