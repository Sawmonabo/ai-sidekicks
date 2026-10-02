// A pid is a name the OS reuses, so this module keeps the state that tells a tree's process from a
// stranger that now holds its number.
//
// The launcher shim exits early and is reaped, so a recorded pid can name another process by the
// time it is signaled. A per-instance start stamp, captured while the process is certainly the one
// meant and compared before anything is signaled, closes that window (`start-stamps.ts` owns what
// a comparison may prove). The root carries a stamp because `terminateExternalTree` walks down from
// its pid; each captured descendant carries one because the captured set is the only handle left
// once the root is gone or reissued.
//
// A capture is only taken while the root is alive. A set read after the root exited is unsound on
// Windows and no filter repairs it: a new holder of the number that starts a child inside the
// listing's window yields a row indistinguishable from a descendant, with a later stamp than the
// original root's, so the ancestry proof admits it and `taskkill /t` would kill an unrelated tree.
//
// - `captureLiveDescendants` records; every caller holds evidence the root is still running.
// - `narrowCapturedDescendants` only removes: the root's `exit` intersects the capture with a fresh
//   listing on pid and stamp, so a reissued member is dropped and nothing new can enter.
//
// The listing is only read where a capture is spent. POSIX addresses the process group, so
// `TERMINATION_CONSUMES_CAPTURED_DESCENDANTS` in `budget.ts` gates both this and the budget
// reservation, keeping cost and reservation together.

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
 * Whether the pid a tree is addressed through still names that tree's root.
 *
 * `gone`: the root exited and its number names nothing. `recycled`: the number names an
 * unrelated process, so nothing reached through it is this tree's.
 * `platform-termination.ts` treats the two differently.
 */
export type TreeRootIdentity = "same" | "gone" | "recycled";

/**
 * The listing a descendant capture takes, or nothing on a platform that spends none.
 *
 * Every capture path treats `undefined` as "keep what you had", so a platform whose arm never
 * consumes a capture behaves correctly and pays for no host query.
 */
const DESCENDANT_LISTING_READER: ProcessTableReader = TERMINATION_CONSUMES_CAPTURED_DESCENDANTS
  ? readProcessTable
  : () => undefined;

/**
 * A spawned tree's root, captured while it is certainly still that root.
 *
 * Every later signal re-reads the root's stamp first, because the shim can exit and be reaped
 * before a disposal runs, leaving a pid that names a stranger. The descendant capture cannot
 * happen at spawn, since Electron has no children yet, so it is refreshed on every verified
 * reading and by an owner that knows its child is up. Each member is captured with the stamp
 * the same listing reported, so the set stays addressable after the root is gone. The readers
 * are parameters so `unverified` can build one that reads nothing.
 */
export class SpawnedTreeIdentity {
  readonly #processId: number;
  readonly #readStamp: ProcessStartStampReader;
  readonly #readProcessTable: ProcessTableReader;
  readonly #capturedStamp: string | undefined;
  #capturedDescendants: readonly CapturedTreeMember[] = [];

  constructor(
    processId: number,
    readStamp: ProcessStartStampReader = readProcessStartStamp,
    readTable: ProcessTableReader = DESCENDANT_LISTING_READER,
  ) {
    this.#processId = processId;
    this.#readStamp = readStamp;
    this.#readProcessTable = readTable;
    this.#capturedStamp = readStamp(processId);
  }

  /**
   * A tree whose root was never captured, for a caller that holds no spawn moment.
   *
   * With nothing to compare against, a reissued pid is undetectable and the reading is `same`
   * while the pid names anything. It captures no descendants either: its table reader answers
   * the unreadable sentinel, since an empty table would claim the host lists nothing. Once such
   * a root is gone nothing may be addressed, because a parent table's rows under a dead pid
   * cannot be told from a stranger's; the arm reports what the table says still claims the
   * number and kills none of it. Callers are `terminateProcessTree`'s default (handed a pid by
   * Playwright) and `spawned-tree-record.ts`, when the root capture never ran.
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
   * What the root pid names right now, refreshing the capture when it is ours.
   *
   * Existence decides `gone`, not the stamp: an unreadable stamp on a live process would
   * otherwise skip the one walk that reaches the tree. An unverifiable pair, with no capture or
   * no current reading, answers `same` (see `start-stamps.ts`). The refresh on the verified arm
   * counts as live because the root's stamp was just read off a running process.
   */
  readIdentity(remainingBudgetMilliseconds?: number): TreeRootIdentity {
    if (this.#processId <= 0 || !processExists(this.#processId)) {
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
   * Record the tree below this root, with each member's stamp, as it is now.
   *
   * Public because the owner knows when its child is still up. `readIdentity` only refreshes
   * when something asks, and when the shim exits while a descendant holds the inherited stdout,
   * the first question comes from the disposal, after the root is already `gone`. The moment
   * is sound because Node holds the child's handle until `exit`, Windows will not reissue a
   * pid while a handle is open, and this blocking `spawnSync` keeps the event loop from
   * delivering `exit` mid-query.
   *
   * A capture replaces the previous one, so a late child becomes reachable; a member that has
   * since exited is filtered by the caller's liveness pass. Only a readable listing replaces
   * it: on the unreadable sentinel the last verified set is kept, since erasing it would leave
   * the arm nothing to address while the browser is alive. A listing that ran and named no
   * descendant does shrink the set. Rows the listing hangs off this pid that predate the root
   * are pruned before the walk (see `start-stamps.ts`).
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
   * This is the only reading allowed after the root's `exit`, when its number may be reissued
   * and a fresh listing can carry rows this tree never fathered. An intersection asks nothing
   * of a row the capture does not already name: a member whose pid now has a different stamp is
   * dropped, and one the listing lacks is kept, as for a descendant that already exited. An
   * empty capture takes no listing at all, which keeps the ordinary POSIX teardown free of a
   * blocking read.
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
   * Pruned from the table rather than filtered from the walk's result: a claimant's own
   * children postdate the root, so a post-filter would keep them while dropping the row that
   * explains them. The whole table is returned when this root has no stamp, since nothing is
   * convicted on an absence.
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
