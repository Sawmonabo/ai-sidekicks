// What React reported while a case ran, read rather than logged.
//
// FOUR SUITES WROTE THIS SPY, differing in nothing: a `console.error` spy that joins
// the parts React hands it into one line, a `finally` that restores it, and a filter
// on the one sentence React uses for two children under one key. The `console-unit`
// project declares no `setupFiles` and fails on no warning, so React's duplicate-key
// report is logged and never read unless a case captures it — and a capture written
// four times is a capture fixed once, in the family every other family may reach.
//
// THE RESTORE IS UNCONDITIONAL. A spy left installed by a failing case would silence
// every later file in the worker, which is why the spy lives inside a scope rather
// than being handed back for the caller to restore.

import { vi } from "vitest";

/** What React reported through `console.error` while `run` ran, beside what it returned. */
export interface ReactRunReport<T> {
  readonly value: T;
  readonly reported: readonly string[];
}

/**
 * Run a case with React's `console.error` reports captured, and hand both back.
 *
 * Captured rather than silenced: a spy that swallows everything would hide whatever
 * else React had to say about the render, so the whole record is returned and the
 * caller filters it for the report it is reading.
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

/** Whatever React said about two children sharing one key, if it said anything. */
export function duplicateKeyReports(reported: readonly string[]): readonly string[] {
  return reported.filter((line) => /same key/iu.test(line));
}
