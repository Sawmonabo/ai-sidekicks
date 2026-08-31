// The post-replay assertion (Plan-005 Phase 3, T3.20).
//
// `Spec-005 §Required Behavior` states the rule this module exists to enforce:
// a replay is verified by what the session ANSWERS, never by what the call
// returned. `replayTranscript` therefore completes only after the reconstituted
// session is read back and answers consistently with the transcript's tail, and
// a session that answers with zero turns, cannot be read, or contradicts the
// tail fails the operation.
//
// The rule is not defensive pedantry. Both pinned seeding surfaces are UNTYPED
// at the wire — Codex's `thread/inject_items` takes `Array<JsonValue>` — so a
// frame the provider does not understand is accepted and dropped rather than
// refused, and every layer above reads a successful call over a session holding
// nothing. A provider that lies by omission is the ordinary case here, not the
// adversarial one, which is why the success return is worth exactly nothing as
// evidence.
//
// Spec coverage: `Spec-005 §Required Behavior` (a replay is verified by what the
// session answers); `Spec-005 §Canonical Transcript Export And Replay` (the
// post-replay assertion as the only admissible evidence a replay worked).
// Verifies invariant I-005-8.
//
// Driver-agnostic on purpose. Both legs seed over different transports and both
// owe the identical verdict, so the comparison rules live once, here, and each
// driver supplies only what it wrote and what the target answered. A driver that
// owned its own verdict could weaken it without the weakening being visible in
// one place.

import type { CanonicalTranscriptTurn } from "@ai-sidekicks/contracts";

// --------------------------------------------------------------------------
// What was seeded, and what the target answered
// --------------------------------------------------------------------------

/**
 * One frame as the DRIVER BELIEVES IT WROTE IT — the daemon's side of the
 * comparison.
 *
 * `text` is the rendered body the driver actually put on the wire for this
 * frame, and an empty string is a legitimate value: a fold that reached a turn
 * whose body could not be read carries the turn with its structural position and
 * an empty body (`turn_content_unavailable`). It is recorded as the empty string
 * rather than as absent so an empty body stays comparable — see
 * {@link assertReplayReconstituted}'s no-comparable-content arm for why a tail
 * made entirely of them is refused rather than silently confirmed.
 */
export interface SeededTranscriptFrame {
  readonly position: number;
  readonly role: CanonicalTranscriptTurn["role"];
  readonly text: string;
}

/**
 * What the reconstituted session ANSWERED when asked what it holds.
 *
 * `turns` is the target's turn bodies as text, oldest first, for the WHOLE
 * session — the same answer shape `MemoTargetGateway.readTurnsForMarkerReconciliation`
 * is bound to, deliberately, because both readers ask the same provider the same
 * question and a second answer shape would be a second notion of what a target
 * holds. A bounded tail window does not satisfy it: this assertion counts turns,
 * and a window shorter than the transcript answers "fewer turns than seeded" for
 * a replay that in fact applied.
 *
 * `unreadable` is a settlement, never a reason to assume the seed took. It is
 * how a reader reports that the question could not be asked at all.
 */
export type ReplayTargetReadback =
  | { readonly kind: "turns"; readonly turns: readonly string[] }
  | { readonly kind: "unreadable"; readonly reason: string };

/**
 * The seam each driver leg binds to reach its target's readback.
 *
 * Keyed by the target's PROVIDER session id — the same key the memo floor's
 * gateway reads by — so the answer is about the session the seed was written
 * into rather than about whatever the reader considers current.
 *
 * Rejecting is equivalent to answering `unreadable`; a leg that catches a
 * rejection MUST convert it into that arm rather than into a pass.
 */
export type ReplayTargetReadbackReader = (
  targetProviderSessionId: string,
) => Promise<ReplayTargetReadback>;

// --------------------------------------------------------------------------
// The verdict
// --------------------------------------------------------------------------

/**
 * Why a replay was refuted. Closed, because each arm is a distinct thing that
 * went wrong and a driver's diagnostics distinguish them.
 *
 * There is deliberately no `unknown` member. Every path through
 * {@link assertReplayReconstituted} lands on a named arm or on `confirmed`, and
 * a catch-all would be the place an unanticipated shape quietly became a pass.
 */
export type PostReplayRefutation =
  | "target-unreadable"
  | "answered-zero-turns"
  | "fewer-turns-than-seeded"
  | "no-comparable-content"
  | "tail-mismatch";

export type PostReplayVerdict =
  | {
      readonly outcome: "confirmed";
      /**
       * How many tail frames were compared body-to-body.
       *
       * Always `>= 1`, and that holds only because
       * {@link assertReplayReconstituted} throws on an empty seed rather than
       * confirming it. The two facts are stated together so an edit that softens
       * the throw cannot leave this claim quietly false.
       */
      readonly comparedTurns: number;
      /** How many turns the target answered with. */
      readonly answeredTurns: number;
    }
  | {
      readonly outcome: "refuted";
      readonly refutation: PostReplayRefutation;
      /** Operator-facing detail. Carries no transcript body — see below. */
      readonly detail: string;
    };

/**
 * How deep into the tail bodies are compared.
 *
 * Three rather than one because a single-turn comparison is satisfied by a
 * provider that kept only the last frame, and rather than all because the
 * comparison's cost is the transcript's length and its evidentiary value is
 * concentrated at the end: `Spec-005 §Required Behavior` binds the answer to be
 * consistent with the transcript's TAIL. The count check below is what covers
 * the interior — a provider that dropped anything anywhere answers with fewer
 * turns than were seeded.
 */
export const POST_REPLAY_TAIL_DEPTH: number = 3;

// --------------------------------------------------------------------------
// The assertion
// --------------------------------------------------------------------------

/**
 * Normalizes a turn body for comparison.
 *
 * Line-ending translation and surrounding whitespace are the only
 * transformations a transport is entitled to make to a body it is storing
 * verbatim, so they are the only ones forgiven. Nothing else is: collapsing
 * interior whitespace, case-folding, or comparing by containment would each let
 * a provider that summarized, truncated, or echoed the seed pass an assertion
 * whose entire purpose is to catch exactly that.
 */
function normalizeTurnBodyForComparison(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

/**
 * The post-replay assertion. Compares what the driver wrote against what the
 * target answered, and returns a verdict.
 *
 * Every ambiguous arm refutes. The operation this gates has a supported
 * fallback — a refuted replay settles on the memo projection reported
 * `degraded` — so refusing costs a caller a degradation, while confirming
 * wrongly costs it a provider session that has silently lost the conversation
 * it is about to answer as though it remembered.
 *
 * @throws {RangeError} when `seeded` is empty. An assertion over nothing is
 * vacuous, and returning `confirmed` for it would report that a replay of no
 * frames worked — which is true and useless, and would let a leg that computed
 * an empty seed reach a passing verdict. Callers refuse an empty transcript
 * before they seed; this is the second lock on the same door.
 */
export function assertReplayReconstituted(
  seeded: readonly SeededTranscriptFrame[],
  readback: ReplayTargetReadback,
): PostReplayVerdict {
  if (seeded.length === 0) {
    throw new RangeError(
      "assertReplayReconstituted: refusing to assert over an empty seed; a replay of no frames has nothing to confirm.",
    );
  }

  if (readback.kind === "unreadable") {
    return {
      outcome: "refuted",
      refutation: "target-unreadable",
      detail: `the replay target could not be read back: ${readback.reason}`,
    };
  }

  const answeredTurns: number = readback.turns.length;

  // Named separately from the count check below even though it is a special
  // case of it. This is the shape a provider that accepted every frame and
  // stored none of them answers with, it is the failure this whole module
  // exists for, and a diagnostic reading "0 < 4" says far less than the name.
  if (answeredTurns === 0) {
    return {
      outcome: "refuted",
      refutation: "answered-zero-turns",
      detail: `the replay target answered with zero turns after ${String(seeded.length)} frame(s) were seeded`,
    };
  }

  // MORE turns than were seeded is tolerated; fewer never is. A provider is
  // entitled to add turns of its own to a session it owns — a system preamble,
  // a normalization that splits one seeded frame in two — and refusing those
  // would refuse working replays for a reason that is not a loss. Losing turns
  // is the one direction that destroys the transcript, and the tail comparison
  // below is what keeps the tolerated direction from becoming a hole a padded
  // answer fits through.
  if (answeredTurns < seeded.length) {
    return {
      outcome: "refuted",
      refutation: "fewer-turns-than-seeded",
      detail: `the replay target answered with ${String(answeredTurns)} turn(s) after ${String(seeded.length)} frame(s) were seeded`,
    };
  }

  const comparedTurns: number = Math.min(seeded.length, POST_REPLAY_TAIL_DEPTH);
  const expectedTail: readonly SeededTranscriptFrame[] = seeded.slice(
    seeded.length - comparedTurns,
  );
  const observedTail: readonly string[] = readback.turns.slice(answeredTurns - comparedTurns);

  const normalizedExpected: string[] = expectedTail.map((frame) =>
    normalizeTurnBodyForComparison(frame.text),
  );
  const normalizedObserved: string[] = observedTail.map((turn) =>
    normalizeTurnBodyForComparison(turn),
  );

  // A SEEDED tail with no bodies has nothing for the target to be consistent
  // with: every pair the loop below would compare is `"" === ""`, so the
  // assertion would silently degrade to the count check alone against a target
  // that could have stored empty placeholders for frames it discarded.
  // `Spec-005 §Required Behavior` requires the answer to be consistent with the
  // transcript's TAIL, and a tail with no content supplies none.
  //
  // The predicate reads the EXPECTED side only, deliberately. Reading the
  // observed side too — "either side carries a body" — would let a target that
  // answered with prose nobody seeded satisfy the check on the strength of the
  // content it invented, and would then report the mismatch under this name
  // instead of the `tail-mismatch` it actually is. What is being asked here is
  // whether the daemon brought anything worth comparing.
  //
  // The honest consequence is stated rather than hidden: a transcript whose tail
  // is entirely unreadable bodies cannot be replay-verified at all and settles on
  // the memo floor, which is the fallback that exists for exactly that.
  const seededTailCarriesComparableBody: boolean = normalizedExpected.some(
    (text) => text.length > 0,
  );
  if (!seededTailCarriesComparableBody) {
    return {
      outcome: "refuted",
      refutation: "no-comparable-content",
      detail: `the seeded tail's newest ${String(comparedTurns)} frame(s) carry empty bodies, so no answer from the target could confirm them`,
    };
  }

  for (let index = 0; index < comparedTurns; index += 1) {
    const expected: string = normalizedExpected[index] ?? "";
    const observed: string = normalizedObserved[index] ?? "";
    if (expected !== observed) {
      const frame: SeededTranscriptFrame | undefined = expectedTail[index];
      const seededPosition: string = frame === undefined ? "unknown" : String(frame.position);
      // The detail names POSITIONS and LENGTHS and never bodies. This string
      // reaches driver diagnostics, which are a bounded-retention tier that is
      // explicitly not a home for transcript content; a mismatch report carrying
      // the turn it is about would put conversation text there on every failed
      // replay.
      return {
        outcome: "refuted",
        refutation: "tail-mismatch",
        detail: `the replay target's tail contradicts the transcript at seeded position ${seededPosition}: expected a ${String(expected.length)}-character body, the target answered with a ${String(observed.length)}-character one`,
      };
    }
  }

  return { outcome: "confirmed", comparedTurns, answeredTurns };
}

// --------------------------------------------------------------------------
// The failure both legs throw
// --------------------------------------------------------------------------

/**
 * Thrown when the post-replay assertion refutes.
 *
 * THROWN rather than returned as a `degraded` result, and the distinction is
 * load-bearing: `DriverTranscriptReplayResult`'s `degraded` status is reserved
 * for the memo floor and its schema requires the matching
 * `conversation_history_summarized` loss, so returning `degraded` here would
 * report a summarized history to a caller that received neither a replay nor a
 * memo. `ReplayTranscriptParams`' own contract routes an unreachable target to a
 * throw for the same reason. The caller catches, abandons the target, and
 * settles on the memo floor — which is where the `degraded` result is minted, by
 * the component that actually delivered the memo.
 */
export class PostReplayAssertionFailedError extends Error {
  readonly refutation: PostReplayRefutation;
  readonly seededFrames: number;
  readonly targetProviderSessionId: string;

  constructor(
    targetProviderSessionId: string,
    seededFrames: number,
    verdict: Extract<PostReplayVerdict, { outcome: "refuted" }>,
  ) {
    super(
      `The post-replay assertion refuted the reconstituted session "${targetProviderSessionId}" (${verdict.refutation}): ${verdict.detail}.`,
    );
    this.name = "PostReplayAssertionFailedError";
    this.refutation = verdict.refutation;
    this.seededFrames = seededFrames;
    this.targetProviderSessionId = targetProviderSessionId;
  }
}

// --------------------------------------------------------------------------
// The replay-target lifecycle: abandoned, never reused
// --------------------------------------------------------------------------

/**
 * Why a replay target is no longer usable. Closed.
 *
 * Five arms are failures, in each of which the target's contents are partial or
 * unknowable. The sixth, `replay-completed`, is a SUCCESS — and it belongs in the
 * same union because it retires the target for the same reason the others do: a
 * target that already holds a whole transcript is not a fresh session, and
 * seeding it again writes the conversation into it twice.
 */
export type ReplayTargetAbandonmentCause =
  | "target-not-fresh"
  | "interior-refusal"
  | "ambiguous-delivery"
  | "readback-unavailable"
  | "assertion-refuted"
  | "replay-completed";

/** Thrown when a caller reaches for a target this daemon has already retired. */
export class ReplayTargetAbandonedError extends Error {
  readonly targetProviderSessionId: string;
  readonly abandonmentCause: ReplayTargetAbandonmentCause;

  constructor(targetProviderSessionId: string, abandonmentCause: ReplayTargetAbandonmentCause) {
    super(
      `Replay target "${targetProviderSessionId}" is no longer usable (${abandonmentCause}); a replay target is single-use, so reconstitute into a fresh session.`,
    );
    this.name = "ReplayTargetAbandonedError";
    this.targetProviderSessionId = targetProviderSessionId;
    this.abandonmentCause = abandonmentCause;
  }
}

/**
 * The per-driver record of which replay targets are burned.
 *
 * A partially-seeded target is ABANDONED, NEVER REUSED — on mid-seeding
 * ambiguity and equally on an interior refusal after an accepted prefix — and
 * the memo settlement always lands in a fresh target. The rule is not fussiness
 * about tidiness: both surviving-session shapes it forbids are conversations a
 * participant then reads. A target holding half a transcript and then a memo
 * summarizing the whole of it states the same exchanges twice, once truncated;
 * a target retried after an ambiguous delivery states one exchange twice
 * verbatim. Neither is recoverable afterwards, because nothing downstream can
 * tell a duplicated turn from a repeated one.
 *
 * Abandonment is deliberately UNIFORM across causes, including the case where
 * the very first frame was refused before anything was applied and the target is
 * therefore provably still pristine. Distinguishing that case would buy one
 * saved provider session and cost the invariant its checkability: with the rule
 * uniform, "no surviving session holds both native frames and the memo" is a
 * property of the mechanism, and with it conditional it becomes a property of
 * each caller's case analysis.
 *
 * A target is retired on SUCCESS too, not only on failure. A replay target is
 * single-use by construction — it is established fresh, seeded once, and then
 * belongs to the conversation it now holds — and without the success entry the
 * one guard a driver can apply cheaply is blind to it: a provider's own
 * seeding surface need not advance whatever turn ledger a driver gates freshness
 * on, so a second replay through the same handle would seed the transcript again
 * and the assertion would confirm it (the doubled session answers with more
 * turns than were seeded, which is tolerated, and its tail still matches).
 * Retiring on success makes that reachable only by establishing a new target.
 *
 * Deliberately in-memory and NOT durable. A restart loses the record, and that is
 * correct rather than a gap: a target is reachable only through a handle a
 * caller holds, and a daemon that restarted holds none — the sessions this
 * ledger names are unreferenceable by the time it is empty again.
 *
 * DELIBERATELY UNCAPPED, and cheaply so: one short string per replay target this
 * process ever established, which is one per reconstitution rather than one per
 * turn or per frame. Evicting a head entry would silently re-admit the oldest
 * burned target, which is the one failure this class exists to prevent, and a
 * daemon uptime long enough for this map to cost memory would have to have
 * reconstituted more sessions than a node hosts.
 */
export class ReplayTargetLedger {
  readonly #abandoned: Map<string, ReplayTargetAbandonmentCause> = new Map();

  /**
   * Records a target as burned. Idempotent, and FIRST CAUSE WINS: the earliest
   * cause is the one that made the target unusable, and a later attempt's
   * failure is a consequence of it rather than a competing explanation.
   */
  abandon(targetProviderSessionId: string, cause: ReplayTargetAbandonmentCause): void {
    if (!this.#abandoned.has(targetProviderSessionId)) {
      this.#abandoned.set(targetProviderSessionId, cause);
    }
  }

  /**
   * Retires a target whose replay CONFIRMED, so it can never be seeded twice.
   *
   * Its own method rather than a bare `abandon` call at each success site: the
   * two acts read differently to anyone maintaining a driver leg, and naming the
   * success one keeps a reader from concluding that a confirmed replay failed.
   */
  consume(targetProviderSessionId: string): void {
    this.abandon(targetProviderSessionId, "replay-completed");
  }

  abandonmentCauseFor(targetProviderSessionId: string): ReplayTargetAbandonmentCause | undefined {
    return this.#abandoned.get(targetProviderSessionId);
  }

  /**
   * Refuses a target this daemon has abandoned.
   *
   * Called at the ENTRANCE of a replay, before any frame is written, so a reuse
   * is refused at zero cost to the provider rather than discovered afterwards.
   */
  assertUsable(targetProviderSessionId: string): void {
    const cause: ReplayTargetAbandonmentCause | undefined =
      this.#abandoned.get(targetProviderSessionId);
    if (cause !== undefined) {
      throw new ReplayTargetAbandonedError(targetProviderSessionId, cause);
    }
  }
}
