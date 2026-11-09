// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The node catalog: every node kind the daemon runs, as `workflow.kind.list` serializes it.

import { type SchemaCheck, deepEqual, ucs2length } from "../../schema-check.js";
import { type EmptyPayload, validateEmptyPayload } from "../method-descriptor.js";
import type { WorkflowNodeKindId } from "./definition/document.js";

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
const schema4773: any = {"type":"object","additionalProperties":false,"properties":{"kind":{"$ref":"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowNodeKindId","description":"The kind's key."},"version":{"type":"integer","minimum":1,"maximum":9007199254740991,"description":"The implementation a newly placed node records."},"category":{"$ref":"#/$defs/WorkflowNodeKindCategory","description":"The palette's group."},"displayName":{"type":"string","minLength":1,"description":"The name a person reads."},"description":{"type":"string","minLength":1,"description":"What the kind does."},"icon":{"type":"string","minLength":1,"description":"The kind's icon."},"aliases":{"type":"array","items":{"type":"string","minLength":1},"description":"Other words the palette's search finds the kind by."},"inputs":{"type":"array","items":{"$ref":"#/$defs/WorkflowInputHandleSpec"},"uniqueItems":true,"description":"The input handles, each id once."},"outputs":{"type":"array","items":{"$ref":"#/$defs/WorkflowOutputHandleSpec"},"uniqueItems":true,"description":"The output handles, each id once."},"outputsDeriveFromParams":{"type":"boolean","description":"Whether the listed outputs are the base case of a set the node's params derive."},"params":{"type":"array","items":{"$ref":"#/$defs/WorkflowParamSpec"},"description":"The parameters."},"perItem":{"type":"boolean","description":"Whether the kind runs once per item rather than once over all of them."},"capabilities":{"$ref":"#/$defs/WorkflowNodeCapabilities","description":"What a run of the kind can do."}},"required":["kind","version","category","displayName","description","icon","inputs","outputs","outputsDeriveFromParams","params"],"description":"One kind as the catalog serializes it. `version` is the implementation a newly placed node\nrecords; a placed node keeps the version it recorded. Each handle id appears once on its side,\nsince an edge names a handle by id alone."};
// prettier-ignore
const schema4775: any = {"description":"The categories the palette groups kinds under.","type":"string","enum":["trigger","agent","human","files","browser","developer","flow","output"]};
// prettier-ignore
const func2 = Object.prototype.hasOwnProperty;
// prettier-ignore
const func1 = ucs2length;
// prettier-ignore
const func0 = deepEqual;
// prettier-ignore
const pattern3230 = new RegExp("^inputs/main/(?:0|[1-9][0-9]{0,14}|[1-8][0-9]{15}|900[0-6][0-9]{12}|9007[0-0][0-9]{11}|90071[0-8][0-9]{10}|900719[0-8][0-9]{9}|9007199[0-1][0-9]{8}|90071992[0-4][0-9]{7}|900719925[0-3][0-9]{6}|9007199254[0-6][0-9]{5}|90071992547[0-3][0-9]{4}|9007199254740[0-8][0-9]{2}|90071992547409[0-8][0-9]{1}|900719925474099[0-0][0-9]{0}|9007199254740991)$", "u");
// prettier-ignore
const pattern3231 = new RegExp("^inputs/tool/(?:0|[1-9][0-9]{0,14}|[1-8][0-9]{15}|900[0-6][0-9]{12}|9007[0-0][0-9]{11}|90071[0-8][0-9]{10}|900719[0-8][0-9]{9}|9007199[0-1][0-9]{8}|90071992[0-4][0-9]{7}|900719925[0-3][0-9]{6}|9007199254[0-6][0-9]{5}|90071992547[0-3][0-9]{4}|9007199254740[0-8][0-9]{2}|90071992547409[0-8][0-9]{1}|900719925474099[0-0][0-9]{0}|9007199254740991)$", "u");
// prettier-ignore
const pattern3232 = new RegExp("^outputs/main/(?:0|[1-9][0-9]{0,14}|[1-8][0-9]{15}|900[0-6][0-9]{12}|9007[0-0][0-9]{11}|90071[0-8][0-9]{10}|900719[0-8][0-9]{9}|9007199[0-1][0-9]{8}|90071992[0-4][0-9]{7}|900719925[0-3][0-9]{6}|9007199254[0-6][0-9]{5}|90071992547[0-3][0-9]{4}|9007199254740[0-8][0-9]{2}|90071992547409[0-8][0-9]{1}|900719925474099[0-0][0-9]{0}|9007199254740991)$", "u");
// prettier-ignore
const pattern3233 = new RegExp("^outputs/tool/(?:0|[1-9][0-9]{0,14}|[1-8][0-9]{15}|900[0-6][0-9]{12}|9007[0-0][0-9]{11}|90071[0-8][0-9]{10}|900719[0-8][0-9]{9}|9007199[0-1][0-9]{8}|90071992[0-4][0-9]{7}|900719925[0-3][0-9]{6}|9007199254[0-6][0-9]{5}|90071992547[0-3][0-9]{4}|9007199254740[0-8][0-9]{2}|90071992547409[0-8][0-9]{1}|900719925474099[0-0][0-9]{0}|9007199254740991)$", "u");
// prettier-ignore
const schema4779: any = {"type":"object","additionalProperties":false,"properties":{"id":{"$ref":"#/$defs/WorkflowParamId","description":"The parameter's id."},"label":{"type":"string","minLength":1,"description":"The label a person reads."},"type":{"$ref":"#/$defs/WorkflowParamType","description":"The parameter's type."},"required":{"type":"boolean","description":"Whether the parameter must be filled."},"sensitive":{"type":"boolean","description":"Whether a `secret://` reference resolves in the parameter."},"default":{"tsType":"unknown","description":"The value the parameter starts on."},"help":{"type":"string","minLength":1,"description":"The help line."},"options":{"type":"array","items":{"$ref":"#/$defs/WorkflowParamOption"},"description":"The choices."},"showWhen":{"type":"object","propertyNames":{"allOf":[{"type":"string"},{"not":{"const":"__proto__"}}]},"additionalProperties":{"type":"array","items":{"tsType":"unknown"}},"description":"The sibling values the parameter is drawn under, by sibling id."}},"required":["id","label","type"],"description":"A leaf parameter: one declared type. `showWhen` is the whole conditional form: the parameter is\ndrawn when each named sibling holds one of the listed values. `sensitive` marks the only\nparameters a `secret://` reference resolves in."};
// prettier-ignore
const schema4781: any = {"description":"The type of one leaf parameter, which picks the field the inspector draws.","type":"string","enum":["string","text","number","boolean","select","multiselect","json","expression","path","glob","cron","secret","agent","mcpTool","callbackTool","session","project"]};
// prettier-ignore
function validate2452(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2452.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.id === undefined) && (missing0 = "id")) || ((data.label === undefined) && (missing0 = "label"))) || ((data.type === undefined) && (missing0 = "type"))){validate2452.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(func2.call(schema4779.properties, key0))){validate2452.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.id !== undefined){let data0: any = data.id;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(func1(data0) < 1){validate2452.errors = [{instancePath:instancePath+"/id",schemaPath:"#/$defs/WorkflowParamId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate2452.errors = [{instancePath:instancePath+"/id",schemaPath:"#/$defs/WorkflowParamId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.label !== undefined){let data1: any = data.label;const _errs5: any = errors;if(errors === _errs5){if(typeof data1 === "string"){if(func1(data1) < 1){validate2452.errors = [{instancePath:instancePath+"/label",schemaPath:"#/properties/label/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate2452.errors = [{instancePath:instancePath+"/label",schemaPath:"#/properties/label/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.type !== undefined){let data2: any = data.type;const _errs7: any = errors;if(typeof data2 !== "string"){validate2452.errors = [{instancePath:instancePath+"/type",schemaPath:"#/$defs/WorkflowParamType/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((((((((((((((((data2 === "string") || (data2 === "text")) || (data2 === "number")) || (data2 === "boolean")) || (data2 === "select")) || (data2 === "multiselect")) || (data2 === "json")) || (data2 === "expression")) || (data2 === "path")) || (data2 === "glob")) || (data2 === "cron")) || (data2 === "secret")) || (data2 === "agent")) || (data2 === "mcpTool")) || (data2 === "callbackTool")) || (data2 === "session")) || (data2 === "project"))){validate2452.errors = [{instancePath:instancePath+"/type",schemaPath:"#/$defs/WorkflowParamType/enum",keyword:"enum",params:{allowedValues: schema4781.enum}}];return false;}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}if(valid0){if(data.required !== undefined){const _errs10: any = errors;if(typeof data.required !== "boolean"){validate2452.errors = [{instancePath:instancePath+"/required",schemaPath:"#/properties/required/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.sensitive !== undefined){const _errs12: any = errors;if(typeof data.sensitive !== "boolean"){validate2452.errors = [{instancePath:instancePath+"/sensitive",schemaPath:"#/properties/sensitive/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}if(valid0){if(data.default !== undefined){const _errs14: any = errors;var valid0: any = _errs14 === errors;}else {var valid0: any = true;}if(valid0){if(data.help !== undefined){let data6: any = data.help;const _errs16: any = errors;if(errors === _errs16){if(typeof data6 === "string"){if(func1(data6) < 1){validate2452.errors = [{instancePath:instancePath+"/help",schemaPath:"#/properties/help/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate2452.errors = [{instancePath:instancePath+"/help",schemaPath:"#/properties/help/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs16 === errors;}else {var valid0: any = true;}if(valid0){if(data.options !== undefined){let data7: any = data.options;const _errs18: any = errors;if(errors === _errs18){if(Array.isArray(data7)){var valid3: any = true;const len0: any = data7.length;for(let i0=0; i0<len0; i0++){let data8: any = data7[i0];const _errs20: any = errors;const _errs21: any = errors;if(errors === _errs21){if(data8 && typeof data8 == "object" && !Array.isArray(data8)){let missing1: any;if(((data8.value === undefined) && (missing1 = "value")) || ((data8.label === undefined) && (missing1 = "label"))){validate2452.errors = [{instancePath:instancePath+"/options/" + i0,schemaPath:"#/$defs/WorkflowParamOption/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs23: any = errors;for(const key1 in data8){if(!((key1 === "value") || (key1 === "label"))){validate2452.errors = [{instancePath:instancePath+"/options/" + i0,schemaPath:"#/$defs/WorkflowParamOption/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs23 === errors){if(data8.value !== undefined){const _errs24: any = errors;var valid5: any = _errs24 === errors;}else {var valid5: any = true;}if(valid5){if(data8.label !== undefined){let data10: any = data8.label;const _errs26: any = errors;if(errors === _errs26){if(typeof data10 === "string"){if(func1(data10) < 1){validate2452.errors = [{instancePath:instancePath+"/options/" + i0+"/label",schemaPath:"#/$defs/WorkflowParamOption/properties/label/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate2452.errors = [{instancePath:instancePath+"/options/" + i0+"/label",schemaPath:"#/$defs/WorkflowParamOption/properties/label/type",keyword:"type",params:{type: "string"}}];return false;}}var valid5: any = _errs26 === errors;}else {var valid5: any = true;}}}}}else {validate2452.errors = [{instancePath:instancePath+"/options/" + i0,schemaPath:"#/$defs/WorkflowParamOption/type",keyword:"type",params:{type: "object"}}];return false;}}var valid3: any = _errs20 === errors;if(!valid3){break;}}}else {validate2452.errors = [{instancePath:instancePath+"/options",schemaPath:"#/properties/options/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs18 === errors;}else {var valid0: any = true;}if(valid0){if(data.showWhen !== undefined){let data11: any = data.showWhen;const _errs28: any = errors;if(errors === _errs28){if(data11 && typeof data11 == "object" && !Array.isArray(data11)){for(const key2 in data11){const _errs30: any = errors;const _errs31: any = errors;if(typeof key2 !== "string"){const err0: any = {instancePath:instancePath+"/showWhen",schemaPath:"#/properties/showWhen/propertyNames/allOf/0/type",keyword:"type",params:{type: "string"},propertyName:key2};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var valid7: any = _errs31 === errors;if(valid7){const _errs33: any = errors;const _errs34: any = errors;const _errs35: any = errors;if("__proto__" !== key2){const err1: any = {};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}var valid8: any = _errs35 === errors;if(valid8){const err2: any = {instancePath:instancePath+"/showWhen",schemaPath:"#/properties/showWhen/propertyNames/allOf/1/not",keyword:"not",params:{},propertyName:key2};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}else {errors = _errs34;if(vErrors !== null){if(_errs34){vErrors.length = _errs34;}else {vErrors = null;}}}var valid7: any = _errs33 === errors;}var valid6: any = _errs30 === errors;if(!valid6){const err3: any = {instancePath:instancePath+"/showWhen",schemaPath:"#/properties/showWhen/propertyNames",keyword:"propertyNames",params:{propertyName: key2}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;validate2452.errors = vErrors;return false;break;}}if(valid6){for(const key3 in data11){let data12: any = data11[key3];const _errs37: any = errors;if(errors === _errs37){if(Array.isArray(data12)){var valid10: any = true;const len1: any = data12.length;for(let i1=0; i1<len1; i1++){const _errs39: any = errors;var valid10: any = _errs39 === errors;if(!valid10){break;}}}else {validate2452.errors = [{instancePath:instancePath+"/showWhen/" + key3.replace(/~/g, "~0").replace(/\//g, "~1"),schemaPath:"#/properties/showWhen/additionalProperties/type",keyword:"type",params:{type: "array"}}];return false;}}var valid9: any = _errs37 === errors;if(!valid9){break;}}}}else {validate2452.errors = [{instancePath:instancePath+"/showWhen",schemaPath:"#/properties/showWhen/type",keyword:"type",params:{type: "object"}}];return false;}}var valid0: any = _errs28 === errors;}else {var valid0: any = true;}}}}}}}}}}}}else {validate2452.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2452.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2452.errors = null as any[] | null;
// prettier-ignore
validate2452.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema4783: any = {"type":"object","additionalProperties":false,"properties":{"id":{"$ref":"#/$defs/WorkflowParamId","description":"The parameter's id."},"label":{"type":"string","minLength":1,"description":"The label a person reads."},"type":{"description":"Always `collection`.","type":"string","enum":["collection"]},"fields":{"type":"array","items":{"$ref":"#/$defs/WorkflowParamSpec"},"description":"The nested fields."},"multiple":{"type":"boolean","description":"Whether the field list repeats."}},"required":["id","label","type","fields"],"description":"A parameter that nests a field list and may repeat."};
// prettier-ignore
const wrapper0 = {validate: validate2451};
// prettier-ignore
function validate2454(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2454.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.id === undefined) && (missing0 = "id")) || ((data.label === undefined) && (missing0 = "label"))) || ((data.type === undefined) && (missing0 = "type"))) || ((data.fields === undefined) && (missing0 = "fields"))){validate2454.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((key0 === "id") || (key0 === "label")) || (key0 === "type")) || (key0 === "fields")) || (key0 === "multiple"))){validate2454.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.id !== undefined){let data0: any = data.id;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(func1(data0) < 1){validate2454.errors = [{instancePath:instancePath+"/id",schemaPath:"#/$defs/WorkflowParamId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate2454.errors = [{instancePath:instancePath+"/id",schemaPath:"#/$defs/WorkflowParamId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.label !== undefined){let data1: any = data.label;const _errs5: any = errors;if(errors === _errs5){if(typeof data1 === "string"){if(func1(data1) < 1){validate2454.errors = [{instancePath:instancePath+"/label",schemaPath:"#/properties/label/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate2454.errors = [{instancePath:instancePath+"/label",schemaPath:"#/properties/label/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.type !== undefined){let data2: any = data.type;const _errs7: any = errors;if(typeof data2 !== "string"){validate2454.errors = [{instancePath:instancePath+"/type",schemaPath:"#/properties/type/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data2 === "collection")){validate2454.errors = [{instancePath:instancePath+"/type",schemaPath:"#/properties/type/enum",keyword:"enum",params:{allowedValues: schema4783.properties.type.enum}}];return false;}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}if(valid0){if(data.fields !== undefined){let data3: any = data.fields;const _errs9: any = errors;if(errors === _errs9){if(Array.isArray(data3)){var valid2: any = true;const len0: any = data3.length;for(let i0=0; i0<len0; i0++){const _errs11: any = errors;if(!(wrapper0.validate.call(this, data3[i0], {instancePath:instancePath+"/fields/" + i0,parentData:data3,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? wrapper0.validate.errors : vErrors.concat(wrapper0.validate.errors);errors = vErrors.length;}var valid2: any = _errs11 === errors;if(!valid2){break;}}}else {validate2454.errors = [{instancePath:instancePath+"/fields",schemaPath:"#/properties/fields/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}if(valid0){if(data.multiple !== undefined){const _errs12: any = errors;if(typeof data.multiple !== "boolean"){validate2454.errors = [{instancePath:instancePath+"/multiple",schemaPath:"#/properties/multiple/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}}}}}}}}else {validate2454.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2454.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2454.errors = null as any[] | null;
// prettier-ignore
validate2454.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2451(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2451.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;const _errs1: any = errors;if(!(validate2452.call(this, data, {instancePath,parentData,parentDataProperty,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate2452.errors : vErrors.concat(validate2452.errors);errors = vErrors.length;}var _valid0: any = _errs1 === errors;valid0 = valid0 || _valid0;if(_valid0){var props0: any = true;}const _errs2: any = errors;if(!(validate2454.call(this, data, {instancePath,parentData,parentDataProperty,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate2454.errors : vErrors.concat(validate2454.errors);errors = vErrors.length;}var _valid0: any = _errs2 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}if(!valid0){const err0: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;validate2451.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validate2451.errors = vErrors;evaluated0.props = props0;return errors === 0;}
// prettier-ignore
validate2451.errors = null as any[] | null;
// prettier-ignore
validate2451.evaluated = {"dynamicProps":true,"dynamicItems":false} as any;
// prettier-ignore
const schema4786: any = {"description":"What running a kind can change: nothing, this machine, or something beyond it.","type":"string","enum":["none","local","external"]};
// prettier-ignore
function validate2457(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2457.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.cancelable === undefined) && (missing0 = "cancelable")) || ((data.resumable === undefined) && (missing0 = "resumable"))) || ((data.sideEffects === undefined) && (missing0 = "sideEffects"))) || ((data.repository === undefined) && (missing0 = "repository"))){validate2457.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((key0 === "cancelable") || (key0 === "resumable")) || (key0 === "sideEffects")) || (key0 === "repository")) || (key0 === "sandbox"))){validate2457.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.cancelable !== undefined){const _errs2: any = errors;if(typeof data.cancelable !== "boolean"){validate2457.errors = [{instancePath:instancePath+"/cancelable",schemaPath:"#/properties/cancelable/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.resumable !== undefined){const _errs4: any = errors;if(typeof data.resumable !== "boolean"){validate2457.errors = [{instancePath:instancePath+"/resumable",schemaPath:"#/properties/resumable/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.sideEffects !== undefined){let data2: any = data.sideEffects;const _errs6: any = errors;if(typeof data2 !== "string"){validate2457.errors = [{instancePath:instancePath+"/sideEffects",schemaPath:"#/$defs/WorkflowNodeSideEffects/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data2 === "none") || (data2 === "local")) || (data2 === "external"))){validate2457.errors = [{instancePath:instancePath+"/sideEffects",schemaPath:"#/$defs/WorkflowNodeSideEffects/enum",keyword:"enum",params:{allowedValues: schema4786.enum}}];return false;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.repository !== undefined){const _errs9: any = errors;if(typeof data.repository !== "boolean"){validate2457.errors = [{instancePath:instancePath+"/repository",schemaPath:"#/properties/repository/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}if(valid0){if(data.sandbox !== undefined){let data4: any = data.sandbox;const _errs11: any = errors;if(errors === _errs11){if(data4 && typeof data4 == "object" && !Array.isArray(data4)){for(const key1 in data4){const _errs13: any = errors;const _errs14: any = errors;if(typeof key1 !== "string"){const err0: any = {instancePath:instancePath+"/sandbox",schemaPath:"#/properties/sandbox/propertyNames/allOf/0/type",keyword:"type",params:{type: "string"},propertyName:key1};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var valid3: any = _errs14 === errors;if(valid3){const _errs16: any = errors;const _errs17: any = errors;const _errs18: any = errors;if("__proto__" !== key1){const err1: any = {};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}var valid4: any = _errs18 === errors;if(valid4){const err2: any = {instancePath:instancePath+"/sandbox",schemaPath:"#/properties/sandbox/propertyNames/allOf/1/not",keyword:"not",params:{},propertyName:key1};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}else {errors = _errs17;if(vErrors !== null){if(_errs17){vErrors.length = _errs17;}else {vErrors = null;}}}var valid3: any = _errs16 === errors;}var valid2: any = _errs13 === errors;if(!valid2){const err3: any = {instancePath:instancePath+"/sandbox",schemaPath:"#/properties/sandbox/propertyNames",keyword:"propertyNames",params:{propertyName: key1}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;validate2457.errors = vErrors;return false;break;}}if(valid2){for(const key2 in data4){let data5: any = data4[key2];const _errs20: any = errors;if(errors === _errs20){if(Array.isArray(data5)){var valid6: any = true;const len0: any = data5.length;for(let i0=0; i0<len0; i0++){const _errs22: any = errors;var valid6: any = _errs22 === errors;if(!valid6){break;}}}else {validate2457.errors = [{instancePath:instancePath+"/sandbox/" + key2.replace(/~/g, "~0").replace(/\//g, "~1"),schemaPath:"#/properties/sandbox/additionalProperties/type",keyword:"type",params:{type: "array"}}];return false;}}var valid5: any = _errs20 === errors;if(!valid5){break;}}}}else {validate2457.errors = [{instancePath:instancePath+"/sandbox",schemaPath:"#/properties/sandbox/type",keyword:"type",params:{type: "object"}}];return false;}}var valid0: any = _errs11 === errors;}else {var valid0: any = true;}}}}}}}}else {validate2457.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2457.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2457.errors = null as any[] | null;
// prettier-ignore
validate2457.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2450(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): boolean {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2450.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((((((((data.kind === undefined) && (missing0 = "kind")) || ((data.version === undefined) && (missing0 = "version"))) || ((data.category === undefined) && (missing0 = "category"))) || ((data.displayName === undefined) && (missing0 = "displayName"))) || ((data.description === undefined) && (missing0 = "description"))) || ((data.icon === undefined) && (missing0 = "icon"))) || ((data.inputs === undefined) && (missing0 = "inputs"))) || ((data.outputs === undefined) && (missing0 = "outputs"))) || ((data.outputsDeriveFromParams === undefined) && (missing0 = "outputsDeriveFromParams"))) || ((data.params === undefined) && (missing0 = "params"))){validate2450.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(func2.call(schema4773.properties, key0))){validate2450.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.kind !== undefined){let data0: any = data.kind;const _errs2: any = errors;const _errs3: any = errors;if(errors === _errs3){if(typeof data0 === "string"){if(func1(data0) < 1){validate2450.errors = [{instancePath:instancePath+"/kind",schemaPath:"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowNodeKindId/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate2450.errors = [{instancePath:instancePath+"/kind",schemaPath:"sidekicks-contracts:workflow/definition/document#/$defs/WorkflowNodeKindId/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.version !== undefined){let data1: any = data.version;const _errs5: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validate2450.errors = [{instancePath:instancePath+"/version",schemaPath:"#/properties/version/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs5){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validate2450.errors = [{instancePath:instancePath+"/version",schemaPath:"#/properties/version/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 1 || isNaN(data1)){validate2450.errors = [{instancePath:instancePath+"/version",schemaPath:"#/properties/version/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.category !== undefined){let data2: any = data.category;const _errs7: any = errors;if(typeof data2 !== "string"){validate2450.errors = [{instancePath:instancePath+"/category",schemaPath:"#/$defs/WorkflowNodeKindCategory/type",keyword:"type",params:{type: "string"}}];return false;}if(!((((((((data2 === "trigger") || (data2 === "agent")) || (data2 === "human")) || (data2 === "files")) || (data2 === "browser")) || (data2 === "developer")) || (data2 === "flow")) || (data2 === "output"))){validate2450.errors = [{instancePath:instancePath+"/category",schemaPath:"#/$defs/WorkflowNodeKindCategory/enum",keyword:"enum",params:{allowedValues: schema4775.enum}}];return false;}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}if(valid0){if(data.displayName !== undefined){let data3: any = data.displayName;const _errs10: any = errors;if(errors === _errs10){if(typeof data3 === "string"){if(func1(data3) < 1){validate2450.errors = [{instancePath:instancePath+"/displayName",schemaPath:"#/properties/displayName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate2450.errors = [{instancePath:instancePath+"/displayName",schemaPath:"#/properties/displayName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.description !== undefined){let data4: any = data.description;const _errs12: any = errors;if(errors === _errs12){if(typeof data4 === "string"){if(func1(data4) < 1){validate2450.errors = [{instancePath:instancePath+"/description",schemaPath:"#/properties/description/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate2450.errors = [{instancePath:instancePath+"/description",schemaPath:"#/properties/description/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}if(valid0){if(data.icon !== undefined){let data5: any = data.icon;const _errs14: any = errors;if(errors === _errs14){if(typeof data5 === "string"){if(func1(data5) < 1){validate2450.errors = [{instancePath:instancePath+"/icon",schemaPath:"#/properties/icon/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate2450.errors = [{instancePath:instancePath+"/icon",schemaPath:"#/properties/icon/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs14 === errors;}else {var valid0: any = true;}if(valid0){if(data.aliases !== undefined){let data6: any = data.aliases;const _errs16: any = errors;if(errors === _errs16){if(Array.isArray(data6)){var valid3: any = true;const len0: any = data6.length;for(let i0=0; i0<len0; i0++){let data7: any = data6[i0];const _errs18: any = errors;if(errors === _errs18){if(typeof data7 === "string"){if(func1(data7) < 1){validate2450.errors = [{instancePath:instancePath+"/aliases/" + i0,schemaPath:"#/properties/aliases/items/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate2450.errors = [{instancePath:instancePath+"/aliases/" + i0,schemaPath:"#/properties/aliases/items/type",keyword:"type",params:{type: "string"}}];return false;}}var valid3: any = _errs18 === errors;if(!valid3){break;}}}else {validate2450.errors = [{instancePath:instancePath+"/aliases",schemaPath:"#/properties/aliases/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs16 === errors;}else {var valid0: any = true;}if(valid0){if(data.inputs !== undefined){let data8: any = data.inputs;const _errs20: any = errors;if(errors === _errs20){if(Array.isArray(data8)){var valid4: any = true;const len1: any = data8.length;for(let i1=0; i1<len1; i1++){let data9: any = data8[i1];const _errs22: any = errors;const _errs23: any = errors;if(errors === _errs23){if(data9 && typeof data9 == "object" && !Array.isArray(data9)){let valid6: any = false;const tag0: any = data9.type;if(typeof tag0 == "string"){if(tag0 === "main"){const _errs26: any = errors;if(errors === _errs26){if(data9 && typeof data9 == "object" && !Array.isArray(data9)){let missing1: any;if((((data9.type === undefined) && (missing1 = "type")) || ((data9.id === undefined) && (missing1 = "id"))) || ((data9.label === undefined) && (missing1 = "label"))){validate2450.errors = [{instancePath:instancePath+"/inputs/" + i1,schemaPath:"#/$defs/WorkflowInputHandleSpec/oneOf/0/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs28: any = errors;for(const key1 in data9){if(!(((((key1 === "type") || (key1 === "id")) || (key1 === "label")) || (key1 === "maxConnections")) || (key1 === "required"))){validate2450.errors = [{instancePath:instancePath+"/inputs/" + i1,schemaPath:"#/$defs/WorkflowInputHandleSpec/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs28 === errors){if(data9.type !== undefined){let data10: any = data9.type;const _errs29: any = errors;if(typeof data10 !== "string"){validate2450.errors = [{instancePath:instancePath+"/inputs/" + i1+"/type",schemaPath:"#/$defs/WorkflowInputHandleSpec/oneOf/0/properties/type/type",keyword:"type",params:{type: "string"}}];return false;}if("main" !== data10){validate2450.errors = [{instancePath:instancePath+"/inputs/" + i1+"/type",schemaPath:"#/$defs/WorkflowInputHandleSpec/oneOf/0/properties/type/const",keyword:"const",params:{allowedValue: "main"}}];return false;}var valid8: any = _errs29 === errors;}else {var valid8: any = true;}if(valid8){if(data9.id !== undefined){let data11: any = data9.id;const _errs31: any = errors;if(errors === _errs31){if(typeof data11 === "string"){if(!pattern3230.test(data11)){validate2450.errors = [{instancePath:instancePath+"/inputs/" + i1+"/id",schemaPath:"#/$defs/WorkflowInputHandleSpec/oneOf/0/properties/id/pattern",keyword:"pattern",params:{pattern: "^inputs/main/(?:0|[1-9][0-9]{0,14}|[1-8][0-9]{15}|900[0-6][0-9]{12}|9007[0-0][0-9]{11}|90071[0-8][0-9]{10}|900719[0-8][0-9]{9}|9007199[0-1][0-9]{8}|90071992[0-4][0-9]{7}|900719925[0-3][0-9]{6}|9007199254[0-6][0-9]{5}|90071992547[0-3][0-9]{4}|9007199254740[0-8][0-9]{2}|90071992547409[0-8][0-9]{1}|900719925474099[0-0][0-9]{0}|9007199254740991)$"}}];return false;}}else {validate2450.errors = [{instancePath:instancePath+"/inputs/" + i1+"/id",schemaPath:"#/$defs/WorkflowInputHandleSpec/oneOf/0/properties/id/type",keyword:"type",params:{type: "string"}}];return false;}}var valid8: any = _errs31 === errors;}else {var valid8: any = true;}if(valid8){if(data9.label !== undefined){let data12: any = data9.label;const _errs33: any = errors;if(errors === _errs33){if(typeof data12 === "string"){if(func1(data12) < 1){validate2450.errors = [{instancePath:instancePath+"/inputs/" + i1+"/label",schemaPath:"#/$defs/WorkflowInputHandleSpec/oneOf/0/properties/label/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate2450.errors = [{instancePath:instancePath+"/inputs/" + i1+"/label",schemaPath:"#/$defs/WorkflowInputHandleSpec/oneOf/0/properties/label/type",keyword:"type",params:{type: "string"}}];return false;}}var valid8: any = _errs33 === errors;}else {var valid8: any = true;}if(valid8){if(data9.maxConnections !== undefined){let data13: any = data9.maxConnections;const _errs35: any = errors;if(!(((typeof data13 == "number") && (!(data13 % 1) && !isNaN(data13))) && (isFinite(data13)))){validate2450.errors = [{instancePath:instancePath+"/inputs/" + i1+"/maxConnections",schemaPath:"#/$defs/WorkflowInputHandleSpec/oneOf/0/properties/maxConnections/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs35){if((typeof data13 == "number") && (isFinite(data13))){if(data13 > 9007199254740991 || isNaN(data13)){validate2450.errors = [{instancePath:instancePath+"/inputs/" + i1+"/maxConnections",schemaPath:"#/$defs/WorkflowInputHandleSpec/oneOf/0/properties/maxConnections/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data13 < 1 || isNaN(data13)){validate2450.errors = [{instancePath:instancePath+"/inputs/" + i1+"/maxConnections",schemaPath:"#/$defs/WorkflowInputHandleSpec/oneOf/0/properties/maxConnections/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid8: any = _errs35 === errors;}else {var valid8: any = true;}if(valid8){if(data9.required !== undefined){const _errs37: any = errors;if(typeof data9.required !== "boolean"){validate2450.errors = [{instancePath:instancePath+"/inputs/" + i1+"/required",schemaPath:"#/$defs/WorkflowInputHandleSpec/oneOf/0/properties/required/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid8: any = _errs37 === errors;}else {var valid8: any = true;}}}}}}}}else {validate2450.errors = [{instancePath:instancePath+"/inputs/" + i1,schemaPath:"#/$defs/WorkflowInputHandleSpec/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid7: any = _errs26 === errors;var props0: any = true;valid6 = valid7;}else if(tag0 === "tool"){const _errs39: any = errors;if(errors === _errs39){if(data9 && typeof data9 == "object" && !Array.isArray(data9)){let missing2: any;if((((data9.type === undefined) && (missing2 = "type")) || ((data9.id === undefined) && (missing2 = "id"))) || ((data9.label === undefined) && (missing2 = "label"))){validate2450.errors = [{instancePath:instancePath+"/inputs/" + i1,schemaPath:"#/$defs/WorkflowInputHandleSpec/oneOf/1/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs41: any = errors;for(const key2 in data9){if(!(((((key2 === "type") || (key2 === "id")) || (key2 === "label")) || (key2 === "maxConnections")) || (key2 === "required"))){validate2450.errors = [{instancePath:instancePath+"/inputs/" + i1,schemaPath:"#/$defs/WorkflowInputHandleSpec/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs41 === errors){if(data9.type !== undefined){let data15: any = data9.type;const _errs42: any = errors;if(typeof data15 !== "string"){validate2450.errors = [{instancePath:instancePath+"/inputs/" + i1+"/type",schemaPath:"#/$defs/WorkflowInputHandleSpec/oneOf/1/properties/type/type",keyword:"type",params:{type: "string"}}];return false;}if("tool" !== data15){validate2450.errors = [{instancePath:instancePath+"/inputs/" + i1+"/type",schemaPath:"#/$defs/WorkflowInputHandleSpec/oneOf/1/properties/type/const",keyword:"const",params:{allowedValue: "tool"}}];return false;}var valid10: any = _errs42 === errors;}else {var valid10: any = true;}if(valid10){if(data9.id !== undefined){let data16: any = data9.id;const _errs44: any = errors;if(errors === _errs44){if(typeof data16 === "string"){if(!pattern3231.test(data16)){validate2450.errors = [{instancePath:instancePath+"/inputs/" + i1+"/id",schemaPath:"#/$defs/WorkflowInputHandleSpec/oneOf/1/properties/id/pattern",keyword:"pattern",params:{pattern: "^inputs/tool/(?:0|[1-9][0-9]{0,14}|[1-8][0-9]{15}|900[0-6][0-9]{12}|9007[0-0][0-9]{11}|90071[0-8][0-9]{10}|900719[0-8][0-9]{9}|9007199[0-1][0-9]{8}|90071992[0-4][0-9]{7}|900719925[0-3][0-9]{6}|9007199254[0-6][0-9]{5}|90071992547[0-3][0-9]{4}|9007199254740[0-8][0-9]{2}|90071992547409[0-8][0-9]{1}|900719925474099[0-0][0-9]{0}|9007199254740991)$"}}];return false;}}else {validate2450.errors = [{instancePath:instancePath+"/inputs/" + i1+"/id",schemaPath:"#/$defs/WorkflowInputHandleSpec/oneOf/1/properties/id/type",keyword:"type",params:{type: "string"}}];return false;}}var valid10: any = _errs44 === errors;}else {var valid10: any = true;}if(valid10){if(data9.label !== undefined){let data17: any = data9.label;const _errs46: any = errors;if(errors === _errs46){if(typeof data17 === "string"){if(func1(data17) < 1){validate2450.errors = [{instancePath:instancePath+"/inputs/" + i1+"/label",schemaPath:"#/$defs/WorkflowInputHandleSpec/oneOf/1/properties/label/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate2450.errors = [{instancePath:instancePath+"/inputs/" + i1+"/label",schemaPath:"#/$defs/WorkflowInputHandleSpec/oneOf/1/properties/label/type",keyword:"type",params:{type: "string"}}];return false;}}var valid10: any = _errs46 === errors;}else {var valid10: any = true;}if(valid10){if(data9.maxConnections !== undefined){let data18: any = data9.maxConnections;const _errs48: any = errors;if(!(((typeof data18 == "number") && (!(data18 % 1) && !isNaN(data18))) && (isFinite(data18)))){validate2450.errors = [{instancePath:instancePath+"/inputs/" + i1+"/maxConnections",schemaPath:"#/$defs/WorkflowInputHandleSpec/oneOf/1/properties/maxConnections/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs48){if((typeof data18 == "number") && (isFinite(data18))){if(data18 > 9007199254740991 || isNaN(data18)){validate2450.errors = [{instancePath:instancePath+"/inputs/" + i1+"/maxConnections",schemaPath:"#/$defs/WorkflowInputHandleSpec/oneOf/1/properties/maxConnections/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data18 < 1 || isNaN(data18)){validate2450.errors = [{instancePath:instancePath+"/inputs/" + i1+"/maxConnections",schemaPath:"#/$defs/WorkflowInputHandleSpec/oneOf/1/properties/maxConnections/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid10: any = _errs48 === errors;}else {var valid10: any = true;}if(valid10){if(data9.required !== undefined){const _errs50: any = errors;if(typeof data9.required !== "boolean"){validate2450.errors = [{instancePath:instancePath+"/inputs/" + i1+"/required",schemaPath:"#/$defs/WorkflowInputHandleSpec/oneOf/1/properties/required/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid10: any = _errs50 === errors;}else {var valid10: any = true;}}}}}}}}else {validate2450.errors = [{instancePath:instancePath+"/inputs/" + i1,schemaPath:"#/$defs/WorkflowInputHandleSpec/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid9: any = _errs39 === errors;if(props0 !== true){props0 = true;}valid6 = valid9;}else {validate2450.errors = [{instancePath:instancePath+"/inputs/" + i1,schemaPath:"#/$defs/WorkflowInputHandleSpec/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "type", tagValue: tag0}}];return false;}}else {validate2450.errors = [{instancePath:instancePath+"/inputs/" + i1,schemaPath:"#/$defs/WorkflowInputHandleSpec/discriminator",keyword:"discriminator",params:{error: "tag", tag: "type", tagValue: tag0}}];return false;}if(valid6){if(props0 !== true){for(const key3 in data9){if(!props0 || !props0[key3]){validate2450.errors = [{instancePath:instancePath+"/inputs/" + i1,schemaPath:"#/$defs/WorkflowInputHandleSpec/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key3}}];return false;break;}}}}}else {validate2450.errors = [{instancePath:instancePath+"/inputs/" + i1,schemaPath:"#/$defs/WorkflowInputHandleSpec/type",keyword:"type",params:{type: "object"}}];return false;}}var valid4: any = _errs22 === errors;if(!valid4){break;}}if(valid4){let i2: any = data8.length;let j0: any;if(i2 > 1){outer0:for(;i2--;){for(j0 = i2; j0--;){if(func0(data8[i2], data8[j0])){validate2450.errors = [{instancePath:instancePath+"/inputs",schemaPath:"#/properties/inputs/uniqueItems",keyword:"uniqueItems",params:{i: i2, j: j0}}];return false;break outer0;}}}}}}else {validate2450.errors = [{instancePath:instancePath+"/inputs",schemaPath:"#/properties/inputs/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs20 === errors;}else {var valid0: any = true;}if(valid0){if(data.outputs !== undefined){let data20: any = data.outputs;const _errs53: any = errors;if(errors === _errs53){if(Array.isArray(data20)){var valid12: any = true;const len2: any = data20.length;for(let i3=0; i3<len2; i3++){let data21: any = data20[i3];const _errs55: any = errors;const _errs56: any = errors;if(errors === _errs56){if(data21 && typeof data21 == "object" && !Array.isArray(data21)){let valid14: any = false;const tag1: any = data21.type;if(typeof tag1 == "string"){if(tag1 === "main"){const _errs59: any = errors;if(errors === _errs59){if(data21 && typeof data21 == "object" && !Array.isArray(data21)){let missing3: any;if((((data21.type === undefined) && (missing3 = "type")) || ((data21.id === undefined) && (missing3 = "id"))) || ((data21.label === undefined) && (missing3 = "label"))){validate2450.errors = [{instancePath:instancePath+"/outputs/" + i3,schemaPath:"#/$defs/WorkflowOutputHandleSpec/oneOf/0/required",keyword:"required",params:{missingProperty: missing3}}];return false;}else {const _errs61: any = errors;for(const key4 in data21){if(!(((((key4 === "type") || (key4 === "id")) || (key4 === "label")) || (key4 === "maxConnections")) || (key4 === "required"))){validate2450.errors = [{instancePath:instancePath+"/outputs/" + i3,schemaPath:"#/$defs/WorkflowOutputHandleSpec/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key4}}];return false;break;}}if(_errs61 === errors){if(data21.type !== undefined){let data22: any = data21.type;const _errs62: any = errors;if(typeof data22 !== "string"){validate2450.errors = [{instancePath:instancePath+"/outputs/" + i3+"/type",schemaPath:"#/$defs/WorkflowOutputHandleSpec/oneOf/0/properties/type/type",keyword:"type",params:{type: "string"}}];return false;}if("main" !== data22){validate2450.errors = [{instancePath:instancePath+"/outputs/" + i3+"/type",schemaPath:"#/$defs/WorkflowOutputHandleSpec/oneOf/0/properties/type/const",keyword:"const",params:{allowedValue: "main"}}];return false;}var valid16: any = _errs62 === errors;}else {var valid16: any = true;}if(valid16){if(data21.id !== undefined){let data23: any = data21.id;const _errs64: any = errors;if(errors === _errs64){if(typeof data23 === "string"){if(!pattern3232.test(data23)){validate2450.errors = [{instancePath:instancePath+"/outputs/" + i3+"/id",schemaPath:"#/$defs/WorkflowOutputHandleSpec/oneOf/0/properties/id/pattern",keyword:"pattern",params:{pattern: "^outputs/main/(?:0|[1-9][0-9]{0,14}|[1-8][0-9]{15}|900[0-6][0-9]{12}|9007[0-0][0-9]{11}|90071[0-8][0-9]{10}|900719[0-8][0-9]{9}|9007199[0-1][0-9]{8}|90071992[0-4][0-9]{7}|900719925[0-3][0-9]{6}|9007199254[0-6][0-9]{5}|90071992547[0-3][0-9]{4}|9007199254740[0-8][0-9]{2}|90071992547409[0-8][0-9]{1}|900719925474099[0-0][0-9]{0}|9007199254740991)$"}}];return false;}}else {validate2450.errors = [{instancePath:instancePath+"/outputs/" + i3+"/id",schemaPath:"#/$defs/WorkflowOutputHandleSpec/oneOf/0/properties/id/type",keyword:"type",params:{type: "string"}}];return false;}}var valid16: any = _errs64 === errors;}else {var valid16: any = true;}if(valid16){if(data21.label !== undefined){let data24: any = data21.label;const _errs66: any = errors;if(errors === _errs66){if(typeof data24 === "string"){if(func1(data24) < 1){validate2450.errors = [{instancePath:instancePath+"/outputs/" + i3+"/label",schemaPath:"#/$defs/WorkflowOutputHandleSpec/oneOf/0/properties/label/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate2450.errors = [{instancePath:instancePath+"/outputs/" + i3+"/label",schemaPath:"#/$defs/WorkflowOutputHandleSpec/oneOf/0/properties/label/type",keyword:"type",params:{type: "string"}}];return false;}}var valid16: any = _errs66 === errors;}else {var valid16: any = true;}if(valid16){if(data21.maxConnections !== undefined){let data25: any = data21.maxConnections;const _errs68: any = errors;if(!(((typeof data25 == "number") && (!(data25 % 1) && !isNaN(data25))) && (isFinite(data25)))){validate2450.errors = [{instancePath:instancePath+"/outputs/" + i3+"/maxConnections",schemaPath:"#/$defs/WorkflowOutputHandleSpec/oneOf/0/properties/maxConnections/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs68){if((typeof data25 == "number") && (isFinite(data25))){if(data25 > 9007199254740991 || isNaN(data25)){validate2450.errors = [{instancePath:instancePath+"/outputs/" + i3+"/maxConnections",schemaPath:"#/$defs/WorkflowOutputHandleSpec/oneOf/0/properties/maxConnections/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data25 < 1 || isNaN(data25)){validate2450.errors = [{instancePath:instancePath+"/outputs/" + i3+"/maxConnections",schemaPath:"#/$defs/WorkflowOutputHandleSpec/oneOf/0/properties/maxConnections/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid16: any = _errs68 === errors;}else {var valid16: any = true;}if(valid16){if(data21.required !== undefined){const _errs70: any = errors;if(typeof data21.required !== "boolean"){validate2450.errors = [{instancePath:instancePath+"/outputs/" + i3+"/required",schemaPath:"#/$defs/WorkflowOutputHandleSpec/oneOf/0/properties/required/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid16: any = _errs70 === errors;}else {var valid16: any = true;}}}}}}}}else {validate2450.errors = [{instancePath:instancePath+"/outputs/" + i3,schemaPath:"#/$defs/WorkflowOutputHandleSpec/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid15: any = _errs59 === errors;var props1: any = true;valid14 = valid15;}else if(tag1 === "tool"){const _errs72: any = errors;if(errors === _errs72){if(data21 && typeof data21 == "object" && !Array.isArray(data21)){let missing4: any;if((((data21.type === undefined) && (missing4 = "type")) || ((data21.id === undefined) && (missing4 = "id"))) || ((data21.label === undefined) && (missing4 = "label"))){validate2450.errors = [{instancePath:instancePath+"/outputs/" + i3,schemaPath:"#/$defs/WorkflowOutputHandleSpec/oneOf/1/required",keyword:"required",params:{missingProperty: missing4}}];return false;}else {const _errs74: any = errors;for(const key5 in data21){if(!(((((key5 === "type") || (key5 === "id")) || (key5 === "label")) || (key5 === "maxConnections")) || (key5 === "required"))){validate2450.errors = [{instancePath:instancePath+"/outputs/" + i3,schemaPath:"#/$defs/WorkflowOutputHandleSpec/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key5}}];return false;break;}}if(_errs74 === errors){if(data21.type !== undefined){let data27: any = data21.type;const _errs75: any = errors;if(typeof data27 !== "string"){validate2450.errors = [{instancePath:instancePath+"/outputs/" + i3+"/type",schemaPath:"#/$defs/WorkflowOutputHandleSpec/oneOf/1/properties/type/type",keyword:"type",params:{type: "string"}}];return false;}if("tool" !== data27){validate2450.errors = [{instancePath:instancePath+"/outputs/" + i3+"/type",schemaPath:"#/$defs/WorkflowOutputHandleSpec/oneOf/1/properties/type/const",keyword:"const",params:{allowedValue: "tool"}}];return false;}var valid18: any = _errs75 === errors;}else {var valid18: any = true;}if(valid18){if(data21.id !== undefined){let data28: any = data21.id;const _errs77: any = errors;if(errors === _errs77){if(typeof data28 === "string"){if(!pattern3233.test(data28)){validate2450.errors = [{instancePath:instancePath+"/outputs/" + i3+"/id",schemaPath:"#/$defs/WorkflowOutputHandleSpec/oneOf/1/properties/id/pattern",keyword:"pattern",params:{pattern: "^outputs/tool/(?:0|[1-9][0-9]{0,14}|[1-8][0-9]{15}|900[0-6][0-9]{12}|9007[0-0][0-9]{11}|90071[0-8][0-9]{10}|900719[0-8][0-9]{9}|9007199[0-1][0-9]{8}|90071992[0-4][0-9]{7}|900719925[0-3][0-9]{6}|9007199254[0-6][0-9]{5}|90071992547[0-3][0-9]{4}|9007199254740[0-8][0-9]{2}|90071992547409[0-8][0-9]{1}|900719925474099[0-0][0-9]{0}|9007199254740991)$"}}];return false;}}else {validate2450.errors = [{instancePath:instancePath+"/outputs/" + i3+"/id",schemaPath:"#/$defs/WorkflowOutputHandleSpec/oneOf/1/properties/id/type",keyword:"type",params:{type: "string"}}];return false;}}var valid18: any = _errs77 === errors;}else {var valid18: any = true;}if(valid18){if(data21.label !== undefined){let data29: any = data21.label;const _errs79: any = errors;if(errors === _errs79){if(typeof data29 === "string"){if(func1(data29) < 1){validate2450.errors = [{instancePath:instancePath+"/outputs/" + i3+"/label",schemaPath:"#/$defs/WorkflowOutputHandleSpec/oneOf/1/properties/label/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validate2450.errors = [{instancePath:instancePath+"/outputs/" + i3+"/label",schemaPath:"#/$defs/WorkflowOutputHandleSpec/oneOf/1/properties/label/type",keyword:"type",params:{type: "string"}}];return false;}}var valid18: any = _errs79 === errors;}else {var valid18: any = true;}if(valid18){if(data21.maxConnections !== undefined){let data30: any = data21.maxConnections;const _errs81: any = errors;if(!(((typeof data30 == "number") && (!(data30 % 1) && !isNaN(data30))) && (isFinite(data30)))){validate2450.errors = [{instancePath:instancePath+"/outputs/" + i3+"/maxConnections",schemaPath:"#/$defs/WorkflowOutputHandleSpec/oneOf/1/properties/maxConnections/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs81){if((typeof data30 == "number") && (isFinite(data30))){if(data30 > 9007199254740991 || isNaN(data30)){validate2450.errors = [{instancePath:instancePath+"/outputs/" + i3+"/maxConnections",schemaPath:"#/$defs/WorkflowOutputHandleSpec/oneOf/1/properties/maxConnections/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data30 < 1 || isNaN(data30)){validate2450.errors = [{instancePath:instancePath+"/outputs/" + i3+"/maxConnections",schemaPath:"#/$defs/WorkflowOutputHandleSpec/oneOf/1/properties/maxConnections/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid18: any = _errs81 === errors;}else {var valid18: any = true;}if(valid18){if(data21.required !== undefined){const _errs83: any = errors;if(typeof data21.required !== "boolean"){validate2450.errors = [{instancePath:instancePath+"/outputs/" + i3+"/required",schemaPath:"#/$defs/WorkflowOutputHandleSpec/oneOf/1/properties/required/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid18: any = _errs83 === errors;}else {var valid18: any = true;}}}}}}}}else {validate2450.errors = [{instancePath:instancePath+"/outputs/" + i3,schemaPath:"#/$defs/WorkflowOutputHandleSpec/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid17: any = _errs72 === errors;if(props1 !== true){props1 = true;}valid14 = valid17;}else {validate2450.errors = [{instancePath:instancePath+"/outputs/" + i3,schemaPath:"#/$defs/WorkflowOutputHandleSpec/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "type", tagValue: tag1}}];return false;}}else {validate2450.errors = [{instancePath:instancePath+"/outputs/" + i3,schemaPath:"#/$defs/WorkflowOutputHandleSpec/discriminator",keyword:"discriminator",params:{error: "tag", tag: "type", tagValue: tag1}}];return false;}if(valid14){if(props1 !== true){for(const key6 in data21){if(!props1 || !props1[key6]){validate2450.errors = [{instancePath:instancePath+"/outputs/" + i3,schemaPath:"#/$defs/WorkflowOutputHandleSpec/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key6}}];return false;break;}}}}}else {validate2450.errors = [{instancePath:instancePath+"/outputs/" + i3,schemaPath:"#/$defs/WorkflowOutputHandleSpec/type",keyword:"type",params:{type: "object"}}];return false;}}var valid12: any = _errs55 === errors;if(!valid12){break;}}if(valid12){let i4: any = data20.length;let j1: any;if(i4 > 1){outer1:for(;i4--;){for(j1 = i4; j1--;){if(func0(data20[i4], data20[j1])){validate2450.errors = [{instancePath:instancePath+"/outputs",schemaPath:"#/properties/outputs/uniqueItems",keyword:"uniqueItems",params:{i: i4, j: j1}}];return false;break outer1;}}}}}}else {validate2450.errors = [{instancePath:instancePath+"/outputs",schemaPath:"#/properties/outputs/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs53 === errors;}else {var valid0: any = true;}if(valid0){if(data.outputsDeriveFromParams !== undefined){const _errs86: any = errors;if(typeof data.outputsDeriveFromParams !== "boolean"){validate2450.errors = [{instancePath:instancePath+"/outputsDeriveFromParams",schemaPath:"#/properties/outputsDeriveFromParams/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs86 === errors;}else {var valid0: any = true;}if(valid0){if(data.params !== undefined){let data33: any = data.params;const _errs88: any = errors;if(errors === _errs88){if(Array.isArray(data33)){var valid20: any = true;const len3: any = data33.length;for(let i5=0; i5<len3; i5++){const _errs90: any = errors;if(!(validate2451.call(this, data33[i5], {instancePath:instancePath+"/params/" + i5,parentData:data33,parentDataProperty:i5,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate2451.errors : vErrors.concat(validate2451.errors);errors = vErrors.length;}var valid20: any = _errs90 === errors;if(!valid20){break;}}}else {validate2450.errors = [{instancePath:instancePath+"/params",schemaPath:"#/properties/params/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs88 === errors;}else {var valid0: any = true;}if(valid0){if(data.perItem !== undefined){const _errs91: any = errors;if(typeof data.perItem !== "boolean"){validate2450.errors = [{instancePath:instancePath+"/perItem",schemaPath:"#/properties/perItem/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs91 === errors;}else {var valid0: any = true;}if(valid0){if(data.capabilities !== undefined){const _errs93: any = errors;if(!(validate2457.call(this, data.capabilities, {instancePath:instancePath+"/capabilities",parentData:data,parentDataProperty:"capabilities",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate2457.errors : vErrors.concat(validate2457.errors);errors = vErrors.length;}var valid0: any = _errs93 === errors;}else {var valid0: any = true;}}}}}}}}}}}}}}}}else {validate2450.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2450.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2450.errors = null as any[] | null;
// prettier-ignore
validate2450.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2449(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowKindListResponse {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2449.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.kinds === undefined) && (missing0 = "kinds")){validate2449.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(key0 === "kinds")){validate2449.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.kinds !== undefined){let data0: any = data.kinds;const _errs2: any = errors;if(errors === _errs2){if(Array.isArray(data0)){var valid1: any = true;const len0: any = data0.length;for(let i0=0; i0<len0; i0++){const _errs4: any = errors;if(!(validate2450.call(this, data0[i0], {instancePath:instancePath+"/kinds/" + i0,parentData:data0,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate2450.errors : vErrors.concat(validate2450.errors);errors = vErrors.length;}var valid1: any = _errs4 === errors;if(!valid1){break;}}}else {validate2449.errors = [{instancePath:instancePath+"/kinds",schemaPath:"#/properties/kinds/type",keyword:"type",params:{type: "array"}}];return false;}}}}}}else {validate2449.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validate2449.errors = vErrors;return errors === 0;}
// prettier-ignore
validate2449.errors = null as any[] | null;
// prettier-ignore
validate2449.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
function validate2460(this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowParamSpec {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validate2460.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}const _errs0: any = errors;let valid0: any = false;const _errs1: any = errors;if(!(validate2452.call(this, data, {instancePath,parentData,parentDataProperty,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate2452.errors : vErrors.concat(validate2452.errors);errors = vErrors.length;}var _valid0: any = _errs1 === errors;valid0 = valid0 || _valid0;if(_valid0){var props0: any = true;}const _errs2: any = errors;if(!(validate2454.call(this, data, {instancePath,parentData,parentDataProperty,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validate2454.errors : vErrors.concat(validate2454.errors);errors = vErrors.length;}var _valid0: any = _errs2 === errors;valid0 = valid0 || _valid0;if(_valid0){if(props0 !== true){props0 = true;}}if(!valid0){const err0: any = {instancePath,schemaPath:"#/anyOf",keyword:"anyOf",params:{}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;validate2460.errors = vErrors;return false;}else {errors = _errs0;if(vErrors !== null){if(_errs0){vErrors.length = _errs0;}else {vErrors = null;}}}validate2460.errors = vErrors;evaluated0.props = props0;return errors === 0;}
// prettier-ignore
validate2460.errors = null as any[] | null;
// prettier-ignore
validate2460.evaluated = {"dynamicProps":true,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowKindListResponse}. */
export const validateWorkflowKindListResponse: SchemaCheck<WorkflowKindListResponse> = validate2449;
/** Checks that a value is a {@link WorkflowParamSpec}. */
export const validateWorkflowParamSpec: SchemaCheck<WorkflowParamSpec> = validate2460;

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
