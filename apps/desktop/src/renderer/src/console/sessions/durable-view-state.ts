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
// record only if it is still current, exactly as `settings/pages/shell-preferences-store.ts`
// ignores a superseded reply. It still marks the state hydrated, because the read
// DID settle and a remount must not re-ask; what is discarded is the value, not the
// fact that the question was answered.

import {
  AttemptGeneration,
  Emitter,
  type ConsoleRefusal,
  type Unsubscribe,
} from "../core/index.js";
import type { UiStateStore } from "../persistence/index.js";

/** The chokepoint's closed value-class union, taken from the chokepoint. */
type PersistedValueClassName = Parameters<UiStateStore["writeGlobal"]>[1];

/** What the chokepoint admits as a value, taken from the chokepoint. */
type PersistedValue = Parameters<UiStateStore["writeGlobal"]>[2];

/** What one write answered, taken from the chokepoint. */
type PersistenceWriteOutcome = Awaited<ReturnType<UiStateStore["writeGlobal"]>>;

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
   * The rounds local acts have opened, so a hydration that started before one of
   * them can tell that it is answering an older question. Here the read is what is
   * superseded and the act is what supersedes it, which is why `commit` invalidates
   * and `hydrate` only captures.
   */
  readonly #localActs = new AttemptGeneration();

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
    const actsAtRead = this.#localActs.current();
    const record = await this.#store.readGlobal(this.#key);
    this.#hydrated = true;
    if (!this.#localActs.isCurrent(actsAtRead)) {
      return;
    }
    const narrowed = record === undefined ? undefined : this.#narrow(record.value);
    if (narrowed !== undefined) {
      this.#value = narrowed;
    }
    this.#changes.emit();
  }

  /** Replace the value and write it. The refusal is recorded and returned. */
  public async commit(next: TValue): Promise<PersistenceWriteOutcome> {
    this.#localActs.supersedeAll();
    this.#value = next;
    this.#changes.emit();
    const outcome = await this.#store.writeGlobal(this.#key, this.#valueClass, next);
    this.#lastRefusal = outcome.outcome === "refused" ? outcome.refusal : undefined;
    if (outcome.outcome === "refused") {
      this.#changes.emit();
    }
    return outcome;
  }
}
