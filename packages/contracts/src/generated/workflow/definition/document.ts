// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// Workflow definitions: the node-graph document an author writes and the ids that address a definition and its versions.

import type { McpServerBindingRef } from "../../mcp/server.js";
import type { TagList } from "../../tag.js";
import type { WorkflowPinnedItem } from "./item.js";

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

export {
  validateWorkflowCanvasPoint,
  validateWorkflowContentHash,
  validateWorkflowDefinitionId,
  validateWorkflowDocument,
  validateWorkflowDraftDocument,
  validateWorkflowEdge,
  validateWorkflowEdgeId,
  validateWorkflowLayout,
  validateWorkflowNode,
  validateWorkflowNodeId,
  validateWorkflowNodeKindId,
  validateWorkflowNodeOnError,
  validateWorkflowNodeRetry,
  validateWorkflowStickyNote,
  validateWorkflowStickyNoteId,
  validateWorkflowToolBinding,
  validateWorkflowTriggerInput,
  validateWorkflowTriggerNode,
  validateWorkflowVersionId,
  validateWorkflowViewport,
} from "../../checks/workflow/definition/document.js";
