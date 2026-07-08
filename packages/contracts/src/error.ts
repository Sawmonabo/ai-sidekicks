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
// Plan-001 T2.3 also ships the version-bound exception envelopes:
//   • VersionFloorExceededError — fired when an attempted version is below
//     a remote peer's accepted floor (ADR-018 §Decision #10). Wire code
//     literal `version.floor_exceeded` is single-sourced from
//     `jsonrpc-negotiation.ts` where it ALSO surfaces as the
//     `DaemonHelloAck.reason` discriminator string — the two surfaces
//     share the same canonical code per BL-103 closure (error-contracts
//     §JSON-RPC Wire Mapping).
//   • VersionCeilingExceededError — symmetric shape for the "attempted
//     version above peer's accepted ceiling" case. Same payload as the
//     floor variant; only the code literal differs.
//
// Both version envelopes share a single `VersionBoundExceededDetails`
// payload: floor and ceiling carry identical fields (`attemptedVersion`
// + `acceptedRange` + optional `upgradePath` guidance). The shared shape
// avoids divergence; the only wire-level difference between the two
// errors is the code literal. No emitter wiring lands in Plan-001 — T2.3
// specifies "Phase 2 ships the wire-shape contracts only" (`Plan-001 §Phase 2 — Contracts Package`);
// Plan-002+ owns the emit sites where version-floor / version-ceiling
// checks happen.
//
// Refs: Spec-001 §Resource Limits + §Limit Enforcement (AC8), error-contracts.md
// § Resource (HTTP 429), § Rate Limiting; Plan-024 Phase 3 §F-024-3-02 +
// ADR-019 §Failure Mode Analysis (row "Sidecar binary missing on user machine");
// ADR-018 §Decision #10 (version-error envelope shapes); Plan-001 T2.3.
import { z } from "zod";

import {
  NEGOTIATION_REASON_CEILING_EXCEEDED,
  NEGOTIATION_REASON_FLOOR_EXCEEDED,
} from "./jsonrpc-negotiation.js";
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

// Version-bound codes — single-sourced from `jsonrpc-negotiation.ts`
// (lines 211-212), where the same strings ALSO surface as
// `DaemonHelloAck.reason` discriminators. Re-exporting via aliases here
// keeps the wire literal in one place — a future code-string change at
// the negotiation site automatically propagates to the error envelope
// schemas below.
//
// Both literals match ADR-018 §Decision #10 verbatim — these are the
// load-bearing identifiers for downstream emitters (Plan-002+) and
// downstream SDK consumers branching on the wire code.
export type VersionFloorExceededCode = typeof NEGOTIATION_REASON_FLOOR_EXCEEDED;
export const VERSION_FLOOR_EXCEEDED_CODE: VersionFloorExceededCode =
  NEGOTIATION_REASON_FLOOR_EXCEEDED;
export type VersionCeilingExceededCode = typeof NEGOTIATION_REASON_CEILING_EXCEEDED;
export const VERSION_CEILING_EXCEEDED_CODE: VersionCeilingExceededCode =
  NEGOTIATION_REASON_CEILING_EXCEEDED;

// Runtime-node refusal codes (Plan-003 Phase 3). These are code+message-only
// (no Details/Schema) per the registry-only 409 convention — no AC needs
// structured details and a conflicting-session-id detail would risk
// cross-session info-leak. Domain token `runtimenode` matches the method
// namespace (runtimenode.attach / runtimenode.capabilityupdate) and deliberately
// AVOIDS the `runtime_node.*` event-name namespace (separator differs) so an
// error code never collides with a durable event name. See error-contracts.md
// §Runtime Node (HTTP 409).
export type RuntimeNodeAttachConflictCode = "runtimenode.attach_conflict";
export const RUNTIME_NODE_ATTACH_CONFLICT_CODE: RuntimeNodeAttachConflictCode =
  "runtimenode.attach_conflict";
export type RuntimeNodeAttachRevokedCode = "runtimenode.attach_revoked";
export const RUNTIME_NODE_ATTACH_REVOKED_CODE: RuntimeNodeAttachRevokedCode =
  "runtimenode.attach_revoked";
// The capability-update coordination-snapshot refresh (runtimenode.capabilityupdate,
// Plan-003 T3.9) raises this single code for BOTH of its refusals: a late update
// against a node with no active attachment (a detach/sweep race), and the I-003-2
// state-context guard (cannot drive `registering -> online` — bringing a node
// online requires a daemon-side capability declaration, which the control plane
// is not the authority for; Spec-003 lines 52/57). One code, two call sites,
// distinct messages — neither leaks another session's identity or the node's
// internal state.
export type RuntimeNodeCapabilityUpdateConflictCode = "runtimenode.capabilityupdate_conflict";
export const RUNTIME_NODE_CAPABILITY_UPDATE_CONFLICT_CODE: RuntimeNodeCapabilityUpdateConflictCode =
  "runtimenode.capabilityupdate_conflict";

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

// Version-bound caps. SemVer-shaped strings comfortably fit in 64 chars
// (longest realistic: "9999.9999.9999-rc.999+build.YYYYMMDDHHMMSS" is
// ~42 chars); 64 leaves head-room for pre-release labels without giving
// a malicious producer infinite-length space. `upgradePath` is the
// human-readable guidance string per ADR-018 §Decision #10 ("...visit
// https://example.com/upgrade") — 512 caps a one-line URL plus a short
// imperative phrase without truncating canonical CDN links.
export const VERSION_STRING_MAX_LEN = 64;
export const VERSION_UPGRADE_PATH_MAX_LEN = 512;

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

// --------------------------------------------------------------------------
// Shared version-bound details (Plan-001 T2.3)
// --------------------------------------------------------------------------
//
// Both `VersionFloorExceededError` and `VersionCeilingExceededError`
// carry this same payload. The fields encode the negotiation context
// the receiver needs to either present a useful UX message or attempt
// a graceful retry against a different version.
//
//   * `attemptedVersion` — the version string the source side tried to
//     negotiate. Wire-string, opaque to this layer (the negotiation
//     surface owns format validation per ADR-018 §Decision #1
//     "MAJOR.MINOR" semver).
//   * `acceptedRange.{min,max}` — the inclusive range the receiver
//     publishes. `min > attemptedVersion` for the floor variant;
//     `max < attemptedVersion` for the ceiling variant. Both endpoints
//     are wire-format strings (same opacity rationale).
//   * `upgradePath` — optional human-readable guidance per ADR-018
//     §Decision #10 ("...visit https://example.com/upgrade"). Producers
//     SHOULD omit when no actionable upgrade path exists (e.g. a
//     pre-release relay refusing a stable build); presence is not
//     wire-required.
//
// Implementation note: the `.object().strict()` shape rejects unknown
// extra keys — a future plan that wants to extend the payload MUST
// declare a new code literal (and thus a new envelope) rather than
// silently widening this shape. This preserves the wire contract's
// closed-set guarantee for consumers branching on the code.

export interface VersionBoundExceededDetails {
  attemptedVersion: string;
  acceptedRange: { min: string; max: string };
  // `upgradePath?: string | undefined` — explicit `| undefined` is
  // required by `exactOptionalPropertyTypes: true` (tsconfig.base.json).
  // Without the union, zod's `ZodOptional` widening surfaces a TS2375
  // assignment mismatch against the `VersionBoundExceededDetailsSchema`
  // shape. The KEY remains omittable on the wire; the value's runtime
  // contract is identical.
  upgradePath?: string | undefined;
}
export const VersionBoundExceededDetailsSchema: z.ZodType<VersionBoundExceededDetails> = z
  .object({
    attemptedVersion: wireFreeFormString(VERSION_STRING_MAX_LEN, "details.attemptedVersion"),
    acceptedRange: z
      .object({
        min: wireFreeFormString(VERSION_STRING_MAX_LEN, "details.acceptedRange.min"),
        max: wireFreeFormString(VERSION_STRING_MAX_LEN, "details.acceptedRange.max"),
      })
      .strict(),
    upgradePath: wireFreeFormString(VERSION_UPGRADE_PATH_MAX_LEN, "details.upgradePath").optional(),
  })
  .strict();

// --------------------------------------------------------------------------
// version.floor_exceeded shape (Plan-001 T2.3, ADR-018 §Decision #10)
// --------------------------------------------------------------------------
//
// Fired by the receiver when the source's `attemptedVersion` is below
// the receiver's accepted floor (`details.acceptedRange.min`). The
// canonical emit site lives in Plan-002+ (e.g. invite-acceptance
// validating a peer's client floor).

export interface VersionFloorExceededError {
  code: VersionFloorExceededCode;
  message: string;
  details: VersionBoundExceededDetails;
}
export const VersionFloorExceededErrorSchema: z.ZodType<VersionFloorExceededError> = z
  .object({
    code: z.literal(VERSION_FLOOR_EXCEEDED_CODE),
    message: wireFreeFormString(ERROR_MESSAGE_MAX_LEN, "VersionFloorExceededError.message"),
    details: VersionBoundExceededDetailsSchema,
  })
  .strict();

// --------------------------------------------------------------------------
// version.ceiling_exceeded shape (Plan-001 T2.3, ADR-018 §Decision #10)
// --------------------------------------------------------------------------
//
// Symmetric to the floor variant — fired when the source's
// `attemptedVersion` is above the receiver's accepted ceiling
// (`details.acceptedRange.max`). Same payload semantics; the code
// literal is the only wire-level difference between the two errors.

export interface VersionCeilingExceededError {
  code: VersionCeilingExceededCode;
  message: string;
  details: VersionBoundExceededDetails;
}
export const VersionCeilingExceededErrorSchema: z.ZodType<VersionCeilingExceededError> = z
  .object({
    code: z.literal(VERSION_CEILING_EXCEEDED_CODE),
    message: wireFreeFormString(ERROR_MESSAGE_MAX_LEN, "VersionCeilingExceededError.message"),
    details: VersionBoundExceededDetailsSchema,
  })
  .strict();
