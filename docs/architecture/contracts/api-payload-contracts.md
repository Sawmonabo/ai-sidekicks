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
- **Local-daemon endpoints.** Endpoints reachable only over the daemon's local IPC socket (JSON-RPC 2.0 per [ADR-009 JSON-RPC IPC Wire Format](../../decisions/009-json-rpc-ipc-wire-format.md)) are authorized by socket reachability plus a required 256-bit session token presented by the Desktop Shell or CLI client (per BL-056 reconciliation on 2026-04-18; see [security-architecture.md §Local Daemon Authentication](../security-architecture.md#local-daemon-authentication-task-51)); they do not require a PASETO access token. The renderer is not a direct daemon client — renderer-originated requests are brokered by the shell via the preload bridge. When a local-daemon request is later forwarded cross-node via dispatch, the target daemon applies the full PASETO + DPoP verification defined above before Cedar runs.
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
type InterventionType = "steer" | "interrupt" | "cancel" | "rollback"; // rollback: campaign B2 (Spec-004 §Required Behavior). Code-mirror gate: the shipped provider-driver.ts union stays three-membered until the campaign's Plan-005 bundle widens union + consumers together (same gate pattern as DriverCapabilityFlag below)
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
  | "model_mutation"
  | "structured_output" // schema-constrained final output (Spec-005 §Per-Driver Capability Matrix, campaign B3)
  | "rollback" // conversation rollback via rollbackTo (campaign B3; the rollback InterventionType member landed via campaign B2)
  | "session_goals" // setSessionGoal / clearSessionGoal (campaign B3)
  | "callback_tools" // daemon-curated callback-tool registry (campaign B3)
  | "subagents" // provider-native in-session subagents under subagentPolicy (campaign B3)
  | "cost_cap"; // realizes a daemon-supplied hard cost cap natively at spawn — Claude --max-budget-usd; gates the Spec-016 native-cap unpriced admission (campaign B6)
// Code-mirror gate (campaign B3/B6): the shipped executable union
// (packages/contracts/src/provider-driver.ts) still exports the seven pre-B3 flags, and the
// shipped assertValidCapabilityFlags rejects any snapshot whose key count differs — so a driver
// MUST NOT declare the six campaign flags against the shipped validator. Union + validator +
// driver_capabilities migration backfill + conformance tests widen together as ONE change via
// the campaign's Plan-005 bundle; cost_cap-gated admission code (Plan-016 T2.3) dispatch-gates
// on that bundle (same named-bundle gate as the goal driver mirror).
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
  timelineCursors: { earliest?: EventCursor; latest: EventCursor; acknowledged?: EventCursor }; // earliest?: the position immediately BEFORE the oldest surviving row (Plan-006 T4.3), a directly resumable cursor — V1-constant encode(-1) (compaction stubs rows in place, never deletes; a future retention pass deleting through N-1 moves it to encode(N-1)). Consumer: resume from acknowledged ?? earliest; gap detection decode(acknowledged) < decode(earliest) ⇒ events lost ⇒ reset projection + resume from earliest. Optional for version skew: new daemons always set it; absent ⇒ responder predates the whole Plan-006 Phase-4 read surface; the consumer discovers the absence from this very session.read response and refuses the resume cycle SDK-locally before any projection reset or subsequent replay/subscribe wire call (`Plan-008 §I-008-12 — Client event-stream resume is floor-checked, gap-safe, and at-most-once-applied` clause (d), campaign B12 — the earlier resume-from-start sketch is unreachable through the surface it names); required at next MAJOR per ADR-018.
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

The `EventEnvelopeVersion` brand carried on every emitted envelope is canonical at the Plan-006 definition below — `string & { readonly __brand: "EventEnvelopeVersion" }` per [ADR-018 §Decision #1](../../decisions/018-cross-version-compatibility.md#decision): on the wire it is the semver `"MAJOR.MINOR"` string. This is the **event envelope** version field, distinct from the JSON-RPC handshake `protocolVersion` field discussed in §Tier 1 (cont.): Plan-007 below.

The cross-tier `SessionEvent` discriminated-union surface is closed via [BL-102](../../backlog.md) no-mirror disposition (2026-04-30): the canonical type lives in `packages/contracts/src/event.ts` as a Zod-validated `z.discriminatedUnion("type", [...])`, this file does not maintain a wire-form mirror, and the §Source-of-Truth Policy above governs the relationship.

The Plan-007 JSON-RPC method-name registry sub-item and the `protocolVersion` field-type sub-item are both closed in §Tier 1 (cont.): Plan-007 below — the latter via 2026-05-01 ratification of ISO 8601 `YYYY-MM-DD` date-string form, per [MCP §Architecture overview](https://modelcontextprotocol.io/docs/learn/architecture) precedent. (The prior closure-by-conflation between handshake-`protocolVersion` and the `EventEnvelopeVersion` brand above was rolled back in commit `735b069` (2026-04-30); the two surfaces remain distinct — `EventEnvelopeVersion` is a semver `MAJOR.MINOR` brand on event-envelopes, `protocolVersion` is a date-string on every JSON-RPC request after handshake.)

---

## Tier 1 (cont.): Plan-007 — Plan-007-Partial (local IPC daemon-control)

[Plan-007 Phase 3](../../plans/007-local-ipc-and-daemon-control.md) defines the JSON-RPC IPC surface served by the local runtime daemon to in-tree clients (CLI, desktop renderer). The Plan-007-partial Tier 1 carve-out per [`docs/plans/007-local-ipc-and-daemon-control.md`](../../plans/007-local-ipc-and-daemon-control.md) §Execution Windows ratifies a subset of that surface inline with Plan-001's session-core types. This subsection ratifies (1) the canonical method-name format that [Plan-007 §I-007-9](../../plans/007-local-ipc-and-daemon-control.md#i-007-9--method-names-conform-to-the-canonical-format-declared-in-api-payload-contractsmd) requires the registry to enforce mechanically at `register(method, ...)` call time and (2) the JSON-RPC handshake `protocolVersion` field type. The remaining Plan-007 sub-items are: (a) `MethodRegistry` runtime shape per F-007p-2-03 — closed via [BL-102](../../backlog.md) no-mirror disposition (2026-04-30); canonical source: `packages/contracts/src/jsonrpc-registry.ts`. (b) `LocalSubscriptionProducer<T>` shape per F-007p-3-02 — closed via [BL-102](../../backlog.md) no-mirror disposition (2026-04-30); canonical source: `packages/contracts/src/jsonrpc-streaming.ts` (the paired client-side consumer shape `LocalSubscriptionConsumer<T>` lives at `packages/client-sdk/src/transport/types.ts`; rename landed 2026-05-19 via BL-115). (c) `protocolVersion` field type per F-007p-2-01 — **closed via §JSON-RPC Handshake `protocolVersion` Field (Tier 1 Ratified) below (2026-05-01)**: ISO 8601 `YYYY-MM-DD` date-string form, current value `"2026-05-01"`. (d) JSON-RPC error envelope shape per F-007p-2-02 — closed via [BL-103](../../backlog.md) §JSON-RPC Wire Mapping ratification in [error-contracts.md](./error-contracts.md), separate from BL-102.

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

**Register-time enforcement** (closes [Plan-007 §I-007-9](../../plans/007-local-ipc-and-daemon-control.md#i-007-9--method-names-conform-to-the-canonical-format-declared-in-api-payload-contractsmd) `BLOCKED-ON-C6`): the method registry's `register(method, handler)` call MUST evaluate `method` against this regex and throw on mismatch. This is mechanical validation, not human review — out-of-format names cannot reach the dispatcher.

```ts
const METHOD_NAME_FORMAT = /^[a-z][a-z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;

function register(method: string, handler: Handler): void {
  if (!METHOD_NAME_FORMAT.test(method)) {
    throw new Error(`method name "${method}" violates dotted-camelCase canonical format`);
  }
  // ... registry insertion
}
```

The runtime regex check is owed by the Plan-007 substrate at `packages/runtime-daemon/src/ipc/registry.ts#isCanonicalMethodName` (the `register()`-time guard), which imports the canonical regex as the `METHOD_NAME_FORMAT` constant exported from `packages/contracts/src/jsonrpc-registry.ts` (the single source — no per-package re-declaration — per BL-142, 2026-06-21); the `MethodRegistry` interface itself (F-007p-2-03) is likewise canonical in code there per the §Source-of-Truth Policy at the top of this file (closed via [BL-102](../../backlog.md) no-mirror disposition, 2026-04-30).

### JSON-RPC Handshake `protocolVersion` Field (Tier 1 Ratified)

Closes the BL-102 sub-item for the `protocolVersion` field type and feature ID F-007p-2-01. Closes [Plan-007](../../plans/007-local-ipc-and-daemon-control.md) `BLOCKED-ON-C6` markers across the JSON-RPC handshake substrate (`packages/contracts/src/jsonrpc.ts`, `packages/contracts/src/jsonrpc-negotiation.ts`, `packages/runtime-daemon/src/ipc/protocol-negotiation.ts`, and the client-SDK transport surface).

**Canonical format**: ISO 8601 date-string in `YYYY-MM-DD` form. The substrate Zod schema at `packages/contracts/src/jsonrpc-negotiation.ts#ProtocolVersionSchema` MUST be:

```ts
const ProtocolVersionSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
```

**Current value**: `"2026-05-01"` — the ratification date is the V1 protocol version. The daemon's supported set at `packages/runtime-daemon/src/ipc/protocol-negotiation.ts#DAEMON_SUPPORTED_PROTOCOL_VERSIONS` is `["2026-05-01"]` for V1; future revisions advance the date and append to the array.

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
  nodes: RuntimeNodeRosterEntry[]; // one entry per runtime_node_attachments row for the session — bounded by distinct nodes ever attached (UNIQUE(node_id, session_id)); both health axes carried verbatim, never collapsed into one scalar (reconciliation is the CLIENT's render-time concern — the Spec-003 line-73 never-mask stance)
  // Shared-terminal write-lease holder (Spec-003 §Required Behavior, campaign B4): null = lease free (writes refused — null-holder-refuses-writes).
  // Source: the terminal-owning daemon is the lease authority and sole producer — it publishes every transition to the control plane via `runtimenode.leaseupdate` (the Terminal-Control registry's projection-sync mutation below), which persists the current holder in `session_terminal_leases` (shared Postgres; durable coordination record, same tier as `runtime_node_presence`, holder cleared on the auto-release presence/attachment drop, on holder authorization loss — role change out of the authorized set, suspension, or revocation — and on the agent-run write-burst release (`auto_released_run_idle`: the acquiring run's first lifecycle transition out of `running`) — per Spec-003; DDL forward-declared in [shared-postgres-schema.md §Session Terminal Lease](../schemas/shared-postgres-schema.md#session-terminal-lease-plan-024); table forward-assigned in cross-plan-dependencies §3 to the Plan-024 Phase 3B lease leg — campaign B16 — whose additive migration ships it and extends this roster read's projection beyond today's attachments × presence join).
  // Session coordination state projected faithfully, same never-mask stance as the node rows above.
  controlHolder: ParticipantId | null;
}
```

### Runtime-Node Method-Name Registry (Tier 3)

Plan-003's runtime-node operations are exposed as five methods — four state-changing operations plus one roster read (`runtimenode.roster`, added 2026-06-09 by the user-directed Plan-003 Phase 5 scope expansion, PR #150). A sixth `runtimenode.*` method — the Plan-024 lease projection-sync mutation `runtimenode.leaseupdate` (campaign B4, 2026-07-13) — registers in the §Session Terminal-Control Method Registry below, where its lease context lives; the seventh and eighth — the Plan-006 signing-key registration/resolution pair `runtimenode.signingkeyregister` / `runtimenode.signingkeyroster` (T4.10 per CP-006-7 leg B / CP-003-5, 2026-07-29) — register in the §Signing-Key Registration Method Registry below, where their verification-key context lives. Method-name strings are `dotted-camelCase` per the canonical `METHOD_NAME_FORMAT` ratified in §Tier 1 (cont.): Plan-007 above (the `register(method, …)` guard at the regex constant) — the same convention shared across Plan-007's JSON-RPC daemon IPC (mechanically regex-enforced at register time) and Plan-008's tRPC control-plane procedures, so the SDK call-site shape (`client.runtimenode.attach({ … })`) is symmetric across transports. Plan-003 registers the four mutation handlers under the Plan-007-partial daemon IPC substrate, and the same four also cross the Plan-008 control-plane transport as `runtimenode.*` tRPC procedures the sibling `runtimeNodeRouter` mounts (Plan-003 T3.8); `runtimenode.roster` is **control-plane tRPC ONLY** (Plan-003 T5.0c) — the roster is control-plane-owned cross-node state (a daemon knows only itself), so the read deliberately does not ride the daemon JSON-RPC transport the four mutations share. The registry table below is the canonical source for both transports (per [Plan-003 §Dependencies](../../plans/003-runtime-node-attach.md)).

The `runtimenode` namespace token is the concatenated domain noun — distinct from the `runtime_node.*` **event** taxonomy (the 7 lifecycle events in [Spec-006 §Runtime Node Lifecycle](../../specs/006-session-event-taxonomy-and-audit-log.md#runtime-node-lifecycle-runtime_node_lifecycle)). The underscore `runtime_node.*` form is a valid _event_ name but is **rejected** as a _method_ name by `METHOD_NAME_FORMAT` (no underscores). `runtimenode.capabilityupdate` is the system's first multi-word procedure: it uses an all-lowercase run-on form within the `dotted-camelCase` regex (the regex permits camelCase in tail segments — `runtimenode.capabilityUpdate` would also be legal — but Plan-003 chose the run-on style to match the then-uniform single-verb arity of the `session.*` surface (since extended: the campaign's `session.goalUpdate`/`session.goalClear` (B6) and `session.takeControl`/`session.releaseControl` (B4) carry the camelCase-tail form the method-name grammar equally permits); the regex also permits a 3-segment `noun.sub.verb` form, reserved for a future nested-router need).

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `runtimenode.attach` | `mutation` | `RuntimeNodeAttachRequest` | `RuntimeNodeAttachResponse` |
| `runtimenode.heartbeat` | `mutation` | `RuntimeNodeHeartbeatRequest` | `null` — HTTP 200 `{ result: { data: null } }` (tRPC) / `result: null` (JSON-RPC); `RuntimeNodeHeartbeatResponseSchema` (`z.null()`) |
| `runtimenode.capabilityupdate` | `mutation` | `RuntimeNodeCapabilityUpdateRequest` | `RuntimeNodeCapabilityUpdateResponse` |
| `runtimenode.detach` | `mutation` | `RuntimeNodeDetachRequest` | `null` — HTTP 200 `{ result: { data: null } }` (tRPC) / `result: null` (JSON-RPC); `RuntimeNodeDetachResponseSchema` (`z.null()`) |
| `runtimenode.roster` | `query` | `RuntimeNodeRosterRequest` | `RuntimeNodeRosterResponse` — control-plane tRPC ONLY (no daemon JSON-RPC registration; added 2026-06-09, PR #150) |

The four dual-transport methods (`attach`/`heartbeat`/`capabilityupdate`/`detach`) are `mutation`s (state-changing, non-idempotent) per the tRPC procedure-type convention in §Tier 1 (cont.): Plan-008 above; `runtimenode.roster` is the namespace's first `query` — joined 2026-07-29 by Plan-006 T4.10's `runtimenode.signingkeyroster` per the §Signing-Key Registration Method Registry below — (an idempotent read: it projects the `runtime_node_attachments` × `runtime_node_presence` coordination records — plus, per campaign B4, the session's shared-terminal `controlHolder` lease state (daemon-enforced; its control-plane coordination record is pinned by the Plan-024 Phase 3B leg) — and writes nothing, so it authors no durable `runtime_node.*` event and does not collide with the [ADR-017 §Server-Derived Runtime-Node Lifecycle Events](../../decisions/017-shared-event-sourcing-scope.md#server-derived-runtime-node-lifecycle-events) V1.1 gate, which governs durable event authorship, not coordination-record reads), and it is mounted on the control-plane transport only (Plan-003 T5.0c). The request/response shapes are the interfaces defined directly above; the canonical Zod schemas live in `packages/contracts/` per the §Source-of-Truth Policy. `heartbeat` and `detach` carry a `null` response payload, not an empty `204` body: their resolvers return `null`, which tRPC serializes as an ordinary HTTP 200 success envelope `{ result: { data: null } }` (the control-plane router uses the default transformer, so there is no `data.json` wrapper). This matters because the SDK's `parseTrpcResult` calls `response.json()` on every 2xx response — a `204` with an empty body would throw `SyntaxError`, whereas `{ result: { data: null } }` parses cleanly and `z.null()` validates the extracted `null`. Over the JSON-RPC daemon transport — where JSON-RPC 2.0 requires a `result` member on success — they return `result: null`. Both transports are validated by the canonical `RuntimeNodeHeartbeatResponseSchema` / `RuntimeNodeDetachResponseSchema` (`z.null()`), so the SDK's `JsonRpcClient.call` (daemon) and the tRPC client both have a concrete result schema to pass (Plan-003 T1.3 / T4.1).

### Session Terminal-Control Method Registry (Tier 3, campaign B4)

The shared-terminal write lease ([Spec-003 §Required Behavior](../../specs/003-runtime-node-attach.md#required-behavior), campaign B4 2026-07-06) exposes two `session.*` methods and one control-plane projection-sync mutation (`runtimenode.leaseupdate`, the third table row). The two `session.*` methods are **daemon JSON-RPC ONLY in V1** — deliberately NOT the dual-transport shape of the four `runtimenode.*` mutations above: for those, the tRPC callee (the control plane) is itself the record authority, whereas the lease authority is the terminal-owning daemon and no documented control-plane→daemon command path exists to forward a remote mutation to it ([ADR-008](../../decisions/008-default-transports-and-relay-boundaries.md)'s relay is E2E peer connectivity, not a control-plane command channel), so a tRPC registration would place the mutation on a party that can neither adjudicate nor enforce it. `Spec-003 §Required Behavior` pins this V1 posture and the forward constraint (a future remote take rides the same relay leg as the terminal bytes it gates). The lease's client-facing control-plane surface is read-only projection, and its write path belongs to the single producer: the terminal-owning daemon publishes every transition — the two mutations' successes and the three auto-release classes (disconnect, authorization loss, agent-run write-burst end — `Spec-003 §Required Behavior`) — by calling `runtimenode.leaseupdate` (`RuntimeNodeLeaseUpdateRequest { sessionId, nodeId, controlHolder: ParticipantId | null, reason, transitionSeq, transitionedAt }`, `reason` mirroring the `pty.control_changed` enum, `transitionSeq` a per-session strictly-increasing counter the daemon owns and persists in its local lease record — a daemon restart continues the sequence, never resets it; response `null`, `RuntimeNodeLeaseUpdateResponseSchema` = `z.null()`, the heartbeat/detach pattern; implemented by Plan-024 Phase 3B / campaign B16), and control-plane-connected clients render `controlHolder` from the `runtimenode.roster` projection (`RuntimeNodeRosterResponse.controlHolder`; daemon-transport clients fold `pty.control_changed` and the mutation responses). The upsert into `session_terminal_leases` is **producer-bound and monotonic**, not bare last-write-wins: the control plane applies a write only when (1) the `(nodeId, sessionId)` pair has a live `runtime_node_attachments` row in an active state whose `participant_id` equals the verified PASETO `sub` — the [§Authenticated Principal](#authenticated-principal-and-authorization-model) body-vs-`sub` rejection rule applied to the node binding, so a daemon can publish only for a node its own participant owns and has attached to that session; (2) the lease row's recorded `node_id` matches `nodeId` — the row binds to its producing terminal-owning node at first write, and a leaseupdate from a _different_ attached node is refused unless the recorded node's attachment has left the active set, in which case the write re-binds the row and re-baselines the sequence (terminal-host migration; monotonicity is per-producer); and (3) `transitionSeq` exceeds the stored value — an equal-or-lower sequence is acknowledged (`null`) and discarded, never applied, so a delayed transport retry of an older transition (a take retried after its release, an auto-clear racing a re-take) cannot resurrect a stale `controlHolder` over newer state. Violations of (1) or (2) are refused as unauthorized with no lease-row write; the roster projection therefore cannot diverge from the daemon-enforced lease through a stale or non-owning caller.

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `session.takeControl` | `mutation` | `SessionTakeControlRequest` | `SessionTakeControlResponse` — daemon JSON-RPC ONLY in V1 (no control-plane tRPC registration; `Spec-003 §Required Behavior` transport posture) |
| `session.releaseControl` | `mutation` | `SessionReleaseControlRequest` | `SessionReleaseControlResponse` — daemon JSON-RPC ONLY in V1 (no control-plane tRPC registration; `Spec-003 §Required Behavior` transport posture) |
| `runtimenode.leaseupdate` | `mutation` | `RuntimeNodeLeaseUpdateRequest` | `null` — HTTP 200 `{ result: { data: null } }`; `RuntimeNodeLeaseUpdateResponseSchema` (`z.null()`) — control-plane tRPC ONLY, **daemon-called** (single producer: the terminal-owning daemon, producer-bound + monotonic per the contract paragraph above; no daemon JSON-RPC registration — clients never invoke the projection sync; Plan-024 Phase 3B / campaign B16) |

```ts
interface SessionTakeControlRequest {
  sessionId: SessionId; // no caller-participant field on the wire — the principal binds per the transport rule below
}

interface SessionTakeControlResponse {
  controlHolder: ParticipantId; // the caller — first-acquire-holds succeeded
}

interface SessionReleaseControlRequest {
  sessionId: SessionId; // no caller-participant field on the wire — the principal binds per the transport rule below
}

interface SessionReleaseControlResponse {
  controlHolder: null; // lease freed; next writer must take explicitly
}
```

Refusals are typed in [Error Contracts §PTY](./error-contracts.md#pty): role authorization precedes lease state — `session.takeControl` is owner/collaborator-only per the [Security Architecture permission matrix](../security-architecture.md#permission-matrix-task-54) row 'Take terminal control', refused `pty.permission_denied` (403) for viewers and runtime contributors before any lease-state comparison — the refusal is role-determined and stable rather than varying with mutable lease state; holder identity itself is deliberately session-visible presence metadata (the `pty.control_changed` broadcast and the roster's `controlHolder` expose it to every participant, viewers included), so the ordering guards the authorization boundary, not a secret (release is holder-gated, not role-gated — a holder stripped of authorization mid-hold can still relinquish during the signal-propagation window, and the membership transition itself force-clears the lease on arrival at the lease authority per Spec-003); a take while another participant holds the lease returns `pty.control_held_by_other` with `data.fields.holderParticipantId`; a terminal write with no lease held returns `pty.control_not_held`. A release by a non-holder is likewise `pty.control_not_held` (releasing nothing is not idempotent-success — it signals a caller-state bug); a take by the current holder is idempotent success — no transition occurs and nothing broadcasts. Every successful transition broadcasts `pty.control_changed` ([Spec-006 census](../../specs/006-session-event-taxonomy-and-audit-log.md#pty-control-session_lifecycle)), authored by the terminal-owning daemon; transitions include the three auto-release classes — holder disconnect, holder authorization loss (role change out of the authorized set, suspension, or revocation), and the agent-run write-burst release (the acquiring run's first lifecycle transition out of `running` after an agent-path take; the acquiring surface and run id are daemon-local lease-record bookkeeping, never a request field, re-bound to the new run on an agent-path take from a different run of the same participant (no broadcast — holder unchanged); `reason: 'auto_released_disconnect' | 'auto_released_authorization_lost' | 'auto_released_run_idle'`, `Spec-003 §Required Behavior`). Neither request carries a caller-participant field — the principal binds per the V1 transport rule: local daemon JSON-RPC callers bind to the daemon's recorded **node-owner participant** — the same absent-actor rule `ApprovalResolveRequest.approver` documents (absent on the local socket → the daemon's owner binding; every runtime node has exactly one owning participant per [runtime-node-model](../../domain/runtime-node-model.md)) — and the node's own agent runs take and release through the daemon's in-process lease authority under the **same node-owner participant identity** (no wire hop; agents are `AgentId`-keyed domain actors, not `participants` rows, so no distinct agent-participant exists to hold — the owner authorized those runs on their node, the holder surfaces stay `ParticipantId`, an owner-vs-own-agent take is the idempotent self-retake case, and per-surface attribution rides the adjacent run/agent events on the timeline, not the lease record). A future relay-borne remote leg binds the relay peer's PASETO-verified `sub` ([§Authenticated Principal And Authorization Model](#authenticated-principal-and-authorization-model)) and rides the terminal-byte channel per Spec-003's forward constraint — so `controlHolder`, the idempotent self-retake comparison, and the non-holder-release refusal are well-defined on every path that can reach the lease authority.

### Signing-Key Registration Method Registry (Tier 4, Plan-006 T4.10)

The per-event daemon-signature verification protocol ([Security Architecture §Per-Event Daemon Signature](../security-architecture.md#per-event-daemon-signature)) resolves the emitting daemon's Ed25519 PUBLIC key by `NodeId` from the session participant roster. This registry is that roster's signing-key surface: the daemon registers its session-scoped public key (the value `DaemonSigningKeyProvisioner.create(sessionId)` returned, or its row-verified `readPublicKey` re-read after a restart) — a registration that LANDS only once the daemon's attach has landed, the write being producer-bound to a live attachment row — via `runtimenode.signingkeyregister`, persisting register-once into the Plan-006-owned [`daemon_signing_public_keys` table](../schemas/shared-postgres-schema.md#daemon-signing-public-keys-plan-006--verification-key-roster); any verifier — peer daemon, forensic export, control-plane-connected client — resolves keys via `runtimenode.signingkeyroster`. Both methods are **control-plane tRPC ONLY** (the store is control-plane-owned cross-node state, the `runtimenode.roster` reasoning; the register mutation is **daemon-called**, the `runtimenode.leaseupdate` shape). Registered by Plan-006 T4.10 per CP-006-7 leg B / CP-003-5 (2026-07-29): the procedure-key registrations on the shared `runtime-node-router.factory.ts` builder, the two `runtimeNodeClient.ts` typed pass-throughs, and the four additive `runtime-node.ts` schema exports are CP-003-5's complete sanctioned Plan-003 seam-edit set (CP-003-6 registers a fourth crossing — the renderer `attachmentId` forward — under the same shape, 2026-08-01), and the register/resolve service is the Plan-006-owned sibling `signing-key-service.ts` — deliberately **new procedures rather than an attach-request field**, because every shipped `runtimenode.*` request/response schema is `.strict()`, so an added member would break the new-daemon→old-control-plane skew direction at parse ([ADR-018 §Decision](../../decisions/018-cross-version-compatibility.md#decision) #7 bidirectional-MINOR); a new daemon calling an old control plane instead receives tRPC `NOT_FOUND` and degrades honestly (its uploaded anchors stay emitter-only-verifiable until the control plane upgrades — the procedure's absence is the discovery signal — and the daemon-side registrar re-attempts on a bounded exponential backoff capped at [Spec-003 §Required Behavior](../../specs/003-runtime-node-attach.md#required-behavior)'s 15-second heartbeat-cadence constant for the locally-materialized session's lifetime, so a mid-session upgrade converges to registered without a daemon restart). The registrar starts at the daemon-local session-establishment moment — `runtimenode.attach` is client-driven and the daemon is never a party to it, so no post-attach hook exists in the registrar's process — and publishes through a thin PASETO-authenticated tRPC caller deliberately scoped to `runtimenode.signingkeyregister` (the Plan-024 T-024-3B-3 `leaseupdate` single-procedure-caller precedent; the daemon takes no `client-sdk` dependency), authenticating as the **node-owner participant** — the daemon's standing control-plane-authentication posture per [component-architecture-local-daemon.md §Responsibilities](../component-architecture-local-daemon.md#responsibilities) ("authenticate to the Collaboration Control Plane using PASETO v4 tokens per Spec-008") — with a PASETO v4.public access token whose per-request DPoP proof is signed by a daemon-held key the token's `cnf.jkt` binds ([§Authenticated Principal](#authenticated-principal-and-authorization-model)), obtained per attempt through the constructor-injected credential-provider interface CP-006-13 registers against Plan-018's Tier-5 PASETO wiring (Codex PR #274 round 4, 2026-07-31: the token's issuance-into-the-daemon path is specified by no V1 document today — the same Tier-5 gate the production `resolveCurrentParticipantId` stub already imposes on every shipped `runtimenode.*` procedure — so an auth failure is a retryable transport failure on the backoff and no Tier-4 code is blocked), retrying the collapsed `runtimenode.permission_denied` refusal on the same backoff — it covers both the attach race and an inactive membership, so the registrar converges once the client-driven attach lands the attachment row and the caller's membership is active (Codex PR #274 rounds 3–4, 2026-07-31). The attempt additionally presents the `attachmentId` the attach response returned (round 5, 2026-08-01; delivery mechanism corrected 2026-08-01 by the Plan-006 T4.10 targeted readiness-audit delta — the prior text here claimed the value rides a shell→daemon boundary "that already signals attach completion," a signal the round-3 record itself establishes does not exist: no daemon-side attach lifecycle and no such completion boundary ship in V1): attach is client-driven, so the value lands only in the attach response the renderer attach view receives, and the view forwards it on attach success to the Plan-006-owned `event.deliverAttachmentId` delivery method (the fourth CP-006-4 registration — pinned at Codex PR #278 round 1, request/response schemas `EventDeliverAttachmentIdRequestSchema` / `EventDeliverAttachmentIdResponseSchema` (`z.null()` response) on `packages/contracts/src/event.ts`, handler exported from the daemon registrar module) over the Plan-023 `window.sidekicks` bridge — the call-site edit riding T4.10 as a CP-003-6-sanctioned seam edit on the shipped Plan-003 attach view per CP-006-14 — feeding the registrar's constructor-injected attachment-id source; its delivery joins the credential as an attempt precondition, so the registrar's first attempt follows delivery rather than blind-racing the attach, and the 403 retry remains for the membership-convergence arm.

The register upsert is **producer-bound and register-once**, the `runtimenode.leaseupdate` authorization shape: the control plane applies a write only when (1) the caller's verified PASETO `sub` holds a `state = 'active'` `session_memberships` row for the session (any role; Codex PR #274 round 4, 2026-07-31 — suspension and revocation strip live capabilities per the Permission Matrix posture, and Plan-003 I-003-3 means no membership transition ever reaps an attachment, so without this predicate a revoked owner's still-live attachment could keep minting durable, erasure-durable roster rows) AND the `(nodeId, sessionId)` pair has a live `runtime_node_attachments` row in an active state whose `participant_id` equals that same `sub` AND whose server-minted `id` equals the request's `attachmentId` (the [§Authenticated Principal](#authenticated-principal-and-authorization-model) body-vs-`sub` rejection rule applied to the node binding — scoped honestly at round 5, 2026-08-01: `sub` and `participant_id` both name the OWNER, never the calling daemon, so the ownership halves close cross-participant planting only — with one participant owning two live attached nodes, either node's registrar satisfies them for the other's slot, and V1 defines no node-identity credential to check instead (`cnf.jkt` is replay-protection material, not a second principal; the non-forgeable node-identity key is the [cross-plan-dependencies.md §5](../cross-plan-dependencies.md#5-canonical-build-order) V1.1 Plan-018/Plan-003 leg, absorbed when it lands through CP-006-13's credential-class-agnostic seam). The `attachmentId` equality is the in-V1 narrowing: `runtime_node_attachments.id` is `gen_random_uuid()`, returned ONLY in the attach response and republished on no roster surface, so a sibling daemon cannot mint a registration from public identifiers alone — it must first usurp the victim's attach row via `runtimenode.attach` under the same participant, a call that rewrites the victim's roster-visible `capabilities`/`client_version`: a loud two-call footprint in place of a silent one-call plant, a mitigation rather than a closure); a caller failing any of these — inactive or absent membership, missing OR foreign attachment, a non-matching `attachmentId`, or a nonexistent session — is refused with the typed `runtimenode.permission_denied` error ([error-contracts.md §Runtime Node](./error-contracts.md#runtime-node) — HTTP 403 / tRPC `FORBIDDEN`, one collapsed refusal disclosing neither attachment existence nor session existence nor ownership, per that family's no-info-leak header, and deliberately never tRPC `NOT_FOUND`, which this namespace reserves as the old-control-plane procedure-absence discovery signal the registrar's retry contract discriminates on) before the floor or key comparison is reached — an unauthorized caller never reaches a key-existence oracle; (2) the attachment's stored `client_version` satisfies the session's current `min_client_version` floor — key registration is a version-sensitive domain write per [Spec-003 §Required Behavior](../../specs/003-runtime-node-attach.md#required-behavior), so a below-floor daemon (admitted read-only at attach) is refused `version.floor_exceeded` (the [error-contracts.md §Version](./error-contracts.md#version) surface-3 code+message form) before any row write, while `runtimenode.signingkeyroster` — a read — carries no floor check; and (3) the `(session_id, node_id)` pair is unregistered, OR the presented key byte-equals the stored one (an acknowledged idempotent no-op — the retry-safe re-attach path). A registration presenting a **different** key for a registered pair is refused with the typed `runtimenode.signingkeyregister_conflict` error ([error-contracts.md §Runtime Node](./error-contracts.md#runtime-node) — HTTP 409 / tRPC `CONFLICT`, registry-only code+message) and no row write — never a silent overwrite; V1 ships no daemon signing-key rotation ceremony, so refusal IS the rotation policy (the control-plane mirror of Plan-006 T4.2's `refuse_on_rotation`; [Security Architecture §Per-Event Daemon Signature](../security-architecture.md#per-event-daemon-signature)). Register-once cuts both ways (round 5, 2026-08-01): with no rotation ceremony, a wrong FIRST registration is permanent for the session's life, so the genuine daemon's 409 is an integrity alarm, not a caller bug — its slot holds a key it never minted (a same-participant sibling registered first, or its own key store was lost and re-minted). The refused daemon therefore appends the durable `audit_integrity_failed` event with the round-5 `failureMode: 'signing_key_slot_conflict'` ([Spec-006 §Audit Integrity](../../specs/006-session-event-taxonomy-and-audit-log.md#audit-integrity-audit_integrity)) to its session event log — session-visible and anchor-covered — rather than holding only a local log line; scoped at Codex PR #276 round 2 (2026-08-01, correcting this sentence's prior "so the parties whose verification the usurped slot breaks can detect it"): the alarm row is signed with the very key the roster refused, so roster-resolving external verifiers see it only as one more `signature_mismatch` among every row this daemon signs — the durable append serves local replay, the anchor-covered post-repair forensic record (authenticatable once the refused daemon's true key is established out-of-band), and operator surfacing, while the independently verifiable trust path for the conflict is the open design item recorded at [Spec-006 §Audit Integrity](../../specs/006-session-event-taxonomy-and-audit-log.md#audit-integrity-audit_integrity)'s sixteenth-mode prose. The four checks and the write are ATOMIC (Codex PR #274 rounds 3–4, 2026-07-31) — one transaction at READ COMMITTED closes all four TOCTOU windows: the session row is read `FOR SHARE` and held to commit, taken explicitly FIRST because the final INSERT's `session_id` FK acquires an implicit `FOR KEY SHARE` on `sessions` ([PostgreSQL 9.3 release notes §Locking](https://www.postgresql.org/docs/release/9.3.0/) — "foreign key checks use the new KEY SHARE lock mode"; the introducing release note is the direct primary statement, which the current-docs pages do not restate) and the canonical order forbids skipping a level a later statement acquires implicitly (`FOR SHARE`, not `FOR KEY SHARE`, because a future floor raise's `UPDATE` takes `FOR NO KEY UPDATE`, which only the former conflicts with per the row-lock conflict matrix, [PostgreSQL §13.3.2 Row-Level Locks](https://www.postgresql.org/docs/current/explicit-locking.html#ROW-LOCK-COMPATIBILITY) — so a floor rise cannot slip between check and write); the caller's `session_memberships` row is read `FOR SHARE` at level 2 of the canonical order (round 4: `FOR SHARE` is the weakest mode conflicting with the `FOR NO KEY UPDATE` a `MembershipService` suspend/revoke `UPDATE` acquires, so a revocation cannot commit between the authorization read and the key INSERT — an unlocked probe would let stale authorization mint the durable row; this is an authorization READ, so Plan-003 I-003-3 is untouched: the transaction writes nothing to `session_memberships`); the attachment row is read `FOR SHARE` (conflicting with detach's state `UPDATE`, so a concurrent detach blocks until this transaction commits); the floor comparison runs in TypeScript (semver `MAJOR.MINOR` compares lexicographically wrong in SQL); and register-once applies as `INSERT ... ON CONFLICT (session_id, node_id) DO NOTHING` with in-transaction classification of the zero-row arm ([INSERT §ON CONFLICT Clause](https://www.postgresql.org/docs/current/sql-insert.html#SQL-ON-CONFLICT) — `DO NOTHING` "simply avoids inserting a row" and `RETURNING` returns "only rows that were successfully inserted or updated", so the zero-row arm is the loser's signal) — byte-equal stored key is the idempotent success, a different key throws the typed conflict — so a raw `23505` is never RAISED rather than caught: the `Querier` contract has no SAVEPOINTs, a raised unique violation aborts the transaction ("`ROLLBACK TO` is the only way to regain control of a transaction block that was put in aborted state by the system due to an error" — [PostgreSQL Tutorial §3.4 Transactions](https://www.postgresql.org/docs/current/tutorial-transactions.html)), and every subsequent command fails `25P02 in_failed_sql_transaction` ([PostgreSQL Appendix A — Error Codes](https://www.postgresql.org/docs/current/errcodes-appendix.html#ERRCODES-TABLE): `23505 unique_violation`, `25P02`) — no legal re-read. Two racing different-key registrations therefore resolve to exactly ONE stored key (round 4, correcting the round-3 clause that claimed both racers receive the 409): the INSERT winner returns the `null` success, while the zero-row loser's in-transaction re-read — a new statement, and Read Committed "starts each command with a new snapshot that includes all transactions committed up to that instant" ([PostgreSQL §13.2.1 Read Committed Isolation Level](https://www.postgresql.org/docs/current/transaction-iso.html#XACT-READ-COMMITTED)), so it legally sees the winner's committed row — classifies the stored different key into the typed 409: one success plus one 409, the shape T4.10's concurrency test asserts, never a raw `23505`. The lock order is registered in [cross-plan-dependencies.md §Lock Ordering Across Shared Tables](../cross-plan-dependencies.md#lock-ordering-across-shared-tables). The roster query is floor-free but NOT authorization-free (Codex PR #274 rounds 3–4, 2026-07-31): [§Authenticated Principal](#authenticated-principal-and-authorization-model) scopes every control-plane endpoint — queries included — to its authenticated caller, so `runtimenode.signingkeyroster` requires the caller's verified principal to hold an ACTIVE `session_memberships` row for the session (any active role — the Permission Matrix read posture, viewers included), refused with the same typed `runtimenode.permission_denied` (403). The membership check and the roster read are ONE SQL statement — a single-row membership-predicate anchor (`EXISTS` over the caller's membership) LEFT-JOINed to `daemon_signing_public_keys` — because two separate statements at READ COMMITTED take two snapshots, letting a revocation commit between probe and read and hand a just-revoked caller a roster newer than their authorization (round 4); one statement is one snapshot ([PostgreSQL §13.2.1 Read Committed Isolation Level](https://www.postgresql.org/docs/current/transaction-iso.html#XACT-READ-COMMITTED)), so the authorization and the returned entries are atomic WITHOUT a lock — a read-path `FOR SHARE` on the membership row would serialize the revoker behind readers while making no reader's answer fresher (the shipped `readRoster` single-statement principle; the BL-141 campaign design's `readRoster` decision prescribes a locked transaction where its uniform-`404` negative requires a `sessions` read — this surface's `403` collapse reads no `sessions` row, so the snapshot alone closes the race). The statement never reads `sessions`: a non-member of a real session and a caller naming a nonexistent session yield the identical false membership flag and byte-identical refusals, and the refusal path inspects no key column; a member of a session with no registered keys gets the anchor row with NULL key columns — `{ entries: [] }` — so empty and denied stay distinguishable. Each entry's `registeredAt` normalizes through the `readRoster` `toIsoString` convention before the response parse (round 4): `TIMESTAMPTZ` hydrates as a JS `Date` under both shipped drivers (`pg`, PGlite) while the wire field is an ISO-8601 string whose `z.iso.datetime({ offset: true })` schema REJECTS a `Date`, so the T4.10 roster test runs against a real PGlite database through the response schema — exercising the hydration path rather than mocking it away. Primary sources for those three claims (round 5, 2026-08-01, each verified at content level): `pg` delegates result parsing to `pg-types`, whose [`lib/textParsers.js`](https://github.com/brianc/node-pg-types/blob/master/lib/textParsers.js) registers OID `1184` (`timestamptz`) to the `Date`-returning `postgres-date` parser (`register(1184, parseTimestampTz)` where `parseTimestampTz = require('postgres-date')`); PGlite's parser for the timestamp family is `parse: (x) => new Date(x)` in [`packages/pglite/src/types.ts`](https://github.com/electric-sql/pglite/blob/main/packages/pglite/src/types.ts); and [Zod §ISO datetimes](https://zod.dev/api#iso-datetimes) documents `z.iso.datetime()` as ISO-8601 STRING validation, so a `Date` instance fails its string precondition before any format check. No operator arm exists on this transport in V1 — the recorded residual against the reader list above: a "forensic export" reader reaches the roster through a session-member principal (or direct database access under the operator's own custody), never an ungated query. The store deliberately carries no participant FK — key material is machine-generated, carries no personal data, and sits outside the [Spec-022 §Shred Fan-Out](../../specs/022-data-retention-and-gdpr.md#shred-fan-out) Path-2 `REFERENCES participants(id)` closure, so registered keys SURVIVE participant erasure and the retained crypto-shredded `runtime_node.*` stream plus `event_log_anchors` rows stay verifiable.

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `runtimenode.signingkeyregister` | `mutation` | `RuntimeNodeSigningKeyRegisterRequest` | `null` — HTTP 200 `{ result: { data: null } }`; `RuntimeNodeSigningKeyRegisterResponseSchema` (`z.null()`) — control-plane tRPC ONLY, **daemon-called** from the session-establishment registrar, landing post-attach (membership-gated + producer-bound + register-once per the contract paragraph above; no daemon JSON-RPC registration; Plan-006 T4.10) |
| `runtimenode.signingkeyroster` | `query` | `RuntimeNodeSigningKeyRosterRequest` | `RuntimeNodeSigningKeyRosterResponse` — control-plane tRPC ONLY (the roster is control-plane-owned cross-node state; Plan-006 T4.10) |

```ts
// RuntimeNodeSigningKeyRegister — control-plane tRPC ONLY, daemon-called from the session-establishment
// registrar, landing post-attach (Plan-006 T4.10 per CP-006-7 leg B / CP-003-5; producer-bound like runtimenode.leaseupdate)
interface RuntimeNodeSigningKeyRegisterRequest {
  sessionId: SessionId;
  nodeId: NodeId;
  attachmentId: string; // runtime_node_attachments.id — the server-minted UUID the attach response returned, republished on no roster surface; the transaction requires it to equal the live attachment row's id, narrowing registration to the daemon whose shell performed the attach (Codex PR #274 round 5)
  daemonSigningPublicKey: string; // 64-char lowercase hex of the 32-byte Ed25519 public key (the Plan-006 T2.3 wire convention); hex-decoded to BYTEA at persist
}
// Response: null — HTTP 200 { result: { data: null } } (RuntimeNodeSigningKeyRegisterResponseSchema = z.null(),
// the heartbeat/detach/leaseupdate pattern). A same-key replay is acknowledged null too (register-once, retry-safe);
// a different-key registration is refused with typed runtimenode.signingkeyregister_conflict (409/CONFLICT) and no row write;
// a below-floor daemon's registration is refused version.floor_exceeded (Spec-003 version-sensitive-write rule);
// a caller without an ACTIVE session membership or a live owned attachment matching the presented
// attachmentId (inactive membership, missing or foreign attachment, non-matching attachmentId,
// unknown session — all collapsed) is refused typed runtimenode.permission_denied
// (403/FORBIDDEN) before the floor or key comparison is reached; a genuine daemon refused the
// 409 for its own slot appends audit_integrity_failed failureMode 'signing_key_slot_conflict'
// durably (round 5 — see the contract paragraph above).

// RuntimeNodeSigningKeyRoster — control-plane tRPC ONLY (the NodeId-keyed verification-key
// resolution surface per Security Architecture §Per-Event Daemon Signature). Membership-gated:
// the caller must hold an ACTIVE session_memberships row (any role), the check and the read ONE
// SQL statement — one READ COMMITTED snapshot, so no revocation can interleave; a non-member or a
// caller naming an unknown session is refused typed runtimenode.permission_denied (403) with
// byte-identical refusals (the statement never reads sessions) — empty ({ entries: [] }) and
// denied stay distinguishable.
interface RuntimeNodeSigningKeyRosterRequest {
  sessionId: SessionId;
}
interface RuntimeNodeSigningKeyRosterEntry {
  nodeId: NodeId;
  daemonSigningPublicKey: string; // 64-char lowercase hex
  registeredAt: string; // ISO 8601 — daemon_signing_public_keys.registered_at with no server-side derivation or masking; TIMESTAMPTZ hydrates as a JS Date under both shipped drivers (pg, PGlite), so the projection normalizes through the readRoster toIsoString convention before the response parse — z.iso.datetime({ offset: true }), the file convention, REJECTS a Date (Codex PR #274 round 4; the pg-types/PGlite/Zod primary sources are cited at the roster paragraph above, round 5)
}
interface RuntimeNodeSigningKeyRosterResponse {
  entries: RuntimeNodeSigningKeyRosterEntry[]; // one entry per registered (session, node); a node attached under a pre-leg-B daemon or control plane simply has no entry (emitter-only-verifiable — the honest degrade)
}
```

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
// free-form fields (`DriverCapabilities.contractVersion`, `ProviderSessionHandle.resumeHandle`,
// and `DriverCliVersionReport.raw` — the CLI-version string, parsed to `semver` fail-closed and
// riding the nominal `GetCapabilitiesResult` return exactly like `contractVersion`) are bounded
// at the Plan-005 Phase-2 write seam (semver / non-empty + length + NUL), not here.
// Zod validates ONLY the surfaces that parse UNTRUSTED
// provider output (the trust boundary): the result envelopes `DriverInterventionResult`,
// `DriverResumeResult`, `DriverRollbackResult`, `DriverGoalResult`, and `DriverAuthProbeResult`,
// provider-declared `ProviderToolMetadata`, and the driver-normalized `CallbackToolInvocation` /
// `McpServerStatusEmission` (each built from provider wire output before the daemon-injected
// seam sees it, campaign B10).
// `resumeSession` returns the `DriverResumeResult` discriminated union (defined below)
// to make silent-replacement structurally inexpressible per Spec-005:69.
// `getCapabilities` returns the `GetCapabilitiesResult` wrapper (defined below) so the
// per-tool `ProviderToolMetadata[]` rides alongside the flag matrix in a single
// round-trip per Plan-005 Phase 4 ratified design.
// Within the Zod-validated surfaces, `ProviderToolMetadata` STRIPS unknown keys (Spec-005
// §Default Behavior forward-compat: "Unknown capability fields are ignored (tolerant
// reader)" — campaign B3 re-framed contractVersion as change-detection, not negotiation),
// while the result envelopes reject unknown keys (`.strict()`);
// and all twelve untrusted provider-output free-form strings (`ProviderToolMetadata.name`/`.description`,
// `DriverInterventionResult.fallbackAction`, `DriverResumeResult.bindingId`/`.providerFailureDetail`,
// `DriverRollbackResult.fallbackAction`/`.bindingId`, `DriverGoalResult.fallbackAction`,
// `DriverAuthProbeResult.detail`, `CallbackToolInvocation.toolName`/`.toolCallId`,
// `McpServerStatusEmission.serverName` — the last three added by campaign B10, Codex rounds 4–5) —
// each on a Zod-validated result envelope, `ProviderToolMetadata`, or a driver-normalized
// seam shape (`CallbackToolInvocation` / `McpServerStatusEmission`) below —
// are runtime-bounded (length + non-whitespace + NUL-rejection) via the package's `wireFreeFormString`
// helper — Zod constraints not expressible in these TS interface shapes.
interface ProviderDriver {
  createSession(params: CreateSessionParams): Promise<ProviderSessionHandle>;
  resumeSession(params: ResumeSessionParams): Promise<DriverResumeResult>;
  startRun(params: StartRunParams): Promise<void>;
  interruptRun(params: InterruptRunParams): Promise<void>;
  applyIntervention(params: ApplyInterventionParams): Promise<DriverInterventionResult>;
  rollbackTo(params: RollbackToParams): Promise<DriverRollbackResult>;
  respondToRequest(params: RespondToRequestParams): Promise<void>;
  setSessionGoal(params: SetSessionGoalParams): Promise<DriverGoalResult>;
  clearSessionGoal(params: ClearSessionGoalParams): Promise<DriverGoalResult>;
  closeSession(params: CloseSessionParams): Promise<void>;
  listModels(): Promise<ProviderModel[]>;
  listModes(): Promise<ProviderMode[]>;
  getCapabilities(): Promise<GetCapabilitiesResult>;
  probeAuth(): Promise<DriverAuthProbeResult>;
}

interface CreateSessionParams {
  sessionId: SessionId;
  config: Record<string, unknown>;
  // Spawn-time realization of the native-cap-escape admitted cap (campaign B6): providers that
  // bind budget caps at process spawn (Claude `--max-budget-usd`) realize it HERE — the initial
  // create path must never launch a native-cap-admitted leg capless while the accountant
  // reserves/debits as if enforced. StartRunParams / ResumeSessionParams carry the same value
  // for the run and recovery paths (Spec-016 §Cost Derivation And Absent-Cost Semantics).
  admittedCostCapCents?: number;
  executionPosture?: ExecutionPosture; // spawn-time posture — provider legs that bind posture at process spawn (Claude `--settings` sandbox) realize it here; the per-run effective posture rides StartRunParams (Spec-005 §Required Behavior, campaign B3)
  callbackTools?: SessionCallbackTool[]; // daemon-curated callback-tool registry exposed into the session (Codex function-form dynamicTools; Claude daemon-hosted ephemeral MCP server via --mcp-config); gated on the callback_tools flag
  subagentPolicy?: SubagentPolicy; // provider-native in-session subagent policy pass-through under the single-supervisor invariant (Spec-016 semantics land via campaign B6); gated on the subagents flag
  outputSchema?: Record<string, unknown>; // normalized JSON Schema constraining schema-constrained final output (Spec-005 §Per-Driver Capability Matrix structured_output, campaign B10); gated on the structured_output flag. The Claude leg binds it per session at spawn (--json-schema); the Codex leg realizes it per turn via StartRunParams.outputSchema (turn/start.outputSchema). Named consumers: Spec-024 dispatch results, Plan-016 orchestration reads
  onCallbackToolCall?: (invocation: CallbackToolInvocation) => Promise<CallbackToolResult>; // daemon-injected callback-tool dispatcher (campaign B10); the driver invokes it on a provider callback-tool request and answers the provider with the result. Gated on the callback_tools flag; the daemon-side host routes through Plan-012's Cedar pipeline (CP-005-7 / B13 T2.8). See CallbackToolInvocation below
  onMcpServerStatus?: McpServerStatusProducer; // daemon-injected MCP server-status sink (campaign B10); the driver emits the per-session MCP server-status census (init) + status-change updates through it as typed McpServerStatusEmission values — the closure is pre-bound to the leg identity (sessionId + bindingId) at spawn and stamps them into the consumer-facing McpServerStatusUpdate (Codex round 5). Producer-only at Plan-005 — the consumer is Plan-028's status normalizer (§Plan-028 — MCP Governance Contract Surfaces below; Spec-028, registered 2026-07-22 B18). See McpServerStatusEmission below
}

interface ResumeSessionParams {
  sessionId: SessionId;
  resumeHandle: string; // opaque provider-owned handle
  // recovery wire-through (campaign B6): on resume/relaunch of a native-cap-admitted run the daemon
  // re-threads the admitted cap from the durable run.queued payload (admittedUnpricedCapCents), so the
  // provider-side hard stop survives daemon restart and session relaunch (Plan-015 recovery resumes
  // bindings through this seam; realized like StartRunParams.admittedCostCapCents on cap-capable legs)
  admittedCostCapCents?: number;
  // Resume is a FRESH process spawn (the C-12 posture-relaunch precedent), so every spawn-bound
  // surface CreateSessionParams binds must re-realize here or the resumed leg silently sheds it —
  // a posture-less resume relaunches UNSANDBOXED, a schema-less one unconstrained (campaign B10,
  // Codex rounds 3–4). The four DATA legs below are reconstructed by the daemon from the durable
  // runtime_bindings.spawn_config record (written at every spawn; Plan-005 T1.7) — never from the
  // original client request, which recovery does not have; the two FUNCTION legs are re-injected
  // fresh at every spawn (functions are never stored in spawn_config).
  executionPosture?: ExecutionPosture;
  callbackTools?: SessionCallbackTool[];
  subagentPolicy?: SubagentPolicy;
  outputSchema?: Record<string, unknown>; // the Claude leg re-binds per session at spawn (--json-schema); the Codex leg realizes per turn via StartRunParams.outputSchema
  onCallbackToolCall?: (invocation: CallbackToolInvocation) => Promise<CallbackToolResult>; // re-injected dispatcher — an omitted rebind would strand provider callback-tool requests unanswered on the resumed leg
  onMcpServerStatus?: McpServerStatusProducer; // re-injected census sink, pre-bound to the resumed leg's identity — the resumed leg re-emits its init census through it
}

interface StartRunParams {
  // native-cap-escape wire-through: the admitted family cap (= the run.queued server-stamped admittedUnpricedCapCents),
  // realized as the provider's native hard cap on cap-capable legs (Claude `--max-budget-usd`); a leg that
  // binds caps at spawn realizes it via CreateSessionParams.admittedCostCapCents (the spawn carrier above) — and a native-cap run on such a leg starts only inside a session spawned with the MATCHING cap: an existing uncapped process forces a capped relaunch at the session boundary before this startRun dispatches (posture-relaunch precedent), never a start-in-uncapped
  // (Spec-016 §Cost Derivation And Absent-Cost Semantics, campaign B6)
  admittedCostCapCents?: number;
  runId: RunId;
  channelId: ChannelId;
  agentConfig: Record<string, unknown>;
  conversationHistory?: unknown[];
  executionPosture?: ExecutionPosture; // per-run effective posture — the same object the daemon stamps on run.running (Spec-006 §Run Lifecycle). Codex realizes per-turn (turn/start sandbox params); a provider that binds posture at spawn realizes it at session boundaries, and a mid-session posture change on such a leg resolves via session relaunch, never silent partial application (Spec-005 §Required Behavior, campaign B3)
  outputSchema?: Record<string, unknown>; // per-turn schema-constrained final output (Codex turn/start.outputSchema); the Claude leg binds it at spawn via CreateSessionParams.outputSchema (--json-schema). Gated on structured_output (Spec-005 §Per-Driver Capability Matrix, campaign B10)
}

interface InterruptRunParams {
  runId: RunId;
  reason?: string;
}

// Discriminated union over `type` — each intervention type coupled to its payload
// shape. `expectedRunVersion` is the MANDATORY fail-closed comparand (Plan-004
// D-004-2) repeated on every arm — absent value rejected, never applied.
// `clientIdempotencyKey` is the MANDATORY requester-generated UUID (Spec-005 §Required
// Behavior, campaign B3): the daemon dedupes on it (replay-or-conflict), and it rides
// through to the driver so provider-remote invocations that honor dedupe keys receive
// it (the `compensable` propagation pattern, Spec-005 §Tool Metadata). Same field set
// as the steer / interrupt / cancel arms of the InterventionRequestPayload union below —
// the `rollback` arm (campaign B2) deliberately has NO ApplyInterventionParams counterpart:
// its driver leg is the dedicated capability-gated `rollbackTo` parity operation
// (§Plan-005 below; Spec-004 §Interfaces And Contracts).
type ApplyInterventionParams =
  | {
      type: "steer";
      targetRunId: RunId;
      expectedRunVersion: number;
      clientIdempotencyKey: string;
      payload: SteerPayload;
    }
  | {
      type: "interrupt";
      targetRunId: RunId;
      expectedRunVersion: number;
      clientIdempotencyKey: string;
      payload: InterruptPayload;
    }
  | {
      type: "cancel";
      targetRunId: RunId;
      expectedRunVersion: number;
      clientIdempotencyKey: string;
      payload: CancelPayload;
    };

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
  status: "applied" | "degraded"; // the complete driver-level vocabulary — `rejected` / `expired` are orchestration-layer verdicts rendered around driver dispatch, never driver-returned (Spec-005 §Required Behavior; normative mapping in queue-and-intervention-model.md §Driver Result To Lifecycle Mapping, campaign B3)
  fallbackAction?: string; // e.g. 'queue_and_interrupt' for degraded steer
}

// Driver-level conversation rollback (campaign B3). `position` is the normalized monotonic
// session position (the same turn/event ordinal vocabulary `DriverResumeResult.sessionPosition`
// reports); the intervention-layer `targetPosition` (Spec-004 rollback content, campaign B2 —
// a named merge prerequisite before any rollback emitter exists) maps onto this driver ordinal.
// Codex leg: `thread/rollback` (drop-N-turns — the driver computes the drop count from the
// ordinal delta); Claude leg: `--resume-session-at <message-uuid>` + `--fork-session` composed.
// Conversation state ONLY: file-state restore is the daemon's turn-snapshot git leg (Plan-010),
// never the driver's — the Codex protocol schema itself notes rollback does not revert local
// file changes.
interface RollbackToParams {
  sessionId: SessionId;
  position: number;
  bindingId: string; // leg key (campaign B2) — the run's live provider binding, the same per-binding addressing as SetSessionGoalParams below: run→bindings is 1:many in the shipped store, so `sessionId` alone cannot name the target leg. The DAEMON resolves the run's live binding at dispatch (client rollback payloads never carry it — clients address the run); a fork-composed rollback then repoints the live binding via `DriverRollbackResult.applied.bindingId`.
}

type DriverRollbackResult =
  // A successful rollback without a confirmed floor is structurally inexpressible (mirrors
  // `DriverResumeResult`): position-compares consume it per Spec-015 via campaign B5/B14.
  | { status: "applied"; sessionPosition: number; bindingId?: string } // sessionPosition: REQUIRED driver-confirmed post-rollback position — the new authoritative recovery floor. Untrusted driver output: the daemon domain-validates it like the request target (integer ≥ 0, recorded boundary, strictly below the pre-rollback position) before trusting it — an invalid or no-op report is a no-rewind failure, never a run.rolled_back — with the file-leg recovery carve-out excepted: on a recovery-admitted current-position target the driver's convergence no-op (sessionPosition == targetPosition, no movement) IS the confirmed floor and the composite proceeds to the fixpoint restore (Spec-004 §Required Behavior). bindingId (campaign B2): present iff the mechanism minted a new provider binding for the same run (Claude fork-composed leg) — the store-minted surrogate of a binding row already registered (provider resume_handle + runtime metadata) through the relaunch pattern's write seam before the result returned, never itself a resume handle; the daemon repoints the run's live binding on receipt; absent on an in-place rollback (Codex thread/rollback); runtime-bounded (length + non-whitespace + NUL-rejection) like `DriverResumeResult.bindingId` — the trust-boundary header's twelve-string enumeration above
  | { status: "degraded"; fallbackAction?: string };

// Session-goal injection (campaign B3). `goalText` is the daemon-rendered textual form of the
// session's structured goal — the structured shape is owned by the Spec-016 goal contract
// (campaign B6), and the daemon renders structure → provider text at dispatch. Codex leg:
// `thread/goal/set` / `thread/goal/clear` (the `objective` field), live; Claude leg:
// driver-held composition into the system prompt at the next turn/resume boundary (grade
// `emulated` — Spec-005 §Parity Capability Mechanism Grades). Durable truth is the
// `session.goal_updated` / `session.goal_cleared` events (Spec-006); the daemon re-pushes the
// goal on session resume, so driver-held state is never the recovery source.
interface SetSessionGoalParams {
  sessionId: SessionId;
  // Leg addressing (campaign B6): goal delivery fans out per live binding, and `run` →
  // bindings is 1:many in the shipped store (store-minted surrogate ids; e.g. a capped or
  // posture relaunch mints a new binding for the same run) — so the BINDING is the leg key,
  // matching the durable intent's per-leg map. The driver resolves its provider session from
  // the binding it established at createSession/resumeSession (DriverResumeResult already
  // returns bindingId; a fork-composed rollback repoints it via DriverRollbackResult.applied.bindingId — campaign B2); runId rides along for run-scoped context and telemetry.
  bindingId: string;
  runId: RunId;
  goalText: string;
}

interface ClearSessionGoalParams {
  sessionId: SessionId;
  bindingId: string; // leg key — same per-binding fan-out as SetSessionGoalParams (campaign B6)
  runId: RunId;
}

type DriverGoalResult =
  // `applied` = the goal governs the session from now or the next turn boundary (both V1
  // legs) — a fallback narrative on a successful application is unrepresentable.
  | { status: "applied" } // success carries no fallback field
  | { status: "degraded"; fallbackAction?: string }; // an absent-grade driver could not deliver

// Return shape of `ProviderDriver.resumeSession()`. Discriminated union over `status`
// makes silent-replacement structurally inexpressible: the failure variant has no
// `bindingId`, so a successful resume cannot be conflated with a failed one. Spec-005
// §Fallback Behavior requires that resume failure "surface `provider failure` detail and
// a visible `recovery-needed` condition; it must not silently create a replacement provider
// session under the same canonical run." The `resumed` variant's REQUIRED `sessionPosition`
// (campaign B3) is the driver's normalized monotonic position — turn/event ordinal, the same
// number-cursor convention as `lastReplayedSequence`/`afterSequence` below — which the daemon
// compares against its recorded position; divergence reconciliation (halt-for-human, rollback
// markers as the position floor) is Spec-015's, landing via campaign B5/B14 per ADR-017's
// local-log-authoritative ruling. The compare also catches a provider silently returning a
// fresh session on resume (e.g. Claude on a working-directory mismatch): a fresh session's
// position cannot match the recorded one. Timestamps for the resumed case live on
// `runtime_bindings.updated_at` (Plan-005 T2.1); the result shape carries only the
// discriminated-union semantic payload.
type DriverResumeResult =
  | { status: "resumed"; bindingId: string; sessionPosition: number }
  | {
      status: "failed";
      recoveryCondition: RecoveryCondition;
      recoverySpanClassification: RecoverySpanClassification; // REQUIRED on this live driver return (Part-B follow-up 2026-07-17, named type below): a resume failure is produced fresh at resume time, never replayed, so a post-amendment driver emits `unclassifiable` when it cannot classify — omission is a schema failure
      providerFailureDetail: string;
    };

// Named once, referenced at every carrying surface (campaign B3, hoisting the previously
// repeated inline union): REQUIRED form on `DriverResumeResult.failed` above; optional form
// on `RunStateChangeEvent`, `RecoveryStatusReadResponse.sessions[]`, and
// `FailureDetailReadResponse` below. `recovery-needed` = generic, operator reconciliation
// required. `reauth-required` = the provider session or credential expired (detected mid-run
// via the provider's typed auth-failure signals or at resume/probe time); remediation is
// re-authenticating the provider CLI on the runtime node, after which recovery may retry
// (Spec-005 §Fallback Behavior).
type RecoveryCondition = "recovery-needed" | "reauth-required";

// Sibling classification of the halted span's CONTENT (Part-B fail-closed follow-up, 2026-07-17):
// orthogonal to `RecoveryCondition` above — that names why the run needs an operator; this names
// what the diverged/halted span contains, so policy can tier on blast radius. V1 consumes it as
// audit metadata ONLY: every divergence still halts for human action (Spec-015 §Fallback
// Behavior). Recording it makes tiered auto-resolution (auto-resolve `read_only` /
// `idempotent_write` divergence, always halt `irreversible`) a future policy flip rather than a
// schema change — a flip gated on the Plan-015 CI divergence-injection tests (with a firing
// negative control) landing first (campaign B14). `unclassifiable` MUST be handled exactly as
// `irreversible` — the fail-closed default. REQUIRED form on `DriverResumeResult.failed` above
// (a live driver return, produced fresh at resume — never replayed — so a post-amendment driver
// emits `unclassifiable` rather than omit); optional form on the three replay-visible carriers
// (`RunStateChangeEvent`, `RecoveryStatusReadResponse.sessions[]`, `FailureDetailReadResponse`),
// whose optionality admits pre-amendment history at replay only.
// Deliberately NOT widening `RecoveryCondition`: the two axes answer different questions, and
// conflating them would overload operator-remediation routing.
type RecoverySpanClassification =
  | "read_only"
  | "idempotent_write"
  | "irreversible"
  | "unclassifiable";

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
  effortLevels?: string[]; // per-model reasoning-effort vocabulary (provider vocabularies differ: Claude low..max; Codex minimal..xhigh — Spec-005 §Provider Parameter Vocabularies, campaign B3); absent = the model exposes no effort selection
}

interface ProviderMode {
  id: string;
  name: string;
}

// Effective sandbox/permission posture (campaign B3 hoist of the previously inline
// RunStateChangeEvent field — shape owned by Spec-005, policy semantics by Spec-012 §Required
// Behavior, campaign B20). Referenced by RunStateChangeEvent.executionPosture? (the run.running
// audit stamp) and by CreateSessionParams/StartRunParams (the spawn/turn carriers).
type ExecutionPostureNetwork =
  | { networkAccess: "none" | "full"; allowedDomains?: never } // allowedDomains structurally absent
  | { networkAccess: "allowed-domains"; allowedDomains: [string, ...string[]] }; // non-empty by construction (Spec-012 cross-field invariants, fail closed)

type ExecutionPosture = ExecutionPostureNetwork & {
  writableRoots: string[];
  profileName?: string;
} & (
    | { mode: "trusted"; credentialPolicyRef?: never } // a trusted run records no enforced credential constraint — a posture carrying mode "trusted" AND a policy ref is unrepresentable
    | {
        mode: "workspace-sandboxed" | "readonly-sandboxed";
        credentialPolicyRef: string; // content-addressed "sha256:<hex>" over the RFC 8785 JCS-canonicalized credential-policy artifact {schemaVersion: 1, denyPaths: string[], denyEnvVars: string[], envNameMatch: 'case-sensitive' | 'case-insensitive'} (daemon canonicalizes denyEnvVars names to the host's env-name case semantics — case-insensitive-env hosts fold to one spelling, case-sensitive verbatim — and records the host's match mode as envNameMatch so hosts that strip differently never share a ref; then lexicographically sorts + dedupes both arrays before hashing — JCS canonicalizes object members, not array order) — REQUIRED on both sandboxed modes ('workspace-sandboxed' / 'readonly-sandboxed'), absent under mode:'trusted' (the credential policy is realized as part of a sandboxed posture — a trusted run records no enforced credential constraint), so auditors reconstruct exactly which credentials were denied/scrubbed without embedding the raw installation-revealing list; the daemon persists the artifact row write-ahead (before the first citing posture stamp) so the ref never dangles (Spec-012 §Required Behavior, campaign B20).
      }
  );

// Daemon-curated callback tool exposed into a session (campaign B3; authorization semantics
// Spec-012, campaign B20). Mirrors the function-form provider tool shape (name + description +
// JSON-Schema input) — the Codex leg maps 1:1 onto function-form `dynamicTools` specs invoked
// via the `item/tool/call` server request; the Claude leg hosts the same registry as a
// daemon-hosted ephemeral MCP server (`--mcp-config`), where tools surface as
// `mcp__<server>__<tool>`. Every invocation flows through the daemon's approval pipeline and
// lands as an ordinary `tool_activity` row (Spec-006). Daemon-constructed and daemon-trusted —
// never provider output.
interface SessionCallbackTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema for the tool's arguments
}

// Callback-tool dispatch seam (campaign B10, Plan-005 T1.8 / T3.15 leg 3). The daemon injects
// `onCallbackToolCall` at spawn (CreateSessionParams above); when the provider issues a callback-tool
// request (Codex `item/tool/call`; the Claude hosted-MCP tool), the driver translates the wire request
// into a `CallbackToolInvocation`, invokes the injected dispatcher, and answers the provider with the
// `CallbackToolResult` — no invocation is left unanswered, no approval bypass invented. The daemon-side
// dispatcher is Plan-005's callback-tool host (`provider/callback-tool-host.ts`), routing every
// invocation through Plan-012's Cedar approval pipeline via the published `approval.requestCreate` seam
// (CP-005-7 covers driver-host permission callbacks; B13 T2.8) — Plan-005 authors no Plan-012 symbols —
// and landing the outcome as an ordinary `tool_activity` row. `CallbackToolInvocation` is normalized at
// the driver boundary from untrusted provider output; `CallbackToolResult` is daemon-constructed and trusted.
// Fail-closed availability (Codex round 5): the Cedar route is a Tier-6 consumer seam, so while the
// daemon has no registered `approval.requestCreate` seam, spawn WITHHOLDS the callbackTools registry
// (tools not exposed) and the host's runtime backstop answers any stray invocation `denied` + a
// DriverDiagnosticRecord — never `completed` without Cedar, never unanswered; the allow path activates
// when Plan-012's seam registers (CP-005-7).
interface CallbackToolInvocation {
  toolName: string; // untrusted provider output — wireFreeFormString-bounded (the trust-boundary header's twelve-string enumeration); resolved against the session's registered SessionCallbackTool set, and an UNKNOWN name answers `failed` without dispatch (campaign B10, Codex round 4)
  arguments: Record<string, unknown>; // validated against the registered tool's inputSchema BEFORE any Cedar round-trip — schema-invalid arguments answer `failed` without dispatch, so malformed provider output never reaches the approval pipeline
  toolCallId: string; // untrusted provider correlation id — wireFreeFormString-bounded, copied verbatim onto the answered result (tool-event pairing is exact-string match)
  sessionId: SessionId;
  runId: RunId;
}
type CallbackToolResult =
  | { status: "completed"; output?: unknown; error?: never }
  | { status: "denied"; output?: never; error?: string }
  | { status: "failed"; output?: never; error?: string };

// MCP server-status producer seam (campaign B10, Plan-005 T1.8 / T3.13). Producer-only: the daemon
// injects `onMcpServerStatus` at spawn (CreateSessionParams above); the driver emits the per-session MCP
// SERVER inventory (name + status) at init plus status-change updates through it — never an untyped
// record. Servers only, never a per-server tool-list assumption (support is not visibility, Spec-005
// §Per-Driver Capability Matrix). Driver telemetry/census surface (DO disposition — no persisted table,
// no new CREATE owner). The consumer is Plan-028's status normalizer (Spec-028, registered 2026-07-22
// B18 — §Plan-028 — MCP Governance Contract Surfaces below); consumer semantics live there.
type McpServerStatus = "unknown" | "starting" | "connected" | "needs-auth" | "failed";
// Driver-emitted shape: serverName + status ONLY. The driver NEVER supplies leg identity — the daemon
// pre-binds the injected producer closure to the leg at spawn (sessionId + the store-minted bindingId,
// pre-minted before the spawn per the relaunch write-seam pattern), so a driver cannot misattribute —
// or spoof — another leg's rows, and the init census emitted DURING createSession needs no id the driver
// does not have (Codex round 5). `serverName` is untrusted provider/CLI output — wireFreeFormString-
// bounded at the driver normalization seam (the twelve-string enumeration above) before it reaches the
// producer.
interface McpServerStatusEmission {
  serverName: string;
  status: McpServerStatus;
}
// Daemon-stamped consumer-facing record (what the Plan-028 status normalizer reads): the pre-bound
// producer closure stamps the leg identity onto every emission.
interface McpServerStatusUpdate {
  sessionId: SessionId;
  bindingId: string; // leg key (campaign B10, Codex rounds 4–5) — daemon-stamped from the injection context, never driver-supplied; run→bindings is 1:many (the RollbackToParams.bindingId precedent), so statuses key per (binding, server): a relaunched leg's fresh census supersedes its OWN predecessor without clobbering a concurrent live leg's rows
  serverName: string;
  status: McpServerStatus;
}
type McpServerStatusProducer = (emission: McpServerStatusEmission) => void;

// Provider-native in-session subagent policy (campaign B3; orchestration semantics Spec-016 via
// campaign B6). Single-supervisor invariant: the daemon is the only cross-session supervisor —
// provider subagents run in-session only, their usage aggregates into the run's own budgets, and
// their tool calls flow through the same approval pipeline. `maxConcurrent` enforces natively on
// Codex; the Claude spawn-side cap is docs-silent, so that leg is BOUNDARY-SERIALIZED — beyond-cap
// subagents hold at their next daemon-mediated tool call until a slot frees (never failed; breach
// diagnostic = observability; subagents disabled at spawn if the leg cannot mediate tool calls)
// (Spec-005 §Parity Capability Mechanism Grades; Spec-016 §Provider-Native Subagents).
type SubagentPolicy =
  // Discriminated on `enabled`: a disabled policy carries no limits or definitions —
  // "off but configured" is unrepresentable; the daemon sends the full arm on enable.
  | { enabled: false }
  | { enabled: true; maxDepth: number; maxConcurrent: number; definitions: SubagentDefinition[] };

// Unified per-subagent definition the driver maps onto its provider form (Claude --agents
// AgentDefinition; Codex [agents] config). Fields beyond `name` are optional — each leg maps
// what its provider supports and ignores the rest (tolerant mapping, graded on the matrix).
interface SubagentDefinition {
  name: string;
  description?: string;
  model?: string;
  tools?: string[];
  permissionMode?: string;
  effort?: string;
  maxTurns?: number;
}

// Driver transport configuration (campaign B3) — a daemon driver-registry config surface, not
// an RPC payload. V1: the Codex driver only (app-server --listen unix://|ws://, config-gated,
// off by default); the Claude CLI exposes no local listener — remote Claude participation is
// Spec-024 cross-node dispatch, recorded as the parity mechanism. `bearerTokenRef` is a
// daemon-config reference to the ws bearer credential — a reference, never the secret value
// (the credentialPolicyRef ref-not-value pattern).
type DriverTransportConfig =
  | { transport: "stdio" } // the V1 default — no local listener, no endpoint
  | { transport: "unix-socket"; endpoint: string } // unix:// URL, REQUIRED
  // ws:// URL + bearer credential reference, both REQUIRED — an unauthenticated ws listener is unrepresentable:
  | { transport: "websocket"; endpoint: string; bearerTokenRef: string };

interface DriverCapabilities {
  flags: Record<DriverCapabilityFlag, boolean>;
  contractVersion: string; // change-detection signal, not negotiation: recorded at attach, compared on refresh to invalidate capability snapshots; the daemon never version-gates behavior on it (Spec-005 §Default Behavior, campaign B3)
}

// Per-tool idempotency classification used by the daemon's two-phase command-receipt
// protocol during crash recovery (Spec-005 §Tool Metadata; Spec-015 §Idempotency
// Protocol).
type IdempotencyClass = "idempotent" | "compensable" | "manual_reconcile_only";

// Durable MCP Tasks recovery handle (campaign B10, Plan-005 T5.1 — the gated Phase 5; T3.13 authors
// the receipt-write seam dormant, T5.1 lands the column + activates it after Plan-004 Phase 1's
// `command_receipts` CREATE). A task-augmented MCP call under the experimental MCP 2025-11-25 Tasks
// utility carries a receiver-generated `taskId` (from the `CreateTaskResult` acceptance response). It
// is NOT a new RPC payload: the daemon persists it on the receipt as the additive nullable
// `command_receipts.mcp_task_id` column (Plan-005 EXTENDs Plan-004's table per
// cross-plan-dependencies.md §1; DDL in local-sqlite-schema.md §Queue and Intervention Tables —
// bounded ≤256 + non-empty + NUL-reject: the id is untrusted remote-peer output). That column is the
// durable handle Spec-015 recovery reads to poll `tasks/get` + `tasks/result` instead of halting the
// `manual_reconcile_only` floor; NULL until the receiver accepts — a crash before that leaves the
// halt intact (Spec-005 §Recovery Consequences).

// INGRESS shape — what a provider driver DECLARES via `getCapabilities()`. `idempotency_class`
// is OPTIONAL: a driver MAY omit it and an undeclared class is NOT a contract violation. Were the
// field required here, Zod would reject a conformant-but-silent driver at ingress BEFORE the
// default could apply — defeating Spec-005:174. The daemon's capability-normalization seam
// (Plan-005 T2.4 hydration) resolves an omitted class to `manual_reconcile_only` (the conservative
// default per Spec-005:174), producing a `NormalizedProviderToolMetadata`.
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

// CLI-version report (campaign B3, P0-2). `raw` is the verbatim provider-reported version
// string (untrusted provider output on the nominal `GetCapabilitiesResult` return — bounded at
// the Plan-005 write seam like `contractVersion`, not the Zod trust boundary); `semver` is the
// driver-parsed normalized MAJOR.MINOR.PATCH the daemon compares against its configured
// per-driver floor (mechanical enforcement at attach/refresh; V1 shipped floors: Claude Code
// 2.1.198, codex-cli 0.141.0 — the 2026-07-02 CLI-currency audit pair). `semver` is REQUIRED,
// so an unparseable version is unrepresentable in this shape — the driver fails the report
// fail-closed and attach refuses as `driver.cli_version_unparseable`; a parseable version
// below the configured floor refuses as `driver.cli_version_below_floor` (Spec-005 §Required
// Behavior).
interface DriverCliVersionReport {
  raw: string;
  semver: string;
}

// Zero-turn authentication probe result (campaign B3, P0-5). Zod `.strict()` — a result
// envelope rejecting unknown keys, correct for an internal owned contract paired with
// contract versioning. `indeterminate` (probe surface unavailable or unparseable) is treated
// as NOT authenticated for admission — fail closed — while staying distinguishable so
// operators separate probe health from credential state. Run admission against a driver not
// probing `authenticated` refuses as `driver.not_authenticated` before any turn is spent
// (Spec-005 §Required Behavior). Mid-run credential expiry is a different surface: the
// provider's typed auth-failure signals map to RecoveryCondition 'reauth-required'.
interface DriverAuthProbeResult {
  status: "authenticated" | "unauthenticated" | "indeterminate";
  detail?: string; // provider-reported account/plan detail (untrusted free-form, bounded)
}

// Return type of `ProviderDriver.getCapabilities()`. Spec-005 §Tool Metadata semantically
// separates whole-driver capability flags from per-tool metadata; the wrapper keeps
// `DriverCapabilities` pure (flags + contractVersion only) while still carrying both
// surfaces in a single round-trip. Modern precedent: MCP 2026 separates `initialize`
// server capabilities from `tools/list`; LSP separates `ServerCapabilities` from
// registered tool surfaces. `cliVersion` (campaign B3) is REQUIRED: a report without a
// parseable provider version never reaches the daemon (fail-closed by construction).
interface GetCapabilitiesResult {
  capabilities: DriverCapabilities;
  tools: ProviderToolMetadata[];
  cliVersion: DriverCliVersionReport;
}
```

### Plan-006 — Session Event Taxonomy

> **Cross-plan note (amendment 2026-06-02, PR #137 — Plan-003 Phase 2).** The per-event payload-shape Zod schemas for the `runtime_node.*` payloads below are **authored by Plan-003** in `packages/contracts/src/runtime-node.ts` (the file Plan-003 owns; CREATE), not by Plan-006. Plan-003 ships `capabilityDetails` (on `capability_declared`) and `previousState`/`newState` (on `capability_updated`) as an **interim opaque** `z.record(z.string(), z.unknown())` because the canonical `CapabilityDetails` consumes Plan-005's `provider-driver.ts` types, which do not yet exist. The `CapabilityDetails` interface defined here is the shape **Plan-006 Tier 4 binds** over those interim-opaque fields (EXTEND — closes Plan-005 CP-005-5 / Plan-006 CP-006-5): the bind lands first — Plan-006 Phase 1 T1.4, the canonical-first arm of a tolerant union — while registration of the schemas into the discriminated `SessionEventSchema` union (`event.ts`) and their `EventEnvelope` wrapping ride the later Tier-4 legs. See [cross-plan-dependencies.md §3 Plan-003 row](../cross-plan-dependencies.md#3-inter-plan-dependency-graph) and Plan-003 §CP-003-1 (Payload-shape ownership).

```ts
// CapabilityDetails — wrapper shape carried by `runtime_node.capability_declared` and
// `runtime_node.capability_updated` event payloads (Spec-006 §Runtime Node Lifecycle, the capability rows). Bound to the same
// three surfaces a driver advertises via `ProviderDriver.getCapabilities()` (GetCapabilitiesResult
// above): the thirteen-flag matrix, the declared contract version, and the per-tool metadata —
// here as `NormalizedProviderToolMetadata` (post-default), since these payloads cross the event
// boundary and must never carry an un-normalized `idempotency_class`. `GetCapabilitiesResult.cliVersion`
// is intentionally NOT mirrored here — the CLI-version floor is an attach-time fail-closed gate, not a
// per-snapshot capability property, so it never crosses the event boundary (campaign B3). The floor
// check and the `driver_contract_meta.cli_version_*` cache write are refresh-path obligations evaluated
// on EVERY refresh, before and independent of this snapshot's change-detection diff — a CLI-version-only
// change is event-silent but never floor-silent or cache-stale (campaign B3).
// Why flattened (not nested under `capabilities`): in the event-payload context all three
// surfaces compose one capability snapshot; readers (Plan-013 timeline, Plan-020 dashboards,
// Plan-015 replay) discriminate `runtime_node.capability_*` events from the discriminated
// union and consume the snapshot as a single object — there is no driver-method context
// that requires DriverCapabilities to remain pure. Sources: Spec-006 §Runtime Node Lifecycle (capability rows); Plan-005
// CP-005-5; Plan-006 Phase 1 T1.4 + Phase 3 doc-mirror audit.
interface CapabilityDetails {
  flags: Record<DriverCapabilityFlag, boolean>;
  contractVersion: string;
  tools: NormalizedProviderToolMetadata[];
}

// runtime_node.capability_declared payload (Spec-006 §Runtime Node Lifecycle, capability_declared row). Emitted once per driver
// registration with the daemon's runtime-node bootstrap (Plan-003 territory).
interface RuntimeNodeCapabilityDeclaredPayload {
  capability: string; // canonical capability identifier (e.g., "provider-driver")
  capabilityDetails: CapabilityDetails;
}

// runtime_node.capability_updated payload (Spec-006 §Runtime Node Lifecycle, capability_updated row). Emitted on driver-version
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
  actor?: string | null; // participant_id, agent_id, or null for system
  payload: Record<string, unknown>; // category-specific fields; may carry the cross-cutting sourceEpoch + sourcePosition pair (below)
  correlationId?: string;
  causationId?: string;
  version: EventEnvelopeVersion; // semver "MAJOR.MINOR" per ADR-018 §Decision #1 (never numeric)
}

// sourceEpoch + sourcePosition — the cross-cutting epoch-attribution payload pair
// (Plan-006 T1.9, the CP-004-12 registration, 2026-07-20; Spec-006 §Event Type
// Enumeration). Stamped TOGETHER at ingestion by Plan-004 T3.11's late-append leg on
// pre-rollback-epoch rows (the pair from the straggler's per-event operation
// association — (epoch, turn) recorded at operation open — falling back to the closed
// delivery generation's always-superseding retained pair; Spec-004 §Required Behavior
// owns the fence and generation-rotation mechanics) of the five late-append families
// — assistant_output,
// tool_activity, usage_telemetry, artifact_publication, and the interactive_request
// closed pair (driver_ask.requested + driver_ask.canceled): sourceEpoch names the
// pre-rollback execution epoch, sourcePosition the normalized session position (the
// Spec-004 targetPosition turn-boundary vocabulary) the row occupies within it —
// registered because no run-scoped family payload carries a native position key, and
// the supersede cutoff (turn > targetPosition) cannot rank a late row against its
// epoch's surviving prefix without one. Admission is keyed on run-scopedness, not
// family membership: only run-scoped SessionEventSchema branches of those families
// admit the pair (via Plan-006 T1.9's withEpochStamp helper, whose pairing
// refinement requires both keys + runId on any stamped payload); variants without
// run attribution — the account-plane usage.rate_limit_update foremost — and every
// run_lifecycle branch never admit it (stragglers absorb, never append). Absent on
// every current-epoch row — absence means current-epoch, and the stamp is never
// fabricated at read time. The pair rides INSIDE payload, so it sits in the RFC 8785
// canonical bytes (signed, hash-chained, shred-safe) with no envelope-level field
// added — the canonical set above is unchanged — and no version bump: the
// registration precedes ADR-018 §Reversibility Assessment's point of no return,
// which is an emission event, not a code merge — pre-first-release, no production
// deployment exists, so no "1.0" envelope has been emitted in a non-test environment
// as of 2026-07-20 (shipped emitter code on develop does not cross it) — making the
// pair part of the v1.0 baseline payload contract from first emit; added after that
// point it would be a MINOR envelope bump per ADR-018 §Decision #8's
// new-optional-field rule, and Plan-006 T1.9 carries that conditional for its
// implementer. The audit-stub projection preserves the sourceEpoch + sourcePosition
// + runId triple at compaction, on accepted run.rolled_back boundary rows the
// runId/runVersion/targetPosition rewind cutoff, and on every run-scoped row the
// runId + resolved originPosition rewind-span detection keys (ORIGIN_POSITION_STUB_KEY
// in packages/contracts/src/event.ts — Spec-006 §Compacted Event Format),
// so Plan-004 T3.14's supersede projection keys cross-epoch rows durably even after
// both the boundary and the stale rows compact. Execution-epoch semantics are
// Spec-004-owned (§Required Behavior + Run State Machine §Invariants): 0 before any
// rollback, advancing with each accepted run.rolled_back rewind regardless of the
// file-leg disposition. The key names are pinned by SOURCE_EPOCH_PAYLOAD_KEY /
// SOURCE_POSITION_PAYLOAD_KEY in packages/contracts/src/event.ts — a rename is
// forbidden-non-additive per ADR-018 §Decision #8.
type SourceEpoch = number; // int >= 0 — SourceEpochSchema in packages/contracts/src/event.ts (Plan-006 T1.9)
type SourcePosition = number; // int >= 0 — SourcePositionSchema, same file (Plan-006 T1.9); Spec-004 targetPosition vocabulary

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
  // §Channel Arbitration, §Onboarding Lifecycle, §Cross-Node Dispatch, §MCP Governance (20 categories
  // total per Spec-006 §Event Type Summary; 156 event types (140 per the 2026-07-02 B1 amendment,
  // +1 `pty.control_changed` per the 2026-07-06 B4 amendment, +15 per the 2026-07-22 B18 amendment —
  // incl. the five `mcp_governance` types) — the Tier-5
  // readiness-audit swap registered daemon.master_key_source + daemon.pii_split_ambiguous
  // under the existing security_events category, Plan-022 D-022-5, and the Tier-6 swap
  // added approval.canceled (D-012-8) plus four Plan-016 types (A-016-6, D-016-10/11/12),
  // all within existing categories — B18's mcp_governance is the first category addition since
  // the 16 → 19 widening).
  | "runtime_node_lifecycle"
  | "recovery_events"
  | "participant_lifecycle"
  | "audit_integrity"
  | "security_events"
  | "event_maintenance"
  | "policy_events"
  | "channel_arbitration"
  | "onboarding_lifecycle"
  | "cross_node_dispatch"
  | "mcp_governance";
// Individual event types within each category are enumerated in Spec-006 §Event Type Enumeration.

// EventReadAfterCursor
interface EventReadAfterCursorRequest {
  sessionId: SessionId;
  afterCursor?: EventCursor; // absent ≡ start-of-log position -1: full surviving-range read, SSE first-connect parity (Plan-006 T4.3)
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
// carrier fields durably (Spec-006 §Run Lifecycle run.queued row — additive optional fields). The wire
// run.queueCreate method never accepts the carrier — child-run creation goes through orchestration.runCreate only.

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
// `clientIdempotencyKey` (campaign B3) is the second mandatory guard — a requester-generated UUID
// giving at-least-once delivery exactly-once application: the daemon persists it on the
// interventions row (UNIQUE(target_run_id, client_idempotency_key)); an identical retry replays
// the originally recorded outcome without re-dispatching, and key reuse with a differing payload
// is rejected as `intervention.idempotency_conflict` (Spec-005 §Required Behavior). The two
// guards are orthogonal: `expectedRunVersion` defeats stale replays of OUTDATED intent;
// `clientIdempotencyKey` defeats duplicate applications of the SAME intent.
type InterventionRequestPayload =
  | {
      type: "steer";
      targetRunId: RunId;
      expectedRunVersion: number;
      clientIdempotencyKey: string;
      content: string;
      attachments?: unknown[];
      expectedTurnId?: string;
    }
  | {
      type: "interrupt";
      targetRunId: RunId;
      expectedRunVersion: number;
      clientIdempotencyKey: string;
      reason?: string;
    }
  | {
      type: "cancel";
      targetRunId: RunId;
      expectedRunVersion: number;
      clientIdempotencyKey: string;
      reason?: string;
    }
  | {
      // campaign B2 (Spec-004 §Required Behavior). Full wire member — same guards, same
      // lifecycle — but the driver leg is the dedicated `rollbackTo` parity operation
      // (RollbackToParams below), never an ApplyInterventionParams arm.
      type: "rollback";
      targetRunId: RunId;
      expectedRunVersion: number;
      clientIdempotencyKey: string;
      targetPosition: number; // normalized session position (RollbackToParams.position vocabulary), domain-validated fail-closed at admission: an integer ≥ 0 (Zod int + nonnegative at parse) naming a recorded turn boundary of the target run strictly below its current position — daemon boundary-existence check, Spec-004 §Required Behavior; current-position targets admissible solely as the file-leg recovery carve-out. Serializes onto run.rolled_back identically on the confirmed path; a confirmed-floor mismatch degrade records the driver-confirmed position instead (the event never lies about the landing position)
    };

// On an idempotent replay (same clientIdempotencyKey, identical payload) this response is
// reconstructed from the persisted intervention row — same interventionId, current state,
// current runVersion — never a second application (campaign B3).
//
// Rollback-only result surface (campaign B9, mirrors Plan-004 T1.3) — restructured to a discriminated
// disposition union (Codex round 2) mirroring Spec-004 §Required Behavior's FULL rollback outcome
// vocabulary: a file-leg-only four-literal cannot express the mandatory no-rewind and skipped-file-leg
// degradations. Carried ONLY on a `rollback` result (the `applied` / `degraded` states); every
// non-rollback intervention omits it. Since round 5 the disposition class is ENCODED in the arm types:
// `applied` admits exactly RollbackAppliedResult (`files-restored` / `conversation-only`) and `degraded`
// exactly RollbackDegradedResult (the other five) — the per-disposition `(applied)` / `(degraded)`
// annotations below are that normative mapping, and it is ORTHOGONAL to the rewind grouping (the
// CONFIRMED-REWIND group spans both states). Two groups, split by whether the conversation leg confirmed
// a rewind (Codex round 4 — `position-mismatch` belongs to the CONFIRMED group: its rewind DID happen,
// at the confirmed floor) —
//   CONFIRMED-REWIND (the conversation leg confirmed a rewind — the forward `run.rolled_back` is
//   emitted at the confirmed position and the execution epoch ADVANCES, Plan-004 T3.13):
//     `files-restored`           restore ran to the fixpoint (`applied`)
//     `files-partially-restored` multi-command restore failed mid-sequence, `failedStep` named plus the
//                                same two never-silent enumerations for every effect applied before the
//                                failure (Codex re-audit round 2; PR #230) — a convergent partial (a fresh
//                                rollback to the same targetPosition re-runs to the fixpoint); NEVER
//                                collapsed into `files-unrestored` (`degraded`)
//     `files-unrestored`         the bound file-restore refused at EXECUTION time (the execution-time
//                                HEAD re-verify) after the conversation leg already applied (`degraded`)
//     `conversation-only`        `read-only` mode or a disposed/retired execution root — the file leg
//                                no-ops (`applied`)
//     `position-mismatch`        the driver-confirmed floor was valid but ≠ the requested targetPosition:
//                                the conversation rewound to the CONFIRMED floor (never the requested
//                                one), the file leg is skipped fail-closed, and the forward event records
//                                the confirmed position — carries `requestedPosition` +
//                                `confirmedPosition` (`degraded`)
//   NO-REWIND (the conversation leg did NOT confirm a rewind — no `run.rolled_back`, the execution
//   epoch is UNCHANGED, and no file leg ran):
//     `pause-only`               conversation-leg failure from a `running` source: the internal pause
//                                applied, the run stays `paused` at its pre-rollback position (`degraded`)
//     `nothing-applied`          conversation-leg failure from every other source: dispatch occurred, no
//                                rewind, nothing applied (`degraded`)
// Root `busy` under another run is NOT a disposition here — it is a pre-dispatch WHOLE-REJECTION
// (`requested → rejected`, Queue And Intervention Model §Driver Result To Lifecycle Mapping), never a result.
type RollbackAppliedResult = // full-effect dispositions — legal ONLY under state: "applied"
  | {
      disposition: "files-restored";
      // Spec-010 §Turn-Boundary Snapshots mandates both enumerations on the restore result
      // ("never silent" — overwritten colliding ignored paths; divergent submodule gitlinks):
      // REQUIRED, empty-when-none — absence is a parse failure, so a consumer can never mistake
      // absence for none (Codex post-merge round, PR #225). These two field names are the
      // Plan-004-owned WIRE contract: T3.13 maps the enumerations Plan-010 T5.2's `restored`
      // variant carries (the callee-side result shape stays Plan-010-owned — cross-plan
      // one-writer) onto these fields, and T4.7's success render surfaces them (exit 0);
      // `conversation-only` ran no file leg and carries neither.
      overwrittenIgnoredPaths: string[]; // ignored untracked paths overwritten by snapshot-tracked collisions on the read-tree leg
      divergentGitlinks: string[]; // submodule paths whose gitlink diverges from the snapshot (absent-working-copy materialization included)
    }
  | { disposition: "conversation-only" };
type RollbackDegradedResult = // partial / zero-effect dispositions — legal ONLY under state: "degraded"
  | {
      disposition: "files-partially-restored";
      failedStep: string;
      // Same Spec-010 §Turn-Boundary Snapshots never-silent mandate as `files-restored` (Codex
      // re-audit round 2): the spec's rationale for this distinct disposition is exactly that a
      // late failure "leaves earlier effects on disk, and hiding that would mask file loss" — so
      // the arm carries the enumerations for EVERY effect applied before the failure — the failing
      // command's partial writes included (PR #230 round 1); only a pre-mutation failure carries
      // both empty. REQUIRED + empty-when-none — the same parse-failure-on-absence as `files-restored`.
      // T3.13 maps them from the callee's partial result and T4.7's degraded render surfaces
      // them (exit code unchanged); the callee-side naming of the enumerations on Plan-010
      // T5.2's `partial_restore` variant is Plan-010's to pin (cross-plan one-writer — the
      // Spec-010 mandate is the normative source either way), and a Plan-004 §Preconditions
      // box + Phase-3 gate hold the consuming dispatch until that amendment lands (Codex
      // re-audit round 4).
      overwrittenIgnoredPaths: string[];
      divergentGitlinks: string[];
    }
  | { disposition: "files-unrestored" }
  | { disposition: "pause-only" }
  | { disposition: "nothing-applied" }
  | { disposition: "position-mismatch"; requestedPosition: number; confirmedPosition: number };
type RollbackInterventionResult = RollbackAppliedResult | RollbackDegradedResult;
// The response is discriminated on `interventionType` (campaign B9, Codex round 2) so the SDK-seam +
// daemon Zod schema parse `result` STRICTLY per type: a `rollback` response validates `result` as
// RollbackInterventionResult and a malformed rollback result FAILS validation — it never falls through a
// permissive generic arm (which would let a malformed rollback outcome cross the boundary). The rollback
// arm is additionally split by lifecycle state (Codex round 3) and state-scoped per disposition class
// (Codex round 5): a TERMINAL rollback outcome REQUIRES the recorded disposition — Spec-004 needs it for
// rendering and the same-position file-leg-recovery carve-out reads the recorded outcome — and `applied`
// admits ONLY RollbackAppliedResult while `degraded` admits ONLY RollbackDegradedResult, so a
// disposition-less terminal response fails parse and so does a state/disposition mismatch (`applied` +
// `files-unrestored` would otherwise exit-map 0 while rendering a failed restore, since the CLI derives
// the POSIX code from `state`). `rejected` REQUIRES `rejectionReason` (round 5 — every refusal family of
// Queue And Intervention Model §Intervention State Transition Table carries its machine-readable cause);
// the non-disposition states (`requested` / `accepted` / `rejected` / `expired`) carry no `result`.
interface InterventionResponseBase {
  interventionId: InterventionId;
  state: InterventionState;
  runVersion: number; // post-application run counter (D-004-1) — the caller threads this into the next intervention's `expectedRunVersion`. Carried on the response because an applied native steer advances the run version WITHOUT a `run.*` state change (Spec-004 §Driver-Level Steer Mechanics), so for that path the response is the only place the caller can read the fresh comparand.
  rejectionReason?: string; // machine-readable cause on a `rejected` OUTCOME that is a normal `run.intervene` response, NOT a JSON-RPC transport error (campaign B9, Codex round 2): the static rollback capability refusal maps `requested → rejected` (Queue And Intervention Model §Driver Result To Lifecycle Mapping — the no-documented-fallback carve-out), so it rides HERE, never the JsonRpcError channel, and the CLI renders WHY (e.g. `driver.capability_unsupported`). A `degraded` cause is the RollbackInterventionResult disposition instead; a request-admission refusal (e.g. `intervention.idempotency_conflict`, 422) is a JsonRpcError that produces no intervention row, so it never rides here. Replay-durable (Codex round 4): the cause persists in the intervention row's own `rejection_reason` column (Plan-004 T1.4 DDL, written at the T3.12 refusal path) — the stored `result` cannot carry it (this contract forbids `result` on `rejected`), so an idempotent replay reconstructs the SAME machine-readable reason from that column, never fabricating one. Round 5: REQUIRED on the rollback `rejected` arm below — every rejected rollback (authorization, boundary-check, root-`busy`, capability — the `Queue And Intervention Model §Intervention State Transition Table` refusal families) carries its cause and T3.12 persists all of them; optional here on the base only for the remaining states and non-rollback types.
}
type InterventionRequestResponse =
  | (InterventionResponseBase & {
      interventionType: "rollback";
      state: "applied"; // full-effect terminal — MANDATORY applied-class disposition (round 5)
      result: RollbackAppliedResult;
    })
  | (InterventionResponseBase & {
      interventionType: "rollback";
      state: "degraded"; // partial / zero-effect terminal — MANDATORY degraded-class disposition (round 5)
      result: RollbackDegradedResult;
    })
  | (InterventionResponseBase & {
      interventionType: "rollback";
      state: "rejected"; // pre-dispatch refusal — the machine-readable cause is MANDATORY (round 5)
      rejectionReason: string;
      result?: never;
    })
  | (InterventionResponseBase & {
      interventionType: "rollback";
      state: "requested" | "accepted" | "expired";
      result?: never; // no disposition exists on these states
    })
  | (InterventionResponseBase & {
      interventionType: "steer" | "interrupt" | "cancel";
      result?: Record<string, unknown>;
    });

// RunStateChange (event, not request/response). The `run.failed` variant carries the
// `providerFailureDetail` surface that mirrors the `failed`-variant `providerFailureDetail` of `DriverResumeResult`
// (§Plan-005 above) — Spec-005:69 requires resume-failure detail to reach the canonical audit
// log so Plan-015's recovery dispatcher and Plan-013's timeline can render the operator-actionable
// reason for the failure without re-querying the driver. Plan-005 CP-005-5; Plan-006 Phase 3 audit.
interface RunStateChangeEvent {
  runId: RunId;
  runVersion: number; // run-progression counter (D-004-1): the optimistic-concurrency comparand clients read via run.subscribeState and pass back as `expectedRunVersion`. Advances on every run progression, applied interventions included. A no-state-change advance with no per-type event of its own (e.g. native steer) is NOT emitted as a discrete run.subscribeState event (no transition to record, `Spec-004 §Driver-Level Steer Mechanics`); the carve-out is the in-place rollback from paused (campaign B2) — it also transitions no state, but its per-type RunRolledBackEvent below rides the same stream carrying the fresh post-rollback runVersion, so subscribers are never blind to a rewind. A non-intervening subscriber may still hold a stale comparand after a steer-like advance until its next guarded request is correctly rejected `expired`, whereupon it re-reads run-state and retries (reject→re-read→retry; V1 adds no broadcast push for such no-per-type-event bumps — Spec-006 §Security Events / Run Lifecycle). Distinct from the immutable EventEnvelope `.version` (Spec-006 §EventEnvelope Version Semantics) — that is the wire-contract semver; this is the run aggregate's concurrency token.
  previousState: RunState;
  currentState: RunState;
  failureCategory?: RunFailureCategory;
  recoveryCondition?: RecoveryCondition; // named type in §Plan-005 above (campaign B3): 'recovery-needed' | 'reauth-required'
  recoverySpanClassification?: RecoverySpanClassification; // span-content sibling of recoveryCondition (Part-B follow-up 2026-07-17)
  healthSignal?: "stuck-suspected";
  providerFailureDetail?: string; // populated on `run.failed` when failureCategory='provider'
  completionKind?: "turn" | "task"; // on `run.completed`: whether the completion closes a conversational turn or the whole task — optional in the shared shape only for pre-B1 history; post-B1 emitters MUST set it (Spec-006 §Run Lifecycle run-state payload, 2026-07-02 B1 amendment)
  intendedClose?: true; // daemon-initiated closeSession clean-terminal discriminator: present only on that path, absent on every other terminal; consumers MUST NOT classify such a terminal as a crash (Spec-006 §Run Lifecycle "Intended-close discriminator", 2026-07-02 B1 amendment)
  executionPosture?: ExecutionPosture; // named type in §Plan-005 above (campaign B3 hoist — same shape, now shared with the CreateSessionParams/StartRunParams spawn/turn carriers). Stamped only on run.running — the post-setup-gate spawn-success transition, where the resolved workspace root and effective posture are final (Plan-004 gate seam; a run.starting stamp would be premature) — recording the run's effective sandbox/permission posture for audit (Spec-006 §Run Lifecycle run-state payload, 2026-07-02 B1 amendment item 11; shape owned by Spec-005 per campaign B3, policy semantics per Spec-012 §Required Behavior, campaign B20). Optionality is for pre-B20 history and non-running rows only: once B20's posture semantics land, run.running emitters MUST stamp the complete posture object — including credentialPolicyRef on both sandboxed modes (absent under mode:'trusted').
  trigger?: "turn_limit" | "budget_exhausted" | "idle_timeout" | "moderation_denied"; // stop-condition provenance (additive per ADR-018): 'turn_limit' rides run.completed at the turn limit (Plan-016 D-016-8 — the value CP-004-10 adds to Plan-004's trigger set); the three InterruptReason values ride run.interrupted on system interrupts (D-016-7). Absent on natural completion and user-initiated paths; the Runs View / timeline stop-condition rendering (Spec-023) reads this field.
  // run.queued linkage (orchestration-created runs only): the OrchestrationRunLinkCarrier fields
  // threaded into the durable payload as optional additive fields (CP-004-10; Plan-016 D-016-3 —
  // run_links is a pure events-canonical projection rebuilt from this event alone). Spec-006 §Run Lifecycle (run.queued row).
  agentId?: AgentId;
  parentRunId?: RunId;
  linkType?: LinkType;
  internalHelper?: boolean;
  producingNodeId?: NodeId;
  // run.queued effective config: the admission-resolved OrchestrationRunConfig (request override
  // else session default) persisted durably so budget/idle enforcement rebuilds replay-stable even
  // if session defaults change mid-run (Plan-016 D-016-5, I-016-14; Spec-006 §Run Lifecycle run.queued row).
  effectiveRunConfig?: OrchestrationRunConfig;
  // ── Path-independent admission stamps (campaign B6) — NOT part of the orchestration linkage
  // block above: run.queued carries these for EVERY provider run, whether admitted via the
  // ordinary run.queueCreate path or orchestration admission (the orchestration path threads
  // its values through the OrchestrationRunLinkCarrier; the ordinary path stamps directly at
  // the queue write — CP-004-10 owns the stamp either way). Never client-suppliable.
  // Native-cap unpriced admissions only (any creation path): the server-stamped admitted family
  // cap — the replay source for reservedCostCents and the worst-case terminal debit; deliberately
  // NOT an OrchestrationRunConfig member, so it can never arrive on
  // OrchestrationRunCreateRequest.config (Spec-016 §Cost Derivation And Absent-Cost Semantics).
  admittedUnpricedCapCents?: number;
  // As-of-admission model family, frozen here for every admitted provider run: orchestration-
  // created runs resolve agentId → agent model → pricing-family key; ordinary runs resolve from
  // the admission-resolved provider model. Derived pricing, family caps, and warnings all key
  // off it; a later agent.configUpdate model change never re-keys an admitted run, and replay
  // reads this field, never the current agents projection. Derived pricing resolves per usage
  // row: a row wire-attributed to another model (e.g. a differently-modeled subagent) keys off
  // that model's family; this field is the fallback when the wire carries no attribution.
  admittedModelFamily?: string;
  timestamp: string;
}

// Forward, NON-STATE rollback event (Spec-006 §Run Lifecycle, its per-type row; campaign B2). The
// structural type is owned here by the rollback intervention contract: `targetPosition` carries the
// accepted `applyIntervention('rollback', {targetPosition})` value on the confirmed path — a confirmed-floor
// mismatch degrade records the driver-confirmed landing position instead (Spec-004 §Required Behavior). Non-terminal — zero
// interaction with the at-most-once terminal backstop — and deliberately NO
// previousState/currentState: a rollback is not a state transition, and fabricating one would
// corrupt the transition stream consumers replay. Rides `run.subscribeState` alongside
// `RunStateChangeEvent` (the RPC table below).
interface RunRolledBackEvent {
  sessionId: SessionId;
  runId: RunId;
  runVersion: number; // the post-rollback progression value — the rollback application advanced it
  channelId?: ChannelId;
  targetPosition: number; // the turn-boundary rewind anchor the run landed at (normalized session position; equals the request's targetPosition on the confirmed path — Spec-004 §Required Behavior)
}

// Provider-initiated mid-run asks (Spec-006 §Driver Ask Events, 2026-07-02 B1 amendment): the third
// `interactive_request` subfamily. `state` is the closed DriverAskState enum and MUST equal the emitting
// event type's suffix (requested / responded / expired / canceled — a mismatch is an emitter bug, fail
// loud). `kind` discriminates permission-approval asks (routed into the approval pipeline) from
// structured-input asks (routed to the run's interactive surface). For kind 'permission', `input` MUST be
// set — the normalized requested resource (command / path / tool arguments) the approval decision is about
// (Spec-006 §Driver Ask Events shape line). `response` appears only on driver_ask.responded rows — the
// delivered answer (permission decision or structured input) — and post-B1 responded emitters MUST set
// it (a responded row with no delivered answer is an emitter bug); the refinement refuses it elsewhere.
// `expiresAt` is the bounded fail-closed deadline stamped at ask creation (Spec-012 §Required Behavior,
// Part-B fail-closed follow-up 2026-07-17): post-amendment driver_ask.requested emitters MUST set it
// (ISO-8601; optionality is pre-amendment history only), later-state rows echo it unchanged, and expiry
// resolves per kind — permission → auto-deny (deny-and-continue), input → park-resumable — never an
// auto-approval (Spec-012 §Resolved Questions and V1 Scope Decisions).
// Variant-required fields are enforced at the EMISSION seam via the exported per-type refinement
// (campaign B13's normalizer bundle: `driverAskPayloadRefinementFor(eventType)`, sibling of Plan-012
// T1.1's `approvalFlowPayloadRefinementFor`): requested ⇒ `expiresAt`; kind 'permission' ⇒ `input` on
// every state; responded ⇒ `response` — refused on the other three; later states echo the requested
// row's `expiresAt` when it carries one (pre-amendment rows have none) — a malformed event fails at the
// emission parse, never at peer/restart projection; base-type optionality admits pre-amendment rows at replay only.
interface DriverAskEvent {
  sessionId: SessionId;
  runId: RunId;
  askId: string;
  kind: "permission" | "input";
  toolName?: string;
  prompt?: string;
  input?: unknown;
  expiresAt?: string;
  state: "requested" | "responded" | "expired" | "canceled";
  response?: unknown;
}

// Run-control mutations (Spec-004 §Required Behavior). `pause` interrupts the active run + persists conversation/run
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

Plan-004's queue / intervention / pause-resume operations are exposed as eight `run.*` methods. The eight concrete strings are ratified (Plan-004 D-004-3 / CP-004-4) and registered here as the canonical wire contract; the reciprocal namespace `provides` is recorded on [Plan-007](../../plans/007-local-ipc-and-daemon-control.md) (the `run.*` method-name owner) in the [cross-plan dependency map](../cross-plan-dependencies.md). Method-name strings are `dotted-camelCase` per the canonical `METHOD_NAME_FORMAT` ratified in §Tier 1 (cont.): Plan-007 above — the `run.*` namespace token is the run-aggregate domain noun, distinct from the `run_lifecycle` **event** taxonomy in [Spec-006 §Run Lifecycle](../../specs/006-session-event-taxonomy-and-audit-log.md#run-lifecycle-run_lifecycle) (the underscore form is a valid event name but is rejected as a method name by `METHOD_NAME_FORMAT`).

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `run.queueList` | `query` | `QueueItemListRequest` | `QueueItemListResponse` |
| `run.queueCreate` | `mutation` | `QueueItemCreateRequest` | `QueueItemCreateResponse` |
| `run.queueCancel` | `mutation` | `QueueItemCancelRequest` | `QueueItemCancelResponse` |
| `run.intervene` | `mutation` | `InterventionRequestPayload` | `InterventionRequestResponse` |
| `run.pause` | `mutation` | `RunPauseRequest` | `RunControlAck` |
| `run.resume` | `mutation` | `RunResumeRequest` | `RunControlAck` |
| `run.subscribeState` | `subscription` | `RunStateSubscribeRequest` | `RunStateChangeEvent \| RunRolledBackEvent` (stream) |
| `run.subscribeQueue` | `subscription` | `RunQueueSubscribeRequest` | `QueueItemSummary` (stream) |

`run.queueList` is the only `query` (idempotent read); the five mutations are state-changing per the tRPC procedure-type convention in §Tier 1 (cont.): Plan-008 above. The two `subscription`s stream their payload type per emission rather than returning a single response — `run.subscribeState` streams `RunStateChangeEvent | RunRolledBackEvent` (the state shape carries the `runVersion` comparand clients pass back as `expectedRunVersion`; the per-type non-state rollback arm — campaign B2, `Spec-006 §Run Lifecycle (run_lifecycle)` — rides the same stream so subscribers observe position rewinds without a fabricated transition), and `run.subscribeQueue` streams the existing `QueueItemSummary` projection (no separate queue-change event type is introduced). All request/response shapes are the interfaces defined directly above; the canonical Zod schemas live in `packages/contracts/src/runControl.ts` (CP-004-3) per the §Source-of-Truth Policy.

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

// Remembered-grant scope — explicit enum, not free-form (Spec-012 line 118).
// `request_only` (Spec-012 line 81) is expressed by OMITTING rememberedScope,
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
// Driver-ask-originated requested rows additionally carry `askId` — its PRESENCE is required at
// the CP-012-6 normalizer seam (T2.8, the sole such emitter): the origin-blind refinement cannot
// know whether a requested payload is driver-ask-originated. What the refinement DOES enforce,
// origin-blind, is the pairing: requested with `askId` present ⇒ `expiryAt` present — the
// emission-boundary mirror of the `approval_requests` ask-implies-deadline CHECK
// (local-sqlite-schema.md §Approval Tables) — so an askId-bearing payload missing its shared
// deadline refuses at the emission parse (I-012-9), never becoming a durable event whose
// projection would fail the CHECK after the fact with replay unable to rebuild the timeout.
interface ApprovalFlowEventPayload {
  sessionId: SessionId;
  runId?: RunId; // absent on trust-triggered rule_revoked (no in-flight request)
  approvalRequestId?: ApprovalRequestId; // ditto
  askId?: string; // present on approval.requested when the request originates from a provider permission ask (Spec-012 §Resolved Questions, Part-B fail-closed follow-up 2026-07-17): the originating DriverAskEvent.askId, persisted at creation as the durable ask↔approval association — restart/replay reconstructs which native ask an outcome or shared-deadline expiry must deny when multiple asks are in flight on one run; required at the CP-012-6 normalizer emission seam (T2.8 — the sole driver-ask-originated requester), never set on direct requests and never client-suppliable (the public ApprovalRequestCreateRequest deliberately carries no askId — trust-boundary note there); persisted on the approval_requests projection row (ask_id — local-sqlite-schema.md §Approval Tables); its presence on a requested payload requires expiryAt alongside it — the refinement-enforced ask-implies-deadline pairing (note above)
  category: ApprovalCategory;
  scope: string;
  requestedBy?: string; // present on approval.requested — recorded requester actor (participant or agent actor id, Spec-012 line 58)
  resourceDescriptor?: Record<string, unknown>; // present on approval.requested — audit-grade target (Spec-012 line 96)
  expiryAt?: string; // present on approval.requested when the request carries an expiry (D-012-14); required whenever askId is present — the refinement refuses an askId-bearing requested payload without its shared deadline (ask-implies-deadline pairing, note above)
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
// Trust boundary (Spec-012 §Resolved Questions, Part-B fail-closed follow-up 2026-07-17): this
// public T3.1 binder shape deliberately carries NO `askId`. The ask↔approval association is
// never client-suppliable — a caller-forged askId could route another ask's outcome or
// shared-deadline expiry to the wrong native provider ask. The CP-012-6 driver-ask normalizer
// (T2.8) supplies the originating askId and the shared deadline (expiryAt = the ask's expiresAt)
// daemon-internally at the approval-service seam, below this binder; the request schema is
// strict, so a smuggled askId field is refused at parse rather than silently dropped.
interface ApprovalRequestCreateRequest {
  runId: RunId;
  category: ApprovalCategory;
  scope: string;
  resourceDescriptor: Record<string, unknown>; // REQUIRED (Spec-012 line 96); audit-grade target descriptor
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
  approver?: ParticipantId; // informational/routing (Spec-012 line 97; D-012-12). Absent on the
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
  // artifact (Spec-012 lines 47/62/85); remembered_rule = matched an unrevoked rule that passed
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
    resourceDescriptor: Record<string, unknown>; // requested resource (Spec-012 line 96)
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
  includeRevoked?: boolean; // default false; true = audit-history view (Spec-012 line 106)
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

// RememberedRuleRevoke — the explicit revocation path (Spec-012 line 106);
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

Plan-011's gitflow PR-preparation and diff-attribution surface is exposed as four `gitflow.*` methods, ratified by the Tier-7 plan-readiness audit (Plan-011 D-011-5; Codex round-19 finding KuB_5). Method-name strings are `dotted-camelCase` per the canonical `METHOD_NAME_FORMAT` ratified in §Tier 1 (cont.): Plan-007 above — the `gitflow` namespace token is the gitflow domain noun (the Plan-011-owned `runtime-daemon/src/gitflow/` daemon module, D-011-3; consumed client-side by the `gitflowClient` SDK, `Plan-011 §Target Areas`). The PascalCase request/response type symbols (`PRPrepare`, `GitActionExecute`, …) are **rejected** as method strings by that regex — it reserves PascalCase for the project's TypeScript type-name convention — so each wire name differs from its payload type symbol. Names register under the Plan-007-partial daemon `MethodRegistry` per the §5 substrate-vs-namespace carve-out; registration's [BL-142](../../archive/backlog-archive.md) precondition (registry-regex conformance to the Tier-1 `METHOD_NAME_FORMAT`) is resolved (2026-06-21). These methods ride the **daemon JSON-RPC transport only** — branch contexts, diff artifacts, and PR preparations are node-local SQLite + local-git state (`branch_contexts` / `diff_artifacts` / `pr_preparations`, local-sqlite-schema.md), so no control-plane tRPC sibling exists.

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
//     §Interfaces And Contracts) plus the daemon-persisted `visibility`/`state`/`metadata` fields (not in the spec envelope).
//     Defined once here (the `ArtifactManifest` shape Plan-014 Task 1 mints in
//     packages/contracts/src/artifacts/); ArtifactPublish returns it (Spec-014 §Interfaces And Contracts),
//     ArtifactRead returns it plus a payload handle/inline (same spec section). 1:1 with the
//     `artifact_manifests` row's wire-shareable fields — each a dedicated column (D-014-2; the daemon-secret `relay_cek_ciphertext` column never rides the wire), incl. `annotations`
//     as a first-class OCI string→string map, never folded into freeform `metadata`. Plan-011's
//     DiffArtifact (artifactType: "diff") rides this envelope per CP-014-1 / CP-011-2. ---

// artifactType discriminator (Spec-014 §Interfaces And Contracts) — the five Spec-014 §Required Behavior families (file, diff, summary,
// log, design) plus workflow_output, the Spec-017 §Output Mode Specification (Tier-8) workflow phase-output type. Spec-014 §Required Behavior
// admits "at least" the five families, so the sixth value is additive, not a families-list rewrite (D-014-4).
type ArtifactType = "file" | "diff" | "summary" | "log" | "design" | "workflow_output";

interface ArtifactManifest {
  id: ArtifactId;
  sessionId: SessionId;
  runId?: RunId;
  artifactType: ArtifactType; // discriminator — Spec-014 §Interfaces And Contracts (D-014-4: file|diff|summary|log|design|workflow_output)
  digest: string; // OCI `digest` (SHA-256) = SQLite content_hash — required: a content-addressed manifest always has one (I-014-1)
  size: number; // OCI manifest-descriptor `size` (payload byte length) = SQLite size_bytes — server-derived, always present
  annotations: Record<string, string>; // OCI `annotations` string-map = SQLite annotations (NOT NULL DEFAULT '{}') — distinct from freeform `metadata`
  subject?: ArtifactId; // OCI `subject`: present only on a derivative (redacted/summarized) manifest → source manifest (I-014-2, Spec-014 §State And Data Implications)
  visibility: ArtifactVisibility;
  state: ArtifactState;
  replicationStatus?: "pending_replication" | "pinned" | "over_cap" | "quota_exceeded" | "expired"; // = SQLite `replication_status` (A-014-3; value set spec-named by the 2026-07-08 relay amendment — Spec-014 §Fallback Behavior grants the `pending_replication` fallback; the full set is spec-named in [Spec-014 §Wire-format additivity](../../specs/014-artifacts-files-and-attachments.md#wire-format-additivity) and mirrors the at-rest CHECK column). Absent = local-only artifact.
  metadata: Record<string, unknown>; // freeform daemon-side provenance/media-type — distinct from the OCI `annotations` map above
  createdAt: string;
}

// ArtifactPublish — Spec-014 §Interfaces And Contracts: "must return artifact id and manifest metadata."
interface ArtifactPublishRequest {
  sessionId: SessionId;
  runId?: RunId;
  artifactType: ArtifactType; // discriminator — see ArtifactManifest.artifactType (Spec-014 §Interfaces And Contracts; D-014-4)
  visibility: ArtifactVisibility;
  payload: Uint8Array | string;
  mediaType: string; // MIME type
  // --- producer-supplied OCI envelope inputs (D-014-3). `size`/`digest` are NOT here:
  //     the daemon derives size_bytes + content_hash from `payload`. ---
  subject?: ArtifactId; // OCI `subject`: set when publishing a derivative (redacted/summarized) form → points to the source manifest (I-014-2, Spec-014 §State And Data Implications); omit for originals
  annotations?: Record<string, string>; // OCI `annotations` string-map persisted to artifact_manifests.annotations; distinct from freeform `metadata`
  metadata?: Record<string, unknown>;
}
interface ArtifactPublishResponse {
  manifest: ArtifactManifest; // embedded manifest metadata (Spec-014 §Interfaces And Contracts); manifest.id is the artifact id, manifest.digest the content hash — no resolvable-URL indirection (D-014-3)
}

// ArtifactRead — Spec-014 §Interfaces And Contracts: "must return manifest plus retrievable payload handle or inline content."
interface ArtifactReadRequest {
  artifactId: ArtifactId;
  includePayload?: boolean; // default false, returns handle only
}
interface ArtifactReadResponse {
  manifest: ArtifactManifest; // the same envelope ArtifactPublish embeds (Spec-014 §Interfaces And Contracts)
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

// --- Cross-node artifact relay methods (2026-07-08 ADR-015 amendment): the
//     ArtifactUploadInit / ArtifactUploadChunk / ArtifactUploadComplete /
//     ArtifactFetchAuthorize / ArtifactFetchComplete request/response schemas land with Plan-014
//     Tasks 7-10 after that plan's readiness-audit delta. Spec-014 §Interfaces names the methods;
//     Spec-014 §Cross-Node Artifact Relay (V1) is the normative design — ArtifactUploadInit carries the relay-visible lifecycle envelope (digest, size, chunk accounting, retentionTier, wrapped-CEK recipient entries) as authenticated plaintext; ArtifactFetchAuthorizeResponse returns the calling node's relay-held wrapped CEK (thumbprint-selected; CEKs wrap to durable per-(participant, node) artifact-encryption keys, never session-ephemeral keys), ArtifactFetchComplete is the authenticated post-verification ack that alone writes delivered_at (never inferred from a chunk GET); the artifact.published event carries the signed cekCommitment, never wrapped CEKs (Spec-014 Publish steps 1/3/4, Fetch step 6).
//     Deliberately not typed here yet — no invented shapes. ---
```

> **Tier-7 audit (NS-19) — ratified design (Plan-014 → `approved`).** The ArtifactPublish/ArtifactRead pair now composes a single named `ArtifactManifest` envelope (`Spec-014 §Interfaces And Contracts`) instead of inlining and duplicating the fields — this is the `ArtifactManifest` shape Plan-014 Task 1 mints, and the envelope Plan-011's `DiffArtifact` (`artifactType: "diff"`) rides per CP-014-1 / CP-011-2 (Plan-011 consumes the envelope **concept**, unchanged, not a flat field layout). `ArtifactPublishResponse` embeds `manifest: ArtifactManifest` per `Spec-014 §Interfaces And Contracts` ("must return artifact id **and manifest metadata**") — this **replaces the prior `manifestUrl` pointer**, which was drift from that "must" clause: the `ArtifactRead` clause grants handle/inline latitude to the **payload** on _Read_ only, never to the manifest, so both responses return the manifest metadata inline (D-014-3 — resolved by aligning the wire to the spec, not an owner decision). `ArtifactReadResponse` is `manifest` + `payloadHandle?`/`payload?` (`Spec-014 §Interfaces And Contracts`). The wire envelope mirrors the `artifact_manifests` row in [Local SQLite Schema](../schemas/local-sqlite-schema.md) 1:1: `digest`/`size` are **required** on the wire because a content-addressed manifest always carries both (I-014-1), and the at-rest `content_hash`/`size_bytes` columns are correspondingly **`NOT NULL`** — each producer (AttachmentIngest, ArtifactPublish) computes the SHA-256 + byte length from its own payload and inserts its manifest with both columns set in the same transaction as the payload-ref, and AttachmentIngest and ArtifactPublish are independent producers (the `artifactId` `AttachmentIngestResponse` returns resolves from the ingest-written manifest, not a later publish), so there is no payload-less manifest to reconcile (D-014-1). `annotations` is a dedicated OCI string→string column (D-014-2; at-rest `NOT NULL DEFAULT '{}'`), required on the wire, never folded into freeform `metadata`. The at-rest `replication_status` column (nullable) surfaces as the optional `replicationStatus?` wire field (A-014-3 — V1 writes `pending_replication` while a shared artifact awaits deferred payload transfer; open set, no closed union, mirroring the at-rest no-CHECK stance). _(2026-07-08: the deferred refinement arrived — the [Spec-014 §Cross-Node Artifact Relay (V1)](../../specs/014-artifacts-files-and-attachments.md#cross-node-artifact-relay-v1) amendment spec-names `pending_replication | pinned | over_cap | quota_exceeded | expired`, the at-rest column now carries the matching CHECK, and the wire field is the closed union above — the open-set stance in this dated record is superseded; the field stays optional.)_ Producer inputs are closed too (D-014-3): `ArtifactPublishRequest` accepts `subject?` (so a Task-4 I-014-2 derivative names its source at publish) and `annotations?`, while `size`/`digest` stay server-derived from `payload` — otherwise the `annotations` column and derivative `subject` would be write-dead. This wire edit + the `local-sqlite-schema.md` artifact edit + Plan-014 CP-014-1 / Task 3 form one whole-or-not bundle.

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
    recoveryCondition?: RecoveryCondition; // named type in §Plan-005 (campaign B3)
    recoverySpanClassification?: RecoverySpanClassification; // span-content sibling of recoveryCondition (Part-B follow-up 2026-07-17)
    // Per-run identities behind a blocked/degraded session entry (campaign B14): names which
    // runs need reconciliation in a multi-run session — a Plan-015 T15.5 divergence halt or a
    // failed resume each land one entry. Optional and additive: absent when no run-level
    // recovery condition exists. Entry contract (round 5): a divergence-halt entry is
    // SELF-SUFFICIENT — recoverySpanClassification REQUIRED (the daemon always derives one; the
    // audit-metadata recording is the T15.5 deliverable), failureCategory absent (the run did
    // not fail), and there is no failure to drill into; a failed-resume entry carries
    // failureCategory REQUIRED plus the driver-provided classification (REQUIRED on
    // DriverResumeResult.failed) and drills into the run-scoped FailureDetailRead by runId.
    haltedRuns?: Array<{
      runId: RunId;
      recoveryCondition: RecoveryCondition;
      recoverySpanClassification?: RecoverySpanClassification; // REQUIRED on a divergence-halt entry (daemon-derived); driver-provided on a failed-resume entry
      failureCategory?: RunFailureCategory; // REQUIRED on a failed-resume entry; absent on a divergence halt
    }>;
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
  entries: TimelineRow[];
  nextCursor?: EventCursor;
  hasMore: boolean;
}

interface TimelineRowBase {
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

type TimelineEntry = TimelineRowBase & { kind: "general" }; // the non-run arm (Codex round 4 on PR #232): carries no run attribution structurally — the projector stamps kind from the event family, so a run-scoped family can never arrive on this arm

type RunScopedTimelineEntry = TimelineRowBase & {
  kind: "run"; // literal discriminator — row.kind narrowing is structural, never a probe of the free-form type: string
  runId: RunId; // run identity — with position + epoch, the REQUIRED all-or-none attribution triple the run.rolled_back live client rule keys on, never dug out of payload (CP-004-13, Codex rounds 2-3 on PR #232): arm selection is by kind, so a run-scoped row missing any of the three fails ITS Zod arm — the malformed-row test — and can never fall through to the general arm
  position: number; // the row's projection-resolved originating run position (Plan-004 T3.14's uniform row-to-turn assignment); the live rule compares it against the run.rolled_back boundary's carried targetPosition (sequence is the session event sequence, never a run position)
  epoch: number; // the row's projection-resolved execution epoch (T3.14's row attribution: the stamped sourceEpoch on late rows, the operation association's epoch on in-time content-asynchronous rows, the run's current epoch at emission otherwise — Codex round 2, PR #232); position alone can never recover the epoch, since re-execution reuses ordinals
  superseded?: { targetPosition: number }; // present exactly when the row's turn is superseded, absence = current (campaign B9 CP-004-13, 2026-07-20) — projection-computed from Plan-004 T3.14's exported supersededTurns(runId); deliberately single-field (Codex round 4, PR #232): the marker's run identity and source epoch ARE the containing row's runId + epoch, so no duplicated fields exist to disagree and live marking (the row plus the boundary cutoff) is identical to replay marking by construction; targetPosition = the superseding rollback's rewind cutoff — the first accepted rollback in the run's lineage, at the row's epoch or later, that rewound the surviving history containing the row (a later rollback below an earlier retained prefix supersedes the inherited rows; a row ranks superseded when position exceeds the run's effective cutoff for its epoch — the minimum cutoff among accepted rollbacks at epoch >= the row's); identical on TimelineRead and TimelineSubscribe replay, rows delivered after a boundary arriving with the marker already projection-computed — per Spec-013 §Required Behavior
};

type LegacyStubTimelineEntry = TimelineRowBase & {
  kind: "legacy_stub"; // a run-scoped audit stub compacted in the vacuous-attribution era (Codex round 5, PR #232): runId is preserved — every run-scoped stub preserves it (Spec-006 §Compacted Event Format) — but position and epoch are structurally ABSENT because they are unknowable (Plan-006 T3.2/T3.5's vacuous-default era; Plan-004's span check treats such a stub as the standing-refusal class, so its run can never admit a rollback while it exists). The row renders as the compaction placeholder alone and is exempt from the marking rule by construction — it can never be ranked, never carries superseded, and the projector stamps this kind only for vacuous-era stub rows (a live run row missing attribution fails the run arm, never lands here)
  runId: RunId;
};

type TimelineRollbackBoundary = TimelineRowBase & {
  kind: "rollback_boundary"; // literal discriminator
  runId: RunId; // the rewound run
  position: number; // the boundary row's own originating position
  epoch: number; // the epoch the rollback rewound
  superseded?: { targetPosition: number }; // an earlier boundary row is itself superseded when a later rollback cuts below it — same single-field marker semantics as the run arm
  type: "run.rolled_back";
  payload: RunRolledBackEvent; // validated into the typed shape (defined at §Tier 5 run.* above) at projection, so the live client rule reads a typed targetPosition — never an unsafe cast; an entry failing that validation is a projection defect surfaced at emission, never delivered untyped (Codex round 2, PR #232). Delivery is visibility-resolved, never keyed on the event's optional channelId: the boundary fans out to every filtered subscription whose filter admits any row of the affected run (Codex round 4, PR #232), so a channel-filtered subscriber holding that run's rows always receives the cutoff. Outer attribution and payload cannot disagree (Codex round 5, PR #232): the boundary arm's schema refines runId === payload.runId, sessionId === payload.sessionId, and position === payload.targetPosition (the boundary row ranks at the confirmed rewind floor — which is why a later rollback below it supersedes it), so a conflicting boundary fails parse as a projection defect, never delivered
};

type TimelineRow =
  | TimelineRollbackBoundary
  | RunScopedTimelineEntry
  | LegacyStubTimelineEntry
  | TimelineEntry; // the row union every timeline surface returns — TimelineReadResponse.entries, the TimelineSubscribe SSE stream, and ChildRunExpandResponse.entries are all TimelineRow — genuinely discriminated on the literal kind (Codex rounds 3-5, PR #232): the contracts Zod discriminatedUnion selects the arm by kind (rollback_boundary | run | legacy_stub | general), each arm validates strictly, and consumers narrow structurally on row.kind — never probing type: string, never casting

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
  channelId?: ChannelId; // filter to a channel's rows — filtering never suppresses a run.rolled_back boundary for a run whose rows the filter admits (visibility-resolved fan-out; Codex round 4, PR #232)
}
// Response: SSE stream of TimelineRow (the discriminated union above)

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
  entries: TimelineRow[];
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
  recoveryCondition?: RecoveryCondition; // named type in §Plan-005 (campaign B3)
  recoverySpanClassification?: RecoverySpanClassification; // span-content sibling of recoveryCondition (Part-B follow-up 2026-07-17)
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
      state: "active" | "paused"; // round-robin arbitration pause (Spec-016:186-188) — daemon projection from arbitration.* events
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
  parentRunId?: RunId; // present = child run; child-of-child refused (depth 1, Spec-016:223)
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
  // owner-supplied unpriced-family escapes — native-cap provider legs only
  // (Spec-016 §Cost Derivation And Absent-Cost Semantics, campaign B6); empty by default
  unpricedFamilyCaps: { modelFamily: string; hardCapUsdCents: number }[]; // one entry per modelFamily — duplicate families rejected at validation
  observedCostCents: number; // BudgetAccountant projection (in-memory, replay-rebuilt from TWO folds: persisted usage.cost_update.costCents — derivation emit-once, never re-run against the current table, so an update re-prices nothing retroactively — PLUS worst-case debits of terminal native-cap runs from run.queued.admittedUnpricedCapCents, whose cost rows are costless by design; folding rows alone would resurrect their headroom) (Spec-016, campaign B6)
  // Σ snapshot-at-admission reservations over ACTIVE native-cap-escape runs — admission
  // predicate: observed + reserved + newCap ≤ costLimitCents. At each such run's terminal the
  // reservation converts to a worst-case debit in observedCostCents (never back to headroom).
  // Each run's admitted cap is frozen in the server-stamped run.queued.admittedUnpricedCapCents —
  // the path-independent durable field on EVERY provider run (ordinary run.queueCreate admissions
  // stamp it directly; the OrchestrationRunLinkCarrier only threads it for orchestration-created
  // runs): unpricedFamilyCaps updates apply to future admissions only; restart/replay rebuilds
  // reservations + debits from run.queued records alone — native-cap ordinary runs included
  // (Spec-016 §Cost Derivation And Absent-Cost Semantics, campaign B6)
  reservedCostCents: number;
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
  // replace-set semantics; hardCapUsdCents a positive integer — the named
  // fail-closed escape for unpriced families on native-cap legs (Spec-016, campaign B6)
  unpricedFamilyCaps?: { modelFamily: string; hardCapUsdCents: number }[]; // replace-set keyed by modelFamily: one entry per family, duplicates rejected at validation
}
type OrchestrationBudgetUpdateResponse = OrchestrationBudgetState;

interface SessionGoal {
  text: string; // 1–4096 chars, non-blank, NUL-rejected (standard bounded free-form guards — persisted to the event log and injected into provider prompts); the Spec-016 §Session Goals structured shape; extending it requires a spec revision (campaign B6)
}
interface SessionGoalUpdateRequest {
  sessionId: SessionId;
  goal: SessionGoal;
}
type SessionGoalUpdateResponse = { sessionId: SessionId; goal: SessionGoal };
interface SessionGoalClearRequest {
  sessionId: SessionId;
}
type SessionGoalClearResponse = { sessionId: SessionId };

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
// (Spec-006 §Run Lifecycle run.queued row — additive optional fields). The wire run.queueCreate handler
// never populates it — child-run creation goes through orchestration.runCreate only.
interface OrchestrationRunLinkCarrier {
  parentRunId?: RunId;
  linkType: LinkType;
  internalHelper: boolean;
  agentId: AgentId; // name mirrors the run.queued additive payload field verbatim (CP-004-10); the service maps the validated wire targetAgentId here after agent resolution
  producingNodeId: NodeId;
  effectiveRunConfig: OrchestrationRunConfig; // admission-resolved post-merge values (request override else session default), persisted on run.queued so budget/idle enforcement rebuilds replay-stable (D-016-5, I-016-14)
  // native-cap-escape snapshot — SERVER-STAMPED at admission, deliberately NOT an
  // OrchestrationRunConfig member so it can never arrive on OrchestrationRunCreateRequest.config
  // (client-injection hazard); frozen per run, immune to later unpricedFamilyCaps updates;
  // replay rebuilds reservations + terminal debits from run.queued records alone; absent on
  // priced runs (Spec-016 §Cost Derivation And Absent-Cost Semantics, campaign B6).
  // The carrier only THREADS this for orchestration-created runs — the durable run.queued
  // fields are path-independent (ordinary run.queueCreate admissions stamp them directly at
  // the queue write; CP-004-10).
  admittedUnpricedCapCents?: number;
  // As-of-admission model family (campaign B6): resolved agentId → agent model →
  // pricing-family key at admission. Threading copy for the orchestration path; the durable,
  // path-independent home is run.queued.admittedModelFamily (stamped for every provider run).
  admittedModelFamily?: string;
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
| `session.goalUpdate` | RPC | `SessionGoalUpdateRequest` → `SessionGoalUpdateResponse` | Owner/collaborator — viewers + runtime contributors read-only, per the Security Architecture role matrix ([Spec-016 §Session Goals](../../specs/016-multi-agent-channels-and-orchestration.md#session-goals), campaign B6); an accepted update emits `session.goal_updated` carrying the same canonical `goal` |
| `session.goalClear` | RPC | `SessionGoalClearRequest` → `SessionGoalClearResponse` | Owner/collaborator; an accepted clear emits `session.goal_cleared` (clearing is the distinct operation — an update without a goal is malformed) |
| `agent.attach` | RPC | `AgentAttachRequest` → `AgentAttachResponse` | Emits `agent.attached` |
| `agent.detach` | RPC | `AgentDetachRequest` → `AgentDetachResponse` | Emits `agent.detached` |
| `agent.configUpdate` | RPC | `AgentConfigUpdateRequest` → `AgentConfigUpdateResponse` | Emits `agent.config_updated` |
| `agent.list` | RPC | `AgentListRequest` → `AgentListResponse` | agents-table projection |

Error vocabulary: [error-contracts.md](./error-contracts.md) §Channel / §Orchestration / §Agent (D-016-16) plus the §Session `session.goal_delivery_failed` (502) and `session.goal_mutation_in_flight` (409) mappings for the live goal-delivery RPCs (campaign B6). Durable events owned by Plan-016 (Spec-006 registrations): `channel.created` / `channel.muted` / `channel.unmuted` / `channel.archived`, `agent.attached` / `agent.detached` / `agent.config_updated`, `arbitration.paused` / `arbitration.resumed`, `orchestration.rejected`, `usage.budget_warning`, `moderation.review_flagged`, `session.goal_updated` / `session.goal_cleared` (campaign B6 — emitted by the goal RPCs above) — see [Spec-006 §Event Type Registry](../../specs/006-session-event-taxonomy-and-audit-log.md).

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

WS overflow is drop-frame (Plan-021 D-021-9): a counter trip refuses the offending frame with ONE in-band error frame and keeps the connection; close code `4029` (private range) fires only for active escalation blocks; an active admin ban closes with `4003` (the 403-class `ratelimit.banned` analog — `Spec-021 §WebSocket Overflow Response`), enforced in observe mode too.

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

In V1 every call resolves to the unconditional `-32603` / `data.type = "gdpr.endpoint_not_v1"` stub (I-022-15) regardless of the procedure type **or request body** shown — the procedure types are the reserved-V1.1 semantics that the real handlers will honor. To keep that response unconditional, the three methods register against a **permissive params schema** (`z.unknown()`) in V1, **not** the strict Request schemas tabled above: Plan-007's `MethodRegistry.dispatch` Zod-parses the registered params schema before the handler body runs and maps a failure to `-32602 Invalid Params` ([Plan-007 §I-007-7 — Schema validation runs before handler dispatch](../../plans/007-local-ipc-and-daemon-control.md#i-007-7--schema-validation-runs-before-handler-dispatch)), so binding a strict schema would pre-empt the unconditional `-32603` with a `-32602` on any malformed body — breaking I-022-15. The strict Request schemas become the registered params schemas only when the real V1.1 handlers ship (Plan-022 D-022-3 (c)). Canonical schemas live in `packages/contracts/` per the §Source-of-Truth Policy.

## Plan-028 — MCP Governance Contract Surfaces

Registered 2026-07-22 (campaign B18; [Spec-028](../../specs/028-mcp-server-configuration-and-governance.md)). The eleven `mcp.*` operations register against the Plan-007 `MethodRegistry` at Plan-028's tier (the CP-007-3 late-namespace pattern; `mcp.subscribe` rides the Plan-007 streaming primitive, the `session.subscribe` consumer shape); the five event payloads mirror [Spec-006 §MCP Governance (`mcp_governance`)](../../specs/006-session-event-taxonomy-and-audit-log.md#mcp-governance-mcp_governance) (registered into contracts by Plan-006 T1.10; payloads authored by Plan-028 — the emitter-authors-payload precedent); the status read model consumes the Plan-005 `McpServerStatusUpdate` seam (§Tier 4 above). Authorization: every mutating operation evaluates the Cedar `mcp` action family through Plan-012's `PermissionCheckService` before any provider call or store write; the V1 principal is the node-local operator (caller-owns-the-node) — no `ApprovalCategory` value is added. Idempotency: every governance mutation — and the receipted operational command `mcp.oauthLogin` — carries the mandatory requester-generated UUID `clientIdempotencyKey` (the Spec-005/B3 discipline; the intervention-surface precedent) with durable receipt replay per Spec-028 §Authorization (`mcp.reconnect` is unreceipted). Error codes: [error-contracts.md §MCP Governance](./error-contracts.md#mcp-governance). Sanitization: no payload below carries config values, env-var values, header values, tokens, or unsanitized paths (Spec-028's no-custody invariant) — raw `scopeRef` filesystem paths included: durable event payloads identify project/local bindings by the keyed `scopeRefDigest` of the audit ref (`McpServerBindingAuditRef` below), never the path itself; `serverName` / `toolName` are untrusted provider-adjacent strings, `wireFreeFormString`-bounded under the twelve-string rule, classified as non-PII infrastructure identifiers for the plaintext audit payload per Spec-028 §Status Observation and Events — the deliberate, documented residual Plan-022's call-site PII classification pass inherits. Identity throughout is the scope-qualified binding `(provider, scope, scopeRef, serverName)` per Spec-028 §Unified Inventory — a **discriminated union on `scope`**, so an invalid shape (`scopeRef` on `user`, a missing `scopeRef` on `project`/`local`, or the non-existent `(codex, local)` combination) is a schema-level rejection, never a service-layer surprise or a collapsed primary key. Two grains share this section deliberately: the config **binding** above and the Plan-005 **runtime-binding leg** (`sessionId` + `bindingId`) — live per-session state (status legs, live mutation results, reconnect targets) always keys by leg, never by collapsing legs into the binding scalar.

```ts
// ---- Primitives (Spec-028) ----
type McpProvider = "claude" | "codex";
type McpConfigScope = "user" | "project" | "local"; // scope axis of the binding identity: user = provider-config-writable (both providers); project/local = observed read-only in V1 — but scope-applicability is PER OPERATION (see the operations block: trust/daemon-enforced overrides/OAuth/reconnect work on run-effective non-user bindings). local is Claude-only (project-keyed private scope)
type McpApplicationGrade = "live_reconcile" | "user_config_write" | "next_run" | "daemon_enforced"; // when/where a mutation takes effect — honest, typed, never silent (parity-triad degrade-honestly): live session set / provider config store (subsequent runs) / next-run composed config / daemon decision layer (immediate)
type McpApprovalMode = "auto" | "prompt" | "writes" | "approve"; // Codex-native vocabulary adopted as the normalized set; Claude-side enforcement is daemon-owned (Spec-028 §Tool-Level Overrides)
type McpTrustReason = "operator_grant" | "operator_revoke" | "config_drift";
type McpConfigChangeKind = "added" | "updated" | "removed" | "enabled" | "disabled";

// The scope-qualified server binding (Spec-028 §Unified Inventory): identity is
// (provider, scope, scopeRef, serverName) — never merged across providers OR scopes. Same-named
// servers in two scopes are distinct configurations with independent status, trust, and overrides;
// collapsing them would trust-ping-pong on drift and bleed overrides across configurations.
// Structural validity is schema-level (a Zod discriminated union on `scope` + a provider refinement),
// not service-layer: `user` FORBIDS scopeRef (persisted as '' in the daemon tables), `project`/`local`
// REQUIRE a canonical non-empty scopeRef (project root / keying directory), and `local` is admissible
// only with provider "claude" — so unrelated projects can never collapse onto one empty-string PK
// component and the non-existent (codex, local) combination never reaches a table. Payload/read-model
// types compose this union via intersection (never `interface extends` — unions don't extend).
type McpServerBindingRef =
  | { provider: McpProvider; scope: "user"; serverName: string }
  | { provider: McpProvider; scope: "project"; scopeRef: string; serverName: string }
  | { provider: "claude"; scope: "local"; scopeRef: string; serverName: string };

// Event-side binding identity (Spec-028 §Status Observation and Events): the same discriminated
// union with the filesystem path replaced by its keyed digest. scopeRef (canonical project root /
// keying directory) is a user-specific filesystem path — a Spec-022 durable-tier PII class — and
// event payloads are hash-chained, signed, and replayable, so the raw path never enters them:
// project/local variants carry scopeRefDigest — "b3:"-prefixed keyed BLAKE3 (key = the binding's
// scope-ref subkey, derived from the daemon-held node-local master key: computable before any
// event fires and without any database row) over the canonical scopeRef — non-brute-forceable
// like every served digest (the key never enters SQLite), stable for the binding's life, and
// joinable to inventory entries (which serve the same digest).
// Requests and inventory reads keep the full McpServerBindingRef (transient wire / operator read,
// not durable audit rows); only the local trust store resolves a digest back to its path.
type McpServerBindingAuditRef =
  | { provider: McpProvider; scope: "user"; serverName: string }
  | { provider: McpProvider; scope: "project"; scopeRefDigest: string; serverName: string }
  | { provider: "claude"; scope: "local"; scopeRefDigest: string; serverName: string };

// mcp.upsertServer config input — the normalized governed surface, discriminated on transport.
// Env-var and header VALUES are write-only credential-adjacent material: accepted here, passed only
// to the sanctioned provider write path, NEVER round-tripped in inventory reads or event payloads
// (names may appear; values never do). Provider-conditional validation is schema-enforced (Zod
// refinements), not prose: a field marked Codex-only rejects for provider "claude" and vice versa,
// so the canonical request schema and SDK signature derive from this union without divergence.
// PRESERVATION RULE (Spec-028 §Configuration Mutation): upserts are read-modify-write over the
// provider's own declaration — provider fields this union does not model (or the request does not
// carry) are preserved, never erased. Codex writes are field-granular config/value paths; the
// regenerated Claude declaration starts from the observed current one.
type McpServerConfigInput =
  | {
      transport: "stdio";
      command: string; // executable; non-empty, NUL-rejected
      args?: string[];
      env?: Record<string, string>; // write-only values (see above)
      enabled?: boolean; // Codex: native `enabled` field; Claude: maps to the daemon enabled overlay
      required?: boolean; // Codex-only — thread start/resume fails if the server cannot initialize
      startupTimeoutSec?: number; // Codex-only native timeout
      toolTimeoutSec?: number; // Codex-only native timeout
    }
  | {
      transport: "http" | "sse"; // "sse" is Claude-only (Claude-native transport kind)
      url: string; // absolute http(s) URL; userinfo (embedded credentials) rejected. Query-string VALUES are write-only credential-equivalent material (a ?api_key=… credential passes no-userinfo validation): accepted, hashed, passed to the provider write path — never round-tripped (the view serves query param NAMES)
      headers?: Record<string, string>; // write-only values (see above)
      bearerTokenEnvVar?: string; // Codex-only `bearer_token_env_var` — the env-var NAME, never the value
      envHttpHeaders?: Record<string, string>; // Codex-only `env_http_headers` — header NAME → env-var NAME (both references, no values; resolved provider-side at connect time)
      oauthScopes?: string[]; // Codex-only `scopes` — OAuth scopes requested for the server's auth flow
      oauthResource?: string; // Codex-only `oauth_resource` — the RFC 8707 resource indicator for the flow
      enabled?: boolean;
      required?: boolean; // Codex-only (as above)
      startupTimeoutSec?: number; // Codex-only (as above)
      toolTimeoutSec?: number; // Codex-only (as above)
    };

// Redacted normalized config view (Spec-028 §Unified Inventory): the read-back of what
// mcp.upsertServer wrote — every non-secret field preserved, secret VALUES structurally absent
// (env/header/query-param NAMES only), so mcp.get supports read/edit workflows without the daemon
// ever serving credential material. command/args are operator-authored process-visible strings —
// the same documented residual class as serverName/toolName in the preamble; the URL is NOT in that
// class (an http URL is not a process argument): it serves query-redacted below.
type McpServerConfigView =
  | {
      transport: "stdio";
      command: string;
      args?: string[];
      envVarNames?: string[]; // the env map's KEYS; values never round-trip
      enabled?: boolean;
      required?: boolean; // Codex-only, as on input
      startupTimeoutSec?: number;
      toolTimeoutSec?: number;
    }
  | {
      transport: "http" | "sse";
      url: string; // QUERY-REDACTED: scheme + host + path only (userinfo already rejected at input; query values are credential-equivalent and never round-trip — the full URL feeds only the base-config hash, so query-credential drift is still detected)
      urlQueryParamNames?: string[]; // the query string's parameter NAMES when one existed; values never round-trip (the env/header names-not-values discipline)
      headerNames?: string[]; // the header map's KEYS; values never round-trip
      bearerTokenEnvVar?: string; // an env-var NAME (Codex-only), safe to serve
      envHttpHeaders?: Record<string, string>; // Codex-only — header NAME → env-var NAME: a name→name reference map, round-trips verbatim
      oauthScopes?: string[]; // Codex-only — non-secret auth references, round-trip verbatim
      oauthResource?: string; // Codex-only — non-secret auth reference, round-trips verbatim
      enabled?: boolean;
      required?: boolean;
      startupTimeoutSec?: number;
      toolTimeoutSec?: number;
    };

// Per-leg live status (Spec-028 §Unified Inventory): one config binding can back several concurrent
// sessions' connections; the Plan-005 seam keys observations by runtime-binding leg, and the
// inventory preserves that grain instead of overwriting divergent leg states into one scalar.
interface McpServerLegStatus {
  sessionId: SessionId;
  bindingId: string; // the Plan-005 runtime-binding leg key (§Tier 4 McpServerStatusUpdate) — NOT this section's config binding
  status: McpServerStatus;
  observedAt?: string; // ISO-8601 of this leg's newest observation
}

// Inventory read model (mcp.list / mcp.get): four merged sources per binding — provider-declared
// config, live status (McpServerStatus, §Tier 4 seam), the trust row, the override rows. A
// DISCRIMINATED PAIR on trustUnavailable (Spec-028 §Fallback Behavior): the normal arm serves all
// four sources; the degraded arm (trust store unreachable) serves the provider-observed sources
// only, with every trust- and override-dependent field STRUCTURALLY ABSENT rather than fabricated —
// the daemon can construct a valid degraded entry without inventing trust state or a noncanonical
// hash (trusted/configHash/toolOverrides all live in the unreachable store). scopeRefDigest stays
// served in BOTH arms: it derives from the daemon-held master key, not from any database row.
// All mutations fail closed while degraded.
type McpServerInventoryEntry = McpServerBindingRef & {
  effectiveInRuns: boolean; // whether this binding reaches provider runs: Codex user+project true (native layering; project shadows user per cwd); Claude user true (composed ephemeral snapshot), project/local false in V1 (strict-mode composition excludes them — Spec-028 §Implementation Notes)
  config: McpServerConfigView; // the redacted normalized declaration (see above)
  status: McpServerStatus; // deterministic aggregate over legs[]: most severe current live-leg status (failed > needs-auth > unknown > starting > connected — a live leg whose observation source is lost reports "unknown": lost observability outranks known-healthy states, never a concrete failure), else newest node-probe observation, else "unknown" — never fabricated
  legs?: McpServerLegStatus[]; // per-leg session-feed observations; absent when no live leg exists. Legs are LIVE-session observations with a bounded lifecycle: when a leg's backing runtime binding closes (session end / driver exit), the daemon retires it and recomputes the aggregate — a terminated session's last status never pins `status`
  observedAt?: string; // ISO-8601 of the newest status observation backing `status`
  requiredServer?: boolean; // Codex `required = true` — thread start/resume fails if the server cannot initialize
  scopeRefDigest?: string; // present for project/local bindings in BOTH arms — the McpServerBindingAuditRef digest, served so clients can join mcp.subscribe / sentinel-chain event payloads to inventory entries without recomputing; derived from the daemon-held master key (the scope-ref subkey), so it needs no database row and the key never leaves the daemon
} & (
    | {
        trustUnavailable?: never; // the normal (trust-store-available) arm
        enabled: boolean; // provider-declared enabled state composed with the daemon's Claude enabled overlay (the overlay lives on the trust row)
        trusted: boolean;
        configHash: string; // "b3:"-prefixed keyed BLAKE3 (key = the binding's config-hash subkey, derived from the daemon-held master key that never enters the database — Spec-028 §Trust Governance) over the RFC 8785 JCS canonical BASE config — daemon-managed override-projection fields excluded, so a governed override write never drifts the hash trust binds to (excluded from the HASH only, never from drift detection: every drift evaluation on a trusted binding separately reconciles the observed projection fields against the expected native state — the preserved native-field baseline overlaid with materialized facets — so an out-of-band enabled_tools/approval-mode edit cannot ride under an unchanged base hash); non-colocated keying keeps every stored or served hash non-brute-forceable even from a database copy
        toolOverrides: McpToolOverride[];
      }
    | {
        trustUnavailable: true; // degraded read: trust store unreachable — mutations fail closed (Spec-028 §Fallback Behavior)
        enabled?: boolean; // the provider-native enabled field only (Codex); ABSENT for Claude bindings — the daemon enabled overlay lives in the unreachable store, and a fabricated value would be a lie
      }
  );

// At least one facet is REQUIRED — a toolName-only override is meaningless and the canonical DDL
// rejects the all-NULL row, so the Zod mirror refines "enabled, approvalMode, or idempotencyClass
// present" and a facet-less request dies as a typed validation error, never a constraint failure.
// enabled: true is a safety-WEAKENING facet (it broadens the executable tool set) and is
// trust-conditioned like every weakening facet (Spec-028 §Trust Governance).
interface McpToolOverride {
  toolName: string;
  enabled?: boolean; // absent = inherit provider config (for Codex-materialized facets, "provider config" means the preserved native baseline — a clear restores it; Spec-028 §Tool-Level Overrides)
  approvalMode?: McpApprovalMode; // absent = provider default
  idempotencyClass?: "idempotent" | "compensable"; // absent = the Spec-005 §Tool Metadata manual_reconcile_only floor; assignment is trusted-server-only + Cedar-gated
}

// Per-facet application grades for override mutations (Spec-028 §Tool-Level Overrides): Codex
// enabled/approvalMode materialize into native config fields (user_config_write) — user-scope
// bindings only; on a Codex project binding those two facets refuse mcp.config_scope_unsupported
// (no daemon interception point could honestly enforce them) while idempotencyClass still applies;
// Claude enforces all three at the daemon approval/resolution layer (daemon_enforced, immediate).
// Present keys mirror the facets the request touched (or reverted, on clear).
interface McpToolOverrideApplication {
  enabled?: McpApplicationGrade;
  approvalMode?: McpApplicationGrade;
  idempotencyClass?: "daemon_enforced";
}

// Per-leg live-application outcome (Spec-028 §Configuration Mutation — partial outcomes are typed,
// never masked): a durable-success/live-failure mutation is a SUCCESSFUL response reporting the
// durable grade plus the failing legs — never a post-commit JSON-RPC error inviting an unsafe retry,
// and never a blanket success hiding a live failure.
interface McpLiveApplicationResult {
  sessionId: SessionId;
  bindingId: string; // the Plan-005 runtime-binding leg key
  outcome: "applied" | "failed";
  errorCode?: string; // mcp.* code for a failed leg (e.g. a per-server setMcpServers error)
  detail?: string; // sanitized — never config values or unsanitized paths
}

// ---- Operations (11; JSON-RPC per ADR-009) ----
// Reads (operator-readable, no Cedar mutation check):
//   mcp.list      {refresh?: boolean} → {servers: McpServerInventoryEntry[]}
//   mcp.get       McpServerBindingRef → {server: McpServerInventoryEntry}
//   mcp.subscribe {} → AsyncIterable<EventEnvelope> // live-tail of every mcp_governance envelope as appended (sentinel- and session-bound alike; Plan-007 streaming primitive, session.subscribe consumer shape). Gap-free by ORDERING, not by cursor: a (re)connecting client opens mcp.subscribe FIRST, then reads mcp.list — the subscribe acknowledgment precedes the stream's first delivery (the Plan-007 I-007-10 wire-ordering invariant), so registration is live before the snapshot read and an event concurrent with the snapshot arrives on the stream instead of falling between snapshot and subscription (re-observation is harmless — governance envelopes are re-entrant state updates; omission is impossible). History via the locally-verified sentinel chain (Spec-028 §Status Observation and Events)
// Cedar-gated non-reads (all deny-before-effect; every operation except mcp.reconnect carries the
// MANDATORY clientIdempotencyKey: string — requester-generated UUID, durable receipt replay on
// identical retry, mcp.idempotency_conflict on key reuse with a differing request digest, Spec-028
// §Authorization. The SIX governance mutations below each emit their mcp_governance event exactly
// once, atomically with the receipt; mcp.oauthLogin and mcp.reconnect are operational commands
// outside that atomic invariant — oauthLogin is receipted but its durable trace is the
// provider-asynchronous mcp.server_oauth_completed, emitted exactly once per OBSERVED completion
// (an abandoned flow leaves only the expiring receipt); reconnect is unreceipted and audits
// through the status transitions it induces):
//   mcp.upsertServer      McpServerBindingRef & {clientIdempotencyKey: string, config: McpServerConfigInput} → {server: McpServerInventoryEntry, applied: McpApplicationGrade, liveResults?: McpLiveApplicationResult[]}
//   mcp.removeServer      McpServerBindingRef & {clientIdempotencyKey: string} → {applied: McpApplicationGrade, liveResults?: McpLiveApplicationResult[]}
//   mcp.setEnabled        McpServerBindingRef & {clientIdempotencyKey: string, enabled: boolean} → {server: McpServerInventoryEntry, applied: McpApplicationGrade, liveResults?: McpLiveApplicationResult[]}
//   mcp.setTrust          McpServerBindingRef & {clientIdempotencyKey: string, trusted: boolean} → {server: McpServerInventoryEntry, applied: "daemon_enforced"} // a grant binds to the binding's CURRENT base-config hash
//   mcp.setToolOverride   McpServerBindingRef & {clientIdempotencyKey: string, override: McpToolOverride} → {server: McpServerInventoryEntry, applied: McpToolOverrideApplication}
//   mcp.clearToolOverride McpServerBindingRef & {clientIdempotencyKey: string, toolName: string} → {server: McpServerInventoryEntry, applied: McpToolOverrideApplication} // grades cover the cleared facets' reversion path
//   mcp.oauthLogin        McpServerBindingRef & {clientIdempotencyKey: string} → {authorizationUrl?: string} // Codex returns the provider URL; a mode with no in-band flow fails mcp.oauth_unsupported; mcp.oauth_flow_failed is LAUNCH-phase only — an async completion failure arrives as mcp.server_oauth_completed outcome: 'failure' on the mcp.subscribe stream, never a late JSON-RPC error (Spec-028 §OAuth Orchestration). Its idempotency receipt persists the acknowledgment with authorizationUrl STRUCTURALLY OMITTED (single-use PKCE-bearing launch material is never durable — Plan-028 I-028-1), so an identical-key retry replays a URL-free acknowledgment: the flow already launched, completion arrives as the event, and a caller that never received the URL starts a new login under a fresh key
//   mcp.reconnect         McpServerBindingRef & {sessionId?: SessionId, bindingId?: string} → {legs: McpServerLegStatus[]} // operational: restarts the binding's live provider leg(s), LEG-ADDRESSABLE — exactly one leg when bindingId is given (with sessionId, both must name the same leg), every live leg of one session when only sessionId is given, every live leg otherwise; per-leg post-reconnect statuses, honest per leg
// Scope applicability is per operation (Spec-028 §Configuration Mutation), never a blanket rule:
// provider-config writes (upsertServer/removeServer/setEnabled) accept scope "user" only;
// setTrust/overrides/oauthLogin/reconnect apply to any binding effective in runs (Codex
// user+project; Claude user); mutations on bindings V1 never materializes (Claude project/local)
// and native-write-only override facets on Codex project bindings fail mcp.config_scope_unsupported
// at the service layer — typed refusals, not parse errors.

// ---- Event payload mirrors (Spec-006 §MCP Governance) ----
// Every payload embeds the PATH-FREE binding identity via intersection with the
// McpServerBindingAuditRef union (provider, scope, scopeRefDigest per the scope variant,
// serverName) — never the raw scopeRef (see the audit-ref comment above): these payloads are
// durable, hash-chained, signed audit rows, and Spec-028 forbids filesystem paths in them.
type McpServerStatusChangedPayload = McpServerBindingAuditRef & {
  previousStatus: McpServerStatus;
  status: McpServerStatus;
  failureReason?: string; // sanitized
  origin: "session_feed" | "node_probe"; // mirrors the per-event session binding: real sessionId on session_feed rows, the daemon-scope sentinel on node_probe rows
  bindingId?: string; // REQUIRED for origin "session_feed" — the Plan-005 runtime-binding leg key (opaque daemon-minted id), attributing the transition to its legs[] entry when one binding backs several legs in the same session; ABSENT for "node_probe" (no leg observed). The Zod mirror enforces the conditionality as a refinement
};
type McpServerConfigChangedPayload = McpServerBindingAuditRef & {
  changeKind: McpConfigChangeKind;
  appliedVia: McpApplicationGrade;
  configHash?: string; // REQUIRED for every changeKind except "removed"; ABSENT for "removed" — there is no post-removal config to hash. The Zod mirror enforces the conditionality as a refinement; no tombstone hash is ever fabricated
  previousConfigHash?: string; // REQUIRED for "removed" and "updated" (the pre-change hash); optional otherwise
  initiatingSessionId?: SessionId; // sentinel-bound rows record a session-scoped initiator here, never in the envelope session_id
};
type McpServerTrustChangedPayload = McpServerBindingAuditRef & {
  trusted: boolean;
  reason: McpTrustReason;
  configHash: string; // the base-config hash the grant binds to, or the drift-observed hash on revoke — keyed BLAKE3 under the binding's derived config-hash subkey (Spec-028 §Trust Governance; the master key never enters the database), so the served digest is not offline-brute-forceable
  initiatingSessionId?: SessionId; // absent on config_drift auto-revoke
};
type McpToolOverrideChangedPayload = McpServerBindingAuditRef & {
  toolName: string;
  changeKind: "set" | "cleared";
  enabled?: boolean;
  approvalMode?: McpApprovalMode;
  idempotencyClass?: "idempotent" | "compensable";
  initiatingSessionId?: SessionId; // absent on the trust-revocation facet-reversion path (revocation neutralizes weakening, Spec-028 §Trust Governance)
};
type McpServerOauthCompletedPayload = McpServerBindingAuditRef & {
  outcome: "success" | "failure"; // 'failure' IS the asynchronous completion-failure channel (Spec-028 §OAuth Orchestration — launch failures are errors, completion failures are events)
  failureReason?: string; // sanitized — never tokens, authorization codes, or URLs with embedded secrets
  initiatingSessionId?: SessionId;
};
```
