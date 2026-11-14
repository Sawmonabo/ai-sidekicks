// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The session directory as a client reads and moves it: the live sessions list, creating, converting and forking a session, moving its working folder, and the terminal pane's overview.

import {
  type CompiledSchemaCheck,
  type SchemaCheck,
  deepEqual,
  repeatsItemKey,
  ucs2length,
  wireByteLength,
} from "../../schema-check.js";
import { type AgentProviderBinding, validateAgentProviderBinding } from "../agent/definition.js";
import { type WireInstant, validateWireInstant } from "../internal/wire-scalars.js";
import {
  type SubscribeAcknowledgmentResponse,
  type SubscriptionId,
  validateSubscribeAcknowledgmentResponse,
  validateSubscriptionId,
} from "../jsonrpc/streaming.js";
import { type EmptyPayload, validateEmptyPayload } from "../method-descriptor.js";
import { type Place, validatePlace } from "../place.js";
import { type ProjectId, validateProjectId } from "../project.js";
import {
  type ProviderOptionSetting,
  validateProviderOptionSetting,
} from "../provider/declaration.js";
import { type ProviderId, validateProviderId } from "../provider/id.js";
import { type ExecutionMode, validateExecutionMode } from "../repo/mount.js";
import { type WorktreeId, validateWorktreeId } from "../worktree/lifecycle.js";
import {
  type SessionConvertRequest,
  type SessionConvertResponse,
  validateSessionConvertRequest,
  validateSessionConvertResponse,
} from "./convert.js";
import { type SessionGroupId, validateSessionGroupId } from "./groups.js";
import { type EventCursor, type SessionId, validateEventCursor, validateSessionId } from "./id.js";
import {
  type SessionEventSubscribeRequest,
  type SessionShape,
  type SessionState,
  type SessionStreamFrame,
  validateSessionEventSubscribeRequest,
  validateSessionShape,
  validateSessionState,
  validateSessionStreamFrame,
} from "./methods.js";

/**
 * How old a `running` or `waiting` reading may be before a reader stops believing it: three
 * missed renewals, so a daemon that stopped publishing never leaves a row claiming work.
 */
export const SESSION_ACTIVITY_STALE_AFTER_MS = 45000 as const;

/**
 * What a session is doing, as the daemon derives it: exactly one of five, and no client invents a
 * sixth. `waiting` is waiting on the person; `failed` is a session that died, kept apart from one
 * that finished (`done`).
 */
export type SessionActivity = "running" | "waiting" | "done" | "failed" | "idle";
/**
 * One row of the sessions list, everything the row draws from one feed so the list opens no
 * stream per session, split on `shape`.
 */
export type SessionListEntry =
  | {
      shape: "project";
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * Its name; absent while untitled, when the row shows `firstMessagePreview`.
       */
      name?: string;
      /**
       * The first message's opening; absent before the first message.
       */
      firstMessagePreview?: string;
      /**
       * Its lifecycle state; archived and closed sessions sit in the `Archived` group.
       */
      state: SessionState;
      /**
       * The row's state word.
       */
      activity: SessionActivity;
      /**
       * When the daemon last published `activity`.
       */
      activityRenewedAt: WireInstant;
      /**
       * Present exactly while the session is pinned; pinned rows sit in pin order.
       */
      pinnedAt?: WireInstant;
      /**
       * Whether the person muted the session's notifications.
       */
      muted: boolean;
      /**
       * Present while the session trades messages with another.
       */
      exchange?: SessionExchange;
      /**
       * The age the row shows.
       */
      lastActivityAt: WireInstant;
      /**
       * The project.
       */
      projectId: ProjectId;
      /**
       * The branch the daemon holds for the session, so the row costs no git read.
       */
      branch?: string;
      /**
       * The group it sits in.
       */
      group?: SessionListGroup;
    }
  | {
      shape: "chat";
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * Its name; absent while untitled, when the row shows `firstMessagePreview`.
       */
      name?: string;
      /**
       * The first message's opening; absent before the first message.
       */
      firstMessagePreview?: string;
      /**
       * Its lifecycle state; archived and closed sessions sit in the `Archived` group.
       */
      state: SessionState;
      /**
       * The row's state word.
       */
      activity: SessionActivity;
      /**
       * When the daemon last published `activity`.
       */
      activityRenewedAt: WireInstant;
      /**
       * Present exactly while the session is pinned; pinned rows sit in pin order.
       */
      pinnedAt?: WireInstant;
      /**
       * Whether the person muted the session's notifications.
       */
      muted: boolean;
      /**
       * Present while the session trades messages with another.
       */
      exchange?: SessionExchange;
      /**
       * The age the row shows.
       */
      lastActivityAt: WireInstant;
      /**
       * The files in the chat's folder; absent while the folder is being made.
       */
      documentCount?: number;
    };
/**
 * One change to the list after the acknowledgment, each carrying `chatCount` as it stands after
 * the change.
 */
export type SessionListChange =
  | {
      kind: "page";
      /**
       * The sessions, at least one.
       *
       * @minItems 1
       */
      sessions: [SessionListEntry, ...SessionListEntry[]];
      /**
       * The chats in the live list.
       */
      chatCount: number;
      /**
       * Whether the list is now whole.
       */
      isComplete: boolean;
    }
  | {
      kind: "upsert";
      /**
       * The entry.
       */
      entry: SessionListEntry;
      /**
       * The chats in the live list.
       */
      chatCount: number;
    }
  | {
      kind: "remove";
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * The chats in the live list.
       */
      chatCount: number;
    };
/**
 * Where a new session works, split on `kind`.
 */
export type SessionBinding = SessionChatBinding | SessionProjectBinding;
/**
 * What `session.create` takes: where the session works and who leads it. Only a project session
 * is filed in a group.
 */
export type SessionCreateRequest =
  | {
      /**
       * The key that makes a repeated create one session.
       */
      clientIdempotencyKey: string;
      /**
       * The project's mount.
       */
      binding: SessionProjectBinding;
      /**
       * The lead, as the app chose it; a session is born with its lead.
       */
      lead: SessionLead;
      /**
       * The group of its project to file the session in.
       */
      groupId?: SessionGroupId;
    }
  | {
      /**
       * The key that makes a repeated create one session.
       */
      clientIdempotencyKey: string;
      /**
       * The managed workspace.
       */
      binding: SessionChatBinding;
      /**
       * The lead, as the app chose it; a session is born with its lead.
       */
      lead: SessionLead;
      /**
       * Never present: a chat sits in no group.
       */
      groupId?: never;
    };
/**
 * The fork. A project fork lands on a new worktree cut from the parent's current one; a chat fork
 * gets its own managed workspace and has no worktree.
 */
export type SessionForkResponse =
  | {
      shape: "project";
      /**
       * The fork.
       */
      sessionId: SessionId;
      /**
       * Its worktree.
       */
      worktreeId: WorktreeId;
    }
  | {
      shape: "chat";
      /**
       * The fork.
       */
      sessionId: SessionId;
    };
/**
 * When a working-folder move takes effect.
 */
export type SessionWorkingFolderDisposition = "applied" | "pending" | "dropped";
/**
 * Whether Remote Control is on.
 */
export type RemoteControlState = "on" | "off";

/**
 * The line a session's row shows in place of its branch or document count while it trades
 * messages with another session: the other session and how many messages the two have traded
 * since the person last wrote in either.
 */
export interface SessionExchange {
  /**
   * The other session.
   */
  peerSessionId: SessionId;
  /**
   * Its name.
   */
  peerName: string;
  /**
   * The messages traded.
   */
  messageCount: number;
}
/**
 * The group of its project a session sits in, named as the list draws it.
 */
export interface SessionListGroup {
  /**
   * The group.
   */
  groupId: SessionGroupId;
  /**
   * Its name.
   */
  name: string;
}
/**
 * `session.subscribe`'s acknowledgment: the subscription, the first page of every session as it
 * stands, and `chatCount`, the chats in the live list as the daemon counts them, so no reader
 * counts. While `isComplete` is false the rest of the list follows as `page` changes, before any
 * other change.
 */
export interface SessionSubscribeResponse {
  /**
   * The subscription.
   */
  subscriptionId: SubscriptionId;
  /**
   * The first page of sessions.
   */
  sessions: SessionListEntry[];
  /**
   * The chats in the live list.
   */
  chatCount: number;
  /**
   * Whether the list is whole.
   */
  isComplete: boolean;
}
/**
 * A chat works in a managed workspace the daemon makes for it in the same step.
 */
export interface SessionChatBinding {
  /**
   * `chat`.
   */
  kind: "chat";
}
/**
 * A project session binds to the project's mount in the same step, working in a worktree of its
 * own (`provisionedWorktree`) or in the project's checkout (`boundRoot`).
 */
export interface SessionProjectBinding {
  /**
   * `project`.
   */
  kind: "project";
  /**
   * The project.
   */
  projectId: ProjectId;
  /**
   * Where in it the session works.
   */
  executionMode: ExecutionMode;
}
/**
 * The lead as the app chose it: its provider, model and effort, and its output speed where one
 * was picked. It names no account: the daemon resolves that.
 */
export interface SessionLead {
  /**
   * The provider.
   */
  providerName: ProviderId;
  /**
   * The model.
   */
  modelId: string;
  /**
   * The effort, or `null` for the driver's default; checked when a run resolves.
   */
  effort: string | null;
  /**
   * The output speed, where one was picked; a saved definition leaves it absent.
   */
  outputSpeed?: string;
  /**
   * The values of the session options the driver declares, where any was set; an option
   * left out keeps the provider's own value, and a saved definition leaves it absent.
   *
   * @minItems 1
   */
  options?: [ProviderOptionSetting, ...ProviderOptionSetting[]];
  /**
   * The larger window chosen, in tokens, recorded when picked and sent on every resume
   * and turn; absent is the model's default window.
   */
  largerWindow?: number;
}
/**
 * What `session.create` answers. `lead` is the binding the daemon resolved for the lead, the
 * account among it; `place` is where the session runs, its project's place, or for a chat the
 * place its provider is installed in.
 */
export interface SessionCreateResponse {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * Its shape.
   */
  shape: SessionShape;
  /**
   * Its state.
   */
  state: SessionState;
  /**
   * Where it runs, written at its creation and never changed; absent on macOS and Linux.
   */
  place?: Place;
  /**
   * The lead's resolved binding.
   */
  lead: AgentProviderBinding;
}
/**
 * Forks a session from a message: a new session of the same shape carrying every row up to and
 * including `anchorCursor`. Absent `name` leaves the fork untitled.
 */
export interface SessionForkRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The last message the fork carries.
   */
  anchorCursor: EventCursor;
  /**
   * The fork's name.
   */
  name?: string;
  /**
   * The key that makes a repeated fork one fork.
   */
  clientIdempotencyKey: string;
}
/**
 * Moves a project session's working folder to `path`: the folder of any worktree git lists for the
 * project's repository, or the repository's own checkout. Asking for the folder the session is
 * already in cancels a pending move, and a later request replaces a pending one.
 */
export interface SessionWorkingFolderUpdateRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The folder.
   */
  path: string;
}
/**
 * The `session.workingFolder.update` result.
 */
export interface SessionWorkingFolderUpdateResponse {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * When the move takes effect.
   */
  disposition: SessionWorkingFolderDisposition;
  /**
   * The folder.
   */
  path: string;
}
/**
 * The terminal pane's held read. The daemon answers once its sessions list or any session's agent
 * list moves past `afterRevision`, or after 10 s with nothing changed.
 */
export interface SessionOverviewReadRequest {
  /**
   * The revision the pane last drew.
   */
  afterRevision: number;
}
/**
 * One agent under a session in the terminal pane.
 */
export interface SessionOverviewAgent {
  /**
   * The agent's name.
   */
  name: string;
  /**
   * Its provider.
   */
  provider: ProviderId;
  /**
   * What it is doing.
   */
  state: SessionActivity;
}
/**
 * One session in the terminal pane; `title` is absent while the session is untitled.
 */
export interface SessionOverviewSession {
  /**
   * The session.
   */
  id: SessionId;
  /**
   * Its title.
   */
  title?: string;
  /**
   * Its lead's provider.
   */
  provider: ProviderId;
  /**
   * What it is doing.
   */
  state: SessionActivity;
  /**
   * Its agents.
   */
  agents: SessionOverviewAgent[];
}
/**
 * What the terminal pane draws: every session with its agents and Remote Control's state, read
 * from the projections behind `session.subscribe` and `agent.subscribe`. The next read sends
 * `revision` back as `afterRevision`.
 */
export interface SessionOverviewReadResponse {
  /**
   * The revision drawn.
   */
  revision: number;
  /**
   * The sessions.
   */
  sessions: SessionOverviewSession[];
  /**
   * Remote Control.
   */
  remoteControl: {
    /**
     * Its state.
     */
    state: RemoteControlState;
  };
}

// prettier-ignore
const schema1185: any = {"description":"What a session is doing, as the daemon derives it: exactly one of five, and no client invents a\nsixth. `waiting` is waiting on the person; `failed` is a session that died, kept apart from one\nthat finished (`done`).","type":"string","enum":["running","waiting","done","failed","idle"]};
/** Checks that a value is a {@link SessionActivity}. */
// prettier-ignore
export const validateSessionActivity: CompiledSchemaCheck<SessionActivity> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionActivity {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionActivity.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateSessionActivity.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((((data === "running") || (data === "waiting")) || (data === "done")) || (data === "failed")) || (data === "idle"))){validateSessionActivity.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema1185.enum}}];return false;}validateSessionActivity.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionActivity.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
const pattern5 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
/** Checks that a value is a {@link SessionExchange}. */
// prettier-ignore
export const validateSessionExchange: CompiledSchemaCheck<SessionExchange> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionExchange {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionExchange.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.peerSessionId === undefined) && (missing0 = "peerSessionId")) || ((data.peerName === undefined) && (missing0 = "peerName"))) || ((data.messageCount === undefined) && (missing0 = "messageCount"))){validateSessionExchange.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "peerSessionId") || (key0 === "peerName")) || (key0 === "messageCount"))){validateSessionExchange.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.peerSessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.peerSessionId, {instancePath:instancePath+"/peerSessionId",parentData:data,parentDataProperty:"peerSessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.peerName !== undefined){let data1: any = data.peerName;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) > 256){validateSessionExchange.errors = [{instancePath:instancePath+"/peerName",schemaPath:"#/properties/peerName/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data1) < 1){validateSessionExchange.errors = [{instancePath:instancePath+"/peerName",schemaPath:"#/properties/peerName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data1)){validateSessionExchange.errors = [{instancePath:instancePath+"/peerName",schemaPath:"#/properties/peerName/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateSessionExchange.errors = [{instancePath:instancePath+"/peerName",schemaPath:"#/properties/peerName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.messageCount !== undefined){let data2: any = data.messageCount;const _errs5: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validateSessionExchange.errors = [{instancePath:instancePath+"/messageCount",schemaPath:"#/properties/messageCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs5){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validateSessionExchange.errors = [{instancePath:instancePath+"/messageCount",schemaPath:"#/properties/messageCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 1 || isNaN(data2)){validateSessionExchange.errors = [{instancePath:instancePath+"/messageCount",schemaPath:"#/properties/messageCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}}else {validateSessionExchange.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionExchange.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionExchange.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionListGroup}. */
// prettier-ignore
export const validateSessionListGroup: CompiledSchemaCheck<SessionListGroup> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionListGroup {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionListGroup.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.groupId === undefined) && (missing0 = "groupId")) || ((data.name === undefined) && (missing0 = "name"))){validateSessionListGroup.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "groupId") || (key0 === "name"))){validateSessionListGroup.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.groupId !== undefined){const _errs2: any = errors;if(!(validateSessionGroupId.call(this, data.groupId, {instancePath:instancePath+"/groupId",parentData:data,parentDataProperty:"groupId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionGroupId.errors : vErrors.concat(validateSessionGroupId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.name !== undefined){let data1: any = data.name;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) > 256){validateSessionListGroup.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data1) < 1){validateSessionListGroup.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data1)){validateSessionListGroup.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateSessionListGroup.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateSessionListGroup.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionListGroup.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionListGroup.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1184: any = {"oneOf":[{"type":"object","additionalProperties":false,"properties":{"shape":{"type":"string","const":"project"},"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session."},"name":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"Its name; absent while untitled, when the row shows `firstMessagePreview`."},"firstMessagePreview":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"The first message's opening; absent before the first message."},"state":{"$ref":"sidekicks-contracts:session/methods#/$defs/SessionState","description":"Its lifecycle state; archived and closed sessions sit in the `Archived` group."},"activity":{"$ref":"#/$defs/SessionActivity","description":"The row's state word."},"activityRenewedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When the daemon last published `activity`."},"pinnedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"Present exactly while the session is pinned; pinned rows sit in pin order."},"muted":{"type":"boolean","description":"Whether the person muted the session's notifications."},"exchange":{"$ref":"#/$defs/SessionExchange","description":"Present while the session trades messages with another."},"lastActivityAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"The age the row shows."},"projectId":{"$ref":"sidekicks-contracts:project#/$defs/ProjectId","description":"The project."},"branch":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","description":"The branch the daemon holds for the session, so the row costs no git read."},"group":{"$ref":"#/$defs/SessionListGroup","description":"The group it sits in."}},"required":["shape","sessionId","state","activity","activityRenewedAt","muted","lastActivityAt","projectId"],"description":"A project session."},{"type":"object","additionalProperties":false,"properties":{"shape":{"type":"string","const":"chat"},"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session."},"name":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"Its name; absent while untitled, when the row shows `firstMessagePreview`."},"firstMessagePreview":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"The first message's opening; absent before the first message."},"state":{"$ref":"sidekicks-contracts:session/methods#/$defs/SessionState","description":"Its lifecycle state; archived and closed sessions sit in the `Archived` group."},"activity":{"$ref":"#/$defs/SessionActivity","description":"The row's state word."},"activityRenewedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When the daemon last published `activity`."},"pinnedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"Present exactly while the session is pinned; pinned rows sit in pin order."},"muted":{"type":"boolean","description":"Whether the person muted the session's notifications."},"exchange":{"$ref":"#/$defs/SessionExchange","description":"Present while the session trades messages with another."},"lastActivityAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"The age the row shows."},"documentCount":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"The files in the chat's folder; absent while the folder is being made."}},"required":["shape","sessionId","state","activity","activityRenewedAt","muted","lastActivityAt"],"description":"A chat."}],"description":"One row of the sessions list, everything the row draws from one feed so the list opens no\nstream per session, split on `shape`.","discriminator":{"propertyName":"shape"},"type":"object","unevaluatedProperties":false};
// prettier-ignore
const func2 = Object.prototype.hasOwnProperty;
/** Checks that a value is a {@link SessionListEntry}. */
// prettier-ignore
export const validateSessionListEntry: CompiledSchemaCheck<SessionListEntry> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionListEntry {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionListEntry.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.shape;if(typeof tag0 == "string"){if(tag0 === "project"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((((((data.shape === undefined) && (missing0 = "shape")) || ((data.sessionId === undefined) && (missing0 = "sessionId"))) || ((data.state === undefined) && (missing0 = "state"))) || ((data.activity === undefined) && (missing0 = "activity"))) || ((data.activityRenewedAt === undefined) && (missing0 = "activityRenewedAt"))) || ((data.muted === undefined) && (missing0 = "muted"))) || ((data.lastActivityAt === undefined) && (missing0 = "lastActivityAt"))) || ((data.projectId === undefined) && (missing0 = "projectId"))){validateSessionListEntry.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!(func2.call(schema1184.oneOf[0].properties, key0))){validateSessionListEntry.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.shape !== undefined){let data0: any = data.shape;const _errs5: any = errors;if(typeof data0 !== "string"){validateSessionListEntry.errors = [{instancePath:instancePath+"/shape",schemaPath:"#/oneOf/0/properties/shape/type",keyword:"type",params:{type: "string"}}];return false;}if("project" !== data0){validateSessionListEntry.errors = [{instancePath:instancePath+"/shape",schemaPath:"#/oneOf/0/properties/shape/const",keyword:"const",params:{allowedValue: "project"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.sessionId !== undefined){const _errs7: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}if(valid2){if(data.name !== undefined){let data2: any = data.name;const _errs8: any = errors;if(errors === _errs8){if(typeof data2 === "string"){if(func1(data2) > 256){validateSessionListEntry.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/0/properties/name/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data2) < 1){validateSessionListEntry.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/0/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data2)){validateSessionListEntry.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/0/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateSessionListEntry.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/0/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}if(valid2){if(data.firstMessagePreview !== undefined){let data3: any = data.firstMessagePreview;const _errs10: any = errors;if(errors === _errs10){if(typeof data3 === "string"){if(func1(data3) > 256){validateSessionListEntry.errors = [{instancePath:instancePath+"/firstMessagePreview",schemaPath:"#/oneOf/0/properties/firstMessagePreview/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data3) < 1){validateSessionListEntry.errors = [{instancePath:instancePath+"/firstMessagePreview",schemaPath:"#/oneOf/0/properties/firstMessagePreview/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data3)){validateSessionListEntry.errors = [{instancePath:instancePath+"/firstMessagePreview",schemaPath:"#/oneOf/0/properties/firstMessagePreview/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateSessionListEntry.errors = [{instancePath:instancePath+"/firstMessagePreview",schemaPath:"#/oneOf/0/properties/firstMessagePreview/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs10 === errors;}else {var valid2: any = true;}if(valid2){if(data.state !== undefined){const _errs12: any = errors;if(!(validateSessionState.call(this, data.state, {instancePath:instancePath+"/state",parentData:data,parentDataProperty:"state",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionState.errors : vErrors.concat(validateSessionState.errors);errors = vErrors.length;}var valid2: any = _errs12 === errors;}else {var valid2: any = true;}if(valid2){if(data.activity !== undefined){const _errs13: any = errors;if(!(validateSessionActivity.call(this, data.activity, {instancePath:instancePath+"/activity",parentData:data,parentDataProperty:"activity",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionActivity.errors : vErrors.concat(validateSessionActivity.errors);errors = vErrors.length;}var valid2: any = _errs13 === errors;}else {var valid2: any = true;}if(valid2){if(data.activityRenewedAt !== undefined){const _errs14: any = errors;if(!(validateWireInstant.call(this, data.activityRenewedAt, {instancePath:instancePath+"/activityRenewedAt",parentData:data,parentDataProperty:"activityRenewedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid2: any = _errs14 === errors;}else {var valid2: any = true;}if(valid2){if(data.pinnedAt !== undefined){const _errs15: any = errors;if(!(validateWireInstant.call(this, data.pinnedAt, {instancePath:instancePath+"/pinnedAt",parentData:data,parentDataProperty:"pinnedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid2: any = _errs15 === errors;}else {var valid2: any = true;}if(valid2){if(data.muted !== undefined){const _errs16: any = errors;if(typeof data.muted !== "boolean"){validateSessionListEntry.errors = [{instancePath:instancePath+"/muted",schemaPath:"#/oneOf/0/properties/muted/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid2: any = _errs16 === errors;}else {var valid2: any = true;}if(valid2){if(data.exchange !== undefined){const _errs18: any = errors;if(!(validateSessionExchange.call(this, data.exchange, {instancePath:instancePath+"/exchange",parentData:data,parentDataProperty:"exchange",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionExchange.errors : vErrors.concat(validateSessionExchange.errors);errors = vErrors.length;}var valid2: any = _errs18 === errors;}else {var valid2: any = true;}if(valid2){if(data.lastActivityAt !== undefined){const _errs19: any = errors;if(!(validateWireInstant.call(this, data.lastActivityAt, {instancePath:instancePath+"/lastActivityAt",parentData:data,parentDataProperty:"lastActivityAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid2: any = _errs19 === errors;}else {var valid2: any = true;}if(valid2){if(data.projectId !== undefined){const _errs20: any = errors;if(!(validateProjectId.call(this, data.projectId, {instancePath:instancePath+"/projectId",parentData:data,parentDataProperty:"projectId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProjectId.errors : vErrors.concat(validateProjectId.errors);errors = vErrors.length;}var valid2: any = _errs20 === errors;}else {var valid2: any = true;}if(valid2){if(data.branch !== undefined){let data12: any = data.branch;const _errs21: any = errors;if(errors === _errs21){if(typeof data12 === "string"){if(func1(data12) < 1){validateSessionListEntry.errors = [{instancePath:instancePath+"/branch",schemaPath:"#/oneOf/0/properties/branch/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data12)){validateSessionListEntry.errors = [{instancePath:instancePath+"/branch",schemaPath:"#/oneOf/0/properties/branch/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validateSessionListEntry.errors = [{instancePath:instancePath+"/branch",schemaPath:"#/oneOf/0/properties/branch/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs21 === errors;}else {var valid2: any = true;}if(valid2){if(data.group !== undefined){const _errs23: any = errors;if(!(validateSessionListGroup.call(this, data.group, {instancePath:instancePath+"/group",parentData:data,parentDataProperty:"group",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionListGroup.errors : vErrors.concat(validateSessionListGroup.errors);errors = vErrors.length;}var valid2: any = _errs23 === errors;}else {var valid2: any = true;}}}}}}}}}}}}}}}}}else {validateSessionListEntry.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "chat"){const _errs24: any = errors;if(errors === _errs24){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((((((data.shape === undefined) && (missing1 = "shape")) || ((data.sessionId === undefined) && (missing1 = "sessionId"))) || ((data.state === undefined) && (missing1 = "state"))) || ((data.activity === undefined) && (missing1 = "activity"))) || ((data.activityRenewedAt === undefined) && (missing1 = "activityRenewedAt"))) || ((data.muted === undefined) && (missing1 = "muted"))) || ((data.lastActivityAt === undefined) && (missing1 = "lastActivityAt"))){validateSessionListEntry.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs26: any = errors;for(const key1 in data){if(!(func2.call(schema1184.oneOf[1].properties, key1))){validateSessionListEntry.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs26 === errors){if(data.shape !== undefined){let data14: any = data.shape;const _errs27: any = errors;if(typeof data14 !== "string"){validateSessionListEntry.errors = [{instancePath:instancePath+"/shape",schemaPath:"#/oneOf/1/properties/shape/type",keyword:"type",params:{type: "string"}}];return false;}if("chat" !== data14){validateSessionListEntry.errors = [{instancePath:instancePath+"/shape",schemaPath:"#/oneOf/1/properties/shape/const",keyword:"const",params:{allowedValue: "chat"}}];return false;}var valid4: any = _errs27 === errors;}else {var valid4: any = true;}if(valid4){if(data.sessionId !== undefined){const _errs29: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid4: any = _errs29 === errors;}else {var valid4: any = true;}if(valid4){if(data.name !== undefined){let data16: any = data.name;const _errs30: any = errors;if(errors === _errs30){if(typeof data16 === "string"){if(func1(data16) > 256){validateSessionListEntry.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/1/properties/name/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data16) < 1){validateSessionListEntry.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/1/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data16)){validateSessionListEntry.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/1/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateSessionListEntry.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/1/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid4: any = _errs30 === errors;}else {var valid4: any = true;}if(valid4){if(data.firstMessagePreview !== undefined){let data17: any = data.firstMessagePreview;const _errs32: any = errors;if(errors === _errs32){if(typeof data17 === "string"){if(func1(data17) > 256){validateSessionListEntry.errors = [{instancePath:instancePath+"/firstMessagePreview",schemaPath:"#/oneOf/1/properties/firstMessagePreview/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data17) < 1){validateSessionListEntry.errors = [{instancePath:instancePath+"/firstMessagePreview",schemaPath:"#/oneOf/1/properties/firstMessagePreview/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data17)){validateSessionListEntry.errors = [{instancePath:instancePath+"/firstMessagePreview",schemaPath:"#/oneOf/1/properties/firstMessagePreview/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateSessionListEntry.errors = [{instancePath:instancePath+"/firstMessagePreview",schemaPath:"#/oneOf/1/properties/firstMessagePreview/type",keyword:"type",params:{type: "string"}}];return false;}}var valid4: any = _errs32 === errors;}else {var valid4: any = true;}if(valid4){if(data.state !== undefined){const _errs34: any = errors;if(!(validateSessionState.call(this, data.state, {instancePath:instancePath+"/state",parentData:data,parentDataProperty:"state",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionState.errors : vErrors.concat(validateSessionState.errors);errors = vErrors.length;}var valid4: any = _errs34 === errors;}else {var valid4: any = true;}if(valid4){if(data.activity !== undefined){const _errs35: any = errors;if(!(validateSessionActivity.call(this, data.activity, {instancePath:instancePath+"/activity",parentData:data,parentDataProperty:"activity",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionActivity.errors : vErrors.concat(validateSessionActivity.errors);errors = vErrors.length;}var valid4: any = _errs35 === errors;}else {var valid4: any = true;}if(valid4){if(data.activityRenewedAt !== undefined){const _errs36: any = errors;if(!(validateWireInstant.call(this, data.activityRenewedAt, {instancePath:instancePath+"/activityRenewedAt",parentData:data,parentDataProperty:"activityRenewedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid4: any = _errs36 === errors;}else {var valid4: any = true;}if(valid4){if(data.pinnedAt !== undefined){const _errs37: any = errors;if(!(validateWireInstant.call(this, data.pinnedAt, {instancePath:instancePath+"/pinnedAt",parentData:data,parentDataProperty:"pinnedAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid4: any = _errs37 === errors;}else {var valid4: any = true;}if(valid4){if(data.muted !== undefined){const _errs38: any = errors;if(typeof data.muted !== "boolean"){validateSessionListEntry.errors = [{instancePath:instancePath+"/muted",schemaPath:"#/oneOf/1/properties/muted/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid4: any = _errs38 === errors;}else {var valid4: any = true;}if(valid4){if(data.exchange !== undefined){const _errs40: any = errors;if(!(validateSessionExchange.call(this, data.exchange, {instancePath:instancePath+"/exchange",parentData:data,parentDataProperty:"exchange",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionExchange.errors : vErrors.concat(validateSessionExchange.errors);errors = vErrors.length;}var valid4: any = _errs40 === errors;}else {var valid4: any = true;}if(valid4){if(data.lastActivityAt !== undefined){const _errs41: any = errors;if(!(validateWireInstant.call(this, data.lastActivityAt, {instancePath:instancePath+"/lastActivityAt",parentData:data,parentDataProperty:"lastActivityAt",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWireInstant.errors : vErrors.concat(validateWireInstant.errors);errors = vErrors.length;}var valid4: any = _errs41 === errors;}else {var valid4: any = true;}if(valid4){if(data.documentCount !== undefined){let data25: any = data.documentCount;const _errs42: any = errors;if(!(((typeof data25 == "number") && (!(data25 % 1) && !isNaN(data25))) && (isFinite(data25)))){validateSessionListEntry.errors = [{instancePath:instancePath+"/documentCount",schemaPath:"#/oneOf/1/properties/documentCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs42){if((typeof data25 == "number") && (isFinite(data25))){if(data25 > 9007199254740991 || isNaN(data25)){validateSessionListEntry.errors = [{instancePath:instancePath+"/documentCount",schemaPath:"#/oneOf/1/properties/documentCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data25 < 0 || isNaN(data25)){validateSessionListEntry.errors = [{instancePath:instancePath+"/documentCount",schemaPath:"#/oneOf/1/properties/documentCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid4: any = _errs42 === errors;}else {var valid4: any = true;}}}}}}}}}}}}}}}else {validateSessionListEntry.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid3: any = _errs24 === errors;if(props0 !== true){props0 = true;}valid0 = valid3;}else {validateSessionListEntry.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "shape", tagValue: tag0}}];return false;}}else {validateSessionListEntry.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "shape", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key2 in data){if(!props0 || !props0[key2]){validateSessionListEntry.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key2}}];return false;break;}}}}}else {validateSessionListEntry.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionListEntry.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionListEntry.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionSubscribeResponse}. */
// prettier-ignore
export const validateSessionSubscribeResponse: CompiledSchemaCheck<SessionSubscribeResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionSubscribeResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionSubscribeResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.subscriptionId === undefined) && (missing0 = "subscriptionId")) || ((data.sessions === undefined) && (missing0 = "sessions"))) || ((data.chatCount === undefined) && (missing0 = "chatCount"))) || ((data.isComplete === undefined) && (missing0 = "isComplete"))){validateSessionSubscribeResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "subscriptionId") || (key0 === "sessions")) || (key0 === "chatCount")) || (key0 === "isComplete"))){validateSessionSubscribeResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.subscriptionId !== undefined){const _errs2: any = errors;if(!(validateSubscriptionId.call(this, data.subscriptionId, {instancePath:instancePath+"/subscriptionId",parentData:data,parentDataProperty:"subscriptionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSubscriptionId.errors : vErrors.concat(validateSubscriptionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.sessions !== undefined){let data1: any = data.sessions;const _errs3: any = errors;if(wireByteLength(data1, this && this.attachments) > 991808){validateSessionSubscribeResponse.errors = [{instancePath:instancePath+"/sessions",schemaPath:"#/properties/sessions/maxJsonBytes",keyword:"maxJsonBytes",params:{}}];return false;}if(errors === _errs3){if(Array.isArray(data1)){var valid1: any = true;const len0: any = data1.length;for(let i0=0; i0<len0; i0++){const _errs5: any = errors;if(!(validateSessionListEntry.call(this, data1[i0], {instancePath:instancePath+"/sessions/" + i0,parentData:data1,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionListEntry.errors : vErrors.concat(validateSessionListEntry.errors);errors = vErrors.length;}var valid1: any = _errs5 === errors;if(!valid1){break;}}}else {validateSessionSubscribeResponse.errors = [{instancePath:instancePath+"/sessions",schemaPath:"#/properties/sessions/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.chatCount !== undefined){let data3: any = data.chatCount;const _errs6: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validateSessionSubscribeResponse.errors = [{instancePath:instancePath+"/chatCount",schemaPath:"#/properties/chatCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs6){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 9007199254740991 || isNaN(data3)){validateSessionSubscribeResponse.errors = [{instancePath:instancePath+"/chatCount",schemaPath:"#/properties/chatCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data3 < 0 || isNaN(data3)){validateSessionSubscribeResponse.errors = [{instancePath:instancePath+"/chatCount",schemaPath:"#/properties/chatCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.isComplete !== undefined){const _errs8: any = errors;if(typeof data.isComplete !== "boolean"){validateSessionSubscribeResponse.errors = [{instancePath:instancePath+"/isComplete",schemaPath:"#/properties/isComplete/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}}}}}}}else {validateSessionSubscribeResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionSubscribeResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionSubscribeResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionListChange}. */
// prettier-ignore
export const validateSessionListChange: CompiledSchemaCheck<SessionListChange> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionListChange {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionListChange.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.kind;if(typeof tag0 == "string"){if(tag0 === "page"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.kind === undefined) && (missing0 = "kind")) || ((data.sessions === undefined) && (missing0 = "sessions"))) || ((data.chatCount === undefined) && (missing0 = "chatCount"))) || ((data.isComplete === undefined) && (missing0 = "isComplete"))){validateSessionListChange.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!((((key0 === "kind") || (key0 === "sessions")) || (key0 === "chatCount")) || (key0 === "isComplete"))){validateSessionListChange.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.kind !== undefined){let data0: any = data.kind;const _errs5: any = errors;if(typeof data0 !== "string"){validateSessionListChange.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("page" !== data0){validateSessionListChange.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "page"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.sessions !== undefined){let data1: any = data.sessions;const _errs7: any = errors;if(wireByteLength(data1, this && this.attachments) > 991808){validateSessionListChange.errors = [{instancePath:instancePath+"/sessions",schemaPath:"#/oneOf/0/properties/sessions/maxJsonBytes",keyword:"maxJsonBytes",params:{}}];return false;}if(errors === _errs7){if(Array.isArray(data1)){if(data1.length < 1){validateSessionListChange.errors = [{instancePath:instancePath+"/sessions",schemaPath:"#/oneOf/0/properties/sessions/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid3: any = true;const len0: any = data1.length;for(let i0=0; i0<len0; i0++){const _errs9: any = errors;if(!(validateSessionListEntry.call(this, data1[i0], {instancePath:instancePath+"/sessions/" + i0,parentData:data1,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionListEntry.errors : vErrors.concat(validateSessionListEntry.errors);errors = vErrors.length;}var valid3: any = _errs9 === errors;if(!valid3){break;}}}}else {validateSessionListChange.errors = [{instancePath:instancePath+"/sessions",schemaPath:"#/oneOf/0/properties/sessions/type",keyword:"type",params:{type: "array"}}];return false;}}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}if(valid2){if(data.chatCount !== undefined){let data3: any = data.chatCount;const _errs10: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validateSessionListChange.errors = [{instancePath:instancePath+"/chatCount",schemaPath:"#/oneOf/0/properties/chatCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs10){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 9007199254740991 || isNaN(data3)){validateSessionListChange.errors = [{instancePath:instancePath+"/chatCount",schemaPath:"#/oneOf/0/properties/chatCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data3 < 0 || isNaN(data3)){validateSessionListChange.errors = [{instancePath:instancePath+"/chatCount",schemaPath:"#/oneOf/0/properties/chatCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid2: any = _errs10 === errors;}else {var valid2: any = true;}if(valid2){if(data.isComplete !== undefined){const _errs12: any = errors;if(typeof data.isComplete !== "boolean"){validateSessionListChange.errors = [{instancePath:instancePath+"/isComplete",schemaPath:"#/oneOf/0/properties/isComplete/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid2: any = _errs12 === errors;}else {var valid2: any = true;}}}}}}}else {validateSessionListChange.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "upsert"){const _errs14: any = errors;if(errors === _errs14){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((data.kind === undefined) && (missing1 = "kind")) || ((data.entry === undefined) && (missing1 = "entry"))) || ((data.chatCount === undefined) && (missing1 = "chatCount"))){validateSessionListChange.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs16: any = errors;for(const key1 in data){if(!(((key1 === "kind") || (key1 === "entry")) || (key1 === "chatCount"))){validateSessionListChange.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs16 === errors){if(data.kind !== undefined){let data5: any = data.kind;const _errs17: any = errors;if(typeof data5 !== "string"){validateSessionListChange.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("upsert" !== data5){validateSessionListChange.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "upsert"}}];return false;}var valid5: any = _errs17 === errors;}else {var valid5: any = true;}if(valid5){if(data.entry !== undefined){const _errs19: any = errors;if(!(validateSessionListEntry.call(this, data.entry, {instancePath:instancePath+"/entry",parentData:data,parentDataProperty:"entry",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionListEntry.errors : vErrors.concat(validateSessionListEntry.errors);errors = vErrors.length;}var valid5: any = _errs19 === errors;}else {var valid5: any = true;}if(valid5){if(data.chatCount !== undefined){let data7: any = data.chatCount;const _errs20: any = errors;if(!(((typeof data7 == "number") && (!(data7 % 1) && !isNaN(data7))) && (isFinite(data7)))){validateSessionListChange.errors = [{instancePath:instancePath+"/chatCount",schemaPath:"#/oneOf/1/properties/chatCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs20){if((typeof data7 == "number") && (isFinite(data7))){if(data7 > 9007199254740991 || isNaN(data7)){validateSessionListChange.errors = [{instancePath:instancePath+"/chatCount",schemaPath:"#/oneOf/1/properties/chatCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data7 < 0 || isNaN(data7)){validateSessionListChange.errors = [{instancePath:instancePath+"/chatCount",schemaPath:"#/oneOf/1/properties/chatCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid5: any = _errs20 === errors;}else {var valid5: any = true;}}}}}}else {validateSessionListChange.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid4: any = _errs14 === errors;if(props0 !== true){props0 = true;}valid0 = valid4;}else if(tag0 === "remove"){const _errs22: any = errors;if(errors === _errs22){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if((((data.kind === undefined) && (missing2 = "kind")) || ((data.sessionId === undefined) && (missing2 = "sessionId"))) || ((data.chatCount === undefined) && (missing2 = "chatCount"))){validateSessionListChange.errors = [{instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs24: any = errors;for(const key2 in data){if(!(((key2 === "kind") || (key2 === "sessionId")) || (key2 === "chatCount"))){validateSessionListChange.errors = [{instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs24 === errors){if(data.kind !== undefined){let data8: any = data.kind;const _errs25: any = errors;if(typeof data8 !== "string"){validateSessionListChange.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("remove" !== data8){validateSessionListChange.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/const",keyword:"const",params:{allowedValue: "remove"}}];return false;}var valid7: any = _errs25 === errors;}else {var valid7: any = true;}if(valid7){if(data.sessionId !== undefined){const _errs27: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid7: any = _errs27 === errors;}else {var valid7: any = true;}if(valid7){if(data.chatCount !== undefined){let data10: any = data.chatCount;const _errs28: any = errors;if(!(((typeof data10 == "number") && (!(data10 % 1) && !isNaN(data10))) && (isFinite(data10)))){validateSessionListChange.errors = [{instancePath:instancePath+"/chatCount",schemaPath:"#/oneOf/2/properties/chatCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs28){if((typeof data10 == "number") && (isFinite(data10))){if(data10 > 9007199254740991 || isNaN(data10)){validateSessionListChange.errors = [{instancePath:instancePath+"/chatCount",schemaPath:"#/oneOf/2/properties/chatCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data10 < 0 || isNaN(data10)){validateSessionListChange.errors = [{instancePath:instancePath+"/chatCount",schemaPath:"#/oneOf/2/properties/chatCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid7: any = _errs28 === errors;}else {var valid7: any = true;}}}}}}else {validateSessionListChange.errors = [{instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}var valid6: any = _errs22 === errors;if(props0 !== true){props0 = true;}valid0 = valid6;}else {validateSessionListChange.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "kind", tagValue: tag0}}];return false;}}else {validateSessionListChange.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "kind", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key3 in data){if(!props0 || !props0[key3]){validateSessionListChange.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key3}}];return false;break;}}}}}else {validateSessionListChange.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionListChange.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionListChange.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1175: any = {"type":"object","additionalProperties":false,"properties":{"kind":{"description":"`chat`.","type":"string","enum":["chat"]}},"required":["kind"],"description":"A chat works in a managed workspace the daemon makes for it in the same step."};
/** Checks that a value is a {@link SessionChatBinding}. */
// prettier-ignore
export const validateSessionChatBinding: CompiledSchemaCheck<SessionChatBinding> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionChatBinding {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionChatBinding.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.kind === undefined) && (missing0 = "kind")){validateSessionChatBinding.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "kind")){validateSessionChatBinding.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.kind !== undefined){let data0: any = data.kind;if(typeof data0 !== "string"){validateSessionChatBinding.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data0 === "chat")){validateSessionChatBinding.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/properties/kind/enum",keyword:"enum",params:{allowedValues: schema1175.properties.kind.enum}}];return false;}}}}}else {validateSessionChatBinding.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionChatBinding.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionChatBinding.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1176: any = {"type":"object","additionalProperties":false,"properties":{"kind":{"description":"`project`.","type":"string","enum":["project"]},"projectId":{"$ref":"sidekicks-contracts:project#/$defs/ProjectId","description":"The project."},"executionMode":{"$ref":"sidekicks-contracts:repo/mount#/$defs/ExecutionMode","description":"Where in it the session works."}},"required":["kind","projectId","executionMode"],"description":"A project session binds to the project's mount in the same step, working in a worktree of its\nown (`provisionedWorktree`) or in the project's checkout (`boundRoot`)."};
/** Checks that a value is a {@link SessionProjectBinding}. */
// prettier-ignore
export const validateSessionProjectBinding: CompiledSchemaCheck<SessionProjectBinding> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionProjectBinding {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionProjectBinding.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.kind === undefined) && (missing0 = "kind")) || ((data.projectId === undefined) && (missing0 = "projectId"))) || ((data.executionMode === undefined) && (missing0 = "executionMode"))){validateSessionProjectBinding.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "kind") || (key0 === "projectId")) || (key0 === "executionMode"))){validateSessionProjectBinding.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.kind !== undefined){let data0: any = data.kind;const _errs2: any = errors;if(typeof data0 !== "string"){validateSessionProjectBinding.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data0 === "project")){validateSessionProjectBinding.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/properties/kind/enum",keyword:"enum",params:{allowedValues: schema1176.properties.kind.enum}}];return false;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.projectId !== undefined){const _errs4: any = errors;if(!(validateProjectId.call(this, data.projectId, {instancePath:instancePath+"/projectId",parentData:data,parentDataProperty:"projectId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProjectId.errors : vErrors.concat(validateProjectId.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.executionMode !== undefined){const _errs5: any = errors;if(!(validateExecutionMode.call(this, data.executionMode, {instancePath:instancePath+"/executionMode",parentData:data,parentDataProperty:"executionMode",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateExecutionMode.errors : vErrors.concat(validateExecutionMode.errors);errors = vErrors.length;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}}else {validateSessionProjectBinding.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionProjectBinding.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionProjectBinding.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionBinding}. */
// prettier-ignore
export const validateSessionBinding: CompiledSchemaCheck<SessionBinding> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionBinding {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionBinding.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;const _errs1: any = errors;if(!(validateSessionChatBinding.call(this, data, {instancePath,parentData,parentDataProperty,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionChatBinding.errors : vErrors.concat(validateSessionChatBinding.errors);errors = vErrors.length;}var _valid0: any = _errs1 === errors;valid0 = valid0 || _valid0;if(_valid0){var props0: any = true;}const _errs2: any = errors;if(!(validateSessionProjectBinding.call(this, data, {instancePath,parentData,parentDataProperty,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionProjectBinding.errors : vErrors.concat(validateSessionProjectBinding.errors);errors = vErrors.length;}var _valid0: any = _errs2 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}if(!valid0){const err0: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;validateSessionBinding.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validateSessionBinding.errors = vErrors;evaluated0.props = props0;return errors === 0;};
// prettier-ignore
validateSessionBinding.evaluated = {"dynamicProps":true,"dynamicItems":false} as any;
// prettier-ignore
const schema1178: any = {"type":"object","additionalProperties":false,"properties":{"providerName":{"$ref":"sidekicks-contracts:provider/id#/$defs/ProviderId","description":"The provider."},"modelId":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":128,"description":"The model."},"effort":{"type":["string","null"],"minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":128,"description":"The effort, or `null` for the driver's default; checked when a run resolves."},"outputSpeed":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":128,"description":"The output speed, where one was picked; a saved definition leaves it absent."},"options":{"type":"array","items":{"$ref":"sidekicks-contracts:provider/declaration#/$defs/ProviderOptionSetting"},"minItems":1,"uniqueItems":true,"uniqueItemKey":"id","description":"The values of the session options the driver declares, where any was set; an option\nleft out keeps the provider's own value, and a saved definition leaves it absent."},"largerWindow":{"type":"integer","minimum":1,"maximum":9007199254740991,"description":"The larger window chosen, in tokens, recorded when picked and sent on every resume\nand turn; absent is the model's default window."}},"required":["providerName","modelId","effort"],"description":"The lead as the app chose it: its provider, model and effort, and its output speed where one\nwas picked. It names no account: the daemon resolves that."};
// prettier-ignore
const func0 = deepEqual;
/** Checks that a value is a {@link SessionLead}. */
// prettier-ignore
export const validateSessionLead: CompiledSchemaCheck<SessionLead> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionLead {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionLead.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.providerName === undefined) && (missing0 = "providerName")) || ((data.modelId === undefined) && (missing0 = "modelId"))) || ((data.effort === undefined) && (missing0 = "effort"))){validateSessionLead.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((((key0 === "providerName") || (key0 === "modelId")) || (key0 === "effort")) || (key0 === "outputSpeed")) || (key0 === "options")) || (key0 === "largerWindow"))){validateSessionLead.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.providerName !== undefined){const _errs2: any = errors;if(!(validateProviderId.call(this, data.providerName, {instancePath:instancePath+"/providerName",parentData:data,parentDataProperty:"providerName",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderId.errors : vErrors.concat(validateProviderId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.modelId !== undefined){let data1: any = data.modelId;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) > 128){validateSessionLead.errors = [{instancePath:instancePath+"/modelId",schemaPath:"#/properties/modelId/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data1) < 1){validateSessionLead.errors = [{instancePath:instancePath+"/modelId",schemaPath:"#/properties/modelId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data1)){validateSessionLead.errors = [{instancePath:instancePath+"/modelId",schemaPath:"#/properties/modelId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateSessionLead.errors = [{instancePath:instancePath+"/modelId",schemaPath:"#/properties/modelId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.effort !== undefined){let data2: any = data.effort;const _errs5: any = errors;if((typeof data2 !== "string") && (data2 !== null)){validateSessionLead.errors = [{instancePath:instancePath+"/effort",schemaPath:"#/properties/effort/type",keyword:"type",params:{type: schema1178.properties.effort.type}}];return false;}if(errors === _errs5){if(typeof data2 === "string"){if(func1(data2) > 128){validateSessionLead.errors = [{instancePath:instancePath+"/effort",schemaPath:"#/properties/effort/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data2) < 1){validateSessionLead.errors = [{instancePath:instancePath+"/effort",schemaPath:"#/properties/effort/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data2)){validateSessionLead.errors = [{instancePath:instancePath+"/effort",schemaPath:"#/properties/effort/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.outputSpeed !== undefined){let data3: any = data.outputSpeed;const _errs7: any = errors;if(errors === _errs7){if(typeof data3 === "string"){if(func1(data3) > 128){validateSessionLead.errors = [{instancePath:instancePath+"/outputSpeed",schemaPath:"#/properties/outputSpeed/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data3) < 1){validateSessionLead.errors = [{instancePath:instancePath+"/outputSpeed",schemaPath:"#/properties/outputSpeed/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data3)){validateSessionLead.errors = [{instancePath:instancePath+"/outputSpeed",schemaPath:"#/properties/outputSpeed/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateSessionLead.errors = [{instancePath:instancePath+"/outputSpeed",schemaPath:"#/properties/outputSpeed/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}if(valid0){if(data.options !== undefined){let data4: any = data.options;const _errs9: any = errors;if(errors === _errs9){if(Array.isArray(data4)){if(data4.length < 1){validateSessionLead.errors = [{instancePath:instancePath+"/options",schemaPath:"#/properties/options/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid1: any = true;const len0: any = data4.length;for(let i0=0; i0<len0; i0++){const _errs11: any = errors;if(!(validateProviderOptionSetting.call(this, data4[i0], {instancePath:instancePath+"/options/" + i0,parentData:data4,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderOptionSetting.errors : vErrors.concat(validateProviderOptionSetting.errors);errors = vErrors.length;}var valid1: any = _errs11 === errors;if(!valid1){break;}}if(valid1){let valid2: any;let i1: any = data4.length;let j0: any;valid2 = true;if(i1 > 1){outer0:for(;i1--;){for(j0 = i1; j0--;){if(func0(data4[i1], data4[j0])){validateSessionLead.errors = [{instancePath:instancePath+"/options",schemaPath:"#/properties/options/uniqueItems",keyword:"uniqueItems",params:{i: i1, j: j0}}];return false;valid2 = false;break outer0;}}}}if(valid2){if(repeatsItemKey(data4, "id")){validateSessionLead.errors = [{instancePath:instancePath+"/options",schemaPath:"#/properties/options/uniqueItemKey",keyword:"uniqueItemKey",params:{}}];return false;}}}}}else {validateSessionLead.errors = [{instancePath:instancePath+"/options",schemaPath:"#/properties/options/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}if(valid0){if(data.largerWindow !== undefined){let data6: any = data.largerWindow;const _errs12: any = errors;if(!(((typeof data6 == "number") && (!(data6 % 1) && !isNaN(data6))) && (isFinite(data6)))){validateSessionLead.errors = [{instancePath:instancePath+"/largerWindow",schemaPath:"#/properties/largerWindow/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs12){if((typeof data6 == "number") && (isFinite(data6))){if(data6 > 9007199254740991 || isNaN(data6)){validateSessionLead.errors = [{instancePath:instancePath+"/largerWindow",schemaPath:"#/properties/largerWindow/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data6 < 1 || isNaN(data6)){validateSessionLead.errors = [{instancePath:instancePath+"/largerWindow",schemaPath:"#/properties/largerWindow/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}}}}}}}}}else {validateSessionLead.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionLead.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionLead.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern88 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$", "u");
/** Checks that a value is a {@link SessionCreateRequest}. */
// prettier-ignore
export const validateSessionCreateRequest: CompiledSchemaCheck<SessionCreateRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionCreateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionCreateRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;const _errs1: any = errors;if(errors === _errs1){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.clientIdempotencyKey === undefined) && (missing0 = "clientIdempotencyKey")) || ((data.binding === undefined) && (missing0 = "binding"))) || ((data.lead === undefined) && (missing0 = "lead"))){const err0: any = {instancePath,schemaPath:"#/anyOf/0/required",keyword:"required",params:{missingProperty: missing0}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {const _errs3: any = errors;for(const key0 in data){if(!((((key0 === "clientIdempotencyKey") || (key0 === "binding")) || (key0 === "lead")) || (key0 === "groupId"))){const err1: any = {instancePath,schemaPath:"#/anyOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;break;}}if(_errs3 === errors){if(data.clientIdempotencyKey !== undefined){let data0: any = data.clientIdempotencyKey;const _errs4: any = errors;if(errors === _errs4){if(typeof data0 === "string"){if(!pattern88.test(data0)){const err2: any = {instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/anyOf/0/properties/clientIdempotencyKey/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}}else {const err3: any = {instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/anyOf/0/properties/clientIdempotencyKey/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}}var valid1: any = _errs4 === errors;}else {var valid1: any = true;}if(valid1){if(data.binding !== undefined){const _errs6: any = errors;if(!(validateSessionProjectBinding.call(this, data.binding, {instancePath:instancePath+"/binding",parentData:data,parentDataProperty:"binding",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionProjectBinding.errors : vErrors.concat(validateSessionProjectBinding.errors);errors = vErrors.length;}var valid1: any = _errs6 === errors;}else {var valid1: any = true;}if(valid1){if(data.lead !== undefined){const _errs7: any = errors;if(!(validateSessionLead.call(this, data.lead, {instancePath:instancePath+"/lead",parentData:data,parentDataProperty:"lead",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionLead.errors : vErrors.concat(validateSessionLead.errors);errors = vErrors.length;}var valid1: any = _errs7 === errors;}else {var valid1: any = true;}if(valid1){if(data.groupId !== undefined){const _errs8: any = errors;if(!(validateSessionGroupId.call(this, data.groupId, {instancePath:instancePath+"/groupId",parentData:data,parentDataProperty:"groupId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionGroupId.errors : vErrors.concat(validateSessionGroupId.errors);errors = vErrors.length;}var valid1: any = _errs8 === errors;}else {var valid1: any = true;}}}}}}}else {const err4: any = {instancePath,schemaPath:"#/anyOf/0/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}}var _valid0: any = _errs1 === errors;valid0 = valid0 || _valid0;if(_valid0){var props0: any = true;}const _errs9: any = errors;if(errors === _errs9){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((data.clientIdempotencyKey === undefined) && (missing1 = "clientIdempotencyKey")) || ((data.binding === undefined) && (missing1 = "binding"))) || ((data.lead === undefined) && (missing1 = "lead"))){const err5: any = {instancePath,schemaPath:"#/anyOf/1/required",keyword:"required",params:{missingProperty: missing1}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;}else {const _errs11: any = errors;for(const key1 in data){if(!((((key1 === "clientIdempotencyKey") || (key1 === "binding")) || (key1 === "lead")) || (key1 === "groupId"))){const err6: any = {instancePath,schemaPath:"#/anyOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}};if(vErrors === null){vErrors = [err6];}else {vErrors.push(err6);}errors++;break;}}if(_errs11 === errors){if(data.clientIdempotencyKey !== undefined){let data4: any = data.clientIdempotencyKey;const _errs12: any = errors;if(errors === _errs12){if(typeof data4 === "string"){if(!pattern88.test(data4)){const err7: any = {instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/anyOf/1/properties/clientIdempotencyKey/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}};if(vErrors === null){vErrors = [err7];}else {vErrors.push(err7);}errors++;}}else {const err8: any = {instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/anyOf/1/properties/clientIdempotencyKey/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err8];}else {vErrors.push(err8);}errors++;}}var valid2: any = _errs12 === errors;}else {var valid2: any = true;}if(valid2){if(data.binding !== undefined){const _errs14: any = errors;if(!(validateSessionChatBinding.call(this, data.binding, {instancePath:instancePath+"/binding",parentData:data,parentDataProperty:"binding",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionChatBinding.errors : vErrors.concat(validateSessionChatBinding.errors);errors = vErrors.length;}var valid2: any = _errs14 === errors;}else {var valid2: any = true;}if(valid2){if(data.lead !== undefined){const _errs15: any = errors;if(!(validateSessionLead.call(this, data.lead, {instancePath:instancePath+"/lead",parentData:data,parentDataProperty:"lead",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionLead.errors : vErrors.concat(validateSessionLead.errors);errors = vErrors.length;}var valid2: any = _errs15 === errors;}else {var valid2: any = true;}if(valid2){if(data.groupId !== undefined){const _errs16: any = errors;const err9: any = {instancePath:instancePath+"/groupId",schemaPath:"#/anyOf/1/properties/groupId/not",keyword:"not",params:{}};if(vErrors === null){vErrors = [err9];}else {vErrors.push(err9);}errors++;var valid2: any = _errs16 === errors;}else {var valid2: any = true;}}}}}}}else {const err10: any = {instancePath,schemaPath:"#/anyOf/1/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err10];}else {vErrors.push(err10);}errors++;}}var _valid0: any = _errs9 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}if(!valid0){const err11: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err11];}else {vErrors.push(err11);}errors++;validateSessionCreateRequest.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validateSessionCreateRequest.errors = vErrors;evaluated0.props = props0;return errors === 0;};
// prettier-ignore
validateSessionCreateRequest.evaluated = {"dynamicProps":true,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionCreateResponse}. */
// prettier-ignore
export const validateSessionCreateResponse: CompiledSchemaCheck<SessionCreateResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionCreateResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionCreateResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.shape === undefined) && (missing0 = "shape"))) || ((data.state === undefined) && (missing0 = "state"))) || ((data.lead === undefined) && (missing0 = "lead"))){validateSessionCreateResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((key0 === "sessionId") || (key0 === "shape")) || (key0 === "state")) || (key0 === "place")) || (key0 === "lead"))){validateSessionCreateResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.shape !== undefined){const _errs3: any = errors;if(!(validateSessionShape.call(this, data.shape, {instancePath:instancePath+"/shape",parentData:data,parentDataProperty:"shape",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionShape.errors : vErrors.concat(validateSessionShape.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.state !== undefined){const _errs4: any = errors;if(!(validateSessionState.call(this, data.state, {instancePath:instancePath+"/state",parentData:data,parentDataProperty:"state",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionState.errors : vErrors.concat(validateSessionState.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.place !== undefined){const _errs5: any = errors;if(!(validatePlace.call(this, data.place, {instancePath:instancePath+"/place",parentData:data,parentDataProperty:"place",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validatePlace.errors : vErrors.concat(validatePlace.errors);errors = vErrors.length;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.lead !== undefined){const _errs6: any = errors;if(!(validateAgentProviderBinding.call(this, data.lead, {instancePath:instancePath+"/lead",parentData:data,parentDataProperty:"lead",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateAgentProviderBinding.errors : vErrors.concat(validateAgentProviderBinding.errors);errors = vErrors.length;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}}}}else {validateSessionCreateResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionCreateResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionCreateResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionForkRequest}. */
// prettier-ignore
export const validateSessionForkRequest: CompiledSchemaCheck<SessionForkRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionForkRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionForkRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.anchorCursor === undefined) && (missing0 = "anchorCursor"))) || ((data.clientIdempotencyKey === undefined) && (missing0 = "clientIdempotencyKey"))){validateSessionForkRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "sessionId") || (key0 === "anchorCursor")) || (key0 === "name")) || (key0 === "clientIdempotencyKey"))){validateSessionForkRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.anchorCursor !== undefined){const _errs3: any = errors;if(!(validateEventCursor.call(this, data.anchorCursor, {instancePath:instancePath+"/anchorCursor",parentData:data,parentDataProperty:"anchorCursor",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateEventCursor.errors : vErrors.concat(validateEventCursor.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.name !== undefined){let data2: any = data.name;const _errs4: any = errors;if(errors === _errs4){if(typeof data2 === "string"){if(func1(data2) > 256){validateSessionForkRequest.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data2) < 1){validateSessionForkRequest.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data2)){validateSessionForkRequest.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateSessionForkRequest.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.clientIdempotencyKey !== undefined){let data3: any = data.clientIdempotencyKey;const _errs6: any = errors;if(errors === _errs6){if(typeof data3 === "string"){if(!pattern88.test(data3)){validateSessionForkRequest.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/properties/clientIdempotencyKey/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}}];return false;}}else {validateSessionForkRequest.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/properties/clientIdempotencyKey/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}}}else {validateSessionForkRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionForkRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionForkRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionForkResponse}. */
// prettier-ignore
export const validateSessionForkResponse: CompiledSchemaCheck<SessionForkResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionForkResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionForkResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.shape;if(typeof tag0 == "string"){if(tag0 === "project"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.shape === undefined) && (missing0 = "shape")) || ((data.sessionId === undefined) && (missing0 = "sessionId"))) || ((data.worktreeId === undefined) && (missing0 = "worktreeId"))){validateSessionForkResponse.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!(((key0 === "shape") || (key0 === "sessionId")) || (key0 === "worktreeId"))){validateSessionForkResponse.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.shape !== undefined){let data0: any = data.shape;const _errs5: any = errors;if(typeof data0 !== "string"){validateSessionForkResponse.errors = [{instancePath:instancePath+"/shape",schemaPath:"#/oneOf/0/properties/shape/type",keyword:"type",params:{type: "string"}}];return false;}if("project" !== data0){validateSessionForkResponse.errors = [{instancePath:instancePath+"/shape",schemaPath:"#/oneOf/0/properties/shape/const",keyword:"const",params:{allowedValue: "project"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.sessionId !== undefined){const _errs7: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}if(valid2){if(data.worktreeId !== undefined){const _errs8: any = errors;if(!(validateWorktreeId.call(this, data.worktreeId, {instancePath:instancePath+"/worktreeId",parentData:data,parentDataProperty:"worktreeId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorktreeId.errors : vErrors.concat(validateWorktreeId.errors);errors = vErrors.length;}var valid2: any = _errs8 === errors;}else {var valid2: any = true;}}}}}}else {validateSessionForkResponse.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "chat"){const _errs9: any = errors;if(errors === _errs9){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((data.shape === undefined) && (missing1 = "shape")) || ((data.sessionId === undefined) && (missing1 = "sessionId"))){validateSessionForkResponse.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs11: any = errors;for(const key1 in data){if(!((key1 === "shape") || (key1 === "sessionId"))){validateSessionForkResponse.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs11 === errors){if(data.shape !== undefined){let data3: any = data.shape;const _errs12: any = errors;if(typeof data3 !== "string"){validateSessionForkResponse.errors = [{instancePath:instancePath+"/shape",schemaPath:"#/oneOf/1/properties/shape/type",keyword:"type",params:{type: "string"}}];return false;}if("chat" !== data3){validateSessionForkResponse.errors = [{instancePath:instancePath+"/shape",schemaPath:"#/oneOf/1/properties/shape/const",keyword:"const",params:{allowedValue: "chat"}}];return false;}var valid4: any = _errs12 === errors;}else {var valid4: any = true;}if(valid4){if(data.sessionId !== undefined){const _errs14: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid4: any = _errs14 === errors;}else {var valid4: any = true;}}}}}else {validateSessionForkResponse.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid3: any = _errs9 === errors;if(props0 !== true){props0 = true;}valid0 = valid3;}else {validateSessionForkResponse.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "shape", tagValue: tag0}}];return false;}}else {validateSessionForkResponse.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "shape", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key2 in data){if(!props0 || !props0[key2]){validateSessionForkResponse.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key2}}];return false;break;}}}}}else {validateSessionForkResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionForkResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionForkResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern33 = new RegExp("^[^\\x00]*$", "u");
/** Checks that a value is a {@link SessionWorkingFolderUpdateRequest}. */
// prettier-ignore
export const validateSessionWorkingFolderUpdateRequest: CompiledSchemaCheck<SessionWorkingFolderUpdateRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionWorkingFolderUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionWorkingFolderUpdateRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.path === undefined) && (missing0 = "path"))){validateSessionWorkingFolderUpdateRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "path"))){validateSessionWorkingFolderUpdateRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.path !== undefined){let data1: any = data.path;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) > 4096){validateSessionWorkingFolderUpdateRequest.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data1) < 1){validateSessionWorkingFolderUpdateRequest.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern33.test(data1)){validateSessionWorkingFolderUpdateRequest.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validateSessionWorkingFolderUpdateRequest.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateSessionWorkingFolderUpdateRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionWorkingFolderUpdateRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionWorkingFolderUpdateRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1196: any = {"description":"When a working-folder move takes effect.","type":"string","enum":["applied","pending","dropped"]};
/** Checks that a value is a {@link SessionWorkingFolderDisposition}. */
// prettier-ignore
export const validateSessionWorkingFolderDisposition: CompiledSchemaCheck<SessionWorkingFolderDisposition> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionWorkingFolderDisposition {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionWorkingFolderDisposition.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateSessionWorkingFolderDisposition.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data === "applied") || (data === "pending")) || (data === "dropped"))){validateSessionWorkingFolderDisposition.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema1196.enum}}];return false;}validateSessionWorkingFolderDisposition.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionWorkingFolderDisposition.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionWorkingFolderUpdateResponse}. */
// prettier-ignore
export const validateSessionWorkingFolderUpdateResponse: CompiledSchemaCheck<SessionWorkingFolderUpdateResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionWorkingFolderUpdateResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionWorkingFolderUpdateResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.disposition === undefined) && (missing0 = "disposition"))) || ((data.path === undefined) && (missing0 = "path"))){validateSessionWorkingFolderUpdateResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "disposition")) || (key0 === "path"))){validateSessionWorkingFolderUpdateResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.sessionId, {instancePath:instancePath+"/sessionId",parentData:data,parentDataProperty:"sessionId",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.disposition !== undefined){const _errs3: any = errors;if(!(validateSessionWorkingFolderDisposition.call(this, data.disposition, {instancePath:instancePath+"/disposition",parentData:data,parentDataProperty:"disposition",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionWorkingFolderDisposition.errors : vErrors.concat(validateSessionWorkingFolderDisposition.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.path !== undefined){let data2: any = data.path;const _errs4: any = errors;if(errors === _errs4){if(typeof data2 === "string"){if(func1(data2) > 4096){validateSessionWorkingFolderUpdateResponse.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data2) < 1){validateSessionWorkingFolderUpdateResponse.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern33.test(data2)){validateSessionWorkingFolderUpdateResponse.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validateSessionWorkingFolderUpdateResponse.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}}else {validateSessionWorkingFolderUpdateResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionWorkingFolderUpdateResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionWorkingFolderUpdateResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionOverviewReadRequest}. */
// prettier-ignore
export const validateSessionOverviewReadRequest: CompiledSchemaCheck<SessionOverviewReadRequest> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionOverviewReadRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionOverviewReadRequest.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.afterRevision === undefined) && (missing0 = "afterRevision")){validateSessionOverviewReadRequest.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "afterRevision")){validateSessionOverviewReadRequest.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.afterRevision !== undefined){let data0: any = data.afterRevision;const _errs2: any = errors;if(!(((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0))) && (isFinite(data0)))){validateSessionOverviewReadRequest.errors = [{instancePath:instancePath+"/afterRevision",schemaPath:"#/properties/afterRevision/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs2){if((typeof data0 == "number") && (isFinite(data0))){if(data0 > 9007199254740991 || isNaN(data0)){validateSessionOverviewReadRequest.errors = [{instancePath:instancePath+"/afterRevision",schemaPath:"#/properties/afterRevision/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data0 < 0 || isNaN(data0)){validateSessionOverviewReadRequest.errors = [{instancePath:instancePath+"/afterRevision",schemaPath:"#/properties/afterRevision/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}}}}}else {validateSessionOverviewReadRequest.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionOverviewReadRequest.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionOverviewReadRequest.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionOverviewAgent}. */
// prettier-ignore
export const validateSessionOverviewAgent: CompiledSchemaCheck<SessionOverviewAgent> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionOverviewAgent {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionOverviewAgent.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.name === undefined) && (missing0 = "name")) || ((data.provider === undefined) && (missing0 = "provider"))) || ((data.state === undefined) && (missing0 = "state"))){validateSessionOverviewAgent.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "name") || (key0 === "provider")) || (key0 === "state"))){validateSessionOverviewAgent.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.name !== undefined){let data0: any = data.name;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 128){validateSessionOverviewAgent.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data0) < 1){validateSessionOverviewAgent.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data0)){validateSessionOverviewAgent.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateSessionOverviewAgent.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.provider !== undefined){const _errs4: any = errors;if(!(validateProviderId.call(this, data.provider, {instancePath:instancePath+"/provider",parentData:data,parentDataProperty:"provider",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderId.errors : vErrors.concat(validateProviderId.errors);errors = vErrors.length;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.state !== undefined){const _errs5: any = errors;if(!(validateSessionActivity.call(this, data.state, {instancePath:instancePath+"/state",parentData:data,parentDataProperty:"state",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionActivity.errors : vErrors.concat(validateSessionActivity.errors);errors = vErrors.length;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}}}}}}else {validateSessionOverviewAgent.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionOverviewAgent.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionOverviewAgent.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionOverviewSession}. */
// prettier-ignore
export const validateSessionOverviewSession: CompiledSchemaCheck<SessionOverviewSession> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionOverviewSession {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionOverviewSession.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.id === undefined) && (missing0 = "id")) || ((data.provider === undefined) && (missing0 = "provider"))) || ((data.state === undefined) && (missing0 = "state"))) || ((data.agents === undefined) && (missing0 = "agents"))){validateSessionOverviewSession.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((key0 === "id") || (key0 === "title")) || (key0 === "provider")) || (key0 === "state")) || (key0 === "agents"))){validateSessionOverviewSession.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.id !== undefined){const _errs2: any = errors;if(!(validateSessionId.call(this, data.id, {instancePath:instancePath+"/id",parentData:data,parentDataProperty:"id",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionId.errors : vErrors.concat(validateSessionId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.title !== undefined){let data1: any = data.title;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) > 256){validateSessionOverviewSession.errors = [{instancePath:instancePath+"/title",schemaPath:"#/properties/title/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data1) < 1){validateSessionOverviewSession.errors = [{instancePath:instancePath+"/title",schemaPath:"#/properties/title/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern5.test(data1)){validateSessionOverviewSession.errors = [{instancePath:instancePath+"/title",schemaPath:"#/properties/title/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validateSessionOverviewSession.errors = [{instancePath:instancePath+"/title",schemaPath:"#/properties/title/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.provider !== undefined){const _errs5: any = errors;if(!(validateProviderId.call(this, data.provider, {instancePath:instancePath+"/provider",parentData:data,parentDataProperty:"provider",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateProviderId.errors : vErrors.concat(validateProviderId.errors);errors = vErrors.length;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.state !== undefined){const _errs6: any = errors;if(!(validateSessionActivity.call(this, data.state, {instancePath:instancePath+"/state",parentData:data,parentDataProperty:"state",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionActivity.errors : vErrors.concat(validateSessionActivity.errors);errors = vErrors.length;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.agents !== undefined){let data4: any = data.agents;const _errs7: any = errors;if(errors === _errs7){if(Array.isArray(data4)){var valid1: any = true;const len0: any = data4.length;for(let i0=0; i0<len0; i0++){const _errs9: any = errors;if(!(validateSessionOverviewAgent.call(this, data4[i0], {instancePath:instancePath+"/agents/" + i0,parentData:data4,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionOverviewAgent.errors : vErrors.concat(validateSessionOverviewAgent.errors);errors = vErrors.length;}var valid1: any = _errs9 === errors;if(!valid1){break;}}}else {validateSessionOverviewSession.errors = [{instancePath:instancePath+"/agents",schemaPath:"#/properties/agents/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}}}}}}}}else {validateSessionOverviewSession.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionOverviewSession.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionOverviewSession.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1192: any = {"description":"Whether Remote Control is on.","type":"string","enum":["on","off"]};
/** Checks that a value is a {@link RemoteControlState}. */
// prettier-ignore
export const validateRemoteControlState: CompiledSchemaCheck<RemoteControlState> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is RemoteControlState {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateRemoteControlState.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateRemoteControlState.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data === "on") || (data === "off"))){validateRemoteControlState.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema1192.enum}}];return false;}validateRemoteControlState.errors = vErrors;return errors === 0;};
// prettier-ignore
validateRemoteControlState.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionOverviewReadResponse}. */
// prettier-ignore
export const validateSessionOverviewReadResponse: CompiledSchemaCheck<SessionOverviewReadResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionOverviewReadResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateSessionOverviewReadResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.revision === undefined) && (missing0 = "revision")) || ((data.sessions === undefined) && (missing0 = "sessions"))) || ((data.remoteControl === undefined) && (missing0 = "remoteControl"))){validateSessionOverviewReadResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "revision") || (key0 === "sessions")) || (key0 === "remoteControl"))){validateSessionOverviewReadResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.revision !== undefined){let data0: any = data.revision;const _errs2: any = errors;if(!(((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0))) && (isFinite(data0)))){validateSessionOverviewReadResponse.errors = [{instancePath:instancePath+"/revision",schemaPath:"#/properties/revision/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs2){if((typeof data0 == "number") && (isFinite(data0))){if(data0 > 9007199254740991 || isNaN(data0)){validateSessionOverviewReadResponse.errors = [{instancePath:instancePath+"/revision",schemaPath:"#/properties/revision/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data0 < 0 || isNaN(data0)){validateSessionOverviewReadResponse.errors = [{instancePath:instancePath+"/revision",schemaPath:"#/properties/revision/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.sessions !== undefined){let data1: any = data.sessions;const _errs4: any = errors;if(errors === _errs4){if(Array.isArray(data1)){var valid1: any = true;const len0: any = data1.length;for(let i0=0; i0<len0; i0++){const _errs6: any = errors;if(!(validateSessionOverviewSession.call(this, data1[i0], {instancePath:instancePath+"/sessions/" + i0,parentData:data1,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateSessionOverviewSession.errors : vErrors.concat(validateSessionOverviewSession.errors);errors = vErrors.length;}var valid1: any = _errs6 === errors;if(!valid1){break;}}}else {validateSessionOverviewReadResponse.errors = [{instancePath:instancePath+"/sessions",schemaPath:"#/properties/sessions/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.remoteControl !== undefined){let data3: any = data.remoteControl;const _errs7: any = errors;if(errors === _errs7){if(data3 && typeof data3 == "object" && !Array.isArray(data3)){let missing1: any;if((data3.state === undefined) && (missing1 = "state")){validateSessionOverviewReadResponse.errors = [{instancePath:instancePath+"/remoteControl",schemaPath:"#/properties/remoteControl/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs9: any = errors;for(const key1 in data3){if(!(key1 === "state")){validateSessionOverviewReadResponse.errors = [{instancePath:instancePath+"/remoteControl",schemaPath:"#/properties/remoteControl/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs9 === errors){if(data3.state !== undefined){if(!(validateRemoteControlState.call(this, data3.state, {instancePath:instancePath+"/remoteControl/state",parentData:data3,parentDataProperty:"state",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateRemoteControlState.errors : vErrors.concat(validateRemoteControlState.errors);errors = vErrors.length;}}}}}else {validateSessionOverviewReadResponse.errors = [{instancePath:instancePath+"/remoteControl",schemaPath:"#/properties/remoteControl/type",keyword:"type",params:{type: "object"}}];return false;}}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}}}}}}else {validateSessionOverviewReadResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateSessionOverviewReadResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateSessionOverviewReadResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;

/** The methods of {@link SESSION_DIRECTORY_METHOD_DESCRIPTORS}, each with its checks. */
export interface SessionDirectoryMethodDescriptors {
  readonly "session.create": {
    readonly method: "session.create";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SessionCreateRequest>;
    readonly responseCheck: SchemaCheck<SessionCreateResponse>;
  };
  readonly "session.subscribe": {
    readonly method: "session.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<SessionSubscribeResponse>;
    readonly emissionCheck: SchemaCheck<SessionListChange>;
  };
  readonly "session.event.subscribe": {
    readonly method: "session.event.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<SessionEventSubscribeRequest>;
    readonly responseCheck: SchemaCheck<SubscribeAcknowledgmentResponse>;
    readonly emissionCheck: SchemaCheck<SessionStreamFrame>;
  };
  readonly "session.convert": {
    readonly method: "session.convert";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SessionConvertRequest>;
    readonly responseCheck: SchemaCheck<SessionConvertResponse>;
  };
  readonly "session.fork": {
    readonly method: "session.fork";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SessionForkRequest>;
    readonly responseCheck: SchemaCheck<SessionForkResponse>;
  };
  readonly "session.workingFolder.update": {
    readonly method: "session.workingFolder.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SessionWorkingFolderUpdateRequest>;
    readonly responseCheck: SchemaCheck<SessionWorkingFolderUpdateResponse>;
  };
  readonly "session.overview.read": {
    readonly method: "session.overview.read";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<SessionOverviewReadRequest>;
    readonly responseCheck: SchemaCheck<SessionOverviewReadResponse>;
  };
}
/** The session directory methods' wire contract: name, procedure type and types. */
export const SESSION_DIRECTORY_METHOD_DESCRIPTORS: SessionDirectoryMethodDescriptors =
  Object.freeze({
    "session.create": Object.freeze({
      method: "session.create",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateSessionCreateRequest,
      responseCheck: validateSessionCreateResponse,
    }),
    "session.subscribe": Object.freeze({
      method: "session.subscribe",
      procedureType: "subscription",
      mutating: false,
      requestCheck: validateEmptyPayload,
      responseCheck: validateSessionSubscribeResponse,
      emissionCheck: validateSessionListChange,
    }),
    "session.event.subscribe": Object.freeze({
      method: "session.event.subscribe",
      procedureType: "subscription",
      mutating: false,
      requestCheck: validateSessionEventSubscribeRequest,
      responseCheck: validateSubscribeAcknowledgmentResponse,
      emissionCheck: validateSessionStreamFrame,
    }),
    "session.convert": Object.freeze({
      method: "session.convert",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateSessionConvertRequest,
      responseCheck: validateSessionConvertResponse,
    }),
    "session.fork": Object.freeze({
      method: "session.fork",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateSessionForkRequest,
      responseCheck: validateSessionForkResponse,
    }),
    "session.workingFolder.update": Object.freeze({
      method: "session.workingFolder.update",
      procedureType: "mutation",
      mutating: true,
      requestCheck: validateSessionWorkingFolderUpdateRequest,
      responseCheck: validateSessionWorkingFolderUpdateResponse,
    }),
    "session.overview.read": Object.freeze({
      method: "session.overview.read",
      procedureType: "query",
      mutating: false,
      requestCheck: validateSessionOverviewReadRequest,
      responseCheck: validateSessionOverviewReadResponse,
    }),
  });
