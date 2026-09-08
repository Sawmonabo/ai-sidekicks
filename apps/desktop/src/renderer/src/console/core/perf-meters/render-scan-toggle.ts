// The dev render-scan toggle.
//
// The perf meters next door answer "what did this cost"; this answers the question
// an author asks immediately afterwards — "which component paid for it". `react-scan`
// is the ADOPTed tool for that reading in `Spec-023 §Console Libraries`, admitted
// there under a dev define and never as a shipped dependency.
//
// EVERY REACHING LINE IS INSIDE THE FIXTURE GUARD, INCLUDING THE IMPORT. The module
// specifier itself sits in a dynamic `import()` inside `if (__SIDEKICKS_CONSOLE_FIXTURES__)`,
// which is a build-time literal — so Rollup folds the branch away in a release build
// and the specifier never reaches a release chunk. A static import at the top of the
// file would pull the whole library into the graph and leave tree-shaking to decide
// whether any of it survived, which is a decision about a devDependency that no
// shipped bundle should be making.
//
// AND THE TOGGLE HANGS ITS HANDLE ON THE CLOSED FIXTURE-GLOBAL TUPLE, so the
// release-absence sweep proves its absence by the same walk that proves the other
// three. A handle declared beside that tuple rather than in it would be a handle
// nothing ever checked for.
//
// OFF UNTIL ASKED. Scanning instruments every render, so arming it by default would
// make a fixture build a bad place to read any of the other three meters.

import { REACT_SCAN_FIXTURE_GLOBAL } from "../fixture-globals.js";

/** What the page-hung handle offers. Two verbs and one reading, and nothing else. */
export interface RenderScanControl {
  /** Begin instrumenting renders. Idempotent. */
  start(): Promise<void>;
  /** Stop instrumenting. Idempotent, and safe before a start. */
  stop(): void;
  /** Whether scanning is currently armed. */
  isScanning(): boolean;
}

/**
 * The toggle's own state, module-private.
 *
 * A module-level pair rather than a class because there is exactly one renderer
 * process and exactly one scanner in it — the library instruments React itself, so a
 * second instance would be a second set of hooks on one reconciler.
 */
let scanning = false;

/**
 * Arm or disarm the scanner.
 *
 * The library is reached only here, and only under the define. `stop` is deliberately
 * synchronous: an author disarming a scan that is making the window unusable should
 * not have to wait on a module load to do it.
 */
export const renderScanControl: RenderScanControl = {
  async start(): Promise<void> {
    if (!__SIDEKICKS_CONSOLE_FIXTURES__ || scanning) {
      return;
    }
    const { scan } = await import("react-scan");
    scan({ enabled: true });
    scanning = true;
  },

  stop(): void {
    if (!__SIDEKICKS_CONSOLE_FIXTURES__ || !scanning) {
      return;
    }
    // Reached through the already-resolved module registry rather than a second
    // `await import`, so disarming cannot be blocked on a network or disk read.
    void import("react-scan").then(({ scan }) => {
      scan({ enabled: false });
    });
    scanning = false;
  },

  isScanning(): boolean {
    return scanning;
  },
};

/*
 * Expose the toggle to the page under the fixture define, and only there.
 *
 * The same shape `core/tripwires.ts` uses for its registry, and for the same reason:
 * an author drives this from the window's own console, and a handle that only module
 * code could reach would be a toggle with no operator.
 */
if (__SIDEKICKS_CONSOLE_FIXTURES__) {
  (globalThis as Record<string, unknown>)[REACT_SCAN_FIXTURE_GLOBAL] = renderScanControl;
}
