// Seeding a fresh Claude replay target frame by frame and confirming it by readback, burning the
// target in the ledger on any failure so it is never reused.

import {
  assertReplayReconstituted,
  PostReplayAssertionFailedError,
  type PostReplayVerdict,
  type ReplayTargetAbandonmentCause,
  type ReplayTargetLedger,
  type ReplayTargetReadback,
  type SeededTranscriptFrame,
} from "../../transcript/replay-assertion.js";
import type {
  ClaudeTranscriptSeedOutcome,
  ClaudeTranscriptSeedingSurface,
} from "./capabilities.js";
import { ClaudeTranscriptReplayFailedError, readReplayTargetSafely } from "./transcript-replay.js";

/** Seeds replay targets through a build's seeding surface, abandoning a target that fails. */
export class ClaudeReplaySeeding {
  readonly #replayTargets: ReplayTargetLedger;

  constructor(replayTargets: ReplayTargetLedger) {
    this.#replayTargets = replayTargets;
  }

  /**
   * Checks the target is empty, seeds every frame and asserts the readback reconstitutes them.
   * Throws after abandoning the target when any step fails.
   */
  async seedFreshTarget(
    surface: ClaudeTranscriptSeedingSurface,
    targetProviderSessionId: string,
    seeded: readonly SeededTranscriptFrame[],
  ): Promise<void> {
    // Freshness is read, not inferred: the post-replay assertion tolerates extra turns in a target.
    const priorContents: ReplayTargetReadback = await readReplayTargetSafely(
      surface.readBack,
      targetProviderSessionId,
    );
    if (priorContents.kind === "unreadable") {
      this.#abandonReplayTarget(targetProviderSessionId, "readback-unavailable");
      throw new ClaudeTranscriptReplayFailedError(
        `Replay target "${targetProviderSessionId}" could not be read before seeding (${priorContents.reason}), so its freshness is unknown; the target was abandoned.`,
      );
    }
    if (priorContents.turns.length > 0) {
      this.#abandonReplayTarget(targetProviderSessionId, "target-not-fresh");
      throw new ClaudeTranscriptReplayFailedError(
        `Refusing to replay into session "${targetProviderSessionId}": it already holds ${String(priorContents.turns.length)} turn(s), and a replay target must be fresh.`,
      );
    }

    for (const frame of seeded) {
      const outcome: ClaudeTranscriptSeedOutcome = await surface.seedFrame(
        targetProviderSessionId,
        frame,
      );
      if (outcome.delivery === "applied") {
        continue;
      }
      const cause: ReplayTargetAbandonmentCause =
        outcome.delivery === "ambiguous" ? "ambiguous-delivery" : "interior-refusal";
      this.#abandonReplayTarget(targetProviderSessionId, cause);
      throw new ClaudeTranscriptReplayFailedError(
        `Claude replay seeding stopped at transcript position ${String(frame.position)} (${outcome.delivery}: ${outcome.reason}); the target was abandoned and must not be reused.`,
      );
    }

    const readback: ReplayTargetReadback = await readReplayTargetSafely(
      surface.readBack,
      targetProviderSessionId,
    );
    const verdict: PostReplayVerdict = assertReplayReconstituted(seeded, readback);
    if (verdict.outcome === "refuted") {
      const cause: ReplayTargetAbandonmentCause =
        verdict.refutation === "target-unreadable" ? "readback-unavailable" : "assertion-refuted";
      this.#abandonReplayTarget(targetProviderSessionId, cause);
      throw new PostReplayAssertionFailedError(targetProviderSessionId, seeded.length, verdict);
    }
  }

  // Records the burn in the ledger only; unlike the Codex driver it does not dispose the process,
  // whose handle the caller that established the session holds.
  #abandonReplayTarget(targetProviderSessionId: string, cause: ReplayTargetAbandonmentCause): void {
    this.#replayTargets.abandon(targetProviderSessionId, cause);
  }
}
