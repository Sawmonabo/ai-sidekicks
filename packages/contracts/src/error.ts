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
// Plan-024 Phase 3 adds the second wire-payload shape:
//   • PtyBackendUnavailable — fired by the daemon's `PtyHostSelector` when
//     the requested PTY backend cannot be constructed (sidecar binary
//     missing AND `node-pty` fallback also unavailable, env-var coerces
//     to an unknown backend, or `RustSidecarPtyHost` exhausts its
//     5-failures-per-60s crash-respawn budget). The wire shape is:
//       {code: "PtyBackendUnavailable",
//        message: "...",
//        details: {attemptedBackend, cause?}}
//     where `attemptedBackend` is the closed enum of supported backends
//     (`rust-sidecar` | `node-pty`) and `cause` is the underlying trigger
//     (errno object, missing-binary path string, JSON-RPC error envelope —
//     intentionally `unknown` because the producers are heterogeneous).
//
// Refs: Spec-001 §Resource Limits + §Limit Enforcement (AC8), error-contracts.md
// § Resource (HTTP 429), § Rate Limiting; Plan-024 Phase 3 §F-024-3-02 +
// ADR-019 §Failure Mode Analysis (row "Sidecar binary missing on user machine").
import { z } from "zod";

import { wireFreeFormString } from "./session.js";

// --------------------------------------------------------------------------
// Error code constants
// --------------------------------------------------------------------------
//
// Exported as a `const` literal so consumers (daemon, control-plane, SDK)
// can compare against the typed value rather than the bare string. Adding
// new codes is opt-in — Plan-001 only owns this one.

export type ResourceLimitExceededCode = "resource.limit_exceeded";
export const RESOURCE_LIMIT_EXCEEDED_CODE: ResourceLimitExceededCode = "resource.limit_exceeded";

// PtyBackendUnavailable uses a PascalCase code literal (deliberate divergence
// from the dotted `resource.limit_exceeded` style above). The literal value
// is fixed by Plan-024 §F-024-3-02 acceptance criterion verbatim — downstream
// daemon throwers and SDK consumers compare against this exact string. New
// dotted-style codes added in subsequent plans should not depend on this one.
export type PtyBackendUnavailableCode = "PtyBackendUnavailable";
export const PTY_BACKEND_UNAVAILABLE_CODE: PtyBackendUnavailableCode = "PtyBackendUnavailable";

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
    // get added without a contract bump. The `wireFreeFormString` helper
    // applies the length cap (128) AND the whitespace-only / NUL-byte
    // rejection — same trust-boundary rationale as `EventEnvelope.id` and
    // `identityHandle` (see session.ts for full rationale).
    resource: wireFreeFormString(RESOURCE_LABEL_MAX_LEN, "details.resource"),
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
    // authoritative body-size enforcer. `wireFreeFormString` also rejects
    // whitespace-only / NUL-byte messages — a NUL byte in `message` would
    // truncate downstream observability log lines that quote the error
    // string verbatim.
    message: wireFreeFormString(ERROR_MESSAGE_MAX_LEN, "ResourceLimitExceededError.message"),
    details: ResourceLimitExceededDetailsSchema,
  })
  .strict();

// --------------------------------------------------------------------------
// PtyBackendUnavailable shape
// --------------------------------------------------------------------------
//
// Thrown by the daemon's `PtyHostSelector` when the requested PTY backend
// cannot be constructed. Three trigger sites in Plan-024 Phase 3:
//   1. Sidecar binary missing on disk AND `node-pty` fallback also
//      unavailable (ADR-019 §Failure Mode "Sidecar binary missing on user
//      machine"). This is the primary V1 failure mode.
//   2. The `AIS_PTY_BACKEND` env-var coerces to an unrecognized
//      backend (selector rejects rather than silently falling back).
//   3. `RustSidecarPtyHost` exhausts its 5-failures-per-60s crash-respawn
//      budget (sidecar keeps crashing — give up and surface the failure to
//      the user rather than spin up a respawn loop).
//
// `attemptedBackend` is the closed enum of supported backends — currently
// only `rust-sidecar` and `node-pty`. Adding a third backend requires both
// a contract bump here and a corresponding selector update; the closed
// enum is intentional so consumers (UI banners, diagnostics rendering)
// can switch-exhaustive on the value.
//
// `cause` is `unknown` because producers are heterogeneous: a Rust-side
// spawn errno (NodeJS `SystemError`-shaped object), the missing-binary
// path string from `resolveSidecarBinaryPath`, a JSON-RPC error envelope
// from a crashing sidecar, etc. Consumers SHOULD render `cause` opaquely
// (e.g. `JSON.stringify` for diagnostics) and MUST NOT branch on its
// internal shape — the producers are free to change it without a
// contract bump.

export interface PtyBackendUnavailableDetails {
  attemptedBackend: "rust-sidecar" | "node-pty";
  cause?: unknown;
}
export const PtyBackendUnavailableDetailsSchema: z.ZodType<PtyBackendUnavailableDetails> = z
  .object({
    // Closed enum — intentional. New backends require a contract bump (and
    // a corresponding `PtyHostSelector` update in the daemon). Switch-
    // exhaustive consumers (UI diagnostics, structured-log routers) depend
    // on this being a closed set rather than a free-form string.
    attemptedBackend: z.enum(["rust-sidecar", "node-pty"]),
    // `unknown` is correct: producers are heterogeneous (errno objects,
    // path strings, JSON-RPC error envelopes). `.optional()` makes the
    // KEY omittable (without it, strict-mode would reject envelopes
    // missing the `cause` field) — `z.unknown()` alone would only
    // permit-the-value but still require the key. Consumers MUST NOT
    // branch on `cause`'s internal shape; render opaquely.
    cause: z.unknown().optional(),
  })
  .strict();

export interface PtyBackendUnavailable {
  code: PtyBackendUnavailableCode;
  message: string;
  details: PtyBackendUnavailableDetails;
}
export const PtyBackendUnavailableSchema: z.ZodType<PtyBackendUnavailable> = z
  .object({
    code: z.literal(PTY_BACKEND_UNAVAILABLE_CODE),
    // Same `wireFreeFormString` hardening as `ResourceLimitExceededError`
    // — defense-in-depth length cap, whitespace-only rejection, NUL-byte
    // rejection. Authoritative body-size enforcement is the framework
    // layer (Plan-004/005); these caps are a SECOND line of defense for
    // non-HTTP callers (daemon-internal IPC, structured logs).
    message: wireFreeFormString(ERROR_MESSAGE_MAX_LEN, "PtyBackendUnavailable.message"),
    details: PtyBackendUnavailableDetailsSchema,
  })
  .strict();
