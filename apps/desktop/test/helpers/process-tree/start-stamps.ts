// What a per-instance start stamp PROVES, and what it is never allowed to prove.
//
// Split out of `identity.ts` beside it rather than left inside it because the two
// are different subjects with different failures. That module holds a tree's
// identity as STATE — the root's stamp taken at the spawn, the descendant set
// taken while the root was still that root — and answers "what does this pid name
// now". This one is stateless and answers the two questions that state is compared
// with: whether two readings of one pid AGREE, and whether one reading is
// demonstrably EARLIER than another. Nothing here reads a host or holds a tree.
//
// WHAT AN UNREADABLE STAMP MEANS, ONCE, FOR EVERY COMPARISON HERE
//
// Nothing. A pair that cannot be compared — no capture, or no current reading — is
// admitted rather than refused. That is a deliberate degradation: refusing every
// kill on a host whose stamp probe does not work would leak every tree on that
// host, which is a larger failure than the one this closes, and detection there is
// impossible by construction rather than by choice. A pid is convicted only by a
// stamp that DISAGREES, never by a stamp that is missing.
//
// AND A THIRD THING A STAMP SAYS: WHETHER A CLAIMANT COULD BE A CHILD AT ALL
//
// Windows does not reparent, so a process whose parent has exited keeps naming
// that parent's number for as long as it lives — including when the number was
// handed to this tree's root long afterwards. The parent-table walk cannot tell
// such a claimant from a real descendant: both rows record the same pid, and an
// equality check passes both, because the claimant's stamp has not changed since
// it was captured. It was never this tree's to capture.
//
// The proof that separates them is an ORDER rather than an equality, and it is the
// one fact about parenthood no operating system violates: a child cannot have
// started before its parent. The root's own start stamp is taken at the spawn, and
// a claimant whose stamp is DEMONSTRABLY earlier than that is not a descendant of
// this root. `startStampPrecedes` is where "demonstrably" is spent, and it keeps
// the failure direction above: a pair it cannot order convicts nobody.

import { type ProcessTableRow } from "./readers.js";

/**
 * One descendant, captured while the tree was verifiably this one's.
 *
 * The pid is what a kill is addressed to and the stamp is what says the address
 * is still the right one. `startStamp` is `undefined` when the listing carried
 * none, which admits the member rather than refusing it — the module header
 * states that failure direction once for every comparison here.
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
 * REFUSAL IS ON DISAGREEMENT AND NEVER ON ABSENCE, which is the whole rule and
 * the reason this is one named predicate rather than a comparison at each site:
 *
 *   • Both stamps read and they DIFFER — the pid was reissued between the capture
 *     and now, so it names a stranger. Killing it is the defect this prevents.
 *   • Either stamp is missing — no comparison was possible, so the member stands.
 *   • Both stamps read and they AGREE — the member is still itself.
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
 * The captured members whose pid still names the process it was captured from.
 *
 * A row absent from the table is the ordinary shape for a descendant that has
 * already exited, and such a member is kept: it is filtered by the caller's own
 * liveness reading before anything is signalled. A listing that could not be read
 * at all never reaches here as a table, because `readers.ts` answers that with its
 * own sentinel — so "the host would not answer" can never be mistaken here for
 * "everything has exited".
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
 * TWO ORDERS AND NEVER A THIRD, because a stamp this cannot place is a stamp it
 * must refuse to reason about rather than one to guess at. Windows emits
 * `CreationDate.Ticks`, an integer counted in hundred-nanosecond units — read as
 * a `bigint` rather than a `number` because it is eighteen digits and a double
 * cannot hold them exactly, so adjacent ticks would compare equal. POSIX emits
 * `ps -o lstart=`, a `Sun Sep  7 02:25:10 2026` calendar stamp read as an
 * instant, whose one-second resolution is the reason the comparison below is
 * STRICT: a child started within its parent's second reads equal, and equal is
 * not evidence of anything.
 *
 * The `kind` travels with the value so two orders can never be mixed. A tick
 * count and a millisecond instant are both integers and comparing one against
 * the other would answer confidently and mean nothing.
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
 * Whether `candidate` was demonstrably started BEFORE `baseline`.
 *
 * THE ANCESTRY PROOF, as the one claim about parenthood that is always true: a
 * child cannot predate its parent. A row the process table hangs off this tree's
 * root pid whose stamp is earlier than the root's own is therefore not this
 * tree's descendant — it is a survivor of whoever held that number before, and
 * on Windows it keeps naming the number for as long as it runs.
 *
 * FALSE IS THE ANSWER TO EVERY DOUBT, which is this module's failure direction
 * and not a shortcut: a missing stamp on either side, two stamps in orders that
 * cannot be compared, and a stamp in no order this recognises all answer `false`
 * and admit the claimant. Refusing a member on an unreadable stamp would drop
 * real descendants out of the only kill list a rootless tree has, which is a
 * worse failure than the one this prevents.
 *
 * IT COMPARES ACROSS THE TWO READERS ON PURPOSE, AND THAT IS SAFE HERE FOR THE
 * REASON EQUALITY IS NOT. `readers.ts` keeps the per-pid stamp and the table's
 * column apart because the two commands SPELL one instant differently — a
 * single-digit day padded in one and not the other — and two spellings compare
 * unequal as text. This does not compare text: both sides are parsed into a
 * value first, and the padding that defeats an equality is gone by then.
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
