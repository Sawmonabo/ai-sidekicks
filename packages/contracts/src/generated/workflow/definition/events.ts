// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The events a workflow appends before any run exists: a version written, and a trigger or schedule armed or fired, each naming the workflow rather than a run.

import { type SchemaCheck, ucs2length } from "../../../schema-check.js";
import type { WireInstant } from "../../internal/wire-scalars.js";
import type { SessionId } from "../../session/id.js";
import type { WorkflowDefinitionId, WorkflowNodeId, WorkflowVersionId } from "./document.js";

/**
 * `workflow.version.created`: a workflow was authored or a new version of it written; no run
 * exists yet, so it names the workflow and the version alone.
 */
export interface WorkflowVersionCreatedPayload {
  /**
   * The session the event is written to.
   */
  sessionId: SessionId;
  /**
   * The workflow.
   */
  definitionId: WorkflowDefinitionId;
  /**
   * The version written.
   */
  workflowVersionId: WorkflowVersionId;
}
/**
 * `workflow.schedule.armed` and `workflow.trigger.armed`: a schedule, or a file watch, webhook or
 * session-event filter, was armed on the workflow's trigger node.
 */
export interface WorkflowTriggerArmedPayload {
  /**
   * The session the event is written to.
   */
  sessionId: SessionId;
  /**
   * The workflow.
   */
  definitionId: WorkflowDefinitionId;
  /**
   * The trigger node armed.
   */
  nodeId: WorkflowNodeId;
}
/**
 * `workflow.schedule.fired` and `workflow.trigger.fired`: an armed trigger fired, starting a run.
 * The workflow, the node and `scheduledInstant` together name the occurrence, so neither a restart
 * nor a second arming fires it twice.
 */
export interface WorkflowTriggerFiredPayload {
  /**
   * The session the event is written to.
   */
  sessionId: SessionId;
  /**
   * The workflow.
   */
  definitionId: WorkflowDefinitionId;
  /**
   * The trigger node that fired.
   */
  nodeId: WorkflowNodeId;
  /**
   * The occurrence's instant.
   */
  scheduledInstant: WireInstant;
}

// prettier-ignore
const pattern4 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
function validate2360(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowTriggerArmedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2360.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.definitionId === undefined) && (missing0 = "definitionId"))) || ((data.nodeId === undefined) && (missing0 = "nodeId"))){validate2360.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "definitionId")) || (key0 === "nodeId"))){validate2360.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2360.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2360.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.definitionId !== undefined){let data1: any = data.definitionId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate2360.errors = [{instancePath:instancePath+"/definitionId",schemaPath:"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowDefinitionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2360.errors = [{instancePath:instancePath+"/definitionId",schemaPath:"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowDefinitionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.nodeId !== undefined){let data2: any = data.nodeId;const _errs10: any = errors;const _errs11: any = errors;if(errors === _errs11){if(typeof data2 === "string"){if(func1(data2) < 1){validate2360.errors = [{instancePath:instancePath+"/nodeId",schemaPath:"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowNodeId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate2360.errors = [{instancePath:instancePath+"/nodeId",schemaPath:"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowNodeId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}}}}}}else {validate2360.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2360.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2360.errors = null as any[] | null;
// prettier-ignore
validate2360.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern5 = new RegExp("^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$", "u");
// prettier-ignore
function validate2361(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowTriggerFiredPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2361.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.definitionId === undefined) && (missing0 = "definitionId"))) || ((data.nodeId === undefined) && (missing0 = "nodeId"))) || ((data.scheduledInstant === undefined) && (missing0 = "scheduledInstant"))){validate2361.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((key0 === "sessionId") || (key0 === "definitionId")) || (key0 === "nodeId")) || (key0 === "scheduledInstant"))){validate2361.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2361.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2361.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.definitionId !== undefined){let data1: any = data.definitionId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate2361.errors = [{instancePath:instancePath+"/definitionId",schemaPath:"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowDefinitionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2361.errors = [{instancePath:instancePath+"/definitionId",schemaPath:"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowDefinitionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.nodeId !== undefined){let data2: any = data.nodeId;const _errs10: any = errors;const _errs11: any = errors;if(errors === _errs11){if(typeof data2 === "string"){if(func1(data2) < 1){validate2361.errors = [{instancePath:instancePath+"/nodeId",schemaPath:"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowNodeId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate2361.errors = [{instancePath:instancePath+"/nodeId",schemaPath:"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowNodeId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.scheduledInstant !== undefined){let data3: any = data.scheduledInstant;const _errs14: any = errors;const _errs15: any = errors;if(errors === _errs15){if(typeof data3 === "string"){if(!pattern5.test(data3)){validate2361.errors = [{instancePath:instancePath+"/scheduledInstant",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/pattern",keyword:"pattern",params:{pattern: "^(?:(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29|[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|(?:02)-(?:0[1-9]|1[0-9]|2[0-8])))T(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]+)?(?:Z|([+-](?:[01][0-9]|2[0-3]):[0-5][0-9])))$"}}];return false;}}else {validate2361.errors = [{instancePath:instancePath+"/scheduledInstant",schemaPath:"sidekicks-contracts:internal/wire-scalars#/$defs/WireInstant/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs14 === errors;}else {var valid0: any = true;}}}}}}}else {validate2361.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2361.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2361.errors = null as any[] | null;
// prettier-ignore
validate2361.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2362(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowVersionCreatedPayload {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2362.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.sessionId === undefined) && (missing0 = "sessionId")) || ((data.definitionId === undefined) && (missing0 = "definitionId"))) || ((data.workflowVersionId === undefined) && (missing0 = "workflowVersionId"))){validate2362.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "sessionId") || (key0 === "definitionId")) || (key0 === "workflowVersionId"))){validate2362.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.sessionId !== undefined){let data0: any = data.sessionId;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(!pattern4.test(data0)){validate2362.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2362.errors = [{instancePath:instancePath+"/sessionId",schemaPath:"sidekicks-contracts:session/id#/$defs/SessionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.definitionId !== undefined){let data1: any = data.definitionId;const _errs6: any = errors;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern4.test(data1)){validate2362.errors = [{instancePath:instancePath+"/definitionId",schemaPath:"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowDefinitionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2362.errors = [{instancePath:instancePath+"/definitionId",schemaPath:"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowDefinitionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.workflowVersionId !== undefined){let data2: any = data.workflowVersionId;const _errs10: any = errors;const _errs11: any = errors;if(errors === _errs11){if(typeof data2 === "string"){if(!pattern4.test(data2)){validate2362.errors = [{instancePath:instancePath+"/workflowVersionId",schemaPath:"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowVersionId/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validate2362.errors = [{instancePath:instancePath+"/workflowVersionId",schemaPath:"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowVersionId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}}}}}}else {validate2362.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2362.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2362.errors = null as any[] | null;
// prettier-ignore
validate2362.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowTriggerArmedPayload}. */
export const validateWorkflowTriggerArmedPayload: SchemaCheck<WorkflowTriggerArmedPayload> =
  validate2360;
/** Checks that a value is a {@link WorkflowTriggerFiredPayload}. */
export const validateWorkflowTriggerFiredPayload: SchemaCheck<WorkflowTriggerFiredPayload> =
  validate2361;
/** Checks that a value is a {@link WorkflowVersionCreatedPayload}. */
export const validateWorkflowVersionCreatedPayload: SchemaCheck<WorkflowVersionCreatedPayload> =
  validate2362;
