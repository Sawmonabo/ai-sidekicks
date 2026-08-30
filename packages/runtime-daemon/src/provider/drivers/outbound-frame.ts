// Provider-bound outbound text frames — driver-boundary neutralization and the
// runtime tripwire (Plan-005 T3.18, I-005-7).
//
// ---------------------------------------------------------------------------
// The hazard
// ---------------------------------------------------------------------------
//
// A provider CLI whose programmatic input surface ALSO parses client-side
// commands consumes a message whose first word is command-shaped and answers
// with a ZERO-TURN SUCCESS: a well-formed terminal frame carrying no error, no
// model attribution, and no token accounting. The participant's words never
// reach the model while every layer above reads a completed turn. Verified
// first-party against the pinned Claude build; see
// `docs/reference/provider-wire/claude.md` §Client-side command interception on
// the programmatic input surface for the measured discriminants this module's
// classifiers key on.
//
// ---------------------------------------------------------------------------
// Why the neutralization lives HERE and nowhere upstream
// ---------------------------------------------------------------------------
//
// The transform is TRANSPORT-ONLY. It changes the bytes handed to the provider
// process and NOTHING else: the participant's text is persisted, evented,
// replayed, rewound to, and rendered exactly as authored. Applying the
// transform in the composer, at queue admission, or at event append is a named
// pitfall — it would put a daemon-authored byte into the participant's own
// history, where a rollback target and an exported transcript would both carry
// it forever.
//
// The structural consequence, and the reason this module owns a frame TYPE
// rather than exporting a helper function: the drivers' transport ports accept
// `OutboundTextFrame` and nothing else, and `OutboundTextFrame` carries a
// `#private` field, so it is NOMINAL — no object literal can satisfy it and no
// driver module can mint one. A driver therefore cannot compose provider-bound
// text at all without routing through this module's writer. Coverage is
// structural, not a call-site checklist a later edit can quietly fall off.
//
// ---------------------------------------------------------------------------
// Why frame ORIGIN and not a capability flag
// ---------------------------------------------------------------------------
//
// A capability flag's undeclared state resolves fail-OPEN through Spec-005's
// undeclared-is-unsupported rule, which is backwards here: the dangerous
// default is "do not neutralize". `OutboundFrameOrigin` is therefore a closed
// discriminator on the frame itself whose ABSENT and UNRECOGNIZED arms both
// neutralize. It is deliberately daemon-local — it never crosses the wire and
// is never hoisted into `packages/contracts`, because no wire payload, event,
// or persisted row carries it.
//
// ---------------------------------------------------------------------------
// Why the tripwire asks for turn evidence and never for command dispatch
// ---------------------------------------------------------------------------
//
// The set of shapes a client-side command layer can emit is OPEN — one provider
// wraps its output in a `<local-command-stdout>` element and stamps a meta
// marker, another may do neither next release. A classifier that recognizes
// DISPATCH fails open the day that shape changes. So the classifier asks the
// only question with a closed answer: did a model turn demonstrably happen?
// Typed fields of the response envelope answer it; message prose is never read.

import { randomUUID } from "node:crypto";

// --------------------------------------------------------------------------
// Origin discriminator
// --------------------------------------------------------------------------

/**
 * Why a frame is being written, which decides whether its bytes may be
 * neutralized and whether its turn is subject to the tripwire.
 *
 * `driver_command` is the ONE arm the driver intends the provider's command
 * layer to consume — a leading `/` there is the payload, not a hazard — so it
 * is delivered verbatim on every grade and is exempt from the tripwire.
 *
 * The transcript pipeline's `RenderedFrameOrigin` is a type alias onto this
 * declaration, so one fail-closed discriminator has one spelling.
 */
export type OutboundFrameOrigin = "participant_text" | "driver_command" | "system_narration";

/** The closed origin set, for exhaustiveness checks and membership tests. */
export const OUTBOUND_FRAME_ORIGINS: readonly OutboundFrameOrigin[] = Object.freeze([
  "participant_text",
  "driver_command",
  "system_narration",
]);

/**
 * The origins a CALLER may name on text it asks a driver to write.
 *
 * `driver_command` is absent BY CONSTRUCTION. It is the single arm that both
 * suppresses neutralization and exempts the turn from the tripwire, so a field
 * a caller fills able to carry it is a route for participant text to be
 * delivered command-shaped AND then swallowed unwatched — the two halves of the
 * hazard at once. Only a driver's own command dispatch may claim that arm, from
 * a literal, in the module that composes the frame.
 *
 * Naming it as a type rather than validating it at each entry point is
 * deliberate: an in-process caller is held to it by the compiler, and the
 * boundaries that read an UNTYPED bag — where no type reaches — refuse the
 * exempt arm themselves.
 */
export type CallerDeclaredFrameOrigin = Exclude<OutboundFrameOrigin, "driver_command">;

/**
 * The origin value the tripwire's operator-visible detail may carry.
 *
 * `driver_command` is absent BY CONSTRUCTION rather than by omission: an exempt
 * frame never reaches a trip, so a detail naming it would be unreachable. An
 * off-union or absent origin composes the literal `unknown` — the writer never
 * echoes the caller's rejected value into a persisted, operator-visible string.
 */
export type TripwireDetailOrigin = "participant_text" | "system_narration" | "unknown";

/**
 * The parity mechanism grade for this leg's text-neutrality capability, read
 * from `Spec-005 §Parity Capability Mechanism Grades`.
 *
 * This is a behavioral INPUT, not a label: an `emulated` leg prepends the
 * sentinel to command-shaped text, a `native` leg emits the author's bytes
 * unchanged. Both pinned legs are `emulated` today, and a leg re-graded
 * `native` by amendment changes its declared grade here rather than its code.
 */
export type TextNeutralityMechanismGrade = "native" | "emulated";

// --------------------------------------------------------------------------
// The refusal code and its composed detail
// --------------------------------------------------------------------------

/**
 * Registered in `docs/architecture/contracts/error-contracts.md` §Driver at
 * 409. It rides NO JSON-RPC error envelope on any path: the run's own
 * `run.failed` terminal is the guarantee, and the intervention result's
 * `refusalCode` is a best-effort second surface.
 */
export const TEXT_NEUTRALIZATION_REFUSAL_CODE = "driver.text_neutralization_failed" as const;

export type TextNeutralizationRefusalCode = typeof TEXT_NEUTRALIZATION_REFUSAL_CODE;

/**
 * The V1 sentinel: a single leading newline — the least visible transform that
 * defeats the interception, measured rather than assumed.
 *
 * The escalation ladder, ordered by decreasing invisibility, is leading newline
 * -> leading space -> structural repositioning -> a visible documented prefix
 * -> a typed refusal. Invisible and zero-width sentinels (U+200B, U+2060,
 * variation selectors, Unicode tag characters) are PROHIBITED at every rung:
 * they are indistinguishable from an attack on a reader who diffs the bytes,
 * and they survive copy-paste into places no one can see them.
 */
export const OUTBOUND_TEXT_NEUTRALIZATION_SENTINEL = "\n";

/**
 * Composes the exact `providerFailureDetail` a trip lands on the run terminal.
 *
 * The form is FIXED — the code, one space, `origin=`, one of the three
 * `TripwireDetailOrigin` members — because two producers share that one field
 * and a consumer parses it. Nothing else is interpolated: no provider prose, no
 * caller-supplied value, no correlation id, because everything in this string
 * is persisted and operator-visible.
 */
export function composeTextNeutralizationFailureDetail(origin: TripwireDetailOrigin): string {
  return `${TEXT_NEUTRALIZATION_REFUSAL_CODE} origin=${origin}`;
}

// --------------------------------------------------------------------------
// The command-shaped predicate
// --------------------------------------------------------------------------

/**
 * The six ASCII whitespace bytes, named as bytes because that is the level the
 * predicate operates at.
 *
 * Deliberately NOT `String.prototype.trim`'s notion of whitespace, which spans
 * the Unicode `White_Space` property plus the BOM. A non-ASCII leading space is
 * therefore NOT skipped, so a no-break space followed by `/status` is not
 * command-shaped by this predicate. That is a considered narrowing rather
 * than an oversight: the predicate's job is to mirror what a provider's own
 * parser does on ASCII, and over-matching would neutralize text no provider
 * would have intercepted. The residual — a parser that DOES skip exotic
 * whitespace — is caught by the tripwire, the fail-closed backstop it belongs in.
 */
const ASCII_WHITESPACE_BYTES: ReadonlySet<number> = new Set([
  0x09, // horizontal tab
  0x0a, // line feed
  0x0b, // vertical tab
  0x0c, // form feed
  0x0d, // carriage return
  0x20, // space
]);

/** The byte a client-side command layer dispatches on. */
const COMMAND_LEAD_BYTE = 0x2f; // '/'

/**
 * True when the provider's command layer would dispatch on this text.
 *
 * Byte-level and locale-independent. It NEVER decodes, normalizes, case-folds,
 * or trims by Unicode rules, and it consults NO command-name list — the
 * measured interception is made on the leading byte upstream of any name
 * lookup, so `/etc/hosts`, `/foo:bar`, and `/zzqnotarealcommand` are all
 * command-shaped, and a mid-text `/` is not.
 */
export function isCommandShapedText(text: string): boolean {
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) {
      return false;
    }
    if (ASCII_WHITESPACE_BYTES.has(codePoint)) {
      continue;
    }
    return codePoint === COMMAND_LEAD_BYTE;
  }
  return false;
}

// --------------------------------------------------------------------------
// The frame
// --------------------------------------------------------------------------

/**
 * The module-private mint token.
 *
 * Runtime half of the structural guard: it is never exported, so no caller
 * outside this module can pass it, and `OutboundTextFrame`'s constructor
 * refuses without it. The compile-time half is the class's `#private` field,
 * which makes the type nominal so no object literal can be assigned to it.
 * Neither half alone is sufficient — the token stops a `Reflect.construct`, the
 * private field stops a structural cast.
 */
const FRAME_MINT_TOKEN: unique symbol = Symbol("outbound-text-frame-mint");

/**
 * One composed provider-bound text frame: the bytes to write, the origin that
 * decided them, and the daemon-minted correlation value the tripwire joins on.
 *
 * Instances come only from {@link OutboundTextFrameWriter}. A driver holds one
 * and reads `wireText`; it can neither construct one nor alter one.
 */
export class OutboundTextFrame {
  readonly #mintedByWriter: true;

  /** The author's bytes, unchanged — what is persisted, evented, and replayed. */
  readonly authoredText: string;

  /** The bytes to hand the provider process. Equal to `authoredText` unless neutralized. */
  readonly wireText: string;

  /** The declared origin, or `null` when the caller declared none or declared an off-union value. */
  readonly origin: OutboundFrameOrigin | null;

  /** The origin arm a trip on this frame would name. */
  readonly detailOrigin: TripwireDetailOrigin;

  /** True when this frame's turn is not subject to the tripwire. */
  readonly tripwireExempt: boolean;

  /** True when the sentinel was applied — i.e. `wireText !== authoredText`. */
  readonly neutralized: boolean;

  /** Daemon-minted, one per frame. Never sent to the provider; never persisted. */
  readonly correlationId: string;

  constructor(
    mintToken: symbol,
    init: {
      readonly authoredText: string;
      readonly wireText: string;
      readonly origin: OutboundFrameOrigin | null;
      readonly detailOrigin: TripwireDetailOrigin;
      readonly tripwireExempt: boolean;
      readonly neutralized: boolean;
      readonly correlationId: string;
    },
  ) {
    if (mintToken !== FRAME_MINT_TOKEN) {
      throw new Error(
        "An outbound provider text frame may be composed only by the driver-boundary frame writer.",
      );
    }
    this.#mintedByWriter = true;
    this.authoredText = init.authoredText;
    this.wireText = init.wireText;
    this.origin = init.origin;
    this.detailOrigin = init.detailOrigin;
    this.tripwireExempt = init.tripwireExempt;
    this.neutralized = init.neutralized;
    this.correlationId = init.correlationId;
    Object.freeze(this);
  }

  /** Reads the nominal marker, so the private field is used rather than merely declared. */
  get mintedByWriter(): boolean {
    return this.#mintedByWriter;
  }
}

// --------------------------------------------------------------------------
// The writer
// --------------------------------------------------------------------------

/** What a caller declares about the text it wants written. */
export interface OutboundTextFrameRequest {
  /** The author's text, verbatim. Never mutated by this module. */
  readonly text: string;
  /**
   * The declared origin. Typed as `string` rather than as the union so an
   * off-union value from an untyped daemon-side source is a RUNTIME state this
   * module classifies fail-closed, not a compile error that would push the
   * classification onto every caller.
   */
  readonly origin?: string | undefined;
}

export interface OutboundTextFrameWriterOptions {
  /** This leg's declared parity grade. See {@link TextNeutralityMechanismGrade}. */
  readonly mechanismGrade: TextNeutralityMechanismGrade;
  /** Correlation minting, injectable so a test can assert on stable values. */
  readonly mintCorrelationId?: (() => string) | undefined;
}

/**
 * The single composer of provider-bound text bytes.
 *
 * Stateful because it mints a correlation value per frame and holds the leg's
 * grade; a free function would have to take both on every call, which is how a
 * call site ends up passing the wrong grade.
 */
export class OutboundTextFrameWriter {
  readonly #mechanismGrade: TextNeutralityMechanismGrade;
  readonly #mintCorrelationId: () => string;

  constructor(options: OutboundTextFrameWriterOptions) {
    this.#mechanismGrade = options.mechanismGrade;
    this.#mintCorrelationId = options.mintCorrelationId ?? ((): string => randomUUID());
  }

  /** This leg's declared grade, exposed so a caller can report it without re-deriving it. */
  get mechanismGrade(): TextNeutralityMechanismGrade {
    return this.#mechanismGrade;
  }

  /**
   * Composes one frame.
   *
   * The three decisions, in order: classify the declared origin (absent or
   * off-union lands on the fail-closed arm); decide exemption (`driver_command`
   * alone); decide the bytes (neutralize only when the leg is `emulated`, the
   * frame is not exempt, and the text is command-shaped).
   */
  compose(request: OutboundTextFrameRequest): OutboundTextFrame {
    const origin = classifyOutboundFrameOrigin(request.origin);
    const tripwireExempt = origin === "driver_command";
    const neutralized =
      !tripwireExempt && this.#mechanismGrade === "emulated" && isCommandShapedText(request.text);
    return new OutboundTextFrame(FRAME_MINT_TOKEN, {
      authoredText: request.text,
      wireText: neutralized
        ? `${OUTBOUND_TEXT_NEUTRALIZATION_SENTINEL}${request.text}`
        : request.text,
      origin,
      detailOrigin: composeTripwireDetailOrigin(origin),
      tripwireExempt,
      neutralized,
      correlationId: this.#mintCorrelationId(),
    });
  }
}

/** Narrows a declared origin onto the closed union, or `null` when it is not a member. */
function classifyOutboundFrameOrigin(declared: string | undefined): OutboundFrameOrigin | null {
  if (declared === undefined) {
    return null;
  }
  const member = OUTBOUND_FRAME_ORIGINS.find((candidate) => candidate === declared);
  return member ?? null;
}

/** Maps a classified origin onto the arm a trip's detail may name. */
function composeTripwireDetailOrigin(origin: OutboundFrameOrigin | null): TripwireDetailOrigin {
  switch (origin) {
    case "participant_text":
    case "system_narration":
      return origin;
    // An exempt frame never reaches a trip, so its detail arm is unreachable
    // rather than absent; `unknown` is the safe value for the unreachable case.
    case "driver_command":
    case null:
      return "unknown";
  }
}

// --------------------------------------------------------------------------
// Turn evidence
// --------------------------------------------------------------------------

/**
 * The closed set of positive, TYPED evidence that a model turn happened.
 *
 * Each member is a different provider's way of saying the same thing, so the
 * tripwire's rule is one predicate over the set rather than a per-provider
 * branch:
 *
 *   `model_output`           — the response carries model-authored content.
 *   `turn_accounting`        — the provider billed, timed, or counted a turn.
 *   `declared_turn_failure`  — the provider declared a TYPED failure.
 *
 * The third member is the one that needs its reasoning stated. A turn that
 * fails for an unrelated reason (an exhausted quota, an exceeded context
 * window) produces no model output and no accounting, so a two-way rule would
 * trip on it and report a neutralization failure for a cause that is not one —
 * poisoning the shared `providerFailureDetail` field and sending an operator
 * to the wrong diagnosis. It does not fail open, because it requires a TYPED
 * declared failure to be PRESENT: a provider that silently swallows text
 * declares nothing, which is exactly the state this member does not cover.
 */
export type TurnEvidenceClass = "model_output" | "turn_accounting" | "declared_turn_failure";

/**
 * One leg's reading of a settling response envelope.
 *
 * `recognized: false` is a TRIP condition, not an abstention. A settling
 * envelope the driver cannot parse is indistinguishable, from here, from a
 * response the provider composed locally — and the fail-closed reading is the
 * only one that does not let an unrecognized shape become a silent swallow.
 */
export interface TurnEvidenceClassification {
  readonly recognized: boolean;
  readonly observations: readonly TurnEvidenceClass[];
}

/** A recognized envelope carrying the given evidence. */
export function observedTurnEvidence(
  ...observations: readonly TurnEvidenceClass[]
): TurnEvidenceClassification {
  return { recognized: true, observations: Object.freeze([...new Set(observations)]) };
}

/** A settling envelope this leg's classifier does not recognize. */
export const UNRECOGNIZED_TURN_EVIDENCE: TurnEvidenceClassification = Object.freeze({
  recognized: false,
  observations: Object.freeze([]),
});

// --------------------------------------------------------------------------
// The tripwire
// --------------------------------------------------------------------------

export type TripwirePassReason = "no-correlated-frame" | "frame-exempt" | "turn-evidence-observed";

export type TripwireTripCause = "no-turn-evidence" | "unrecognized-settling-envelope";

export interface TripwirePass {
  readonly tripped: false;
  readonly reason: TripwirePassReason;
}

export interface TripwireTrip {
  readonly tripped: true;
  readonly cause: TripwireTripCause;
  readonly correlationId: string;
  readonly detailOrigin: TripwireDetailOrigin;
  /** The exact composed `providerFailureDetail`. */
  readonly failureDetail: string;
  readonly refusalCode: TextNeutralizationRefusalCode;
}

export type TripwireDecision = TripwirePass | TripwireTrip;

/**
 * The run-terminal landing an UNPROVEN DELIVERY produces.
 *
 * One landing serves every path that reaches it — a run-opening frame and a
 * steer directive frame fail the run identically, and so does a frame whose
 * binding was taken away before the provider settled it. It mints no driver
 * event, no third driver-result status, no persisted column, and no state
 * transition: both `starting -> failed` and `running -> failed` are already
 * declared, so the terminal this composes is an existing one reached for a new
 * reason.
 *
 * What varies between the paths is `providerFailureDetail`, and the difference
 * is load-bearing rather than cosmetic. A trip's detail carries the registered
 * dotted code in a fixed parseable form and means "the provider swallowed a
 * turn". A supersede's does not and must not: nobody observed a swallow there,
 * only an answer that will now never come. Each composer below states its own
 * claim, and neither may borrow the other's.
 */
export interface UnprovenDeliveryRunFailure {
  readonly eventType: "run.failed";
  readonly failureCategory: "provider failure";
  readonly recoveryCondition: "recovery-needed";
  readonly providerFailureDetail: string;
}

/**
 * The trip's landing, which is one instance of {@link UnprovenDeliveryRunFailure}.
 *
 * An alias rather than a second declaration: the concept widened when the
 * supersede path arrived, the shape did not, and forking it would have given
 * two names to one record. Retained because it is the name the driver callback
 * surface and every existing producer already use.
 */
export type TextNeutralizationRunFailure = UnprovenDeliveryRunFailure;

/** Composes the run terminal for a trip. */
export function composeTextNeutralizationRunFailure(
  trip: TripwireTrip,
): UnprovenDeliveryRunFailure {
  return {
    eventType: "run.failed",
    failureCategory: "provider failure",
    recoveryCondition: "recovery-needed",
    providerFailureDetail: trip.failureDetail,
  };
}

/**
 * How a superseded frame's origin reads in the detail this composes.
 *
 * Prose rather than the trip's `origin=<token>` form, deliberately. That form is
 * a parseable contract two producers emit and a consumer reads, and it is bound
 * to the neutralization code; reusing its SHAPE here would invite a reader to
 * parse a supersede as a swallow. The two details are meant to be told apart at
 * a glance and by any parser.
 */
const SUPERSEDED_DELIVERY_ORIGIN_PHRASE: Readonly<Record<TripwireDetailOrigin, string>> =
  Object.freeze({
    participant_text: "a participant's text",
    system_narration: "system narration",
    unknown: "text of unrecorded origin",
  });

/**
 * Composes the run terminal for a frame whose binding was superseded before the
 * provider settled it.
 *
 * Carries NO dotted code, on the same reasoning as `OutboundFrameCapacityRefusedError`
 * below: the error registry has no row for this, and reusing the neutralization
 * code would state something the driver did not observe. What IS claimed is
 * exactly what is known — the words may or may not have reached the model, and
 * nothing will ever say which — and the run fails on it, because the alternative
 * is a participant's text disappearing behind a session that resumed cleanly.
 */
export function composeSupersededDeliveryRunFailure(
  origin: TripwireDetailOrigin,
): UnprovenDeliveryRunFailure {
  return {
    eventType: "run.failed",
    failureCategory: "provider failure",
    recoveryCondition: "recovery-needed",
    providerFailureDetail: `The provider binding carrying ${SUPERSEDED_DELIVERY_ORIGIN_PHRASE[origin]} for this run was superseded by a fresh spawn before the provider settled the turn, so whether those words reached the model was never established.`,
  };
}

/**
 * How many SETTLED keys the retained-decision map and the quarantine each hold.
 *
 * These three collections share ONE bound because they share one property:
 * every entry in them describes something that has already been ruled, so an
 * entry that ages out costs a best-effort answer and never a ruling. The
 * retained decision is the read the intervention path makes when it happens to
 * ask before the answer expires; the quarantine holds one entry per tripped run
 * and one per tripped session, and a tripped run is already terminal while a
 * tripped session is released the moment a fresh process takes its id — so an
 * aged-out entry cannot revive either. What expires is only the fail-fast
 * refusal an immediate re-attach would have hit.
 *
 * The UNSETTLED store deliberately does NOT share this bound, and does not
 * evict at all. See {@link OUTBOUND_FRAME_PENDING_SCOPE_CAPACITY}.
 */
const OUTBOUND_FRAME_SETTLED_KEY_MEMORY = 64;

/**
 * How many UNSETTLED frames ONE registration scope may hold at once.
 *
 * SCOPED PER PROVIDER SESSION, not per manager, and that is the correction this
 * bound exists to make. The pending store is keyed by a correlation value the
 * daemon mints per frame, and one tripwire serves every session on its driver —
 * so a single manager-wide bound let one runaway session consume the whole
 * budget and answer for the frames of every other session on the node. A
 * per-scope ceiling makes the blast radius of a session that never settles a
 * turn exactly that session.
 *
 * Sixteen is generous against the real load and pathological beyond it. A turn
 * is opened by ONE frame and then takes however many steer directives a
 * participant issues before it settles; both providers serialize turns on a
 * session, so the live set is a handful of frames on one turn rather than one
 * per turn. A scope holding sixteen frames that no turn has accounted for is
 * not a busy session, it is a session whose turns are not settling.
 */
export const OUTBOUND_FRAME_PENDING_SCOPE_CAPACITY: number = 16;

/**
 * The global backstop across every scope one tripwire serves.
 *
 * The per-scope ceiling alone bounds nothing at the manager level: a driver
 * with a thousand sessions could hold sixteen thousand pending frames while
 * every scope stayed individually within its cap. This is the second bound, and
 * it is deliberately far above any healthy state — a node running more than a
 * handful of concurrent provider sessions per driver is already past what V1
 * ships for, so reaching this figure means frames are not settling anywhere,
 * not that the node is busy.
 */
export const OUTBOUND_FRAME_PENDING_TOTAL_CAPACITY: number = 256;

/**
 * Caps an insertion-ordered SETTLED-key collection, evicting oldest-first.
 *
 * Callers `delete` before `set` / `add` so a re-used key moves to the newest
 * position rather than ageing out while still live.
 *
 * Deliberately NOT used on the unsettled store. Evicting there discards a
 * ruling that is still owed, and a turn that later settles against the evicted
 * frame finds no correlation and PASSES — the swallowed turn reported as a
 * completed one, which is the whole outcome this module exists to catch.
 */
function evictOldestBeyondCapacity(keyed: {
  readonly size: number;
  keys(): IterableIterator<string>;
  delete(key: string): boolean;
}): void {
  while (keyed.size > OUTBOUND_FRAME_SETTLED_KEY_MEMORY) {
    const oldest = keyed.keys().next();
    if (oldest.done === true) {
      return;
    }
    keyed.delete(oldest.value);
  }
}

/** One frame's ruling from {@link OutboundFrameTripwire.settleScope}. */
export interface ScopeFrameRuling {
  /**
   * The key the frame was correlated to when its binding went away — a run id
   * for a frame the provider had not yet named a turn for, a turn id after.
   */
  readonly joinKey: string;
  readonly decision: TripwireDecision;
}

/** One frame's abandonment from {@link OutboundFrameTripwire.abandonScope}. */
export interface AbandonedFrameDelivery {
  /**
   * The key the frame was correlated to when its binding went away — a run id
   * for a frame the provider had not yet named a turn for, a turn id after. The
   * same vocabulary {@link ScopeFrameRuling} uses, for the same reason: it is the
   * only handle the caller can resolve a run from.
   */
  readonly joinKey: string;
  readonly detailOrigin: TripwireDetailOrigin;
}

interface PendingCorrelatedFrame {
  readonly frame: OutboundTextFrame;
  /**
   * The provider binding this frame was written on — a session id on both legs.
   *
   * Carried per frame rather than derived, because the join key is not it: a
   * frame is registered under a run id and re-keyed onto a turn id, and neither
   * names the binding whose disposal makes the frame unrulable. It is what the
   * per-scope bound counts and what {@link OutboundFrameTripwire.forgetScope}
   * and the reclamation pass both select on.
   */
  readonly scopeKey: string;
  /**
   * The key the settling turn will carry.
   *
   * MUTABLE, and the only mutable field here: `recorrelateFrame` re-keys a
   * frame registered under a run id onto the turn id the provider names, and
   * the frame's own correlation value — which is what the store is keyed by —
   * does not move with it.
   */
  joinKey: string;
  /** The declared part this frame plays in its turn — see the attribution rule. */
  readonly frameRole: OutboundFrameRole;
  readonly observations: Set<TurnEvidenceClass>;
  /**
   * Whether the provider ANSWERED this frame's own request. MUTABLE, set once
   * by `recordRequestAnswered`. Proof the provider TOOK the frame — the
   * strongest per-frame statement the transport makes — and NOT proof the
   * model read its text; see the attribution rule's conjunction residual.
   */
  requestAnswered: boolean;
}

/**
 * Folds one frame's decision into the aggregate a settling turn answers with.
 *
 * A trip WINS and the FIRST trip is kept, so the aggregate names the oldest
 * frame the turn failed to account for rather than the newest. Between two
 * passes, observed evidence beats exemption: both are passes, and the reason a
 * caller reads should describe the turn rather than whichever frame happened to
 * be enumerated last.
 */
function foldTripwireDecision(carried: TripwireDecision, next: TripwireDecision): TripwireDecision {
  if (carried.tripped) {
    return carried;
  }
  if (next.tripped) {
    return next;
  }
  return next.reason === "turn-evidence-observed" ? next : carried;
}

/**
 * The part a frame plays in the turn it is correlated to.
 *
 * `turn-opening` — the frame whose text the turn exists to answer. The turn's
 * stream items and its settling envelope are evidence about THIS frame, and a
 * transport-level acknowledgment can never vouch for it: the zero-turn hazard
 * is precisely a request acknowledged as taken and then answered with an empty
 * turn, so an ack-vouched opener would pass in exactly the case the tripwire
 * exists to catch.
 *
 * `turn-joining` — a frame written into a turn that already exists (a steer
 * directive). Stream items carry no frame attribution, so none of them can
 * vouch for it; the one per-frame statement the transport produces is the
 * provider's answer to the frame's own request, recorded via
 * {@link OutboundFrameTripwire.recordRequestAnswered}.
 */
export type OutboundFrameRole = "turn-opening" | "turn-joining";

/** One frame's registration with the tripwire that will rule on it. */
export interface OutboundFrameRegistration {
  /**
   * The provider binding this frame is written on — a session id on both legs.
   *
   * NOT the join key and not derivable from it: the join key is a run id that
   * later becomes a turn id, and neither names the binding whose disposal makes
   * the frame unrulable. It is what the per-binding capacity counts, so a
   * session whose turns stop settling exhausts its own budget and no other's.
   */
  readonly scopeKey: string;
  /** The key the settling turn will carry — a run id or a provider turn id. */
  readonly joinKey: string;
  /**
   * Which part this frame plays in its turn, DECLARED by the caller rather
   * than inferred from registration order: a recorrelated turn-joining frame
   * can end up insertion-ordered ahead of a later turn's opening frame, so
   * order encodes nothing about who opened which turn. The role decides which
   * evidence can vouch for the frame — see the attribution rule on the class.
   */
  readonly frameRole: OutboundFrameRole;
  readonly frame: OutboundTextFrame;
}

export interface OutboundFrameTripwireOptions {
  /**
   * Whether a binding is retired — disposed, quarantined, or torn down.
   *
   * Consulted ONLY on the capacity path, to reclaim registrations that can no
   * longer be settled by anything. Supplying it is what lets a driver whose
   * session died mid-turn recover the budget those frames hold instead of
   * refusing the next write; omitting it costs only that reclamation, never a
   * ruling. It MUST be a pure read of driver-local state: it is called inside
   * a write path, and it is called at most once per distinct binding per pass.
   */
  readonly isScopeRetired?: (scopeKey: string) => boolean;
}

/**
 * Correlates written frames with the turns that settle them, and rules on each.
 *
 * The join key is DAEMON-SIDE, never a wire-carried value: one provider hands
 * back a turn id at dispatch and the other hands back nothing at all, so a
 * design that needed a provider-minted id would work on exactly one leg. Each
 * driver supplies the key it can actually produce — a run id or a provider turn
 * id — and this class stays provider-neutral.
 *
 * Decisions are RETAINED after settlement so the intervention path can ask
 * whether the turn it just steered has already tripped. That is the whole of
 * `refusalCode`'s best-effort character: the driver never holds an intervention
 * call open waiting for a turn to settle, so it reports the refusal on the
 * result only when the answer is already known, and the run terminal carries
 * the guarantee in every other case.
 *
 * ---------------------------------------------------------------------------
 * One turn carries MANY frames, and each keeps its own correlation state
 * ---------------------------------------------------------------------------
 *
 * A turn is opened by one frame and can then take any number of steer
 * directives, all correlated to the same turn. The store is therefore keyed by
 * the frame's own daemon-minted correlation value and NOT by the join key: a
 * one-frame-per-key store made a steer REPLACE the opening frame and its
 * accumulated observations, so evidence produced before the steer could vouch
 * for the steer, and the steer's own registration could trip the turn the
 * opening frame had already been confirmed on. Both failures are silent.
 *
 * THE ATTRIBUTION RULE, stated once because every reader is load-bearing:
 *
 *   * A provider's stream items and its settling envelope's observations carry
 *     no frame attribution — nothing in either says WHICH written frame caused
 *     an item — so they are evidence about exactly one frame: the one whose
 *     role declares it opened the turn (`frameRole: "turn-opening"`). Every
 *     positional substitute for that declaration was a guess with a silent
 *     failure mode. Crediting every pending frame let output caused by an
 *     already-vouched directive vouch a later one the provider swallowed.
 *     Crediting the oldest-unevidenced frame moved the same guess: a DELAYED
 *     item from the opener's own output credited the steer written after it —
 *     the swallowed steer passed behind a green terminal — while a delivered
 *     steer that produced no further item tripped a healthy session.
 *   * A turn-joining frame (`frameRole: "turn-joining"`) is consumed on the
 *     provider's answer to ITS OWN request, recorded via
 *     `recordRequestAnswered` — the one per-frame statement the transport
 *     produces. An answered request proves the provider TOOK the frame, not
 *     that the model read its text, so it is a declared coverage boundary
 *     rather than delivery proof. A joined frame whose request was never
 *     answered holds no evidence and trips at its turn's settlement,
 *     deterministically: request unanswered is the fail-closed arm, not a
 *     coin flip on item timing.
 *   * The envelope's `recognized` flag is a property of the envelope rather
 *     than of any item in it, so it applies to every frame: an unparsable
 *     terminal trips them all, acknowledged or not — a zero-turn settlement
 *     means the TURN was swallowed, and no frame's delivery outranks that.
 *
 * The residual this boundary accepts is a CONJUNCTION, and every conjunct is
 * required: the joined frame's wire text survived `compose` in
 * command-effective shape (the same neutralization every non-exempt frame
 * takes before these bytes exist), AND the provider answered the request as
 * taken, AND an interception layer then dropped the text before the model —
 * on a request path where the watched surface is not known to parse client
 * commands at all (its command parsing lives in the interactive frontends).
 * No daemon-side rule can split that conjunction, because the answer is the
 * transport's last per-frame statement. The turn-level swallow stays covered
 * regardless: a zero-turn settlement trips the turn-opening frame, and an
 * unrecognized envelope trips every frame, answered or not.
 *
 * The Claude leg additionally spreads one terminal across several correlated
 * RUNS, positionally and for the same reason. That rule composes above this one
 * rather than duplicating it: on that leg each run key holds exactly one frame,
 * so the two never overlap. Not an assumption — that leg's `startRun` refuses a
 * dispatch whose run key already holds a pending frame (`run_already_dispatched`)
 * before it composes or registers anything, because a second frame under one key
 * would be attributed `UNRECOGNIZED_TURN_EVIDENCE` here and trip the session
 * over a duplicate dispatch rather than a swallowed participant.
 */
export class OutboundFrameTripwire {
  /**
   * Keyed by the frame's correlation value, insertion-ordered — so iteration
   * yields frames oldest-registered first, which is the order the attribution
   * rule and the trip fold both read.
   */
  readonly #pendingByCorrelationId = new Map<string, PendingCorrelatedFrame>();
  readonly #decisionByJoinKey = new Map<string, TripwireDecision>();
  readonly #isScopeRetired: ((scopeKey: string) => boolean) | undefined;

  constructor(options: OutboundFrameTripwireOptions = {}) {
    this.#isScopeRetired = options.isScopeRetired;
  }

  /**
   * Registers a written frame against the key its settling turn will carry.
   *
   * MUST be called BEFORE the bytes go out, and its refusal MUST abort the
   * write. A frame this store did not accept is a frame no turn can be ruled
   * against, and a turn that settles with no correlated frame PASSES — so a
   * write that outran its registration is exactly the swallowed turn reported
   * as a completed one that the tripwire exists to catch.
   *
   * An exempt frame is registered too, rather than dropped: a later `settle`
   * must be able to say WHY it passed, and a dropped registration would be
   * indistinguishable from a frame that was never written.
   *
   * APPENDS rather than replaces. Any frame already pending under this key is
   * left exactly as it is, observations included.
   *
   * @throws {OutboundFrameCapacityRefusedError} when the scope or the tripwire
   *   is at capacity and no registration could be reclaimed. Nothing already
   *   pending is discarded to make room — see the module bounds.
   */
  register(registration: OutboundFrameRegistration): void {
    const { scopeKey, joinKey, frameRole, frame } = registration;
    if (!this.#pendingByCorrelationId.has(frame.correlationId)) {
      this.#admit(scopeKey);
    }
    this.#pendingByCorrelationId.delete(frame.correlationId);
    this.#pendingByCorrelationId.set(frame.correlationId, {
      frame,
      scopeKey,
      joinKey,
      frameRole,
      observations: new Set(),
      requestAnswered: false,
    });
    this.#decisionByJoinKey.delete(joinKey);
  }

  /**
   * Records in-flight evidence for a correlated turn.
   *
   * Evidence accrues across a turn rather than being read only off the settling
   * frame: one leg's terminal notification carries the whole item list and the
   * other's does not, so an accumulating tripwire works on both without either
   * classifier having to reconstruct what it did not see.
   *
   * Credited to the TURN-OPENING frame under the key and to no other — which is
   * how the attribution rule is ENCODED rather than merely described. An item
   * carries no frame attribution, so any rule that hands items to turn-joining
   * frames is guessing: crediting every pending frame let output caused by an
   * already-vouched directive vouch a later one the provider swallowed, and
   * crediting the oldest-unevidenced frame merely moved the same guess — a
   * DELAYED item from the opener's own output credited the steer written after
   * it, and the swallowed steer passed behind it, while a delivered steer that
   * happened to produce no further item tripped. A turn-joining frame is
   * consumed on the provider's answer to its own request
   * (`recordRequestAnswered`).
   */
  observe(joinKey: string, observation: TurnEvidenceClass): void {
    for (const pending of this.#pendingByCorrelationId.values()) {
      if (pending.joinKey === joinKey && pending.frameRole === "turn-opening") {
        pending.observations.add(observation);
        return;
      }
    }
  }

  /**
   * Records that the provider ANSWERED one frame's own request — the per-frame
   * statement a turn-joining frame is consumed on at its turn's settlement.
   *
   * An answered request proves the provider took the frame, not that the model
   * read its text; the coverage boundary that record draws, and its conjunction
   * residual, are stated on the class. A no-op for a frame that is no longer
   * pending: a frame already ruled is owed nothing further. A no-op —
   * deliberately, and fail-closed — for a TURN-OPENING frame: the zero-turn
   * hazard is a request answered as taken and met with an empty turn, so an
   * answered request can never vouch for the frame the turn exists to answer;
   * ignoring the call leaves that frame to the turn evidence it is properly
   * ruled on.
   */
  recordRequestAnswered(frame: OutboundTextFrame): void {
    const pending = this.#pendingByCorrelationId.get(frame.correlationId);
    if (pending === undefined || pending.frameRole === "turn-opening") {
      return;
    }
    pending.requestAnswered = true;
  }

  /**
   * Re-keys ONE pending registration once the provider names the turn its
   * bytes opened.
   *
   * Frame-scoped rather than key-wide, and it has to be: a run id is the key
   * every attempt on that run registers under, so re-keying the KEY would
   * carry a concurrent attempt's frame onto a turn it never opened and leave
   * the attempt that did open that turn with nothing correlated — and a turn
   * that settles against no correlated frame PASSES. Naming the frame keeps
   * each attempt's ruling its own.
   *
   * A no-op for a frame that is no longer pending. A frame already settled,
   * forgotten, or reclaimed is owed no further correlation, and re-admitting
   * it here would resurrect a registration the store has already answered for.
   *
   * The frame keeps its declared role, every observation it has accrued, and
   * any recorded answered request, so the evidence that will rule it survives
   * the move unchanged.
   *
   * NEITHER key's retained decision is touched. This is a MOVE, not a fresh
   * attempt: `register` clears the destination because a new write is starting
   * there, while a settled turn's ruling is a property of the turn and outlives
   * any one frame arriving at or leaving it — the rule `forgetFrame` and
   * `forgetScope` already state. Clearing the destination here would erase
   * exactly the ruling the intervention path reads back when an acknowledged
   * steer names a turn that has already settled.
   *
   * A CALLER OBLIGATION, and the one this method cannot discharge: a frame
   * moved onto an ALREADY-settled turn can never be ruled — no second terminal
   * for that turn is coming — so it would sit as occupancy until its binding's
   * scope is released, which is silence in the case that warrants the loudest
   * answer. Refusing the move here is not possible, because this store cannot
   * tell a settled key from a live one: a turn that settles with nothing
   * correlated to it returns before any decision is retained, so it leaves no
   * trace here at all. Each caller therefore establishes that its destination
   * is still live from the settlement record its own driver keeps, and rules
   * the frame itself when it is not — the Codex run-opening path by replaying
   * the terminal its session remembered onto the re-keyed frame, and the steer
   * path by refusing the move and consuming the frame on its own recorded
   * answered request.
   */
  recorrelateFrame(frame: OutboundTextFrame, toJoinKey: string): void {
    const pending = this.#pendingByCorrelationId.get(frame.correlationId);
    if (pending === undefined) {
      return;
    }
    pending.joinKey = toJoinKey;
  }

  /**
   * Rules on every frame correlated to a settling turn and consumes their
   * registrations, so a second terminal for the same turn cannot trip twice.
   */
  settle(joinKey: string, classification: TurnEvidenceClassification): TripwireDecision {
    const pendingFrames = this.#pendingFramesFor(joinKey);
    if (pendingFrames.length === 0) {
      return { tripped: false, reason: "no-correlated-frame" };
    }
    let aggregate: TripwireDecision = { tripped: false, reason: "frame-exempt" };
    for (const pending of pendingFrames) {
      this.#pendingByCorrelationId.delete(pending.frame.correlationId);
      aggregate = foldTripwireDecision(
        aggregate,
        this.#rule(pending, classification, pending.frameRole === "turn-opening"),
      );
    }
    this.#decisionByJoinKey.delete(joinKey);
    this.#decisionByJoinKey.set(joinKey, aggregate);
    evictOldestBeyondCapacity(this.#decisionByJoinKey);
    return aggregate;
  }

  /**
   * Rules on ONE frame and consumes only that registration, leaving every other
   * frame on its turn correlated and still owed its own ruling.
   *
   * The counterpart of `settle` for the case where a SINGLE frame's delivery
   * became unknowable while its turn stayed open — a write the host rejected
   * mid-flight, or a response phase that died with the connection. `settle`
   * cannot serve that case: an unrecognized classification trips EVERY frame on
   * the key, so a turn whose opening frame was answered and observed would be
   * reported swallowed, naming a correlation id there is positive evidence for.
   * Ruling the uncertain frame alone keeps the report attributable to the frame
   * whose delivery is actually in doubt.
   *
   * Deliberately does NOT write the retained decision: the turn has not
   * settled, and storing a trip under its key would make `decisionFor` answer
   * "swallowed" for a turn whose other frames are still live and may yet pass.
   */
  settleFrame(
    frame: OutboundTextFrame,
    classification: TurnEvidenceClassification,
  ): TripwireDecision {
    const pending = this.#pendingByCorrelationId.get(frame.correlationId);
    if (pending === undefined) {
      return { tripped: false, reason: "no-correlated-frame" };
    }
    this.#pendingByCorrelationId.delete(frame.correlationId);
    // The envelope never vouches here: this frame is being ruled outside any
    // settling envelope, so the classification's observations are attributable
    // to nobody. Its own accrued evidence — observations for a turn-opening
    // frame, a recorded answered request for a turn-joining one — still counts.
    return this.#rule(pending, classification, false);
  }

  /**
   * Whether any written frame is still awaiting its settling turn.
   *
   * Read by a driver that must decide WHICH of several correlated keys a single
   * terminal accounts for: routes and registrations are different sets — a run
   * whose failed write was already ruled here keeps its route so that a later
   * attach is REFUSED rather than answered `undefined`, while its registration
   * is gone — so ordering the decision by route would let a run with nothing
   * pending consume the evidence a live one needed.
   */
  hasPendingFrame(joinKey: string): boolean {
    for (const pending of this.#pendingByCorrelationId.values()) {
      if (pending.joinKey === joinKey) {
        return true;
      }
    }
    return false;
  }

  /**
   * Whether ANY frame is still pending under a scope, whatever its key.
   *
   * Deliberately not the same question as {@link hasPendingFrame}: on a leg
   * whose settling envelope carries no join identity (Claude), the terminal's
   * real classification can only ever be credited within one key at a time, so
   * admitting a second key's frame into a scope that still holds one would
   * manufacture exactly the cross-key ambiguity the settle path then rules
   * fail-closed. The session-serialization guard asks this question before the
   * frame exists.
   */
  hasPendingFrameInScope(scopeKey: string): boolean {
    for (const pending of this.#pendingByCorrelationId.values()) {
      if (pending.scopeKey === scopeKey) {
        return true;
      }
    }
    return false;
  }

  /** The retained decision for a settled turn, or `undefined` while it is still open. */
  decisionFor(joinKey: string): TripwireDecision | undefined {
    return this.#decisionByJoinKey.get(joinKey);
  }

  /** Drops all state for a key — used when a run's binding is torn down. */
  forget(joinKey: string): void {
    for (const pending of this.#pendingFramesFor(joinKey)) {
      this.#pendingByCorrelationId.delete(pending.frame.correlationId);
    }
    this.#decisionByJoinKey.delete(joinKey);
  }

  /**
   * Drops ONE frame's registration, leaving every other frame on its turn
   * correlated.
   *
   * The counterpart of `register` for a send that PROVABLY never reached the
   * wire — refused ahead of the write, or unencodable — and it has to be
   * frame-scoped: no turn will ever account for that frame, but the frame that
   * OPENED the turn is still live and still owed a ruling, and dropping the
   * whole key would silence it. Leaving the unsent frame registered instead
   * would trip the turn and dispose a binding that swallowed nothing.
   *
   * Reserved for that provably-unsent class, and callers must classify before
   * reaching for it: a send whose bytes may have been taken and whose failure
   * therefore says nothing about delivery has to be RETAINED and ruled instead
   * — see `settleFrame`. Forgetting there is how a swallowed directive escapes.
   *
   * The retained decision is deliberately untouched: a settled turn's ruling is
   * a property of the turn, not of any one frame withdrawn from it.
   */
  forgetFrame(frame: OutboundTextFrame): void {
    this.#pendingByCorrelationId.delete(frame.correlationId);
  }

  /**
   * Rules on every frame still pending on one provider binding and consumes
   * their registrations, returning each ruling beside the key it was owed on.
   *
   * The counterpart of `forgetScope` for a binding being taken away from turns
   * that are still LIVE — a session quarantined by a trip, or superseded by a
   * resume. `forgetScope` is right only where no turn on the binding could ever
   * settle anyway and the frames are pure occupancy; where the turns were still
   * running, dropping their frames converts "we never learned whether these
   * words were delivered" into silence, which is the swallowed-turn outcome
   * this class exists to make loud. The caller rules them instead, and reports.
   *
   * Each frame is ruled ALONE and the envelope vouches for none of them,
   * exactly as `settleFrame` rules and for the same reason: no settling envelope
   * is present here, so no envelope's observations are attributable to any of
   * them. The join key rides out with each decision because it is the only
   * handle the caller can resolve a run from — a frame is keyed by run id until
   * the provider names its turn and by turn id afterwards.
   *
   * Writes no retained decision, again as `settleFrame` does: no turn settled,
   * and storing a trip under a turn key would answer `decisionFor` with a
   * verdict the provider never actually delivered a terminal for.
   */
  settleScope(
    scopeKey: string,
    classification: TurnEvidenceClassification,
  ): readonly ScopeFrameRuling[] {
    const rulings: ScopeFrameRuling[] = [];
    for (const [correlationId, pending] of this.#pendingByCorrelationId) {
      if (pending.scopeKey !== scopeKey) {
        continue;
      }
      this.#pendingByCorrelationId.delete(correlationId);
      rulings.push({
        joinKey: pending.joinKey,
        decision: this.#rule(pending, classification, false),
      });
    }
    return rulings;
  }

  /**
   * Drops every pending registration written on one provider binding.
   *
   * Called where a binding is torn down or superseded — the point past which
   * no turn on it can ever settle, so the frames it left behind are owed no
   * ruling and are pure occupancy. Reclaiming them here is what keeps a
   * session that died mid-turn from spending its scope's budget forever.
   *
   * Retained DECISIONS are deliberately untouched: they are keyed by turn and
   * read back by the intervention path after the binding is gone, which is the
   * one moment a caller most needs to know the turn it steered had tripped.
   */
  forgetScope(scopeKey: string): void {
    for (const [correlationId, pending] of this.#pendingByCorrelationId) {
      if (pending.scopeKey === scopeKey) {
        this.#pendingByCorrelationId.delete(correlationId);
      }
    }
  }

  /**
   * Consumes every pending registration on one binding and reports the frames
   * whose delivery was left UNPROVEN.
   *
   * The third disposal, between `settleScope` and `forgetScope`, and it exists
   * because the gap between those two is real. `forgetScope` is right where no
   * turn could ever settle and the frames are pure occupancy. `settleScope` is
   * right where the binding was condemned BECAUSE text was swallowed — it mints
   * `TripwireTrip`s, and a trip's detail carries the registered dotted code and
   * asserts a swallow. A binding SUPERSEDED by a fresh spawn is neither: the
   * turns were live, so their frames are owed an answer, but nothing observed a
   * swallow, so the trip's claim is unsupportable. Manufacturing one would trade
   * a silent loss for a false accusation, and both are worse than the truth.
   *
   * So this returns facts and no verdict. The caller composes the terminal —
   * `composeSupersededDeliveryRunFailure` is what states the honest cause — and
   * this method mints no `TripwireTrip`, sets no refusal code, and quarantines
   * nothing. A superseded run is not condemned; the fresh binding is exactly
   * where its future work belongs.
   *
   * Exempt frames are consumed and NOT reported, matching `#rule`'s own first
   * test: a `driver_command` carries no participant words, so its disappearance
   * costs nobody their turn. A frame whose request was ANSWERED is reported
   * like any other: an answered request proves the provider took the frame,
   * not that the model read its text, and a turn that died unsettled never
   * reached the settlement that consumes the frame on that answer — so
   * "delivery left unproven" is exactly true of it.
   *
   * Writes no retained decision, as `settleScope` does not: no turn settled.
   */
  abandonScope(scopeKey: string): readonly AbandonedFrameDelivery[] {
    const abandoned: AbandonedFrameDelivery[] = [];
    for (const [correlationId, pending] of this.#pendingByCorrelationId) {
      if (pending.scopeKey !== scopeKey) {
        continue;
      }
      this.#pendingByCorrelationId.delete(correlationId);
      if (pending.frame.tripwireExempt) {
        continue;
      }
      abandoned.push({ joinKey: pending.joinKey, detailOrigin: pending.frame.detailOrigin });
    }
    return abandoned;
  }

  /**
   * How many unsettled frames one binding is holding.
   *
   * A scan rather than a maintained counter, deliberately: the store is capped
   * at a few hundred entries and this runs once per frame written — beside a
   * subprocess round trip — while a counter would have to be kept exact across
   * `settle`, `forget`, `forgetFrame`, and `forgetScope`, and a drifted counter
   * refuses writes that should have been admitted.
   */
  pendingFrameCountForScope(scopeKey: string): number {
    let count = 0;
    for (const pending of this.#pendingByCorrelationId.values()) {
      if (pending.scopeKey === scopeKey) {
        count += 1;
      }
    }
    return count;
  }

  /** How many unsettled frames this tripwire is holding across every binding. */
  get pendingFrameCount(): number {
    return this.#pendingByCorrelationId.size;
  }

  /**
   * Admits one new registration, or refuses.
   *
   * Prune-then-refuse, in that order and never evict: the only registrations
   * this reclaims are ones whose provider binding is gone, which is the one
   * class of entry that is provably owed no ruling. Everything else is a frame
   * whose turn may still settle, and discarding one to make room converts a
   * future trip into a silent pass.
   */
  #admit(scopeKey: string): void {
    if (this.#hasRoomForScope(scopeKey)) {
      return;
    }
    this.#reclaimRetiredScopes();
    if (this.#hasRoomForScope(scopeKey)) {
      return;
    }
    throw new OutboundFrameCapacityRefusedError(
      scopeKey,
      this.pendingFrameCountForScope(scopeKey),
      this.#pendingByCorrelationId.size,
    );
  }

  #hasRoomForScope(scopeKey: string): boolean {
    return (
      this.#pendingByCorrelationId.size < OUTBOUND_FRAME_PENDING_TOTAL_CAPACITY &&
      this.pendingFrameCountForScope(scopeKey) < OUTBOUND_FRAME_PENDING_SCOPE_CAPACITY
    );
  }

  /**
   * Reclaims the registrations of bindings the driver reports retired.
   *
   * The verdict is memoized for the pass so a store full of frames from a
   * handful of sessions asks the driver once per session rather than once per
   * frame, and a predicate that THROWS is contained as "not retired" — a
   * question that could not be answered has not proven a binding dead, and
   * reclaiming on an unproven answer is the eviction this method exists to
   * avoid.
   */
  #reclaimRetiredScopes(): void {
    const isScopeRetired = this.#isScopeRetired;
    if (isScopeRetired === undefined) {
      return;
    }
    const retiredByScopeKey = new Map<string, boolean>();
    for (const [correlationId, pending] of this.#pendingByCorrelationId) {
      let retired = retiredByScopeKey.get(pending.scopeKey);
      if (retired === undefined) {
        try {
          retired = isScopeRetired(pending.scopeKey);
        } catch {
          retired = false;
        }
        retiredByScopeKey.set(pending.scopeKey, retired);
      }
      if (retired) {
        this.#pendingByCorrelationId.delete(correlationId);
      }
    }
  }

  /** Every frame correlated to a key, oldest registration first. */
  #pendingFramesFor(joinKey: string): PendingCorrelatedFrame[] {
    const correlated: PendingCorrelatedFrame[] = [];
    for (const pending of this.#pendingByCorrelationId.values()) {
      if (pending.joinKey === joinKey) {
        correlated.push(pending);
      }
    }
    return correlated;
  }

  #rule(
    pending: PendingCorrelatedFrame,
    classification: TurnEvidenceClassification,
    envelopeVouchesForFrame: boolean,
  ): TripwireDecision {
    if (pending.frame.tripwireExempt) {
      return { tripped: false, reason: "frame-exempt" };
    }
    if (!classification.recognized) {
      return this.#trip(pending.frame, "unrecognized-settling-envelope");
    }
    // The settling envelope's observations are attributable only to the frame
    // that OPENED the settling turn — see the attribution rule on the class. A
    // turn-joining frame is consumed on the provider's recorded answer to its
    // own request: a declared coverage boundary, not delivery proof.
    const hasEvidence =
      pending.observations.size > 0 ||
      pending.requestAnswered ||
      (envelopeVouchesForFrame && classification.observations.length > 0);
    if (hasEvidence) {
      return { tripped: false, reason: "turn-evidence-observed" };
    }
    return this.#trip(pending.frame, "no-turn-evidence");
  }

  #trip(frame: OutboundTextFrame, cause: TripwireTripCause): TripwireTrip {
    return {
      tripped: true,
      cause,
      correlationId: frame.correlationId,
      detailOrigin: frame.detailOrigin,
      failureDetail: composeTextNeutralizationFailureDetail(frame.detailOrigin),
      refusalCode: TEXT_NEUTRALIZATION_REFUSAL_CODE,
    };
  }
}

/**
 * The refusal a caller gets when the tripwire cannot watch another frame.
 *
 * The alternative this replaces was to evict the oldest unsettled registration
 * and take the write anyway. That is worse than a refused send in the exact
 * case the tripwire exists for: the evicted turn later settles, finds no
 * correlated frame, and PASSES — so a swallowed turn is reported as a completed
 * one, silently, and the participant's words are lost behind a green result. A
 * refused write is loud, is attributable to one binding, and loses nothing.
 *
 * Carries NO dotted code, deliberately, and that is the established shape for a
 * driver-local refusal the error registry has no row for — the neighbours are
 * the Codex session-already-live and driver-config errors. Callers discriminate
 * on the class. Reusing the neutralization code would be worse than adding
 * none: that code's detail string has a fixed parseable form two producers emit
 * and a consumer reads, and it means "the provider swallowed a turn" — which is
 * precisely what has NOT happened here.
 *
 * Extends `Error` and not `DaemonDomainError` for the same wire reason as its
 * neighbour: the JSON-RPC mapper discriminates by `instanceof` and projects a
 * `DaemonDomainError` subclass's `code` into `data.type`, so extending that base
 * publishes a refusal shape no contract registers. Falling through to the
 * catch-all keeps this a `-32603` with no `data`.
 */
export class OutboundFrameCapacityRefusedError extends Error {
  /** The provider binding whose budget was exhausted. */
  readonly scopeKey: string;
  /** Unsettled frames that binding was holding when the write was refused. */
  readonly scopePendingFrameCount: number;
  /** Unsettled frames the tripwire was holding across every binding. */
  readonly totalPendingFrameCount: number;

  constructor(scopeKey: string, scopePendingFrameCount: number, totalPendingFrameCount: number) {
    super(
      `Refusing to send provider-bound text on session ${scopeKey}: the text-neutralization tripwire cannot watch another frame. ` +
        `That session holds ${String(scopePendingFrameCount)} unsettled frames (limit ${String(OUTBOUND_FRAME_PENDING_SCOPE_CAPACITY)}) ` +
        `and ${String(totalPendingFrameCount)} are unsettled across all sessions (limit ${String(OUTBOUND_FRAME_PENDING_TOTAL_CAPACITY)}). ` +
        `Turns on this session are not settling.`,
    );
    this.name = "OutboundFrameCapacityRefusedError";
    this.scopeKey = scopeKey;
    this.scopePendingFrameCount = scopePendingFrameCount;
    this.totalPendingFrameCount = totalPendingFrameCount;
  }
}

// --------------------------------------------------------------------------
// Provider-binding disposal
// --------------------------------------------------------------------------

/**
 * The refusal a disposed binding answers a later attach with.
 *
 * Carries the SAME code as the trip that disposed it, which is the point: an
 * operator who reads the run terminal and then watches an attach fail sees one
 * cause, not two unrelated ones.
 *
 * Deliberately extends `Error` and NOT `DaemonDomainError`. `error-contracts.md`
 * registers this code as riding no error envelope on any path — "one landing,
 * never an error envelope" — and the JSON-RPC mapper discriminates by
 * `instanceof`, projecting a `DaemonDomainError` subclass's `code` into
 * `data.type` on the wire. Extending that base would therefore publish the
 * dotted code as a wire refusal and break the registration; falling through to
 * the mapper's catch-all keeps this a `-32603` with no `data`, which is the
 * honest shape for a daemon-internal disposal a client never named.
 */
export class TextNeutralizationRefusedError extends Error {
  readonly code: TextNeutralizationRefusalCode = TEXT_NEUTRALIZATION_REFUSAL_CODE;

  constructor(subject: "run" | "session", subjectId: string) {
    super(
      `The provider binding for ${subject} ${subjectId} was disposed after a provider-bound text neutralization failure and cannot be attached to.`,
    );
    this.name = "TextNeutralizationRefusedError";
  }
}

/**
 * Tracks bindings quarantined by a trip.
 *
 * Disposal is a PROCESS FACT, not a row state: `runtime_bindings` owns no
 * liveness column, and minting one would make the refusal depend on the very
 * marker being refused. The caller owns the liveness intersection against the
 * process supervisor's registry; this class is the driver-local half of it, and
 * it deliberately holds no attach-time arm of its own beyond refusing.
 *
 * ---------------------------------------------------------------------------
 * Two axes, because a run-keyed quarantine cannot reach the session
 * ---------------------------------------------------------------------------
 *
 * A trip means the PROVIDER PROCESS consumed a participant's words and reported
 * a completed turn. Quarantining only the run leaves the session record live,
 * and a later `startRun` resolves that same record by session id and dispatches
 * fresh work into the process the driver just declared unsafe. So a trip
 * quarantines both: the run, whose later attach must refuse rather than answer
 * a stale channel, and the SESSION, whose later resolution must refuse rather
 * than reach the process at all.
 *
 * The session arm is RELEASED at establishment rather than held forever: the
 * promised recovery is a fresh spawn, and a session id whose new process is
 * already running is not the binding that was quarantined. This class means
 * "this binding", not "this identifier, permanently".
 *
 * ---------------------------------------------------------------------------
 * Both axes are keyed by BINDING, and the run axis is looked up by run
 * ---------------------------------------------------------------------------
 *
 * The condemned thing is the process, so the release condition is a property of
 * the process — and a run quarantine that could only be entered and never left
 * made the run axis mean "this identifier, permanently" while the session axis
 * meant "this binding". A run reopened after the fresh spawn — a rewind
 * reinstating it is the reachable case — then lost its interrupt and
 * intervention controls for the rest of the daemon's life, refused by a
 * quarantine on a process that no longer exists.
 *
 * So a run is recorded WITH the binding that condemned it, and releasing that
 * binding releases every run condemned on it. The two axes now share one release
 * condition, stated once, instead of one axis having none.
 *
 * The LOOKUP stays keyed by run, because binding identity is not available where
 * the refusal is made and cannot be made available without weakening it: both
 * drivers call `assertRunAttachable` BEFORE resolving the session, deliberately,
 * so that a run whose binding was condemned refuses with THAT cause rather than
 * with the "no active turn" the swept route would otherwise produce. Deriving a
 * session there would mean resolving first and refusing second — the exact
 * ordering the assert exists to invert. Recording the binding and looking up by
 * run keeps both properties.
 */
export class ProviderBindingQuarantine {
  // Run id → the session whose binding condemned it. The VALUE is what makes the
  // release possible; the KEY is what the assert sites can supply.
  readonly #condemningSessionIdByRunId = new Map<string, string>();
  readonly #disposedSessionIds = new Set<string>();

  /**
   * Quarantines a run's provider binding. Idempotent.
   *
   * `sessionId` is the binding the trip condemned, not merely context: it is the
   * identity this quarantine is released against. Every caller already holds it
   * — a trip is ruled against a session's terminal — so it is required rather
   * than optional, which is what keeps an unreleasable entry unreachable.
   */
  disposeRun(runId: string, sessionId: string): void {
    this.#condemningSessionIdByRunId.delete(runId);
    this.#condemningSessionIdByRunId.set(runId, sessionId);
    evictOldestBeyondCapacity(this.#condemningSessionIdByRunId);
  }

  /** Quarantines the provider session the tripped run was running on. Idempotent. */
  disposeSession(sessionId: string): void {
    this.#disposedSessionIds.delete(sessionId);
    this.#disposedSessionIds.add(sessionId);
    evictOldestBeyondCapacity(this.#disposedSessionIds);
  }

  /**
   * Releases a session id whose binding has been replaced by a fresh spawn, and
   * with it every run that binding condemned.
   *
   * Called from the establishment paths, where a new provider process has just
   * been adopted under this id. Deliberately NOT called anywhere a record is
   * merely re-read: what is released is the quarantine on a binding that no
   * longer exists, not the quarantine on the identifier.
   *
   * The run sweep is part of the same act rather than a second call a caller
   * could forget. A caller that released the session and left the runs would
   * reopen the process to new work while permanently refusing the runs that were
   * on it — the worst of both arms.
   */
  releaseSession(sessionId: string): void {
    this.#disposedSessionIds.delete(sessionId);
    for (const [runId, condemningSessionId] of [...this.#condemningSessionIdByRunId]) {
      if (condemningSessionId === sessionId) {
        this.#condemningSessionIdByRunId.delete(runId);
      }
    }
  }

  isRunDisposed(runId: string): boolean {
    return this.#condemningSessionIdByRunId.has(runId);
  }

  isSessionDisposed(sessionId: string): boolean {
    return this.#disposedSessionIds.has(sessionId);
  }

  /** Refuses an attach to a quarantined run binding. */
  assertRunAttachable(runId: string): void {
    if (this.#condemningSessionIdByRunId.has(runId)) {
      throw new TextNeutralizationRefusedError("run", runId);
    }
  }

  /** Refuses any resolution of a quarantined provider session. */
  assertSessionAttachable(sessionId: string): void {
    if (this.#disposedSessionIds.has(sessionId)) {
      throw new TextNeutralizationRefusedError("session", sessionId);
    }
  }
}
