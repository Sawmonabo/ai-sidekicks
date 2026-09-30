// Seeding a fresh Codex replay target with one `thread/inject_items` request per frame and
// confirming it by readback, abandoning and closing the target on any failure.

import {
  assertReplayReconstituted,
  PostReplayAssertionFailedError,
  type PostReplayVerdict,
  type ReplayTargetAbandonmentCause,
  type ReplayTargetLedger,
  type ReplayTargetReadback,
  type ReplayTargetReadbackReader,
  type SeededTranscriptFrame,
} from "../../transcript/replay-assertion.js";
import type { CodexLifecycleOptions, CodexSessionRecord } from "./session-state.js";
import type { CodexRequestAttempt } from "./app-server-connection.js";
import { CodexTransportError } from "./session-errors.js";
import { codexResponsesItemForFrame, readRenderedTranscriptFrameForReplay } from "./thread-view.js";
import { CODEX_THREAD_INJECT_ITEMS_METHOD } from "./provider-commands.js";
import type { CloseSessionParams, ReplayTranscriptParams } from "../../provider-driver.js";

/** The replay ledger, the bound readback and the close an abandoned target is torn down through. */
export interface CodexReplaySeedingDependencies {
  readonly options: Pick<CodexLifecycleOptions, "transcriptReplayReadback">;
  readonly replayTargets: ReplayTargetLedger;
  readonly closeSession: (params: CloseSessionParams) => Promise<void>;
}

/** Seeds a replay target and asserts the readback, abandoning a target that fails any step. */
export class CodexReplaySeeding {
  readonly #options: CodexReplaySeedingDependencies["options"];
  readonly #replayTargets: ReplayTargetLedger;
  readonly #closeSession: (params: CloseSessionParams) => Promise<void>;

  constructor(dependencies: CodexReplaySeedingDependencies) {
    this.#options = dependencies.options;
    this.#replayTargets = dependencies.replayTargets;
    this.#closeSession = dependencies.closeSession;
  }

  /**
   * Refuses a target that already holds turns, parses and seeds every frame, and asserts the
   * readback reconstitutes them. Throws after abandoning the target when any step fails.
   */
  async seedFreshTarget(
    record: CodexSessionRecord,
    targetProviderSessionId: string,
    params: ReplayTranscriptParams,
  ): Promise<void> {
    // A non-empty turn ledger proves the target already held a conversation.
    if (record.turnBoundaries.length > 0) {
      this.#abandonReplayTarget(record, targetProviderSessionId, "target-not-fresh");
      throw new CodexTransportError(
        `Refusing to replay into Codex thread "${record.threadId}": it already holds ${String(record.turnBoundaries.length)} turn(s), and a replay target must be fresh.`,
        { method: CODEX_THREAD_INJECT_ITEMS_METHOD },
      );
    }

    const seeded: SeededTranscriptFrame[] = [];
    for (const frame of params.frames) {
      // Fail closed before any write: a skipped frame would falsify the empty loss list.
      seeded.push(readRenderedTranscriptFrameForReplay(frame));
    }
    if (seeded.length === 0) {
      throw new CodexTransportError(
        "Refusing to replay an empty transcript into a Codex thread: there is nothing to reconstitute, and a post-replay assertion over no frames confirms nothing.",
        { method: CODEX_THREAD_INJECT_ITEMS_METHOD },
      );
    }

    for (const frame of seeded) {
      const attempt: CodexRequestAttempt = await record.connection.attemptRequest(
        CODEX_THREAD_INJECT_ITEMS_METHOD,
        { threadId: record.threadId, items: [codexResponsesItemForFrame(frame)] },
      );
      if (attempt.settled === "answered") {
        continue;
      }
      // `indeterminate` (bytes left, arrival unknowable) must not be recorded as a refusal.
      const cause: ReplayTargetAbandonmentCause =
        attempt.delivery === "indeterminate" ? "ambiguous-delivery" : "interior-refusal";
      this.#abandonReplayTarget(record, targetProviderSessionId, cause);
      throw new CodexTransportError(
        `Codex replay seeding stopped at transcript position ${String(frame.position)} (${attempt.delivery}); the target was abandoned and must not be reused.`,
        { method: CODEX_THREAD_INJECT_ITEMS_METHOD },
      );
    }

    const readReadback: ReplayTargetReadbackReader | undefined =
      this.#options.transcriptReplayReadback;
    if (readReadback === undefined) {
      // Answered seeding calls are not proof; without a readback a discarded seed looks faithful.
      this.#abandonReplayTarget(record, targetProviderSessionId, "readback-unavailable");
      throw new CodexTransportError(
        `Codex replay into thread "${record.threadId}" seeded ${String(seeded.length)} frame(s) but no target-readback reader is bound, so the post-replay assertion cannot run; the target was abandoned.`,
        { method: CODEX_THREAD_INJECT_ITEMS_METHOD },
      );
    }

    let readback: ReplayTargetReadback;
    try {
      readback = await readReadback(targetProviderSessionId);
    } catch (error: unknown) {
      // A rejecting reader is the `unreadable` arm of the readback contract.
      readback = {
        kind: "unreadable",
        reason: error instanceof Error ? error.message : String(error),
      };
    }

    const verdict: PostReplayVerdict = assertReplayReconstituted(seeded, readback);
    if (verdict.outcome === "refuted") {
      const cause: ReplayTargetAbandonmentCause =
        verdict.refutation === "target-unreadable" ? "readback-unavailable" : "assertion-refuted";
      this.#abandonReplayTarget(record, targetProviderSessionId, cause);
      throw new PostReplayAssertionFailedError(targetProviderSessionId, seeded.length, verdict);
    }
  }

  /**
   * Records the abandonment first, so the target is unusable even if disposal fails, then closes
   * its process. A disposal failure stays in the session map and is swallowed: the caller is
   * throwing.
   */
  #abandonReplayTarget(
    record: CodexSessionRecord,
    targetProviderSessionId: string,
    cause: ReplayTargetAbandonmentCause,
  ): void {
    this.#replayTargets.abandon(targetProviderSessionId, cause);
    void this.#closeSession({ sessionId: record.sessionId }).catch(() => {
      // The caller is already throwing the replay error.
    });
  }
}
