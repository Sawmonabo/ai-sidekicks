// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Workflow definitions: the node-graph document an author writes and the ids that address a definition and its versions.

import { type CompiledSchemaCheck, ucs2length } from "../../../../schema-check.js";
import type {
  WorkflowContentHash,
  WorkflowDefinitionId,
  WorkflowEdgeId,
  WorkflowNodeId,
  WorkflowVersionId,
} from "../../../workflow/definition/document.js";

// prettier-ignore
const pattern3 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
/** Checks that a value is a {@link WorkflowDefinitionId}. */
// prettier-ignore
export const validateWorkflowDefinitionId: CompiledSchemaCheck<WorkflowDefinitionId> = /* @__PURE__ */ Object.assign(function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowDefinitionId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowDefinitionId.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern3.test(data)){validateWorkflowDefinitionId.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validateWorkflowDefinitionId.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateWorkflowDefinitionId.errors = vErrors;return errors === 0;}, { evaluated: {"dynamicProps":false,"dynamicItems":false} as any });
/** Checks that a value is a {@link WorkflowVersionId}. */
// prettier-ignore
export const validateWorkflowVersionId: CompiledSchemaCheck<WorkflowVersionId> = /* @__PURE__ */ Object.assign(function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowVersionId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowVersionId.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern3.test(data)){validateWorkflowVersionId.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validateWorkflowVersionId.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateWorkflowVersionId.errors = vErrors;return errors === 0;}, { evaluated: {"dynamicProps":false,"dynamicItems":false} as any });
// prettier-ignore
const func2 = ucs2length;
/** Checks that a value is a {@link WorkflowContentHash}. */
// prettier-ignore
export const validateWorkflowContentHash: CompiledSchemaCheck<WorkflowContentHash> = /* @__PURE__ */ Object.assign(function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowContentHash {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowContentHash.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(func2(data) < 1){validateWorkflowContentHash.errors = [{instancePath,schemaPath:"#/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateWorkflowContentHash.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateWorkflowContentHash.errors = vErrors;return errors === 0;}, { evaluated: {"dynamicProps":false,"dynamicItems":false} as any });
/** Checks that a value is a {@link WorkflowNodeId}. */
// prettier-ignore
export const validateWorkflowNodeId: CompiledSchemaCheck<WorkflowNodeId> = /* @__PURE__ */ Object.assign(function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowNodeId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowNodeId.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(func2(data) < 1){validateWorkflowNodeId.errors = [{instancePath,schemaPath:"#/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateWorkflowNodeId.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateWorkflowNodeId.errors = vErrors;return errors === 0;}, { evaluated: {"dynamicProps":false,"dynamicItems":false} as any });
/** Checks that a value is a {@link WorkflowEdgeId}. */
// prettier-ignore
export const validateWorkflowEdgeId: CompiledSchemaCheck<WorkflowEdgeId> = /* @__PURE__ */ Object.assign(function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowEdgeId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowEdgeId.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(func2(data) < 1){validateWorkflowEdgeId.errors = [{instancePath,schemaPath:"#/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateWorkflowEdgeId.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateWorkflowEdgeId.errors = vErrors;return errors === 0;}, { evaluated: {"dynamicProps":false,"dynamicItems":false} as any });
