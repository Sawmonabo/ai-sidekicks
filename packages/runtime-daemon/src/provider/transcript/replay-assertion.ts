// The post-replay assertion: a replay is verified by what the session answers, never by what the
// call returned. `replayTranscript` completes only after the reconstituted session is read back
// and answers consistently with the transcript's tail; zero turns, an unreadable session or a
// contradicting tail fails the operation.
//
// The seeding surfaces are untyped at the wire (Codex's `thread/inject_items` takes
// `Array<JsonValue>`), so a frame the provider does not understand is accepted and dropped, and a
// successful call over an empty session is ordinary. The comparison rules live here once so no
// driver can weaken its own verdict.

import type { CanonicalTranscriptTurn } from "@ai-sidekicks/contracts";

/** One frame as the driver wrote it; `text` is empty for a turn whose body was unreadable. */
export interface SeededTranscriptFrame {
  readonly position: number;
  readonly role: CanonicalTranscriptTurn["role"];
  readonly text: string;
}

/**
 * What the session answered. `turns` is every turn body, oldest first (the assertion counts
 * turns, so not a tail window); `unreadable` never means the seed took.
 */
export type ReplayTargetReadback =
  | { readonly kind: "turns"; readonly turns: readonly string[] }
  | { readonly kind: "unreadable"; readonly reason: string };

/**
 * Reads a target back, keyed by its provider session id. A rejection is equivalent to
 * `unreadable`: a driver that catches one MUST convert it to that arm, never to a pass.
 */
export type ReplayTargetReadbackReader = (
  targetProviderSessionId: string,
) => Promise<ReplayTargetReadback>;

/** Why a replay was refuted. Closed on purpose, so no unanticipated shape can become a pass. */
export type PostReplayRefutation =
  | "target-unreadable"
  | "answered-zero-turns"
  | "fewer-turns-than-seeded"
  | "no-comparable-content"
  | "tail-mismatch";

/** The assertion's result: confirmed with the counts compared, or refuted with the reason. */
export type PostReplayVerdict =
  | {
      readonly outcome: "confirmed";
      /** How many tail frames were compared body to body; at least 1. */
      readonly comparedTurns: number;
      /** How many turns the target answered with. */
      readonly answeredTurns: number;
    }
  | {
      readonly outcome: "refuted";
      readonly refutation: PostReplayRefutation;
      /** Operator-facing detail. Carries no transcript body. */
      readonly detail: string;
    };

/**
 * How many tail bodies are compared. One would pass a provider that kept only the last frame;
 * the turn-count check covers the interior.
 */
export const POST_REPLAY_TAIL_DEPTH: number = 3;

// Only line endings and surrounding whitespace are forgiven; looser matching would let a provider
// that summarized, truncated or echoed the seed pass.
function normalizeTurnBodyForComparison(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

/**
 * Compares what the driver wrote against what the target answered. Every ambiguous case refutes:
 * a refuted replay falls back to the memo projection, a wrong confirmation loses the conversation.
 *
 * @throws {RangeError} when `seeded` is empty.
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

  // Named apart from the count check: it is the shape of a provider that stored none.
  if (answeredTurns === 0) {
    return {
      outcome: "refuted",
      refutation: "answered-zero-turns",
      detail: `the replay target answered with zero turns after ${String(seeded.length)} frame(s) were seeded`,
    };
  }

  // More turns than seeded is tolerated (a provider may add a preamble or split a frame); the
  // tail comparison keeps that from admitting a padded answer.
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

  // An all-empty seeded tail would compare `"" === ""` and reduce to the count check. Only the
  // expected side is read, so invented prose still reports as `tail-mismatch`.
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
      // Positions and lengths only: the detail reaches diagnostics, which must not hold transcript
      // content.
      return {
        outcome: "refuted",
        refutation: "tail-mismatch",
        detail: `the replay target's tail contradicts the transcript at seeded position ${seededPosition}: expected a ${String(expected.length)}-character body, the target answered with a ${String(observed.length)}-character one`,
      };
    }
  }

  return { outcome: "confirmed", comparedTurns, answeredTurns };
}

/**
 * Thrown when the assertion refutes, not returned as `degraded` (which
 * `DriverTranscriptReplayResult` reserves for the memo floor). The caller abandons the target and
 * settles on the memo floor.
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

/** Why a replay target is unusable; `replay-completed` retires it too, against a second seeding. */
export type ReplayTargetAbandonmentCause =
  | "target-not-fresh"
  | "interior-refusal"
  | "ambiguous-delivery"
  | "readback-unavailable"
  | "assertion-refuted"
  | "replay-completed";

/** Thrown when a caller reaches for a target this daemon has retired. */
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
 * The per-driver record of burned replay targets, in memory on purpose (after a restart Codex
 * replay resolves only live session records, so a burned target stays unseedable) and uncapped
 * (evicting an entry would re-admit one). Every cause burns the target, even a pristine one; the
 * memo settlement always lands in a fresh target.
 */
export class ReplayTargetLedger {
  readonly #abandoned: Map<string, ReplayTargetAbandonmentCause> = new Map();

  /** Records a target as burned. Idempotent; the first cause wins. */
  abandon(targetProviderSessionId: string, cause: ReplayTargetAbandonmentCause): void {
    if (!this.#abandoned.has(targetProviderSessionId)) {
      this.#abandoned.set(targetProviderSessionId, cause);
    }
  }

  /** Retires a target whose replay confirmed, so it can never be seeded twice. */
  consume(targetProviderSessionId: string): void {
    this.abandon(targetProviderSessionId, "replay-completed");
  }

  /** The cause a target was abandoned for, or `undefined` if it is still usable. */
  abandonmentCauseFor(targetProviderSessionId: string): ReplayTargetAbandonmentCause | undefined {
    return this.#abandoned.get(targetProviderSessionId);
  }

  /** Throws {@link ReplayTargetAbandonedError} for an abandoned target; call before seeding. */
  assertUsable(targetProviderSessionId: string): void {
    const cause: ReplayTargetAbandonmentCause | undefined =
      this.#abandoned.get(targetProviderSessionId);
    if (cause !== undefined) {
      throw new ReplayTargetAbandonedError(targetProviderSessionId, cause);
    }
  }
}
