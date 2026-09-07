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

import { disposeWhenTestFinishes, type SettleTimeRegistrar } from "./electron-child.js";
import { TERMINATION_GRACE_MS, type ManagedElectronChild } from "./managed-electron-child.js";

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
 * `close` IS THE EVENT, AND AN EXIT CODE IS NOT A PROXY FOR IT. This read
 * `child.exitCode !== null || child.signalCode !== null` and returned on it,
 * which is a different fact and a weaker one: `exit` fires when the process
 * ends, `close` when every stdio stream inherited from it has been released as
 * well. Between the two, a descendant that inherited the child's stdout is
 * still running — the shim-and-browser shape `electron-child.ts`'s header
 * describes, and the ordinary shape here, since a launcher is what this package
 * spawns. Removing the profile directory in that window races processes still
 * holding files inside it; on POSIX the unlink mostly succeeds anyway and hides
 * the bug, and on Windows an open handle makes the removal fail outright and
 * the directory outlives the run. So the wait is for `close`.
 *
 * The already-fired arm is not an optimisation: `close` is delivered at most
 * once, so a listener registered after it would wait out the whole bound on
 * every ordinary teardown. `ManagedElectronChild` records the delivery from its
 * own constructor-registered handler, which is what makes the question
 * answerable at all after the fact — a listener cannot ask it.
 */
async function whenChildIsGone(managed: ManagedElectronChild, exitWaitMs: number): Promise<void> {
  if (managed.hasClosed) {
    return;
  }
  await new Promise<void>((resolve) => {
    const bound = setTimeout(resolve, exitWaitMs);
    managed.child.once("close", () => {
      clearTimeout(bound);
      resolve();
    });
  });
}
