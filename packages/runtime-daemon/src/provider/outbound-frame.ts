// Provider-bound text frames: transport-only neutralization, and the swallowed-turn tripwire.
//
// A provider CLI that also parses client-side commands consumes a message whose first word is
// command-shaped and answers with a zero-turn success: no error, no model attribution, no token
// accounting (verified against the pinned Claude build).
// - Neutralization changes only the bytes handed to the provider; the user's text is persisted,
//   evented, replayed and rendered as authored.
// - `OutboundTextFrame` is nominal (`#private` field): a driver only gets text from the writer.
// - The frame carries an origin, not a capability flag: an undeclared capability resolves
//   fail-open, so an absent or unrecognized origin neutralizes.
// - The tripwire asks for typed turn evidence, never for command dispatch, whose shapes are open.

import { randomUUID } from "node:crypto";

/**
 * Why a frame is written; it decides whether its bytes are neutralized and whether its turn is
 * watched. `driver_command` is delivered verbatim and exempt from the tripwire.
 */
export type OutboundFrameOrigin = "human_text" | "driver_command" | "system_narration";

/** The closed origin set, for exhaustiveness checks and membership tests. */
const OUTBOUND_FRAME_ORIGINS: readonly OutboundFrameOrigin[] = Object.freeze([
  "human_text",
  "driver_command",
  "system_narration",
]);

/**
 * The origins a caller may name on text a driver writes. `driver_command` is excluded because it
 * skips neutralization and the tripwire; a boundary reading an untyped bag must refuse it itself.
 */
export type CallerDeclaredFrameOrigin = Exclude<OutboundFrameOrigin, "driver_command">;

/**
 * The origin a trip's visible detail may carry. An off-union or absent origin becomes `unknown`,
 * so a rejected caller value is never echoed into a persisted string.
 */
export type TripwireDetailOrigin = "human_text" | "system_narration" | "unknown";

/** This leg's parity grade: `emulated` neutralizes command-shaped text, `native` never does. */
export type TextNeutralityMechanismGrade = "native" | "emulated";

/**
 * The code named in a trip's failure detail (409). It rides no JSON-RPC error envelope: the run's
 * `run.failed` terminal is the guarantee; the intervention `refusalCode` is best-effort.
 */
export const TEXT_NEUTRALIZATION_REFUSAL_CODE = "driver.text_neutralization_failed" as const;

/** The type of {@link TEXT_NEUTRALIZATION_REFUSAL_CODE}. */
export type TextNeutralizationRefusalCode = typeof TEXT_NEUTRALIZATION_REFUSAL_CODE;

/**
 * One leading newline: the least visible transform that defeats the interception (measured).
 * Zero-width characters are prohibited: a byte diff cannot tell them from an attack.
 */
export const OUTBOUND_TEXT_NEUTRALIZATION_SENTINEL = "\n";

/** Composes a trip's `providerFailureDetail`; the form is fixed because a consumer parses it. */
function composeTextNeutralizationFailureDetail(origin: TripwireDetailOrigin): string {
  return `${TEXT_NEUTRALIZATION_REFUSAL_CODE} origin=${origin}`;
}

/** ASCII only, not `trim()`: a no-break space before `/status` is not command-shaped. */
const ASCII_WHITESPACE_BYTES: ReadonlySet<number> = new Set([
  0x09, // horizontal tab
  0x0a, // line feed
  0x0b, // vertical tab
  0x0c, // form feed
  0x0d, // carriage return
  0x20, // space
]);

const COMMAND_LEAD_BYTE = 0x2f; // '/'

/**
 * True when the provider's command layer would dispatch on this text. Byte-level, with no name
 * list: the measured interception is on the leading `/` before any name lookup, so `/etc/hosts` is
 * command-shaped and a mid-text `/` is not.
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

/** Constructor guard against `Reflect.construct`; the `#private` field stops a structural cast. */
const FRAME_MINT_TOKEN: unique symbol = Symbol("outbound-text-frame-mint");

/**
 * One composed provider-bound text frame: the bytes to write, the origin that decided them, and
 * the correlation value the tripwire joins on. Only {@link OutboundTextFrameWriter} mints one.
 */
export class OutboundTextFrame {
  readonly #mintedByWriter: true;

  /** The author's bytes, unchanged — what is persisted, evented, and replayed. */
  readonly authoredText: string;

  /** The bytes to hand the provider process. Equal to `authoredText` unless neutralized. */
  readonly wireText: string;

  /** The declared origin, or `null` when none was declared or the value is outside the union. */
  readonly origin: OutboundFrameOrigin | null;

  readonly detailOrigin: TripwireDetailOrigin;

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

/** What a caller declares about the text it wants written. */
export interface OutboundTextFrameRequest {
  /** The author's text, verbatim. Never mutated by this module. */
  readonly text: string;
  /** The declared origin; typed `string` so an off-union value is classified fail-closed here. */
  readonly origin?: string | undefined;
}

/** Construction options for {@link OutboundTextFrameWriter}. */
export interface OutboundTextFrameWriterOptions {
  readonly mechanismGrade: TextNeutralityMechanismGrade;
  /** Correlation minting, injectable so a test can assert on stable values. */
  readonly mintCorrelationId?: (() => string) | undefined;
}

/**
 * The single composer of provider-bound text bytes. It holds the leg's grade so a call site cannot
 * pass the wrong one.
 */
export class OutboundTextFrameWriter {
  readonly #mechanismGrade: TextNeutralityMechanismGrade;
  readonly #mintCorrelationId: () => string;

  constructor(options: OutboundTextFrameWriterOptions) {
    this.#mechanismGrade = options.mechanismGrade;
    // Not `mintUuidV7`: the value only correlates one in-flight frame, so uniqueness is enough.
    this.#mintCorrelationId = options.mintCorrelationId ?? ((): string => randomUUID());
  }

  /** This leg's declared grade, exposed so a caller can report it without re-deriving it. */
  get mechanismGrade(): TextNeutralityMechanismGrade {
    return this.#mechanismGrade;
  }

  /**
   * Composes one frame: an absent or off-union origin is fail-closed, only `driver_command` is
   * exempt, and neutralization needs an `emulated` leg, a non-exempt frame and command-shaped text.
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

function classifyOutboundFrameOrigin(declared: string | undefined): OutboundFrameOrigin | null {
  if (declared === undefined) {
    return null;
  }
  const member = OUTBOUND_FRAME_ORIGINS.find((candidate) => candidate === declared);
  return member ?? null;
}

function composeTripwireDetailOrigin(origin: OutboundFrameOrigin | null): TripwireDetailOrigin {
  switch (origin) {
    case "human_text":
    case "system_narration":
      return origin;
    // An exempt frame never reaches a trip, so `unknown` only covers the unreachable case.
    case "driver_command":
    case null:
      return "unknown";
  }
}

/**
 * The closed set of typed evidence that a model turn happened. `declared_turn_failure` is needed
 * because a turn that fails for another reason (quota, context window) has no output or
 * accounting, and the tripwire would otherwise blame neutralization; a silent swallow declares
 * nothing.
 */
export type TurnEvidenceClass = "model_output" | "turn_accounting" | "declared_turn_failure";

/** One leg's reading of a settling envelope; `recognized: false` trips, it does not abstain. */
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

type TripwirePassReason = "no-correlated-frame" | "frame-exempt" | "turn-evidence-observed";

/** Why a frame tripped. */
export type TripwireTripCause = "no-turn-evidence" | "unrecognized-settling-envelope";

interface TripwirePass {
  readonly tripped: false;
  readonly reason: TripwirePassReason;
}

/** A frame that got no turn evidence, with the detail and code its run terminal carries. */
export interface TripwireTrip {
  readonly tripped: true;
  readonly cause: TripwireTripCause;
  readonly correlationId: string;
  readonly detailOrigin: TripwireDetailOrigin;
  /** The exact composed `providerFailureDetail`. */
  readonly failureDetail: string;
  readonly refusalCode: TextNeutralizationRefusalCode;
}

/** A tripwire ruling on a frame: a pass or a trip. */
export type TripwireDecision = TripwirePass | TripwireTrip;

/** The run terminal for an unproven delivery; a supersede's detail must not claim a swallow. */
export interface UnprovenDeliveryRunFailure {
  readonly eventType: "run.failed";
  readonly failureCategory: "provider failure";
  readonly recoveryCondition: "recovery-needed";
  readonly providerFailureDetail: string;
}

/** A trip's run terminal: the same record as {@link UnprovenDeliveryRunFailure}. */
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

/** Prose, not the trip's `origin=<token>` form, so no parser reads a supersede as a swallow. */
const SUPERSEDED_DELIVERY_ORIGIN_PHRASE: Readonly<Record<TripwireDetailOrigin, string>> =
  Object.freeze({
    human_text: "a user's text",
    system_narration: "system narration",
    unknown: "text of unrecorded origin",
  });

/**
 * Composes the run terminal for a frame whose binding was superseded before it settled. It carries
 * no dotted code (the registry has no row, and the trip code would claim an unobserved swallow).
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

/** Settled keys each retained map holds; aging one out costs a best-effort answer, no ruling. */
const OUTBOUND_FRAME_SETTLED_KEY_MEMORY = 64;

/** Unsettled frames one session may hold; turns serialize, so sixteen is far above real load. */
export const OUTBOUND_FRAME_PENDING_SCOPE_CAPACITY: number = 16;

/** The global backstop across every scope one tripwire serves. */
export const OUTBOUND_FRAME_PENDING_TOTAL_CAPACITY: number = 256;

/**
 * Evicts oldest first from an insertion-ordered collection of settled keys; callers `delete` before
 * `set`/`add`. Never for the unsettled store: evicting there turns an owed trip into a silent pass.
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
  /** The key the frame was correlated to: a run id, then a turn id once the provider names one. */
  readonly joinKey: string;
  readonly decision: TripwireDecision;
}

/** One frame's abandonment from {@link OutboundFrameTripwire.abandonScope}. */
export interface AbandonedFrameDelivery {
  /** Same key vocabulary as {@link ScopeFrameRuling}; the caller resolves a run from it. */
  readonly joinKey: string;
  readonly detailOrigin: TripwireDetailOrigin;
}

interface PendingCorrelatedFrame {
  readonly frame: OutboundTextFrame;
  /** The provider binding written on (a session id on both legs); the join key cannot supply it. */
  readonly scopeKey: string;
  /** Mutable: `recorrelateFrame` re-keys a frame from a run id to the provider's turn id. */
  joinKey: string;
  /** The declared part this frame plays in its turn; see the attribution rule on the tripwire. */
  readonly frameRole: OutboundFrameRole;
  readonly observations: Set<TurnEvidenceClass>;
  /** Set once by `recordRequestAnswered`: the provider took the frame, not that the model read. */
  requestAnswered: boolean;
}

/** The first trip wins; between two passes, observed evidence beats exemption. */
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
 * The part a frame plays in its turn. Stream items vouch only for `turn-opening`, the frame the
 * turn exists to answer; a `turn-joining` frame (a steer) only by its own request's answer.
 */
export type OutboundFrameRole = "turn-opening" | "turn-joining";

/** One frame's registration with the tripwire that will rule on it. */
export interface OutboundFrameRegistration {
  /** The provider binding written on (a session id on both legs); it feeds per-binding capacity. */
  readonly scopeKey: string;
  /** The key the settling turn will carry — a run id or a provider turn id. */
  readonly joinKey: string;
  /** Declared by the caller: registration order does not say which frame opened which turn. */
  readonly frameRole: OutboundFrameRole;
  readonly frame: OutboundTextFrame;
}

/** Construction options for {@link OutboundFrameTripwire}. */
export interface OutboundFrameTripwireOptions {
  /**
   * Whether a binding is retired (disposed, quarantined or torn down); consulted only to reclaim
   * registrations nothing can settle. Must be a pure read of driver-local state.
   */
  readonly isScopeRetired?: (scopeKey: string) => boolean;
}

/**
 * Correlates written frames with the turns that settle them, and rules on each. The join key is
 * daemon-side (a run id or provider turn id), which keeps the class provider-neutral.
 */
export class OutboundFrameTripwire {
  // Keyed by correlation value, not join key (a steer would replace the opening frame and its
  // observations), and insertion-ordered so iteration yields the oldest frame first.
  readonly #pendingByCorrelationId = new Map<string, PendingCorrelatedFrame>();
  readonly #decisionByJoinKey = new Map<string, TripwireDecision>();
  readonly #isScopeRetired: ((scopeKey: string) => boolean) | undefined;

  constructor(options: OutboundFrameTripwireOptions = {}) {
    this.#isScopeRetired = options.isScopeRetired;
  }

  /**
   * Registers a written frame under the key its settling turn will carry. Call it before the bytes
   * go out and abort the write if it throws: a turn settling with no correlated frame passes.
   * Appends, and registers exempt frames too so `settle` can say why one passed.
   *
   * @throws {OutboundFrameCapacityRefusedError} at capacity when nothing could be reclaimed.
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
   * Records in-flight evidence for a correlated turn. Stream items carry no frame attribution, so
   * it is credited to the turn-opening frame under the key alone: crediting every pending frame, or
   * the oldest without evidence, lets output already vouched for vouch a swallowed steer.
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
   * Records that the provider answered one frame's own request, the statement a turn-joining frame
   * is consumed on: it proves the provider took the frame, not that the model read it. A no-op for
   * a frame no longer pending and, fail-closed, for a turn-opening frame.
   */
  recordRequestAnswered(frame: OutboundTextFrame): void {
    const pending = this.#pendingByCorrelationId.get(frame.correlationId);
    if (pending === undefined || pending.frameRole === "turn-opening") {
      return;
    }
    pending.requestAnswered = true;
  }

  /**
   * Re-keys one pending registration once the provider names the turn its bytes opened. It is
   * frame-scoped because concurrent attempts share a run id, and it leaves both keys' retained
   * decisions alone. A frame moved onto an already-settled turn can never be ruled and this store
   * cannot see that, so each caller rules the frame itself when its destination is no longer live.
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
   * Rules on one frame and consumes only its registration, for a frame whose delivery became
   * unknowable while its turn stayed open. `settle` cannot serve: an unrecognized classification
   * trips every frame on the key. Writes no retained decision, since the turn has not settled.
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
    // No settling envelope is present, so only the frame's own accrued evidence counts.
    return this.#rule(pending, classification, false);
  }

  /** Whether any frame under this key still awaits its turn; a run can keep a route with none. */
  hasPendingFrame(joinKey: string): boolean {
    for (const pending of this.#pendingByCorrelationId.values()) {
      if (pending.joinKey === joinKey) {
        return true;
      }
    }
    return false;
  }

  /**
   * Whether any frame is still pending under a scope, whatever its key. On a leg whose envelope
   * carries no join identity (Claude), admitting a second key into an occupied scope makes `settle`
   * ambiguous, so the session-serialization guard asks this first.
   */
  hasPendingFrameInScope(scopeKey: string): boolean {
    for (const pending of this.#pendingByCorrelationId.values()) {
      if (pending.scopeKey === scopeKey) {
        return true;
      }
    }
    return false;
  }

  /**
   * The retained decision for a settled turn, or `undefined` while it is open. Best-effort for the
   * intervention path: no intervention call is held open for a turn to settle.
   */
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
   * Drops one frame's registration for a send that provably never reached the wire. Callers must
   * classify first: a send whose bytes may have been taken must be ruled with `settleFrame`,
   * because forgetting it is how a swallowed directive escapes. The retained decision is kept.
   */
  forgetFrame(frame: OutboundTextFrame): void {
    this.#pendingByCorrelationId.delete(frame.correlationId);
  }

  /**
   * Rules on every frame still pending on one provider binding and returns each ruling with the key
   * it was owed on (a run id until the provider names the turn, then a turn id). For a binding
   * taken from live turns; `forgetScope` fits only pure occupancy. Writes no retained decision.
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
   * Drops every pending registration written on one binding, past which no turn can settle, so a
   * session that died mid-turn does not spend its budget forever. Retained decisions are kept
   * because the intervention path reads them by turn after the binding is gone.
   */
  forgetScope(scopeKey: string): void {
    for (const [correlationId, pending] of this.#pendingByCorrelationId) {
      if (pending.scopeKey === scopeKey) {
        this.#pendingByCorrelationId.delete(correlationId);
      }
    }
  }

  /**
   * Consumes every pending registration on one binding and reports the non-exempt frames whose
   * delivery was left unproven, as facts and no verdict: nothing observed a swallow, so this mints
   * no trip. The caller composes the terminal with `composeSupersededDeliveryRunFailure`. A frame
   * whose request was answered is reported too. Writes no retained decision.
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

  /** Unsettled frames on one binding; a scan, since a drifted counter would refuse writes. */
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
   * Prune then refuse, never evict: only registrations whose binding is gone are provably owed no
   * ruling, and discarding any other turns a future trip into a silent pass.
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
   * Reclaims registrations of bindings the driver reports retired, asking once per binding. A
   * predicate that throws counts as not retired: an unanswered question proves nothing.
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
    // The flag belongs to the envelope: an unparsable terminal trips every frame, answered or not.
    if (!classification.recognized) {
      return this.#trip(pending.frame, "unrecognized-settling-envelope");
    }
    // Only the turn-opening frame is vouched for by the envelope's observations. A turn-joining
    // frame is consumed on its recorded answer, a coverage boundary: an answered request whose text
    // is then dropped before the model goes unseen. A zero-turn settlement still trips the opener.
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
 * The refusal a caller gets when the tripwire cannot watch another frame; evicting instead would
 * let the evicted turn settle and pass. It carries no dotted code (the neutralization code would
 * claim a swallow) and extends `Error`, not `DaemonDomainError`, so the JSON-RPC mapper does not
 * publish an unregistered `data.type`: it falls through to `-32603`.
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

/**
 * The refusal a disposed binding gives a later attach, with the trip's code. It extends `Error`,
 * not `DaemonDomainError`, for the wire reason on {@link OutboundFrameCapacityRefusedError}.
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
 * Tracks provider bindings quarantined by a trip; the caller owns the liveness check against the
 * process supervisor's registry, and this class only refuses. Runs are recorded with the session
 * that condemned them but looked up by run id, since `assertRunAttachable` runs before the session
 * is resolved.
 */
export class RuntimeBindingQuarantine {
  // Run id -> condemning session: the assert sites supply the key, the value enables release.
  readonly #condemningSessionIdByRunId = new Map<string, string>();
  readonly #disposedSessionIds = new Set<string>();

  /**
   * Quarantines a run's provider binding so a later attach refuses rather than answer a stale
   * channel. Idempotent; `sessionId` is the condemned binding the quarantine is released against.
   */
  disposeRun(runId: string, sessionId: string): void {
    this.#condemningSessionIdByRunId.delete(runId);
    this.#condemningSessionIdByRunId.set(runId, sessionId);
    evictOldestBeyondCapacity(this.#condemningSessionIdByRunId);
  }

  /** Quarantines the session the tripped run was on, so no new work reaches it. Idempotent. */
  disposeSession(sessionId: string): void {
    this.#disposedSessionIds.delete(sessionId);
    this.#disposedSessionIds.add(sessionId);
    evictOldestBeyondCapacity(this.#disposedSessionIds);
  }

  /**
   * Releases a session id whose binding a fresh spawn replaced, and every run that binding
   * condemned. Call it where a new process is adopted under the id, not where a record is re-read;
   * releasing the session alone would keep refusing the runs that were on it.
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
