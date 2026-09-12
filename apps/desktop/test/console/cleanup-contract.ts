// What a bounded cleanup is TOLD, and what it is told about.
//
// Split out of `bounded-cleanup.ts` on the seam between its two subjects. This is
// the contract — the three collaborators a cleanup is handed,
// the clock it charges its phases against, and the verdict it returns — and the
// file beside it is the race that produces one. The seams are the whole reason
// that race is checkable: no fixture makes a browser process refuse to close on
// demand, no `rmSync` over a directory this process owns fails on a POSIX
// runner, no platform can be asked to refuse a kill, and no real clock spends a
// five-second host query on request.
//
// The one binding with a body is `ELECTRON_PROCESS_TERMINATOR`, and it belongs
// here rather than beside the class for the reason the interface does: it is
// what a caller is HANDED, and its whole content is which shared implementation
// each seam member resolves to and what it forwards.

import { terminateProcessTree } from "../helpers/process-tree/dispatch.js";
import { processHasTerminated } from "../helpers/process-tree/liveness.js";
import { type ProfileRemovalFailure } from "./launch-profile.js";

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
 * signalling anything: a spy is an object literal, and these cases run INSIDE
 * the runner, where a terminator that really killed something would deliver to
 * a whole process group — the launched tree only because playwright-core spawns
 * detached, and somebody else's group for any other pid it is handed.
 */
export interface ProcessTerminator {
  /**
   * Kill the tree led by `processId`. Returns whether a signal was delivered.
   *
   * `remainingBudgetMilliseconds` is what is LEFT of this cleanup's termination
   * deadline, and it is a parameter rather than a figure the implementation
   * reads because the implementation cannot know it: a tree kill is several
   * blocking host commands — a start-stamp read, a process-table listing, the
   * `taskkill` itself — each held to `HOST_QUERY_TIMEOUT_MS` on its own and to
   * nothing collectively. The shared door takes the smaller of that ceiling and
   * this, and spawns nothing at all once it reaches zero.
   *
   * It is a REMAINDER AT THE MOMENT OF THE CALL and not an allowance for each of
   * those commands: the implementation turns it into one deadline and subtracts
   * afresh before every one of them, so this figure bounds the whole call rather
   * than each step of it. A caller may therefore charge what it hands over here
   * against its own clock exactly once.
   */
  readonly terminate: (processId: number, remainingBudgetMilliseconds: number) => boolean;
  /**
   * Whether that process may still EXECUTE, asked without signalling it.
   *
   * On the same seam as `terminate` rather than a fourth constructor argument,
   * because the two are one subject: `terminationSucceeded` already decides a
   * kill by asking this question, and a cleanup that must decide whether a
   * FAILED close left anything running asks exactly the same one.
   *
   * A pid that still ANSWERS is not the question, and answering that one was a
   * defect on both of this class's verdict paths. A process that has exited and
   * not been reaped holds its pid, answers signal 0, and will never run another
   * instruction — and a group SIGKILL produces exactly that state for every
   * grandchild, for as long as whichever init inherited it takes to reap.
   * Reading it as alive reports `unterminable` over a tree that is gone, and
   * `unterminable` is the settlement that fails a tier.
   *
   * Charged to the same deadline as `terminate` and for the same reason: on
   * macOS this reading runs `ps` for the process-table state code, so a probe
   * taken between attempts is another blocking command nothing was charging.
   * Read at or below zero it spawns nothing and answers "still there", which
   * keeps this cleanup escalating rather than reporting a tree clean because
   * there was no time left to look at it.
   */
  readonly isRunning: (processId: number, remainingBudgetMilliseconds: number) => boolean;
}

/**
 * The wall clock this cleanup charges its phases against, as a seam.
 *
 * Injected for the one case no real clock produces on demand: a synchronous host
 * query spending its whole `HOST_QUERY_TIMEOUT_MS` ceiling, which is what
 * `#terminateUntilGone` charges to the deadline. A case driving three of those
 * cannot afford fifteen real seconds, and cannot move the SIGKILL onto a fake
 * timer either — the pause below still needs a real macrotask.
 */
export type CleanupClock = () => number;

/**
 * How the close settled.
 *
 * `unterminable` is deliberately distinct from `terminated` rather than folded
 * into it: it means a process may still be running and holding a profile, which
 * is the one cleanup outcome that can affect a LATER launch, and a reader who
 * cannot tell it from a successful kill has lost the only actionable half.
 *
 * `closed-after-rejection` is distinct from `closed` for the mirror reason. The
 * close failed and the process is nonetheless gone, so nothing leaked and no kill
 * was needed — but a caller told plain `closed` would have no way to surface the
 * rejection, and this cleanup used to discard it silently.
 */
export type CleanupSettlement = "closed" | "closed-after-rejection" | "terminated" | "unterminable";

export interface CleanupOutcome {
  readonly settlement: CleanupSettlement;
  /**
   * Why `application.close()` rejected, when it did.
   *
   * Present on every settlement reached through a rejection and absent
   * otherwise, so a caller can attach it rather than lose it. It used to be
   * caught and dropped on the floor, which is how a close that failed outright
   * could be reported as one that succeeded.
   */
  readonly closeRejection?: unknown;
  /** Wall milliseconds spent closing, measured driver-side. */
  readonly waitedMs: number;
  /**
   * The bound this close was held to, in milliseconds.
   *
   * `CLEANUP_BUDGET_MS` for every launched console, and reported rather than
   * re-derived by its readers so the sentence a reader sees and the race that
   * produced it cannot disagree: the cases that exercise a hung close supply a
   * bound short enough to exhaust, and a message naming the constant there would
   * misdescribe the very measurement it is reporting.
   */
  readonly budgetMs: number;
  /**
   * The process the settlement is about, when one was still addressable.
   *
   * Carried so a failure can NAME it: an operator told only that termination was
   * refused has nothing to look for in `ps`.
   */
  readonly processId?: number | undefined;
  /**
   * The launch profile still on disk, when removing it failed.
   *
   * On the verdict rather than raised where it happens, and independent of the
   * settlement rather than folded into it: a close can go perfectly while the
   * removal fails, and the two facts are separately actionable. Absent means the
   * directory is gone.
   */
  readonly profileRemovalFailure?: ProfileRemovalFailure | undefined;
}

/**
 * The terminator every real launch uses, over the one shared implementation.
 *
 * A thin binding rather than a body: the platform facts live in
 * `test/helpers/process-tree/`, shared with the smoke probe, because
 * two copies of them had already disagreed about whether `taskkill`'s exit
 * status counts. `BoundedCleanup` still takes the seam as a constructor
 * argument — a terminator that really killed something would signal a whole
 * process group from inside the runner, and a test must signal nothing.
 */
export const ELECTRON_PROCESS_TERMINATOR: ProcessTerminator = {
  // `processHasTerminated` and never `processExists`: the reading this verdict
  // needs counts an unreaped zombie as gone, which is the state a group SIGKILL
  // leaves every grandchild in.
  //
  // BOTH MEMBERS FORWARD THE REMAINING BUDGET, and dropping it on either one
  // would put the whole of `HOST_QUERY_TIMEOUT_MS` back outside this cleanup's
  // deadline: the shared implementations bound every command they run by the
  // smaller of their own ceiling and what is passed here, so an argument that
  // stops here is a bound that stops with it.
  isRunning: (processId: number, remainingBudgetMilliseconds: number): boolean =>
    !processHasTerminated(processId, remainingBudgetMilliseconds),
  // The two middle arguments are passed as `undefined` rather than restated:
  // the signal and the unverified root identity are `terminateProcessTree`'s own
  // defaults, and spelling either one here would be a second place for it to
  // drift from the module that owns it.
  terminate: (processId: number, remainingBudgetMilliseconds: number): boolean =>
    terminateProcessTree(processId, undefined, undefined, remainingBudgetMilliseconds),
};
