// One tool of an MCP server: its name, the override a person sets on it by facet, and the reading
// of each setting in force with where it came from.
import { z } from "zod";

import { IDEMPOTENCY_CLASSES, type IdempotencyClass } from "../provider/driver/tools.js";
import { DRIVER_TOOL_NAME_MAX_LEN } from "../provider/driver/length-limits.js";
import { wireFreeFormString } from "../free-form-string.js";

const MCP_APPROVAL_MODE_VALUES = ["auto", "prompt", "writes", "approve"] as const;

/** The normalized approval vocabulary a tool override may pin. */
export type McpApprovalMode = (typeof MCP_APPROVAL_MODE_VALUES)[number];
/** Every {@link McpApprovalMode}, in the order the per-tool control offers them. */
export const MCP_APPROVAL_MODES: readonly McpApprovalMode[] = MCP_APPROVAL_MODE_VALUES;
/** Parses an {@link McpApprovalMode}. */
export const McpApprovalModeSchema: z.ZodType<McpApprovalMode, McpApprovalMode> =
  z.enum(MCP_APPROVAL_MODE_VALUES);

/**
 * The interrupted-call classes a person can assign to a tool. The third class,
 * `manual_reconcile_only`, is the floor a tool reads with no assignment, so it is cleared to, never
 * set.
 */
export type McpAssignableIdempotencyClass = Exclude<IdempotencyClass, "manual_reconcile_only">;

/**
 * One tool's override as `mcp.setToolOverride` sets it, by facet; at least one facet is present,
 * and an absent facet is left as it stands. What a tool reads in force is its
 * {@link McpToolReading}.
 */
export interface McpToolOverride {
  toolName: string;
  enabled?: boolean | undefined;
  approvalMode?: McpApprovalMode | undefined;
  idempotencyClass?: McpAssignableIdempotencyClass | undefined;
}

const MCP_TOOL_OVERRIDE_FACET_VALUES = ["enabled", "approvalMode", "idempotencyClass"] as const;

/** One facet of a tool override, as `mcp.clearToolOverride` names the one it clears. */
export type McpToolOverrideFacet = (typeof MCP_TOOL_OVERRIDE_FACET_VALUES)[number];
/** Every {@link McpToolOverrideFacet}, in the order above. */
export const MCP_TOOL_OVERRIDE_FACETS: readonly McpToolOverrideFacet[] =
  MCP_TOOL_OVERRIDE_FACET_VALUES;
/** Parses an {@link McpToolOverrideFacet}. */
export const McpToolOverrideFacetSchema: z.ZodType<McpToolOverrideFacet, McpToolOverrideFacet> =
  z.enum(MCP_TOOL_OVERRIDE_FACET_VALUES);

/**
 * One per-tool value in force, as the daemon resolved it, and where it came from. Under an
 * override it also carries `serverValue`, the server's own value that clearing the override
 * returns to, so a client choosing that value clears the facet rather than setting it.
 */
export type McpToolSetting<OverrideValue, ServerValue = OverrideValue> =
  | { source: "server"; value: ServerValue }
  | { source: "override"; value: OverrideValue; serverValue: ServerValue };

/** Where a tool's value in force comes from: the server's own, or an override set on the page. */
export type McpToolSettingSource = McpToolSetting<unknown>["source"];

/**
 * One tool a binding's server offers, each setting in force and where it came from. The daemon
 * resolves each one from the server's own declaration and the person's override, so a client
 * draws them and works none of them out: an unset approval mode reads the provider's default in
 * the normalized vocabulary, and an unset interrupted-call class reads `manual_reconcile_only`,
 * the only class a server's own reading holds.
 */
export interface McpToolReading {
  toolName: string;
  enabled: McpToolSetting<boolean>;
  approvalMode: McpToolSetting<McpApprovalMode>;
  idempotencyClass: McpToolSetting<McpAssignableIdempotencyClass, "manual_reconcile_only">;
}

/** A tool's name as an override and an event carry it. */
export const McpToolNameSchema: z.ZodString = wireFreeFormString(
  DRIVER_TOOL_NAME_MAX_LEN,
  "McpToolOverride.toolName",
);

const McpAssignableIdempotencyClassSchema: z.ZodType<
  McpAssignableIdempotencyClass,
  McpAssignableIdempotencyClass
> = z.enum(
  IDEMPOTENCY_CLASSES.filter(
    (value): value is McpAssignableIdempotencyClass => value !== "manual_reconcile_only",
  ),
);

/** Parses an {@link McpToolOverride}; an override that sets no facet is refused. */
export const McpToolOverrideSchema: z.ZodType<McpToolOverride, McpToolOverride> = z
  .object({
    toolName: McpToolNameSchema,
    enabled: z.boolean().optional(),
    approvalMode: McpApprovalModeSchema.optional(),
    idempotencyClass: McpAssignableIdempotencyClassSchema.optional(),
  })
  .strict()
  .refine(
    (override) =>
      override.enabled !== undefined ||
      override.approvalMode !== undefined ||
      override.idempotencyClass !== undefined,
    { message: "A tool override sets at least one of enabled, approvalMode or idempotencyClass." },
  );

// One setting's two arms: the server's own value, or an override with the server's value beside it.
const toolSettingSchema = <OverrideValue extends z.ZodType, ServerValue extends z.ZodType>(
  value: OverrideValue,
  serverValue: ServerValue,
) =>
  z.discriminatedUnion("source", [
    z.object({ source: z.literal("server"), value: serverValue }).strict(),
    z.object({ source: z.literal("override"), value, serverValue }).strict(),
  ]);
/** Parses an {@link McpToolReading}. */
export const McpToolReadingSchema: z.ZodType<McpToolReading> = z
  .object({
    toolName: McpToolNameSchema,
    enabled: toolSettingSchema(z.boolean(), z.boolean()),
    approvalMode: toolSettingSchema(McpApprovalModeSchema, McpApprovalModeSchema),
    idempotencyClass: toolSettingSchema(
      McpAssignableIdempotencyClassSchema,
      z.literal("manual_reconcile_only"),
    ),
  })
  .strict();
