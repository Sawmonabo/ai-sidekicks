// Closing a launched console, bounded — because `close()` can hang too.
//
// `launchConsole()`'s failure path closes the application before it rethrows, and
// that close used to be awaited with no bound at all. An Electron wedged rather
// than merely slow therefore consumed whatever the tier had left and vitest's
// generic timeout won anyway: no diagnostic, no breadcrumb, and a temporary
// profile left on disk for the next launch to trip over. Bounding every phase of
// the launch and then leaving the last one unbounded is not a fix; it is the same
// undiagnosable kill one line further down.
//
// WHY THE BOUND IS A FLOOR AND NOT SIMPLY WHAT THE DEADLINE HAS LEFT
//
// `close()` is reached on two paths that look alike and are not. On the failure
// path it runs inside the launch, where the deadline is the right authority and
// its remaining time is exactly the cleanup slice. On the SUCCESS path the caller
// closes when its test is done — for the endurance tier, minutes later — and by
// then the launch deadline is long spent. A bound drawn from the deadline alone
// would be 1 ms there and would SIGKILL a perfectly healthy application on its
// way out. So the bound is `max(what the deadline has left, the reserved slice)`:
// the deadline can only ever GRANT more time than the reserve, never less.
//
// WHAT HAPPENS WHEN THE BOUND IS REACHED
//
// The process tree is SIGKILLed, and the outcome is reported rather than thrown.
// Cleanup is never the interesting failure — something else already went wrong to
// get here — so it returns a verdict the caller attaches to the error it was
// already carrying, in the shape `FrameWitness` uses for the same reason.

import { spawnSync } from "node:child_process";
import process from "node:process";

import { CLEANUP_BUDGET_MS, type LaunchDeadline } from "./launch-deadline.js";

/**
 * The launched application, reduced to what cleanup needs of it.
 *
 * An interface rather than Playwright's `ElectronApplication` so a stub whose
 * `close()` never settles is one object literal. That case cannot be produced
 * with a real Electron — no fixture makes a browser process refuse to close on
 * demand — which is exactly why it was the case nothing checked.
 */
export interface ClosableApplication {
  readonly close: () => Promise<void>;
  /** The launched process, or `undefined` once it has exited or was never spawned. */
  readonly processId: () => number | undefined;
}

/**
 * Force-termination, as a seam.
 *
 * A constructor argument so a test can assert the SIGKILL happened without
 * signalling anything: a spy is an object literal, and a terminator that really
 * killed something would take the test runner's own process tree with it on the
 * negative-pid arm below.
 */
export interface ProcessTerminator {
  /** Kill the tree led by `pid`. Returns whether a signal was delivered. */
  readonly terminate: (pid: number) => boolean;
}

/**
 * How the close settled.
 *
 * `unterminable` is deliberately distinct from `terminated` rather than folded
 * into it: it means a process may still be running and holding a profile, which
 * is the one cleanup outcome that can affect a LATER launch, and a reader who
 * cannot tell it from a successful kill has lost the only actionable half.
 */
export type CleanupSettlement = "closed" | "terminated" | "unterminable";

export interface CleanupOutcome {
  readonly settlement: CleanupSettlement;
  /** Wall milliseconds spent closing, measured driver-side. */
  readonly waitedMs: number;
  /**
   * The bound this close was actually held to, in milliseconds.
   *
   * Reported rather than assumed to be `CLEANUP_BUDGET_MS`, because it usually
   * is not. The applied bound is `max(what the deadline has left, the reserve)`,
   * and a launch that failed EARLY leaves most of the deadline unspent — so a
   * readiness failure two seconds in gives cleanup nearly 55 000 ms. A message
   * that named the reserve there would claim a process failed to close within
   * ten seconds when it had been given five times that, which is a diagnostic
   * that misdescribes the very measurement it is reporting.
   */
  readonly budgetMs: number;
}

/**
 * SIGKILL an Electron process tree, on the shape both neighbours already use.
 *
 * MEASURED, NOT ASSUMED, because the negative-pid form is only safe under one
 * condition and is catastrophic without it. `playwright-core` spawns with
 * `detached: process.platform !== "win32"` (`lib/coreBundle.js`), so on POSIX the
 * launched Electron LEADS its own process group and `-pid` reaches the browser,
 * its zygote, and every renderer at once. An attached child would instead share
 * this runner's group, and the same call would SIGKILL vitest itself — so the
 * fallback below is to the group leader alone, never a widening.
 *
 * The Windows arm is `taskkill /pid N /T /F`, which is what playwright-core
 * itself runs for this process and what `test/helpers/electron-probe.ts` runs for
 * the smoke test's tree. Windows has no process group to signal and its
 * "signals" are `TerminateProcess` calls that are never forwarded, so killing the
 * leader alone would orphan the browser.
 */
export const ELECTRON_PROCESS_TERMINATOR: ProcessTerminator = {
  terminate: (pid: number): boolean => {
    if (process.platform === "win32") {
      const result = spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
      // A tree already gone exits non-zero, which is the same no-op the POSIX
      // arm absorbs as ESRCH. Only a failure to RUN taskkill is a failure here.
      return result.error === undefined;
    }
    try {
      process.kill(-pid, "SIGKILL");
      return true;
    } catch {
      // Group already reaped, or this pid does not lead one after all.
    }
    try {
      process.kill(pid, "SIGKILL");
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * Closes an application within the deadline's cleanup slice, or kills it.
 *
 * A class for the reason its two collaborators are constructor arguments: the
 * application and the terminator are both seams, and the one behaviour worth
 * checking — a close that never settles — is unreachable through the real ones.
 */
export class BoundedCleanup {
  readonly #application: ClosableApplication;
  readonly #terminator: ProcessTerminator;
  readonly #deadline: LaunchDeadline;
  readonly #reservedMs: number;

  constructor(
    application: ClosableApplication,
    terminator: ProcessTerminator,
    deadline: LaunchDeadline,
    reservedMs: number = CLEANUP_BUDGET_MS,
  ) {
    this.#application = application;
    this.#terminator = terminator;
    this.#deadline = deadline;
    this.#reservedMs = reservedMs;
  }

  async close(): Promise<CleanupOutcome> {
    const startedAt = Date.now();
    const budgetMs = Math.max(this.#deadline.remainingMs(), this.#reservedMs);
    let timeoutHandle: NodeJS.Timeout | undefined;
    const budgetExpired = new Promise<"expired">((resolveExpiry) => {
      timeoutHandle = setTimeout(() => {
        resolveExpiry("expired");
      }, budgetMs);
    });
    const closing = this.#application.close().then(() => "closed" as const);
    // An ABANDONED close must not take the process down. When the budget wins it
    // is still outstanding, and killing the process underneath it is precisely
    // what makes it reject — with no handler attached unless one is put here.
    // Attaching does not remove it from the race, so a close that fails FAST
    // still settles the race rather than waiting out the budget.
    closing.catch(() => undefined);
    let raced: "closed" | "expired";
    try {
      raced = await Promise.race([closing, budgetExpired]);
    } catch {
      // A close that REJECTS has finished closing, unsuccessfully. There is
      // nothing left to bound and nothing to kill that its own failure did not
      // already reach; reporting it as a hang would name the wrong thing.
      raced = "closed";
    } finally {
      clearTimeout(timeoutHandle);
    }
    if (raced === "closed") {
      return { settlement: "closed", waitedMs: Date.now() - startedAt, budgetMs };
    }
    const processId = this.#application.processId();
    const terminated = processId !== undefined && this.#terminator.terminate(processId);
    return {
      settlement: terminated ? "terminated" : "unterminable",
      waitedMs: Date.now() - startedAt,
      budgetMs,
    };
  }
}

/**
 * Re-word a failure whose cleanup ALSO went wrong, without losing either.
 *
 * Cleanup is never the interesting failure — something else went wrong first to
 * reach it — so the original stays as `cause` and this only adds what the reader
 * could not otherwise know: that a process may still be running. Silent on a
 * clean close, because a sentence about cleanup on every failure would train a
 * reader to skip the one that matters.
 */
export function withCleanupOutcome(error: unknown, outcome: CleanupOutcome | undefined): unknown {
  if (outcome === undefined || outcome.settlement === "closed") {
    return error;
  }
  const consequence =
    outcome.settlement === "terminated"
      ? "so its process tree was SIGKILLed; later launches are unaffected"
      : "and could not be terminated either, so it may still be running and holding its profile — " +
        "a later launch in the same job losing `requestSingleInstanceLock()` starts here";
  return new Error(
    `a launch failed, and the Electron process then did not close within the ${String(outcome.budgetMs)} ms ` +
      "it was given " +
      `(waited ${String(outcome.waitedMs)} ms) ${consequence}; the failure that started this is the cause below`,
    { cause: error },
  );
}
