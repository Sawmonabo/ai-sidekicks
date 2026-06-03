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
type WorktreeId = string & { readonly __brand: "WorktreeId" };
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
  | "workspace" // workspace/repo errors
  | "artifact" // artifact publication errors
  | "workflow" // workflow execution errors
  | "driver" // provider driver errors
  | "relay" // relay/transport errors
  | "system"; // internal system errors
// Illustrative V1 subset; `error-contracts.md` is the canonical namespace registry.

// Rate limiting response (Spec-021)
interface RateLimitResponse {
  code: "rate_limited";
  retryAfter: number; // seconds
  limit: number;
  remaining: number;
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
type WorktreeState = "creating" | "ready" | "dirty" | "merged" | "retired" | "failed";
type RepoMountState = "attached" | "detached" | "archived";

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

The regex requires a lowercase-starting first segment (the namespace root); subsequent dot-delimited segments may contain camelCase (`[a-z][a-zA-Z0-9]*`). This adopts the dotted-camelCase _segment_ style of the LSP precedent ([Language Server Protocol §General Messages](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/) — e.g. `workspace.executeCommand`) and the MCP precedent ([Model Context Protocol §Protocol Messages](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) — `tools.list`, `tools.call`), but deliberately **tightens the leading segment to lowercase-only**: LSP's own camelCase-rooted names such as `textDocument.didOpen` are _rejected_ by this regex, because every V1 namespace root (`session`, `driver`, `settings`, `daemon`, `event`, `run`, `repo`, `artifact`) is a lowercase identifier. The V1 Tier 1 surface (`session.create`, `session.read`, `session.join`, `session.subscribe`) uses all-lowercase segments; nested-namespace operations like `settings.effectiveRead` and `driver.listCapabilities` (lowercase root + camelCase tail) are permitted under this regex.

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

The runtime regex check is owed by the Plan-007 substrate at `packages/runtime-daemon/src/ipc/registry.ts:register()`; the `MethodRegistry` interface itself (F-007p-2-03) is canonical in code at `packages/contracts/src/jsonrpc-registry.ts` per the §Source-of-Truth Policy at the top of this file (closed via [BL-102](../../backlog.md) no-mirror disposition, 2026-04-30).

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
  healthChanges?: { state: NodeState; reason?: string };
}
interface RuntimeNodeCapabilityUpdateResponse {
  nodeId: NodeId;
  state: NodeState;
  updatedAt: string;
}

// RuntimeNodeDetach
interface RuntimeNodeDetachRequest {
  nodeId: NodeId;
  reason?: string;
}
// Response: null — over tRPC, HTTP 200 with { result: { data: null } } (resolver returns null, not a 204); over JSON-RPC, result: null (RuntimeNodeDetachResponseSchema = z.null())
```

### Runtime-Node Method-Name Registry (Tier 3)

Plan-003's runtime-node operations are exposed as four methods. Method-name strings are `dotted-camelCase` per the canonical `METHOD_NAME_FORMAT` ratified in §Tier 1 (cont.): Plan-007 above (the `register(method, …)` guard at the regex constant) — the same convention shared across Plan-007's JSON-RPC daemon IPC (mechanically regex-enforced at register time) and Plan-008's tRPC control-plane procedures, so the SDK call-site shape (`client.runtimenode.attach({ … })`) is symmetric across transports. Plan-003 registers these handlers under the Plan-007-partial daemon IPC substrate, and the attach/heartbeat calls also cross the Plan-008 control-plane transport (per [Plan-003 §Dependencies](../../plans/003-runtime-node-attach.md)).

The `runtimenode` namespace token is the concatenated domain noun — distinct from the `runtime_node.*` **event** taxonomy (the 7 lifecycle events in [Spec-006 §Runtime Node Lifecycle](../../specs/006-session-event-taxonomy-and-audit-log.md)). The underscore `runtime_node.*` form is a valid _event_ name but is **rejected** as a _method_ name by `METHOD_NAME_FORMAT` (no underscores). `runtimenode.capabilityupdate` is the system's first multi-word procedure: it uses an all-lowercase run-on form within the `dotted-camelCase` regex (the regex permits camelCase in segments — `runtimeNode.capabilityUpdate` would also be legal — but Plan-003 chose the run-on style to match the uniform single-verb arity of the `session.*` surface; the regex also permits a 3-segment `noun.sub.verb` form, reserved for a future nested-router need).

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `runtimenode.attach` | `mutation` | `RuntimeNodeAttachRequest` | `RuntimeNodeAttachResponse` |
| `runtimenode.heartbeat` | `mutation` | `RuntimeNodeHeartbeatRequest` | `null` — HTTP 200 `{ result: { data: null } }` (tRPC) / `result: null` (JSON-RPC); `RuntimeNodeHeartbeatResponseSchema` (`z.null()`) |
| `runtimenode.capabilityupdate` | `mutation` | `RuntimeNodeCapabilityUpdateRequest` | `RuntimeNodeCapabilityUpdateResponse` |
| `runtimenode.detach` | `mutation` | `RuntimeNodeDetachRequest` | `null` — HTTP 200 `{ result: { data: null } }` (tRPC) / `result: null` (JSON-RPC); `RuntimeNodeDetachResponseSchema` (`z.null()`) |

All four are `mutation`s (state-changing, non-idempotent) per the tRPC procedure-type convention in §Tier 1 (cont.): Plan-008 above. The request/response shapes are the interfaces defined directly above; the canonical Zod schemas live in `packages/contracts/` per the §Source-of-Truth Policy. `heartbeat` and `detach` carry a `null` response payload, not an empty `204` body: their resolvers return `null`, which tRPC serializes as an ordinary HTTP 200 success envelope `{ result: { data: null } }` (the control-plane router uses the default transformer, so there is no `data.json` wrapper). This matters because the SDK's `parseTrpcResult` calls `response.json()` on every 2xx response — a `204` with an empty body would throw `SyntaxError`, whereas `{ result: { data: null } }` parses cleanly and `z.null()` validates the extracted `null`. Over the JSON-RPC daemon transport — where JSON-RPC 2.0 requires a `result` member on success — they return `result: null`. Both transports are validated by the canonical `RuntimeNodeHeartbeatResponseSchema` / `RuntimeNodeDetachResponseSchema` (`z.null()`), so the SDK's `JsonRpcClient.call` (daemon) and the tRPC client both have a concrete result schema to pass (Plan-003 T1.3 / T4.1).

---

## Tier 4: Plans 005, 006, 007 (Task 4.5)

### Plan-005 — Provider Driver Contract (Internal Interface)

```ts
// Internal driver interface — TypeScript interfaces, not Zod (internal boundary).
// `resumeSession` returns the `DriverResumeResult` discriminated union (defined below)
// to make silent-replacement structurally inexpressible per Spec-005:60.
// `getCapabilities` returns the `GetCapabilitiesResult` wrapper (defined below) so the
// per-tool `ProviderToolMetadata[]` rides alongside the flag matrix in a single
// round-trip per Plan-005 Phase 4 ratified design.
interface ProviderDriver {
  createSession(params: CreateSessionParams): Promise<ProviderSessionHandle>;
  resumeSession(params: ResumeSessionParams): Promise<DriverResumeResult>;
  startRun(params: StartRunParams): Promise<void>;
  interruptRun(params: InterruptRunParams): Promise<void>;
  applyIntervention(params: ApplyInterventionParams): Promise<InterventionDriverResult>;
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

interface ApplyInterventionParams {
  type: InterventionType;
  targetRunId: RunId;
  expectedRunVersion: number; // MANDATORY fail-closed comparand (Plan-004 D-004-2) — absent value rejected, never applied; same field set as the InterventionRequestPayload union below
  payload: SteerPayload | InterruptPayload | CancelPayload;
}

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

interface InterventionDriverResult {
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
// `runtime_node.capability_updated` event payloads (Spec-006:379-380). Bound to the same
// three surfaces a driver advertises via `ProviderDriver.getCapabilities()` (GetCapabilitiesResult
// above): the seven-flag matrix, the negotiated contract version, and the per-tool metadata —
// here as `NormalizedProviderToolMetadata` (post-default), since these payloads cross the event
// boundary and must never carry an un-normalized `idempotency_class`.
// Why flattened (not nested under `capabilities`): in the event-payload context all three
// surfaces compose one capability snapshot; readers (Plan-013 timeline, Plan-020 dashboards,
// Plan-015 replay) discriminate `runtime_node.capability_*` events from the discriminated
// union and consume the snapshot as a single object — there is no driver-method context
// that requires DriverCapabilities to remain pure. Sources: Spec-006:379-380; Plan-005
// CP-005-5; Plan-006 Phase 1 T1.4 + Phase 3 doc-mirror audit.
interface CapabilityDetails {
  flags: Record<DriverCapabilityFlag, boolean>;
  contractVersion: string;
  tools: NormalizedProviderToolMetadata[];
}

// runtime_node.capability_declared payload (Spec-006:379). Emitted once per driver
// registration with the daemon's runtime-node bootstrap (Plan-003 territory).
interface RuntimeNodeCapabilityDeclaredPayload {
  capability: string; // canonical capability identifier (e.g., "provider-driver")
  capabilityDetails: CapabilityDetails;
}

// runtime_node.capability_updated payload (Spec-006:380). Emitted on driver-version
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
  // per Spec-006 §Event Type Summary line 510; 125 event types per line 537 — the Tier-5
  // readiness-audit swap registered daemon.master_key_source + daemon.pii_split_ambiguous
  // under the existing security_events category, Plan-022 D-022-5, so no category was added).
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
  priority?: number; // default 0
  payload: Record<string, unknown>;
}
interface QueueItemCreateResponse {
  queueItemId: QueueItemId;
  state: QueueItemState;
  createdAt: string;
}

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
// `providerFailureDetail` surface that mirrors `DriverResumeResult.failure.providerFailureDetail`
// (line 620 above) — Spec-005:60 requires resume-failure detail to reach the canonical audit
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
  relayEndpoint: string;
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
// RepoAttach
interface RepoAttachRequest {
  sessionId: SessionId;
  localPath: string;
  nodeId: NodeId;
}
interface RepoAttachResponse {
  repoMountId: RepoMountId;
  state: RepoMountState;
  vcsType: string;
  canonicalRoot: string;
}

// RepoMountRead
interface RepoMountReadRequest {
  repoMountId: RepoMountId;
}
interface RepoMountReadResponse {
  id: RepoMountId;
  sessionId: SessionId;
  localPath: string;
  vcsType: string;
  state: RepoMountState;
  attachedAt: string;
}

// WorkspaceBind
interface WorkspaceBindRequest {
  repoMountId: RepoMountId;
  executionMode: ExecutionMode;
  directory?: string; // subdirectory within repo, optional
}
interface WorkspaceBindResponse {
  workspaceId: WorkspaceId;
  fsRoot: string;
  executionMode: ExecutionMode;
  state: WorkspaceState;
}

// WorkspaceExecutionModeCapabilitiesRead
interface WorkspaceExecutionModeCapabilitiesReadRequest {
  repoMountId: RepoMountId;
}
interface WorkspaceExecutionModeCapabilitiesReadResponse {
  availableModes: ExecutionMode[];
  defaultMode: ExecutionMode;
  restrictions?: Record<ExecutionMode, string>; // reason if mode is restricted
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
  }>;
}
```

### Plan-010 — Worktree Lifecycle And Execution Modes

```ts
// ExecutionModeSelect
interface ExecutionModeSelectRequest {
  workspaceId: WorkspaceId;
  mode: ExecutionMode;
}
interface ExecutionModeSelectResponse {
  workspaceId: WorkspaceId;
  executionMode: ExecutionMode;
  executionRoot?: string;
}

// ExecutionRootPrepare
interface ExecutionRootPrepareRequest {
  workspaceId: WorkspaceId;
  branchName?: string; // for worktree/branch mode
}
interface ExecutionRootPrepareResponse {
  executionRoot: string;
  worktreeId?: WorktreeId; // set for worktree mode
  state: WorkspaceState;
}

// WorktreeReuseCheck
interface WorktreeReuseCheckRequest {
  repoMountId: RepoMountId;
  branchName: string;
}
interface WorktreeReuseCheckResponse {
  available: boolean;
  worktreeId?: WorktreeId;
  state?: WorktreeState;
  isClean?: boolean;
}

// EphemeralClonePrepare
interface EphemeralClonePrepareRequest {
  workspaceId: WorkspaceId;
  cleanupPolicy?: "on_run_complete" | "manual";
}
interface EphemeralClonePrepareResponse {
  cloneId: string;
  cloneRoot: string;
  state: "creating" | "ready";
}

// WorktreeRetire
interface WorktreeRetireRequest {
  worktreeId: WorktreeId;
}
interface WorktreeRetireResponse {
  worktreeId: WorktreeId;
  state: "retired";
}
```

### Plan-012 — Approvals Permissions And Trust Boundaries

```ts
// ApprovalRequestCreate
interface ApprovalRequestCreateRequest {
  runId: RunId;
  category: ApprovalCategory;
  scope: string;
  resourceDescriptor?: Record<string, unknown>;
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
  decision: ApprovalDecision;
  rememberedScope?: string; // scope pattern for remembered rules
  auditMetadata?: Record<string, unknown>;
}
interface ApprovalResolveResponse {
  approvalRequestId: ApprovalRequestId;
  state: ApprovalState;
  resolvedAt: string;
}

// PermissionCheck (local daemon operation)
interface PermissionCheckRequest {
  runId: RunId;
  category: ApprovalCategory;
  scope: string;
  resourceDescriptor?: Record<string, unknown>;
}
interface PermissionCheckResponse {
  allowed: boolean;
  reason: "remembered_rule" | "pending_approval" | "denied" | "approved";
  approvalRequestId?: ApprovalRequestId; // if pending
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
    category: ApprovalCategory;
    scope: string;
    state: ApprovalState;
    createdAt: string;
    resolvedAt?: string;
  }>;
}
```

---

## Tier 7: Plans 011, 014, 015 (Task 4.8)

### Plan-011 — Gitflow PR And Diff Attribution

```ts
// BranchContextRead
interface BranchContextReadRequest {
  worktreeId: WorktreeId;
}
interface BranchContextReadResponse {
  branchContextId: string;
  baseBranch: string;
  headBranch: string;
  upstreamRef?: string;
  worktreeId: WorktreeId;
}

// DiffArtifactCreate
interface DiffArtifactCreateRequest {
  runId: RunId;
  attributionMode: "agent_trace" | "git_diff";
  baseRef: string;
  headRef: string;
}
interface DiffArtifactCreateResponse {
  diffArtifactId: string;
  artifactManifestId: ArtifactId;
  createdAt: string;
}

// PRPrepare
interface PRPrepareRequest {
  branchContextId: string;
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
```

### Plan-014 — Artifacts Files And Attachments

```ts
// ArtifactPublish
interface ArtifactPublishRequest {
  sessionId: SessionId;
  runId?: RunId;
  artifactType: string; // 'code', 'document', 'image', 'diff', etc.
  visibility: ArtifactVisibility;
  payload: Uint8Array | string;
  mediaType: string; // MIME type
  metadata?: Record<string, unknown>;
}
interface ArtifactPublishResponse {
  artifactId: ArtifactId;
  contentHash: string; // SHA-256
  state: ArtifactState;
  manifestUrl: string;
}

// ArtifactRead
interface ArtifactReadRequest {
  artifactId: ArtifactId;
  includePayload?: boolean; // default false, returns handle only
}
interface ArtifactReadResponse {
  id: ArtifactId;
  sessionId: SessionId;
  runId?: RunId;
  artifactType: string;
  visibility: ArtifactVisibility;
  state: ArtifactState;
  contentHash?: string;
  metadata: Record<string, unknown>;
  payloadHandle?: string; // CAS key or URL for deferred retrieval
  payload?: Uint8Array; // only if includePayload=true and size permits
  createdAt: string;
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

## Tier 9: Plans 016, 017 (Task 4.10)

### Plan-016 — Multi-Agent Channels And Orchestration

```ts
// ChannelCreate
interface ChannelCreateRequest {
  sessionId: SessionId;
  name?: string;
  config?: Record<string, unknown>; // turn budget, stop policy, etc.
}
interface ChannelCreateResponse {
  channelId: ChannelId;
  state: ChannelState;
  createdAt: string;
}

// OrchestrationRunCreate
interface OrchestrationRunCreateRequest {
  sessionId: SessionId;
  parentRunId?: RunId; // for child runs
  targetAgentId: string;
  targetNodeId?: NodeId;
  targetChannelId: ChannelId;
  internalHelper?: boolean; // marks as non-user-facing
  config?: Record<string, unknown>;
}
interface OrchestrationRunCreateResponse {
  runId: RunId;
  state: RunState;
  parentRunId?: RunId;
  channelId: ChannelId;
}

// ChildRunLinkRead
interface ChildRunLinkReadRequest {
  parentRunId: RunId;
}
interface ChildRunLinkReadResponse {
  links: Array<{
    childRunId: RunId;
    linkType: "spawn" | "delegate" | "handoff";
    state: RunState;
    createdAt: string;
  }>;
}

// InternalRunFlag (enum/marker)
type InternalRunFlag = boolean; // true = internal helper, false = user-facing
```

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

```ts
// RateLimitCheck (internal operation)
interface RateLimitCheckRequest {
  identity: string; // participant_id or API key
  endpoint: string; // route pattern
  context?: Record<string, unknown>;
}
interface RateLimitCheckResponse {
  allowed: boolean;
  remaining: number;
  resetAt: string; // ISO 8601
}
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
