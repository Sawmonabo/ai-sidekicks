// What React reported while a case ran, read rather than logged.
//
// The `renderer` project declares no `setupFiles` and fails on no warning, so React's
// duplicate-key report is logged and never read unless a case captures it. The capture lives here
// so every suite shares one spy. The restore is unconditional and the spy lives inside a scope,
// because a spy left installed by a failing case would silence every later file in the worker.

import { vi } from "vitest";

/** What React reported through `console.error` while `run` ran, beside what it returned. */
export interface ReactRunReport<T> {
  readonly value: T;
  readonly reported: readonly string[];
}

/**
 * Run a case with React's `console.error` reports captured, and hand both back.
 *
 * Captured rather than silenced, so the caller sees whatever else React said about the render
 * and filters for the report it is reading.
 */
export async function reportsWhileReactRan<T>(
  run: () => T | Promise<T>,
): Promise<ReactRunReport<T>> {
  const reported: string[] = [];
  const consoleErrors = vi
    .spyOn(console, "error")
    .mockImplementation((...parts: readonly unknown[]) => {
      reported.push(parts.map((part) => String(part)).join(" "));
    });
  try {
    const value = await run();
    return { value, reported };
  } finally {
    consoleErrors.mockRestore();
  }
}

/** The reports that name two children sharing one key. */
export function duplicateKeyReports(reported: readonly string[]): readonly string[] {
  return reported.filter((line) => /same key/iu.test(line));
}
