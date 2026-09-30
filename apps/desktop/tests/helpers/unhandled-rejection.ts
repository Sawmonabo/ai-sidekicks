// Witness for the half of a failure `render` cannot see. A detached async body (a drain started
// with `void`, an effect that discards its promise) reports nothing to React when it throws, so a
// case asserting only what is on screen passes against code that leaves an unhandled rejection.
// The runner's own report is the only witness.
//
// The macrotask turn is load-bearing: a rejection is reported at the end of a turn, so a body
// awaiting only microtasks would read clean against the defect. A runtime with no reporter throws
// instead of answering an empty list, since a witness that cannot see reads like a green result.
// The host is reached through `globalThis` and typed here because the renderer's test program
// carries no Node types.

import { crossMacrotaskBoundary } from "./macrotask-boundary.js";

/**
 * Runs one case body and returns every unhandled rejection reported while it ran. Listeners attach
 * around the body, not the file, so another case's rejection is never counted against this one.
 */
export async function unhandledRejectionsDuring(
  body: () => Promise<void>,
): Promise<readonly unknown[]> {
  const reporter = (globalThis as { readonly process?: UnhandledRejectionReporter }).process;
  if (reporter === undefined) {
    throw new Error("this runtime reports no unhandled rejections, so the case cannot run");
  }
  const reported: unknown[] = [];
  const record = (reason: unknown): void => {
    reported.push(reason);
  };
  reporter.on("unhandledRejection", record);
  try {
    await body();
    await crossMacrotaskBoundary();
  } finally {
    reporter.off("unhandledRejection", record);
  }
  return reported;
}

/** The two host methods that report a rejection nothing handled. */
interface UnhandledRejectionReporter {
  on(event: "unhandledRejection", listener: (reason: unknown) => void): void;
  off(event: "unhandledRejection", listener: (reason: unknown) => void): void;
}
