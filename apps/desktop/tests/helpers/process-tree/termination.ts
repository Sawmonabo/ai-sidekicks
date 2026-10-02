// Kills a spawned Electron tree, for every harness that spawns one. This module is the public
// entry and the dispatch between the arms in `platform-termination.ts`, binding their
// dependencies to one shared deadline.
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
import { readProcessTable } from "./readers.js";

/** How this platform's tree kill reaches a tree. */
type ProcessTreeTerminationMode = "signal" | "external";

/**
 * Whether `terminateProcessTree` delivers a signal or runs another program.
 *
 * On POSIX the group kill is a delivered signal, so the child's `exit` names it; on Windows
 * `taskkill /f` is external and the child reports an exit code with `signal === null`. Derived
 * from `budget.ts`'s predicate so the arm that consumes a captured descendant set and the
 * reservation for capturing one cannot drift apart.
 */
const PROCESS_TREE_TERMINATION_MODE: ProcessTreeTerminationMode =
  TERMINATION_CONSUMES_CAPTURED_DESCENDANTS ? "external" : "signal";

/**
 * The Windows arm's dependencies, every one charged to one deadline.
 *
 * The closures hold the budget and ask it afresh at each call, so the figures decline across a
 * sequence and sum to the deadline; a captured number would let each command spend the whole
 * remainder. `capturedDescendants` reads nothing and is charged nothing.
 */
function externalTreeToolsOver(
  rootIdentity: SpawnedTreeIdentity,
  budget: HostCommandBudget,
): ExternalTreeTools {
  return {
    killTreeFrom: (treeMemberProcessId: number, forced: boolean): boolean =>
      runPlatformTreeKill(treeMemberProcessId, forced, budget.remainingMilliseconds()),
    processTable: () => readProcessTable(budget.remainingMilliseconds()),
    hasTerminated: (treeMemberProcessId: number): boolean =>
      processHasTerminated(treeMemberProcessId, budget.remainingMilliseconds()),
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
 * signaled nor terminated.
 */
export function terminateProcessTree(
  processId: number,
  signal: NodeJS.Signals = "SIGKILL",
  rootIdentity: SpawnedTreeIdentity = SpawnedTreeIdentity.unverified(processId),
  remainingBudgetMilliseconds?: number,
): boolean {
  const budget = new HostCommandBudget(remainingBudgetMilliseconds);
  if (PROCESS_TREE_TERMINATION_MODE === "external") {
    return terminateExternalTree(processId, signal, externalTreeToolsOver(rootIdentity, budget));
  }
  return terminateSignaledTree(processId, signal, {
    deliver: deliverSignal,
    groupHasMember: processGroupExists,
    hasTerminated: (treeMemberProcessId: number): boolean =>
      processHasTerminated(treeMemberProcessId, budget.remainingMilliseconds()),
  });
}
