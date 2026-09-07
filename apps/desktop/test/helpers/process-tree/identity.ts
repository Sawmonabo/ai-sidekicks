// A pid is a NAME, and this is the module that refuses to treat it as a process.
//
// The operating system takes a pid back and hands it out again, so every reading
// in `liveness.ts` can be taken of a number that no longer belongs to the tree it
// was recorded for — the launcher shim exits early and is reaped, which makes
// that window ordinary here rather than exotic. What closes it is a per-instance
// start stamp: captured while the process is certainly the one meant, re-read
// before anything is signalled, and compared.
//
// TWO THINGS CARRY AN IDENTITY, AND FOR DIFFERENT REASONS
//
//   • THE ROOT, because it is the number a tree is addressed THROUGH.
//     `terminateExternalTree` walks a tree DOWN from its root pid, and a walk
//     from a reissued number terminates a stranger, exits zero, and latches
//     `ManagedElectronChild` as killed while this package's browser keeps
//     running.
//   • EACH DESCENDANT, because they are the only handle that survives the root.
//     Once the root pid is gone or reissued, the captured set is what a rootless
//     tree is addressed by — and a captured pid is a number like any other, so a
//     capture without a stamp hands the arm a stranger to kill one indirection
//     along. That is the same defect as signalling the root, and it is why
//     `CapturedTreeMember` is a pair rather than a pid.
//
// WHAT AN UNREADABLE STAMP MEANS, ONCE, FOR BOTH
//
// Nothing. A pair that cannot be compared — no capture, or no current reading —
// is admitted rather than refused, at the root and at every descendant alike.
// That is a deliberate degradation: refusing every kill on a host whose stamp
// probe does not work would leak every tree on that host, which is a larger
// failure than the one this module closes, and detection there is impossible by
// construction rather than by choice. A pid is convicted only by a stamp that
// DISAGREES, never by a stamp that is missing.
//
// AND A THIRD THING A STAMP SAYS: WHETHER A CLAIMANT COULD BE A CHILD AT ALL
//
// Windows does not reparent, so a process whose parent has exited keeps naming
// that parent's number for as long as it lives — including when the number was
// handed to this tree's root long afterwards. The parent-table walk cannot tell
// such a claimant from a real descendant: both rows record the same pid, and the
// equality check above passes both, because the claimant's stamp has not changed
// since it was captured. It was never this tree's to capture.
//
// The proof that separates them is an ORDER rather than an equality, and it is
// the one fact about parenthood no operating system violates: a child cannot
// have started before its parent. The root's own start stamp is taken at the
// spawn, and a claimant whose stamp is DEMONSTRABLY earlier than that is not a
// descendant of this root and is pruned from the table before the walk — with
// its own subtree, since a child of a stranger is a stranger. `startStampPrecedes`
// is where "demonstrably" is spent, and it keeps the failure direction the rest
// of this module has: a pair it cannot order convicts nobody.

import { processExists } from "./liveness.js";
import {
  descendantsOf,
  readProcessStartStamp,
  readProcessTable,
  type ProcessStartStampReader,
  type ProcessTableReader,
  type ProcessTableRow,
} from "./readers.js";

/**
 * Whether the pid a tree is addressed THROUGH still names that tree's root.
 *
 * Three answers rather than two, because "not ours" splits into two facts that
 * owe different behaviour — `arms.ts` has the mechanism. `gone` means the root
 * exited and its number names nothing; `recycled` means the number names an
 * unrelated process, so neither it nor anything reached through it is this
 * tree's.
 */
export type TreeRootIdentity = "same" | "gone" | "recycled";

/**
 * One descendant, captured while the tree was verifiably this one's.
 *
 * The pid is what a kill is addressed to and the stamp is what says the address
 * is still the right one. `startStamp` is `undefined` when the listing carried
 * none, which admits the member rather than refusing it — the module header
 * states that failure direction once for the root and for these.
 */
export interface CapturedTreeMember {
  /** The pid this member held when it was captured. */
  readonly processId: number;
  /** Its per-instance start stamp then, or `undefined` if none was read. */
  readonly startStamp: string | undefined;
}

/**
 * The captured members whose pid still names the process it was captured from.
 *
 * REFUSAL IS ON DISAGREEMENT AND NEVER ON ABSENCE, which is the whole rule and
 * the reason this is one named function rather than a filter at each arm:
 *
 *   • Both stamps read and they DIFFER — the pid was reissued between the
 *     capture and now, so it names a stranger and is dropped. Killing it is the
 *     defect this exists to prevent.
 *   • Either stamp is missing — no comparison was possible, so the member is
 *     kept. A row absent from the table is the ordinary shape for a descendant
 *     that has already exited, and such a member is filtered by the caller's own
 *     liveness reading before anything is signalled; a listing that could not be
 *     read at all never reaches here as a table, because `readers.ts` answers
 *     that with its own sentinel — so "the host would not answer" can never be
 *     mistaken here for "everything has exited".
 *   • Both stamps read and they AGREE — the member is still itself.
 */
export function verifyCapturedMembers(
  captured: readonly CapturedTreeMember[],
  processTable: ReadonlyMap<number, ProcessTableRow>,
): number[] {
  return captured
    .filter((member) => {
      const currentStamp = processTable.get(member.processId)?.startStamp;
      return (
        member.startStamp === undefined ||
        currentStamp === undefined ||
        currentStamp === member.startStamp
      );
    })
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

/**
 * A spawned tree's root, captured while it is certainly still that root.
 *
 * THE HANDLE A PID IS NOT. `terminateExternalTree` walks a tree DOWN from its
 * root pid, and by the time a disposal runs that pid may name an unrelated
 * process — the shim exits early and is reaped, which is the ordinary shape here
 * and not a corner of one. Signalling it terminates a stranger, the platform
 * exits zero, and `ManagedElectronChild` latches on the zero while the browser
 * this package spawned keeps running. So the tree carries an identity from the
 * moment it is spawned, and every later signal re-reads it first.
 *
 * The descendant capture is the second half and cannot be taken at spawn: an
 * Electron has no children in the instant it starts. It is refreshed on every
 * VERIFIED reading instead, so the last set taken while the root was demonstrably
 * this tree's is the set still nameable once the pid stops being. Refreshed only
 * on the verified arm, because a capture taken under an unverifiable identity is
 * a capture nothing can ever consume — the reissued-root reading it exists for is
 * exactly the reading that arm cannot reach. Each member is captured WITH the
 * stamp the same listing reported for it, so the set stays addressable after the
 * root is gone without becoming a list of numbers nothing has verified.
 *
 * Every collaborator is injected for this package's usual reason and one
 * stronger: a pid whose holder changes between two reads is not a state a test
 * can arrange against a live process, and it is the only state this class is
 * about.
 */
export class SpawnedTreeIdentity {
  readonly #processId: number;
  readonly #readStamp: ProcessStartStampReader;
  readonly #readProcessTable: ProcessTableReader;
  readonly #rootExists: (processId: number) => boolean;
  readonly #capturedStamp: string | undefined;
  #capturedDescendants: readonly CapturedTreeMember[] = [];

  constructor(
    processId: number,
    readStamp: ProcessStartStampReader = readProcessStartStamp,
    readTable: ProcessTableReader = readProcessTable,
    rootExists: (processId: number) => boolean = processExists,
  ) {
    this.#processId = processId;
    this.#readStamp = readStamp;
    this.#readProcessTable = readTable;
    this.#rootExists = rootExists;
    this.#capturedStamp = readStamp(processId);
  }

  /**
   * A tree whose root was never captured, for a caller that holds no spawn moment.
   *
   * Named rather than defaulted silently, because what it gives up is exactly
   * what this class exists for: with nothing to compare against, a reissued pid
   * is undetectable and the reading degrades to the one this module took before
   * identity existed — `same` while the pid names anything. The one caller is
   * `terminateProcessTree`'s default, reached from `BoundedCleanup`, which is
   * handed a pid by Playwright rather than by a spawn of its own and so has no
   * moment at which the capture would mean anything.
   *
   * It captures no descendants either — its table reader answers the unreadable
   * sentinel by construction, so `captureLiveDescendants` is a no-op on it
   * however often it is called, and a reader that answered an EMPTY table would
   * instead claim this host lists nothing, which is a reading it never took —
   * and the consequence is named rather than
   * hidden: once such a root is GONE there is nothing this package may address,
   * because the only remaining evidence is a parent table whose rows under a dead
   * pid cannot be told from a stranger's. That arm therefore reports whatever the
   * table says still claims the number, and kills none of it.
   */
  static unverified(processId: number): SpawnedTreeIdentity {
    return new SpawnedTreeIdentity(
      processId,
      () => undefined,
      () => undefined,
    );
  }

  /** The members captured while the root last read `same`, each with its stamp. */
  get capturedDescendants(): readonly CapturedTreeMember[] {
    return this.#capturedDescendants;
  }

  /**
   * What the root pid names right now, and a refreshed capture when it is ours.
   *
   * Existence decides `gone` rather than the stamp, and the order is the claim:
   * a stamp that could not be read on a LIVE process is an unreadable probe, and
   * reading that as `gone` would skip the one walk that reaches the tree. So the
   * pid is asked whether it names anything first, and the stamp is asked only to
   * separate ours from somebody else's.
   *
   * An unverifiable pair — no capture, or no current reading — answers `same`,
   * for the reason the module header gives once for every stamp comparison here.
   */
  readIdentity(remainingBudgetMilliseconds?: number): TreeRootIdentity {
    if (this.#processId <= 0 || !this.#rootExists(this.#processId)) {
      return "gone";
    }
    const currentStamp = this.#readStamp(this.#processId, remainingBudgetMilliseconds);
    if (this.#capturedStamp === undefined || currentStamp === undefined) {
      return "same";
    }
    if (currentStamp !== this.#capturedStamp) {
      return "recycled";
    }
    this.captureLiveDescendants(remainingBudgetMilliseconds);
    return "same";
  }

  /**
   * Record the tree below this root, with each member's stamp, as it is NOW.
   *
   * PUBLIC BECAUSE THE LAST LIVE MOMENT IS THE OWNER'S TO KNOW, AND NOT THIS
   * CLASS'S. `readIdentity` refreshes the capture on its verified arm, which is
   * the whole mechanism whenever something asks — and on the shape this exists
   * for, nothing does: the launcher shim exits while a descendant holds the
   * inherited stdout, and the first question anybody asks of this object is the
   * disposal's, by which time the root is already `gone` and the walk that would
   * have named the descendant is exactly the walk `gone` refuses. Between the
   * spawn and that disposal there is one event that says the root is ending —
   * the child's own `exit` — and only `ManagedElectronChild` receives it. So the
   * capture is a method it can call rather than a private step of a reading it
   * would have to invent a reason to take.
   *
   * Taken at `exit` the set is sound for the same reason it is sound on the
   * verified arm, and no more: the rows are the ones this host hangs off a pid
   * that was this tree's until the instant the event fired. Each member is kept
   * WITH the stamp that same listing reported, so a member whose pid is reissued
   * between here and the kill is refused by `verifyCapturedMembers` rather than
   * signalled.
   *
   * A capture REPLACES the previous one rather than accumulating, which is what
   * makes a late child reachable: the set is what the tree looked like at the
   * last live reading, and a member that has since exited is filtered by the
   * caller's own liveness pass before anything is signalled.
   *
   * ONLY A READABLE LISTING MAY REPLACE IT. `readProcessTable` answers an
   * unreadable host with its own SENTINEL — a query that would not start, spent
   * its bound, or exited non-zero — rather than with an empty map, so the two
   * are told apart here by what arrived and not by counting rows. Replacing the
   * capture on the sentinel would exchange a verified set for nothing at exactly
   * the moment it becomes the only handle this tree has: the root has just
   * exited, the browser under it is alive, and the arm would be handed no member
   * to address and would refuse every attempt. So an unreadable refresh KEEPS
   * the last verified set — stale by then, and stale-and-addressable beats
   * verified-and-erased — and a member of it that has since exited is filtered
   * by the caller's own liveness pass, exactly as a member of a fresh capture
   * is. A listing that RAN and named no descendant is the opposite reading and
   * does shrink the set, which is the whole reason the two answers are distinct
   * values.
   *
   * AND WHAT IS CAPTURED IS THE TREE THIS ROOT COULD HAVE FATHERED. Rows the
   * listing hangs off this pid that PREDATE the root are pruned before the walk,
   * so neither they nor anything beneath them enters the set — the header has why
   * a table cannot tell such a claimant from a descendant, and `startStampPrecedes`
   * has what "predate" is allowed to mean.
   */
  captureLiveDescendants(remainingBudgetMilliseconds?: number): void {
    const processTable = this.#readProcessTable(remainingBudgetMilliseconds);
    if (processTable === undefined) {
      return;
    }
    const fatherable = this.#rowsThisRootCouldHaveFathered(processTable);
    this.#capturedDescendants = descendantsOf(this.#processId, fatherable).map(
      (descendantProcessId) => ({
        processId: descendantProcessId,
        startStamp: processTable.get(descendantProcessId)?.startStamp,
      }),
    );
  }

  /**
   * `processTable` without the rows that started before this root did.
   *
   * Pruned from the TABLE rather than filtered out of the walk's result, and
   * that is the difference between removing a stranger and removing a stranger's
   * family: a claimant's own children postdate the root perfectly happily, and a
   * post-filter would keep every one of them while dropping the one row that
   * explains where they came from.
   *
   * The whole table is returned unchanged when this root carries no stamp of its
   * own — there is nothing to compare against, and this module never convicts on
   * an absence.
   */
  #rowsThisRootCouldHaveFathered(
    processTable: ReadonlyMap<number, ProcessTableRow>,
  ): ReadonlyMap<number, ProcessTableRow> {
    if (this.#capturedStamp === undefined) {
      return processTable;
    }
    const fatherable = new Map<number, ProcessTableRow>();
    for (const [claimantProcessId, row] of processTable) {
      if (!startStampPrecedes(row.startStamp, this.#capturedStamp)) {
        fatherable.set(claimantProcessId, row);
      }
    }
    return fatherable;
  }
}
