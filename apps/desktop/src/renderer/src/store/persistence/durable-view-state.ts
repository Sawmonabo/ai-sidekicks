// One durable piece of per-install view state, which the pin map is built on: held in memory,
// hydrated once, written through `UiStateStore`, with the last refusal kept so a view renders it.
// A read that failed is a refusal too, never taken for "nothing stored".
// The in-memory value updates first and a refused write is recorded, not rolled back, since a
// rollback would flicker for reasons a person cannot see. A late hydration never overwrites a
// newer local act. Writes are serialized, one at the store at a time, with a later act replacing
// the waiting snapshot, so the store sees the issued snapshots in order, ending on the newest.

import type { Unsubscribe } from "@shared/preload-api.js";
import { Emitter } from "@renderer/lib/emitter.js";
import { type Refusal } from "@renderer/lib/refusal.js";
import type { UiStateStore } from "@renderer/store/persistence/ui-state-store.js";
import { refusePersistence } from "./persistence-refusals.js";
import { GenerationLatch } from "@renderer/lib/reads/generation-latch.js";

/**
 * What one write answered, taken from the chokepoint. Exported so this module's suite can
 * drive the state with a store whose writes are held.
 */
export type PersistenceWriteOutcome = Awaited<ReturnType<UiStateStore["writeGlobal"]>>;

/** What a durable view state is built from: its store, record key, value class and codec. */
export interface DurableViewStateOptions<TValue extends PersistedValue> {
  readonly store: UiStateStore;
  /** The record key inside the global partition. Identifier-shaped, by the rules. */
  readonly key: string;
  readonly valueClass: PersistedValueClassName;
  /** What the state holds before anything has been read or written. */
  readonly initial: TValue;
  /**
   * Narrow one durable record back into the value, or `undefined` to discard it and keep the
   * initial value. A record this app did not produce is not coerced onto the screen.
   */
  readonly narrow: (raw: unknown) => TValue | undefined;
}

/** The chokepoint's closed value-class union, taken from the chokepoint. */
type PersistedValueClassName = Parameters<UiStateStore["writeGlobal"]>[1];

/** What the chokepoint admits as a value, taken from the chokepoint. */
type PersistedValue = Parameters<UiStateStore["writeGlobal"]>[2];

/**
 * The one key every act of one state is on: a local act supersedes every read and write that
 * started before it, whichever it was.
 */
const LOCAL_ACT_KEY = "local-act";

/** One durable value with a hydrated read, a serialized write path and a recorded refusal. */
export class DurableViewState<TValue extends PersistedValue> {
  readonly #store: UiStateStore;
  readonly #key: string;
  readonly #valueClass: PersistedValueClassName;
  readonly #narrow: (raw: unknown) => TValue | undefined;
  readonly #changes = new Emitter<void>("durable view state");
  #value: TValue;
  #hydrated = false;
  #lastRefusal: Refusal | undefined;
  /**
   * The round local acts are on. `commit` claims afresh and both settlement paths only join,
   * so the round stands until the next act or the disposal ends it.
   */
  readonly #localActs = new GenerationLatch();
  /** The write at the store, mapped never to reject, or `undefined` while idle. */
  #writeAtStore: Promise<void> | undefined;
  /** The newest snapshot no write has carried yet. Replaced by a later act, never appended. */
  #queuedSnapshot: QueuedSnapshot<TValue> | undefined;
  /** The one write that snapshot will ride, shared by every caller waiting on it. */
  #queuedWrite: Promise<PersistenceWriteOutcome> | undefined;

  public constructor(options: DurableViewStateOptions<TValue>) {
    this.#store = options.store;
    this.#key = options.key;
    this.#valueClass = options.valueClass;
    this.#narrow = options.narrow;
    this.#value = options.initial;
  }

  /** The current value. A stable reference until it changes, for `useSyncExternalStore`. */
  public get value(): TValue {
    return this.#value;
  }

  /**
   * Release this state: its store has been replaced. Drops the sinks and supersedes the local
   * acts, so a hydration in flight discards its record. A write already in flight completes
   * against the store it was sent to.
   */
  public dispose(): void {
    this.#localActs.supersedeAll();
    this.#changes.clear();
  }

  /** The last refusal this state saw, or `undefined`. Rendered, never swallowed. */
  public get lastRefusal(): Refusal | undefined {
    return this.#lastRefusal;
  }

  /** Be told when the value or the last refusal changes. */
  public subscribe(sink: () => void): Unsubscribe {
    return this.#changes.subscribe(sink);
  }

  /**
   * Read the durable record once. Idempotent, so a remount cannot re-read over a changed
   * value. Never throws: a read that failed keeps the initial value and records a refusal, so
   * the view says what was saved could not be read. A record arriving after a local act is
   * discarded, but the state is still marked hydrated.
   */
  public async hydrate(): Promise<void> {
    if (this.#hydrated) {
      return;
    }
    const actsAtRead = this.#localActs.currentClaim(this, LOCAL_ACT_KEY);
    const read = await this.#store.readGlobalOutcome(this.#key);
    this.#hydrated = true;
    if (!actsAtRead.isCurrent) {
      return;
    }
    if (read.outcome === "failed") {
      this.#lastRefusal = UNREADABLE_RECORD_REFUSAL;
    }
    const narrowed = read.outcome === "present" ? this.#narrow(read.record.value) : undefined;
    if (narrowed !== undefined) {
      this.#value = narrowed;
    }
    this.#changes.emit();
  }

  /**
   * Replace the value and write it. The refusal is recorded and returned.
   *
   * The settlement emits whenever the refusal changes, in either direction, so a write that
   * recovered clears a standing refusal on screen. Identity is the comparison: two refusals
   * for one cause are two objects and re-rendering for the second is right. A coalesced
   * caller gets the answer of the write that carried the newest value.
   */
  public async commit(next: TValue): Promise<PersistenceWriteOutcome> {
    this.#localActs.supersedeAll();
    this.#value = next;
    this.#changes.emit();
    return await this.#persist(next);
  }

  /** Send `next` to the store, or fold it into the snapshot already waiting. */
  #persist(next: TValue): Promise<PersistenceWriteOutcome> {
    const writeAtStore = this.#writeAtStore;
    if (writeAtStore === undefined) {
      return this.#issue(next);
    }
    const waiting = this.#queuedSnapshot;
    const waitingWrite = this.#queuedWrite;
    if (waiting !== undefined && waitingWrite !== undefined) {
      waiting.value = next;
      return waitingWrite;
    }
    const queued: QueuedSnapshot<TValue> = { value: next };
    // Read at issue time: an act landing before the store frees must be carried by this
    // write.
    const write = writeAtStore.then(() => this.#issueQueued(queued));
    this.#queuedSnapshot = queued;
    this.#queuedWrite = write;
    return write;
  }

  /** Claim the freed store for the waiting snapshot. */
  #issueQueued(queued: QueuedSnapshot<TValue>): Promise<PersistenceWriteOutcome> {
    this.#queuedSnapshot = undefined;
    this.#queuedWrite = undefined;
    return this.#issue(queued.value);
  }

  /**
   * Put one write at the store and hold the store until it settles. The store stays held
   * while a snapshot is waiting, so an act arriving in between folds into that snapshot
   * instead of opening a second write.
   */
  #issue(next: TValue): Promise<PersistenceWriteOutcome> {
    const settlement = this.#writeThrough(next);
    this.#writeAtStore = settlement.then(
      () => {
        this.#releaseStore();
      },
      () => {
        this.#releaseStore();
      },
    );
    return settlement;
  }

  #releaseStore(): void {
    if (this.#queuedSnapshot === undefined) {
      this.#writeAtStore = undefined;
    }
  }

  /**
   * The write itself, and the settlement it may publish. A superseded act's settlement
   * publishes nothing: its snapshot is not what the view shows, and the write carrying that is
   * already queued.
   */
  async #writeThrough(next: TValue): Promise<PersistenceWriteOutcome> {
    const actsAtWrite = this.#localActs.currentClaim(this, LOCAL_ACT_KEY);
    const outcome = await this.#store.writeGlobal(this.#key, this.#valueClass, next);
    if (!actsAtWrite.isCurrent) {
      return outcome;
    }
    const settledRefusal = outcome.outcome === "refused" ? outcome.refusal : undefined;
    const refusalChanged = settledRefusal !== this.#lastRefusal;
    this.#lastRefusal = settledRefusal;
    if (refusalChanged) {
      this.#changes.emit();
    }
    return outcome;
  }
}

/** What a view says when its saved record could not be read. */
const UNREADABLE_RECORD_REFUSAL = refusePersistence(
  "adapter-unavailable",
  "What was saved here could not be read, so this view starts from its defaults.",
);

/**
 * A snapshot waiting for the store to free. A mutable box so a later act replaces what the
 * waiting write carries, and every caller holding its promise settles on that one write.
 */
interface QueuedSnapshot<TValue> {
  value: TValue;
}
