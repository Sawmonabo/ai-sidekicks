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
//
// AND THE RETRY IS THIS DISPOSER'S OWN, BECAUSE THE ORDER IS NOT ITS TO PICK
//
// Vitest runs settle-time callbacks in registration STACK order, so this
// registration — necessarily made AFTER the one `spawnManagedElectronChild`
// armed, since the caller needs the handle that spawn returns — runs BEFORE it.
// That is invisible while every kill lands and decisive on the one that does
// not. A refused tree kill is a real outcome and not a hypothetical: it is the
// `taskkill` that spawns, exits non-zero and leaves Electron running, which is
// exactly why `terminateProcessTree` reports delivery and survival as two
// answers. Under that refusal this disposer signalled once, waited out its whole
// bound against a child that was never going to close, removed the profile
// under a live browser — and only then did the earlier disposer take its turn
// and kill the tree, with no removal anywhere after it. The locked directory
// that survived is the one thing this module exists to take off disk.
//
// So the disposal is retried HERE rather than left to whoever runs next.
// `dispose` is already idempotent in the sense that matters — a delivered kill
// signals nothing a second time, a refused one asks again — so the retry is a
// no-op on every ordinary run and is the whole fix on the run that needed it,
// and the removal keeps its single call site AFTER the last wait.

import { onTestFinished } from "vitest";

import { disposeWhenTestFinishes, type SettleTimeRegistrar } from "./electron-child.js";
import { TERMINATION_GRACE_MS, type ManagedElectronChild } from "./managed-electron-child.js";

/**
 * How many times a settle-time disposal asks before it gives the child up.
 *
 * Small on purpose, and a bound rather than a condition: the first call is the
 * ordinary one, the second is the whole reason the loop exists — a tree that
 * refused one kill and takes the next — and past that the tree is unkillable by
 * this process. A further ask would hold teardown open for the same answer,
 * which is the trade the bounded wait below already refuses.
 */
const DISPOSAL_ATTEMPTS = 3;

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
    await disposeUntilChildHasClosed(managed, exitWaitMs);
    cleanUp();
  }, register);
}

/**
 * Signal and wait, and ask again while the child is still there.
 *
 * The FIRST `dispose` is unconditional, even against a child whose `close` has
 * already been delivered, because signalling is not all it does: it also
 * releases an armed escalation timer, and a pending timer is a claim on a
 * worker that is being torn down — the shape `electron-child.ts`'s header opens
 * with. Every LATER one is the retry, and it is asked only of a child that has
 * not closed, which is the only state in which `dispose` still signals anything.
 *
 * Returning early on `hasClosed` rather than on the attempt count is what keeps
 * the ordinary run one call long: the bound is what a refusal costs, not what
 * every teardown pays.
 */
async function disposeUntilChildHasClosed(
  managed: ManagedElectronChild,
  exitWaitMs: number,
): Promise<void> {
  for (let attempt = 0; attempt < DISPOSAL_ATTEMPTS; attempt += 1) {
    managed.dispose();
    await whenChildIsGone(managed, exitWaitMs);
    if (managed.hasClosed) {
      return;
    }
  }
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
 *
 * The spent-bound arm REMOVES its listener, which matters only because the
 * caller above can come back: without it a retried disposal leaves one dead
 * closure per refused attempt attached to a child that is still running, and
 * the count grows with a bound that exists to be hit.
 */
async function whenChildIsGone(managed: ManagedElectronChild, exitWaitMs: number): Promise<void> {
  if (managed.hasClosed) {
    return;
  }
  const { child } = managed;
  await new Promise<void>((resolve) => {
    const onClosed = (): void => {
      clearTimeout(bound);
      resolve();
    };
    const bound = setTimeout(() => {
      child.removeListener("close", onClosed);
      resolve();
    }, exitWaitMs);
    child.once("close", onClosed);
  });
}
