// Keeping the deck's arrangement on disk, without arming a timer to do it.
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
// AND THERE IS NOTHING TO DISPOSE, WHICH IS THE POINT. This class arms no timer,
// holds no subscription, and reaches no DOM node, so it owns no resource a pane's
// unmount has to reclaim. A `dispose()` here would either be a no-op that reads as
// a lifecycle, or a cancel that throws away the last arrangement the person made
// before they closed the pane — which is exactly the one they expect to find when
// they open it again. The surface stops calling `request`; that is the whole
// teardown.

import type { DeckSnapshotRecord } from "./deck-snapshot.js";

export interface DeckLayoutWriterOptions {
  /**
   * Performs one durable write, under the partition the request named. A refusal
   * is the caller's to render.
   */
  readonly write: (partition: string, snapshot: DeckSnapshotRecord) => Promise<void>;
  /** A write that rejected outright, as opposed to one the store refused. */
  readonly onFailed: (error: unknown) => void;
}

/** One arrangement, and the session it belongs to. The two travel together. */
interface PendingDeckLayoutWrite {
  readonly partition: string;
  readonly snapshot: DeckSnapshotRecord;
}

export class DeckLayoutWriter {
  readonly #write: (partition: string, snapshot: DeckSnapshotRecord) => Promise<void>;
  readonly #onFailed: (error: unknown) => void;
  #pending: PendingDeckLayoutWrite | undefined;
  #inFlight = false;
  #writeCount = 0;

  public constructor(options: DeckLayoutWriterOptions) {
    this.#write = options.write;
    this.#onFailed = options.onFailed;
  }

  /** Writes performed, so a test can count them rather than infer a coalesce. */
  public get writeCount(): number {
    return this.#writeCount;
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
  public request(partition: string, snapshot: DeckSnapshotRecord): void {
    this.#pending = { partition, snapshot };
    this.#pump();
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
