// Workflow definitions: the node-graph document an author writes and the ids that address a
// definition and its versions. The methods are in `workflow/definition/methods.ts`; the state
// kept beside a version (the enabled switch, layout, pinned data, the builder's draft, the
// expression preview and the webhook address) is in `workflow/definition/builder.ts`.
//
// A definition has one form, the document below, on the wire and in the store. Its
// content hash covers only the hashed members (`WORKFLOW_DOCUMENT_HASHED_MEMBERS`);
// canvas layout, pinned sample data and tags sit outside them, so dragging a node,
// pinning data or tagging a workflow never mints a version.
//
// The `workflow_create` and `workflow_update` agent tools derive their input schemas
// from this document with `z.toJSONSchema`, and a model reading one sees each
// member's `.describe()` text but not its bounds, so every rule an author must meet
// is also written in that text.
//
// This file imports nothing from the run contracts: they import the document's ids,
// nodes and items from here.
import { z } from "zod";

import { McpServerBindingRefSchema, type McpServerBindingRef } from "../../mcp/server.js";
import {
  AGENT_RESOLUTION_REFUSED_CODE,
  AgentResolutionRefusedDetailsSchema,
  type AgentResolutionRefusedCode,
  type AgentResolutionRefusedDetails,
} from "../../agent/definition.js";
import { ArtifactIdSchema, type ArtifactId } from "../../artifacts/id.js";
import { FILE_PATH_MAX_LEN } from "../../free-form-string.js";
import { findRepeats } from "../../internal/repeats.js";
import { countSchema } from "../../internal/wire-scalars.js";
import { TagListSchema } from "../../tag.js";
import type { WorkflowParamType } from "../kind.js";
import type { WorkflowDefinitionFinding } from "./refusals.js";

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
 * the runtime node id of `runtime-node/id.ts`.
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

// The document

/** The document schema version this contract reads and writes. */
export const WORKFLOW_DOCUMENT_SCHEMA_VERSION = "2" as const;

const WORKFLOW_NODE_ON_ERROR = ["stop", "continue", "continue-error-output"] as const;

/**
 * What a node's failure does: stop the run, pass the node's input on, or send the failed
 * items down a real `error` output handle.
 */
export type WorkflowNodeOnError = (typeof WORKFLOW_NODE_ON_ERROR)[number];

/**
 * How a `flow.merge` node joins its inputs into its one output. `first-to-arrive` passes on
 * the first input to succeed and cancels the branches still running.
 */
export const WORKFLOW_MERGE_MODES = [
  "append",
  "combine-by-field",
  "combine-by-position",
  "choose-branch",
  "first-to-arrive",
] as const;
/**
 * One of {@link WORKFLOW_MERGE_MODES}.
 *
 * @consumedBy the merge node's kind
 */
export type WorkflowMergeMode = (typeof WORKFLOW_MERGE_MODES)[number];

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
const workflowNodeShape = {
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
        "expression written ={{ … }}. An agent, project or session parameter holds that " +
        "record's id and an MCP tool parameter its server binding and tool name, never a " +
        "nested node. A secret is written secret://shared/<name> or " +
        "secret://project/<name>, never as an expression, and only in a parameter the " +
        "kind marks sensitive.",
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
};
/** Wire schema for {@link WorkflowNode}. */
export const WorkflowNodeSchema: z.ZodType<WorkflowNode, WorkflowNode> = z
  .object(workflowNodeShape)
  .strict();

// What every declared input carries, whatever its type.
interface WorkflowTriggerInputArm<Type extends WorkflowParamType, Value> {
  name: string;
  type: Type;
  required?: boolean | undefined;
  default: Value;
}

/**
 * One input a workflow declares on its trigger, which a run start fills by `name`, unique among
 * the trigger's inputs. Its type picks the field Run now draws: a checkbox for `boolean`, a list
 * of `options` for `select`, a folder picker for `path`, a box for `string`. `default` is the
 * value the field starts on, and a `select` input's is one of its `options`; a start that leaves
 * an optional input out runs on it.
 */
export type WorkflowTriggerInput =
  | WorkflowTriggerInputArm<"boolean", boolean>
  | WorkflowTriggerInputArm<"string", string>
  | WorkflowTriggerInputArm<"path", string>
  | (WorkflowTriggerInputArm<"select", string> & { options: [string, ...string[]] });

const triggerInputShape = {
  name: z.string().min(1).describe("The input's name; a run start fills the input by it."),
  required: z
    .boolean()
    .optional()
    .describe("True where a start must fill the input; omitted, it may be left out."),
};
const WorkflowTriggerInputSchema: z.ZodType<WorkflowTriggerInput, WorkflowTriggerInput> =
  z.discriminatedUnion("type", [
    z.object({ ...triggerInputShape, type: z.literal("boolean"), default: z.boolean() }).strict(),
    z.object({ ...triggerInputShape, type: z.literal("string"), default: z.string() }).strict(),
    z
      .object({
        ...triggerInputShape,
        type: z.literal("path"),
        default: z.string().max(FILE_PATH_MAX_LEN),
      })
      .strict(),
    z
      .object({
        ...triggerInputShape,
        type: z.literal("select"),
        options: z
          .tuple([z.string().min(1)], z.string().min(1))
          .describe("The choices, at least one; default is one of them."),
        default: z.string(),
      })
      .strict()
      .refine((input) => input.options.includes(input.default), {
        path: ["default"],
        message: "A choice input starts on one of its options.",
      }),
  ]);

/** The trigger node: a node that may also declare the inputs a run of the workflow starts with. */
export interface WorkflowTriggerNode extends WorkflowNode {
  inputs?: WorkflowTriggerInput[] | undefined;
}
const WorkflowTriggerNodeSchema: z.ZodType<WorkflowTriggerNode, WorkflowTriggerNode> = z
  .object({
    ...workflowNodeShape,
    inputs: z
      .array(WorkflowTriggerInputSchema)
      .superRefine((inputs, context) => {
        for (const { index, value } of findRepeats(inputs.map((input) => input.name))) {
          context.addIssue({
            code: "custom",
            path: [index, "name"],
            message: `Input name ${value} is used more than once.`,
          });
        }
      })
      .optional()
      .describe(
        "The inputs a run starts with, each with a name no other input uses and a type " +
          "(boolean, string, path, or select with its options) with the value it starts on " +
          "as default; required marks one a start must fill.",
      ),
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
 * A failure carried on one item, so one item can fail while the rest of a batch succeeds, on the
 * step it failed in, and on a run as why it failed or was canceled. A coded failure carries the
 * step failure's own `workflow.<condition>` code (a timed-out step, a sandbox that did not start, a
 * Code step over its budget …) and may carry that code's `details`; a step whose agent could not
 * resolve (a park on an account removed first) carries `agent.resolution_refused` with its
 * reason in `details`; a failure with no code of its own carries the message alone, never
 * `details`. `itemIndex` names the input item the step failed on: the same zero-based index an
 * expression reads as `$itemIndex`, drawn as it stands (`Item 1` for 1).
 */
export type WorkflowStepError =
  | {
      message: string;
      nodeId?: WorkflowNodeId | undefined;
      itemIndex?: number | undefined;
      code?: undefined;
      details?: undefined;
    }
  | {
      message: string;
      nodeId?: WorkflowNodeId | undefined;
      itemIndex?: number | undefined;
      code: `workflow.${string}`;
      details?: Record<string, unknown> | undefined;
    }
  | {
      message: string;
      nodeId?: WorkflowNodeId | undefined;
      itemIndex?: number | undefined;
      code: AgentResolutionRefusedCode;
      details: AgentResolutionRefusedDetails;
    };

const stepErrorShape = {
  message: z.string().min(1),
  nodeId: WorkflowNodeIdSchema.optional(),
  itemIndex: countSchema.optional(),
};
/** Wire schema for {@link WorkflowStepError}. */
export const WorkflowStepErrorSchema: z.ZodType<WorkflowStepError, WorkflowStepError> = z.union([
  z.object(stepErrorShape).strict(),
  z
    .object({
      ...stepErrorShape,
      code: z.templateLiteral(["workflow.", z.string().regex(/^[a-z][a-z_]*$/u)]),
      details: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
  z
    .object({
      ...stepErrorShape,
      code: z.literal(AGENT_RESOLUTION_REFUSED_CODE),
      details: AgentResolutionRefusedDetailsSchema,
    })
    .strict(),
]);

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
const workflowItemObject = z
  .object({
    json: z.unknown(),
    binary: z.record(z.string(), WorkflowBinaryRefSchema).optional(),
    pairedItem: z.union([WorkflowPairedItemSchema, z.array(WorkflowPairedItemSchema)]).optional(),
    error: WorkflowStepErrorSchema.optional(),
  })
  .strict();
/** Wire schema for {@link WorkflowItem}. */
export const WorkflowItemSchema: z.ZodType<WorkflowItem, WorkflowItem> = workflowItemObject;

/**
 * An item pinned onto a node as test data. It carries no binary value, because a node
 * whose items carry one cannot be pinned.
 */
export type WorkflowPinnedItem = Omit<WorkflowItem, "binary">;
/** Wire schema for {@link WorkflowPinnedItem}. */
export const WorkflowPinnedItemSchema: z.ZodType<WorkflowPinnedItem, WorkflowPinnedItem> =
  workflowItemObject.omit({ binary: true });

const documentBodyShape = {
  schemaVersion: z
    .literal(WORKFLOW_DOCUMENT_SCHEMA_VERSION)
    .describe(`The document schema version; always "${WORKFLOW_DOCUMENT_SCHEMA_VERSION}".`),
  name: z.string().min(1).describe("The workflow's name."),
  description: z.string().optional(),
  nodes: z
    .array(WorkflowNodeSchema)
    .describe(
      "Every node except the trigger. Node ids are unique across the document, the " +
        "trigger's included.",
    ),
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
  tags: TagListSchema.optional().describe(
    "The workflow's tags, nested with / and held once ignoring case, each never empty, with no " +
      "whitespace and no empty level around a /; outside the content hash.",
  ),
};

const triggerDescription =
  "The one trigger node; its kind is in the trigger category, such as trigger.manual. " +
  "Only the trigger declares inputs.";

/**
 * A workflow document: exactly one trigger node, the other nodes, and the edges between
 * them, plus the layout, pinned data and tags outside the hash. A document holds no
 * settings block: what a failure does is set on the node that failed.
 */
export interface WorkflowDocument {
  schemaVersion: typeof WORKFLOW_DOCUMENT_SCHEMA_VERSION;
  name: string;
  description?: string | undefined;
  trigger: WorkflowTriggerNode;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  layout?: WorkflowLayout | undefined;
  pinData?: Record<string, WorkflowPinnedItem[]> | undefined;
  tags?: string[] | undefined;
}
// A node id names one node, so the trigger's id and every other node's are all distinct. Each
// repeat's issue carries a `node_id_duplicate` finding as its `params`, which a refused call's
// error carries to the reader, so the refusal is named like every other finding.
function refuseRepeatedNodeIds(
  document: {
    trigger?: { id: WorkflowNodeId } | undefined;
    nodes: readonly { id: WorkflowNodeId }[];
  },
  context: z.RefinementCtx,
): void {
  const ids = document.nodes.map((node) => node.id);
  const allIds = document.trigger === undefined ? ids : [document.trigger.id, ...ids];
  const triggerOffset = allIds.length - ids.length;
  for (const { index, value: id } of findRepeats(allIds)) {
    const finding: WorkflowDefinitionFinding = { rule: "node_id_duplicate", nodeIds: [id] };
    context.addIssue({
      code: "custom",
      path: ["nodes", index - triggerOffset, "id"],
      message: `Node id ${id} is used more than once.`,
      params: finding,
    });
  }
}

/**
 * Wire schema for {@link WorkflowDocument}. It refuses a node id used twice with a custom issue
 * whose `params` is that id's `node_id_duplicate` finding.
 */
export const WorkflowDocumentSchema: z.ZodType<WorkflowDocument, WorkflowDocument> = z
  .object({ ...documentBodyShape, trigger: WorkflowTriggerNodeSchema.describe(triggerDescription) })
  .strict()
  .superRefine(refuseRepeatedNodeIds);

/**
 * The document members the content hash covers: its content, never its schema version. The
 * rest, `layout`, `pinData` and `tags`, sit outside it, so no member the engine reads may move
 * there.
 */
export const WORKFLOW_DOCUMENT_HASHED_MEMBERS = [
  "name",
  "description",
  "trigger",
  "nodes",
  "edges",
] as const;

/**
 * The part of a document its content hash covers: no geometry, pinned data or tags. The
 * `Pick` refuses to compile if the list above names anything but a document member.
 */
export type WorkflowDocumentHashedBody = Pick<
  WorkflowDocument,
  (typeof WORKFLOW_DOCUMENT_HASHED_MEMBERS)[number]
>;

/**
 * Returns the hashed body of a document, the only part the content hash reads; a member
 * the document leaves out stays out rather than appearing as `undefined`.
 */
export function pickWorkflowDocumentHashedBody(
  document: WorkflowDocument,
): WorkflowDocumentHashedBody {
  const body: Partial<Record<keyof WorkflowDocumentHashedBody, unknown>> = {};
  for (const member of WORKFLOW_DOCUMENT_HASHED_MEMBERS) {
    if (document[member] !== undefined) {
      body[member] = document[member];
    }
  }
  return body as WorkflowDocumentHashedBody;
}

/**
 * The builder's unsaved document. It may not have its trigger yet: the builder opens on
 * the trigger picker, and a draft saved before one is placed still survives a reload.
 */
export type WorkflowDraftDocument = Omit<WorkflowDocument, "trigger"> & {
  trigger?: WorkflowTriggerNode | undefined;
};
/**
 * Wire schema for {@link WorkflowDraftDocument}. It refuses a node id used twice the way
 * {@link WorkflowDocumentSchema} does.
 */
export const WorkflowDraftDocumentSchema: z.ZodType<WorkflowDraftDocument, WorkflowDraftDocument> =
  z
    .object({
      ...documentBodyShape,
      trigger: WorkflowTriggerNodeSchema.optional().describe(triggerDescription),
    })
    .strict()
    .superRefine(refuseRepeatedNodeIds);

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
