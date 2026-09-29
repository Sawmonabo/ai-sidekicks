// Error contracts — the wire error envelopes and their codes.
//
// The resource-limit shape:
//   • resource.limit_exceeded — fired when a request would take a counted
//     resource past its configured limit.
//
//   {code: "resource.limit_exceeded",
//    message: "...",
//    details: {resource, limit, current}}
//
// `details.resource` is the human-readable name of the limit that tripped
// (e.g. "users per session"); `limit` is the configured ceiling and
// `current` is the count that triggered the rejection. All three are
// REQUIRED — the daemon and control-plane both populate them, and the
// SDK's retry/backoff logic relies on `current >= limit` invariants
// (validated downstream).
//
// The PTY backend shape:
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
import { z } from "zod";

import { SessionIdSchema, wireFreeFormString, type SessionId } from "./session.js";

// --------------------------------------------------------------------------
// Error code constants
// --------------------------------------------------------------------------
//
// Exported as a `const` literal so consumers (daemon, control-plane, SDK)
// can compare against the typed value rather than the bare string. Adding
// new codes is opt-in — only owns this one.

export type ResourceLimitExceededCode = "resource.limit_exceeded";
export const RESOURCE_LIMIT_EXCEEDED_CODE: ResourceLimitExceededCode = "resource.limit_exceeded";

// PtyBackendUnavailable uses a PascalCase code literal (deliberate divergence
// from the dotted `resource.limit_exceeded` style above). The literal value
// is fixed — downstream daemon throwers and SDK consumers compare against
// this exact string. New dotted-style codes added in subsequent plans should
// not depend on this one.
export type PtyBackendUnavailableCode = "PtyBackendUnavailable";
export const PTY_BACKEND_UNAVAILABLE_CODE: PtyBackendUnavailableCode = "PtyBackendUnavailable";

// Daemon append-path refusal codes. All are raised by
// `EventLogService.append` and all carry TYPED details: each detail member is a
// non-secret identifier or size the caller supplied, so structured details
// add no info-leak surface. Domain token `daemon` matches the local runtime
// daemon's own authority — these refusals originate in the machine-local
// append path, never in a control-plane method..
//
// They differ in KIND, which is why they carry different statuses:
//
//   * `daemon.ingest_halted` (409) — a STATE-dependent refusal of an
//     otherwise-valid write. The write is well-formed; the session's
//     ingest is administratively halted (key-reuse observer published
//     `halt(sessionId)` through the `IngestHaltRegistry`). Re-admission
//     is possible without changing the write, via `clear(sessionId)` —
//     hence the 409 shape shared with `run.invalid_transition`.
//   * `daemon.pii_split_bypass` (400) — a STRUCTURAL refusal. The write
//     is malformed regardless of session state: its `payload` carries a
//     PII-tagged field with no `pii_ciphertext_digest`, meaning it
//     bypassed `pii-indirection.ts` sole-write-path split. No session
//     state change makes it admissible; the producer must fix the
//     write.
//
//   * No session-state change makes it admissible; the producer moves bulk
//     content behind a reference (the payload catalog
//     is metadata-shaped by construction, so an append near the bound is a
//     payload-design defect).
//
// None is the `daemon.pii_split_ambiguous` TAXONOMY EVENT — that event
// signals a SUCCESSFUL containment fallback (an ambiguous record routed
// wholesale into `pii_payload`), never a failed write.
export type DaemonIngestHaltedCode = "daemon.ingest_halted";
export const DAEMON_INGEST_HALTED_CODE: DaemonIngestHaltedCode = "daemon.ingest_halted";
export type DaemonPiiSplitBypassCode = "daemon.pii_split_bypass";
export const DAEMON_PII_SPLIT_BYPASS_CODE: DaemonPiiSplitBypassCode = "daemon.pii_split_bypass";
export type DaemonEventCanonicalBytesExceededCode = "daemon.event_canonical_bytes_exceeded";
export const DAEMON_EVENT_CANONICAL_BYTES_EXCEEDED_CODE: DaemonEventCanonicalBytesExceededCode =
  "daemon.event_canonical_bytes_exceeded";

// Event-read cursor refusal code. Registered at 400 — an `EventCursor`
// submitted to `readAfterCursor` / `readWindow` that `decodeEventCursor`
// cannot resolve to a log position (a non-integer, a value `< -1`, a legacy
// SDK-synthesized UUID) predecessor-position cursor model.
//
// Exported HERE rather than spelled at each end because the daemon raises it and
// the desktop console classifies on it, and a wire string with one home on each
// side of the wire is a string that can drift on one side without the other
// failing to compile. It carries no `*Schema`: the registration is code+message
// only, so what this constant ships is the EXACT literal both ends compare against.
export type EventCursorUnresolvableCode = "event.cursor_unresolvable";
export const EVENT_CURSOR_UNRESOLVABLE_CODE: EventCursorUnresolvableCode =
  "event.cursor_unresolvable";

// --------------------------------------------------------------------------
// Per-field length caps — defense-in-depth bounds (see also event.ts header).
// --------------------------------------------------------------------------
//
// The HTTP/tRPC framework layer (005) is authoritative on body size;
// these caps are a SECOND line of defense for non-HTTP callers.
//
//   • RESOURCE_LABEL_MAX_LEN (128) — `details.resource` label..
//   • ERROR_MESSAGE_MAX_LEN (8192) — top-level `message` field. 8 KiB is
//     well above any human-readable error message but still bounded.

export const RESOURCE_LABEL_MAX_LEN = 128;
export const ERROR_MESSAGE_MAX_LEN = 8192;

// `daemon.pii_split_bypass` `details.fieldPath` cap. The value is a payload
// KEY PATH (e.g. `payload.pii_user_id`), never a payload VALUE — the
// whole point of naming the path is to identify the offending field without
// echoing PII back onto the wire. Real key paths are short; 256 leaves room
// for a nested path while denying a malicious producer unbounded space in a
// field that lands in operator logs.
export const PII_FIELD_PATH_MAX_LEN = 256;

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
    // Free-form resource label (e.g. "users per session", "agents per
    // session"). The `wireFreeFormString` helper applies the length cap
    // (128) AND the whitespace-only / NUL-byte rejection — same
    // trust-boundary rationale as `EventEnvelope.id` and `identityHandle`
    // (see session.ts for full rationale).
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
// cannot be constructed.
//   1. Sidecar binary missing on disk AND `node-pty` fallback also
//      unavailable ("Sidecar binary missing on user machine"). This is
//      the primary V1 failure mode.
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
    // layer (005); these caps are a SECOND line of defense for non-HTTP
    // callers (daemon-internal IPC, structured logs).
    message: wireFreeFormString(ERROR_MESSAGE_MAX_LEN, "PtyBackendUnavailable.message"),
    details: PtyBackendUnavailableDetailsSchema,
  })
  .strict();

// --------------------------------------------------------------------------
// --------------------------------------------------------------------------
//
// The DETAIL CARRIER for the append path's ingest-halt refusal. `EventLogService`
// throws a `DaemonDomainError` whose `detail` is a value PARSED through this
// schema, which the daemon's `mapJsonRpcError` then projects as
// `data.fields.sessionId` beside `data.type`. Parsing (rather than casting) at
// the throw site is what makes the detail load-bearing: a detail-LESS throw
// yields `data.fields === undefined` and fails arm that pins the rendered shape.
//
// Only `sessionId`, and `.strict()`. The refused session id is information the
// caller ALREADY supplied — echoing it leaks nothing — whereas any additional
// member (the colliding key id, the observer's evidence, a halt reason) would
// describe daemon-internal audit state to a caller that failed a write. Strict
// mode is the enforcement: a future well-meaning `reason` addition fails the
// parse here instead of silently reaching the wire.

// Declared as an object TYPE ALIAS, not an `interface`, and the difference is
// load-bearing rather than stylistic. TypeScript grants a type alias of an
// object type an implicit index signature and grants an interface none, so only
// the alias form is assignable to `Record<string, unknown>` — which is exactly
// what the daemon's `DaemonDomainError.detail` field requires. Flipping either
// of these two to `interface` stops the throw sites compiling, which is the
// enforcement that keeps this comment true. (The older `*Details` shapes in this
// file are interfaces because nothing passes them as a `detail`; these two do.)
export type DaemonIngestHaltedDetails = {
  sessionId: SessionId;
};
export const DaemonIngestHaltedDetailsSchema: z.ZodType<DaemonIngestHaltedDetails> = z
  .object({
    // `SessionIdSchema`-typed, NOT a free-form string: the refusal names a real
    // session, so the wire value carries the same UUID guarantee every other
    // session-scoped field does. This also admits the RFC 9562 Max UUID
    // daemon-scope sentinel (`DAEMON_SCOPE_SENTINEL_SESSION_ID` in event.ts) with
    // no carve-out, so a halt refusal on the node-scope chain renders identically.
    sessionId: SessionIdSchema,
  })
  .strict();

// --------------------------------------------------------------------------
// --------------------------------------------------------------------------
//
// The DETAIL CARRIER for the append path's PII-split-bypass refusal. Same
// parse-at-throw-site discipline as the halt detail above.
//
// `fieldPath` is a payload KEY PATH — `payload.pii_user_id`, say — and
// NEVER the offending field's VALUE. That distinction is the entire security
// property of this error: the write was refused precisely BECAUSE it carried
// unencrypted PII outside the `pii-indirection.ts` split, so echoing the value
// into an error envelope (which lands in operator logs and client consoles)
// would complete the leak the refusal exists to prevent. Nothing in the type
// system can enforce "path, not value" — the guarantee lives at the throw
// sites, which construct the path from a reserved key CONSTANT rather than from
// payload contents.

// Object TYPE ALIAS for the same reason as its sibling above — it is passed as
// a `DaemonDomainError.detail`, which demands `Record<string, unknown>`
// assignability that an `interface` does not provide.
export type DaemonPiiSplitBypassDetails = {
  fieldPath: string;
};
export const DaemonPiiSplitBypassDetailsSchema: z.ZodType<DaemonPiiSplitBypassDetails> = z
  .object({
    // `wireFreeFormString` applies the 256-char cap AND the whitespace-only /
    // NUL-byte rejection — the same trust-boundary hardening
    // `details.resource` gets, for the same reason (this string is rendered
    // into logs and client-side error surfaces).
    fieldPath: wireFreeFormString(PII_FIELD_PATH_MAX_LEN, "details.fieldPath"),
  })
  .strict();

// --------------------------------------------------------------------------
// daemon.event_canonical_bytes_exceeded shape
// --------------------------------------------------------------------------
//
// The DETAIL CARRIER for the append path's canonical-size ceiling refusal.
// Both members are SIZES — the measured canonical byte length and the bound
// it exceeded — never payload content, so the details leak nothing of the
// oversized write they refuse. Carrying both lets a producer log exactly how
// far over it was without re-canonicalizing anything.

// Object TYPE ALIAS for the same reason as its siblings above — passed as a
// `DaemonDomainError.detail`, which demands `Record<string, unknown>`
// assignability that an `interface` does not provide.
export type DaemonEventCanonicalBytesExceededDetails = {
  canonicalBytes: number;
  maxCanonicalBytes: number;
};
export const DaemonEventCanonicalBytesExceededDetailsSchema: z.ZodType<DaemonEventCanonicalBytesExceededDetails> =
  z
    .object({
      canonicalBytes: z.number().int().nonnegative(),
      maxCanonicalBytes: z.number().int().positive(),
    })
    .strict();
