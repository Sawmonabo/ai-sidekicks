// What a per-instance start stamp proves, and what it is never allowed to prove.
//
// This module is stateless: it answers whether two readings of one pid agree and whether one
// reading is demonstrably earlier than another. `identity.ts` holds the state they are compared
// against, and nothing here reads a host.
//
// A stamp that cannot be compared, with no capture or no current reading, is admitted rather
// than refused. Refusing every kill on a host whose stamp probe does not work would leak every
// tree there, and detection is impossible by construction; a pid is convicted only by a stamp
// that disagrees, never by one that is missing.
//
// A stamp also says whether a claimant could be a child at all. Windows does not reparent, so a
// process whose parent exited keeps naming that number, including after the number is handed to
// this tree's root. The parent-table walk cannot tell such a claimant from a descendant, since
// both rows record the same pid and the claimant's stamp has not changed. What separates them
// is an order: a child cannot start before its parent. A claimant whose stamp is demonstrably
// earlier than the root's is not a descendant, and `startStampPrecedes` keeps the failure
// direction above, convicting nobody on a pair it cannot order.

import { type ProcessTableRow } from "./readers.js";

/**
 * One descendant, captured while the tree was verifiably this one's.
 *
 * The pid is what a kill is addressed to and the stamp says the address is still right.
 * `startStamp` is `undefined` when the listing carried none, which admits the member.
 */
export interface CapturedTreeMember {
  /** The pid this member held when it was captured. */
  readonly processId: number;
  /** Its per-instance start stamp then, or `undefined` if none was read. */
  readonly startStamp: string | undefined;
}

/**
 * Whether a captured member's pid still names the process it was captured from.
 *
 * Refusal is on disagreement and never on absence:
 *
 * - Both stamps read and they differ: the pid was reissued, and killing it is the defect this
 *   prevents.
 * - Either stamp is missing: no comparison was possible, so the member stands.
 * - Both read and agree: the member is still itself.
 */
export function stampStillNamesMember(
  member: CapturedTreeMember,
  currentStamp: string | undefined,
): boolean {
  return (
    member.startStamp === undefined ||
    currentStamp === undefined ||
    currentStamp === member.startStamp
  );
}

/**
 * The pids of the captured members that still name the process they were captured from.
 *
 * A member absent from the table is the ordinary shape of a descendant that already exited, and
 * it is kept: the caller's liveness reading filters it before anything is signaled. An
 * unreadable listing never arrives here as a table (`readers.ts` answers it with a sentinel), so
 * "the host would not answer" is never mistaken for "everything has exited".
 */
export function verifyCapturedMembers(
  captured: readonly CapturedTreeMember[],
  processTable: ReadonlyMap<number, ProcessTableRow>,
): number[] {
  return captured
    .filter((member) =>
      stampStillNamesMember(member, processTable.get(member.processId)?.startStamp),
    )
    .map((member) => member.processId);
}

/**
 * One start stamp read as a value with a known total order, or nothing.
 *
 * Windows emits `CreationDate.Ticks`, an eighteen-digit count of hundred-nanosecond units, read
 * as a `bigint` because a double cannot hold it exactly. POSIX emits `ps -o lstart=`, a calendar
 * stamp such as `Sun Sep  7 02:25:10 2026` with one-second resolution, which is why the
 * comparison is strict: a child started within its parent's second reads equal. The `kind`
 * travels with the value so a tick count is never compared with a millisecond instant.
 */
function orderedStartStamp(
  stamp: string,
): { readonly kind: "ticks" | "instant"; readonly value: bigint } | undefined {
  const trimmed = stamp.trim();
  if (/^\d+$/.test(trimmed)) {
    return { kind: "ticks", value: BigInt(trimmed) };
  }
  const instant = Date.parse(trimmed);
  return Number.isNaN(instant) ? undefined : { kind: "instant", value: BigInt(instant) };
}

/**
 * Whether `candidate` was demonstrably started before `baseline`.
 *
 * A child cannot predate its parent, so a row the process table hangs off the root pid with an
 * earlier stamp than the root's is a survivor of whoever held that number before, not a
 * descendant. Every doubt answers `false`: a missing stamp, two stamps in orders that cannot be
 * compared, or a stamp in no recognized order all admit the claimant, because dropping real
 * descendants from the only kill list a rootless tree has is the worse failure.
 *
 * It compares across the two readers safely because both sides are parsed into values first;
 * `readers.ts` keeps them apart for equality since the commands spell one instant differently
 * (a padded single-digit day in one and not the other).
 */
export function startStampPrecedes(
  candidate: string | undefined,
  baseline: string | undefined,
): boolean {
  if (candidate === undefined || baseline === undefined) {
    return false;
  }
  const candidateOrder = orderedStartStamp(candidate);
  const baselineOrder = orderedStartStamp(baseline);
  if (
    candidateOrder === undefined ||
    baselineOrder === undefined ||
    candidateOrder.kind !== baselineOrder.kind
  ) {
    return false;
  }
  return candidateOrder.value < baselineOrder.value;
}
