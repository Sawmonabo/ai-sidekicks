// Releasing what a spawned child was holding, once the child is actually gone.
//
// `electron-child.ts` owns the child's LIFETIME — when it is signalled and how
// many times — and `disposeWhenTestFinishes` is the door that makes those run on
// an outcome nobody armed a timer for. Neither answers the question a harness
// asks next: it also holds a resource the child holds open, and that resource has
// to be released after the process is gone rather than beside the signal that
// kills it. A Chromium `--user-data-dir` profile is the case that found this.
//
// TWO PATHS, AND EACH WAS WRONG ALONE
//
// Removing from the child's own `close` handler is the path a vitest timeout
// never reaches. That is the whole shape of the leak `electron-child.ts` exists
// to close, one layer in: the disposer killed the child and the directory removal
// sat behind an event the torn-down worker would never deliver, so every test
// that overran its budget left a profile behind for the run to accumulate.
//
// Removing straight after `dispose` is the opposite error. `dispose` signals and
// returns — it does not wait — so the removal races a process that has been
// SIGKILLed and has not yet exited. On POSIX that mostly succeeds by accident,
// because unlinking a file another process holds open is legal; on Windows it
// does not, and a profile directory with live handles in it refuses removal
// outright. A cleanup that works on the author's platform and not on a supported
// one is the same leak wearing a passing local run.
//
// SO THE WAIT IS BOUNDED AND THE CLEANUP IS UNCONDITIONAL
//
// The child has just been SIGKILLed, so it is gone in milliseconds or it is
// unkillable, and holding teardown open past that buys nothing that a longer
// bound would not also fail to buy. The cleanup therefore runs on both outcomes,
// best-effort in the same sense the door swallows a late failure: by then the
// test's own result is what explains the run, and a directory that could not be
// removed is a smaller fact than the one the reader came for.

import { onTestFinished } from "vitest";

import {
  disposeWhenTestFinishes,
  TERMINATION_GRACE_MS,
  type ManagedElectronChild,
  type SettleTimeRegistrar,
} from "./electron-child.js";

/**
 * Kill `managed` when the test ends, wait until it is gone, then run `cleanUp`.
 *
 * ONE remover, reached from both paths. The harness's own settlement calls
 * `cleanUp` directly once its `close` has fired — where the child is already gone
 * and the wait below is a no-op — and this registration covers every outcome that
 * settlement does not run at all. Passing the same function to both is what makes
 * "exactly one remover, idempotent" a property of the code rather than a promise
 * in a comment.
 *
 * `register` and `exitWaitMs` are injected for the reason the rest of this
 * mechanism injects its collaborators: a test proving that a settling test
 * releases its resources cannot itself be the settling test.
 */
export function cleanUpAfterChildAtSettleTime(
  managed: ManagedElectronChild,
  cleanUp: () => void,
  register: SettleTimeRegistrar = onTestFinished,
  exitWaitMs: number = TERMINATION_GRACE_MS,
): void {
  disposeWhenTestFinishes(async () => {
    managed.dispose();
    await whenChildIsGone(managed, exitWaitMs);
    cleanUp();
  }, register);
}

/**
 * Resolve once the child has closed, or once the bound is spent — whichever first.
 *
 * The already-settled arm is not an optimisation: `close` has fired by then and
 * will not fire again, so a listener registered here would wait out the whole
 * bound on the ordinary path and make every teardown pay for it.
 */
async function whenChildIsGone(managed: ManagedElectronChild, exitWaitMs: number): Promise<void> {
  const child = managed.child;
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => {
    const bound = setTimeout(resolve, exitWaitMs);
    child.once("close", () => {
      clearTimeout(bound);
      resolve();
    });
  });
}
