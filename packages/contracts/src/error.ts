// Wire error envelopes and their codes: `resource.limit_exceeded`, `PtyBackendUnavailable` and
// `event.cursor_unresolvable`.
import { z } from "zod";

import { wireFreeFormString } from "./session.js";

// Error codes are exported as `const` literals so consumers compare against the typed value
// rather than a bare string.

/** Type of {@link RESOURCE_LIMIT_EXCEEDED_CODE}. */
export type ResourceLimitExceededCode = "resource.limit_exceeded";
/** Error code for a request that would take a counted resource past its configured limit. */
export const RESOURCE_LIMIT_EXCEEDED_CODE: ResourceLimitExceededCode = "resource.limit_exceeded";

/** Type of {@link PTY_BACKEND_UNAVAILABLE_CODE}. */
export type PtyBackendUnavailableCode = "PtyBackendUnavailable";
/**
 * Error code for a PTY backend that cannot be constructed. The PascalCase literal is fixed:
 * daemon throwers and SDK consumers compare against this exact string.
 */
export const PTY_BACKEND_UNAVAILABLE_CODE: PtyBackendUnavailableCode = "PtyBackendUnavailable";

/** Type of {@link EVENT_CURSOR_UNRESOLVABLE_CODE}. */
export type EventCursorUnresolvableCode = "event.cursor_unresolvable";
/**
 * Error code for an `EventCursor` that cannot be resolved to a log position. It has one home
 * here because the daemon raises it and the desktop classifies on it; it carries no schema,
 * only this literal.
 */
export const EVENT_CURSOR_UNRESOLVABLE_CODE: EventCursorUnresolvableCode =
  "event.cursor_unresolvable";

// The framework layer is authoritative on body size; these caps are a second line of defense
// for non-HTTP callers.

/** The longest `details.resource` label. */
export const RESOURCE_LABEL_MAX_LEN = 128;
/** The longest top-level error `message`: well above any readable message, still bounded. */
export const ERROR_MESSAGE_MAX_LEN = 8192;

/**
 * The details of {@link ResourceLimitExceededError}: the name of the limit that tripped (such
 * as "users per session"), its configured ceiling and the count that triggered the rejection.
 */
export interface ResourceLimitExceededDetails {
  resource: string;
  limit: number;
  current: number;
}
/** Parses {@link ResourceLimitExceededDetails}; all three members are required. */
export const ResourceLimitExceededDetailsSchema: z.ZodType<ResourceLimitExceededDetails> = z
  .object({
    resource: wireFreeFormString(RESOURCE_LABEL_MAX_LEN, "details.resource"),
    // `current >= limit` is a daemon-side invariant, not a wire rule, so it is not refined here.
    limit: z.number().int().nonnegative(),
    current: z.number().int().nonnegative(),
  })
  .strict();

/** The error a request gets when it would take a counted resource past its limit. */
export interface ResourceLimitExceededError {
  code: ResourceLimitExceededCode;
  message: string;
  details: ResourceLimitExceededDetails;
}
/** Parses a {@link ResourceLimitExceededError}. */
export const ResourceLimitExceededErrorSchema: z.ZodType<ResourceLimitExceededError> = z
  .object({
    code: z.literal(RESOURCE_LIMIT_EXCEEDED_CODE),
    // A NUL byte in `message` would truncate log lines that quote the error verbatim.
    message: wireFreeFormString(ERROR_MESSAGE_MAX_LEN, "ResourceLimitExceededError.message"),
    details: ResourceLimitExceededDetailsSchema,
  })
  .strict();

/**
 * The details of {@link PtyBackendUnavailable}. `attemptedBackend` is a closed set so
 * consumers can switch exhaustively; adding a backend changes this contract and the daemon's
 * selector together. `cause` is `unknown` because producers differ (an errno object, a
 * missing-binary path, a JSON-RPC error envelope): render it opaquely and never branch on its
 * shape.
 */
export interface PtyBackendUnavailableDetails {
  attemptedBackend: "rust-sidecar" | "node-pty";
  cause?: unknown;
}
/** Parses {@link PtyBackendUnavailableDetails}. */
export const PtyBackendUnavailableDetailsSchema: z.ZodType<PtyBackendUnavailableDetails> = z
  .object({
    attemptedBackend: z.enum(["rust-sidecar", "node-pty"]),
    // `.optional()` makes the key omittable; `z.unknown()` alone still requires it.
    cause: z.unknown().optional(),
  })
  .strict();

/**
 * The error the daemon raises when the requested PTY backend cannot be constructed: the sidecar
 * binary and the `node-pty` fallback are both unavailable, the backend setting names an unknown
 * backend, or the Rust sidecar host exhausts its crash-respawn budget.
 */
export interface PtyBackendUnavailable {
  code: PtyBackendUnavailableCode;
  message: string;
  details: PtyBackendUnavailableDetails;
}
/** Parses a {@link PtyBackendUnavailable}. */
export const PtyBackendUnavailableSchema: z.ZodType<PtyBackendUnavailable> = z
  .object({
    code: z.literal(PTY_BACKEND_UNAVAILABLE_CODE),
    message: wireFreeFormString(ERROR_MESSAGE_MAX_LEN, "PtyBackendUnavailable.message"),
    details: PtyBackendUnavailableDetailsSchema,
  })
  .strict();
