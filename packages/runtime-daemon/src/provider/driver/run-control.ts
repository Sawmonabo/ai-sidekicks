// The params and results of the driver operations that act on one live run: a steer or an
// interrupt, pause and continue, withdrawing a waiting message, overruling a reviewer's block,
// answering a provider's choice and resending a held turn on a faster model; and what the run queue
// serves a driver starting a run.
import { z } from "zod";

import type { AgentId } from "@ai-sidekicks/contracts/agent/definition";
import type { ArtifactId } from "@ai-sidekicks/contracts/artifacts/id";
import type { ApplyInterventionRequest } from "@ai-sidekicks/contracts/provider/driver/intervention";
import type {
  RunRefusalChoice,
  RunUsageCreditsChoice,
} from "@ai-sidekicks/contracts/run/provider-choice";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { QueueItemSummary } from "@ai-sidekicks/contracts/run/queue";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

/**
 * A skill picked for a message as its provider listed it: its name and the file the provider loads
 * it from, absolute. The daemon resolves a person's pick to it, so no path a client sent reaches a
 * provider.
 */
export interface PickedSkill {
  name: string;
  path: string;
}
/** Parses a {@link PickedSkill}. */
export const PickedSkillSchema: z.ZodType<PickedSkill, PickedSkill> = z
  .object({
    name: z.string().min(1),
    path: z.string().min(1),
  })
  .strict();

/**
 * Payload of a driver's `steer`: the queued message's content, its attachments, the skills the
 * person picked for it and a target turn.
 */
interface SteerPayload {
  content: string;
  // Order-preserving: an attachment the turn cannot resolve becomes an unresolved marker with its
  // cause in its own position, never dropped. No count of the app's own bounds the list.
  attachments?: ArtifactId[] | undefined;
  skills?: PickedSkill[] | undefined;
  expectedTurnId?: string | undefined;
}

/**
 * What the daemon asks a driver to do on a live run, one arm per verb: a `steer` delivers a message
 * the run queue holds, and an `interrupt` carries out an intervention. `clientIdempotencyKey` is
 * passed through unchanged; a steer's is the message's own id.
 */
export type ApplyInterventionParams =
  | {
      type: "steer";
      targetRunId: RunId;
      expectedRunVersion: number;
      clientIdempotencyKey: string;
      payload: SteerPayload;
    }
  | ApplyInterventionRequest;

/**
 * Thrown by a driver's steer that was not sent because the turn it was handed for had ended
 * first: nothing reached the provider, and the message is left for the run's next turn.
 */
export class SteerTurnEndedError extends Error {
  readonly runId: RunId;

  constructor(runId: RunId) {
    super(`The turn of run ${runId} ended before the steer was sent.`);
    this.name = "SteerTurnEndedError";
    this.runId = runId;
  }
}

/**
 * Params of `pauseRun`: the lead run or a provider subagent's child run to stop after the step in
 * flight. The caller has moved the run to `pausing`; the driver reports `paused` once nothing runs.
 */
export interface PauseRunParams {
  sessionId: SessionId;
  runId: RunId;
}

/**
 * A message waiting for a run, as the queue holds it, for delivery when the run continues: its
 * words, files and the skills picked for it.
 */
export type WaitingMessage = Pick<QueueItemSummary, "id" | "content" | "attachments"> & {
  readonly skills?: readonly PickedSkill[] | undefined;
};

/**
 * Params of `resumeRun`: the paused or pausing run to continue from where it stopped, with the
 * messages that waited for it in send order, delivered as it continues.
 */
export interface ResumeRunParams {
  sessionId: SessionId;
  runId: RunId;
  messages: readonly WaitingMessage[];
}

/**
 * Params of `withdrawQueuedMessage` (gated on `steer`): takes back a steer sent into a running
 * turn before the provider reads it. `clientIdempotencyKey` is the steer's own key, which the
 * driver sent as the message's id.
 */
export interface WithdrawQueuedMessageParams {
  sessionId: SessionId;
  runId: RunId;
  clientIdempotencyKey: string;
}

/**
 * What a withdraw did: `withdrawn` before the provider read the message, or `already_delivered`
 * when the message is no longer the driver's to take back: the provider took it into the turn, or
 * the driver had already sent it on, so nothing was taken back.
 */
export type WithdrawQueuedMessageResult = { status: "withdrawn" } | { status: "already_delivered" };

/**
 * Params of `overrideDenial`: `Allow once` on a block by the provider's own reviewer. The denial is
 * the provider's own, as the daemon kept it with the block: Claude Code's action as its
 * `PermissionDenied` hook received it, or Codex's review as Codex sent it.
 */
export interface OverrideDenialParams {
  sessionId: SessionId;
  providerDenial: unknown;
}

/** The person's answer to a choice the provider holds a run on, one arm per kind of choice. */
export type ProviderChoiceAnswer =
  | { dialog: "refusal"; choice: RunRefusalChoice }
  | { dialog: "usage_credits"; choice: RunUsageCreditsChoice };

/** Params of `answerProviderChoice`: the run the choice holds and the person's answer. */
export interface AnswerProviderChoiceParams {
  sessionId: SessionId;
  runId: RunId;
  answer: ProviderChoiceAnswer;
}

/**
 * What answering a choice did: `answered` when the provider took the answer, or `not_pending` when
 * the run holds no choice of that kind, because it was settled or never asked.
 */
export type AnswerProviderChoiceResult = { status: "answered" } | { status: "not_pending" };

/**
 * Params of `retryTurnOnFasterModel`: resend the turn `expectedTurnId` that the provider holds for
 * a safety check, on `model`.
 */
export interface FasterModelRetryParams {
  sessionId: SessionId;
  runId: RunId;
  expectedTurnId: string;
  model: string;
}

/**
 * How a faster-model retry ended: sent again, or refused with its reason because the turn is no
 * longer the run's latest or its reply has started. A failure after the retry was accepted throws.
 */
export type FasterModelRetryOutcome =
  | { readonly state: "applied" }
  | { readonly state: "rejected"; readonly rejectionReason: string };

/**
 * A tool call of a run's turn finished while the turn still runs: the step boundary at which the
 * run queue hands the driver every message it holds for that run, in send order.
 */
export interface RunToolBoundary {
  readonly sessionId: SessionId;
  readonly runId: RunId;
}

/** The binding a turn the daemon starts on a session itself runs on, and the session's agent. */
export interface DaemonTurnBinding {
  readonly bindingId: string;
  readonly agentId: AgentId;
}

/**
 * The daemon-owned facts the Claude driver's `startRun` needs that `StartRunParams` lacks, which
 * the run queue serves. `messageId` is the person's message the opening text is, a UUID, stamped on
 * the user frame so a later cut can name it.
 */
export interface ClaudeRunDispatch {
  readonly sessionId: SessionId;
  /** The runtime binding the run's deliveries are attributed on, opened by the daemon. */
  readonly bindingId: string;
  readonly openingText: string;
  /** The message's staged files, in staging order. */
  readonly attachments: readonly ArtifactId[];
  readonly messageId: string;
}

/** Opens the binding of a turn the daemon starts on a session itself; the run queue serves it. */
export interface DaemonTurnBindingResolver {
  /** Throws when the binding cannot be opened, which ends the run failed. */
  openDaemonTurnBinding(runId: RunId, sessionId: SessionId): Promise<DaemonTurnBinding>;
}
