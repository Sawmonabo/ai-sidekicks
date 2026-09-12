// Killing a spawned Electron tree, once, for every harness that spawns one.
//
// Two harnesses spawn Electron — the smoke probe in `electron-probe.ts`
// and the console launcher behind `test/console/bounded-cleanup.ts` — and each
// grew its own copy of the same platform facts. They had already diverged:
// only one of them read `taskkill`'s exit status, so the other reported a kill it
// had not performed. A rule with two homes is a rule that will disagree with
// itself; this is the home.
//
// This module is the DOOR and the dispatch, and deliberately nothing else. The
// readings live in `readers.ts` and `liveness.ts`, the pid-versus-process
// question in `identity.ts`, the shared deadline in `budget.ts`, and the two
// platform decisions in `arms.ts` — five roles that were one 509-line file until
// each of them grew its own findings. What is left here is the choice between
// the two arms, and the binding of each arm's collaborators to that deadline.
//
// The facts that decide the dispatch, each measured rather than assumed:
//
//   • POSIX group delivery is safe HERE and catastrophic in general.
//     `playwright-core` spawns with `detached: process.platform !== "win32"`
//     (`lib/coreBundle.js`), and the smoke probe passes `detached: true` itself,
//     so on POSIX the launched Electron LEADS its own process group and `-pid`
//     reaches the browser, its zygote, and every renderer at once. The negative
//     form addresses a whole GROUP — the one whose id is that number — and the
//     only reason that group is the launched tree is the detached spawn above.
//     Hand the same call a pid that leads somebody else's group and it takes
//     that group down instead, which is why the POSIX arm narrows to the leader
//     and never widens. An ATTACHED child leads no group at all, so the negative
//     call finds none, fails `ESRCH`, and falls through to that arm; this
//     runner's own group is a different number and is never passed.
//
//   • Windows has no process group to signal, and its "signals" are
//     `TerminateProcess` calls that are never forwarded, so signalling the
//     launcher alone orphans the browser holding the inherited stdout write end.
//     `taskkill /pid N /t` walks the descendant tree instead — `runPlatformTreeKill`
//     in `arms.ts` states what the flags do and why. It is a SEPARATE PROGRAM
//     rather than a delivered signal, which is why the mode below is named and
//     exported: a tree terminated that way reports no signal on the child's
//     `exit`, so a test asserting one is asserting a POSIX detail on a platform
//     that has none.
//
//   • Delivery and survival are two questions, and answering only the first was
//     the divergence. A `taskkill` that SPAWNS and exits non-zero — termination
//     denied, most of all — leaves `spawnSync`'s `error` undefined while Electron
//     keeps running. The exit code is a separate field of that result precisely
//     because it is a separate question, and a non-zero exit is not automatically
//     a failure either: a tree already gone is one of the things taskkill refuses.
//     Which one it was is asked of the OS, never read out of taskkill's message,
//     because that message is localised and this must not depend on the runner's
//     display language.

import {
  deliverSignal,
  runPlatformTreeKill,
  terminateExternalTree,
  terminateSignalledTree,
  type ExternalTreeTools,
} from "./arms.js";
import { HostCommandBudget, TERMINATION_CONSUMES_CAPTURED_DESCENDANTS } from "./budget.js";
import { SpawnedTreeIdentity } from "./identity.js";
import { processGroupExists, processHasTerminated } from "./liveness.js";
import { readProcessTable, type ProcessTableReader } from "./readers.js";

/** How this platform's tree kill reaches a tree. */
export type ProcessTreeTerminationMode = "signal" | "external";

/**
 * Whether `terminateProcessTree` DELIVERS a signal or runs another program.
 *
 * Exported because it is the honest key for a caller that wants to say
 * something about how a tree died. On POSIX the group kill is a delivered
 * signal, so the child's `exit` names it; on Windows the tree is walked by
 * `taskkill /f`, an external termination the child reports as an exit code with
 * `signal === null`. A test branching on `process.platform` to say the same
 * thing would be restating this module's own fact somewhere it can drift.
 *
 * Derived from `budget.ts`'s predicate rather than from `process.platform` here,
 * for that same reason one step further out: the arm that consumes a captured
 * descendant set and the reservation an enclosing budget keeps for capturing one
 * are the same fact, and two spellings of it are two things that drift.
 */
export const PROCESS_TREE_TERMINATION_MODE: ProcessTreeTerminationMode =
  TERMINATION_CONSUMES_CAPTURED_DESCENDANTS ? "external" : "signal";

/**
 * The three host acts the Windows arm performs, as one injectable set.
 *
 * Injected for the reason every seam in this directory is: a macOS runner never
 * enters that arm, so the binding below — which figure each command is charged,
 * and when it is read — would otherwise be a claim nothing on this host could
 * check. Each member takes the budget as its LAST parameter, matching the shape
 * `readers.ts` and `liveness.ts` already publish, so the production set is the
 * three functions themselves rather than three wrappers.
 */
export interface ExternalHostCommands {
  readonly killTreeFrom: (
    processId: number,
    forced: boolean,
    remainingBudgetMilliseconds?: number,
  ) => boolean;
  readonly readProcessTable: ProcessTableReader;
  readonly hasTerminated: (processId: number, remainingBudgetMilliseconds?: number) => boolean;
}

/** The real three, which every production termination takes. */
const PLATFORM_EXTERNAL_HOST_COMMANDS: ExternalHostCommands = {
  killTreeFrom: runPlatformTreeKill,
  readProcessTable,
  hasTerminated: processHasTerminated,
};

/**
 * The Windows arm's collaborators, every one of them charged to ONE deadline.
 *
 * THE BINDING IS THE FIX, AND IT IS WHY THIS IS A NAMED FUNCTION. These closures
 * used to capture a `remainingBudgetMilliseconds` NUMBER, so each command they
 * ran was entitled to the whole remainder: `taskkill` could spend it and the
 * fallback process-table listing after it could spend it again, and one
 * `terminateProcessTree` call overran the deadline it was given several times
 * over before `BoundedCleanup` could re-read the clock. They capture the BUDGET
 * now and ask it afresh at each call, so the figures decline across a sequence
 * rather than repeating, and their sum is the deadline rather than a multiple.
 *
 * `capturedDescendants` is the one member that reads nothing and is charged
 * nothing — it returns a set already in memory.
 */
export function externalTreeToolsOver(
  processId: number,
  rootIdentity: SpawnedTreeIdentity,
  budget: HostCommandBudget,
  hostCommands: ExternalHostCommands = PLATFORM_EXTERNAL_HOST_COMMANDS,
): ExternalTreeTools {
  return {
    killTreeFrom: (treeMemberProcessId: number, forced: boolean): boolean =>
      hostCommands.killTreeFrom(treeMemberProcessId, forced, budget.remainingMilliseconds()),
    processTable: () => hostCommands.readProcessTable(budget.remainingMilliseconds()),
    hasTerminated: (treeMemberProcessId: number): boolean =>
      hostCommands.hasTerminated(treeMemberProcessId, budget.remainingMilliseconds()),
    rootIdentity: () => rootIdentity.readIdentity(budget.remainingMilliseconds()),
    capturedDescendants: () => rootIdentity.capturedDescendants,
  };
}

/**
 * Signal the process tree led by `processId`, and say whether the TREE is gone.
 *
 * `true` means the signal was delivered or there was nothing left to signal;
 * `false` means something that can still run refused it. A caller escalating
 * from `SIGTERM` asks again after its grace period rather than reading `true` as
 * "gone" — a delivered graceful signal says the tree was asked to exit, not that
 * it has.
 *
 * The verdict is over the TREE and never over the root alone, which is what the
 * arms in `arms.ts` are for: this function's whole body is the platform dispatch
 * and the readings each arm is handed. Answering from the root is what let a
 * rootless Windows tree — a reaped launcher shim with a live browser under it —
 * be reported as a delivered kill.
 *
 * `rootIdentity` is the tree's own, captured at the spawn that created it, and
 * the Windows arm refuses to signal `processId` at all unless it re-verifies. The
 * default is the UNVERIFIED one rather than a fresh capture: capturing here would
 * compare the pid against itself an instant later and answer `same` for every
 * pid on the host, which is a check that cannot fail dressed as one that can.
 *
 * AND EVERY HOST COMMAND THIS RUNS IS CHARGED TO ONE SHARED DEADLINE. This whole
 * call is synchronous — the stamp read, the process-table listing, `taskkill`,
 * and the state code behind each survival reading are all `spawnSync`, each
 * bounded at `HOST_QUERY_TIMEOUT_MS` on its own and none of them bounded
 * collectively — so a caller that escalates three times can spend several
 * multiples of a cleanup budget that was already over, with vitest's timeout
 * firing on this blocked thread before the verdict it was waiting for exists.
 *
 * `remainingBudgetMilliseconds` is what is LEFT of that deadline WHEN THIS IS
 * CALLED, and `HostCommandBudget` turns it into an absolute instant re-read
 * before each command rather than a snapshot handed to all of them: a figure
 * copied to every call site entitles each command to the whole remainder, so
 * `taskkill` spends it and the listing after it spends it again. Each command
 * takes the smaller of what is left and its own bound; a budget spent to zero
 * runs none of them and reports the tree as neither signalled nor terminated,
 * which is the reading that keeps a caller escalating rather than one that
 * claims a kill it never attempted.
 *
 * `readClock` sits last for `readProcessStateCode`'s reason: the budget is what
 * a production caller passes, and the clock is what a case does.
 */
export function terminateProcessTree(
  processId: number,
  signal: NodeJS.Signals = "SIGKILL",
  rootIdentity: SpawnedTreeIdentity = SpawnedTreeIdentity.unverified(processId),
  remainingBudgetMilliseconds?: number,
  readClock: () => number = Date.now,
): boolean {
  const budget = new HostCommandBudget(remainingBudgetMilliseconds, readClock);
  if (PROCESS_TREE_TERMINATION_MODE === "external") {
    return terminateExternalTree(
      processId,
      signal,
      externalTreeToolsOver(processId, rootIdentity, budget),
    );
  }
  return terminateSignalledTree(processId, signal, {
    deliver: deliverSignal,
    groupHasMember: processGroupExists,
    hasTerminated: (treeMemberProcessId: number): boolean =>
      processHasTerminated(treeMemberProcessId, budget.remainingMilliseconds()),
  });
}
