// The params and results of the driver operations that act on one live run: pause and continue,
// withdrawing a waiting message, overruling a reviewer's block, answering a provider's choice and
// resending a held turn on a faster model; and what the run queue serves a driver starting a run.
import type { AgentId } from "@ai-sidekicks/contracts/agent/definition";
import type { ArtifactId } from "@ai-sidekicks/contracts/artifacts/id";
import type {
  RunRefusalChoice,
  RunUsageCreditsChoice,
} from "@ai-sidekicks/contracts/run/provider-choice";
import type { RunId } from "@ai-sidekicks/contracts/run/id";
import type { PickedSkill } from "@ai-sidekicks/contracts/provider/driver/intervention";
import type { QueueItemSummary } from "@ai-sidekicks/contracts/run/queue";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

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
