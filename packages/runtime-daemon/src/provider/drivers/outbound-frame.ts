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
 * The union is byte-identical to the transcript pipeline's local
 * `RenderedFrameOrigin`, which that module documents as collapsing onto this
 * declaration.
 */
export type OutboundFrameOrigin = "participant_text" | "driver_command" | "system_narration";

/** The closed origin set, for exhaustiveness checks and membership tests. */
export const OUTBOUND_FRAME_ORIGINS: readonly OutboundFrameOrigin[] = Object.freeze([
  "participant_text",
  "driver_command",
  "system_narration",
]);

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
 * The run-terminal landing a trip produces.
 *
 * One landing serves BOTH paths — a run-opening frame and a steer directive
 * frame fail the run identically. The trip mints no driver event, no third
 * driver-result status, no persisted column, and no state transition: both
 * `starting -> failed` and `running -> failed` are already declared, so the
 * terminal this composes is an existing one reached for a new reason.
 */
export interface TextNeutralizationRunFailure {
  readonly eventType: "run.failed";
  readonly failureCategory: "provider failure";
  readonly recoveryCondition: "recovery-needed";
  readonly providerFailureDetail: string;
}

/** Composes the run terminal for a trip. */
export function composeTextNeutralizationRunFailure(
  trip: TripwireTrip,
): TextNeutralizationRunFailure {
  return {
    eventType: "run.failed",
    failureCategory: "provider failure",
    recoveryCondition: "recovery-needed",
    providerFailureDetail: trip.failureDetail,
  };
}

/**
 * How many keys the tripwire and the quarantine each retain.
 *
 * Both maps below are keyed by a value the daemon mints per run or per turn,
 * and neither has a completion guarantee: a session that dies without a
 * terminal leaves its registration pending forever, and a disposed binding is
 * never un-disposed. Unbounded, that is a leak for the lifetime of the daemon
 * process, so both are capped and evicted oldest-first — the same bound and the
 * same end as the Codex terminated-turn memory, for the same reason: the window
 * in which an entry is still claimed is short, so the oldest entry is always
 * the least likely to still matter.
 *
 * The cap is generous against its real load. The tripwire holds one pending
 * entry per UNSETTLED frame, and both providers settle a turn before the next
 * one starts on the same session; the quarantine holds one entry per tripped
 * run, and a tripped run is already terminal, so an aged-out entry cannot
 * revive it — what ages out is only the fail-fast refusal an immediate re-
 * attach would have hit.
 */
const OUTBOUND_FRAME_KEY_MEMORY = 64;

/**
 * Caps an insertion-ordered keyed collection, evicting oldest-first.
 *
 * Callers `delete` before `set` / `add` so a re-used key moves to the newest
 * position rather than ageing out while still live.
 */
function evictOldestBeyondCapacity(keyed: {
  readonly size: number;
  keys(): IterableIterator<string>;
  delete(key: string): boolean;
}): void {
  while (keyed.size > OUTBOUND_FRAME_KEY_MEMORY) {
    const oldest = keyed.keys().next();
    if (oldest.done === true) {
      return;
    }
    keyed.delete(oldest.value);
  }
}

interface PendingCorrelatedFrame {
  readonly frame: OutboundTextFrame;
  readonly observations: Set<TurnEvidenceClass>;
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
 */
export class OutboundFrameTripwire {
  readonly #pendingByJoinKey = new Map<string, PendingCorrelatedFrame>();
  readonly #decisionByJoinKey = new Map<string, TripwireDecision>();

  /**
   * Registers a written frame against the key its settling turn will carry.
   *
   * An exempt frame is registered too, rather than dropped: a later `settle`
   * must be able to say WHY it passed, and a dropped registration would be
   * indistinguishable from a frame that was never written.
   */
  register(joinKey: string, frame: OutboundTextFrame): void {
    this.#pendingByJoinKey.delete(joinKey);
    this.#pendingByJoinKey.set(joinKey, { frame, observations: new Set() });
    this.#decisionByJoinKey.delete(joinKey);
    evictOldestBeyondCapacity(this.#pendingByJoinKey);
  }

  /**
   * Records in-flight evidence for a correlated turn.
   *
   * Evidence accrues across a turn rather than being read only off the settling
   * frame: one leg's terminal notification carries the whole item list and the
   * other's does not, so an accumulating tripwire works on both without either
   * classifier having to reconstruct what it did not see.
   */
  observe(joinKey: string, observation: TurnEvidenceClass): void {
    this.#pendingByJoinKey.get(joinKey)?.observations.add(observation);
  }

  /** Re-keys a pending registration once the provider names the turn it started. */
  recorrelate(fromJoinKey: string, toJoinKey: string): void {
    if (fromJoinKey === toJoinKey) {
      return;
    }
    const pending = this.#pendingByJoinKey.get(fromJoinKey);
    if (pending === undefined) {
      return;
    }
    this.#pendingByJoinKey.delete(fromJoinKey);
    this.#pendingByJoinKey.delete(toJoinKey);
    this.#pendingByJoinKey.set(toJoinKey, pending);
  }

  /**
   * Rules on the correlated frame as its turn settles, and consumes the
   * registration so a second terminal for the same turn cannot trip twice.
   */
  settle(joinKey: string, classification: TurnEvidenceClassification): TripwireDecision {
    const pending = this.#pendingByJoinKey.get(joinKey);
    if (pending === undefined) {
      return { tripped: false, reason: "no-correlated-frame" };
    }
    this.#pendingByJoinKey.delete(joinKey);

    const decision = this.#rule(pending, classification);
    this.#decisionByJoinKey.delete(joinKey);
    this.#decisionByJoinKey.set(joinKey, decision);
    evictOldestBeyondCapacity(this.#decisionByJoinKey);
    return decision;
  }

  /**
   * Whether a written frame is still awaiting its settling turn.
   *
   * Read by a driver that must decide WHICH of several correlated keys a single
   * terminal accounts for: routes and registrations are different sets — a run
   * whose write threw keeps its route and drops its registration — so ordering
   * the decision by route would let a run with nothing pending consume the
   * evidence a live one needed.
   */
  hasPendingFrame(joinKey: string): boolean {
    return this.#pendingByJoinKey.has(joinKey);
  }

  /** The retained decision for a settled turn, or `undefined` while it is still open. */
  decisionFor(joinKey: string): TripwireDecision | undefined {
    return this.#decisionByJoinKey.get(joinKey);
  }

  /** Drops all state for a key — used when a run's binding is torn down. */
  forget(joinKey: string): void {
    this.#pendingByJoinKey.delete(joinKey);
    this.#decisionByJoinKey.delete(joinKey);
  }

  #rule(
    pending: PendingCorrelatedFrame,
    classification: TurnEvidenceClassification,
  ): TripwireDecision {
    if (pending.frame.tripwireExempt) {
      return { tripped: false, reason: "frame-exempt" };
    }
    if (!classification.recognized) {
      return this.#trip(pending.frame, "unrecognized-settling-envelope");
    }
    const hasEvidence = pending.observations.size > 0 || classification.observations.length > 0;
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

  constructor(runId: string) {
    super(
      `The provider binding for run ${runId} was disposed after a provider-bound text neutralization failure and cannot be attached to.`,
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
 */
export class ProviderBindingQuarantine {
  readonly #disposedRunIds = new Set<string>();

  /** Quarantines a run's provider binding. Idempotent. */
  dispose(runId: string): void {
    this.#disposedRunIds.delete(runId);
    this.#disposedRunIds.add(runId);
    evictOldestBeyondCapacity(this.#disposedRunIds);
  }

  isDisposed(runId: string): boolean {
    return this.#disposedRunIds.has(runId);
  }

  /** Refuses an attach to a quarantined binding. */
  assertAttachable(runId: string): void {
    if (this.#disposedRunIds.has(runId)) {
      throw new TextNeutralizationRefusedError(runId);
    }
  }
}
