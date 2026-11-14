// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The MCP governance stream: the stored events of the `mcpGovernance` category, the live notices of an edit to a binding and of a status change, and the `mcp.subscribe` method that carries them.

import { type CompiledSchemaCheck, type SchemaCheck, ucs2length } from "../../schema-check.js";
import { type EventEnvelope, validateEventEnvelope } from "../event/envelope.js";
import {
  type SubscribeAcknowledgmentResponse,
  validateSubscribeAcknowledgmentResponse,
} from "../jsonrpc/streaming.js";
import { type EmptyPayload, validateEmptyPayload } from "../method-descriptor.js";
import {
  type McpServerStatusChangedNotice,
  validateMcpServerStatusChangedNotice,
} from "./governance.js";
import {
  type McpServerConfigChangedNotice,
  validateMcpServerConfigChangedNotice,
} from "./server.js";

/**
 * A stored session event of the `mcpGovernance` category: the event envelope, its `category` held to `mcpGovernance`, and its `type` and `payload` kept as written.
 */
export type McpGovernanceEvent = EventEnvelope & {
  category?: "mcpGovernance";
};
/**
 * One `mcp.subscribe` frame: the live notice of an edit to a binding or of a status change, or a
 * governance event. The stream reads governance events from the sentinel session's log at the
 * subscriber's place and sends each notice's newest value per binding and source (a session's
 * leg, the machine probe, an edit), so it keeps no queue, no cursor and no dropped mark.
 */
export type McpSubscribeEmission =
  | McpServerConfigChangedNotice
  | McpServerStatusChangedNotice
  | McpGovernanceEvent;

/** Checks that a value is a {@link McpGovernanceEvent}. */
// prettier-ignore
export const validateMcpGovernanceEvent: CompiledSchemaCheck<McpGovernanceEvent> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is McpGovernanceEvent {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateMcpGovernanceEvent.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;if(!(validateEventEnvelope.call(this, data, {instancePath,parentData,parentDataProperty,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateEventEnvelope.errors : vErrors.concat(validateEventEnvelope.errors);errors = vErrors.length;}var valid0: any = _errs0 === errors;if(valid0){const _errs1: any = errors;if(errors === _errs1){if(data && typeof data == "object" && !Array.isArray(data)){if(data.category !== undefined){if("mcpGovernance" !== data.category){validateMcpGovernanceEvent.errors = [{instancePath:instancePath+"/category",schemaPath:"#/allOf/1/properties/category/const",keyword:"const",params:{allowedValue: "mcpGovernance"}}];return false;}}}else {validateMcpGovernanceEvent.errors = [{instancePath,schemaPath:"#/allOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid0: any = _errs1 === errors;}validateMcpGovernanceEvent.errors = vErrors;return errors === 0;};
// prettier-ignore
validateMcpGovernanceEvent.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link McpSubscribeEmission}. */
// prettier-ignore
export const validateMcpSubscribeEmission: CompiledSchemaCheck<McpSubscribeEmission> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is McpSubscribeEmission {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateMcpSubscribeEmission.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;const _errs1: any = errors;if(!(validateMcpServerConfigChangedNotice.call(this, data, {instancePath,parentData,parentDataProperty,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateMcpServerConfigChangedNotice.errors : vErrors.concat(validateMcpServerConfigChangedNotice.errors);errors = vErrors.length;}var _valid0: any = _errs1 === errors;valid0 = valid0 || _valid0;if(_valid0){var props0: any = true;}const _errs2: any = errors;if(!(validateMcpServerStatusChangedNotice.call(this, data, {instancePath,parentData,parentDataProperty,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateMcpServerStatusChangedNotice.errors : vErrors.concat(validateMcpServerStatusChangedNotice.errors);errors = vErrors.length;}var _valid0: any = _errs2 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}const _errs3: any = errors;if(!(validateMcpGovernanceEvent.call(this, data, {instancePath,parentData,parentDataProperty,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateMcpGovernanceEvent.errors : vErrors.concat(validateMcpGovernanceEvent.errors);errors = vErrors.length;}var _valid0: any = _errs3 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}if(!valid0){const err0: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;validateMcpSubscribeEmission.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validateMcpSubscribeEmission.errors = vErrors;evaluated0.props = props0;return errors === 0;};
// prettier-ignore
validateMcpSubscribeEmission.evaluated = {"dynamicProps":true,"dynamicItems":false} as any;

/** The methods of {@link MCP_EVENT_METHOD_DESCRIPTORS}, each with its checks. */
export interface McpEventMethodDescriptors {
  readonly "mcp.subscribe": {
    readonly method: "mcp.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<SubscribeAcknowledgmentResponse>;
    readonly emissionCheck: SchemaCheck<McpSubscribeEmission>;
  };
}
/**
 * `mcp.subscribe`, the MCP governance stream, opened before `mcp.server.list` is read so
 * nothing falls between the two. It reads governance events from the sentinel session's log at
 * the subscriber's place and sends each notice's newest value per binding and source (a
 * session's leg, the machine probe, an edit): no cursor, no dropped mark.
 */
export const MCP_EVENT_METHOD_DESCRIPTORS: McpEventMethodDescriptors = Object.freeze({
  "mcp.subscribe": Object.freeze({
    method: "mcp.subscribe",
    procedureType: "subscription",
    mutating: false,
    requestCheck: validateEmptyPayload,
    responseCheck: validateSubscribeAcknowledgmentResponse,
    emissionCheck: validateMcpSubscribeEmission,
  }),
});
