// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The `mcp.*` method table, the sign-in event payload, the status notice, the refusal codes, a write conflict's reason, the binding store's cause and a config file refusal's details.

import { type SchemaCheck, ucs2length } from "../../schema-check.js";
import type { WireInstant } from "../internal/wire-scalars.js";
import type { KeychainRefusalCause } from "../keychain.js";
import { type EmptyPayload, validateEmptyPayload } from "../method-descriptor.js";
import type { RuntimeBindingId } from "../provider/driver/runtime-binding.js";
import type { ProviderId } from "../provider/id.js";
import type { SessionId } from "../session/id.js";
import {
  type McpBindingScope,
  type McpRegistrySearchRequest,
  type McpRegistrySearchResponse,
  type McpServerBindingId,
  type McpServerBindingRef,
  type McpServerDeleteRequest,
  type McpServerDeleteResponse,
  type McpServerEnabledUpdateRequest,
  type McpServerListRequest,
  type McpServerListResponse,
  type McpServerMutationResponse,
  type McpServerReadResponse,
  type McpServerReconnectRequest,
  type McpServerReconnectResponse,
  type McpServerSignInRequest,
  type McpServerSignInResponse,
  type McpServerSignOutRequest,
  type McpServerStatus,
  type McpServerUpsertRequest,
  type McpToolOverrideClearRequest,
  type McpToolOverrideMutationResponse,
  type McpToolOverrideUpdateRequest,
  validateMcpRegistrySearchRequest,
  validateMcpRegistrySearchResponse,
  validateMcpServerBindingRef,
  validateMcpServerDeleteRequest,
  validateMcpServerDeleteResponse,
  validateMcpServerEnabledUpdateRequest,
  validateMcpServerListRequest,
  validateMcpServerListResponse,
  validateMcpServerMutationResponse,
  validateMcpServerReadResponse,
  validateMcpServerReconnectRequest,
  validateMcpServerReconnectResponse,
  validateMcpServerSignInRequest,
  validateMcpServerSignInResponse,
  validateMcpServerSignOutRequest,
  validateMcpServerUpsertRequest,
  validateMcpToolOverrideClearRequest,
  validateMcpToolOverrideMutationResponse,
  validateMcpToolOverrideUpdateRequest,
} from "./server.js";

/** No binding with the requested provider, scope, folder and name exists. */
export const MCP_SERVER_NOT_FOUND_CODE = "mcp.server.notFound" as const;

/** The submitted configuration failed validation before anything was written. */
export const MCP_SERVER_CONFIG_INVALID_CODE = "mcp.server.configInvalid" as const;

/**
 * The provider's config file changed under the write: the provider's own version check
 * failed, a project file no longer hashes to what the daemon last read, or another writer
 * changed the binding's entry since the daemon read it.
 */
export const MCP_SERVER_CONFIG_WRITE_CONFLICT_CODE = "mcp.server.configWriteConflict" as const;

/**
 * The change reused a key with another request; the screen sends the change again under a
 * new key.
 */
export const MCP_SERVER_IDEMPOTENCY_CONFLICT_CODE = "mcp.server.idempotencyConflict" as const;

/**
 * The provider's own config does not load, so nothing was written; the screen names the
 * files.
 */
export const MCP_SERVER_CONFIG_FILE_INVALID_CODE = "mcp.server.configFileInvalid" as const;

/**
 * The sign-in could not be started for a passing reason; retry under a new key. A failure
 * after it started arrives as an event.
 */
export const MCP_SERVER_SIGN_IN_FAILED_CODE = "mcp.server.signInFailed" as const;

/**
 * The keychain refused to delete the sign-in, so the server stays signed in; the refusal
 * carries the keychain's cause.
 */
export const MCP_SERVER_SIGN_OUT_FAILED_CODE = "mcp.server.signOutFailed" as const;

/**
 * `mcp.server.status.changed`, the live notice of a status change on `mcp.subscribe`,
 * written to no log, tagged on `origin`, placed on its row by `serverBindingId`: a
 * `sessionFeed` notice names the session and the live leg whose own status changed, its two
 * statuses that leg's, so a page updates that leg's line; a `sessionEnded` notice names the
 * session whose leg left, its `status` the aggregate over the legs that remain; a
 * `machineProbe` notice carries the probe's own readings and names neither.
 */
export type McpServerStatusChangedNotice =
  | {
      origin: "sessionFeed";
      /**
       * Always `mcp.server.status.changed`.
       */
      type: "mcp.server.status.changed";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The binding's scope.
       */
      scope: McpBindingScope;
      /**
       * The server's name.
       */
      serverName: string;
      /**
       * The binding's id, the same as on its `mcp.server.list` entry, which places
       * every notice on that row; the audit ref names the binding to a person.
       */
      serverBindingId: McpServerBindingId;
      /**
       * The status before.
       */
      previousStatus: McpServerStatus;
      /**
       * The status now.
       */
      status: McpServerStatus;
      /**
       * Why it failed, where the provider said.
       */
      failureReason?: string;
      /**
       * The session.
       */
      sessionId: SessionId;
      /**
       * The live leg.
       */
      bindingId: RuntimeBindingId;
      /**
       * When the leg's reading that changed its status was observed.
       */
      observedAt: WireInstant;
    }
  | {
      origin: "sessionEnded";
      /**
       * Always `mcp.server.status.changed`.
       */
      type: "mcp.server.status.changed";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The binding's scope.
       */
      scope: McpBindingScope;
      /**
       * The server's name.
       */
      serverName: string;
      /**
       * The binding's id, the same as on its `mcp.server.list` entry, which places
       * every notice on that row; the audit ref names the binding to a person.
       */
      serverBindingId: McpServerBindingId;
      /**
       * The status before.
       */
      previousStatus: McpServerStatus;
      /**
       * The status now.
       */
      status: McpServerStatus;
      /**
       * Why it failed, where the provider said.
       */
      failureReason?: string;
      /**
       * The session whose leg left.
       */
      sessionId: SessionId;
      /**
       * The leg that left.
       */
      bindingId: RuntimeBindingId;
    }
  | {
      origin: "machineProbe";
      /**
       * Always `mcp.server.status.changed`.
       */
      type: "mcp.server.status.changed";
      /**
       * The provider.
       */
      provider: ProviderId;
      /**
       * The binding's scope.
       */
      scope: McpBindingScope;
      /**
       * The server's name.
       */
      serverName: string;
      /**
       * The binding's id, the same as on its `mcp.server.list` entry, which places
       * every notice on that row; the audit ref names the binding to a person.
       */
      serverBindingId: McpServerBindingId;
      /**
       * The status before.
       */
      previousStatus: McpServerStatus;
      /**
       * The status now.
       */
      status: McpServerStatus;
      /**
       * Why it failed, where the provider said.
       */
      failureReason?: string;
      /**
       * Never present: no session saw it.
       */
      sessionId?: never;
      /**
       * Never present: no live leg saw it.
       */
      bindingId?: never;
    };
/**
 * How a sign-in ended.
 */
export type McpServerSignInOutcome = "success" | "failure";
/**
 * Why a write to a provider's own config lost to a concurrent edit: the
 * `mcp.server.configWriteConflict` refusal's `data.fields.reason`.
 */
export type McpServerConfigWriteConflictReason =
  | "staleVersion"
  | "configFileChanged"
  | "entryChanged";
/**
 * Why the daemon's receipt key could not be used: one `mcp.bindingStoreUnavailable` cause.
 */
export type McpReceiptKeyCause = "receiptKeyLost";
/**
 * The `mcp.bindingStoreUnavailable` refusal's `data.fields.cause`: the receipt key's cause, or
 * the keychain's when it could not be read.
 */
export type McpBindingStoreUnavailableCause = McpReceiptKeyCause | KeychainRefusalCause;

/**
 * The payload of `mcp.server.signIn.completed`: how a sign-in ended. A sign-in that fails after
 * `mcp.server.signIn` has answered arrives here as `failure`, never as a late error.
 */
export interface McpServerSignInCompletedPayload {
  /**
   * The provider.
   */
  provider: ProviderId;
  /**
   * The binding's scope.
   */
  scope: McpBindingScope;
  /**
   * The server's name.
   */
  serverName: string;
  /**
   * How it ended.
   */
  outcome: McpServerSignInOutcome;
  /**
   * Why it failed.
   */
  failureReason?: string;
  /**
   * The session the sign-in was started from.
   */
  initiatingSessionId?: SessionId;
}
/**
 * The `mcp.server.configFileInvalid` refusal's `data.fields`: the binding the write was for and
 * the provider's config files. It is the one MCP refusal detail that names a path on this machine.
 */
export interface McpServerConfigFileInvalidDetails {
  /**
   * The provider.
   */
  provider: ProviderId;
  /**
   * The binding's scope.
   */
  scope: McpBindingScope;
  /**
   * The server's name.
   */
  serverName: string;
  /**
   * The paths of the config's layers the provider reported on the read before the write; a
   * layer with no file is named by its kind. A path read from the provider's words never goes
   * in.
   */
  configFiles: string[];
}

// prettier-ignore
const schema1071: any = {"description":"Where a server binding applies: `user` in all projects, `project` in one project with its\ndeclaration in the repository, `local` in one project with its declaration outside the\nrepository, `plugin` for a server an installed plugin carries, and, on a provider that brings\nservers itself, `connector` for a connector of its account and `managed` for a server an\nadministrator layer declares (an organization's managed settings, or a provider's system-wide\nor managed-device configuration). The first three are writable on every provider; where a\nprovider has no per-project layer outside the repository, the daemon emulates `local` with a\nuser entry that is off by default and switched on in that project's sessions. The last two are\nread-only.","type":"string","enum":["user","project","local","plugin","connector","managed"]};
// prettier-ignore
const schema1072: any = {"description":"How a sign-in ended.","type":"string","enum":["success","failure"]};
// prettier-ignore
const pattern16 = new RegExp("^[a-z][a-z0-9-]{0,31}$", "u");
// prettier-ignore
const pattern6 = new RegExp("^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$", "u");
// prettier-ignore
const pattern4 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
function validate1099(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is McpServerSignInCompletedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1099.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.provider === undefined) && (missing0 = "provider")) || ((data.scope === undefined) && (missing0 = "scope"))) || ((data.serverName === undefined) && (missing0 = "serverName"))) || ((data.outcome === undefined) && (missing0 = "outcome"))){validate1099.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((((key0 === "provider") || (key0 === "scope")) || (key0 === "serverName")) || (key0 === "outcome")) || (key0 === "failureReason")) || (key0 === "initiatingSessionId"))){validate1099.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.provider !== undefined){let data0: any = data.provider;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern16.test(data0)){validate1099.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}}];return false;}}else {validate1099.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.scope !== undefined){let data1: any = data.scope;const _errs6: any = errors;if(typeof data1 !== "string"){validate1099.errors = [{instancePath:instancePath+"/scope",schemaPath:"sidekicks-contracts:mcp/server#/$defs/McpBindingScope/type",keyword:"type",params:{type: "string"}}];return false;}if(!((((((data1 === "user") || (data1 === "project")) || (data1 === "local")) || (data1 === "plugin")) || (data1 === "connector")) || (data1 === "managed"))){validate1099.errors = [{instancePath:instancePath+"/scope",schemaPath:"sidekicks-contracts:mcp/server#/$defs/McpBindingScope/enum",keyword:"enum",params:{allowedValues: schema1071.enum}}];return false;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.serverName !== undefined){let data2: any = data.serverName;const _errs9: any = errors;if(errors === _errs9){if(typeof data2 === "string"){if(func1(data2) > 128){validate1099.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/properties/serverName/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data2) < 1){validate1099.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/properties/serverName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data2)){validate1099.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/properties/serverName/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1099.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/properties/serverName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}if(valid0){if(data.outcome !== undefined){let data3: any = data.outcome;const _errs11: any = errors;if(typeof data3 !== "string"){validate1099.errors = [{instancePath:instancePath+"/outcome",schemaPath:"#/$defs/McpServerSignInOutcome/type",keyword:"type",params:{type: "string"}}];return false;}if(!((data3 === "success") || (data3 === "failure"))){validate1099.errors = [{instancePath:instancePath+"/outcome",schemaPath:"#/$defs/McpServerSignInOutcome/enum",keyword:"enum",params:{allowedValues: schema1072.enum}}];return false;}var valid0: any = _errs11 === errors;}else {var valid0: any = true;}if(valid0){if(data.failureReason !== undefined){const _errs14: any = errors;if(typeof data.failureReason !== "string"){validate1099.errors = [{instancePath:instancePath+"/failureReason",schemaPath:"#/properties/failureReason/type",keyword:"type",params:{type: "string"}}];return false;}var valid0: any = _errs14 === errors;}else {var valid0: any = true;}if(valid0){if(data.initiatingSessionId !== undefined){let data5: any = data.initiatingSessionId;const _errs16: any = errors;const _errs17: any = errors;if(errors === _errs17){if(typeof data5 === "string"){if(!pattern4.test(data5)){validate1099.errors = [{instancePath:instancePath+"/initiatingSessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1099.errors = [{instancePath:instancePath+"/initiatingSessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs16 === errors;}else {var valid0: any = true;}}}}}}}}}else {validate1099.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1099.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1099.errors = null as any[] | null;
// prettier-ignore
validate1099.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema2027: any = {"oneOf":[{"type":"object","additionalProperties":false,"properties":{"origin":{"type":"string","const":"sessionFeed"},"type":{"description":"Always `mcp.server.status.changed`.","type":"string","enum":["mcp.server.status.changed"]},"provider":{"$ref":"sidekicks-contracts:provider/id#/$defs/ProviderId","description":"The provider."},"scope":{"$ref":"sidekicks-contracts:mcp/server#/$defs/McpBindingScope","description":"The binding's scope."},"serverName":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":128,"description":"The server's name."},"serverBindingId":{"$ref":"sidekicks-contracts:mcp/server#/$defs/McpServerBindingId","description":"The binding's id, the same as on its `mcp.server.list` entry, which places\nevery notice on that row; the audit ref names the binding to a person."},"previousStatus":{"$ref":"sidekicks-contracts:mcp/server#/$defs/McpServerStatus","description":"The status before."},"status":{"$ref":"sidekicks-contracts:mcp/server#/$defs/McpServerStatus","description":"The status now."},"failureReason":{"type":"string","description":"Why it failed, where the provider said."},"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session."},"bindingId":{"$ref":"sidekicks-contracts:provider/driver/runtime-binding#/$defs/RuntimeBindingId","description":"The live leg."},"observedAt":{"$ref":"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant","description":"When the leg's reading that changed its status was observed."}},"required":["origin","type","provider","scope","serverName","serverBindingId","previousStatus","status","sessionId","bindingId","observedAt"],"description":"A session's live leg's own status changed."},{"type":"object","additionalProperties":false,"properties":{"origin":{"type":"string","const":"sessionEnded"},"type":{"description":"Always `mcp.server.status.changed`.","type":"string","enum":["mcp.server.status.changed"]},"provider":{"$ref":"sidekicks-contracts:provider/id#/$defs/ProviderId","description":"The provider."},"scope":{"$ref":"sidekicks-contracts:mcp/server#/$defs/McpBindingScope","description":"The binding's scope."},"serverName":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":128,"description":"The server's name."},"serverBindingId":{"$ref":"sidekicks-contracts:mcp/server#/$defs/McpServerBindingId","description":"The binding's id, the same as on its `mcp.server.list` entry, which places\nevery notice on that row; the audit ref names the binding to a person."},"previousStatus":{"$ref":"sidekicks-contracts:mcp/server#/$defs/McpServerStatus","description":"The status before."},"status":{"$ref":"sidekicks-contracts:mcp/server#/$defs/McpServerStatus","description":"The status now."},"failureReason":{"type":"string","description":"Why it failed, where the provider said."},"sessionId":{"$ref":"sidekicks-contracts:session/id#/$defs/SessionId","description":"The session whose leg left."},"bindingId":{"$ref":"sidekicks-contracts:provider/driver/runtime-binding#/$defs/RuntimeBindingId","description":"The leg that left."}},"required":["origin","type","provider","scope","serverName","serverBindingId","previousStatus","status","sessionId","bindingId"],"description":"A session's leg left the aggregate: the session closed, its driver exited, the leg\nmoved to another binding or the server was switched off for it; a page drops that leg\nand reads nothing again."},{"type":"object","additionalProperties":false,"properties":{"origin":{"type":"string","const":"machineProbe"},"type":{"description":"Always `mcp.server.status.changed`.","type":"string","enum":["mcp.server.status.changed"]},"provider":{"$ref":"sidekicks-contracts:provider/id#/$defs/ProviderId","description":"The provider."},"scope":{"$ref":"sidekicks-contracts:mcp/server#/$defs/McpBindingScope","description":"The binding's scope."},"serverName":{"type":"string","minLength":1,"pattern":"^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$","maxLength":128,"description":"The server's name."},"serverBindingId":{"$ref":"sidekicks-contracts:mcp/server#/$defs/McpServerBindingId","description":"The binding's id, the same as on its `mcp.server.list` entry, which places\nevery notice on that row; the audit ref names the binding to a person."},"previousStatus":{"$ref":"sidekicks-contracts:mcp/server#/$defs/McpServerStatus","description":"The status before."},"status":{"$ref":"sidekicks-contracts:mcp/server#/$defs/McpServerStatus","description":"The status now."},"failureReason":{"type":"string","description":"Why it failed, where the provider said."},"sessionId":{"not":{},"tsType":"never","description":"Never present: no session saw it."},"bindingId":{"not":{},"tsType":"never","description":"Never present: no live leg saw it."}},"required":["origin","type","provider","scope","serverName","serverBindingId","previousStatus","status"],"description":"The daemon's own probe's reading changed."}],"description":"`mcp.server.status.changed`, the live notice of a status change on `mcp.subscribe`,\nwritten to no log, tagged on `origin`, placed on its row by `serverBindingId`: a\n`sessionFeed` notice names the session and the live leg whose own status changed, its two\nstatuses that leg's, so a page updates that leg's line; a `sessionEnded` notice names the\nsession whose leg left, its `status` the aggregate over the legs that remain; a\n`machineProbe` notice carries the probe's own readings and names neither.","discriminator":{"propertyName":"origin"},"type":"object","unevaluatedProperties":false};
// prettier-ignore
const schema2031: any = {"description":"A server's connection state; it says nothing about which of its tools a session can see.","type":"string","enum":["failed","needsAuth","unknown","starting","connected"]};
// prettier-ignore
const func2 = Object.prototype.hasOwnProperty;
// prettier-ignore
const pattern220 = new RegExp("^[0-9a-f]{64}$", "u");
// prettier-ignore
const pattern5 = new RegExp("^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$", "u");
// prettier-ignore
function validate1100(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is McpServerStatusChangedNotice {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate1100.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.origin;if(typeof tag0 == "string"){if(tag0 === "sessionFeed"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((((((((data.origin === undefined) && (missing0 = "origin")) || ((data.type === undefined) && (missing0 = "type"))) || ((data.provider === undefined) && (missing0 = "provider"))) || ((data.scope === undefined) && (missing0 = "scope"))) || ((data.serverName === undefined) && (missing0 = "serverName"))) || ((data.serverBindingId === undefined) && (missing0 = "serverBindingId"))) || ((data.previousStatus === undefined) && (missing0 = "previousStatus"))) || ((data.status === undefined) && (missing0 = "status"))) || ((data.sessionId === undefined) && (missing0 = "sessionId"))) || ((data.bindingId === undefined) && (missing0 = "bindingId"))) || ((data.observedAt === undefined) && (missing0 = "observedAt"))){validate1100.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!(func2.call(schema2027.oneOf[0].properties, key0))){validate1100.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.origin !== undefined){let data0: any = data.origin;const _errs5: any = errors;if(typeof data0 !== "string"){validate1100.errors = [{instancePath:instancePath+"/origin",schemaPath:"#/oneOf/0/properties/origin/type",keyword:"type",params:{type: "string"}}];return false;}if("sessionFeed" !== data0){validate1100.errors = [{instancePath:instancePath+"/origin",schemaPath:"#/oneOf/0/properties/origin/const",keyword:"const",params:{allowedValue: "sessionFeed"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.type !== undefined){let data1: any = data.type;const _errs7: any = errors;if(typeof data1 !== "string"){validate1100.errors = [{instancePath:instancePath+"/type",schemaPath:"#/oneOf/0/properties/type/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data1 === "mcp.server.status.changed")){validate1100.errors = [{instancePath:instancePath+"/type",schemaPath:"#/oneOf/0/properties/type/enum",keyword:"enum",params:{allowedValues: schema2027.oneOf[0].properties.type.enum}}];return false;}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}if(valid2){if(data.provider !== undefined){let data2: any = data.provider;const _errs9: any = errors;const _errs10: any = errors;if(errors === _errs10){if(typeof data2 === "string"){if(!pattern16.test(data2)){validate1100.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}}];return false;}}else {validate1100.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs9 === errors;}else {var valid2: any = true;}if(valid2){if(data.scope !== undefined){let data3: any = data.scope;const _errs13: any = errors;if(typeof data3 !== "string"){validate1100.errors = [{instancePath:instancePath+"/scope",schemaPath:"sidekicks-contracts:mcp/server#/$defs/McpBindingScope/type",keyword:"type",params:{type: "string"}}];return false;}if(!((((((data3 === "user") || (data3 === "project")) || (data3 === "local")) || (data3 === "plugin")) || (data3 === "connector")) || (data3 === "managed"))){validate1100.errors = [{instancePath:instancePath+"/scope",schemaPath:"sidekicks-contracts:mcp/server#/$defs/McpBindingScope/enum",keyword:"enum",params:{allowedValues: schema1071.enum}}];return false;}var valid2: any = _errs13 === errors;}else {var valid2: any = true;}if(valid2){if(data.serverName !== undefined){let data4: any = data.serverName;const _errs16: any = errors;if(errors === _errs16){if(typeof data4 === "string"){if(func1(data4) > 128){validate1100.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/oneOf/0/properties/serverName/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data4) < 1){validate1100.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/oneOf/0/properties/serverName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data4)){validate1100.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/oneOf/0/properties/serverName/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1100.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/oneOf/0/properties/serverName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs16 === errors;}else {var valid2: any = true;}if(valid2){if(data.serverBindingId !== undefined){let data5: any = data.serverBindingId;const _errs18: any = errors;const _errs19: any = errors;if(errors === _errs19){if(typeof data5 === "string"){if(!pattern220.test(data5)){validate1100.errors = [{instancePath:instancePath+"/serverBindingId",schemaPath:"sidekicks-contracts:mcp/server#/$defs/McpServerBindingId/pattern",keyword:"pattern",params:{pattern: "^[0-9a-f]{64}$"}}];return false;}}else {validate1100.errors = [{instancePath:instancePath+"/serverBindingId",schemaPath:"sidekicks-contracts:mcp/server#/$defs/McpServerBindingId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs18 === errors;}else {var valid2: any = true;}if(valid2){if(data.previousStatus !== undefined){let data6: any = data.previousStatus;const _errs22: any = errors;if(typeof data6 !== "string"){validate1100.errors = [{instancePath:instancePath+"/previousStatus",schemaPath:"sidekicks-contracts:mcp/server#/$defs/McpServerStatus/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((((data6 === "failed") || (data6 === "needsAuth")) || (data6 === "unknown")) || (data6 === "starting")) || (data6 === "connected"))){validate1100.errors = [{instancePath:instancePath+"/previousStatus",schemaPath:"sidekicks-contracts:mcp/server#/$defs/McpServerStatus/enum",keyword:"enum",params:{allowedValues: schema2031.enum}}];return false;}var valid2: any = _errs22 === errors;}else {var valid2: any = true;}if(valid2){if(data.status !== undefined){let data7: any = data.status;const _errs25: any = errors;if(typeof data7 !== "string"){validate1100.errors = [{instancePath:instancePath+"/status",schemaPath:"sidekicks-contracts:mcp/server#/$defs/McpServerStatus/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((((data7 === "failed") || (data7 === "needsAuth")) || (data7 === "unknown")) || (data7 === "starting")) || (data7 === "connected"))){validate1100.errors = [{instancePath:instancePath+"/status",schemaPath:"sidekicks-contracts:mcp/server#/$defs/McpServerStatus/enum",keyword:"enum",params:{allowedValues: schema2031.enum}}];return false;}var valid2: any = _errs25 === errors;}else {var valid2: any = true;}if(valid2){if(data.failureReason !== undefined){const _errs28: any = errors;if(typeof data.failureReason !== "string"){validate1100.errors = [{instancePath:instancePath+"/failureReason",schemaPath:"#/oneOf/0/properties/failureReason/type",keyword:"type",params:{type: "string"}}];return false;}var valid2: any = _errs28 === errors;}else {var valid2: any = true;}if(valid2){if(data.sessionId !== undefined){let data9: any = data.sessionId;const _errs30: any = errors;const _errs31: any = errors;if(errors === _errs31){if(typeof data9 === "string"){if(!pattern4.test(data9)){validate1100.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1100.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs30 === errors;}else {var valid2: any = true;}if(valid2){if(data.bindingId !== undefined){let data10: any = data.bindingId;const _errs34: any = errors;const _errs35: any = errors;if(errors === _errs35){if(typeof data10 === "string"){if(func1(data10) > 256){validate1100.errors = [{instancePath:instancePath+"/bindingId",schemaPath:"sidekicks-contracts:provider/driver/runtime-binding#/$defs/RuntimeBindingId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data10) < 1){validate1100.errors = [{instancePath:instancePath+"/bindingId",schemaPath:"sidekicks-contracts:provider/driver/runtime-binding#/$defs/RuntimeBindingId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1100.errors = [{instancePath:instancePath+"/bindingId",schemaPath:"sidekicks-contracts:provider/driver/runtime-binding#/$defs/RuntimeBindingId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs34 === errors;}else {var valid2: any = true;}if(valid2){if(data.observedAt !== undefined){let data11: any = data.observedAt;const _errs38: any = errors;const _errs39: any = errors;if(errors === _errs39){if(typeof data11 === "string"){if(!pattern5.test(data11)){validate1100.errors = [{instancePath:instancePath+"/observedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}}];return false;}}else {validate1100.errors = [{instancePath:instancePath+"/observedAt",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs38 === errors;}else {var valid2: any = true;}}}}}}}}}}}}}}}else {validate1100.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "sessionEnded"){const _errs41: any = errors;if(errors === _errs41){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if(((((((((((data.origin === undefined) && (missing1 = "origin")) || ((data.type === undefined) && (missing1 = "type"))) || ((data.provider === undefined) && (missing1 = "provider"))) || ((data.scope === undefined) && (missing1 = "scope"))) || ((data.serverName === undefined) && (missing1 = "serverName"))) || ((data.serverBindingId === undefined) && (missing1 = "serverBindingId"))) || ((data.previousStatus === undefined) && (missing1 = "previousStatus"))) || ((data.status === undefined) && (missing1 = "status"))) || ((data.sessionId === undefined) && (missing1 = "sessionId"))) || ((data.bindingId === undefined) && (missing1 = "bindingId"))){validate1100.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs43: any = errors;for(const key1 in data){if(!(func2.call(schema2027.oneOf[1].properties, key1))){validate1100.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs43 === errors){if(data.origin !== undefined){let data12: any = data.origin;const _errs44: any = errors;if(typeof data12 !== "string"){validate1100.errors = [{instancePath:instancePath+"/origin",schemaPath:"#/oneOf/1/properties/origin/type",keyword:"type",params:{type: "string"}}];return false;}if("sessionEnded" !== data12){validate1100.errors = [{instancePath:instancePath+"/origin",schemaPath:"#/oneOf/1/properties/origin/const",keyword:"const",params:{allowedValue: "sessionEnded"}}];return false;}var valid12: any = _errs44 === errors;}else {var valid12: any = true;}if(valid12){if(data.type !== undefined){let data13: any = data.type;const _errs46: any = errors;if(typeof data13 !== "string"){validate1100.errors = [{instancePath:instancePath+"/type",schemaPath:"#/oneOf/1/properties/type/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data13 === "mcp.server.status.changed")){validate1100.errors = [{instancePath:instancePath+"/type",schemaPath:"#/oneOf/1/properties/type/enum",keyword:"enum",params:{allowedValues: schema2027.oneOf[1].properties.type.enum}}];return false;}var valid12: any = _errs46 === errors;}else {var valid12: any = true;}if(valid12){if(data.provider !== undefined){let data14: any = data.provider;const _errs48: any = errors;const _errs49: any = errors;if(errors === _errs49){if(typeof data14 === "string"){if(!pattern16.test(data14)){validate1100.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}}];return false;}}else {validate1100.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid12: any = _errs48 === errors;}else {var valid12: any = true;}if(valid12){if(data.scope !== undefined){let data15: any = data.scope;const _errs52: any = errors;if(typeof data15 !== "string"){validate1100.errors = [{instancePath:instancePath+"/scope",schemaPath:"sidekicks-contracts:mcp/server#/$defs/McpBindingScope/type",keyword:"type",params:{type: "string"}}];return false;}if(!((((((data15 === "user") || (data15 === "project")) || (data15 === "local")) || (data15 === "plugin")) || (data15 === "connector")) || (data15 === "managed"))){validate1100.errors = [{instancePath:instancePath+"/scope",schemaPath:"sidekicks-contracts:mcp/server#/$defs/McpBindingScope/enum",keyword:"enum",params:{allowedValues: schema1071.enum}}];return false;}var valid12: any = _errs52 === errors;}else {var valid12: any = true;}if(valid12){if(data.serverName !== undefined){let data16: any = data.serverName;const _errs55: any = errors;if(errors === _errs55){if(typeof data16 === "string"){if(func1(data16) > 128){validate1100.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/oneOf/1/properties/serverName/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data16) < 1){validate1100.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/oneOf/1/properties/serverName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data16)){validate1100.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/oneOf/1/properties/serverName/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1100.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/oneOf/1/properties/serverName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid12: any = _errs55 === errors;}else {var valid12: any = true;}if(valid12){if(data.serverBindingId !== undefined){let data17: any = data.serverBindingId;const _errs57: any = errors;const _errs58: any = errors;if(errors === _errs58){if(typeof data17 === "string"){if(!pattern220.test(data17)){validate1100.errors = [{instancePath:instancePath+"/serverBindingId",schemaPath:"sidekicks-contracts:mcp/server#/$defs/McpServerBindingId/pattern",keyword:"pattern",params:{pattern: "^[0-9a-f]{64}$"}}];return false;}}else {validate1100.errors = [{instancePath:instancePath+"/serverBindingId",schemaPath:"sidekicks-contracts:mcp/server#/$defs/McpServerBindingId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid12: any = _errs57 === errors;}else {var valid12: any = true;}if(valid12){if(data.previousStatus !== undefined){let data18: any = data.previousStatus;const _errs61: any = errors;if(typeof data18 !== "string"){validate1100.errors = [{instancePath:instancePath+"/previousStatus",schemaPath:"sidekicks-contracts:mcp/server#/$defs/McpServerStatus/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((((data18 === "failed") || (data18 === "needsAuth")) || (data18 === "unknown")) || (data18 === "starting")) || (data18 === "connected"))){validate1100.errors = [{instancePath:instancePath+"/previousStatus",schemaPath:"sidekicks-contracts:mcp/server#/$defs/McpServerStatus/enum",keyword:"enum",params:{allowedValues: schema2031.enum}}];return false;}var valid12: any = _errs61 === errors;}else {var valid12: any = true;}if(valid12){if(data.status !== undefined){let data19: any = data.status;const _errs64: any = errors;if(typeof data19 !== "string"){validate1100.errors = [{instancePath:instancePath+"/status",schemaPath:"sidekicks-contracts:mcp/server#/$defs/McpServerStatus/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((((data19 === "failed") || (data19 === "needsAuth")) || (data19 === "unknown")) || (data19 === "starting")) || (data19 === "connected"))){validate1100.errors = [{instancePath:instancePath+"/status",schemaPath:"sidekicks-contracts:mcp/server#/$defs/McpServerStatus/enum",keyword:"enum",params:{allowedValues: schema2031.enum}}];return false;}var valid12: any = _errs64 === errors;}else {var valid12: any = true;}if(valid12){if(data.failureReason !== undefined){const _errs67: any = errors;if(typeof data.failureReason !== "string"){validate1100.errors = [{instancePath:instancePath+"/failureReason",schemaPath:"#/oneOf/1/properties/failureReason/type",keyword:"type",params:{type: "string"}}];return false;}var valid12: any = _errs67 === errors;}else {var valid12: any = true;}if(valid12){if(data.sessionId !== undefined){let data21: any = data.sessionId;const _errs69: any = errors;const _errs70: any = errors;if(errors === _errs70){if(typeof data21 === "string"){if(!pattern4.test(data21)){validate1100.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate1100.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid12: any = _errs69 === errors;}else {var valid12: any = true;}if(valid12){if(data.bindingId !== undefined){let data22: any = data.bindingId;const _errs73: any = errors;const _errs74: any = errors;if(errors === _errs74){if(typeof data22 === "string"){if(func1(data22) > 256){validate1100.errors = [{instancePath:instancePath+"/bindingId",schemaPath:"sidekicks-contracts:provider/driver/runtime-binding#/$defs/RuntimeBindingId/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data22) < 1){validate1100.errors = [{instancePath:instancePath+"/bindingId",schemaPath:"sidekicks-contracts:provider/driver/runtime-binding#/$defs/RuntimeBindingId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validate1100.errors = [{instancePath:instancePath+"/bindingId",schemaPath:"sidekicks-contracts:provider/driver/runtime-binding#/$defs/RuntimeBindingId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid12: any = _errs73 === errors;}else {var valid12: any = true;}}}}}}}}}}}}}}else {validate1100.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid11: any = _errs41 === errors;if(props0 !== true){props0 = true;}valid0 = valid11;}else if(tag0 === "machineProbe"){const _errs77: any = errors;if(errors === _errs77){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if(((((((((data.origin === undefined) && (missing2 = "origin")) || ((data.type === undefined) && (missing2 = "type"))) || ((data.provider === undefined) && (missing2 = "provider"))) || ((data.scope === undefined) && (missing2 = "scope"))) || ((data.serverName === undefined) && (missing2 = "serverName"))) || ((data.serverBindingId === undefined) && (missing2 = "serverBindingId"))) || ((data.previousStatus === undefined) && (missing2 = "previousStatus"))) || ((data.status === undefined) && (missing2 = "status"))){validate1100.errors = [{instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs79: any = errors;for(const key2 in data){if(!(func2.call(schema2027.oneOf[2].properties, key2))){validate1100.errors = [{instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs79 === errors){if(data.origin !== undefined){let data23: any = data.origin;const _errs80: any = errors;if(typeof data23 !== "string"){validate1100.errors = [{instancePath:instancePath+"/origin",schemaPath:"#/oneOf/2/properties/origin/type",keyword:"type",params:{type: "string"}}];return false;}if("machineProbe" !== data23){validate1100.errors = [{instancePath:instancePath+"/origin",schemaPath:"#/oneOf/2/properties/origin/const",keyword:"const",params:{allowedValue: "machineProbe"}}];return false;}var valid21: any = _errs80 === errors;}else {var valid21: any = true;}if(valid21){if(data.type !== undefined){let data24: any = data.type;const _errs82: any = errors;if(typeof data24 !== "string"){validate1100.errors = [{instancePath:instancePath+"/type",schemaPath:"#/oneOf/2/properties/type/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data24 === "mcp.server.status.changed")){validate1100.errors = [{instancePath:instancePath+"/type",schemaPath:"#/oneOf/2/properties/type/enum",keyword:"enum",params:{allowedValues: schema2027.oneOf[2].properties.type.enum}}];return false;}var valid21: any = _errs82 === errors;}else {var valid21: any = true;}if(valid21){if(data.provider !== undefined){let data25: any = data.provider;const _errs84: any = errors;const _errs85: any = errors;if(errors === _errs85){if(typeof data25 === "string"){if(!pattern16.test(data25)){validate1100.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/pattern",keyword:"pattern",params:{pattern: "^[a-z][a-z0-9-]{0,31}$"}}];return false;}}else {validate1100.errors = [{instancePath:instancePath+"/provider",schemaPath:"sidekicks-contracts:provider/id#/$defs/ProviderId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid21: any = _errs84 === errors;}else {var valid21: any = true;}if(valid21){if(data.scope !== undefined){let data26: any = data.scope;const _errs88: any = errors;if(typeof data26 !== "string"){validate1100.errors = [{instancePath:instancePath+"/scope",schemaPath:"sidekicks-contracts:mcp/server#/$defs/McpBindingScope/type",keyword:"type",params:{type: "string"}}];return false;}if(!((((((data26 === "user") || (data26 === "project")) || (data26 === "local")) || (data26 === "plugin")) || (data26 === "connector")) || (data26 === "managed"))){validate1100.errors = [{instancePath:instancePath+"/scope",schemaPath:"sidekicks-contracts:mcp/server#/$defs/McpBindingScope/enum",keyword:"enum",params:{allowedValues: schema1071.enum}}];return false;}var valid21: any = _errs88 === errors;}else {var valid21: any = true;}if(valid21){if(data.serverName !== undefined){let data27: any = data.serverName;const _errs91: any = errors;if(errors === _errs91){if(typeof data27 === "string"){if(func1(data27) > 128){validate1100.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/oneOf/2/properties/serverName/maxLength",keyword:"maxLength",params:{limit: 128}}];return false;}else {if(func1(data27) < 1){validate1100.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/oneOf/2/properties/serverName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}else {if(!pattern6.test(data27)){validate1100.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/oneOf/2/properties/serverName/pattern",keyword:"pattern",params:{pattern: "^[^\\x00]*[^\\x00\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff][^\\x00]*$"}}];return false;}}}}else {validate1100.errors = [{instancePath:instancePath+"/serverName",schemaPath:"#/oneOf/2/properties/serverName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid21: any = _errs91 === errors;}else {var valid21: any = true;}if(valid21){if(data.serverBindingId !== undefined){let data28: any = data.serverBindingId;const _errs93: any = errors;const _errs94: any = errors;if(errors === _errs94){if(typeof data28 === "string"){if(!pattern220.test(data28)){validate1100.errors = [{instancePath:instancePath+"/serverBindingId",schemaPath:"sidekicks-contracts:mcp/server#/$defs/McpServerBindingId/pattern",keyword:"pattern",params:{pattern: "^[0-9a-f]{64}$"}}];return false;}}else {validate1100.errors = [{instancePath:instancePath+"/serverBindingId",schemaPath:"sidekicks-contracts:mcp/server#/$defs/McpServerBindingId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid21: any = _errs93 === errors;}else {var valid21: any = true;}if(valid21){if(data.previousStatus !== undefined){let data29: any = data.previousStatus;const _errs97: any = errors;if(typeof data29 !== "string"){validate1100.errors = [{instancePath:instancePath+"/previousStatus",schemaPath:"sidekicks-contracts:mcp/server#/$defs/McpServerStatus/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((((data29 === "failed") || (data29 === "needsAuth")) || (data29 === "unknown")) || (data29 === "starting")) || (data29 === "connected"))){validate1100.errors = [{instancePath:instancePath+"/previousStatus",schemaPath:"sidekicks-contracts:mcp/server#/$defs/McpServerStatus/enum",keyword:"enum",params:{allowedValues: schema2031.enum}}];return false;}var valid21: any = _errs97 === errors;}else {var valid21: any = true;}if(valid21){if(data.status !== undefined){let data30: any = data.status;const _errs100: any = errors;if(typeof data30 !== "string"){validate1100.errors = [{instancePath:instancePath+"/status",schemaPath:"sidekicks-contracts:mcp/server#/$defs/McpServerStatus/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((((data30 === "failed") || (data30 === "needsAuth")) || (data30 === "unknown")) || (data30 === "starting")) || (data30 === "connected"))){validate1100.errors = [{instancePath:instancePath+"/status",schemaPath:"sidekicks-contracts:mcp/server#/$defs/McpServerStatus/enum",keyword:"enum",params:{allowedValues: schema2031.enum}}];return false;}var valid21: any = _errs100 === errors;}else {var valid21: any = true;}if(valid21){if(data.failureReason !== undefined){const _errs103: any = errors;if(typeof data.failureReason !== "string"){validate1100.errors = [{instancePath:instancePath+"/failureReason",schemaPath:"#/oneOf/2/properties/failureReason/type",keyword:"type",params:{type: "string"}}];return false;}var valid21: any = _errs103 === errors;}else {var valid21: any = true;}if(valid21){if(data.sessionId !== undefined){const _errs105: any = errors;validate1100.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"#/oneOf/2/properties/sessionId/not",keyword:"not",params:{}}];return false;var valid21: any = _errs105 === errors;}else {var valid21: any = true;}if(valid21){if(data.bindingId !== undefined){const _errs108: any = errors;validate1100.errors = [{instancePath:instancePath+"/bindingId",schemaPath:"#/oneOf/2/properties/bindingId/not",keyword:"not",params:{}}];return false;var valid21: any = _errs108 === errors;}else {var valid21: any = true;}}}}}}}}}}}}}}else {validate1100.errors = [{instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}var valid20: any = _errs77 === errors;if(props0 !== true){props0 = true;}valid0 = valid20;}else {validate1100.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "origin", tagValue: tag0}}];return false;}}else {validate1100.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "origin", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key3 in data){if(!props0 || !props0[key3]){validate1100.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key3}}];return false;break;}}}}}else {validate1100.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate1100.errors = vErrors;return errors === 0;}
// prettier-ignore
validate1100.errors = null as any[] | null;
// prettier-ignore
validate1100.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link McpServerSignInCompletedPayload}. */
export const validateMcpServerSignInCompletedPayload: SchemaCheck<McpServerSignInCompletedPayload> =
  validate1099;
/** Checks that a value is a {@link McpServerStatusChangedNotice}. */
export const validateMcpServerStatusChangedNotice: SchemaCheck<McpServerStatusChangedNotice> =
  validate1100;

/** The methods of {@link MCP_METHOD_DESCRIPTORS}, each with its checks. */
export interface McpMethodDescriptors {
  readonly "mcp.server.list": {
    readonly method: "mcp.server.list";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<McpServerListRequest>;
    readonly responseCheck: SchemaCheck<McpServerListResponse>;
  };
  readonly "mcp.server.read": {
    readonly method: "mcp.server.read";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<McpServerBindingRef>;
    readonly responseCheck: SchemaCheck<McpServerReadResponse>;
  };
  readonly "mcp.registry.search": {
    readonly method: "mcp.registry.search";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<McpRegistrySearchRequest>;
    readonly responseCheck: SchemaCheck<McpRegistrySearchResponse>;
  };
  readonly "mcp.server.upsert": {
    readonly method: "mcp.server.upsert";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<McpServerUpsertRequest>;
    readonly responseCheck: SchemaCheck<McpServerMutationResponse>;
  };
  readonly "mcp.server.delete": {
    readonly method: "mcp.server.delete";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<McpServerDeleteRequest>;
    readonly responseCheck: SchemaCheck<McpServerDeleteResponse>;
  };
  readonly "mcp.server.enabled.update": {
    readonly method: "mcp.server.enabled.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<McpServerEnabledUpdateRequest>;
    readonly responseCheck: SchemaCheck<McpServerMutationResponse>;
  };
  readonly "mcp.toolOverride.update": {
    readonly method: "mcp.toolOverride.update";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<McpToolOverrideUpdateRequest>;
    readonly responseCheck: SchemaCheck<McpToolOverrideMutationResponse>;
  };
  readonly "mcp.toolOverride.clear": {
    readonly method: "mcp.toolOverride.clear";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<McpToolOverrideClearRequest>;
    readonly responseCheck: SchemaCheck<McpToolOverrideMutationResponse>;
  };
  readonly "mcp.server.signIn": {
    readonly method: "mcp.server.signIn";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<McpServerSignInRequest>;
    readonly responseCheck: SchemaCheck<McpServerSignInResponse>;
  };
  readonly "mcp.server.signOut": {
    readonly method: "mcp.server.signOut";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<McpServerSignOutRequest>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
  readonly "mcp.server.reconnect": {
    readonly method: "mcp.server.reconnect";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<McpServerReconnectRequest>;
    readonly responseCheck: SchemaCheck<McpServerReconnectResponse>;
  };
}
/**
 * Every `mcp.*` method but `mcp.subscribe`, whose emissions are session events and live
 * notices.
 */
export const MCP_METHOD_DESCRIPTORS: McpMethodDescriptors = Object.freeze({
  "mcp.server.list": Object.freeze({
    method: "mcp.server.list",
    procedureType: "query",
    mutating: false,
    requestCheck: validateMcpServerListRequest,
    responseCheck: validateMcpServerListResponse,
  }),
  "mcp.server.read": Object.freeze({
    method: "mcp.server.read",
    procedureType: "query",
    mutating: false,
    requestCheck: validateMcpServerBindingRef,
    responseCheck: validateMcpServerReadResponse,
  }),
  "mcp.registry.search": Object.freeze({
    method: "mcp.registry.search",
    procedureType: "query",
    mutating: false,
    requestCheck: validateMcpRegistrySearchRequest,
    responseCheck: validateMcpRegistrySearchResponse,
  }),
  "mcp.server.upsert": Object.freeze({
    method: "mcp.server.upsert",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateMcpServerUpsertRequest,
    responseCheck: validateMcpServerMutationResponse,
  }),
  "mcp.server.delete": Object.freeze({
    method: "mcp.server.delete",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateMcpServerDeleteRequest,
    responseCheck: validateMcpServerDeleteResponse,
  }),
  "mcp.server.enabled.update": Object.freeze({
    method: "mcp.server.enabled.update",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateMcpServerEnabledUpdateRequest,
    responseCheck: validateMcpServerMutationResponse,
  }),
  "mcp.toolOverride.update": Object.freeze({
    method: "mcp.toolOverride.update",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateMcpToolOverrideUpdateRequest,
    responseCheck: validateMcpToolOverrideMutationResponse,
  }),
  "mcp.toolOverride.clear": Object.freeze({
    method: "mcp.toolOverride.clear",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateMcpToolOverrideClearRequest,
    responseCheck: validateMcpToolOverrideMutationResponse,
  }),
  "mcp.server.signIn": Object.freeze({
    method: "mcp.server.signIn",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateMcpServerSignInRequest,
    responseCheck: validateMcpServerSignInResponse,
  }),
  "mcp.server.signOut": Object.freeze({
    method: "mcp.server.signOut",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateMcpServerSignOutRequest,
    responseCheck: validateEmptyPayload,
  }),
  "mcp.server.reconnect": Object.freeze({
    method: "mcp.server.reconnect",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateMcpServerReconnectRequest,
    responseCheck: validateMcpServerReconnectResponse,
  }),
});
