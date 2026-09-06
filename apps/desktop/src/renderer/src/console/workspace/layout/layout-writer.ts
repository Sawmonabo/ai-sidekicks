// One durable write in flight, and one pending snapshot behind it.
//
// The problem is the resize drag: a separator commits a new layout on every
// pointer move, so a naive "save on change" writes sixty records a second to a
// database that only needs to hold the last one.
//
// WHY THIS IS NOT A DEBOUNCE, AND NOT `store/scheduling.ts`. The obvious answer is
// a trailing debounce, and the console already owns one — `RefreshScheduler`. It is
// the wrong tool twice over: its own header says the session-store registry is what
// constructs it and nothing else in the tree may arm a timer, and its
// `RefreshReason` vocabulary is a diagnostics field whose doc forbids inventing a
// value for a read nobody asked for. A deck rearrangement is not a refresh, and
// there is no honest reason to hand it. Writing a second debouncer beside that one
// would be a second implementation of the thing it exists to be.
//
// So the coalescing comes from the write itself: at most ONE write is in flight,
// and while one is, further changes replace a single pending snapshot rather than
// queueing. A drag costs as many writes as the database can absorb — each of them
// the newest arrangement, never a stale one — with no timer to arm, cancel, or
// leak, and nothing for a test to advance.
//
// AND THE PARTITION RIDES THE REQUEST, NOT THE CALLER'S CURRENT STATE. A request
// names the session its snapshot belongs to, and the single pending slot carries
// both, so the pump writes what the request named however long it waited. The
// alternative — reading the caller's current session inside the write callback —
// files a queued arrangement under whichever session the person navigated to while
// it waited, which overwrites that session's saved deck with another one's.
//
// TWO RECORDS, ONE WRITER. The deck's arrangement was the first record kept this
// way; the session sidebar's width, collapse, and open section is the second. Both
// are the persistence chokepoint's `layout` value class, both are written on a
// gesture, and both need exactly the coalescing below — so the writer is generic
// over the record it carries and lives at the family's own level rather than inside
// either subtree. A second writer beside it would be the one thing this file exists
// to be.
//
// AND THE WRITER IS ADDRESSED BY THE STORE IT WRITES THROUGH. The record goes into a
// `UiStateStore`, and that store is replaced under a live surface: a reconnect
// re-mints it and the composition root hands the new one down without remounting
// anything beneath. A writer built in a `useState` initializer closes over the store
// of its FIRST render and keeps writing there, so every later arrangement is filed in
// a store nothing will ever read again — and the restore, which does move, then reads
// the newer store's older record. Both writers are therefore held per store through
// `store/subject-scoped-resource.ts`, which retires the one bound to the store that
// was replaced.
//
// RETIREMENT DRAINS; IT DOES NOT CANCEL. `flushAndClose` sends the pending snapshot
// before it stops accepting requests, because the last arrangement a person made is
// exactly the one they expect to find, and a terminal that threw it away would be
// worse than the no-terminal this class shipped with. A request arriving after
// retirement is dropped rather than filed: the surface on screen holds the writer
// bound to the live store, and that is where its arrangement belongs.

import { type SubjectScopedDisposal } from "../../store/index.js";

/**
 * The shape the persistence chokepoint's `layout` value class admits: an object of
 * objects whose members are numbers, booleans, and identifier-shaped strings.
 *
 * Written here rather than imported from either record's own grammar, because it is
 * the CLASS's constraint and not either grammar's preference — the deck names its
 * own record `DeckSnapshotRecord` and the sidebar names its own, and both satisfy
 * this because both are stored under that one class.
 */
export type PersistedLayoutRecord = Record<string, Record<string, number | boolean | string>>;

export interface CoalescingLayoutWriterOptions<TRecord extends PersistedLayoutRecord> {
  /**
   * Performs one durable write, under the partition the request named. A refusal
   * is the caller's to render.
   */
  readonly write: (partition: string, snapshot: TRecord) => Promise<void>;
  /** A write that rejected outright, as opposed to one the store refused. */
  readonly onFailed: (error: unknown) => void;
}

/** One arrangement, and the session it belongs to. The two travel together. */
interface PendingLayoutWrite<TRecord extends PersistedLayoutRecord> {
  readonly partition: string;
  readonly snapshot: TRecord;
}

export class CoalescingLayoutWriter<TRecord extends PersistedLayoutRecord> {
  readonly #write: (partition: string, snapshot: TRecord) => Promise<void>;
  readonly #onFailed: (error: unknown) => void;
  #pending: PendingLayoutWrite<TRecord> | undefined;
  #inFlight = false;
  #writeCount = 0;
  #isRetired = false;

  public constructor(options: CoalescingLayoutWriterOptions<TRecord>) {
    this.#write = options.write;
    this.#onFailed = options.onFailed;
  }

  /** Writes performed, so a test can count them rather than infer a coalesce. */
  public get writeCount(): number {
    return this.#writeCount;
  }

  /**
   * True once `flushAndClose` has run. Terminal: no request is ever taken again.
   *
   * Published for the holder that owns this writer's lifetime. React's double-mount
   * runs the committed cleanup and then re-runs the effect against the value it just
   * closed, so a holder with no way to ask would re-commit a retired writer — and
   * every save after that is dropped at `request` with no refusal raised anywhere,
   * which is a person rearranging their deck all session and nothing being kept.
   */
  public get isRetired(): boolean {
    return this.#isRetired;
  }

  /** True when nothing is in flight and nothing is waiting to go. */
  public get isIdle(): boolean {
    return !this.#inFlight && this.#pending === undefined;
  }

  /**
   * Save this arrangement, under the session it belongs to.
   *
   * The newest request REPLACES an unsent one rather than joining a queue: the
   * layout is a single current value, and writing an arrangement the person has
   * already moved past would put a stale record on disk and then correct it. The
   * partition travels with the snapshot for the same reason it exists at all — a
   * queued write settles later than the act that queued it, and by then the caller's
   * own idea of the current session may have moved on.
   */
  public request(partition: string, snapshot: TRecord): void {
    if (this.#isRetired) {
      // Dropped rather than filed: this writer's store has been replaced, and the
      // surface on screen is already holding the writer bound to the live one.
      return;
    }
    this.#pending = { partition, snapshot };
    this.#pump();
  }

  /**
   * Send what is waiting, then stop accepting requests. The terminal, and total.
   *
   * Called when the store this writer was built over is replaced. It DRAINS: the
   * pending slot holds the newest arrangement, and a teardown that dropped it would
   * throw away the one act the person performed last. Where a write is already in
   * flight there is nothing to start — the pump's own `finally` sends the pending one
   * — so this needs no `await` and answers in both states.
   */
  public flushAndClose(): void {
    this.#pump();
    this.#isRetired = true;
  }

  #pump(): void {
    if (this.#inFlight || this.#pending === undefined) {
      return;
    }
    const { partition, snapshot } = this.#pending;
    this.#pending = undefined;
    this.#inFlight = true;
    this.#writeCount += 1;
    void this.#write(partition, snapshot)
      .catch((error: unknown) => {
        this.#onFailed(error);
      })
      .finally(() => {
        this.#inFlight = false;
        this.#pump();
      });
  }
}

function flushAndCloseWriter(writer: CoalescingLayoutWriter<PersistedLayoutRecord>): void {
  writer.flushAndClose();
}

function isWriterRetired(writer: CoalescingLayoutWriter<PersistedLayoutRecord>): boolean {
  return writer.isRetired;
}

/**
 * How a retired writer ends, and how a retired one is recognised. Both records take it.
 *
 * THE TERMINAL ARM, BECAUSE `flushAndClose` IS ONE-WAY. A writer past it drops every
 * later request in silence — no refusal raised, nothing on screen — so a holder that
 * re-committed one after React's double-mount would leave a person rearranging all
 * session with nothing kept. `store/subject-scoped-resource.ts` reads `isClosed`
 * before it commits and mints a fresh writer instead, and the arm's shape is what
 * makes the reading impossible to omit: `{ dispose }` alone matches neither arm.
 *
 * ONE MODULE-LEVEL OBJECT RATHER THAN A LITERAL AT EACH CALL SITE. The hook holds
 * `dispose` and `isClosed` on a dependency of their own, so a fresh literal per render
 * would restart that lifetime effect on every pass for no change in what is open —
 * and the deck and the sidebar retire the same class of writer for the same reason,
 * which is why this lives beside the class rather than twice above it.
 */
export const WRITER_RETIREMENT: SubjectScopedDisposal<
  CoalescingLayoutWriter<PersistedLayoutRecord>
> = {
  dispose: flushAndCloseWriter,
  isClosed: isWriterRetired,
};
