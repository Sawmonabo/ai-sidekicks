// The two platform arms of a tree kill. `termination.ts` picks the arm and binds its readings.
//
// A tree is not its root: the Electron shim can be reaped while the browser it spawned runs on.
// POSIX asks survival of the process group (`-pid`). Windows has no group, so `taskkill /t` walks
// down from the root, and a root pid the OS has reissued would walk a stranger's tree. Identity is
// therefore read before anything is signaled: `same` walks the root; `gone` and `recycled` address
// only members captured while the root read `same`, and with none the verdict is a refusal.
// Windows does not reparent, so a row under the root pid does not prove the process is ours, and a
// table that could not be read is a sentinel this arm fails closed on, never an empty table.

import process from "node:process";

import { type TreeRootIdentity } from "./identity.js";
import {
  descendantsOf,
  runBoundedHostCommand,
  type ProcessTableReader,
  type ProcessTableRow,
} from "./readers.js";
import { verifyCapturedMembers, type CapturedTreeMember } from "./start-stamps.js";

/**
 * Whether a termination attempt left nothing to worry about.
 *
 * A delivered signal succeeds, and so does an undelivered one when nothing is left to kill,
 * the ordinary outcome when a process exited between a close timing out and the kill.
 * `treeStillRunning` is the tree's question and never the root's.
 */
function terminationSucceeded(signalDelivered: boolean, treeStillRunning: () => boolean): boolean {
  return signalDelivered || !treeStillRunning();
}

/** What the POSIX arm needs from the platform, as one injectable set. */
export interface SignalTreeTools {
  /** Deliver `signal` to `target`, and say whether it landed rather than throwing. */
  readonly deliver: (target: number, signal: NodeJS.Signals) => boolean;
  /** Whether the process group led by `processId` still holds any member. */
  readonly groupHasMember: (processId: number) => boolean;
  /** Whether `processId` itself will never run another instruction. */
  readonly hasTerminated: (processId: number) => boolean;
}

/** What the Windows arm needs from the platform, as one injectable set. */
export interface ExternalTreeTools {
  /** Run the platform's tree kill downwards from `processId`; `true` if it exited clean. */
  readonly killTreeFrom: (processId: number, forced: boolean) => boolean;
  /**
   * Every process on this host, or `undefined` when it would not answer at all.
   *
   * Told apart by the sentinel and never by counting rows: an empty table is a host that listed
   * nothing beneath the root, `undefined` one that listed nothing at all, and only the first is
   * evidence.
   */
  readonly processTable: ProcessTableReader;
  /** Whether `processId` will never run another instruction. */
  readonly hasTerminated: (processId: number) => boolean;
  /**
   * What the root pid names right now, relative to what this tree captured.
   *
   * Asked before anything is signaled, since a `taskkill` at a reissued pid has already
   * terminated a stranger by the time any verdict is computed.
   */
  readonly rootIdentity: () => TreeRootIdentity;
  /**
   * The members captured while the root last read `same`, each with its stamp.
   *
   * The only handle on this tree that survives its root's pid being reissued, and the only
   * source of a rootless kill list. Empty means nothing of this tree is nameable, not that the
   * tree is gone.
   */
  readonly capturedDescendants: () => readonly CapturedTreeMember[];
}

/**
 * Signal the group `processId` leads, and say whether the tree is gone.
 *
 * The negative form comes first because it alone reaches the browser behind the launcher shim;
 * the leader alone is the narrowing fallback for a child that leads no group, and this arm never
 * widens past it. Survival is the group's, since a group outlives its leader.
 */
export function terminateSignaledTree(
  processId: number,
  signal: NodeJS.Signals,
  tools: SignalTreeTools,
): boolean {
  for (const target of [-processId, processId]) {
    if (tools.deliver(target, signal)) {
      return true;
    }
  }
  // ESRCH on an empty group is the commonest reason both deliveries fail; calling that a failed
  // termination would claim a profile is held when nothing is, and EPERM on a live group
  // counted as success would be the same mistake reversed.
  return terminationSucceeded(
    false,
    () => tools.groupHasMember(processId) || !tools.hasTerminated(processId),
  );
}

/**
 * Walk `processId`'s tree with the platform's own tree kill, then address what it could not reach.
 *
 * The pid is walked only under `same`, since a reissued pid would terminate a stranger and report
 * the surviving descendant as killed. The second pass is not a retry: `taskkill /t` walks down
 * from the root, so a root that names nothing gives it nothing to find. Those members come from
 * what this tree captured while the root was verifiably its own, verified pid by pid, and are
 * killed by name. The verdict covers every one of them and every row the host still hangs off
 * the root pid, so a rootless termination is never accepted because the root is gone. An
 * unvouched row, or a host that would not produce rows, is a reason to refuse rather than a pid
 * to signal.
 */
export function terminateExternalTree(
  processId: number,
  signal: NodeJS.Signals,
  tools: ExternalTreeTools,
): boolean {
  const forced = signal === "SIGKILL";
  const identity = tools.rootIdentity();
  if (identity === "same" && tools.killTreeFrom(processId, forced)) {
    return true;
  }
  // One read, so the kill list and the survival reading describe the same snapshot.
  const listing = tools.processTable();
  // An unreadable host still gets a kill list: the capture needs no table, and
  // `verifyCapturedMembers` convicts only on a stamp that disagrees. The sentinel must not
  // reach the verdict as a reading, which the guard below prevents.
  const processTable = listing ?? new Map<number, ProcessTableRow>();
  const captured = tools.capturedDescendants();
  const members = addressableTreeMembers(processId, identity, processTable, captured);
  const unreachedMembers = members.filter((member) => !tools.hasTerminated(member));
  for (const member of unreachedMembers) {
    tools.killTreeFrom(member, forced);
  }
  if (identity === "recycled" && captured.length === 0) {
    // The pid belongs to somebody else and nothing was captured while it was ours, so there is
    // no reading to take; reporting a kill would be the false success this module prevents.
    // Asked of the capture rather than of what survived verification, since a captured pid the
    // stamps convict of being somebody else means that member exited.
    return false;
  }
  const claimants = unverifiedRootClaimants(processId, identity, processTable, members);
  return terminationSucceeded(
    false,
    () =>
      // First, because the other three read the table, and on an unanswering host each reads
      // clean, which reported a live browser as terminated. It also short-circuits, so a host
      // already refusing one query is asked no more.
      listing === undefined ||
      // The root counts only while it is still this tree's: under `recycled` a live stranger
      // would make the tree unkillable forever, and under `gone` asking anyway catches an
      // identity read that raced a root that had not exited.
      (identity !== "recycled" && !tools.hasTerminated(processId)) ||
      unreachedMembers.some((member) => !tools.hasTerminated(member)) ||
      claimants.some((claimant) => !tools.hasTerminated(claimant)),
  );
}

/**
 * The members this arm may signal, given what the root pid turned out to name.
 *
 * A set, because the two sources overlap on every ordinary reading and a member addressed twice
 * would get a second `taskkill`. The table walk is admitted for `same` alone; under `gone` and
 * `recycled` the kill list is the capture, verified against the stamps in this same table.
 */
function addressableTreeMembers(
  processId: number,
  identity: TreeRootIdentity,
  processTable: ReadonlyMap<number, ProcessTableRow>,
  captured: readonly CapturedTreeMember[],
): number[] {
  const verified = verifyCapturedMembers(captured, processTable);
  if (identity !== "same") {
    return [...new Set(verified)];
  }
  return [...new Set([...descendantsOf(processId, processTable), ...verified])];
}

/**
 * The rows this host still hangs off the root pid that this tree cannot vouch for.
 *
 * Read and never signaled: each is either an uncaptured descendant or a leftover child of the
 * pid's former holder, and nothing in the table separates them. Killing one risks an unrelated
 * process and ignoring one risks reporting a live tree as gone, so the verdict is refused
 * instead. Empty for every identity but `gone`: under `same` the walk is already the kill list,
 * and under `recycled` the rows belong at least as much to the pid's new holder.
 */
function unverifiedRootClaimants(
  processId: number,
  identity: TreeRootIdentity,
  processTable: ReadonlyMap<number, ProcessTableRow>,
  addressed: readonly number[],
): number[] {
  if (identity !== "gone") {
    return [];
  }
  const addressedMembers = new Set(addressed);
  return descendantsOf(processId, processTable).filter(
    (claimant) => !addressedMembers.has(claimant),
  );
}

/**
 * Run this platform's tree kill downwards from `processId`.
 *
 * `taskkill /pid N /t` walks the descendant tree: without `/f` it posts WM_CLOSE to each windowed
 * process, and with `/f` it terminates every node outright. `playwright-core` runs the same form.
 * A non-zero exit is not automatically a failure, since a tree already gone is one of the things
 * taskkill refuses, so this reports the status and the arm decides by asking the OS rather than
 * reading taskkill's localized message. It goes through `runBoundedHostCommand`: a bound already
 * spent runs nothing and reports the kill as undelivered, which keeps the caller escalating.
 */
export function runPlatformTreeKill(
  processId: number,
  forced: boolean,
  remainingBudgetMilliseconds?: number,
): boolean {
  const result = runBoundedHostCommand(
    "taskkill",
    ["/pid", String(processId), "/t", ...(forced ? ["/f"] : [])],
    remainingBudgetMilliseconds,
  );
  return result !== undefined && result.error === undefined && result.status === 0;
}

/**
 * Deliver `signal` to `target`, reporting a throw as a failure to deliver.
 *
 * A negative target addresses a process group, which is the launched tree only because the
 * spawn was detached. A named seam so the arm above can be driven without real delivery.
 */
export function deliverSignal(target: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(target, signal);
    return true;
  } catch {
    // The group is already reaped, this pid leads none, or it is out of reach.
    return false;
  }
}
