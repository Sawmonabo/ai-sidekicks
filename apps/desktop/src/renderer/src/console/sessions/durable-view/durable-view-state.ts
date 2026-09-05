// One durable piece of per-install view state, held in memory and written through
// the persistence chokepoint.
//
// The sessions destination has two of these — which sessions are pinned to the
// front tier, and which invitations a person has set aside — and they are the same
// object with different contents: hold a value, hydrate it once from the durable
// store, notify subscribers when it changes, write every change through
// `UiStateStore`, and keep the last refusal so a surface can render it instead of
// pretending the write landed. Written twice, the two would drift on exactly the
// question that matters (what happens when the write is refused), so it is written
// once here.
//
// THE VALUE CLASS AND THE VALUE TYPE COME FROM THE CHOKEPOINT ITSELF. Both are
// derived off `UiStateStore.writeGlobal`'s own parameters rather than imported by
// name — the persistence door exports the store and not its vocabulary, and a
// hand-written copy of either would be a second declaration of a closed set that
// nothing checks. Derived, a class renamed there stops compiling here.
//
// A REFUSED WRITE NEVER SILENTLY SUCCEEDS IN MEMORY. The in-memory value is
// updated first so the surface responds at once, and a refusal is RECORDED rather
// than rolled back: rolling back would make a control flicker between two states
// for reasons a person cannot see, while a recorded refusal is a sentence they can
// read. `Spec-023 §Console Design (Meridian)` rule 9 — controls are offered,
// refusals are rendered.
//
// A LATE HYDRATION NEVER OVERWRITES A NEWER LOCAL ACT. The durable read is
// asynchronous and a person can pin a session or set an invitation aside while it
// is still in flight; `commit` installs immediately, so the record that then comes
// back is older than what is on screen. The mutation generation is the ordering the
// store itself supplies — `hydrate` captures it before its read and applies the
// record only if it is still current, exactly as `settings/pages/shell-preferences/shell-preferences-store.ts`
// ignores a superseded reply. It still marks the state hydrated, because the read
// DID settle and a remount must not re-ask; what is discarded is the value, not the
// fact that the question was answered.
//
// AND NEITHER DOES A LATE WRITE. Every commit writes a COMPLETE snapshot of the
// record, so two of them in flight at once are two whole records racing for the same
// key: pinning a session and then pinning a second one before the first write
// settles could leave the one-pin snapshot durable, and the adapter's own settlement
// order is not the order the acts happened in. So the writes are SERIALISED — one at
// the store at a time, the newest snapshot nothing has carried yet waiting behind it,
// and a later act REPLACING that waiting snapshot rather than queueing after it,
// because the value is a full record and writing the intermediate one first would
// spend a write on a state no surface shows any more. What reaches the store is
// every issued snapshot in the order it was issued, ending on the newest.

import { Emitter, type ConsoleRefusal, type Unsubscribe } from "../../core/index.js";
import type { UiStateStore } from "../../persistence/index.js";
import { GenerationLatch } from "../../store/index.js";

/** The chokepoint's closed value-class union, taken from the chokepoint. */
type PersistedValueClassName = Parameters<UiStateStore["writeGlobal"]>[1];

/** What the chokepoint admits as a value, taken from the chokepoint. */
type PersistedValue = Parameters<UiStateStore["writeGlobal"]>[2];

/**
 * What one write answered, taken from the chokepoint.
 *
 * Exported because this module's own suite drives the state with a store whose
 * writes are held at the door, and a test that re-derived the outcome under a second
 * name would go on type-checking against the store's full return type the day this
 * module narrowed its own — driving the state with an arm it no longer models while
 * asserting nothing about the narrowing. `knip.json`'s `ignoreExportsUsedInFile`
 * means the export costs nothing at the dead-code gate.
 */
export type PersistenceWriteOutcome = Awaited<ReturnType<UiStateStore["writeGlobal"]>>;

export interface DurableViewStateOptions<TValue extends PersistedValue> {
  readonly store: UiStateStore;
  /** The record key inside the global partition. Identifier-shaped, by the rules. */
  readonly key: string;
  readonly valueClass: PersistedValueClassName;
  /** What the state holds before anything has been read or written. */
  readonly initial: TValue;
  /**
   * Narrow one durable record back into the value, or refuse it.
   *
   * `undefined` discards the record and keeps the initial value. A record written
   * by an older build, or hand-edited in the browser's storage inspector, is data
   * this console did not produce, and coercing it would put a value on screen that
   * no code path can produce.
   */
  readonly narrow: (raw: unknown) => TValue | undefined;
}

/**
 * The one key every act of one state is on.
 *
 * One key rather than a key per act, because the rule this latch states is a single
 * ordering: a local act supersedes every read and every write that started before
 * it, whichever of them it was.
 */
const LOCAL_ACT_KEY = "local-act";

export class DurableViewState<TValue extends PersistedValue> {
  readonly #store: UiStateStore;
  readonly #key: string;
  readonly #valueClass: PersistedValueClassName;
  readonly #narrow: (raw: unknown) => TValue | undefined;
  readonly #changes = new Emitter<void>("durable view state");
  #value: TValue;
  #hydrated = false;
  #disposed = false;
  #lastRefusal: ConsoleRefusal | undefined;
  /**
   * The round local acts are on, so a hydration or a write that started before one
   * of them can tell that it is answering an older question. Here the read is what
   * is superseded and the act is what supersedes it, which is why `commit` claims
   * afresh and both settlement paths only JOIN — neither of them settles through the
   * handle, so the round stands until the next act or the disposal ends it.
   */
  readonly #localActs = new GenerationLatch();
  /**
   * The write at the store, mapped never to reject, or `undefined` while the store
   * is idle. Exactly one write is ever at the store.
   */
  #writeAtStore: Promise<void> | undefined;
  /**
   * The newest snapshot no write has carried yet. Replaced by a later act, never
   * appended to — see {@link QueuedSnapshot}.
   */
  #queuedSnapshot: QueuedSnapshot<TValue> | undefined;
  /** The one write that snapshot will ride. Every caller waiting on it shares it. */
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

  /** True once the durable read has settled, however it settled. */
  public get isHydrated(): boolean {
    return this.#hydrated;
  }

  /**
   * True once the store behind this state has been replaced. Terminal.
   *
   * Read by the binding holder's own test, and by nothing on a render path: a
   * disposed state is one no surface is subscribed to any more, so the fact is
   * about the holder's bookkeeping rather than about what a person sees.
   */
  public get isDisposed(): boolean {
    return this.#disposed;
  }

  /**
   * Release this state: its store has been replaced and nothing may reach it again.
   *
   * Three acts, and the middle one is the point. Dropping the sinks stops a late
   * reply notifying a surface that has moved on; superseding the local acts makes a
   * hydration still in flight discard the record it comes back with, so the closed
   * store's contents can never be installed over the successor's; and the flag
   * records the fact for the holder that owns the replacement.
   *
   * A write ALREADY IN FLIGHT still completes against the store it was sent to, and
   * that is correct — it was issued while that store was live. What cannot happen is
   * a NEW write, because every act reaches the binding the holder currently holds.
   */
  public dispose(): void {
    this.#disposed = true;
    this.#localActs.supersedeAll();
    this.#changes.clear();
  }

  /** The last refusal this state saw, or `undefined`. Rendered, never swallowed. */
  public get lastRefusal(): ConsoleRefusal | undefined {
    return this.#lastRefusal;
  }

  public subscribe(sink: () => void): Unsubscribe {
    return this.#changes.subscribe(sink);
  }

  /**
   * Read the durable record once.
   *
   * Idempotent: a second call after the first has settled does nothing, so a
   * remount cannot re-read over a value the person has since changed. Never
   * throws — `UiStateStore.read` answers `undefined` on failure by contract, which
   * is the same answer as "nothing was stored", and both leave the initial value
   * in place.
   *
   * A record that arrives after a local act is DISCARDED rather than installed: it
   * is the value from before that act, and installing it would put a pin or a hide
   * back the way a person had just changed it, with nothing on screen to explain
   * why. The state is still marked hydrated, so the question is not asked again.
   */
  public async hydrate(): Promise<void> {
    if (this.#hydrated) {
      return;
    }
    const actsAtRead = this.#localActs.currentClaim(this, LOCAL_ACT_KEY);
    const record = await this.#store.readGlobal(this.#key);
    this.#hydrated = true;
    if (!actsAtRead.isCurrent) {
      return;
    }
    const narrowed = record === undefined ? undefined : this.#narrow(record.value);
    if (narrowed !== undefined) {
      this.#value = narrowed;
    }
    this.#changes.emit();
  }

  /**
   * Replace the value and write it. The refusal is recorded and returned.
   *
   * THE SETTLEMENT EMITS WHEN THE REFUSAL CHANGES, IN EITHER DIRECTION. It emitted
   * only on the refused arm, so a write that RECOVERED cleared `#lastRefusal` and
   * told nobody: the pre-write emission happened while the old refusal was still
   * present, and the pin list and the invitation shelf read this getter on a render
   * they had no reason to perform — so a failure a person had already fixed stayed
   * on screen until something unrelated re-rendered the surface.
   *
   * Identity is the comparison because a refusal is a value the store hands back
   * whole: two refusals for the same cause are two objects, and re-rendering for the
   * second one is right — it is this write's own reason and not the last one's. What
   * it does not do is emit twice for the settlement that changed nothing, which is
   * every successful write after the first.
   *
   * THE ANSWER A COALESCED CALLER GETS IS THE WRITE THAT CARRIED ITS STATE. Two acts
   * before the store frees are one waiting snapshot, so both callers settle on the
   * one write that took the newest value — which is the honest answer to "did what I
   * asked for reach the store", and the only one the serialisation leaves true.
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
    // Read at ISSUE time and not here: an act landing between now and the store
    // freeing supersedes this snapshot's value, and the write has to carry what the
    // surface is showing when it leaves rather than what it was showing when it
    // was queued.
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
   * Put one write at the store and hold the door until it settles.
   *
   * The door is released in a continuation of the write's own settlement, so the
   * waiting snapshot — chained on the same promise, and chained FIRST — claims the
   * store in the very turn it is freed. That is why the release keeps the door shut
   * while a snapshot is waiting: an act arriving in the turns between the two folds
   * into that snapshot instead of opening a second write beside it.
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
   * The write itself, and the settlement it is allowed to publish.
   *
   * A settlement belonging to a superseded act publishes NOTHING. Its snapshot is
   * not what the surface is showing, and the write that carries what the surface IS
   * showing is already queued behind it — so recording this one would put a refusal
   * about a state nobody can see beside a control, or clear a standing refusal on the
   * strength of a write for a value that has been replaced. `hydrate` discards a
   * superseded record for the same reason and through the same generation.
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

/**
 * A snapshot waiting for the store to free.
 *
 * A mutable box rather than a value, because that is the coalescing: a later act
 * REPLACES what the waiting write will carry, and every caller already holding the
 * write's promise settles on the one write that then takes it.
 */
interface QueuedSnapshot<TValue> {
  value: TValue;
}
