// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The session directory as a client reads and moves it: the live sessions list, creating, converting and forking a session, moving its working folder, and the terminal pane's overview.

import { type SchemaCheck, deepEqual, ucs2length, wireByteLength } from "../../schema-check.js";
import type { AgentProviderBinding } from "../agent/definition.js";
import type { WireInstant } from "../internal/wire-scalars.js";
import {
  type SubscribeAcknowledgmentResponse,
  type SubscriptionId,
  validateSubscribeAcknowledgmentResponse,
} from "../jsonrpc/streaming.js";
import { type EmptyPayload, validateEmptyPayload } from "../method-descriptor.js";
import type { Place } from "../place.js";
import type { ProjectId } from "../project.js";
import type { ProviderOptionSetting } from "../provider/declaration.js";
import type { ProviderId } from "../provider/id.js";
import type { ExecutionMode } from "../repo/mount.js";
import type { WorktreeId } from "../worktree/lifecycle.js";
import {
  type SessionConvertRequest,
  type SessionConvertResponse,
  validateSessionConvertRequest,
  validateSessionConvertResponse,
} from "./convert.js";
import type { SessionGroupId } from "./groups.js";
import type { EventCursor, SessionId } from "./id.js";
import {
  type SessionEventSubscribeRequest,
  type SessionShape,
  type SessionState,
  type SessionStreamFrame,
  validateSessionEventSubscribeRequest,
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
const schema3751: any = {"type":"object","additionalProperties":false,"properties":{"kind":{"description":"`chat`.","type":"string","enum":["chat"]}},"required":["kind"],"description":"A chat works in a managed workspace the daemon makes for it in the same step."};
// prettier-ignore
const schema3752: any = {"type":"object","additionalProperties":false,"properties":{"kind":{"description":"`project`.","type":"string","enum":["project"]},"projectId":{"$ref":"sidekicks-contracts:project#/$defs/ProjectId","description":"The project."},"executionMode":{"$ref":"sidekicks-contracts:repo/mount#/$defs/ExecutionMode","description":"Where in it the session works."}},"required":["kind","projectId","executionMode"],"description":"A project session binds to the project's mount in the same step, working in a worktree of its\nown (`provisionedWorktree`) or in the project's checkout (`boundRoot`)."};
// prettier-ignore
const schema1986: any = {"description":"How a workspace uses its mount: `boundRoot` works in the root already bound to it (the mount's\nown checkout), `provisionedWorktree` in a worktree the daemon provisions for it.","type":"string","enum":["boundRoot","provisionedWorktree"]};
// prettier-ignore
const pattern4 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
// prettier-ignore
function validate1884(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1884.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.kind === undefined) && (missing0 = "kind")) || ((data.projectId === undefined) && (missing0 = "projectId"))) || ((data.executionMode === undefined) && (missing0 = "executionMode"))){validate1884.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "kind") || (key0 === "projectId")) || (key0 === "executionMode"))){validate1884.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.kind !== undefined){let data0: any = data.kind;const _errs2: any = errors;if(typeof data0 !== "string"){validate1884.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data0 === "project")){validate1884.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/properties/kind/enum",keyword:"enum",params:{allowedValues: schema3752.properties.kind.enum}}];return false;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.projectId !== undefined){let data1: any = data.projectId;const _errs4: any = errors;const _errs5: any = errors;if(errors === _errs5){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate1884.errors = [{instancePath:instancePath+"/projectId",schemaPath:"sidekicks-contracts:project#/$defs/ProjectId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1884.errors = [{instancePath:instancePath+"/projectId",schemaPath:"sidekicks-contracts:project#/$defs/ProjectId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.executionMode !== undefined){let data2: any = data.executionMode;const _errs8: any = errors;if(typeof data2 !== "string"){validate1884.errors = [{instancePath:instancePath+"/executionMode",schemaPath:"sidekicks-contracts:repo/mount#/$defs/ExecutionMode/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data2 === "boundRoot") || (data2 === "provisionedWorktree"))){validate1884.errors = [{instancePath:instancePath+"/executionMode",schemaPath:"sidekicks-contracts:repo/mount#/$defs/ExecutionMode/enum",keyword:"enum",params:{allowedValues: schema1986.enum}}];return false;}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}}}}}}else {validate1884.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1884.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1884.errors = null as any[] | null;
// prettier-ignore
validate1884.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1883(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionBinding {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1883.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;const _errs1: any = errors;const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.kind === undefined) && (missing0 = "kind")){const err0: any = {instancePath,schemaPath:"#/$defs/SessionChatBinding/required",keyword:"required",params:{missingProperty: missing0}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {const _errs4: any = errors;for(const key0 in data){if(!(key0 === "kind")){const err1: any = {instancePath,schemaPath:"#/$defs/SessionChatBinding/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;break;}}if(_errs4 === errors){if(data.kind !== undefined){let data0: any = data.kind;if(typeof data0 !== "string"){const err2: any = {instancePath:instancePath+"/kind",schemaPath:"#/$defs/SessionChatBinding/properties/kind/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}if(!(data0 === "chat")){const err3: any = {instancePath:instancePath+"/kind",schemaPath:"#/$defs/SessionChatBinding/properties/kind/enum",keyword:"enum",params:{allowedValues: schema3751.properties.kind.enum}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}}}}}else {const err4: any = {instancePath,schemaPath:"#/$defs/SessionChatBinding/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}}var _valid0: any = _errs1 === errors;valid0 = valid0 || _valid0;if(_valid0){var props0: any = true;}const _errs7: any = errors;if(!(validate1884.call(this, data, {instancePath,parentData,parentDataProperty,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1884.errors : vErrors.concat(validate1884.errors);errors = vErrors.length;}var _valid0: any = _errs7 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}if(!valid0){const err5: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;validate1883.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validate1883.errors = vErrors;evaluated0.props = props0;return errors === 0;}
// prettier-ignore
validate1883.errors = null as any[] | null;
// prettier-ignore
validate1883.evaluated = {"dynamicProps":true,"dynamicItems":false} as any;
// prettier-ignore
const pattern222 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$", "u");
// prettier-ignore
const schema3756: any = {"type":"object","additionalProperties":false,"properties":{"providerName":{"$ref":"sidekicks-contracts:provider/id#/$defs/ProviderId","description":"The provider."},"modelId":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":128,"description":"The model."},"effort":{"type":["string","null"],"minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":128,"description":"The effort, or `null` for the driver's default; checked when a run resolves."},"outputSpeed":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":128,"description":"The output speed, where one was picked; a saved definition leaves it absent."},"options":{"type":"array","items":{"$ref":"sidekicks-contracts:provider/declaration#/$defs/ProviderOptionSetting"},"minItems":1,"uniqueItems":true,"description":"The values of the session options the driver declares, where any was set; an option\nleft out keeps the provider's own value, and a saved definition leaves it absent."},"largerWindow":{"type":"integer","minimum":1,"maximum":9007199254740991,"description":"The larger window chosen, in tokens, recorded when picked and sent on every resume\nand turn; absent is the model's default window."}},"required":["providerName","modelId","effort"],"description":"The lead as the app chose it: its provider, model and effort, and its output speed where one\nwas picked. It names no account: the daemon resolves that."};
// prettier-ignore
const pattern16 = new RegExp("^[a-z][a-z0-9-]{0,31}$", "u");
// prettier-ignore
const pattern6 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
const func0 = deepEqual;
// prettier-ignore
const pattern20 = new RegExp("^[a-z][A-Za-z0-9]{0,63}$", "u");
// prettier-ignore
function validate1889(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1889.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.id === undefined) && (missing0 = "id")) || ((data.value === undefined) && (missing0 = "value"))){validate1889.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "id") || (key0 === "value"))){validate1889.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.id !== undefined){let data0: any = data.id;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern20.test(data0)){validate1889.errors = [{instancePath:instancePath+"/id",schemaPath:"#/$defs/ProviderDeclarationId/pattern",keyword:"pattern",params:{pattern: "^[a-z][A-Za-z0-9]{0,63}$"}}];return false;}}else {validate1889.errors = [{instancePath:instancePath+"/id",schemaPath:"#/$defs/ProviderDeclarationId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.value !== undefined){let data1: any = data.value;const _errs6: any = errors;const _errs8: any = errors;let valid3: any = false;const _errs9: any = errors;if(typeof data1 !== "boolean"){const err0: any = {instancePath:instancePath+"/value",schemaPath:"#/$defs/ProviderValue/anyOf/0/type",keyword:"type",params:{type: "boolean"}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var _valid0: any = _errs9 === errors;valid3 = valid3 || _valid0;const _errs11: any = errors;if(errors === _errs11){if(typeof data1 === "string"){if(func1(data1) > 4096){const err1: any = {instancePath:instancePath+"/value",schemaPath:"#/$defs/ProviderValue/anyOf/1/maxLength",keyword:"maxLength",params:{limit: 4096}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}else {if(func1(data1) < 1){const err2: any = {instancePath:instancePath+"/value",schemaPath:"#/$defs/ProviderValue/anyOf/1/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}else {if(!pattern6.test(data1)){const err3: any = {instancePath:instancePath+"/value",schemaPath:"#/$defs/ProviderValue/anyOf/1/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}}}}else {const err4: any = {instancePath:instancePath+"/value",schemaPath:"#/$defs/ProviderValue/anyOf/1/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}}var _valid0: any = _errs11 === errors;valid3 = valid3 || _valid0;if(!valid3){const err5: any = {instancePath:instancePath+"/value",schemaPath:"#/$defs/ProviderValue/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;validate1889.errors = vErrors;return false;}else {errors = _errs8;if(vErrors !== null){if(_errs8){vErrors.length = _errs8;}else {vErrors = null;}}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate1889.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1889.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1889.errors = null as any[] | null;
// prettier-ignore
validate1889.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1888(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1888.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.providerName === undefined) && (missing0 = "providerName")) || ((data.modelId === undefined) && (missing0 = "modelId"))) || ((data.effort === undefined) && (missing0 = "effort"))){validate1888.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((((key0 === "providerName") || (key0 === "modelId")) || (key0 === "effort")) || (key0 === "outputSpeed")) || (key0 === "options")) || (key0 === "largerWindow"))){validate1888.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.providerName !== undefined){let data0: any = data.providerName;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern16.test(data0)){validate1888.errors = [{instancePath:instancePath+"/providerName",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}}];return false;}}else {validate1888.errors = [{instancePath:instancePath+"/providerName",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.modelId !== undefined){let data1: any = data.modelId;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(func1(data1) > 128){validate1888.errors = [{instancePath:instancePath+"/modelId",schemaPath:"#/properties/modelId/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data1) < 1){validate1888.errors = [{instancePath:instancePath+"/modelId",schemaPath:"#/properties/modelId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data1)){validate1888.errors = [{instancePath:instancePath+"/modelId",schemaPath:"#/properties/modelId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1888.errors = [{instancePath:instancePath+"/modelId",schemaPath:"#/properties/modelId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.effort !== undefined){let data2: any = data.effort;const _errs8: any = errors;if((typeof data2 !== "string") && (data2 !== null)){validate1888.errors = [{instancePath:instancePath+"/effort",schemaPath:"#/properties/effort/type",keyword:"type",params:{type: schema3756.properties.effort.type}}];return false;}if(errors === _errs8){if(typeof data2 === "string"){if(func1(data2) > 128){validate1888.errors = [{instancePath:instancePath+"/effort",schemaPath:"#/properties/effort/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data2) < 1){validate1888.errors = [{instancePath:instancePath+"/effort",schemaPath:"#/properties/effort/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data2)){validate1888.errors = [{instancePath:instancePath+"/effort",schemaPath:"#/properties/effort/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.outputSpeed !== undefined){let data3: any = data.outputSpeed;const _errs10: any = errors;if(errors === _errs10){if(typeof data3 === "string"){if(func1(data3) > 128){validate1888.errors = [{instancePath:instancePath+"/outputSpeed",schemaPath:"#/properties/outputSpeed/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data3) < 1){validate1888.errors = [{instancePath:instancePath+"/outputSpeed",schemaPath:"#/properties/outputSpeed/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data3)){validate1888.errors = [{instancePath:instancePath+"/outputSpeed",schemaPath:"#/properties/outputSpeed/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1888.errors = [{instancePath:instancePath+"/outputSpeed",schemaPath:"#/properties/outputSpeed/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.options !== undefined){let data4: any = data.options;const _errs12: any = errors;if(errors === _errs12){if(Array.isArray(data4)){if(data4.length < 1){validate1888.errors = [{instancePath:instancePath+"/options",schemaPath:"#/properties/options/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid2: any = true;const len0: any = data4.length;for(let i0=0; i0<len0; i0++){const _errs14: any = errors;if(!(validate1889.call(this, data4[i0], {instancePath:instancePath+"/options/" + i0,parentData:data4,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1889.errors : vErrors.concat(validate1889.errors);errors = vErrors.length;}var valid2: any = _errs14 === errors;if(!valid2){break;}}if(valid2){let i1: any = data4.length;let j0: any;if(i1 > 1){outer0:for(;i1--;){for(j0 = i1; j0--;){if(func0(data4[i1], data4[j0])){validate1888.errors = [{instancePath:instancePath+"/options",schemaPath:"#/properties/options/uniqueItems",keyword:"uniqueItems",params:{i: i1, j: j0}}];return false;break outer0;}}}}}}}else {validate1888.errors = [{instancePath:instancePath+"/options",schemaPath:"#/properties/options/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}if(valid0){if(data.largerWindow !== undefined){let data6: any = data.largerWindow;const _errs15: any = errors;if(!(((typeof data6 == "number") && (!(data6 % 1) && !isNaN(data6))) && (isFinite(data6)))){validate1888.errors = [{instancePath:instancePath+"/largerWindow",schemaPath:"#/properties/largerWindow/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs15){if((typeof data6 == "number") && (isFinite(data6))){if(data6 > 9007199254740991 || isNaN(data6)){validate1888.errors = [{instancePath:instancePath+"/largerWindow",schemaPath:"#/properties/largerWindow/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data6 < 1 || isNaN(data6)){validate1888.errors = [{instancePath:instancePath+"/largerWindow",schemaPath:"#/properties/largerWindow/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs15 === errors;}else {var valid0: any = true;}}}}}}}}}else {validate1888.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1888.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1888.errors = null as any[] | null;
// prettier-ignore
validate1888.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1886(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionCreateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1886.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;const _errs1: any = errors;if(errors === _errs1){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.clientIdempotencyKey === undefined) && (missing0 = "clientIdempotencyKey")) || ((data.binding === undefined) && (missing0 = "binding"))) || ((data.lead === undefined) && (missing0 = "lead"))){const err0: any = {instancePath,schemaPath:"#/anyOf/0/required",keyword:"required",params:{missingProperty: missing0}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {const _errs3: any = errors;for(const key0 in data){if(!((((key0 === "clientIdempotencyKey") || (key0 === "binding")) || (key0 === "lead")) || (key0 === "groupId"))){const err1: any = {instancePath,schemaPath:"#/anyOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;break;}}if(_errs3 === errors){if(data.clientIdempotencyKey !== undefined){let data0: any = data.clientIdempotencyKey;const _errs4: any = errors;if(errors === _errs4){if(typeof data0 === "string"){if(!pattern222.test(data0)){const err2: any = {instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/anyOf/0/properties/clientIdempotencyKey/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}}else {const err3: any = {instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/anyOf/0/properties/clientIdempotencyKey/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}}var valid1: any = _errs4 === errors;}else {var valid1: any = true;}if(valid1){if(data.binding !== undefined){const _errs6: any = errors;if(!(validate1884.call(this, data.binding, {instancePath:instancePath+"/binding",parentData:data,parentDataProperty:"binding",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1884.errors : vErrors.concat(validate1884.errors);errors = vErrors.length;}var valid1: any = _errs6 === errors;}else {var valid1: any = true;}if(valid1){if(data.lead !== undefined){const _errs7: any = errors;if(!(validate1888.call(this, data.lead, {instancePath:instancePath+"/lead",parentData:data,parentDataProperty:"lead",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1888.errors : vErrors.concat(validate1888.errors);errors = vErrors.length;}var valid1: any = _errs7 === errors;}else {var valid1: any = true;}if(valid1){if(data.groupId !== undefined){let data3: any = data.groupId;const _errs8: any = errors;const _errs9: any = errors;if(errors === _errs9){if(typeof data3 === "string"){if(!pattern4.test(data3)){const err4: any = {instancePath:instancePath+"/groupId",schemaPath:"sidekicks-contracts:session/groups#/$defs/SessionGroupId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}}else {const err5: any = {instancePath:instancePath+"/groupId",schemaPath:"sidekicks-contracts:session/groups#/$defs/SessionGroupId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;}}var valid1: any = _errs8 === errors;}else {var valid1: any = true;}}}}}}}else {const err6: any = {instancePath,schemaPath:"#/anyOf/0/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err6];}else {vErrors.push(err6);}errors++;}}var _valid0: any = _errs1 === errors;valid0 = valid0 || _valid0;if(_valid0){var props0: any = true;}const _errs12: any = errors;if(errors === _errs12){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((data.clientIdempotencyKey === undefined) && (missing1 = "clientIdempotencyKey")) || ((data.binding === undefined) && (missing1 = "binding"))) || ((data.lead === undefined) && (missing1 = "lead"))){const err7: any = {instancePath,schemaPath:"#/anyOf/1/required",keyword:"required",params:{missingProperty: missing1}};if(vErrors === null){vErrors = [err7];}else {vErrors.push(err7);}errors++;}else {const _errs14: any = errors;for(const key1 in data){if(!((((key1 === "clientIdempotencyKey") || (key1 === "binding")) || (key1 === "lead")) || (key1 === "groupId"))){const err8: any = {instancePath,schemaPath:"#/anyOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}};if(vErrors === null){vErrors = [err8];}else {vErrors.push(err8);}errors++;break;}}if(_errs14 === errors){if(data.clientIdempotencyKey !== undefined){let data4: any = data.clientIdempotencyKey;const _errs15: any = errors;if(errors === _errs15){if(typeof data4 === "string"){if(!pattern222.test(data4)){const err9: any = {instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/anyOf/1/properties/clientIdempotencyKey/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}};if(vErrors === null){vErrors = [err9];}else {vErrors.push(err9);}errors++;}}else {const err10: any = {instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/anyOf/1/properties/clientIdempotencyKey/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err10];}else {vErrors.push(err10);}errors++;}}var valid3: any = _errs15 === errors;}else {var valid3: any = true;}if(valid3){if(data.binding !== undefined){let data5: any = data.binding;const _errs17: any = errors;const _errs18: any = errors;if(errors === _errs18){if(data5 && typeof data5 == "object" && !Array.isArray(data5)){let missing2: any;if((data5.kind === undefined) && (missing2 = "kind")){const err11: any = {instancePath:instancePath+"/binding",schemaPath:"#/$defs/SessionChatBinding/required",keyword:"required",params:{missingProperty: missing2}};if(vErrors === null){vErrors = [err11];}else {vErrors.push(err11);}errors++;}else {const _errs20: any = errors;for(const key2 in data5){if(!(key2 === "kind")){const err12: any = {instancePath:instancePath+"/binding",schemaPath:"#/$defs/SessionChatBinding/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}};if(vErrors === null){vErrors = [err12];}else {vErrors.push(err12);}errors++;break;}}if(_errs20 === errors){if(data5.kind !== undefined){let data6: any = data5.kind;if(typeof data6 !== "string"){const err13: any = {instancePath:instancePath+"/binding/kind",schemaPath:"#/$defs/SessionChatBinding/properties/kind/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err13];}else {vErrors.push(err13);}errors++;}if(!(data6 === "chat")){const err14: any = {instancePath:instancePath+"/binding/kind",schemaPath:"#/$defs/SessionChatBinding/properties/kind/enum",keyword:"enum",params:{allowedValues: schema3751.properties.kind.enum}};if(vErrors === null){vErrors = [err14];}else {vErrors.push(err14);}errors++;}}}}}else {const err15: any = {instancePath:instancePath+"/binding",schemaPath:"#/$defs/SessionChatBinding/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err15];}else {vErrors.push(err15);}errors++;}}var valid3: any = _errs17 === errors;}else {var valid3: any = true;}if(valid3){if(data.lead !== undefined){const _errs23: any = errors;if(!(validate1888.call(this, data.lead, {instancePath:instancePath+"/lead",parentData:data,parentDataProperty:"lead",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1888.errors : vErrors.concat(validate1888.errors);errors = vErrors.length;}var valid3: any = _errs23 === errors;}else {var valid3: any = true;}if(valid3){if(data.groupId !== undefined){const _errs24: any = errors;const err16: any = {instancePath:instancePath+"/groupId",schemaPath:"#/anyOf/1/properties/groupId/not",keyword:"not",params:{}};if(vErrors === null){vErrors = [err16];}else {vErrors.push(err16);}errors++;var valid3: any = _errs24 === errors;}else {var valid3: any = true;}}}}}}}else {const err17: any = {instancePath,schemaPath:"#/anyOf/1/type",keyword:"type",params:{type: "object"}};if(vErrors === null){vErrors = [err17];}else {vErrors.push(err17);}errors++;}}var _valid0: any = _errs12 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}if(!valid0){const err18: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err18];}else {vErrors.push(err18);}errors++;validate1886.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validate1886.errors = vErrors;evaluated0.props = props0;return errors === 0;}
// prettier-ignore
validate1886.errors = null as any[] | null;
// prettier-ignore
validate1886.evaluated = {"dynamicProps":true,"dynamicItems":false} as any;
// prettier-ignore
const schema908: any = {"description":"What a session is bound to, kept as a stored fact rather than a mode flag: a `chat` works in a\nmanaged workspace the daemon owns, a `project` in a repository the person attached. Converting\na chat changes it in place, so it is read from the session, never fixed at creation.","type":"string","enum":["chat","project"]};
// prettier-ignore
const schema1217: any = {"description":"Where a session is in its lifecycle.","type":"string","enum":["provisioning","active","archived","closed","purgeRequested"]};
// prettier-ignore
const schema914: any = {"anyOf":[{"description":"Windows itself.","type":"string","enum":["windows"]},{"$ref":"#/$defs/WslPlace","description":"A WSL distribution."}],"description":"Where work runs: `\"windows\"`, or `{distro}` for a WSL 2 distribution. A provider's `Command`\nrow may also name a WSL 1 distribution, the one place no work runs."};
// prettier-ignore
function validate477(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate477.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.distro === undefined) && (missing0 = "distro")){validate477.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "distro")){validate477.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.distro !== undefined){let data0: any = data.distro;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(func1(data0) > 256){validate477.errors = [{instancePath:instancePath+"/distro",schemaPath:"#/$defs/DistroName/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(!pattern6.test(data0)){validate477.errors = [{instancePath:instancePath+"/distro",schemaPath:"#/$defs/DistroName/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validate477.errors = [{instancePath:instancePath+"/distro",schemaPath:"#/$defs/DistroName/type",keyword:"type",params:{type: "string"}}];return false;}}}}}}else {validate477.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate477.errors = vErrors;return errors === 0;}
// prettier-ignore
validate477.errors = null as any[] | null;
// prettier-ignore
validate477.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1895(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1895.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;const _errs1: any = errors;if(typeof data !== "string"){const err0: any = {instancePath,schemaPath:"#/anyOf/0/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}if(!(data === "windows")){const err1: any = {instancePath,schemaPath:"#/anyOf/0/enum",keyword:"enum",params:{allowedValues: schema914.anyOf[0].enum}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}var _valid0: any = _errs1 === errors;valid0 = valid0 || _valid0;const _errs3: any = errors;if(!(validate477.call(this, data, {instancePath,parentData,parentDataProperty,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate477.errors : vErrors.concat(validate477.errors);errors = vErrors.length;}var _valid0: any = _errs3 === errors;valid0 = valid0 || _valid0;if(_valid0){var props0: any = true;}if(!valid0){const err2: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;validate1895.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validate1895.errors = vErrors;evaluated0.props = props0;return errors === 0;}
// prettier-ignore
validate1895.errors = null as any[] | null;
// prettier-ignore
validate1895.evaluated = {"dynamicProps":true,"dynamicItems":false} as any;
// prettier-ignore
const schema71: any = {"type":"object","additionalProperties":false,"properties":{"providerName":{"$ref":"sidekicks-contracts:provider/id#/$defs/ProviderId","description":"The provider."},"modelId":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":128,"description":"The model."},"providerAccountId":{"anyOf":[{"$ref":"sidekicks-contracts:provider/account/record#/$defs/ProviderAccountId"},{"type":"null"}],"description":"The account, or `null` to follow the provider's current account, resolved at run\nstart; not a foreign key, so a removed account refuses resolution rather than\nrewriting this."},"effort":{"type":["string","null"],"minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":128,"description":"The effort, or `null` for the driver's default; checked when a run resolves."},"outputSpeed":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":128,"description":"The output speed, where one was picked; a saved definition leaves it absent."},"options":{"type":"array","items":{"$ref":"sidekicks-contracts:provider/declaration#/$defs/ProviderOptionSetting"},"minItems":1,"uniqueItems":true,"description":"The values of the session options the driver declares, where any was set; an option\nleft out keeps the provider's own value, and a saved definition leaves it absent."},"largerWindow":{"type":"integer","minimum":1,"maximum":9007199254740991,"description":"The larger window chosen, in tokens, recorded when picked and sent on every resume\nand turn; absent is the model's default window."}},"required":["providerName","modelId","providerAccountId","effort"],"description":"Which provider runs an agent, on which model, paying from which account, at which effort,\nspeed and session options: one shape for a saved definition's bindings and a running\nagent's binding."};
// prettier-ignore
function validate41(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate41.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.id === undefined) && (missing0 = "id")) || ((data.value === undefined) && (missing0 = "value"))){validate41.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "id") || (key0 === "value"))){validate41.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.id !== undefined){let data0: any = data.id;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern20.test(data0)){validate41.errors = [{instancePath:instancePath+"/id",schemaPath:"#/$defs/ProviderDeclarationId/pattern",keyword:"pattern",params:{pattern: "^[a-z][A-Za-z0-9]{0,63}$"}}];return false;}}else {validate41.errors = [{instancePath:instancePath+"/id",schemaPath:"#/$defs/ProviderDeclarationId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.value !== undefined){let data1: any = data.value;const _errs6: any = errors;const _errs8: any = errors;let valid3: any = false;const _errs9: any = errors;if(typeof data1 !== "boolean"){const err0: any = {instancePath:instancePath+"/value",schemaPath:"#/$defs/ProviderValue/anyOf/0/type",keyword:"type",params:{type: "boolean"}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var _valid0: any = _errs9 === errors;valid3 = valid3 || _valid0;const _errs11: any = errors;if(errors === _errs11){if(typeof data1 === "string"){if(func1(data1) > 4096){const err1: any = {instancePath:instancePath+"/value",schemaPath:"#/$defs/ProviderValue/anyOf/1/maxLength",keyword:"maxLength",params:{limit: 4096}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}else {if(func1(data1) < 1){const err2: any = {instancePath:instancePath+"/value",schemaPath:"#/$defs/ProviderValue/anyOf/1/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}else {if(!pattern6.test(data1)){const err3: any = {instancePath:instancePath+"/value",schemaPath:"#/$defs/ProviderValue/anyOf/1/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}}}}else {const err4: any = {instancePath:instancePath+"/value",schemaPath:"#/$defs/ProviderValue/anyOf/1/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;}}var _valid0: any = _errs11 === errors;valid3 = valid3 || _valid0;if(!valid3){const err5: any = {instancePath:instancePath+"/value",schemaPath:"#/$defs/ProviderValue/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err5];}else {vErrors.push(err5);}errors++;validate41.errors = vErrors;return false;}else {errors = _errs8;if(vErrors !== null){if(_errs8){vErrors.length = _errs8;}else {vErrors = null;}}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate41.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate41.errors = vErrors;return errors === 0;}
// prettier-ignore
validate41.errors = null as any[] | null;
// prettier-ignore
validate41.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate85(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate85.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.providerName === undefined) && (missing0 = "providerName")) || ((data.modelId === undefined) && (missing0 = "modelId"))) || ((data.providerAccountId === undefined) && (missing0 = "providerAccountId"))) || ((data.effort === undefined) && (missing0 = "effort"))){validate85.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((((key0 === "providerName") || (key0 === "modelId")) || (key0 === "providerAccountId")) || (key0 === "effort")) || (key0 === "outputSpeed")) || (key0 === "options")) || (key0 === "largerWindow"))){validate85.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.providerName !== undefined){let data0: any = data.providerName;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern16.test(data0)){validate85.errors = [{instancePath:instancePath+"/providerName",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}}];return false;}}else {validate85.errors = [{instancePath:instancePath+"/providerName",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.modelId !== undefined){let data1: any = data.modelId;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(func1(data1) > 128){validate85.errors = [{instancePath:instancePath+"/modelId",schemaPath:"#/properties/modelId/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data1) < 1){validate85.errors = [{instancePath:instancePath+"/modelId",schemaPath:"#/properties/modelId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data1)){validate85.errors = [{instancePath:instancePath+"/modelId",schemaPath:"#/properties/modelId/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate85.errors = [{instancePath:instancePath+"/modelId",schemaPath:"#/properties/modelId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.providerAccountId !== undefined){let data2: any = data.providerAccountId;const _errs8: any = errors;const _errs9: any = errors;let valid2: any = false;const _errs10: any = errors;const _errs11: any = errors;if(errors === _errs11){if(typeof data2 === "string"){if(func1(data2) > 256){const err0: any = {instancePath:instancePath+"/providerAccountId",schemaPath:"sidekicks-contracts:provider/account/record#/$defs/ProviderAccountId/maxLength",keyword:"maxLength",params:{limit: 256}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}else {if(func1(data2) < 1){const err1: any = {instancePath:instancePath+"/providerAccountId",schemaPath:"sidekicks-contracts:provider/account/record#/$defs/ProviderAccountId/minLength",keyword:"minLength",params:{limit: 1}};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}}}else {const err2: any = {instancePath:instancePath+"/providerAccountId",schemaPath:"sidekicks-contracts:provider/account/record#/$defs/ProviderAccountId/type",keyword:"type",params:{type: "string"}};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}}var _valid0: any = _errs10 === errors;valid2 = valid2 || _valid0;const _errs14: any = errors;if(data2 !== null){const err3: any = {instancePath:instancePath+"/providerAccountId",schemaPath:"#/properties/providerAccountId/anyOf/1/type",keyword:"type",params:{type: "null"}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;}var _valid0: any = _errs14 === errors;valid2 = valid2 || _valid0;if(!valid2){const err4: any = {instancePath:instancePath+"/providerAccountId",schemaPath:"#/properties/providerAccountId/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err4];}else {vErrors.push(err4);}errors++;validate85.errors = vErrors;return false;}else {errors = _errs9;if(vErrors !== null){if(_errs9){vErrors.length = _errs9;}else {vErrors = null;}}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.effort !== undefined){let data3: any = data.effort;const _errs16: any = errors;if((typeof data3 !== "string") && (data3 !== null)){validate85.errors = [{instancePath:instancePath+"/effort",schemaPath:"#/properties/effort/type",keyword:"type",params:{type: schema71.properties.effort.type}}];return false;}if(errors === _errs16){if(typeof data3 === "string"){if(func1(data3) > 128){validate85.errors = [{instancePath:instancePath+"/effort",schemaPath:"#/properties/effort/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data3) < 1){validate85.errors = [{instancePath:instancePath+"/effort",schemaPath:"#/properties/effort/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data3)){validate85.errors = [{instancePath:instancePath+"/effort",schemaPath:"#/properties/effort/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}}var valid0: any = _errs16 === errors;}else {var valid0: any = true;}if(valid0){if(data.outputSpeed !== undefined){let data4: any = data.outputSpeed;const _errs18: any = errors;if(errors === _errs18){if(typeof data4 === "string"){if(func1(data4) > 128){validate85.errors = [{instancePath:instancePath+"/outputSpeed",schemaPath:"#/properties/outputSpeed/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data4) < 1){validate85.errors = [{instancePath:instancePath+"/outputSpeed",schemaPath:"#/properties/outputSpeed/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data4)){validate85.errors = [{instancePath:instancePath+"/outputSpeed",schemaPath:"#/properties/outputSpeed/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate85.errors = [{instancePath:instancePath+"/outputSpeed",schemaPath:"#/properties/outputSpeed/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs18 === errors;}else {var valid0: any = true;}if(valid0){if(data.options !== undefined){let data5: any = data.options;const _errs20: any = errors;if(errors === _errs20){if(Array.isArray(data5)){if(data5.length < 1){validate85.errors = [{instancePath:instancePath+"/options",schemaPath:"#/properties/options/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid4: any = true;const len0: any = data5.length;for(let i0=0; i0<len0; i0++){const _errs22: any = errors;if(!(validate41.call(this, data5[i0], {instancePath:instancePath+"/options/" + i0,parentData:data5,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate41.errors : vErrors.concat(validate41.errors);errors = vErrors.length;}var valid4: any = _errs22 === errors;if(!valid4){break;}}if(valid4){let i1: any = data5.length;let j0: any;if(i1 > 1){outer0:for(;i1--;){for(j0 = i1; j0--;){if(func0(data5[i1], data5[j0])){validate85.errors = [{instancePath:instancePath+"/options",schemaPath:"#/properties/options/uniqueItems",keyword:"uniqueItems",params:{i: i1, j: j0}}];return false;break outer0;}}}}}}}else {validate85.errors = [{instancePath:instancePath+"/options",schemaPath:"#/properties/options/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs20 === errors;}else {var valid0: any = true;}if(valid0){if(data.largerWindow !== undefined){let data7: any = data.largerWindow;const _errs23: any = errors;if(!(((typeof data7 == "number") && (!(data7 % 1) && !isNaN(data7))) && (isFinite(data7)))){validate85.errors = [{instancePath:instancePath+"/largerWindow",schemaPath:"#/properties/largerWindow/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs23){if((typeof data7 == "number") && (isFinite(data7))){if(data7 > 9007199254740991 || isNaN(data7)){validate85.errors = [{instancePath:instancePath+"/largerWindow",schemaPath:"#/properties/largerWindow/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data7 < 1 || isNaN(data7)){validate85.errors = [{instancePath:instancePath+"/largerWindow",schemaPath:"#/properties/largerWindow/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs23 === errors;}else {var valid0: any = true;}}}}}}}}}}else {validate85.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate85.errors = vErrors;return errors === 0;}
// prettier-ignore
validate85.errors = null as any[] | null;
// prettier-ignore
validate85.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1894(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionCreateResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1894.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.shape === undefined) && (missing0 = "shape"))) || ((data.state === undefined) && (missing0 = "state"))) || ((data.lead === undefined) && (missing0 = "lead"))){validate1894.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((key0 === "sessionId") || (key0 === "shape")) || (key0 === "state")) || (key0 === "place")) || (key0 === "lead"))){validate1894.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1894.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1894.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.shape !== undefined){let data1: any = data.shape;const _errs6: any = errors;if(typeof data1 !== "string"){validate1894.errors = [{instancePath:instancePath+"/shape",schemaPath:"sidekicks-contracts:session/methods#/$defs/SessionShape/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data1 === "chat") || (data1 === "project"))){validate1894.errors = [{instancePath:instancePath+"/shape",schemaPath:"sidekicks-contracts:session/methods#/$defs/SessionShape/enum",keyword:"enum",params:{allowedValues: schema908.enum}}];return false;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.state !== undefined){let data2: any = data.state;const _errs9: any = errors;if(typeof data2 !== "string"){validate1894.errors = [{instancePath:instancePath+"/state",schemaPath:"sidekicks-contracts:session/methods#/$defs/SessionState/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((((data2 === "provisioning") || (data2 === "active")) || (data2 === "archived")) || (data2 === "closed")) || (data2 === "purgeRequested"))){validate1894.errors = [{instancePath:instancePath+"/state",schemaPath:"sidekicks-contracts:session/methods#/$defs/SessionState/enum",keyword:"enum",params:{allowedValues: schema1217.enum}}];return false;}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}if(valid0){if(data.place !== undefined){const _errs12: any = errors;if(!(validate1895.call(this, data.place, {instancePath:instancePath+"/place",parentData:data,parentDataProperty:"place",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1895.errors : vErrors.concat(validate1895.errors);errors = vErrors.length;}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}if(valid0){if(data.lead !== undefined){const _errs13: any = errors;if(!(validate85.call(this, data.lead, {instancePath:instancePath+"/lead",parentData:data,parentDataProperty:"lead",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate85.errors : vErrors.concat(validate85.errors);errors = vErrors.length;}var valid0: any = _errs13 === errors;}else {var valid0: any = true;}}}}}}}}else {validate1894.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1894.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1894.errors = null as any[] | null;
// prettier-ignore
validate1894.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1899(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionForkRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1899.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.anchorCursor === undefined) && (missing0 = "anchorCursor"))) || ((data.clientIdempotencyKey === undefined) && (missing0 = "clientIdempotencyKey"))){validate1899.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "sessionId") || (key0 === "anchorCursor")) || (key0 === "name")) || (key0 === "clientIdempotencyKey"))){validate1899.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1899.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1899.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.anchorCursor !== undefined){let data1: any = data.anchorCursor;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(func1(data1) > 256){validate1899.errors = [{instancePath:instancePath+"/anchorCursor",schemaPath:"sidekicks-contracts:session/id#/$defs/EventCursor/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data1) < 1){validate1899.errors = [{instancePath:instancePath+"/anchorCursor",schemaPath:"sidekicks-contracts:session/id#/$defs/EventCursor/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1899.errors = [{instancePath:instancePath+"/anchorCursor",schemaPath:"sidekicks-contracts:session/id#/$defs/EventCursor/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.name !== undefined){let data2: any = data.name;const _errs10: any = errors;if(errors === _errs10){if(typeof data2 === "string"){if(func1(data2) > 256){validate1899.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data2) < 1){validate1899.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data2)){validate1899.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1899.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.clientIdempotencyKey !== undefined){let data3: any = data.clientIdempotencyKey;const _errs12: any = errors;if(errors === _errs12){if(typeof data3 === "string"){if(!pattern222.test(data3)){validate1899.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/properties/clientIdempotencyKey/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"}}];return false;}}else {validate1899.errors = [{instancePath:instancePath+"/clientIdempotencyKey",schemaPath:"#/properties/clientIdempotencyKey/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}}}}}}}else {validate1899.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1899.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1899.errors = null as any[] | null;
// prettier-ignore
validate1899.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1900(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionForkResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1900.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.shape;if(typeof tag0 == "string"){if(tag0 === "project"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.shape === undefined) && (missing0 = "shape")) || ((data.sessionId === undefined) && (missing0 = "sessionId"))) || ((data.worktreeId === undefined) && (missing0 = "worktreeId"))){validate1900.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!(((key0 === "shape") || (key0 === "sessionId")) || (key0 === "worktreeId"))){validate1900.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.shape !== undefined){let data0: any = data.shape;const _errs5: any = errors;if(typeof data0 !== "string"){validate1900.errors = [{instancePath:instancePath+"/shape",schemaPath:"#/oneOf/0/properties/shape/type",keyword:"type",params:{type: "string"}}];return false;}if("project" !== data0){validate1900.errors = [{instancePath:instancePath+"/shape",schemaPath:"#/oneOf/0/properties/shape/const",keyword:"const",params:{allowedValue: "project"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.sessionId !== undefined){let data1: any = data.sessionId;const _errs7: any = errors;const _errs8: any = errors;if(errors === _errs8){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate1900.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1900.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}if(valid2){if(data.worktreeId !== undefined){let data2: any = data.worktreeId;const _errs11: any = errors;const _errs12: any = errors;if(errors === _errs12){if(typeof data2 === "string"){if(!pattern4.test(data2)){validate1900.errors = [{instancePath:instancePath+"/worktreeId",schemaPath:"sidekicks-contracts:worktree/lifecycle#/$defs/WorktreeId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1900.errors = [{instancePath:instancePath+"/worktreeId",schemaPath:"sidekicks-contracts:worktree/lifecycle#/$defs/WorktreeId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs11 === errors;}else {var valid2: any = true;}}}}}}else {validate1900.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "chat"){const _errs15: any = errors;if(errors === _errs15){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((data.shape === undefined) && (missing1 = "shape")) || ((data.sessionId === undefined) && (missing1 = "sessionId"))){validate1900.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs17: any = errors;for(const key1 in data){if(!((key1 === "shape") || (key1 === "sessionId"))){validate1900.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs17 === errors){if(data.shape !== undefined){let data3: any = data.shape;const _errs18: any = errors;if(typeof data3 !== "string"){validate1900.errors = [{instancePath:instancePath+"/shape",schemaPath:"#/oneOf/1/properties/shape/type",keyword:"type",params:{type: "string"}}];return false;}if("chat" !== data3){validate1900.errors = [{instancePath:instancePath+"/shape",schemaPath:"#/oneOf/1/properties/shape/const",keyword:"const",params:{allowedValue: "chat"}}];return false;}var valid6: any = _errs18 === errors;}else {var valid6: any = true;}if(valid6){if(data.sessionId !== undefined){let data4: any = data.sessionId;const _errs20: any = errors;const _errs21: any = errors;if(errors === _errs21){if(typeof data4 === "string"){if(!pattern4.test(data4)){validate1900.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1900.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid6: any = _errs20 === errors;}else {var valid6: any = true;}}}}}else {validate1900.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid5: any = _errs15 === errors;if(props0 !== true){props0 = true;}valid0 = valid5;}else {validate1900.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "shape", tagValue: tag0}}];return false;}}else {validate1900.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "shape", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key2 in data){if(!props0 || !props0[key2]){validate1900.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key2}}];return false;break;}}}}}else {validate1900.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1900.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1900.errors = null as any[] | null;
// prettier-ignore
validate1900.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema3777: any = {"oneOf":[{"type":"object","additionalProperties":false,"properties":{"shape":{"type":"string","const":"project"},"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session."},"name":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"Its name; absent while untitled, when the row shows `firstMessagePreview`."},"firstMessagePreview":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"The first message's opening; absent before the first message."},"state":{"$ref":"sidekicks-contracts:session/methods#/$defs/SessionState","description":"Its lifecycle state; archived and closed sessions sit in the `Archived` group."},"activity":{"$ref":"#/$defs/SessionActivity","description":"The row's state word."},"activityRenewedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When the daemon last published `activity`."},"pinnedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"Present exactly while the session is pinned; pinned rows sit in pin order."},"muted":{"type":"boolean","description":"Whether the person muted the session's notifications."},"exchange":{"$ref":"#/$defs/SessionExchange","description":"Present while the session trades messages with another."},"lastActivityAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"The age the row shows."},"projectId":{"$ref":"sidekicks-contracts:project#/$defs/ProjectId","description":"The project."},"branch":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","description":"The branch the daemon holds for the session, so the row costs no git read."},"group":{"$ref":"#/$defs/SessionListGroup","description":"The group it sits in."}},"required":["shape","sessionId","state","activity","activityRenewedAt","muted","lastActivityAt","projectId"],"description":"A project session."},{"type":"object","additionalProperties":false,"properties":{"shape":{"type":"string","const":"chat"},"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session."},"name":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"Its name; absent while untitled, when the row shows `firstMessagePreview`."},"firstMessagePreview":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":256,"description":"The first message's opening; absent before the first message."},"state":{"$ref":"sidekicks-contracts:session/methods#/$defs/SessionState","description":"Its lifecycle state; archived and closed sessions sit in the `Archived` group."},"activity":{"$ref":"#/$defs/SessionActivity","description":"The row's state word."},"activityRenewedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When the daemon last published `activity`."},"pinnedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"Present exactly while the session is pinned; pinned rows sit in pin order."},"muted":{"type":"boolean","description":"Whether the person muted the session's notifications."},"exchange":{"$ref":"#/$defs/SessionExchange","description":"Present while the session trades messages with another."},"lastActivityAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"The age the row shows."},"documentCount":{"type":"integer","minimum":0,"maximum":9007199254740991,"description":"The files in the chat's folder; absent while the folder is being made."}},"required":["shape","sessionId","state","activity","activityRenewedAt","muted","lastActivityAt"],"description":"A chat."}],"description":"One row of the sessions list, everything the row draws from one feed so the list opens no\nstream per session, split on `shape`.","discriminator":{"propertyName":"shape"},"type":"object","unevaluatedProperties":false};
// prettier-ignore
const schema3780: any = {"description":"What a session is doing, as the daemon derives it: exactly one of five, and no client invents a\nsixth. `waiting` is waiting on the person; `failed` is a session that died, kept apart from one\nthat finished (`done`).","type":"string","enum":["running","waiting","done","failed","idle"]};
// prettier-ignore
const func2 = Object.prototype.hasOwnProperty;
// prettier-ignore
const pattern5 = new RegExp("^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$", "u");
// prettier-ignore
function validate1903(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1903.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.peerSessionId === undefined) && (missing0 = "peerSessionId")) || ((data.peerName === undefined) && (missing0 = "peerName"))) || ((data.messageCount === undefined) && (missing0 = "messageCount"))){validate1903.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "peerSessionId") || (key0 === "peerName")) || (key0 === "messageCount"))){validate1903.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.peerSessionId !== undefined){let data0: any = data.peerSessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1903.errors = [{instancePath:instancePath+"/peerSessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1903.errors = [{instancePath:instancePath+"/peerSessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.peerName !== undefined){let data1: any = data.peerName;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(func1(data1) > 256){validate1903.errors = [{instancePath:instancePath+"/peerName",schemaPath:"#/properties/peerName/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data1) < 1){validate1903.errors = [{instancePath:instancePath+"/peerName",schemaPath:"#/properties/peerName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data1)){validate1903.errors = [{instancePath:instancePath+"/peerName",schemaPath:"#/properties/peerName/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1903.errors = [{instancePath:instancePath+"/peerName",schemaPath:"#/properties/peerName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.messageCount !== undefined){let data2: any = data.messageCount;const _errs8: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validate1903.errors = [{instancePath:instancePath+"/messageCount",schemaPath:"#/properties/messageCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs8){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validate1903.errors = [{instancePath:instancePath+"/messageCount",schemaPath:"#/properties/messageCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 1 || isNaN(data2)){validate1903.errors = [{instancePath:instancePath+"/messageCount",schemaPath:"#/properties/messageCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}}}}}}else {validate1903.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1903.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1903.errors = null as any[] | null;
// prettier-ignore
validate1903.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1905(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1905.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.groupId === undefined) && (missing0 = "groupId")) || ((data.name === undefined) && (missing0 = "name"))){validate1905.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "groupId") || (key0 === "name"))){validate1905.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.groupId !== undefined){let data0: any = data.groupId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1905.errors = [{instancePath:instancePath+"/groupId",schemaPath:"sidekicks-contracts:session/groups#/$defs/SessionGroupId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1905.errors = [{instancePath:instancePath+"/groupId",schemaPath:"sidekicks-contracts:session/groups#/$defs/SessionGroupId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.name !== undefined){let data1: any = data.name;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(func1(data1) > 256){validate1905.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data1) < 1){validate1905.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data1)){validate1905.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1905.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate1905.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1905.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1905.errors = null as any[] | null;
// prettier-ignore
validate1905.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1902(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1902.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.shape;if(typeof tag0 == "string"){if(tag0 === "project"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((((((data.shape === undefined) && (missing0 = "shape")) || ((data.sessionId === undefined) && (missing0 = "sessionId"))) || ((data.state === undefined) && (missing0 = "state"))) || ((data.activity === undefined) && (missing0 = "activity"))) || ((data.activityRenewedAt === undefined) && (missing0 = "activityRenewedAt"))) || ((data.muted === undefined) && (missing0 = "muted"))) || ((data.lastActivityAt === undefined) && (missing0 = "lastActivityAt"))) || ((data.projectId === undefined) && (missing0 = "projectId"))){validate1902.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!(func2.call(schema3777.oneOf[0].properties, key0))){validate1902.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.shape !== undefined){let data0: any = data.shape;const _errs5: any = errors;if(typeof data0 !== "string"){validate1902.errors = [{instancePath:instancePath+"/shape",schemaPath:"#/oneOf/0/properties/shape/type",keyword:"type",params:{type: "string"}}];return false;}if("project" !== data0){validate1902.errors = [{instancePath:instancePath+"/shape",schemaPath:"#/oneOf/0/properties/shape/const",keyword:"const",params:{allowedValue: "project"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.sessionId !== undefined){let data1: any = data.sessionId;const _errs7: any = errors;const _errs8: any = errors;if(errors === _errs8){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate1902.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1902.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}if(valid2){if(data.name !== undefined){let data2: any = data.name;const _errs11: any = errors;if(errors === _errs11){if(typeof data2 === "string"){if(func1(data2) > 256){validate1902.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/0/properties/name/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data2) < 1){validate1902.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/0/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data2)){validate1902.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/0/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1902.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/0/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs11 === errors;}else {var valid2: any = true;}if(valid2){if(data.firstMessagePreview !== undefined){let data3: any = data.firstMessagePreview;const _errs13: any = errors;if(errors === _errs13){if(typeof data3 === "string"){if(func1(data3) > 256){validate1902.errors = [{instancePath:instancePath+"/firstMessagePreview",schemaPath:"#/oneOf/0/properties/firstMessagePreview/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data3) < 1){validate1902.errors = [{instancePath:instancePath+"/firstMessagePreview",schemaPath:"#/oneOf/0/properties/firstMessagePreview/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data3)){validate1902.errors = [{instancePath:instancePath+"/firstMessagePreview",schemaPath:"#/oneOf/0/properties/firstMessagePreview/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1902.errors = [{instancePath:instancePath+"/firstMessagePreview",schemaPath:"#/oneOf/0/properties/firstMessagePreview/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs13 === errors;}else {var valid2: any = true;}if(valid2){if(data.state !== undefined){let data4: any = data.state;const _errs15: any = errors;if(typeof data4 !== "string"){validate1902.errors = [{instancePath:instancePath+"/state",schemaPath:"sidekicks-contracts:session/methods#/$defs/SessionState/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((((data4 === "provisioning") || (data4 === "active")) || (data4 === "archived")) || (data4 === "closed")) || (data4 === "purgeRequested"))){validate1902.errors = [{instancePath:instancePath+"/state",schemaPath:"sidekicks-contracts:session/methods#/$defs/SessionState/enum",keyword:"enum",params:{allowedValues: schema1217.enum}}];return false;}var valid2: any = _errs15 === errors;}else {var valid2: any = true;}if(valid2){if(data.activity !== undefined){let data5: any = data.activity;const _errs18: any = errors;if(typeof data5 !== "string"){validate1902.errors = [{instancePath:instancePath+"/activity",schemaPath:"#/$defs/SessionActivity/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((((data5 === "running") || (data5 === "waiting")) || (data5 === "done")) || (data5 === "failed")) || (data5 === "idle"))){validate1902.errors = [{instancePath:instancePath+"/activity",schemaPath:"#/$defs/SessionActivity/enum",keyword:"enum",params:{allowedValues: schema3780.enum}}];return false;}var valid2: any = _errs18 === errors;}else {var valid2: any = true;}if(valid2){if(data.activityRenewedAt !== undefined){let data6: any = data.activityRenewedAt;const _errs21: any = errors;const _errs22: any = errors;if(errors === _errs22){if(typeof data6 === "string"){if(!pattern5.test(data6)){validate1902.errors = [{instancePath:instancePath+"/activityRenewedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}}];return false;}}else {validate1902.errors = [{instancePath:instancePath+"/activityRenewedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs21 === errors;}else {var valid2: any = true;}if(valid2){if(data.pinnedAt !== undefined){let data7: any = data.pinnedAt;const _errs24: any = errors;const _errs25: any = errors;if(errors === _errs25){if(typeof data7 === "string"){if(!pattern5.test(data7)){validate1902.errors = [{instancePath:instancePath+"/pinnedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}}];return false;}}else {validate1902.errors = [{instancePath:instancePath+"/pinnedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs24 === errors;}else {var valid2: any = true;}if(valid2){if(data.muted !== undefined){const _errs27: any = errors;if(typeof data.muted !== "boolean"){validate1902.errors = [{instancePath:instancePath+"/muted",schemaPath:"#/oneOf/0/properties/muted/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid2: any = _errs27 === errors;}else {var valid2: any = true;}if(valid2){if(data.exchange !== undefined){const _errs29: any = errors;if(!(validate1903.call(this, data.exchange, {instancePath:instancePath+"/exchange",parentData:data,parentDataProperty:"exchange",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1903.errors : vErrors.concat(validate1903.errors);errors = vErrors.length;}var valid2: any = _errs29 === errors;}else {var valid2: any = true;}if(valid2){if(data.lastActivityAt !== undefined){let data10: any = data.lastActivityAt;const _errs30: any = errors;const _errs31: any = errors;if(errors === _errs31){if(typeof data10 === "string"){if(!pattern5.test(data10)){validate1902.errors = [{instancePath:instancePath+"/lastActivityAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}}];return false;}}else {validate1902.errors = [{instancePath:instancePath+"/lastActivityAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs30 === errors;}else {var valid2: any = true;}if(valid2){if(data.projectId !== undefined){let data11: any = data.projectId;const _errs33: any = errors;const _errs34: any = errors;if(errors === _errs34){if(typeof data11 === "string"){if(!pattern4.test(data11)){validate1902.errors = [{instancePath:instancePath+"/projectId",schemaPath:"sidekicks-contracts:project#/$defs/ProjectId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1902.errors = [{instancePath:instancePath+"/projectId",schemaPath:"sidekicks-contracts:project#/$defs/ProjectId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs33 === errors;}else {var valid2: any = true;}if(valid2){if(data.branch !== undefined){let data12: any = data.branch;const _errs37: any = errors;if(errors === _errs37){if(typeof data12 === "string"){if(func1(data12) < 1){validate1902.errors = [{instancePath:instancePath+"/branch",schemaPath:"#/oneOf/0/properties/branch/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data12)){validate1902.errors = [{instancePath:instancePath+"/branch",schemaPath:"#/oneOf/0/properties/branch/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}else {validate1902.errors = [{instancePath:instancePath+"/branch",schemaPath:"#/oneOf/0/properties/branch/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs37 === errors;}else {var valid2: any = true;}if(valid2){if(data.group !== undefined){const _errs39: any = errors;if(!(validate1905.call(this, data.group, {instancePath:instancePath+"/group",parentData:data,parentDataProperty:"group",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1905.errors : vErrors.concat(validate1905.errors);errors = vErrors.length;}var valid2: any = _errs39 === errors;}else {var valid2: any = true;}}}}}}}}}}}}}}}}}else {validate1902.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "chat"){const _errs40: any = errors;if(errors === _errs40){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((((((data.shape === undefined) && (missing1 = "shape")) || ((data.sessionId === undefined) && (missing1 = "sessionId"))) || ((data.state === undefined) && (missing1 = "state"))) || ((data.activity === undefined) && (missing1 = "activity"))) || ((data.activityRenewedAt === undefined) && (missing1 = "activityRenewedAt"))) || ((data.muted === undefined) && (missing1 = "muted"))) || ((data.lastActivityAt === undefined) && (missing1 = "lastActivityAt"))){validate1902.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs42: any = errors;for(const key1 in data){if(!(func2.call(schema3777.oneOf[1].properties, key1))){validate1902.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs42 === errors){if(data.shape !== undefined){let data14: any = data.shape;const _errs43: any = errors;if(typeof data14 !== "string"){validate1902.errors = [{instancePath:instancePath+"/shape",schemaPath:"#/oneOf/1/properties/shape/type",keyword:"type",params:{type: "string"}}];return false;}if("chat" !== data14){validate1902.errors = [{instancePath:instancePath+"/shape",schemaPath:"#/oneOf/1/properties/shape/const",keyword:"const",params:{allowedValue: "chat"}}];return false;}var valid11: any = _errs43 === errors;}else {var valid11: any = true;}if(valid11){if(data.sessionId !== undefined){let data15: any = data.sessionId;const _errs45: any = errors;const _errs46: any = errors;if(errors === _errs46){if(typeof data15 === "string"){if(!pattern4.test(data15)){validate1902.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1902.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid11: any = _errs45 === errors;}else {var valid11: any = true;}if(valid11){if(data.name !== undefined){let data16: any = data.name;const _errs49: any = errors;if(errors === _errs49){if(typeof data16 === "string"){if(func1(data16) > 256){validate1902.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/1/properties/name/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data16) < 1){validate1902.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/1/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data16)){validate1902.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/1/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1902.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/1/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid11: any = _errs49 === errors;}else {var valid11: any = true;}if(valid11){if(data.firstMessagePreview !== undefined){let data17: any = data.firstMessagePreview;const _errs51: any = errors;if(errors === _errs51){if(typeof data17 === "string"){if(func1(data17) > 256){validate1902.errors = [{instancePath:instancePath+"/firstMessagePreview",schemaPath:"#/oneOf/1/properties/firstMessagePreview/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data17) < 1){validate1902.errors = [{instancePath:instancePath+"/firstMessagePreview",schemaPath:"#/oneOf/1/properties/firstMessagePreview/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data17)){validate1902.errors = [{instancePath:instancePath+"/firstMessagePreview",schemaPath:"#/oneOf/1/properties/firstMessagePreview/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1902.errors = [{instancePath:instancePath+"/firstMessagePreview",schemaPath:"#/oneOf/1/properties/firstMessagePreview/type",keyword:"type",params:{type: "string"}}];return false;}}var valid11: any = _errs51 === errors;}else {var valid11: any = true;}if(valid11){if(data.state !== undefined){let data18: any = data.state;const _errs53: any = errors;if(typeof data18 !== "string"){validate1902.errors = [{instancePath:instancePath+"/state",schemaPath:"sidekicks-contracts:session/methods#/$defs/SessionState/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((((data18 === "provisioning") || (data18 === "active")) || (data18 === "archived")) || (data18 === "closed")) || (data18 === "purgeRequested"))){validate1902.errors = [{instancePath:instancePath+"/state",schemaPath:"sidekicks-contracts:session/methods#/$defs/SessionState/enum",keyword:"enum",params:{allowedValues: schema1217.enum}}];return false;}var valid11: any = _errs53 === errors;}else {var valid11: any = true;}if(valid11){if(data.activity !== undefined){let data19: any = data.activity;const _errs56: any = errors;if(typeof data19 !== "string"){validate1902.errors = [{instancePath:instancePath+"/activity",schemaPath:"#/$defs/SessionActivity/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((((data19 === "running") || (data19 === "waiting")) || (data19 === "done")) || (data19 === "failed")) || (data19 === "idle"))){validate1902.errors = [{instancePath:instancePath+"/activity",schemaPath:"#/$defs/SessionActivity/enum",keyword:"enum",params:{allowedValues: schema3780.enum}}];return false;}var valid11: any = _errs56 === errors;}else {var valid11: any = true;}if(valid11){if(data.activityRenewedAt !== undefined){let data20: any = data.activityRenewedAt;const _errs59: any = errors;const _errs60: any = errors;if(errors === _errs60){if(typeof data20 === "string"){if(!pattern5.test(data20)){validate1902.errors = [{instancePath:instancePath+"/activityRenewedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}}];return false;}}else {validate1902.errors = [{instancePath:instancePath+"/activityRenewedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}}];return false;}}var valid11: any = _errs59 === errors;}else {var valid11: any = true;}if(valid11){if(data.pinnedAt !== undefined){let data21: any = data.pinnedAt;const _errs62: any = errors;const _errs63: any = errors;if(errors === _errs63){if(typeof data21 === "string"){if(!pattern5.test(data21)){validate1902.errors = [{instancePath:instancePath+"/pinnedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}}];return false;}}else {validate1902.errors = [{instancePath:instancePath+"/pinnedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}}];return false;}}var valid11: any = _errs62 === errors;}else {var valid11: any = true;}if(valid11){if(data.muted !== undefined){const _errs65: any = errors;if(typeof data.muted !== "boolean"){validate1902.errors = [{instancePath:instancePath+"/muted",schemaPath:"#/oneOf/1/properties/muted/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid11: any = _errs65 === errors;}else {var valid11: any = true;}if(valid11){if(data.exchange !== undefined){const _errs67: any = errors;if(!(validate1903.call(this, data.exchange, {instancePath:instancePath+"/exchange",parentData:data,parentDataProperty:"exchange",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1903.errors : vErrors.concat(validate1903.errors);errors = vErrors.length;}var valid11: any = _errs67 === errors;}else {var valid11: any = true;}if(valid11){if(data.lastActivityAt !== undefined){let data24: any = data.lastActivityAt;const _errs68: any = errors;const _errs69: any = errors;if(errors === _errs69){if(typeof data24 === "string"){if(!pattern5.test(data24)){validate1902.errors = [{instancePath:instancePath+"/lastActivityAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}}];return false;}}else {validate1902.errors = [{instancePath:instancePath+"/lastActivityAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}}];return false;}}var valid11: any = _errs68 === errors;}else {var valid11: any = true;}if(valid11){if(data.documentCount !== undefined){let data25: any = data.documentCount;const _errs71: any = errors;if(!(((typeof data25 == "number") && (!(data25 % 1) && !isNaN(data25))) && (isFinite(data25)))){validate1902.errors = [{instancePath:instancePath+"/documentCount",schemaPath:"#/oneOf/1/properties/documentCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs71){if((typeof data25 == "number") && (isFinite(data25))){if(data25 > 9007199254740991 || isNaN(data25)){validate1902.errors = [{instancePath:instancePath+"/documentCount",schemaPath:"#/oneOf/1/properties/documentCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data25 < 0 || isNaN(data25)){validate1902.errors = [{instancePath:instancePath+"/documentCount",schemaPath:"#/oneOf/1/properties/documentCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid11: any = _errs71 === errors;}else {var valid11: any = true;}}}}}}}}}}}}}}}else {validate1902.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid10: any = _errs40 === errors;if(props0 !== true){props0 = true;}valid0 = valid10;}else {validate1902.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "shape", tagValue: tag0}}];return false;}}else {validate1902.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "shape", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key2 in data){if(!props0 || !props0[key2]){validate1902.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key2}}];return false;break;}}}}}else {validate1902.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1902.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1902.errors = null as any[] | null;
// prettier-ignore
validate1902.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1901(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionListChange {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1901.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.kind;if(typeof tag0 == "string"){if(tag0 === "page"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.kind === undefined) && (missing0 = "kind")) || ((data.sessions === undefined) && (missing0 = "sessions"))) || ((data.chatCount === undefined) && (missing0 = "chatCount"))) || ((data.isComplete === undefined) && (missing0 = "isComplete"))){validate1901.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!((((key0 === "kind") || (key0 === "sessions")) || (key0 === "chatCount")) || (key0 === "isComplete"))){validate1901.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.kind !== undefined){let data0: any = data.kind;const _errs5: any = errors;if(typeof data0 !== "string"){validate1901.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("page" !== data0){validate1901.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/0/properties/kind/const",keyword:"const",params:{allowedValue: "page"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.sessions !== undefined){let data1: any = data.sessions;const _errs7: any = errors;if(wireByteLength(data1, this && this.attachments) > 991808){validate1901.errors = [{instancePath:instancePath+"/sessions",schemaPath:"#/oneOf/0/properties/sessions/maxJsonBytes",keyword:"maxJsonBytes",params:{}}];return false;}if(errors === _errs7){if(Array.isArray(data1)){if(data1.length < 1){validate1901.errors = [{instancePath:instancePath+"/sessions",schemaPath:"#/oneOf/0/properties/sessions/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid3: any = true;const len0: any = data1.length;for(let i0=0; i0<len0; i0++){const _errs9: any = errors;if(!(validate1902.call(this, data1[i0], {instancePath:instancePath+"/sessions/" + i0,parentData:data1,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1902.errors : vErrors.concat(validate1902.errors);errors = vErrors.length;}var valid3: any = _errs9 === errors;if(!valid3){break;}}}}else {validate1901.errors = [{instancePath:instancePath+"/sessions",schemaPath:"#/oneOf/0/properties/sessions/type",keyword:"type",params:{type: "array"}}];return false;}}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}if(valid2){if(data.chatCount !== undefined){let data3: any = data.chatCount;const _errs10: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validate1901.errors = [{instancePath:instancePath+"/chatCount",schemaPath:"#/oneOf/0/properties/chatCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs10){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 9007199254740991 || isNaN(data3)){validate1901.errors = [{instancePath:instancePath+"/chatCount",schemaPath:"#/oneOf/0/properties/chatCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data3 < 0 || isNaN(data3)){validate1901.errors = [{instancePath:instancePath+"/chatCount",schemaPath:"#/oneOf/0/properties/chatCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid2: any = _errs10 === errors;}else {var valid2: any = true;}if(valid2){if(data.isComplete !== undefined){const _errs12: any = errors;if(typeof data.isComplete !== "boolean"){validate1901.errors = [{instancePath:instancePath+"/isComplete",schemaPath:"#/oneOf/0/properties/isComplete/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid2: any = _errs12 === errors;}else {var valid2: any = true;}}}}}}}else {validate1901.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "upsert"){const _errs14: any = errors;if(errors === _errs14){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((data.kind === undefined) && (missing1 = "kind")) || ((data.entry === undefined) && (missing1 = "entry"))) || ((data.chatCount === undefined) && (missing1 = "chatCount"))){validate1901.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs16: any = errors;for(const key1 in data){if(!(((key1 === "kind") || (key1 === "entry")) || (key1 === "chatCount"))){validate1901.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs16 === errors){if(data.kind !== undefined){let data5: any = data.kind;const _errs17: any = errors;if(typeof data5 !== "string"){validate1901.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("upsert" !== data5){validate1901.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/1/properties/kind/const",keyword:"const",params:{allowedValue: "upsert"}}];return false;}var valid5: any = _errs17 === errors;}else {var valid5: any = true;}if(valid5){if(data.entry !== undefined){const _errs19: any = errors;if(!(validate1902.call(this, data.entry, {instancePath:instancePath+"/entry",parentData:data,parentDataProperty:"entry",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1902.errors : vErrors.concat(validate1902.errors);errors = vErrors.length;}var valid5: any = _errs19 === errors;}else {var valid5: any = true;}if(valid5){if(data.chatCount !== undefined){let data7: any = data.chatCount;const _errs20: any = errors;if(!(((typeof data7 == "number") && (!(data7 % 1) && !isNaN(data7))) && (isFinite(data7)))){validate1901.errors = [{instancePath:instancePath+"/chatCount",schemaPath:"#/oneOf/1/properties/chatCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs20){if((typeof data7 == "number") && (isFinite(data7))){if(data7 > 9007199254740991 || isNaN(data7)){validate1901.errors = [{instancePath:instancePath+"/chatCount",schemaPath:"#/oneOf/1/properties/chatCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data7 < 0 || isNaN(data7)){validate1901.errors = [{instancePath:instancePath+"/chatCount",schemaPath:"#/oneOf/1/properties/chatCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid5: any = _errs20 === errors;}else {var valid5: any = true;}}}}}}else {validate1901.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid4: any = _errs14 === errors;if(props0 !== true){props0 = true;}valid0 = valid4;}else if(tag0 === "remove"){const _errs22: any = errors;if(errors === _errs22){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if((((data.kind === undefined) && (missing2 = "kind")) || ((data.sessionId === undefined) && (missing2 = "sessionId"))) || ((data.chatCount === undefined) && (missing2 = "chatCount"))){validate1901.errors = [{instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs24: any = errors;for(const key2 in data){if(!(((key2 === "kind") || (key2 === "sessionId")) || (key2 === "chatCount"))){validate1901.errors = [{instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs24 === errors){if(data.kind !== undefined){let data8: any = data.kind;const _errs25: any = errors;if(typeof data8 !== "string"){validate1901.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/type",keyword:"type",params:{type: "string"}}];return false;}if("remove" !== data8){validate1901.errors = [{instancePath:instancePath+"/kind",schemaPath:"#/oneOf/2/properties/kind/const",keyword:"const",params:{allowedValue: "remove"}}];return false;}var valid7: any = _errs25 === errors;}else {var valid7: any = true;}if(valid7){if(data.sessionId !== undefined){let data9: any = data.sessionId;const _errs27: any = errors;const _errs28: any = errors;if(errors === _errs28){if(typeof data9 === "string"){if(!pattern4.test(data9)){validate1901.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1901.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid7: any = _errs27 === errors;}else {var valid7: any = true;}if(valid7){if(data.chatCount !== undefined){let data10: any = data.chatCount;const _errs31: any = errors;if(!(((typeof data10 == "number") && (!(data10 % 1) && !isNaN(data10))) && (isFinite(data10)))){validate1901.errors = [{instancePath:instancePath+"/chatCount",schemaPath:"#/oneOf/2/properties/chatCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs31){if((typeof data10 == "number") && (isFinite(data10))){if(data10 > 9007199254740991 || isNaN(data10)){validate1901.errors = [{instancePath:instancePath+"/chatCount",schemaPath:"#/oneOf/2/properties/chatCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data10 < 0 || isNaN(data10)){validate1901.errors = [{instancePath:instancePath+"/chatCount",schemaPath:"#/oneOf/2/properties/chatCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid7: any = _errs31 === errors;}else {var valid7: any = true;}}}}}}else {validate1901.errors = [{instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}var valid6: any = _errs22 === errors;if(props0 !== true){props0 = true;}valid0 = valid6;}else {validate1901.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "kind", tagValue: tag0}}];return false;}}else {validate1901.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "kind", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key3 in data){if(!props0 || !props0[key3]){validate1901.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key3}}];return false;break;}}}}}else {validate1901.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1901.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1901.errors = null as any[] | null;
// prettier-ignore
validate1901.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1910(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionOverviewReadRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1910.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.afterRevision === undefined) && (missing0 = "afterRevision")){validate1910.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "afterRevision")){validate1910.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.afterRevision !== undefined){let data0: any = data.afterRevision;const _errs2: any = errors;if(!(((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0))) && (isFinite(data0)))){validate1910.errors = [{instancePath:instancePath+"/afterRevision",schemaPath:"#/properties/afterRevision/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs2){if((typeof data0 == "number") && (isFinite(data0))){if(data0 > 9007199254740991 || isNaN(data0)){validate1910.errors = [{instancePath:instancePath+"/afterRevision",schemaPath:"#/properties/afterRevision/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data0 < 0 || isNaN(data0)){validate1910.errors = [{instancePath:instancePath+"/afterRevision",schemaPath:"#/properties/afterRevision/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}}}}}else {validate1910.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1910.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1910.errors = null as any[] | null;
// prettier-ignore
validate1910.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema3805: any = {"description":"Whether Remote Control is on.","type":"string","enum":["on","off"]};
// prettier-ignore
function validate1913(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1913.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.name === undefined) && (missing0 = "name")) || ((data.provider === undefined) && (missing0 = "provider"))) || ((data.state === undefined) && (missing0 = "state"))){validate1913.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "name") || (key0 === "provider")) || (key0 === "state"))){validate1913.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.name !== undefined){let data0: any = data.name;const _errs2: any = errors;if(errors === _errs2){if(typeof data0 === "string"){if(func1(data0) > 128){validate1913.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data0) < 1){validate1913.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data0)){validate1913.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1913.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.provider !== undefined){let data1: any = data.provider;const _errs4: any = errors;const _errs5: any = errors;if(errors === _errs5){if(typeof data1 === "string"){if(!pattern16.test(data1)){validate1913.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}}];return false;}}else {validate1913.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.state !== undefined){let data2: any = data.state;const _errs8: any = errors;if(typeof data2 !== "string"){validate1913.errors = [{instancePath:instancePath+"/state",schemaPath:"#/$defs/SessionActivity/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((((data2 === "running") || (data2 === "waiting")) || (data2 === "done")) || (data2 === "failed")) || (data2 === "idle"))){validate1913.errors = [{instancePath:instancePath+"/state",schemaPath:"#/$defs/SessionActivity/enum",keyword:"enum",params:{allowedValues: schema3780.enum}}];return false;}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}}}}}}else {validate1913.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1913.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1913.errors = null as any[] | null;
// prettier-ignore
validate1913.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1912(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1912.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.id === undefined) && (missing0 = "id")) || ((data.provider === undefined) && (missing0 = "provider"))) || ((data.state === undefined) && (missing0 = "state"))) || ((data.agents === undefined) && (missing0 = "agents"))){validate1912.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((key0 === "id") || (key0 === "title")) || (key0 === "provider")) || (key0 === "state")) || (key0 === "agents"))){validate1912.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.id !== undefined){let data0: any = data.id;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1912.errors = [{instancePath:instancePath+"/id",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1912.errors = [{instancePath:instancePath+"/id",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.title !== undefined){let data1: any = data.title;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(func1(data1) > 256){validate1912.errors = [{instancePath:instancePath+"/title",schemaPath:"#/properties/title/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data1) < 1){validate1912.errors = [{instancePath:instancePath+"/title",schemaPath:"#/properties/title/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data1)){validate1912.errors = [{instancePath:instancePath+"/title",schemaPath:"#/properties/title/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1912.errors = [{instancePath:instancePath+"/title",schemaPath:"#/properties/title/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.provider !== undefined){let data2: any = data.provider;const _errs8: any = errors;const _errs9: any = errors;if(errors === _errs9){if(typeof data2 === "string"){if(!pattern16.test(data2)){validate1912.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}}];return false;}}else {validate1912.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.state !== undefined){let data3: any = data.state;const _errs12: any = errors;if(typeof data3 !== "string"){validate1912.errors = [{instancePath:instancePath+"/state",schemaPath:"#/$defs/SessionActivity/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((((data3 === "running") || (data3 === "waiting")) || (data3 === "done")) || (data3 === "failed")) || (data3 === "idle"))){validate1912.errors = [{instancePath:instancePath+"/state",schemaPath:"#/$defs/SessionActivity/enum",keyword:"enum",params:{allowedValues: schema3780.enum}}];return false;}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}if(valid0){if(data.agents !== undefined){let data4: any = data.agents;const _errs15: any = errors;if(errors === _errs15){if(Array.isArray(data4)){var valid4: any = true;const len0: any = data4.length;for(let i0=0; i0<len0; i0++){const _errs17: any = errors;if(!(validate1913.call(this, data4[i0], {instancePath:instancePath+"/agents/" + i0,parentData:data4,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1913.errors : vErrors.concat(validate1913.errors);errors = vErrors.length;}var valid4: any = _errs17 === errors;if(!valid4){break;}}}else {validate1912.errors = [{instancePath:instancePath+"/agents",schemaPath:"#/properties/agents/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs15 === errors;}else {var valid0: any = true;}}}}}}}}else {validate1912.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1912.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1912.errors = null as any[] | null;
// prettier-ignore
validate1912.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1911(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionOverviewReadResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1911.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.revision === undefined) && (missing0 = "revision")) || ((data.sessions === undefined) && (missing0 = "sessions"))) || ((data.remoteControl === undefined) && (missing0 = "remoteControl"))){validate1911.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "revision") || (key0 === "sessions")) || (key0 === "remoteControl"))){validate1911.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.revision !== undefined){let data0: any = data.revision;const _errs2: any = errors;if(!(((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0))) && (isFinite(data0)))){validate1911.errors = [{instancePath:instancePath+"/revision",schemaPath:"#/properties/revision/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs2){if((typeof data0 == "number") && (isFinite(data0))){if(data0 > 9007199254740991 || isNaN(data0)){validate1911.errors = [{instancePath:instancePath+"/revision",schemaPath:"#/properties/revision/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data0 < 0 || isNaN(data0)){validate1911.errors = [{instancePath:instancePath+"/revision",schemaPath:"#/properties/revision/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.sessions !== undefined){let data1: any = data.sessions;const _errs4: any = errors;if(errors === _errs4){if(Array.isArray(data1)){var valid1: any = true;const len0: any = data1.length;for(let i0=0; i0<len0; i0++){const _errs6: any = errors;if(!(validate1912.call(this, data1[i0], {instancePath:instancePath+"/sessions/" + i0,parentData:data1,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1912.errors : vErrors.concat(validate1912.errors);errors = vErrors.length;}var valid1: any = _errs6 === errors;if(!valid1){break;}}}else {validate1911.errors = [{instancePath:instancePath+"/sessions",schemaPath:"#/properties/sessions/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.remoteControl !== undefined){let data3: any = data.remoteControl;const _errs7: any = errors;if(errors === _errs7){if(data3 && typeof data3 == "object" && !Array.isArray(data3)){let missing1: any;if((data3.state === undefined) && (missing1 = "state")){validate1911.errors = [{instancePath:instancePath+"/remoteControl",schemaPath:"#/properties/remoteControl/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs9: any = errors;for(const key1 in data3){if(!(key1 === "state")){validate1911.errors = [{instancePath:instancePath+"/remoteControl",schemaPath:"#/properties/remoteControl/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs9 === errors){if(data3.state !== undefined){let data4: any = data3.state;if(typeof data4 !== "string"){validate1911.errors = [{instancePath:instancePath+"/remoteControl/state",schemaPath:"#/$defs/RemoteControlState/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data4 === "on") || (data4 === "off"))){validate1911.errors = [{instancePath:instancePath+"/remoteControl/state",schemaPath:"#/$defs/RemoteControlState/enum",keyword:"enum",params:{allowedValues: schema3805.enum}}];return false;}}}}}else {validate1911.errors = [{instancePath:instancePath+"/remoteControl",schemaPath:"#/properties/remoteControl/type",keyword:"type",params:{type: "object"}}];return false;}}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}}}}}}else {validate1911.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1911.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1911.errors = null as any[] | null;
// prettier-ignore
validate1911.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate1916(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionSubscribeResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1916.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.subscriptionId === undefined) && (missing0 = "subscriptionId")) || ((data.sessions === undefined) && (missing0 = "sessions"))) || ((data.chatCount === undefined) && (missing0 = "chatCount"))) || ((data.isComplete === undefined) && (missing0 = "isComplete"))){validate1916.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "subscriptionId") || (key0 === "sessions")) || (key0 === "chatCount")) || (key0 === "isComplete"))){validate1916.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.subscriptionId !== undefined){let data0: any = data.subscriptionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1916.errors = [{instancePath:instancePath+"/subscriptionId",schemaPath:"sidekicks-contracts:jsonrpc/streaming#/$defs/SubscriptionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1916.errors = [{instancePath:instancePath+"/subscriptionId",schemaPath:"sidekicks-contracts:jsonrpc/streaming#/$defs/SubscriptionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.sessions !== undefined){let data1: any = data.sessions;const _errs6: any = errors;if(wireByteLength(data1, this && this.attachments) > 991808){validate1916.errors = [{instancePath:instancePath+"/sessions",schemaPath:"#/properties/sessions/maxJsonBytes",keyword:"maxJsonBytes",params:{}}];return false;}if(errors === _errs6){if(Array.isArray(data1)){var valid2: any = true;const len0: any = data1.length;for(let i0=0; i0<len0; i0++){const _errs8: any = errors;if(!(validate1902.call(this, data1[i0], {instancePath:instancePath+"/sessions/" + i0,parentData:data1,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate1902.errors : vErrors.concat(validate1902.errors);errors = vErrors.length;}var valid2: any = _errs8 === errors;if(!valid2){break;}}}else {validate1916.errors = [{instancePath:instancePath+"/sessions",schemaPath:"#/properties/sessions/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.chatCount !== undefined){let data3: any = data.chatCount;const _errs9: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validate1916.errors = [{instancePath:instancePath+"/chatCount",schemaPath:"#/properties/chatCount/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs9){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 9007199254740991 || isNaN(data3)){validate1916.errors = [{instancePath:instancePath+"/chatCount",schemaPath:"#/properties/chatCount/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data3 < 0 || isNaN(data3)){validate1916.errors = [{instancePath:instancePath+"/chatCount",schemaPath:"#/properties/chatCount/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}if(valid0){if(data.isComplete !== undefined){const _errs11: any = errors;if(typeof data.isComplete !== "boolean"){validate1916.errors = [{instancePath:instancePath+"/isComplete",schemaPath:"#/properties/isComplete/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs11 === errors;}else {var valid0: any = true;}}}}}}}else {validate1916.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1916.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1916.errors = null as any[] | null;
// prettier-ignore
validate1916.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern43 = new RegExp("^[^\\x00]*$", "u");
// prettier-ignore
function validate1918(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionWorkingFolderUpdateRequest {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1918.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.path === undefined) && (missing0 = "path"))){validate1918.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "sessionId") || (key0 === "path"))){validate1918.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1918.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1918.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.path !== undefined){let data1: any = data.path;const _errs6: any = errors;if(errors === _errs6){if(typeof data1 === "string"){if(func1(data1) > 4096){validate1918.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data1) < 1){validate1918.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data1)){validate1918.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate1918.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}else {validate1918.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1918.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1918.errors = null as any[] | null;
// prettier-ignore
validate1918.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema3812: any = {"description":"When a working-folder move takes effect.","type":"string","enum":["applied","pending","dropped"]};
// prettier-ignore
function validate1919(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is SessionWorkingFolderUpdateResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1919.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.disposition === undefined) && (missing0 = "disposition"))) || ((data.path === undefined) && (missing0 = "path"))){validate1919.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "disposition")) || (key0 === "path"))){validate1919.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate1919.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1919.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.disposition !== undefined){let data1: any = data.disposition;const _errs6: any = errors;if(typeof data1 !== "string"){validate1919.errors = [{instancePath:instancePath+"/disposition",schemaPath:"#/$defs/SessionWorkingFolderDisposition/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data1 === "applied") || (data1 === "pending")) || (data1 === "dropped"))){validate1919.errors = [{instancePath:instancePath+"/disposition",schemaPath:"#/$defs/SessionWorkingFolderDisposition/enum",keyword:"enum",params:{allowedValues: schema3812.enum}}];return false;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.path !== undefined){let data2: any = data.path;const _errs9: any = errors;if(errors === _errs9){if(typeof data2 === "string"){if(func1(data2) > 4096){validate1919.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}else {if(func1(data2) < 1){validate1919.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern43.test(data2)){validate1919.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*$"}}];return false;}}}}else {validate1919.errors = [{instancePath:instancePath+"/path",schemaPath:"#/properties/path/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}}}}}}else {validate1919.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1919.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1919.errors = null as any[] | null;
// prettier-ignore
validate1919.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link SessionBinding}. */
export const validateSessionBinding: SchemaCheck<SessionBinding> = validate1883;
/** Checks that a value is a {@link SessionCreateRequest}. */
export const validateSessionCreateRequest: SchemaCheck<SessionCreateRequest> = validate1886;
/** Checks that a value is a {@link SessionCreateResponse}. */
export const validateSessionCreateResponse: SchemaCheck<SessionCreateResponse> = validate1894;
/** Checks that a value is a {@link SessionForkRequest}. */
export const validateSessionForkRequest: SchemaCheck<SessionForkRequest> = validate1899;
/** Checks that a value is a {@link SessionForkResponse}. */
export const validateSessionForkResponse: SchemaCheck<SessionForkResponse> = validate1900;
/** Checks that a value is a {@link SessionListChange}. */
export const validateSessionListChange: SchemaCheck<SessionListChange> = validate1901;
/** Checks that a value is a {@link SessionOverviewReadRequest}. */
export const validateSessionOverviewReadRequest: SchemaCheck<SessionOverviewReadRequest> =
  validate1910;
/** Checks that a value is a {@link SessionOverviewReadResponse}. */
export const validateSessionOverviewReadResponse: SchemaCheck<SessionOverviewReadResponse> =
  validate1911;
/** Checks that a value is a {@link SessionSubscribeResponse}. */
export const validateSessionSubscribeResponse: SchemaCheck<SessionSubscribeResponse> = validate1916;
/** Checks that a value is a {@link SessionWorkingFolderUpdateRequest}. */
export const validateSessionWorkingFolderUpdateRequest: SchemaCheck<SessionWorkingFolderUpdateRequest> =
  validate1918;
/** Checks that a value is a {@link SessionWorkingFolderUpdateResponse}. */
export const validateSessionWorkingFolderUpdateResponse: SchemaCheck<SessionWorkingFolderUpdateResponse> =
  validate1919;

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
