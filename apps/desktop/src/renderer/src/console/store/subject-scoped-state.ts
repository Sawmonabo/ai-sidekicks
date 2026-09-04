// State that belongs to a subject, and can never be read about another one.
//
// THE FAILURE, WHICH FIVE FAMILIES EACH FOUND SEPARATELY. A mounted surface is
// re-addressed — one session to another, one run to another, one bridge to another
// when the fixture scenario switches, one agent binding to a newer reading of
// itself — by a prop changing. Its React state survives that change, and two things
// go wrong at once:
//
//   • THE FIRST COMMITTED RENDER UNDER THE NEW SUBJECT SHOWS THE OLD ONE'S VALUE.
//     Clearing it from an effect narrows that window rather than closing it, because
//     an effect runs after the commit: one painted frame carries the previous
//     session's roster, the previous run's outcome, or a disabled control the person
//     in front of the new subject never caused. Worse than the frame is what can be
//     pressed during it.
//   • A CALL STILL IN FLIGHT AGAINST THE OLD SUBJECT SETTLES INTO THE NEW ONE.
//     Nothing behind the bridge is cancellable, so the honest disposition is that a
//     late answer is DROPPED — never installed, and never described as cancelled.
//
// BOTH ARE CLOSED HERE, AND NEITHER BY A TIMER OR A COUNTER. The held value carries
// the subject it was produced under; the comparison happens DURING the render, so no
// pass can commit another subject's value; and a publisher carries the subject it was
// captured under, so a settlement that arrives after the subject moved writes nothing
// at all rather than overwriting what the new subject has already said.
//
// AND A PUBLISHER CARRIES THE ADDRESSING, NOT THE PAIR. A surface routed away from a
// session and back to it — s1 → s2 → s1 — is addressed at the same pair twice, and
// re-seeds on both visits because nothing here survives the move. A guard that
// compared only the pair would find the first visit's publisher still valid on the
// third, so that visit's reply — dispatched first, answered last — would overwrite the
// answer the surface on screen had already read. So each addressing takes a serial
// that is never reissued, the same mechanism `generation-latch.ts` uses next door, and
// a settlement is admitted only while the addressing it was captured under is the one
// still held.
//
// THE SUBJECT IS AN OBJECT AND A KEY WITHIN IT, and the object is deliberately opaque.
// `store/` sits below `bridge/` in the console's DAG and may not name a
// `ConsoleBridge`, a `GrowthPort`, or a `SessionStore`; every one of them is a live
// object whose replacement retires the calls made through it, which is exactly what
// identity comparison expresses. So the subject is `object`, compared by reference,
// and the families name their own subjects at their own doors —
// `seats/session-subject.ts` is the session-named one.
//
// THE KEY ADMITS `undefined`, which is a reading and not a hole: it says the surface
// has no subject to be about — no session on the address, no run selected — and the
// caller's own `initial()` decides what that renders as. Collapsing it into a
// sentinel string would make "no session" indistinguishable from a session that
// happens to be named that.
//
// A VALUE-COMPARED SUBJECT DERIVES ITS KEY rather than growing a second hook. A
// holder whose subject is a record compared field by field — an agent's effective
// provider binding, say — passes a derivation of that record as the key. The
// comparison then happens in the one place, on a string, and the derivation is the
// caller's business because only the caller knows which fields are the subject.
//
// WHAT THIS IS NOT. It is not single-flight: whether an act may be dispatched at all
// is `generation-latch.ts`, which a handler has to decide inside its own tick. It is
// not a cache — nothing here survives the subject it was held for. And it is not a
// scheduler; a burst collapsing into one read is `store/scheduling.ts`.

import { useCallback, useMemo, useState, useSyncExternalStore } from "react";

import { Emitter, type Unsubscribe } from "../core/index.js";

/**
 * The key within a subject, or `undefined` where the surface is about nothing yet.
 *
 * A string because a key is a NAME inside one object's key space — a session id, a
 * composer address, a run id, a derived binding digest — and never an identity of its
 * own. Two key spaces are told apart by the object they hang off, not by the string.
 */
export type SubjectKey = string | undefined;

/**
 * How a caller publishes: a value, or a function over the subject's current one.
 *
 * The function form is not a convenience. A caller that appends to a list or adds to
 * a set cannot read the current value out of its own closure — two acts settling in
 * one tick would both read the value from the render that produced them, and the
 * second would erase the first — so the update runs where the held value is, beside
 * the subject check. A `TValue` that is ITSELF a function is the one shape this
 * cannot express, which is the same ambiguity `useState` carries.
 */
export type SubjectScopedPublish<TValue> = (next: TValue | ((previous: TValue) => TValue)) => void;

/** What a caller reads and the two ways it writes. */
export interface SubjectScopedState<TValue> {
  /** The value held for the subject passed on THIS render. Never another's. */
  readonly value: TValue;
  /**
   * Publish into the subject this render is about.
   *
   * Captured at render, so a closure a caller carried into a `.then` still names the
   * subject that dispatched the call: if the subject has moved since, the publish is
   * dropped. Its identity changes exactly when the subject does, which is what makes
   * it a correct dependency for an effect that must re-run on a re-address.
   */
  readonly publish: SubjectScopedPublish<TValue>;
  /**
   * Capture the subject as it stands NOW and hand back a publisher bound to it.
   *
   * For the caller that has no fresh {@link publish} to close over: a handler stored
   * in a ref, a class built once by `useState(() => …)`, an effect with an empty
   * dependency list. Stable for the life of the mount, so handing it to such a holder
   * costs no re-subscription — and because the capture happens when it is CALLED
   * rather than when it was handed over, the settlement it publishes is still
   * measured against the subject that dispatched it.
   */
  readonly settle: () => SubjectScopedPublish<TValue>;
}

/** A value together with the subject, and the addressing, it was produced under. */
interface HeldSubjectValue<TValue> {
  readonly subject: object;
  readonly key: SubjectKey;
  /**
   * Which addressing seeded this value. Never reissued, so it names one visit.
   *
   * The pair alone cannot: a surface routed s1 → s2 → s1 is addressed at the same
   * pair on the first and third visits, and the value the first one produced is
   * already gone by the second.
   */
  readonly epoch: number;
  readonly value: TValue;
}

/**
 * The addressing a publisher names when it names none at all.
 *
 * Zero because addressings are counted from one, so a publisher taken for a pair
 * this holder is not currently holding can never match one — it names no visit, and
 * a visit is what a settlement is about.
 */
const NO_ADDRESSING = 0;

/**
 * One value, held per `(subject, key)` and readable only about that pair.
 *
 * REACT-FREE ON PURPOSE. Every rule this class carries — when a value is discarded,
 * which publisher may write, what a late settlement does — is a property of the
 * subject moving and not of a render happening, and five families proved that the
 * place two copies of it drift is the comparison. A test drives this object directly
 * with no renderer at all; the hook below only decides when React is told.
 *
 * ONE INSTANCE PER MOUNT, held by the hook. There is no module-level register, so
 * nothing here outlives the surface that owns it and no subject is reachable from a
 * root after its holder is gone.
 */
export class SubjectScopedHolder<TValue> {
  readonly #changes = new Emitter<void>("subject-scoped value");
  /**
   * The serial every held value is stamped with. Monotonic and never reissued, so a
   * pair the holder visits twice is two addressings and a settlement can name which.
   */
  #addressings = 0;
  #held: HeldSubjectValue<TValue> | undefined;

  /**
   * Address this holder at a subject, seeding it where that subject is new.
   *
   * Called during the render that first sees a new pair, which is what makes the
   * guarantee synchronous rather than one-frame-late. Idempotent: an address the
   * holder already carries does nothing, so a re-render costs one comparison and no
   * allocation, and React's double-invoked render in strict mode changes nothing.
   *
   * It deliberately does NOT emit. The render that re-addresses reads the value
   * immediately afterwards and so already sees the seeded one; emitting here would
   * schedule a second pass to arrive at the value the first one already had.
   *
   * `onDiscarded` is handed the value the new addressing replaced, for the caller
   * whose value owns something a drop does not release. It is called AFTER the
   * replacement is installed, so a caller cannot see a half-addressed holder, and
   * only where something was actually replaced — a first addressing discards
   * nothing. Whether the replaced value may be released is the caller's question and
   * not this class's: a render React discards leaves a value nothing committed, and
   * only React knows which. {@link useSubjectScopedResource} is the one caller that
   * answers it.
   */
  public address(
    subject: object,
    key: SubjectKey,
    initial: () => TValue,
    onDiscarded?: (discarded: TValue) => void,
  ): void {
    if (this.#isHeldFor(subject, key)) {
      return;
    }
    const discarded = this.#held;
    this.#addressings += 1;
    this.#held = { subject, key, epoch: this.#addressings, value: initial() };
    if (discarded !== undefined) {
      onDiscarded?.(discarded.value);
    }
  }

  /**
   * The held value.
   *
   * Throws where nothing has been addressed yet, which is a composition error rather
   * than a state: the one caller is the hook, and it addresses during render before
   * it reads. A holder that answered `undefined` here would hand every consumer a
   * value the type says cannot exist.
   */
  public get value(): TValue {
    if (this.#held === undefined) {
      throw new Error("A subject-scoped holder was read before it was addressed at a subject");
    }
    return this.#held.value;
  }

  /** Subscribe to publishes. Returns an idempotent unsubscribe. */
  public subscribe(sink: () => void): Unsubscribe {
    return this.#changes.subscribe(sink);
  }

  /**
   * Return a publisher bound to the addressing that holds the pair a caller NAMES.
   *
   * The single mechanism behind both members of {@link SubjectScopedState}: the hook
   * names this render's pair for `publish`, and {@link settle} reads the live one for
   * the caller that has no fresh pair to name. There is one rule about what a late
   * write may do, and two moments at which a caller may capture it.
   *
   * A pair this holder is not currently holding publishes NOWHERE, rather than
   * publishing later if the holder returns to it. The return is a second visit and
   * seeds a second value; admitting the first visit's answer into it is the defect
   * this reads an addressing to close.
   */
  public publisherFor(subject: object, key: SubjectKey): SubjectScopedPublish<TValue> {
    const held = this.#held;
    return this.#publisherForAddressing(
      held !== undefined && held.subject === subject && held.key === key
        ? held.epoch
        : NO_ADDRESSING,
    );
  }

  /**
   * Capture the subject as it stands NOW and return a publisher bound to it.
   *
   * For the caller with no fresh publisher to close over — a handler stored in a ref,
   * a class built once, an effect with an empty dependency list. A capture taken
   * before anything was addressed publishes nothing: there is no subject it was
   * about, and {@link publishesNowhere} says so rather than throwing into a
   * settlement path whose whole job is to be total.
   */
  public settle(): SubjectScopedPublish<TValue> {
    const held = this.#held;
    return held === undefined ? publishesNowhere : this.#publisherForAddressing(held.epoch);
  }

  /**
   * The write path, admitted by one comparison: is that addressing still the one held?
   *
   * The pair is not compared beside it and does not need to be — an addressing names
   * one visit to one pair, and the serial is never reissued — so there is a single
   * predicate here rather than two that could disagree. A publish keeps the
   * addressing it wrote under: settling is not re-addressing.
   */
  #publisherForAddressing(epoch: number): SubjectScopedPublish<TValue> {
    return (next) => {
      const held = this.#held;
      if (held === undefined || held.epoch !== epoch) {
        // The subject moved while this call was out — or moved away and back, which
        // is the same fact. Dropping the answer is the whole point: it is about a
        // visit nothing on screen is addressed at.
        return;
      }
      const resolved =
        typeof next === "function" ? (next as (was: TValue) => TValue)(held.value) : next;
      if (Object.is(resolved, held.value)) {
        // A publish that changes nothing wakes nobody. Two acts settling into the
        // same value in one tick would otherwise render the surface twice for it.
        return;
      }
      this.#held = { ...held, value: resolved };
      this.#changes.emit();
    };
  }

  #isHeldFor(subject: object, key: SubjectKey): boolean {
    const held = this.#held;
    return held !== undefined && held.subject === subject && held.key === key;
  }
}

/**
 * Hold one value per `(subject, key)`, reset during the render that re-addresses.
 *
 * `initial` is a function and is read only when the subject changes, so a caller may
 * derive the seed from whatever the new subject is — "unasked" where the key is
 * `undefined`, "reading" where it is not — without recomputing it on every pass.
 */
export function useSubjectScopedState<TValue>(
  subject: object,
  key: SubjectKey,
  initial: () => TValue,
): SubjectScopedState<TValue> {
  const [holder] = useState(() => new SubjectScopedHolder<TValue>());
  // During the render, before the value is read: the pass that first sees a new
  // subject already reads that subject's own seed, so no frame carries the previous
  // one's. React's own state-adjustment pattern spends a discarded render pass to
  // reach the same place; addressing an external holder reaches it in the first.
  holder.address(subject, key, initial);

  const subscribe = useCallback((onChange: () => void) => holder.subscribe(onChange), [holder]);
  const read = useCallback(() => holder.value, [holder]);
  const value = useSyncExternalStore(subscribe, read, read);

  // Re-captured exactly when the subject moves, and by nothing else — a caller that
  // carried this into a settlement still names the subject that dispatched it.
  const publish = useMemo(() => holder.publisherFor(subject, key), [holder, subject, key]);
  // Stable for the mount: captured when CALLED, so a holder built once may keep it.
  const settle = useCallback(() => holder.settle(), [holder]);

  return useMemo(() => ({ value, publish, settle }), [value, publish, settle]);
}

/**
 * What a capture taken before any subject publishes: nothing, anywhere.
 *
 * A declared function rather than a closure minted per call — it is reached only on a
 * mount's very first pass, and a fresh no-op each time would be an allocation on a
 * path whose whole content is doing nothing. It takes no parameter, which is what
 * makes it a publisher for every value type without a cast.
 */
function publishesNowhere(): void {}
