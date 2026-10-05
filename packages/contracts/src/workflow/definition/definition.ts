// Workflow definitions: the node-graph document an author writes, the ids and scopes
// that address a definition and its versions, and the refusal a save answers with when
// the document breaks a rule. The methods are in `workflow/definition/methods.ts`; the
// state kept beside a version (the enabled switch, layout, pinned data, the builder's
// draft, the expression preview and the webhook address) is in
// `workflow/definition/builder.ts`.
//
// A definition has one form, the document below, on the wire and in the store. Its
// content hash covers only the hashed members (`WORKFLOW_DOCUMENT_HASHED_MEMBERS`);
// canvas layout and pinned sample data sit outside them, so dragging a node or
// pinning data never mints a version.
//
// The `workflow_create` and `workflow_update` agent tools derive their input schemas
// from this document with `z.toJSONSchema`, and a model reading one sees each
// member's `.describe()` text but not its bounds, so every rule an author must meet
// is also written in that text.
//
// This file imports nothing from the run contracts: they import the document's ids,
// nodes and items from here.
import { z } from "zod";

import { McpServerBindingRefSchema, type McpServerBindingRef } from "../../mcp/mcp.js";
import { ArtifactIdSchema, type ArtifactId } from "../../provider/driver/driver.js";
import { FILE_PATH_MAX_LEN } from "../../session/session.js";
import { countSchema } from "../../internal/wire-scalars.js";

/** A workflow definition's id. The daemon mints it; a client passes it through unparsed. */
export type WorkflowDefinitionId = string & { readonly __brand: "WorkflowDefinitionId" };
/** Wire schema for {@link WorkflowDefinitionId}. */
export const WorkflowDefinitionIdSchema: z.ZodType<WorkflowDefinitionId, WorkflowDefinitionId> = z
  .string()
  .min(1)
  .brand<"WorkflowDefinitionId">() as unknown as z.ZodType<
  WorkflowDefinitionId,
  WorkflowDefinitionId
>;

/**
 * One saved version's id, exactly as the daemon returned it; it is what a run start
 * takes. A client never builds one from a definition id and a version number, because
 * no encoding over that pair exists on the wire.
 */
export const WorkflowVersionIdSchema: z.ZodType<string, string> = z.string().min(1);

/**
 * A definition's content hash: BLAKE3 over the RFC 8785 canonical JSON of its hashed
 * body. Canvas layout and pinned sample data sit outside that body, so neither changes it.
 */
export const WorkflowContentHashSchema: z.ZodType<string, string> = z.string().min(1);

/**
 * A node's id inside one document. Edges, expressions and step records address a node
 * by it, so renaming a node is a label edit and never a graph-wide rewrite. It is not
 * the runtime node id of `node-id.ts`.
 */
export type WorkflowNodeId = string & { readonly __brand: "WorkflowNodeId" };
/** Wire schema for {@link WorkflowNodeId}. */
export const WorkflowNodeIdSchema: z.ZodType<WorkflowNodeId, WorkflowNodeId> = z
  .string()
  .min(1)
  .describe("The node's id, unique in the document; edges and expressions address it.")
  .brand<"WorkflowNodeId">() as unknown as z.ZodType<WorkflowNodeId, WorkflowNodeId>;

/**
 * A node kind's key, the category then the kind: `files.read`, `agent.run`. It is data,
 * not a closed union: the catalog is what `workflow.kindList` answers.
 */
export type WorkflowNodeKindId = string;
/** Wire schema for {@link WorkflowNodeKindId}. */
export const WorkflowNodeKindIdSchema: z.ZodType<WorkflowNodeKindId, WorkflowNodeKindId> = z
  .string()
  .min(1)
  .describe("The node kind's key as workflow.kindList lists it, such as files.read.");

const WORKFLOW_DEFINITION_SCOPES = ["session", "project", "shared"] as const;

/**
 * Where a definition is visible, most specific first, which is also the order a name
 * resolves in. `session` binds it to the session that wrote it, `project` spans one
 * project's sessions, and `shared` is reusable by every project on this machine.
 * `shared` widens reuse only: nothing is distributed or synced.
 */
export type WorkflowDefinitionScope = (typeof WORKFLOW_DEFINITION_SCOPES)[number];
/** Wire schema for {@link WorkflowDefinitionScope}. */
export const WorkflowDefinitionScopeSchema: z.ZodType<
  WorkflowDefinitionScope,
  WorkflowDefinitionScope
> = z.enum(WORKFLOW_DEFINITION_SCOPES);

/**
 * A scope's identity: the authoring session's id at `session`, the resolved repository
 * root at `project`, and the empty string at `shared`, which refers to nothing narrower.
 */
export const WorkflowDefinitionScopeRefSchema: z.ZodType<string, string> = z
  .string()
  .max(FILE_PATH_MAX_LEN);

// The document

/** The document schema version this contract reads and writes. */
export const WORKFLOW_DOCUMENT_SCHEMA_VERSION = "2" as const;

/**
 * The document members the content hash covers, in the order the hash preimage lists
 * them. Everything else, `layout` and `pinData`, is outside the hash.
 *
 * @consumedBy the daemon's workflow content hash, which covers these members and not the layout
 */
export const WORKFLOW_DOCUMENT_HASHED_MEMBERS = [
  "name",
  "description",
  "trigger",
  "nodes",
  "edges",
] as const;

const WORKFLOW_NODE_ON_ERROR = ["stop", "continue", "continue-error-output"] as const;

/**
 * What a node's failure does: stop the run, pass the node's input on, or send the failed
 * items down a real `error` output handle.
 */
export type WorkflowNodeOnError = (typeof WORKFLOW_NODE_ON_ERROR)[number];

/**
 * One node. `kindVersion` is written when the node is placed and never migrated: the
 * daemon runs the kind implementation the document names. `order` decides which
 * sibling branch runs first and is never derived from canvas position. The retry
 * counts are the author's asks; the engine clamps them and never trusts them as given.
 */
export interface WorkflowNode {
  id: WorkflowNodeId;
  kind: WorkflowNodeKindId;
  kindVersion: number;
  name: string;
  order: number;
  params: Record<string, unknown>;
  disabled?: boolean | undefined;
  notes?: string | undefined;
  onError?: WorkflowNodeOnError | undefined;
  retry?: { maxTries: number; waitMs: number } | undefined;
  executeOnce?: boolean | undefined;
  alwaysOutputData?: boolean | undefined;
}
/** Wire schema for {@link WorkflowNode}. */
export const WorkflowNodeSchema: z.ZodType<WorkflowNode, WorkflowNode> = z
  .object({
    id: WorkflowNodeIdSchema,
    kind: WorkflowNodeKindIdSchema,
    kindVersion: z
      .number()
      .int()
      .positive()
      .describe("The kind's version when the node was placed; a whole number from 1."),
    name: z.string().min(1).describe("The label a person reads; never used to address the node."),
    order: z
      .number()
      .int()
      .describe("Which sibling branch runs first, lowest first; never the canvas position."),
    params: z
      .record(z.string(), z.unknown())
      .describe(
        "The node's parameters by the ids its kind lists. A value is a literal, or an " +
          "expression written ={{ … }}. A secret is written secret://<scope>/<name> and " +
          "only in a parameter the kind marks sensitive.",
      ),
    disabled: z.boolean().optional(),
    notes: z.string().optional(),
    onError: z.enum(WORKFLOW_NODE_ON_ERROR).optional(),
    retry: z
      .object({
        maxTries: z.number().int().positive(),
        waitMs: countSchema,
      })
      .strict()
      .optional()
      .describe("Retries on failure: maxTries from 1, waitMs from 0; the engine clamps both."),
    executeOnce: z.boolean().optional(),
    alwaysOutputData: z.boolean().optional(),
  })
  .strict();

/**
 * One edge. It names the two handles it joins, not only the two nodes, because a node
 * can carry several handles on each side. A handle id reads `<mode>/<type>/<index>`,
 * such as `outputs/main/1`; the daemon's check at save refuses a type other than
 * `main` or `tool`.
 */
export interface WorkflowEdge {
  id: string;
  source: WorkflowNodeId;
  sourceHandle: string;
  target: WorkflowNodeId;
  targetHandle: string;
}
/** Wire schema for {@link WorkflowEdge}. */
export const WorkflowEdgeSchema: z.ZodType<WorkflowEdge, WorkflowEdge> = z
  .object({
    id: z.string().min(1),
    source: WorkflowNodeIdSchema,
    sourceHandle: z
      .string()
      .min(1)
      .describe("The source node's output handle, such as outputs/main/0 or outputs/tool/0."),
    target: WorkflowNodeIdSchema,
    targetHandle: z
      .string()
      .min(1)
      .describe("The target node's input handle, such as inputs/main/0 or inputs/tool/0."),
  })
  .strict();

const canvasPointShape = { x: z.number(), y: z.number() };

/** A sticky note on the canvas: text in a box, with no handles. */
export interface WorkflowStickyNote {
  id: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Canvas geometry, in canvas units. Outside the hash, and persisted beside the version's
 * body, so an exported or agent-written workflow carries its picture. A document with
 * no layout is laid out by the daemon the same way every time.
 */
export interface WorkflowLayout {
  nodes: Record<string, { x: number; y: number }>;
  viewport?: { x: number; y: number; zoom: number } | undefined;
  notes?: WorkflowStickyNote[] | undefined;
}
/** Wire schema for {@link WorkflowLayout}. */
export const WorkflowLayoutSchema: z.ZodType<WorkflowLayout, WorkflowLayout> = z
  .object({
    nodes: z.record(z.string(), z.object(canvasPointShape).strict()),
    viewport: z
      .object({ ...canvasPointShape, zoom: z.number().positive() })
      .strict()
      .optional(),
    notes: z
      .array(
        z
          .object({
            id: z.string().min(1),
            text: z.string(),
            ...canvasPointShape,
            width: z.number().positive(),
            height: z.number().positive(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

/**
 * A binary value an item carries: a stored artifact by id, with the type, name and size
 * a panel draws. Bytes never travel inside a run record or a document.
 */
export interface WorkflowBinaryRef {
  artifactId: ArtifactId;
  mimeType: string;
  fileName: string;
  size: number;
}
const WorkflowBinaryRefSchema: z.ZodType<WorkflowBinaryRef, WorkflowBinaryRef> = z
  .object({
    artifactId: ArtifactIdSchema,
    mimeType: z.string().min(1),
    fileName: z.string().min(1).max(FILE_PATH_MAX_LEN),
    size: countSchema,
  })
  .strict();

/** One input item an output item came from, and on which input. */
export interface WorkflowPairedItem {
  item: number;
  input?: number | undefined;
}
const WorkflowPairedItemSchema: z.ZodType<WorkflowPairedItem, WorkflowPairedItem> = z
  .object({
    item: countSchema,
    input: countSchema.optional(),
  })
  .strict();

/**
 * A failure carried on one item, so one item can fail while the rest of a batch
 * succeeds, and on the step it failed in. `code` is the step failure's own code where
 * one names it (a timed-out step, a sandbox that did not start, a Code step over its
 * budget …) with that code's `details`; a failure with no code of its own carries the
 * message alone. `itemIndex` names the input item the step failed on: the same zero-based
 * index an expression reads as `$itemIndex`, drawn as it stands (`Item 1` for 1).
 */
export interface WorkflowStepError {
  message: string;
  nodeId?: WorkflowNodeId | undefined;
  itemIndex?: number | undefined;
  code?: string | undefined;
  details?: Record<string, unknown> | undefined;
}
/** Wire schema for {@link WorkflowStepError}; `details` never appears without `code`. */
export const WorkflowStepErrorSchema: z.ZodType<WorkflowStepError, WorkflowStepError> = z
  .object({
    message: z.string().min(1),
    nodeId: WorkflowNodeIdSchema.optional(),
    itemIndex: countSchema.optional(),
    code: z
      .string()
      .regex(/^workflow\.[a-z][a-z_]*$/u)
      .optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .refine((error) => error.details === undefined || error.code !== undefined, {
    path: ["details"],
    message: "details belong to a coded failure.",
  });

/**
 * One item: data between nodes is always an array of these. `pairedItem` is the item's
 * lineage, which lets an expression walk back across a branch and a merge.
 */
export interface WorkflowItem {
  json: unknown;
  binary?: Record<string, WorkflowBinaryRef> | undefined;
  pairedItem?: WorkflowPairedItem | WorkflowPairedItem[] | undefined;
  error?: WorkflowStepError | undefined;
}
/** Wire schema for {@link WorkflowItem}. */
export const WorkflowItemSchema: z.ZodType<WorkflowItem, WorkflowItem> = z
  .object({
    json: z.unknown(),
    binary: z.record(z.string(), WorkflowBinaryRefSchema).optional(),
    pairedItem: z.union([WorkflowPairedItemSchema, z.array(WorkflowPairedItemSchema)]).optional(),
    error: WorkflowStepErrorSchema.optional(),
  })
  .strict();

/**
 * An item pinned onto a node as test data. It carries no binary value, because a node
 * whose items carry one cannot be pinned.
 */
export type WorkflowPinnedItem = Omit<WorkflowItem, "binary">;
/** Wire schema for {@link WorkflowPinnedItem}. */
export const WorkflowPinnedItemSchema: z.ZodType<WorkflowPinnedItem, WorkflowPinnedItem> = z
  .object({
    json: z.unknown(),
    pairedItem: z.union([WorkflowPairedItemSchema, z.array(WorkflowPairedItemSchema)]).optional(),
    error: WorkflowStepErrorSchema.optional(),
  })
  .strict();

const documentBodyShape = {
  schemaVersion: z
    .literal(WORKFLOW_DOCUMENT_SCHEMA_VERSION)
    .describe(`The document schema version; always "${WORKFLOW_DOCUMENT_SCHEMA_VERSION}".`),
  name: z.string().min(1).describe("The workflow's name."),
  description: z.string().optional(),
  nodes: z
    .array(WorkflowNodeSchema)
    .describe("Every node except the trigger. Node ids are unique across the document."),
  edges: z
    .array(WorkflowEdgeSchema)
    .describe(
      "The connections. main carries items and tool carries a capability; nothing " +
        "connects into the trigger, and nothing but a loop closes a cycle.",
    ),
  layout: WorkflowLayoutSchema.optional().describe(
    "Canvas positions; outside the content hash. Omit it and the daemon lays the graph out.",
  ),
  pinData: z
    .record(z.string(), z.array(WorkflowPinnedItemSchema))
    .optional()
    .describe("Test data pinned onto nodes by node id; outside the content hash."),
};

const triggerDescription =
  "The one trigger node; its kind is in the trigger category, such as trigger.manual.";

/**
 * A workflow document: exactly one trigger node, the other nodes, and the edges between
 * them, plus the layout and pinned data outside the hash. A document holds no settings
 * block: what a failure does is set on the node that failed.
 */
export interface WorkflowDocument {
  schemaVersion: typeof WORKFLOW_DOCUMENT_SCHEMA_VERSION;
  name: string;
  description?: string | undefined;
  trigger: WorkflowNode;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  layout?: WorkflowLayout | undefined;
  pinData?: Record<string, WorkflowPinnedItem[]> | undefined;
}
/** Wire schema for {@link WorkflowDocument}. */
export const WorkflowDocumentSchema: z.ZodType<WorkflowDocument, WorkflowDocument> = z
  .object({ ...documentBodyShape, trigger: WorkflowNodeSchema.describe(triggerDescription) })
  .strict();

/**
 * The builder's unsaved document. It may not have its trigger yet: the builder opens on
 * the trigger picker, and a draft saved before one is placed still survives a reload.
 */
export type WorkflowDraftDocument = Omit<WorkflowDocument, "trigger"> & {
  trigger?: WorkflowNode | undefined;
};
/** Wire schema for {@link WorkflowDraftDocument}. */
export const WorkflowDraftDocumentSchema: z.ZodType<WorkflowDraftDocument, WorkflowDraftDocument> =
  z
    .object({
      ...documentBodyShape,
      trigger: WorkflowNodeSchema.optional().describe(triggerDescription),
    })
    .strict();

/**
 * A node's tool parameter: which server's tool, and nothing about its policy. A tool's
 * approval lives only in Settings › MCP servers, read live when the step starts, so
 * `enabled`, `approvalMode` or `idempotencyClass` on a binding is an unknown member and
 * fails the parse.
 */
export interface WorkflowToolBinding {
  binding: McpServerBindingRef;
  toolName: string;
}
/** Wire schema for {@link WorkflowToolBinding}. */
export const WorkflowToolBindingSchema: z.ZodType<WorkflowToolBinding, WorkflowToolBinding> = z
  .object({ binding: McpServerBindingRefSchema, toolName: z.string().min(1) })
  .strict();

// The document's refusal

/**
 * A document the daemon's check at save refused; it carries every finding at once.
 *
 * @consumedBy the handler that returns the `workflow.definition_refused` error
 */
export const WORKFLOW_DEFINITION_REFUSED_CODE = "workflow.definition_refused" as const;

/**
 * The rules a refused document can break. Each finding names one, with the nodes it
 * marks; the validation strip lists every finding and the canvas marks each node.
 */
export const WORKFLOW_DEFINITION_FINDING_RULES = [
  "cycle",
  "orphan",
  "empty_document",
  "trigger_missing",
  "trigger_duplicate",
  "edge_into_trigger",
  "edge_out_of_terminal",
  "param_missing",
  "expression_unparsable",
  "expression_unknown_node",
  "expression_regex_unsupported",
  "tool_edge_without_tool_input",
  "handle_type_unknown",
  "scope_ref_invalid",
  "unknown_key",
  "secret_outside_sensitive_field",
  "code_packages_unresolved",
] as const;
/** One of {@link WORKFLOW_DEFINITION_FINDING_RULES}. */
export type WorkflowDefinitionFindingRule = (typeof WORKFLOW_DEFINITION_FINDING_RULES)[number];

/**
 * One finding. Only `code_packages_unresolved` carries `detail`, and always does: the package a
 * full-tier Code step names at two versions in two imports. A package that merely cannot be
 * locked is no finding; the save is kept.
 */
export type WorkflowDefinitionFinding =
  | {
      rule: Exclude<WorkflowDefinitionFindingRule, "code_packages_unresolved">;
      nodeIds: WorkflowNodeId[];
    }
  | { rule: "code_packages_unresolved"; nodeIds: WorkflowNodeId[]; detail: string };
/** Wire schema for {@link WorkflowDefinitionFinding}. */
export const WorkflowDefinitionFindingSchema: z.ZodType<WorkflowDefinitionFinding> = z.union([
  z
    .object({
      rule: z.enum(WORKFLOW_DEFINITION_FINDING_RULES).exclude(["code_packages_unresolved"]),
      nodeIds: z.array(WorkflowNodeIdSchema),
    })
    .strict(),
  z
    .object({
      rule: z.literal("code_packages_unresolved"),
      nodeIds: z.array(WorkflowNodeIdSchema).min(1),
      detail: z.string().min(1),
    })
    .strict(),
]);

/** The details of {@link WORKFLOW_DEFINITION_REFUSED_CODE}: the whole list of findings. */
export interface WorkflowDefinitionRefusedDetails {
  findings: WorkflowDefinitionFinding[];
}
/**
 * Wire schema for {@link WorkflowDefinitionRefusedDetails}.
 *
 * @consumedBy the handler that returns the `workflow.definition_refused` error
 */
export const WorkflowDefinitionRefusedDetailsSchema: z.ZodType<WorkflowDefinitionRefusedDetails> = z
  .object({ findings: z.array(WorkflowDefinitionFindingSchema).min(1) })
  .strict();
