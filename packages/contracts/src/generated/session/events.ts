// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The payloads of a session's own events: its creation, its lifecycle moves, its renames, its marks, its advisor, its output style and its provider's status.

import { type CompiledSchemaCheck, deepEqual, ucs2length } from "../../schema-check.js";
import { type AgentDefinitionId, validateAgentDefinitionId } from "../agent/definition.js";
import { type AgentSubscribeEntry, validateAgentSubscribeEntry } from "../agent/methods.js";
import {
  type SourceEpoch,
  type SourcePosition,
  validateSourceEpoch,
  validateSourcePosition,
} from "../event/envelope.js";
import { type WireInstant, validateWireInstant } from "../internal/wire-scalars.js";
import { type Place, validatePlace } from "../place.js";
import { type ProviderId, validateProviderId } from "../provider/id.js";
import { type RunId, validateRunId } from "../run/id.js";
import {
  type EventCursor,
  type SessionId,
  type UserId,
  validateEventCursor,
  validateSessionId,
  validateUserId,
} from "./id.js";
import {
  type SessionShape,
  type SessionState,
  validateSessionShape,
  validateSessionState,
} from "./methods.js";

/**
 * The state an unarchived session returns to: `active`, or `provisioning` for one archived before
 * its create finished, which the create's finish then takes on to `active`.
 */
export type SessionReactivatedState = "active" | "provisioning";
/**
 * Who a rename came from: the person (`user`), the provider renaming its own conversation
 * (`provider`), or the daemon's naming pass after the first exchange (`auto`), which writes only
 * while the session is unnamed, so a name the person typed always wins.
 */
export type SessionRenameOrigin = "user" | "provider" | "auto";

/**
 * The session a fork was taken from, and the message it was taken at.
 */
export interface SessionCreatedParent {
  /**
   * The session forked from.
   */
  sessionId: SessionId;
  /**
   * The message the fork was taken at.
   */
  anchorCursor: EventCursor;
}
/**
 * A session's birth, bringing in its lead as `mainAgent`. `parent` is present exactly on a fork,
 * `scratchForDefinitionId` names the saved definition a scratch session tries, and `place` is
 * where the session runs for its whole life.
 */
export interface SessionCreatedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The session's shape.
   */
  shape: SessionShape;
  /**
   * The session's lead.
   */
  mainAgent: AgentSubscribeEntry;
  /**
   * The session forked from, on a fork.
   */
  parent?: SessionCreatedParent;
  /**
   * The saved definition a scratch session tries.
   */
  scratchForDefinitionId?: AgentDefinitionId;
  /**
   * The person who created it.
   */
  actor?: UserId;
  /**
   * Where it runs, written here once and never changed; absent on macOS and Linux.
   */
  place?: Place;
}
/**
 * The payload of a lifecycle move (`session.activated`, `session.archived`, `session.closed`),
 * naming the state the session left and the one it is in. `actor` is the person who acted, absent
 * when the daemon moved it.
 */
export interface SessionLifecycleChangePayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The state it left, where it had one.
   */
  previousState?: SessionState;
  /**
   * The state it is in.
   */
  newState: SessionState;
  /**
   * The person who acted, absent when the daemon moved it.
   */
  actor?: UserId;
}
/**
 * The `session.reactivated` payload: an archived session back on the live list, naming the state
 * it left and the one it returns to. `actor` is the person who acted, absent when the daemon
 * moved it.
 */
export interface SessionReactivatedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The state it left, where it had one.
   */
  previousState?: SessionState;
  /**
   * The state it returns to.
   */
  state: SessionReactivatedState;
  /**
   * The person who acted, absent when the daemon moved it.
   */
  actor?: UserId;
}
/**
 * The `session.renamed` payload: the new name, `null` when the name was cleared, the name it
 * replaced where there was one, and who renamed it. A rename to the current name writes no event.
 */
export interface SessionRenamedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The new name, or `null` when it was cleared.
   */
  name: string | null;
  /**
   * The name it replaced, where there was one.
   */
  previousName?: string;
  /**
   * Who renamed it.
   */
  origin: SessionRenameOrigin;
  /**
   * The person who renamed it.
   */
  actor?: UserId;
}
/**
 * The payload of a session mark set or cleared (`session.pinned`, `session.unpinned`,
 * `session.muted`, `session.unmuted`) with the time it happened. Pinned rows sit in the order they
 * were pinned, and a mute stands until it is cleared: both are rebuilt from these events.
 */
export interface SessionMarkChangePayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * When it happened.
   */
  at: WireInstant;
}
/**
 * The `session.advisor.changed` payload: the session's own advisor, changed by the provider's own
 * advisor command in that session. `advisorModel` is the session's own setting, `null` when the
 * advisor is off; `attachedAdvisorModel` is the advisor the provider says it attaches after the
 * change, `null` when none attaches, absent where the build does not report it.
 */
export interface SessionAdvisorChangedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The session's own advisor setting, or `null` when the advisor is off.
   */
  advisorModel: string | null;
  /**
   * The advisor the provider attaches, `null` when none, absent where the build does not say.
   */
  attachedAdvisorModel?: string | null;
  /**
   * When it happened.
   */
  at: WireInstant;
}
/**
 * The `session.outputStyle.changed` payload: the session's own output style, changed by the
 * provider's own output-style command in that session, with the time it happened.
 */
export interface SessionOutputStyleChangedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The output style.
   */
  outputStyle: string;
  /**
   * When it happened.
   */
  at: WireInstant;
}
/**
 * The `session.providerStatus.reported` payload: a coarse status the provider reported for its
 * session, normalized, with display text where it sent some. It records what the provider said and
 * never moves the session's own state. It takes the epoch stamp: `sourceEpoch` and
 * `sourcePosition` come together, and only on a payload naming its run.
 */
export interface SessionProviderStatusReportedPayload {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The run, where the status names one.
   */
  runId?: RunId;
  /**
   * The provider.
   */
  provider: ProviderId;
  /**
   * The status, normalized.
   */
  status: string;
  /**
   * The provider's display text, where it sent some.
   */
  detail?: string;
  /**
   * The execution epoch a late row is attributed to; comes with `sourcePosition` and `runId`.
   */
  sourceEpoch?: SourceEpoch;
  /**
   * The run position the row occupies within its epoch; comes with `sourceEpoch`.
   */
  sourcePosition?: SourcePosition;
}

// prettier-ignore
const func1 = ucs2length;
/** Checks that a value is a {@link SessionCreatedParent}. */
// prettier-ignore
export const validateSessionCreatedParent: CompiledSchemaCheck<SessionCreatedParent> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionCreatedParent {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionCreatedParent.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.anchorCursor === undefined) && (missing0 = "anchorCursor"))){validateSessionCreatedParent.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "anchorCursor"))){validateSessionCreatedParent.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.anchorCursor !== undefined){const _errs3: any = errors;if(!(validateEventCursor.call(this, data.anchorCursor, {instancePath:instancePath+"/anchorCursor",parentData:data,parentDataProperty:"anchorCursor",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateEventCursor.errors : vErrors.concat(validateEventCursor.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateSessionCreatedParent.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionCreatedParent.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionCreatedParent.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern5 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
/** Checks that a value is a {@link SessionCreatedPayload}. */
// prettier-ignore
export const validateSessionCreatedPayload: CompiledSchemaCheck<SessionCreatedPayload> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionCreatedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionCreatedPayload.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.shape === undefined) && (missing0 = "shape"))) || ((data.mainAgent === undefined) && (missing0 = "mainAgent"))){validateSessionCreatedPayload.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((((key0 === "sessionId") || (key0 === "shape")) || (key0 === "mainAgent")) || (key0 === "parent")) || (key0 === "scratchForDefinitionId")) || (key0 === "actor")) || (key0 === "place"))){validateSessionCreatedPayload.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.shape !== undefined){const _errs3: any = errors;if(!(validateSessionShape.call(this, data.shape, {instancePath:instancePath+"/shape",parentData:data,parentDataProperty:"shape",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionShape.errors : vErrors.concat(validateSessionShape.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.mainAgent !== undefined){const _errs4: any = errors;if(!(validateAgentSubscribeEntry.call(this, data.mainAgent, {instancePath:instancePath+"/mainAgent",parentData:data,parentDataProperty:"mainAgent",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateAgentSubscribeEntry.errors : vErrors.concat(validateAgentSubscribeEntry.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.parent !== undefined){const _errs5: any = errors;if(!(validateSessionCreatedParent.call(this, data.parent, {instancePath:instancePath+"/parent",parentData:data,parentDataProperty:"parent",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionCreatedParent.errors : vErrors.concat(validateSessionCreatedParent.errors);errors = vErrors.length;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.scratchForDefinitionId !== undefined){const _errs6: any = errors;if(!(validateAgentDefinitionId.call(this, data.scratchForDefinitionId, {instancePath:instancePath+"/scratchForDefinitionId",parentData:data,parentDataProperty:"scratchForDefinitionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateAgentDefinitionId.errors : vErrors.concat(validateAgentDefinitionId.errors);errors = vErrors.length;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.actor !== undefined){const _errs7: any = errors;if(!(validateUserId.call(this, data.actor, {instancePath:instancePath+"/actor",parentData:data,parentDataProperty:"actor",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateUserId.errors : vErrors.concat(validateUserId.errors);errors = vErrors.length;}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}if(valid0){if(data.place !== undefined){const _errs8: any = errors;if(!(validatePlace.call(this, data.place, {instancePath:instancePath+"/place",parentData:data,parentDataProperty:"place",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePlace.errors : vErrors.concat(validatePlace.errors);errors = vErrors.length;}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}}}}}}}}}}else {validateSessionCreatedPayload.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionCreatedPayload.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionCreatedPayload.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionLifecycleChangePayload}. */
// prettier-ignore
export const validateSessionLifecycleChangePayload: CompiledSchemaCheck<SessionLifecycleChangePayload> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionLifecycleChangePayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionLifecycleChangePayload.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.newState === undefined) && (missing0 = "newState"))){validateSessionLifecycleChangePayload.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "sessionId") || (key0 === "previousState")) || (key0 === "newState")) || (key0 === "actor"))){validateSessionLifecycleChangePayload.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.previousState !== undefined){const _errs3: any = errors;if(!(validateSessionState.call(this, data.previousState, {instancePath:instancePath+"/previousState",parentData:data,parentDataProperty:"previousState",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionState.errors : vErrors.concat(validateSessionState.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.newState !== undefined){const _errs4: any = errors;if(!(validateSessionState.call(this, data.newState, {instancePath:instancePath+"/newState",parentData:data,parentDataProperty:"newState",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionState.errors : vErrors.concat(validateSessionState.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.actor !== undefined){const _errs5: any = errors;if(!(validateUserId.call(this, data.actor, {instancePath:instancePath+"/actor",parentData:data,parentDataProperty:"actor",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateUserId.errors : vErrors.concat(validateUserId.errors);errors = vErrors.length;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}}}else {validateSessionLifecycleChangePayload.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionLifecycleChangePayload.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionLifecycleChangePayload.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema474: any = {"description":"The state an unarchived session returns to: `active`, or `provisioning` for one archived before\nits create finished, which the create's finish then takes on to `active`.","type":"string","enum":["active","provisioning"]};
/** Checks that a value is a {@link SessionReactivatedState}. */
// prettier-ignore
export const validateSessionReactivatedState: CompiledSchemaCheck<SessionReactivatedState> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionReactivatedState {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionReactivatedState.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateSessionReactivatedState.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data === "active") || (data === "provisioning"))){validateSessionReactivatedState.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema474.enum}}];return false;}validateSessionReactivatedState.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionReactivatedState.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionReactivatedPayload}. */
// prettier-ignore
export const validateSessionReactivatedPayload: CompiledSchemaCheck<SessionReactivatedPayload> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionReactivatedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionReactivatedPayload.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.state === undefined) && (missing0 = "state"))){validateSessionReactivatedPayload.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "sessionId") || (key0 === "previousState")) || (key0 === "state")) || (key0 === "actor"))){validateSessionReactivatedPayload.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.previousState !== undefined){const _errs3: any = errors;if(!(validateSessionState.call(this, data.previousState, {instancePath:instancePath+"/previousState",parentData:data,parentDataProperty:"previousState",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionState.errors : vErrors.concat(validateSessionState.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.state !== undefined){const _errs4: any = errors;if(!(validateSessionReactivatedState.call(this, data.state, {instancePath:instancePath+"/state",parentData:data,parentDataProperty:"state",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionReactivatedState.errors : vErrors.concat(validateSessionReactivatedState.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.actor !== undefined){const _errs5: any = errors;if(!(validateUserId.call(this, data.actor, {instancePath:instancePath+"/actor",parentData:data,parentDataProperty:"actor",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateUserId.errors : vErrors.concat(validateUserId.errors);errors = vErrors.length;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}}}else {validateSessionReactivatedPayload.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionReactivatedPayload.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionReactivatedPayload.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema510: any = {"description":"Who a rename came from: the person (`user`), the provider renaming its own conversation\n(`provider`), or the daemon's naming pass after the first exchange (`auto`), which writes only\nwhile the session is unnamed, so a name the person typed always wins.","type":"string","enum":["user","provider","auto"]};
/** Checks that a value is a {@link SessionRenameOrigin}. */
// prettier-ignore
export const validateSessionRenameOrigin: CompiledSchemaCheck<SessionRenameOrigin> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionRenameOrigin {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionRenameOrigin.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateSessionRenameOrigin.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data === "user") || (data === "provider")) || (data === "auto"))){validateSessionRenameOrigin.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema510.enum}}];return false;}validateSessionRenameOrigin.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionRenameOrigin.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema509: any = {"type":"object","additionalProperties":false,"properties":{"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session."},"name":{"type":["string","null"],"minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"The new name, or `null` when it was cleared."},"previousName":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"The name it replaced, where there was one."},"origin":{"$ref":"#/$defs/SessionRenameOrigin","description":"Who renamed it."},"actor":{"$ref":"sidekicks-contracts:session/id#/$defs/UserId","description":"The person who renamed it."}},"required":["sessionId","name","origin"],"description":"The `session.renamed` payload: the new name, `null` when the name was cleared, the name it\nreplaced where there was one, and who renamed it. A rename to the current name writes no event."};
/** Checks that a value is a {@link SessionRenamedPayload}. */
// prettier-ignore
export const validateSessionRenamedPayload: CompiledSchemaCheck<SessionRenamedPayload> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionRenamedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionRenamedPayload.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.name === undefined) && (missing0 = "name"))) || ((data.origin === undefined) && (missing0 = "origin"))){validateSessionRenamedPayload.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((key0 === "sessionId") || (key0 === "name")) || (key0 === "previousName")) || (key0 === "origin")) || (key0 === "actor"))){validateSessionRenamedPayload.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.name !== undefined){let data1: any = data.name;const _errs3: any = errors;if((typeof data1 !== "string") && (data1 !== null)){validateSessionRenamedPayload.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: schema509.properties.name.type}}];return false;}if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) > 256){validateSessionRenamedPayload.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data1) < 1){validateSessionRenamedPayload.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data1)){validateSessionRenamedPayload.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.previousName !== undefined){let data2: any = data.previousName;const _errs5: any = errors;if(errors === _errs5){if(typeof data2 === "string"){if(func1(data2) > 256){validateSessionRenamedPayload.errors = [{instancePath:instancePath+"/previousName",schemaPath:"#/properties/previousName/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data2) < 1){validateSessionRenamedPayload.errors = [{instancePath:instancePath+"/previousName",schemaPath:"#/properties/previousName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data2)){validateSessionRenamedPayload.errors = [{instancePath:instancePath+"/previousName",schemaPath:"#/properties/previousName/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateSessionRenamedPayload.errors = [{instancePath:instancePath+"/previousName",schemaPath:"#/properties/previousName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.origin !== undefined){const _errs7: any = errors;if(!(validateSessionRenameOrigin.call(this, data.origin, {instancePath:instancePath+"/origin",parentData:data,parentDataProperty:"origin",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionRenameOrigin.errors : vErrors.concat(validateSessionRenameOrigin.errors);errors = vErrors.length;}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}if(valid0){if(data.actor !== undefined){const _errs8: any = errors;if(!(validateUserId.call(this, data.actor, {instancePath:instancePath+"/actor",parentData:data,parentDataProperty:"actor",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateUserId.errors : vErrors.concat(validateUserId.errors);errors = vErrors.length;}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}}}}}}}}else {validateSessionRenamedPayload.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionRenamedPayload.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionRenamedPayload.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionMarkChangePayload}. */
// prettier-ignore
export const validateSessionMarkChangePayload: CompiledSchemaCheck<SessionMarkChangePayload> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionMarkChangePayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionMarkChangePayload.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.at === undefined) && (missing0 = "at"))){validateSessionMarkChangePayload.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "at"))){validateSessionMarkChangePayload.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.at !== undefined){const _errs3: any = errors;if(!(validateWireInstant.call(this, data.at, {instancePath:instancePath+"/at",parentData:data,parentDataProperty:"at",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateSessionMarkChangePayload.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionMarkChangePayload.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionMarkChangePayload.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema491: any = {"type":"object","additionalProperties":false,"properties":{"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session."},"advisorModel":{"type":["string","null"],"minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"The session's own advisor setting, or `null` when the advisor is off."},"attachedAdvisorModel":{"type":["string","null"],"minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"The advisor the provider attaches, `null` when none, absent where the build does not say."},"at":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When it happened."}},"required":["sessionId","advisorModel","at"],"description":"The `session.advisor.changed` payload: the session's own advisor, changed by the provider's own\nadvisor command in that session. `advisorModel` is the session's own setting, `null` when the\nadvisor is off; `attachedAdvisorModel` is the advisor the provider says it attaches after the\nchange, `null` when none attaches, absent where the build does not report it."};
/** Checks that a value is a {@link SessionAdvisorChangedPayload}. */
// prettier-ignore
export const validateSessionAdvisorChangedPayload: CompiledSchemaCheck<SessionAdvisorChangedPayload> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionAdvisorChangedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionAdvisorChangedPayload.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.advisorModel === undefined) && (missing0 = "advisorModel"))) || ((data.at === undefined) && (missing0 = "at"))){validateSessionAdvisorChangedPayload.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "sessionId") || (key0 === "advisorModel")) || (key0 === "attachedAdvisorModel")) || (key0 === "at"))){validateSessionAdvisorChangedPayload.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.advisorModel !== undefined){let data1: any = data.advisorModel;const _errs3: any = errors;if((typeof data1 !== "string") && (data1 !== null)){validateSessionAdvisorChangedPayload.errors = [{instancePath:instancePath+"/advisorModel",schemaPath:"#/properties/advisorModel/type",keyword:"type",params:{type: schema491.properties.advisorModel.type}}];return false;}if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) > 256){validateSessionAdvisorChangedPayload.errors = [{instancePath:instancePath+"/advisorModel",schemaPath:"#/properties/advisorModel/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data1) < 1){validateSessionAdvisorChangedPayload.errors = [{instancePath:instancePath+"/advisorModel",schemaPath:"#/properties/advisorModel/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data1)){validateSessionAdvisorChangedPayload.errors = [{instancePath:instancePath+"/advisorModel",schemaPath:"#/properties/advisorModel/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.attachedAdvisorModel !== undefined){let data2: any = data.attachedAdvisorModel;const _errs5: any = errors;if((typeof data2 !== "string") && (data2 !== null)){validateSessionAdvisorChangedPayload.errors = [{instancePath:instancePath+"/attachedAdvisorModel",schemaPath:"#/properties/attachedAdvisorModel/type",keyword:"type",params:{type: schema491.properties.attachedAdvisorModel.type}}];return false;}if(errors === _errs5){if(typeof data2 === "string"){if(func1(data2) > 256){validateSessionAdvisorChangedPayload.errors = [{instancePath:instancePath+"/attachedAdvisorModel",schemaPath:"#/properties/attachedAdvisorModel/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data2) < 1){validateSessionAdvisorChangedPayload.errors = [{instancePath:instancePath+"/attachedAdvisorModel",schemaPath:"#/properties/attachedAdvisorModel/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data2)){validateSessionAdvisorChangedPayload.errors = [{instancePath:instancePath+"/attachedAdvisorModel",schemaPath:"#/properties/attachedAdvisorModel/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.at !== undefined){const _errs7: any = errors;if(!(validateWireInstant.call(this, data.at, {instancePath:instancePath+"/at",parentData:data,parentDataProperty:"at",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}}}}}}}else {validateSessionAdvisorChangedPayload.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionAdvisorChangedPayload.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionAdvisorChangedPayload.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionOutputStyleChangedPayload}. */
// prettier-ignore
export const validateSessionOutputStyleChangedPayload: CompiledSchemaCheck<SessionOutputStyleChangedPayload> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionOutputStyleChangedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionOutputStyleChangedPayload.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.outputStyle === undefined) && (missing0 = "outputStyle"))) || ((data.at === undefined) && (missing0 = "at"))){validateSessionOutputStyleChangedPayload.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "outputStyle")) || (key0 === "at"))){validateSessionOutputStyleChangedPayload.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.outputStyle !== undefined){let data1: any = data.outputStyle;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) > 256){validateSessionOutputStyleChangedPayload.errors = [{instancePath:instancePath+"/outputStyle",schemaPath:"#/properties/outputStyle/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data1) < 1){validateSessionOutputStyleChangedPayload.errors = [{instancePath:instancePath+"/outputStyle",schemaPath:"#/properties/outputStyle/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data1)){validateSessionOutputStyleChangedPayload.errors = [{instancePath:instancePath+"/outputStyle",schemaPath:"#/properties/outputStyle/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateSessionOutputStyleChangedPayload.errors = [{instancePath:instancePath+"/outputStyle",schemaPath:"#/properties/outputStyle/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.at !== undefined){const _errs5: any = errors;if(!(validateWireInstant.call(this, data.at, {instancePath:instancePath+"/at",parentData:data,parentDataProperty:"at",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}}else {validateSessionOutputStyleChangedPayload.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionOutputStyleChangedPayload.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionOutputStyleChangedPayload.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionProviderStatusReportedPayload}. */
// prettier-ignore
export const validateSessionProviderStatusReportedPayload: CompiledSchemaCheck<SessionProviderStatusReportedPayload> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionProviderStatusReportedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionProviderStatusReportedPayload.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.provider === undefined) && (missing0 = "provider"))) || ((data.status === undefined) && (missing0 = "status"))){validateSessionProviderStatusReportedPayload.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((((key0 === "sessionId") || (key0 === "runId")) || (key0 === "provider")) || (key0 === "status")) || (key0 === "detail")) || (key0 === "sourceEpoch")) || (key0 === "sourcePosition"))){validateSessionProviderStatusReportedPayload.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.runId !== undefined){const _errs3: any = errors;if(!(validateRunId.call(this, data.runId, {instancePath:instancePath+"/runId",parentData:data,parentDataProperty:"runId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRunId.errors : vErrors.concat(validateRunId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.provider !== undefined){const _errs4: any = errors;if(!(validateProviderId.call(this, data.provider, {instancePath:instancePath+"/provider",parentData:data,parentDataProperty:"provider",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderId.errors : vErrors.concat(validateProviderId.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.status !== undefined){let data3: any = data.status;const _errs5: any = errors;if(errors === _errs5){if(typeof data3 === "string"){if(func1(data3) > 128){validateSessionProviderStatusReportedPayload.errors = [{instancePath:instancePath+"/status",schemaPath:"#/properties/status/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data3) < 1){validateSessionProviderStatusReportedPayload.errors = [{instancePath:instancePath+"/status",schemaPath:"#/properties/status/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data3)){validateSessionProviderStatusReportedPayload.errors = [{instancePath:instancePath+"/status",schemaPath:"#/properties/status/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateSessionProviderStatusReportedPayload.errors = [{instancePath:instancePath+"/status",schemaPath:"#/properties/status/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.detail !== undefined){let data4: any = data.detail;const _errs7: any = errors;if(errors === _errs7){if(typeof data4 === "string"){if(func1(data4) > 32768){validateSessionProviderStatusReportedPayload.errors = [{instancePath:instancePath+"/detail",schemaPath:"#/properties/detail/maxLength",keyword:"maxLength",params:{limit: 32768}}];return false;}else {if(func1(data4) < 1){validateSessionProviderStatusReportedPayload.errors = [{instancePath:instancePath+"/detail",schemaPath:"#/properties/detail/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data4)){validateSessionProviderStatusReportedPayload.errors = [{instancePath:instancePath+"/detail",schemaPath:"#/properties/detail/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateSessionProviderStatusReportedPayload.errors = [{instancePath:instancePath+"/detail",schemaPath:"#/properties/detail/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}if(valid0){if(data.sourceEpoch !== undefined){const _errs9: any = errors;if(!(validateSourceEpoch.call(this, data.sourceEpoch, {instancePath:instancePath+"/sourceEpoch",parentData:data,parentDataProperty:"sourceEpoch",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSourceEpoch.errors : vErrors.concat(validateSourceEpoch.errors);errors = vErrors.length;}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}if(valid0){if(data.sourcePosition !== undefined){const _errs10: any = errors;if(!(validateSourcePosition.call(this, data.sourcePosition, {instancePath:instancePath+"/sourcePosition",parentData:data,parentDataProperty:"sourcePosition",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSourcePosition.errors : vErrors.concat(validateSourcePosition.errors);errors = vErrors.length;}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){let missing1: any;if(data.sourceEpoch !== undefined && (((data.sourcePosition === undefined) && (missing1 = "sourcePosition")) || ((data.runId === undefined) && (missing1 = "runId")))){validateSessionProviderStatusReportedPayload.errors = [{instancePath,schemaPath:"#/dependentRequired",keyword:"dependentRequired",params:{property: "sourceEpoch",
    missingProperty: missing1,
    depsCount: 2,
    deps: "sourcePosition, runId"}}];return false;}else {if(data.sourcePosition !== undefined && (((data.sourceEpoch === undefined) && (missing1 = "sourceEpoch")) || ((data.runId === undefined) && (missing1 = "runId")))){validateSessionProviderStatusReportedPayload.errors = [{instancePath,schemaPath:"#/dependentRequired",keyword:"dependentRequired",params:{property: "sourcePosition",
    missingProperty: missing1,
    depsCount: 2,
    deps: "sourceEpoch, runId"}}];return false;}}}}}}}}}}}}else {validateSessionProviderStatusReportedPayload.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionProviderStatusReportedPayload.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionProviderStatusReportedPayload.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
