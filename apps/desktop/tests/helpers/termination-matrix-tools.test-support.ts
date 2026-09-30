// The scripted platform every termination cell is answered against. No platform can be made to
// refuse a kill on demand and no runner can be made Windows, so the platform I/O stays
// unexecuted and the decisions the arms funnel through are driven directly with these
// collaborators (`process-tree.test.ts` does the same).
//
// The pids are a cast. `ROOT_PID` is the number a tree is addressed through and `DESCENDANT_PID`
// the member that outlives it. `IMPOSTOR_CHILD_PID` is a child of whoever holds the root's number
// after a reissue; `STALE_PARENT_ROW_PID` is a live process that recorded the root pid as its
// parent before this tree existed (Windows keeps that column after a parent exits). They are
// separate so a fix for one claim cannot satisfy the other.

import {
  type ExternalTreeTools,
  type SignalTreeTools,
} from "./process-tree/platform-termination.js";
import { type TreeRootIdentity } from "./process-tree/identity.js";
import { type ProcessTableRow } from "./process-tree/readers.js";
import { type CapturedTreeMember } from "./process-tree/start-stamps.js";
import { processTableOf } from "./process-table-fixture.test-support.js";

/** A pid that names nothing here, since every cell scripts its own answers. */
export const ROOT_PID = 4242;
/** The descendant a rootless tree leaves behind, addressable only explicitly. */
export const DESCENDANT_PID = 4243;
/**
 * A child of whoever holds `ROOT_PID` once it is reissued: what a parent-table walk from
 * `ROOT_PID` returns, so "the stranger's tree was not walked" has something concrete to be false
 * about.
 */
export const IMPOSTOR_CHILD_PID = 4244;
/**
 * A live process that recorded `ROOT_PID` as its parent before this tree existed. Its row has the
 * same shape as this tree's descendant, so a kill list built from the table cannot tell them
 * apart.
 */
export const STALE_PARENT_ROW_PID = 4245;

/** The stamp the descendant is listed under while it is still itself. */
const DESCENDANT_STAMP = "descendant-at-capture";

/** The one member captured while the root was verifiably this tree's. */
export const CAPTURED_DESCENDANT: CapturedTreeMember = {
  processId: DESCENDANT_PID,
  startStamp: DESCENDANT_STAMP,
};

/** A host on which nothing at all claims the root pid. */
export const EMPTY_TABLE: ReadonlyMap<number, ProcessTableRow> = processTableOf([]);

/**
 * A host that would not answer: the sentinel, not a table with no rows. It is the foil for
 * `EMPTY_TABLE`, a listing that ran and named nothing beneath the root, which on Windows is
 * evidence that nothing survives; this one is evidence of nothing.
 */
export const UNREADABLE_TABLE: undefined = undefined;

/** A table in which `DESCENDANT_PID` still records `ROOT_PID` as its parent. */
export const ROOTLESS_TREE_TABLE: ReadonlyMap<number, ProcessTableRow> = processTableOf([
  [DESCENDANT_PID, ROOT_PID, DESCENDANT_STAMP],
]);

/**
 * The same rootless tree plus a stranger the dead root's number also carries. Both rows have
 * `parent = ROOT_PID` and only the capture separates them: the stale one was never captured.
 */
export const STALE_PARENT_ROW_TABLE: ReadonlyMap<number, ProcessTableRow> = processTableOf([
  [DESCENDANT_PID, ROOT_PID, DESCENDANT_STAMP],
  [STALE_PARENT_ROW_PID, ROOT_PID, "older-holders-child"],
]);

/**
 * A table taken after the descendant's own pid was reissued: the number is listed under another
 * parent and stamp, so the captured member has exited and a stranger holds the pid.
 */
export const REISSUED_DESCENDANT_TABLE: ReadonlyMap<number, ProcessTableRow> = processTableOf([
  [DESCENDANT_PID, 1, "somebody-else"],
]);

/**
 * A table taken after the root's reissue: the rows under `ROOT_PID` are the stranger's children,
 * and this tree's descendant is absent.
 */
export const REISSUED_ROOT_TABLE: ReadonlyMap<number, ProcessTableRow> = processTableOf([
  [IMPOSTOR_CHILD_PID, ROOT_PID, "impostor"],
]);

/**
 * The external arm's collaborators, scripted. `hasTerminated` receives the pids the arm ran a tree
 * kill from, so a scripted tree dies only if named. `rootIdentity` and `capturedDescendants`
 * default to the ordinary reading (the pid is still this tree's, nothing captured), so a cell not
 * about a reissued pid says nothing about one.
 */
export function scriptedExternalTools(script: {
  readonly killTreeFrom: (processId: number) => boolean;
  /**
   * The listing this host produces, or `undefined` for one that will not answer; explicit,
   * because an unreadable host and one that lists nothing are different readings.
   */
  readonly processTable: ReadonlyMap<number, ProcessTableRow> | undefined;
  readonly hasTerminated: (processId: number, killAttempts: readonly number[]) => boolean;
  readonly rootIdentity?: TreeRootIdentity;
  readonly capturedDescendants?: readonly CapturedTreeMember[];
}): ExternalTreeTools & { readonly killedFrom: readonly number[] } {
  const killedFrom: number[] = [];
  return {
    killedFrom,
    killTreeFrom: (processId: number): boolean => {
      killedFrom.push(processId);
      return script.killTreeFrom(processId);
    },
    processTable: () => script.processTable,
    hasTerminated: (processId: number): boolean => script.hasTerminated(processId, killedFrom),
    rootIdentity: () => script.rootIdentity ?? "same",
    capturedDescendants: () => script.capturedDescendants ?? [],
  };
}

/**
 * The tools for a rootless tree whose descendant takes or refuses an explicit kill. The root is
 * gone throughout, so only the descendant's fate can change, and only if the arm addressed it. The
 * descendant arrives as a captured member, not a table row: the table says who claims the dead
 * number, only the capture says who is ours.
 */
export function rootlessTreeTools(
  descendantYieldsToExplicitKill: boolean,
  processTable: ReadonlyMap<number, ProcessTableRow> = ROOTLESS_TREE_TABLE,
): ExternalTreeTools & { readonly killedFrom: readonly number[] } {
  return scriptedExternalTools({
    // `taskkill` walks from the root; a pid that names nothing has no tree, so it exits non-zero
    // however alive the descendant is.
    killTreeFrom: (processId: number) => processId !== ROOT_PID && descendantYieldsToExplicitKill,
    processTable,
    hasTerminated: (processId: number, killAttempts: readonly number[]) =>
      processId === ROOT_PID ||
      (descendantYieldsToExplicitKill && killAttempts.includes(processId)),
    rootIdentity: "gone",
    capturedDescendants: [CAPTURED_DESCENDANT],
  });
}

/**
 * The tools for a rootless tree whose captured descendant's own pid was reissued. The captured
 * member is gone and the stranger holding its pid stays alive, so "it was not signaled" is
 * observable.
 */
export function reissuedDescendantTools(): ExternalTreeTools & {
  readonly killedFrom: readonly number[];
} {
  return scriptedExternalTools({
    killTreeFrom: () => true,
    processTable: REISSUED_DESCENDANT_TABLE,
    hasTerminated: (processId: number) => processId === ROOT_PID,
    rootIdentity: "gone",
    capturedDescendants: [CAPTURED_DESCENDANT],
  });
}

/**
 * The tools for a tree whose root pid was handed to somebody else. The stranger takes the kill and
 * stays alive: taking it is the clean `taskkill` exit that would latch the child as killed, and
 * staying alive makes a signal to the root visible in `hasTerminated` as well as `killedFrom`.
 */
export function reissuedRootTools(
  capturedDescendants: readonly CapturedTreeMember[],
  capturedDescendantIsGone = false,
): ExternalTreeTools & { readonly killedFrom: readonly number[] } {
  return scriptedExternalTools({
    killTreeFrom: () => true,
    processTable: REISSUED_ROOT_TABLE,
    hasTerminated: (processId: number) =>
      processId === DESCENDANT_PID ? capturedDescendantIsGone : false,
    rootIdentity: "recycled",
    capturedDescendants,
  });
}

/** A liveness probe pair that reports one scripted state for a pid that exists. */
export function scriptedLiveness(stateCode: string): {
  exists: () => boolean;
  stateCode: () => string;
} {
  return { exists: () => true, stateCode: () => stateCode };
}

/**
 * The POSIX arm's collaborators, scripted: nothing delivers, and the case says what the group and
 * the root each still hold. They disagree in the cell: the root reaped while its group is not
 * empty, as a shim exiting under a live browser produces.
 */
export function undeliverableSignalTools(script: {
  readonly groupHasMember: boolean;
  readonly rootHasTerminated: boolean;
}): SignalTreeTools {
  return {
    deliver: () => false,
    groupHasMember: () => script.groupHasMember,
    hasTerminated: () => script.rootHasTerminated,
  };
}
