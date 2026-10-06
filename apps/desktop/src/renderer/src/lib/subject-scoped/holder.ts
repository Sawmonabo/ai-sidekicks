// The rule a subject-scoped value obeys, with no renderer in it.
//
// A mounted component is re-addressed (another session, run, bridge or agent binding) by a prop
// changing, and its React state survives. Two things go wrong: the first committed render under
// the new subject shows the old subject's value (clearing it in an effect only narrows the window,
// since an effect runs after the commit), and a call still in flight against the old subject
// settles into the new one. Nothing behind the bridge is cancelable, so a late answer is dropped,
// never installed; where it is a resource, the caller's disposal is the only path to it.
//
// Both are closed without a timer. The held value carries the subject it was produced under, the
// comparison happens during the render, and a publisher carries the addressing it was captured
// under, so a settlement after the subject moved writes nothing.
//
// A publisher carries the addressing, not the pair. A component routed s1 -> s2 -> s1 is addressed
// at the same pair twice, and a guard on the pair would let the first visit's reply overwrite the
// answer already read. Each addressing takes a serial that is never reissued (as in
// `reads/generation-latch.ts`), and a settlement is admitted only while its addressing is held.
//
// An addressing is held in two phases because a render is not a commit: React may discard a pass
// (an interrupted concurrent render, a superseded transition, a suspension that never resumes).
// A new addressing is provisional until a render carrying it commits, the committed one keeps
// admitting settlements until then, and a provisional nothing committed is discarded once a later
// pass proves it over: a pass for another subject, or one back at the committed subject.
//
// The subject is an opaque object compared by reference, with a string key within it: `lib/` sits
// below `store/` and `services/` and cannot name a `PlatformBridge` or `SessionStore`, each of
// which is a live object whose replacement retires calls made through it. The key admits
// `undefined`, meaning the component has no subject yet; the caller's `initial()` decides what
// that renders as. `store/session/subject.ts` is the session-named subject.
//
// The React half is in `hooks/subject-scoped/`: `useSubjectScopedState.ts` decides when React is
// told and `useSubjectScopedResource.ts` handles values that must be disposed. What becomes of a
// value this class lets go of is `unheld-value-disposal.ts`.

import type { Unsubscribe } from "#shared/preload-api.js";
import { Emitter } from "../emitter.js";

import { UnheldValueDisposal, type SubjectScopedHolderOptions } from "./unheld-value-disposal.js";

/**
 * The key within a subject, or `undefined` where the component is about nothing yet. A name inside
 * one object's key space (a session id, composer address, run id); key spaces are told apart by
 * their subject object, not by the string.
 */
export type SubjectKey = string | undefined;

/**
 * How a caller publishes: a value, or a function over the subject's current one. The function
 * form runs beside the subject check, so two acts settling in one tick do not both read a stale
 * closure and erase each other. A `TValue` that is itself a function cannot be expressed, as with
 * `useState`.
 */
export type SubjectScopedPublish<TValue> = (next: TValue | ((previous: TValue) => TValue)) => void;

/** A value together with the subject, and the addressing, it was produced under. */
interface HeldSubjectValue<TValue> {
  readonly subject: object;
  readonly key: SubjectKey;
  /** Which addressing seeded this value; never reissued, so it names one visit, unlike the pair. */
  readonly epoch: number;
  readonly value: TValue;
}

/** The addressing a publisher names when it names none. Zero, since addressings count from one. */
const NO_ADDRESSING = 0;

/**
 * One value, held per `(subject, key)` and readable only about that pair. React-free, so a test
 * drives it directly; one instance per mount, held by the hook, so nothing outlives its component.
 */
export class SubjectScopedHolder<TValue> {
  readonly #changes = new Emitter<void>("subject-scoped value");
  /** What becomes of a direct value this holder lets go of, where a drop is not enough. */
  readonly #disposal: UnheldValueDisposal<TValue>;
  /** The serial stamped on held values; never reissued, so a revisited pair is a new addressing. */
  #addressings = 0;
  /** What the last committed render is addressed at; what the tree on screen reads. */
  #committed: HeldSubjectValue<TValue> | undefined;
  /** What a render pass has addressed and no commit has confirmed. */
  #provisional: HeldSubjectValue<TValue> | undefined;

  /**
   * A plain holder drops what it refuses; one built with a disposal closes it. The disposal is
   * taken once here, since a publisher capture may outlive the render that took it.
   */
  public constructor(options?: SubjectScopedHolderOptions<TValue>) {
    this.#disposal = new UnheldValueDisposal<TValue>(options?.disposeUnheldValue);
  }

  /**
   * Addresses this holder at a subject, seeding it where that subject is new. Called during the
   * render that first sees a new pair, so the guarantee is synchronous; a pair already held costs
   * one comparison and no allocation, so strict mode's double render changes nothing.
   *
   * A new pair is addressed provisionally, never over the committed one: the pass may be thrown
   * away, and the screen keeps reading and settling through the committed visit until
   * {@link commit}. A pass back at the committed pair, or at a third subject, ends the provisional
   * one and hands its seeded value to the caller's disposal; only one provisional exists at a time.
   *
   * It does not emit: the render that addresses reads the value right after, and emitting would
   * schedule a second pass to reach a value the first already has.
   */
  public address(subject: object, key: SubjectKey, initial: () => TValue): void {
    if (addresses(this.#provisional, subject, key)) {
      return;
    }
    if (addresses(this.#committed, subject, key)) {
      this.discardProvisional();
      return;
    }
    const abandoned = this.#provisional;
    this.#addressings += 1;
    this.#provisional = { subject, key, epoch: this.#addressings, value: initial() };
    if (abandoned !== undefined) {
      // After the replacement is installed, so a disposal cannot observe a half-addressed holder,
      // and through the disposal backstop, so a throwing `close` cannot strand the new resource.
      this.#disposal.disposeDiscarded(abandoned.value);
    }
  }

  /**
   * Confirms that a render carrying this pair reached the screen; the caller says so from the
   * layout phase, the earliest moment the answer is known. The previous commit's value is dropped,
   * not disposed: a live effect still holds it and the caller's lifetime retires it. A commit
   * naming a pair no provisional carries confirms nothing and ends any provisional.
   */
  public commit(subject: object, key: SubjectKey): void {
    if (!addresses(this.#provisional, subject, key)) {
      this.discardProvisional();
      return;
    }
    this.#committed = this.#provisional;
    this.#provisional = undefined;
  }

  /**
   * Ends a provisional addressing no render will commit. Called from {@link address} and
   * {@link commit} when a later pass proves it over, and by the caller at the end of the mount.
   */
  public discardProvisional(): void {
    const abandoned = this.#provisional;
    if (abandoned === undefined) {
      return;
    }
    this.#provisional = undefined;
    this.#disposal.disposeDiscarded(abandoned.value);
  }

  /**
   * The value of the addressing being read now: the provisional one where a pass addressed a
   * subject the last commit has not seen, else the committed one. Read it in the pass that
   * addressed. Throws if nothing has been addressed, a composition error: the hook addresses
   * during render before it reads.
   */
  public get value(): TValue {
    const reading = this.#provisional ?? this.#committed;
    if (reading === undefined) {
      throw new Error("A subject-scoped holder was read before it was addressed at a subject");
    }
    return reading.value;
  }

  /**
   * The addressing this render is reading, for a caller that memoizes a publisher. The pair cannot
   * stand in for it: React compares memo dependencies against the last committed render, so an
   * A -> B -> A round trip inside one commit leaves the pair equal while the visit is over.
   * `NO_ADDRESSING` before anything is addressed.
   */
  public get addressing(): number {
    return (this.#provisional ?? this.#committed)?.epoch ?? NO_ADDRESSING;
  }

  /** Subscribes to publishes. Returns an idempotent unsubscribe. */
  public subscribe(sink: () => void): Unsubscribe {
    return this.#changes.subscribe(sink);
  }

  /**
   * Returns a publisher bound to the addressing that holds the named pair, checking the
   * provisional addressing before the committed one, as a render reads. A pair not currently held
   * publishes nowhere, even if the holder later returns to it: that is a second visit with a
   * second value.
   */
  public publisherFor(subject: object, key: SubjectKey): SubjectScopedPublish<TValue> {
    const named = addresses(this.#provisional, subject, key)
      ? this.#provisional
      : addresses(this.#committed, subject, key)
        ? this.#committed
        : undefined;
    return this.#publisherForAddressing(named?.epoch ?? NO_ADDRESSING);
  }

  /**
   * Captures the visit on screen and returns a publisher bound to it, for a caller outside a
   * render (a handler in a ref, a class built once, an effect with no dependencies), where only the
   * committed visit is being read. Before anything commits, the publisher refuses every write
   * through the same refusal path, so a holder with a disposal still closes what it is handed.
   */
  public settle(): SubjectScopedPublish<TValue> {
    return this.#publisherForAddressing(this.#committed?.epoch ?? NO_ADDRESSING);
  }

  /**
   * The write path, admitted by one comparison: is that addressing still held? An addressing names
   * one visit to one pair, so the pair is not compared too. A publish keeps its addressing;
   * settling neither promotes a provisional nor retires a committed one.
   */
  #publisherForAddressing(epoch: number): SubjectScopedPublish<TValue> {
    return (next) => {
      const held = this.#heldAt(epoch);
      if (held === undefined) {
        // The subject moved while this call was out, moved away and back, or the proposing pass
        // was thrown away: the answer is about a visit nothing on screen is addressed at.
        this.#refusePublish(next);
        return;
      }
      const resolved =
        typeof next === "function" ? (next as (was: TValue) => TValue)(held.value) : next;
      if (Object.is(resolved, held.value)) {
        // A publish that changes nothing wakes nobody.
        return;
      }
      const replaced = held.value;
      const written = { ...held, value: resolved };
      if (this.#provisional?.epoch === epoch) {
        this.#provisional = written;
      } else {
        this.#committed = written;
      }
      // After the replacement is installed and before anybody is woken: a disposal must not see a
      // half-written holder, nor a subscriber a frame whose predecessor is still open.
      this.#disposal.disposeReplaced(replaced);
      this.#changes.emit();
    };
  }

  /** Whichever of the two addressings carries this serial, or neither. */
  #heldAt(epoch: number): HeldSubjectValue<TValue> | undefined {
    if (this.#provisional?.epoch === epoch) {
      return this.#provisional;
    }
    if (this.#committed?.epoch === epoch) {
      return this.#committed;
    }
    return undefined;
  }

  /** Disposes a refused value; the function form is refused unrun, so nothing is disposed. */
  #refusePublish(next: TValue | ((previous: TValue) => TValue)): void {
    if (typeof next === "function") {
      return;
    }
    this.#disposal.disposeRefused(next);
  }
}

/** Whether an addressing, if there is one at all, is the one for this exact pair. */
function addresses<TValue>(
  held: HeldSubjectValue<TValue> | undefined,
  subject: object,
  key: SubjectKey,
): boolean {
  return held !== undefined && held.subject === subject && held.key === key;
}
