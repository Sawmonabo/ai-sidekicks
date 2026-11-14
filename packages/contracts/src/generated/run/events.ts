// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The stored payloads of a run's state changes, of the markers its provider reports, of its turns' starts, steers and ends, and of its interventions, one per event type.

import type { AgentTreeMember } from "../agent/tree.js";
import type { SourcePosition } from "../event/envelope.js";
import type { InterruptReason } from "../orchestration.js";
import type { ExecutionPosture } from "../provider/driver/capabilities.js";
import type { RecoveryCondition } from "../provider/driver/recovery.js";
import type { ProviderId } from "../provider/id.js";
import type { SessionId } from "../session/id.js";
import type { DeviceId } from "../trust-statement.js";
import type { ProviderTurnId } from "../turn.js";
import type { ChildStoppedState } from "./children.js";
import type { ProcessExit, RunFailureCategory, StopTrigger } from "./control.js";
import type { RunFailureCause } from "./failure-cause.js";
import type { RunId } from "./id.js";
import type { InterventionId, InterventionType } from "./intervention.js";
import type { QueueItemId } from "./queue.js";
import type { RunState } from "./state.js";

/** The actor of an intervention the daemon made itself, such as a stop at a spend limit. */
export const DAEMON_INTERVENTION_ACTOR = "daemon" as const;

/**
 * A run state with a state-change event of its own: every state but `queued`, the run's birth.
 */
export type RunStateChangeState =
  | "starting"
  | "running"
  | "waitingForApproval"
  | "waitingForInput"
  | "pausing"
  | "paused"
  | "completed"
  | "interrupted"
  | "stopped"
  | "failed";
/**
 * Who reported a turn's end, not who cut the turn: the provider, whose own end frame arrived, or
 * the daemon, which wrote the end with no provider frame.
 */
export type TurnEndOrigin = "provider" | "daemon";
/**
 * Why a turn was interrupted or failed, where the daemon knows it: it saw the provider process
 * exit, a restart settled the open turn, the person stopped the service under it, or a limit the
 * person set cut it.
 */
export type TurnEndCause =
  | "processExit"
  | "daemonRestart"
  | "daemonStop"
  | "stepLimit"
  | "spendLimit"
  | "tokenLimit";
/**
 * Who an intervention is from: the daemon for its own, or the device whose connection carried
 * it. Never a person. The arms are disjoint: a device actor is never `daemon`.
 */
export type InterventionActor = "daemon" | DeviceId;

/**
 * The `agent.run.starting` payload.
 */
export interface AgentRunStartingPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The run.
   */
  runId: RunId;
  /**
   * The run version after the transition.
   */
  runVersion: number;
  /**
   * The state it left.
   */
  previousState: RunState;
  /**
   * The state it entered.
   */
  newState: "starting";
  /**
   * Why the run failed.
   */
  failureCategory?: RunFailureCategory;
  /**
   * Why the run needs recovery.
   */
  recoveryCondition?: RecoveryCondition;
}
/**
 * The `agent.run.running` payload, which stamps the effective posture, final only once
 * running.
 */
export interface AgentRunRunningPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The run.
   */
  runId: RunId;
  /**
   * The run version after the transition.
   */
  runVersion: number;
  /**
   * The state it left.
   */
  previousState: RunState;
  /**
   * The state it entered.
   */
  newState: "running";
  /**
   * Why the run failed.
   */
  failureCategory?: RunFailureCategory;
  /**
   * Why the run needs recovery.
   */
  recoveryCondition?: RecoveryCondition;
  /**
   * The effective posture, with the workspace root resolved.
   */
  executionPosture?: ExecutionPosture;
}
/**
 * The `agent.run.waitingForApproval` payload.
 */
export interface AgentRunWaitingForApprovalPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The run.
   */
  runId: RunId;
  /**
   * The run version after the transition.
   */
  runVersion: number;
  /**
   * The state it left.
   */
  previousState: RunState;
  /**
   * The state it entered.
   */
  newState: "waitingForApproval";
  /**
   * Why the run failed.
   */
  failureCategory?: RunFailureCategory;
  /**
   * Why the run needs recovery.
   */
  recoveryCondition?: RecoveryCondition;
}
/**
 * The `agent.run.waitingForInput` payload.
 */
export interface AgentRunWaitingForInputPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The run.
   */
  runId: RunId;
  /**
   * The run version after the transition.
   */
  runVersion: number;
  /**
   * The state it left.
   */
  previousState: RunState;
  /**
   * The state it entered.
   */
  newState: "waitingForInput";
  /**
   * Why the run failed.
   */
  failureCategory?: RunFailureCategory;
  /**
   * Why the run needs recovery.
   */
  recoveryCondition?: RecoveryCondition;
}
/**
 * The `agent.run.pausing` payload.
 */
export interface AgentRunPausingPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The run.
   */
  runId: RunId;
  /**
   * The run version after the transition.
   */
  runVersion: number;
  /**
   * The state it left.
   */
  previousState: RunState;
  /**
   * The state it entered.
   */
  newState: "pausing";
  /**
   * Why the run failed.
   */
  failureCategory?: RunFailureCategory;
  /**
   * Why the run needs recovery.
   */
  recoveryCondition?: RecoveryCondition;
}
/**
 * The `agent.run.paused` payload.
 */
export interface AgentRunPausedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The run.
   */
  runId: RunId;
  /**
   * The run version after the transition.
   */
  runVersion: number;
  /**
   * The state it left.
   */
  previousState: RunState;
  /**
   * The state it entered.
   */
  newState: "paused";
  /**
   * Why the run failed.
   */
  failureCategory?: RunFailureCategory;
  /**
   * Why the run needs recovery.
   */
  recoveryCondition?: RecoveryCondition;
}
/**
 * The `agent.run.completed` payload.
 */
export interface AgentRunCompletedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The run.
   */
  runId: RunId;
  /**
   * The run version after the transition.
   */
  runVersion: number;
  /**
   * The state it left.
   */
  previousState: RunState;
  /**
   * The state it entered.
   */
  newState: "completed";
  /**
   * Why the run failed.
   */
  failureCategory?: RunFailureCategory;
  /**
   * Why the run needs recovery.
   */
  recoveryCondition?: RecoveryCondition;
  /**
   * Present only on a terminal the daemon itself closed, which is never a crash.
   */
  intendedClose?: true;
}
/**
 * The `agent.run.interrupted` payload, with why the daemon interrupted the run where it did so
 * itself; the person's own interrupt carries none.
 */
export interface AgentRunInterruptedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The run.
   */
  runId: RunId;
  /**
   * The run version after the transition.
   */
  runVersion: number;
  /**
   * The state it left.
   */
  previousState: RunState;
  /**
   * The state it entered.
   */
  newState: "interrupted";
  /**
   * Why the run failed.
   */
  failureCategory?: RunFailureCategory;
  /**
   * Why the run needs recovery.
   */
  recoveryCondition?: RecoveryCondition;
  /**
   * Present only on a terminal the daemon itself closed, which is never a crash.
   */
  intendedClose?: true;
  /**
   * Why the daemon itself interrupted the run.
   */
  trigger?: InterruptReason;
}
/**
 * The `agent.run.stopped` payload, with why the daemon stopped the run where it did so
 * itself.
 */
export interface AgentRunStoppedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The run.
   */
  runId: RunId;
  /**
   * The run version after the transition.
   */
  runVersion: number;
  /**
   * The state it left.
   */
  previousState: RunState;
  /**
   * The state it entered.
   */
  newState: "stopped";
  /**
   * Why the run failed.
   */
  failureCategory?: RunFailureCategory;
  /**
   * Why the run needs recovery.
   */
  recoveryCondition?: RecoveryCondition;
  /**
   * Present only on a terminal the daemon itself closed, which is never a crash.
   */
  intendedClose?: true;
  /**
   * Why the daemon itself stopped the run.
   */
  trigger?: StopTrigger;
}
/**
 * The `agent.run.failed` payload, with its typed cause, the provider's own words and its
 * process's own exit.
 */
export interface AgentRunFailedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The run.
   */
  runId: RunId;
  /**
   * The run version after the transition.
   */
  runVersion: number;
  /**
   * The state it left.
   */
  previousState: RunState;
  /**
   * The state it entered.
   */
  newState: "failed";
  /**
   * Why the run failed.
   */
  failureCategory?: RunFailureCategory;
  /**
   * Why the run needs recovery.
   */
  recoveryCondition?: RecoveryCondition;
  /**
   * Present only on a terminal the daemon itself closed, which is never a crash.
   */
  intendedClose?: true;
  /**
   * The run's typed failure cause.
   */
  failureCause?: RunFailureCause;
  /**
   * The provider's own words on why it failed the run, shown whole and never parsed.
   */
  providerFailureDetail?: string;
  /**
   * How the provider process ended under the turn, where it ended on its own.
   */
  processExit?: ProcessExit;
}
/**
 * The `agent.run.providerInitialized` payload: the provider process reported its start for the
 * run, with the model it runs where it named one.
 */
export interface AgentRunProviderInitializedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The run.
   */
  runId: RunId;
  /**
   * The run version when the event was recorded.
   */
  runVersion: number;
  /**
   * The provider.
   */
  provider: ProviderId;
  /**
   * The model it runs.
   */
  model?: string;
}
/**
 * The `agent.turn.started` payload: a turn opened within the run, at the run position its
 * opening message takes and under the provider's own turn id where the provider named them.
 */
export interface AgentTurnStartedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The run.
   */
  runId: RunId;
  /**
   * The run version when the event was recorded.
   */
  runVersion: number;
  /**
   * The turn's number within its run, from 1.
   */
  turnNumber: number;
  /**
   * The run position the turn's opening message takes.
   */
  position?: SourcePosition;
  /**
   * The provider's own id of the turn, so what the provider reports against that id joins
   * the turn it opened in.
   */
  providerTurnId?: ProviderTurnId;
}
/**
 * The `agent.turn.steered` payload: the provider took one of the person's waiting messages
 * into a running turn, and that message opens a run position of its own.
 */
export interface AgentTurnSteeredPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The run.
   */
  runId: RunId;
  /**
   * The run version when the event was recorded.
   */
  runVersion: number;
  /**
   * The number of the turn the message joined, within its run.
   */
  turnNumber: number;
  /**
   * The run position the steer opens.
   */
  position: SourcePosition;
  /**
   * The queue item whose message the turn took.
   */
  messageId: QueueItemId;
}
/**
 * The `agent.turn.completed` payload: the turn ended normally, as the provider reported it.
 */
export interface AgentTurnCompletedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The run.
   */
  runId: RunId;
  /**
   * The run version when the event was recorded.
   */
  runVersion: number;
  /**
   * The turn's number within its run.
   */
  turnNumber: number;
}
/**
 * The `agent.turn.interrupted` payload: the turn was cut, its partial output kept.
 */
export interface AgentTurnInterruptedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The run.
   */
  runId: RunId;
  /**
   * The run version when the event was recorded.
   */
  runVersion: number;
  /**
   * The turn's number within its run.
   */
  turnNumber: number;
  /**
   * Who reported the turn's end.
   */
  origin: TurnEndOrigin;
  /**
   * Why the turn ended, where the daemon knows it.
   */
  cause?: TurnEndCause;
}
/**
 * The `agent.children.stopped` payload: the flow row of one stop of every agent a session
 * dispatched, its word the session's provider's and its names the agents the stop reached.
 */
export interface AgentChildrenStoppedPayload {
  /**
   * How the session's provider stops a child, whatever each reached child's own end.
   */
  word: ChildStoppedState;
  /**
   * The agents the stop reached, in dispatch order; one whose stop failed or that had already
   * ended is left out.
   */
  reached: AgentTreeMember[];
}
/**
 * The `agent.turn.failed` payload: the turn failed.
 */
export interface AgentTurnFailedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The run.
   */
  runId: RunId;
  /**
   * The run version when the event was recorded.
   */
  runVersion: number;
  /**
   * The turn's number within its run.
   */
  turnNumber: number;
  /**
   * Who reported the turn's end.
   */
  origin: TurnEndOrigin;
  /**
   * Why the turn ended, where the daemon knows it.
   */
  cause?: TurnEndCause;
}
/**
 * The `agent.run.workerShuttingDown` payload: the provider said its worker is shutting down
 * mid-run, with its own reason where it sent one. An early warning, never the run's end.
 */
export interface AgentRunWorkerShuttingDownPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The run.
   */
  runId: RunId;
  /**
   * The run version when the event was recorded.
   */
  runVersion: number;
  /**
   * The provider's reason.
   */
  reason?: string;
}
/**
 * The `agent.run.parentCorrected` payload: the run now hangs under `parentRunId`, the run whose
 * call started it.
 */
export interface AgentRunParentCorrectedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The run moved.
   */
  runId: RunId;
  /**
   * The run whose call started it.
   */
  parentRunId: RunId;
}
/**
 * The `agent.intervention.requested` payload.
 */
export interface AgentInterventionRequestedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The intervention.
   */
  interventionId: InterventionId;
  /**
   * The run it acts on.
   */
  targetRunId: RunId;
  /**
   * What it does.
   */
  type: InterventionType;
  /**
   * Its state.
   */
  state: "requested";
  /**
   * Who it is from.
   */
  actor: InterventionActor;
}
/**
 * The `agent.intervention.accepted` payload.
 */
export interface AgentInterventionAcceptedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The intervention.
   */
  interventionId: InterventionId;
  /**
   * The run it acts on.
   */
  targetRunId: RunId;
  /**
   * What it does.
   */
  type: InterventionType;
  /**
   * Its state.
   */
  state: "accepted";
  /**
   * Who it is from.
   */
  actor: InterventionActor;
}
/**
 * The `agent.intervention.applied` payload.
 */
export interface AgentInterventionAppliedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The intervention.
   */
  interventionId: InterventionId;
  /**
   * The run it acts on.
   */
  targetRunId: RunId;
  /**
   * What it does.
   */
  type: InterventionType;
  /**
   * Its state.
   */
  state: "applied";
  /**
   * Who it is from.
   */
  actor: InterventionActor;
}
/**
 * The `agent.intervention.rejected` payload.
 */
export interface AgentInterventionRejectedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The intervention.
   */
  interventionId: InterventionId;
  /**
   * The run it acts on.
   */
  targetRunId: RunId;
  /**
   * What it does.
   */
  type: InterventionType;
  /**
   * Its state.
   */
  state: "rejected";
  /**
   * Who it is from.
   */
  actor: InterventionActor;
}
/**
 * The `agent.intervention.degraded` payload.
 */
export interface AgentInterventionDegradedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The intervention.
   */
  interventionId: InterventionId;
  /**
   * The run it acts on.
   */
  targetRunId: RunId;
  /**
   * What it does.
   */
  type: InterventionType;
  /**
   * Its state.
   */
  state: "degraded";
  /**
   * Who it is from.
   */
  actor: InterventionActor;
}
/**
 * The `agent.intervention.expired` payload.
 */
export interface AgentInterventionExpiredPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The intervention.
   */
  interventionId: InterventionId;
  /**
   * The run it acts on.
   */
  targetRunId: RunId;
  /**
   * What it does.
   */
  type: InterventionType;
  /**
   * Its state.
   */
  state: "expired";
  /**
   * Who it is from.
   */
  actor: InterventionActor;
}
/**
 * The `agent.intervention.failed` payload, with why, in the words its reply and its stored row
 * carry.
 */
export interface AgentInterventionFailedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The intervention.
   */
  interventionId: InterventionId;
  /**
   * The run it acts on.
   */
  targetRunId: RunId;
  /**
   * What it does.
   */
  type: InterventionType;
  /**
   * Its state.
   */
  state: "failed";
  /**
   * Who it is from.
   */
  actor: InterventionActor;
  /**
   * The thrown error's code, else its message, or why it never completed or was never
   * sent.
   */
  failureReason: string;
}

export {
  validateAgentChildrenStoppedPayload,
  validateAgentInterventionAcceptedPayload,
  validateAgentInterventionAppliedPayload,
  validateAgentInterventionDegradedPayload,
  validateAgentInterventionExpiredPayload,
  validateAgentInterventionFailedPayload,
  validateAgentInterventionRejectedPayload,
  validateAgentInterventionRequestedPayload,
  validateAgentRunCompletedPayload,
  validateAgentRunFailedPayload,
  validateAgentRunInterruptedPayload,
  validateAgentRunParentCorrectedPayload,
  validateAgentRunPausedPayload,
  validateAgentRunPausingPayload,
  validateAgentRunProviderInitializedPayload,
  validateAgentRunRunningPayload,
  validateAgentRunStartingPayload,
  validateAgentRunStoppedPayload,
  validateAgentRunWaitingForApprovalPayload,
  validateAgentRunWaitingForInputPayload,
  validateAgentRunWorkerShuttingDownPayload,
  validateAgentTurnCompletedPayload,
  validateAgentTurnFailedPayload,
  validateAgentTurnInterruptedPayload,
  validateAgentTurnStartedPayload,
  validateAgentTurnSteeredPayload,
  validateInterventionActor,
  validateTurnEndCause,
  validateTurnEndOrigin,
} from "../checks/run/events.js";
