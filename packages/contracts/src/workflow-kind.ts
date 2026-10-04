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

import { defineMethodDescriptors, type MethodDescriptor } from "./method-descriptor.js";
import { WorkflowNodeKindIdSchema, type WorkflowNodeKindId } from "./workflow-definition.js";

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

const WORKFLOW_HANDLE_TYPES = ["main", "tool"] as const;

/** What a handle carries: items on `main`, a capability an agent can call on `tool`. */
export type WorkflowHandleType = (typeof WORKFLOW_HANDLE_TYPES)[number];

/**
 * One handle a kind declares. Its id reads `<mode>/<type>/<index>`, so a handle is
 * addressable from a stored edge alone.
 */
export interface WorkflowHandleSpec {
  id: string;
  label: string;
  type: WorkflowHandleType;
  maxConnections?: number | undefined;
  required?: boolean | undefined;
}
const WorkflowHandleSpecSchema: z.ZodType<WorkflowHandleSpec> = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    type: z.enum(WORKFLOW_HANDLE_TYPES),
    maxConnections: z.number().int().positive().optional(),
    required: z.boolean().optional(),
  })
  .strict();

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
  "session",
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
  inputs: WorkflowHandleSpec[];
  outputs: WorkflowHandleSpec[];
  outputsDeriveFromParams: boolean;
  params: WorkflowParamSpec[];
  perItem?: boolean | undefined;
  capabilities?:
    | { cancelable: boolean; resumable: boolean; sideEffects: "none" | "local" | "external" }
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
    inputs: z.array(WorkflowHandleSpecSchema),
    outputs: z.array(WorkflowHandleSpecSchema),
    outputsDeriveFromParams: z.boolean(),
    params: z.array(WorkflowParamSpecSchema),
    // True where the kind runs once per item rather than once over all of them.
    perItem: z.boolean().optional(),
    capabilities: z
      .object({
        cancelable: z.boolean(),
        resumable: z.boolean(),
        sideEffects: z.enum(["none", "local", "external"]),
      })
      .strict()
      .optional(),
  })
  .strict();

/** `workflow.kindList` takes no members. */
export type WorkflowKindListRequest = Record<string, never>;
/** Wire schema for {@link WorkflowKindListRequest}. */
export const WorkflowKindListRequestSchema: z.ZodType<
  WorkflowKindListRequest,
  WorkflowKindListRequest
> = z.object({}).strict();

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
    WorkflowKindListRequest,
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
      requestSchema: WorkflowKindListRequestSchema,
      responseSchema: WorkflowKindListResponseSchema,
    },
  });
