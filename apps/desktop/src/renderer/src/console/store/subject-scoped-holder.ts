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
//     in front of the new subject never caused — and worse than the frame is what can
//     be pressed during it.
//   • A CALL STILL IN FLIGHT AGAINST THE OLD SUBJECT SETTLES INTO THE NEW ONE.
//     Nothing behind the bridge is cancellable, so the honest disposition is that a
//     late answer is DROPPED — never installed, never described as cancelled. Where
//     that answer is a RESOURCE, dropping it is not enough: never installed means no
//     effect closed over it, so the caller's disposal is the only path to it.
//
// BOTH ARE CLOSED HERE, AND NEITHER BY A TIMER OR A COUNTER. The held value carries
// the subject it was produced under, the comparison happens DURING the render, and a
// publisher carries the subject it was captured under — so a settlement arriving after
// the subject moved writes nothing rather than overwriting what the new subject said.
//
// AND A PUBLISHER CARRIES THE ADDRESSING, NOT THE PAIR. A surface routed away from a
// session and back to it — s1 → s2 → s1 — is addressed at the same pair twice, and
// re-seeds on both visits because nothing here survives the move. A guard comparing
// only the pair would find the first visit's publisher still valid on the third, so
// that visit's reply — dispatched first, answered last — would overwrite the answer the
// surface on screen had already read. So each addressing takes a serial that is never
// reissued, the same mechanism `generation-latch.ts` uses next door, and a settlement
// is admitted only while the addressing it was captured under is one still held.
//
// AN ADDRESSING IS HELD IN TWO PHASES, BECAUSE A RENDER IS NOT A COMMIT. A pass that
// first sees a new subject has to read that subject's own seed — that is the whole
// guarantee — but React may throw that pass away: an interrupted concurrent render, a
// transition superseded by a later one, a suspension that never resumes. An addressing
// that retired the committed one AS IT WAS MINTED would leave the tree on screen
// reading through a visit the holder no longer holds: its publisher refuses every
// settlement, silently, and the value it had already been given is replaced by a seed
// for a subject nothing painted. So a new addressing is PROVISIONAL until a render
// carrying it commits, the committed one goes on admitting settlements until then, and
// a provisional nothing committed is discarded the moment a later pass proves it is
// over — a pass for another subject, or one back at the committed subject.
//
// THE SUBJECT IS AN OBJECT AND A KEY WITHIN IT, and the object is deliberately opaque.
// `store/` sits below `bridge/` in the console's DAG and may not name a
// `ConsoleBridge`, a `GrowthPort`, or a `SessionStore`; every one of them is a live
// object whose replacement retires the calls made through it, which is exactly what
// identity comparison expresses. So the subject is `object`, compared by reference,
// and the families name their own subjects at their own doors —
// `seats/session-subject.ts` is the session-named one. THE KEY ADMITS `undefined`,
// which is a reading and not a hole: it says the surface has no subject to be about,
// and the caller's own `initial()` decides what that renders as.
//
// THE REACT HALF IS NEXT DOOR, and the split is the one the rule itself draws: every
// decision in this file is a property of the SUBJECT moving rather than of a render
// happening, so it is drivable with no renderer at all — a test addresses and commits
// in the order React would. `subject-scoped-state.ts` decides when React is told, and
// `subject-scoped-resource.ts` adds the half about a value that has to be disposed
// rather than dropped.
//
// AND WHAT BECOMES OF A VALUE THIS CLASS LETS GO OF IS `unheld-value-disposal.ts`.
// This file answers who may write; that one answers what happens to the value the
// write refused or replaced, and to the one an abandoned pass seeded, and it holds all
// three moments together because they share a backstop and differ only in the sentence
// they report.

import { Emitter, type Unsubscribe } from "../core/index.js";

import { UnheldValueDisposal, type SubjectScopedHolderOptions } from "./unheld-value-disposal.js";

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
   * Which addressing seeded this value. Never reissued, so it names ONE visit, which
   * the pair alone cannot: a surface routed s1 → s2 → s1 is at the same pair twice.
   */
  readonly epoch: number;
  readonly value: TValue;
}

/**
 * The addressing a publisher names when it names none at all. Zero because addressings
 * are counted from one, so a publisher taken for a pair this holder is not currently
 * holding can never match one — it names no visit, and a settlement is about a visit.
 */
const NO_ADDRESSING = 0;

/** Whether an addressing, if there is one at all, is the one for this exact pair. */
function addresses<TValue>(
  held: HeldSubjectValue<TValue> | undefined,
  subject: object,
  key: SubjectKey,
): boolean {
  return held !== undefined && held.subject === subject && held.key === key;
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
  /** What becomes of a direct value this holder lets go of, where a drop is not enough. */
  readonly #disposal: UnheldValueDisposal<TValue>;
  /**
   * The serial every held value is stamped with. Monotonic and never reissued, so a
   * pair the holder visits twice is two addressings and a settlement can name which.
   */
  #addressings = 0;
  /** What the last render to COMMIT is addressed at. What the tree on screen reads. */
  #committed: HeldSubjectValue<TValue> | undefined;
  /** What a render pass has addressed and no commit has yet confirmed. */
  #provisional: HeldSubjectValue<TValue> | undefined;

  /**
   * A plain holder drops what it refuses; one built with a disposal closes it.
   *
   * The disposal is taken ONCE, here, rather than at each write moment: a publisher
   * is captured per render and a capture may outlive the render that took it, so a
   * disposal supplied beside one would be as stale as the visit it names.
   */
  public constructor(options?: SubjectScopedHolderOptions<TValue>) {
    this.#disposal = new UnheldValueDisposal<TValue>(options?.disposeUnheldValue);
  }

  /**
   * Address this holder at a subject, seeding it where that subject is new.
   *
   * Called during the render that first sees a new pair, which is what makes the
   * guarantee synchronous rather than one-frame-late. The pair the last commit holds
   * and the pair a pass in flight already addressed both cost one comparison and no
   * allocation, so a re-render allocates nothing and React's double-invoked render in
   * strict mode changes nothing.
   *
   * A NEW PAIR IS ADDRESSED PROVISIONALLY, never over the committed one. The pass
   * doing the addressing may be thrown away, and the tree on screen goes on reading
   * and settling through the visit it committed to until a pass carrying the new one
   * reaches {@link commit}.
   *
   * A PASS BACK AT THE COMMITTED PAIR ENDS ANY PROVISIONAL, which is how a suspended
   * or superseded pass stops being anybody's: React re-renders at the subject on
   * screen, this comparison finds the committed addressing already right, and the
   * value the abandoned pass seeded is handed to the caller's disposal. The same
   * happens where the later pass names a THIRD subject: one provisional at a time,
   * and the one it replaces is over.
   *
   * It deliberately does NOT emit. The render that addresses reads the value
   * immediately afterwards and so already sees the seeded one; emitting here would
   * schedule a second pass to arrive at the value the first one already had.
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
      // AFTER the replacement is installed, so a disposal cannot observe a
      // half-addressed holder, and through the backstop the disposal module owns: a
      // `close` that throws here would otherwise leave the resource it was clearing
      // room for held by an object nothing will ever clean up.
      this.#disposal.disposeDiscarded(abandoned.value);
    }
  }

  /**
   * Confirm that a render carrying this pair reached the screen.
   *
   * The one thing this class cannot observe for itself. An addressing minted during a
   * render is a proposal — React decides whether that pass becomes a frame — so the
   * caller says so from the layout phase, the earliest moment the answer is known and
   * still before anything can be painted.
   *
   * THE VALUE THE PREVIOUS COMMIT SAW IS DROPPED AND NOT DISPOSED. A live effect is
   * holding it at this instant — that is what having been committed means — and it is
   * retired by the caller's own lifetime, on its own terms, once this frame reaches
   * it. Handing it to the disposal here would ask a caller to close what it is still
   * reading through.
   *
   * A commit naming a pair no provisional addressing carries confirms nothing and
   * ends any provisional there is: the pass that would have committed it is over.
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
   * End a provisional addressing no render will ever commit. Reached from
   * {@link address} and {@link commit} on every path a later pass proves the earlier
   * one over, and from the caller at the end of the mount, the one moment no later
   * pass is coming.
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
   * The value of the addressing being read NOW — the provisional one where a pass has
   * addressed a subject the last commit has not seen, and the committed one otherwise.
   *
   * Read it in the same pass that addressed: a value belongs to a subject, and a
   * reader that did not just say which subject it is about has no claim on the answer.
   *
   * Throws where nothing has been addressed yet, which is a composition error rather
   * than a state: the one caller is the hook, and it addresses during render before
   * it reads. A holder that answered `undefined` here would hand every consumer a
   * value the type says cannot exist.
   */
  public get value(): TValue {
    const reading = this.#provisional ?? this.#committed;
    if (reading === undefined) {
      throw new Error("A subject-scoped holder was read before it was addressed at a subject");
    }
    return reading.value;
  }

  /**
   * The addressing this render is reading, for the caller that memoizes a publisher.
   *
   * A publisher is bound to one addressing, so the question "is the publisher I
   * handed out still the live one" has exactly one honest answer, and it is this
   * number. The pair cannot stand in for it: React compares a memo's dependencies
   * against the last COMMITTED render's, so a pass can move what this render is
   * reading while leaving the pair equal — an A -> B -> A round-trip inside one
   * commit — and a publisher keyed on the pair alone then names a visit that is over.
   *
   * `NO_ADDRESSING` before anything is addressed, so a caller cannot key a memo on
   * a number that names no visit and then find it equal to one that does.
   */
  public get addressing(): number {
    return (this.#provisional ?? this.#committed)?.epoch ?? NO_ADDRESSING;
  }

  /** Subscribe to publishes. Returns an idempotent unsubscribe. */
  public subscribe(sink: () => void): Unsubscribe {
    return this.#changes.subscribe(sink);
  }

  /**
   * Return a publisher bound to the addressing that holds the pair a caller NAMES.
   *
   * The provisional addressing first and the committed one second, which is the order
   * a render reads in: the pass asking is the one that just addressed, so where it
   * carries a proposal of its own that is the visit its settlements are about.
   *
   * A pair this holder is not currently holding publishes NOWHERE, rather than
   * publishing later if the holder returns to it. The return is a second visit and
   * seeds a second value; admitting the first visit's answer into it is the defect
   * this reads an addressing to close.
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
   * Capture the visit ON SCREEN and return a publisher bound to it.
   *
   * For the caller with no fresh publisher to close over — a handler stored in a ref,
   * a class built once, an effect with an empty dependency list. Every one of those is
   * called OUTSIDE a render, and outside a render the only visit anything is reading
   * through is the committed one, so a provisional a pass left behind is deliberately
   * not what this names.
   *
   * A capture taken before anything has committed publishes nothing: there is no
   * visit it was about, so the publisher it hands back refuses every write rather than
   * throwing into a settlement path whose whole job is to be total — through the ONE
   * refusal path even then, since a second publisher that quietly ignored what it was
   * handed would be a second answer to what a refusal does, and on a holder built with
   * a disposal the two answers differ by a connection nobody closes.
   */
  public settle(): SubjectScopedPublish<TValue> {
    return this.#publisherForAddressing(this.#committed?.epoch ?? NO_ADDRESSING);
  }

  /**
   * The write path, admitted by one comparison: is that addressing still one held?
   *
   * The pair is not compared beside it and does not need to be — an addressing names
   * one visit to one pair, and the serial is never reissued — so there is a single
   * predicate here rather than two that could disagree. A publish keeps the addressing
   * it wrote under: settling neither promotes a provisional nor retires a committed
   * one.
   */
  #publisherForAddressing(epoch: number): SubjectScopedPublish<TValue> {
    return (next) => {
      const held = this.#heldAt(epoch);
      if (held === undefined) {
        // The subject moved while this call was out — or moved away and back, or the
        // pass that proposed this addressing was thrown away. Refusing the answer is
        // the whole point: it is about a visit nothing on screen is addressed at.
        this.#refusePublish(next);
        return;
      }
      const resolved =
        typeof next === "function" ? (next as (was: TValue) => TValue)(held.value) : next;
      if (Object.is(resolved, held.value)) {
        // A publish that changes nothing wakes nobody. Two acts settling into the
        // same value in one tick would otherwise render the surface twice for it.
        return;
      }
      const replaced = held.value;
      const written = { ...held, value: resolved };
      if (this.#provisional?.epoch === epoch) {
        this.#provisional = written;
      } else {
        this.#committed = written;
      }
      // AFTER the replacement is installed and BEFORE anybody is woken, which is the
      // ordering `address` states for the same reason: a disposal must not see a
      // half-written holder, and a subscriber must not be woken into a frame whose
      // predecessor is still open.
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

  /**
   * What becomes of a publish this holder refused.
   *
   * THE FUNCTION FORM IS REFUSED WITHOUT RUNNING, so there is nothing to dispose:
   * the update that would have produced a value never ran, and handing the caller
   * its own closure back would be a disposal of a resource that does not exist.
   * That is the whole of this method — what a disposed value costs and what it
   * reports is `unheld-value-disposal.ts`, which owns all three write moments
   * together so their sentences cannot drift apart.
   */
  #refusePublish(next: TValue | ((previous: TValue) => TValue)): void {
    if (typeof next === "function") {
      return;
    }
    this.#disposal.disposeRefused(next);
  }
}
