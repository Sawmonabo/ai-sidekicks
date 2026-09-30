// Kills a spawned Electron tree, once, for every harness that spawns one.
//
// The smoke probe and the tier launcher each grew their own copy of these platform facts and
// diverged: only one read `taskkill`'s exit status, so the other reported a kill it had not
// performed. This module is the public entry and the dispatch between the arms in
// `platform-termination.ts`, binding their collaborators to one shared deadline.
//
// - POSIX: `electron-child.ts` and `playwright-core` spawn with `detached: process.platform !==
//   "win32"`, so Electron leads its own process group and `-pid` reaches the browser, zygote and
//   renderers. A pid leading someone else's group would take that group down, so the POSIX arm
//   narrows to the leader and never widens; an attached child leads no group, so `-pid` fails
//   `ESRCH` and falls through.
// - Windows: no process group, and its "signals" are `TerminateProcess` calls that are never
//   forwarded, so signaling the launcher alone orphans the browser holding the inherited stdout.
//   `taskkill /pid N /t` walks the tree instead and is a separate program, so the child's `exit`
//   reports no signal; `PROCESS_TREE_TERMINATION_MODE` names the difference.
// - Delivery and survival are separate questions: a `taskkill` that exits non-zero (termination
//   denied) leaves `spawnSync`'s `error` undefined while Electron runs, yet a tree already gone
//   also exits non-zero. Which it was is asked of the OS, never read from taskkill's message,
//   which is localized.

import {
  deliverSignal,
  runPlatformTreeKill,
  terminateExternalTree,
  terminateSignaledTree,
  type ExternalTreeTools,
} from "./platform-termination.js";
import { HostCommandBudget, TERMINATION_CONSUMES_CAPTURED_DESCENDANTS } from "./budget.js";
import { SpawnedTreeIdentity } from "./identity.js";
import { processGroupExists, processHasTerminated } from "./liveness.js";
import { readProcessTable, type ProcessTableReader } from "./readers.js";

/** How this platform's tree kill reaches a tree. */
export type ProcessTreeTerminationMode = "signal" | "external";

/**
 * Whether `terminateProcessTree` delivers a signal or runs another program.
 *
 * On POSIX the group kill is a delivered signal, so the child's `exit` names it; on Windows
 * `taskkill /f` is external and the child reports an exit code with `signal === null`. Derived
 * from `budget.ts`'s predicate so the arm that consumes a captured descendant set and the
 * reservation for capturing one cannot drift apart.
 */
export const PROCESS_TREE_TERMINATION_MODE: ProcessTreeTerminationMode =
  TERMINATION_CONSUMES_CAPTURED_DESCENDANTS ? "external" : "signal";

/**
 * The three host acts the Windows arm performs, as one injectable set.
 *
 * A macOS runner never enters that arm, so injection is what lets the deadline binding below be
 * checked. Each member takes the budget as its last parameter, so the production set is the three
 * functions themselves.
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
 * The Windows arm's collaborators, every one charged to one deadline.
 *
 * The closures hold the budget and ask it afresh at each call, so the figures decline across a
 * sequence and sum to the deadline. Capturing a number instead let `taskkill` and the fallback
 * listing each spend the whole remainder, overrunning the deadline several times before
 * `BoundedCleanup` could re-read the clock. `capturedDescendants` reads nothing and is charged
 * nothing.
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
 * Signal the process tree led by `processId`, and say whether the tree is gone.
 *
 * `true` means the signal was delivered or nothing was left to signal; `false` means something
 * that can still run refused it. A delivered graceful signal only means the tree was asked to
 * exit, so a caller escalating from `SIGTERM` asks again after its grace period. The verdict is
 * over the tree, never the root alone.
 *
 * `rootIdentity` is captured at the tree's spawn, and the Windows arm refuses to signal
 * `processId` unless it re-verifies. The default is the unverified identity, since capturing here
 * would compare the pid against itself and answer `same` for every pid on the host.
 *
 * Every host command is a bounded `spawnSync` and this call is synchronous, so the commands share
 * one deadline or vitest's timeout would fire on the blocked thread first.
 * `remainingBudgetMilliseconds` is what is left when this is called; `HostCommandBudget` re-reads
 * it before each command, and a budget spent to zero runs none and reports the tree neither
 * signaled nor terminated. `readClock` is last because production passes the budget and a test the
 * clock.
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
  return terminateSignaledTree(processId, signal, {
    deliver: deliverSignal,
    groupHasMember: processGroupExists,
    hasTerminated: (treeMemberProcessId: number): boolean =>
      processHasTerminated(treeMemberProcessId, budget.remainingMilliseconds()),
  });
}
