// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Run control: pause and resume, the recovery question after a restart, the run state stream and the run-control method table, which also serves the queue, interventions, a child's own controls and the provider's choices a run waits on.

import type { SourcePosition } from "../event/envelope.js";
import type { WireInstant } from "../internal/wire-scalars.js";
import type { SubscribeAcknowledgmentResponse } from "../jsonrpc/streaming.js";
import type { InterruptReason } from "../orchestration.js";
import type { ExecutionPosture } from "../provider/driver/capabilities.js";
import type { RecoveryCondition } from "../provider/driver/recovery.js";
import type { ProviderId } from "../provider/id.js";
import type { RunSafetyBufferingUpdatedPayload } from "../session/controls/events.js";
import type { EventCursor, SessionId } from "../session/id.js";
import type {
  AgentChildRunInterruptRequest,
  AgentChildRunInterruptResponse,
  AgentChildRunPausedUpdateRequest,
  AgentChildRunPausedUpdateResponse,
  AgentChildRunSteerRequest,
  AgentChildRunStopAllRequest,
  AgentChildRunStopAllResponse,
} from "./children.js";
import type { RunFailureCause } from "./failure-cause.js";
import type { RunId } from "./id.js";
import type { AgentRunInterveneRequest, AgentRunInterveneResponse } from "./intervention.js";
import type {
  AgentRunRefusalChoiceResolveRequest,
  AgentRunUsageCreditsChoiceResolveRequest,
} from "./provider-choice.js";
import type {
  AgentQueueItemCancelRequest,
  AgentQueueItemCancelResponse,
  AgentQueueItemCreateRequest,
  AgentQueueItemCreateResponse,
  AgentQueueItemListRequest,
  AgentQueueItemListResponse,
  AgentQueueItemReorderRequest,
  AgentQueueItemSubscribeRequest,
  RunQueueStreamFrame,
} from "./queue.js";
import type { RunState } from "./state.js";

/**
 * The code of a move the run's current state does not allow, such as a second or late answer
 * to a choice the run already settled.
 */
export const AGENT_RUN_INVALID_TRANSITION_CODE = "agent.run.invalidTransition" as const;

/**
 * The code of an `agent.run.pause` or `agent.run.resume` whose `expectedRunVersion` is not
 * the run's current version, older or newer; nothing is written and the run is left as it
 * was.
 */
export const AGENT_RUN_VERSION_STALE_CODE = "agent.run.versionStale" as const;

/**
 * Why a run failed.
 */
export type RunFailureCategory =
  | "providerFailure"
  | "transportFailure"
  | "localPersistenceFailure"
  | "projectionFailure"
  | "refused"
  | "setupFailure";
/**
 * How a process ended under work it carried: exactly one of its exit code, the signal that ended
 * it and the silence the daemon ended a provider service for, and the last lines it printed.
 * `agent.run.failed` carries a provider process's under the turn; a process the daemon closed
 * itself for any other reason, or a sleep, records none.
 */
export type ProcessExit =
  | {
      /**
       * The exit code.
       */
      exitCode: number;
      /**
       * Never present beside an exit code.
       */
      signal?: never;
      /**
       * Never present beside an exit code.
       */
      silentSeconds?: never;
      /**
       * The last lines it printed.
       */
      outputTail: string;
    }
  | {
      /**
       * The signal's name.
       */
      signal: string;
      /**
       * Never present beside a signal.
       */
      exitCode?: never;
      /**
       * Never present beside a signal.
       */
      silentSeconds?: never;
      /**
       * The last lines it printed.
       */
      outputTail: string;
    }
  | {
      /**
       * How long it answered nothing before the daemon ended it, in seconds.
       */
      silentSeconds: number;
      /**
       * Never present beside a silence.
       */
      exitCode?: never;
      /**
       * Never present beside a silence.
       */
      signal?: never;
      /**
       * The last lines it printed.
       */
      outputTail: string;
    };
/**
 * Why the daemon itself ended a run `stopped`: the run passed the token limit the person set, the
 * person stopped it with every other agent, the person stopped the service before the run started,
 * or the person removed every message the run was queued for.
 */
export type StopTrigger = "tokenLimit" | "stopAll" | "daemonStop" | "messagesRemoved";
/**
 * One run state transition as `agent.run.subscribe` delivers it, tagged on its new state, with its
 * new run version; only a transition into `failed` carries a failure cause or a process exit, and
 * only one into `interrupted` or `stopped` carries the daemon's own trigger. `sessionId` is
 * carried by the subscription's scope, not repeated per event.
 */
export type RunStateChangeEvent =
  | {
      newState: "starting";
      /**
       * The run.
       */
      runId: RunId;
      /**
       * The run version after the transition, which clients pass back as
       * `expectedRunVersion`.
       */
      runVersion: number;
      /**
       * The state it left.
       */
      previousState: RunState;
      /**
       * Why the run failed.
       */
      failureCategory?: RunFailureCategory;
      /**
       * Why the run needs recovery.
       */
      recoveryCondition?: RecoveryCondition;
      /**
       * The provider's own words on why it failed the run, shown whole and never parsed.
       */
      providerFailureDetail?: string;
      /**
       * Present only on a terminal the daemon itself closed, which is never a crash.
       */
      intendedClose?: true;
      /**
       * The effective posture, stamped only on `running`, where it and the workspace root
       * are final.
       */
      executionPosture?: ExecutionPosture;
      /**
       * Never present outside `failed`.
       */
      failureCause?: never;
      /**
       * Never present outside `failed`.
       */
      processExit?: never;
      /**
       * Never present outside `interrupted` and `stopped`.
       */
      trigger?: never;
      /**
       * When the transition happened.
       */
      timestamp: WireInstant;
    }
  | {
      newState: "running";
      /**
       * The run.
       */
      runId: RunId;
      /**
       * The run version after the transition, which clients pass back as
       * `expectedRunVersion`.
       */
      runVersion: number;
      /**
       * The state it left.
       */
      previousState: RunState;
      /**
       * Why the run failed.
       */
      failureCategory?: RunFailureCategory;
      /**
       * Why the run needs recovery.
       */
      recoveryCondition?: RecoveryCondition;
      /**
       * The provider's own words on why it failed the run, shown whole and never parsed.
       */
      providerFailureDetail?: string;
      /**
       * Present only on a terminal the daemon itself closed, which is never a crash.
       */
      intendedClose?: true;
      /**
       * The effective posture, stamped only on `running`, where it and the workspace root
       * are final.
       */
      executionPosture?: ExecutionPosture;
      /**
       * Never present outside `failed`.
       */
      failureCause?: never;
      /**
       * Never present outside `failed`.
       */
      processExit?: never;
      /**
       * Never present outside `interrupted` and `stopped`.
       */
      trigger?: never;
      /**
       * When the transition happened.
       */
      timestamp: WireInstant;
    }
  | {
      newState: "waitingForApproval";
      /**
       * The run.
       */
      runId: RunId;
      /**
       * The run version after the transition, which clients pass back as
       * `expectedRunVersion`.
       */
      runVersion: number;
      /**
       * The state it left.
       */
      previousState: RunState;
      /**
       * Why the run failed.
       */
      failureCategory?: RunFailureCategory;
      /**
       * Why the run needs recovery.
       */
      recoveryCondition?: RecoveryCondition;
      /**
       * The provider's own words on why it failed the run, shown whole and never parsed.
       */
      providerFailureDetail?: string;
      /**
       * Present only on a terminal the daemon itself closed, which is never a crash.
       */
      intendedClose?: true;
      /**
       * The effective posture, stamped only on `running`, where it and the workspace root
       * are final.
       */
      executionPosture?: ExecutionPosture;
      /**
       * Never present outside `failed`.
       */
      failureCause?: never;
      /**
       * Never present outside `failed`.
       */
      processExit?: never;
      /**
       * Never present outside `interrupted` and `stopped`.
       */
      trigger?: never;
      /**
       * When the transition happened.
       */
      timestamp: WireInstant;
    }
  | {
      newState: "waitingForInput";
      /**
       * The run.
       */
      runId: RunId;
      /**
       * The run version after the transition, which clients pass back as
       * `expectedRunVersion`.
       */
      runVersion: number;
      /**
       * The state it left.
       */
      previousState: RunState;
      /**
       * Why the run failed.
       */
      failureCategory?: RunFailureCategory;
      /**
       * Why the run needs recovery.
       */
      recoveryCondition?: RecoveryCondition;
      /**
       * The provider's own words on why it failed the run, shown whole and never parsed.
       */
      providerFailureDetail?: string;
      /**
       * Present only on a terminal the daemon itself closed, which is never a crash.
       */
      intendedClose?: true;
      /**
       * The effective posture, stamped only on `running`, where it and the workspace root
       * are final.
       */
      executionPosture?: ExecutionPosture;
      /**
       * Never present outside `failed`.
       */
      failureCause?: never;
      /**
       * Never present outside `failed`.
       */
      processExit?: never;
      /**
       * Never present outside `interrupted` and `stopped`.
       */
      trigger?: never;
      /**
       * When the transition happened.
       */
      timestamp: WireInstant;
    }
  | {
      newState: "pausing";
      /**
       * The run.
       */
      runId: RunId;
      /**
       * The run version after the transition, which clients pass back as
       * `expectedRunVersion`.
       */
      runVersion: number;
      /**
       * The state it left.
       */
      previousState: RunState;
      /**
       * Why the run failed.
       */
      failureCategory?: RunFailureCategory;
      /**
       * Why the run needs recovery.
       */
      recoveryCondition?: RecoveryCondition;
      /**
       * The provider's own words on why it failed the run, shown whole and never parsed.
       */
      providerFailureDetail?: string;
      /**
       * Present only on a terminal the daemon itself closed, which is never a crash.
       */
      intendedClose?: true;
      /**
       * The effective posture, stamped only on `running`, where it and the workspace root
       * are final.
       */
      executionPosture?: ExecutionPosture;
      /**
       * Never present outside `failed`.
       */
      failureCause?: never;
      /**
       * Never present outside `failed`.
       */
      processExit?: never;
      /**
       * Never present outside `interrupted` and `stopped`.
       */
      trigger?: never;
      /**
       * When the transition happened.
       */
      timestamp: WireInstant;
    }
  | {
      newState: "paused";
      /**
       * The run.
       */
      runId: RunId;
      /**
       * The run version after the transition, which clients pass back as
       * `expectedRunVersion`.
       */
      runVersion: number;
      /**
       * The state it left.
       */
      previousState: RunState;
      /**
       * Why the run failed.
       */
      failureCategory?: RunFailureCategory;
      /**
       * Why the run needs recovery.
       */
      recoveryCondition?: RecoveryCondition;
      /**
       * The provider's own words on why it failed the run, shown whole and never parsed.
       */
      providerFailureDetail?: string;
      /**
       * Present only on a terminal the daemon itself closed, which is never a crash.
       */
      intendedClose?: true;
      /**
       * The effective posture, stamped only on `running`, where it and the workspace root
       * are final.
       */
      executionPosture?: ExecutionPosture;
      /**
       * Never present outside `failed`.
       */
      failureCause?: never;
      /**
       * Never present outside `failed`.
       */
      processExit?: never;
      /**
       * Never present outside `interrupted` and `stopped`.
       */
      trigger?: never;
      /**
       * When the transition happened.
       */
      timestamp: WireInstant;
    }
  | {
      newState: "completed";
      /**
       * The run.
       */
      runId: RunId;
      /**
       * The run version after the transition, which clients pass back as
       * `expectedRunVersion`.
       */
      runVersion: number;
      /**
       * The state it left.
       */
      previousState: RunState;
      /**
       * Why the run failed.
       */
      failureCategory?: RunFailureCategory;
      /**
       * Why the run needs recovery.
       */
      recoveryCondition?: RecoveryCondition;
      /**
       * The provider's own words on why it failed the run, shown whole and never parsed.
       */
      providerFailureDetail?: string;
      /**
       * Present only on a terminal the daemon itself closed, which is never a crash.
       */
      intendedClose?: true;
      /**
       * The effective posture, stamped only on `running`, where it and the workspace root
       * are final.
       */
      executionPosture?: ExecutionPosture;
      /**
       * Never present outside `failed`.
       */
      failureCause?: never;
      /**
       * Never present outside `failed`.
       */
      processExit?: never;
      /**
       * Never present outside `interrupted` and `stopped`.
       */
      trigger?: never;
      /**
       * When the transition happened.
       */
      timestamp: WireInstant;
    }
  | {
      newState: "interrupted";
      /**
       * The run.
       */
      runId: RunId;
      /**
       * The run version after the transition, which clients pass back as
       * `expectedRunVersion`.
       */
      runVersion: number;
      /**
       * The state it left.
       */
      previousState: RunState;
      /**
       * Why the run failed.
       */
      failureCategory?: RunFailureCategory;
      /**
       * Why the run needs recovery.
       */
      recoveryCondition?: RecoveryCondition;
      /**
       * The provider's own words on why it failed the run, shown whole and never parsed.
       */
      providerFailureDetail?: string;
      /**
       * Present only on a terminal the daemon itself closed, which is never a crash.
       */
      intendedClose?: true;
      /**
       * The effective posture, stamped only on `running`, where it and the workspace root
       * are final.
       */
      executionPosture?: ExecutionPosture;
      /**
       * Never present outside `failed`.
       */
      failureCause?: never;
      /**
       * Never present outside `failed`.
       */
      processExit?: never;
      /**
       * Why the daemon itself interrupted the run; absent when it did not.
       */
      trigger?: InterruptReason;
      /**
       * When the transition happened.
       */
      timestamp: WireInstant;
    }
  | {
      newState: "stopped";
      /**
       * The run.
       */
      runId: RunId;
      /**
       * The run version after the transition, which clients pass back as
       * `expectedRunVersion`.
       */
      runVersion: number;
      /**
       * The state it left.
       */
      previousState: RunState;
      /**
       * Why the run failed.
       */
      failureCategory?: RunFailureCategory;
      /**
       * Why the run needs recovery.
       */
      recoveryCondition?: RecoveryCondition;
      /**
       * The provider's own words on why it failed the run, shown whole and never parsed.
       */
      providerFailureDetail?: string;
      /**
       * Present only on a terminal the daemon itself closed, which is never a crash.
       */
      intendedClose?: true;
      /**
       * The effective posture, stamped only on `running`, where it and the workspace root
       * are final.
       */
      executionPosture?: ExecutionPosture;
      /**
       * Never present outside `failed`.
       */
      failureCause?: never;
      /**
       * Never present outside `failed`.
       */
      processExit?: never;
      /**
       * Why the daemon itself stopped the run; absent when it did not.
       */
      trigger?: StopTrigger;
      /**
       * When the transition happened.
       */
      timestamp: WireInstant;
    }
  | {
      newState: "failed";
      /**
       * The run.
       */
      runId: RunId;
      /**
       * The run version after the transition, which clients pass back as
       * `expectedRunVersion`.
       */
      runVersion: number;
      /**
       * The state it left.
       */
      previousState: RunState;
      /**
       * Why the run failed.
       */
      failureCategory?: RunFailureCategory;
      /**
       * Why the run needs recovery.
       */
      recoveryCondition?: RecoveryCondition;
      /**
       * The provider's own words on why it failed the run, shown whole and never parsed.
       */
      providerFailureDetail?: string;
      /**
       * Present only on a terminal the daemon itself closed, which is never a crash.
       */
      intendedClose?: true;
      /**
       * The effective posture, stamped only on `running`, where it and the workspace root
       * are final.
       */
      executionPosture?: ExecutionPosture;
      /**
       * The run's typed failure cause.
       */
      failureCause?: RunFailureCause;
      /**
       * How the provider process ended under the turn, where it ended on its own.
       */
      processExit?: ProcessExit;
      /**
       * Never present outside `interrupted` and `stopped`.
       */
      trigger?: never;
      /**
       * When the transition happened.
       */
      timestamp: WireInstant;
    };
/**
 * One delivery on `agent.run.subscribe`: a state change, a rollback, or the provider's safety hold
 * on the run's turn. The hold is a live detail only this stream carries, never written to the
 * session's history. None carries a tag; their closed members keep them apart.
 */
export type RunStateStreamEvent =
  | RunStateChangeEvent
  | AgentRunRolledBackEvent
  | RunSafetyBufferingUpdatedPayload;
/**
 * The value of each `agent.run.subscribe` notify: the changes since the previous frame, or
 * the mark that the stream was moved to the log's head.
 */
export type RunStateStreamFrame =
  | {
      kind: "changes";
      /**
       * The changes, oldest first.
       *
       * @minItems 1
       * @maxItems 50
       */
      changes: [RunStateStreamChange, ...RunStateStreamChange[]];
    }
  | {
      kind: "behind";
      /**
       * The head the stream carries on from.
       */
      headCursor: EventCursor;
    };
/**
 * The person's answer when a resumed conversation and the service's record disagree. Provider
 * ahead: `keepProvider` keeps what it did, `undoToAgreed` cuts back to where both agree.
 * Service ahead: `continueProvider` goes on from the provider's record, `handOver` starts a new
 * conversation with the hand-over brief.
 */
export type RunRecoveryChoice = "keepProvider" | "undoToAgreed" | "continueProvider" | "handOver";

/**
 * A run rewound to an earlier run position, carried on `agent.run.subscribe`, and the stored
 * `agent.run.rolledBack` payload. It is not a state transition, so it has no previous or new
 * state, and it carries no tag: its closed members keep it apart from the state change.
 */
export interface AgentRunRolledBackEvent {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The run rewound.
   */
  runId: RunId;
  /**
   * The run version after the rollback advanced it.
   */
  runVersion: number;
  /**
   * The run position the run landed at, counting the person's messages the run took (a turn's
   * opening or a steer), not turns: the request's target, or the landing the driver confirmed
   * when that differs.
   */
  targetPosition: SourcePosition;
}
/**
 * One change on `agent.run.subscribe`: the delivery and the cursor of the event it came from, or,
 * for the provider's safety hold, which the session's history never records, the session's
 * newest cursor when it went out.
 */
export interface RunStateStreamChange {
  /**
   * The position.
   */
  cursor: EventCursor;
  /**
   * The delivery.
   */
  event: RunStateStreamEvent;
}
/**
 * Pauses a run. Not an intervention, but guarded by the same mandatory `expectedRunVersion`.
 */
export interface AgentRunPauseRequest {
  /**
   * The run.
   */
  targetRunId: RunId;
  /**
   * The run version the caller last saw.
   */
  expectedRunVersion: number;
}
/**
 * Resumes a paused run, guarded by the same mandatory `expectedRunVersion`.
 */
export interface AgentRunResumeRequest {
  /**
   * The run.
   */
  targetRunId: RunId;
  /**
   * The run version the caller last saw.
   */
  expectedRunVersion: number;
}
/**
 * The run's state after a run-control call and its advanced `runVersion`, so the caller can guard
 * its next request without reading `agent.run.subscribe`.
 */
export interface AgentRunControlResponse {
  /**
   * The run.
   */
  runId: RunId;
  /**
   * Its state now.
   */
  newState: RunState;
  /**
   * Its run version now.
   */
  runVersion: number;
}
/**
 * Answers the recovery question a restart left a run halted on (`agent.run.recovery.resolve`).
 */
export interface AgentRunRecoveryResolveRequest {
  /**
   * The run.
   */
  runId: RunId;
  /**
   * The person's answer.
   */
  choice: RunRecoveryChoice;
}
/**
 * The payload of `agent.run.recovery.resolved`: which choice settled the question.
 */
export interface AgentRunRecoveryResolvedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The run.
   */
  runId: RunId;
  /**
   * The answer that settled it.
   */
  choice: RunRecoveryChoice;
}
/**
 * The payload of `agent.run.recoverySteps.added`: after a restart, `count` steps from the
 * provider's own record that only read were added to the transcript as the provider recorded them.
 */
export interface AgentRunRecoveryStepsAddedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The run.
   */
  runId: RunId;
  /**
   * How many steps were added, at least one.
   */
  count: number;
  /**
   * The provider whose record they came from.
   */
  provider: ProviderId;
}
/**
 * Opens a session's run state stream: every run in the session, the lead and each child, which
 * the caller fans out by `runId`. With `afterCursor`, the stream first replays each change the
 * session's record holds after that cursor, then follows live; without it, it follows from now.
 */
export interface AgentRunSubscribeRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * Replay from after this position.
   */
  afterCursor?: EventCursor;
}

export {
  validateAgentRunRecoveryResolvedPayload,
  validateAgentRunRecoveryStepsAddedPayload,
  validateAgentRunRolledBackEvent,
  validateProcessExit,
  validateRunFailureCategory,
  validateRunRecoveryChoice,
  validateRunStateChangeEvent,
  validateStopTrigger,
} from "../checks/run/control.js";

/** The methods of {@link RUN_CONTROL_METHOD_DESCRIPTORS}, each with its kind. */
export interface RunControlMethodDescriptors {
  readonly "agent.queueItem.create": {
    readonly method: "agent.queueItem.create";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "agent.queueItem.list": {
    readonly method: "agent.queueItem.list";
    readonly procedureType: "query";
    readonly mutating: false;
  };
  readonly "agent.queueItem.cancel": {
    readonly method: "agent.queueItem.cancel";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "agent.queueItem.reorder": {
    readonly method: "agent.queueItem.reorder";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "agent.queueItem.subscribe": {
    readonly method: "agent.queueItem.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
  };
  readonly "agent.run.intervene": {
    readonly method: "agent.run.intervene";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "agent.run.pause": {
    readonly method: "agent.run.pause";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "agent.run.resume": {
    readonly method: "agent.run.resume";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "agent.run.subscribe": {
    readonly method: "agent.run.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
  };
  readonly "agent.childRun.steer": {
    readonly method: "agent.childRun.steer";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "agent.childRun.interrupt": {
    readonly method: "agent.childRun.interrupt";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "agent.childRun.paused.update": {
    readonly method: "agent.childRun.paused.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "agent.childRun.stopAll": {
    readonly method: "agent.childRun.stopAll";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "agent.run.recovery.resolve": {
    readonly method: "agent.run.recovery.resolve";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "agent.run.refusalChoice.resolve": {
    readonly method: "agent.run.refusalChoice.resolve";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
  readonly "agent.run.usageCreditsChoice.resolve": {
    readonly method: "agent.run.usageCreditsChoice.resolve";
    readonly procedureType: "mutation";
    readonly mutating: true;
  };
}
/** The params, result and emission types of each method of {@link RUN_CONTROL_METHOD_DESCRIPTORS}. */
export interface RunControlMethodTypes {
  readonly "agent.queueItem.create": {
    readonly params: AgentQueueItemCreateRequest;
    readonly result: AgentQueueItemCreateResponse;
  };
  readonly "agent.queueItem.list": {
    readonly params: AgentQueueItemListRequest;
    readonly result: AgentQueueItemListResponse;
  };
  readonly "agent.queueItem.cancel": {
    readonly params: AgentQueueItemCancelRequest;
    readonly result: AgentQueueItemCancelResponse;
  };
  readonly "agent.queueItem.reorder": {
    readonly params: AgentQueueItemReorderRequest;
    readonly result: AgentQueueItemListResponse;
  };
  readonly "agent.queueItem.subscribe": {
    readonly params: AgentQueueItemSubscribeRequest;
    readonly result: SubscribeAcknowledgmentResponse;
    readonly emission: RunQueueStreamFrame;
  };
  readonly "agent.run.intervene": {
    readonly params: AgentRunInterveneRequest;
    readonly result: AgentRunInterveneResponse;
  };
  readonly "agent.run.pause": {
    readonly params: AgentRunPauseRequest;
    readonly result: AgentRunControlResponse;
  };
  readonly "agent.run.resume": {
    readonly params: AgentRunResumeRequest;
    readonly result: AgentRunControlResponse;
  };
  readonly "agent.run.subscribe": {
    readonly params: AgentRunSubscribeRequest;
    readonly result: SubscribeAcknowledgmentResponse;
    readonly emission: RunStateStreamFrame;
  };
  readonly "agent.childRun.steer": {
    readonly params: AgentChildRunSteerRequest;
    readonly result: AgentQueueItemCreateResponse;
  };
  readonly "agent.childRun.interrupt": {
    readonly params: AgentChildRunInterruptRequest;
    readonly result: AgentChildRunInterruptResponse;
  };
  readonly "agent.childRun.paused.update": {
    readonly params: AgentChildRunPausedUpdateRequest;
    readonly result: AgentChildRunPausedUpdateResponse;
  };
  readonly "agent.childRun.stopAll": {
    readonly params: AgentChildRunStopAllRequest;
    readonly result: AgentChildRunStopAllResponse;
  };
  readonly "agent.run.recovery.resolve": {
    readonly params: AgentRunRecoveryResolveRequest;
    readonly result: AgentRunControlResponse;
  };
  readonly "agent.run.refusalChoice.resolve": {
    readonly params: AgentRunRefusalChoiceResolveRequest;
    readonly result: AgentRunControlResponse;
  };
  readonly "agent.run.usageCreditsChoice.resolve": {
    readonly params: AgentRunUsageCreditsChoiceResolveRequest;
    readonly result: AgentRunControlResponse;
  };
}
/**
 * The run-control methods: the queue, interventions, pause and resume, the state stream, a
 * child's own controls, the recovery question and the provider's choices a run waits on.
 */
export const RUN_CONTROL_METHOD_DESCRIPTORS: RunControlMethodDescriptors =
  /* @__PURE__ */ Object.freeze({
    "agent.queueItem.create": /* @__PURE__ */ Object.freeze({
      method: "agent.queueItem.create",
      procedureType: "mutation",
      mutating: true,
    }),
    "agent.queueItem.list": /* @__PURE__ */ Object.freeze({
      method: "agent.queueItem.list",
      procedureType: "query",
      mutating: false,
    }),
    "agent.queueItem.cancel": /* @__PURE__ */ Object.freeze({
      method: "agent.queueItem.cancel",
      procedureType: "mutation",
      mutating: true,
    }),
    "agent.queueItem.reorder": /* @__PURE__ */ Object.freeze({
      method: "agent.queueItem.reorder",
      procedureType: "mutation",
      mutating: true,
    }),
    "agent.queueItem.subscribe": /* @__PURE__ */ Object.freeze({
      method: "agent.queueItem.subscribe",
      procedureType: "subscription",
      mutating: false,
    }),
    "agent.run.intervene": /* @__PURE__ */ Object.freeze({
      method: "agent.run.intervene",
      procedureType: "mutation",
      mutating: true,
    }),
    "agent.run.pause": /* @__PURE__ */ Object.freeze({
      method: "agent.run.pause",
      procedureType: "mutation",
      mutating: true,
    }),
    "agent.run.resume": /* @__PURE__ */ Object.freeze({
      method: "agent.run.resume",
      procedureType: "mutation",
      mutating: true,
    }),
    "agent.run.subscribe": /* @__PURE__ */ Object.freeze({
      method: "agent.run.subscribe",
      procedureType: "subscription",
      mutating: false,
    }),
    "agent.childRun.steer": /* @__PURE__ */ Object.freeze({
      method: "agent.childRun.steer",
      procedureType: "mutation",
      mutating: true,
    }),
    "agent.childRun.interrupt": /* @__PURE__ */ Object.freeze({
      method: "agent.childRun.interrupt",
      procedureType: "mutation",
      mutating: true,
    }),
    "agent.childRun.paused.update": /* @__PURE__ */ Object.freeze({
      method: "agent.childRun.paused.update",
      procedureType: "mutation",
      mutating: true,
    }),
    "agent.childRun.stopAll": /* @__PURE__ */ Object.freeze({
      method: "agent.childRun.stopAll",
      procedureType: "mutation",
      mutating: true,
    }),
    "agent.run.recovery.resolve": /* @__PURE__ */ Object.freeze({
      method: "agent.run.recovery.resolve",
      procedureType: "mutation",
      mutating: true,
    }),
    "agent.run.refusalChoice.resolve": /* @__PURE__ */ Object.freeze({
      method: "agent.run.refusalChoice.resolve",
      procedureType: "mutation",
      mutating: true,
    }),
    "agent.run.usageCreditsChoice.resolve": /* @__PURE__ */ Object.freeze({
      method: "agent.run.usageCreditsChoice.resolve",
      procedureType: "mutation",
      mutating: true,
    }),
  });
