// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The node catalog: every node kind the daemon runs, as `workflow.kind.list` serializes it.

import {
  type CompiledSchemaCheck,
  type SchemaCheck,
  deepEqual,
  ucs2length,
} from "../../schema-check.js";
import { type EmptyPayload, validateEmptyPayload } from "../method-descriptor.js";
import { type WorkflowNodeKindId, validateWorkflowNodeKindId } from "./definition/document.js";

/** The name a person reads for each node kind the catalog ships, by the kind's key. */
export const WORKFLOW_NODE_KIND_NAMES = {
  "agent.askQuestion": "Ask a question",
  "agent.multiAgent": "Run a sidekick team",
  "agent.run": "Run a sidekick",
  "browser.act": "Act on a page",
  "browser.extract": "Extract from a page",
  "browser.open": "Open a page",
  "browser.screenshot": "Screenshot",
  "developer.callbackTool": "App tool",
  "developer.code": "Code",
  "developer.git": "Git",
  "developer.http": "HTTP request",
  "developer.mcpTool": "MCP tool",
  "developer.repoDiff": "Read a repo diff",
  "developer.runTests": "Run tests",
  "developer.shell": "Run a command",
  "files.ingestArtifacts": "Ingest as artifacts",
  "files.parse": "Parse",
  "files.read": "Read files",
  "files.template": "Render a template",
  "files.write": "Write files",
  "flow.executeWorkflow": "Execute workflow",
  "flow.if": "If",
  "flow.loopItems": "Loop over items",
  "flow.merge": "Merge",
  "flow.setVars": "Set variables",
  "flow.stopError": "Stop with error",
  "flow.switch": "Switch",
  "flow.wait": "Wait",
  "human.approval": "Ask for approval",
  "human.form": "Ask for a form",
  "human.waitForChatReply": "Wait for a chat reply",
  "output.notify": "Notify",
  "output.saveArtifact": "Save as artifact",
  "output.writeSummary": "Write a summary",
  "trigger.chat": "From chat",
  "trigger.error": "When a workflow fails",
  "trigger.fileWatch": "On a file change",
  "trigger.manual": "Run manually",
  "trigger.schedule": "On a schedule",
  "trigger.sessionEvent": "On a session event",
  "trigger.subWorkflow": "Called by a workflow",
  "trigger.webhook": "On a webhook",
} as const;

/**
 * The categories the palette groups kinds under.
 */
export type WorkflowNodeKindCategory =
  | "trigger"
  | "agent"
  | "human"
  | "files"
  | "browser"
  | "developer"
  | "flow"
  | "output";
/**
 * One input handle a kind declares. `maxConnections` absent means the handle takes any number
 * of edges.
 */
export type WorkflowInputHandleSpec =
  | {
      type: "main";
      /**
       * The handle's id.
       */
      id: string;
      /**
       * The handle's label.
       */
      label: string;
      /**
       * The most edges the handle takes; absent, any number.
       */
      maxConnections?: number;
      /**
       * Whether the handle must be connected.
       */
      required?: boolean;
    }
  | {
      type: "tool";
      /**
       * The handle's id.
       */
      id: string;
      /**
       * The handle's label.
       */
      label: string;
      /**
       * The most edges the handle takes; absent, any number.
       */
      maxConnections?: number;
      /**
       * Whether the handle must be connected.
       */
      required?: boolean;
    };
/**
 * One output handle a kind declares. `maxConnections` absent means the handle takes any
 * number of edges.
 */
export type WorkflowOutputHandleSpec =
  | {
      type: "main";
      /**
       * The handle's id.
       */
      id: string;
      /**
       * The handle's label.
       */
      label: string;
      /**
       * The most edges the handle takes; absent, any number.
       */
      maxConnections?: number;
      /**
       * Whether the handle must be connected.
       */
      required?: boolean;
    }
  | {
      type: "tool";
      /**
       * The handle's id.
       */
      id: string;
      /**
       * The handle's label.
       */
      label: string;
      /**
       * The most edges the handle takes; absent, any number.
       */
      maxConnections?: number;
      /**
       * Whether the handle must be connected.
       */
      required?: boolean;
    };
/**
 * The type of one leaf parameter, which picks the field the inspector draws.
 */
export type WorkflowParamType =
  | "string"
  | "text"
  | "number"
  | "boolean"
  | "select"
  | "multiselect"
  | "json"
  | "expression"
  | "path"
  | "glob"
  | "cron"
  | "secret"
  | "agent"
  | "mcpTool"
  | "callbackTool"
  | "session"
  | "project";
/**
 * A parameter's id, which a node's params are keyed by.
 */
export type WorkflowParamId = string;
/**
 * The type of a parameter that nests a field list.
 */
export type WorkflowCollectionParamType = "collection";
/**
 * One parameter a kind declares: a leaf of one type, or a collection that nests a field list.
 */
export type WorkflowParamSpec = WorkflowLeafParamSpec | WorkflowCollectionParamSpec;
/**
 * What running a kind can change: nothing, this machine, or something beyond it.
 */
export type WorkflowNodeSideEffects = "none" | "local" | "external";

/**
 * One choice a `select` or `multiselect` parameter offers.
 */
export interface WorkflowParamOption {
  /**
   * The value the parameter takes.
   */
  value: unknown;
  /**
   * The label a person reads.
   */
  label: string;
}
/**
 * A leaf parameter: one declared type. `showWhen` is the whole conditional form: the parameter is
 * drawn when each named sibling holds one of the listed values. `sensitive` marks the only
 * parameters a `secret://` reference resolves in.
 */
export interface WorkflowLeafParamSpec {
  /**
   * The parameter's id.
   */
  id: WorkflowParamId;
  /**
   * The label a person reads.
   */
  label: string;
  /**
   * The parameter's type.
   */
  type: WorkflowParamType;
  /**
   * Whether the parameter must be filled.
   */
  required?: boolean;
  /**
   * Whether a `secret://` reference resolves in the parameter.
   */
  sensitive?: boolean;
  /**
   * The value the parameter starts on.
   */
  default?: unknown;
  /**
   * The help line.
   */
  help?: string;
  /**
   * The choices.
   */
  options?: WorkflowParamOption[];
  /**
   * The sibling values the parameter is drawn under, by sibling id.
   */
  showWhen?: {
    [k: string]: unknown[] | undefined;
  };
}
/**
 * A parameter that nests a field list and may repeat.
 */
export interface WorkflowCollectionParamSpec {
  /**
   * The parameter's id.
   */
  id: WorkflowParamId;
  /**
   * The label a person reads.
   */
  label: string;
  /**
   * Always `collection`.
   */
  type: "collection";
  /**
   * The nested fields.
   */
  fields: WorkflowParamSpec[];
  /**
   * Whether the field list repeats.
   */
  multiple?: boolean;
}
/**
 * What a kind's run can do: be canceled, resume after a restart, what it can change, whether it
 * needs a project's repository, and when it runs in its provider's sandbox.
 */
export interface WorkflowNodeCapabilities {
  /**
   * Whether a run of the kind can be canceled.
   */
  cancelable: boolean;
  /**
   * Whether a run of the kind resumes after a restart.
   */
  resumable: boolean;
  /**
   * What a run of the kind can change.
   */
  sideEffects: WorkflowNodeSideEffects;
  /**
   * Whether a run of the kind needs the run to work in a project's repository.
   */
  repository: boolean;
  /**
   * When a run of the kind starts a process in its provider's sandbox: absent for never, an
   * empty record for always, otherwise when each named param's value is one of its listed
   * values, as a param's `showWhen` reads.
   */
  sandbox?: {
    [k: string]: unknown[] | undefined;
  };
}
/**
 * One kind as the catalog serializes it. `version` is the implementation a newly placed node
 * records; a placed node keeps the version it recorded. Each handle id appears once on its side,
 * since an edge names a handle by id alone.
 */
export interface WorkflowNodeKindSpec {
  /**
   * The kind's key.
   */
  kind: WorkflowNodeKindId;
  /**
   * The implementation a newly placed node records.
   */
  version: number;
  /**
   * The palette's group.
   */
  category: WorkflowNodeKindCategory;
  /**
   * The name a person reads.
   */
  displayName: string;
  /**
   * What the kind does.
   */
  description: string;
  /**
   * The kind's icon.
   */
  icon: string;
  /**
   * Other words the palette's search finds the kind by.
   */
  aliases?: string[];
  /**
   * The input handles, each id once.
   */
  inputs: WorkflowInputHandleSpec[];
  /**
   * The output handles, each id once.
   */
  outputs: WorkflowOutputHandleSpec[];
  /**
   * Whether the listed outputs are the base case of a set the node's params derive.
   */
  outputsDeriveFromParams: boolean;
  /**
   * The parameters.
   */
  params: WorkflowParamSpec[];
  /**
   * Whether the kind runs once per item rather than once over all of them.
   */
  perItem?: boolean;
  /**
   * What a run of the kind can do.
   */
  capabilities?: WorkflowNodeCapabilities;
}
/**
 * The `workflow.kind.list` result: every kind the daemon runs.
 */
export interface WorkflowKindListResponse {
  /**
   * The kinds.
   */
  kinds: WorkflowNodeKindSpec[];
}

// prettier-ignore
const schema1497: any = {"description":"The categories the palette groups kinds under.","type":"string","enum":["trigger","agent","human","files","browser","developer","flow","output"]};
/** Checks that a value is a {@link WorkflowNodeKindCategory}. */
// prettier-ignore
export const validateWorkflowNodeKindCategory: CompiledSchemaCheck<WorkflowNodeKindCategory> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowNodeKindCategory {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowNodeKindCategory.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateWorkflowNodeKindCategory.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!((((((((data === "trigger") || (data === "agent")) || (data === "human")) || (data === "files")) || (data === "browser")) || (data === "developer")) || (data === "flow")) || (data === "output"))){validateWorkflowNodeKindCategory.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema1497.enum}}];return false;}validateWorkflowNodeKindCategory.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowNodeKindCategory.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern930 = new RegExp("^inputs/main/(?:0|[1-9][0-9]{0,14}|[1-8][0-9]{15}|900[0-6][0-9]{12}|9007[0-0][0-9]{11}|90071[0-8][0-9]{10}|900719[0-8][0-9]{9}|9007199[0-1][0-9]{8}|90071992[0-4][0-9]{7}|900719925[0-3][0-9]{6}|9007199254[0-6][0-9]{5}|90071992547[0-3][0-9]{4}|9007199254740[0-8][0-9]{2}|90071992547409[0-8][0-9]{1}|900719925474099[0-0][0-9]{0}|9007199254740991)$", "u");
// prettier-ignore
const pattern931 = new RegExp("^inputs/tool/(?:0|[1-9][0-9]{0,14}|[1-8][0-9]{15}|900[0-6][0-9]{12}|9007[0-0][0-9]{11}|90071[0-8][0-9]{10}|900719[0-8][0-9]{9}|9007199[0-1][0-9]{8}|90071992[0-4][0-9]{7}|900719925[0-3][0-9]{6}|9007199254[0-6][0-9]{5}|90071992547[0-3][0-9]{4}|9007199254740[0-8][0-9]{2}|90071992547409[0-8][0-9]{1}|900719925474099[0-0][0-9]{0}|9007199254740991)$", "u");
// prettier-ignore
const func1 = ucs2length;
/** Checks that a value is a {@link WorkflowInputHandleSpec}. */
// prettier-ignore
export const validateWorkflowInputHandleSpec: CompiledSchemaCheck<WorkflowInputHandleSpec> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowInputHandleSpec {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowInputHandleSpec.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.type;if(typeof tag0 == "string"){if(tag0 === "main"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.type === undefined) && (missing0 = "type")) || ((data.id === undefined) && (missing0 = "id"))) || ((data.label === undefined) && (missing0 = "label"))){validateWorkflowInputHandleSpec.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!(((((key0 === "type") || (key0 === "id")) || (key0 === "label")) || (key0 === "maxConnections")) || (key0 === "required"))){validateWorkflowInputHandleSpec.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.type !== undefined){let data0: any = data.type;const _errs5: any = errors;if(typeof data0 !== "string"){validateWorkflowInputHandleSpec.errors = [{instancePath:instancePath+"/type",schemaPath:"#/oneOf/0/properties/type/type",keyword:"type",params:{type: "string"}}];return false;}if("main" !== data0){validateWorkflowInputHandleSpec.errors = [{instancePath:instancePath+"/type",schemaPath:"#/oneOf/0/properties/type/const",keyword:"const",params:{allowedValue: "main"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.id !== undefined){let data1: any = data.id;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern930.test(data1)){validateWorkflowInputHandleSpec.errors = [{instancePath:instancePath+"/id",schemaPath:"#/oneOf/0/properties/id/pattern",keyword:"pattern",params:{pattern: "^inputs/main/(?:0|[1-9][0-9]{0,14}|[1-8][0-9]{15}|900[0-6][0-9]{12}|9007[0-0][0-9]{11}|90071[0-8][0-9]{10}|900719[0-8][0-9]{9}|9007199[0-1][0-9]{8}|90071992[0-4][0-9]{7}|900719925[0-3][0-9]{6}|9007199254[0-6][0-9]{5}|90071992547[0-3][0-9]{4}|9007199254740[0-8][0-9]{2}|90071992547409[0-8][0-9]{1}|900719925474099[0-0][0-9]{0}|9007199254740991)$"}}];return false;}}else {validateWorkflowInputHandleSpec.errors = [{instancePath:instancePath+"/id",schemaPath:"#/oneOf/0/properties/id/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}if(valid2){if(data.label !== undefined){let data2: any = data.label;const _errs9: any = errors;if(errors === _errs9){if(typeof data2 === "string"){if(func1(data2) < 1){validateWorkflowInputHandleSpec.errors = [{instancePath:instancePath+"/label",schemaPath:"#/oneOf/0/properties/label/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateWorkflowInputHandleSpec.errors = [{instancePath:instancePath+"/label",schemaPath:"#/oneOf/0/properties/label/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs9 === errors;}else {var valid2: any = true;}if(valid2){if(data.maxConnections !== undefined){let data3: any = data.maxConnections;const _errs11: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validateWorkflowInputHandleSpec.errors = [{instancePath:instancePath+"/maxConnections",schemaPath:"#/oneOf/0/properties/maxConnections/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs11){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 9007199254740991 || isNaN(data3)){validateWorkflowInputHandleSpec.errors = [{instancePath:instancePath+"/maxConnections",schemaPath:"#/oneOf/0/properties/maxConnections/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data3 < 1 || isNaN(data3)){validateWorkflowInputHandleSpec.errors = [{instancePath:instancePath+"/maxConnections",schemaPath:"#/oneOf/0/properties/maxConnections/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid2: any = _errs11 === errors;}else {var valid2: any = true;}if(valid2){if(data.required !== undefined){const _errs13: any = errors;if(typeof data.required !== "boolean"){validateWorkflowInputHandleSpec.errors = [{instancePath:instancePath+"/required",schemaPath:"#/oneOf/0/properties/required/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid2: any = _errs13 === errors;}else {var valid2: any = true;}}}}}}}}else {validateWorkflowInputHandleSpec.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "tool"){const _errs15: any = errors;if(errors === _errs15){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((data.type === undefined) && (missing1 = "type")) || ((data.id === undefined) && (missing1 = "id"))) || ((data.label === undefined) && (missing1 = "label"))){validateWorkflowInputHandleSpec.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs17: any = errors;for(const key1 in data){if(!(((((key1 === "type") || (key1 === "id")) || (key1 === "label")) || (key1 === "maxConnections")) || (key1 === "required"))){validateWorkflowInputHandleSpec.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs17 === errors){if(data.type !== undefined){let data5: any = data.type;const _errs18: any = errors;if(typeof data5 !== "string"){validateWorkflowInputHandleSpec.errors = [{instancePath:instancePath+"/type",schemaPath:"#/oneOf/1/properties/type/type",keyword:"type",params:{type: "string"}}];return false;}if("tool" !== data5){validateWorkflowInputHandleSpec.errors = [{instancePath:instancePath+"/type",schemaPath:"#/oneOf/1/properties/type/const",keyword:"const",params:{allowedValue: "tool"}}];return false;}var valid4: any = _errs18 === errors;}else {var valid4: any = true;}if(valid4){if(data.id !== undefined){let data6: any = data.id;const _errs20: any = errors;if(errors === _errs20){if(typeof data6 === "string"){if(!pattern931.test(data6)){validateWorkflowInputHandleSpec.errors = [{instancePath:instancePath+"/id",schemaPath:"#/oneOf/1/properties/id/pattern",keyword:"pattern",params:{pattern: "^inputs/tool/(?:0|[1-9][0-9]{0,14}|[1-8][0-9]{15}|900[0-6][0-9]{12}|9007[0-0][0-9]{11}|90071[0-8][0-9]{10}|900719[0-8][0-9]{9}|9007199[0-1][0-9]{8}|90071992[0-4][0-9]{7}|900719925[0-3][0-9]{6}|9007199254[0-6][0-9]{5}|90071992547[0-3][0-9]{4}|9007199254740[0-8][0-9]{2}|90071992547409[0-8][0-9]{1}|900719925474099[0-0][0-9]{0}|9007199254740991)$"}}];return false;}}else {validateWorkflowInputHandleSpec.errors = [{instancePath:instancePath+"/id",schemaPath:"#/oneOf/1/properties/id/type",keyword:"type",params:{type: "string"}}];return false;}}var valid4: any = _errs20 === errors;}else {var valid4: any = true;}if(valid4){if(data.label !== undefined){let data7: any = data.label;const _errs22: any = errors;if(errors === _errs22){if(typeof data7 === "string"){if(func1(data7) < 1){validateWorkflowInputHandleSpec.errors = [{instancePath:instancePath+"/label",schemaPath:"#/oneOf/1/properties/label/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateWorkflowInputHandleSpec.errors = [{instancePath:instancePath+"/label",schemaPath:"#/oneOf/1/properties/label/type",keyword:"type",params:{type: "string"}}];return false;}}var valid4: any = _errs22 === errors;}else {var valid4: any = true;}if(valid4){if(data.maxConnections !== undefined){let data8: any = data.maxConnections;const _errs24: any = errors;if(!(((typeof data8 == "number") && (!(data8 % 1) && !isNaN(data8))) && (isFinite(data8)))){validateWorkflowInputHandleSpec.errors = [{instancePath:instancePath+"/maxConnections",schemaPath:"#/oneOf/1/properties/maxConnections/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs24){if((typeof data8 == "number") && (isFinite(data8))){if(data8 > 9007199254740991 || isNaN(data8)){validateWorkflowInputHandleSpec.errors = [{instancePath:instancePath+"/maxConnections",schemaPath:"#/oneOf/1/properties/maxConnections/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data8 < 1 || isNaN(data8)){validateWorkflowInputHandleSpec.errors = [{instancePath:instancePath+"/maxConnections",schemaPath:"#/oneOf/1/properties/maxConnections/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid4: any = _errs24 === errors;}else {var valid4: any = true;}if(valid4){if(data.required !== undefined){const _errs26: any = errors;if(typeof data.required !== "boolean"){validateWorkflowInputHandleSpec.errors = [{instancePath:instancePath+"/required",schemaPath:"#/oneOf/1/properties/required/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid4: any = _errs26 === errors;}else {var valid4: any = true;}}}}}}}}else {validateWorkflowInputHandleSpec.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid3: any = _errs15 === errors;if(props0 !== true){props0 = true;}valid0 = valid3;}else {validateWorkflowInputHandleSpec.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "type", tagValue: tag0}}];return false;}}else {validateWorkflowInputHandleSpec.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "type", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key2 in data){if(!props0 || !props0[key2]){validateWorkflowInputHandleSpec.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key2}}];return false;break;}}}}}else {validateWorkflowInputHandleSpec.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowInputHandleSpec.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowInputHandleSpec.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const pattern932 = new RegExp("^outputs/main/(?:0|[1-9][0-9]{0,14}|[1-8][0-9]{15}|900[0-6][0-9]{12}|9007[0-0][0-9]{11}|90071[0-8][0-9]{10}|900719[0-8][0-9]{9}|9007199[0-1][0-9]{8}|90071992[0-4][0-9]{7}|900719925[0-3][0-9]{6}|9007199254[0-6][0-9]{5}|90071992547[0-3][0-9]{4}|9007199254740[0-8][0-9]{2}|90071992547409[0-8][0-9]{1}|900719925474099[0-0][0-9]{0}|9007199254740991)$", "u");
// prettier-ignore
const pattern933 = new RegExp("^outputs/tool/(?:0|[1-9][0-9]{0,14}|[1-8][0-9]{15}|900[0-6][0-9]{12}|9007[0-0][0-9]{11}|90071[0-8][0-9]{10}|900719[0-8][0-9]{9}|9007199[0-1][0-9]{8}|90071992[0-4][0-9]{7}|900719925[0-3][0-9]{6}|9007199254[0-6][0-9]{5}|90071992547[0-3][0-9]{4}|9007199254740[0-8][0-9]{2}|90071992547409[0-8][0-9]{1}|900719925474099[0-0][0-9]{0}|9007199254740991)$", "u");
/** Checks that a value is a {@link WorkflowOutputHandleSpec}. */
// prettier-ignore
export const validateWorkflowOutputHandleSpec: CompiledSchemaCheck<WorkflowOutputHandleSpec> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowOutputHandleSpec {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowOutputHandleSpec.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.type;if(typeof tag0 == "string"){if(tag0 === "main"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.type === undefined) && (missing0 = "type")) || ((data.id === undefined) && (missing0 = "id"))) || ((data.label === undefined) && (missing0 = "label"))){validateWorkflowOutputHandleSpec.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!(((((key0 === "type") || (key0 === "id")) || (key0 === "label")) || (key0 === "maxConnections")) || (key0 === "required"))){validateWorkflowOutputHandleSpec.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.type !== undefined){let data0: any = data.type;const _errs5: any = errors;if(typeof data0 !== "string"){validateWorkflowOutputHandleSpec.errors = [{instancePath:instancePath+"/type",schemaPath:"#/oneOf/0/properties/type/type",keyword:"type",params:{type: "string"}}];return false;}if("main" !== data0){validateWorkflowOutputHandleSpec.errors = [{instancePath:instancePath+"/type",schemaPath:"#/oneOf/0/properties/type/const",keyword:"const",params:{allowedValue: "main"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.id !== undefined){let data1: any = data.id;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(!pattern932.test(data1)){validateWorkflowOutputHandleSpec.errors = [{instancePath:instancePath+"/id",schemaPath:"#/oneOf/0/properties/id/pattern",keyword:"pattern",params:{pattern: "^outputs/main/(?:0|[1-9][0-9]{0,14}|[1-8][0-9]{15}|900[0-6][0-9]{12}|9007[0-0][0-9]{11}|90071[0-8][0-9]{10}|900719[0-8][0-9]{9}|9007199[0-1][0-9]{8}|90071992[0-4][0-9]{7}|900719925[0-3][0-9]{6}|9007199254[0-6][0-9]{5}|90071992547[0-3][0-9]{4}|9007199254740[0-8][0-9]{2}|90071992547409[0-8][0-9]{1}|900719925474099[0-0][0-9]{0}|9007199254740991)$"}}];return false;}}else {validateWorkflowOutputHandleSpec.errors = [{instancePath:instancePath+"/id",schemaPath:"#/oneOf/0/properties/id/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}if(valid2){if(data.label !== undefined){let data2: any = data.label;const _errs9: any = errors;if(errors === _errs9){if(typeof data2 === "string"){if(func1(data2) < 1){validateWorkflowOutputHandleSpec.errors = [{instancePath:instancePath+"/label",schemaPath:"#/oneOf/0/properties/label/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateWorkflowOutputHandleSpec.errors = [{instancePath:instancePath+"/label",schemaPath:"#/oneOf/0/properties/label/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs9 === errors;}else {var valid2: any = true;}if(valid2){if(data.maxConnections !== undefined){let data3: any = data.maxConnections;const _errs11: any = errors;if(!(((typeof data3 == "number") && (!(data3 % 1) && !isNaN(data3))) && (isFinite(data3)))){validateWorkflowOutputHandleSpec.errors = [{instancePath:instancePath+"/maxConnections",schemaPath:"#/oneOf/0/properties/maxConnections/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs11){if((typeof data3 == "number") && (isFinite(data3))){if(data3 > 9007199254740991 || isNaN(data3)){validateWorkflowOutputHandleSpec.errors = [{instancePath:instancePath+"/maxConnections",schemaPath:"#/oneOf/0/properties/maxConnections/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data3 < 1 || isNaN(data3)){validateWorkflowOutputHandleSpec.errors = [{instancePath:instancePath+"/maxConnections",schemaPath:"#/oneOf/0/properties/maxConnections/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid2: any = _errs11 === errors;}else {var valid2: any = true;}if(valid2){if(data.required !== undefined){const _errs13: any = errors;if(typeof data.required !== "boolean"){validateWorkflowOutputHandleSpec.errors = [{instancePath:instancePath+"/required",schemaPath:"#/oneOf/0/properties/required/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid2: any = _errs13 === errors;}else {var valid2: any = true;}}}}}}}}else {validateWorkflowOutputHandleSpec.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "tool"){const _errs15: any = errors;if(errors === _errs15){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((data.type === undefined) && (missing1 = "type")) || ((data.id === undefined) && (missing1 = "id"))) || ((data.label === undefined) && (missing1 = "label"))){validateWorkflowOutputHandleSpec.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs17: any = errors;for(const key1 in data){if(!(((((key1 === "type") || (key1 === "id")) || (key1 === "label")) || (key1 === "maxConnections")) || (key1 === "required"))){validateWorkflowOutputHandleSpec.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs17 === errors){if(data.type !== undefined){let data5: any = data.type;const _errs18: any = errors;if(typeof data5 !== "string"){validateWorkflowOutputHandleSpec.errors = [{instancePath:instancePath+"/type",schemaPath:"#/oneOf/1/properties/type/type",keyword:"type",params:{type: "string"}}];return false;}if("tool" !== data5){validateWorkflowOutputHandleSpec.errors = [{instancePath:instancePath+"/type",schemaPath:"#/oneOf/1/properties/type/const",keyword:"const",params:{allowedValue: "tool"}}];return false;}var valid4: any = _errs18 === errors;}else {var valid4: any = true;}if(valid4){if(data.id !== undefined){let data6: any = data.id;const _errs20: any = errors;if(errors === _errs20){if(typeof data6 === "string"){if(!pattern933.test(data6)){validateWorkflowOutputHandleSpec.errors = [{instancePath:instancePath+"/id",schemaPath:"#/oneOf/1/properties/id/pattern",keyword:"pattern",params:{pattern: "^outputs/tool/(?:0|[1-9][0-9]{0,14}|[1-8][0-9]{15}|900[0-6][0-9]{12}|9007[0-0][0-9]{11}|90071[0-8][0-9]{10}|900719[0-8][0-9]{9}|9007199[0-1][0-9]{8}|90071992[0-4][0-9]{7}|900719925[0-3][0-9]{6}|9007199254[0-6][0-9]{5}|90071992547[0-3][0-9]{4}|9007199254740[0-8][0-9]{2}|90071992547409[0-8][0-9]{1}|900719925474099[0-0][0-9]{0}|9007199254740991)$"}}];return false;}}else {validateWorkflowOutputHandleSpec.errors = [{instancePath:instancePath+"/id",schemaPath:"#/oneOf/1/properties/id/type",keyword:"type",params:{type: "string"}}];return false;}}var valid4: any = _errs20 === errors;}else {var valid4: any = true;}if(valid4){if(data.label !== undefined){let data7: any = data.label;const _errs22: any = errors;if(errors === _errs22){if(typeof data7 === "string"){if(func1(data7) < 1){validateWorkflowOutputHandleSpec.errors = [{instancePath:instancePath+"/label",schemaPath:"#/oneOf/1/properties/label/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateWorkflowOutputHandleSpec.errors = [{instancePath:instancePath+"/label",schemaPath:"#/oneOf/1/properties/label/type",keyword:"type",params:{type: "string"}}];return false;}}var valid4: any = _errs22 === errors;}else {var valid4: any = true;}if(valid4){if(data.maxConnections !== undefined){let data8: any = data.maxConnections;const _errs24: any = errors;if(!(((typeof data8 == "number") && (!(data8 % 1) && !isNaN(data8))) && (isFinite(data8)))){validateWorkflowOutputHandleSpec.errors = [{instancePath:instancePath+"/maxConnections",schemaPath:"#/oneOf/1/properties/maxConnections/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs24){if((typeof data8 == "number") && (isFinite(data8))){if(data8 > 9007199254740991 || isNaN(data8)){validateWorkflowOutputHandleSpec.errors = [{instancePath:instancePath+"/maxConnections",schemaPath:"#/oneOf/1/properties/maxConnections/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data8 < 1 || isNaN(data8)){validateWorkflowOutputHandleSpec.errors = [{instancePath:instancePath+"/maxConnections",schemaPath:"#/oneOf/1/properties/maxConnections/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid4: any = _errs24 === errors;}else {var valid4: any = true;}if(valid4){if(data.required !== undefined){const _errs26: any = errors;if(typeof data.required !== "boolean"){validateWorkflowOutputHandleSpec.errors = [{instancePath:instancePath+"/required",schemaPath:"#/oneOf/1/properties/required/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid4: any = _errs26 === errors;}else {var valid4: any = true;}}}}}}}}else {validateWorkflowOutputHandleSpec.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid3: any = _errs15 === errors;if(props0 !== true){props0 = true;}valid0 = valid3;}else {validateWorkflowOutputHandleSpec.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "type", tagValue: tag0}}];return false;}}else {validateWorkflowOutputHandleSpec.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "type", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key2 in data){if(!props0 || !props0[key2]){validateWorkflowOutputHandleSpec.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key2}}];return false;break;}}}}}else {validateWorkflowOutputHandleSpec.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowOutputHandleSpec.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowOutputHandleSpec.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1503: any = {"description":"The type of one leaf parameter, which picks the field the inspector draws.","type":"string","enum":["string","text","number","boolean","select","multiselect","json","expression","path","glob","cron","secret","agent","mcpTool","callbackTool","session","project"]};
/** Checks that a value is a {@link WorkflowParamType}. */
// prettier-ignore
export const validateWorkflowParamType: CompiledSchemaCheck<WorkflowParamType> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowParamType {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowParamType.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateWorkflowParamType.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((((((((((((((((data === "string") || (data === "text")) || (data === "number")) || (data === "boolean")) || (data === "select")) || (data === "multiselect")) || (data === "json")) || (data === "expression")) || (data === "path")) || (data === "glob")) || (data === "cron")) || (data === "secret")) || (data === "agent")) || (data === "mcpTool")) || (data === "callbackTool")) || (data === "session")) || (data === "project"))){validateWorkflowParamType.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema1503.enum}}];return false;}validateWorkflowParamType.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowParamType.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowParamId}. */
// prettier-ignore
export const validateWorkflowParamId: CompiledSchemaCheck<WorkflowParamId> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowParamId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowParamId.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(func1(data) < 1){validateWorkflowParamId.errors = [{instancePath,schemaPath:"#/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateWorkflowParamId.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateWorkflowParamId.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowParamId.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowParamOption}. */
// prettier-ignore
export const validateWorkflowParamOption: CompiledSchemaCheck<WorkflowParamOption> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowParamOption {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowParamOption.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.value === undefined) && (missing0 = "value")) || ((data.label === undefined) && (missing0 = "label"))){validateWorkflowParamOption.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "value") || (key0 === "label"))){validateWorkflowParamOption.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.value !== undefined){const _errs2: any = errors;var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.label !== undefined){let data1: any = data.label;const _errs4: any = errors;if(errors === _errs4){if(typeof data1 === "string"){if(func1(data1) < 1){validateWorkflowParamOption.errors = [{instancePath:instancePath+"/label",schemaPath:"#/properties/label/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateWorkflowParamOption.errors = [{instancePath:instancePath+"/label",schemaPath:"#/properties/label/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validateWorkflowParamOption.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowParamOption.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowParamOption.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1501: any = {"type":"object","additionalProperties":false,"properties":{"id":{"$ref":"#/$defs/WorkflowParamId","description":"The parameter's id."},"label":{"type":"string","minLength":1,"description":"The label a person reads."},"type":{"$ref":"#/$defs/WorkflowParamType","description":"The parameter's type."},"required":{"type":"boolean","description":"Whether the parameter must be filled."},"sensitive":{"type":"boolean","description":"Whether a `secret://` reference resolves in the parameter."},"default":{"tsType":"unknown","description":"The value the parameter starts on."},"help":{"type":"string","minLength":1,"description":"The help line."},"options":{"type":"array","items":{"$ref":"#/$defs/WorkflowParamOption"},"description":"The choices."},"showWhen":{"type":"object","propertyNames":{"allOf":[{"type":"string"},{"not":{"const":"__proto__"}}]},"additionalProperties":{"type":"array","items":{"tsType":"unknown"}},"description":"The sibling values the parameter is drawn under, by sibling id."}},"required":["id","label","type"],"description":"A leaf parameter: one declared type. `showWhen` is the whole conditional form: the parameter is\ndrawn when each named sibling holds one of the listed values. `sensitive` marks the only\nparameters a `secret://` reference resolves in."};
// prettier-ignore
const func2 = Object.prototype.hasOwnProperty;
/** Checks that a value is a {@link WorkflowLeafParamSpec}. */
// prettier-ignore
export const validateWorkflowLeafParamSpec: CompiledSchemaCheck<WorkflowLeafParamSpec> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowLeafParamSpec {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowLeafParamSpec.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.id === undefined) && (missing0 = "id")) || ((data.label === undefined) && (missing0 = "label"))) || ((data.type === undefined) && (missing0 = "type"))){validateWorkflowLeafParamSpec.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(func2.call(schema1501.properties, key0))){validateWorkflowLeafParamSpec.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.id !== undefined){const _errs2: any = errors;if(!(validateWorkflowParamId.call(this, data.id, {instancePath:instancePath+"/id",parentData:data,parentDataProperty:"id",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowParamId.errors : vErrors.concat(validateWorkflowParamId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.label !== undefined){let data1: any = data.label;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) < 1){validateWorkflowLeafParamSpec.errors = [{instancePath:instancePath+"/label",schemaPath:"#/properties/label/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateWorkflowLeafParamSpec.errors = [{instancePath:instancePath+"/label",schemaPath:"#/properties/label/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.type !== undefined){const _errs5: any = errors;if(!(validateWorkflowParamType.call(this, data.type, {instancePath:instancePath+"/type",parentData:data,parentDataProperty:"type",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowParamType.errors : vErrors.concat(validateWorkflowParamType.errors);errors = vErrors.length;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.required !== undefined){const _errs6: any = errors;if(typeof data.required !== "boolean"){validateWorkflowLeafParamSpec.errors = [{instancePath:instancePath+"/required",schemaPath:"#/properties/required/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.sensitive !== undefined){const _errs8: any = errors;if(typeof data.sensitive !== "boolean"){validateWorkflowLeafParamSpec.errors = [{instancePath:instancePath+"/sensitive",schemaPath:"#/properties/sensitive/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.default !== undefined){const _errs10: any = errors;var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.help !== undefined){let data6: any = data.help;const _errs12: any = errors;if(errors === _errs12){if(typeof data6 === "string"){if(func1(data6) < 1){validateWorkflowLeafParamSpec.errors = [{instancePath:instancePath+"/help",schemaPath:"#/properties/help/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateWorkflowLeafParamSpec.errors = [{instancePath:instancePath+"/help",schemaPath:"#/properties/help/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}if(valid0){if(data.options !== undefined){let data7: any = data.options;const _errs14: any = errors;if(errors === _errs14){if(Array.isArray(data7)){var valid1: any = true;const len0: any = data7.length;for(let i0=0; i0<len0; i0++){const _errs16: any = errors;if(!(validateWorkflowParamOption.call(this, data7[i0], {instancePath:instancePath+"/options/" + i0,parentData:data7,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowParamOption.errors : vErrors.concat(validateWorkflowParamOption.errors);errors = vErrors.length;}var valid1: any = _errs16 === errors;if(!valid1){break;}}}else {validateWorkflowLeafParamSpec.errors = [{instancePath:instancePath+"/options",schemaPath:"#/properties/options/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs14 === errors;}else {var valid0: any = true;}if(valid0){if(data.showWhen !== undefined){let data9: any = data.showWhen;const _errs17: any = errors;if(errors === _errs17){if(data9 && typeof data9 == "object" && !Array.isArray(data9)){for(const key1 in data9){const _errs19: any = errors;const _errs20: any = errors;if(typeof key1 !== "string"){const err0: any = {instancePath:instancePath+"/showWhen",schemaPath:"#/properties/showWhen/propertyNames/allOf/0/type",keyword:"type",params:{type: "string"},propertyName:key1};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var valid3: any = _errs20 === errors;if(valid3){const _errs22: any = errors;const _errs23: any = errors;const _errs24: any = errors;if("__proto__" !== key1){const err1: any = {};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}var valid4: any = _errs24 === errors;if(valid4){const err2: any = {instancePath:instancePath+"/showWhen",schemaPath:"#/properties/showWhen/propertyNames/allOf/1/not",keyword:"not",params:{},propertyName:key1};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}else {errors = _errs23;if(vErrors !== null){if(_errs23){vErrors.length = _errs23;}else {vErrors = null;}}}var valid3: any = _errs22 === errors;}var valid2: any = _errs19 === errors;if(!valid2){const err3: any = {instancePath:instancePath+"/showWhen",schemaPath:"#/properties/showWhen/propertyNames",keyword:"propertyNames",params:{propertyName: key1}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;validateWorkflowLeafParamSpec.errors = vErrors;return false;break;}}if(valid2){for(const key2 in data9){let data10: any = data9[key2];const _errs26: any = errors;if(errors === _errs26){if(Array.isArray(data10)){var valid6: any = true;const len1: any = data10.length;for(let i1=0; i1<len1; i1++){const _errs28: any = errors;var valid6: any = _errs28 === errors;if(!valid6){break;}}}else {validateWorkflowLeafParamSpec.errors = [{instancePath:instancePath+"/showWhen/" + key2.replace(/~/g, "~0").replace(/\//g, "~1"),schemaPath:"#/properties/showWhen/additionalProperties/type",keyword:"type",params:{type: "array"}}];return false;}}var valid5: any = _errs26 === errors;if(!valid5){break;}}}}else {validateWorkflowLeafParamSpec.errors = [{instancePath:instancePath+"/showWhen",schemaPath:"#/properties/showWhen/type",keyword:"type",params:{type: "object"}}];return false;}}var valid0: any = _errs17 === errors;}else {var valid0: any = true;}}}}}}}}}}}}else {validateWorkflowLeafParamSpec.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowLeafParamSpec.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowLeafParamSpec.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1505: any = {"type":"object","additionalProperties":false,"properties":{"id":{"$ref":"#/$defs/WorkflowParamId","description":"The parameter's id."},"label":{"type":"string","minLength":1,"description":"The label a person reads."},"type":{"description":"Always `collection`.","type":"string","enum":["collection"]},"fields":{"type":"array","items":{"$ref":"#/$defs/WorkflowParamSpec"},"description":"The nested fields."},"multiple":{"type":"boolean","description":"Whether the field list repeats."}},"required":["id","label","type","fields"],"description":"A parameter that nests a field list and may repeat."};
/** Checks that a value is a {@link WorkflowParamSpec}. */
// prettier-ignore
export const validateWorkflowParamSpec: CompiledSchemaCheck<WorkflowParamSpec> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowParamSpec {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowParamSpec.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;const _errs1: any = errors;if(!(validateWorkflowLeafParamSpec.call(this, data, {instancePath,parentData,parentDataProperty,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowLeafParamSpec.errors : vErrors.concat(validateWorkflowLeafParamSpec.errors);errors = vErrors.length;}var _valid0: any = _errs1 === errors;valid0 = valid0 || _valid0;if(_valid0){var props0: any = true;}const _errs2: any = errors;if(!(validateWorkflowCollectionParamSpec.call(this, data, {instancePath,parentData,parentDataProperty,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowCollectionParamSpec.errors : vErrors.concat(validateWorkflowCollectionParamSpec.errors);errors = vErrors.length;}var _valid0: any = _errs2 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}if(!valid0){const err0: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;validateWorkflowParamSpec.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validateWorkflowParamSpec.errors = vErrors;evaluated0.props = props0;return errors === 0;};
// prettier-ignore
validateWorkflowParamSpec.evaluated = {"dynamicProps":true,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowCollectionParamSpec}. */
// prettier-ignore
export const validateWorkflowCollectionParamSpec: CompiledSchemaCheck<WorkflowCollectionParamSpec> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowCollectionParamSpec {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowCollectionParamSpec.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.id === undefined) && (missing0 = "id")) || ((data.label === undefined) && (missing0 = "label"))) || ((data.type === undefined) && (missing0 = "type"))) || ((data.fields === undefined) && (missing0 = "fields"))){validateWorkflowCollectionParamSpec.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((key0 === "id") || (key0 === "label")) || (key0 === "type")) || (key0 === "fields")) || (key0 === "multiple"))){validateWorkflowCollectionParamSpec.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.id !== undefined){const _errs2: any = errors;if(!(validateWorkflowParamId.call(this, data.id, {instancePath:instancePath+"/id",parentData:data,parentDataProperty:"id",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowParamId.errors : vErrors.concat(validateWorkflowParamId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.label !== undefined){let data1: any = data.label;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) < 1){validateWorkflowCollectionParamSpec.errors = [{instancePath:instancePath+"/label",schemaPath:"#/properties/label/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateWorkflowCollectionParamSpec.errors = [{instancePath:instancePath+"/label",schemaPath:"#/properties/label/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.type !== undefined){let data2: any = data.type;const _errs5: any = errors;if(typeof data2 !== "string"){validateWorkflowCollectionParamSpec.errors = [{instancePath:instancePath+"/type",schemaPath:"#/properties/type/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data2 === "collection")){validateWorkflowCollectionParamSpec.errors = [{instancePath:instancePath+"/type",schemaPath:"#/properties/type/enum",keyword:"enum",params:{allowedValues: schema1505.properties.type.enum}}];return false;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.fields !== undefined){let data3: any = data.fields;const _errs7: any = errors;if(errors === _errs7){if(Array.isArray(data3)){var valid1: any = true;const len0: any = data3.length;for(let i0=0; i0<len0; i0++){const _errs9: any = errors;if(!(wrapper0.validate.call(this, data3[i0], {instancePath:instancePath+"/fields/" + i0,parentData:data3,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? wrapper0.validate.errors : vErrors.concat(wrapper0.validate.errors);errors = vErrors.length;}var valid1: any = _errs9 === errors;if(!valid1){break;}}}else {validateWorkflowCollectionParamSpec.errors = [{instancePath:instancePath+"/fields",schemaPath:"#/properties/fields/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}if(valid0){if(data.multiple !== undefined){const _errs10: any = errors;if(typeof data.multiple !== "boolean"){validateWorkflowCollectionParamSpec.errors = [{instancePath:instancePath+"/multiple",schemaPath:"#/properties/multiple/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}}}}}}}}else {validateWorkflowCollectionParamSpec.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowCollectionParamSpec.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowCollectionParamSpec.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1507: any = {"description":"What running a kind can change: nothing, this machine, or something beyond it.","type":"string","enum":["none","local","external"]};
/** Checks that a value is a {@link WorkflowNodeSideEffects}. */
// prettier-ignore
export const validateWorkflowNodeSideEffects: CompiledSchemaCheck<WorkflowNodeSideEffects> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowNodeSideEffects {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowNodeSideEffects.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateWorkflowNodeSideEffects.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data === "none") || (data === "local")) || (data === "external"))){validateWorkflowNodeSideEffects.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema1507.enum}}];return false;}validateWorkflowNodeSideEffects.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowNodeSideEffects.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowNodeCapabilities}. */
// prettier-ignore
export const validateWorkflowNodeCapabilities: CompiledSchemaCheck<WorkflowNodeCapabilities> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowNodeCapabilities {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowNodeCapabilities.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.cancelable === undefined) && (missing0 = "cancelable")) || ((data.resumable === undefined) && (missing0 = "resumable"))) || ((data.sideEffects === undefined) && (missing0 = "sideEffects"))) || ((data.repository === undefined) && (missing0 = "repository"))){validateWorkflowNodeCapabilities.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((key0 === "cancelable") || (key0 === "resumable")) || (key0 === "sideEffects")) || (key0 === "repository")) || (key0 === "sandbox"))){validateWorkflowNodeCapabilities.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.cancelable !== undefined){const _errs2: any = errors;if(typeof data.cancelable !== "boolean"){validateWorkflowNodeCapabilities.errors = [{instancePath:instancePath+"/cancelable",schemaPath:"#/properties/cancelable/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.resumable !== undefined){const _errs4: any = errors;if(typeof data.resumable !== "boolean"){validateWorkflowNodeCapabilities.errors = [{instancePath:instancePath+"/resumable",schemaPath:"#/properties/resumable/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.sideEffects !== undefined){const _errs6: any = errors;if(!(validateWorkflowNodeSideEffects.call(this, data.sideEffects, {instancePath:instancePath+"/sideEffects",parentData:data,parentDataProperty:"sideEffects",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowNodeSideEffects.errors : vErrors.concat(validateWorkflowNodeSideEffects.errors);errors = vErrors.length;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.repository !== undefined){const _errs7: any = errors;if(typeof data.repository !== "boolean"){validateWorkflowNodeCapabilities.errors = [{instancePath:instancePath+"/repository",schemaPath:"#/properties/repository/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}if(valid0){if(data.sandbox !== undefined){let data4: any = data.sandbox;const _errs9: any = errors;if(errors === _errs9){if(data4 && typeof data4 == "object" && !Array.isArray(data4)){for(const key1 in data4){const _errs11: any = errors;const _errs12: any = errors;if(typeof key1 !== "string"){const err0: any = {instancePath:instancePath+"/sandbox",schemaPath:"#/properties/sandbox/propertyNames/allOf/0/type",keyword:"type",params:{type: "string"},propertyName:key1};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var valid2: any = _errs12 === errors;if(valid2){const _errs14: any = errors;const _errs15: any = errors;const _errs16: any = errors;if("__proto__" !== key1){const err1: any = {};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}var valid3: any = _errs16 === errors;if(valid3){const err2: any = {instancePath:instancePath+"/sandbox",schemaPath:"#/properties/sandbox/propertyNames/allOf/1/not",keyword:"not",params:{},propertyName:key1};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}else {errors = _errs15;if(vErrors !== null){if(_errs15){vErrors.length = _errs15;}else {vErrors = null;}}}var valid2: any = _errs14 === errors;}var valid1: any = _errs11 === errors;if(!valid1){const err3: any = {instancePath:instancePath+"/sandbox",schemaPath:"#/properties/sandbox/propertyNames",keyword:"propertyNames",params:{propertyName: key1}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;validateWorkflowNodeCapabilities.errors = vErrors;return false;break;}}if(valid1){for(const key2 in data4){let data5: any = data4[key2];const _errs18: any = errors;if(errors === _errs18){if(Array.isArray(data5)){var valid5: any = true;const len0: any = data5.length;for(let i0=0; i0<len0; i0++){const _errs20: any = errors;var valid5: any = _errs20 === errors;if(!valid5){break;}}}else {validateWorkflowNodeCapabilities.errors = [{instancePath:instancePath+"/sandbox/" + key2.replace(/~/g, "~0").replace(/\//g, "~1"),schemaPath:"#/properties/sandbox/additionalProperties/type",keyword:"type",params:{type: "array"}}];return false;}}var valid4: any = _errs18 === errors;if(!valid4){break;}}}}else {validateWorkflowNodeCapabilities.errors = [{instancePath:instancePath+"/sandbox",schemaPath:"#/properties/sandbox/type",keyword:"type",params:{type: "object"}}];return false;}}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}}}}}}}}else {validateWorkflowNodeCapabilities.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowNodeCapabilities.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowNodeCapabilities.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1496: any = {"type":"object","additionalProperties":false,"properties":{"kind":{"$ref":"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowNodeKindId","description":"The kind's key."},"version":{"type":"integer","minimum":1,"maximum":9007199254740991,"description":"The implementation a newly placed node records."},"category":{"$ref":"#/$defs/WorkflowNodeKindCategory","description":"The palette's group."},"displayName":{"type":"string","minLength":1,"description":"The name a person reads."},"description":{"type":"string","minLength":1,"description":"What the kind does."},"icon":{"type":"string","minLength":1,"description":"The kind's icon."},"aliases":{"type":"array","items":{"type":"string","minLength":1},"description":"Other words the palette's search finds the kind by."},"inputs":{"type":"array","items":{"$ref":"#/$defs/WorkflowInputHandleSpec"},"uniqueItems":true,"description":"The input handles, each id once."},"outputs":{"type":"array","items":{"$ref":"#/$defs/WorkflowOutputHandleSpec"},"uniqueItems":true,"description":"The output handles, each id once."},"outputsDeriveFromParams":{"type":"boolean","description":"Whether the listed outputs are the base case of a set the node's params derive."},"params":{"type":"array","items":{"$ref":"#/$defs/WorkflowParamSpec"},"description":"The parameters."},"perItem":{"type":"boolean","description":"Whether the kind runs once per item rather than once over all of them."},"capabilities":{"$ref":"#/$defs/WorkflowNodeCapabilities","description":"What a run of the kind can do."}},"required":["kind","version","category","displayName","description","icon","inputs","outputs","outputsDeriveFromParams","params"],"description":"One kind as the catalog serializes it. `version` is the implementation a newly placed node\nrecords; a placed node keeps the version it recorded. Each handle id appears once on its side,\nsince an edge names a handle by id alone."};
// prettier-ignore
const func0 = deepEqual;
/** Checks that a value is a {@link WorkflowNodeKindSpec}. */
// prettier-ignore
export const validateWorkflowNodeKindSpec: CompiledSchemaCheck<WorkflowNodeKindSpec> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowNodeKindSpec {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowNodeKindSpec.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((((((((data.kind === undefined) && (missing0 = "kind")) || ((data.version === undefined) && (missing0 = "version"))) || ((data.category === undefined) && (missing0 = "category"))) || ((data.displayName === undefined) && (missing0 = "displayName"))) || ((data.description === undefined) && (missing0 = "description"))) || ((data.icon === undefined) && (missing0 = "icon"))) || ((data.inputs === undefined) && (missing0 = "inputs"))) || ((data.outputs === undefined) && (missing0 = "outputs"))) || ((data.outputsDeriveFromParams === undefined) && (missing0 = "outputsDeriveFromParams"))) || ((data.params === undefined) && (missing0 = "params"))){validateWorkflowNodeKindSpec.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(func2.call(schema1496.properties, key0))){validateWorkflowNodeKindSpec.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.kind !== undefined){const _errs2: any = errors;if(!(validateWorkflowNodeKindId.call(this, data.kind, {instancePath:instancePath+"/kind",parentData:data,parentDataProperty:"kind",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowNodeKindId.errors : vErrors.concat(validateWorkflowNodeKindId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.version !== undefined){let data1: any = data.version;const _errs3: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validateWorkflowNodeKindSpec.errors = [{instancePath:instancePath+"/version",schemaPath:"#/properties/version/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs3){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validateWorkflowNodeKindSpec.errors = [{instancePath:instancePath+"/version",schemaPath:"#/properties/version/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 1 || isNaN(data1)){validateWorkflowNodeKindSpec.errors = [{instancePath:instancePath+"/version",schemaPath:"#/properties/version/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.category !== undefined){const _errs5: any = errors;if(!(validateWorkflowNodeKindCategory.call(this, data.category, {instancePath:instancePath+"/category",parentData:data,parentDataProperty:"category",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowNodeKindCategory.errors : vErrors.concat(validateWorkflowNodeKindCategory.errors);errors = vErrors.length;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.displayName !== undefined){let data3: any = data.displayName;const _errs6: any = errors;if(errors === _errs6){if(typeof data3 === "string"){if(func1(data3) < 1){validateWorkflowNodeKindSpec.errors = [{instancePath:instancePath+"/displayName",schemaPath:"#/properties/displayName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateWorkflowNodeKindSpec.errors = [{instancePath:instancePath+"/displayName",schemaPath:"#/properties/displayName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.description !== undefined){let data4: any = data.description;const _errs8: any = errors;if(errors === _errs8){if(typeof data4 === "string"){if(func1(data4) < 1){validateWorkflowNodeKindSpec.errors = [{instancePath:instancePath+"/description",schemaPath:"#/properties/description/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateWorkflowNodeKindSpec.errors = [{instancePath:instancePath+"/description",schemaPath:"#/properties/description/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.icon !== undefined){let data5: any = data.icon;const _errs10: any = errors;if(errors === _errs10){if(typeof data5 === "string"){if(func1(data5) < 1){validateWorkflowNodeKindSpec.errors = [{instancePath:instancePath+"/icon",schemaPath:"#/properties/icon/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateWorkflowNodeKindSpec.errors = [{instancePath:instancePath+"/icon",schemaPath:"#/properties/icon/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.aliases !== undefined){let data6: any = data.aliases;const _errs12: any = errors;if(errors === _errs12){if(Array.isArray(data6)){var valid1: any = true;const len0: any = data6.length;for(let i0=0; i0<len0; i0++){let data7: any = data6[i0];const _errs14: any = errors;if(errors === _errs14){if(typeof data7 === "string"){if(func1(data7) < 1){validateWorkflowNodeKindSpec.errors = [{instancePath:instancePath+"/aliases/" + i0,schemaPath:"#/properties/aliases/items/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateWorkflowNodeKindSpec.errors = [{instancePath:instancePath+"/aliases/" + i0,schemaPath:"#/properties/aliases/items/type",keyword:"type",params:{type: "string"}}];return false;}}var valid1: any = _errs14 === errors;if(!valid1){break;}}}else {validateWorkflowNodeKindSpec.errors = [{instancePath:instancePath+"/aliases",schemaPath:"#/properties/aliases/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}if(valid0){if(data.inputs !== undefined){let data8: any = data.inputs;const _errs16: any = errors;if(errors === _errs16){if(Array.isArray(data8)){var valid2: any = true;const len1: any = data8.length;for(let i1=0; i1<len1; i1++){const _errs18: any = errors;if(!(validateWorkflowInputHandleSpec.call(this, data8[i1], {instancePath:instancePath+"/inputs/" + i1,parentData:data8,parentDataProperty:i1,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowInputHandleSpec.errors : vErrors.concat(validateWorkflowInputHandleSpec.errors);errors = vErrors.length;}var valid2: any = _errs18 === errors;if(!valid2){break;}}if(valid2){let i2: any = data8.length;let j0: any;if(i2 > 1){outer0:for(;i2--;){for(j0 = i2; j0--;){if(func0(data8[i2], data8[j0])){validateWorkflowNodeKindSpec.errors = [{instancePath:instancePath+"/inputs",schemaPath:"#/properties/inputs/uniqueItems",keyword:"uniqueItems",params:{i: i2, j: j0}}];return false;break outer0;}}}}}}else {validateWorkflowNodeKindSpec.errors = [{instancePath:instancePath+"/inputs",schemaPath:"#/properties/inputs/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs16 === errors;}else {var valid0: any = true;}if(valid0){if(data.outputs !== undefined){let data10: any = data.outputs;const _errs19: any = errors;if(errors === _errs19){if(Array.isArray(data10)){var valid4: any = true;const len2: any = data10.length;for(let i3=0; i3<len2; i3++){const _errs21: any = errors;if(!(validateWorkflowOutputHandleSpec.call(this, data10[i3], {instancePath:instancePath+"/outputs/" + i3,parentData:data10,parentDataProperty:i3,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowOutputHandleSpec.errors : vErrors.concat(validateWorkflowOutputHandleSpec.errors);errors = vErrors.length;}var valid4: any = _errs21 === errors;if(!valid4){break;}}if(valid4){let i4: any = data10.length;let j1: any;if(i4 > 1){outer1:for(;i4--;){for(j1 = i4; j1--;){if(func0(data10[i4], data10[j1])){validateWorkflowNodeKindSpec.errors = [{instancePath:instancePath+"/outputs",schemaPath:"#/properties/outputs/uniqueItems",keyword:"uniqueItems",params:{i: i4, j: j1}}];return false;break outer1;}}}}}}else {validateWorkflowNodeKindSpec.errors = [{instancePath:instancePath+"/outputs",schemaPath:"#/properties/outputs/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs19 === errors;}else {var valid0: any = true;}if(valid0){if(data.outputsDeriveFromParams !== undefined){const _errs22: any = errors;if(typeof data.outputsDeriveFromParams !== "boolean"){validateWorkflowNodeKindSpec.errors = [{instancePath:instancePath+"/outputsDeriveFromParams",schemaPath:"#/properties/outputsDeriveFromParams/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs22 === errors;}else {var valid0: any = true;}if(valid0){if(data.params !== undefined){let data13: any = data.params;const _errs24: any = errors;if(errors === _errs24){if(Array.isArray(data13)){var valid6: any = true;const len3: any = data13.length;for(let i5=0; i5<len3; i5++){const _errs26: any = errors;if(!(validateWorkflowParamSpec.call(this, data13[i5], {instancePath:instancePath+"/params/" + i5,parentData:data13,parentDataProperty:i5,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowParamSpec.errors : vErrors.concat(validateWorkflowParamSpec.errors);errors = vErrors.length;}var valid6: any = _errs26 === errors;if(!valid6){break;}}}else {validateWorkflowNodeKindSpec.errors = [{instancePath:instancePath+"/params",schemaPath:"#/properties/params/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs24 === errors;}else {var valid0: any = true;}if(valid0){if(data.perItem !== undefined){const _errs27: any = errors;if(typeof data.perItem !== "boolean"){validateWorkflowNodeKindSpec.errors = [{instancePath:instancePath+"/perItem",schemaPath:"#/properties/perItem/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs27 === errors;}else {var valid0: any = true;}if(valid0){if(data.capabilities !== undefined){const _errs29: any = errors;if(!(validateWorkflowNodeCapabilities.call(this, data.capabilities, {instancePath:instancePath+"/capabilities",parentData:data,parentDataProperty:"capabilities",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowNodeCapabilities.errors : vErrors.concat(validateWorkflowNodeCapabilities.errors);errors = vErrors.length;}var valid0: any = _errs29 === errors;}else {var valid0: any = true;}}}}}}}}}}}}}}}}else {validateWorkflowNodeKindSpec.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowNodeKindSpec.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowNodeKindSpec.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowKindListResponse}. */
// prettier-ignore
export const validateWorkflowKindListResponse: CompiledSchemaCheck<WorkflowKindListResponse> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowKindListResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowKindListResponse.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.kinds === undefined) && (missing0 = "kinds")){validateWorkflowKindListResponse.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "kinds")){validateWorkflowKindListResponse.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.kinds !== undefined){let data0: any = data.kinds;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validateWorkflowNodeKindSpec.call(this, data0[i0], {instancePath:instancePath+"/kinds/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowNodeKindSpec.errors : vErrors.concat(validateWorkflowNodeKindSpec.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validateWorkflowKindListResponse.errors = [{instancePath:instancePath+"/kinds",schemaPath:"#/properties/kinds/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validateWorkflowKindListResponse.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowKindListResponse.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowKindListResponse.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const wrapper0 = {validate: validateWorkflowParamSpec};

/** The methods of {@link WORKFLOW_KIND_METHOD_DESCRIPTORS}, each with its checks. */
export interface WorkflowKindMethodDescriptors {
  readonly "workflow.kind.list": {
    readonly method: "workflow.kind.list";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<EmptyPayload>;
    readonly responseCheck: SchemaCheck<WorkflowKindListResponse>;
  };
}
/** The node catalog's method table. */
export const WORKFLOW_KIND_METHOD_DESCRIPTORS: WorkflowKindMethodDescriptors = Object.freeze({
  "workflow.kind.list": Object.freeze({
    method: "workflow.kind.list",
    procedureType: "query",
    mutating: false,
    requestCheck: validateEmptyPayload,
    responseCheck: validateWorkflowKindListResponse,
  }),
});
