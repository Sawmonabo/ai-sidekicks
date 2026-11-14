// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The service's recovery after a restart: its state, the refusals a write meets, the repair of the database file and the recovery pass's events.

import { type CompiledSchemaCheck, ucs2length } from "../../schema-check.js";
import { type WireInstant, validateWireInstant } from "../internal/wire-scalars.js";
import { type MachineId, validateMachineId } from "../machine/id.js";
import { type RecoveryCondition, validateRecoveryCondition } from "../provider/driver/recovery.js";
import { type RunFailureCategory, validateRunFailureCategory } from "../run/control.js";
import { type RunId, validateRunId } from "../run/id.js";
import { type SessionId, validateSessionId } from "../session/id.js";

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
const schema270: any = {"description":"Where the service stands in recovery: `rebuilding` while the restart's pass runs, `degraded`\nwhile one or more sessions have damaged history, and `blocked` when the local store itself is\nunavailable. Ordered from least to most severe.","type":"string","enum":["healthy","rebuilding","degraded","blocked"]};
/** Checks that a value is a {@link DaemonRecoveryState}. */
// prettier-ignore
export const validateDaemonRecoveryState: CompiledSchemaCheck<DaemonRecoveryState> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DaemonRecoveryState {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateDaemonRecoveryState.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateDaemonRecoveryState.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((((data === "healthy") || (data === "rebuilding")) || (data === "degraded")) || (data === "blocked"))){validateDaemonRecoveryState.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema270.enum}}];return false;}validateDaemonRecoveryState.errors = vErrors;return errors === 0;};
// prettier-ignore
validateDaemonRecoveryState.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema272: any = {"description":"Where one session that is not healthy stands: `rebuilding` while the restart's pass has yet to\nrebuild it, which a write refusal names and the status read leaves to the service's own state,\n`degraded` when its history is damaged after a readable start, so it opens read-only at its\nlast good point, `damaged` when no event of it can be read, and `blocked` when a run of it\nhalted after the restart on a question for the person, named in its `haltedRuns`.","type":"string","enum":["rebuilding","degraded","damaged","blocked"]};
/** Checks that a value is a {@link DaemonRecoverySessionState}. */
// prettier-ignore
export const validateDaemonRecoverySessionState: CompiledSchemaCheck<DaemonRecoverySessionState> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DaemonRecoverySessionState {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateDaemonRecoverySessionState.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateDaemonRecoverySessionState.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((((data === "rebuilding") || (data === "degraded")) || (data === "damaged")) || (data === "blocked"))){validateDaemonRecoverySessionState.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema272.enum}}];return false;}validateDaemonRecoverySessionState.errors = vErrors;return errors === 0;};
// prettier-ignore
validateDaemonRecoverySessionState.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern3 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
/** Checks that a value is a {@link DaemonRecoveryHaltedRun}. */
// prettier-ignore
export const validateDaemonRecoveryHaltedRun: CompiledSchemaCheck<DaemonRecoveryHaltedRun> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DaemonRecoveryHaltedRun {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateDaemonRecoveryHaltedRun.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.runId === undefined) && (missing0 = "runId")) || ((data.recoveryCondition === undefined) && (missing0 = "recoveryCondition"))){validateDaemonRecoveryHaltedRun.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "runId") || (key0 === "recoveryCondition")) || (key0 === "failureCategory"))){validateDaemonRecoveryHaltedRun.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.runId !== undefined){const _errs2: any = errors;if(!(validateRunId.call(this, data.runId, {instancePath:instancePath+"/runId",parentData:data,parentDataProperty:"runId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRunId.errors : vErrors.concat(validateRunId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.recoveryCondition !== undefined){const _errs3: any = errors;if(!(validateRecoveryCondition.call(this, data.recoveryCondition, {instancePath:instancePath+"/recoveryCondition",parentData:data,parentDataProperty:"recoveryCondition",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRecoveryCondition.errors : vErrors.concat(validateRecoveryCondition.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.failureCategory !== undefined){const _errs4: any = errors;if(!(validateRunFailureCategory.call(this, data.failureCategory, {instancePath:instancePath+"/failureCategory",parentData:data,parentDataProperty:"failureCategory",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRunFailureCategory.errors : vErrors.concat(validateRunFailureCategory.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}}else {validateDaemonRecoveryHaltedRun.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateDaemonRecoveryHaltedRun.errors = vErrors;return errors === 0;};
// prettier-ignore
validateDaemonRecoveryHaltedRun.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link DaemonRecoverySession}. */
// prettier-ignore
export const validateDaemonRecoverySession: CompiledSchemaCheck<DaemonRecoverySession> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DaemonRecoverySession {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateDaemonRecoverySession.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.state === undefined) && (missing0 = "state"))){validateDaemonRecoverySession.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((((((key0 === "sessionId") || (key0 === "state")) || (key0 === "lastAppliedSequence")) || (key0 === "lastAppliedAt")) || (key0 === "damagedFromSequence")) || (key0 === "failureCategory")) || (key0 === "recoveryCondition")) || (key0 === "haltedRuns"))){validateDaemonRecoverySession.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.state !== undefined){const _errs3: any = errors;if(!(validateDaemonRecoverySessionState.call(this, data.state, {instancePath:instancePath+"/state",parentData:data,parentDataProperty:"state",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateDaemonRecoverySessionState.errors : vErrors.concat(validateDaemonRecoverySessionState.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.lastAppliedSequence !== undefined){let data2: any = data.lastAppliedSequence;const _errs4: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validateDaemonRecoverySession.errors = [{instancePath:instancePath+"/lastAppliedSequence",schemaPath:"#/properties/lastAppliedSequence/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs4){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validateDaemonRecoverySession.errors = [{instancePath:instancePath+"/lastAppliedSequence",schemaPath:"#/properties/lastAppliedSequence/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 0 || isNaN(data2)){validateDaemonRecoverySession.errors = [{instancePath:instancePath+"/lastAppliedSequence",schemaPath:"#/properties/lastAppliedSequence/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.lastAppliedAt !== undefined){const _errs6: any = errors;if(!(validateWireInstant.call(this, data.lastAppliedAt, {instancePath:instancePath+"/lastAppliedAt",parentData:data,parentDataProperty:"lastAppliedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.damagedFromSequence !== undefined){let data4: any = data.damagedFromSequence;const _errs7: any = errors;if(!(((typeof data4 == "number") && (!(data4 % 1) && !isNaN(data4))) && (isFinite(data4)))){validateDaemonRecoverySession.errors = [{instancePath:instancePath+"/damagedFromSequence",schemaPath:"#/properties/damagedFromSequence/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs7){if((typeof data4 == "number") && (isFinite(data4))){if(data4 > 9007199254740991 || isNaN(data4)){validateDaemonRecoverySession.errors = [{instancePath:instancePath+"/damagedFromSequence",schemaPath:"#/properties/damagedFromSequence/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data4 < 0 || isNaN(data4)){validateDaemonRecoverySession.errors = [{instancePath:instancePath+"/damagedFromSequence",schemaPath:"#/properties/damagedFromSequence/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}if(valid0){if(data.failureCategory !== undefined){const _errs9: any = errors;if(!(validateRunFailureCategory.call(this, data.failureCategory, {instancePath:instancePath+"/failureCategory",parentData:data,parentDataProperty:"failureCategory",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRunFailureCategory.errors : vErrors.concat(validateRunFailureCategory.errors);errors = vErrors.length;}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}if(valid0){if(data.recoveryCondition !== undefined){const _errs10: any = errors;if(!(validateRecoveryCondition.call(this, data.recoveryCondition, {instancePath:instancePath+"/recoveryCondition",parentData:data,parentDataProperty:"recoveryCondition",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRecoveryCondition.errors : vErrors.concat(validateRecoveryCondition.errors);errors = vErrors.length;}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.haltedRuns !== undefined){let data7: any = data.haltedRuns;const _errs11: any = errors;if(errors === _errs11){if(Array.isArray(data7)){var valid1: any = true;const len0: any = data7.length;for(let i0=0; i0<len0; i0++){const _errs13: any = errors;if(!(validateDaemonRecoveryHaltedRun.call(this, data7[i0], {instancePath:instancePath+"/haltedRuns/" + i0,parentData:data7,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateDaemonRecoveryHaltedRun.errors : vErrors.concat(validateDaemonRecoveryHaltedRun.errors);errors = vErrors.length;}var valid1: any = _errs13 === errors;if(!valid1){break;}}}else {validateDaemonRecoverySession.errors = [{instancePath:instancePath+"/haltedRuns",schemaPath:"#/properties/haltedRuns/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs11 === errors;}else {var valid0: any = true;}}}}}}}}}}}else {validateDaemonRecoverySession.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateDaemonRecoverySession.errors = vErrors;return errors === 0;};
// prettier-ignore
validateDaemonRecoverySession.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link DaemonRecoveryStatus}. */
// prettier-ignore
export const validateDaemonRecoveryStatus: CompiledSchemaCheck<DaemonRecoveryStatus> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DaemonRecoveryStatus {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateDaemonRecoveryStatus.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.overall === undefined) && (missing0 = "overall")) || ((data.sessions === undefined) && (missing0 = "sessions"))){validateDaemonRecoveryStatus.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "overall") || (key0 === "sessions"))){validateDaemonRecoveryStatus.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.overall !== undefined){const _errs2: any = errors;if(!(validateDaemonRecoveryState.call(this, data.overall, {instancePath:instancePath+"/overall",parentData:data,parentDataProperty:"overall",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateDaemonRecoveryState.errors : vErrors.concat(validateDaemonRecoveryState.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.sessions !== undefined){let data1: any = data.sessions;const _errs3: any = errors;if(errors === _errs3){if(Array.isArray(data1)){var valid1: any = true;const len0: any = data1.length;for(let i0=0; i0<len0; i0++){const _errs5: any = errors;if(!(validateDaemonRecoverySession.call(this, data1[i0], {instancePath:instancePath+"/sessions/" + i0,parentData:data1,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateDaemonRecoverySession.errors : vErrors.concat(validateDaemonRecoverySession.errors);errors = vErrors.length;}var valid1: any = _errs5 === errors;if(!valid1){break;}}}else {validateDaemonRecoveryStatus.errors = [{instancePath:instancePath+"/sessions",schemaPath:"#/properties/sessions/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateDaemonRecoveryStatus.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateDaemonRecoveryStatus.errors = vErrors;return errors === 0;};
// prettier-ignore
validateDaemonRecoveryStatus.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link DaemonRepairProgress}. */
// prettier-ignore
export const validateDaemonRepairProgress: CompiledSchemaCheck<DaemonRepairProgress> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DaemonRepairProgress {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateDaemonRepairProgress.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.done === undefined) && (missing0 = "done")) || ((data.total === undefined) && (missing0 = "total"))){validateDaemonRepairProgress.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "done") || (key0 === "total"))){validateDaemonRepairProgress.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.done !== undefined){let data0: any = data.done;const _errs2: any = errors;if(!(((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0))) && (isFinite(data0)))){validateDaemonRepairProgress.errors = [{instancePath:instancePath+"/done",schemaPath:"#/properties/done/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs2){if((typeof data0 == "number") && (isFinite(data0))){if(data0 > 9007199254740991 || isNaN(data0)){validateDaemonRepairProgress.errors = [{instancePath:instancePath+"/done",schemaPath:"#/properties/done/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data0 < 0 || isNaN(data0)){validateDaemonRepairProgress.errors = [{instancePath:instancePath+"/done",schemaPath:"#/properties/done/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.total !== undefined){let data1: any = data.total;const _errs4: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validateDaemonRepairProgress.errors = [{instancePath:instancePath+"/total",schemaPath:"#/properties/total/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs4){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validateDaemonRepairProgress.errors = [{instancePath:instancePath+"/total",schemaPath:"#/properties/total/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 0 || isNaN(data1)){validateDaemonRepairProgress.errors = [{instancePath:instancePath+"/total",schemaPath:"#/properties/total/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validateDaemonRepairProgress.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateDaemonRepairProgress.errors = vErrors;return errors === 0;};
// prettier-ignore
validateDaemonRepairProgress.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link DaemonRepairingDetails}. */
// prettier-ignore
export const validateDaemonRepairingDetails: CompiledSchemaCheck<DaemonRepairingDetails> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DaemonRepairingDetails {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateDaemonRepairingDetails.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){const _errs1: any = errors;for(const key0 in data){if(!(key0 === "progress")){validateDaemonRepairingDetails.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.progress !== undefined){if(!(validateDaemonRepairProgress.call(this, data.progress, {instancePath:instancePath+"/progress",parentData:data,parentDataProperty:"progress",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateDaemonRepairProgress.errors : vErrors.concat(validateDaemonRepairProgress.errors);errors = vErrors.length;}}}}else {validateDaemonRepairingDetails.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateDaemonRepairingDetails.errors = vErrors;return errors === 0;};
// prettier-ignore
validateDaemonRepairingDetails.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema265: any = {"description":"The step of the recovery pass an event's outcome was decided in.","type":"string","enum":["projectionRebuild","bindingRestore","runResumption"]};
/** Checks that a value is a {@link RecoveryPhase}. */
// prettier-ignore
export const validateRecoveryPhase: CompiledSchemaCheck<RecoveryPhase> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is RecoveryPhase {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateRecoveryPhase.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateRecoveryPhase.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data === "projectionRebuild") || (data === "bindingRestore")) || (data === "runResumption"))){validateRecoveryPhase.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema265.enum}}];return false;}validateRecoveryPhase.errors = vErrors;return errors === 0;};
// prettier-ignore
validateRecoveryPhase.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema266: any = {"description":"What started a recovery pass.","type":"string","enum":["startup","manual","supervisor"]};
/** Checks that a value is a {@link RecoveryTrigger}. */
// prettier-ignore
export const validateRecoveryTrigger: CompiledSchemaCheck<RecoveryTrigger> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is RecoveryTrigger {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateRecoveryTrigger.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateRecoveryTrigger.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data === "startup") || (data === "manual")) || (data === "supervisor"))){validateRecoveryTrigger.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema266.enum}}];return false;}validateRecoveryTrigger.errors = vErrors;return errors === 0;};
// prettier-ignore
validateRecoveryTrigger.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link RecoveryId}. */
// prettier-ignore
export const validateRecoveryId: CompiledSchemaCheck<RecoveryId> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is RecoveryId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateRecoveryId.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern3.test(data)){validateRecoveryId.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validateRecoveryId.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateRecoveryId.errors = vErrors;return errors === 0;};
// prettier-ignore
validateRecoveryId.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema268: any = {"description":"What kind of failure a failed recovery pass met.","type":"string","enum":["projectionRebuildFailed","bindingRestoreFailed","persistenceUnavailable","other"]};
/** Checks that a value is a {@link RecoveryFailureKind}. */
// prettier-ignore
export const validateRecoveryFailureKind: CompiledSchemaCheck<RecoveryFailureKind> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is RecoveryFailureKind {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateRecoveryFailureKind.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateRecoveryFailureKind.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((((data === "projectionRebuildFailed") || (data === "bindingRestoreFailed")) || (data === "persistenceUnavailable")) || (data === "other"))){validateRecoveryFailureKind.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema268.enum}}];return false;}validateRecoveryFailureKind.errors = vErrors;return errors === 0;};
// prettier-ignore
validateRecoveryFailureKind.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const func1 = ucs2length;
/** Checks that a value is a {@link DaemonRecoveryAttemptedPayload}. */
// prettier-ignore
export const validateDaemonRecoveryAttemptedPayload: CompiledSchemaCheck<DaemonRecoveryAttemptedPayload> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DaemonRecoveryAttemptedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateDaemonRecoveryAttemptedPayload.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((((data.machineId === undefined) && (missing0 = "machineId")) || ((data.recoveryId === undefined) && (missing0 = "recoveryId"))) || ((data.phase === undefined) && (missing0 = "phase"))) || ((data.attemptNumber === undefined) && (missing0 = "attemptNumber"))) || ((data.recoveryTrigger === undefined) && (missing0 = "recoveryTrigger"))) || ((data.priorFailureCount === undefined) && (missing0 = "priorFailureCount"))) || ((data.startedAt === undefined) && (missing0 = "startedAt"))){validateDaemonRecoveryAttemptedPayload.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((((key0 === "machineId") || (key0 === "recoveryId")) || (key0 === "phase")) || (key0 === "attemptNumber")) || (key0 === "recoveryTrigger")) || (key0 === "priorFailureCount")) || (key0 === "startedAt"))){validateDaemonRecoveryAttemptedPayload.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.machineId !== undefined){const _errs2: any = errors;if(!(validateMachineId.call(this, data.machineId, {instancePath:instancePath+"/machineId",parentData:data,parentDataProperty:"machineId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateMachineId.errors : vErrors.concat(validateMachineId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.recoveryId !== undefined){const _errs3: any = errors;if(!(validateRecoveryId.call(this, data.recoveryId, {instancePath:instancePath+"/recoveryId",parentData:data,parentDataProperty:"recoveryId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRecoveryId.errors : vErrors.concat(validateRecoveryId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.phase !== undefined){const _errs4: any = errors;if(!(validateRecoveryPhase.call(this, data.phase, {instancePath:instancePath+"/phase",parentData:data,parentDataProperty:"phase",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRecoveryPhase.errors : vErrors.concat(validateRecoveryPhase.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.attemptNumber !== undefined){let data3: any = data.attemptNumber;const _errs5: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validateDaemonRecoveryAttemptedPayload.errors = [{instancePath:instancePath+"/attemptNumber",schemaPath:"#/properties/attemptNumber/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs5){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 9007199254740991 || isNaN(data3)){validateDaemonRecoveryAttemptedPayload.errors = [{instancePath:instancePath+"/attemptNumber",schemaPath:"#/properties/attemptNumber/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data3 < 1 || isNaN(data3)){validateDaemonRecoveryAttemptedPayload.errors = [{instancePath:instancePath+"/attemptNumber",schemaPath:"#/properties/attemptNumber/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.recoveryTrigger !== undefined){const _errs7: any = errors;if(!(validateRecoveryTrigger.call(this, data.recoveryTrigger, {instancePath:instancePath+"/recoveryTrigger",parentData:data,parentDataProperty:"recoveryTrigger",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRecoveryTrigger.errors : vErrors.concat(validateRecoveryTrigger.errors);errors = vErrors.length;}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}if(valid0){if(data.priorFailureCount !== undefined){let data5: any = data.priorFailureCount;const _errs8: any = errors;if(!(((typeof data5 == "number") && (!(data5 % 1) && !isNaN(data5))) && (isFinite(data5)))){validateDaemonRecoveryAttemptedPayload.errors = [{instancePath:instancePath+"/priorFailureCount",schemaPath:"#/properties/priorFailureCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs8){if((typeof data5 == "number") && (isFinite(data5))){if(data5 > 9007199254740991 || isNaN(data5)){validateDaemonRecoveryAttemptedPayload.errors = [{instancePath:instancePath+"/priorFailureCount",schemaPath:"#/properties/priorFailureCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data5 < 0 || isNaN(data5)){validateDaemonRecoveryAttemptedPayload.errors = [{instancePath:instancePath+"/priorFailureCount",schemaPath:"#/properties/priorFailureCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.startedAt !== undefined){const _errs10: any = errors;if(!(validateWireInstant.call(this, data.startedAt, {instancePath:instancePath+"/startedAt",parentData:data,parentDataProperty:"startedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}}}}}}}}}}else {validateDaemonRecoveryAttemptedPayload.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateDaemonRecoveryAttemptedPayload.errors = vErrors;return errors === 0;};
// prettier-ignore
validateDaemonRecoveryAttemptedPayload.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema276: any = {"type":"object","additionalProperties":false,"properties":{"machineId":{"$ref":"sidekicks-contracts:machine/id#/$defs/MachineId","description":"This machine."},"recoveryId":{"$ref":"#/$defs/RecoveryId","description":"The pass."},"phase":{"$ref":"#/$defs/RecoveryPhase","description":"The step it was in."},"attemptNumber":{"type":"integer","minimum":1,"maximum":9007199254740991,"description":"Which attempt it is."},"eventsApplied":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"The events applied."},"bindingsRestored":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"The provider bindings restored."},"runsResumed":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"The runs resumed."},"runsFailedDeterministically":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"The runs that failed deterministically."},"runsHaltedForReconciliation":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"The runs halted for the person to reconcile."},"runsInterrupted":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"The runs ended `interrupted`: under the person's pending interrupt, a paused child, or at a\nstep or spend limit their log still owed."},"runsStopped":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"The runs ended `stopped` at a token limit their log still owed."},"durationMs":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"How long it took, on a monotonic clock, in milliseconds."},"completedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When it completed."}},"required":["machineId","recoveryId","phase","attemptNumber","eventsApplied","bindingsRestored","runsResumed","runsFailedDeterministically","runsHaltedForReconciliation","runsInterrupted","runsStopped","durationMs","completedAt"],"description":"`daemon.recovery.succeeded`: a recovery pass completed; every count is of this pass alone, and\nevery run it settled is in exactly one of the run counts."};
// prettier-ignore
const func2 = Object.prototype.hasOwnProperty;
/** Checks that a value is a {@link DaemonRecoverySucceededPayload}. */
// prettier-ignore
export const validateDaemonRecoverySucceededPayload: CompiledSchemaCheck<DaemonRecoverySucceededPayload> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DaemonRecoverySucceededPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateDaemonRecoverySucceededPayload.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((((((((((data.machineId === undefined) && (missing0 = "machineId")) || ((data.recoveryId === undefined) && (missing0 = "recoveryId"))) || ((data.phase === undefined) && (missing0 = "phase"))) || ((data.attemptNumber === undefined) && (missing0 = "attemptNumber"))) || ((data.eventsApplied === undefined) && (missing0 = "eventsApplied"))) || ((data.bindingsRestored === undefined) && (missing0 = "bindingsRestored"))) || ((data.runsResumed === undefined) && (missing0 = "runsResumed"))) || ((data.runsFailedDeterministically === undefined) && (missing0 = "runsFailedDeterministically"))) || ((data.runsHaltedForReconciliation === undefined) && (missing0 = "runsHaltedForReconciliation"))) || ((data.runsInterrupted === undefined) && (missing0 = "runsInterrupted"))) || ((data.runsStopped === undefined) && (missing0 = "runsStopped"))) || ((data.durationMs === undefined) && (missing0 = "durationMs"))) || ((data.completedAt === undefined) && (missing0 = "completedAt"))){validateDaemonRecoverySucceededPayload.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(func2.call(schema276.properties, key0))){validateDaemonRecoverySucceededPayload.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.machineId !== undefined){const _errs2: any = errors;if(!(validateMachineId.call(this, data.machineId, {instancePath:instancePath+"/machineId",parentData:data,parentDataProperty:"machineId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateMachineId.errors : vErrors.concat(validateMachineId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.recoveryId !== undefined){const _errs3: any = errors;if(!(validateRecoveryId.call(this, data.recoveryId, {instancePath:instancePath+"/recoveryId",parentData:data,parentDataProperty:"recoveryId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRecoveryId.errors : vErrors.concat(validateRecoveryId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.phase !== undefined){const _errs4: any = errors;if(!(validateRecoveryPhase.call(this, data.phase, {instancePath:instancePath+"/phase",parentData:data,parentDataProperty:"phase",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRecoveryPhase.errors : vErrors.concat(validateRecoveryPhase.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.attemptNumber !== undefined){let data3: any = data.attemptNumber;const _errs5: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validateDaemonRecoverySucceededPayload.errors = [{instancePath:instancePath+"/attemptNumber",schemaPath:"#/properties/attemptNumber/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs5){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 9007199254740991 || isNaN(data3)){validateDaemonRecoverySucceededPayload.errors = [{instancePath:instancePath+"/attemptNumber",schemaPath:"#/properties/attemptNumber/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data3 < 1 || isNaN(data3)){validateDaemonRecoverySucceededPayload.errors = [{instancePath:instancePath+"/attemptNumber",schemaPath:"#/properties/attemptNumber/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.eventsApplied !== undefined){let data4: any = data.eventsApplied;const _errs7: any = errors;if(!(((typeof data4 == "number") && (!(data4 % 1) && !isNaN(data4))) && (isFinite(data4)))){validateDaemonRecoverySucceededPayload.errors = [{instancePath:instancePath+"/eventsApplied",schemaPath:"#/properties/eventsApplied/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs7){if((typeof data4 == "number") && (isFinite(data4))){if(data4 > 9007199254740991 || isNaN(data4)){validateDaemonRecoverySucceededPayload.errors = [{instancePath:instancePath+"/eventsApplied",schemaPath:"#/properties/eventsApplied/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data4 < 0 || isNaN(data4)){validateDaemonRecoverySucceededPayload.errors = [{instancePath:instancePath+"/eventsApplied",schemaPath:"#/properties/eventsApplied/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}if(valid0){if(data.bindingsRestored !== undefined){let data5: any = data.bindingsRestored;const _errs9: any = errors;if(!(((typeof data5 == "number") && (!(data5 % 1) && !isNaN(data5))) && (isFinite(data5)))){validateDaemonRecoverySucceededPayload.errors = [{instancePath:instancePath+"/bindingsRestored",schemaPath:"#/properties/bindingsRestored/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs9){if((typeof data5 == "number") && (isFinite(data5))){if(data5 > 9007199254740991 || isNaN(data5)){validateDaemonRecoverySucceededPayload.errors = [{instancePath:instancePath+"/bindingsRestored",schemaPath:"#/properties/bindingsRestored/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data5 < 0 || isNaN(data5)){validateDaemonRecoverySucceededPayload.errors = [{instancePath:instancePath+"/bindingsRestored",schemaPath:"#/properties/bindingsRestored/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}if(valid0){if(data.runsResumed !== undefined){let data6: any = data.runsResumed;const _errs11: any = errors;if(!(((typeof data6 == "number") && (!(data6 % 1) && !isNaN(data6))) && (isFinite(data6)))){validateDaemonRecoverySucceededPayload.errors = [{instancePath:instancePath+"/runsResumed",schemaPath:"#/properties/runsResumed/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs11){if((typeof data6 == "number") && (isFinite(data6))){if(data6 > 9007199254740991 || isNaN(data6)){validateDaemonRecoverySucceededPayload.errors = [{instancePath:instancePath+"/runsResumed",schemaPath:"#/properties/runsResumed/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data6 < 0 || isNaN(data6)){validateDaemonRecoverySucceededPayload.errors = [{instancePath:instancePath+"/runsResumed",schemaPath:"#/properties/runsResumed/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs11 === errors;}else {var valid0: any = true;}if(valid0){if(data.runsFailedDeterministically !== undefined){let data7: any = data.runsFailedDeterministically;const _errs13: any = errors;if(!(((typeof data7 == "number") && (!(data7 % 1) && !isNaN(data7))) && (isFinite(data7)))){validateDaemonRecoverySucceededPayload.errors = [{instancePath:instancePath+"/runsFailedDeterministically",schemaPath:"#/properties/runsFailedDeterministically/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs13){if((typeof data7 == "number") && (isFinite(data7))){if(data7 > 9007199254740991 || isNaN(data7)){validateDaemonRecoverySucceededPayload.errors = [{instancePath:instancePath+"/runsFailedDeterministically",schemaPath:"#/properties/runsFailedDeterministically/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data7 < 0 || isNaN(data7)){validateDaemonRecoverySucceededPayload.errors = [{instancePath:instancePath+"/runsFailedDeterministically",schemaPath:"#/properties/runsFailedDeterministically/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs13 === errors;}else {var valid0: any = true;}if(valid0){if(data.runsHaltedForReconciliation !== undefined){let data8: any = data.runsHaltedForReconciliation;const _errs15: any = errors;if(!(((typeof data8 == "number") && (!(data8 % 1) && !isNaN(data8))) && (isFinite(data8)))){validateDaemonRecoverySucceededPayload.errors = [{instancePath:instancePath+"/runsHaltedForReconciliation",schemaPath:"#/properties/runsHaltedForReconciliation/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs15){if((typeof data8 == "number") && (isFinite(data8))){if(data8 > 9007199254740991 || isNaN(data8)){validateDaemonRecoverySucceededPayload.errors = [{instancePath:instancePath+"/runsHaltedForReconciliation",schemaPath:"#/properties/runsHaltedForReconciliation/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data8 < 0 || isNaN(data8)){validateDaemonRecoverySucceededPayload.errors = [{instancePath:instancePath+"/runsHaltedForReconciliation",schemaPath:"#/properties/runsHaltedForReconciliation/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs15 === errors;}else {var valid0: any = true;}if(valid0){if(data.runsInterrupted !== undefined){let data9: any = data.runsInterrupted;const _errs17: any = errors;if(!(((typeof data9 == "number") && (!(data9 % 1) && !isNaN(data9))) && (isFinite(data9)))){validateDaemonRecoverySucceededPayload.errors = [{instancePath:instancePath+"/runsInterrupted",schemaPath:"#/properties/runsInterrupted/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs17){if((typeof data9 == "number") && (isFinite(data9))){if(data9 > 9007199254740991 || isNaN(data9)){validateDaemonRecoverySucceededPayload.errors = [{instancePath:instancePath+"/runsInterrupted",schemaPath:"#/properties/runsInterrupted/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data9 < 0 || isNaN(data9)){validateDaemonRecoverySucceededPayload.errors = [{instancePath:instancePath+"/runsInterrupted",schemaPath:"#/properties/runsInterrupted/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs17 === errors;}else {var valid0: any = true;}if(valid0){if(data.runsStopped !== undefined){let data10: any = data.runsStopped;const _errs19: any = errors;if(!(((typeof data10 == "number") && (!(data10 % 1) && !isNaN(data10))) && (isFinite(data10)))){validateDaemonRecoverySucceededPayload.errors = [{instancePath:instancePath+"/runsStopped",schemaPath:"#/properties/runsStopped/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs19){if((typeof data10 == "number") && (isFinite(data10))){if(data10 > 9007199254740991 || isNaN(data10)){validateDaemonRecoverySucceededPayload.errors = [{instancePath:instancePath+"/runsStopped",schemaPath:"#/properties/runsStopped/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data10 < 0 || isNaN(data10)){validateDaemonRecoverySucceededPayload.errors = [{instancePath:instancePath+"/runsStopped",schemaPath:"#/properties/runsStopped/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs19 === errors;}else {var valid0: any = true;}if(valid0){if(data.durationMs !== undefined){let data11: any = data.durationMs;const _errs21: any = errors;if(!(((typeof data11 == "number") && (!(data11 % 1) && !isNaN(data11))) && (isFinite(data11)))){validateDaemonRecoverySucceededPayload.errors = [{instancePath:instancePath+"/durationMs",schemaPath:"#/properties/durationMs/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs21){if((typeof data11 == "number") && (isFinite(data11))){if(data11 > 9007199254740991 || isNaN(data11)){validateDaemonRecoverySucceededPayload.errors = [{instancePath:instancePath+"/durationMs",schemaPath:"#/properties/durationMs/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data11 < 0 || isNaN(data11)){validateDaemonRecoverySucceededPayload.errors = [{instancePath:instancePath+"/durationMs",schemaPath:"#/properties/durationMs/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs21 === errors;}else {var valid0: any = true;}if(valid0){if(data.completedAt !== undefined){const _errs23: any = errors;if(!(validateWireInstant.call(this, data.completedAt, {instancePath:instancePath+"/completedAt",parentData:data,parentDataProperty:"completedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid0: any = _errs23 === errors;}else {var valid0: any = true;}}}}}}}}}}}}}}}}else {validateDaemonRecoverySucceededPayload.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateDaemonRecoverySucceededPayload.errors = vErrors;return errors === 0;};
// prettier-ignore
validateDaemonRecoverySucceededPayload.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern5 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
/** Checks that a value is a {@link DaemonRecoveryFailedPayload}. */
// prettier-ignore
export const validateDaemonRecoveryFailedPayload: CompiledSchemaCheck<DaemonRecoveryFailedPayload> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is DaemonRecoveryFailedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateDaemonRecoveryFailedPayload.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((((((data.machineId === undefined) && (missing0 = "machineId")) || ((data.recoveryId === undefined) && (missing0 = "recoveryId"))) || ((data.phase === undefined) && (missing0 = "phase"))) || ((data.attemptNumber === undefined) && (missing0 = "attemptNumber"))) || ((data.failureKind === undefined) && (missing0 = "failureKind"))) || ((data.detail === undefined) && (missing0 = "detail"))) || ((data.runsLeftInFlight === undefined) && (missing0 = "runsLeftInFlight"))) || ((data.durationMs === undefined) && (missing0 = "durationMs"))){validateDaemonRecoveryFailedPayload.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((((((key0 === "machineId") || (key0 === "recoveryId")) || (key0 === "phase")) || (key0 === "attemptNumber")) || (key0 === "failureKind")) || (key0 === "detail")) || (key0 === "runsLeftInFlight")) || (key0 === "durationMs"))){validateDaemonRecoveryFailedPayload.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.machineId !== undefined){const _errs2: any = errors;if(!(validateMachineId.call(this, data.machineId, {instancePath:instancePath+"/machineId",parentData:data,parentDataProperty:"machineId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateMachineId.errors : vErrors.concat(validateMachineId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.recoveryId !== undefined){const _errs3: any = errors;if(!(validateRecoveryId.call(this, data.recoveryId, {instancePath:instancePath+"/recoveryId",parentData:data,parentDataProperty:"recoveryId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRecoveryId.errors : vErrors.concat(validateRecoveryId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.phase !== undefined){const _errs4: any = errors;if(!(validateRecoveryPhase.call(this, data.phase, {instancePath:instancePath+"/phase",parentData:data,parentDataProperty:"phase",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRecoveryPhase.errors : vErrors.concat(validateRecoveryPhase.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.attemptNumber !== undefined){let data3: any = data.attemptNumber;const _errs5: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validateDaemonRecoveryFailedPayload.errors = [{instancePath:instancePath+"/attemptNumber",schemaPath:"#/properties/attemptNumber/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs5){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 9007199254740991 || isNaN(data3)){validateDaemonRecoveryFailedPayload.errors = [{instancePath:instancePath+"/attemptNumber",schemaPath:"#/properties/attemptNumber/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data3 < 1 || isNaN(data3)){validateDaemonRecoveryFailedPayload.errors = [{instancePath:instancePath+"/attemptNumber",schemaPath:"#/properties/attemptNumber/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.failureKind !== undefined){const _errs7: any = errors;if(!(validateRecoveryFailureKind.call(this, data.failureKind, {instancePath:instancePath+"/failureKind",parentData:data,parentDataProperty:"failureKind",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRecoveryFailureKind.errors : vErrors.concat(validateRecoveryFailureKind.errors);errors = vErrors.length;}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}if(valid0){if(data.detail !== undefined){let data5: any = data.detail;const _errs8: any = errors;if(errors === _errs8){if(typeof data5 === "string"){if(func1(data5) > 32768){validateDaemonRecoveryFailedPayload.errors = [{instancePath:instancePath+"/detail",schemaPath:"#/properties/detail/maxLength",keyword:"maxLength",params:{limit: 32768}}];return false;}else {if(func1(data5) < 1){validateDaemonRecoveryFailedPayload.errors = [{instancePath:instancePath+"/detail",schemaPath:"#/properties/detail/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data5)){validateDaemonRecoveryFailedPayload.errors = [{instancePath:instancePath+"/detail",schemaPath:"#/properties/detail/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateDaemonRecoveryFailedPayload.errors = [{instancePath:instancePath+"/detail",schemaPath:"#/properties/detail/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.runsLeftInFlight !== undefined){let data6: any = data.runsLeftInFlight;const _errs10: any = errors;if(errors === _errs10){if(Array.isArray(data6)){var valid1: any = true;const len0: any = data6.length;for(let i0=0; i0<len0; i0++){const _errs12: any = errors;if(!(validateRunId.call(this, data6[i0], {instancePath:instancePath+"/runsLeftInFlight/" + i0,parentData:data6,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRunId.errors : vErrors.concat(validateRunId.errors);errors = vErrors.length;}var valid1: any = _errs12 === errors;if(!valid1){break;}}}else {validateDaemonRecoveryFailedPayload.errors = [{instancePath:instancePath+"/runsLeftInFlight",schemaPath:"#/properties/runsLeftInFlight/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.durationMs !== undefined){let data8: any = data.durationMs;const _errs13: any = errors;if(!(((typeof data8 == "number") && (!(data8 % 1) && !isNaN(data8))) && (isFinite(data8)))){validateDaemonRecoveryFailedPayload.errors = [{instancePath:instancePath+"/durationMs",schemaPath:"#/properties/durationMs/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs13){if((typeof data8 == "number") && (isFinite(data8))){if(data8 > 9007199254740991 || isNaN(data8)){validateDaemonRecoveryFailedPayload.errors = [{instancePath:instancePath+"/durationMs",schemaPath:"#/properties/durationMs/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data8 < 0 || isNaN(data8)){validateDaemonRecoveryFailedPayload.errors = [{instancePath:instancePath+"/durationMs",schemaPath:"#/properties/durationMs/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs13 === errors;}else {var valid0: any = true;}}}}}}}}}}}else {validateDaemonRecoveryFailedPayload.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateDaemonRecoveryFailedPayload.errors = vErrors;return errors === 0;};
// prettier-ignore
validateDaemonRecoveryFailedPayload.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
