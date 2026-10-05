// One durable write in flight and one pending snapshot behind it, so a resize drag that commits
// a layout per pointer move costs only as many writes as the database absorbs, with no timer.
// The partition rides each request, so an arrangement queued in one session is never filed
// under the session navigated to meanwhile. Retirement flushes the pending snapshot, then drops
// later requests.

import { type SubjectScopedDisposal } from "#renderer/lib/subject-scoped/subject-scoped-disposal.js";

/**
 * The shape the persistence chokepoint's `layout` value class admits: an object of objects
 * whose members are numbers, booleans, and identifier-shaped strings. Written here because it
 * is the class's constraint, not the pane layout grammar's preference.
 */
export type PersistedLayoutRecord = Record<string, Record<string, number | boolean | string>>;

/** What a coalescing writer performs its writes and reports its failures through. */
export interface CoalescingLayoutWriterOptions<TRecord extends PersistedLayoutRecord> {
  /**
   * Performs one durable write, under the partition the request named. A refusal
   * is the caller's to render.
   */
  readonly write: (partition: string, snapshot: TRecord) => Promise<void>;
  /**
   * A write that rejected outright, as opposed to one the store refused, with the
   * partition it was written under.
   */
  readonly onFailed: (error: unknown, partition: string) => void;
}

/** Writes at most one record at a time, coalescing later requests into one pending snapshot. */
export class CoalescingLayoutWriter<TRecord extends PersistedLayoutRecord> {
  readonly #write: (partition: string, snapshot: TRecord) => Promise<void>;
  readonly #onFailed: (error: unknown, partition: string) => void;
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
   * True once `flushAndClose` has run. Terminal: no request is taken again. Published for the
   * holder, because React's double-mount re-runs the effect against a value it just closed,
   * and a retired writer drops every save silently.
   */
  public get isRetired(): boolean {
    return this.#isRetired;
  }

  /** True when nothing is in flight and nothing is waiting to go. */
  public get isIdle(): boolean {
    return !this.#inFlight && this.#pending === undefined;
  }

  /**
   * Save this arrangement, under the session it belongs to. The newest request replaces an
   * unsent one, since writing an arrangement the person moved past would put a stale record on
   * disk. The partition travels with the snapshot because the caller's idea of the current
   * session may move on before the write settles.
   */
  public request(partition: string, snapshot: TRecord): void {
    if (this.#isRetired) {
      // Dropped: this writer's store was replaced and the pane layout holds the live one's.
      return;
    }
    this.#pending = { partition, snapshot };
    this.#pump();
  }

  /**
   * Send what is waiting, then stop accepting requests. Terminal and total. It flushes because
   * the pending request holds the newest arrangement. With a write in flight the pump's own
   * `finally` sends the pending one, so no `await` is needed.
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
        this.#onFailed(error, partition);
      })
      .finally(() => {
        this.#inFlight = false;
        this.#pump();
      });
  }
}

/** One arrangement, and the session it belongs to. The two travel together. */
interface PendingLayoutWrite<TRecord extends PersistedLayoutRecord> {
  readonly partition: string;
  readonly snapshot: TRecord;
}

function flushAndCloseWriter(writer: CoalescingLayoutWriter<PersistedLayoutRecord>): void {
  writer.flushAndClose();
}

function isWriterRetired(writer: CoalescingLayoutWriter<PersistedLayoutRecord>): boolean {
  return writer.isRetired;
}

/**
 * How a retired writer ends and is recognized. `flushAndClose` is one-way and a writer past it
 * drops requests silently, so the holder reads `isClosed` before committing and mints a fresh
 * writer; the arm's shape makes omitting that impossible. One module-level object, because
 * the hook holds `dispose` and `isClosed` on a dependency and a literal per render would
 * restart that lifetime effect.
 */
export const WRITER_RETIREMENT: SubjectScopedDisposal<
  CoalescingLayoutWriter<PersistedLayoutRecord>
> = {
  dispose: flushAndCloseWriter,
  isClosed: isWriterRetired,
};
