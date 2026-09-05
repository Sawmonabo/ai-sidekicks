// The rule a subject-scoped value obeys, with no renderer anywhere in it.
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
//     Where that answer is a RESOURCE, dropping it is not enough: never installed
//     means no effect ever closed over it, so the caller's disposal is the only path
//     to it and this class is the only place that knows the value was refused.
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
// THE REACT HALF IS NEXT DOOR, and the split is the one the rule itself draws: every
// decision in this file is a property of the SUBJECT moving rather than of a render
// happening, so it is drivable with no renderer at all. `subject-scoped-state.ts`
// decides when React is told, and `subject-scoped-resource.ts` adds the half about a
// value that has to be disposed rather than dropped.

import { wireRejectionToError } from "../../../../shared/wire-errors.js";

import { Emitter, reportTripwire, type Unsubscribe } from "../core/index.js";

/** What a tripwire report from this module names as the site it fired at. */
const SITE = "console/store/subject-scoped-holder.ts";

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
 * How a holder is built, for the caller whose value owns something.
 *
 * A VALUE IS DROPPED AND A RESOURCE IS DISPOSED — the split {@link
 * SubjectScopedHolder.address} already draws for a value a re-addressing replaces,
 * drawn here at the other write moment. A caller that opened a connection for a
 * visit which ended while the open was in flight has published something nothing
 * will ever hold: it is not installed, so no effect closes over it, so no cleanup
 * closes it. Handing a disposal in is what makes that refusal a close rather than a
 * leak, and a holder built without one drops what it refuses exactly as before.
 */
export interface SubjectScopedHolderOptions<TValue> {
  /**
   * Dispose a direct value this holder refused to install.
   *
   * WHETHER THE VALUE MAY BE RELEASED STAYS THE CALLER'S QUESTION, as it is for a
   * discarded one: this class knows a publish was refused and nothing about which
   * render, if any, is holding what. `useSubjectScopedResource` answers it.
   */
  readonly disposeRejectedPublish: (rejected: TValue) => void;
}

/**
 * One value, held per `(subject, key)` and readable only about that pair.
 *
 * REACT-FREE ON PURPOSE. Every rule this class carries — when a value is discarded,
 * which publisher may write, what a late settlement does — is a property of the
 * subject moving and not of a render happening, and five families proved that the
 * place two copies of it drift is the comparison. A test drives this object directly
 * with no renderer at all; the hook next door only decides when React is told.
 *
 * ONE INSTANCE PER MOUNT, held by the hook. There is no module-level register, so
 * nothing here outlives the surface that owns it and no subject is reachable from a
 * root after its holder is gone.
 */
export class SubjectScopedHolder<TValue> {
  readonly #changes = new Emitter<void>("subject-scoped value");
  /** What becomes of a direct value this holder refuses, where a drop is not enough. */
  readonly #disposeRejectedPublish: ((rejected: TValue) => void) | undefined;
  /**
   * The serial every held value is stamped with. Monotonic and never reissued, so a
   * pair the holder visits twice is two addressings and a settlement can name which.
   */
  #addressings = 0;
  #held: HeldSubjectValue<TValue> | undefined;

  /**
   * A plain holder drops what it refuses; one built with a disposal closes it.
   *
   * The disposal is taken ONCE, here, rather than at each write moment: a publisher
   * is captured per render and a capture may outlive the render that took it, so a
   * disposal supplied beside one would be as stale as the visit it names.
   */
  public constructor(options?: SubjectScopedHolderOptions<TValue>) {
    this.#disposeRejectedPublish = options?.disposeRejectedPublish;
  }

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
   *
   * AND A DISPOSAL THAT THROWS DOES NOT TAKE THE REPLACEMENT WITH IT. The ordering
   * above has a cost the class has to pay rather than pass on: this runs during a
   * render, with the new value already installed and no commit yet reaching it, so a
   * `close` that throws — `disposeAll` over a registry can — would leave the resource
   * the disposal was clearing room for held by an object nothing will ever clean up.
   * So the call is backstopped, on the precedent `core/wire-rejection.ts` sets for
   * the same shape: the failure is REPORTED and swallowed, never silently dropped.
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
    if (discarded === undefined || onDiscarded === undefined) {
      return;
    }
    try {
      onDiscarded(discarded.value);
    } catch (disposalFailure: unknown) {
      // Under the kind an escaping throw would have been reported as anyway. Left to
      // propagate, this reaches the surface's error boundary, which records exactly
      // this — a throw raised while rendering, mutating no store — and unmounts the
      // subtree on top of it. Caught here the reading is the same and the subtree
      // survives; a disposal that failed is a defect either way, and this is the one
      // path in the module where a throw had no backstop at all.
      //
      // `wireRejectionToError` rather than a second stringifier: a thrown value is
      // `unknown`, and `String(...)` on a null-prototype one throws inside the report
      // that exists to describe it.
      reportTripwire(
        "surface-render-failure",
        SITE,
        `a subject-scoped value's disposal threw while the holder was being re-addressed; the replacement stands and the discarded value was not released: ${wireRejectionToError(disposalFailure, { total: true }).message}`,
      );
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

  /**
   * The addressing the holder is on NOW, for the caller that memoizes a publisher.
   *
   * A publisher is bound to one addressing, so the question "is the publisher I
   * handed out still the live one" has exactly one honest answer, and it is this
   * number. The pair cannot stand in for it: React compares a memo's dependencies
   * against the last COMMITTED render's, so a pass React discarded can move the
   * addressing while leaving the pair equal — an A -> B -> A round-trip inside one
   * commit — and a publisher keyed on the pair alone then names a visit that is
   * over. It publishes nowhere, silently, taking whatever the caller had just
   * opened for it with it.
   *
   * `NO_ADDRESSING` before anything is addressed, so a caller cannot key a memo on
   * a number that names no visit and then find it equal to one that does.
   */
  public get addressing(): number {
    return this.#held?.epoch ?? NO_ADDRESSING;
  }

  /** Subscribe to publishes. Returns an idempotent unsubscribe. */
  public subscribe(sink: () => void): Unsubscribe {
    return this.#changes.subscribe(sink);
  }

  /**
   * Return a publisher bound to the addressing that holds the pair a caller NAMES.
   *
   * The single mechanism behind both write moments the hook next door hands out: it
   * names this render's pair for its `publish`, and {@link settle} reads the live one
   * for the caller that has no fresh pair to name. There is one rule about what a
   * late write may do, and two moments at which a caller may capture it.
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
   * about, so the publisher it hands back refuses every write rather than throwing
   * into a settlement path whose whole job is to be total.
   *
   * Through the ONE refusal path even then, rather than a no-op of its own: a second
   * publisher that quietly ignored what it was handed would be a second answer to
   * what a refusal does, and on a holder built with a disposal the two answers
   * differ by a connection nobody closes.
   */
  public settle(): SubjectScopedPublish<TValue> {
    return this.#publisherForAddressing(this.addressing);
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
        // is the same fact. Refusing the answer is the whole point: it is about a
        // visit nothing on screen is addressed at.
        this.#rejectPublish(next);
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

  /**
   * What becomes of a publish this holder refused.
   *
   * NOTHING AT ALL FOR A VALUE, which is correct and is the plain holder's whole
   * answer: it was never installed and nothing holds it. A holder built with a
   * disposal has a caller whose value owns a connection, a subscription, or a
   * registry, and for that caller a silent drop is a leak with no path left to it.
   *
   * REPORTED AS WELL AS DISPOSED, on the precedent `frame/session-event-binder.ts`
   * and `bridge/scenario-engine.ts` set for this same class — work that arrived for
   * a target that is gone, dropped rather than delivered. One report per refusal,
   * and it says which of the two happened, because a disposal that throws leaves the
   * resource held by nothing and that is a different fact from a clean close.
   *
   * THE REPORT COMES AFTER THE DISPOSAL, and the order is load-bearing: a report
   * THROWS in a development build, so reporting first would take the close with it
   * on exactly the build an author is watching. The disposal is backstopped for the
   * reason `address`'s is — a throw here escapes into whatever settled the publish,
   * which is a caller's `.then`.
   *
   * THE FUNCTION FORM IS REFUSED WITHOUT RUNNING, so there is nothing to dispose:
   * the update that would have produced a value never ran.
   */
  #rejectPublish(next: TValue | ((previous: TValue) => TValue)): void {
    const dispose = this.#disposeRejectedPublish;
    if (dispose === undefined || typeof next === "function") {
      return;
    }
    let disposalFailure: unknown;
    let disposed = false;
    try {
      dispose(next);
      disposed = true;
    } catch (failure: unknown) {
      disposalFailure = failure;
    }
    reportTripwire(
      "apply-chokepoint-bypass",
      SITE,
      disposed
        ? "a resource settled into a subject-scoped visit that had already ended; the holder handed it to the caller's disposal rather than installing it into a visit nothing on screen is addressed at"
        : `a resource settled into a subject-scoped visit that had already ended and its disposal threw, so it is installed nowhere and held by nothing: ${wireRejectionToError(disposalFailure, { total: true }).message}`,
    );
  }

  #isHeldFor(subject: object, key: SubjectKey): boolean {
    const held = this.#held;
    return held !== undefined && held.subject === subject && held.key === key;
  }
}
