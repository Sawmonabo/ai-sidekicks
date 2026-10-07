// The node catalog: every node kind the daemon runs, as `workflow.kindList` serializes
// it. One description per kind drives the palette row, the inspector's parameter
// form, the canvas handles and the daemon's check at save, and an agent reads the same
// list before it writes a workflow.
//
// A kind's two computed parts, the handle set derived from its params and the one-line
// summary of a configured node, are functions and do not cross the wire:
// `outputsDeriveFromParams` says the listed outputs are the base case, and whatever holds
// the kind's code composes the summary.
import { z } from "zod";

import {
  defineMethodDescriptors,
  EmptyPayloadSchema,
  type EmptyPayload,
  type MethodDescriptor,
} from "../method-descriptor.js";
import { WorkflowNodeKindIdSchema, type WorkflowNodeKindId } from "./definition/document.js";
import {
  parseWorkflowHandle,
  type WorkflowHandleId,
  type WorkflowHandleMode,
  type WorkflowHandleType,
} from "./definition/handle.js";

const WORKFLOW_NODE_KIND_CATEGORIES = [
  "trigger",
  "agent",
  "human",
  "files",
  "browser",
  "developer",
  "flow",
  "output",
] as const;

/** The categories the palette groups kinds under. */
export type WorkflowNodeKindCategory = (typeof WORKFLOW_NODE_KIND_CATEGORIES)[number];

/**
 * One handle a kind declares on one side. Its id reads `<mode>/<type>/<index>` and says the
 * side and type the handle declares, so a handle is addressable from a stored edge alone.
 * `maxConnections` absent means the handle takes any number of edges.
 */
export type WorkflowHandleSpec<Mode extends WorkflowHandleMode = WorkflowHandleMode> = {
  [Type in WorkflowHandleType]: {
    id: WorkflowHandleId<Mode, Type>;
    label: string;
    type: Type;
    maxConnections?: number | undefined;
    required?: boolean | undefined;
  };
}[WorkflowHandleType];

function handleSpecArm<Id extends string, Type extends WorkflowHandleType>(
  id: z.ZodType<Id, Id>,
  type: Type,
) {
  return z
    .object({
      id,
      label: z.string().min(1),
      type: z.literal(type),
      maxConnections: z.number().int().positive().optional(),
      required: z.boolean().optional(),
    })
    .strict();
}

// The template literal lets a negative index or one with leading zeros through. Such an id parses
// to the fallback handle or drops its zeros, so it no longer reads back as itself.
function hasCanonicalIndex(spec: { id: string }): boolean {
  const { mode, type, index } = parseWorkflowHandle(spec.id);
  return `${mode}/${type}/${index}` === spec.id;
}
const CANONICAL_INDEX_ISSUE = {
  path: ["id"],
  message: "A handle's index is a whole number from 0, written with no leading zeros.",
};

const InputHandleSpecSchema: z.ZodType<WorkflowHandleSpec<"inputs">> = z
  .discriminatedUnion("type", [
    handleSpecArm(z.templateLiteral(["inputs/main/", z.int()]), "main"),
    handleSpecArm(z.templateLiteral(["inputs/tool/", z.int()]), "tool"),
  ])
  .refine(hasCanonicalIndex, CANONICAL_INDEX_ISSUE);

const OutputHandleSpecSchema: z.ZodType<WorkflowHandleSpec<"outputs">> = z
  .discriminatedUnion("type", [
    handleSpecArm(z.templateLiteral(["outputs/main/", z.int()]), "main"),
    handleSpecArm(z.templateLiteral(["outputs/tool/", z.int()]), "tool"),
  ])
  .refine(hasCanonicalIndex, CANONICAL_INDEX_ISSUE);

const WORKFLOW_PARAM_TYPES = [
  "string",
  "text",
  "number",
  "boolean",
  "select",
  "multiselect",
  "json",
  "expression",
  "path",
  "glob",
  "cron",
  "secret",
  "agent",
  "mcp-tool",
  "callback-tool",
  "session",
  "project",
] as const;

/** The type of one leaf parameter, which picks the field the inspector draws. */
export type WorkflowParamType = (typeof WORKFLOW_PARAM_TYPES)[number];

/**
 * One parameter a kind declares. A leaf has one type; a `collection` nests a field list
 * and may repeat. `showWhen` is the whole conditional form: the parameter is drawn when
 * each named sibling holds one of the listed values. `sensitive` marks the only
 * parameters a `secret://` reference resolves in.
 */
export type WorkflowParamSpec =
  | {
      id: string;
      label: string;
      type: WorkflowParamType;
      required?: boolean | undefined;
      sensitive?: boolean | undefined;
      default?: unknown;
      help?: string | undefined;
      options?: { value: unknown; label: string }[] | undefined;
      showWhen?: Record<string, unknown[]> | undefined;
    }
  | {
      id: string;
      label: string;
      type: "collection";
      fields: WorkflowParamSpec[];
      multiple?: boolean | undefined;
    };
/** Wire schema for {@link WorkflowParamSpec}. */
export const WorkflowParamSpecSchema: z.ZodType<WorkflowParamSpec> = z.lazy(() =>
  z.union([
    z
      .object({
        id: z.string().min(1),
        label: z.string().min(1),
        type: z.enum(WORKFLOW_PARAM_TYPES),
        required: z.boolean().optional(),
        sensitive: z.boolean().optional(),
        default: z.unknown().optional(),
        help: z.string().min(1).optional(),
        options: z
          .array(z.object({ value: z.unknown(), label: z.string().min(1) }).strict())
          .optional(),
        showWhen: z.record(z.string(), z.array(z.unknown())).optional(),
      })
      .strict(),
    z
      .object({
        id: z.string().min(1),
        label: z.string().min(1),
        type: z.literal("collection"),
        fields: z.array(WorkflowParamSpecSchema),
        multiple: z.boolean().optional(),
      })
      .strict(),
  ]),
);

const WORKFLOW_NODE_SIDE_EFFECTS = ["none", "local", "external"] as const;

/** What running a kind can change: nothing, this machine, or something beyond it. */
export type WorkflowNodeSideEffects = (typeof WORKFLOW_NODE_SIDE_EFFECTS)[number];

/**
 * One kind as the catalog serializes it. `version` is the implementation a newly placed
 * node records; a placed node keeps the version it recorded.
 */
export interface WorkflowNodeKindSpec {
  kind: WorkflowNodeKindId;
  version: number;
  category: WorkflowNodeKindCategory;
  displayName: string;
  description: string;
  icon: string;
  aliases?: string[] | undefined;
  inputs: WorkflowHandleSpec<"inputs">[];
  outputs: WorkflowHandleSpec<"outputs">[];
  outputsDeriveFromParams: boolean;
  params: WorkflowParamSpec[];
  perItem?: boolean | undefined;
  capabilities?:
    | { cancelable: boolean; resumable: boolean; sideEffects: WorkflowNodeSideEffects }
    | undefined;
}
const WorkflowNodeKindSpecSchema: z.ZodType<WorkflowNodeKindSpec> = z
  .object({
    kind: WorkflowNodeKindIdSchema,
    version: z.number().int().positive(),
    category: z.enum(WORKFLOW_NODE_KIND_CATEGORIES),
    displayName: z.string().min(1),
    description: z.string().min(1),
    icon: z.string().min(1),
    // Palette search only.
    aliases: z.array(z.string().min(1)).optional(),
    inputs: z.array(InputHandleSpecSchema),
    outputs: z.array(OutputHandleSpecSchema),
    outputsDeriveFromParams: z.boolean(),
    params: z.array(WorkflowParamSpecSchema),
    // True where the kind runs once per item rather than once over all of them.
    perItem: z.boolean().optional(),
    capabilities: z
      .object({
        cancelable: z.boolean(),
        resumable: z.boolean(),
        sideEffects: z.enum(WORKFLOW_NODE_SIDE_EFFECTS),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(({ inputs }) => hasUniqueIds(inputs), {
    path: ["inputs"],
    message: "Each input handle id appears once.",
  })
  .refine(({ outputs }) => hasUniqueIds(outputs), {
    path: ["outputs"],
    message: "Each output handle id appears once.",
  });

// An edge names a handle by id alone, so two handles with one id on a side are one port.
function hasUniqueIds(specs: readonly { id: string }[]): boolean {
  return new Set(specs.map(({ id }) => id)).size === specs.length;
}

/** The `workflow.kindList` result: every kind the daemon runs. */
export interface WorkflowKindListResponse {
  kinds: WorkflowNodeKindSpec[];
}
/** Wire schema for {@link WorkflowKindListResponse}. */
export const WorkflowKindListResponseSchema: z.ZodType<WorkflowKindListResponse> = z
  .object({ kinds: z.array(WorkflowNodeKindSpecSchema) })
  .strict();

/** The `workflow.kindList` method. */
export interface WorkflowKindMethodDescriptors {
  readonly "workflow.kindList": MethodDescriptor<
    "workflow.kindList",
    EmptyPayload,
    WorkflowKindListResponse
  >;
}

/**
 * The node catalog's method table.
 *
 * @consumedBy the daemon's `workflow.kindList` handler
 */
export const WORKFLOW_KIND_METHOD_DESCRIPTORS: WorkflowKindMethodDescriptors =
  defineMethodDescriptors({
    "workflow.kindList": {
      method: "workflow.kindList",
      procedureType: "query",
      mutating: false,
      requestSchema: EmptyPayloadSchema,
      responseSchema: WorkflowKindListResponseSchema,
    },
  });
