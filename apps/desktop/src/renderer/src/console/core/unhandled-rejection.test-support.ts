// The witness for the half of a failure `render` cannot see.
//
// A detached async body — a drain started with `void`, an effect that fires a call and
// discards its promise — reports nothing to React when it throws: there is no error
// boundary on the path, so a case asserting only what is on screen passes against code
// that leaves an unhandled rejection behind it. The runner's own report is the only
// witness, and this is how a case reads it.
//
// THE MACROTASK TURN IS LOAD-BEARING. A rejection nothing handled is reported at the
// END of a turn, so a body that awaited only microtasks would report clean against the
// defect as well as against the fix — which is a check that has stopped checking.
//
// AND A RUNTIME WITH NO REPORTER FAILS HERE rather than answering an empty list, for
// the same reason: a witness that cannot see is worse than one nobody wrote, because
// the green result reads identically.
//
// The host is reached through `globalThis` and typed here rather than imported,
// because the renderer's test program deliberately carries no Node types — pulling
// them in to reach one listener would put the whole Node surface into the typegraph of
// every renderer test, which is what `src/renderer/tsconfig.test.json` exists to
// prevent. No renderer MODULE reads this; it is a test looking at its own host.

import { crossMacrotaskBoundary } from "./macrotask-boundary.test-support.js";

/**
 * Run one case body and hand back every unhandled rejection reported while it ran.
 *
 * Listeners are attached and detached around the BODY rather than for the file, so a
 * rejection another case raises is never counted against this one.
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
