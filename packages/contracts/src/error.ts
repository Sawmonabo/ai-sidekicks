// Error contracts — V1 subset of the canonical ErrorResponse envelope per
// docs/architecture/contracts/error-contracts.md.
//
// Plan-001 PR #2 ships the single error shape its acceptance criteria need:
//   • resource.limit_exceeded — fired on every Spec-001 §Resource Limits
//     enforcement (sessions/participants/channels/agents/runs/queue depth).
//
// Spec-001 §Limit Enforcement specifies the wire shape verbatim:
//   {code: "resource.limit_exceeded",
//    message: "...",
//    details: {resource, limit, current}}
//
// `details.resource` is the human-readable name of the limit that tripped
// (e.g. "participants per session"); `limit` is the configured ceiling and
// `current` is the count that triggered the rejection. All three are
// REQUIRED — the daemon and control-plane both populate them, and the
// SDK's retry/backoff logic relies on `current >= limit` invariants
// (validated downstream in Plan-005).
//
// Refs: Spec-001 §Resource Limits + §Limit Enforcement (AC8), error-contracts.md
// § Resource (HTTP 429), § Rate Limiting.
import { z } from "zod";

// --------------------------------------------------------------------------
// Error code constants
// --------------------------------------------------------------------------
//
// Exported as a `const` literal so consumers (daemon, control-plane, SDK)
// can compare against the typed value rather than the bare string. Adding
// new codes is opt-in — Plan-001 only owns this one.

export type ResourceLimitExceededCode = "resource.limit_exceeded";
export const RESOURCE_LIMIT_EXCEEDED_CODE: ResourceLimitExceededCode = "resource.limit_exceeded";

// --------------------------------------------------------------------------
// Per-field length caps — defense-in-depth bounds (see also event.ts header).
// --------------------------------------------------------------------------
//
// The HTTP/tRPC framework layer (Plan-004/005) is authoritative on body
// size; these caps are a SECOND line of defense for non-HTTP callers.
//
//   • RESOURCE_LABEL_MAX_LEN (128) — `details.resource` label. The
//     Spec-001 §Resource Limits table values fit in well under 128 chars
//     (longest current label: "concurrent runs per session").
//   • ERROR_MESSAGE_MAX_LEN (8192) — top-level `message` field. 8 KiB is
//     well above any human-readable error message but still bounded.

export const RESOURCE_LABEL_MAX_LEN = 128;
export const ERROR_MESSAGE_MAX_LEN = 8192;

// --------------------------------------------------------------------------
// resource.limit_exceeded shape
// --------------------------------------------------------------------------

export interface ResourceLimitExceededDetails {
  resource: string;
  limit: number;
  current: number;
}
export const ResourceLimitExceededDetailsSchema: z.ZodType<ResourceLimitExceededDetails> = z
  .object({
    // Free-form resource label (e.g. "participants per session", "agents per
    // session"). The Spec-001 §Resource Limits table is the canonical source
    // of valid values, but the wire format is unconstrained — new resources
    // get added without a contract bump. Length cap (128) is defense in
    // depth (see header).
    resource: z.string().min(1).max(RESOURCE_LABEL_MAX_LEN),
    // Both `limit` and `current` are non-negative integers. `current` is
    // typically `>= limit` at the moment of rejection; we do not encode that
    // as a zod refinement here because the constraint is a daemon-side
    // invariant, not a wire-validation one (a malicious client cannot relax
    // it — and a legitimate test fixture might assert it directly).
    limit: z.number().int().nonnegative(),
    current: z.number().int().nonnegative(),
  })
  .strict();

export interface ResourceLimitExceededError {
  code: ResourceLimitExceededCode;
  message: string;
  details: ResourceLimitExceededDetails;
}
export const ResourceLimitExceededErrorSchema: z.ZodType<ResourceLimitExceededError> = z
  .object({
    code: z.literal(RESOURCE_LIMIT_EXCEEDED_CODE),
    // Length cap (8 KiB) is defense in depth; the framework layer is the
    // authoritative body-size enforcer.
    message: z.string().min(1).max(ERROR_MESSAGE_MAX_LEN),
    details: ResourceLimitExceededDetailsSchema,
  })
  .strict();
