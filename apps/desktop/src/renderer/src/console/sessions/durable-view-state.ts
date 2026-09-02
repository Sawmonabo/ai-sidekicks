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

import { Emitter, type ConsoleRefusal, type Unsubscribe } from "../core/index.js";
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
  #lastRefusal: ConsoleRefusal | undefined;

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
   */
  public async hydrate(): Promise<void> {
    if (this.#hydrated) {
      return;
    }
    const record = await this.#store.readGlobal(this.#key);
    this.#hydrated = true;
    const narrowed = record === undefined ? undefined : this.#narrow(record.value);
    if (narrowed !== undefined) {
      this.#value = narrowed;
    }
    this.#changes.emit();
  }

  /** Replace the value and write it. The refusal is recorded and returned. */
  public async commit(next: TValue): Promise<PersistenceWriteOutcome> {
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
