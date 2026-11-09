// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The service's recovery after a restart: its state, the refusals a write meets, the repair of the database file and the recovery pass's events.

import { type SchemaCheck, ucs2length } from "../../schema-check.js";
import type { WireInstant } from "../internal/wire-scalars.js";
import type { MachineId } from "../machine/id.js";
import type { RecoveryCondition } from "../provider/driver/recovery.js";
import type { RunFailureCategory } from "../run/control.js";
import type { RunId } from "../run/id.js";
import type { SessionId } from "../session/id.js";

/**
 * The error code a service answers `connection.initialize` with, once the request carries its
 * session token, while it repairs its database file. A client waits for it rather than
 * counting it as silence.
 */
export const DAEMON_REPAIRING_CODE = "daemon.repairing" as const;

/** What a person reads while the service repairs its database file. */
export const DAEMON_REPAIRING_LINE =
  "Repairing saved sessions after an unexpected shutdown" as const;

/**
 * Where the service stands in recovery: `rebuilding` while the restart's pass runs, `degraded`
 * while one or more sessions have damaged history, and `blocked` when the local store itself is
 * unavailable. Ordered from least to most severe.
 */
export type DaemonRecoveryState = "healthy" | "rebuilding" | "degraded" | "blocked";
/**
 * Where one session that is not healthy stands: `rebuilding` while the restart's pass has yet to
 * rebuild it, which a write refusal names and the status read leaves to the service's own state,
 * `degraded` when its history is damaged after a readable start, so it opens read-only at its
 * last good point, `damaged` when no event of it can be read, and `blocked` when a run of it
 * halted after the restart on a question for the person, named in its `haltedRuns`.
 */
export type DaemonRecoverySessionState = "rebuilding" | "degraded" | "damaged" | "blocked";
/**
 * The service's state when a write was refused by the whole service.
 */
export type DaemonWriteRefusedRecovery = "rebuilding" | "blocked";
/**
 * The step of the recovery pass an event's outcome was decided in.
 */
export type RecoveryPhase = "projectionRebuild" | "bindingRestore" | "runResumption";
/**
 * What started a recovery pass.
 */
export type RecoveryTrigger = "startup" | "manual" | "supervisor";
/**
 * Identifies one recovery pass; every event of the pass names it.
 */
export type RecoveryId = string & { readonly __brand: "RecoveryId" };
/**
 * What kind of failure a failed recovery pass met.
 */
export type RecoveryFailureKind =
  | "projectionRebuildFailed"
  | "bindingRestoreFailed"
  | "persistenceUnavailable"
  | "other";

/**
 * One run behind a session's entry that needs the person: a halt on a diverged resume carries no
 * `failureCategory`, since the run did not fail; a failed resume carries one.
 */
export interface DaemonRecoveryHaltedRun {
  /**
   * The run.
   */
  runId: RunId;
  /**
   * What its recovery needs.
   */
  recoveryCondition: RecoveryCondition;
  /**
   * Why it failed, where it did.
   */
  failureCategory?: RunFailureCategory;
}
/**
 * One session that is not healthy, and why. A `degraded` session carries its last good point:
 * the last event it opens at, that event's time, and the first event that cannot be read.
 */
export interface DaemonRecoverySession {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * Where it stands.
   */
  state: DaemonRecoverySessionState;
  /**
   * The last event sequence the session's projections reflect.
   */
  lastAppliedSequence?: number;
  /**
   * When the event at `last_applied_sequence` happened.
   */
  lastAppliedAt?: WireInstant;
  /**
   * The first event that cannot be read; every event from it to the head is damaged.
   */
  damagedFromSequence?: number;
  /**
   * Why its run failed, where one did.
   */
  failureCategory?: RunFailureCategory;
  /**
   * What its recovery needs, where that is known.
   */
  recoveryCondition?: RecoveryCondition;
  /**
   * The runs that need the person, each once; absent when no run does.
   */
  haltedRuns?: DaemonRecoveryHaltedRun[];
}
/**
 * The `recovery` member of `daemon.status.read`: the service's overall state and the sessions that
 * are not healthy, each damaged session among them.
 */
export interface DaemonRecoveryStatus {
  /**
   * The service's overall state.
   */
  overall: DaemonRecoveryState;
  /**
   * The sessions that are not healthy.
   */
  sessions: DaemonRecoverySession[];
}
/**
 * The `daemon.writeRefused` refusal's `data.fields`: the service's recovery state when the call
 * arrived.
 */
export interface DaemonWriteRefusedDetails {
  /**
   * The service's state.
   */
  recovery: DaemonWriteRefusedRecovery;
}
/**
 * How far a repair has come: `done` of the damaged file's `total` session events recovered.
 */
export interface DaemonRepairProgress {
  /**
   * The session events recovered so far.
   */
  done: number;
  /**
   * The session events the damaged file lists.
   */
  total: number;
}
/**
 * The `daemon.repairing` refusal's `data.fields`: the repair's count, absent while the step it is
 * on gives none.
 */
export interface DaemonRepairingDetails {
  /**
   * The repair's count.
   */
  progress?: DaemonRepairProgress;
}
/**
 * `daemon.recovery.attempted`: a recovery pass started. Like every recovery event it names this
 * machine, the pass, the step it was in, and which attempt it is, one above the failed passes
 * since the last one that succeeded.
 */
export interface DaemonRecoveryAttemptedPayload {
  /**
   * This machine.
   */
  machineId: MachineId;
  /**
   * The pass.
   */
  recoveryId: RecoveryId;
  /**
   * The step it was in.
   */
  phase: RecoveryPhase;
  /**
   * Which attempt it is.
   */
  attemptNumber: number;
  /**
   * What started it.
   */
  recoveryTrigger: RecoveryTrigger;
  /**
   * The failed passes since the last one that succeeded.
   */
  priorFailureCount: number;
  /**
   * When it started.
   */
  startedAt: WireInstant;
}
/**
 * `daemon.recovery.succeeded`: a recovery pass completed; every count is of this pass alone, and
 * every run it settled is in exactly one of the run counts.
 */
export interface DaemonRecoverySucceededPayload {
  /**
   * This machine.
   */
  machineId: MachineId;
  /**
   * The pass.
   */
  recoveryId: RecoveryId;
  /**
   * The step it was in.
   */
  phase: RecoveryPhase;
  /**
   * Which attempt it is.
   */
  attemptNumber: number;
  /**
   * The events applied.
   */
  eventsApplied: number;
  /**
   * The provider bindings restored.
   */
  bindingsRestored: number;
  /**
   * The runs resumed.
   */
  runsResumed: number;
  /**
   * The runs that failed deterministically.
   */
  runsFailedDeterministically: number;
  /**
   * The runs halted for the person to reconcile.
   */
  runsHaltedForReconciliation: number;
  /**
   * The runs ended `interrupted`: under the person's pending interrupt, a paused child, or at a
   * step or spend limit their log still owed.
   */
  runsInterrupted: number;
  /**
   * The runs ended `stopped` at a token limit their log still owed.
   */
  runsStopped: number;
  /**
   * How long it took, on a monotonic clock, in milliseconds.
   */
  durationMs: number;
  /**
   * When it completed.
   */
  completedAt: WireInstant;
}
/**
 * `daemon.recovery.failed`: a recovery pass that left the service blocked, when the local store
 * failed, or degraded, when a session's history could not be rebuilt whole; `detail` is in the
 * service's own words.
 */
export interface DaemonRecoveryFailedPayload {
  /**
   * This machine.
   */
  machineId: MachineId;
  /**
   * The pass.
   */
  recoveryId: RecoveryId;
  /**
   * The step it was in.
   */
  phase: RecoveryPhase;
  /**
   * Which attempt it is.
   */
  attemptNumber: number;
  /**
   * What kind of failure it met.
   */
  failureKind: RecoveryFailureKind;
  /**
   * The failure, in the service's own words.
   */
  detail: string;
  /**
   * The runs the pass left live.
   */
  runsLeftInFlight: RunId[];
  /**
   * How long it took, on a monotonic clock, in milliseconds.
   */
  durationMs: number;
}

// prettier-ignore
const schema678: any = {"description":"The step of the recovery pass an event's outcome was decided in.","type":"string","enum":["projectionRebuild","bindingRestore","runResumption"]};
// prettier-ignore
const schema679: any = {"description":"What started a recovery pass.","type":"string","enum":["startup","manual","supervisor"]};
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
const pattern4 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
// prettier-ignore
const pattern5 = new RegExp("^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$", "u");
// prettier-ignore
function validate350(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DaemonRecoveryAttemptedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate350.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((((data.machineId === undefined) && (missing0 = "machineId")) || ((data.recoveryId === undefined) && (missing0 = "recoveryId"))) || ((data.phase === undefined) && (missing0 = "phase"))) || ((data.attemptNumber === undefined) && (missing0 = "attemptNumber"))) || ((data.recoveryTrigger === undefined) && (missing0 = "recoveryTrigger"))) || ((data.priorFailureCount === undefined) && (missing0 = "priorFailureCount"))) || ((data.startedAt === undefined) && (missing0 = "startedAt"))){validate350.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((((key0 === "machineId") || (key0 === "recoveryId")) || (key0 === "phase")) || (key0 === "attemptNumber")) || (key0 === "recoveryTrigger")) || (key0 === "priorFailureCount")) || (key0 === "startedAt"))){validate350.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.machineId !== undefined){let data0: any = data.machineId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(func1(data0) > 256){validate350.errors = [{instancePath:instancePath+"/machineId",schemaPath:"sidekicks-contracts:machine/id#/$defs/MachineId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data0) < 1){validate350.errors = [{instancePath:instancePath+"/machineId",schemaPath:"sidekicks-contracts:machine/id#/$defs/MachineId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate350.errors = [{instancePath:instancePath+"/machineId",schemaPath:"sidekicks-contracts:machine/id#/$defs/MachineId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.recoveryId !== undefined){let data1: any = data.recoveryId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate350.errors = [{instancePath:instancePath+"/recoveryId",schemaPath:"#/$defs/RecoveryId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate350.errors = [{instancePath:instancePath+"/recoveryId",schemaPath:"#/$defs/RecoveryId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.phase !== undefined){let data2: any = data.phase;const _errs10: any = errors;if(typeof data2 !== "string"){validate350.errors = [{instancePath:instancePath+"/phase",schemaPath:"#/$defs/RecoveryPhase/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data2 === "projectionRebuild") || (data2 === "bindingRestore")) || (data2 === "runResumption"))){validate350.errors = [{instancePath:instancePath+"/phase",schemaPath:"#/$defs/RecoveryPhase/enum",keyword:"enum",params:{allowedValues: schema678.enum}}];return false;}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.attemptNumber !== undefined){let data3: any = data.attemptNumber;const _errs13: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validate350.errors = [{instancePath:instancePath+"/attemptNumber",schemaPath:"#/properties/attemptNumber/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs13){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 9007199254740991 || isNaN(data3)){validate350.errors = [{instancePath:instancePath+"/attemptNumber",schemaPath:"#/properties/attemptNumber/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data3 < 1 || isNaN(data3)){validate350.errors = [{instancePath:instancePath+"/attemptNumber",schemaPath:"#/properties/attemptNumber/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs13 === errors;}else {var valid0: any = true;}if(valid0){if(data.recoveryTrigger !== undefined){let data4: any = data.recoveryTrigger;const _errs15: any = errors;if(typeof data4 !== "string"){validate350.errors = [{instancePath:instancePath+"/recoveryTrigger",schemaPath:"#/$defs/RecoveryTrigger/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data4 === "startup") || (data4 === "manual")) || (data4 === "supervisor"))){validate350.errors = [{instancePath:instancePath+"/recoveryTrigger",schemaPath:"#/$defs/RecoveryTrigger/enum",keyword:"enum",params:{allowedValues: schema679.enum}}];return false;}var valid0: any = _errs15 === errors;}else {var valid0: any = true;}if(valid0){if(data.priorFailureCount !== undefined){let data5: any = data.priorFailureCount;const _errs18: any = errors;if(!(((typeof data5 == "number") && (!(data5 % 1) && !isNaN(data5))) && (isFinite(data5)))){validate350.errors = [{instancePath:instancePath+"/priorFailureCount",schemaPath:"#/properties/priorFailureCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs18){if((typeof data5 == "number") && (isFinite(data5))){if(data5 > 9007199254740991 || isNaN(data5)){validate350.errors = [{instancePath:instancePath+"/priorFailureCount",schemaPath:"#/properties/priorFailureCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data5 < 0 || isNaN(data5)){validate350.errors = [{instancePath:instancePath+"/priorFailureCount",schemaPath:"#/properties/priorFailureCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs18 === errors;}else {var valid0: any = true;}if(valid0){if(data.startedAt !== undefined){let data6: any = data.startedAt;const _errs20: any = errors;const _errs21: any = errors;if(errors === _errs21){if(typeof data6 === "string"){if(!pattern5.test(data6)){validate350.errors = [{instancePath:instancePath+"/startedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}}];return false;}}else {validate350.errors = [{instancePath:instancePath+"/startedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs20 === errors;}else {var valid0: any = true;}}}}}}}}}}else {validate350.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate350.errors = vErrors;return errors === 0;}
// prettier-ignore
validate350.errors = null as any[] | null;
// prettier-ignore
validate350.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema685: any = {"description":"What kind of failure a failed recovery pass met.","type":"string","enum":["projectionRebuildFailed","bindingRestoreFailed","persistenceUnavailable","other"]};
// prettier-ignore
const pattern6 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
// prettier-ignore
function validate351(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DaemonRecoveryFailedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate351.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((((((data.machineId === undefined) && (missing0 = "machineId")) || ((data.recoveryId === undefined) && (missing0 = "recoveryId"))) || ((data.phase === undefined) && (missing0 = "phase"))) || ((data.attemptNumber === undefined) && (missing0 = "attemptNumber"))) || ((data.failureKind === undefined) && (missing0 = "failureKind"))) || ((data.detail === undefined) && (missing0 = "detail"))) || ((data.runsLeftInFlight === undefined) && (missing0 = "runsLeftInFlight"))) || ((data.durationMs === undefined) && (missing0 = "durationMs"))){validate351.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((((((key0 === "machineId") || (key0 === "recoveryId")) || (key0 === "phase")) || (key0 === "attemptNumber")) || (key0 === "failureKind")) || (key0 === "detail")) || (key0 === "runsLeftInFlight")) || (key0 === "durationMs"))){validate351.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.machineId !== undefined){let data0: any = data.machineId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(func1(data0) > 256){validate351.errors = [{instancePath:instancePath+"/machineId",schemaPath:"sidekicks-contracts:machine/id#/$defs/MachineId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data0) < 1){validate351.errors = [{instancePath:instancePath+"/machineId",schemaPath:"sidekicks-contracts:machine/id#/$defs/MachineId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate351.errors = [{instancePath:instancePath+"/machineId",schemaPath:"sidekicks-contracts:machine/id#/$defs/MachineId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.recoveryId !== undefined){let data1: any = data.recoveryId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate351.errors = [{instancePath:instancePath+"/recoveryId",schemaPath:"#/$defs/RecoveryId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate351.errors = [{instancePath:instancePath+"/recoveryId",schemaPath:"#/$defs/RecoveryId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.phase !== undefined){let data2: any = data.phase;const _errs10: any = errors;if(typeof data2 !== "string"){validate351.errors = [{instancePath:instancePath+"/phase",schemaPath:"#/$defs/RecoveryPhase/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data2 === "projectionRebuild") || (data2 === "bindingRestore")) || (data2 === "runResumption"))){validate351.errors = [{instancePath:instancePath+"/phase",schemaPath:"#/$defs/RecoveryPhase/enum",keyword:"enum",params:{allowedValues: schema678.enum}}];return false;}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.attemptNumber !== undefined){let data3: any = data.attemptNumber;const _errs13: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validate351.errors = [{instancePath:instancePath+"/attemptNumber",schemaPath:"#/properties/attemptNumber/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs13){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 9007199254740991 || isNaN(data3)){validate351.errors = [{instancePath:instancePath+"/attemptNumber",schemaPath:"#/properties/attemptNumber/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data3 < 1 || isNaN(data3)){validate351.errors = [{instancePath:instancePath+"/attemptNumber",schemaPath:"#/properties/attemptNumber/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs13 === errors;}else {var valid0: any = true;}if(valid0){if(data.failureKind !== undefined){let data4: any = data.failureKind;const _errs15: any = errors;if(typeof data4 !== "string"){validate351.errors = [{instancePath:instancePath+"/failureKind",schemaPath:"#/$defs/RecoveryFailureKind/type",keyword:"type",params:{type: "string"}}];return false;}if(!((((data4 === "projectionRebuildFailed") || (data4 === "bindingRestoreFailed")) || (data4 === "persistenceUnavailable")) || (data4 === "other"))){validate351.errors = [{instancePath:instancePath+"/failureKind",schemaPath:"#/$defs/RecoveryFailureKind/enum",keyword:"enum",params:{allowedValues: schema685.enum}}];return false;}var valid0: any = _errs15 === errors;}else {var valid0: any = true;}if(valid0){if(data.detail !== undefined){let data5: any = data.detail;const _errs18: any = errors;if(errors === _errs18){if(typeof data5 === "string"){if(func1(data5) > 32768){validate351.errors = [{instancePath:instancePath+"/detail",schemaPath:"#/properties/detail/maxLength",keyword:"maxLength",params:{limit: 32768}}];return false;}else {if(func1(data5) < 1){validate351.errors = [{instancePath:instancePath+"/detail",schemaPath:"#/properties/detail/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data5)){validate351.errors = [{instancePath:instancePath+"/detail",schemaPath:"#/properties/detail/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate351.errors = [{instancePath:instancePath+"/detail",schemaPath:"#/properties/detail/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs18 === errors;}else {var valid0: any = true;}if(valid0){if(data.runsLeftInFlight !== undefined){let data6: any = data.runsLeftInFlight;const _errs20: any = errors;if(errors === _errs20){if(Array.isArray(data6)){var valid5: any = true;const len0: any = data6.length;for(let i0=0; i0<len0; i0++){let data7: any = data6[i0];const _errs22: any = errors;const _errs23: any = errors;if(errors === _errs23){if(typeof data7 === "string"){if(!pattern4.test(data7)){validate351.errors = [{instancePath:instancePath+"/runsLeftInFlight/" + i0,schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate351.errors = [{instancePath:instancePath+"/runsLeftInFlight/" + i0,schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs22 === errors;if(!valid5){break;}}}else {validate351.errors = [{instancePath:instancePath+"/runsLeftInFlight",schemaPath:"#/properties/runsLeftInFlight/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs20 === errors;}else {var valid0: any = true;}if(valid0){if(data.durationMs !== undefined){let data8: any = data.durationMs;const _errs26: any = errors;if(!(((typeof data8 == "number") && (!(data8 % 1) && !isNaN(data8))) && (isFinite(data8)))){validate351.errors = [{instancePath:instancePath+"/durationMs",schemaPath:"#/properties/durationMs/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs26){if((typeof data8 == "number") && (isFinite(data8))){if(data8 > 9007199254740991 || isNaN(data8)){validate351.errors = [{instancePath:instancePath+"/durationMs",schemaPath:"#/properties/durationMs/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data8 < 0 || isNaN(data8)){validate351.errors = [{instancePath:instancePath+"/durationMs",schemaPath:"#/properties/durationMs/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs26 === errors;}else {var valid0: any = true;}}}}}}}}}}}else {validate351.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate351.errors = vErrors;return errors === 0;}
// prettier-ignore
validate351.errors = null as any[] | null;
// prettier-ignore
validate351.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema688: any = {"description":"Where the service stands in recovery: `rebuilding` while the restart's pass runs, `degraded`\nwhile one or more sessions have damaged history, and `blocked` when the local store itself is\nunavailable. Ordered from least to most severe.","type":"string","enum":["healthy","rebuilding","degraded","blocked"]};
// prettier-ignore
const schema691: any = {"description":"Where one session that is not healthy stands: `rebuilding` while the restart's pass has yet to\nrebuild it, which a write refusal names and the status read leaves to the service's own state,\n`degraded` when its history is damaged after a readable start, so it opens read-only at its\nlast good point, `damaged` when no event of it can be read, and `blocked` when a run of it\nhalted after the restart on a question for the person, named in its `haltedRuns`.","type":"string","enum":["rebuilding","degraded","damaged","blocked"]};
// prettier-ignore
const schema694: any = {"description":"Why a run failed.","type":"string","enum":["providerFailure","transportFailure","localPersistenceFailure","projectionFailure","refused","setupFailure"]};
// prettier-ignore
const schema696: any = {"description":"Why a run needs attention.","type":"string","enum":["recoveryNeeded","reauthRequired"]};
// prettier-ignore
function validate356(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate356.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.runId === undefined) && (missing0 = "runId")) || ((data.recoveryCondition === undefined) && (missing0 = "recoveryCondition"))){validate356.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "runId") || (key0 === "recoveryCondition")) || (key0 === "failureCategory"))){validate356.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.runId !== undefined){let data0: any = data.runId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate356.errors = [{instancePath:instancePath+"/runId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate356.errors = [{instancePath:instancePath+"/runId",schemaPath:"sidekicks-contracts:run/id#/$defs/RunId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.recoveryCondition !== undefined){let data1: any = data.recoveryCondition;const _errs6: any = errors;if(typeof data1 !== "string"){validate356.errors = [{instancePath:instancePath+"/recoveryCondition",schemaPath:"sidekicks-contracts:provider/driver/recovery#/$defs/RecoveryCondition/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data1 === "recoveryNeeded") || (data1 === "reauthRequired"))){validate356.errors = [{instancePath:instancePath+"/recoveryCondition",schemaPath:"sidekicks-contracts:provider/driver/recovery#/$defs/RecoveryCondition/enum",keyword:"enum",params:{allowedValues: schema696.enum}}];return false;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.failureCategory !== undefined){let data2: any = data.failureCategory;const _errs9: any = errors;if(typeof data2 !== "string"){validate356.errors = [{instancePath:instancePath+"/failureCategory",schemaPath:"sidekicks-contracts:run/control#/$defs/RunFailureCategory/type",keyword:"type",params:{type: "string"}}];return false;}if(!((((((data2 === "providerFailure") || (data2 === "transportFailure")) || (data2 === "localPersistenceFailure")) || (data2 === "projectionFailure")) || (data2 === "refused")) || (data2 === "setupFailure"))){validate356.errors = [{instancePath:instancePath+"/failureCategory",schemaPath:"sidekicks-contracts:run/control#/$defs/RunFailureCategory/enum",keyword:"enum",params:{allowedValues: schema694.enum}}];return false;}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}}}}}}else {validate356.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate356.errors = vErrors;return errors === 0;}
// prettier-ignore
validate356.errors = null as any[] | null;
// prettier-ignore
validate356.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate353(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate353.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.state === undefined) && (missing0 = "state"))){validate353.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((((((key0 === "sessionId") || (key0 === "state")) || (key0 === "lastAppliedSequence")) || (key0 === "lastAppliedAt")) || (key0 === "damagedFromSequence")) || (key0 === "failureCategory")) || (key0 === "recoveryCondition")) || (key0 === "haltedRuns"))){validate353.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate353.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate353.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.state !== undefined){let data1: any = data.state;const _errs6: any = errors;if(typeof data1 !== "string"){validate353.errors = [{instancePath:instancePath+"/state",schemaPath:"#/$defs/DaemonRecoverySessionState/type",keyword:"type",params:{type: "string"}}];return false;}if(!((((data1 === "rebuilding") || (data1 === "degraded")) || (data1 === "damaged")) || (data1 === "blocked"))){validate353.errors = [{instancePath:instancePath+"/state",schemaPath:"#/$defs/DaemonRecoverySessionState/enum",keyword:"enum",params:{allowedValues: schema691.enum}}];return false;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.lastAppliedSequence !== undefined){let data2: any = data.lastAppliedSequence;const _errs9: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validate353.errors = [{instancePath:instancePath+"/lastAppliedSequence",schemaPath:"#/properties/lastAppliedSequence/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs9){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validate353.errors = [{instancePath:instancePath+"/lastAppliedSequence",schemaPath:"#/properties/lastAppliedSequence/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 0 || isNaN(data2)){validate353.errors = [{instancePath:instancePath+"/lastAppliedSequence",schemaPath:"#/properties/lastAppliedSequence/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}if(valid0){if(data.lastAppliedAt !== undefined){let data3: any = data.lastAppliedAt;const _errs11: any = errors;const _errs12: any = errors;if(errors === _errs12){if(typeof data3 === "string"){if(!pattern5.test(data3)){validate353.errors = [{instancePath:instancePath+"/lastAppliedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}}];return false;}}else {validate353.errors = [{instancePath:instancePath+"/lastAppliedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs11 === errors;}else {var valid0: any = true;}if(valid0){if(data.damagedFromSequence !== undefined){let data4: any = data.damagedFromSequence;const _errs14: any = errors;if(!(((typeof data4 == "number") && (!(data4 % 1) && !isNaN(data4))) && (isFinite(data4)))){validate353.errors = [{instancePath:instancePath+"/damagedFromSequence",schemaPath:"#/properties/damagedFromSequence/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs14){if((typeof data4 == "number") && (isFinite(data4))){if(data4 > 9007199254740991 || isNaN(data4)){validate353.errors = [{instancePath:instancePath+"/damagedFromSequence",schemaPath:"#/properties/damagedFromSequence/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data4 < 0 || isNaN(data4)){validate353.errors = [{instancePath:instancePath+"/damagedFromSequence",schemaPath:"#/properties/damagedFromSequence/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs14 === errors;}else {var valid0: any = true;}if(valid0){if(data.failureCategory !== undefined){let data5: any = data.failureCategory;const _errs16: any = errors;if(typeof data5 !== "string"){validate353.errors = [{instancePath:instancePath+"/failureCategory",schemaPath:"sidekicks-contracts:run/control#/$defs/RunFailureCategory/type",keyword:"type",params:{type: "string"}}];return false;}if(!((((((data5 === "providerFailure") || (data5 === "transportFailure")) || (data5 === "localPersistenceFailure")) || (data5 === "projectionFailure")) || (data5 === "refused")) || (data5 === "setupFailure"))){validate353.errors = [{instancePath:instancePath+"/failureCategory",schemaPath:"sidekicks-contracts:run/control#/$defs/RunFailureCategory/enum",keyword:"enum",params:{allowedValues: schema694.enum}}];return false;}var valid0: any = _errs16 === errors;}else {var valid0: any = true;}if(valid0){if(data.recoveryCondition !== undefined){let data6: any = data.recoveryCondition;const _errs19: any = errors;if(typeof data6 !== "string"){validate353.errors = [{instancePath:instancePath+"/recoveryCondition",schemaPath:"sidekicks-contracts:provider/driver/recovery#/$defs/RecoveryCondition/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data6 === "recoveryNeeded") || (data6 === "reauthRequired"))){validate353.errors = [{instancePath:instancePath+"/recoveryCondition",schemaPath:"sidekicks-contracts:provider/driver/recovery#/$defs/RecoveryCondition/enum",keyword:"enum",params:{allowedValues: schema696.enum}}];return false;}var valid0: any = _errs19 === errors;}else {var valid0: any = true;}if(valid0){if(data.haltedRuns !== undefined){let data7: any = data.haltedRuns;const _errs22: any = errors;if(errors === _errs22){if(Array.isArray(data7)){var valid6: any = true;const len0: any = data7.length;for(let i0=0; i0<len0; i0++){const _errs24: any = errors;if(!(validate356.call(this, data7[i0], {instancePath:instancePath+"/haltedRuns/" + i0,parentData:data7,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate356.errors : vErrors.concat(validate356.errors);errors = vErrors.length;}var valid6: any = _errs24 === errors;if(!valid6){break;}}}else {validate353.errors = [{instancePath:instancePath+"/haltedRuns",schemaPath:"#/properties/haltedRuns/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs22 === errors;}else {var valid0: any = true;}}}}}}}}}}}else {validate353.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate353.errors = vErrors;return errors === 0;}
// prettier-ignore
validate353.errors = null as any[] | null;
// prettier-ignore
validate353.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate352(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DaemonRecoveryStatus {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate352.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.overall === undefined) && (missing0 = "overall")) || ((data.sessions === undefined) && (missing0 = "sessions"))){validate352.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "overall") || (key0 === "sessions"))){validate352.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.overall !== undefined){let data0: any = data.overall;const _errs2: any = errors;if(typeof data0 !== "string"){validate352.errors = [{instancePath:instancePath+"/overall",schemaPath:"#/$defs/DaemonRecoveryState/type",keyword:"type",params:{type: "string"}}];return false;}if(!((((data0 === "healthy") || (data0 === "rebuilding")) || (data0 === "degraded")) || (data0 === "blocked"))){validate352.errors = [{instancePath:instancePath+"/overall",schemaPath:"#/$defs/DaemonRecoveryState/enum",keyword:"enum",params:{allowedValues: schema688.enum}}];return false;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.sessions !== undefined){let data1: any = data.sessions;const _errs5: any = errors;if(errors === _errs5){if(Array.isArray(data1)){var valid2: any = true;const len0: any = data1.length;for(let i0=0; i0<len0; i0++){const _errs7: any = errors;if(!(validate353.call(this, data1[i0], {instancePath:instancePath+"/sessions/" + i0,parentData:data1,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate353.errors : vErrors.concat(validate353.errors);errors = vErrors.length;}var valid2: any = _errs7 === errors;if(!valid2){break;}}}else {validate352.errors = [{instancePath:instancePath+"/sessions",schemaPath:"#/properties/sessions/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}else {validate352.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate352.errors = vErrors;return errors === 0;}
// prettier-ignore
validate352.errors = null as any[] | null;
// prettier-ignore
validate352.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema701: any = {"type":"object","additionalProperties":false,"properties":{"machineId":{"$ref":"sidekicks-contracts:machine/id#/$defs/MachineId","description":"This machine."},"recoveryId":{"$ref":"#/$defs/RecoveryId","description":"The pass."},"phase":{"$ref":"#/$defs/RecoveryPhase","description":"The step it was in."},"attemptNumber":{"type":"integer","minimum":1,"maximum":9007199254740991,"description":"Which attempt it is."},"eventsApplied":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"The events applied."},"bindingsRestored":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"The provider bindings restored."},"runsResumed":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"The runs resumed."},"runsFailedDeterministically":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"The runs that failed deterministically."},"runsHaltedForReconciliation":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"The runs halted for the person to reconcile."},"runsInterrupted":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"The runs ended `interrupted`: under the person's pending interrupt, a paused child, or at a\nstep or spend limit their log still owed."},"runsStopped":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"The runs ended `stopped` at a token limit their log still owed."},"durationMs":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"How long it took, on a monotonic clock, in milliseconds."},"completedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When it completed."}},"required":["machineId","recoveryId","phase","attemptNumber","eventsApplied","bindingsRestored","runsResumed","runsFailedDeterministically","runsHaltedForReconciliation","runsInterrupted","runsStopped","durationMs","completedAt"],"description":"`daemon.recovery.succeeded`: a recovery pass completed; every count is of this pass alone, and\nevery run it settled is in exactly one of the run counts."};
// prettier-ignore
const func2 = Object.prototype.hasOwnProperty;
// prettier-ignore
function validate359(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DaemonRecoverySucceededPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate359.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((((((((((data.machineId === undefined) && (missing0 = "machineId")) || ((data.recoveryId === undefined) && (missing0 = "recoveryId"))) || ((data.phase === undefined) && (missing0 = "phase"))) || ((data.attemptNumber === undefined) && (missing0 = "attemptNumber"))) || ((data.eventsApplied === undefined) && (missing0 = "eventsApplied"))) || ((data.bindingsRestored === undefined) && (missing0 = "bindingsRestored"))) || ((data.runsResumed === undefined) && (missing0 = "runsResumed"))) || ((data.runsFailedDeterministically === undefined) && (missing0 = "runsFailedDeterministically"))) || ((data.runsHaltedForReconciliation === undefined) && (missing0 = "runsHaltedForReconciliation"))) || ((data.runsInterrupted === undefined) && (missing0 = "runsInterrupted"))) || ((data.runsStopped === undefined) && (missing0 = "runsStopped"))) || ((data.durationMs === undefined) && (missing0 = "durationMs"))) || ((data.completedAt === undefined) && (missing0 = "completedAt"))){validate359.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(func2.call(schema701.properties, key0))){validate359.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.machineId !== undefined){let data0: any = data.machineId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(func1(data0) > 256){validate359.errors = [{instancePath:instancePath+"/machineId",schemaPath:"sidekicks-contracts:machine/id#/$defs/MachineId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data0) < 1){validate359.errors = [{instancePath:instancePath+"/machineId",schemaPath:"sidekicks-contracts:machine/id#/$defs/MachineId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate359.errors = [{instancePath:instancePath+"/machineId",schemaPath:"sidekicks-contracts:machine/id#/$defs/MachineId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.recoveryId !== undefined){let data1: any = data.recoveryId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate359.errors = [{instancePath:instancePath+"/recoveryId",schemaPath:"#/$defs/RecoveryId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate359.errors = [{instancePath:instancePath+"/recoveryId",schemaPath:"#/$defs/RecoveryId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.phase !== undefined){let data2: any = data.phase;const _errs10: any = errors;if(typeof data2 !== "string"){validate359.errors = [{instancePath:instancePath+"/phase",schemaPath:"#/$defs/RecoveryPhase/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data2 === "projectionRebuild") || (data2 === "bindingRestore")) || (data2 === "runResumption"))){validate359.errors = [{instancePath:instancePath+"/phase",schemaPath:"#/$defs/RecoveryPhase/enum",keyword:"enum",params:{allowedValues: schema678.enum}}];return false;}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.attemptNumber !== undefined){let data3: any = data.attemptNumber;const _errs13: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validate359.errors = [{instancePath:instancePath+"/attemptNumber",schemaPath:"#/properties/attemptNumber/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs13){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 9007199254740991 || isNaN(data3)){validate359.errors = [{instancePath:instancePath+"/attemptNumber",schemaPath:"#/properties/attemptNumber/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data3 < 1 || isNaN(data3)){validate359.errors = [{instancePath:instancePath+"/attemptNumber",schemaPath:"#/properties/attemptNumber/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs13 === errors;}else {var valid0: any = true;}if(valid0){if(data.eventsApplied !== undefined){let data4: any = data.eventsApplied;const _errs15: any = errors;if(!(((typeof data4 == "number") && (!(data4 % 1) && !isNaN(data4))) && (isFinite(data4)))){validate359.errors = [{instancePath:instancePath+"/eventsApplied",schemaPath:"#/properties/eventsApplied/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs15){if((typeof data4 == "number") && (isFinite(data4))){if(data4 > 9007199254740991 || isNaN(data4)){validate359.errors = [{instancePath:instancePath+"/eventsApplied",schemaPath:"#/properties/eventsApplied/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data4 < 0 || isNaN(data4)){validate359.errors = [{instancePath:instancePath+"/eventsApplied",schemaPath:"#/properties/eventsApplied/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs15 === errors;}else {var valid0: any = true;}if(valid0){if(data.bindingsRestored !== undefined){let data5: any = data.bindingsRestored;const _errs17: any = errors;if(!(((typeof data5 == "number") && (!(data5 % 1) && !isNaN(data5))) && (isFinite(data5)))){validate359.errors = [{instancePath:instancePath+"/bindingsRestored",schemaPath:"#/properties/bindingsRestored/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs17){if((typeof data5 == "number") && (isFinite(data5))){if(data5 > 9007199254740991 || isNaN(data5)){validate359.errors = [{instancePath:instancePath+"/bindingsRestored",schemaPath:"#/properties/bindingsRestored/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data5 < 0 || isNaN(data5)){validate359.errors = [{instancePath:instancePath+"/bindingsRestored",schemaPath:"#/properties/bindingsRestored/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs17 === errors;}else {var valid0: any = true;}if(valid0){if(data.runsResumed !== undefined){let data6: any = data.runsResumed;const _errs19: any = errors;if(!(((typeof data6 == "number") && (!(data6 % 1) && !isNaN(data6))) && (isFinite(data6)))){validate359.errors = [{instancePath:instancePath+"/runsResumed",schemaPath:"#/properties/runsResumed/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs19){if((typeof data6 == "number") && (isFinite(data6))){if(data6 > 9007199254740991 || isNaN(data6)){validate359.errors = [{instancePath:instancePath+"/runsResumed",schemaPath:"#/properties/runsResumed/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data6 < 0 || isNaN(data6)){validate359.errors = [{instancePath:instancePath+"/runsResumed",schemaPath:"#/properties/runsResumed/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs19 === errors;}else {var valid0: any = true;}if(valid0){if(data.runsFailedDeterministically !== undefined){let data7: any = data.runsFailedDeterministically;const _errs21: any = errors;if(!(((typeof data7 == "number") && (!(data7 % 1) && !isNaN(data7))) && (isFinite(data7)))){validate359.errors = [{instancePath:instancePath+"/runsFailedDeterministically",schemaPath:"#/properties/runsFailedDeterministically/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs21){if((typeof data7 == "number") && (isFinite(data7))){if(data7 > 9007199254740991 || isNaN(data7)){validate359.errors = [{instancePath:instancePath+"/runsFailedDeterministically",schemaPath:"#/properties/runsFailedDeterministically/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data7 < 0 || isNaN(data7)){validate359.errors = [{instancePath:instancePath+"/runsFailedDeterministically",schemaPath:"#/properties/runsFailedDeterministically/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs21 === errors;}else {var valid0: any = true;}if(valid0){if(data.runsHaltedForReconciliation !== undefined){let data8: any = data.runsHaltedForReconciliation;const _errs23: any = errors;if(!(((typeof data8 == "number") && (!(data8 % 1) && !isNaN(data8))) && (isFinite(data8)))){validate359.errors = [{instancePath:instancePath+"/runsHaltedForReconciliation",schemaPath:"#/properties/runsHaltedForReconciliation/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs23){if((typeof data8 == "number") && (isFinite(data8))){if(data8 > 9007199254740991 || isNaN(data8)){validate359.errors = [{instancePath:instancePath+"/runsHaltedForReconciliation",schemaPath:"#/properties/runsHaltedForReconciliation/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data8 < 0 || isNaN(data8)){validate359.errors = [{instancePath:instancePath+"/runsHaltedForReconciliation",schemaPath:"#/properties/runsHaltedForReconciliation/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs23 === errors;}else {var valid0: any = true;}if(valid0){if(data.runsInterrupted !== undefined){let data9: any = data.runsInterrupted;const _errs25: any = errors;if(!(((typeof data9 == "number") && (!(data9 % 1) && !isNaN(data9))) && (isFinite(data9)))){validate359.errors = [{instancePath:instancePath+"/runsInterrupted",schemaPath:"#/properties/runsInterrupted/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs25){if((typeof data9 == "number") && (isFinite(data9))){if(data9 > 9007199254740991 || isNaN(data9)){validate359.errors = [{instancePath:instancePath+"/runsInterrupted",schemaPath:"#/properties/runsInterrupted/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data9 < 0 || isNaN(data9)){validate359.errors = [{instancePath:instancePath+"/runsInterrupted",schemaPath:"#/properties/runsInterrupted/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs25 === errors;}else {var valid0: any = true;}if(valid0){if(data.runsStopped !== undefined){let data10: any = data.runsStopped;const _errs27: any = errors;if(!(((typeof data10 == "number") && (!(data10 % 1) && !isNaN(data10))) && (isFinite(data10)))){validate359.errors = [{instancePath:instancePath+"/runsStopped",schemaPath:"#/properties/runsStopped/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs27){if((typeof data10 == "number") && (isFinite(data10))){if(data10 > 9007199254740991 || isNaN(data10)){validate359.errors = [{instancePath:instancePath+"/runsStopped",schemaPath:"#/properties/runsStopped/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data10 < 0 || isNaN(data10)){validate359.errors = [{instancePath:instancePath+"/runsStopped",schemaPath:"#/properties/runsStopped/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs27 === errors;}else {var valid0: any = true;}if(valid0){if(data.durationMs !== undefined){let data11: any = data.durationMs;const _errs29: any = errors;if(!(((typeof data11 == "number") && (!(data11 % 1) && !isNaN(data11))) && (isFinite(data11)))){validate359.errors = [{instancePath:instancePath+"/durationMs",schemaPath:"#/properties/durationMs/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs29){if((typeof data11 == "number") && (isFinite(data11))){if(data11 > 9007199254740991 || isNaN(data11)){validate359.errors = [{instancePath:instancePath+"/durationMs",schemaPath:"#/properties/durationMs/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data11 < 0 || isNaN(data11)){validate359.errors = [{instancePath:instancePath+"/durationMs",schemaPath:"#/properties/durationMs/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs29 === errors;}else {var valid0: any = true;}if(valid0){if(data.completedAt !== undefined){let data12: any = data.completedAt;const _errs31: any = errors;const _errs32: any = errors;if(errors === _errs32){if(typeof data12 === "string"){if(!pattern5.test(data12)){validate359.errors = [{instancePath:instancePath+"/completedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}}];return false;}}else {validate359.errors = [{instancePath:instancePath+"/completedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs31 === errors;}else {var valid0: any = true;}}}}}}}}}}}}}}}}else {validate359.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate359.errors = vErrors;return errors === 0;}
// prettier-ignore
validate359.errors = null as any[] | null;
// prettier-ignore
validate359.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate360(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DaemonRepairingDetails {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate360.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){const _errs1: any = errors;for(const key0 in data){if(!(key0 === "progress")){validate360.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.progress !== undefined){let data0: any = data.progress;const _errs3: any = errors;if(errors === _errs3){if(data0 && typeof data0 == "object" && !Array.isArray(data0)){let missing0: any;if(((data0.done === undefined) && (missing0 = "done")) || ((data0.total === undefined) && (missing0 = "total"))){validate360.errors = [{instancePath:instancePath+"/progress",schemaPath:"#/$defs/DaemonRepairProgress/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs5: any = errors;for(const key1 in data0){if(!((key1 === "done") || (key1 === "total"))){validate360.errors = [{instancePath:instancePath+"/progress",schemaPath:"#/$defs/DaemonRepairProgress/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs5 === errors){if(data0.done !== undefined){let data1: any = data0.done;const _errs6: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validate360.errors = [{instancePath:instancePath+"/progress/done",schemaPath:"#/$defs/DaemonRepairProgress/properties/done/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs6){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validate360.errors = [{instancePath:instancePath+"/progress/done",schemaPath:"#/$defs/DaemonRepairProgress/properties/done/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 0 || isNaN(data1)){validate360.errors = [{instancePath:instancePath+"/progress/done",schemaPath:"#/$defs/DaemonRepairProgress/properties/done/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid2: any = _errs6 === errors;}else {var valid2: any = true;}if(valid2){if(data0.total !== undefined){let data2: any = data0.total;const _errs8: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validate360.errors = [{instancePath:instancePath+"/progress/total",schemaPath:"#/$defs/DaemonRepairProgress/properties/total/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs8){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validate360.errors = [{instancePath:instancePath+"/progress/total",schemaPath:"#/$defs/DaemonRepairProgress/properties/total/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 0 || isNaN(data2)){validate360.errors = [{instancePath:instancePath+"/progress/total",schemaPath:"#/$defs/DaemonRepairProgress/properties/total/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}}}}}else {validate360.errors = [{instancePath:instancePath+"/progress",schemaPath:"#/$defs/DaemonRepairProgress/type",keyword:"type",params:{type: "object"}}];return false;}}}}}else {validate360.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate360.errors = vErrors;return errors === 0;}
// prettier-ignore
validate360.errors = null as any[] | null;
// prettier-ignore
validate360.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link DaemonRecoveryAttemptedPayload}. */
export const validateDaemonRecoveryAttemptedPayload: SchemaCheck<DaemonRecoveryAttemptedPayload> =
  validate350;
/** Checks that a value is a {@link DaemonRecoveryFailedPayload}. */
export const validateDaemonRecoveryFailedPayload: SchemaCheck<DaemonRecoveryFailedPayload> =
  validate351;
/** Checks that a value is a {@link DaemonRecoveryStatus}. */
export const validateDaemonRecoveryStatus: SchemaCheck<DaemonRecoveryStatus> = validate352;
/** Checks that a value is a {@link DaemonRecoverySucceededPayload}. */
export const validateDaemonRecoverySucceededPayload: SchemaCheck<DaemonRecoverySucceededPayload> =
  validate359;
/** Checks that a value is a {@link DaemonRepairingDetails}. */
export const validateDaemonRepairingDetails: SchemaCheck<DaemonRepairingDetails> = validate360;
