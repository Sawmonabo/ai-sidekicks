// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Workflow definitions: the node-graph document an author writes and the ids that address a definition and its versions.

import { type CompiledSchemaCheck, deepEqual, ucs2length } from "../../../schema-check.js";
import { type McpServerBindingRef, validateMcpServerBindingRef } from "../../mcp/server.js";
import { type TagList, validateTagList } from "../../tag.js";
import { type WorkflowPinnedItem, validateWorkflowPinnedItem } from "./item.js";

/** The document schema version this contract reads and writes. */
export const WORKFLOW_DOCUMENT_SCHEMA_VERSION = "2" as const;

/** Every way a `flow.merge` node joins its inputs. */
export const WORKFLOW_MERGE_MODES = [
  "append",
  "combineByField",
  "combineByPosition",
  "chooseBranch",
  "firstToArrive",
] as const;

/**
 * A workflow definition's id. The daemon mints it; a client passes it through unparsed.
 */
export type WorkflowDefinitionId = string & { readonly __brand: "WorkflowDefinitionId" };
/**
 * One saved version's id, exactly as the daemon returned it; it is what a run start takes. The
 * daemon mints it; a client never builds one from a definition id and a version number.
 */
export type WorkflowVersionId = string & { readonly __brand: "WorkflowVersionId" };
/**
 * A content hash: BLAKE3 over RFC 8785 canonical JSON, of a document's hashed body or of the
 * items pinned onto a node.
 */
export type WorkflowContentHash = string;
/**
 * The node's id, unique in the document; edges and expressions address it.
 */
export type WorkflowNodeId = string & { readonly __brand: "WorkflowNodeId" };
/**
 * The node kind's key as workflow.kind.list lists it, such as files.read.
 */
export type WorkflowNodeKindId = string;
/**
 * An edge's id, unique among the document's edges.
 */
export type WorkflowEdgeId = string;
/**
 * A sticky note's id, unique among the canvas's notes.
 */
export type WorkflowStickyNoteId = string;
/**
 * The document schema version, always `2`.
 */
export type WorkflowDocumentSchemaVersion = "2";
/**
 * What a node's failure does: stop the run, pass the node's input on, or send the failed items
 * down a real `error` output handle.
 */
export type WorkflowNodeOnError = "stop" | "continue" | "continueErrorOutput";
/**
 * How a `flow.merge` node joins its inputs into its one output. `firstToArrive` passes on the
 * first input to succeed and cancels the branches still running.
 */
export type WorkflowMergeMode =
  | "append"
  | "combineByField"
  | "combineByPosition"
  | "chooseBranch"
  | "firstToArrive";
/**
 * One input a workflow declares on its trigger, which a run start fills by `name`, unique among
 * the trigger's inputs. Its type picks the field Run now draws: a checkbox for `boolean`, a list
 * of `options` for `select`, a folder picker for `path`, a box for `string`. `default` is the
 * value the field starts on, and a `select` input's is one of its `options`.
 */
export type WorkflowTriggerInput =
  | {
      type: "boolean";
      /**
       * The input's name; a run start fills the input by it.
       */
      name: string;
      /**
       * True where a start must fill the input; omitted, it may be left out.
       */
      required?: boolean;
      /**
       * The value the field starts on.
       */
      default: boolean;
    }
  | {
      type: "string";
      /**
       * The input's name; a run start fills the input by it.
       */
      name: string;
      /**
       * True where a start must fill the input; omitted, it may be left out.
       */
      required?: boolean;
      /**
       * The value the field starts on.
       */
      default: string;
    }
  | {
      type: "path";
      /**
       * The input's name; a run start fills the input by it.
       */
      name: string;
      /**
       * True where a start must fill the input; omitted, it may be left out.
       */
      required?: boolean;
      /**
       * The path the field starts on.
       */
      default: string;
    }
  | {
      type: "select";
      /**
       * The input's name; a run start fills the input by it.
       */
      name: string;
      /**
       * True where a start must fill the input; omitted, it may be left out.
       */
      required?: boolean;
      /**
       * The choices, at least one; default is one of them.
       *
       * @minItems 1
       */
      options: [string, ...string[]];
      /**
       * The choice the field starts on.
       */
      default: string;
    };

/**
 * A node's retries on failure, as the author asks for them; the engine clamps both.
 */
export interface WorkflowNodeRetry {
  /**
   * The tries, from 1.
   */
  maxTries: number;
  /**
   * The wait between tries, in milliseconds.
   */
  waitMs: number;
}
/**
 * One node. `kindVersion` is written when the node is placed and never migrated: the daemon
 * runs the kind implementation the document names. `order` decides which sibling branch runs
 * first and is never derived from canvas position.
 */
export interface WorkflowNode {
  /**
   * The node's id.
   */
  id: WorkflowNodeId;
  /**
   * The node's kind.
   */
  kind: WorkflowNodeKindId;
  /**
   * The kind's version when the node was placed; a whole number from 1.
   */
  kindVersion: number;
  /**
   * The label a person reads; never used to address the node.
   */
  name: string;
  /**
   * Which sibling branch runs first, lowest first; never the canvas position.
   */
  order: number;
  /**
   * The node's parameters by the ids its kind lists. A value is a literal, or an expression written ={{ … }}. An agent, project or session parameter holds that record's id and an MCP tool parameter its server binding and tool name, never a nested node. A secret is written secret://shared/<name> or secret://project/<name>, never as an expression, and only in a parameter the kind marks sensitive.
   */
  params: {
    [k: string]: unknown | undefined;
  };
  /**
   * Whether the node is switched off.
   */
  disabled?: boolean;
  /**
   * The author's notes.
   */
  notes?: string;
  /**
   * What the node's failure does.
   */
  onError?: WorkflowNodeOnError;
  /**
   * Retries on failure: maxTries from 1, waitMs from 0; the engine clamps both.
   */
  retry?: WorkflowNodeRetry;
  /**
   * Whether the node runs once, over its first item only.
   */
  executeOnce?: boolean;
  /**
   * Whether the node outputs one empty item where it would output none.
   */
  alwaysOutputData?: boolean;
}
/**
 * The trigger node: a node that may also declare the inputs a run of the workflow starts
 * with, each name used once.
 */
export interface WorkflowTriggerNode {
  /**
   * The node's id.
   */
  id: WorkflowNodeId;
  /**
   * The node's kind.
   */
  kind: WorkflowNodeKindId;
  /**
   * The kind's version when the node was placed; a whole number from 1.
   */
  kindVersion: number;
  /**
   * The label a person reads; never used to address the node.
   */
  name: string;
  /**
   * Which sibling branch runs first, lowest first; never the canvas position.
   */
  order: number;
  /**
   * The node's parameters by the ids its kind lists. A value is a literal, or an expression written ={{ … }}. An agent, project or session parameter holds that record's id and an MCP tool parameter its server binding and tool name, never a nested node. A secret is written secret://shared/<name> or secret://project/<name>, never as an expression, and only in a parameter the kind marks sensitive.
   */
  params: {
    [k: string]: unknown | undefined;
  };
  /**
   * Whether the node is switched off.
   */
  disabled?: boolean;
  /**
   * The author's notes.
   */
  notes?: string;
  /**
   * What the node's failure does.
   */
  onError?: WorkflowNodeOnError;
  /**
   * Retries on failure: maxTries from 1, waitMs from 0; the engine clamps both.
   */
  retry?: WorkflowNodeRetry;
  /**
   * Whether the node runs once, over its first item only.
   */
  executeOnce?: boolean;
  /**
   * Whether the node outputs one empty item where it would output none.
   */
  alwaysOutputData?: boolean;
  /**
   * The inputs a run starts with, each with a name no other input uses and a type (boolean, string, path, or select with its options) with the value it starts on as default; required marks one a start must fill.
   */
  inputs?: WorkflowTriggerInput[];
}
/**
 * One edge. It names the two handles it joins, not only the two nodes, because a node can carry
 * several handles on each side. A handle id reads `<mode>/<type>/<index>`, such as
 * `outputs/main/1`; the daemon's check at save refuses a type other than `main` or `tool`.
 */
export interface WorkflowEdge {
  /**
   * The edge's id.
   */
  id: WorkflowEdgeId;
  /**
   * The node the edge leaves.
   */
  source: WorkflowNodeId;
  /**
   * The source node's output handle, such as outputs/main/0 or outputs/tool/0.
   */
  sourceHandle: string;
  /**
   * The node the edge enters.
   */
  target: WorkflowNodeId;
  /**
   * The target node's input handle, such as inputs/main/0 or inputs/tool/0.
   */
  targetHandle: string;
}
/**
 * A point on the canvas, in canvas units.
 */
export interface WorkflowCanvasPoint {
  /**
   * Across.
   */
  x: number;
  /**
   * Down.
   */
  y: number;
}
/**
 * The canvas's view: where it is scrolled to and how far it is zoomed.
 */
export interface WorkflowViewport {
  /**
   * Across.
   */
  x: number;
  /**
   * Down.
   */
  y: number;
  /**
   * The zoom, above 0.
   */
  zoom: number;
}
/**
 * A sticky note on the canvas: text in a box, with no handles.
 */
export interface WorkflowStickyNote {
  /**
   * The note's id.
   */
  id: WorkflowStickyNoteId;
  /**
   * The note's text.
   */
  text: string;
  /**
   * Across.
   */
  x: number;
  /**
   * Down.
   */
  y: number;
  /**
   * The box's width, above 0.
   */
  width: number;
  /**
   * The box's height, above 0.
   */
  height: number;
}
/**
 * Canvas geometry, in canvas units. Outside the hash, and persisted beside the version's body, so
 * an exported or agent-written workflow carries its picture. A document with no layout is laid
 * out by the daemon the same way every time.
 */
export interface WorkflowLayout {
  /**
   * Each node's position, by node id.
   */
  nodes: {
    [k: string]: WorkflowCanvasPoint | undefined;
  };
  /**
   * The canvas's view.
   */
  viewport?: WorkflowViewport;
  /**
   * The sticky notes.
   */
  notes?: WorkflowStickyNote[];
}
/**
 * A workflow document: exactly one trigger node, the other nodes, and the edges between
 * them, plus the layout, pinned data and tags outside the hash. What a failure does is set
 * on the node that failed, never in a document-wide block.
 */
export interface WorkflowDocument {
  /**
   * The document schema version; always "2".
   */
  schemaVersion: "2";
  /**
   * The workflow's name: 1 to 256 characters.
   */
  name: string;
  /**
   * The workflow's description.
   */
  description?: string;
  /**
   * The one trigger node; its kind is in the trigger category, such as trigger.manual. Only the trigger declares inputs.
   */
  trigger: WorkflowTriggerNode;
  /**
   * Every node except the trigger. Node ids are unique across the document, the trigger's included.
   */
  nodes: WorkflowNode[];
  /**
   * The connections. main carries items and tool carries a capability; nothing connects into the trigger, and nothing but a loop closes a cycle.
   */
  edges: WorkflowEdge[];
  /**
   * Canvas positions; outside the content hash. Omit it and the daemon lays the graph out.
   */
  layout?: WorkflowLayout;
  /**
   * Test data pinned onto nodes by node id; outside the content hash.
   */
  pinData?: {
    [k: string]: WorkflowPinnedItem[] | undefined;
  };
  /**
   * The workflow's tags, nested with / and held once ignoring case, each never empty, with no whitespace and no empty level around a /; outside the content hash.
   */
  tags?: TagList;
}
/**
 * The builder's unsaved document. It may not have its trigger yet: the builder opens on the
 * trigger picker, and a draft saved before one is placed still survives a reload.
 */
export interface WorkflowDraftDocument {
  /**
   * The document schema version; always "2".
   */
  schemaVersion: "2";
  /**
   * The workflow's name: 1 to 256 characters.
   */
  name: string;
  /**
   * The workflow's description.
   */
  description?: string;
  /**
   * The one trigger node; its kind is in the trigger category, such as trigger.manual. Only the trigger declares inputs.
   */
  trigger?: WorkflowTriggerNode;
  /**
   * Every node except the trigger. Node ids are unique across the document, the trigger's included.
   */
  nodes: WorkflowNode[];
  /**
   * The connections. main carries items and tool carries a capability; nothing connects into the trigger, and nothing but a loop closes a cycle.
   */
  edges: WorkflowEdge[];
  /**
   * Canvas positions; outside the content hash. Omit it and the daemon lays the graph out.
   */
  layout?: WorkflowLayout;
  /**
   * Test data pinned onto nodes by node id; outside the content hash.
   */
  pinData?: {
    [k: string]: WorkflowPinnedItem[] | undefined;
  };
  /**
   * The workflow's tags, nested with / and held once ignoring case, each never empty, with no whitespace and no empty level around a /; outside the content hash.
   */
  tags?: TagList;
}
/**
 * A node's tool parameter: which server's tool, and nothing about its policy. A tool's approval
 * lives only in Settings › MCP servers, read live when the step starts, so `enabled`,
 * `approvalMode` or `idempotencyClass` on a binding is an unknown member and fails the parse.
 */
export interface WorkflowToolBinding {
  /**
   * The server binding.
   */
  binding: McpServerBindingRef;
  /**
   * The tool's name.
   */
  toolName: string;
}

// prettier-ignore
const pattern3 = new RegExp("^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$", "u");
/** Checks that a value is a {@link WorkflowDefinitionId}. */
// prettier-ignore
export const validateWorkflowDefinitionId: CompiledSchemaCheck<WorkflowDefinitionId> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowDefinitionId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowDefinitionId.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern3.test(data)){validateWorkflowDefinitionId.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validateWorkflowDefinitionId.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateWorkflowDefinitionId.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowDefinitionId.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowVersionId}. */
// prettier-ignore
export const validateWorkflowVersionId: CompiledSchemaCheck<WorkflowVersionId> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowVersionId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowVersionId.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(!pattern3.test(data)){validateWorkflowVersionId.errors = [{instancePath,schemaPath:"#/pattern",keyword:"pattern",params:{pattern: "^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$"}}];return false;}}else {validateWorkflowVersionId.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateWorkflowVersionId.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowVersionId.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const func1 = ucs2length;
/** Checks that a value is a {@link WorkflowContentHash}. */
// prettier-ignore
export const validateWorkflowContentHash: CompiledSchemaCheck<WorkflowContentHash> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowContentHash {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowContentHash.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(func1(data) < 1){validateWorkflowContentHash.errors = [{instancePath,schemaPath:"#/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateWorkflowContentHash.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateWorkflowContentHash.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowContentHash.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowNodeId}. */
// prettier-ignore
export const validateWorkflowNodeId: CompiledSchemaCheck<WorkflowNodeId> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowNodeId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowNodeId.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(func1(data) < 1){validateWorkflowNodeId.errors = [{instancePath,schemaPath:"#/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateWorkflowNodeId.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateWorkflowNodeId.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowNodeId.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowNodeKindId}. */
// prettier-ignore
export const validateWorkflowNodeKindId: CompiledSchemaCheck<WorkflowNodeKindId> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowNodeKindId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowNodeKindId.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(func1(data) < 1){validateWorkflowNodeKindId.errors = [{instancePath,schemaPath:"#/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateWorkflowNodeKindId.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateWorkflowNodeKindId.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowNodeKindId.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowEdgeId}. */
// prettier-ignore
export const validateWorkflowEdgeId: CompiledSchemaCheck<WorkflowEdgeId> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowEdgeId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowEdgeId.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(func1(data) < 1){validateWorkflowEdgeId.errors = [{instancePath,schemaPath:"#/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateWorkflowEdgeId.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateWorkflowEdgeId.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowEdgeId.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowStickyNoteId}. */
// prettier-ignore
export const validateWorkflowStickyNoteId: CompiledSchemaCheck<WorkflowStickyNoteId> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowStickyNoteId {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowStickyNoteId.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(typeof data === "string"){if(func1(data) < 1){validateWorkflowStickyNoteId.errors = [{instancePath,schemaPath:"#/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateWorkflowStickyNoteId.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}}validateWorkflowStickyNoteId.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowStickyNoteId.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1418: any = {"description":"What a node's failure does: stop the run, pass the node's input on, or send the failed items\ndown a real `error` output handle.","type":"string","enum":["stop","continue","continueErrorOutput"]};
/** Checks that a value is a {@link WorkflowNodeOnError}. */
// prettier-ignore
export const validateWorkflowNodeOnError: CompiledSchemaCheck<WorkflowNodeOnError> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowNodeOnError {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowNodeOnError.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(typeof data !== "string"){validateWorkflowNodeOnError.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "string"}}];return false;}if(!(((data === "stop") || (data === "continue")) || (data === "continueErrorOutput"))){validateWorkflowNodeOnError.errors = [{instancePath,schemaPath:"#/enum",keyword:"enum",params:{allowedValues: schema1418.enum}}];return false;}validateWorkflowNodeOnError.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowNodeOnError.evaluated = {"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowNodeRetry}. */
// prettier-ignore
export const validateWorkflowNodeRetry: CompiledSchemaCheck<WorkflowNodeRetry> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowNodeRetry {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowNodeRetry.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.maxTries === undefined) && (missing0 = "maxTries")) || ((data.waitMs === undefined) && (missing0 = "waitMs"))){validateWorkflowNodeRetry.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "maxTries") || (key0 === "waitMs"))){validateWorkflowNodeRetry.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.maxTries !== undefined){let data0: any = data.maxTries;const _errs2: any = errors;if(!(((typeof data0 == "number") && (!(data0 % 1) && !isNaN(data0))) && (isFinite(data0)))){validateWorkflowNodeRetry.errors = [{instancePath:instancePath+"/maxTries",schemaPath:"#/properties/maxTries/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs2){if((typeof data0 == "number") && (isFinite(data0))){if(data0 > 9007199254740991 || isNaN(data0)){validateWorkflowNodeRetry.errors = [{instancePath:instancePath+"/maxTries",schemaPath:"#/properties/maxTries/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data0 < 1 || isNaN(data0)){validateWorkflowNodeRetry.errors = [{instancePath:instancePath+"/maxTries",schemaPath:"#/properties/maxTries/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.waitMs !== undefined){let data1: any = data.waitMs;const _errs4: any = errors;if(!(((typeof data1 == "number") && (!(data1 % 1) && !isNaN(data1))) && (isFinite(data1)))){validateWorkflowNodeRetry.errors = [{instancePath:instancePath+"/waitMs",schemaPath:"#/properties/waitMs/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs4){if((typeof data1 == "number") && (isFinite(data1))){if(data1 > 9007199254740991 || isNaN(data1)){validateWorkflowNodeRetry.errors = [{instancePath:instancePath+"/waitMs",schemaPath:"#/properties/waitMs/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data1 < 0 || isNaN(data1)){validateWorkflowNodeRetry.errors = [{instancePath:instancePath+"/waitMs",schemaPath:"#/properties/waitMs/minimum",keyword:"minimum",params:{comparison: ">=", limit: 0}}];return false;}}}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validateWorkflowNodeRetry.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowNodeRetry.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowNodeRetry.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1421: any = {"type":"object","additionalProperties":false,"properties":{"id":{"$ref":"#/$defs/WorkflowNodeId","description":"The node's id."},"kind":{"$ref":"#/$defs/WorkflowNodeKindId","description":"The node's kind."},"kindVersion":{"type":"integer","minimum":1,"maximum":9007199254740991,"description":"The kind's version when the node was placed; a whole number from 1."},"name":{"type":"string","minLength":1,"description":"The label a person reads; never used to address the node."},"order":{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991,"description":"Which sibling branch runs first, lowest first; never the canvas position."},"params":{"type":"object","propertyNames":{"allOf":[{"type":"string"},{"not":{"const":"__proto__"}}]},"additionalProperties":{"tsType":"unknown"},"description":"The node's parameters by the ids its kind lists. A value is a literal, or an expression written ={{ … }}. An agent, project or session parameter holds that record's id and an MCP tool parameter its server binding and tool name, never a nested node. A secret is written secret://shared/<name> or secret://project/<name>, never as an expression, and only in a parameter the kind marks sensitive."},"disabled":{"type":"boolean","description":"Whether the node is switched off."},"notes":{"type":"string","description":"The author's notes."},"onError":{"$ref":"#/$defs/WorkflowNodeOnError","description":"What the node's failure does."},"retry":{"$ref":"#/$defs/WorkflowNodeRetry","description":"Retries on failure: maxTries from 1, waitMs from 0; the engine clamps both."},"executeOnce":{"type":"boolean","description":"Whether the node runs once, over its first item only."},"alwaysOutputData":{"type":"boolean","description":"Whether the node outputs one empty item where it would output none."}},"required":["id","kind","kindVersion","name","order","params"],"description":"One node. `kindVersion` is written when the node is placed and never migrated: the daemon\nruns the kind implementation the document names. `order` decides which sibling branch runs\nfirst and is never derived from canvas position."};
// prettier-ignore
const func2 = Object.prototype.hasOwnProperty;
/** Checks that a value is a {@link WorkflowNode}. */
// prettier-ignore
export const validateWorkflowNode: CompiledSchemaCheck<WorkflowNode> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowNode {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowNode.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((((data.id === undefined) && (missing0 = "id")) || ((data.kind === undefined) && (missing0 = "kind"))) || ((data.kindVersion === undefined) && (missing0 = "kindVersion"))) || ((data.name === undefined) && (missing0 = "name"))) || ((data.order === undefined) && (missing0 = "order"))) || ((data.params === undefined) && (missing0 = "params"))){validateWorkflowNode.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(func2.call(schema1421.properties, key0))){validateWorkflowNode.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.id !== undefined){const _errs2: any = errors;if(!(validateWorkflowNodeId.call(this, data.id, {instancePath:instancePath+"/id",parentData:data,parentDataProperty:"id",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowNodeId.errors : vErrors.concat(validateWorkflowNodeId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.kind !== undefined){const _errs3: any = errors;if(!(validateWorkflowNodeKindId.call(this, data.kind, {instancePath:instancePath+"/kind",parentData:data,parentDataProperty:"kind",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowNodeKindId.errors : vErrors.concat(validateWorkflowNodeKindId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.kindVersion !== undefined){let data2: any = data.kindVersion;const _errs4: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validateWorkflowNode.errors = [{instancePath:instancePath+"/kindVersion",schemaPath:"#/properties/kindVersion/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs4){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validateWorkflowNode.errors = [{instancePath:instancePath+"/kindVersion",schemaPath:"#/properties/kindVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 1 || isNaN(data2)){validateWorkflowNode.errors = [{instancePath:instancePath+"/kindVersion",schemaPath:"#/properties/kindVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.name !== undefined){let data3: any = data.name;const _errs6: any = errors;if(errors === _errs6){if(typeof data3 === "string"){if(func1(data3) < 1){validateWorkflowNode.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateWorkflowNode.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.order !== undefined){let data4: any = data.order;const _errs8: any = errors;if(!(((typeof data4 == "number") && (!(data4 % 1) && !isNaN(data4))) && (isFinite(data4)))){validateWorkflowNode.errors = [{instancePath:instancePath+"/order",schemaPath:"#/properties/order/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs8){if((typeof data4 == "number") && (isFinite(data4))){if(data4 > 9007199254740991 || isNaN(data4)){validateWorkflowNode.errors = [{instancePath:instancePath+"/order",schemaPath:"#/properties/order/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data4 < -9007199254740991 || isNaN(data4)){validateWorkflowNode.errors = [{instancePath:instancePath+"/order",schemaPath:"#/properties/order/minimum",keyword:"minimum",params:{comparison: ">=", limit: -9007199254740991}}];return false;}}}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.params !== undefined){let data5: any = data.params;const _errs10: any = errors;if(errors === _errs10){if(data5 && typeof data5 == "object" && !Array.isArray(data5)){for(const key1 in data5){const _errs12: any = errors;const _errs13: any = errors;if(typeof key1 !== "string"){const err0: any = {instancePath:instancePath+"/params",schemaPath:"#/properties/params/propertyNames/allOf/0/type",keyword:"type",params:{type: "string"},propertyName:key1};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var valid2: any = _errs13 === errors;if(valid2){const _errs15: any = errors;const _errs16: any = errors;const _errs17: any = errors;if("__proto__" !== key1){const err1: any = {};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}var valid3: any = _errs17 === errors;if(valid3){const err2: any = {instancePath:instancePath+"/params",schemaPath:"#/properties/params/propertyNames/allOf/1/not",keyword:"not",params:{},propertyName:key1};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}else {errors = _errs16;if(vErrors !== null){if(_errs16){vErrors.length = _errs16;}else {vErrors = null;}}}var valid2: any = _errs15 === errors;}var valid1: any = _errs12 === errors;if(!valid1){const err3: any = {instancePath:instancePath+"/params",schemaPath:"#/properties/params/propertyNames",keyword:"propertyNames",params:{propertyName: key1}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;validateWorkflowNode.errors = vErrors;return false;break;}}if(valid1){for(const key2 in data5){const _errs19: any = errors;var valid4: any = _errs19 === errors;if(!valid4){break;}}}}else {validateWorkflowNode.errors = [{instancePath:instancePath+"/params",schemaPath:"#/properties/params/type",keyword:"type",params:{type: "object"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.disabled !== undefined){const _errs21: any = errors;if(typeof data.disabled !== "boolean"){validateWorkflowNode.errors = [{instancePath:instancePath+"/disabled",schemaPath:"#/properties/disabled/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs21 === errors;}else {var valid0: any = true;}if(valid0){if(data.notes !== undefined){const _errs23: any = errors;if(typeof data.notes !== "string"){validateWorkflowNode.errors = [{instancePath:instancePath+"/notes",schemaPath:"#/properties/notes/type",keyword:"type",params:{type: "string"}}];return false;}var valid0: any = _errs23 === errors;}else {var valid0: any = true;}if(valid0){if(data.onError !== undefined){const _errs25: any = errors;if(!(validateWorkflowNodeOnError.call(this, data.onError, {instancePath:instancePath+"/onError",parentData:data,parentDataProperty:"onError",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowNodeOnError.errors : vErrors.concat(validateWorkflowNodeOnError.errors);errors = vErrors.length;}var valid0: any = _errs25 === errors;}else {var valid0: any = true;}if(valid0){if(data.retry !== undefined){const _errs26: any = errors;if(!(validateWorkflowNodeRetry.call(this, data.retry, {instancePath:instancePath+"/retry",parentData:data,parentDataProperty:"retry",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowNodeRetry.errors : vErrors.concat(validateWorkflowNodeRetry.errors);errors = vErrors.length;}var valid0: any = _errs26 === errors;}else {var valid0: any = true;}if(valid0){if(data.executeOnce !== undefined){const _errs27: any = errors;if(typeof data.executeOnce !== "boolean"){validateWorkflowNode.errors = [{instancePath:instancePath+"/executeOnce",schemaPath:"#/properties/executeOnce/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs27 === errors;}else {var valid0: any = true;}if(valid0){if(data.alwaysOutputData !== undefined){const _errs29: any = errors;if(typeof data.alwaysOutputData !== "boolean"){validateWorkflowNode.errors = [{instancePath:instancePath+"/alwaysOutputData",schemaPath:"#/properties/alwaysOutputData/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs29 === errors;}else {var valid0: any = true;}}}}}}}}}}}}}}}else {validateWorkflowNode.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowNode.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowNode.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const func0 = deepEqual;
/** Checks that a value is a {@link WorkflowTriggerInput}. */
// prettier-ignore
export const validateWorkflowTriggerInput: CompiledSchemaCheck<WorkflowTriggerInput> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowTriggerInput {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowTriggerInput.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let valid0: any = false;const tag0: any = data.type;if(typeof tag0 == "string"){if(tag0 === "boolean"){const _errs2: any = errors;if(errors === _errs2){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.type === undefined) && (missing0 = "type")) || ((data.name === undefined) && (missing0 = "name"))) || ((data.default === undefined) && (missing0 = "default"))){validateWorkflowTriggerInput.errors = [{instancePath,schemaPath:"#/oneOf/0/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs4: any = errors;for(const key0 in data){if(!((((key0 === "type") || (key0 === "name")) || (key0 === "required")) || (key0 === "default"))){validateWorkflowTriggerInput.errors = [{instancePath,schemaPath:"#/oneOf/0/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs4 === errors){if(data.type !== undefined){let data0: any = data.type;const _errs5: any = errors;if(typeof data0 !== "string"){validateWorkflowTriggerInput.errors = [{instancePath:instancePath+"/type",schemaPath:"#/oneOf/0/properties/type/type",keyword:"type",params:{type: "string"}}];return false;}if("boolean" !== data0){validateWorkflowTriggerInput.errors = [{instancePath:instancePath+"/type",schemaPath:"#/oneOf/0/properties/type/const",keyword:"const",params:{allowedValue: "boolean"}}];return false;}var valid2: any = _errs5 === errors;}else {var valid2: any = true;}if(valid2){if(data.name !== undefined){let data1: any = data.name;const _errs7: any = errors;if(errors === _errs7){if(typeof data1 === "string"){if(func1(data1) < 1){validateWorkflowTriggerInput.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/0/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateWorkflowTriggerInput.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/0/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid2: any = _errs7 === errors;}else {var valid2: any = true;}if(valid2){if(data.required !== undefined){const _errs9: any = errors;if(typeof data.required !== "boolean"){validateWorkflowTriggerInput.errors = [{instancePath:instancePath+"/required",schemaPath:"#/oneOf/0/properties/required/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid2: any = _errs9 === errors;}else {var valid2: any = true;}if(valid2){if(data.default !== undefined){const _errs11: any = errors;if(typeof data.default !== "boolean"){validateWorkflowTriggerInput.errors = [{instancePath:instancePath+"/default",schemaPath:"#/oneOf/0/properties/default/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid2: any = _errs11 === errors;}else {var valid2: any = true;}}}}}}}else {validateWorkflowTriggerInput.errors = [{instancePath,schemaPath:"#/oneOf/0/type",keyword:"type",params:{type: "object"}}];return false;}}var valid1: any = _errs2 === errors;var props0: any = true;valid0 = valid1;}else if(tag0 === "string"){const _errs13: any = errors;if(errors === _errs13){if(data && typeof data == "object" && !Array.isArray(data)){let missing1: any;if((((data.type === undefined) && (missing1 = "type")) || ((data.name === undefined) && (missing1 = "name"))) || ((data.default === undefined) && (missing1 = "default"))){validateWorkflowTriggerInput.errors = [{instancePath,schemaPath:"#/oneOf/1/required",keyword:"required",params:{missingProperty: missing1}}];return false;}else {const _errs15: any = errors;for(const key1 in data){if(!((((key1 === "type") || (key1 === "name")) || (key1 === "required")) || (key1 === "default"))){validateWorkflowTriggerInput.errors = [{instancePath,schemaPath:"#/oneOf/1/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key1}}];return false;break;}}if(_errs15 === errors){if(data.type !== undefined){let data4: any = data.type;const _errs16: any = errors;if(typeof data4 !== "string"){validateWorkflowTriggerInput.errors = [{instancePath:instancePath+"/type",schemaPath:"#/oneOf/1/properties/type/type",keyword:"type",params:{type: "string"}}];return false;}if("string" !== data4){validateWorkflowTriggerInput.errors = [{instancePath:instancePath+"/type",schemaPath:"#/oneOf/1/properties/type/const",keyword:"const",params:{allowedValue: "string"}}];return false;}var valid4: any = _errs16 === errors;}else {var valid4: any = true;}if(valid4){if(data.name !== undefined){let data5: any = data.name;const _errs18: any = errors;if(errors === _errs18){if(typeof data5 === "string"){if(func1(data5) < 1){validateWorkflowTriggerInput.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/1/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateWorkflowTriggerInput.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/1/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid4: any = _errs18 === errors;}else {var valid4: any = true;}if(valid4){if(data.required !== undefined){const _errs20: any = errors;if(typeof data.required !== "boolean"){validateWorkflowTriggerInput.errors = [{instancePath:instancePath+"/required",schemaPath:"#/oneOf/1/properties/required/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid4: any = _errs20 === errors;}else {var valid4: any = true;}if(valid4){if(data.default !== undefined){const _errs22: any = errors;if(typeof data.default !== "string"){validateWorkflowTriggerInput.errors = [{instancePath:instancePath+"/default",schemaPath:"#/oneOf/1/properties/default/type",keyword:"type",params:{type: "string"}}];return false;}var valid4: any = _errs22 === errors;}else {var valid4: any = true;}}}}}}}else {validateWorkflowTriggerInput.errors = [{instancePath,schemaPath:"#/oneOf/1/type",keyword:"type",params:{type: "object"}}];return false;}}var valid3: any = _errs13 === errors;if(props0 !== true){props0 = true;}valid0 = valid3;}else if(tag0 === "path"){const _errs24: any = errors;if(errors === _errs24){if(data && typeof data == "object" && !Array.isArray(data)){let missing2: any;if((((data.type === undefined) && (missing2 = "type")) || ((data.name === undefined) && (missing2 = "name"))) || ((data.default === undefined) && (missing2 = "default"))){validateWorkflowTriggerInput.errors = [{instancePath,schemaPath:"#/oneOf/2/required",keyword:"required",params:{missingProperty: missing2}}];return false;}else {const _errs26: any = errors;for(const key2 in data){if(!((((key2 === "type") || (key2 === "name")) || (key2 === "required")) || (key2 === "default"))){validateWorkflowTriggerInput.errors = [{instancePath,schemaPath:"#/oneOf/2/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key2}}];return false;break;}}if(_errs26 === errors){if(data.type !== undefined){let data8: any = data.type;const _errs27: any = errors;if(typeof data8 !== "string"){validateWorkflowTriggerInput.errors = [{instancePath:instancePath+"/type",schemaPath:"#/oneOf/2/properties/type/type",keyword:"type",params:{type: "string"}}];return false;}if("path" !== data8){validateWorkflowTriggerInput.errors = [{instancePath:instancePath+"/type",schemaPath:"#/oneOf/2/properties/type/const",keyword:"const",params:{allowedValue: "path"}}];return false;}var valid6: any = _errs27 === errors;}else {var valid6: any = true;}if(valid6){if(data.name !== undefined){let data9: any = data.name;const _errs29: any = errors;if(errors === _errs29){if(typeof data9 === "string"){if(func1(data9) < 1){validateWorkflowTriggerInput.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/2/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateWorkflowTriggerInput.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/2/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid6: any = _errs29 === errors;}else {var valid6: any = true;}if(valid6){if(data.required !== undefined){const _errs31: any = errors;if(typeof data.required !== "boolean"){validateWorkflowTriggerInput.errors = [{instancePath:instancePath+"/required",schemaPath:"#/oneOf/2/properties/required/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid6: any = _errs31 === errors;}else {var valid6: any = true;}if(valid6){if(data.default !== undefined){let data11: any = data.default;const _errs33: any = errors;if(errors === _errs33){if(typeof data11 === "string"){if(func1(data11) > 4096){validateWorkflowTriggerInput.errors = [{instancePath:instancePath+"/default",schemaPath:"#/oneOf/2/properties/default/maxLength",keyword:"maxLength",params:{limit: 4096}}];return false;}}else {validateWorkflowTriggerInput.errors = [{instancePath:instancePath+"/default",schemaPath:"#/oneOf/2/properties/default/type",keyword:"type",params:{type: "string"}}];return false;}}var valid6: any = _errs33 === errors;}else {var valid6: any = true;}}}}}}}else {validateWorkflowTriggerInput.errors = [{instancePath,schemaPath:"#/oneOf/2/type",keyword:"type",params:{type: "object"}}];return false;}}var valid5: any = _errs24 === errors;if(props0 !== true){props0 = true;}valid0 = valid5;}else if(tag0 === "select"){const _errs35: any = errors;if(errors === _errs35){if(data && typeof data == "object" && !Array.isArray(data)){let missing3: any;if(((((data.type === undefined) && (missing3 = "type")) || ((data.name === undefined) && (missing3 = "name"))) || ((data.options === undefined) && (missing3 = "options"))) || ((data.default === undefined) && (missing3 = "default"))){validateWorkflowTriggerInput.errors = [{instancePath,schemaPath:"#/oneOf/3/required",keyword:"required",params:{missingProperty: missing3}}];return false;}else {const _errs37: any = errors;for(const key3 in data){if(!(((((key3 === "type") || (key3 === "name")) || (key3 === "required")) || (key3 === "options")) || (key3 === "default"))){validateWorkflowTriggerInput.errors = [{instancePath,schemaPath:"#/oneOf/3/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key3}}];return false;break;}}if(_errs37 === errors){if(data.type !== undefined){let data12: any = data.type;const _errs38: any = errors;if(typeof data12 !== "string"){validateWorkflowTriggerInput.errors = [{instancePath:instancePath+"/type",schemaPath:"#/oneOf/3/properties/type/type",keyword:"type",params:{type: "string"}}];return false;}if("select" !== data12){validateWorkflowTriggerInput.errors = [{instancePath:instancePath+"/type",schemaPath:"#/oneOf/3/properties/type/const",keyword:"const",params:{allowedValue: "select"}}];return false;}var valid8: any = _errs38 === errors;}else {var valid8: any = true;}if(valid8){if(data.name !== undefined){let data13: any = data.name;const _errs40: any = errors;if(errors === _errs40){if(typeof data13 === "string"){if(func1(data13) < 1){validateWorkflowTriggerInput.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/3/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateWorkflowTriggerInput.errors = [{instancePath:instancePath+"/name",schemaPath:"#/oneOf/3/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid8: any = _errs40 === errors;}else {var valid8: any = true;}if(valid8){if(data.required !== undefined){const _errs42: any = errors;if(typeof data.required !== "boolean"){validateWorkflowTriggerInput.errors = [{instancePath:instancePath+"/required",schemaPath:"#/oneOf/3/properties/required/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid8: any = _errs42 === errors;}else {var valid8: any = true;}if(valid8){if(data.options !== undefined){let data15: any = data.options;const _errs44: any = errors;if(errors === _errs44){if(Array.isArray(data15)){if(data15.length < 1){validateWorkflowTriggerInput.errors = [{instancePath:instancePath+"/options",schemaPath:"#/oneOf/3/properties/options/minItems",keyword:"minItems",params:{limit: 1}}];return false;}else {var valid9: any = true;const len0: any = data15.length;for(let i0=0; i0<len0; i0++){let data16: any = data15[i0];const _errs46: any = errors;if(errors === _errs46){if(typeof data16 === "string"){if(func1(data16) < 1){validateWorkflowTriggerInput.errors = [{instancePath:instancePath+"/options/" + i0,schemaPath:"#/oneOf/3/properties/options/items/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateWorkflowTriggerInput.errors = [{instancePath:instancePath+"/options/" + i0,schemaPath:"#/oneOf/3/properties/options/items/type",keyword:"type",params:{type: "string"}}];return false;}}var valid9: any = _errs46 === errors;if(!valid9){break;}}if(valid9){const _errs48: any = errors;const len1: any = data15.length;for(let i1=0; i1<len1; i1++){const _errs49: any = errors;const vSchema0: any = data && data.default;if(vSchema0 !== undefined && (!func0(data15[i1], vSchema0))){const err0: any = {instancePath:instancePath+"/options/" + i1,schemaPath:"#/oneOf/3/properties/options/contains/const",keyword:"const",params:{allowedValue: vSchema0}};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var valid10: any = _errs49 === errors;if(valid10){break;}}if(!valid10){validateWorkflowTriggerInput.errors = [{instancePath:instancePath+"/options",schemaPath:"#/oneOf/3/properties/options/contains",keyword:"contains",params:{minContains: 1}}];return false;}else {errors = _errs48;if(vErrors !== null){if(_errs48){vErrors.length = _errs48;}else {vErrors = null;}}}}}}else {validateWorkflowTriggerInput.errors = [{instancePath:instancePath+"/options",schemaPath:"#/oneOf/3/properties/options/type",keyword:"type",params:{type: "array"}}];return false;}}var valid8: any = _errs44 === errors;}else {var valid8: any = true;}if(valid8){if(data.default !== undefined){const _errs50: any = errors;if(typeof data.default !== "string"){validateWorkflowTriggerInput.errors = [{instancePath:instancePath+"/default",schemaPath:"#/oneOf/3/properties/default/type",keyword:"type",params:{type: "string"}}];return false;}var valid8: any = _errs50 === errors;}else {var valid8: any = true;}}}}}}}}else {validateWorkflowTriggerInput.errors = [{instancePath,schemaPath:"#/oneOf/3/type",keyword:"type",params:{type: "object"}}];return false;}}var valid7: any = _errs35 === errors;if(props0 !== true){props0 = true;}valid0 = valid7;}else {validateWorkflowTriggerInput.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "mapping", tag: "type", tagValue: tag0}}];return false;}}else {validateWorkflowTriggerInput.errors = [{instancePath,schemaPath:"#/discriminator",keyword:"discriminator",params:{error: "tag", tag: "type", tagValue: tag0}}];return false;}if(valid0){if(props0 !== true){for(const key4 in data){if(!props0 || !props0[key4]){validateWorkflowTriggerInput.errors = [{instancePath,schemaPath:"#/unevaluatedProperties",keyword:"unevaluatedProperties",params:{unevaluatedProperty: key4}}];return false;break;}}}}}else {validateWorkflowTriggerInput.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowTriggerInput.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowTriggerInput.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1416: any = {"type":"object","additionalProperties":false,"properties":{"id":{"$ref":"#/$defs/WorkflowNodeId","description":"The node's id."},"kind":{"$ref":"#/$defs/WorkflowNodeKindId","description":"The node's kind."},"kindVersion":{"type":"integer","minimum":1,"maximum":9007199254740991,"description":"The kind's version when the node was placed; a whole number from 1."},"name":{"type":"string","minLength":1,"description":"The label a person reads; never used to address the node."},"order":{"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991,"description":"Which sibling branch runs first, lowest first; never the canvas position."},"params":{"type":"object","propertyNames":{"allOf":[{"type":"string"},{"not":{"const":"__proto__"}}]},"additionalProperties":{"tsType":"unknown"},"description":"The node's parameters by the ids its kind lists. A value is a literal, or an expression written ={{ … }}. An agent, project or session parameter holds that record's id and an MCP tool parameter its server binding and tool name, never a nested node. A secret is written secret://shared/<name> or secret://project/<name>, never as an expression, and only in a parameter the kind marks sensitive."},"disabled":{"type":"boolean","description":"Whether the node is switched off."},"notes":{"type":"string","description":"The author's notes."},"onError":{"$ref":"#/$defs/WorkflowNodeOnError","description":"What the node's failure does."},"retry":{"$ref":"#/$defs/WorkflowNodeRetry","description":"Retries on failure: maxTries from 1, waitMs from 0; the engine clamps both."},"executeOnce":{"type":"boolean","description":"Whether the node runs once, over its first item only."},"alwaysOutputData":{"type":"boolean","description":"Whether the node outputs one empty item where it would output none."},"inputs":{"type":"array","items":{"$ref":"#/$defs/WorkflowTriggerInput"},"description":"The inputs a run starts with, each with a name no other input uses and a type (boolean, string, path, or select with its options) with the value it starts on as default; required marks one a start must fill."}},"required":["id","kind","kindVersion","name","order","params"],"description":"The trigger node: a node that may also declare the inputs a run of the workflow starts\nwith, each name used once."};
/** Checks that a value is a {@link WorkflowTriggerNode}. */
// prettier-ignore
export const validateWorkflowTriggerNode: CompiledSchemaCheck<WorkflowTriggerNode> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowTriggerNode {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowTriggerNode.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((((data.id === undefined) && (missing0 = "id")) || ((data.kind === undefined) && (missing0 = "kind"))) || ((data.kindVersion === undefined) && (missing0 = "kindVersion"))) || ((data.name === undefined) && (missing0 = "name"))) || ((data.order === undefined) && (missing0 = "order"))) || ((data.params === undefined) && (missing0 = "params"))){validateWorkflowTriggerNode.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(func2.call(schema1416.properties, key0))){validateWorkflowTriggerNode.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.id !== undefined){const _errs2: any = errors;if(!(validateWorkflowNodeId.call(this, data.id, {instancePath:instancePath+"/id",parentData:data,parentDataProperty:"id",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowNodeId.errors : vErrors.concat(validateWorkflowNodeId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.kind !== undefined){const _errs3: any = errors;if(!(validateWorkflowNodeKindId.call(this, data.kind, {instancePath:instancePath+"/kind",parentData:data,parentDataProperty:"kind",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowNodeKindId.errors : vErrors.concat(validateWorkflowNodeKindId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.kindVersion !== undefined){let data2: any = data.kindVersion;const _errs4: any = errors;if(!(((typeof data2 == "number") && (!(data2 % 1) && !isNaN(data2))) && (isFinite(data2)))){validateWorkflowTriggerNode.errors = [{instancePath:instancePath+"/kindVersion",schemaPath:"#/properties/kindVersion/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs4){if((typeof data2 == "number") && (isFinite(data2))){if(data2 > 9007199254740991 || isNaN(data2)){validateWorkflowTriggerNode.errors = [{instancePath:instancePath+"/kindVersion",schemaPath:"#/properties/kindVersion/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data2 < 1 || isNaN(data2)){validateWorkflowTriggerNode.errors = [{instancePath:instancePath+"/kindVersion",schemaPath:"#/properties/kindVersion/minimum",keyword:"minimum",params:{comparison: ">=", limit: 1}}];return false;}}}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.name !== undefined){let data3: any = data.name;const _errs6: any = errors;if(errors === _errs6){if(typeof data3 === "string"){if(func1(data3) < 1){validateWorkflowTriggerNode.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateWorkflowTriggerNode.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.order !== undefined){let data4: any = data.order;const _errs8: any = errors;if(!(((typeof data4 == "number") && (!(data4 % 1) && !isNaN(data4))) && (isFinite(data4)))){validateWorkflowTriggerNode.errors = [{instancePath:instancePath+"/order",schemaPath:"#/properties/order/type",keyword:"type",params:{type: "integer"}}];return false;}if(errors === _errs8){if((typeof data4 == "number") && (isFinite(data4))){if(data4 > 9007199254740991 || isNaN(data4)){validateWorkflowTriggerNode.errors = [{instancePath:instancePath+"/order",schemaPath:"#/properties/order/maximum",keyword:"maximum",params:{comparison: "<=", limit: 9007199254740991}}];return false;}else {if(data4 < -9007199254740991 || isNaN(data4)){validateWorkflowTriggerNode.errors = [{instancePath:instancePath+"/order",schemaPath:"#/properties/order/minimum",keyword:"minimum",params:{comparison: ">=", limit: -9007199254740991}}];return false;}}}}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.params !== undefined){let data5: any = data.params;const _errs10: any = errors;if(errors === _errs10){if(data5 && typeof data5 == "object" && !Array.isArray(data5)){for(const key1 in data5){const _errs12: any = errors;const _errs13: any = errors;if(typeof key1 !== "string"){const err0: any = {instancePath:instancePath+"/params",schemaPath:"#/properties/params/propertyNames/allOf/0/type",keyword:"type",params:{type: "string"},propertyName:key1};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var valid2: any = _errs13 === errors;if(valid2){const _errs15: any = errors;const _errs16: any = errors;const _errs17: any = errors;if("__proto__" !== key1){const err1: any = {};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}var valid3: any = _errs17 === errors;if(valid3){const err2: any = {instancePath:instancePath+"/params",schemaPath:"#/properties/params/propertyNames/allOf/1/not",keyword:"not",params:{},propertyName:key1};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}else {errors = _errs16;if(vErrors !== null){if(_errs16){vErrors.length = _errs16;}else {vErrors = null;}}}var valid2: any = _errs15 === errors;}var valid1: any = _errs12 === errors;if(!valid1){const err3: any = {instancePath:instancePath+"/params",schemaPath:"#/properties/params/propertyNames",keyword:"propertyNames",params:{propertyName: key1}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;validateWorkflowTriggerNode.errors = vErrors;return false;break;}}if(valid1){for(const key2 in data5){const _errs19: any = errors;var valid4: any = _errs19 === errors;if(!valid4){break;}}}}else {validateWorkflowTriggerNode.errors = [{instancePath:instancePath+"/params",schemaPath:"#/properties/params/type",keyword:"type",params:{type: "object"}}];return false;}}var valid0: any = _errs10 === errors;}else {var valid0: any = true;}if(valid0){if(data.disabled !== undefined){const _errs21: any = errors;if(typeof data.disabled !== "boolean"){validateWorkflowTriggerNode.errors = [{instancePath:instancePath+"/disabled",schemaPath:"#/properties/disabled/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs21 === errors;}else {var valid0: any = true;}if(valid0){if(data.notes !== undefined){const _errs23: any = errors;if(typeof data.notes !== "string"){validateWorkflowTriggerNode.errors = [{instancePath:instancePath+"/notes",schemaPath:"#/properties/notes/type",keyword:"type",params:{type: "string"}}];return false;}var valid0: any = _errs23 === errors;}else {var valid0: any = true;}if(valid0){if(data.onError !== undefined){const _errs25: any = errors;if(!(validateWorkflowNodeOnError.call(this, data.onError, {instancePath:instancePath+"/onError",parentData:data,parentDataProperty:"onError",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowNodeOnError.errors : vErrors.concat(validateWorkflowNodeOnError.errors);errors = vErrors.length;}var valid0: any = _errs25 === errors;}else {var valid0: any = true;}if(valid0){if(data.retry !== undefined){const _errs26: any = errors;if(!(validateWorkflowNodeRetry.call(this, data.retry, {instancePath:instancePath+"/retry",parentData:data,parentDataProperty:"retry",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowNodeRetry.errors : vErrors.concat(validateWorkflowNodeRetry.errors);errors = vErrors.length;}var valid0: any = _errs26 === errors;}else {var valid0: any = true;}if(valid0){if(data.executeOnce !== undefined){const _errs27: any = errors;if(typeof data.executeOnce !== "boolean"){validateWorkflowTriggerNode.errors = [{instancePath:instancePath+"/executeOnce",schemaPath:"#/properties/executeOnce/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs27 === errors;}else {var valid0: any = true;}if(valid0){if(data.alwaysOutputData !== undefined){const _errs29: any = errors;if(typeof data.alwaysOutputData !== "boolean"){validateWorkflowTriggerNode.errors = [{instancePath:instancePath+"/alwaysOutputData",schemaPath:"#/properties/alwaysOutputData/type",keyword:"type",params:{type: "boolean"}}];return false;}var valid0: any = _errs29 === errors;}else {var valid0: any = true;}if(valid0){if(data.inputs !== undefined){let data13: any = data.inputs;const _errs31: any = errors;if(errors === _errs31){if(Array.isArray(data13)){var valid5: any = true;const len0: any = data13.length;for(let i0=0; i0<len0; i0++){const _errs33: any = errors;if(!(validateWorkflowTriggerInput.call(this, data13[i0], {instancePath:instancePath+"/inputs/" + i0,parentData:data13,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowTriggerInput.errors : vErrors.concat(validateWorkflowTriggerInput.errors);errors = vErrors.length;}var valid5: any = _errs33 === errors;if(!valid5){break;}}}else {validateWorkflowTriggerNode.errors = [{instancePath:instancePath+"/inputs",schemaPath:"#/properties/inputs/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs31 === errors;}else {var valid0: any = true;}}}}}}}}}}}}}}}}else {validateWorkflowTriggerNode.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowTriggerNode.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowTriggerNode.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowEdge}. */
// prettier-ignore
export const validateWorkflowEdge: CompiledSchemaCheck<WorkflowEdge> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowEdge {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowEdge.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((data.id === undefined) && (missing0 = "id")) || ((data.source === undefined) && (missing0 = "source"))) || ((data.sourceHandle === undefined) && (missing0 = "sourceHandle"))) || ((data.target === undefined) && (missing0 = "target"))) || ((data.targetHandle === undefined) && (missing0 = "targetHandle"))){validateWorkflowEdge.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((((key0 === "id") || (key0 === "source")) || (key0 === "sourceHandle")) || (key0 === "target")) || (key0 === "targetHandle"))){validateWorkflowEdge.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.id !== undefined){const _errs2: any = errors;if(!(validateWorkflowEdgeId.call(this, data.id, {instancePath:instancePath+"/id",parentData:data,parentDataProperty:"id",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowEdgeId.errors : vErrors.concat(validateWorkflowEdgeId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.source !== undefined){const _errs3: any = errors;if(!(validateWorkflowNodeId.call(this, data.source, {instancePath:instancePath+"/source",parentData:data,parentDataProperty:"source",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowNodeId.errors : vErrors.concat(validateWorkflowNodeId.errors);errors = vErrors.length;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.sourceHandle !== undefined){let data2: any = data.sourceHandle;const _errs4: any = errors;if(errors === _errs4){if(typeof data2 === "string"){if(func1(data2) < 1){validateWorkflowEdge.errors = [{instancePath:instancePath+"/sourceHandle",schemaPath:"#/properties/sourceHandle/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateWorkflowEdge.errors = [{instancePath:instancePath+"/sourceHandle",schemaPath:"#/properties/sourceHandle/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.target !== undefined){const _errs6: any = errors;if(!(validateWorkflowNodeId.call(this, data.target, {instancePath:instancePath+"/target",parentData:data,parentDataProperty:"target",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowNodeId.errors : vErrors.concat(validateWorkflowNodeId.errors);errors = vErrors.length;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.targetHandle !== undefined){let data4: any = data.targetHandle;const _errs7: any = errors;if(errors === _errs7){if(typeof data4 === "string"){if(func1(data4) < 1){validateWorkflowEdge.errors = [{instancePath:instancePath+"/targetHandle",schemaPath:"#/properties/targetHandle/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateWorkflowEdge.errors = [{instancePath:instancePath+"/targetHandle",schemaPath:"#/properties/targetHandle/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}}}}}}}}else {validateWorkflowEdge.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowEdge.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowEdge.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowCanvasPoint}. */
// prettier-ignore
export const validateWorkflowCanvasPoint: CompiledSchemaCheck<WorkflowCanvasPoint> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowCanvasPoint {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowCanvasPoint.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.x === undefined) && (missing0 = "x")) || ((data.y === undefined) && (missing0 = "y"))){validateWorkflowCanvasPoint.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "x") || (key0 === "y"))){validateWorkflowCanvasPoint.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.x !== undefined){let data0: any = data.x;const _errs2: any = errors;if(!((typeof data0 == "number") && (isFinite(data0)))){validateWorkflowCanvasPoint.errors = [{instancePath:instancePath+"/x",schemaPath:"#/properties/x/type",keyword:"type",params:{type: "number"}}];return false;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.y !== undefined){let data1: any = data.y;const _errs4: any = errors;if(!((typeof data1 == "number") && (isFinite(data1)))){validateWorkflowCanvasPoint.errors = [{instancePath:instancePath+"/y",schemaPath:"#/properties/y/type",keyword:"type",params:{type: "number"}}];return false;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}}}}}else {validateWorkflowCanvasPoint.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowCanvasPoint.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowCanvasPoint.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowViewport}. */
// prettier-ignore
export const validateWorkflowViewport: CompiledSchemaCheck<WorkflowViewport> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowViewport {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowViewport.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((data.x === undefined) && (missing0 = "x")) || ((data.y === undefined) && (missing0 = "y"))) || ((data.zoom === undefined) && (missing0 = "zoom"))){validateWorkflowViewport.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "x") || (key0 === "y")) || (key0 === "zoom"))){validateWorkflowViewport.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.x !== undefined){let data0: any = data.x;const _errs2: any = errors;if(!((typeof data0 == "number") && (isFinite(data0)))){validateWorkflowViewport.errors = [{instancePath:instancePath+"/x",schemaPath:"#/properties/x/type",keyword:"type",params:{type: "number"}}];return false;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.y !== undefined){let data1: any = data.y;const _errs4: any = errors;if(!((typeof data1 == "number") && (isFinite(data1)))){validateWorkflowViewport.errors = [{instancePath:instancePath+"/y",schemaPath:"#/properties/y/type",keyword:"type",params:{type: "number"}}];return false;}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.zoom !== undefined){let data2: any = data.zoom;const _errs6: any = errors;if(errors === _errs6){if((typeof data2 == "number") && (isFinite(data2))){if(data2 <= 0 || isNaN(data2)){validateWorkflowViewport.errors = [{instancePath:instancePath+"/zoom",schemaPath:"#/properties/zoom/exclusiveMinimum",keyword:"exclusiveMinimum",params:{comparison: ">", limit: 0}}];return false;}}else {validateWorkflowViewport.errors = [{instancePath:instancePath+"/zoom",schemaPath:"#/properties/zoom/type",keyword:"type",params:{type: "number"}}];return false;}}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}}}}}}else {validateWorkflowViewport.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowViewport.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowViewport.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowStickyNote}. */
// prettier-ignore
export const validateWorkflowStickyNote: CompiledSchemaCheck<WorkflowStickyNote> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowStickyNote {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowStickyNote.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((((data.id === undefined) && (missing0 = "id")) || ((data.text === undefined) && (missing0 = "text"))) || ((data.x === undefined) && (missing0 = "x"))) || ((data.y === undefined) && (missing0 = "y"))) || ((data.width === undefined) && (missing0 = "width"))) || ((data.height === undefined) && (missing0 = "height"))){validateWorkflowStickyNote.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((((((key0 === "id") || (key0 === "text")) || (key0 === "x")) || (key0 === "y")) || (key0 === "width")) || (key0 === "height"))){validateWorkflowStickyNote.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.id !== undefined){const _errs2: any = errors;if(!(validateWorkflowStickyNoteId.call(this, data.id, {instancePath:instancePath+"/id",parentData:data,parentDataProperty:"id",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowStickyNoteId.errors : vErrors.concat(validateWorkflowStickyNoteId.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.text !== undefined){const _errs3: any = errors;if(typeof data.text !== "string"){validateWorkflowStickyNote.errors = [{instancePath:instancePath+"/text",schemaPath:"#/properties/text/type",keyword:"type",params:{type: "string"}}];return false;}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}if(valid0){if(data.x !== undefined){let data2: any = data.x;const _errs5: any = errors;if(!((typeof data2 == "number") && (isFinite(data2)))){validateWorkflowStickyNote.errors = [{instancePath:instancePath+"/x",schemaPath:"#/properties/x/type",keyword:"type",params:{type: "number"}}];return false;}var valid0: any = _errs5 === errors;}else {var valid0: any = true;}if(valid0){if(data.y !== undefined){let data3: any = data.y;const _errs7: any = errors;if(!((typeof data3 == "number") && (isFinite(data3)))){validateWorkflowStickyNote.errors = [{instancePath:instancePath+"/y",schemaPath:"#/properties/y/type",keyword:"type",params:{type: "number"}}];return false;}var valid0: any = _errs7 === errors;}else {var valid0: any = true;}if(valid0){if(data.width !== undefined){let data4: any = data.width;const _errs9: any = errors;if(errors === _errs9){if((typeof data4 == "number") && (isFinite(data4))){if(data4 <= 0 || isNaN(data4)){validateWorkflowStickyNote.errors = [{instancePath:instancePath+"/width",schemaPath:"#/properties/width/exclusiveMinimum",keyword:"exclusiveMinimum",params:{comparison: ">", limit: 0}}];return false;}}else {validateWorkflowStickyNote.errors = [{instancePath:instancePath+"/width",schemaPath:"#/properties/width/type",keyword:"type",params:{type: "number"}}];return false;}}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}if(valid0){if(data.height !== undefined){let data5: any = data.height;const _errs11: any = errors;if(errors === _errs11){if((typeof data5 == "number") && (isFinite(data5))){if(data5 <= 0 || isNaN(data5)){validateWorkflowStickyNote.errors = [{instancePath:instancePath+"/height",schemaPath:"#/properties/height/exclusiveMinimum",keyword:"exclusiveMinimum",params:{comparison: ">", limit: 0}}];return false;}}else {validateWorkflowStickyNote.errors = [{instancePath:instancePath+"/height",schemaPath:"#/properties/height/type",keyword:"type",params:{type: "number"}}];return false;}}var valid0: any = _errs11 === errors;}else {var valid0: any = true;}}}}}}}}}else {validateWorkflowStickyNote.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowStickyNote.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowStickyNote.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowLayout}. */
// prettier-ignore
export const validateWorkflowLayout: CompiledSchemaCheck<WorkflowLayout> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowLayout {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowLayout.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((data.nodes === undefined) && (missing0 = "nodes")){validateWorkflowLayout.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(((key0 === "nodes") || (key0 === "viewport")) || (key0 === "notes"))){validateWorkflowLayout.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.nodes !== undefined){let data0: any = data.nodes;const _errs2: any = errors;if(errors === _errs2){if(data0 && typeof data0 == "object" && !Array.isArray(data0)){for(const key1 in data0){const _errs4: any = errors;const _errs5: any = errors;if(typeof key1 !== "string"){const err0: any = {instancePath:instancePath+"/nodes",schemaPath:"#/properties/nodes/propertyNames/allOf/0/type",keyword:"type",params:{type: "string"},propertyName:key1};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var valid2: any = _errs5 === errors;if(valid2){const _errs7: any = errors;const _errs8: any = errors;const _errs9: any = errors;if("__proto__" !== key1){const err1: any = {};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}var valid3: any = _errs9 === errors;if(valid3){const err2: any = {instancePath:instancePath+"/nodes",schemaPath:"#/properties/nodes/propertyNames/allOf/1/not",keyword:"not",params:{},propertyName:key1};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}else {errors = _errs8;if(vErrors !== null){if(_errs8){vErrors.length = _errs8;}else {vErrors = null;}}}var valid2: any = _errs7 === errors;}var valid1: any = _errs4 === errors;if(!valid1){const err3: any = {instancePath:instancePath+"/nodes",schemaPath:"#/properties/nodes/propertyNames",keyword:"propertyNames",params:{propertyName: key1}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;validateWorkflowLayout.errors = vErrors;return false;break;}}if(valid1){for(const key2 in data0){const _errs11: any = errors;if(!(validateWorkflowCanvasPoint.call(this, data0[key2], {instancePath:instancePath+"/nodes/" + key2.replace(/~/g, "~0").replace(/\//g, "~1"),parentData:data0,parentDataProperty:key2,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowCanvasPoint.errors : vErrors.concat(validateWorkflowCanvasPoint.errors);errors = vErrors.length;}var valid4: any = _errs11 === errors;if(!valid4){break;}}}}else {validateWorkflowLayout.errors = [{instancePath:instancePath+"/nodes",schemaPath:"#/properties/nodes/type",keyword:"type",params:{type: "object"}}];return false;}}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.viewport !== undefined){const _errs12: any = errors;if(!(validateWorkflowViewport.call(this, data.viewport, {instancePath:instancePath+"/viewport",parentData:data,parentDataProperty:"viewport",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowViewport.errors : vErrors.concat(validateWorkflowViewport.errors);errors = vErrors.length;}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}if(valid0){if(data.notes !== undefined){let data3: any = data.notes;const _errs13: any = errors;if(errors === _errs13){if(Array.isArray(data3)){var valid5: any = true;const len0: any = data3.length;for(let i0=0; i0<len0; i0++){const _errs15: any = errors;if(!(validateWorkflowStickyNote.call(this, data3[i0], {instancePath:instancePath+"/notes/" + i0,parentData:data3,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowStickyNote.errors : vErrors.concat(validateWorkflowStickyNote.errors);errors = vErrors.length;}var valid5: any = _errs15 === errors;if(!valid5){break;}}}else {validateWorkflowLayout.errors = [{instancePath:instancePath+"/notes",schemaPath:"#/properties/notes/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs13 === errors;}else {var valid0: any = true;}}}}}}else {validateWorkflowLayout.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowLayout.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowLayout.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1453: any = {"type":"object","additionalProperties":false,"properties":{"schemaVersion":{"description":"The document schema version; always \"2\".","type":"string","enum":["2"]},"name":{"type":"string","minLength":1,"maxLength":256,"description":"The workflow's name: 1 to 256 characters."},"description":{"type":"string","description":"The workflow's description."},"trigger":{"$ref":"#/$defs/WorkflowTriggerNode","description":"The one trigger node; its kind is in the trigger category, such as trigger.manual. Only the trigger declares inputs."},"nodes":{"type":"array","items":{"$ref":"#/$defs/WorkflowNode"},"description":"Every node except the trigger. Node ids are unique across the document, the trigger's included."},"edges":{"type":"array","items":{"$ref":"#/$defs/WorkflowEdge"},"description":"The connections. main carries items and tool carries a capability; nothing connects into the trigger, and nothing but a loop closes a cycle."},"layout":{"$ref":"#/$defs/WorkflowLayout","description":"Canvas positions; outside the content hash. Omit it and the daemon lays the graph out."},"pinData":{"type":"object","propertyNames":{"allOf":[{"type":"string"},{"not":{"const":"__proto__"}}]},"additionalProperties":{"type":"array","items":{"$ref":"sidekicks-contracts:workflow/definition/item#/$defs/WorkflowPinnedItem"}},"description":"Test data pinned onto nodes by node id; outside the content hash."},"tags":{"$ref":"sidekicks-contracts:tag#/$defs/TagList","description":"The workflow's tags, nested with / and held once ignoring case, each never empty, with no whitespace and no empty level around a /; outside the content hash."}},"required":["schemaVersion","name","trigger","nodes","edges"],"description":"A workflow document: exactly one trigger node, the other nodes, and the edges between\nthem, plus the layout, pinned data and tags outside the hash. What a failure does is set\non the node that failed, never in a document-wide block."};
/** Checks that a value is a {@link WorkflowDocument}. */
// prettier-ignore
export const validateWorkflowDocument: CompiledSchemaCheck<WorkflowDocument> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowDocument {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowDocument.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if((((((data.schemaVersion === undefined) && (missing0 = "schemaVersion")) || ((data.name === undefined) && (missing0 = "name"))) || ((data.trigger === undefined) && (missing0 = "trigger"))) || ((data.nodes === undefined) && (missing0 = "nodes"))) || ((data.edges === undefined) && (missing0 = "edges"))){validateWorkflowDocument.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(func2.call(schema1453.properties, key0))){validateWorkflowDocument.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.schemaVersion !== undefined){let data0: any = data.schemaVersion;const _errs2: any = errors;if(typeof data0 !== "string"){validateWorkflowDocument.errors = [{instancePath:instancePath+"/schemaVersion",schemaPath:"#/properties/schemaVersion/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data0 === "2")){validateWorkflowDocument.errors = [{instancePath:instancePath+"/schemaVersion",schemaPath:"#/properties/schemaVersion/enum",keyword:"enum",params:{allowedValues: schema1453.properties.schemaVersion.enum}}];return false;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.name !== undefined){let data1: any = data.name;const _errs4: any = errors;if(errors === _errs4){if(typeof data1 === "string"){if(func1(data1) > 256){validateWorkflowDocument.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data1) < 1){validateWorkflowDocument.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validateWorkflowDocument.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.description !== undefined){const _errs6: any = errors;if(typeof data.description !== "string"){validateWorkflowDocument.errors = [{instancePath:instancePath+"/description",schemaPath:"#/properties/description/type",keyword:"type",params:{type: "string"}}];return false;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.trigger !== undefined){const _errs8: any = errors;if(!(validateWorkflowTriggerNode.call(this, data.trigger, {instancePath:instancePath+"/trigger",parentData:data,parentDataProperty:"trigger",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowTriggerNode.errors : vErrors.concat(validateWorkflowTriggerNode.errors);errors = vErrors.length;}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.nodes !== undefined){let data4: any = data.nodes;const _errs9: any = errors;if(errors === _errs9){if(Array.isArray(data4)){var valid1: any = true;const len0: any = data4.length;for(let i0=0; i0<len0; i0++){const _errs11: any = errors;if(!(validateWorkflowNode.call(this, data4[i0], {instancePath:instancePath+"/nodes/" + i0,parentData:data4,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowNode.errors : vErrors.concat(validateWorkflowNode.errors);errors = vErrors.length;}var valid1: any = _errs11 === errors;if(!valid1){break;}}}else {validateWorkflowDocument.errors = [{instancePath:instancePath+"/nodes",schemaPath:"#/properties/nodes/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}if(valid0){if(data.edges !== undefined){let data6: any = data.edges;const _errs12: any = errors;if(errors === _errs12){if(Array.isArray(data6)){var valid2: any = true;const len1: any = data6.length;for(let i1=0; i1<len1; i1++){const _errs14: any = errors;if(!(validateWorkflowEdge.call(this, data6[i1], {instancePath:instancePath+"/edges/" + i1,parentData:data6,parentDataProperty:i1,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowEdge.errors : vErrors.concat(validateWorkflowEdge.errors);errors = vErrors.length;}var valid2: any = _errs14 === errors;if(!valid2){break;}}}else {validateWorkflowDocument.errors = [{instancePath:instancePath+"/edges",schemaPath:"#/properties/edges/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}if(valid0){if(data.layout !== undefined){const _errs15: any = errors;if(!(validateWorkflowLayout.call(this, data.layout, {instancePath:instancePath+"/layout",parentData:data,parentDataProperty:"layout",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowLayout.errors : vErrors.concat(validateWorkflowLayout.errors);errors = vErrors.length;}var valid0: any = _errs15 === errors;}else {var valid0: any = true;}if(valid0){if(data.pinData !== undefined){let data9: any = data.pinData;const _errs16: any = errors;if(errors === _errs16){if(data9 && typeof data9 == "object" && !Array.isArray(data9)){for(const key1 in data9){const _errs18: any = errors;const _errs19: any = errors;if(typeof key1 !== "string"){const err0: any = {instancePath:instancePath+"/pinData",schemaPath:"#/properties/pinData/propertyNames/allOf/0/type",keyword:"type",params:{type: "string"},propertyName:key1};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var valid4: any = _errs19 === errors;if(valid4){const _errs21: any = errors;const _errs22: any = errors;const _errs23: any = errors;if("__proto__" !== key1){const err1: any = {};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}var valid5: any = _errs23 === errors;if(valid5){const err2: any = {instancePath:instancePath+"/pinData",schemaPath:"#/properties/pinData/propertyNames/allOf/1/not",keyword:"not",params:{},propertyName:key1};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}else {errors = _errs22;if(vErrors !== null){if(_errs22){vErrors.length = _errs22;}else {vErrors = null;}}}var valid4: any = _errs21 === errors;}var valid3: any = _errs18 === errors;if(!valid3){const err3: any = {instancePath:instancePath+"/pinData",schemaPath:"#/properties/pinData/propertyNames",keyword:"propertyNames",params:{propertyName: key1}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;validateWorkflowDocument.errors = vErrors;return false;break;}}if(valid3){for(const key2 in data9){let data10: any = data9[key2];const _errs25: any = errors;if(errors === _errs25){if(Array.isArray(data10)){var valid7: any = true;const len2: any = data10.length;for(let i2=0; i2<len2; i2++){const _errs27: any = errors;if(!(validateWorkflowPinnedItem.call(this, data10[i2], {instancePath:instancePath+"/pinData/" + key2.replace(/~/g, "~0").replace(/\//g, "~1")+"/" + i2,parentData:data10,parentDataProperty:i2,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowPinnedItem.errors : vErrors.concat(validateWorkflowPinnedItem.errors);errors = vErrors.length;}var valid7: any = _errs27 === errors;if(!valid7){break;}}}else {validateWorkflowDocument.errors = [{instancePath:instancePath+"/pinData/" + key2.replace(/~/g, "~0").replace(/\//g, "~1"),schemaPath:"#/properties/pinData/additionalProperties/type",keyword:"type",params:{type: "array"}}];return false;}}var valid6: any = _errs25 === errors;if(!valid6){break;}}}}else {validateWorkflowDocument.errors = [{instancePath:instancePath+"/pinData",schemaPath:"#/properties/pinData/type",keyword:"type",params:{type: "object"}}];return false;}}var valid0: any = _errs16 === errors;}else {var valid0: any = true;}if(valid0){if(data.tags !== undefined){const _errs28: any = errors;if(!(validateTagList.call(this, data.tags, {instancePath:instancePath+"/tags",parentData:data,parentDataProperty:"tags",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTagList.errors : vErrors.concat(validateTagList.errors);errors = vErrors.length;}var valid0: any = _errs28 === errors;}else {var valid0: any = true;}}}}}}}}}}}}else {validateWorkflowDocument.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowDocument.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowDocument.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
// prettier-ignore
const schema1415: any = {"type":"object","additionalProperties":false,"properties":{"schemaVersion":{"description":"The document schema version; always \"2\".","type":"string","enum":["2"]},"name":{"type":"string","minLength":1,"maxLength":256,"description":"The workflow's name: 1 to 256 characters."},"description":{"type":"string","description":"The workflow's description."},"trigger":{"$ref":"#/$defs/WorkflowTriggerNode","description":"The one trigger node; its kind is in the trigger category, such as trigger.manual. Only the trigger declares inputs."},"nodes":{"type":"array","items":{"$ref":"#/$defs/WorkflowNode"},"description":"Every node except the trigger. Node ids are unique across the document, the trigger's included."},"edges":{"type":"array","items":{"$ref":"#/$defs/WorkflowEdge"},"description":"The connections. main carries items and tool carries a capability; nothing connects into the trigger, and nothing but a loop closes a cycle."},"layout":{"$ref":"#/$defs/WorkflowLayout","description":"Canvas positions; outside the content hash. Omit it and the daemon lays the graph out."},"pinData":{"type":"object","propertyNames":{"allOf":[{"type":"string"},{"not":{"const":"__proto__"}}]},"additionalProperties":{"type":"array","items":{"$ref":"sidekicks-contracts:workflow/definition/item#/$defs/WorkflowPinnedItem"}},"description":"Test data pinned onto nodes by node id; outside the content hash."},"tags":{"$ref":"sidekicks-contracts:tag#/$defs/TagList","description":"The workflow's tags, nested with / and held once ignoring case, each never empty, with no whitespace and no empty level around a /; outside the content hash."}},"required":["schemaVersion","name","nodes","edges"],"description":"The builder's unsaved document. It may not have its trigger yet: the builder opens on the\ntrigger picker, and a draft saved before one is placed still survives a reload."};
/** Checks that a value is a {@link WorkflowDraftDocument}. */
// prettier-ignore
export const validateWorkflowDraftDocument: CompiledSchemaCheck<WorkflowDraftDocument> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowDraftDocument {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowDraftDocument.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((((data.schemaVersion === undefined) && (missing0 = "schemaVersion")) || ((data.name === undefined) && (missing0 = "name"))) || ((data.nodes === undefined) && (missing0 = "nodes"))) || ((data.edges === undefined) && (missing0 = "edges"))){validateWorkflowDraftDocument.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!(func2.call(schema1415.properties, key0))){validateWorkflowDraftDocument.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.schemaVersion !== undefined){let data0: any = data.schemaVersion;const _errs2: any = errors;if(typeof data0 !== "string"){validateWorkflowDraftDocument.errors = [{instancePath:instancePath+"/schemaVersion",schemaPath:"#/properties/schemaVersion/type",keyword:"type",params:{type: "string"}}];return false;}if(!(data0 === "2")){validateWorkflowDraftDocument.errors = [{instancePath:instancePath+"/schemaVersion",schemaPath:"#/properties/schemaVersion/enum",keyword:"enum",params:{allowedValues: schema1415.properties.schemaVersion.enum}}];return false;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.name !== undefined){let data1: any = data.name;const _errs4: any = errors;if(errors === _errs4){if(typeof data1 === "string"){if(func1(data1) > 256){validateWorkflowDraftDocument.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/maxLength",keyword:"maxLength",params:{limit: 256}}];return false;}else {if(func1(data1) < 1){validateWorkflowDraftDocument.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}}else {validateWorkflowDraftDocument.errors = [{instancePath:instancePath+"/name",schemaPath:"#/properties/name/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs4 === errors;}else {var valid0: any = true;}if(valid0){if(data.description !== undefined){const _errs6: any = errors;if(typeof data.description !== "string"){validateWorkflowDraftDocument.errors = [{instancePath:instancePath+"/description",schemaPath:"#/properties/description/type",keyword:"type",params:{type: "string"}}];return false;}var valid0: any = _errs6 === errors;}else {var valid0: any = true;}if(valid0){if(data.trigger !== undefined){const _errs8: any = errors;if(!(validateWorkflowTriggerNode.call(this, data.trigger, {instancePath:instancePath+"/trigger",parentData:data,parentDataProperty:"trigger",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowTriggerNode.errors : vErrors.concat(validateWorkflowTriggerNode.errors);errors = vErrors.length;}var valid0: any = _errs8 === errors;}else {var valid0: any = true;}if(valid0){if(data.nodes !== undefined){let data4: any = data.nodes;const _errs9: any = errors;if(errors === _errs9){if(Array.isArray(data4)){var valid1: any = true;const len0: any = data4.length;for(let i0=0; i0<len0; i0++){const _errs11: any = errors;if(!(validateWorkflowNode.call(this, data4[i0], {instancePath:instancePath+"/nodes/" + i0,parentData:data4,parentDataProperty:i0,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowNode.errors : vErrors.concat(validateWorkflowNode.errors);errors = vErrors.length;}var valid1: any = _errs11 === errors;if(!valid1){break;}}}else {validateWorkflowDraftDocument.errors = [{instancePath:instancePath+"/nodes",schemaPath:"#/properties/nodes/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs9 === errors;}else {var valid0: any = true;}if(valid0){if(data.edges !== undefined){let data6: any = data.edges;const _errs12: any = errors;if(errors === _errs12){if(Array.isArray(data6)){var valid2: any = true;const len1: any = data6.length;for(let i1=0; i1<len1; i1++){const _errs14: any = errors;if(!(validateWorkflowEdge.call(this, data6[i1], {instancePath:instancePath+"/edges/" + i1,parentData:data6,parentDataProperty:i1,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowEdge.errors : vErrors.concat(validateWorkflowEdge.errors);errors = vErrors.length;}var valid2: any = _errs14 === errors;if(!valid2){break;}}}else {validateWorkflowDraftDocument.errors = [{instancePath:instancePath+"/edges",schemaPath:"#/properties/edges/type",keyword:"type",params:{type: "array"}}];return false;}}var valid0: any = _errs12 === errors;}else {var valid0: any = true;}if(valid0){if(data.layout !== undefined){const _errs15: any = errors;if(!(validateWorkflowLayout.call(this, data.layout, {instancePath:instancePath+"/layout",parentData:data,parentDataProperty:"layout",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowLayout.errors : vErrors.concat(validateWorkflowLayout.errors);errors = vErrors.length;}var valid0: any = _errs15 === errors;}else {var valid0: any = true;}if(valid0){if(data.pinData !== undefined){let data9: any = data.pinData;const _errs16: any = errors;if(errors === _errs16){if(data9 && typeof data9 == "object" && !Array.isArray(data9)){for(const key1 in data9){const _errs18: any = errors;const _errs19: any = errors;if(typeof key1 !== "string"){const err0: any = {instancePath:instancePath+"/pinData",schemaPath:"#/properties/pinData/propertyNames/allOf/0/type",keyword:"type",params:{type: "string"},propertyName:key1};if(vErrors === null){vErrors = [err0];}else {vErrors.push(err0);}errors++;}var valid4: any = _errs19 === errors;if(valid4){const _errs21: any = errors;const _errs22: any = errors;const _errs23: any = errors;if("__proto__" !== key1){const err1: any = {};if(vErrors === null){vErrors = [err1];}else {vErrors.push(err1);}errors++;}var valid5: any = _errs23 === errors;if(valid5){const err2: any = {instancePath:instancePath+"/pinData",schemaPath:"#/properties/pinData/propertyNames/allOf/1/not",keyword:"not",params:{},propertyName:key1};if(vErrors === null){vErrors = [err2];}else {vErrors.push(err2);}errors++;}else {errors = _errs22;if(vErrors !== null){if(_errs22){vErrors.length = _errs22;}else {vErrors = null;}}}var valid4: any = _errs21 === errors;}var valid3: any = _errs18 === errors;if(!valid3){const err3: any = {instancePath:instancePath+"/pinData",schemaPath:"#/properties/pinData/propertyNames",keyword:"propertyNames",params:{propertyName: key1}};if(vErrors === null){vErrors = [err3];}else {vErrors.push(err3);}errors++;validateWorkflowDraftDocument.errors = vErrors;return false;break;}}if(valid3){for(const key2 in data9){let data10: any = data9[key2];const _errs25: any = errors;if(errors === _errs25){if(Array.isArray(data10)){var valid7: any = true;const len2: any = data10.length;for(let i2=0; i2<len2; i2++){const _errs27: any = errors;if(!(validateWorkflowPinnedItem.call(this, data10[i2], {instancePath:instancePath+"/pinData/" + key2.replace(/~/g, "~0").replace(/\//g, "~1")+"/" + i2,parentData:data10,parentDataProperty:i2,rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateWorkflowPinnedItem.errors : vErrors.concat(validateWorkflowPinnedItem.errors);errors = vErrors.length;}var valid7: any = _errs27 === errors;if(!valid7){break;}}}else {validateWorkflowDraftDocument.errors = [{instancePath:instancePath+"/pinData/" + key2.replace(/~/g, "~0").replace(/\//g, "~1"),schemaPath:"#/properties/pinData/additionalProperties/type",keyword:"type",params:{type: "array"}}];return false;}}var valid6: any = _errs25 === errors;if(!valid6){break;}}}}else {validateWorkflowDraftDocument.errors = [{instancePath:instancePath+"/pinData",schemaPath:"#/properties/pinData/type",keyword:"type",params:{type: "object"}}];return false;}}var valid0: any = _errs16 === errors;}else {var valid0: any = true;}if(valid0){if(data.tags !== undefined){const _errs28: any = errors;if(!(validateTagList.call(this, data.tags, {instancePath:instancePath+"/tags",parentData:data,parentDataProperty:"tags",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateTagList.errors : vErrors.concat(validateTagList.errors);errors = vErrors.length;}var valid0: any = _errs28 === errors;}else {var valid0: any = true;}}}}}}}}}}}}else {validateWorkflowDraftDocument.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowDraftDocument.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowDraftDocument.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
/** Checks that a value is a {@link WorkflowToolBinding}. */
// prettier-ignore
export const validateWorkflowToolBinding: CompiledSchemaCheck<WorkflowToolBinding> = function (this: any, data: any, {instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors={}}: any = {}): data is WorkflowToolBinding {let vErrors: any = null;let errors: any = 0;const evaluated0: any = validateWorkflowToolBinding.evaluated;if(evaluated0.dynamicProps){evaluated0.props = undefined;}if(evaluated0.dynamicItems){evaluated0.items = undefined;}if(errors === 0){if(data && typeof data == "object" && !Array.isArray(data)){let missing0: any;if(((data.binding === undefined) && (missing0 = "binding")) || ((data.toolName === undefined) && (missing0 = "toolName"))){validateWorkflowToolBinding.errors = [{instancePath,schemaPath:"#/required",keyword:"required",params:{missingProperty: missing0}}];return false;}else {const _errs1: any = errors;for(const key0 in data){if(!((key0 === "binding") || (key0 === "toolName"))){validateWorkflowToolBinding.errors = [{instancePath,schemaPath:"#/additionalProperties",keyword:"additionalProperties",params:{additionalProperty: key0}}];return false;break;}}if(_errs1 === errors){if(data.binding !== undefined){const _errs2: any = errors;if(!(validateMcpServerBindingRef.call(this, data.binding, {instancePath:instancePath+"/binding",parentData:data,parentDataProperty:"binding",rootData,dynamicAnchors}))){vErrors = vErrors === null ? validateMcpServerBindingRef.errors : vErrors.concat(validateMcpServerBindingRef.errors);errors = vErrors.length;}var valid0: any = _errs2 === errors;}else {var valid0: any = true;}if(valid0){if(data.toolName !== undefined){let data1: any = data.toolName;const _errs3: any = errors;if(errors === _errs3){if(typeof data1 === "string"){if(func1(data1) < 1){validateWorkflowToolBinding.errors = [{instancePath:instancePath+"/toolName",schemaPath:"#/properties/toolName/minLength",keyword:"minLength",params:{limit: 1}}];return false;}}else {validateWorkflowToolBinding.errors = [{instancePath:instancePath+"/toolName",schemaPath:"#/properties/toolName/type",keyword:"type",params:{type: "string"}}];return false;}}var valid0: any = _errs3 === errors;}else {var valid0: any = true;}}}}}else {validateWorkflowToolBinding.errors = [{instancePath,schemaPath:"#/type",keyword:"type",params:{type: "object"}}];return false;}}validateWorkflowToolBinding.errors = vErrors;return errors === 0;};
// prettier-ignore
validateWorkflowToolBinding.evaluated = {"props":true,"dynamicProps":false,"dynamicItems":false} as any;
