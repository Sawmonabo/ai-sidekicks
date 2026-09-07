// The scripted platform every termination cell is answered against.
//
// WHAT IS DRIVEN, AND WHAT CANNOT BE. No platform can be asked to refuse a kill
// on demand, no runner can be made Windows, and a zombie is the reaping behaviour
// of an init this process does not own. So the platform I/O stays unexecuted by
// construction — `process-tree.test.ts` says the same about itself — and the
// DECISIONS those arms funnel through are driven directly with the collaborators
// below, which is why each is a named exported function rather than an expression
// at a call site.
//
// THE PIDS ARE A CAST, AND EACH ONE PLAYS ONE PART. `ROOT_PID` is the number a
// tree is addressed through. `DESCENDANT_PID` is the member that outlives it.
// `IMPOSTOR_CHILD_PID` is a child of whoever holds the root's number after a
// reissue, which is what a walk from a RECYCLED pid hands back.
// `STALE_PARENT_ROW_PID` is the quieter one: a live process that recorded the root
// pid as its parent before this tree ever existed, still listed under that number
// because Windows retains the column after a parent exits. The two strangers are
// separate constants on purpose — a cell asserting "the stranger's tree was not
// walked" and one asserting "the stale row was not signalled" are different
// claims, and one pid playing both parts would let a fix for either satisfy both.

import { type ExternalTreeTools, type SignalTreeTools } from "../../helpers/process-tree/arms.js";
import {
  type CapturedTreeMember,
  type TreeRootIdentity,
} from "../../helpers/process-tree/identity.js";
import { type ProcessTableRow } from "../../helpers/process-tree/readers.js";
import { processTableOf } from "./process-table-fixture.test-support.js";

/** A pid that names nothing here, since every cell scripts its own answers. */
export const ROOT_PID = 4242;
/** The descendant a rootless tree leaves behind, addressable only explicitly. */
export const DESCENDANT_PID = 4243;
/**
 * A child of whoever holds `ROOT_PID` once it has been reissued.
 *
 * The pid that makes the recycled cells non-vacuous: it is what a parent-table
 * walk from `ROOT_PID` hands back after the reissue, so a cell asserting "the
 * stranger's tree was not walked" has something concrete to be false about.
 */
export const IMPOSTOR_CHILD_PID = 4244;
/**
 * A live process that recorded `ROOT_PID` as its parent before this tree existed.
 *
 * The stale row. Windows keeps a process's recorded parent id after that parent
 * exits, so a child of the number's FORMER holder sits in the table under
 * exactly the row shape this tree's own descendant sits in — and a kill list
 * built from the table cannot tell them apart.
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
 * A host that would not answer — the sentinel, and not a table with no rows.
 *
 * Its whole job is to be the foil for `EMPTY_TABLE`. That one is a listing that
 * RAN and named nothing beneath the root, which on Windows is positive evidence
 * that nothing survives the dead pid; this one is a query that would not start,
 * spent its bound, or exited non-zero, which is evidence of nothing at all. The
 * two cells that differ only in this constant are what keeps the distinction
 * from collapsing back into "no rows".
 */
export const UNREADABLE_TABLE: undefined = undefined;

/** A table in which `DESCENDANT_PID` still records `ROOT_PID` as its parent. */
export const ROOTLESS_TREE_TABLE: ReadonlyMap<number, ProcessTableRow> = processTableOf([
  [DESCENDANT_PID, ROOT_PID, DESCENDANT_STAMP],
]);

/**
 * The same rootless tree, plus a stranger the dead root's number also carries.
 *
 * Both rows are `parent = ROOT_PID` and only the capture separates them, which is
 * the whole point: the stale one was never captured, so nothing this package
 * holds says it is ours.
 */
export const STALE_PARENT_ROW_TABLE: ReadonlyMap<number, ProcessTableRow> = processTableOf([
  [DESCENDANT_PID, ROOT_PID, DESCENDANT_STAMP],
  [STALE_PARENT_ROW_PID, ROOT_PID, "older-holders-child"],
]);

/**
 * A table taken AFTER the descendant's own pid was reissued.
 *
 * The number is listed under a different parent and a different stamp, so the
 * member captured under it has exited and what holds it now is a stranger.
 */
export const REISSUED_DESCENDANT_TABLE: ReadonlyMap<number, ProcessTableRow> = processTableOf([
  [DESCENDANT_PID, 1, "somebody-else"],
]);

/**
 * A table taken AFTER the ROOT's reissue: the rows under `ROOT_PID` are the
 * stranger's children, and this tree's descendant is not in it at all.
 */
export const REISSUED_ROOT_TABLE: ReadonlyMap<number, ProcessTableRow> = processTableOf([
  [IMPOSTOR_CHILD_PID, ROOT_PID, "impostor"],
]);

/**
 * The external arm's collaborators, scripted. `hasTerminated` is handed the pids
 * the arm ran a tree kill from, so "it addressed the descendant" is separable
 * from "it reported success without looking": a scripted tree dies only if named.
 *
 * `rootIdentity` and `capturedDescendants` default to the ordinary reading — the
 * pid is still this tree's, and nothing has been captured beyond what the table
 * says — so a cell that is not about a reissued pid says nothing about one.
 */
export function scriptedExternalTools(script: {
  readonly killTreeFrom: (processId: number) => boolean;
  /**
   * The listing this scripted host produces, or `undefined` for one that will
   * not answer at all. Spelled explicitly rather than left optional, because
   * the whole point of the value is that an unreadable host and a host that
   * lists nothing are two different readings a cell has to choose between.
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
 * The tools for a rootless tree whose descendant takes, or refuses, an explicit
 * kill. The root is gone throughout — that is what makes the tree rootless — so
 * the only pid whose fate can change is the descendant's, and it changes only if
 * the arm actually addressed it.
 *
 * The descendant arrives as a CAPTURED member and not as a table row, which is
 * the discrimination the whole rootless arm now rests on: the table says who
 * claims the dead number, and only the capture says who is ours.
 */
export function rootlessTreeTools(
  descendantYieldsToExplicitKill: boolean,
  processTable: ReadonlyMap<number, ProcessTableRow> = ROOTLESS_TREE_TABLE,
): ExternalTreeTools & { readonly killedFrom: readonly number[] } {
  return scriptedExternalTools({
    // The walk starts at the root, and a pid that names nothing has no tree to
    // walk, so `taskkill` exits non-zero however alive the descendant is.
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
 * The tools for a rootless tree whose captured descendant's own pid was reissued.
 *
 * The root is gone and the number the capture named is somebody else's now, so
 * the member this tree held is itself gone — the stranger holding its pid stays
 * alive, which is what makes "it was not signalled" observable rather than
 * vacuous.
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
 * The tools for a tree whose root pid has been handed to somebody else.
 *
 * The STRANGER is scripted to take the kill and to stay alive — both halves
 * matter. Taking it is the clean `taskkill` exit that used to latch the child as
 * killed; staying alive is what makes "the root was signalled" observable in
 * `hasTerminated` as well as in `killedFrom`, so a rewrite cannot satisfy the
 * cell by signalling and then reading the wrong pid.
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
 * The POSIX arm's collaborators, scripted: nothing delivers, and the case says
 * what the GROUP and the ROOT each still hold. Both are supplied separately
 * because the whole cell is that they disagree — the root reaped and its group
 * not empty, which a shim exiting under a live browser produces on every run.
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
