# API Payload Contracts

Typed payload definitions for all named interfaces across all specs. Each contract specifies request shape, response shape, and error shapes using TypeScript/Zod notation.

**Usage:** Implementation agents translate these definitions into Zod schemas in `packages/contracts/src/`. The organization by tier matches the [Canonical Build Order](../cross-plan-dependencies.md).

**Schema reference:** Column types and constraints are in [Local SQLite Schema](../schemas/local-sqlite-schema.md) and [Shared Postgres Schema](../schemas/shared-postgres-schema.md).

---

## Authenticated Principal And Authorization Model

Every control-plane endpoint defined in this document is implicitly scoped to the authenticated caller. Authorization rules — including every Cedar policy evaluation — treat the following as controlling inputs:

- **Principal identity.** The Cedar `principal` is the `sub` claim of the caller's PASETO v4.public access token (a `ParticipantId`). This is the only identity Cedar evaluates. See [RFC 9068 §2.2 — `sub` claim](https://datatracker.ietf.org/doc/html/rfc9068#section-2.2) for the `sub`-as-principal pattern and [ADR-010 PASETO + WebAuthn + MLS Auth](../../decisions/010-paseto-webauthn-mls-auth.md) for the V1 PASETO profile.
- **Proof-of-possession binding.** Each access token carries a DPoP-style confirmation claim (`cnf.jkt`, per [RFC 9449 §3.1 — Public Key Confirmation via Thumbprint](https://datatracker.ietf.org/doc/html/rfc9449#section-3.1)) whose value is the SHA-256 thumbprint of the caller's bound JWK. A token is valid only when accompanied by a DPoP proof signed by the matching private key. `cnf.jkt` is a replay-protection binding — **not** a second principal identity; Cedar never reads it as a `principal` input.
- **Informational body fields.** Any body field that names a participant — `approver`, `inviter`, `requester`, `initiatorId`, `actor`, and equivalents — is routing/audit metadata only. Cedar does **not** read these fields as authorization input. Servers must reject a request when the body-supplied actor disagrees with the verified `sub`, rather than trusting the body.
- **Local-daemon endpoints.** Endpoints reachable only over the daemon's local IPC socket (JSON-RPC 2.0 per [ADR-009 JSON-RPC IPC Wire Format](../../decisions/009-json-rpc-ipc-wire-format.md)) are authorized by socket reachability plus a required 256-bit session token presented by the Desktop Shell or CLI client (per BL-056 reconciliation on 2026-04-18; see [security-architecture.md §Local Daemon Authentication](../security-architecture.md)); they do not require a PASETO access token. The renderer is not a direct daemon client — renderer-originated requests are brokered by the shell via the preload bridge. When a local-daemon request is later forwarded cross-node via dispatch, the target daemon applies the full PASETO + DPoP verification defined above before Cedar runs.
- **Cross-node dispatch.** Cross-node approval envelopes follow [Spec-024 Cross-Node Dispatch And Approval](../../specs/024-cross-node-dispatch-and-approval.md): the Cedar `principal` on the target side is bound only to `caller_token.sub`; `approver_token.sub` is carried for audit and replay-binding via the shared `bound_jti` + `request_body_hash` and does **not** become a second principal.

**See also:** [Security Architecture §Permission Matrix](../security-architecture.md#permission-matrix-task-54), [ADR-010 PASETO + WebAuthn + MLS Auth](../../decisions/010-paseto-webauthn-mls-auth.md), [Cedar terminology — principal, action, resource, context](https://docs.cedarpolicy.com/overview/terminology.html).

---

## Source-of-Truth Policy

This file is the **design surface** for cross-cutting payload contracts — brand types, procedure-type assignments, method-name formats, error envelopes, SSE wire frames, and other shapes that span multiple plans and require ratification before any package implements them. Cross-package consumers reading this file see a single canonical declaration of how the wire surface is shaped.

Package-local typed surfaces are **canonical in code**, not in this file. Examples (non-exhaustive):

- `MethodRegistry` interface — `packages/contracts/src/jsonrpc-registry.ts`
- `LocalSubscriptionProducer<T>` streaming primitive — `packages/contracts/src/jsonrpc-streaming.ts` (the client-side consumer shape is `LocalSubscriptionConsumer<T>` at `packages/client-sdk/src/transport/types.ts`)
- `SecureDefaults` config + effective-settings — `packages/runtime-daemon/src/bootstrap/secure-defaults.ts`
- LSP-style streaming method-name taxonomy (`$/subscription/notify`, `$/subscription/cancel`) — `packages/contracts/src/jsonrpc-streaming.ts`
- `SessionEvent` discriminated-union schema — `packages/contracts/src/event.ts`

This file does **NOT** maintain doc-side mirrors of those types. A consumer searching for the canonical runtime type reads the code path directly; this file's role for those surfaces is to cite the code location and explain cross-cutting consistency, not to redefine them. The Zod schema in code is the source of truth, and divergence between this file's prose and the Zod schema is resolved in favor of the schema.

The "no-mirror" disposition was ratified for [BL-102](../../backlog.md) mirror-class sub-items on 2026-04-30. Cross-cutting decisions that DO require ratification in this file (procedure-type tables, method-name regexes, SSE wire-frame primitives, brand-type catalogs) remain in scope; package-local interface shapes do not.

---

## Branded ID Types

All domain IDs use branded string types for compile-time safety.

```ts
type SessionId = string & { readonly __brand: "SessionId" };
type ParticipantId = string & { readonly __brand: "ParticipantId" };
type MembershipId = string & { readonly __brand: "MembershipId" };
type InviteId = string & { readonly __brand: "InviteId" };
type NodeId = string & { readonly __brand: "NodeId" };
type RunId = string & { readonly __brand: "RunId" };
type ChannelId = string & { readonly __brand: "ChannelId" };
type QueueItemId = string & { readonly __brand: "QueueItemId" };
type InterventionId = string & { readonly __brand: "InterventionId" };
type ArtifactId = string & { readonly __brand: "ArtifactId" };
type WorkspaceId = string & { readonly __brand: "WorkspaceId" };
type WorktreeId = string & { readonly __brand: "WorktreeId" }; // EphemeralCloneId + BranchContextId: §Plan-010 (Tier 6)
type RepoMountId = string & { readonly __brand: "RepoMountId" };
type ApprovalRequestId = string & { readonly __brand: "ApprovalRequestId" };
type WorkflowDefinitionId = string & { readonly __brand: "WorkflowDefinitionId" };
type WorkflowRunId = string & { readonly __brand: "WorkflowRunId" };
type WorkflowPhaseId = string & { readonly __brand: "WorkflowPhaseId" };
type EventCursor = string & { readonly __brand: "EventCursor" };
```

---

## Cross-Cutting: Error Contract (Task 4.1)

All API responses use this error envelope on failure. Partially satisfies BL-026.

```ts
// Canonical error response
interface ErrorResponse {
  code: string; // namespaced: 'session.not_found', 'auth.token_expired', etc.
  message: string; // human-readable description
  details?: Record<string, unknown>; // structured context
}

// Error code namespaces
type ErrorNamespace =
  | "session" // session lifecycle errors
  | "auth" // authentication/authorization
  | "run" // run state machine violations
  | "approval" // approval flow errors
  | "invite" // invite lifecycle errors
  | "membership" // membership/role lifecycle errors
  | "presence" // presence/device-detail authorization errors
  | "workspace" // workspace lifecycle errors; sibling "repo" mount-lifecycle namespace per the canonical registry
  | "artifact" // artifact publication errors
  | "workflow" // workflow execution errors
  | "driver" // provider driver errors
  | "relay" // relay/transport errors
  | "admin" // operator admin-surface errors (admin-bans API, Plan-021)
  | "ratelimit" // rate-limit enforcement errors beyond the 429 envelope (Plan-021)
  | "system"; // internal system errors
// Illustrative V1 subset; `error-contracts.md` is the canonical namespace registry.

// Rate limiting response (Spec-021; canonical 5-field shape per Plan-021 D-021-6 —
// identical in error-contracts.md §Rate Limiting and packages/contracts/src/rate-limiter.ts)
interface RateLimitResponse {
  code: "rate_limited";
  retryAfter?: number; // seconds until retry is allowed — sliding-window/escalation refusals; omitted on concurrency-cap refusals (capacity frees on release; no reset clock — Spec-021 §Overflow Response)
  limit: number; // total allowed requests in the window (the cap itself on concurrency-cap refusals)
  remaining: number; // requests remaining in the current window
  resetAt?: string; // ISO 8601 timestamp when the limit resets — same enforcement-class rule as retryAfter; the pair is both-present or both-absent (schema-refined, Plan-021 T21.1-1)
}
```

---

## Shared Enums

```ts
type SessionState =
  | "provisioning"
  | "active"
  | "archived"
  | "closed"
  | "purge_requested"
  | "purged";
type MembershipRole = "owner" | "viewer" | "collaborator" | "runtime contributor";
type MembershipState = "pending" | "active" | "suspended" | "revoked";
type InviteState = "pending" | "accepted" | "revoked" | "expired";
type PresenceState = "online" | "idle" | "reconnecting" | "offline";
type JoinMode = "viewer" | "collaborator" | "runtime contributor";

type RunState =
  | "queued"
  | "starting"
  | "running"
  | "waiting_for_approval"
  | "waiting_for_input"
  | "paused"
  | "completed"
  | "interrupted"
  | "failed";
type TerminalRunState = "completed" | "interrupted" | "failed";
type BlockingRunState = "waiting_for_approval" | "waiting_for_input" | "paused";
type RunFailureCategory =
  | "provider failure"
  | "transport failure"
  | "local persistence failure"
  | "projection failure";

type QueueItemState = "queued" | "admitted" | "superseded" | "canceled" | "expired";
type InterventionType = "steer" | "interrupt" | "cancel";
type InterventionState = "requested" | "accepted" | "applied" | "rejected" | "degraded" | "expired";

type ApprovalCategory =
  | "tool_execution"
  | "file_write"
  | "network_access"
  | "destructive_git"
  | "user_input"
  | "plan_approval"
  | "mcp_elicitation"
  | "gate"
  | "human_phase_contribution";
type ApprovalDecision = "approved" | "rejected";
type ApprovalState = "pending" | "approved" | "rejected" | "expired" | "canceled";

type NodeState = "registering" | "online" | "degraded" | "offline" | "revoked";
type ExecutionMode = "read-only" | "branch" | "worktree" | "ephemeral clone";
type WorkspaceState = "provisioning" | "ready" | "busy" | "stale" | "archived";
type WorktreeState = "creating" | "ready" | "dirty" | "merged" | "retired" | "failed"; // EphemeralCloneState: §Plan-010 (Tier 6)
type RepoMountState = "attached" | "detached" | "archived"; // VcsType + RepoMountHealth: §Plan-009 (Tier 6)

type ArtifactState = "pending" | "published" | "superseded";
type ArtifactVisibility = "local-only" | "shared";

type ChannelState = "active" | "muted" | "archived";
type DriverCapabilityFlag =
  | "resume"
  | "steer"
  | "interactive_requests"
  | "mcp"
  | "tool_calls"
  | "reasoning_stream"
  | "model_mutation";
```

---

## Tier 1: Plan-001 — Shared Session Core (Task 4.2)

```ts
// SessionCreate
interface SessionCreateRequest {
  config?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}
interface SessionCreateResponse {
  sessionId: SessionId;
  state: SessionState;
  memberships: MembershipSummary[];
  channels: ChannelSummary[];
}

// SessionRead
interface SessionReadRequest {
  sessionId: SessionId;
}
interface SessionReadResponse {
  session: SessionSnapshot;
  timelineCursors: { latest: EventCursor; acknowledged?: EventCursor };
}

// SessionJoin
interface SessionJoinRequest {
  sessionId: SessionId;
  identityHandle: string;
}
interface SessionJoinResponse {
  sessionId: SessionId;
  participantId: ParticipantId;
  membershipId: MembershipId;
  sharedMetadata: Record<string, unknown>;
}

// SessionSubscribe
interface SessionSubscribeRequest {
  sessionId: SessionId;
  afterCursor?: EventCursor;
}
// Response: SSE stream where each event is an EventEnvelope (defined in Tier 4, Plan-006)
type SessionSubscribeStream = AsyncIterable<EventEnvelope>;

// Shared projection types
interface SessionSnapshot {
  id: SessionId;
  state: SessionState;
  config: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface MembershipSummary {
  id: MembershipId;
  participantId: ParticipantId;
  role: MembershipRole;
  state: MembershipState;
}

interface ChannelSummary {
  id: ChannelId;
  name?: string;
  state: ChannelState;
}
```

---

## Tier 1 (cont.): Plan-008 — Plan-008-Bootstrap (control-plane tRPC + SSE substrate)

Plan-008 Phase 1 (Plan-008-bootstrap, Tier 1 carve-out per [`docs/plans/008-control-plane-relay-and-session-join.md`](../../plans/008-control-plane-relay-and-session-join.md) §Execution Windows) wraps Plan-001's `session-directory-service.ts` (Tier 1 above) in a typed [tRPC v11](https://trpc.io/) router served from Cloudflare Workers via [`@trpc/server/adapters/fetch`](https://trpc.io/docs/server/adapters/fetch) per [ADR-014 tRPC Control-Plane API](../../decisions/014-trpc-control-plane-api.md). The Tier 5 Plan-008 surface (relay broker, presence register, invite handoff) lives in §Tier 5 below; this Tier 1 carve-out ratifies the procedure-type assignments, the canonical method-name registry, and the SSE wire-frame primitive that the bootstrap depends on. Closes the `BLOCKED-ON-C6` tags inside Plan-008 §Phase 1 task descriptions T-008b-1-2, T-008b-1-3, and T-008b-1-5.

| tRPC procedure | Procedure type | Input schema (from `packages/contracts/src/session.ts`) | Output schema | Directory-service method called |
| --- | --- | --- | --- | --- |
| `session.create` | `mutation` | `SessionCreateRequestSchema` | `SessionCreateResponseSchema` | `directoryService.createSession(...)` |
| `session.read` | `query` | `SessionReadRequestSchema` | `SessionReadResponseSchema` | `directoryService.readSession(...)` |
| `session.join` | `mutation` | `SessionJoinRequestSchema` | `SessionJoinResponseSchema` | `directoryService.joinSession(...)` |

The procedure-type assignments follow the tRPC convention: read-only operations use `query` (HTTP GET-like, idempotent); writes / state-changes use `mutation` (HTTP POST-like, non-idempotent). Method-name strings are `dotted-camelCase` (`session.create`, `session.read`, `session.join`) per the canonical format ratified in §Tier 1 (cont.): Plan-007 below — the same `dotted-camelCase` convention applies to both Plan-008's tRPC HTTP procedures and Plan-007's JSON-RPC IPC methods so that client SDK call-site shape is symmetric across local IPC and remote control-plane calls. The Tier 1 surface uses all-lowercase segments (`session.create`, `session.read`, `session.join`); within-segment camelCase is permitted in nested namespaces per LSP precedent (e.g. `textDocument.didOpen`, `settings.effectiveRead`).

```ts
// session.create — tRPC mutation
//   Input:  SessionCreateRequest (defined in Tier 1, Plan-001 above)
//   Output: SessionCreateResponse (defined in Tier 1, Plan-001 above)
//   Wraps:  directoryService.createSession(...)

// session.read — tRPC query
//   Input:  SessionReadRequest (defined in Tier 1, Plan-001 above)
//   Output: SessionReadResponse (defined in Tier 1, Plan-001 above)
//   Wraps:  directoryService.readSession(...)

// session.join — tRPC mutation
//   Input:  SessionJoinRequest (defined in Tier 1, Plan-001 above)
//   Output: SessionJoinResponse (defined in Tier 1, Plan-001 above)
//   Wraps:  directoryService.joinSession(...)
//   Tier 1 stub: rejects non-self joins with `auth.not_authorized` until
//   Tier 5 invite/presence land per Plan-008 §I-008-2.

// session.subscribe — tRPC subscription (SSE-backed via @trpc/server/adapters/fetch)
//   Input:  SessionSubscribeRequest (defined in Tier 1, Plan-001 above)
//   Output: AsyncIterable<EventEnvelope> (EventEnvelope defined in Tier 4, Plan-006)
//   tRPC substrate: resolveResponse.ts detects subscription procedures and wraps
//   the async generator into a ReadableStream-backed Response per BL-104 (2026-04-30).
```

### SSE Wire Frame (Tier 1 Ratified)

The wire frame below is the Tier 1 ratified shape, formerly carried inline as `BLOCKED-ON-C6` in Plan-008 §Phase 1 (per F-008b-1-08 SSE primitive scope and F-008b-1-04 Workers reformulation). SSE adapter selection is settled by [BL-104 resolution (2026-04-30)](../../backlog.md): tRPC v11's shared HTTP resolver (`@trpc/server/adapters/fetch` substrate at `packages/server/src/unstable-core-do-not-import/http/resolveResponse.ts` upstream) detects subscription procedures and produces the SSE-streaming `Response` natively when invoked through `fetchRequestHandler` on Cloudflare Workers — no separate SSE adapter is required.

- `Content-Type: text/event-stream; charset=utf-8`
- `Cache-Control: no-store`
- `X-Accel-Buffering: no`
- One `EventEnvelope` per SSE event, encoded as `data: <single-line JSON>` (`JSON.stringify` with no embedded newlines, per [WHATWG HTML §Server-sent events — `data` field](https://html.spec.whatwg.org/multipage/server-sent-events.html#dispatchMessage)).
- `id:` carries the `EventCursor` value from Plan-006 (or a placeholder string at Tier 1 pending Plan-006 widening).
- `retry: 5000` — advisory client retry interval in milliseconds (enforced at `packages/control-plane/src/server/sse-retry-prefix.ts`).
- On reconnect with the `Last-Event-ID` header, the server emits all events strictly after that cursor.
- `event: heartbeat\ndata: {}\n\n` every 15 seconds in the absence of data.

The `EventEnvelopeVersion` brand carried on every emitted envelope is canonical at the Plan-006 definition below — `string & { readonly __brand: "EventEnvelopeVersion" }` per [ADR-018 §Decision #1](../../decisions/018-cross-version-compatibility.md): on the wire it is the semver `"MAJOR.MINOR"` string. This is the **event envelope** version field, distinct from the JSON-RPC handshake `protocolVersion` field discussed in §Tier 1 (cont.): Plan-007 below.

The cross-tier `SessionEvent` discriminated-union surface is closed via [BL-102](../../backlog.md) no-mirror disposition (2026-04-30): the canonical type lives in `packages/contracts/src/event.ts` as a Zod-validated `z.discriminatedUnion("type", [...])`, this file does not maintain a wire-form mirror, and the §Source-of-Truth Policy above governs the relationship.

The Plan-007 JSON-RPC method-name registry sub-item and the `protocolVersion` field-type sub-item are both closed in §Tier 1 (cont.): Plan-007 below — the latter via 2026-05-01 ratification of ISO 8601 `YYYY-MM-DD` date-string form, per [MCP §Architecture overview](https://modelcontextprotocol.io/docs/learn/architecture) precedent. (The prior closure-by-conflation between handshake-`protocolVersion` and the `EventEnvelopeVersion` brand above was rolled back in commit `735b069` (2026-04-30); the two surfaces remain distinct — `EventEnvelopeVersion` is a semver `MAJOR.MINOR` brand on event-envelopes, `protocolVersion` is a date-string on every JSON-RPC request after handshake.)

---

## Tier 1 (cont.): Plan-007 — Plan-007-Partial (local IPC daemon-control)

[Plan-007 Phase 3](../../plans/007-local-ipc-and-daemon-control.md) defines the JSON-RPC IPC surface served by the local runtime daemon to in-tree clients (CLI, desktop renderer). The Plan-007-partial Tier 1 carve-out per [`docs/plans/007-local-ipc-and-daemon-control.md`](../../plans/007-local-ipc-and-daemon-control.md) §Execution Windows ratifies a subset of that surface inline with Plan-001's session-core types. This subsection ratifies (1) the canonical method-name format that [Plan-007 §I-007-9](../../plans/007-local-ipc-and-daemon-control.md) requires the registry to enforce mechanically at `register(method, ...)` call time and (2) the JSON-RPC handshake `protocolVersion` field type. The remaining Plan-007 sub-items are: (a) `MethodRegistry` runtime shape per F-007p-2-03 — closed via [BL-102](../../backlog.md) no-mirror disposition (2026-04-30); canonical source: `packages/contracts/src/jsonrpc-registry.ts`. (b) `LocalSubscriptionProducer<T>` shape per F-007p-3-02 — closed via [BL-102](../../backlog.md) no-mirror disposition (2026-04-30); canonical source: `packages/contracts/src/jsonrpc-streaming.ts` (the paired client-side consumer shape `LocalSubscriptionConsumer<T>` lives at `packages/client-sdk/src/transport/types.ts`; rename landed 2026-05-19 via BL-115). (c) `protocolVersion` field type per F-007p-2-01 — **closed via §JSON-RPC Handshake `protocolVersion` Field (Tier 1 Ratified) below (2026-05-01)**: ISO 8601 `YYYY-MM-DD` date-string form, current value `"2026-05-01"`. (d) JSON-RPC error envelope shape per F-007p-2-02 — closed via [BL-103](../../backlog.md) §JSON-RPC Wire Mapping ratification in [error-contracts.md](./error-contracts.md), separate from BL-102.

### JSON-RPC Method-Name Registry (Tier 1 Ratified)

Closes the BL-102 sub-item "JSON-RPC method-name canonical-format registry (`session.create` vs `session/create`)" and feature ID F-007p-3-01.

**Canonical format**: `dotted-camelCase`. Method-name strings match the regex:

```
/^[a-z][a-z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/
```

The regex requires a lowercase-starting first segment (the namespace root); subsequent dot-delimited segments may contain camelCase (`[a-z][a-zA-Z0-9]*`). This adopts the dotted-camelCase _segment_ style of the LSP precedent ([Language Server Protocol §General Messages](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/) — e.g. `workspace.executeCommand`) and the MCP precedent ([Model Context Protocol §Protocol Messages](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) — `tools.list`, `tools.call`), but deliberately **tightens the leading segment to lowercase-only**: LSP's own camelCase-rooted names such as `textDocument.didOpen` are _rejected_ by this regex, because every V1 namespace root is a lowercase identifier — registered or shipped: `session`, `daemon`, `run`, `repo`, `approval`, `participant`, `gdpr`, `runtimenode`, `presence`, `invite`, `membership`, `channel`, plus the Tier-6-ratified Plan-016 roots `orchestration` and `agent`, and the Tier-7-ratified Plan-011 root `gitflow`; still-planned: `driver`, `settings`, `event`, `artifact` (root set re-derived during the Tier-6 audit, gitflow added during the Tier-7 audit; `invite`/`membership`/`channel` are SDK-declared daemon-as-gateway strings owned by Plan-002, bridged server-side to control-plane tRPC). The V1 Tier 1 surface (`session.create`, `session.read`, `session.join`, `session.subscribe`) uses all-lowercase segments; nested-namespace operations like `settings.effectiveRead` and `driver.listCapabilities` (lowercase root + camelCase tail) are permitted under this regex.

The regex accepts the Tier 1 surface and rejects:

- `session/create` — slash-style (visually conflated with HTTP path segments; ambiguous in JSON-RPC contexts where method names appear in the JSON `method` field, not URLs).
- `SessionCreate` — PascalCase (collides with the project's TypeScript type-name convention; `SessionCreate` is already a request-payload type symbol per `packages/contracts/src/session.ts`, so a string-form would be ambiguous at every call site).
- `sessionCreate` — bare camelCase without a namespace dot (cannot express the namespace/operation split without a convention-internal delimiter; doesn't scale to nested namespaces).

**Method-name table** (Plan-007 Phase 3 surface, per F-007p-3-01):

| Method | Procedure type | Notes |
| --- | --- | --- |
| `session.create` | RPC (request/response) | Materialize new session row + emit `SessionCreated`. |
| `session.read` | RPC (request/response) | Resolve session by id. |
| `session.join` | RPC (request/response) | Add member; emit `MembershipCreated`. |
| `session.subscribe` | Long-lived (`LocalSubscriptionConsumer<EventEnvelope>`) | Replay-then-tail event stream. |

**Cross-transport consistency**: This same `dotted-camelCase` format is used by Plan-008's tRPC HTTP procedures (per §Tier 1 (cont.): Plan-008 above). Both transport surfaces share the convention so that client SDK call-site shape is symmetric across local IPC and remote control-plane calls — `client.session.create({ ... })` reads identically whether the underlying transport is local JSON-RPC over Unix domain socket or tRPC HTTP over the control-plane.

**Register-time enforcement** (closes [Plan-007 §I-007-9](../../plans/007-local-ipc-and-daemon-control.md) `BLOCKED-ON-C6`): the method registry's `register(method, handler)` call MUST evaluate `method` against this regex and throw on mismatch. This is mechanical validation, not human review — out-of-format names cannot reach the dispatcher.

```ts
const METHOD_NAME_FORMAT = /^[a-z][a-z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;

function register(method: string, handler: Handler): void {
  if (!METHOD_NAME_FORMAT.test(method)) {
    throw new Error(`method name "${method}" violates dotted-camelCase canonical format`);
  }
  // ... registry insertion
}
```

The runtime regex check is owed by the Plan-007 substrate at `packages/runtime-daemon/src/ipc/registry.ts:register()`, which imports the canonical regex as the `METHOD_NAME_FORMAT` constant exported from `packages/contracts/src/jsonrpc-registry.ts` (the single source — no per-package re-declaration — per BL-142, 2026-06-21); the `MethodRegistry` interface itself (F-007p-2-03) is likewise canonical in code there per the §Source-of-Truth Policy at the top of this file (closed via [BL-102](../../backlog.md) no-mirror disposition, 2026-04-30).

### JSON-RPC Handshake `protocolVersion` Field (Tier 1 Ratified)

Closes the BL-102 sub-item for the `protocolVersion` field type and feature ID F-007p-2-01. Closes [Plan-007](../../plans/007-local-ipc-and-daemon-control.md) `BLOCKED-ON-C6` markers across the JSON-RPC handshake substrate (`packages/contracts/src/jsonrpc.ts`, `packages/contracts/src/jsonrpc-negotiation.ts`, `packages/runtime-daemon/src/ipc/protocol-negotiation.ts`, and the client-SDK transport surface).

**Canonical format**: ISO 8601 date-string in `YYYY-MM-DD` form. The substrate Zod schema at `packages/contracts/src/jsonrpc-negotiation.ts:ProtocolVersionSchema` MUST be:

```ts
const ProtocolVersionSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
```

**Current value**: `"2026-05-01"` — the ratification date is the V1 protocol version. The daemon's supported set at `packages/runtime-daemon/src/ipc/protocol-negotiation.ts:DAEMON_SUPPORTED_PROTOCOL_VERSIONS` is `["2026-05-01"]` for V1; future revisions advance the date and append to the array.

**Ordering convention**: ISO 8601 date-strings are lexicographically equivalent to chronologically ordered. The `negotiateProtocol` algorithm uses string-sort (`[...].sort().at(-1)!`) for max-version selection, with no separate semver parser. Floor / ceiling discrimination uses the same lex order against the daemon's supported set.

**Rationale**: This project is an AI-agent IPC running `claude-driver` and `codex-driver` provider processes; the [Model Context Protocol (MCP) §Architecture overview](https://modelcontextprotocol.io/docs/learn/architecture) is the closest-analog 2024-2026 convention from Anthropic, and MCP uses date-string `protocolVersion` (e.g. `"2025-06-18"`) for the same handshake semantics. Date-strings encode release date inherently, dodge the semver "v1.5 with no v1.4" ambiguity, and are immediately readable in logs and error reports without a parser.

**Distinction from `EventEnvelopeVersion`**: `protocolVersion` is the JSON-RPC handshake field on every request — it identifies the wire-protocol revision the client and daemon speak. `EventEnvelopeVersion` (per [ADR-018](../../decisions/018-cross-version-compatibility.md), defined in §Tier 4: Plan-006 below) is a semver `MAJOR.MINOR` brand on event envelopes — it identifies the event-data schema revision. The two surfaces are independent and evolve on independent cadences; conflating them was the failure mode rolled back in commit `735b069` (2026-04-30).

---

## Tier 2: Plan-002 — Invite Membership And Presence (Task 4.3)

```ts
// InviteCreate
interface InviteCreateRequest {
  sessionId: SessionId;
  inviter: ParticipantId;
  joinMode: JoinMode;
  expiresAt: string; // ISO 8601
}
interface InviteCreateResponse {
  inviteId: InviteId;
  token: string; // plaintext token for recipient (hashed in DB)
  expiresAt: string;
}

// InviteAccept
interface InviteAcceptRequest {
  token: string;
}
interface InviteAcceptResponse {
  inviteId: InviteId; // the invite consumed (now `accepted`)
  membershipId: MembershipId;
  sessionId: SessionId;
  participantId: ParticipantId;
  role: MembershipRole;
  state: MembershipState; // the activated membership's state (NOT InviteState)
}

// InviteRevoke
interface InviteRevokeRequest {
  sessionId: SessionId;
  inviteId: InviteId;
  reason?: string;
}
interface InviteRevokeResponse {
  inviteId: InviteId;
  state: InviteState; // the invite's lifecycle state (NOT MembershipState)
}

// MembershipUpdate
interface MembershipUpdateRequest {
  membershipId: MembershipId;
  action: "change_role" | "suspend" | "revoke" | "reactivate";
  newRole?: MembershipRole; // required for change_role
}
interface MembershipUpdateResponse {
  membershipId: MembershipId;
  state: MembershipState;
  role: MembershipRole;
  updatedAt: string;
}

// PresenceHeartbeat
interface PresenceHeartbeatRequest {
  participantId: ParticipantId;
  deviceId: string;
  activityState: PresenceState;
  metadata: {
    deviceType: string;
    focusedSessionId: SessionId | null;
    focusedChannelId: ChannelId | null;
    lastActivityAt: string;
    appVisible: boolean;
  };
}
// Response: 204 No Content (fire-and-forget)

// PresenceUpdate (JSON-RPC, local IPC)
interface PresenceUpdateParams {
  sessionId: SessionId;
  awarenessState: Uint8Array; // serialized Yjs Awareness CRDT
}

// PresenceRead (JSON-RPC, local IPC)
interface PresenceReadParams {
  sessionId: SessionId;
}
interface PresenceReadResult {
  participants: Array<{
    participantId: ParticipantId;
    state: PresenceState;
    lastSeen: string;
  }>;
}

// ChannelList — read-only projection of channels in a session (see Spec-002 Interfaces And Contracts).
// Channel creation is handled by Plan-016 (multi-agent channels and orchestration).
interface ChannelListRequest {
  sessionId: SessionId;
}
interface ChannelListResponse {
  channels: Array<{
    id: ChannelId;
    name?: string;
    state: ChannelState;
    participantCount: number;
  }>;
}
```

---

## Tier 3: Plan-003 — Runtime Node Attach (Task 4.4)

```ts
// RuntimeNodeAttach
interface RuntimeNodeAttachRequest {
  sessionId: SessionId;
  participantId: ParticipantId;
  nodeId: NodeId;
  clientVersion: EventEnvelopeVersion; // semver "MAJOR.MINOR" (ADR-018 §Decision #1); validated against sessions.min_client_version — below-floor daemons are admitted read-only, not ejected (ADR-018 §Decision #4 / Plan-003 I-003-1). Comparison is semver-aware (MAJOR.MINOR), not lexicographic.
  capabilities: Record<string, unknown>;
  healthState: "online" | "degraded";
}
interface RuntimeNodeAttachResponse {
  attachmentId: string;
  state: NodeState; // liveness axis (registering|online|degraded|offline|revoked) — UNCHANGED
  readOnly: boolean; // permission axis, orthogonal to state — true iff clientVersion is below the session floor (DERIVED from stored client_version vs sessions.min_client_version, never a NodeState value). A node may be online + readOnly.
  attachedAt: string;
}

// RuntimeNodeHeartbeat
interface RuntimeNodeHeartbeatRequest {
  nodeId: NodeId;
  healthState: "online" | "degraded";
}
// Response: null — over tRPC, HTTP 200 with { result: { data: null } } (resolver returns null, not a 204); over JSON-RPC, result: null (RuntimeNodeHeartbeatResponseSchema = z.null())

// RuntimeNodeCapabilityUpdate
interface RuntimeNodeCapabilityUpdateRequest {
  nodeId: NodeId;
  capabilities: Record<string, unknown>;
  healthChanges?: { state: "online" | "degraded"; reason?: string }; // self-reported capability-health — the SAME 2-value RuntimeNodeHealthState axis as attach/heartbeat above (Spec-003 §Default-Behavior capabilityupdate amendment, 2026-06-04). A daemon self-reports only its own capability-health; offline is server-derived liveness-death (the staleness sweep, Plan-003 T3.6) and revoked is an authority-issued trust decision (detach/admin, Plan-003 T3.7) — neither is daemon-self-reportable, so both are unrepresentable here. The request narrows to the 2-value health axis; the response state below stays the broad server-derived NodeState liveness projection — the asymmetry is intentional (daemon asserts narrow, server reports broad).
}
interface RuntimeNodeCapabilityUpdateResponse {
  nodeId: NodeId;
  state: NodeState; // liveness axis (registering|online|degraded|offline|revoked) — UNCHANGED: the server-derived liveness position the control plane owns (request→response narrow/broad asymmetry is intentional)
  updatedAt: string;
}

// RuntimeNodeDetach
interface RuntimeNodeDetachRequest {
  nodeId: NodeId;
  reason?: string;
}
// Response: null — over tRPC, HTTP 200 with { result: { data: null } } (resolver returns null, not a 204); over JSON-RPC, result: null (RuntimeNodeDetachResponseSchema = z.null())

// RuntimeNodeRoster — control-plane tRPC ONLY (the namespace's first query; no daemon JSON-RPC
// registration — the roster is control-plane-owned cross-node state, a daemon knows only itself).
// Added 2026-06-09 (PR #150, user-directed Plan-003 Phase 5 scope expansion); pinned in
// Spec-003 §Interfaces And Contracts (2026-06-09 amendment).
interface RuntimeNodeRosterRequest {
  sessionId: SessionId;
}
interface RuntimeNodeRosterEntry {
  nodeId: NodeId;
  participantId: ParticipantId;
  state: NodeState; // slot axis — all five values verbatim (registering|online|degraded|offline|revoked); the read hides nothing (faithful projection — Spec-003 AC2 needs degraded/offline visible)
  healthState: "online" | "degraded" | "offline" | null; // liveness axis — runtime_node_presence.health_state carried VERBATIM (the 3-value sweep-owned enum, NOT the 2-value wire self-report); NULL until the node's first heartbeat lands (LEFT JOIN — no presence row yet). The read NEVER derives staleness: the Plan-003 T3.6 sweep is the single liveness-derivation writer.
  lastHeartbeatAt: string | null; // runtime_node_presence.last_heartbeat_at verbatim; NULL until the first heartbeat
  readOnly: boolean; // DERIVED per row at read time from the stored client_version vs sessions.min_client_version (NULL floor → false) — identical semantics to the attach-time verdict (the persisted client_version column exists to make this verdict auditable + roster-displayable, per shared-postgres-schema.md)
  capabilities: Record<string, unknown>;
  clientVersion: EventEnvelopeVersion;
  attachedAt: string;
}
interface RuntimeNodeRosterResponse {
  nodes: RuntimeNodeRosterEntry[]; // one entry per runtime_node_attachments row for the session — bounded by distinct nodes ever attached (UNIQUE(node_id, session_id)); both health axes carried verbatim, never collapsed into one scalar (reconciliation is the CLIENT's render-time concern — the Spec-003 line-72 never-mask stance)
}
```

### Runtime-Node Method-Name Registry (Tier 3)

Plan-003's runtime-node operations are exposed as five methods — four state-changing operations plus one roster read (`runtimenode.roster`, added 2026-06-09 by the user-directed Plan-003 Phase 5 scope expansion, PR #150). Method-name strings are `dotted-camelCase` per the canonical `METHOD_NAME_FORMAT` ratified in §Tier 1 (cont.): Plan-007 above (the `register(method, …)` guard at the regex constant) — the same convention shared across Plan-007's JSON-RPC daemon IPC (mechanically regex-enforced at register time) and Plan-008's tRPC control-plane procedures, so the SDK call-site shape (`client.runtimenode.attach({ … })`) is symmetric across transports. Plan-003 registers the four mutation handlers under the Plan-007-partial daemon IPC substrate, and the same four also cross the Plan-008 control-plane transport as `runtimenode.*` tRPC procedures the sibling `runtimeNodeRouter` mounts (Plan-003 T3.8); `runtimenode.roster` is **control-plane tRPC ONLY** (Plan-003 T5.0c) — the roster is control-plane-owned cross-node state (a daemon knows only itself), so the read deliberately does not ride the daemon JSON-RPC transport the four mutations share. The registry table below is the canonical source for both transports (per [Plan-003 §Dependencies](../../plans/003-runtime-node-attach.md)).

The `runtimenode` namespace token is the concatenated domain noun — distinct from the `runtime_node.*` **event** taxonomy (the 7 lifecycle events in [Spec-006 §Runtime Node Lifecycle](../../specs/006-session-event-taxonomy-and-audit-log.md)). The underscore `runtime_node.*` form is a valid _event_ name but is **rejected** as a _method_ name by `METHOD_NAME_FORMAT` (no underscores). `runtimenode.capabilityupdate` is the system's first multi-word procedure: it uses an all-lowercase run-on form within the `dotted-camelCase` regex (the regex permits camelCase in tail segments — `runtimenode.capabilityUpdate` would also be legal — but Plan-003 chose the run-on style to match the uniform single-verb arity of the `session.*` surface; the regex also permits a 3-segment `noun.sub.verb` form, reserved for a future nested-router need).

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `runtimenode.attach` | `mutation` | `RuntimeNodeAttachRequest` | `RuntimeNodeAttachResponse` |
| `runtimenode.heartbeat` | `mutation` | `RuntimeNodeHeartbeatRequest` | `null` — HTTP 200 `{ result: { data: null } }` (tRPC) / `result: null` (JSON-RPC); `RuntimeNodeHeartbeatResponseSchema` (`z.null()`) |
| `runtimenode.capabilityupdate` | `mutation` | `RuntimeNodeCapabilityUpdateRequest` | `RuntimeNodeCapabilityUpdateResponse` |
| `runtimenode.detach` | `mutation` | `RuntimeNodeDetachRequest` | `null` — HTTP 200 `{ result: { data: null } }` (tRPC) / `result: null` (JSON-RPC); `RuntimeNodeDetachResponseSchema` (`z.null()`) |
| `runtimenode.roster` | `query` | `RuntimeNodeRosterRequest` | `RuntimeNodeRosterResponse` — control-plane tRPC ONLY (no daemon JSON-RPC registration; added 2026-06-09, PR #150) |

The four dual-transport methods (`attach`/`heartbeat`/`capabilityupdate`/`detach`) are `mutation`s (state-changing, non-idempotent) per the tRPC procedure-type convention in §Tier 1 (cont.): Plan-008 above; `runtimenode.roster` is the namespace's first — and only — `query` (an idempotent read: it projects the `runtime_node_attachments` × `runtime_node_presence` coordination records and writes nothing, so it authors no durable `runtime_node.*` event and does not collide with the [ADR-017 §Server-Derived Runtime-Node Lifecycle Events](../../decisions/017-shared-event-sourcing-scope.md#server-derived-runtime-node-lifecycle-events) V1.1 gate, which governs durable event authorship, not coordination-record reads), and it is mounted on the control-plane transport only (Plan-003 T5.0c). The request/response shapes are the interfaces defined directly above; the canonical Zod schemas live in `packages/contracts/` per the §Source-of-Truth Policy. `heartbeat` and `detach` carry a `null` response payload, not an empty `204` body: their resolvers return `null`, which tRPC serializes as an ordinary HTTP 200 success envelope `{ result: { data: null } }` (the control-plane router uses the default transformer, so there is no `data.json` wrapper). This matters because the SDK's `parseTrpcResult` calls `response.json()` on every 2xx response — a `204` with an empty body would throw `SyntaxError`, whereas `{ result: { data: null } }` parses cleanly and `z.null()` validates the extracted `null`. Over the JSON-RPC daemon transport — where JSON-RPC 2.0 requires a `result` member on success — they return `result: null`. Both transports are validated by the canonical `RuntimeNodeHeartbeatResponseSchema` / `RuntimeNodeDetachResponseSchema` (`z.null()`), so the SDK's `JsonRpcClient.call` (daemon) and the tRPC client both have a concrete result schema to pass (Plan-003 T1.3 / T4.1).

---

## Tier 4: Plans 005, 006, 007 (Task 4.5)

### Plan-005 — Provider Driver Contract (Internal Interface)

```ts
// Internal driver interface. Two kinds of nominal-TypeScript surface ship here. (a) The
// daemon-CONSTRUCTED param types (`CreateSessionParams` … `ApplyInterventionParams` + the
// intervention payloads) are genuinely trusted — the daemon constructs them in-process.
// (b) The driver-CONSTRUCTED returns — the capability flags, `DriverCapabilities`,
// `GetCapabilitiesResult`, `ProviderSessionHandle`, and `ProviderModel`/`ProviderMode` — are
// normalized at the Plan-005 Phase-3 driver boundary (the driver, daemon-owned code, parses
// raw provider output there) and returned to the daemon as already-trusted normalized values,
// so they ship nominal by design and are not re-parsed at this contract layer. Their persisted
// free-form fields (`DriverCapabilities.contractVersion`, `ProviderSessionHandle.resumeHandle`)
// are bounded at the Plan-005 Phase-2 write seam (semver / non-empty + length + NUL), not here.
// Zod validates ONLY the surfaces that parse UNTRUSTED
// provider output (the trust boundary): the result envelopes `DriverInterventionResult` and
// `DriverResumeResult`, and provider-declared `ProviderToolMetadata`.
// `resumeSession` returns the `DriverResumeResult` discriminated union (defined below)
// to make silent-replacement structurally inexpressible per Spec-005:60.
// `getCapabilities` returns the `GetCapabilitiesResult` wrapper (defined below) so the
// per-tool `ProviderToolMetadata[]` rides alongside the flag matrix in a single
// round-trip per Plan-005 Phase 4 ratified design.
// Within the Zod-validated surfaces, `ProviderToolMetadata` STRIPS unknown keys (Spec-005:55
// forward-compat: "Unknown capability fields are ignored until the driver contract version
// explicitly supports them"), while the result envelopes reject unknown keys (`.strict()`);
// and all five untrusted provider-output free-form strings (`ProviderToolMetadata.name`/`.description`,
// `DriverInterventionResult.fallbackAction`, `DriverResumeResult.bindingId`/`.providerFailureDetail`)
// are runtime-bounded (length + non-whitespace + NUL-rejection) via the package's `wireFreeFormString`
// helper — Zod constraints not expressible in these TS interface shapes.
interface ProviderDriver {
  createSession(params: CreateSessionParams): Promise<ProviderSessionHandle>;
  resumeSession(params: ResumeSessionParams): Promise<DriverResumeResult>;
  startRun(params: StartRunParams): Promise<void>;
  interruptRun(params: InterruptRunParams): Promise<void>;
  applyIntervention(params: ApplyInterventionParams): Promise<DriverInterventionResult>;
  respondToRequest(params: RespondToRequestParams): Promise<void>;
  closeSession(params: CloseSessionParams): Promise<void>;
  listModels(): Promise<ProviderModel[]>;
  listModes(): Promise<ProviderMode[]>;
  getCapabilities(): Promise<GetCapabilitiesResult>;
}

interface CreateSessionParams {
  sessionId: SessionId;
  config: Record<string, unknown>;
}

interface ResumeSessionParams {
  sessionId: SessionId;
  resumeHandle: string; // opaque provider-owned handle
}

interface StartRunParams {
  runId: RunId;
  channelId: ChannelId;
  agentConfig: Record<string, unknown>;
  conversationHistory?: unknown[];
}

interface InterruptRunParams {
  runId: RunId;
  reason?: string;
}

// Discriminated union over `type` — each intervention type coupled to its payload
// shape. `expectedRunVersion` is the MANDATORY fail-closed comparand (Plan-004
// D-004-2) repeated on every arm — absent value rejected, never applied. Same
// field set as the InterventionRequestPayload union below.
type ApplyInterventionParams =
  | { type: "steer"; targetRunId: RunId; expectedRunVersion: number; payload: SteerPayload }
  | { type: "interrupt"; targetRunId: RunId; expectedRunVersion: number; payload: InterruptPayload }
  | { type: "cancel"; targetRunId: RunId; expectedRunVersion: number; payload: CancelPayload };

interface SteerPayload {
  content: string;
  attachments?: unknown[];
  expectedTurnId?: string;
}

interface InterruptPayload {
  reason?: string;
}

interface CancelPayload {
  reason?: string;
}

interface DriverInterventionResult {
  status: "applied" | "degraded";
  fallbackAction?: string; // e.g. 'queue_and_interrupt' for degraded steer
}

// Return shape of `ProviderDriver.resumeSession()`. Discriminated union over `status`
// makes silent-replacement structurally inexpressible: the failure variant has no
// `bindingId`, so a successful resume cannot be conflated with a failed one. Spec-005:60
// requires that resume failure "surface `provider failure` detail and a visible
// `recovery-needed` condition; it must not silently create a replacement provider
// session under the same canonical run." Timestamps for the resumed case live on
// `runtime_bindings.updated_at` (Plan-005 T2.1); the result shape carries only the
// discriminated-union semantic payload.
type DriverResumeResult =
  | { status: "resumed"; bindingId: string }
  | {
      status: "failed";
      recoveryCondition: "recovery-needed";
      providerFailureDetail: string;
    };

interface RespondToRequestParams {
  runId: RunId;
  requestId: string;
  response: unknown;
}

interface CloseSessionParams {
  sessionId: SessionId;
}

interface ProviderSessionHandle {
  providerSessionId: string;
  resumeHandle: string;
}

interface ProviderModel {
  id: string;
  name: string;
  capabilities: string[];
}

interface ProviderMode {
  id: string;
  name: string;
}

interface DriverCapabilities {
  flags: Record<DriverCapabilityFlag, boolean>;
  contractVersion: string;
}

// Per-tool idempotency classification used by the daemon's two-phase command-receipt
// protocol during crash recovery (Spec-005 §Tool Metadata; Spec-015 §Idempotency
// Protocol).
type IdempotencyClass = "idempotent" | "compensable" | "manual_reconcile_only";

// INGRESS shape — what a provider driver DECLARES via `getCapabilities()`. `idempotency_class`
// is OPTIONAL: a driver MAY omit it and an undeclared class is NOT a contract violation. Were the
// field required here, Zod would reject a conformant-but-silent driver at ingress BEFORE the
// default could apply — defeating Spec-005:128. The daemon's capability-normalization seam
// (Plan-005 T2.4 hydration) resolves an omitted class to `manual_reconcile_only` (the conservative
// default per Spec-005:128), producing a `NormalizedProviderToolMetadata`.
interface ProviderToolMetadata {
  name: string;
  idempotency_class?: IdempotencyClass;
  description?: string;
}

// NORMALIZED shape — the daemon-side projection AFTER the normalization seam has applied the
// `manual_reconcile_only` default. `idempotency_class` is REQUIRED, so the type system forbids
// persisting an un-normalized value into the NOT NULL `driver_tools.idempotency_class` column or
// emitting it on a `runtime_node.capability_*` event. This is the only tool-metadata shape that
// crosses the persistence / event-payload boundary; ingress `ProviderToolMetadata` never does.
interface NormalizedProviderToolMetadata {
  name: string;
  idempotency_class: IdempotencyClass;
  description?: string;
}

// Return type of `ProviderDriver.getCapabilities()`. Spec-005:116-118 semantically
// separates whole-driver capability flags from per-tool metadata; the wrapper keeps
// `DriverCapabilities` pure (flags + contractVersion only) while still carrying both
// surfaces in a single round-trip. Modern precedent: MCP 2026 separates `initialize`
// server capabilities from `tools/list`; LSP separates `ServerCapabilities` from
// registered tool surfaces.
interface GetCapabilitiesResult {
  capabilities: DriverCapabilities;
  tools: ProviderToolMetadata[];
}
```

### Plan-006 — Session Event Taxonomy

> **Cross-plan note (amendment 2026-06-02, PR #137 — Plan-003 Phase 2).** The per-event payload-shape Zod schemas for the `runtime_node.*` payloads below are **authored by Plan-003** in `packages/contracts/src/runtime-node.ts` (the file Plan-003 owns; CREATE), not by Plan-006. Plan-003 ships `capabilityDetails` (on `capability_declared`) and `previousState`/`newState` (on `capability_updated`) as an **interim opaque** `z.record(z.string(), z.unknown())` because the canonical `CapabilityDetails` consumes Plan-005's `provider-driver.ts` types, which do not yet exist. The `CapabilityDetails` interface defined here is the shape **Plan-006 Tier 4 binds** over those interim-opaque fields (EXTEND — closes Plan-005 CP-005-5 / Plan-006 CP-006-5), simultaneously registering the schemas into the discriminated `SessionEventSchema` union (`event.ts`) and wrapping them in the `EventEnvelope`. See [cross-plan-dependencies.md §3 Plan-003 row](../cross-plan-dependencies.md#3-inter-plan-dependency-graph) and Plan-003 §CP-003-1 (Payload-shape ownership).

```ts
// CapabilityDetails — wrapper shape carried by `runtime_node.capability_declared` and
// `runtime_node.capability_updated` event payloads (Spec-006:384-385). Bound to the same
// three surfaces a driver advertises via `ProviderDriver.getCapabilities()` (GetCapabilitiesResult
// above): the seven-flag matrix, the negotiated contract version, and the per-tool metadata —
// here as `NormalizedProviderToolMetadata` (post-default), since these payloads cross the event
// boundary and must never carry an un-normalized `idempotency_class`.
// Why flattened (not nested under `capabilities`): in the event-payload context all three
// surfaces compose one capability snapshot; readers (Plan-013 timeline, Plan-020 dashboards,
// Plan-015 replay) discriminate `runtime_node.capability_*` events from the discriminated
// union and consume the snapshot as a single object — there is no driver-method context
// that requires DriverCapabilities to remain pure. Sources: Spec-006:384-385; Plan-005
// CP-005-5; Plan-006 Phase 1 T1.4 + Phase 3 doc-mirror audit.
interface CapabilityDetails {
  flags: Record<DriverCapabilityFlag, boolean>;
  contractVersion: string;
  tools: NormalizedProviderToolMetadata[];
}

// runtime_node.capability_declared payload (Spec-006:384). Emitted once per driver
// registration with the daemon's runtime-node bootstrap (Plan-003 territory).
interface RuntimeNodeCapabilityDeclaredPayload {
  capability: string; // canonical capability identifier (e.g., "provider-driver")
  capabilityDetails: CapabilityDetails;
}

// runtime_node.capability_updated payload (Spec-006:385). Emitted on driver-version
// bump, tool addition/removal, or flag-matrix mutation. `previousState` / `newState`
// carry the same wrapper shape so consumers diff snapshots structurally.
interface RuntimeNodeCapabilityUpdatedPayload {
  capability: string;
  previousState: CapabilityDetails;
  newState: CapabilityDetails;
}

// EventEnvelopeVersion — branded semver "MAJOR.MINOR" string per ADR-018 §Decision #1.
// Wire form and persisted form are both string (never numeric). Parsing extracts MAJOR
// and MINOR as integers for numeric comparison; lexical string comparison is unsafe
// (e.g. "1.10" lexically < "1.9"). Range errors map to `version.floor_exceeded` /
// `version.ceiling_exceeded` in error-contracts.md (typed: VERSION_FLOOR_EXCEEDED /
// VERSION_CEILING_EXCEEDED per ADR-018 §Decision #4).
type EventEnvelopeVersion = string & { readonly __brand: "EventEnvelopeVersion" };
// Format: /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/ — validated at envelope construction.

// EventEnvelope — canonical event message
interface EventEnvelope {
  id: string;
  sessionId: SessionId;
  sequence: number;
  occurredAt: string; // ISO 8601
  category: EventCategory;
  type: string; // specific type within category
  actor?: string; // participant_id, agent_id, or null for system
  payload: Record<string, unknown>;
  correlationId?: string;
  causationId?: string;
  version: EventEnvelopeVersion; // semver "MAJOR.MINOR" per ADR-018 §Decision #1 (never numeric)
}

type EventCategory =
  | "run_lifecycle"
  | "assistant_output"
  | "tool_activity"
  | "interactive_request"
  | "artifact_publication"
  | "membership_change"
  | "session_lifecycle"
  | "approval_flow"
  | "usage_telemetry"
  // Extended per Spec-006 §Runtime Node Lifecycle, §Recovery Events, §Participant Lifecycle,
  // §Audit Integrity, §Security Events, §Event Maintenance, §Policy Events,
  // §Channel Arbitration, §Onboarding Lifecycle, §Cross-Node Dispatch (19 categories total
  // per Spec-006 §Event Type Summary line 519; 130 event types per line 521 — the Tier-5
  // readiness-audit swap registered daemon.master_key_source + daemon.pii_split_ambiguous
  // under the existing security_events category, Plan-022 D-022-5, and the Tier-6 swap
  // added approval.canceled (D-012-8) plus four Plan-016 types (A-016-6, D-016-10/11/12),
  // all within existing categories — so no category was added).
  | "runtime_node_lifecycle"
  | "recovery_events"
  | "participant_lifecycle"
  | "audit_integrity"
  | "security_events"
  | "event_maintenance"
  | "policy_events"
  | "channel_arbitration"
  | "onboarding_lifecycle"
  | "cross_node_dispatch";
// Individual event types within each category are enumerated in Spec-006 §Event Type Enumeration.

// EventReadAfterCursor
interface EventReadAfterCursorRequest {
  sessionId: SessionId;
  afterCursor: EventCursor;
  limit?: number; // default 100
}
interface EventReadAfterCursorResponse {
  events: EventEnvelope[];
  nextCursor: EventCursor;
  hasMore: boolean;
}

// EventReadWindow
interface EventReadWindowRequest {
  sessionId: SessionId;
  fromSequence: number;
  toSequence: number;
}
interface EventReadWindowResponse {
  events: EventEnvelope[];
}

// EventSubscription
interface EventSubscriptionRequest {
  sessionId: SessionId;
  afterCursor?: EventCursor; // replay from this point; omit for live-only
}
// Response: SSE stream of EventEnvelope
```

### Plan-007 — Local IPC And Daemon Control

```ts
// JSON-RPC 2.0 method shapes

// DaemonHello
interface DaemonHelloParams {
  clientVersion: string;
  supportedProtocols: string[];
}
interface DaemonHelloResult {
  daemonVersion: string;
  negotiatedProtocol: string;
  sessionId?: SessionId; // if already attached
}

// DaemonStatusRead
interface DaemonStatusReadParams {}
interface DaemonStatusReadResult {
  processState: "running" | "starting" | "stopping" | "degraded";
  protocolVersion: string;
  transportEndpoint: string;
  uptimeMs: number;
}

// DaemonStop / DaemonRestart (no DaemonStart: daemon cold-boot is the CLI process-spawn path — `ai-sidekicks daemon start` — not an IPC method; see Plan-007 T-007r-3-4)
// Separate per-method request schemas (NOT a shared `action` discriminator): each carries the idle-drain
// deadline that I-007-12 self-swap refusal + I-007-15 quiesce depend on. The 5000ms default is applied by
// the Zod schema (Plan-007 T-007r-1-2), so the field is input-optional but always present post-parse.
// Refusal is the canonical JSON-RPC error envelope (data.type: "daemon.lifecycle_conflict"), never a
// success-shape discriminator — so both success results are the uniform { accepted: true }.
interface DaemonStopParams {
  idleDrainDeadlineMs?: number; // default 5000
}
interface DaemonStopResult {
  accepted: true;
}
interface DaemonRestartParams {
  idleDrainDeadlineMs?: number; // default 5000
}
interface DaemonRestartResult {
  accepted: true;
}

// LocalSubscription
interface LocalSubscriptionParams {
  sessionId: SessionId;
  afterCursor?: EventCursor;
  categories?: EventCategory[]; // filter to specific categories
}
// Response: JSON-RPC notification stream of EventEnvelope
```

---

## Tier 5: Plans 004, 008, 018 (Task 4.6)

### Plan-004 — Queue Steer Pause Resume

```ts
// QueueItemCreate
interface QueueItemCreateRequest {
  sessionId: SessionId;
  channelId?: ChannelId;
  workspaceId?: WorkspaceId; // repo-bound run binding (Spec-010 run setup data; absent = non-repo run) — Tier-6 audit
  priority?: number; // default 0
  payload: Record<string, unknown>;
}
interface QueueItemCreateResponse {
  queueItemId: QueueItemId;
  state: QueueItemState;
  createdAt: string;
}
// Orchestration seam (Tier-6 audit, D-016-13): Plan-016's orchestration-run-service composes with
// the daemon queue-admission service IN-PROCESS, passing an OrchestrationRunLinkCarrier (see
// §Plan-016) after its own admission pipeline passes. The in-process admission API returns the
// minted RunId (the run.queued emission's runId) alongside queueItemId, and run.queued carries the
// carrier fields durably (Spec-006:187 additive optional fields). The wire run.queueCreate method
// never accepts the carrier — child-run creation goes through orchestration.runCreate only.

// QueueItemList
interface QueueItemListRequest {
  sessionId: SessionId;
  state?: QueueItemState; // filter
  channelId?: ChannelId; // filter
}
interface QueueItemListResponse {
  items: QueueItemSummary[];
}

interface QueueItemSummary {
  id: QueueItemId;
  state: QueueItemState;
  priority: number;
  channelId?: ChannelId;
  createdAt: string;
  updatedAt: string;
}

// QueueItemCancel
interface QueueItemCancelRequest {
  queueItemId: QueueItemId;
}
interface QueueItemCancelResponse {
  queueItemId: QueueItemId;
  state: "canceled";
}

// InterventionRequest (discriminated union by type)
// `expectedRunVersion` is the MANDATORY optimistic-concurrency comparand (Plan-004 D-004-2,
// fail-closed): every intervention carries the run version the caller last observed, and the
// daemon rejects the request as `expired` when it does not match the run's current `runVersion`
// (surfaced on RunStateChangeEvent / RunControlAck / InterventionRequestResponse below). The field
// is required — an absent comparand is rejected, never applied (an optional field would let a caller
// bypass the stale-replay guard by omitting it). The compared-against counter is `runVersion`
// (Plan-004 D-004-1): an any-run-progression counter that advances on every run progression,
// applied interventions included — distinct from the immutable EventEnvelope `.version` wire-contract
// field (Spec-006 §EventEnvelope Version Semantics).
type InterventionRequestPayload =
  | {
      type: "steer";
      targetRunId: RunId;
      expectedRunVersion: number;
      content: string;
      attachments?: unknown[];
      expectedTurnId?: string;
    }
  | { type: "interrupt"; targetRunId: RunId; expectedRunVersion: number; reason?: string }
  | { type: "cancel"; targetRunId: RunId; expectedRunVersion: number; reason?: string };

interface InterventionRequestResponse {
  interventionId: InterventionId;
  state: InterventionState;
  runVersion: number; // post-application run counter (D-004-1) — the caller threads this into the next intervention's `expectedRunVersion`. Carried on the response because an applied native steer advances the run version WITHOUT a `run.*` state change (Spec-004:85), so for that path the response is the only place the caller can read the fresh comparand.
  result?: Record<string, unknown>;
}

// RunStateChange (event, not request/response). The `run.failed` variant carries the
// `providerFailureDetail` surface that mirrors the `failed`-variant `providerFailureDetail` of `DriverResumeResult`
// (line 657 above) — Spec-005:60 requires resume-failure detail to reach the canonical audit
// log so Plan-015's recovery dispatcher and Plan-013's timeline can render the operator-actionable
// reason for the failure without re-querying the driver. Plan-005 CP-005-5; Plan-006 Phase 3 audit.
interface RunStateChangeEvent {
  runId: RunId;
  runVersion: number; // run-progression counter (D-004-1): the optimistic-concurrency comparand clients read via run.subscribeState and pass back as `expectedRunVersion`. Advances on every run progression, applied interventions included. A no-state-change advance (e.g. native steer) is NOT emitted as a discrete run.subscribeState event (no transition to record, Spec-004:85), so a non-intervening subscriber may hold a stale comparand until its next guarded request is correctly rejected `expired`, whereupon it re-reads run-state and retries (reject→re-read→retry; V1 adds no broadcast push for no-state-change bumps — Spec-006 §Security Events / Run Lifecycle). Distinct from the immutable EventEnvelope `.version` (Spec-006 §EventEnvelope Version Semantics) — that is the wire-contract semver; this is the run aggregate's concurrency token.
  previousState: RunState;
  currentState: RunState;
  failureCategory?: RunFailureCategory;
  recoveryCondition?: "recovery-needed";
  healthSignal?: "stuck-suspected";
  providerFailureDetail?: string; // populated on `run.failed` when failureCategory='provider'
  trigger?: "turn_limit" | "budget_exhausted" | "idle_timeout" | "moderation_denied"; // stop-condition provenance (additive per ADR-018): 'turn_limit' rides run.completed at the turn limit (Plan-016 D-016-8 — the value CP-004-10 adds to Plan-004's trigger set); the three InterruptReason values ride run.interrupted on system interrupts (D-016-7). Absent on natural completion and user-initiated paths; the Runs View / timeline stop-condition rendering (Spec-023) reads this field.
  // run.queued linkage (orchestration-created runs only): the OrchestrationRunLinkCarrier fields
  // threaded into the durable payload as optional additive fields (CP-004-10; Plan-016 D-016-3 —
  // run_links is a pure events-canonical projection rebuilt from this event alone). Spec-006:187.
  agentId?: AgentId;
  parentRunId?: RunId;
  linkType?: LinkType;
  internalHelper?: boolean;
  producingNodeId?: NodeId;
  // run.queued effective config: the admission-resolved OrchestrationRunConfig (request override
  // else session default) persisted durably so budget/idle enforcement rebuilds replay-stable even
  // if session defaults change mid-run (Plan-016 D-016-5, I-016-14; Spec-006:187).
  effectiveRunConfig?: OrchestrationRunConfig;
  timestamp: string;
}

// Run-control mutations (Spec-004:41-43). `pause` interrupts the active run + persists conversation/run
// state + queues a resume (orchestration-layer, never driver-gated per I-004-10); `resume` returns the
// `paused` run to active execution with the SAME run id. Both carry a MANDATORY `expectedRunVersion`
// optimistic-concurrency guard with the SAME fail-closed semantics as InterventionRequestPayload: a stale
// comparand rejects the request (the run is left untouched), never silently applied. The Tier-5 audit
// EXTENDS Plan-004 D-004-2's mandatory-comparand obligation to these orchestration-layer verbs — `pause` /
// `resume` hold no InterventionType membership (ADR-011), so the guard binds them by deliberate extension,
// NOT by D-004-2's original intervention-only scope.
interface RunPauseRequest {
  targetRunId: RunId;
  expectedRunVersion: number;
}
interface RunResumeRequest {
  targetRunId: RunId;
  expectedRunVersion: number;
}
// Shared pause/resume ack: echoes the post-transition run state + the advanced `runVersion`, so the
// caller threads the fresh comparand into its next guarded request without a round-trip to run.subscribeState.
interface RunControlAck {
  runId: RunId;
  currentState: RunState;
  runVersion: number;
}

// Subscription request shapes. Both subscriptions are session-scoped: the canonical event stream is
// per-session (Spec-006) and ADR-001 makes the session the authorization unit, so a caller subscribes
// within a session it participates in and fans out per run client-side via RunStateChangeEvent.runId.
interface RunStateSubscribeRequest {
  sessionId: SessionId;
}
interface RunQueueSubscribeRequest {
  sessionId: SessionId;
}
```

### Run-Control Method-Name Registry (Tier 5)

Plan-004's queue / intervention / pause-resume operations are exposed as eight `run.*` methods. The eight concrete strings are ratified (Plan-004 D-004-3 / CP-004-4) and registered here as the canonical wire contract; the reciprocal namespace `provides` is recorded on [Plan-007](../../plans/007-local-ipc-and-daemon-control.md) (the `run.*` method-name owner) in the [cross-plan dependency map](../cross-plan-dependencies.md). Method-name strings are `dotted-camelCase` per the canonical `METHOD_NAME_FORMAT` ratified in §Tier 1 (cont.): Plan-007 above — the `run.*` namespace token is the run-aggregate domain noun, distinct from the `run_lifecycle` **event** taxonomy in [Spec-006 §Run Lifecycle](../../specs/006-session-event-taxonomy-and-audit-log.md) (the underscore form is a valid event name but is rejected as a method name by `METHOD_NAME_FORMAT`).

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `run.queueList` | `query` | `QueueItemListRequest` | `QueueItemListResponse` |
| `run.queueCreate` | `mutation` | `QueueItemCreateRequest` | `QueueItemCreateResponse` |
| `run.queueCancel` | `mutation` | `QueueItemCancelRequest` | `QueueItemCancelResponse` |
| `run.intervene` | `mutation` | `InterventionRequestPayload` | `InterventionRequestResponse` |
| `run.pause` | `mutation` | `RunPauseRequest` | `RunControlAck` |
| `run.resume` | `mutation` | `RunResumeRequest` | `RunControlAck` |
| `run.subscribeState` | `subscription` | `RunStateSubscribeRequest` | `RunStateChangeEvent` (stream) |
| `run.subscribeQueue` | `subscription` | `RunQueueSubscribeRequest` | `QueueItemSummary` (stream) |

`run.queueList` is the only `query` (idempotent read); the five mutations are state-changing per the tRPC procedure-type convention in §Tier 1 (cont.): Plan-008 above. The two `subscription`s stream their payload type per emission rather than returning a single response — `run.subscribeState` streams `RunStateChangeEvent` (carrying the `runVersion` comparand clients pass back as `expectedRunVersion`), and `run.subscribeQueue` streams the existing `QueueItemSummary` projection (no separate queue-change event type is introduced). All request/response shapes are the interfaces defined directly above; the canonical Zod schemas live in `packages/contracts/src/runControl.ts` (CP-004-3) per the §Source-of-Truth Policy.

### Plan-008 — Control-Plane Relay And Session Join

```ts
// SessionJoin (control-plane variant)
interface ControlPlaneSessionJoinRequest {
  sessionId: SessionId;
  identityHandle: string;
  inviteToken?: string; // for invite-based join
}
interface ControlPlaneSessionJoinResponse {
  sessionId: SessionId;
  participantId: ParticipantId;
  membershipId: MembershipId;
  relayEndpoint?: string;
}

// RelayNegotiation
interface RelayNegotiationRequest {
  sessionId: SessionId;
  nodeId: NodeId;
  transportPreferences: string[]; // e.g. ['websocket', 'http2']
}
interface RelayNegotiationResponse {
  relayEndpoint: string; // per-session WSS URL the client dials; carries the negotiated sessionId so the relay verifier recovers it out-of-band from the connect-token (PASETO v4 implicit assertion, Spec-008 §Relay Negotiation). The self-hostable single-process relay mints it with sessionId as a path segment (wss://<host>/relay/<sessionId>, Plan-025 D-025-10); the hosted session-sharded Durable Object holds sessionId via its shard identity.
  transportProtocol: string;
  cipherSuite: string; // negotiated cipher suite, e.g. 'v1/pairwise' (Spec-008 §Relay Negotiation)
  connectionToken: string; // short-lived auth token
  ttl: number; // seconds
}

// PresenceRegister
interface PresenceRegisterRequest {
  sessionId: SessionId;
  participantId: ParticipantId;
  deviceId: string;
}
interface PresenceRegisterResponse {
  presenceId: string;
  state: PresenceState;
}

// SessionResumeAfterReconnect
interface SessionResumeAfterReconnectRequest {
  sessionId: SessionId;
  participantId: ParticipantId;
  previousClientHandle?: string;
}
interface SessionResumeAfterReconnectResponse {
  sessionId: SessionId;
  resumedAt: string;
  missedEventCursor: EventCursor;
}
```

### Plan-018 — Identity And Participant State

```ts
// ParticipantProjectionRead
interface ParticipantProjectionReadRequest {
  sessionId: SessionId;
  participantId?: ParticipantId; // omit for all participants
}
interface ParticipantProjectionReadResponse {
  participants: ParticipantProjection[];
}

interface ParticipantProjection {
  participantId: ParticipantId;
  displayName: string;
  role: MembershipRole;
  state: MembershipState; // canonical membership lifecycle state (Spec-018:42; Plan-018 CP-018-8). Distinct from `presenceState` (online/idle/…) and `role` (owner/viewer/…). Code-canonical in packages/contracts; this illustration is re-synced to carry it.
  presenceState: PresenceState;
  lastSeen: string; // when `state` ≠ the most-recently-seen device, this is the winning (highest-activity precedence) device's lastSeen, so {state, lastSeen} stay internally consistent (Plan-018 D-018-4).
}

// ParticipantStateUpdate
interface ParticipantStateUpdateRequest {
  participantId: ParticipantId;
  displayName?: string;
  metadata?: Record<string, unknown>;
}
interface ParticipantStateUpdateResponse {
  participantId: ParticipantId;
  updatedAt: string;
}

// PresenceDetailRead
interface PresenceDetailReadRequest {
  sessionId: SessionId;
  participantId: ParticipantId;
}
interface PresenceDetailReadResponse {
  participantId: ParticipantId;
  devices: Array<{
    deviceId: string;
    state: PresenceState;
    lastSeen: string;
  }>;
  aggregateState: PresenceState;
}

// RevokeAllTokensForParticipant (BL-070)
// Backs POST /auth/revoke-all-for-participant. See security-architecture.md
// §Bulk Revoke All For Participant (BL-070) for auth, side effects, multi-region
// propagation, and regulatory mapping.
interface RevokeAllTokensForParticipantRequest {
  participantId: ParticipantId;
  reason: "account_compromise" | "password_reset" | "admin_action" | "self_service";
}
// Response: 204 No Content (no body).
// Emits `participant.tokens_revoked_all` per Spec-006 (BL-064) with payload
// base + {revokedAt, tokenCount}.
// Auth: admin scope `admin:participants:revoke` OR participant's own access
// token with step-up reauth per NIST SP 800-63B §4.2.3.
```

### Participant Method-Name Registry (Tier 5)

Plan-018's identity / participant-state reads and updates are exposed as three `participant.*` methods (Plan-018 CP-018-6). Names are registered here pending the Plan-007 daemon method-name registry merge; the reciprocal `provides` is recorded on [Plan-007](../../plans/007-local-ipc-and-daemon-control.md). Same `dotted-camelCase` `METHOD_NAME_FORMAT` as the other namespaces above.

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `participant.projectionRead` | `query` | `ParticipantProjectionReadRequest` | `ParticipantProjectionReadResponse` |
| `participant.stateUpdate` | `mutation` | `ParticipantStateUpdateRequest` | `ParticipantStateUpdateResponse` |
| `participant.presenceDetail` | `query` | `PresenceDetailReadRequest` | `PresenceDetailReadResponse` |

`participant.presenceDetail` returns per-device presence fan-out and is **owner/operator-only** (Plan-018 D-018-5 / I-018-6): per-device detail is privacy-sensitive, so the aggregated `presenceState` on `ParticipantProjection` remains the participant-visible default and the device-level breakdown is gated to the session owner / daemon operator (see [Security Architecture §Per-Device Presence Detail Authorization](../security-architecture.md#per-device-presence-detail-authorization)). `participant.stateUpdate` is the only mutation. Canonical Zod schemas live in `packages/contracts/` per the §Source-of-Truth Policy.

---

## Tier 6: Plans 009, 010, 012 (Task 4.7)

### Plan-009 — Repo Attachment And Workspace Binding

```ts
// Plan-009 shared shapes (Tier-6 audit, D-009-2 / D-009-4) — canonical origin
// packages/contracts/src/repo.ts; Plan-010 imports these per Plan-009 CP-009-1.
type VcsType = "git" | "none";
// Derived projection, never persisted — Spec-009 §Repo Mount Health (V1 Definition)
interface RepoMountHealth {
  status: "healthy" | "unreachable";
  checkedAt: string; // ISO-8601 instant of the probe that produced the verdict
}

// RepoAttach
interface RepoAttachRequest {
  sessionId: SessionId;
  localPath: string; // user-entered path (provenance; persisted as repo_mounts.local_path)
  nodeId: NodeId; // owning runtime node — the node that can access the filesystem path
}
interface RepoAttachResponse {
  repoMountId: RepoMountId;
  state: RepoMountState;
  vcsType: VcsType;
  canonicalRoot: string; // resolver output (absolute, symlink-resolved), never the echoed input
  defaultWorkspaceId: WorkspaceId; // attach always creates the default read-only workspace (Plan-009 D-009-7)
}

// RepoMountRead
interface RepoMountReadRequest {
  repoMountId: RepoMountId;
}
interface RepoMountReadResponse {
  id: RepoMountId;
  sessionId: SessionId;
  nodeId: NodeId;
  localPath: string; // user-entered provenance
  canonicalRoot: string; // resolver output — the trust-envelope and dedupe key
  vcsType: VcsType;
  state: RepoMountState;
  health: RepoMountHealth; // derived projection (defined above), never persisted
  attachedAt: string;
}

// RepoDetach (Plan-009 D-009-6; Spec-009 §Detach Semantics)
interface RepoDetachRequest {
  repoMountId: RepoMountId;
}
interface RepoDetachResponse {
  repoMountId: RepoMountId;
  state: RepoMountState; // 'detached' — terminal; re-attach creates a new mount row
  archivedWorkspaceIds: WorkspaceId[]; // dependent workspaces archived by the cascade
}

// WorkspaceBind — mount-first single funnel (Plan-009 D-009-4): directory-root binding
// attaches the directory as a plain-directory mount (vcsType 'none') first; bind always
// references a repo mount.
interface WorkspaceBindRequest {
  repoMountId: RepoMountId;
  executionMode: ExecutionMode;
  directory?: string; // mount-root-relative subdirectory; containment re-checked after symlink resolution
}
interface WorkspaceBindResponse {
  workspaceId: WorkspaceId;
  fsRoot?: string; // absent while state = 'provisioning' (writable binds — Plan-010 fills the root at provisioning completion); present for read-only binds (the mount canonical root)
  executionMode: ExecutionMode;
  state: WorkspaceState;
}

// WorkspaceExecutionModeCapabilitiesRead — exactly one of repoMountId | workspaceId
// (Zod refinement): a mount-scoped read answers "what could a workspace on this mount
// do"; a workspace-scoped read answers "what may THIS workspace do now".
interface WorkspaceExecutionModeCapabilitiesReadRequest {
  repoMountId?: RepoMountId;
  workspaceId?: WorkspaceId;
}
interface WorkspaceExecutionModeCapabilitiesReadResponse {
  availableModes: ExecutionMode[];
  defaultMode: ExecutionMode; // default for the next WRITABLE coding run (Plan-009 D-009-5), not the fresh-workspace read-only posture
  restrictions?: Partial<Record<ExecutionMode, string>>; // sparse: reason per restricted mode — capability gaps are explicit, never silent substitution
}

// WorkspaceList
interface WorkspaceListRequest {
  sessionId: SessionId;
  repoMountId?: RepoMountId; // filter
}
interface WorkspaceListResponse {
  workspaces: Array<{
    id: WorkspaceId;
    repoMountId: RepoMountId;
    executionMode: ExecutionMode;
    state: WorkspaceState;
    fsRoot?: string;
    lastError?: string; // present iff state = 'stale' from a recorded failure (workspaces.metadata.lastError, Spec-009 line 91) — Tier-6 audit
  }>;
}
```

### Repo Method-Name Registry (Tier 6)

Plan-009's repo-attachment and workspace-binding surface is exposed as six `repo.*` methods, ratified by the Tier-6 plan-readiness audit (Plan-009 D-009-1, CP-009-5). Names register under the Plan-007-partial daemon `MethodRegistry` at Tier 6 per the §5 substrate-vs-namespace carve-out (`presence.*` precedent); registration's BL-142 precondition (registry-regex conformance to the Tier-1 `METHOD_NAME_FORMAT`) is resolved (2026-06-21). These methods ride the daemon JSON-RPC transport only — repo mounts and workspaces are node-local filesystem state (ADR-004), so no control-plane tRPC sibling exists. Method strings are imperative and disjoint-by-form from the past-participle Spec-006 durable event names (`repo.attached`, `repo.detached`).

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `repo.attach` | `mutation` | `RepoAttachRequest` | `RepoAttachResponse` |
| `repo.mountRead` | `query` | `RepoMountReadRequest` | `RepoMountReadResponse` |
| `repo.workspaceBind` | `mutation` | `WorkspaceBindRequest` | `WorkspaceBindResponse` |
| `repo.executionModeCapabilitiesRead` | `query` | `WorkspaceExecutionModeCapabilitiesReadRequest` | `WorkspaceExecutionModeCapabilitiesReadResponse` |
| `repo.workspaceList` | `query` | `WorkspaceListRequest` | `WorkspaceListResponse` |
| `repo.detach` | `mutation` | `RepoDetachRequest` | `RepoDetachResponse` |

Canonical Zod schemas live in `packages/contracts/src/repo.ts` per the §Source-of-Truth Policy.

Plan-010's worktree-lifecycle and execution-mode surface adds seven further `repo.*` methods (Plan-010 D-010-3, Tier-6 audit) — the same namespace, not a new root, because the Tier-1 ratified namespace-root enumeration admits `repo` and mounts, workspaces, worktrees, and clones form one repo aggregate (sibling symmetry: `repo.executionModeCapabilitiesRead` ↔ `repo.executionModeSelect`). Registration rides the same Plan-007-partial `MethodRegistry` path; its BL-142 regex-conformance and BL-143 typed-domain-error-projection preconditions are both resolved (2026-06-21). Method strings stay imperative and disjoint-by-form from the past-participle Spec-006 durable event names (`worktree.created` … `worktree.retired`).

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `repo.executionModeSelect` | `mutation` | `ExecutionModeSelectRequest` | `ExecutionModeSelectResponse` |
| `repo.executionRootPrepare` | `mutation` | `ExecutionRootPrepareRequest` | `ExecutionRootPrepareResponse` |
| `repo.worktreeReuseCheck` | `query` | `WorktreeReuseCheckRequest` | `WorktreeReuseCheckResponse` |
| `repo.ephemeralClonePrepare` | `mutation` | `EphemeralClonePrepareRequest` | `EphemeralClonePrepareResponse` |
| `repo.ephemeralCloneDispose` | `mutation` | `EphemeralCloneDisposeRequest` | `EphemeralCloneDisposeResponse` |
| `repo.worktreeRetire` | `mutation` | `WorktreeRetireRequest` | `WorktreeRetireResponse` |
| `repo.worktreeStatusRead` | `query` | `WorktreeStatusReadRequest` | `WorktreeStatusReadResponse` |

Canonical Zod schemas for these seven pairs live in `packages/contracts/src/worktree.ts` (Plan-010 D-010-1) per the §Source-of-Truth Policy.

### Plan-010 — Worktree Lifecycle And Execution Modes

```ts
// Branded IDs + enums introduced by Plan-010 (canonical origin: packages/contracts/src/worktree.ts;
// declared in-block rather than under §Branded ID Types / §Shared Enums for cite stability — Tier-6 audit)
type EphemeralCloneId = string & { readonly __brand: "EphemeralCloneId" };
type BranchContextId = string & { readonly __brand: "BranchContextId" };
type EphemeralCloneState = "creating" | "ready" | "retired" | "failed";

// ExecutionModeSelect — records the canonical mode and transitions the workspace (Spec-010 §Interfaces);
// root materialization is ExecutionRootPrepare's surface. Exactly one mutation per explicit switch.
interface ExecutionModeSelectRequest {
  workspaceId: WorkspaceId;
  executionMode: ExecutionMode;
}
interface ExecutionModeSelectResponse {
  workspaceId: WorkspaceId;
  executionMode: ExecutionMode;
  state: WorkspaceState; // 'ready' when resolved synchronously (read-only); 'provisioning' while a writable root awaits prepare
  executionRoot?: string; // present iff resolved synchronously
}

// ExecutionRootPrepare — materializes (or binds) the execution root for the workspace's selected mode.
// Wire-initiated prepares are pre-run by definition; the run-setup gate calls the service directly,
// supplying the run id that populates worktrees.created_by_run_id + run_execution_contexts.
interface ExecutionRootPrepareRequest {
  workspaceId: WorkspaceId;
  branchName?: string; // REQUIRED for writable modes on the wire (pre-run, no slug-rule seed; absent → typed workspace.branch_name_required refusal); the run-setup gate derives per the Spec-010 slug rule service-side (Plan-010 D-010-19)
  baseRef?: string; // worktree base; default = mount HEAD branch; detached HEAD without baseRef → typed refusal
  reuseWorktreeId?: WorktreeId; // explicit reuse names the candidate (Spec-010 explicit-reuse requirement)
  acknowledgeDirtyCandidate?: boolean; // explicit consent to bind a DIRTY named candidate; never bypasses incompatibility
}
interface ExecutionRootPrepareResponse {
  executionRoot: string;
  state: WorkspaceState;
  worktreeId?: WorktreeId; // set for worktree mode
  ephemeralCloneId?: EphemeralCloneId; // set for ephemeral clone mode
  branchContextId?: BranchContextId; // set for all three writable modes (Spec-010 §State And Data Implications)
}

// WorktreeReuseCheck — singular candidate by construction: the partial-unique active-branch index
// (local-sqlite-schema.md worktrees DDL) guarantees at most one live checkout per (mount, branch).
interface WorktreeReuseCheckRequest {
  repoMountId: RepoMountId;
  branchName: string;
}
interface WorktreeReuseCheckResponse {
  available: boolean; // true iff a live candidate exists
  worktreeId?: WorktreeId;
  state?: WorktreeState;
  branchName?: string;
  isClean?: boolean;
  compatible?: boolean; // branch-strategy compatibility (Spec-010 §Interfaces)
  reason?: string; // populated when !isClean || !compatible
}

// EphemeralClonePrepare — TTL is daemon configuration, not a wire parameter (Spec-010 §Resolved Questions)
interface EphemeralClonePrepareRequest {
  workspaceId: WorkspaceId;
  branchName: string; // head branch inside the clone — required on the wire: wire prepares are pre-run and carry no slug-rule derivation seed; the run-setup gate path derives service-side (Plan-010 D-010-19)
  cleanupPolicy?: "on_run_complete" | "manual"; // default on_run_complete
}
interface EphemeralClonePrepareResponse {
  cloneId: EphemeralCloneId;
  cloneRoot: string;
  state: Extract<EphemeralCloneState, "creating" | "ready">;
  cleanupPolicy: "on_run_complete" | "manual"; // effective policy, reported per Spec-010 §Interfaces
  branchName: string; // effective head branch (caller-supplied or slug-derived), persisted on the clone row
  expiresAt: string; // ISO-8601 TTL deadline
}

// EphemeralCloneDispose — explicit disposal: the `manual` cleanup-policy arm (Spec-010 §Interfaces)
interface EphemeralCloneDisposeRequest {
  cloneId: EphemeralCloneId;
}
interface EphemeralCloneDisposeResponse {
  cloneId: EphemeralCloneId;
  state: Extract<EphemeralCloneState, "retired">;
}

// WorktreeRetire — records retirement; disk cleanup is asynchronous (cleaned_at stamps it)
interface WorktreeRetireRequest {
  worktreeId: WorktreeId;
}
interface WorktreeRetireResponse {
  worktreeId: WorktreeId;
  state: Extract<WorktreeState, "retired">;
}

// WorktreeStatusRead — daemon-owned read surface over worktree + clone records incl. provenance
// (Spec-010 §Interfaces; feeds the execution-mode-picker status view)
interface WorktreeStatusReadRequest {
  sessionId: SessionId;
  repoMountId?: RepoMountId;
}
interface WorktreeStatusReadResponse {
  worktrees: Array<{
    worktreeId: WorktreeId;
    repoMountId: RepoMountId;
    branchName: string;
    fsRoot: string;
    state: WorktreeState;
    createdBySessionId: SessionId;
    createdByRunId?: RunId;
    createdAt: string;
    updatedAt: string;
    cleanedAt?: string; // async disk-cleanup stamp; absent until the sweep runs (local-sqlite `cleaned_at`)
  }>;
  ephemeralClones: Array<{
    cloneId: EphemeralCloneId;
    workspaceId: WorkspaceId;
    cloneRoot: string;
    branchName: string; // head branch inside the clone (Spec-010 §Interfaces: the status read exposes branch for clone records)
    state: EphemeralCloneState;
    cleanupPolicy: "on_run_complete" | "manual";
    expiresAt: string;
    createdAt: string;
    cleanedAt?: string; // async disk-cleanup stamp; absent until the sweep runs (local-sqlite `cleaned_at`)
  }>;
}
```

### Plan-012 — Approvals Permissions And Trust Boundaries

```ts
// Plan-012 shapes (Tier-6 audit, D-012-1/D-012-3) — canonical origin
// packages/contracts/src/approval.ts. PermissionCheck is a daemon-internal API
// (Spec-012: "inside the local daemon"); it has no JSON-RPC method string and no
// SDK surface in V1 (D-012-5; the in-process check is the composed enforcement
// gate per D-012-18 — evaluate, then on an ask-policy outcome create the request
// via the approval service (whose create persists and emits `approval.requested` —
// the single emission seam), and notify the run-blocking seam before returning).

type RememberedRuleId = string & { readonly __brand: "RememberedRuleId" }; // → §Branded ID Types

// Remembered-grant scope — explicit enum, not free-form (Spec-012 line 104).
// `request_only` (Spec-012 line 67) is expressed by OMITTING rememberedScope,
// never by an enum member. Pattern semantics are category-derived (D-012-10):
// path categories (file_write, destructive_git) = normalized-absolute-path
// prefix containment; network_access = exact host equality (no wildcards in V1);
// all other categories = exact scope-token equality. Absent pattern =
// category-wide within the (session, node, kind) boundary.
interface RememberedScope {
  kind: "run" | "session"; // 'run' = remainder of the originating run; 'session' = session-wide (explicit opt-in)
  pattern?: string; // resource-matching pattern within the kind boundary; absent = category-wide
}

type InvalidationTrigger = "explicit" | "membership_change" | "node_trust_change" | "session_end";

// approval_flow event payload for the seven `approval.*` variants (Spec-006
// §Approval Flow, incl. `approval.canceled` per D-012-8; mirror of the canonical
// Zod schema). The variants carry the projection-rebuild fields (D-012-6 peer/replay
// rebuild; D-012-7 events-canonical): `requested` carries the request quad; the
// resolution events carry the recorded approver + effective scope; `remembered`
// carries the full rule projection (grantor = `approver`, bound `nodeId`, binding =
// `rememberedScope` + `runId`, origin resolution via `approvalRequestId`) so
// `remembered_approval_rules` rebuilds byte-equal (I-012-9); decision and state ride
// the event type; envelope timestamps supply the created/updated instants. The
// category's eighth event, `moderation.review_flagged`, has a distinct payload —
// see ModerationReviewFlaggedPayload below.
// Variant-required fields are enforced at the EMISSION seam via the exported per-type
// refinement (Plan-012 T1.1 `approvalFlowPayloadRefinementFor`): requested ⇒ runId /
// approvalRequestId / requestedBy / resourceDescriptor; approved / rejected ⇒
// approvalRequestId / approver / effectiveScope; expired / canceled ⇒ approvalRequestId;
// remembered ⇒ approvalRequestId / approver / nodeId / rememberedScope / ruleId (+ runId
// iff rememberedScope.kind = 'run'); rule_revoked ⇒ ruleId / invalidationTrigger —
// a malformed event fails at the emission parse, never at peer/restart projection (I-012-9).
interface ApprovalFlowEventPayload {
  sessionId: SessionId;
  runId?: RunId; // absent on trust-triggered rule_revoked (no in-flight request)
  approvalRequestId?: ApprovalRequestId; // ditto
  category: ApprovalCategory;
  scope: string;
  requestedBy?: string; // present on approval.requested — recorded requester actor (participant or agent actor id, Spec-012 line 58)
  resourceDescriptor?: Record<string, unknown>; // present on approval.requested — audit-grade target (Spec-012 line 82)
  expiryAt?: string; // present on approval.requested when the request carries an expiry (D-012-14)
  approver?: ParticipantId; // present on approval.approved / approval.rejected — the recorded resolver (D-012-12); on approval.remembered it is the rule's GRANTOR (rules mint only via resolve-with-remember)
  effectiveScope?: string; // present on approval.approved / approval.rejected — recorded effective scope (≤ requested, I-012-6)
  nodeId?: NodeId; // present on approval.remembered — the rule's bound node (D-012-10 match boundary; not derivable from ruleId on replay)
  rememberedScope?: RememberedScope;
  ruleId?: RememberedRuleId; // present on approval.remembered / approval.rule_revoked
  invalidationTrigger?: InvalidationTrigger; // present on approval.rule_revoked
}

// moderation.review_flagged payload — the approval_flow category's eighth event
// (Spec-006 §Approval Flow registry row; D-016-10). Informational post-turn
// moderation flag; emitter Plan-016. `eventId` references the flagged
// `assistant_output` event.
interface ModerationReviewFlaggedPayload {
  sessionId: SessionId;
  channelId: ChannelId;
  runId: RunId;
  agentId: AgentId;
  eventId: string;
}

// ApprovalRequestCreate
interface ApprovalRequestCreateRequest {
  runId: RunId;
  category: ApprovalCategory;
  scope: string;
  resourceDescriptor: Record<string, unknown>; // REQUIRED (Spec-012 line 82); audit-grade target descriptor
  expiryAt?: string;
}
interface ApprovalRequestCreateResponse {
  approvalRequestId: ApprovalRequestId;
  state: ApprovalState;
  createdAt: string;
}

// ApprovalResolve
interface ApprovalResolveRequest {
  approvalRequestId: ApprovalRequestId;
  approver?: ParticipantId; // informational/routing (Spec-012 line 83; D-012-12). Absent on the
  // local socket → the daemon records its node-owner participant binding; present → cross-checked
  // (local: vs the owner binding; PASETO surfaces: vs the verified `sub`) — mismatch is rejected
  // with `auth.principal_mismatch`. Never authoritative.
  decision: ApprovalDecision;
  effectiveScope?: string; // granted scope; defaults server-side to the request's scope; never broader than requested
  rememberedScope?: RememberedScope; // valid only with decision "approved" (allow-only rules, D-012-16); schema-refined
  auditMetadata?: Record<string, unknown>;
}
interface ApprovalResolveResponse {
  approvalRequestId: ApprovalRequestId;
  state: ApprovalState;
  effectiveScope: string; // the recorded grant (Spec-012 line 59)
  approverId: ParticipantId; // the RECORDED approver (server truth; AC-3 observable)
  resolvedAt: string;
}

// PermissionCheck (daemon-internal pre-execution gate — no wire method string, D-012-5/D-012-18)
interface PermissionCheckRequest {
  runId: RunId;
  category: ApprovalCategory;
  scope: string;
  resourceDescriptor: Record<string, unknown>;
}
interface PermissionCheckResponse {
  allowed: boolean;
  reason: "policy_allow" | "remembered_rule" | "approved" | "pending_approval" | "denied";
  // D-012-17 semantics: policy_allow = Cedar/own-node-envelope permit with no human approval
  // artifact (Spec-012 lines 47/62/71); remembered_rule = matched an unrevoked rule that passed
  // at-use re-validation; approved = a recorded approved resolution covers this exact request;
  // pending_approval = request created/open (allowed=false); denied = Cedar forbid, rejected/
  // expired resolution, or fail-closed refusal (the typed `approval.persistence_unavailable`
  // error additionally surfaces on fail-closed paths so audit can distinguish them).
  // Invariants: allowed === (reason ∈ {policy_allow, remembered_rule, approved});
  approvalRequestId?: ApprovalRequestId; // present iff reason = 'pending_approval'
}

// ApprovalProjectionRead
interface ApprovalProjectionReadRequest {
  sessionId: SessionId;
  state?: ApprovalState; // filter
  category?: ApprovalCategory; // filter
}
interface ApprovalProjectionReadResponse {
  approvals: Array<{
    id: ApprovalRequestId;
    runId: RunId;
    requestedBy: string; // recorded requester actor — participant or agent actor id (Spec-012 line 58)
    category: ApprovalCategory;
    scope: string;
    resourceDescriptor: Record<string, unknown>; // requested resource (Spec-012 line 82)
    state: ApprovalState;
    createdAt: string;
    updatedAt: string; // last state-transition instant (expired/canceled rows settle here; no resolution row)
    expiryAt?: string;
    resolvedAt?: string; // resolved quad present iff state ∈ {approved, rejected}
    decision?: ApprovalDecision;
    approverId?: ParticipantId; // AC-3: who granted
    effectiveScope?: string; // AC-3: what scope
    rememberedScope?: RememberedScope; // present iff the resolution minted a remembered rule
  }>;
}

// RememberedRuleList
interface RememberedRuleListRequest {
  sessionId: SessionId;
  includeRevoked?: boolean; // default false; true = audit-history view (Spec-012 line 92)
}
interface RememberedRuleListResponse {
  rules: Array<{
    ruleId: RememberedRuleId;
    sessionId: SessionId;
    participantId: ParticipantId; // the GRANTOR (audit + membership-invalidation key, not a match key — D-012-10)
    nodeId: NodeId;
    runId?: RunId; // present iff scope.kind = 'run' — the originating run the rule is bound to
    category: ApprovalCategory;
    scope: RememberedScope;
    grantedAt: string;
    revokedAt?: string;
    invalidationTrigger?: InvalidationTrigger;
  }>;
}

// RememberedRuleRevoke — the explicit revocation path (Spec-012 line 92);
// writes revoked_at + 'explicit' and emits `approval.rule_revoked`
interface RememberedRuleRevokeRequest {
  ruleId: RememberedRuleId;
}
interface RememberedRuleRevokeResponse {
  ruleId: RememberedRuleId;
  revokedAt: string;
  invalidationTrigger: "explicit";
}
```

### Approval Method-Name Registry (Tier 6)

Plan-012's approval surface is exposed as five `approval.*` methods, ratified by the Tier-6 plan-readiness audit (D-012-5; findings F-012-1-13/-14, F-012-3-01/-04, F-012-4-04). Names register under the Plan-007-partial daemon `MethodRegistry` at Tier 6 per the §5 substrate-vs-namespace carve-out (`repo.*` precedent); registration's BL-142 precondition (all five tails are camelCase) and BL-143 typed-domain-error-projection precondition are both resolved (2026-06-21). These methods ride the **daemon JSON-RPC transport only** — approval state is daemon-local SQLite per ADR-017 (coordination-records-only Postgres; no control-plane approval storage or tRPC sibling exists in V1; cross-participant visibility rides roster-gated relay distribution of `approval_flow` events into each peer daemon's own projection, ADR-017 Option B). Method strings are imperative and disjoint-by-form from the past-participle Spec-006 `approval_flow` durable event names (`approval.resolve` method vs `approval.approved` event; `approval.ruleRevoke` vs `approval.rule_revoked` — the underscore event form is regex-invalid as a method name). `PermissionCheck` is deliberately **not** registered: it is the daemon-internal pre-execution gate (Spec-012: "inside the local daemon"), no V1 client consumes a wire preflight, and exposing one would invite stale-verdict (time-of-check/time-of-use) authorization against the security gate (D-012-5/D-012-18). The plural `approvals.listPending` gloss formerly in Spec-023 §Approvals View is superseded by this registry (reconciled in the Tier-6 working copy; Plan-023's Tier-8 audit owns the full-file pass per CP-012-8).

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `approval.requestCreate` | `mutation` | `ApprovalRequestCreateRequest` | `ApprovalRequestCreateResponse` |
| `approval.resolve` | `mutation` | `ApprovalResolveRequest` | `ApprovalResolveResponse` |
| `approval.projectionRead` | `query` | `ApprovalProjectionReadRequest` | `ApprovalProjectionReadResponse` |
| `approval.ruleList` | `query` | `RememberedRuleListRequest` | `RememberedRuleListResponse` |
| `approval.ruleRevoke` | `mutation` | `RememberedRuleRevokeRequest` | `RememberedRuleRevokeResponse` |

Canonical Zod schemas live in `packages/contracts/src/approval.ts` per the §Source-of-Truth Policy.

---

## Tier 7: Plans 011, 014, 015 (Task 4.8)

### Plan-011 — Gitflow PR And Diff Attribution

```ts
// BranchContextRead — exactly one of branchContextId | (worktreeId + workspaceId) (Zod
// refinement, the WorkspaceExecutionModeCapabilitiesRead discipline): branchContextId is
// minted by repo.executionRootPrepare for every writable mode, so branch- and clone-anchored
// contexts stay readable; the worktree-keyed arm serves worktree-anchored flows that hold
// only the owning worktree id (Spec-011 §Interfaces And Contracts) and MUST pair it with the
// requesting workspaceId: explicit cross-workspace reuse (Plan-010 D-010-15) upserts one
// branch_contexts row per (workspace, worktree) binding while retaining the same worktree_id
// across workspaces, so worktreeId alone is 1:N — the pair resolves exactly one row via the
// partial-unique binding index (local-sqlite-schema.md branch_contexts).
interface BranchContextReadRequest {
  branchContextId?: BranchContextId;
  worktreeId?: WorktreeId;
  workspaceId?: WorkspaceId; // required with worktreeId (the pair is the key); absent on the branchContextId arm
}
interface BranchContextReadResponse {
  branchContextId: BranchContextId;
  workspaceId: WorkspaceId;
  baseBranch: string;
  headBranch: string;
  upstreamRef?: string;
  worktreeId?: WorktreeId; // present only for worktree-anchored contexts (branch_contexts at-most-one association CHECK)
  ephemeralCloneId?: EphemeralCloneId; // present only for clone-anchored contexts
}

// DiffArtifactCreate. Discriminated union over `attributionMode` (Spec-011:52/58, D-011-2) — the arm
// structurally fixes which workspace-resolver key is present, so the {runId XOR workspaceId} invariant is
// unrepresentable-when-violated (the prior optional-pair interface let a caller send both or neither). This
// mirrors the at-rest biconditional CHECK in local-sqlite-schema.md (diff_artifacts): run_attributed
// requires run_id present + workspace_id absent, workspace_fallback requires run_id absent + workspace_id
// present. The producing workspace — hence the
// repo to diff (baseRef..headRef) and the session for the minted manifest — is resolved one way per arm; the
// computed diff is the payload that mints the linked artifact_manifests row (CP-011-2; artifact_manifests
// .session_id NOT NULL, local-sqlite-schema.md), so the manifest is never payload-less (D-014-1).
// diff_artifacts persists workspace_id for the workspace_fallback arm (the durable workspace-level provenance
// label Spec-011:44 mandates — D-011-4; run_attributed persists no workspace_id, its workspace reachable via
// the run's run_execution_contexts.workspace_id). No session_id column: the session is reached via the
// artifact_manifest_id FK (NOT NULL).
type DiffArtifactCreateRequest =
  | {
      attributionMode: "run_attributed"; // a diff that correlates to run provenance (Spec-011:52/58, D-011-2)
      runId: RunId; // required; the daemon resolves the producing workspace from runId (run_execution_contexts.workspace_id) — both the repo to diff and the minted manifest's session
      baseRef: string;
      headRef: string;
    }
  | {
      attributionMode: "workspace_fallback"; // precise run attribution unavailable; a workspace-level diff (Spec-011:52/58, D-011-2; the prior agent_trace/git_diff pair conflated the provenance-quality axis with the attribution mechanism)
      workspaceId: WorkspaceId; // required; the fallback arm carries no runId, so it names its workspace explicitly — the daemon locates the repo via workspaces.repo_mount_id (repo_mounts.canonical_root) and derives the minted manifest's session via workspaces.session_id, symmetric to run_attributed. sessionId would be the wrong grain: a session holds many workspaces, and baseRef/headRef do not name a repo.
      baseRef: string;
      headRef: string;
    };
interface DiffArtifactCreateResponse {
  diffArtifactId: string;
  artifactManifestId: ArtifactId;
  createdAt: string;
}

// PRPrepare
interface PRPrepareRequest {
  branchContextId: BranchContextId;
  targetBranch: string;
  title?: string;
  description?: string;
}
interface PRPrepareResponse {
  prPreparationId: string;
  state: "draft" | "ready";
  proposalBlob: Record<string, unknown>;
}

// GitActionExecute
interface GitActionExecuteRequest {
  repoMountId: RepoMountId;
  action: string; // normalized action name
  params: Record<string, unknown>;
  causationRunId?: RunId;
  causationParticipantId?: ParticipantId;
}
interface GitActionExecuteResponse {
  success: boolean;
  output?: string;
  error?: string;
}

// GitHostingAdapter (internal interface — host-agnostic; V1 wraps `gh` CLI)
interface GitHostingAdapter {
  createChangeRequest(params: ChangeRequestParams): Promise<ChangeRequestResult>;
  updateChangeRequest(params: UpdateChangeRequestParams): Promise<void>;
  listChangeRequests(params: ListChangeRequestsParams): Promise<ChangeRequestSummary[]>;
  getChangeRequestStatus(params: GetChangeRequestStatusParams): Promise<ChangeRequestStatus>;
  addComment(params: AddCommentParams): Promise<CommentResult>;
}

// --- GitHostingAdapter supporting types (D-011-1; host-agnostic, Spec-011 §GitHostingAdapter
//     Interface lines 129-152). Every shape uses generic ChangeRequest terminology — callers never
//     reference GitHub-specific concepts (Spec-011:150). V1 binds each method to a `gh` CLI subcommand
//     (Spec-011:135-139); field names normalize the `gh` contract — reads via `gh pr … --json`; writes
//     whose porcelain `gh pr` subcommand has no `--json` (create, comment) each resolve their structured
//     result without scraping a porcelain table (Spec-011:141): `addComment` posts via the JSON-returning
//     `gh api` REST path (Spec-011:139), while `createChangeRequest` runs `gh pr create` — which prints only
//     the new PR URL to stdout — then passes that one URL to `gh pr view <created-url> --json number,url`
//     (Spec-011:135). Two distinct mechanisms; neither parses porcelain-table stdout (gh-mapping noted inline).
//     Every params shape carries a `repoMountId` identifying the target repository context — all
//     operations accept one (Spec-011:141); the adapter resolves it to the repo's working tree / `gh -R`. ---
interface ChangeRequestParams {
  // → gh pr create (prints only the new PR URL to stdout — no --json; Spec-011:135), then
  //   gh pr view <created-url> --json number,url to resolve the handle. The URL is passed
  //   explicitly: a bare gh pr view resolves the CURRENT branch's PR, not the one just
  //   created on an arbitrary headBranch (Spec-011:141).
  repoMountId: RepoMountId; // target repository context — all operations accept it (Spec-011:141)
  baseBranch: string; // target branch the change merges into (--base)
  headBranch: string; // source branch carrying the change (--head)
  title: string;
  description: string; // change-request body (--body)
  reviewers?: string[]; // optional requested reviewers (--reviewer)
}
interface ChangeRequestResult {
  changeRequestId: string; // host-agnostic handle for subsequent update/status/comment calls (gh pr view <created-url> --json number → number, stringified)
  number: number; // host-assigned change-request number (gh pr view <created-url> --json number)
  url: string; // canonical web URL (gh pr create prints this URL to stdout; passed back into gh pr view <created-url> --json to resolve number)
}
interface UpdateChangeRequestParams {
  // → gh pr edit (Spec-011:136) — partial: only provided fields change
  repoMountId: RepoMountId; // target repository context (Spec-011:141)
  changeRequestId: string; // which change request to edit (gh pr edit <number>)
  title?: string;
  description?: string;
  reviewers?: string[];
  labels?: string[]; // --add-label / --remove-label reconciliation
}
interface ListChangeRequestsParams {
  // → gh pr list (Spec-011:137)
  repoMountId: RepoMountId; // target repository context (Spec-011:141)
  state?: "open" | "merged" | "closed" | "all"; // optional lifecycle filter (--state)
  labels?: string[]; // optional label filter (--label)
}
interface ChangeRequestSummary {
  changeRequestId: string; // host-agnostic handle (gh: number, stringified)
  number: number;
  title: string;
  state: "open" | "merged" | "closed"; // normalized lifecycle state (gh: state OPEN|MERGED|CLOSED, lowercased)
  headBranch: string; // gh: headRefName
  baseBranch: string; // gh: baseRefName
  url: string;
  isDraft: boolean; // gh: isDraft
}
interface GetChangeRequestStatusParams {
  repoMountId: RepoMountId; // target repository context (Spec-011:141)
  changeRequestId: string; // which change request to query (gh pr view <number>, Spec-011:138)
}
interface ChangeRequestStatus {
  // → gh pr view (Spec-011:138) — "open/merged/closed plus CI check results"
  changeRequestId: string;
  state: "open" | "merged" | "closed"; // normalized lifecycle state (gh: state)
  mergeable: "mergeable" | "conflicting" | "unknown"; // normalized from gh: mergeable (GitHub MergeableState MERGEABLE/CONFLICTING/UNKNOWN); "unknown" = host still computing
  reviewDecision?: "approved" | "changes_requested" | "review_required"; // gh: reviewDecision (normalized)
  checks: Array<{ name: string; status: "pending" | "success" | "failure" }>; // CI rollup normalized from gh: statusCheckRollup (status×conclusion → the decision-relevant trichotomy)
}
interface AddCommentParams {
  // → gh api repos/{owner}/{repo}/issues/{number}/comments — gh pr comment exposes no --json/id (Spec-011:139)
  repoMountId: RepoMountId; // target repository context (Spec-011:141)
  changeRequestId: string; // which change request to comment on — the PR number is the {number} path segment of the gh api issues/comments endpoint (Spec-011:139)
  body: string; // comment markdown (gh api -f body=…)
}
interface CommentResult {
  commentId: string; // host-agnostic comment handle (gh api .../issues/{number}/comments → id, stringified; gh pr comment exposes no --json/id)
  url: string; // canonical web URL of the posted comment (gh api → html_url)
}
```

Plan-011's gitflow PR-preparation and diff-attribution surface is exposed as four `gitflow.*` methods, ratified by the Tier-7 plan-readiness audit (Plan-011 D-011-5; Codex round-19 finding KuB_5). Method-name strings are `dotted-camelCase` per the canonical `METHOD_NAME_FORMAT` ratified in §Tier 1 (cont.): Plan-007 above — the `gitflow` namespace token is the gitflow domain noun (the Plan-011-owned `runtime-daemon/src/gitflow/` daemon module, D-011-3; consumed client-side by the `gitflowClient` SDK, Plan-011 §Target Areas). The PascalCase request/response type symbols (`PRPrepare`, `GitActionExecute`, …) are **rejected** as method strings by that regex — it reserves PascalCase for the project's TypeScript type-name convention — so each wire name differs from its payload type symbol. Names register under the Plan-007-partial daemon `MethodRegistry` per the §5 substrate-vs-namespace carve-out; registration's [BL-142](../../archive/backlog-archive.md) precondition (registry-regex conformance to the Tier-1 `METHOD_NAME_FORMAT`) is resolved (2026-06-21). These methods ride the **daemon JSON-RPC transport only** — branch contexts, diff artifacts, and PR preparations are node-local SQLite + local-git state (`branch_contexts` / `diff_artifacts` / `pr_preparations`, local-sqlite-schema.md), so no control-plane tRPC sibling exists.

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `gitflow.branchContextRead` | `query` | `BranchContextReadRequest` | `BranchContextReadResponse` |
| `gitflow.diffArtifactCreate` | `mutation` | `DiffArtifactCreateRequest` | `DiffArtifactCreateResponse` |
| `gitflow.prPrepare` | `mutation` | `PRPrepareRequest` | `PRPrepareResponse` |
| `gitflow.gitActionExecute` | `mutation` | `GitActionExecuteRequest` | `GitActionExecuteResponse` |

`gitflow.branchContextRead` is the only `query` (an idempotent branch-context read); the three writes are `mutation`s per the tRPC procedure-type convention in §Tier 1 (cont.): Plan-008 above — `diffArtifactCreate` mints a `diff_artifacts` row plus its linked `artifact_manifests` row (CP-011-2), `prPrepare` writes the durable `pr_preparations` record, and `gitActionExecute` performs the remote git mutation. The `GitHostingAdapter` interface and its nine supporting types (above) are daemon-internal (V1 wraps the `gh` CLI, D-011-1) — not registered wire methods. Canonical Zod schemas live in `packages/contracts/src/gitflow.ts` per the §Source-of-Truth Policy.

### Plan-014 — Artifacts Files And Attachments

```ts
// --- ArtifactManifest: the persisted manifest record — the OCI-inspired envelope (Spec-014
//     line 72) plus the daemon-persisted `visibility`/`state`/`metadata` fields (not in line 72).
//     Defined once here (the `ArtifactManifest` shape Plan-014 Task 1 mints in
//     packages/contracts/src/artifacts/); ArtifactPublish returns it (Spec-014 line 68),
//     ArtifactRead returns it plus a payload handle/inline (Spec-014 line 69). 1:1 with the
//     `artifact_manifests` row — each field a dedicated column (D-014-2), incl. `annotations`
//     as a first-class OCI string→string map, never folded into freeform `metadata`. Plan-011's
//     DiffArtifact (artifactType: "diff") rides this envelope per CP-014-1 / CP-011-2. ---

// artifactType discriminator (Spec-014 line 73) — the five Spec-014:41 families (file, diff, summary,
// log, design) plus workflow_output, the Spec-017:237 (Tier-8) workflow phase-output type. Spec-014:41
// admits "at least" the five families, so the sixth value is additive, not a families-list rewrite (D-014-4).
type ArtifactType = "file" | "diff" | "summary" | "log" | "design" | "workflow_output";

interface ArtifactManifest {
  id: ArtifactId;
  sessionId: SessionId;
  runId?: RunId;
  artifactType: ArtifactType; // discriminator — Spec-014 line 73 (D-014-4: file|diff|summary|log|design|workflow_output)
  digest: string; // OCI `digest` (SHA-256) = SQLite content_hash — required: a content-addressed manifest always has one (I-014-1)
  size: number; // OCI manifest-descriptor `size` (payload byte length) = SQLite size_bytes — server-derived, always present
  annotations: Record<string, string>; // OCI `annotations` string-map = SQLite annotations (NOT NULL DEFAULT '{}') — distinct from freeform `metadata`
  subject?: ArtifactId; // OCI `subject`: present only on a derivative (redacted/summarized) manifest → source manifest (I-014-2, Spec-014 line 84)
  visibility: ArtifactVisibility;
  state: ArtifactState;
  replicationStatus?: string; // = SQLite `replication_status` (A-014-3): V1 writes `pending_replication` while a shared artifact awaits deferred payload transfer, absent otherwise; open set, no closed union (Spec-014:61 names only `pending_replication`; mirrors the at-rest no-CHECK column)
  metadata: Record<string, unknown>; // freeform daemon-side provenance/media-type — distinct from the OCI `annotations` map above
  createdAt: string;
}

// ArtifactPublish — Spec-014 line 68: "must return artifact id and manifest metadata."
interface ArtifactPublishRequest {
  sessionId: SessionId;
  runId?: RunId;
  artifactType: ArtifactType; // discriminator — see ArtifactManifest.artifactType (Spec-014 line 73; D-014-4)
  visibility: ArtifactVisibility;
  payload: Uint8Array | string;
  mediaType: string; // MIME type
  // --- producer-supplied OCI envelope inputs (D-014-3). `size`/`digest` are NOT here:
  //     the daemon derives size_bytes + content_hash from `payload`. ---
  subject?: ArtifactId; // OCI `subject`: set when publishing a derivative (redacted/summarized) form → points to the source manifest (I-014-2, Spec-014 line 84); omit for originals
  annotations?: Record<string, string>; // OCI `annotations` string-map persisted to artifact_manifests.annotations; distinct from freeform `metadata`
  metadata?: Record<string, unknown>;
}
interface ArtifactPublishResponse {
  manifest: ArtifactManifest; // embedded manifest metadata (Spec-014 line 68); manifest.id is the artifact id, manifest.digest the content hash — no resolvable-URL indirection (D-014-3)
}

// ArtifactRead — Spec-014 line 69: "must return manifest plus retrievable payload handle or inline content."
interface ArtifactReadRequest {
  artifactId: ArtifactId;
  includePayload?: boolean; // default false, returns handle only
}
interface ArtifactReadResponse {
  manifest: ArtifactManifest; // the same envelope ArtifactPublish embeds (Spec-014 line 69)
  payloadHandle?: string; // CAS key or URL for deferred retrieval
  payload?: Uint8Array; // only if includePayload=true and size permits
}

// ArtifactVisibilityUpdate
interface ArtifactVisibilityUpdateRequest {
  artifactId: ArtifactId;
  visibility: ArtifactVisibility;
}
interface ArtifactVisibilityUpdateResponse {
  artifactId: ArtifactId;
  visibility: ArtifactVisibility;
  updatedAt: string;
}

// AttachmentIngest
interface AttachmentIngestRequest {
  sessionId: SessionId;
  runId?: RunId;
  fileName: string;
  mediaType: string;
  sizeBytes: number;
  payload: Uint8Array;
}
interface AttachmentIngestResponse {
  artifactId: ArtifactId;
  contentHash: string;
  normalizedName: string;
}
```

> **Tier-7 audit (NS-19) — ratified design (Plan-014 → `approved`).** The ArtifactPublish/ArtifactRead pair now composes a single named `ArtifactManifest` envelope (Spec-014 line 72) instead of inlining and duplicating the fields — this is the `ArtifactManifest` shape Plan-014 Task 1 mints, and the envelope Plan-011's `DiffArtifact` (`artifactType: "diff"`) rides per CP-014-1 / CP-011-2 (Plan-011 consumes the envelope **concept**, unchanged, not a flat field layout). `ArtifactPublishResponse` embeds `manifest: ArtifactManifest` per Spec-014 line 68 ("must return artifact id **and manifest metadata**") — this **replaces the prior `manifestUrl` pointer**, which was drift from that "must" clause: line 69 grants handle/inline latitude to the **payload** on _Read_ only, never to the manifest, so both responses return the manifest metadata inline (D-014-3 — resolved by aligning the wire to the spec, not an owner decision). `ArtifactReadResponse` is `manifest` + `payloadHandle?`/`payload?` (Spec-014 line 69). The wire envelope mirrors the `artifact_manifests` row in [Local SQLite Schema](../schemas/local-sqlite-schema.md) 1:1: `digest`/`size` are **required** on the wire because a content-addressed manifest always carries both (I-014-1), and the at-rest `content_hash`/`size_bytes` columns are correspondingly **`NOT NULL`** — each producer (AttachmentIngest, ArtifactPublish) computes the SHA-256 + byte length from its own payload and inserts its manifest with both columns set in the same transaction as the payload-ref, and AttachmentIngest and ArtifactPublish are independent producers (the `artifactId` `AttachmentIngestResponse` returns resolves from the ingest-written manifest, not a later publish), so there is no payload-less manifest to reconcile (D-014-1). `annotations` is a dedicated OCI string→string column (D-014-2; at-rest `NOT NULL DEFAULT '{}'`), required on the wire, never folded into freeform `metadata`. The at-rest `replication_status` column (nullable) surfaces as the optional `replicationStatus?` wire field (A-014-3 — V1 writes `pending_replication` while a shared artifact awaits deferred payload transfer; open set, no closed union, mirroring the at-rest no-CHECK stance). Producer inputs are closed too (D-014-3): `ArtifactPublishRequest` accepts `subject?` (so a Task-4 I-014-2 derivative names its source at publish) and `annotations?`, while `size`/`digest` stay server-derived from `payload` — otherwise the `annotations` column and derivative `subject` would be write-dead. This wire edit + the `local-sqlite-schema.md` artifact edit + Plan-014 CP-014-1 / Task 3 form one whole-or-not bundle.

### Plan-015 — Persistence Recovery And Replay

```ts
// RecoveryStatusRead
interface RecoveryStatusReadRequest {
  sessionId?: SessionId; // omit for daemon-wide status
}
interface RecoveryStatusReadResponse {
  overall: "healthy" | "replaying" | "degraded" | "blocked";
  sessions: Array<{
    sessionId: SessionId;
    state: "healthy" | "replaying" | "degraded" | "blocked";
    lastReplayedSequence?: number;
    failureCategory?: RunFailureCategory;
    recoveryCondition?: "recovery-needed";
  }>;
}

// ReplayReadAfterCursor
interface ReplayReadAfterCursorRequest {
  sessionId: SessionId;
  afterSequence: number;
  limit?: number;
}
interface ReplayReadAfterCursorResponse {
  events: EventEnvelope[];
  nextSequence: number;
  hasMore: boolean;
}

// ProjectionRebuild (idempotent operation)
interface ProjectionRebuildRequest {
  sessionId: SessionId;
  force?: boolean; // rebuild even if projections appear current
}
interface ProjectionRebuildResponse {
  sessionId: SessionId;
  rebuiltProjections: string[];
  asOfSequence: number;
}

// RuntimeBindingRead
interface RuntimeBindingReadRequest {
  runId: RunId;
}
interface RuntimeBindingReadResponse {
  runId: RunId;
  driverName: string;
  contractVersion: string;
  resumeHandle?: string;
  runtimeMetadata: Record<string, unknown>;
}
```

---

## Tier 8: Plans 013, 019, 020 (Task 4.9)

### Plan-013 — Live Timeline Visibility And Reasoning Surfaces

```ts
// TimelineRead
interface TimelineReadRequest {
  sessionId: SessionId;
  afterCursor?: EventCursor;
  beforeCursor?: EventCursor;
  limit?: number;
  channelId?: ChannelId; // filter to specific channel
}
interface TimelineReadResponse {
  entries: TimelineEntry[];
  nextCursor?: EventCursor;
  hasMore: boolean;
}

interface TimelineEntry {
  id: string;
  sessionId: SessionId;
  sequence: number;
  category: EventCategory;
  type: string;
  actor?: string;
  summary: string; // human-readable summary
  timestamp: string;
  childRunSummary?: ChildRunSummary; // if this is a summarized child-run row
  payload: Record<string, unknown>;
}

interface ChildRunSummary {
  runId: RunId;
  parentRunId: RunId;
  state: RunState;
  producingNodeId?: NodeId;
  eventCount: number;
}

// TimelineSubscribe
interface TimelineSubscribeRequest {
  sessionId: SessionId;
  afterCursor?: EventCursor;
  channelId?: ChannelId;
}
// Response: SSE stream of TimelineEntry

// ReasoningSurfaceRead
interface ReasoningSurfaceReadRequest {
  runId: RunId;
}
interface ReasoningSurfaceReadResponse {
  available: boolean;
  policyReason?: string; // why reasoning may be hidden
  reasoningEntries?: Array<{
    sequence: number;
    content: string;
    timestamp: string;
  }>;
}

// ChildRunExpand
interface ChildRunExpandRequest {
  runId: RunId; // child run to expand
}
interface ChildRunExpandResponse {
  runId: RunId;
  parentRunId: RunId;
  state: RunState;
  entries: TimelineEntry[];
}
```

### Plan-019 — Notifications And Attention Model

```ts
// AttentionProjectionRead
interface AttentionProjectionReadRequest {
  sessionId: SessionId;
  scope?: "run" | "session";
}
interface AttentionProjectionReadResponse {
  items: AttentionItem[];
}

interface AttentionItem {
  id: string;
  sessionId: SessionId;
  runId?: RunId;
  trigger:
    | "pending_approval"
    | "pending_input"
    | "run_completed"
    | "run_failed"
    | "invite_received"
    | "mention";
  severity: "actionable" | "informational";
  summary: string;
  sourceEventId: string; // canonical event that triggered this
  createdAt: string;
  resolvedAt?: string;
}

// NotificationPreferenceRead
interface NotificationPreferenceReadRequest {
  participantId: ParticipantId;
}
interface NotificationPreferenceReadResponse {
  preferences: Array<{
    key: string;
    value: Record<string, unknown>;
  }>;
}

// NotificationPreferenceUpdate
interface NotificationPreferenceUpdateRequest {
  participantId: ParticipantId;
  key: string;
  value: Record<string, unknown>;
}
interface NotificationPreferenceUpdateResponse {
  updatedAt: string;
}

// NotificationEmit (internal operation)
interface NotificationEmitParams {
  participantId: ParticipantId;
  trigger: string;
  sourceEventId: string;
  summary: string;
  metadata?: Record<string, unknown>;
}
```

### Plan-020 — Observability And Failure Recovery

```ts
// HealthStatusRead
interface HealthStatusReadRequest {
  scope?: "daemon" | "control_plane" | "provider" | "replay";
}
interface HealthStatusReadResponse {
  overall: "healthy" | "degraded" | "unhealthy";
  components: Array<{
    name: string;
    state: "healthy" | "degraded" | "unhealthy";
    lastChecked: string;
    details?: Record<string, unknown>;
  }>;
}

// FailureDetailRead
interface FailureDetailReadRequest {
  runId: RunId;
}
interface FailureDetailReadResponse {
  runId: RunId;
  failureCategory: RunFailureCategory;
  recoveryCondition?: "recovery-needed";
  humanSummary: string;
  technicalDetails: Record<string, unknown>;
  occurredAt: string;
}

// StuckRunInspect
interface StuckRunInspectRequest {
  runId: RunId;
}
interface StuckRunInspectResponse {
  runId: RunId;
  currentState: RunState;
  lastProgressAt: string;
  lastEventTime: string;
  blockingReason?: string;
  healthSignal: "stuck-suspected" | "healthy";
  suggestedAction?: "interrupt" | "retry" | "escalate";
}

// RecoveryActionRequest
interface RecoveryActionRequestRequest {
  runId: RunId;
  action: "retry" | "interrupt" | "abandon";
  reason?: string;
}
interface RecoveryActionRequestResponse {
  runId: RunId;
  previousState: RunState;
  newState: RunState;
  actionTaken: string;
}
```

---

## Tier 6 / Tier 8: Plans 016, 017 (Task 4.10)

Heading retitled by the Tier-6 audit: Plan-016 executes at Tier 6 (cross-plan-dependencies §4 build order); Plan-017 at Tier 8. The original "Tier 9" label predated the tier graph.

### Plan-016 — Multi-Agent Channels And Orchestration

Contracts rewritten during the Tier-6 plan-readiness audit (D-016-1..20). Canonical TypeScript source once shipped: `packages/contracts/src/orchestration.ts` (single file — ChannelCreate included; Plan-002's `channels.ts` is read-projection-only and stays untouched). `AgentId` is a new branded UUID (`brandedUuidIdSchema<AgentId>("AgentId")`). All mutations are daemon JSON-RPC (channel/orchestration/agent authority is daemon-local, ADR-001/ADR-003 posture); `channel.list` remains Plan-002's SDK-declared daemon-as-gateway directory read and is NOT part of this surface.

```ts
// Typed configs (D-016-4) — replace the former Record<string, unknown> placeholders
type TurnPolicy = "free-form" | "round-robin" | "request-based"; // Spec-016 §Turn Policies; default "free-form"
interface ChannelConfig {
  turnPolicy?: TurnPolicy;
  roundRobinOrder?: AgentId[]; // REQUIRED non-empty when turnPolicy === "round-robin" (validation error otherwise)
  moderation?: { preTurnGate?: boolean; postTurnReview?: boolean }; // Spec-016 §Moderation Hooks; both default false (V1 opt-in)
}
interface OrchestrationRunConfig {
  tokenLimit?: number; // per-run token budget; default 100000 (Spec-016 §Budget Policies)
  idleTimeoutMs?: number; // idle stop condition; default 300000 (Spec-016 §Stop Conditions)
}
type LinkType = "spawn" | "delegate" | "handoff"; // D-016-17: spawn = parent-initiated helper returning output to the parent's channel context; delegate = bounded task published to its own target channel; handoff = parent transfers its continuation to the child and completes
type InterruptReason = "budget_exhausted" | "idle_timeout" | "moderation_denied"; // D-016-8: closed set carried on system-initiated interrupts

// ChannelCreate — wire: channel.create (refuses the reserved main name — main is projected, never a row; D-016-15)
interface ChannelCreateRequest {
  sessionId: SessionId;
  name?: string;
  config?: ChannelConfig;
}
interface ChannelCreateResponse {
  channelId: ChannelId;
  state: ChannelState;
  createdAt: string;
}

// ChannelMute / ChannelUnmute / ChannelArchive — wire: channel.mute / channel.unmute / channel.archive (D-016-12)
interface ChannelLifecycleRequest {
  channelId: ChannelId;
}
interface ChannelLifecycleResponse {
  channelId: ChannelId;
  state: ChannelState; // post-transition state; archived is terminal
}

// ChannelRosterRead — wire: channel.rosterRead (D-016-6; daemon-native session-local roster
// — distinct from Plan-002's channel.list control-plane directory read)
interface ChannelRosterReadRequest {
  sessionId: SessionId;
}
interface ChannelRosterReadResponse {
  channels: Array<{
    id: ChannelId; // synthesized main (deriveMainChannelId(sessionId), CP-002-7) listed first
    name?: string;
    state: ChannelState;
    config: ChannelConfig;
    arbitration: {
      state: "active" | "paused"; // round-robin arbitration pause (Spec-016:122-124) — daemon projection from arbitration.* events
      turnPolicy: TurnPolicy;
      unreachableNodeId?: NodeId; // present while paused on an unreachable node
      unreachableAgentId?: AgentId;
    };
    createdAt: string; // synthesized main carries the session createdAt
  }>;
}

// OrchestrationRunCreate — wire: orchestration.runCreate (admission pipeline D-016-13:
// agent resolution -> depth -> active-child -> scheduler limits -> budget block -> turn gate ->
// Plan-004 queue admission; zero-residue typed refusal + durable orchestration.rejected on deny)
interface OrchestrationRunCreateRequest {
  sessionId: SessionId;
  parentRunId?: RunId; // present = child run; child-of-child refused (depth 1, Spec-016:198)
  targetAgentId: AgentId; // must resolve in the agents projection (agent.not_found / agent.not_ready)
  targetNodeId?: NodeId; // V1: must be locally attached or absent (orchestration.node_not_local; cross-node = Spec-024/Plan-027, D-016-9)
  targetChannelId: ChannelId; // accepts the derived main id without a channels row (D-016-15)
  linkType?: LinkType; // default "spawn" (meaningful only with parentRunId)
  internalHelper?: boolean; // marks as non-user-facing; durable in run_links.internal_helper (default false)
  config?: OrchestrationRunConfig; // per-run override; admission resolves against session defaults and persists the merged result durably on run.queued (effectiveRunConfig — D-016-5 replay-stable enforcement)
}
interface OrchestrationRunCreateResponse {
  runId: RunId; // minted at Plan-004 queue admission (run.queued); orchestration adds no second id
  state: RunState; // "queued" at create
  parentRunId?: RunId;
  channelId: ChannelId;
  internalHelper: boolean; // echo of the durable flag (I-016-10)
}

// ChildRunLinkRead — wire: orchestration.childRunLinkRead (projection of run_links —
// single-parent: `child_run_id` is the PK, so a child appears under exactly one parent;
// D-016-3). `rejectedCreates` is event-folded at read time from the parent's
// `orchestration.rejected` events: zero-residue refusals (I-016-8) leave no run/queue/
// link row, so the fold is the only data path that lets the child-run view surface
// refusal records (events-canonical projection, the BudgetAccountant posture — Tier-6 audit).
interface ChildRunLinkReadRequest {
  parentRunId: RunId;
}
interface ChildRunLinkReadResponse {
  links: Array<{
    childRunId: RunId;
    linkType: LinkType;
    internalHelper: boolean; // never dropped between durable home and read surface (I-016-10)
    producingNodeId: NodeId;
    visibility: "reachable" | "unreachable"; // daemon-projected from runtimenode.roster liveness — never client-inferred
    state: RunState;
    createdAt: string;
  }>;
  rejectedCreates: Array<{
    // folded from `orchestration.rejected` events with payload.parentRunId = request.parentRunId
    targetChannelId?: ChannelId;
    targetAgentId?: AgentId;
    reason: string; // the refusing error-contracts.md code — the orchestration.runCreate admission vocabulary spans §Agent (agent.not_found / agent.not_ready), §Channel (channel.inactive), §Orchestration, and §Run (run.not_found parent reuse, D-016-16)
    detail?: string;
    occurredAt: string; // the event envelope timestamp
  }>;
}

// BudgetRead / BudgetUpdate — wire: orchestration.budgetRead / orchestration.budgetUpdate (D-016-5;
// session_budgets row-canonical; budgetUpdate is session-owner-only — Spec-016 "session admin" = role "owner")
interface OrchestrationBudgetReadRequest {
  sessionId: SessionId;
}
interface OrchestrationBudgetState {
  sessionId: SessionId;
  costLimitCents: number; // default 1000 ($10/session)
  turnLimitPerAgent: number; // default 50
  maxExecutingChannels: number; // default 5
  maxQueueDepthPerChannel: number; // default 25
  maxPendingOrchestrationRuns: number; // default 10
  activeChildLimit: number; // default 5
  observedCostCents: number; // BudgetAccountant projection (in-memory, replay-rebuilt)
}
type OrchestrationBudgetReadResponse = OrchestrationBudgetState;
interface OrchestrationBudgetUpdateRequest {
  // every provided limit must be a non-negative integer — Zod .int().nonnegative(),
  // mirroring the session_budgets CHECK constraints (local-sqlite-schema.md §Channel and Orchestration Tables)
  sessionId: SessionId;
  costLimitCents?: number;
  turnLimitPerAgent?: number;
  maxExecutingChannels?: number;
  maxQueueDepthPerChannel?: number;
  maxPendingOrchestrationRuns?: number;
  activeChildLimit?: number;
}
type OrchestrationBudgetUpdateResponse = OrchestrationBudgetState;

// Agent surface (A-016-2 — Plan-016 owns the V1 agent identity + lifecycle surface).
// AgentState is the canonical 4-state lifecycle from domain/agent-channel-and-run-model.md
// §Lifecycle — the contract adopts it rather than minting a parallel enum. V1 wire mapping:
// agent.attach -> "ready" ("configured" when the named default node is not currently attached);
// agent.detach -> "disabled"; re-attach -> "ready"; "archived" is registered but no V1 wire
// mutation reaches it (a future workflow/V1.1 surface). agent.not_ready fires for any state
// other than "ready". The daemon resolves the resulting state at emission time and carries it
// on the agent.* event payloads so the agents projection is deterministic from the log alone.
// wire: agent.attach / agent.detach / agent.configUpdate / agent.list
type AgentState = "configured" | "ready" | "disabled" | "archived";
interface AgentAttachRequest {
  sessionId: SessionId;
  name: string;
  driverName: string; // Plan-005 provider-driver key
  modelId: string;
  defaultNodeId?: NodeId;
  config?: Record<string, unknown>; // driver-scoped, opaque to this contract
}
interface AgentAttachResponse {
  agentId: AgentId;
  state: AgentState; // "ready" | "configured" at attach
  createdAt: string;
}
interface AgentDetachRequest {
  agentId: AgentId;
}
interface AgentDetachResponse {
  agentId: AgentId;
  state: AgentState; // "disabled" at detach
}
interface AgentConfigUpdateRequest {
  agentId: AgentId;
  name?: string;
  modelId?: string;
  defaultNodeId?: NodeId | null; // tri-state: absent = leave unchanged; null = clear the pin (table NULL = any local attached node); value = rebind — rebinding/clearing may flip "configured" <-> "ready"
  config?: Record<string, unknown>;
}
interface AgentConfigUpdateResponse {
  agentId: AgentId;
  state: AgentState; // post-update state (rebind may have changed it)
  updatedAt: string;
}
interface AgentListRequest {
  sessionId: SessionId;
}
interface AgentListResponse {
  agents: Array<{
    agentId: AgentId;
    name: string;
    driverName: string;
    modelId: string;
    defaultNodeId?: NodeId;
    config: Record<string, unknown>; // driver-scoped persona config (Spec-016 A-016-2); {} when never supplied (agents.config NOT NULL DEFAULT '{}')
    state: AgentState;
    createdAt: string;
  }>;
}

// Orchestration queue-admission carrier (D-016-13) — IN-PROCESS seam type, not a wire shape:
// the orchestration-run-service passes it to Plan-004's daemon queue-admission service after its
// own admission pipeline passes; the run.queued event payload then carries these fields durably
// (Spec-006:187 additive optional fields). The wire run.queueCreate handler never populates it —
// child-run creation goes through orchestration.runCreate only.
interface OrchestrationRunLinkCarrier {
  parentRunId?: RunId;
  linkType: LinkType;
  internalHelper: boolean;
  agentId: AgentId; // name mirrors the run.queued additive payload field verbatim (CP-004-10); the service maps the validated wire targetAgentId here after agent resolution
  producingNodeId: NodeId;
  effectiveRunConfig: OrchestrationRunConfig; // admission-resolved post-merge values (request override else session default), persisted on run.queued so budget/idle enforcement rebuilds replay-stable (D-016-5, I-016-14)
}
```

**Method-string registry — Plan-016** (daemon JSON-RPC; all strings now enabled by [BL-142](../../archive/backlog-archive.md) for camelCase-tail registration and [BL-143](../../archive/backlog-archive.md) for typed-error wire projection, both resolved 2026-06-21):

| Method | Procedure type | Request → Response | Notes |
| --- | --- | --- | --- |
| `channel.create` | RPC | `ChannelCreateRequest` → `ChannelCreateResponse` | First daemon-native handler under the `channel` root (root is Plan-002-declared via the `channel.list` gateway string; co-extension per the repo.\* precedent) |
| `channel.mute` | RPC | `ChannelLifecycleRequest` → `ChannelLifecycleResponse` | Emits `channel.muted` |
| `channel.unmute` | RPC | `ChannelLifecycleRequest` → `ChannelLifecycleResponse` | Emits `channel.unmuted` |
| `channel.archive` | RPC | `ChannelLifecycleRequest` → `ChannelLifecycleResponse` | Emits `channel.archived`; terminal |
| `channel.rosterRead` | RPC | `ChannelRosterReadRequest` → `ChannelRosterReadResponse` | Daemon-native session-local roster + arbitration facet; distinct from Plan-002's `channel.list` directory read |
| `orchestration.runCreate` | RPC | `OrchestrationRunCreateRequest` → `OrchestrationRunCreateResponse` | Admission pipeline; composes with Plan-004 queue admission in-process |
| `orchestration.childRunLinkRead` | RPC | `ChildRunLinkReadRequest` → `ChildRunLinkReadResponse` | run_links projection + event-folded `rejectedCreates` (zero-residue refusals, I-016-8) |
| `orchestration.budgetRead` | RPC | `OrchestrationBudgetReadRequest` → `OrchestrationBudgetReadResponse` |  |
| `orchestration.budgetUpdate` | RPC | `OrchestrationBudgetUpdateRequest` → `OrchestrationBudgetUpdateResponse` | Session-owner-only (wire-boundary authorization) |
| `agent.attach` | RPC | `AgentAttachRequest` → `AgentAttachResponse` | Emits `agent.attached` |
| `agent.detach` | RPC | `AgentDetachRequest` → `AgentDetachResponse` | Emits `agent.detached` |
| `agent.configUpdate` | RPC | `AgentConfigUpdateRequest` → `AgentConfigUpdateResponse` | Emits `agent.config_updated` |
| `agent.list` | RPC | `AgentListRequest` → `AgentListResponse` | agents-table projection |

Error vocabulary: [error-contracts.md](./error-contracts.md) §Channel / §Orchestration / §Agent (D-016-16). Durable events owned by Plan-016 (Spec-006 registrations): `channel.created` / `channel.muted` / `channel.unmuted` / `channel.archived`, `agent.attached` / `agent.detached` / `agent.config_updated`, `arbitration.paused` / `arbitration.resumed`, `orchestration.rejected`, `usage.budget_warning`, `moderation.review_flagged` — see [Spec-006 §Event Type Registry](../../specs/006-session-event-taxonomy-and-audit-log.md).

### Plan-017 — Workflow Authoring And Execution

```ts
// WorkflowDefinitionCreate
interface WorkflowDefinitionCreateRequest {
  sessionId: SessionId;
  name: string;
  scope: "session" | "channel";
  phaseDefinitions: PhaseDefinition[];
}
interface WorkflowDefinitionCreateResponse {
  definitionId: WorkflowDefinitionId;
  versionNumber: number;
  createdAt: string;
}

interface PhaseDefinition {
  phaseId: WorkflowPhaseId;
  name: string;
  type: "single-agent" | "automated"; // V1 scope
  gateType: "auto-continue" | "quality-checks" | "human-approval" | "done";
  failureBehavior: "retry" | "go-back-to" | "stop";
  config?: Record<string, unknown>;
}

// WorkflowDefinitionRead
interface WorkflowDefinitionReadRequest {
  definitionId: WorkflowDefinitionId;
  version?: number; // omit for latest
}
interface WorkflowDefinitionReadResponse {
  id: WorkflowDefinitionId;
  name: string;
  scope: "session" | "channel";
  versionNumber: number;
  phaseDefinitions: PhaseDefinition[];
  createdAt: string;
}

// WorkflowRunStart
interface WorkflowRunStartRequest {
  workflowVersionId: string; // definition_id + version
  sessionId: SessionId;
}
interface WorkflowRunStartResponse {
  workflowRunId: WorkflowRunId;
  state: "pending" | "running";
  phaseStates: PhaseState[];
}

interface PhaseState {
  phaseId: WorkflowPhaseId;
  state: "pending" | "running" | "completed" | "failed" | "skipped";
  gateState: "closed" | "open" | "bypassed";
}

// PhaseOutputRead
interface PhaseOutputReadRequest {
  workflowRunId: WorkflowRunId;
  phaseId: WorkflowPhaseId;
}
interface PhaseOutputReadResponse {
  phaseId: WorkflowPhaseId;
  state: "completed" | "failed";
  outputs: Array<{
    artifactId?: ArtifactId;
    summary: string;
    producedAt: string;
  }>;
}

// WorkflowGateResolve
interface WorkflowGateResolveRequest {
  workflowRunId: WorkflowRunId;
  phaseId: WorkflowPhaseId;
  resolution: "passed" | "failed" | "waiting-human";
  feedback?: string;
}
interface WorkflowGateResolveResponse {
  phaseId: WorkflowPhaseId;
  gateState: "open" | "closed";
  nextPhaseId?: WorkflowPhaseId;
}
```

---

## GDPR And Rate Limiting (Task 4.11)

### Spec-021 — Rate Limiting

Shapes below are canonical per [Plan-021](../../plans/021-rate-limiting-policy.md) (Tier-6 audit, D-021-6/D-021-14/D-021-17); code home is `packages/contracts/src/rate-limiter.ts` + `admin-bans.ts` (Plan-021 Phase 1). Endpoint-group keys come from [Spec-021 §Canonical Endpoint Group Registry](../../specs/021-rate-limiting-policy.md#canonical-endpoint-group-registry).

```ts
// RateLimitCheck (internal operation, both backends)
type RateLimitIdentityType = "participant" | "ip" | "token_hash" | "session" | "user"; // 'user' reserved dormant for the V1.1 keypackage.upload activation (Spec-021 row scoped per user; ADR-010 MLS gate) — no V1 surface constructs it (D-021-17)
type RateLimitTier = "anonymous" | "authenticated" | "elevated";

interface RateLimitCheckRequest {
  identity: string; // canonical form: participant/session UUID, IPv4 quad / IPv6 /64, Plan-002 token-hash; the reserved 'user' arm pins its form at V1.1 activation (D-021-14)
  identityType: RateLimitIdentityType;
  endpoint: RateLimitEndpointGroup; // registry-key union (Spec-021 registry)
  tier?: RateLimitTier; // resolved server-side; never caller-supplied
  context?: Record<string, unknown>;
}
// Two-arm union (Plan-021, Tier-6 audit): the degraded arm is minted only by the
// fail-open wrapper during grace and carries no window fields — nothing authoritative
// exists while the backend is unreachable; `graceEndsAt` = grace expiry (503 boundary).
type RateLimitCheckResponse =
  | {
      allowed: boolean;
      remaining: number;
      resetAt: string; // ISO 8601
      limit: number; // total threshold for this window
      degraded?: never;
      blockUntil?: string; // ISO 8601; set only when the denial is an active escalation block — the trip-vs-block discriminator (Plan-021 D-021-3)
    }
  | { allowed: true; degraded: true; graceEndsAt: string };
```

#### Admin Bans API (operator-token surface)

Raw HTTP routes matched before tRPC dispatch (Plan-021 D-021-10); authenticated by the deployment's operator admin token (D-021-1), not PASETO.

```ts
// POST /admin/bans  → 201 | 401 auth.token_invalid | 403 admin.forbidden | 409 admin.ban_already_exists
// (409 only on a genuinely active conflict — an expired-but-unrevoked standing ban is
// superseded on issue via atomic revoke-then-insert, Plan-021 D-021-12)
interface AdminBanCreateRequest {
  identity: string;
  identityType: RateLimitIdentityType;
  reason?: string;
  expiresAt?: string; // ISO 8601; omit for permanent
}
interface AdminBanCreateResponse {
  banId: string; // UUID
  issuedAt: string; // ISO 8601
  expiresAt: string | null;
}

// GET /admin/bans?activeOnly=<bool>&limit=<n>&cursor=<c>  (defaults: activeOnly=true, limit=100)
interface AdminBanListResponse {
  bans: Array<{
    banId: string;
    identity: string;
    identityType: RateLimitIdentityType;
    issuedBy: string; // operator attribution (server-derived per Plan-021 D-021-1; V1 single shared token → constant "deployment-operator")
    issuedAt: string;
    expiresAt: string | null;
    revokedAt: string | null;
    reason: string | null;
  }>;
  nextCursor: string | null;
}

// DELETE /admin/bans/:id → 204 No Content | 404 admin.ban_not_found
```

#### Relay Rate-Limit Signalling

WS overflow is drop-frame (Plan-021 D-021-9): a counter trip refuses the offending frame with ONE in-band error frame and keeps the connection; close code `4029` (private range) fires only for active escalation blocks; an active admin ban closes with `4003` (the 403-class `ratelimit.banned` analog — Spec-021 §WebSocket Overflow Response), enforced in observe mode too.

```ts
// In-band frame sent on counter trip (connection stays open)
interface RateLimitedFrame {
  type: "rate_limited";
  retryAfter: number; // seconds
  limit: number;
  remaining: 0;
  resetAt: string; // ISO 8601
}

// Close on active escalation block:
// code: 4029, reason: "rate_limit_blocked;retryAfter=<seconds>"
// Close on active admin ban (both modes — operator enforcement, never observe-suppressed):
// code: 4003, reason: "banned;retryAfter=<seconds>" (retryAfter segment omitted for permanent bans — no expiry exists)
```

### Spec-022 — Data Retention And GDPR

The three GDPR operations are V1 **daemon JSON-RPC stub methods** on Plan-007's `MethodRegistry` (Plan-022 D-022-3) — **not** control-plane HTTP routes. V1 returns the not-implemented stub (`-32603` + `data.type = "gdpr.endpoint_not_v1"`, see [Error Contracts](./error-contracts.md)) **unconditionally** — independent of request body or caller (I-022-15) — because the real handlers must reach daemon-local `participant_keys` + the `sodium_mlock`-held master key that a Cloudflare-Workers control plane cannot. The request/response interfaces below are the **reserved V1.1 surface** (the shapes real handlers will satisfy), retained so V1.1 can ship handlers without a breaking method addition. The HTTP verbs in the comments are the notional V1.1 REST equivalents, not V1 transport.

```ts
// gdpr.sessionPurge — reserved V1.1 (notional REST: POST /sessions/{id}/purge)
interface SessionPurgeRequest {
  sessionId: SessionId;
}
interface SessionPurgeResponse {
  sessionId: SessionId;
  state: "purge_requested";
  scheduledAt: string;
}

// gdpr.participantExport — reserved V1.1 (notional REST: GET /participants/{id}/export)
interface ParticipantDataExportRequest {
  participantId: ParticipantId;
}
interface ParticipantDataExportResponse {
  participantId: ParticipantId;
  exportData: Record<string, unknown>; // JSON export, decrypted
  generatedAt: string;
}

// gdpr.participantDelete — reserved V1.1 (notional REST: DELETE /participants/{id}/data)
interface ParticipantDataDeleteRequest {
  participantId: ParticipantId;
}
interface ParticipantDataDeleteResponse {
  participantId: ParticipantId;
  deletedAt: string;
  cryptoShredded: boolean;
}
```

### GDPR Method-Name Registry (Tier 5)

The three `gdpr.*` stub methods (Plan-022 D-022-3, registered on Plan-007's `MethodRegistry`; reciprocal `provides` recorded on [Plan-007](../../plans/007-local-ipc-and-daemon-control.md)). All three return the unconditional not-implemented stub in V1 (§above); the Request / Response schemas are the reserved V1.1 contract, not a V1 success surface.

| Method | Procedure type | Request schema | Response schema (reserved V1.1) |
| --- | --- | --- | --- |
| `gdpr.sessionPurge` | `mutation` | `SessionPurgeRequest` | `SessionPurgeResponse` |
| `gdpr.participantExport` | `query` | `ParticipantDataExportRequest` | `ParticipantDataExportResponse` |
| `gdpr.participantDelete` | `mutation` | `ParticipantDataDeleteRequest` | `ParticipantDataDeleteResponse` |

In V1 every call resolves to the unconditional `-32603` / `data.type = "gdpr.endpoint_not_v1"` stub (I-022-15) regardless of the procedure type **or request body** shown — the procedure types are the reserved-V1.1 semantics that the real handlers will honor. To keep that response unconditional, the three methods register against a **permissive params schema** (`z.unknown()`) in V1, **not** the strict Request schemas tabled above: Plan-007's `MethodRegistry.dispatch` Zod-parses the registered params schema before the handler body runs and maps a failure to `-32602 Invalid Params` ([Plan-007:103](../../plans/007-local-ipc-and-daemon-control.md), I-007-7), so binding a strict schema would pre-empt the unconditional `-32603` with a `-32602` on any malformed body — breaking I-022-15. The strict Request schemas become the registered params schemas only when the real V1.1 handlers ship (Plan-022 D-022-3 (c)). Canonical schemas live in `packages/contracts/` per the §Source-of-Truth Policy.
