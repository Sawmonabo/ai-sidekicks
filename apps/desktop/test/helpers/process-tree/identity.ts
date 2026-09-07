// A pid is a NAME, and this is the module that refuses to treat it as a process.
//
// The operating system takes a pid back and hands it out again, so every reading
// in `liveness.ts` can be taken of a number that no longer belongs to the tree it
// was recorded for — the launcher shim exits early and is reaped, which makes
// that window ordinary here rather than exotic. What closes it is a per-instance
// start stamp: captured while the process is certainly the one meant, re-read
// before anything is signalled, and compared. `start-stamps.ts` owns what such a
// comparison is allowed to prove; this module owns the STATE it is spent on.
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
// AND A CAPTURE IS ONLY EVER TAKEN WHILE THE ROOT IS STILL ALIVE
//
// That is the rule the two public capture methods below divide between them, and
// it is a rule about WHEN rather than about what came back. A descendant set read
// AFTER the root has exited is unsound on Windows and cannot be made sound by any
// filter over its rows: the root has been reaped by then, its number is the
// operating system's to hand out again, and a new holder that starts a child
// inside the window the listing itself takes produces a row that is
// indistinguishable from a descendant — same parent pid, and a start stamp AFTER
// the original root's, so the ancestry proof admits it. Handed to `taskkill /t`
// that row is an unrelated process tree this package never spawned.
//
//   • `captureLiveDescendants` RECORDS, and every caller of it holds evidence
//     that the root is still running at the moment it asks: `readIdentity`'s own
//     verified arm, or an owner that has not yet been told its child exited.
//   • `narrowCapturedDescendants` may only REMOVE. It is what the root's `exit`
//     runs, and it is an intersection on pid and start stamp against a fresh
//     listing — so a member whose number has since been reissued is dropped,
//     and a row nothing captured can never enter the set however this host
//     hangs it off the reaped number.
//
// AND THE LISTING IS ONLY READ WHERE A CAPTURE IS SPENT. The POSIX arm addresses
// the process GROUP and consumes no capture at all, so on that platform every
// reading here would be a blocking host query taken for a set nothing reads.
// `TERMINATION_CONSUMES_CAPTURED_DESCENDANTS` in `budget.ts` is the one predicate
// that decides it, and the same constant is what reserves these readings' ceiling
// inside each spawner's enclosing budget — so the cost and the reservation cannot
// drift apart.

import { TERMINATION_CONSUMES_CAPTURED_DESCENDANTS } from "./budget.js";
import { processExists } from "./liveness.js";
import {
  descendantsOf,
  readProcessStartStamp,
  readProcessTable,
  type ProcessStartStampReader,
  type ProcessTableReader,
  type ProcessTableRow,
} from "./readers.js";
import {
  stampStillNamesMember,
  startStampPrecedes,
  type CapturedTreeMember,
} from "./start-stamps.js";

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
 * The listing a descendant capture takes, or nothing on a platform that spends none.
 *
 * The sentinel is already this directory's answer for "the host would not
 * answer", and every capture path here treats it as "keep what you had" rather
 * than "the tree is empty" — so a platform whose arm never consumes a capture
 * gets the correct behaviour by construction and pays for no host query to get
 * it. The predicate is `budget.ts`'s, which is also where the reservation for
 * these readings is derived, so a platform cannot pay a cost the enclosing
 * budgets have not reserved.
 */
const DESCENDANT_LISTING_READER: ProcessTableReader = TERMINATION_CONSUMES_CAPTURED_DESCENDANTS
  ? readProcessTable
  : () => undefined;

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
 * VERIFIED reading instead, and by an owner that knows its child is up, so the
 * last set taken while the root was demonstrably this tree's is the set still
 * nameable once the pid stops being. Refreshed only where the root is known to
 * be alive, because a capture taken after the root is gone is a capture of
 * whatever now holds its number — the module header has why no filter can repair
 * that. Each member is captured WITH the stamp the same listing reported for it,
 * so the set stays addressable after the root is gone without becoming a list of
 * numbers nothing has verified.
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
    readTable: ProcessTableReader = DESCENDANT_LISTING_READER,
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
   * sentinel by construction, so both capture methods are no-ops on it however
   * often they are called, and a reader that answered an EMPTY table would
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

  /** The members captured while the root was still alive, each with its stamp. */
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
   * for the reason `start-stamps.ts` gives once for every stamp comparison here.
   *
   * The refresh on the verified arm is a LIVE capture in the sense the module
   * header requires: this arm has just read the root's own stamp off a running
   * process and found it unchanged, which is evidence about that instant and not
   * about the spawn.
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
   * PUBLIC BECAUSE THE LIVE MOMENT IS THE OWNER'S TO KNOW, AND NOT THIS CLASS'S.
   * `readIdentity` refreshes the capture on its verified arm, which is the whole
   * mechanism whenever something asks — and on the shape this exists for, nothing
   * asks until it is too late: the launcher shim exits while a descendant holds
   * the inherited stdout, and the first question anybody asks of this object is
   * the disposal's, by which time the root is already `gone` and the walk that
   * would have named the descendant is exactly the walk `gone` refuses. So the
   * capture is a method the owner calls at a moment IT can vouch for — while its
   * child has not yet reported an exit — rather than a private step of a reading
   * it would have to invent a reason to take.
   *
   * WHAT MAKES THAT MOMENT SOUND IS NOT OPTIMISM. Node holds the spawned
   * process's own handle open until it reports `exit`, Windows will not reissue a
   * pid while any handle to that process is open, and this reading is a blocking
   * `spawnSync` — so the event loop cannot deliver that `exit` while the listing
   * runs. An owner that has not seen `exit` is therefore holding the number for
   * the whole duration of the query, which is the property the root's own `exit`
   * has already lost and `narrowCapturedDescendants` exists to respect.
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
   * the moment it becomes the only handle this tree has: the browser under the
   * root is alive and the arm would be handed no member to address, so it would
   * refuse every attempt. So an unreadable refresh KEEPS the last verified set —
   * stale by then, and stale-and-addressable beats verified-and-erased — and a
   * member of it that has since exited is filtered by the caller's own liveness
   * pass, exactly as a member of a fresh capture is. A listing that RAN and named
   * no descendant is the opposite reading and does shrink the set, which is the
   * whole reason the two answers are distinct values.
   *
   * AND WHAT IS CAPTURED IS THE TREE THIS ROOT COULD HAVE FATHERED. Rows the
   * listing hangs off this pid that PREDATE the root are pruned before the walk,
   * so neither they nor anything beneath them enters the set — `start-stamps.ts`
   * has why a table cannot tell such a claimant from a descendant, and what
   * "predate" is allowed to mean.
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
   * Drop the captured members this host no longer says are themselves. Never adds.
   *
   * THE READING TAKEN AFTER THE ROOT HAS GONE, AND THE ONLY ONE IT MAY MAKE. By
   * the root's `exit` the process has been reaped and its number is available
   * again, so a listing taken from here can carry rows this tree never fathered
   * and cannot be told from ones it did — the module header has why the ancestry
   * proof does not separate them and why no other filter can. An intersection
   * can still be taken safely, because it asks nothing of a row the capture does
   * not already name: a member whose pid now carries a DIFFERENT start stamp was
   * reissued and is dropped, and a member the listing does not carry at all is
   * kept, which is this directory's failure direction and is the ordinary shape
   * for a descendant that has already exited.
   *
   * AN EMPTY CAPTURE COSTS NO HOST QUERY. There is nothing an intersection over
   * no members can remove, so the listing is not taken at all — which is what
   * keeps the ordinary POSIX teardown, where nothing is ever captured, free of a
   * blocking read it would spend and never consult.
   */
  narrowCapturedDescendants(remainingBudgetMilliseconds?: number): void {
    if (this.#capturedDescendants.length === 0) {
      return;
    }
    const processTable = this.#readProcessTable(remainingBudgetMilliseconds);
    if (processTable === undefined) {
      return;
    }
    this.#capturedDescendants = this.#capturedDescendants.filter((member) =>
      stampStillNamesMember(member, processTable.get(member.processId)?.startStamp),
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
   * own — there is nothing to compare against, and this package never convicts on
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
