// The tools a driver declares and the daemon offers: each tool's metadata and idempotency class,
// and the callback tools the daemon serves the model. A shape is a Zod schema only where it parses
// untrusted provider output.
import { z } from "zod";

import { wireFreeFormString } from "../../free-form-string.js";
import { DRIVER_TOOL_DESCRIPTION_MAX_LEN, DRIVER_TOOL_NAME_MAX_LEN } from "./caps.js";

const IDEMPOTENCY_CLASS_VALUES = ["idempotent", "compensable", "manual_reconcile_only"] as const;

/**
 * A tool's declared idempotency: safe to repeat, undoable, or needing a person to reconcile.
 * Shown per tool on Settings › MCP servers; a daemon restart runs no call again, whatever its
 * class.
 */
export type IdempotencyClass = (typeof IDEMPOTENCY_CLASS_VALUES)[number];

/** Every {@link IdempotencyClass}, safest to repeat first. */
export const IDEMPOTENCY_CLASSES: readonly IdempotencyClass[] = IDEMPOTENCY_CLASS_VALUES;

/**
 * Validates an {@link IdempotencyClass}. Typed double-`T` so its input stays the class, not
 * `unknown`, when `ProviderToolMetadataSchema` composes it with a default.
 */
export const IdempotencyClassSchema: z.ZodType<IdempotencyClass, IdempotencyClass> =
  z.enum(IDEMPOTENCY_CLASS_VALUES);

/**
 * Ingress shape of a tool a driver declares via `getCapabilities()`. `idempotency_class` is
 * optional: an undeclared class is not a contract violation.
 */
export interface ProviderToolMetadata {
  name: string;
  idempotency_class?: IdempotencyClass | undefined;
  description?: string | undefined;
}

/**
 * Daemon-side tool shape after the `manual_reconcile_only` default is applied. Its required
 * `idempotency_class` keeps an un-normalized value out of the NOT NULL
 * `driver_tools.idempotency_class` column; only this shape crosses the persistence boundary.
 */
export interface NormalizedProviderToolMetadata {
  name: string;
  idempotency_class: IdempotencyClass;
  description?: string | undefined;
}

/**
 * Validates and normalizes a declared tool: an omitted `idempotency_class` becomes
 * `manual_reconcile_only`, and unknown keys are stripped, not refused, because providers extend
 * the declaration.
 */
export const ProviderToolMetadataSchema: z.ZodType<
  NormalizedProviderToolMetadata,
  ProviderToolMetadata
> = z.object({
  name: wireFreeFormString(DRIVER_TOOL_NAME_MAX_LEN, "ProviderToolMetadata.name"),
  idempotency_class: IdempotencyClassSchema.optional().default("manual_reconcile_only"),
  description: wireFreeFormString(
    DRIVER_TOOL_DESCRIPTION_MAX_LEN,
    "ProviderToolMetadata.description",
  ).optional(),
});

/**
 * A tool the daemon offers the model: a name, a description and a JSON Schema input. Every call
 * goes through the daemon's approval pipeline and lands as an ordinary `tool_activity` row.
 */
export interface SessionCallbackTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
