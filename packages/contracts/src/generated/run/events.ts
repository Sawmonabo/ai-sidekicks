/* eslint-disable */
// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The stored payloads of a run's state changes, of the markers its provider reports, of its turns' starts and ends, and of its interventions, one per event type.

import { type SchemaCheck, ucs2length } from "../../schema-check.js";
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
 * The `agent.turn.started` payload: a turn opened within the run, at the session position and
 * under the provider's own turn id where the provider named them.
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
   * The turn's session position.
   */
  position?: SourcePosition;
  /**
   * The provider's own id of the turn, so what the provider reports against that id joins
   * the turn it opened in.
   */
  providerTurnId?: ProviderTurnId;
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

// prettier-ignore
const schema973: any = {"description":"The run state a stop leaves a child in: `stopped` where the provider's stop is final,\n`interrupted` where a send can continue it.","type":"string","enum":["stopped","interrupted"]};
// prettier-ignore
const pattern4 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
function validate131(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate131.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){const _errs2: any = errors;for(const key0 in data){validate131.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key0}}];return false;break;}if(_errs2 === errors){const tag0: any = data.kind;if(typeof tag0 == "string"){if(tag0 === "agent"){const _errs3: any = errors;if(errors === _errs3){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.kind === undefined) && (missing0 = "kind")) || ((data.agentId === undefined) && (missing0 = "agentId"))){validate131.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs5: any = errors;for(const key1 in data){if(!((key1 === "kind") || (key1 === "agentId"))){validate131.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs5 === errors){if(data.kind !== undefined){let data0: any = data.kind;const _errs6: any = errors;if(typeof data0 !== "string"){validate131.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("agent" !== data0){validate131.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "agent"}}];return false;}var valid2: any = _errs6 === errors;}else {var valid2: any = true;}if(valid2){if(data.agentId !== undefined){let data1: any = data.agentId;const _errs8: any = errors;const _errs9: any = errors;if(errors === _errs9){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate131.errors = [{instancePath:instancePath+"/agentId",schemaPath:"sidekicks-contracts:agent/definition#/$defs/AgentId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate131.errors = [{instancePath:instancePath+"/agentId",schemaPath:"sidekicks-contracts:agent/definition#/$defs/AgentId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}}}}}else {validate131.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}}else if(tag0 === "providerChild"){const _errs12: any = errors;if(errors === _errs12){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((data.kind === undefined) && (missing1 = "kind")) || ((data.runId === undefined) && (missing1 = "runId"))) || ((data.childHandle === undefined) && (missing1 = "childHandle"))){validate131.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs14: any = errors;for(const key2 in data){if(!(((key2 === "kind") || (key2 === "runId")) || (key2 === "childHandle"))){validate131.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs14 === errors){if(data.kind !== undefined){let data2: any = data.kind;const _errs15: any = errors;if(typeof data2 !== "string"){validate131.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("providerChild" !== data2){validate131.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "providerChild"}}];return false;}var valid5: any = _errs15 === errors;}else {var valid5: any = true;}if(valid5){if(data.runId !== undefined){let data3: any = data.runId;const _errs17: any = errors;const _errs18: any = errors;if(errors === _errs18){if(typeof data3 === "string"){if(!pattern4.test(data3)){validate131.errors = [{instancePath:instancePath+"/runId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate131.errors = [{instancePath:instancePath+"/runId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs17 === errors;}else {var valid5: any = true;}if(valid5){if(data.childHandle !== undefined){let data4: any = data.childHandle;const _errs21: any = errors;const _errs22: any = errors;if(errors === _errs22){if(typeof data4 === "string"){if(func1(data4) > 256){validate131.errors = [{instancePath:instancePath+"/childHandle",schemaPath:"#/$defs/ChildHandle/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data4) < 1){validate131.errors = [{instancePath:instancePath+"/childHandle",schemaPath:"#/$defs/ChildHandle/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate131.errors = [{instancePath:instancePath+"/childHandle",schemaPath:"#/$defs/ChildHandle/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs21 === errors;}else {var valid5: any = true;}}}}}}else {validate131.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}}else {validate131.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "kind", tagValue: tag0}}];return false;}}else {validate131.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "kind", tagValue: tag0}}];return false;}}}else {validate131.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate131.errors = vErrors;return errors === 0;}
// prettier-ignore
validate131.errors = null as any[] | null;
// prettier-ignore
validate131.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1742(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentChildrenStoppedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1742.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.word === undefined) && (missing0 = "word")) || ((data.reached === undefined) && (missing0 = "reached"))){validate1742.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "word") || (key0 === "reached"))){validate1742.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.word !== undefined){let data0: any = data.word;const _errs2: any = errors;if(typeof data0 !== "string"){validate1742.errors = [{instancePath:instancePath+"/word",schemaPath:"sidekicks-contracts:run/children#/$defs/ChildStoppedState/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data0 === "stopped") || (data0 === "interrupted"))){validate1742.errors = [{instancePath:instancePath+"/word",schemaPath:"sidekicks-contracts:run/children#/$defs/ChildStoppedState/enum",keyword:"enum",params:{allowedValues: schema973.enum}}];return false;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.reached !== undefined){let data1: any = data.reached;const _errs5: any = errors;if(errors === _errs5){if(Array.isArray(data1)){var valid2: any = true;const len0: any = data1.length;for(let i0=0; i0<len0; i0++){const _errs7: any = errors;if(!(validate131.call(this, data1[i0], {instancePath:instancePath+"/reached/" + i0,parentData:data1,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate131.errors : vErrors.concat(validate131.errors);errors = vErrors.length;}var valid2: any = _errs7 === errors;if(!valid2){break;}}}else {validate1742.errors = [{instancePath:instancePath+"/reached",schemaPath:"#/properties/reached/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}else {validate1742.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1742.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1742.errors = null as any[] | null;
// prettier-ignore
validate1742.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1744(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentRunParentCorrectedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1744.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.runId === undefined) && (missing0 = "runId"))) || ((data.parentRunId === undefined) && (missing0 = "parentRunId"))){validate1744.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "runId")) || (key0 === "parentRunId"))){validate1744.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1744.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1744.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.runId !== undefined){let data1: any = data.runId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate1744.errors = [{instancePath:instancePath+"/runId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1744.errors = [{instancePath:instancePath+"/runId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.parentRunId !== undefined){let data2: any = data.parentRunId;const _errs10: any = errors;const _errs11: any = errors;if(errors === _errs11){if(typeof data2 === "string"){if(!pattern4.test(data2)){validate1744.errors = [{instancePath:instancePath+"/parentRunId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1744.errors = [{instancePath:instancePath+"/parentRunId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}}}}}}else {validate1744.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1744.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1744.errors = null as any[] | null;
// prettier-ignore
validate1744.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern16 = new RegExp("^[a-z][a-z0-9-]{0,31}$", "u");
// prettier-ignore
const pattern6 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
// prettier-ignore
function validate1745(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentRunProviderInitializedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1745.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.runId === undefined) && (missing0 = "runId"))) || ((data.runVersion === undefined) && (missing0 = "runVersion"))) || ((data.provider === undefined) && (missing0 = "provider"))){validate1745.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((key0 === "sessionId") || (key0 === "runId")) || (key0 === "runVersion")) || (key0 === "provider")) || (key0 === "model"))){validate1745.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1745.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1745.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.runId !== undefined){let data1: any = data.runId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate1745.errors = [{instancePath:instancePath+"/runId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1745.errors = [{instancePath:instancePath+"/runId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.runVersion !== undefined){let data2: any = data.runVersion;const _errs10: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validate1745.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/properties/runVersion/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs10){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validate1745.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/properties/runVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 0 || isNaN(data2)){validate1745.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/properties/runVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.provider !== undefined){let data3: any = data.provider;const _errs12: any = errors;const _errs13: any = errors;if(errors === _errs13){if(typeof data3 === "string"){if(!pattern16.test(data3)){validate1745.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}}];return false;}}else {validate1745.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}if(valid0){if(data.model !== undefined){let data4: any = data.model;const _errs16: any = errors;if(errors === _errs16){if(typeof data4 === "string"){if(func1(data4) > 128){validate1745.errors = [{instancePath:instancePath+"/model",schemaPath:"#/properties/model/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data4) < 1){validate1745.errors = [{instancePath:instancePath+"/model",schemaPath:"#/properties/model/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data4)){validate1745.errors = [{instancePath:instancePath+"/model",schemaPath:"#/properties/model/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1745.errors = [{instancePath:instancePath+"/model",schemaPath:"#/properties/model/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs16 === errors;}else {var valid0: any = true;}}}}}}}}else {validate1745.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1745.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1745.errors = null as any[] | null;
// prettier-ignore
validate1745.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1746(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentRunWorkerShuttingDownPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1746.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.runId === undefined) && (missing0 = "runId"))) || ((data.runVersion === undefined) && (missing0 = "runVersion"))){validate1746.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "sessionId") || (key0 === "runId")) || (key0 === "runVersion")) || (key0 === "reason"))){validate1746.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1746.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1746.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.runId !== undefined){let data1: any = data.runId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate1746.errors = [{instancePath:instancePath+"/runId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1746.errors = [{instancePath:instancePath+"/runId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.runVersion !== undefined){let data2: any = data.runVersion;const _errs10: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validate1746.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/properties/runVersion/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs10){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validate1746.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/properties/runVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 0 || isNaN(data2)){validate1746.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/properties/runVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.reason !== undefined){let data3: any = data.reason;const _errs12: any = errors;if(errors === _errs12){if(typeof data3 === "string"){if(func1(data3) > 32768){validate1746.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/properties/reason/maxLength",keyword:"maxLength",params:{limit: 32768}}];return false;}else {if(func1(data3) < 1){validate1746.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/properties/reason/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data3)){validate1746.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/properties/reason/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1746.errors = [{instancePath:instancePath+"/reason",schemaPath:"#/properties/reason/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}}}}}}}else {validate1746.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1746.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1746.errors = null as any[] | null;
// prettier-ignore
validate1746.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1747(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentTurnCompletedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1747.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.runId === undefined) && (missing0 = "runId"))) || ((data.runVersion === undefined) && (missing0 = "runVersion"))) || ((data.turnNumber === undefined) && (missing0 = "turnNumber"))){validate1747.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "sessionId") || (key0 === "runId")) || (key0 === "runVersion")) || (key0 === "turnNumber"))){validate1747.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1747.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1747.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.runId !== undefined){let data1: any = data.runId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate1747.errors = [{instancePath:instancePath+"/runId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1747.errors = [{instancePath:instancePath+"/runId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.runVersion !== undefined){let data2: any = data.runVersion;const _errs10: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validate1747.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/properties/runVersion/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs10){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validate1747.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/properties/runVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 0 || isNaN(data2)){validate1747.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/properties/runVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.turnNumber !== undefined){let data3: any = data.turnNumber;const _errs12: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validate1747.errors = [{instancePath:instancePath+"/turnNumber",schemaPath:"#/properties/turnNumber/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs12){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 9007199254740991 || isNaN(data3)){validate1747.errors = [{instancePath:instancePath+"/turnNumber",schemaPath:"#/properties/turnNumber/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data3 < 1 || isNaN(data3)){validate1747.errors = [{instancePath:instancePath+"/turnNumber",schemaPath:"#/properties/turnNumber/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}}}}}}}else {validate1747.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1747.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1747.errors = null as any[] | null;
// prettier-ignore
validate1747.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema969: any = {"description":"Who reported a turn's end, not who cut the turn: the provider, whose own end frame arrived, or\nthe daemon, which wrote the end with no provider frame.","type":"string","enum":["provider","daemon"]};
// prettier-ignore
const schema970: any = {"description":"Why a turn was interrupted or failed, where the daemon knows it: it saw the provider process\nexit, a restart settled the open turn, the person stopped the service under it, or a limit the\nperson set cut it.","type":"string","enum":["processExit","daemonRestart","daemonStop","stepLimit","spendLimit","tokenLimit"]};
// prettier-ignore
function validate1748(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentTurnFailedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1748.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.runId === undefined) && (missing0 = "runId"))) || ((data.runVersion === undefined) && (missing0 = "runVersion"))) || ((data.turnNumber === undefined) && (missing0 = "turnNumber"))) || ((data.origin === undefined) && (missing0 = "origin"))){validate1748.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((((key0 === "sessionId") || (key0 === "runId")) || (key0 === "runVersion")) || (key0 === "turnNumber")) || (key0 === "origin")) || (key0 === "cause"))){validate1748.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1748.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1748.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.runId !== undefined){let data1: any = data.runId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate1748.errors = [{instancePath:instancePath+"/runId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1748.errors = [{instancePath:instancePath+"/runId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.runVersion !== undefined){let data2: any = data.runVersion;const _errs10: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validate1748.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/properties/runVersion/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs10){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validate1748.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/properties/runVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 0 || isNaN(data2)){validate1748.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/properties/runVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.turnNumber !== undefined){let data3: any = data.turnNumber;const _errs12: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validate1748.errors = [{instancePath:instancePath+"/turnNumber",schemaPath:"#/properties/turnNumber/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs12){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 9007199254740991 || isNaN(data3)){validate1748.errors = [{instancePath:instancePath+"/turnNumber",schemaPath:"#/properties/turnNumber/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data3 < 1 || isNaN(data3)){validate1748.errors = [{instancePath:instancePath+"/turnNumber",schemaPath:"#/properties/turnNumber/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}if(valid0){if(data.origin !== undefined){let data4: any = data.origin;const _errs14: any = errors;if(typeof data4 !== "string"){validate1748.errors = [{instancePath:instancePath+"/origin",schemaPath:"#/$defs/TurnEndOrigin/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data4 === "provider") || (data4 === "daemon"))){validate1748.errors = [{instancePath:instancePath+"/origin",schemaPath:"#/$defs/TurnEndOrigin/enum",keyword:"enum",params:{allowedValues: schema969.enum}}];return false;}var valid0: any = _errs14 === errors;}else {var valid0: any = true;}if(valid0){if(data.cause !== undefined){let data5: any = data.cause;const _errs17: any = errors;if(typeof data5 !== "string"){validate1748.errors = [{instancePath:instancePath+"/cause",schemaPath:"#/$defs/TurnEndCause/type",keyword:"type",params:{type: "string"}}];return false;}if(!((((((data5 === "processExit") || (data5 === "daemonRestart")) || (data5 === "daemonStop")) || (data5 === "stepLimit")) || (data5 === "spendLimit")) || (data5 === "tokenLimit"))){validate1748.errors = [{instancePath:instancePath+"/cause",schemaPath:"#/$defs/TurnEndCause/enum",keyword:"enum",params:{allowedValues: schema970.enum}}];return false;}var valid0: any = _errs17 === errors;}else {var valid0: any = true;}}}}}}}}}else {validate1748.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1748.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1748.errors = null as any[] | null;
// prettier-ignore
validate1748.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1749(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentTurnInterruptedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1749.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.runId === undefined) && (missing0 = "runId"))) || ((data.runVersion === undefined) && (missing0 = "runVersion"))) || ((data.turnNumber === undefined) && (missing0 = "turnNumber"))) || ((data.origin === undefined) && (missing0 = "origin"))){validate1749.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((((key0 === "sessionId") || (key0 === "runId")) || (key0 === "runVersion")) || (key0 === "turnNumber")) || (key0 === "origin")) || (key0 === "cause"))){validate1749.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1749.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1749.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.runId !== undefined){let data1: any = data.runId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate1749.errors = [{instancePath:instancePath+"/runId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1749.errors = [{instancePath:instancePath+"/runId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.runVersion !== undefined){let data2: any = data.runVersion;const _errs10: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validate1749.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/properties/runVersion/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs10){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validate1749.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/properties/runVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 0 || isNaN(data2)){validate1749.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/properties/runVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.turnNumber !== undefined){let data3: any = data.turnNumber;const _errs12: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validate1749.errors = [{instancePath:instancePath+"/turnNumber",schemaPath:"#/properties/turnNumber/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs12){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 9007199254740991 || isNaN(data3)){validate1749.errors = [{instancePath:instancePath+"/turnNumber",schemaPath:"#/properties/turnNumber/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data3 < 1 || isNaN(data3)){validate1749.errors = [{instancePath:instancePath+"/turnNumber",schemaPath:"#/properties/turnNumber/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}if(valid0){if(data.origin !== undefined){let data4: any = data.origin;const _errs14: any = errors;if(typeof data4 !== "string"){validate1749.errors = [{instancePath:instancePath+"/origin",schemaPath:"#/$defs/TurnEndOrigin/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data4 === "provider") || (data4 === "daemon"))){validate1749.errors = [{instancePath:instancePath+"/origin",schemaPath:"#/$defs/TurnEndOrigin/enum",keyword:"enum",params:{allowedValues: schema969.enum}}];return false;}var valid0: any = _errs14 === errors;}else {var valid0: any = true;}if(valid0){if(data.cause !== undefined){let data5: any = data.cause;const _errs17: any = errors;if(typeof data5 !== "string"){validate1749.errors = [{instancePath:instancePath+"/cause",schemaPath:"#/$defs/TurnEndCause/type",keyword:"type",params:{type: "string"}}];return false;}if(!((((((data5 === "processExit") || (data5 === "daemonRestart")) || (data5 === "daemonStop")) || (data5 === "stepLimit")) || (data5 === "spendLimit")) || (data5 === "tokenLimit"))){validate1749.errors = [{instancePath:instancePath+"/cause",schemaPath:"#/$defs/TurnEndCause/enum",keyword:"enum",params:{allowedValues: schema970.enum}}];return false;}var valid0: any = _errs17 === errors;}else {var valid0: any = true;}}}}}}}}}else {validate1749.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1749.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1749.errors = null as any[] | null;
// prettier-ignore
validate1749.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1750(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is AgentTurnStartedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1750.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.runId === undefined) && (missing0 = "runId"))) || ((data.runVersion === undefined) && (missing0 = "runVersion"))) || ((data.turnNumber === undefined) && (missing0 = "turnNumber"))){validate1750.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((((key0 === "sessionId") || (key0 === "runId")) || (key0 === "runVersion")) || (key0 === "turnNumber")) || (key0 === "position")) || (key0 === "providerTurnId"))){validate1750.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1750.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1750.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.runId !== undefined){let data1: any = data.runId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate1750.errors = [{instancePath:instancePath+"/runId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1750.errors = [{instancePath:instancePath+"/runId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.runVersion !== undefined){let data2: any = data.runVersion;const _errs10: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validate1750.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/properties/runVersion/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs10){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validate1750.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/properties/runVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 0 || isNaN(data2)){validate1750.errors = [{instancePath:instancePath+"/runVersion",schemaPath:"#/properties/runVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.turnNumber !== undefined){let data3: any = data.turnNumber;const _errs12: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validate1750.errors = [{instancePath:instancePath+"/turnNumber",schemaPath:"#/properties/turnNumber/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs12){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 9007199254740991 || isNaN(data3)){validate1750.errors = [{instancePath:instancePath+"/turnNumber",schemaPath:"#/properties/turnNumber/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data3 < 1 || isNaN(data3)){validate1750.errors = [{instancePath:instancePath+"/turnNumber",schemaPath:"#/properties/turnNumber/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}if(valid0){if(data.position !== undefined){let data4: any = data.position;const _errs14: any = errors;const _errs15: any = errors;if(!(((typeof data4 == "number") && (!(data4 % 1) && !isNaN(data4))) && (isFinite(data4)))){validate1750.errors = [{instancePath:instancePath+"/position",schemaPath:"sidekicks-contracts:event/envelope#/$defs/SourcePosition/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs15){if((typeof data4 == "number") && (isFinite(data4))){if(data4 > 9007199254740991 || isNaN(data4)){validate1750.errors = [{instancePath:instancePath+"/position",schemaPath:"sidekicks-contracts:event/envelope#/$defs/SourcePosition/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data4 < 0 || isNaN(data4)){validate1750.errors = [{instancePath:instancePath+"/position",schemaPath:"sidekicks-contracts:event/envelope#/$defs/SourcePosition/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs14 === errors;}else {var valid0: any = true;}if(valid0){if(data.providerTurnId !== undefined){let data5: any = data.providerTurnId;const _errs17: any = errors;const _errs18: any = errors;if(errors === _errs18){if(typeof data5 === "string"){if(func1(data5) > 256){validate1750.errors = [{instancePath:instancePath+"/providerTurnId",schemaPath:"sidekicks-contracts:turn#/$defs/ProviderTurnId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data5) < 1){validate1750.errors = [{instancePath:instancePath+"/providerTurnId",schemaPath:"sidekicks-contracts:turn#/$defs/ProviderTurnId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data5)){validate1750.errors = [{instancePath:instancePath+"/providerTurnId",schemaPath:"sidekicks-contracts:turn#/$defs/ProviderTurnId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1750.errors = [{instancePath:instancePath+"/providerTurnId",schemaPath:"sidekicks-contracts:turn#/$defs/ProviderTurnId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs17 === errors;}else {var valid0: any = true;}}}}}}}}}else {validate1750.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1750.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1750.errors = null as any[] | null;
// prettier-ignore
validate1750.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link AgentChildrenStoppedPayload}. */
export const validateAgentChildrenStoppedPayload: SchemaCheck<AgentChildrenStoppedPayload> =
  validate1742;
/** Checks that a value is a {@link AgentRunParentCorrectedPayload}. */
export const validateAgentRunParentCorrectedPayload: SchemaCheck<AgentRunParentCorrectedPayload> =
  validate1744;
/** Checks that a value is a {@link AgentRunProviderInitializedPayload}. */
export const validateAgentRunProviderInitializedPayload: SchemaCheck<AgentRunProviderInitializedPayload> =
  validate1745;
/** Checks that a value is a {@link AgentRunWorkerShuttingDownPayload}. */
export const validateAgentRunWorkerShuttingDownPayload: SchemaCheck<AgentRunWorkerShuttingDownPayload> =
  validate1746;
/** Checks that a value is a {@link AgentTurnCompletedPayload}. */
export const validateAgentTurnCompletedPayload: SchemaCheck<AgentTurnCompletedPayload> =
  validate1747;
/** Checks that a value is a {@link AgentTurnFailedPayload}. */
export const validateAgentTurnFailedPayload: SchemaCheck<AgentTurnFailedPayload> = validate1748;
/** Checks that a value is a {@link AgentTurnInterruptedPayload}. */
export const validateAgentTurnInterruptedPayload: SchemaCheck<AgentTurnInterruptedPayload> =
  validate1749;
/** Checks that a value is a {@link AgentTurnStartedPayload}. */
export const validateAgentTurnStartedPayload: SchemaCheck<AgentTurnStartedPayload> = validate1750;
