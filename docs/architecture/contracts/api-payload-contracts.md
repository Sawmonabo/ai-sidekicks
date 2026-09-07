# API Payload Contracts

Typed payload definitions for all named interfaces across all specs. Each contract specifies request shape, response shape, and error shapes using TypeScript/Zod notation.

**Usage:** Implementation agents translate these definitions into Zod schemas in `packages/contracts/src/`. The organization by tier matches the [Canonical Build Order](../cross-plan-dependencies.md).

**Schema reference:** Column types and constraints are in [Local SQLite Schema](../schemas/local-sqlite-schema.md) and [Shared Postgres Schema](../schemas/shared-postgres-schema.md).

---

## Authenticated Principal And Authorization Model

Every control-plane endpoint defined in this document is implicitly scoped to the authenticated caller. Authorization rules — including every Cedar policy evaluation — treat the following as controlling inputs:

- **Principal identity.** The Cedar `principal` is the `sub` claim of the caller's PASETO v4.public access token (a `ParticipantId`). This is the only identity Cedar evaluates. See [RFC 9068 §2.2 — `sub` claim](https://datatracker.ietf.org/doc/html/rfc9068#section-2.2) for the `sub`-as-principal pattern and [ADR-010 PASETO + WebAuthn + MLS Auth](../../decisions/010-paseto-webauthn-mls-auth.md) for the V1 PASETO profile.
- **Proof-of-possession binding.** Each access token carries a DPoP-style confirmation claim (`cnf.jkt`, per [RFC 9449 §3.1 — Public Key Confirmation via Thumbprint](https://datatracker.ietf.org/doc/html/rfc9449#section-3.1)) whose value is the SHA-256 thumbprint of the caller's bound JWK. A token is valid only when accompanied by a DPoP proof signed by the matching private key. The bound access token is presented as `Authorization: DPoP <token>` per [RFC 9449 §7.1](https://www.rfc-editor.org/rfc/rfc9449#section-7.1) — never `Bearer`, which a conforming resource server rejects for a DPoP-bound token — and the accompanying proof carries the token's `ath` hash per [RFC 9449 §4.3](https://www.rfc-editor.org/rfc/rfc9449#section-4.3); see [security-architecture.md §DPoP sender-constraining](../security-architecture.md#control-plane-authentication-task-52) for the canonical statement. `cnf.jkt` is a replay-protection binding — **not** a second principal identity; Cedar never reads it as a `principal` input.
- **Informational body fields.** Any body field that names a participant — `approver`, `inviter`, `requester`, `initiatorId`, `actor`, and equivalents — is routing/audit metadata only. Cedar does **not** read these fields as authorization input. Servers must reject a request when the body-supplied actor disagrees with the verified `sub`, rather than trusting the body. The converse is an application of this same rule rather than an exception to it: a request that needs no participant input declares **no principal member at all**, and `ReasoningSurfaceReadRequest` (§Plan-013, 2026-09-01) is the worked instance — its caller is resolved from the transport and its schema is strict, so a caller-supplied principal is refused rather than ignored. That is a resolution-side application of this bullet and deliberately not a sixth entry in the durable-recording list below, which enumerates only where an already-resolved principal is **retained** on a durable carrier — this read retains nothing.
- **Run-control resource context (2026-08-03 cross-user run-control authorization amendment).** For run-control adjudication — the Cedar `Action::"intervene"` evaluation on the target `Run` resource, covering interventions, the orchestration-layer `run.pause` / `run.resume` verbs, and — since 2026-08-29 — participant-triggered `driver.compactContext` identically — the target run's **hosting node** is a controlling request-context input, resolved daemon-side from the target run and never from a client-supplied field (the informational-body-fields rule above applies unchanged; the durable per-run hosting-node carrier this resolution reads is a named [Plan-004 §Preconditions](../../plans/004-queue-steer-pause-resume.md#preconditions) prerequisite — no shipped run accessor or schema column carries the node today, and the one consumer that needs no carrier is `driver.compactContext`, whose target is by construction a provider binding this daemon holds, so its hosting node resolves local without a lookup): authorization evaluates against session membership role, never run authorship, and a non-local hosting node **adds** the target-node-owner approval requirement (an approval in the `tool_execution` category per [Spec-024 Cross-Node Dispatch And Approval](../../specs/024-cross-node-dispatch-and-approval.md)) rather than substituting for the role check. The principal is transport-verified on both run-control paths: on the daemon's local socket — which admits only the node owner's own clients under the layered socket-reachability + session-token model and carries no PASETO token (the Local-daemon endpoints bullet below; [security-architecture.md §Local Daemon Authentication](../security-architecture.md#local-daemon-authentication-task-51)) — the daemon binds the Cedar principal to its **node-owner participant identity** — the daemon's standing control-plane-authentication posture ([component-architecture-local-daemon.md §Responsibilities](../component-architecture-local-daemon.md#responsibilities)) — resolved through the Plan-018-gated credential/identity provider seam the §Signing-Key Registration Method Registry below already rides (the CP-006-13 constructor-injected credential-provider and `resolveCurrentParticipantId` pattern; `runtimenode.attach` is client-driven and hands the daemon no principal, so no attach hook supplies the value), daemon-resolved, never read from a body actor field, and failing closed while the provider is unwired — the run-control registration of that provider is a named [Plan-004 §Preconditions](../../plans/004-queue-steer-pause-resume.md#preconditions) prerequisite; a cross-user caller reaches run-control only over identity-carrying paths — a cross-node intervention arrives via Spec-024 dispatch, where the target binds the principal to the verified `caller_token.sub` after checking the token's signature and its `req_hash` body binding (the Cross-node dispatch bullet below): the envelope's request-hash-bound signed token is that transport's sender-constraining mechanism, and no separate DPoP proof rides the relay leg. Contract text: [Spec-004 §Interfaces And Contracts](../../specs/004-queue-steer-pause-resume.md#interfaces-and-contracts); rule owner: [Spec-012 §Required Behavior](../../specs/012-approvals-permissions-and-trust-boundaries.md#required-behavior).
- **Local-daemon endpoints.** Endpoints reachable only over the daemon's local IPC socket (JSON-RPC 2.0 per [ADR-009 JSON-RPC IPC Wire Format](../../decisions/009-json-rpc-ipc-wire-format.md)) are authorized by socket reachability plus a required 256-bit session token presented by the Desktop Shell or CLI client (per BL-056 reconciliation on 2026-04-18; see [security-architecture.md §Local Daemon Authentication](../security-architecture.md#local-daemon-authentication-task-51)); they do not require a PASETO access token. The renderer is not a direct daemon client — renderer-originated requests are brokered by the shell via the preload bridge. **Where a local handler reads that identity (2026-09-01):** socket reachability authorizes the _connection_, and a handler adjudicating per-caller policy needs the _principal_ — so the gateway resolves the node-owner participant identity through the same Plan-018-gated credential/identity provider seam the run-control bullet above names and stamps it on the dispatch context every handler already receives ([Plan-007](../../plans/007-local-ipc-and-daemon-control.md) I-007-21, its Phase 2B). It is daemon-resolved and never read from a body actor field, so the informational-body-fields rule applies to local handlers unchanged; while the identity provider is unwired the member is absent and a handler that requires one **refuses**, never substituting a default — a placeholder identity is indistinguishable from a real caller to a policy check, which would turn a fail-closed read into a fail-open one. First consumer: [Plan-013](../../plans/013-live-timeline-visibility-and-reasoning-surfaces.md)'s reasoning-surface read (CP-007-17), whose `policy_redacted` decision is exactly such an adjudication. When a local-daemon request is later forwarded cross-node via dispatch, the target daemon verifies the dispatch envelope's `caller_token` — signature plus the `req_hash` body binding per [Spec-024 Cross-Node Dispatch And Approval](../../specs/024-cross-node-dispatch-and-approval.md) — before Cedar runs: the request-hash-bound signed token is that path's sender-constraining, and no separate DPoP proof is carried on the relay leg (the Cross-node dispatch bullet below).
- **Cross-node dispatch.** Cross-node approval envelopes follow [Spec-024 Cross-Node Dispatch And Approval](../../specs/024-cross-node-dispatch-and-approval.md): the Cedar `principal` on the target side is bound only to `caller_token.sub`; `approver_token.sub` is carried for audit and replay-binding via the shared `bound_jti` + `request_body_hash` and does **not** become a second principal.
- **Durable principal recording on admitting writes (2026-08-18 admitting-principal carrier amendment).** The six bullets above govern how a principal is _resolved_ for one request. This bullet governs how it is _retained_. **Every admitting write records the daemon-resolved transport-authenticated principal on its own durable row.** An admitting write is one whose acceptance authorizes later work that the original request no longer accompanies — a subsequent turn, a drained queue item, a remembered grant — so the identity must survive the request that carried it. The recorded value is resolved by exactly the mechanisms above (node-owner binding on the local socket, the verified PASETO `sub` on authenticated surfaces, `caller_token.sub` on the cross-node arm), never read from a body actor field; a body-supplied actor disagreeing with the verified identity refuses as the existing `auth.principal_mismatch` error rather than being trusted or silently normalized. Recording it on the row it admits — rather than deriving it later from event history — is what makes the identity **replay-stable**: an accumulating history offers no single answer to "under whose authority was _this_ unit of work admitted", and the informational-body-fields rule above already forbids the only wire-carried candidate. Where the row can also be written by a non-participant path, a daemon-resolved origin discriminator on the same row carries which admission path produced it, with the principal required exactly on the participant arm and forbidden on the system arm — enforced by the storage engine wherever the carrier is a table row, and by the recorded value's own closed shape where it is not, so the participant arm cannot persist unidentified and the system arm cannot smuggle an identity in. Instances — **(1)**-**(3)** each one column per owning surface under [cross-plan-dependencies.md §2](../cross-plan-dependencies.md#2-package-path-ownership-map) one-writer discipline, **(4)** a payload member for the reason the shape-deviation paragraph below gives, and **(5)** a member inside a durable JSON slot rather than a column of its own: **(1)** `approval_resolutions.approver_id` — the shipped instance ([Spec-012 §Required Behavior](../../specs/012-approvals-permissions-and-trust-boundaries.md#required-behavior), Plan-012 D-012-12), the approver whose decision a remembered grant later re-applies; **(2)** `interventions.admitting_principal_id` beside its `origin` discriminator — the intervention caller whose principal a steer-opened or replacement-send-opened turn executes under ([Spec-004 §Required Behavior](../../specs/004-queue-steer-pause-resume.md#required-behavior), Plan-004 D-004-4; consumed by Plan-012's turn-scoped resolution, CP-004-14 ⇄ CP-012-12); **(3)** the chat-borne workflow start's authoring participant, adjudicated as `Action::"workflow::start"` ([Spec-017 §Start authorization (SA-39)](../../specs/017-workflow-authoring-and-execution.md#start-authorization-sa-39)) — [Plan-017](../../plans/017-workflow-authoring-and-execution.md) instantiates its own column on its own surface when that surface lands, since the rule is a class and not a shared column; **(4)** the turn-scoped effective principal on `usage.cost_update`'s payload — the party whose causation a unit of metered spend is attributed to ([Spec-006 §Usage Telemetry](../../specs/006-session-event-taxonomy-and-audit-log.md#usage-telemetry-usage_telemetry), 2026-08-26; produced by [Plan-004](../../plans/004-queue-steer-pause-resume.md) under CP-004-16 and consumed by [Spec-016 §Session Cost Receipt](../../specs/016-multi-agent-channels-and-orchestration.md#session-cost-receipt)); **(5)** `agents.pending_switch.admittingPrincipalId` — the participant who admitted a same-agent provider switch whose application can outlive both the request and the daemon that took it ([Spec-016 §Same-Agent Provider Switch](../../specs/016-multi-agent-channels-and-orchestration.md#same-agent-provider-switch), 2026-08-26), **registered in this enumeration 2026-09-01** — its own §Plan-016 slot block has recorded it as held under this rule since it was minted, so this entry closes an enumeration that named four of its five members; it carries no `origin` discriminator because `agent.configUpdate` is its only producer, which that block states as a claim under this rule rather than leaving silent.

  Instance (4) differs from the first three in **two** deliberate ways, and neither is an exception to the rule. First, it is not itself an admitting write: it is the **carrier by which an admitting write's principal reaches a downstream fold**, resolved daemon-side from instance (2)'s rows. The retention discipline binds it for the same reason it binds the others — a fold that had to find the principal by ordering a metered row against turn-boundary events would be "deriving it later from event history", which is precisely what this bullet forbids, and that derivation would additionally rest on an event type the corpus types as forward and non-state. Second, its durable home is a **canonical event payload rather than a projection column**, because the unit it must attach to is a metered turn and no per-turn table exists — minting one to hold a single derived identity would add a second record of boundaries the log already orders, which [ADR-029](../../decisions/029-canonical-transcript-is-authoritative.md) rejects on its own terms. The `session_events` row is durable, replay-stable, and integrity-chained, and a typed event's fields live in its payload, so the class's requirement — recorded on the row, never re-derived — is met exactly. The origin discriminator the paragraph above requires is carried by the value's own closed two-arm shape (`EffectivePrincipal`, §Plan-016): the participant reference is required on the participant arm and absent on the system arm, enforced by the union rather than by a table CHECK, since a wire payload has no table to constrain.

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
type InterventionType = "steer" | "interrupt" | "cancel" | "rollback"; // rollback: campaign B2 (Spec-004 §Required Behavior). Code-mirror gate DISCHARGED — the shipped provider-driver.ts union is four-membered (Plan-005 T1.8); ApplyInterventionParams deliberately stays three-armed, because rollback dispatches through the capability-gated rollbackTo parity operation, not through applyIntervention
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
  | "transcript_replay" // accepts a canonical transcript replayed into a fresh session via replayTranscript (2026-08-26, ADR-029; the Claude cell is probe-declared, not statically true — Spec-005 §Per-Driver Capability Matrix)
  | "cost_cap" // realizes a daemon-supplied hard cost cap natively at spawn — Claude --max-budget-usd; gates the Spec-016 native-cap unpriced admission (campaign B6)
  | "context_compaction" // compacts the bound session's own provider-side context on participant request via compactContext (2026-08-29, Spec-005 §Participant-triggered context compaction)
  | "provider_commands" // enumerates the provider's native slash-commands and skills via listProviderCommands — a LIVE read, never a stored registry (2026-08-29, Spec-005 §The provider command and skill surface)
  | "output_speed"; // declares a participant-settable provider-side output-speed mode; Claude only, detectionSource STATIC because reading the declared state is not zero-turn (2026-08-29, Spec-005 §The output-speed axis)
// Code-mirror gate (campaign B3/B6) DISCHARGED: the shipped executable union
// (packages/contracts/src/provider-driver.ts) now exports ALL SEVENTEEN of these, so no member above is
// declarable in doc only and the "MUST NOT declare" carve-out this note used to carry has no remaining
// subject. The shipped assertValidCapabilityFlags still rejects
// any snapshot whose key count differs, so union +
// validator + driver_capabilities migration backfill + conformance tests widen together as ONE change or
// not at all — the coupling that held on every wave: the campaign's Plan-005 bundle landed the first six,
// Plan-005 T3.19 (2026-08-26) the fourteenth by extending that same union rather than opening a second
// seam, and Plan-005 T3.26 (2026-08-29) the fifteenth through seventeenth the same way. That last
// widening rebuilds an ALREADY-SHIPPED CHECK — migration 0011 froze
// driver_capabilities.capability_flag at fourteen values — so it consumed the next-ordinal table-rebuild migration 0014 rather than amending a CREATE, adding no table and no column; cost_cap-gated admission code
// (Plan-016 T2.3) dispatch-gates on that bundle (same named-bundle gate as the goal driver mirror).
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
  // 2026-08-26 (CP-030-8), additive-optional: the projected sidekick peer-invocation opt-in. A
  // DERIVATION of the `session.peer_invocation_set` fold, never a second source of truth and never a
  // stored column — the event log stays the durable home. Present as a read path because the
  // `sidekick.*` surface exposes only the mutating verb, and without it a reopening renderer could
  // learn the current value only by replaying and folding raw events client-side. Absent ⇒ the
  // responder predates this member, which a client renders as unknown rather than as disabled:
  // defaulting an unknown capability grant to "off" would misreport an enabled session as safe.
  peerInvocationEnabled?: boolean;
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
/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/
```

Every dot-delimited segment starts with a lowercase letter and may contain camelCase (`[a-z][a-zA-Z0-9]*`) — the first segment (the namespace root) included, per the 2026-09-05 root widening recorded in this paragraph. This adopts the dotted-camelCase _segment_ style of the LSP precedent ([Language Server Protocol §General Messages](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/) — e.g. `workspace.executeCommand`) and the MCP precedent ([Model Context Protocol §Protocol Messages](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) — `tools.list`, `tools.call`), and applies that style **uniformly to every segment, the root included**. It did not always. Until 2026-09-05 the leading segment was tightened to lowercase-only, which rejected LSP's own camelCase-rooted names such as `textDocument.didOpen` while citing LSP — whose roots are camelCase — as the precedent for the style, and which, once the ten-verb `providerAccount.*` namespace was ratified ([Spec-029](../../specs/029-provider-accounts-and-credential-homes.md) / [Plan-029](../../plans/029-provider-accounts-and-credential-homes.md) / [ADR-028](../../decisions/028-provider-credential-custody-posture.md)) and registered in §Plan-029 — Provider Accounts And Credential Homes below, rejected a namespace root **this document itself registers** — so the `register()`-time guard below would have thrown on all ten verbs at daemon boot. The widening resolves the contradiction by moving the first segment to the class the later segments already admit, which is the class the cited precedent uses; renaming ten ratified verbs across every spec, plan, ADR, architecture contract, and runbook that carries them, to satisfy a regex whose own stated precedent contradicts it, was the wrong direction. Nothing else moves: segment-internal rules are unchanged, the two-segment minimum is unchanged, and an uppercase-**starting** segment is still rejected in any position (`Session.create` fails, as it always did). `providerAccount` is the only registered method root carrying an uppercase letter; the rest are lowercase identifiers — as enumerated at the Tier-8 audit, registered or shipped: `session`, `daemon`, `run`, `repo`, `approval`, `participant`, `gdpr`, `runtimenode`, `presence`, `invite`, `membership`, `channel`, plus the Tier-6-ratified Plan-016 roots `orchestration` and `agent`, the Tier-7-ratified Plan-011 root `gitflow`, the campaign-B18-registered Plan-028 root `mcp`, and the Tier-8-ratified roots `timeline` (Plan-013), `attention` (Plan-019), and `health` (Plan-020); still-planned: `driver`, `settings`, `event`, `artifact` (root set re-derived during the Tier-6 audit, gitflow added during the Tier-7 audit, mcp with the campaign-B18 registration (2026-07-22), and timeline, attention, and health during the Tier-8 audit; `invite`/`membership`/`channel` are SDK-declared daemon-as-gateway strings owned by Plan-002, bridged server-side to control-plane tRPC). The V1 Tier 1 surface (`session.create`, `session.read`, `session.join`, `session.subscribe`) uses all-lowercase segments; nested-namespace operations like `settings.effectiveRead` and `driver.listCapabilities` (lowercase root + camelCase tail) are permitted under this regex, as is a camelCase root such as `providerAccount.list`.

The regex accepts the Tier 1 surface and rejects:

- `session/create` — slash-style (visually conflated with HTTP path segments; ambiguous in JSON-RPC contexts where method names appear in the JSON `method` field, not URLs).
- `SessionCreate` — PascalCase (collides with the project's TypeScript type-name convention; `Session.create` is rejected on the same ground — the root widening admits an uppercase letter _inside_ a segment, never at its start; `SessionCreate` is already a request-payload type symbol per `packages/contracts/src/session.ts`, so a string-form would be ambiguous at every call site).
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
const METHOD_NAME_FORMAT = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;

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

### JSON-RPC Request `id` Bound (Tier 1 Ratified)

**Canonical bound**: a request `id` may not exceed `JSON_RPC_ID_MAX_BYTES` (256) bytes once JSON-encoded. The constant is declared at `packages/contracts/src/jsonrpc.ts` beside the frame's message-size limit and re-exported unchanged by `packages/runtime-daemon/src/ipc/local-ipc-gateway.ts`, which enforces it.

**Where it is enforced**: at the **request** boundary, before dispatch — an over-bound id refuses as `-32600 Invalid Request` with `data.type: "invalid_envelope"`, and that refusal carries `id: null` rather than echoing the offending value. Enforcement is two-sited and both sites are required: the envelope's id gate refuses the request, and the gateway's id-extraction helper — through which the `jsonrpc` and `method` gates build their error frames, and which answers _before_ the id gate — falls back to a null id, without which the one frame guaranteed to be small would be the one carrying the oversized echo.

**Why a request-side bound rather than a response-side subtraction**: JSON-RPC requires a response to echo the request's `id`, so the id is the one response member a response schema does not choose. A reply is bounded by the substrate's absolute message-size limit ([Spec-007 §Wire Format](../../specs/007-local-ipc-and-daemon-control.md#wire-format)), and an oversized reply cannot carry its own error — the send path drops the connection instead. Without this bound, a 900 KB id inside an otherwise-valid request makes every reply to it unencodable and the session unrecoverable from contract-valid data alone.

**Why the encoded form**: measuring the JSON encoding rather than the JavaScript string length covers escaping (a control character encodes to six ASCII bytes) and lets one rule read identically for the string, number, and null id forms the envelope admits.

**Consumers**: any page builder sizing a reply against the frame it will become subtracts a framing reserve that includes this bound — see [Plan-013](../../plans/013-live-timeline-visibility-and-reasoning-surfaces.md) T1.5 and its `TIMELINE_PAGE_FRAME_RESERVE_BYTES` derivation. The reserve is therefore derived from an enforced rule rather than an assumed allowance.

---

## Tier 2: Plan-002 — Invite Membership And Presence (Task 4.3)

> **Amended 2026-08-11 (Spec-002 BL-133 amendment, PR #322):** `InvitePreview` and `ChannelDirectoryPublish` join the registry below — one anonymous non-consuming invite-metadata mutation (resolving the [Spec-023 §Deep-Link Invite Flow](../../specs/023-desktop-shell-and-renderer.md#deep-link-invite-flow) pin) and one daemon-called channel-directory ingest mutation (the consuming half of the [Spec-016 §Interfaces And Contracts](../../specs/016-multi-agent-channels-and-orchestration.md#interfaces-and-contracts) D-016-22 publication). **Known naming skew (flagged, not reconciled by this amendment):** the shipped contracts code names request types **without** the `Request` suffix — `packages/contracts/src/invites.ts` exports `InviteCreate` / `InviteAccept` beside `InviteCreateResponse`-style response types — while this registry's Tier-2 shapes carry the older `Invite*Request` spelling. The shapes are field-identical; the code names are the canonical symbols. A future registry-wide naming pass may reconcile the spelling — this amendment deliberately does not, to keep its diff scoped to the two new methods.

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

// InvitePreview (2026-08-11) — anonymous, NON-CONSUMING metadata read for the deep-link
// confirmation step (Spec-002 Interfaces And Contracts; Spec-023 Deep-Link Invite Flow pin).
// Registered as a tRPC .mutation() despite being read-only: a query would put the token in a
// GET ?input= URL (server/proxy logs, browser history) — POST keeps it in the body. Zero
// writes, never burns the jti; refusal checks run in InviteAccept's exact order, and refusals
// project per error-contracts §Invite with invite.expired / invite.revoked at HTTP 410 via the
// contracts-level status-override map (see error-contracts §Error Response Shape).
interface InvitePreviewRequest {
  token: string;
}
interface InvitePreviewResponse {
  sessionId: SessionId; // target-session identity for the Spec-023 deep-link confirmation step — the
  // same id accept's own response returns to the token holder, so preview discloses nothing accept
  // does not (restored 2026-08-11, PR #322 Codex round 1: with no session-name producer in V1, an
  // all-null display pair left the confirmation step nothing to identify the session by)
  joinMode: JoinMode;
  expiresAt: string; // ISO 8601
  sessionName: string | null; // null until a session-naming owner exists (sessions has no name column) — no raw inviter identifiers
  inviterDisplayName: string | null;
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

// ChannelList — read-only, per-caller-filtered projection of channels in a session (see Spec-002 Interfaces And Contracts, amended 2026-08-03: a direct-kind channel is omitted entirely — never blanked — for any caller outside its immutable two-human member pair, keyed on the authenticated principal from the control-plane auth context, never a request field; the request/response shapes below are unchanged by that filter).
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

// ChannelDirectoryPublish (2026-08-11; fold redesigned same day — PR #322 Codex round 1) —
// DAEMON-called idempotent directory ingest (Spec-002 Interfaces And Contracts; the consuming half
// of Spec-016 D-016-22's producer publication, Plan-016 T2.14 / CP-016-15 <-> Plan-002 CP-002-10).
// Daemon-credentialed channel (the runtimenode.signingkeyregister daemon-called posture) — participants
// never call it. The ingest retains one candidate per origin in session_channel_directory
// (same-origin: higher originSeq; keyless legacy publications share one envelope-ordered slot),
// re-resolves visible state from the retained set (archived latches terminally, sticky on the
// stored row; otherwise the (originOccurredAt, originEventId)-max candidate's state), binds
// kind + memberPair + name exactly
// once from the origin-authenticated channel.created publication, and acknowledges only after the
// durable upsert commits — the producer's at-least-once retry keys on that acknowledgment.
interface ChannelDirectoryPublishRequest {
  sessionId: SessionId;
  channelId: ChannelId;
  lifecycleEventKind: string; // the triggering Spec-006 event type ("channel.created" | "channel.muted" | "channel.unmuted" | "channel.archived") — disclosure binds only from an origin-authenticated "channel.created"; an unrecognized value folds the state axis only (fail-closed, existence preserved)
  name?: string;
  state: ChannelState;
  kind: string; // Plan-016-owned vocabulary — unrecognized values ingest verbatim, consumers read fail-closed as direct
  memberPair?: [ParticipantId, ParticipantId]; // direct-kind two-human pair; canonicalized (low < high) at ingest
  originNodeId?: string; // origin daemon's node id — present iff originSeq is (both-or-neither); must match the authenticated caller for the publication to bind disclosure
  originSeq?: number; // origin daemon's per-(session, origin) monotonic counter — the same-origin comparator; absent only for a publication derived from a pre-extension event whose payload lacks the keys (folds via the legacy slot, never binds disclosure)
  originOccurredAt: string; // origin envelope occurredAt (ISO 8601) — cross-origin comparator, with...
  originEventId: string; // ...origin envelope id as the lexicographic tiebreak
}
interface ChannelDirectoryPublishResponse {
  channelId: ChannelId; // durable-commit acknowledgment
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
  // Shared-terminal write-lease holder (Spec-003 §Required Behavior, campaign B4): null = lease free (writes refused — null-holder-refuses-writes) OR a held lease read-suppressed while its producing node is server-classified offline (next comment + the §Session Terminal-Control Method Registry) — both render as no-advertised-holder, the fail-closed shape.
  // Source: the terminal-owning daemon is the lease authority and sole producer — it publishes every transition to the control plane via `runtimenode.leaseupdate` (the Terminal-Control registry's projection-sync mutation below), which persists the current holder in `session_terminal_leases` (shared Postgres; durable coordination record, same tier as `runtime_node_presence`, holder cleared on the auto-release presence/attachment drop, on holder authorization loss — role change out of the authorized set, suspension, or revocation — and on the agent-run write-burst release (`auto_released_run_idle`: the acquiring run's first lifecycle transition out of `running`) — per Spec-003; DDL forward-declared in [shared-postgres-schema.md §Session Terminal Lease](../schemas/shared-postgres-schema.md#session-terminal-lease-plan-024); table forward-assigned in cross-plan-dependencies §3 to the Plan-024 Phase 3B lease leg — campaign B16 — whose additive migration ships it and extends this roster read's projection beyond today's attachments × presence join).
  // Projected from `session_terminal_leases` with ONE read-time liveness predicate: a holder whose producing node carries `runtime_node_presence.health_state = 'offline'` resolves to null (the registry paragraph below — a read-side suppression, never a projection write). This is not the collapsed-scalar masking the node rows forbid: that node's `healthState` / `lastHeartbeatAt` ride verbatim in the same response, so the payload never contradicts itself: a suppressed holder and a free lease both read null at `controlHolder` — deliberately, since no client should offer write affordances against a holder the control plane cannot vouch live — while the `offline` verdict behind any suppression stays visible on the node rows.
  controlHolder: ParticipantId | null;
}
```

### Runtime-Node Method-Name Registry (Tier 3)

Plan-003's runtime-node operations are exposed as five methods — four state-changing operations plus one roster read (`runtimenode.roster`, added 2026-06-09 by the user-directed Plan-003 Phase 5 scope expansion, PR #150). A sixth `runtimenode.*` method — the Plan-024 lease projection-sync mutation `runtimenode.leaseupdate` (campaign B4, 2026-07-13) — registers in the §Session Terminal-Control Method Registry below, where its lease context lives; the seventh and eighth — the Plan-006 signing-key registration/resolution pair `runtimenode.signingkeyregister` / `runtimenode.signingkeyroster` (T4.10 per CP-006-7 leg B / CP-003-5, 2026-07-29) — register in the §Signing-Key Registration Method Registry below, where their verification-key context lives. Method-name strings are `dotted-camelCase` per the canonical `METHOD_NAME_FORMAT` ratified in §Tier 1 (cont.): Plan-007 above (the `register(method, …)` guard at the regex constant) — the same convention shared across Plan-007's JSON-RPC daemon IPC (mechanically regex-enforced at register time) and Plan-008's tRPC control-plane procedures, so the SDK call-site shape (`client.runtimenode.attach({ … })`) is symmetric across transports. Plan-003 registers the four mutation handlers under the Plan-007-partial daemon IPC substrate, and the same four also cross the Plan-008 control-plane transport as `runtimenode.*` tRPC procedures the sibling `runtimeNodeRouter` mounts (Plan-003 T3.8); `runtimenode.roster` is **control-plane tRPC ONLY** (Plan-003 T5.0c) — the roster is control-plane-owned cross-node state (a daemon knows only itself), so the read deliberately does not ride the daemon JSON-RPC transport the four mutations share. The registry table below is the canonical source for both transports (per [Plan-003 §Dependencies](../../plans/003-runtime-node-attach.md)).

The `runtimenode` namespace token is the concatenated domain noun — a spelling that **predates** the 2026-09-05 first-segment widening and is not required by it: `runtimeNode` would validate under the widened regex, but the concatenated root is the shipped, registered form on both transports and stays as it is; the widening admits a camelCase root, it does not ask any lowercase one to become one — distinct from the `runtime_node.*` **event** taxonomy (the 7 lifecycle events in [Spec-006 §Runtime Node Lifecycle](../../specs/006-session-event-taxonomy-and-audit-log.md#runtime-node-lifecycle-runtime_node_lifecycle)). The underscore `runtime_node.*` form is a valid _event_ name but is **rejected** as a _method_ name by `METHOD_NAME_FORMAT` (no underscores). `runtimenode.capabilityupdate` is the system's first multi-word procedure: it uses an all-lowercase run-on form within the `dotted-camelCase` regex (the regex permits camelCase in tail segments — `runtimenode.capabilityUpdate` would also be legal — but Plan-003 chose the run-on style to match the then-uniform single-verb arity of the `session.*` surface (since extended: the campaign's `session.goalUpdate`/`session.goalClear` (B6) and `session.takeControl`/`session.releaseControl` (B4) carry the camelCase-tail form the method-name grammar equally permits); the regex also permits a 3-segment `noun.sub.verb` form, reserved for a future nested-router need).

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `runtimenode.attach` | `mutation` | `RuntimeNodeAttachRequest` | `RuntimeNodeAttachResponse` |
| `runtimenode.heartbeat` | `mutation` | `RuntimeNodeHeartbeatRequest` | `null` — HTTP 200 `{ result: { data: null } }` (tRPC) / `result: null` (JSON-RPC); `RuntimeNodeHeartbeatResponseSchema` (`z.null()`) |
| `runtimenode.capabilityupdate` | `mutation` | `RuntimeNodeCapabilityUpdateRequest` | `RuntimeNodeCapabilityUpdateResponse` |
| `runtimenode.detach` | `mutation` | `RuntimeNodeDetachRequest` | `null` — HTTP 200 `{ result: { data: null } }` (tRPC) / `result: null` (JSON-RPC); `RuntimeNodeDetachResponseSchema` (`z.null()`) |
| `runtimenode.roster` | `query` | `RuntimeNodeRosterRequest` | `RuntimeNodeRosterResponse` — control-plane tRPC ONLY (no daemon JSON-RPC registration; added 2026-06-09, PR #150) |

The four dual-transport methods (`attach`/`heartbeat`/`capabilityupdate`/`detach`) are `mutation`s (state-changing, non-idempotent) per the tRPC procedure-type convention in §Tier 1 (cont.): Plan-008 above; `runtimenode.roster` is the namespace's first `query` — joined 2026-07-29 by Plan-006 T4.10's `runtimenode.signingkeyroster` per the §Signing-Key Registration Method Registry below — (an idempotent read: it projects the `runtime_node_attachments` × `runtime_node_presence` coordination records — plus, per campaign B4, the session's shared-terminal `controlHolder` lease state (daemon-enforced; its control-plane coordination record is pinned by the Plan-024 Phase 3B leg) — and writes nothing, so it authors no durable `runtime_node.*` event and does not collide with the [ADR-017 §Server-Derived Runtime-Node Lifecycle Events](../../decisions/017-shared-event-sourcing-scope.md#server-derived-runtime-node-lifecycle-events) V1.1 gate, which governs durable event authorship, not coordination-record reads), and it is mounted on the control-plane transport only (Plan-003 T5.0c). The request/response shapes are the interfaces defined directly above; the canonical Zod schemas live in `packages/contracts/` per the §Source-of-Truth Policy. `heartbeat` and `detach` carry a `null` response payload, not an empty `204` body: their resolvers return `null`, which tRPC serializes as an ordinary HTTP 200 success envelope `{ result: { data: null } }` (the control-plane router uses the default transformer, so there is no `data.json` wrapper). This matters because the SDK's `parseTrpcResult` calls `response.json()` on every 2xx response — a `204` with an empty body would throw `SyntaxError`, whereas `{ result: { data: null } }` parses cleanly and `z.null()` validates the extracted `null`. Over the JSON-RPC daemon transport — where JSON-RPC 2.0 requires a `result` member on success — they return `result: null`. Both transports are validated by the canonical `RuntimeNodeHeartbeatResponseSchema` / `RuntimeNodeDetachResponseSchema` (`z.null()`), so the SDK's `JsonRpcClient.call` (daemon) and the tRPC client both have a concrete result schema to pass (Plan-003 T1.3 / T4.1).

### Session Terminal-Control Method Registry (Tier 3, campaign B4)

The shared-terminal write lease ([Spec-003 §Required Behavior](../../specs/003-runtime-node-attach.md#required-behavior), campaign B4 2026-07-06) exposes two `session.*` methods and one control-plane projection-sync mutation (`runtimenode.leaseupdate`, the third table row). The two `session.*` methods are **daemon JSON-RPC ONLY in V1** — deliberately NOT the dual-transport shape of the four `runtimenode.*` mutations above: for those, the tRPC callee (the control plane) is itself the record authority, whereas the lease authority is the terminal-owning daemon and no documented control-plane→daemon command path exists to forward a remote mutation to it ([ADR-008](../../decisions/008-default-transports-and-relay-boundaries.md)'s relay is E2E peer connectivity, not a control-plane command channel), so a tRPC registration would place the mutation on a party that can neither adjudicate nor enforce it. `Spec-003 §Required Behavior` pins this V1 posture and the forward constraint (a future remote take rides the same relay leg as the terminal bytes it gates). The lease's client-facing control-plane surface is read-only projection, and its write path belongs to the single producer: the terminal-owning daemon publishes every transition — the two mutations' successes and the three auto-release classes (disconnect, authorization loss, agent-run write-burst end — `Spec-003 §Required Behavior`) — by calling `runtimenode.leaseupdate` (`RuntimeNodeLeaseUpdateRequest { sessionId, nodeId, controlHolder: ParticipantId | null, reason, transitionSeq, transitionedAt }`, `reason` mirroring the `pty.control_changed` enum, `transitionSeq` a per-session strictly-increasing counter the daemon owns and persists in its local lease record — a daemon restart continues the sequence, never resets it; response `null`, `RuntimeNodeLeaseUpdateResponseSchema` = `z.null()`, the heartbeat/detach pattern; implemented by Plan-024 Phase 3B / campaign B16), and control-plane-connected clients render `controlHolder` from the `runtimenode.roster` projection (`RuntimeNodeRosterResponse.controlHolder`; daemon-transport clients fold `pty.control_changed` and the mutation responses). The upsert into `session_terminal_leases` is **producer-bound and monotonic**, not bare last-write-wins: the control plane applies a write only when (1) the `(nodeId, sessionId)` pair has a live `runtime_node_attachments` row in an active state whose `participant_id` equals the verified PASETO `sub` — the [§Authenticated Principal](#authenticated-principal-and-authorization-model) body-vs-`sub` rejection rule applied to the node binding, so a daemon can publish only for a node its own participant owns and has attached to that session — **and, on a holder-asserting publish only (`controlHolder ≠ null`), that same `sub` additionally holds a `state = 'active'` `session_memberships` row for the session**: the §Signing-Key Registration Method Registry sibling predicate below, whose rationale transfers verbatim — [Plan-003 I-003-3](../../plans/003-runtime-node-attach.md#invariants) means no membership transition ever reaps an attachment, so without this predicate a suspended or revoked node-owner's still-live attachment keeps publishing itself as `controlHolder` and the projection advertises a holder whose write authority the daemon's own force-clear has already dropped, the state [Spec-003 §Acceptance Criteria](../../specs/003-runtime-node-attach.md#acceptance-criteria) forbids (`controlHolder` returns to `null` at signal arrival). A **clear/release** publish (`controlHolder: null` — an explicit `session.releaseControl` success and all three auto-release classes) is deliberately **exempt** from the membership predicate and stays attachment-gated only: it is the projection-layer form of `Spec-003 §Required Behavior`'s holder-gated-release rule — a holder stripped of authorization must still be able to relinquish, and refusing its force-clear publish would strand exactly the row the predicate exists to clear. Both halves of (1) ride the **same statement** as the write rather than a preceding probe (one snapshot — the single-statement authorization principle the §Signing-Key Registration Method Registry roster read below states), and the membership `EXISTS` is repeated on **both** upsert arms — `INSERT … SELECT … WHERE EXISTS (…)` as well as `ON CONFLICT (session_id) DO UPDATE … WHERE … AND EXISTS (…)` — because a bare `VALUES … ON CONFLICT` evaluates its `DO UPDATE … WHERE` only for rows proposed for update ([INSERT §ON CONFLICT Clause](https://www.postgresql.org/docs/current/sql-insert.html#SQL-ON-CONFLICT)) and would therefore admit an unauthorized first claimant against an absent row; (2) the lease row's recorded `node_id` matches `nodeId` — the row binds to its producing terminal-owning node at first write, and a leaseupdate from a _different_ attached node is refused unless the recorded node has ceased to be a live terminal host, which holds on **either** of two signals: its `runtime_node_attachments` row has left the active set (the cooperative path — an explicit `runtimenode.detach`, the only writer of that column per [Plan-003 T3.7](../../plans/003-runtime-node-attach.md)) **or** its `runtime_node_presence.health_state` reads `offline` (the non-cooperative path — a crashed or powered-off host calls no detach, so the [Plan-003 T3.6](../../plans/003-runtime-node-attach.md) staleness sweep's `> 60s` verdict is the only departure signal it ever emits), in which case the write re-binds the row and re-baselines the sequence (terminal-host migration; monotonicity is per-producer). The second disjunct is load-bearing rather than belt-and-braces: without it the hatch is **unreachable** for a dead host, so no successor terminal host's publish is ever accepted and the projection can never advertise the true holder again — the dead-holder lockout `Spec-003 §Required Behavior` forbids, on the **presence** axis that clause already names ("the holder's presence/attachment drop frees it — no dead-holder lockout"). The predicate **reads** `health_state` and derives nothing, so the T3.6 sweep remains the single liveness-derivation writer (the stance the roster read above takes), and it binds at `offline` **and nothing weaker** — `degraded` is the deliberate reversible hysteresis band per `Spec-003 §Default Behavior`, so re-binding on it would flip the recorded producer for a node that returns inside the band; a node with no `runtime_node_presence` row at all (none exists until its first heartbeat) satisfies neither disjunct and the hatch stays closed, fail-closed. The rule is symmetric on the old host's return: its publishes are refused on `node_id` mismatch until **its** hatch condition holds, so exactly one producer is recorded at any instant and the projection never flaps between two hosts; and (3) `transitionSeq` exceeds the stored value — an equal-or-lower sequence is acknowledged (`null`) and discarded, never applied, so a delayed transport retry of an older transition (a take retried after its release, an auto-clear racing a re-take) cannot resurrect a stale `controlHolder` over newer state. Violations of (1) or (2) are refused as unauthorized with no lease-row write; the roster projection therefore cannot diverge from the daemon-enforced lease through a stale, non-owning, or no-longer-authorized caller. Condition (2)'s hatch rides **inside** the statement too (2026-08-03 amendment, closing a review-found TOCTOU — the prior text evaluated it above the statement): the `DO UPDATE … WHERE` different-node disjunct is `node_id <> EXCLUDED.node_id AND <recorded-producer-departed>`, where the departure predicate consults the **recorded** row's node — `NOT EXISTS` an active `runtime_node_attachments` row for it, `OR EXISTS` its `runtime_node_presence` row reading `offline` — under the conflicting row's lock in the same snapshot as the write ([shared-postgres-schema.md §Session Terminal Lease](../schemas/shared-postgres-schema.md#session-terminal-lease-plan-024) carries the statement form). A probe-then-write split is exploitable in both directions the single statement closes: two successors racing a dead producer serialize on the row lock and the second re-evaluates against the first's committed re-bind (refused — the new recorded producer is live), and a returning former producer's delayed publish evaluates against the successor's row and is refused while the successor is live. Every refusal is therefore a **zero-row outcome that must be classified in-transaction** across its three causes: re-read and distinguish a merely-stale `transitionSeq` (acknowledged `null` and discarded per (3), the retry-safe arm), a failed (1) predicate (the unauthorized refusal), and a refused (2) re-bind (the recorded producer is still live) — never collapsing them, which would either silently swallow an authorization failure as a successful ack or surface a benign retry as a refusal. This is the same re-read-and-classify discipline the §Signing-Key Registration Method Registry states for its own zero-row arm; only the discipline transfers, not the arms (that surface discriminates insert-winner from byte-equal stored key). A refusal here costs projection freshness only, never terminal-write correctness: write authority is daemon-local and the daemon gates the write frame before it ever publishes ([Plan-024 I-024-9](../../plans/024-rust-pty-sidecar.md)).

**Roster-read liveness suppression on `controlHolder` (Plan-024 CP-024-5 audit delta, Codex PR #283 rounds 2-3, 2026-08-02/03 — replacing the round-1 write-side backstop, withdrawn; the write-side half of the dead-producer closure is condition (2)'s `offline` re-bind disjunct above).** The producer-bound conditions above leave one case needing more than the write path alone. When the recorded producer's own attachment leaves the active set, condition (1) refuses that node's publishes until it re-attaches — a reconnecting daemon converges (condition (1) tests for A live attachment on `(nodeId, sessionId)` and pins no `attachmentId` — a contrast the sibling §Signing-Key Registration Method Registry below carried until the 2026-08-11 admission-time registration decoupling deleted its attachment predicates outright; this registry's attachment gate is its own producer binding and stays) — but a producer that never returns (host crash, machine powered off) never republishes at all; condition (2)'s `offline` re-bind disjunct (the 2026-08-03 Spec-003 projection-conformance amendment) lets a successor terminal host take the row over, yet re-binding requires a successor to volunteer, so while none does, a lease held at the moment of loss would stay advertised on the roster indefinitely, contrary to [Spec-003 §Required Behavior](../../specs/003-runtime-node-attach.md#required-behavior)'s disconnect auto-release. The repair is a READ-side predicate, not a second writer: `RuntimeNodeRosterResponse.controlHolder` resolves to `null` whenever the lease row's recorded `node_id` carries `runtime_node_presence.health_state = 'offline'`, and the projection row itself is never touched. Round 1 of this delta specified the opposite — a server-side holder clear applied in the same transaction that moves a `runtime_node_attachments` row out of the active set — and that transaction does not exist for the motivating case: a crashed or powered-off host calls no `runtimenode.detach`, and Plan-003's heartbeat staleness sweep transitions `runtime_node_presence.health_state` (`degraded`, then `offline`), never `runtime_node_attachments.state`, which moves only on the explicit detach path ([Plan-003 §Phase 3](../../plans/003-runtime-node-attach.md) T3.6 vs T3.7). The presence transition is the ONLY server-derived signal a departed producer emits, so it is the signal the repair must bind to. Five properties make the read-side form correct where the write-side one was not. (a) **It consumes a derived verdict rather than deriving one:** the roster read already LEFT JOINs `runtime_node_presence` to carry each node row's `healthState` and `lastHeartbeatAt`, and the predicate reads that stored `health_state` column while comparing no timestamps — so Plan-003's heartbeat sweep stays the single liveness-DERIVATION writer and this read derives no staleness of its own, the constraint the roster-read contract imposes. It is the shape of the sibling `readOnly` field this read already resolves per row from stored columns. (b) **It suppresses at `offline` and nothing weaker,** so the response cannot contradict itself: the producing node's `healthState` is returned verbatim in the same payload, and `online` / `degraded` producers keep advertising their holder — suppressing a reachable holder would be a worse lie than showing one. A node attached but not yet heartbeated (`health_state` NULL) likewise keeps it: the lease row exists only because that producer published under a live attachment, so it was reachable, and its first heartbeat is at most one heartbeat cadence away. (c) **The single-writer model is restored intact:** `session_terminal_leases` takes writes from the terminal-owning daemon's publishes alone (plus the `ON DELETE SET NULL` erasure backstop in the [schema write model](../schemas/shared-postgres-schema.md#session-terminal-lease-plan-024)). Because no row is written, `node_id` and `transition_seq` are untouched BY CONSTRUCTION — there is no server-mutated state for a returning daemon to disagree with, so its republish of the same snapshot at the same sequence is the ordinary acknowledged-and-discarded case and the roster is already correct without it. Plan-024 authors nothing inside a Plan-003 write path. (d) **It authors no `pty.control_changed`, and needs none** — nothing transitioned, a read authors no events, and the departed daemon is that stream's sole author ([ADR-017](../../decisions/017-shared-event-sourcing-scope.md)). (e) **Recovery needs no repair write:** when heartbeats resume the sweep restores `health_state` and the same read advertises the holder again; if the producer instead returns having released the lease, its republish lands the release at a higher `transitionSeq` through the ordinary monotonic path; and if a successor re-bound while it was gone, the returning host's republish is refused on condition (2) — the successor is now the recorded producer — and its holder claim ended with that re-bind. What the suppression does NOT do is revoke anything. Write authority is daemon-LOCAL per Plan-024 I-024-9, so a holder on a host merely partitioned from the control plane — alive, reachable by its own local writers — keeps its lease and keeps writing, because nothing here reaches its daemon-local lease record. Spec-003's auto-release on holder disconnect is discharged by the daemon in every case where a daemon survives to discharge it; this predicate covers only the residue — a host that is gone, where the daemon-local record went with it and the roster is the sole surviving surface.

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

**Publisher credential source and auth posture (Plan-024 CP-024-5, 2026-08-02).** The daemon publishes `runtimenode.leaseupdate` as the node-owner participant through the constructor-injected `DaemonCredentialProvider` (Plan-006 T3.3, the CP-006-13 shape), minted per attempt. Like the sibling §Signing-Key Registration Method Registry below, an auth failure here is a RETRYABLE TRANSPORT failure on a bounded backoff and blocks no Tier-4 code: the provider is Tier-5-dormant until Plan-018's PASETO wiring, so through Tier 4 `session_terminal_leases` is expected-empty and the `runtimenode.roster` `controlHolder` join expected-null. Write gating never depends on it — the terminal-owning daemon refuses off its daemon-local lease record per Plan-024 I-024-9. Because the request body is a SNAPSHOT of that record and this registry's upsert is monotonic in `transitionSeq` and idempotent, a dropped publish is repaired by the daemon republishing current state on backoff or reconnect rather than by any server-side REPLAY of missed transitions — so servers MUST tolerate a republish carrying an already-applied `transitionSeq` as the acknowledged-and-discarded case this registry already specifies, and MUST NOT treat it as a duplicate-submission error. Republication covers every case in which the producer returns; the one case it cannot reach — a producer that never comes back — is closed on the WRITE side by condition (2)'s `offline` re-bind disjunct (a successor host's publish lands once the recorded producer is server-classified offline — the 2026-08-03 Spec-003 projection-conformance amendment) and at the READ surface by the roster liveness suppression specified in the upsert-contract paragraph above, which resolves `controlHolder` to null while the producing node is `offline` and no successor has re-bound, writing nothing (Codex PR #283 rounds 2-3). A PERMANENTLY refused credential (the node-owner participant suspended or revoked — no retry can revalidate it) converges through the same decay rather than through retries: the daemon's heartbeats refuse identically, the Plan-003 staleness sweep classifies the node `offline` within its `> 60s` bound, and the suppression plus the re-bind hatch take over — while the clear itself needs no live membership at all, a `controlHolder: null` publish being attachment-gated only per the upsert contract's direction-asymmetric exemption, precisely the removed-holder force-clear case (Codex PR #283 round 3).

Refusals are typed in [Error Contracts §PTY](./error-contracts.md#pty): role authorization precedes lease state — `session.takeControl` is owner/collaborator-only per the [Security Architecture permission matrix](../security-architecture.md#permission-matrix-task-54) row 'Take terminal control', refused `pty.permission_denied` (403) for viewers and runtime contributors before any lease-state comparison — the refusal is role-determined and stable rather than varying with mutable lease state; holder identity itself is deliberately session-visible presence metadata (the `pty.control_changed` broadcast and the roster's `controlHolder` expose it to every participant, viewers included), so the ordering guards the authorization boundary, not a secret (release is holder-gated, not role-gated — a holder stripped of authorization mid-hold can still relinquish during the signal-propagation window, and the membership transition itself force-clears the lease on arrival at the lease authority per Spec-003); a take while another participant holds the lease returns `pty.control_held_by_other` with `data.fields.holderParticipantId`; a terminal write with no lease held returns `pty.control_not_held`. A release by a non-holder is likewise `pty.control_not_held` (releasing nothing is not idempotent-success — it signals a caller-state bug); a take by the current holder is idempotent success — no transition occurs and nothing broadcasts. Every successful transition broadcasts `pty.control_changed` ([Spec-006 census](../../specs/006-session-event-taxonomy-and-audit-log.md#pty-control-session_lifecycle)), authored by the terminal-owning daemon; transitions include the three auto-release classes — holder disconnect, holder authorization loss (role change out of the authorized set, suspension, or revocation), and the agent-run write-burst release (the acquiring run's first lifecycle transition out of `running` after an agent-path take; the acquiring surface and run id are daemon-local lease-record bookkeeping, never a request field, re-bound to the new run on an agent-path take from a different run of the same participant (no broadcast — holder unchanged); `reason: 'auto_released_disconnect' | 'auto_released_authorization_lost' | 'auto_released_run_idle'`, `Spec-003 §Required Behavior`). Neither request carries a caller-participant field — the principal binds per the V1 transport rule: local daemon JSON-RPC callers bind to the daemon's recorded **node-owner participant** — the same absent-actor rule `ApprovalResolveRequest.approver` documents (absent on the local socket → the daemon's owner binding; every runtime node has exactly one owning participant per [runtime-node-model](../../domain/runtime-node-model.md)) — and the node's own agent runs take and release through the daemon's in-process lease authority under the **same node-owner participant identity** (no wire hop; agents are `AgentId`-keyed domain actors, not `participants` rows, so no distinct agent-participant exists to hold — the owner authorized those runs on their node, the holder surfaces stay `ParticipantId`, an owner-vs-own-agent take is the idempotent self-retake case, and per-surface attribution rides the adjacent run/agent events on the timeline, not the lease record). A future relay-borne remote leg binds the relay peer's PASETO-verified `sub` ([§Authenticated Principal And Authorization Model](#authenticated-principal-and-authorization-model)) and rides the terminal-byte channel per Spec-003's forward constraint — so `controlHolder`, the idempotent self-retake comparison, and the non-holder-release refusal are well-defined on every path that can reach the lease authority.

### Signing-Key Registration Method Registry (Tier 4, Plan-006 T4.10)

The per-event daemon-signature verification protocol ([Security Architecture §Per-Event Daemon Signature](../security-architecture.md#per-event-daemon-signature)) resolves the emitting daemon's Ed25519 PUBLIC key by `NodeId` from the session participant roster. This registry is that roster's signing-key surface: the daemon registers its session-scoped public key (the value `DaemonSigningKeyProvisioner.create(sessionId)` returned, or its row-verified `readPublicKey` re-read after a restart) — a registration that lands at ADMISSION TIME, with no attach precondition since the 2026-08-11 admission-time registration decoupling (the [Spec-008 §Peer History Backfill On Join (V1)](../../specs/008-control-plane-relay-and-session-join.md#peer-history-backfill-on-join-v1)-pinned leg, landed by Plan-008's restoring targeted readiness-audit delta jointly with the Plan-006-owned T4.10 surface, PR #323), the write being membership-gated and bound to the daemon-held CP-006-13 credential — via `runtimenode.signingkeyregister`, persisting register-once into the Plan-006-owned [`daemon_signing_public_keys` table](../schemas/shared-postgres-schema.md#daemon-signing-public-keys-plan-006--verification-key-roster); any verifier — peer daemon, forensic export, control-plane-connected client — resolves keys via `runtimenode.signingkeyroster`. Both methods are **control-plane tRPC ONLY** (the store is control-plane-owned cross-node state, the `runtimenode.roster` reasoning; the register mutation is **daemon-called**, the `runtimenode.leaseupdate` shape). Registered by Plan-006 T4.10 per CP-006-7 leg B / CP-003-5 (2026-07-29): the procedure-key registrations on the shared `runtime-node-router.factory.ts` builder, the two `runtimeNodeClient.ts` typed pass-throughs, and the four additive `runtime-node.ts` schema exports are CP-003-5's complete sanctioned Plan-003 seam-edit set (CP-003-6 registered a fourth crossing — the renderer `attachmentId` forward — under the same shape 2026-08-01, RETRACTED 2026-08-11 with the delivery machinery when the decoupling deleted the `attachmentId` predicate), and the register/resolve service is the Plan-006-owned sibling `signing-key-service.ts` — deliberately **new procedures rather than an attach-request field**, because every shipped `runtimenode.*` request/response schema is `.strict()`, so an added member would break the new-daemon→old-control-plane skew direction at parse ([ADR-018 §Decision](../../decisions/018-cross-version-compatibility.md#decision) #7 bidirectional-MINOR); a new daemon calling an old control plane instead receives tRPC `NOT_FOUND` and degrades honestly (its uploaded anchors stay emitter-only-verifiable until the control plane upgrades — the procedure's absence is the discovery signal — and the daemon-side registrar re-attempts on a bounded exponential backoff capped at [Spec-003 §Required Behavior](../../specs/003-runtime-node-attach.md#required-behavior)'s 15-second heartbeat-cadence constant for the locally-materialized session's lifetime, so a mid-session upgrade converges to registered without a daemon restart). The registrar starts at the daemon-local session-establishment moment — `runtimenode.attach` is client-driven and the daemon is never a party to it, so no post-attach hook exists in the registrar's process — and publishes through a thin PASETO-authenticated tRPC caller deliberately scoped to `runtimenode.signingkeyregister` (the Plan-024 T-024-3B-3 `leaseupdate` single-procedure-caller precedent; the daemon takes no `client-sdk` dependency), authenticating as the **node-owner participant** — the daemon's standing control-plane-authentication posture per [component-architecture-local-daemon.md §Responsibilities](../component-architecture-local-daemon.md#responsibilities) ("authenticate to the Collaboration Control Plane using PASETO v4 tokens per Spec-008") — with a PASETO v4.public access token whose per-request DPoP proof is signed by a daemon-held key the token's `cnf.jkt` binds ([§Authenticated Principal](#authenticated-principal-and-authorization-model)), obtained per attempt through the constructor-injected credential-provider interface CP-006-13 registers against Plan-018's Tier-5 PASETO wiring (Codex PR #274 round 4, 2026-07-31: the token's issuance-into-the-daemon path is specified by no V1 document today — the same Tier-5 gate the production `resolveCurrentParticipantId` stub already imposes on every shipped `runtimenode.*` procedure — so an auth failure is a retryable transport failure on the backoff and no Tier-4 code is blocked), retrying the collapsed `runtimenode.permission_denied` refusal on the same backoff — since the 2026-08-11 decoupling it covers membership convergence alone (an inactive or not-yet-admitted membership; no attach is awaited), so the registrar converges once the caller's membership is active (Codex PR #274 rounds 3–4, 2026-07-31; the attach-race arm retired with the attachment predicates). The attempt presents NO `attachmentId` (2026-08-11 admission-time decoupling): the request member, the `event.deliverAttachmentId` delivery method with its `EventDeliverAttachmentIdRequestSchema` / `EventDeliverAttachmentIdResponseSchema` contracts pair, the daemon's durable `daemon_attachment_deliveries` store, and the AttachFlow attach-success forward with its `daemon.status` reconnect replay (the CP-006-14 / CP-003-6 legs, both RETRACTED) are all deleted rather than shipped — the registrar's `nodeId` instead reads the daemon's own shipped Plan-003 Phase-2 node registry (`node_trust_state`), populated at daemon startup before any session materializes, so the attempt preconditions are the credential and the daemon's node identity, both daemon-local. **Scope note (Codex PR #284 round 3; closed 2026-08-11):** the attach-bound landing confined this registry to attached execution nodes, while [Security Architecture §Per-Event Daemon Signature](../security-architecture.md#per-event-daemon-signature) requires roster registration at join time — a never-attached member daemon authors durable rows ([Spec-006 §User Message Events](../../specs/006-session-event-taxonomy-and-audit-log.md#user-message-events)'s `user.message`) that no roster key would have covered. The admission-time registration decoupling (landed by Plan-008's restoring targeted readiness-audit delta jointly with the Plan-006-owned T4.10 surface, PR #323) removed the attach precondition, so registration fires for every locally-materialized session — chat-only member daemons included — restoring the at-join-time contract as specified behavior; the unrostered-origin honesty arm of [Spec-008 §Peer History Backfill On Join (V1)](../../specs/008-control-plane-relay-and-session-join.md#peer-history-backfill-on-join-v1) remains the degrade for a node registered under no roster key (pre-roster software), not a structural gap for unattached members.

The register upsert is **producer-bound and register-once**, the `runtimenode.leaseupdate` authorization shape: the control plane applies a write only when (1) the caller's verified PASETO `sub` holds a `state = 'active'` `session_memberships` row for the session (any role; Codex PR #274 round 4, 2026-07-31 — suspension and revocation strip live capabilities per the Permission Matrix posture, so without this predicate a revoked owner's daemon could keep minting durable, erasure-durable roster rows) — since the 2026-08-11 admission-time registration decoupling this is the SOLE authorization predicate: the attachment-ownership and `attachmentId`-equality predicates this arm carried 2026-08-01–2026-08-11 were DELETED with the attach precondition (no attachment row exists at admission time to check), and the producer binding is the daemon-held CP-006-13 credential itself — a PASETO v4.public access token whose per-request DPoP proof a daemon-held key signs under the token's `cnf.jkt` — which binds at PARTICIPANT granularity, never node granularity (`cnf.jkt` is replay-protection material, not a second principal). That is an accepted, NAMED WIDENING recorded by the decoupling: with one participant owning two live daemons, either sibling's registrar can now mint the other's slot in one honest-looking call, where the prior `attachmentId` equality forced a loud two-call attach-usurpation footprint. Register-once plus the durable `signing_key_slot_conflict` alarm (below) remain the detection, and the non-forgeable node-identity credential is the [cross-plan-dependencies.md §5](../cross-plan-dependencies.md#5-canonical-build-order) V1.1 Plan-018/Plan-003 closure, absorbed when it lands through CP-006-13's credential-class-agnostic seam; a caller failing the predicate — inactive or absent membership, or a nonexistent session, all collapsed — is refused with the typed `runtimenode.permission_denied` error ([error-contracts.md §Runtime Node](./error-contracts.md#runtime-node) — HTTP 403 / tRPC `FORBIDDEN`, one collapsed refusal disclosing neither attachment existence nor session existence nor ownership, per that family's no-info-leak header, and deliberately never tRPC `NOT_FOUND`, which this namespace reserves as the old-control-plane procedure-absence discovery signal the registrar's retry contract discriminates on) before the floor or key comparison is reached — an unauthorized caller never reaches a key-existence oracle; (2) the request-carried self-declared `clientVersion` satisfies the session's current `min_client_version` floor — key registration is a version-sensitive domain write per [Spec-003 §Required Behavior](../../specs/003-runtime-node-attach.md#required-behavior); no attachment row exists at admission time to consult, so the check reads the request member, the same self-declared trust class `RuntimeNodeAttachRequest.clientVersion` itself carries (attach-parity trust — I-003-1's admit-read-only posture is preserved, and the declared value cannot change within one daemon process lifetime, so a below-floor park releases only on daemon upgrade + restart) — and a below-floor daemon is refused `version.floor_exceeded` (the [error-contracts.md §Version](./error-contracts.md#version) surface-3 code+message form) before any row write, while `runtimenode.signingkeyroster` — a read — carries no floor check; and (3) the `(session_id, node_id)` pair is unregistered, OR the presented key byte-equals the stored one (an acknowledged idempotent no-op — the retry-safe re-attach path). A registration presenting a **different** key for a registered pair is refused with the typed `runtimenode.signingkeyregister_conflict` error ([error-contracts.md §Runtime Node](./error-contracts.md#runtime-node) — HTTP 409 / tRPC `CONFLICT`, registry-only code+message) and no row write — never a silent overwrite; V1 ships no daemon signing-key rotation ceremony, so refusal IS the rotation policy (the control-plane mirror of Plan-006 T4.2's `refuse_on_rotation`; [Security Architecture §Per-Event Daemon Signature](../security-architecture.md#per-event-daemon-signature)). Register-once cuts both ways (round 5, 2026-08-01): with no rotation ceremony, a wrong FIRST registration is permanent for the session's life, so the genuine daemon's 409 is an integrity alarm, not a caller bug — its slot holds a key it never minted (a same-participant sibling registered first, or its own key store was lost and re-minted). The refused daemon therefore appends the durable `audit_integrity_failed` event with the round-5 `failureMode: 'signing_key_slot_conflict'` ([Spec-006 §Audit Integrity](../../specs/006-session-event-taxonomy-and-audit-log.md#audit-integrity-audit_integrity)) to its session event log — session-visible and anchor-covered — rather than holding only a local log line; scoped at Codex PR #276 round 2 (2026-08-01, correcting this sentence's prior "so the parties whose verification the usurped slot breaks can detect it"): the alarm row is signed with the very key the roster refused, so roster-resolving external verifiers see it only as one more `signature_mismatch` among every row this daemon signs — the durable append serves local replay, the anchor-covered post-repair forensic record (authenticatable once the refused daemon's true key is established out-of-band), and operator surfacing, while the independently verifiable trust path for the conflict is the open design item recorded at [Spec-006 §Audit Integrity](../../specs/006-session-event-taxonomy-and-audit-log.md#audit-integrity-audit_integrity)'s sixteenth-mode prose. The three checks and the write are ATOMIC (Codex PR #274 rounds 3–4, 2026-07-31; the attachment level was deleted by the 2026-08-11 decoupling) — one transaction at READ COMMITTED closes all three TOCTOU windows: the session row is read `FOR SHARE` and held to commit, taken explicitly FIRST because the final INSERT's `session_id` FK acquires an implicit `FOR KEY SHARE` on `sessions` ([PostgreSQL 9.3 release notes §Locking](https://www.postgresql.org/docs/release/9.3.0/) — "foreign key checks use the new KEY SHARE lock mode"; the introducing release note is the direct primary statement, which the current-docs pages do not restate) and the canonical order forbids skipping a level a later statement acquires implicitly (`FOR SHARE`, not `FOR KEY SHARE`, because a future floor raise's `UPDATE` takes `FOR NO KEY UPDATE`, which only the former conflicts with per the row-lock conflict matrix, [PostgreSQL §13.3.2 Row-Level Locks](https://www.postgresql.org/docs/current/explicit-locking.html#ROW-LOCK-COMPATIBILITY) — so a floor rise cannot slip between check and write); the caller's `session_memberships` row is read `FOR SHARE` at level 2 of the canonical order (round 4: `FOR SHARE` is the weakest mode conflicting with the `FOR NO KEY UPDATE` a `MembershipService` suspend/revoke `UPDATE` acquires, so a revocation cannot commit between the authorization read and the key INSERT — an unlocked probe would let stale authorization mint the durable row; this is an authorization READ, so Plan-003 I-003-3 is untouched: the transaction writes nothing to `session_memberships`); the floor comparison runs in TypeScript (semver `MAJOR.MINOR` compares lexicographically wrong in SQL); and register-once applies as `INSERT ... ON CONFLICT (session_id, node_id) DO NOTHING` with in-transaction classification of the zero-row arm ([INSERT §ON CONFLICT Clause](https://www.postgresql.org/docs/current/sql-insert.html#SQL-ON-CONFLICT) — `DO NOTHING` "simply avoids inserting a row" and `RETURNING` returns "only rows that were successfully inserted or updated", so the zero-row arm is the loser's signal) — byte-equal stored key is the idempotent success, a different key throws the typed conflict — so a raw `23505` is never RAISED rather than caught: the `Querier` contract has no SAVEPOINTs, a raised unique violation aborts the transaction ("`ROLLBACK TO` is the only way to regain control of a transaction block that was put in aborted state by the system due to an error" — [PostgreSQL Tutorial §3.4 Transactions](https://www.postgresql.org/docs/current/tutorial-transactions.html)), and every subsequent command fails `25P02 in_failed_sql_transaction` ([PostgreSQL Appendix A — Error Codes](https://www.postgresql.org/docs/current/errcodes-appendix.html#ERRCODES-TABLE): `23505 unique_violation`, `25P02`) — no legal re-read. Two racing different-key registrations therefore resolve to exactly ONE stored key (round 4, correcting the round-3 clause that claimed both racers receive the 409): the INSERT winner returns the `null` success, while the zero-row loser's in-transaction re-read — a new statement, and Read Committed "starts each command with a new snapshot that includes all transactions committed up to that instant" ([PostgreSQL §13.2.1 Read Committed Isolation Level](https://www.postgresql.org/docs/current/transaction-iso.html#XACT-READ-COMMITTED)), so it legally sees the winner's committed row — classifies the stored different key into the typed 409: one success plus one 409, the shape T4.10's concurrency test asserts, never a raw `23505`. The lock order is registered in [cross-plan-dependencies.md §Lock Ordering Across Shared Tables](../cross-plan-dependencies.md#lock-ordering-across-shared-tables). The roster query is floor-free but NOT authorization-free (Codex PR #274 rounds 3–4, 2026-07-31): [§Authenticated Principal](#authenticated-principal-and-authorization-model) scopes every control-plane endpoint — queries included — to its authenticated caller, so `runtimenode.signingkeyroster` requires the caller's verified principal to hold an ACTIVE `session_memberships` row for the session (any active role — the Permission Matrix read posture, viewers included), refused with the same typed `runtimenode.permission_denied` (403). The membership check and the roster read are ONE SQL statement — a single-row membership-predicate anchor (`EXISTS` over the caller's membership) LEFT-JOINed to `daemon_signing_public_keys` — because two separate statements at READ COMMITTED take two snapshots, letting a revocation commit between probe and read and hand a just-revoked caller a roster newer than their authorization (round 4); one statement is one snapshot ([PostgreSQL §13.2.1 Read Committed Isolation Level](https://www.postgresql.org/docs/current/transaction-iso.html#XACT-READ-COMMITTED)), so the authorization and the returned entries are atomic WITHOUT a lock — a read-path `FOR SHARE` on the membership row would serialize the revoker behind readers while making no reader's answer fresher (the shipped `readRoster` single-statement principle; the BL-141 campaign design's `readRoster` decision — superseded by ADR-025 Reading 1's uniform 403 — prescribed a locked transaction where its uniform-`404` negative required a `sessions` read — this surface's `403` collapse reads no `sessions` row, so the snapshot alone closes the race). The statement never reads `sessions`: a non-member of a real session and a caller naming a nonexistent session yield the identical false membership flag and byte-identical refusals, and the refusal path inspects no key column; a member of a session with no registered keys gets the anchor row with NULL key columns — `{ entries: [] }` — so empty and denied stay distinguishable. Each entry's `registeredAt` normalizes through the `readRoster` `toIsoString` convention before the response parse (round 4): `TIMESTAMPTZ` hydrates as a JS `Date` under both shipped drivers (`pg`, PGlite) while the wire field is an ISO-8601 string whose `z.iso.datetime({ offset: true })` schema REJECTS a `Date`, so the T4.10 roster test runs against a real PGlite database through the response schema — exercising the hydration path rather than mocking it away. Primary sources for those three claims (round 5, 2026-08-01, each verified at content level): `pg` delegates result parsing to `pg-types`, whose [`lib/textParsers.js`](https://github.com/brianc/node-pg-types/blob/master/lib/textParsers.js) registers OID `1184` (`timestamptz`) to the `Date`-returning `postgres-date` parser (`register(1184, parseTimestampTz)` where `parseTimestampTz = require('postgres-date')`); PGlite's parser for the timestamp family is `parse: (x) => new Date(x)` in [`packages/pglite/src/types.ts`](https://github.com/electric-sql/pglite/blob/main/packages/pglite/src/types.ts); and [Zod §ISO datetimes](https://zod.dev/api#iso-datetimes) documents `z.iso.datetime()` as ISO-8601 STRING validation, so a `Date` instance fails its string precondition before any format check. No operator arm exists on this transport in V1 — the recorded residual against the reader list above: a "forensic export" reader reaches the roster through a session-member principal (or direct database access under the operator's own custody), never an ungated query. The store deliberately carries no participant FK — key material is machine-generated, carries no personal data, and sits outside the [Spec-022 §Shred Fan-Out](../../specs/022-data-retention-and-gdpr.md#shred-fan-out) Path-2 `REFERENCES participants(id)` closure, so registered keys SURVIVE participant erasure and the retained crypto-shredded `runtime_node.*` stream plus `event_log_anchors` rows stay verifiable.

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `runtimenode.signingkeyregister` | `mutation` | `RuntimeNodeSigningKeyRegisterRequest` | `null` — HTTP 200 `{ result: { data: null } }`; `RuntimeNodeSigningKeyRegisterResponseSchema` (`z.null()`) — control-plane tRPC ONLY, **daemon-called** from the session-establishment registrar, landing at session admission with no attach precondition (2026-08-11 decoupling; membership-gated + daemon-credentialed + register-once per the contract paragraph above; no daemon JSON-RPC registration; Plan-006 T4.10) |
| `runtimenode.signingkeyroster` | `query` | `RuntimeNodeSigningKeyRosterRequest` | `RuntimeNodeSigningKeyRosterResponse` — control-plane tRPC ONLY (the roster is control-plane-owned cross-node state; Plan-006 T4.10) |

```ts
// RuntimeNodeSigningKeyRegister — control-plane tRPC ONLY, daemon-called from the session-establishment
// registrar, landing at session admission with no attach precondition (Plan-006 T4.10 per CP-006-7 leg B / CP-003-5;
// membership-gated + daemon-credentialed — the attachment predicates were deleted by the 2026-08-11 admission-time decoupling)
interface RuntimeNodeSigningKeyRegisterRequest {
  sessionId: SessionId;
  nodeId: NodeId;
  clientVersion: EventEnvelopeVersion; // semver "MAJOR.MINOR" (ADR-018 §Decision #1) — request-carried self-declared floor input, the same trust class RuntimeNodeAttachRequest.clientVersion carries (attach-parity); no attachment row exists at admission time to consult (2026-08-11 admission-time decoupling — the attachmentId member this interface carried 2026-08-01–2026-08-11 was deleted with the attach precondition)
  daemonSigningPublicKey: string; // 64-char lowercase hex of the 32-byte Ed25519 public key (the Plan-006 T2.3 wire convention); hex-decoded to BYTEA at persist
}
// Response: null — HTTP 200 { result: { data: null } } (RuntimeNodeSigningKeyRegisterResponseSchema = z.null(),
// the heartbeat/detach/leaseupdate pattern). A same-key replay is acknowledged null too (register-once, retry-safe);
// a different-key registration is refused with typed runtimenode.signingkeyregister_conflict (409/CONFLICT) and no row write;
// a below-floor daemon's registration is refused version.floor_exceeded (Spec-003 version-sensitive-write
// rule, read from the request-carried self-declared clientVersion — no attachment row exists at admission time);
// a caller without an ACTIVE session membership (inactive or absent membership,
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
// to make silent-replacement structurally inexpressible per Spec-005 §Fallback Behavior.
// `getCapabilities` returns the `GetCapabilitiesResult` wrapper (defined below) so the
// per-tool `ProviderToolMetadata[]` rides alongside the flag matrix in a single
// round-trip per Plan-005 Phase 4 ratified design.
// Within the Zod-validated surfaces, `ProviderToolMetadata` STRIPS unknown keys (Spec-005
// §Default Behavior forward-compat: "Unknown capability fields are ignored (tolerant
// reader)" — campaign B3 re-framed contractVersion as change-detection, not negotiation),
// while the result envelopes reject unknown keys (`.strict()`);
// and all seventeen untrusted provider-output free-form strings (`ProviderToolMetadata.name`/`.description`,
// `DriverInterventionResult.fallbackAction`, `DriverResumeResult.bindingId`/`.providerFailureDetail`,
// `DriverRollbackResult.fallbackAction`/`.bindingId`, `DriverGoalResult.fallbackAction`,
// `DriverAuthProbeResult.detail`, `CallbackToolInvocation.toolName`/`.toolCallId`,
// `McpServerStatusEmission.serverName` — the last three added by campaign B10, Codex rounds 4–5 —
// and `ProviderCommandEntry.name`/`.description`/`.scope` plus
// `ProviderOutputSpeedState.declared`/`.reason`, the five added 2026-08-29 with the console-parity
// surfaces: both shapes are built from provider- or skill-authored metadata at the driver's own
// normalize boundary and both travel to a client, so an unbounded one is an arbitrarily large
// IPC response and renderer workload) —
// each on a Zod-validated result envelope, `ProviderToolMetadata`, or a driver-normalized
// seam shape (`CallbackToolInvocation` / `McpServerStatusEmission` / `ProviderCommandEntry` /
// `ProviderOutputSpeedState`) below —
// are runtime-bounded (length + non-whitespace + NUL-rejection) via the package's `wireFreeFormString`
// helper — Zod constraints not expressible in these TS interface shapes.
// SHIPPED SUBSET vs CANONICAL SET (2026-08-29; discharged 2026-08-31). `packages/contracts/src/provider-driver.ts`
// realized the TWELVE pre-amendment strings when this note was written; Plan-005 T3.26 (PR #388,
// merged 2026-08-31) landed the `ProviderCommandEntry` and `ProviderOutputSpeedState` producers and
// carried the file's own count claim to SEVENTEEN, so the file now realizes this enumeration in
// full — the "twelve" its comments still name counts the twelve provider-boundary LENGTH CAPS
// (twelve caps cover seventeen fields because four are reused across surfaces), a different census
// that never competed with this one. The owed leg still open at this annotation (2026-08-31) is
// T4.9's SDK-seam schemas for the two console-parity verbs, under the same named-owner discipline:
// T4.9 EXTENDs that file.
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
  // Render the run's canonical transcript into this provider's replay frames (2026-08-26,
  // ADR-029; Spec-005 §Canonical Transcript Export And Replay). Pure with respect to session
  // state: it mutates nothing, writes nothing, and starts no turn.
  exportTranscript(params: ExportTranscriptParams): Promise<DriverTranscriptExportResult>;
  // Reconstitute a conversation into a FRESH provider session from exported frames. Gated on the
  // `transcript_replay` flag and never writes to the SOURCE session; returns only after the
  // post-replay assertion passes. A driver whose provider refuses prior-turn content declares the
  // flag `false`, and the daemon falls back to the memo projection instead of calling this.
  replayTranscript(params: ReplayTranscriptParams): Promise<DriverTranscriptReplayResult>;
  // Ask the provider to compact the bound session's OWN context, on a participant's explicit
  // request and never on a threshold, timer, or heuristic (2026-08-29, Spec-005 §Participant-
  // triggered context compaction). Gated on `context_compaction`. It SETTLES on the provider's
  // typed compaction evidence — the frame that already produces usage.context_compacted — and
  // NEVER on the request being accepted: the Codex method answers an empty ack and the Claude leg
  // is a driver_command frame that only settles, so acceptance is evidence of delivery and of
  // nothing else. There is deliberately NO prompt-injected emulation arm; a driver that cannot
  // compact declares the flag false and the call refuses as driver.capability_unsupported.
  // The wait for that evidence is BOUNDED and has TWO terminals (2026-08-29): the driver's own
  // declared per-binding compaction bound, and the run's provider binding ceasing to be live —
  // whichever lands first ends the wait, so a provider that acknowledges and then produces no
  // frame, or exits mid-compaction, cannot hold the operation open indefinitely. Expiry settles
  // `failed`, never `applied`. Late evidence is NOT lost: a compaction frame arriving after the
  // wait ended normalizes into usage.context_compacted exactly as an unsolicited provider-initiated
  // compaction does, so no boundary escapes Spec-004's rewind classifier.
  compactContext(params: CompactContextParams): Promise<DriverCompactionResult>;
  // Read the provider's own enumeration of native slash-commands and skills for the bound
  // session (2026-08-29, Spec-005 §The provider command and skill surface). Gated on
  // `provider_commands`. A LIVE read held as driver-session state and discarded with it: not
  // persisted, not cached across sessions, and folded into no projection — which is why this
  // capability adds no table and no column. Every entry carries the (driverName,
  // providerAccountId) it was read under, and that binding is a ROUTING INVARIANT: an entry is
  // offerable only to agents of that same binding, and the one entry V1 dispatches is dispatchable
  // only through them.
  listProviderCommands(params: ListProviderCommandsParams): Promise<ProviderCommandListResult>;
}

// Console-parity shapes (2026-08-29, Spec-005 §Desktop Console Parity Surfaces).
//
// AUTHORIZATION (both verbs, at the wire boundary — before the capability gate and before any
// driver dispatch). Neither mints a Cedar action and neither mints an error code.
//   * A caller who is not an ACTIVE participant of the named session is refused the already-
//     registered `session.not_found`, whose registered description is "does not exist or is not
//     accessible" — a non-member and an unknown session collapse into one byte-identical refusal,
//     so neither verb is a session-existence oracle (the runtimenode family's no-info-leak rule).
//   * `driver.listProviderCommands` needs nothing beyond that: any active role reads, the
//     `runtimenode.signingkeyroster` precedent.
//   * `driver.compactContext` mutates the bound run's provider context, so it is adjudicated by
//     the IDENTICAL `Action::"intervene"` evaluation the intervention path runs on the run that
//     owns the named binding — the `run.pause` / `run.resume` precedent above (§Authenticated
//     Principal And Authorization Model: that action covers interventions and those orchestration
//     verbs identically), reading the same Security Architecture permission-matrix run-control
//     row — whose subject names compaction as of 2026-08-29, so this citation lands on a row that
//     names the operation; the matrix gains NO row, which is the same claim as reusing the
//     action. It is NOT an intervention and does not widen `Spec-004`'s closed V1 control set; it
//     shares the adjudication, not the envelope. I-004-19's non-local hosting-node approval leg
//     is unreachable here BY CONSTRUCTION rather than waived: a binding this daemon holds is
//     hosted on this node, so the resolved hosting node is always local and the operation carries
//     no dependency on the per-run hosting-node carrier Plan-004 still holds open.
//   * A deny settles on the operation's own `refused` arm as `not_permitted`, never as a
//     JSON-RPC error — the way an authorization-rejected intervention rides
//     `InterventionResponseBase.rejectionReason`, and the way Spec-030 routes peer-invocation
//     denials onto the callback-tool result arms.
//
// WIRE ADDRESSING (2026-08-29). NEITHER client-facing verb takes a `bindingId`, and the daemon
// resolves the live provider binding at dispatch — the addressing `RollbackToParams` already
// specifies ("clients address the run"). This is not stylistic: no client-facing read publishes a
// `bindingId` anywhere, so a binding-addressed wire request would be unconstructible from every
// response a client can obtain, and a client that somehow held one would be holding a
// daemon-internal lifecycle identifier whose liveness it cannot check.
//
// The two verbs take DIFFERENT identifiers, each the one its own authorization and its own
// consumer already use, rather than one identifier chosen for symmetry:
//   * `compactContext` takes a RUN. It mutates that run's provider context and is adjudicated by
//     the `Action::"intervene"` evaluation on the run that owns the binding, so the run is the
//     subject of its authorization, not an addressing convenience.
//   * `listProviderCommands` takes an AGENT. It is a membership-only read whose consumer is the
//     composer, which is addressed to a target agent and re-reads when that target changes
//     (Plan-023 CP-023-8), and whose routing invariant is stated over the agent's
//     (driverName, providerAccountId) binding. Addressing it by run would force the one caller
//     that has an agent to obtain a run id it does not otherwise need.
//
// AN AGENT CAN HOLD SEVERAL LIVE BINDINGS AT ONCE, so the RESULT is discriminated rather than the
// request (2026-08-29, round-3 fold). Plan-016's admission pipeline has no one-active-run-per-agent
// gate and V1 permits concurrent runs, so `agentId` does not resolve to one binding: the agent may
// have a run per leg, and a provider switch that applied at a run boundary leaves older runs on the
// binding they spawned under. An enumeration is held per driver session and two of them can
// legitimately differ. The fix is NOT to re-address the request by `runId`: that would reverse the
// bullet above for the one caller that has an agent and not a run, and it would still not name a
// binding, since `runtime_bindings` is keyed by its own id with `run_id` on the row and run ->
// bindings is 1:many. Instead the reply carries one group PER LIVE BINDING, each naming the run it
// belongs to and the `(driverName, providerAccountId)` it was read under — the tuple a client can
// actually construct, no `bindingId` being published anywhere. The reply is therefore TOTAL under
// concurrency: a caller can never receive an arbitrary leg's commands mistaken for the agent's,
// because every entry arrives inside the group that says where it came from. Consumers MUST NOT
// flatten the groups into one list — the routing invariant is stated per binding, so a flattened
// list is exactly the lost provenance the `binding` member on each entry exists to prevent
// (`Spec-005 §The provider command and skill surface`; the composer's rule is Plan-023 T-023r-6-2).
//
// Resolution refuses in a FIXED ORDER, each on an ALREADY-REGISTERED code, so this addressing
// mints none: `session.not_found` (unknown or inaccessible session — the collapsed refusal
// above), then `run.not_found` / `agent.not_found` (no such run or agent, or not one of that
// session), then `driver.unavailable` (no live provider binding: one was never started, or the
// process is gone — which is also the honest answer for an enumeration, this being a live read
// held as driver-session state and not a catalog that outlives one). A live binding whose driver
// lacks the flag still refuses at the capability gate with `driver.capability_unsupported`,
// unchanged. A caller therefore cannot name another leg's binding at all: the class of request
// the driver-side dispatch check exists to reject is unrepresentable on the wire, and that check
// remains as the daemon-interior backstop rather than as the only one.
interface CompactContextRequest {
  sessionId: SessionId;
  runId: RunId;
}

interface ListProviderCommandsRequest {
  sessionId: SessionId;
  agentId: AgentId;
}

// The DRIVER-FACING params, composed by the daemon AFTER that resolution. They stay binding-
// addressed because run -> bindings is 1:many and the operation acts on exactly one leg; they
// cross no wire, and no client constructs one.
interface CompactContextParams {
  sessionId: SessionId;
  // Daemon-resolved at dispatch, the same per-binding addressing rollbackTo and goal delivery
  // use: run -> bindings is 1:many, so the operation names the leg it acts on.
  bindingId: string;
}

// The result of a compaction ATTEMPT, not of the request — a DISCRIMINATED UNION on `status`
// (2026-08-29), so no arm can carry a member another arm's state makes meaningless and no
// consumer has to guess which optional members its arm implies. `applied` is reachable only
// after the provider's typed compaction frame is observed, and `boundaryPosition` is REQUIRED
// there, typed `number | null` so a frame carrying no position is representable without being
// synthesized — the NS-75 `RollbackDegradedResult` shape. `refused` means NOTHING WAS SENT;
// `failed` means something was sent and no boundary was witnessed. There is deliberately no
// `capability_undeclared` reason: an undeclared flag refuses at the static capability gate with
// `driver.capability_unsupported` BEFORE the driver is called (`Spec-005 §Required Behavior`),
// so an arm for it would be a second, contradictory encoding of one refusal.
type DriverCompactionResult =
  | { status: "applied"; boundaryPosition: number | null }
  // `command_absent`: the pre-dispatch presence check on the emulated leg did not find the
  // command in the provider's own enumeration for this binding. `not_permitted`: the
  // `Action::"intervene"` adjudication above denied the caller.
  | { status: "refused"; reason: "command_absent" | "not_permitted" }
  // `wait_expired`: the driver's declared per-binding compaction bound elapsed with no typed
  // compaction frame. `binding_lost`: the run's provider binding stopped being live (process
  // exit or disposal) before one arrived. `provider_error`: the mechanism itself errored.
  // Every arm records a diagnostic; none is silent, and none can settle `applied`.
  | { status: "failed"; reason: "wait_expired" | "binding_lost" | "provider_error" };

interface ListProviderCommandsParams {
  sessionId: SessionId;
  bindingId: string;
}

// One enumerated provider command or skill. `binding` is not decoration: it is the routing key
// the invariant is enforced on, carried WITH the data so a consumer cannot lose it by filtering
// a held list instead of re-reading. `kind` distinguishes the two things providers publish
// under one syntax; `scope` is present only where the provider declares one (the Codex skills
// surface does, the Claude handshake enumeration does not), so its absence means the provider
// stated no scope rather than that the scope is unknown to the driver. `enabled` follows that same
// present-iff-the-provider-declares-one rule (2026-08-29, round-3 fold): the Codex `skills/list`
// entry carries an `enabled` Boolean (`Spec-005 §Per-Driver Capability Matrix`) and the Claude
// handshake enumeration publishes no enabled/disabled distinction at all, so ABSENT means the
// provider draws no such distinction on this surface — never that the entry's state is unknown to
// the driver, and never a driver-synthesized `true`, which would be exactly the fabricated reading
// the verbatim rules elsewhere in this section forbid. The driver DOES NOT FILTER: a disabled entry
// is returned, because dropping it would make the result stop being the provider's enumeration as
// observed, and a consumer would have no way to tell a disabled command from one that does not
// exist. What the flag governs is OFFERABILITY, not presence — an entry whose `enabled` is
// explicitly `false` is not offerable and is rendered unavailable rather than advertised as
// runnable, since the bound provider will not execute it; an absent `enabled` is offerable.
//
// V1 IS ENUMERATION AND DISCOVERY, NOT A DISPATCH CHANNEL (2026-08-29). No member of this shape
// is a dispatch handle, and no wire route takes one: the ONLY entry V1 sends is the compaction
// command, composed by the driver's own emulated leg and reached through `compactContext`, which
// checks presence against this same enumeration. Selecting any other entry inserts nothing into
// the composer and starts no turn. That is a contract consequence, not a UI preference: text
// beginning with `/` is refused outright on provider-bound composer paths by
// `Spec-017 §Command interception — the reserved / prefix (C-18)`, and the `driver_command` frame
// origin — the only origin exempt from the neutralization tripwire — is admitted by
// `Spec-005 §Required Behavior` only against POST-DISPATCH typed evidence, which an arbitrary
// provider command does not supply. A dispatch route therefore needs both C-18's escape
// activated and a per-command typed-evidence contract, and is left to a future amendment.
// `Spec-005 §Required Behavior`'s "exactly one `driver_command` producer" count stays exact.
//
// BOUNDED AT THE NORMALIZE BOUNDARY (2026-08-29). Every entry is assembled from provider- and
// skill-authored metadata — a local skill file's front matter is operator-writable and a provider
// handshake enumeration is provider-writable — and the assembled list travels to a client, so an
// unbounded one is an arbitrarily large IPC response and renderer workload rather than a merely
// ugly read. `name`, `description`, and `scope` are therefore `wireFreeFormString`-bounded
// (length + non-whitespace + NUL-rejection) exactly as the other untrusted provider-output strings
// enumerated at the head of this section are, and the ENTRY COUNT is capped by the same schema. Truncation is NEVER
// SILENT: the result is the envelope below, not a bare array, so a caller can always tell a
// provider that published few commands from a provider whose list was cut — the NS-75 rule that a
// degraded outcome gets a representable shape rather than an indistinguishable one.
interface ProviderCommandEntry {
  name: string;
  kind: "command" | "skill";
  description?: string;
  scope?: string;
  // Absent = the provider draws no enabled/disabled distinction on this surface. `false` = the
  // provider published the entry AND declared it disabled: returned, never filtered, not offerable.
  enabled?: boolean;
  binding: { driverName: string; providerAccountId: string };
}

// One live binding's enumeration. `runId` and `binding` TOGETHER say where these entries came from:
// neither alone is a key (run -> bindings is 1:many, and one agent can hold bindings on the same
// provider and account across two runs), and no claim is made here that either is unique — the pair
// is provenance a client can read and construct, not an addressing handle, and V1 dispatches
// nothing from this read. `complete: false` means the provider published more entries than the cap
// admits and this group's tail was dropped; the cap and the flag are PER GROUP, so one truncated
// binding never marks another complete or incomplete. The cap is a WIRE-AND-RENDER bound only:
// `compactContext`'s pre-dispatch presence check reads the driver's OWN HELD enumeration for the
// binding, never this capped result, so a truncated read can never manufacture a `command_absent`
// refusal for a command the provider actually publishes.
interface ProviderCommandBindingGroup {
  runId: RunId;
  binding: { driverName: string; providerAccountId: string };
  entries: ProviderCommandEntry[];
  complete: boolean;
}

// The reply is the GROUP LIST, never a bare entry array (2026-08-29, round-3 fold — see the
// concurrent-bindings note at the request above). A single-binding agent yields one group, so the
// common case costs one level of nesting and the concurrent case stays representable instead of
// silently collapsing. The array is never empty on a success reply: an agent with no live binding
// refuses `driver.unavailable` in the fixed order above rather than returning zero groups, so an
// empty list cannot be mistaken for "this provider publishes nothing".
interface ProviderCommandListResult {
  bindings: ProviderCommandBindingGroup[];
}

// Transcript export/replay shapes (2026-08-26, ADR-029). The canonical transcript is a PROJECTION
// the daemon rebuilds per call and caches nowhere, so it is passed IN rather than fetched by the
// driver: a driver holding a transcript handle would be holding a second record of the log, which
// is the divergence ADR-029 exists to eliminate.
// The daemon-side fold of a run's normalized events into ordered turns (Spec-005 §The canonical
// transcript is a projection, never a store). It never crosses a wire and is never persisted, so
// only its IDENTITY is mirrored here: the per-turn element shape is authored by Plan-005 T3.19 in
// `packages/contracts/src/provider-driver.ts` and is bounded by the Spec-006 normalized taxonomy,
// which is what makes "anything that never became an event is not in the transcript" true by
// construction rather than by discipline.
interface CanonicalTranscriptProjection {
  sessionId: SessionId;
  runId: RunId;
  // The log position this fold was taken at. Two folds at the same position render identically and
  // one taken after an appended event does not — the projection-not-a-store property, asserted.
  builtAtPosition: number;
  turns: readonly CanonicalTranscriptTurn[]; // element shape owned by Plan-005 T3.19, above
}

interface ExportTranscriptParams {
  sessionId: SessionId;
  // The daemon-supplied canonical projection, folded from normalized events. Its content is
  // bounded by the Spec-006 taxonomy — anything a provider held that never became an event is by
  // construction absent, which is what the declared-loss list exists to surface.
  transcript: CanonicalTranscriptProjection;
  // Export up to and including this normalized session position — the same position vocabulary
  // `RollbackToParams.position` uses.
  boundary: number;
}
interface DriverTranscriptExportResult {
  // Provider-shaped replay frames, deliberately untyped at this boundary: the pinned Codex
  // injection surface takes an untyped array and validates neither shape nor tool-call pairing, so
  // the DAEMON owns both and a type here would be a false assurance.
  frames: unknown[];
  // What steps 3 and 4 of the ordered pipeline stripped or repaired, by class. An empty array is
  // the positive assertion that nothing was dropped (Spec-016 §Same-Agent Provider Switch).
  declaredLosses: DeclaredLossKind[];
}
interface ReplayTranscriptParams {
  // A FRESH session handle. Replay never writes to the session the transcript came from.
  target: ProviderSessionHandle;
  frames: unknown[];
}
interface DriverTranscriptReplayResult {
  // "degraded" is the memo floor having stood in: the conversation moved and the losses say what
  // came along. It is not a failure result — a target that cannot be reached at all throws.
  status: "applied" | "degraded";
  declaredLosses: DeclaredLossKind[];
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
  // The REQUESTED accelerated-output mode (2026-08-29, Spec-005 §The output-speed axis). Gated on
  // the `output_speed` flag and validated against that driver's declared `outputSpeedLevels`
  // BEFORE spawn — an out-of-vocabulary value refuses with `agent.provider_axis_invalid` rather
  // than reaching the provider. Spawn-bound like posture and schema: the axis is a settings opt-in
  // the provider reads at process start, so a fresh process is the only place it can be realized
  // and `ResumeSessionParams` re-realizes it below. Requesting it is NOT the same as getting it —
  // what the provider actually declared is observed later as binding-held `ProviderOutputSpeedState`.
  outputSpeed?: string;
  callbackTools?: SessionCallbackTool[]; // daemon-curated callback-tool registry exposed into the session (Codex function-form dynamicTools; Claude daemon-hosted ephemeral MCP server via --mcp-config); gated on the callback_tools flag
  subagentPolicy?: SubagentPolicy; // provider-native in-session subagent policy pass-through under the single-supervisor invariant (Spec-016 semantics land via campaign B6); gated on the subagents flag
  outputSchema?: Record<string, unknown>; // normalized JSON Schema constraining schema-constrained final output (Spec-005 §Per-Driver Capability Matrix structured_output, campaign B10); gated on the structured_output flag. The Claude leg binds it per session at spawn (--json-schema); the Codex leg realizes it per turn via StartRunParams.outputSchema (turn/start.outputSchema). Named consumers: Spec-024 dispatch results, Plan-016 orchestration reads
  // Provider-account identity at spawn (2026-08-18 amendment, Plan-005 T3.17; landed 2026-08-31,
  // PR #397). OPAQUE TO THE DRIVER — never parsed, never used to locate credential material: the
  // driver receives the already-constructed spawn environment, and pinning the account's credential
  // home into it (and denying the ambient names a bound leg must not read) are obligations on the
  // spawn path — Plan-029's fail-closed binding, consumed per CP-005-9 — not properties this member
  // carries. SERVER-RESOLVED AND SERVER-STAMPED: a client-supplied value is an input to resolution,
  // never the recorded outcome; what lands here, and what is durably recorded, is the value the
  // daemon resolved. Spawn-bound because a run's paying account is bound for the run's LIFETIME —
  // `ResumeSessionParams` re-realizes it below from the durable record rather than re-resolving the
  // current default. Omitting it is the unchanged pre-amendment path.
  providerAccountId?: string;
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
  // Codex rounds 3–4). The six DATA legs below (re-derived from five by counting
  // when T3.17 added `providerAccountId`) are reconstructed by the daemon from the durable
  // runtime_bindings.spawn_config record (written at every spawn; Plan-005 T1.7) — never from the
  // original client request, which recovery does not have; the two FUNCTION legs are re-injected
  // fresh at every spawn (functions are never stored in spawn_config).
  executionPosture?: ExecutionPosture;
  // The requested mode, re-realized on the fresh process (2026-08-29). It is spawn_config's fifth
  // reconstructed leg for exactly the reason posture is: a speed-less resume relaunches at the
  // provider's default while `agents.output_speed` still records the operator's accepted choice,
  // which is the silent-shedding failure this list exists to prevent. What the relaunched process
  // declares is observed as binding-held `ProviderOutputSpeedState` (the 2026-08-29 round-3
  // correction recorded on `ProviderSessionHandle` below), never returned on `DriverResumeResult`,
  // so a mode that stops being available across a restart surfaces as an observation rather than
  // as a stale request.
  outputSpeed?: string;
  callbackTools?: SessionCallbackTool[];
  subagentPolicy?: SubagentPolicy;
  outputSchema?: Record<string, unknown>; // the Claude leg re-binds per session at spawn (--json-schema); the Codex leg realizes per turn via StartRunParams.outputSchema
  // The SIXTH reconstructed data leg (T3.17) — the one whose silent shedding is a BILLING fault
  // rather than a capability one: a resume that re-resolved "whichever account is default now"
  // would move a live run's spend onto an account it was never admitted against, mid-run, with the
  // receipt's per-paying-account key still claiming the original. Read back from the durable
  // `runtime_bindings.spawn_config` record written at the original spawn — never re-resolved, and
  // never taken from a client request recovery does not hold. Same opacity rule as on
  // `CreateSessionParams` above.
  providerAccountId?: string;
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
  refusalCode?: "driver.text_neutralization_failed"; // additive-optional, 2026-08-25 provider-bound text-neutrality amendment (Spec-005 §Required Behavior; authored by Plan-005 T3.18, consumed by Plan-004 T2.6 under CP-004-1). A CLOSED literal union, not a free-form string: the envelope parses untrusted provider output, and a daemon-selected code from a fixed set carries no provider-composed text, so this member is deliberately absent from the wireFreeFormString-bounded list above. `.strict()` is retained — it rejects UNKNOWN keys, and a declared optional key is not unknown. BEST-EFFORT by construction: the driver sets it only when the trip is classified before this call resolves — it never holds `applyIntervention` open waiting for its correlated frame to settle — so the run's `run.failed` terminal is the guarantee on both paths and an absent `refusalCode` is never evidence that no trip occurred.
}

// Driver-level conversation rollback (campaign B3). `position` is the normalized monotonic
// session position (the same turn/event ordinal vocabulary `DriverResumeResult.sessionPosition`
// reports); the intervention-layer `targetPosition` (Spec-004 rollback content, campaign B2 —
// a named merge prerequisite before any rollback emitter exists) maps onto this driver ordinal.
// Codex leg: `thread/fork` at an inclusive `lastTurnId` — the driver resolves `position` to the
// boundary turn id, never to a drop count, so a re-dispatch names the same boundary rather than
// recomputing a delta (rebound 2026-08-26: `thread/rollback` is deprecated in the generated
// Codex type; Spec-005 §Parity Capability Mechanism Grades is the mechanism's home). Claude leg:
// `--resume-session-at <message-uuid>` + `--fork-session` composed.
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
  | { status: "applied"; sessionPosition: number; bindingId?: string } // sessionPosition: REQUIRED driver-confirmed post-rollback position — the new authoritative recovery floor. Untrusted driver output: the daemon domain-validates it like the request target (integer ≥ 0, recorded boundary, strictly below the pre-rollback position) before trusting it — an invalid or no-op report is a no-rewind failure, never a run.rolled_back — with the file-leg recovery carve-out excepted: on a recovery-admitted current-position target the driver's convergence no-op (sessionPosition == targetPosition, no movement) IS the confirmed floor and the composite proceeds to the fixpoint restore (Spec-004 §Required Behavior). bindingId (campaign B2): present iff the mechanism minted a new provider binding for the same run — the store-minted surrogate of a binding row already registered (provider resume_handle + runtime metadata) through the relaunch pattern's write seam before the result returned, never itself a resume handle; the daemon repoints the run's live binding on receipt. Under the 2026-08-26 Codex rebinding **both V1 legs mint one** — Claude `--resume-session-at` + `--fork-session`, and Codex `thread/fork`, which mints a new thread and repoints the run's live binding in the same operation — so a V1 driver reporting `applied` without it is reporting an unrecorded binding. The member stays optional for a future in-place mechanism, not for either shipped leg; runtime-bounded (length + non-whitespace + NUL-rejection) like `DriverResumeResult.bindingId` — the trust-boundary header's seventeen-string enumeration above
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
  // NO `outputSpeedState` MEMBER, and its absence is the 2026-08-29 round-3 correction rather than
  // an omission: a resume is a fresh spawn, so it has exactly the defect `ProviderSessionHandle`
  // does — the declaring handshake is turn-bearing, and this result resolves before any turn-bearing
  // exchange on the relaunched process. The declared state is observed later, as the binding-held
  // state `ProviderOutputSpeedState` below defines.
  | {
      status: "resumed";
      bindingId: string;
      sessionPosition: number;
    }
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

// Typed provider usage-limit signal (2026-08-18 amendment, Plan-005 T3.16; landed 2026-08-31,
// PR #397). A SIBLING AXIS beside `RecoveryCondition` above, never a member of it — that axis
// names why a run needs an operator; this one names a provider-stated allowance state, minted here
// and scoped per-account by Plan-029 keying on `(accountId, credentialGeneration)` (CP-005-8 ⇄
// CP-029-2). Recognition is TYPED-ONLY (I-005-6): each driver leg keys on a structured provider
// event it can name — never message prose, an exit code, or a bare HTTP status — and an
// unrecognized shape emits NOTHING, an absence that reads "not known to be limited", never "known
// not to be limited". Deliberately nominal at the driver seam rather than Zod-schema'd: `cause`
// and `provenance` are closed literals the driver SELECTS and `resetsAt` is a timestamp the
// driver COMPOSES, so no member is provider-verbatim and a schema over them would validate the
// driver against itself (the provider-verbatim shapes above are schema'd for exactly the opposite
// reason).

// The closed cause set — ONE member today, and the arity is a finding rather than a placeholder:
// the deliberately-excluded neighbor arms (Codex workspace/member credit depletion and the Codex
// spend-control ceiling, Claude billing faults) are account-plane or payment facts rather than
// plan-allowance exhaustion, each named in the contracts file rather than absorbed here.
type ProviderUsageLimitCause = "plan-allowance-exhausted";

// Whether the reset instant is the provider's own statement or the runtime's derivation, so a
// consumer can tell the two apart. Primary sources, per the AGENTS.md citation standard: the
// Codex leg stamps provider-stated off the published rate-limit shapes — the
// `account/rateLimits/read` pull + `account/rateLimits/updated` push pair the provider-wire
// reference family's codex file records (Generated schema, Verified at the codex-cli 0.150.1
// pin), consumed by the shipped codex event-normalizer's push row. The Claude leg stamps
// runtime-derived because no Claude surface states a reset instant: the arithmetic is
// observation time plus the `api_retry` frame's own `retry_delay_ms`, emitted only on the
// final announced retry beside the typed `rate_limit` error member — the mid-session retry
// taxonomy the provider-wire claude file records (Binary probe, Verified at Claude Code
// 2.1.245). The sibling-axis rule and typed-only recognition are `Spec-005 §Fallback
// Behavior`'s.
type ProviderUsageLimitResetProvenance = "provider-stated" | "runtime-derived";

interface ProviderUsageLimitResetBoundary {
  resetsAt: string; // RFC 3339 UTC — the encoding `PhaseState.autoResumeAt` already consumes
  provenance: ProviderUsageLimitResetProvenance;
}

// The signal itself. The BOUNDARY IS OPTIONAL AND THE CAUSE IS NOT: a limit can be recognized
// with no reset instant to report, but never without a cause — and carrying `resetsAt` and
// `provenance` inside one shape makes "an instant with no provenance" and "a provenance stamp
// with no instant" both inexpressible.
interface ProviderUsageLimitSignal {
  cause: ProviderUsageLimitCause;
  resetBoundary?: ProviderUsageLimitResetBoundary;
}

interface RespondToRequestParams {
  runId: RunId;
  requestId: string;
  response: unknown;
}

interface CloseSessionParams {
  sessionId: SessionId;
}

// NO `outputSpeedState` MEMBER (2026-08-29 round-3 correction — it was drafted here and REMOVED
// before any producer landed). This is the driver-constructed RETURN of `createSession`, which
// resolves before `startRun` can begin the first turn-bearing exchange, and `Spec-005 §Detection
// source is static` establishes that the handshake declaring the speed state is emitted only as
// part of such an exchange. A member here could therefore never be populated on any path, and a
// structurally always-absent member is a field minted ahead of its producer — the NS-84 ground on
// which a capability flag with no reader was withdrawn rather than shipped. The observation is
// binding-held state instead; see `ProviderOutputSpeedState` below.
interface ProviderSessionHandle {
  providerSessionId: string;
  resumeHandle: string;
}

// The provider's own report — never a probe of its own and never synthesized from the request
// (2026-08-29). IT IS BINDING-HELD DRIVER-SESSION STATE, NOT A SPAWN RETURN (round-3 correction).
// The declaring handshake is emitted only as part of a turn-bearing exchange (`Spec-005 §Detection
// source is static`), so neither `createSession` nor `resumeSession` can carry it: both resolve
// before the first such exchange, and neither may spend a synthetic turn or block waiting for one.
// The driver therefore records the state against the binding WHEN THE HANDSHAKE ACTUALLY ARRIVES,
// on the first turn-bearing exchange the participant's own work produces, and holds it for the
// binding's life — the same held-state shape `listProviderCommands` already uses. Until then the
// binding HAS NO OBSERVATION, and every reader of it is absent-until-observed rather than defaulted.
// READ AND DISCARDED WITH THE SESSION: it is deliberately NOT written to `runtime_bindings.spawn_config`, which records
// what was REQUESTED so a resume can re-realize it, and not to `agents.output_speed`, which
// records the operator's accepted choice. Persisting an observation into either would create a
// second, staler record of a fact the live session already holds — and would make a mode that
// stopped being available look accepted after a restart. It reaches clients as a LIVE-SCOPED
// projection on `AgentListResponse.agents[]`, present only while the binding it was read on is
// live.
//
// `declared` is carried VERBATIM and is deliberately not narrowed to `outputSpeedLevels`: that
// vocabulary bounds what a caller may REQUEST, while this is what the provider REPORTED, and a
// provider that returns a level the driver's table does not list is reporting a real state under
// version skew — coercing it to `off` would fabricate exactly the false reading this member
// exists to prevent. `reason` is the provider's own explanation, present only where the provider
// supplied one; its absence means the provider gave no reason, never that there was none. Both
// strings are provider-authored and `wireFreeFormString`-bounded per the head of §Plan-005.
interface ProviderOutputSpeedState {
  declared: string;
  reason?: string;
}

interface ProviderModel {
  id: string;
  name: string;
  capabilities: string[];
  effortLevels?: string[]; // per-model reasoning-effort vocabulary, copied verbatim from the provider's own catalog read — the lists differ per model WITHIN one provider, so there is no provider-wide list (Spec-005 §Provider Parameter Vocabularies, corrected 2026-08-30); absent = the model exposes no effort selection
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
  toolName: string; // untrusted provider output — wireFreeFormString-bounded (the trust-boundary header's seventeen-string enumeration); resolved against the session's registered SessionCallbackTool set, and an UNKNOWN name answers `failed` without dispatch (campaign B10, Codex round 4)
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
// bounded at the driver normalization seam (the seventeen-string enumeration above) before it reaches the
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

// Durable MCP Tasks recovery handle (campaign B10, Plan-005 T5.1 — LANDED: T3.13 authored the
// receipt-write seam, and T5.1's own migration added the column and activated the seam on
// Plan-004 Phase 1's `command_receipts` CREATE). A task-augmented MCP call under MCP 2025-11-25's
// experimental Tasks utility carries a receiver-generated `taskId` (from the `CreateTaskResult`
// acceptance response). It is NOT a new RPC payload: the daemon persists it on the receipt as the
// additive nullable `command_receipts.mcp_task_id` column (Plan-005 EXTENDs Plan-004's table per
// cross-plan-dependencies.md §1; DDL in local-sqlite-schema.md §Queue and Intervention Tables —
// bounded ≤256 code points + non-empty + NUL-reject: the id is untrusted remote-peer output, and
// the write seam mirrors it). That column is the durable handle Spec-015 recovery reads to poll
// `tasks/get` + `tasks/result` instead of halting the `manual_reconcile_only` floor; NULL until the
// receiver accepts — a crash before that leaves the halt intact (Spec-005 §Recovery Consequences).

// INGRESS shape — what a provider driver DECLARES via `getCapabilities()`. `idempotency_class`
// is OPTIONAL: a driver MAY omit it and an undeclared class is NOT a contract violation. Were the
// field required here, Zod would reject a conformant-but-silent driver at ingress BEFORE the
// default could apply — defeating Spec-005 §idempotency_class. The daemon's capability-normalization seam
// (Plan-005 T2.4 hydration) resolves an omitted class to `manual_reconcile_only` (the conservative
// default per Spec-005 §idempotency_class), producing a `NormalizedProviderToolMetadata`.
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
// per-driver floor (mechanical enforcement at attach/refresh; V1 floors: Claude Code 2.1.234,
// codex-cli 0.141.0 — set by Spec-005 §Required Behavior, which is also where the raise from
// 2.1.198 to 2.1.234 is recorded; a floor is stated by that spec, a pin is cited from the
// provider-wire reference family, and neither is restated here). Both values are read from
// the version the SPAWNED process reports in-band, not from a launcher symlink. `semver` is REQUIRED,
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
  // Per-flag provenance of the reading above (2026-08-26 provider-CLI version-tolerance
  // amendment, Spec-005 §Required Behavior). `probed` means decided against the installed
  // build by a zero-turn probe whose negative control still refused; `static` means declared
  // from the driver's own per-driver table, which Spec-005 admits only where the flag has no
  // ADMISSIBLE probe -- zero-turn, non-mutating, and decisive at the consumed granularity --
  // and requires the mechanism table to name the conjunct that fails. Sibling of `cliVersion` for the same reason `cliVersion` is
  // one: it is a property of THIS reading, not of a capability, so `DriverCapabilities` stays
  // pure (flags + contractVersion). ADDITIVE-OPTIONAL and LIVE-SCOPED, not required — present
  // and TOTAL over the flag set whenever the wrapper is a live driver read; absent exactly
  // when it was reconstructed by `DriverCapabilitiesWriter.hydrate()` from the durable cache,
  // which persists flag VALUES for change detection and NOT provenance (so no column is
  // minted, and a required member would be unsatisfiable on that path). Absence therefore
  // reads as "cache reconstruction", never as "unknown provenance" — a consumer that needs
  // provenance re-reads the driver. Driver-side only: deliberately NOT mirrored into
  // `CapabilityDetails` (same carve-out as `cliVersion`) and NOT carried on the client-facing
  // `driver.listCapabilities` payload, which this member does not widen. That client-facing `driver.*` set
  // stood at SEVEN names from its 2026-05-27 ratification until 2026-08-29, when
  // `driver.compactContext` and `driver.listProviderCommands` took it to NINE (Plan-005 §Phase 4
  // decision #2; registered against the Plan-007 namespace registry under CP-007-6). Both were
  // admitted by that decision's own governing principle rather than as exceptions to it: each
  // operates on an already-existing session and neither establishes, restores, starts, nor tears
  // one down. The other four lifecycle operations above remain daemon-internal.
  detectionSource?: Record<DriverCapabilityFlag, CapabilityDetectionSource>;
  // The output-speed axis's VALUE VOCABULARY (2026-08-29, Spec-005 §Provider Parameter
  // Vocabularies + §The output-speed axis). Present iff `capabilities.flags.output_speed` is
  // `true`; absent or empty means the axis is unsettable and an `agent.configUpdate` carrying
  // `outputSpeed` refuses fail-closed rather than forwarding an unvalidated value.
  // STATICALLY DECLARED from the same per-driver table the `output_speed` flag itself comes
  // from, and never read from the provider: obtaining the provider's declared speed state costs
  // a turn-bearing request, which is exactly the conjunct that makes that flag `static`, so a
  // vocabulary sourced by reading would contradict its own detection source. Unlike
  // `detectionSource`, this member IS served on the client-facing `driver.listCapabilities`
  // payload — its reader is a client control that must offer the choice set, the same reason
  // `ProviderModel.effortLevels` travels to the client that renders the effort selector. The
  // values themselves are the provider's own; this contract names none of them.
  //
  // PRESENT ON BOTH READ PATHS, and that is a consequence of being static rather than a second
  // rule (2026-08-29). Because the vocabulary is a property of the DRIVER, not of a reading, the
  // wrapper carries it identically whether it was built by a live `getCapabilities()` call or
  // reconstructed by `DriverCapabilitiesWriter.hydrate()` — the hydrating path re-derives it from
  // the same per-driver table the live path reads, so nothing has to survive the durable cache.
  // This is exactly why it does NOT follow `detectionSource` into absence-on-hydrate: that member
  // is a fact about one reading and cannot be re-derived, while this one is a constant of the
  // driver and always can. Consequences: the durable capability cache gains NO column, and
  // `CapabilityDetails` — the event-payload wrapper below — is NOT widened, since replaying a
  // capability snapshot never needs a vocabulary the current driver table already states. A
  // client therefore never receives `output_speed: true` without the values it must render, on
  // either path, so Plan-016's fail-closed refusal rule can never be triggered by the cache.
  outputSpeedLevels?: string[];
}

type CapabilityDetectionSource = "static" | "probed";
```

### Plan-006 — Session Event Taxonomy

> **Cross-plan note (amendment 2026-06-02, PR #137 — Plan-003 Phase 2).** The per-event payload-shape Zod schemas for the `runtime_node.*` payloads below are **authored by Plan-003** in `packages/contracts/src/runtime-node.ts` (the file Plan-003 owns; CREATE), not by Plan-006. Plan-003 ships `capabilityDetails` (on `capability_declared`) and `previousState`/`newState` (on `capability_updated`) as an **interim opaque** `z.record(z.string(), z.unknown())` because the canonical `CapabilityDetails` consumes Plan-005's `provider-driver.ts` types, which do not yet exist. The `CapabilityDetails` interface defined here is the shape **Plan-006 Tier 4 binds** over those interim-opaque fields (EXTEND — closes Plan-005 CP-005-5 / Plan-006 CP-006-5): the bind lands first — Plan-006 Phase 1 T1.4, the canonical-first arm of a tolerant union. Registration of the schemas into the discriminated `SessionEventSchema` union (`event.ts`) followed in Plan-006 Phase 1 T1.12, which registered the five daemon-reachable variants and left `degraded` / `revoked` census-only; only their `EventEnvelope` integrity wrapping still rides a later Tier-4 leg. See [cross-plan-dependencies.md §3 Plan-003 row](../cross-plan-dependencies.md#3-inter-plan-dependency-graph) and Plan-003 §CP-003-1 (Payload-shape ownership).

```ts
// CapabilityDetails — wrapper shape carried by `runtime_node.capability_declared` and
// `runtime_node.capability_updated` event payloads (Spec-006 §Runtime Node Lifecycle, the capability rows). Bound to the same
// three surfaces a driver advertises via `ProviderDriver.getCapabilities()` (GetCapabilitiesResult
// above): the seventeen-flag matrix, the declared contract version, and the per-tool metadata —
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
  // total per Spec-006 §Event Type Summary; 159 event types (140 per the 2026-07-02 B1 amendment,
  // +1 `pty.control_changed` per the 2026-07-06 B4 amendment, +15 per the 2026-07-22 B18 amendment —
  // incl. the five `mcp_governance` types — +2 (`agent.provider_switched`,
  // `agent.provider_switch_failed`) per the 2026-08-26 D-016-26 amendment, and +1
  // (`session.peer_invocation_set`) per the 2026-08-26 Spec-030 peer-invocation amendment) — the Tier-5
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

// ---------------------------------------------------------------------------
// The six Plan-006-emitted payload variants (Plan-006 T1.11) — authored in
// packages/contracts/src/event.ts, which Plan-006 owns, rather than imported
// from an emitting plan's module (contrast the repo/workspace/worktree family,
// authored in repo.ts / worktree.ts under emitter-authors-payload). Registering
// a payload variant is additive-MINOR per ADR-018 §Decision #8; all six type
// strings were already census members, so the 156/20 census is unchanged.
//
// Session binding (Spec-006 §Daemon-Scope Event Binding And Node-Scope
// Anchoring): key_reuse_detected and the three event_maintenance types bind the
// reserved RFC 9562 §5.10 Max UUID sentinel session_id (lowercase);
// audit_integrity_verified / audit_integrity_failed carry the verified range's
// real session_id — the sentinel only when verifying the node-scope chain, and
// the signing_key_slot_conflict arm always the refused registration's real id.
// Binding is an emitter obligation: the envelope's SessionId already admits the
// sentinel, so no schema carve-out exists.
//
// None of the six is run-scoped (no payload carries runId), so none composes
// the sourceEpoch + sourcePosition pair documented above.

// audit_integrity payload base — {sessionId, anchorId?, verifierNodeId}, per
// Spec-006 §Audit Integrity. anchorId is an opaque bounded string, deliberately
// not a branded/UUID id: the control-plane anchor id is UUID while the local
// pending_anchor_uploads.id is TEXT, and no AnchorId vocabulary is declared.
// key_reuse_detected does NOT carry this base (its spec cell has no "base +"
// prefix) — it is an observer's node-level finding. The audit_integrity_failed
// REGISTRAR arm takes a REDUCED base, {sessionId, verifierNodeId}, anchorId
// excluded (Spec-006 2026-08-03) — see that arm below.

interface AuditIntegrityVerifiedPayload {
  sessionId: SessionId;
  anchorId?: string;
  verifierNodeId: NodeId;
  treeSize: number; // int >= 0; RFC 9162 tree_size (leaf count of the verified tree)
  rootHash: string; // house form is 64-char lowercase hex; the wire contract is a bounded string
  fromSeq: number; // int >= 0, bounded by the EventEnvelope.sequence ceiling
  toSeq: number;
  verifiedAt: string; // ISO 8601
  signatureAlgorithm: string; // no algorithm vocabulary is specified; bounded free-form
}

// audit_integrity_failed is DISCRIMINATED on failureMode (Spec-006 §Audit
// Integrity, 2026-08-01 amendment): the fifteen read-side verifier modes walked
// a range and REQUIRE the Merkle triple; the registrar's
// signing_key_slot_conflict walked none, so requiring the triple there would
// force it to fabricate roots for a tree it never touched. One event type, one
// wire schema, two arms. The verified RANGE splits the same way (2026-08-03):
// fromSeq/toSeq are REQUIRED on the verifier arm — I-006-4-01's consumer dedupe
// key — and absent from the registrar's, which walked no range.
type VerifierFailureMode =
  | "hash_mismatch"
  | "signature_mismatch"
  | "anchor_mismatch"
  | "inclusion_proof_failed"
  | "consistency_proof_failed"
  | "log_file_missing"
  | "log_file_moved"
  | "anchor_missing_for_compacted_range"
  | "anchor_signature_invalid"
  | "stub_signature_invalid"
  | "stub_scalar_mismatch"
  | "signature_placeholder"
  | "occurred_at_not_canonical"
  | "pii_ciphertext_digest_unbound"
  | "pii_owner_stamp_unbound"
  | "content_ciphertext_digest_unbound"
  | "signing_key_slot_conflict"; // registrar-emitted; the sixteenth mode BY MINT
// ORDER, which is how Spec-006 §Audit Integrity names it; the union's own
// positional count moved to seventeen on 2026-08-30, when
// content_ciphertext_digest_unbound landed as the SIXTEENTH member of the
// verifier arm — two closed sets, each counted on its own terms.
// failurePath names the verification GUARANTEE that failed, not the column the
// defect occupies — which is why the three signature-survives-but-binding-broke
// modes all pair with "signature".
// NINE of the fifteen verifier modes have their path FIXED by Security
// Architecture §Verification Rules and the schema enforces the pairing at parse:
// hash_mismatch → "inclusion"; anchor_mismatch → "consistency"; and
// signature_mismatch / signature_placeholder / occurred_at_not_canonical /
// pii_ciphertext_digest_unbound / pii_owner_stamp_unbound / content_ciphertext_digest_unbound /
// stub_signature_invalid / stub_scalar_mismatch → "signature". The other SIX
// (inclusion_proof_failed, consistency_proof_failed, log_file_missing,
// log_file_moved, anchor_missing_for_compacted_range, anchor_signature_invalid)
// have no corpus-fixed path and keep the full three-value latitude — pinning
// one would mint an authority that does not exist.
type VerifierFailurePath = "inclusion" | "consistency" | "signature";

type AuditIntegrityFailedPayload =
  | {
      // Verifier arm — the fifteen read-side modes.
      sessionId: SessionId;
      anchorId?: string;
      verifierNodeId: NodeId;
      treeSize: number;
      expectedRootHash: string;
      observedRootHash: string;
      // The verified range's endpoints — REQUIRED on this arm. I-006-4-01's
      // dedupe key is (verifierNodeId, fromSeq, toSeq, verifiedAt); verifiedAt
      // stays an audit_integrity_verified member, so the fourth key member is
      // read from the envelope's occurredAt and T4.1's IdempotencyClass keys
      // these rows on the first three.
      fromSeq: number;
      toSeq: number;
      failureMode: Exclude<VerifierFailureMode, "signing_key_slot_conflict">;
      failurePath: VerifierFailurePath;
      offendingSeq?: number; // absent when no single row is implicated
      detail: string;
    }
  | {
      // Registrar arm — no range was verified, so no Merkle triple and no
      // range endpoints.
      sessionId: SessionId; // the refused registration's real id, never the sentinel
      // No anchorId — REDUCED base, the member excluded rather than optional
      // (Spec-006 2026-08-03). It is permanently absent on this row: the signed
      // payload is never mutated, and later coverage is represented by the
      // subsequently appended anchor spanning this row's range, exactly as for
      // any appended row. The schema is .strict(), so an offered anchorId is
      // an unrecognized key and REJECTED — the permanence is enforced here,
      // not left to emitter convention.
      verifierNodeId: NodeId; // the refused daemon naming itself
      failureMode: "signing_key_slot_conflict";
      failurePath: "signature";
      detail: string; // names the refused (session_id, node_id) pair
    };

interface KeyReuseDetectedPayload {
  offendingKeyFingerprint: string;
  observedIdentities: Array<{ sessionId: SessionId; nodeId: NodeId }>; // >= 2, PAIRWISE DISTINCT — a repeated pair is one identity holding its own key
  firstSeenAt: string; // ISO 8601
  rotationInvariantViolated: "refuse_on_rotation"; // V1's only rotation posture
  detectorNodeId: NodeId;
}

// event_maintenance payload base — {nodeId, operationId, occurredAt}, per
// Spec-006 §Event Maintenance. occurredAt re-spells the envelope member (the
// spec's shape; both sit in the RFC 8785 canonical bytes).

interface SchemaMigratedPayload {
  nodeId: NodeId;
  operationId: string; // batch correlation id (Liquibase DEPLOYMENT_ID by precedent)
  occurredAt: string; // ISO 8601
  fromVersion: string; // migration revisions, NOT EventEnvelopeVersion
  toVersion: string;
  migrationId: string;
  description: string;
  checksum: string; // BLAKE3 over the concatenated migration file contents
  appliedBy: string;
  executionMs: number; // int >= 0
  success: boolean; // false is representable — a failed batch is the row worth auditing
}

interface EventCompactedPayload {
  nodeId: NodeId;
  operationId: string;
  occurredAt: string; // ISO 8601
  sessionId?: SessionId; // present when the pass is scoped to one session
  fromSeq: number;
  toSeq: number;
  eventsBefore: number;
  eventsAfter: number;
  bytesReclaimed: number;
  tombstoneCount: number;
  compactionReason: "age_threshold" | "count_threshold" | "storage_threshold";
}

interface EventShreddedPayload {
  nodeId: NodeId;
  operationId: string;
  occurredAt: string; // ISO 8601
  participantId: ParticipantId;
  affectedSessionIds: SessionId[]; // may be empty — an idempotent re-run is still auditable
  piiPayloadsCleared: number;
  shredReason: "gdpr_article_17" | "retention_policy" | "admin_action";
}

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

### Event-Anchor Upload Method Registry (Tier 4, Plan-006 T3.3)

The Merkle-anchor integrity witness ([Security Architecture §Merkle Anchors (Control-Plane Witness)](../security-architecture.md#merkle-anchors-control-plane-witness)) is uploaded by the emitting daemon through a single control-plane procedure, `eventanchor.upload`, persisting into the Plan-006-owned [`event_log_anchors` table](../schemas/shared-postgres-schema.md#event-log-anchors-plan-006--integrity-witness). The method is **control-plane tRPC ONLY** and **daemon-called** — the `runtimenode.signingkeyregister` shape — because the store is control-plane-owned cross-node state and the daemon is the sole producer; it rides no daemon JSON-RPC transport. The request body is `AnchorPayload`, the exact seven-member metadata set bound to that table's columns, and it is **metadata only**: the canonical `AnchorPayloadSchema` in `packages/contracts/src/event-anchor.ts` is `.strict()` and carries no `payload`, `events`, or `pii_payload` member, so an upload smuggling event content is REFUSED at parse with `BAD_REQUEST` (400) rather than silently stripped — the structural enforcement of Plan-006 I-006-3-02 and of [ADR-017](../../decisions/017-shared-event-sourcing-scope.md)'s rejection of a shared event log. Event payloads never leave the emitting daemon.

The upsert is **idempotent by range identity**: `INSERT ... ON CONFLICT (session_id, node_id, start_sequence, end_sequence) DO NOTHING RETURNING id`, whose zero-row arm is classified from the statement's own `RETURNING` rows into `{ stored: false }`. A re-upload of an identical range is therefore an acknowledged HTTP 200 success and deliberately **never a 409** — the daemon retries whenever an attempt's outcome is unknown to it, which is the normal case rather than the exceptional one, and an error status would strand the anchor in the local `pending_anchor_uploads` queue permanently. `end_sequence` is part of the key on purpose: a cadence anchor over `[1,1000]` and a wider compaction-covering anchor over `[1,5000]` share a `start_sequence` and MUST coexist, so the key dedups genuine re-uploads of the identical range and nothing else ("covering anchor" at verify time is a coverage test, `start_sequence <= range_start AND end_sequence >= range_end`, per [Spec-006 §Post-Compaction Integrity](../../specs/006-session-event-taxonomy-and-audit-log.md#post-compaction-integrity), never an exact-start match). Because Ed25519 is deterministic ([RFC 8032 §5.1.6](https://www.rfc-editor.org/rfc/rfc8032#section-5.1.6)), a re-signed anchor over the same root is byte-identical, so the conflicting row has nothing to reconcile and the server compares no commitment bytes. An anchor naming a session with no `sessions` row is refused tRPC `NOT_FOUND` (404) rather than surfacing the raw FK violation as a retryable 500 — a terminal answer the daemon needs, since re-sending the same body can never satisfy the constraint. That refusal is also the backstop for V1 scope: node-scope (sentinel-partitioned) chains anchor LOCALLY only, the daemon's upload worker filtering them out by the `DAEMON_SCOPE_SENTINEL_SESSION_ID` sentinel, and control-plane witnessing for them is a V1.1 extension per [ADR-017 §Node-Scope Anchor Witnessing](../../decisions/017-shared-event-sourcing-scope.md#node-scope-anchor-witnessing-v1-local-only-v11-control-plane-upload).

The daemon authenticates as the **node-owner participant** through the constructor-injected `DaemonCredentialProvider` interface (Plan-006 T3.3, the CP-006-13 shape), minted **per attempt** — a DPoP proof binds to one request, so reuse across attempts is replay ([RFC 9449 §11.1](https://www.rfc-editor.org/rfc/rfc9449#section-11.1)) — and presented as `Authorization: DPoP <token>` per [RFC 9449 §7.1](https://www.rfc-editor.org/rfc/rfc9449#section-7.1), never the `Bearer` form, alongside the proof bound to the attempt's `htm`/`htu` and carrying the token's `ath` hash ([RFC 9449 §4.3](https://www.rfc-editor.org/rfc/rfc9449#section-4.3)). Like the sibling §Signing-Key Registration Method Registry, the provider is Tier-5-dormant until Plan-018's PASETO wiring lands, so an auth failure is a RETRYABLE TRANSPORT failure on a bounded backoff and blocks no Tier-4 code: through Tier 4 the daemon still ANCHORS correctly and `event_log_anchors` is expected-empty, unflushed anchors accumulating durably in `pending_anchor_uploads` and flushing on reconnect. A new daemon calling an old control plane receives tRPC `NOT_FOUND` for the procedure itself and degrades honestly — its anchors stay emitter-only-verifiable until the control plane upgrades, the procedure's absence being the discovery signal, the same skew posture the signing-key registry documents.

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `eventanchor.upload` | `mutation` | `EventAnchorUploadRequest` (identical to `AnchorPayload`) | `EventAnchorUploadResponse` — HTTP 200 `{ result: { data: { stored } } }`; control-plane tRPC ONLY, **daemon-called** from the anchor-upload worker (idempotent per the contract paragraph above; no daemon JSON-RPC registration; Plan-006 T3.3) |

```ts
// EventAnchorUpload — control-plane tRPC ONLY, daemon-called from the anchor-upload worker
// (Plan-006 T3.3 per CP-006-2; metadata-only per I-006-3-02 / ADR-017).
// EventAnchorUploadRequest is an alias of AnchorPayload rather than a distinct shape: the wire
// body IS the anchor, and a second near-identical interface would drift from it.
interface AnchorPayload {
  sessionId: SessionId;
  nodeId: NodeId;
  startSequence: number; // first session_events.sequence in the anchored range (inclusive)
  endSequence: number; // last session_events.sequence in the anchored range (inclusive); >= startSequence, mirroring the table CHECK
  merkleRoot: string; // base64 of exactly 32 bytes — the RFC 9162 §2.1.1 MTH over the range's row_hash entries, BLAKE3 as HASH
  rootSignature: string; // base64 of exactly 64 bytes — Ed25519 by the emitting daemon's session-scoped key over the ANCHOR CLAIM: the RFC 8785 canonicalization of {endSequence, merkleRoot, nodeId, sessionId, startSequence} per Spec-006 §Anchoring Cadence (2026-08-11 amendment — previously merkleRoot alone; pre-first-release, no production anchors exist, and the shipped T3.3 signer takes the preimage update in the immediate Plan-006 follow-up code PR — landed 2026-08-12, PR #324)
  anchoredAt: string; // ISO 8601 with offset — the DAEMON's timestamp at anchor computation, not the server's now() default
}
type EventAnchorUploadRequest = AnchorPayload;
// NO payload, events, or pii_payload member — AnchorPayloadSchema is .strict(), so a body carrying
// one is refused BAD_REQUEST (400) at the procedure boundary rather than accepted and stripped.
interface EventAnchorUploadResponse {
  stored: boolean; // true = this upload inserted the row; false = an identical range was already stored (idempotent success, NOT 409)
}
```

---

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

// DaemonStop / DaemonRestart (no DaemonStart: daemon cold-boot is the CLI process-spawn path — `sidekicks daemon start` — not an IPC method; see Plan-007 T-007r-3-4)
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
      // 2026-08-16 rewind-hardening amendment (Spec-004 §Required Behavior's atomic edit-and-resend bullet; Plan-004 I-004-21, mirrored by T1.2). OPTIONAL and PRESENCE-DISCRIMINATING: presence alone selects the atomic edit-and-resend composite — still ONE intervention on the SAME wire method, minting no new intervention type, method name, event type, error code, or table — and turns on that composite's four additional structural refusal guards (no active turn; no earlier pending send; a participant-authored `user.message` boundary of the target run; a resumable target), each fail-closed at admission, pre-dispatch, and whole-intervention. Absence is an ordinary bare rollback, which is why an unregistered member fails closed rather than open. REQUEST-SIDE ONLY — the result never echoes it, which is exactly why `resendDisposition` below parses schema-optional. The body is persisted on the write-ahead intervention row through the participant-keyed PII envelope (`interventions.pii_payload` + `pii_participant_id`) BEFORE dispatch and never lands in plaintext `interventions.payload` (Spec-004 §Required Behavior; Spec-022 §PII Data Map).
      replacementSend?: {
        content: string; // the corrected message body — the `steer` arm's `content` vocabulary above, non-empty at parse (Zod `.min(1)`). No attachment member in V1: the leg replaces a participant `user.message` body and nothing else, so widening it is a named future amendment rather than an unregistered field the daemon might silently drop.
      };
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
// exactly RollbackDegradedResult (the other seven) — the per-disposition `(applied)` / `(degraded)`
// annotations below are that normative mapping, and it is ORTHOGONAL to the rewind grouping (the
// CONFIRMED-REWIND group spans both states). The `resendDisposition` member (the class-scoped resend
// fragments below) is a SEPARATE AXIS from both: it is not a disposition, it rides both terminal arms by
// intersection, and it reports the replacement leg's outcome, not an earliest-failing leg — though its
// V1 VALUE is state-determined, which the fragments encode rather than merely assert.
// Two groups, split by whether the conversation leg confirmed a rewind (Codex round 4 —
// `position-mismatch` belongs to the CONFIRMED group: its rewind DID happen, at the confirmed floor) —
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
//     `boundary-diverged`        2026-08-16 rewind-hardening amendment (I-004-20): the SETTLEMENT-time
//                                reclassification found the driver-confirmed floor strictly below the
//                                then-newest `usage.context_compacted` boundary. The rewind DID happen —
//                                the file leg is skipped fail-closed, a staged `replacementSend` is
//                                suppressed, the run follows conversation truth `paused` at the confirmed
//                                floor, and the forward event records the confirmed position with the
//                                divergence cause on the durable row. Carries `confirmedPosition` +
//                                `newestBoundaryPosition`, the latter NULL exactly when the conclusion
//                                rests on a position-less compaction row (Spec-004: such a row "classifies
//                                as crossing for EVERY target of that run"). The run is NON-RESUMABLE in
//                                V1: `run.resume`
//                                refuses fail-closed with the registered `run.compaction_boundary_diverged`
//                                (Error Contracts §Run), the backstop for the one late-delivery window
//                                settlement cannot see (`degraded`)
//     `resend-unapplied`         2026-08-16 rewind-hardening amendment (I-004-21), COMPOSITE-ONLY: the
//                                rewind was fully successful — confirmed floor EQUAL to the target,
//                                boundary-clear at settlement, file leg complete or legitimately
//                                conversation-only — and the `replacementSend` ADMISSION ITSELF failed.
//                                Reserved for exactly that arm: an admission-condition SUPPRESSION names
//                                the earlier-failing leg instead (precedence in leg order —
//                                `boundary-diverged`, then `position-mismatch`, then the file-leg arms).
//                                Carries the REQUIRED `resendDisposition: "unapplied"` its composite-only
//                                reachability makes expressible, plus `files-restored`'s two
//                                enumerations — this arm DISPLACES that outcome, so dropping them would
//                                silence a restore that did mutate the tree. It carries no locator for
//                                the caller's text, which stays recoverable under the requester's
//                                participant key on the durable intervention row that
//                                `InterventionResponseBase.interventionId` already names (`degraded`)
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
  | { disposition: "position-mismatch"; requestedPosition: number; confirmedPosition: number }
  | {
      // Settlement-time boundary reclassification (2026-08-16 rewind-hardening amendment; Plan-004
      // I-004-20, produced by T3.16). BOTH members REQUIRED — never absent, so the caller renders WHERE
      // the run landed and WHY the resume refusal that follows is the class's terminal shape rather than
      // a transient failure. The comparand is NULLABLE rather than optional because Spec-004 §Required
      // Behavior routes a second cause into this same disposition: "a position-less compaction row
      // classifies as crossing for EVERY target of that run" — a current `usage.context_compacted` row
      // with no stamp, no operation linkage, and no recoverable timeline slot. Admission refuses that
      // run outright, but the row can arrive between admission and the `rollbackTo` confirmation, and
      // settlement cannot un-rewind, so the class settles `degraded` with no position to name. An
      // absent member could not distinguish that from a producer that forgot to populate it; an
      // explicit `null` states the cause.
      disposition: "boundary-diverged";
      confirmedPosition: number; // the driver-confirmed floor the conversation leg actually rewound to — the position the forward `run.rolled_back` records
      newestBoundaryPosition: number | null; // the newest `usage.context_compacted` boundary in the SETTLEMENT-time set, strictly above `confirmedPosition` — the comparand that concluded divergence, so the caller can state the gap rather than assert an unexplained refusal. `null` EXACTLY when the crossing conclusion rests on a position-less compaction row, which has no position to compare against and is treated as sitting above every target
    }
  | {
      // Committed-then-failed composite arm (I-004-21). It carries no locator for the caller's staged
      // text — `InterventionResponseBase.interventionId` already names the durable intervention row that
      // text is recoverable from, so a second wire-side locator would be a redundant second source of
      // truth. `resendDisposition` is REQUIRED here and nowhere else: this arm is COMPOSITE-ONLY, so
      // unlike every other rollback outcome its result does identify its request as composite, and
      // requiredness IS expressible. It is also the ONLY disposition that STANDS IN FOR a completed file
      // leg — its reachability condition is a fully-successful rewind whose restore ran to the fixpoint
      // or whose run legitimately took the conversation-only branch — so it displaces the
      // `files-restored` outcome the settlement would otherwise have recorded and MUST carry that arm's
      // two enumerations, on the same REQUIRED + empty-when-none contract (Codex round 7). Every other
      // degraded arm applied no file effects: `files-unrestored` refuses at execution time pre-mutation,
      // and `position-mismatch` / `boundary-diverged` skip the file leg fail-closed. Dropping them here
      // would make an overwritten ignored path or a divergent gitlink silent in exactly the case where
      // the restore DID mutate the tree, which Spec-010 §Turn-Boundary Snapshots forbids ("never
      // silent"). On the conversation-only branch both are empty because no file leg ran; that is the
      // same reading two empty arrays already have on `files-restored`, and whether the run has a file
      // leg at all is a property of its execution mode the caller knows independently of this response.
      // Producer naming matches the two carrier arms above: T3.17 composes these two fields onto this
      // arm — where the file leg ran, from the same T3.13 restore result the displaced `files-restored`
      // outcome would have carried; on the conversation-only branch as two empty arrays, no restore
      // result existing to read — and T4.7's degraded render surfaces them (exit code unchanged).
      disposition: "resend-unapplied";
      resendDisposition: "unapplied";
      overwrittenIgnoredPaths: string[];
      divergentGitlinks: string[];
    };
// SCHEMA-OPTIONAL, PRODUCER-OBLIGATED (2026-08-16 rewind-hardening amendment; Plan-004 T1.3, produced and
// asserted by T3.17). PRESENCE is not expressible as required: no member of a rollback result identifies
// its request as composite (`replacementSend` is request-side and is never echoed) except the
// composite-only `resend-unapplied` arm, which therefore REQUIRES it. Everywhere else the schema parses
// the member optional, and the daemon's tested obligation is that a composite settlement ALWAYS populates
// it while a bare rollback settlement NEVER does — presence reports a composite settlement without being
// a parse-time discriminator. The VALUE, by contrast, IS expressible, and the fragment is split by
// terminal state so the contract stops admitting shapes Spec-004 §Required Behavior declares invalid
// (Codex round 6): in V1 the value is state-determined — `applied` ⇒ `"admitted"`, every `degraded` arm ⇒
// `"unapplied"` — so the applied class admits only the first literal and the degraded class only the
// second, on the round-5 precedent that encodes a normative mapping in the arm types instead of leaving
// it to prose. It stays a SEPARATE AXIS from the disposition (it names no leg and reports the replacement
// leg's outcome, not the earliest-failing one) and from the rewind grouping; widening it — an `applied`
// composite whose resend was unapplied — is a named future amendment, never an unregistered shape the
// daemon might emit silently.
interface RollbackAppliedResendOutcome {
  resendDisposition?: "admitted";
}
interface RollbackDegradedResendOutcome {
  resendDisposition?: "unapplied";
}
type RollbackInterventionResult =
  | (RollbackAppliedResult & RollbackAppliedResendOutcome)
  | (RollbackDegradedResult & RollbackDegradedResendOutcome);
// The atomic edit-and-resend composite's four structural refusal guards, typed (2026-09-06 amendment).
// Spec-004 §Required Behavior states all four and this registry previously settled them as `rejected`
// results carrying `rejectionReason` alone. That member is a machine-readable CAUSE and never prose (its
// own comment below, and the shipped console renders it verbatim in a refusal `code` slot that is "never
// prose, never localized, never reworded" — `apps/desktop/src/renderer/src/console/core/refusal.ts#ConsoleRefusal`) —
// what it is not is a CLOSED VOCABULARY: [error-contracts.md §Intervention](./error-contracts.md#intervention)
// deliberately registers no code for an intervention OUTCOME (`rejected` / `expired` / `degraded` "are
// states, not error codes"; that namespace covers only request-level refusals producing no intervention
// row), so no contract enumerates the causes a rollback `rejected` may carry and its wire type bounds
// length / whitespace / NUL rather than a value set. A client could therefore SHOW the cause and not
// SWITCH on it — a refusal family added later carries a new identifier every exhaustive read falls
// through, silently and at no compile-time cost. This union closes that gap for the four guards, the
// shape `refusal.ts` already prescribes (each producer "keeps its own closed code union and widens into
// this shape at its boundary"), so a fifth guard breaks compilation at every exhaustive reader rather
// than passing. The four literals are that paragraph's own guard names — "No active turn", "No
// pending send", "A participant-authored target of this run", "A resumable target" — kebab-cased with the
// leading article dropped, so each names the CONDITION THE GUARD REQUIRES rather than restating the
// failure. Closed: a fifth guard is an amendment of Spec-004 §Required Behavior and of this type, never a
// free string the daemon invents. The union is the wire vocabulary only — the eligibility predicate that
// evaluates the guards is the daemon's (Plan-004 T3.17), and the affordance's client-side projection of
// it (I-004-24) stays a fail-closed projection, never a second source of eligibility truth. The literal
// is also the durable one: T3.17 persists it to `interventions.rejection_guard`, whose column-attached
// CHECK closes the same four literals and binds them to the `rollback` `rejected` arm, so the at-rest
// vocabulary and this union are amended together or not at all.
type RollbackCompositeRejectionGuard =
  | "no-active-turn"
  | "no-pending-send"
  | "participant-authored-target"
  | "resumable-target";
// The response is discriminated on `interventionType` (campaign B9, Codex round 2) so the SDK-seam +
// daemon Zod schema parse `result` STRICTLY per type: a `rollback` response validates `result` as
// RollbackInterventionResult and a malformed rollback result FAILS validation — it never falls through a
// permissive generic arm (which would let a malformed rollback outcome cross the boundary). The rollback
// arm is additionally split by lifecycle state (Codex round 3) and state-scoped per disposition class
// (Codex round 5): a TERMINAL rollback outcome REQUIRES the recorded disposition — Spec-004 needs it for
// rendering and the same-position file-leg-recovery carve-out reads the recorded outcome — and `applied`
// admits ONLY RollbackAppliedResult while `degraded` admits ONLY RollbackDegradedResult — each intersected
// with its OWN class-scoped resend fragment, which adds no disposition and narrows no disposition class,
// but does bind the resend literal to the terminal state (round 6) — so a
// disposition-less terminal response fails parse, and so does a state/disposition mismatch (`applied` +
// `files-unrestored` would otherwise exit-map 0 while rendering a failed restore, since the CLI derives
// the POSIX code from `state`). `rejected` REQUIRES `rejectionReason` (round 5 — every refusal family of
// Queue And Intervention Model §Intervention State Transition Table carries its machine-readable cause),
// and since 2026-09-06 that arm additionally carries the additive-optional `rejectionGuard` when the
// refusal came from one of the composite's four structural guards (the arm comment below);
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
      result: RollbackAppliedResult & RollbackAppliedResendOutcome;
      rejectionGuard?: never; // the guard is the `rejected` arm's alone (Codex PR #449 round 4): `?: never` on every other arm so a producer-side variable carrying it fails at its construction site, not at the client's strict parse
    })
  | (InterventionResponseBase & {
      interventionType: "rollback";
      state: "degraded"; // partial / zero-effect terminal — MANDATORY degraded-class disposition (round 5)
      result: RollbackDegradedResult & RollbackDegradedResendOutcome;
      rejectionGuard?: never;
    })
  | (InterventionResponseBase & {
      interventionType: "rollback";
      state: "rejected"; // pre-dispatch refusal — the machine-readable cause is MANDATORY (round 5)
      rejectionReason: string;
      rejectionGuard?: RollbackCompositeRejectionGuard; // 2026-09-06 typed-composite-guard amendment (Spec-004 §Required Behavior's four-structural-refusal-guards paragraph; Plan-004 I-004-21, mirrored by T1.3 and produced by T3.17). ADDITIVE-OPTIONAL and ARM-SCOPED: declared HERE and not on InterventionResponseBase, because only a `rollback` request can be a composite and only a `rejected` composite settles on one of these guards — a strict parse then REFUSES the member on a steer / interrupt / cancel rejection and on every non-`rejected` state, rather than admitting a guard on an arm that can never raise one. PRODUCER-OBLIGATED within the arm, the `resendDisposition` shape: no member of a `rejected` response identifies its request as composite (`replacementSend` is request-side and the response does not echo it), so requiredness is not expressible at the strict-parse boundary; the daemon's tested obligation is that a refusal raised by one of the four guards ALWAYS populates it and every other refusal family never does — the EIGHT [Queue And Intervention Model §Intervention State Transition Table](../../domain/queue-and-intervention-model.md#intervention-state-transition-table) admits for a rollback: capability, authorization, target-position domain, compaction-boundary, incompatible target run state, the Spec-010 restore precondition, uncompacted-rewind-span, and execution-root `busy`. `rejectionReason` is unchanged — the member exists so a renderer maps guard -> remedy by an exhaustive switch its sibling's open vocabulary cannot support. NO error code is minted: these guards settle as `rejected` RESULTS, never as `JsonRpcError` envelopes. REPLAY-DURABLE (round 2): a `rejected` intervention carries no `result` on this wire, so an idempotent replay of the same `clientIdempotencyKey` reconstructs the response from the durable row alone — the reason `rejectionReason` has the `interventions.rejection_reason` column — and the guard literal is NOT recoverable from that sibling, whose open unenumerated vocabulary is exactly what this member exists to close; the daemon therefore persists it to `interventions.rejection_guard` (additive nullable, vocabulary-closed and arm-bound by a column-attached CHECK) and a replay returns a value EQUAL to the recorded one, a daemon restart included. ADDITIVE-OPTIONAL UNDER THE EXISTING PROTOCOL VERSION: the arm has shipped, so ADR-018 §Decision #8's additive-only rule for already-published shapes binds, and a new optional member is squarely inside what that rule admits ("new optional fields with defaults, new event types, new enum values") and outside everything it forbids — no rename, no type change, no semantic change, no new required field, no new required semantic invariant. It therefore rides the `2026-05-01` protocol version and mints no revision, exactly as every additive member registered here since that ratification has (`replacementSend` and the `boundary-diverged` arm on this same rollback shape, `resendDisposition`, `run.queued`'s `admittedProviderAccountId`, `usage.cost_update`'s `effectivePrincipal`, `SessionReadResponse`'s `peerInvocationEnabled`), and as the daemon's still single-valued supported set at `packages/runtime-daemon/src/ipc/protocol-negotiation.ts#DAEMON_SUPPORTED_PROTOCOL_VERSIONS` records. A revision would buy nothing here in any case: what refuses an unknown key is the CLIENT's own `.strict()` schema, so tolerating one would take an old-protocol projection on the daemon — a compatibility layer for a mixed-revision install of a single in-tree monorepo release, which is not a configuration V1 supports.
      result?: never;
    })
  | (InterventionResponseBase & {
      interventionType: "rollback";
      state: "requested" | "accepted" | "expired";
      result?: never;
      rejectionGuard?: never; // no disposition exists on these states, and no guard
    })
  | (InterventionResponseBase & {
      interventionType: "steer" | "interrupt" | "cancel";
      result?: Record<string, unknown>;
      rejectionGuard?: never; // only a rollback request can be a composite
    });

// RunStateChange (event, not request/response). The `run.failed` variant carries the
// `providerFailureDetail` surface that mirrors the `failed`-variant `providerFailureDetail` of `DriverResumeResult`
// (§Plan-005 above) — Spec-005 §Fallback Behavior requires resume-failure detail to reach the canonical audit
// log so Plan-015's recovery dispatcher and Plan-013's timeline can render the operator-actionable
// reason for the failure without re-querying the driver. Plan-005 CP-005-5; Plan-006 Phase 3 audit. TWO PRODUCERS, ONE FIELD (2026-08-25): the resume failure that introduced this member writes FREE-FORM prose. The Spec-005 outbound-frame neutralization tripwire writes ONE fixed daemon-composed machine-readable form instead — the registered error code, one space byte (0x20), then `origin=` followed by one of `participant_text` / `system_narration` / `unknown`, so `driver.text_neutralization_failed origin=participant_text` is an entire value. Parse rule: read the cause as the substring before the first space and the origin as the substring after `origin=`; a value whose leading token is not a registered error code is the prose producer, and no consumer may assume the whole value is prose (Spec-005 §Required Behavior).
interface RunStateChangeEvent {
  runId: RunId;
  runVersion: number; // run-progression counter (D-004-1): the optimistic-concurrency comparand clients read via run.subscribeState and pass back as `expectedRunVersion`. Advances on every run progression, applied interventions included. A no-state-change advance with no per-type event of its own (e.g. native steer) is NOT emitted as a discrete run.subscribeState event (no transition to record, `Spec-004 §Driver-Level Steer Mechanics`); the carve-out is the in-place rollback from paused (campaign B2) — it also transitions no state, but its per-type RunRolledBackEvent below rides the same stream carrying the fresh post-rollback runVersion, so subscribers are never blind to a rewind. A non-intervening subscriber may still hold a stale comparand after a steer-like advance until its next guarded request is correctly rejected `expired`, whereupon it re-reads run-state and retries (reject→re-read→retry; V1 adds no broadcast push for such no-per-type-event bumps — Spec-006 §Security Events / Run Lifecycle). Distinct from the immutable EventEnvelope `.version` (Spec-006 §EventEnvelope Version Semantics) — that is the wire-contract semver; this is the run aggregate's concurrency token.
  previousState: RunState;
  currentState: RunState;
  failureCategory?: RunFailureCategory;
  recoveryCondition?: RecoveryCondition; // named type in §Plan-005 above (campaign B3): 'recovery-needed' | 'reauth-required'
  recoverySpanClassification?: RecoverySpanClassification; // span-content sibling of recoveryCondition (Part-B follow-up 2026-07-17)
  healthSignal?: "stuck-suspected";
  providerFailureDetail?: string; // populated on `run.failed` when failureCategory='provider'; two producers, one field — free-form prose from the resume-failure producer, one fixed `<registered code> origin=<arm>` form from the Spec-005 neutralization tripwire (parse rule in the comment block above)
  completionKind?: "turn" | "task"; // on `run.completed`: whether the completion closes a conversational turn or the whole task — optional in the shared shape only for pre-B1 history; post-B1 emitters MUST set it (Spec-006 §Run Lifecycle run-state payload, 2026-07-02 B1 amendment)
  intendedClose?: true; // daemon-initiated closeSession clean-terminal discriminator: present only on that path, absent on every other terminal; consumers MUST NOT classify such a terminal as a crash (Spec-006 §Run Lifecycle "Intended-close discriminator", 2026-07-02 B1 amendment)
  executionPosture?: ExecutionPosture; // named type in §Plan-005 above (campaign B3 hoist — same shape, now shared with the CreateSessionParams/StartRunParams spawn/turn carriers). Stamped only on run.running — the post-setup-gate spawn-success transition, where the resolved workspace root and effective posture are final (Plan-004 gate seam; a run.starting stamp would be premature) — recording the run's effective sandbox/permission posture for audit (Spec-006 §Run Lifecycle run-state payload, 2026-07-02 B1 amendment item 11; shape owned by Spec-005 per campaign B3, policy semantics per Spec-012 §Required Behavior, campaign B20). Optionality is for pre-B20 history and non-running rows only: once B20's posture semantics land, run.running emitters MUST stamp the complete posture object — including credentialPolicyRef on both sandboxed modes (absent under mode:'trusted').
  trigger?:
    | "turn_limit"
    | "budget_exhausted"
    | "idle_timeout"
    | "moderation_denied"
    | "workflow_phase_cancelled"; // stop-condition provenance (additive per ADR-018): 'turn_limit' rides run.completed at the turn limit (Plan-016 D-016-8 — the value CP-004-10 adds to Plan-004's trigger set); the four InterruptReason values ride run.interrupted on system interrupts (D-016-7; 'workflow_phase_cancelled' added 2026-08-11, Plan-016 D-016-23 — the Spec-017 SA-9 cascade). Absent on natural completion and user-initiated paths; the Runs View / timeline stop-condition rendering (Spec-023) reads this field.
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
// `options` (2026-08-29) is ADDITIVE-OPTIONAL and carries the closed choice set an input-kind ask
// offers, where the provider's own ask declares one — the Codex item/tool/requestUserInput and MCP
// elicitation surfaces can, the Claude control round-trip does not. Reported at the DRIVER's
// normalize boundary and never synthesized by a consumer, so its absence means the provider offered
// no choice set the driver could represent — never that a represented one was lost in transit. It
// carries NO refinement on either kind or any state, deliberately: requiring it anywhere would
// refuse a legitimate ask from the one mechanism that cannot supply it. Its reader is the Spec-013
// input-ask card, whose free-text answer arm is unconditional for exactly that reason. Answers
// travel on the already-registered `driver.respondToRequest`, whose `response` is unknown-typed —
// no wire member is minted for them.
// BOUNDED BEFORE APPEND. The choice set is provider- or MCP-authored and this payload is a durable
// canonical event, so the array's CARDINALITY and both `value` and `label` are bounded in the
// payload schema itself (`wireFreeFormString`: length + non-whitespace + NUL-rejection). Without
// those bounds the event log's 32 KiB canonical ceiling would be the first guard, and an oversized
// but schema-valid ask would fail only at append — leaving the run waiting on an input card that was
// never recorded, which is the one outcome an interactive-request family must not produce. With
// them the over-large set is refused at the driver's own boundary while the ask itself still
// arrives: the driver reports the ask WITHOUT `options` and records a driver-band diagnostic naming
// the drop, and the card's unconditional free-text arm carries the answer. That is why the absence
// clause above is scoped to representability rather than to the provider's intent — a dropped set
// is legible in the driver diagnostics, and no path both drops a set and reports nothing.
interface DriverAskEvent {
  sessionId: SessionId;
  runId: RunId;
  askId: string;
  kind: "permission" | "input";
  toolName?: string;
  prompt?: string;
  options?: ReadonlyArray<{ value: string; label?: string }>;
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

// HistoryBackfill (Spec-008 §Peer History Backfill On Join (V1), 2026-08-03 amendment; typed by
// Plan-008's R4 backfill task T-008r-4-14, 2026-08-11). On the RELAY these shapes are
// application-level payloads INSIDE the established pairwise ciphertext envelope (Spec-008
// §Message Framing — no new frame message type, no SessionKeyBundle change, no control-plane
// tRPC procedure; the relay forwards opaque ciphertext and learns nothing). Because that one
// envelope carries more than one message family, each payload is tagged with a required `kind`
// member and demultiplexed through the Plan-008-owned RelayApplicationPayload discriminated
// union — see the §Envelope-Interior Application-Payload Kind Registry below (CP-008-16,
// ratified 2026-08-12 as Plan-014 D-014-5); unknown kinds are dropped fail-closed. They DO cross the
// local client↔daemon boundary: pairwise decryption is client-side (bundle custody) while
// verification + append are daemon-side, so the decrypted payloads ride the four daemon
// JSON-RPC bridge methods in the §History-Backfill Bridge Method Registry below (CP-008-14 —
// re-scoped 2026-08-11, Codex PR #323 round 2; the prior "no daemon JSON-RPC method" claim held
// the relay-payload shapes to a rule that would have left the daemon engines with no caller).
// A response is split at the application layer before encryption wherever a chunk would exceed
// the 64 KB frame ceiling; the frame codec is unchanged, and no single entry can exceed a frame
// because Spec-006 §Canonical Serialization Rules bounds canonical bytes at
// EVENT_CANONICAL_BYTES_MAX = 32 KiB at append (base64 4/3 expansion + members + AEAD + framing
// ≈45 KiB worst case — under the ceiling with headroom; no reassembly protocol exists).
interface HistoryBackfillRequest {
  kind: "history_backfill_request"; // the RelayApplicationPayload discriminant — see the §Envelope-Interior Application-Payload Kind Registry below (Plan-008 CP-008-16, ratified 2026-08-12 as Plan-014 D-014-5); required, and an absent or unrecognized kind is dropped fail-closed by the coordinator demux rather than dispatched
  sessionId: SessionId; // the only selector — V1 mints no cross-daemon cursor: a source answers with its full origin-signed entitled holdings and the joiner discards duplicates (append is idempotent on the event id)
  correlationId: string; // requester-minted per-request identifier; completion accounting ONLY, never dedup (dedup keys on the event id alone)
}
interface HistoryBackfillEntry {
  originNodeId: NodeId; // the origin daemon the signature resolves under (register-once daemon_signing_public_keys roster key)
  canonicalBytes: string; // base64 of the ORIGIN's RFC 8785 canonical bytes, verbatim — transport, never authorship: a source never re-signs and never re-canonicalizes what it serves
  daemonSignature: string; // the origin's Ed25519 signature over exactly those bytes (lowercase hex, the Plan-006 T2.3 wire convention); verified against the origin NodeId's roster key BEFORE append — a failed verification refuses the entry and surfaces audit_integrity_failed, never appends
  stub: boolean; // true when the source holds only the post-compaction audit stub — canonicalBytes/daemonSignature then carry the stub and its stub_signature, verified on the Spec-006 anchor-plus-stub path
  coveringAnchor?: HistoryBackfillCoveringAnchor; // present iff stub: true — the origin's covering anchor record, carried so the joiner can run BOTH halves of the anchor-plus-stub path without racing the anchor's asynchronous control-plane upload; absent or failing → the entry is refused (anchor_missing_for_compacted_range / anchor_signature_invalid), never appended
}
// The origin-signed anchor record covering a stubbed row's range — the event_log_anchors row shape
// (shared-postgres-schema.md §Event Log Anchors) as an application payload. Origin-signed, so an
// untrusted source can CARRY but not forge it; the joiner verifies rootSignature under the same
// origin roster key the entry resolves against, then the coverage test, then the stub_signature.
interface HistoryBackfillCoveringAnchor {
  sessionId: SessionId;
  nodeId: NodeId; // MUST equal the entry's originNodeId — the key the rootSignature resolves under
  startSequence: number;
  endSequence: number; // coverage test per Spec-006 §Post-Compaction Integrity: startSequence <= stubbed row's sequence <= endSequence (covering is a coverage test, not exact-start)
  merkleRoot: string; // base64 of exactly 32 bytes — the AnchorPayload wire convention above (the EventAnchorUpload block)
  rootSignature: string; // base64 of exactly 64 bytes — Ed25519 by the origin daemon's session-scoped key over the ANCHOR CLAIM: the RFC 8785 canonicalization of {endSequence, merkleRoot, nodeId, sessionId, startSequence} per Spec-006 §Anchoring Cadence (2026-08-11 amendment — coordinates signed, so the coverage test below runs against origin-attested spans; a root-only signature left them carrier-writable, Codex PR #323 round 2)
  anchoredAt: string;
}
interface HistoryBackfillChunk {
  kind: "history_backfill_chunk"; // the RelayApplicationPayload discriminant — see the §Envelope-Interior Application-Payload Kind Registry below (Plan-008 CP-008-16, ratified 2026-08-12 as Plan-014 D-014-5). Inside the responderSignature preimage below (that signature covers this chunk's members EXCLUDING itself), so on a terminal chunk the tag is unstrippable in carriage rather than advisory
  correlationId: string; // echoes the request
  ordinal: number; // 0-based chunk position within this source's response — completion is DECLARED, never inferred: answered = terminal marker received AND every declared ordinal held AND distinct verified entry ids across the response equal the signed totalEntries (2026-08-12, Codex PR #323 round 3: the responder signature covers the terminal members, not the unsigned data chunks, so reconciliation is what makes a dropped-then-duplicate-padded or renumbered stream fail to earn credit; Spec-008 §Peer History Backfill On Join (V1))
  entries: HistoryBackfillEntry[]; // possibly empty — an entitled-empty source answers as a single zero-entry terminal chunk
  terminal: boolean; // true on exactly the final chunk of the response…
  totalEntries?: number; // …which declares the total entry count across all chunks (present iff terminal)
  servesForOrigins?: NodeId[]; // present iff terminal: the origin NodeIds this response claims to serve for — its own always, a migrated predecessor's only alongside rows/stubs actually verifying under that origin's key (an empty foreign claim is never credited; Spec-008 §Failure honesty). Inside the responder-signed member set below, so a claim list cannot be stripped or padded in carriage
  responderNodeId?: NodeId; // present iff terminal — the responding daemon's own NodeId, the self-claim's subject (2026-08-11, Codex PR #323 round 2)
  responderSignature?: string; // present iff terminal — lowercase hex of 64 bytes (the Plan-006 T2.3 wire convention): Ed25519 under responderNodeId's roster key (the daemon session signing key the source engine holds) over the RFC 8785 canonicalization of this chunk's members EXCLUDING this one. The pairwise envelope authenticates only the sending ParticipantId and the roster carries no participant linkage, so this is the ONLY proof binding the terminal declarations (totalEntries, servesForOrigins) to a node identity — the joiner verifies it via the CP-008-11 roster read before crediting the self-claim, and an unsigned, wrong-key, or forged terminal marker leaves the source outstanding and the self-claim uncredited (fail-closed)
}
// The live-relay sibling arm (typed 2026-08-12, Codex PR #326 round 1 — a Zod discriminatedUnion
// needs an object schema per arm, and this arm had prose only): a tagged wrapper nesting exactly
// one HistoryBackfillEntry, so the live path consumes the SAME entry type the backfill path
// consumes — "live receive and backfill share one verification path" is type-level, not aspirational,
// and the entry's member docs have one home. The entry itself stays tagless (chunk-interior rule).
interface RelayedSessionEventPayload {
  kind: "relayed_session_event"; // the RelayApplicationPayload discriminant — see the §Envelope-Interior Application-Payload Kind Registry below
  entry: HistoryBackfillEntry; // the origin triple verbatim (originNodeId, canonicalBytes, daemonSignature; stub carried for a compaction racing the live send) — forwarded as-is into the CP-008-13 verify-and-append engine by session.relayEventDeliver
}
```

### History-Backfill Bridge Method Registry (Tier 5, Plan-008 T-008r-4-14)

The client↔daemon bridge for relay-decrypted payloads (registered 2026-08-11, Codex PR #323 round 2 — Plan-008 CP-008-14): pairwise decryption is client-side where bundle custody lives, while roster-resolved verification and log append are daemon authority, so the [Spec-008 §Peer History Backfill On Join (V1)](../../specs/008-control-plane-relay-and-session-join.md#peer-history-backfill-on-join-v1) payloads cross the local [Spec-007](../../specs/007-local-ipc-and-daemon-control.md) JSON-RPC boundary through four daemon methods — an EXTEND of the Tier-1 `session.*` namespace root under the [cross-plan-dependencies.md §2](../cross-plan-dependencies.md#2-package-path-ownership-map) root-extension class (the Plan-024 lease-pair / Plan-016 goal-pair precedent), handler files under `packages/runtime-daemon/src/ipc/handlers/`, backed by Plan-008's own `packages/runtime-daemon/src/backfill/` engines. The first three are T-008r-4-14's; the fourth is the live-relay sibling on T-008r-4-10's inbound leg, riding the **same** verify-and-append engine (ADR-017's receive semantics are one path, live or deferred — Spec-008: "backfill is that path deferred, not a second one").

| Method | Type | Semantics |
| --- | --- | --- |
| `session.historyBackfillStart` | request/response | Joiner-side, coordinator-called at relay admission: the daemon joiner engine mints the `correlationId`, registers the two-axis coverage expectations (member sources excluding self; roster origins), credits the joiner's own origin from the local log, and returns the `HistoryBackfillRequest` the coordinator seals to each **other** current member |
| `session.historyBackfillServe` | streaming (subscribe-init ack + chunk notifications, the Plan-007 streaming primitive) | Source-side, coordinator-called when a decrypted `HistoryBackfillRequest` arrives, carrying the pairwise-authenticated requester `ParticipantId`: the daemon source engine runs the possession-bound entitlement selection, builds chunks in ordinal order, and signs the terminal marker under its own roster key (the key is daemon-held — the signature can only be produced here); the coordinator seals and publishes each chunk as it streams |
| `session.historyBackfillDeliver` | request/response | Joiner-side, coordinator-called per decrypted `HistoryBackfillChunk`, carrying the source `ParticipantId`: the daemon joiner engine verifies the terminal responder signature and every entry (roster read, verify-before-append), appends under ADR-017 receive semantics with `received_from_node_id` stamped, updates coverage accounting, and returns the per-chunk disposition (appended / refused / duplicate counts) |
| `session.relayEventDeliver` | request/response | Joiner-side live sibling (T-008r-4-10 inbound leg): a decrypted `RelayedSessionEventPayload` (the tagged wrapper above) whose nested `HistoryBackfillEntry` is forwarded verbatim into the same verify-and-append engine, so live receive and backfill share one verification path, one entry type, and one append seam (CP-008-13) |

No control-plane procedure is added, and nothing here rides the relay transport itself — these are local IPC registrations on the established daemon surface, the same trust boundary every client-initiated daemon action already crosses.

### Envelope-Interior Application-Payload Kind Registry (Tier 5, Plan-008 T-008r-1-3)

The discriminator that separates the message families riding **inside** one pairwise ciphertext envelope (registered 2026-08-12 — Plan-008 CP-008-16, ratified as Plan-014 D-014-5 by that plan's relay-scope targeted readiness-audit delta). [Spec-008 §Peer History Backfill On Join (V1)](../../specs/008-control-plane-relay-and-session-join.md#peer-history-backfill-on-join-v1) and [Spec-014 §Cross-Node Artifact Relay (V1)](../../specs/014-artifacts-files-and-attachments.md#cross-node-artifact-relay-v1) each place their payloads in that envelope and each refuses a new frame message type, citing the other's use of the same seam — so without a tag the receiving demultiplexer has no input at all. **Owner: Plan-008**, in `packages/contracts/src/session-join.ts` — one level below the `RelayFrameType` 1-byte frame enum hoisted into the same file by the NS-19 Tier-7 audit (D-025-1): `RelayFrameType` separates frames, this union separates payloads inside one frame's decrypted plaintext. The union is `RelayApplicationPayload`, a Zod `discriminatedUnion` over the required string member **`kind`**, whose vocabulary is the `RelayApplicationPayloadKind` enum. It lands with the codec block at **T-008r-1-3** (the file itself CREATEd at T-008r-1-1) and is consumed by the client coordinator's demux at **T-008r-4-10** and the bridge engines at **T-008r-4-14**.

| `kind` | Payload | Registering plan |
| --- | --- | --- |
| `history_backfill_request` | `HistoryBackfillRequest` (above) | Plan-008 (owner) |
| `history_backfill_chunk` | `HistoryBackfillChunk` (above) | Plan-008 (owner) |
| `relayed_session_event` | `RelayedSessionEventPayload` (above) — the tagged wrapper nesting one `HistoryBackfillEntry` verbatim, consumed by the §History-Backfill Bridge Method Registry's `session.relayEventDeliver` row (T-008r-4-10's inbound leg) | Plan-008 (owner) |
| `artifact_key_attestation` | `ArtifactKeyAttestationPayload` (§Plan-014 — Artifacts Files And Attachments below) — the Ed25519-identity-signed artifact-key attestation of [Spec-014 §Cross-Node Artifact Relay (V1)](../../specs/014-artifacts-files-and-attachments.md#cross-node-artifact-relay-v1) Publish step 3; the runtime schema stays in Plan-014's own `packages/contracts/src/artifacts/` domain and the arm references it (typed 2026-08-12, Codex PR #326 round 2) | Plan-014 (Task 7, CP-014-4) |

**Fail-closed on unknown kinds.** A decrypted payload whose `kind` is absent or is not a registered value is **dropped with a logged refusal** and never dispatched to a bridge method — a forward-compatible peer's unrecognized family is discarded, never mistaken for a registered one. This is the one rule that makes the seam safe to extend.

**Registration seam.** A consuming plan appends its own arm and keeps the payload schema in its own contract domain; Plan-008 owns only the tag, the union, and the exhaustiveness rule. This is the same one-owner-many-registrants shape the `SessionEventSchema` union already uses on the [cross-plan-dependencies.md §2](../cross-plan-dependencies.md#2-package-path-ownership-map) `packages/contracts/src/` row. `HistoryBackfillEntry` and `HistoryBackfillCoveringAnchor` are chunk-interior and carry **no** tag — only the payload sealed directly into the envelope does. On a terminal `HistoryBackfillChunk` the tag sits inside the `responderSignature` preimage, so it is unstrippable in carriage. Everything registered here is additive and unshipped, so no version bump is owed and no plan or spec changes Status.

### Artifact-Attestation Bridge Method Registry (Tier 7, Plan-014 Task 7)

The client↔daemon bridge for the `artifact_key_attestation` arm (registered 2026-08-12, Codex PR #326 round 2 — the kind-registry row above named the arm but no method carried it across the local boundary, and the custody split forces one: the durable X25519 artifact key and the recipient-key cache are daemon-held in `packages/runtime-daemon`, while the pairwise envelope coordinator, decryption, and the injected `Ed25519IdentitySigner` (Plan-008 T-008r-4-2; custody ADR-021 CLI / ADR-010 + Plan-023 desktop — the daemon never holds the identity key) are client-side, and CP-008-14's four methods carry Plan-008's own arms only). Unlike the §History-Backfill registry above this is **not** a `session.*` root extension: the pair registers on the `artifact.*` namespace Plan-014 already owns on the [cross-plan-dependencies.md §2](../cross-plan-dependencies.md#2-package-path-ownership-map) `ipc/` row — a plan-owned registration under Plan-007's `MethodRegistry` substrate, no Plan-008 involvement. Handler files under `packages/runtime-daemon/src/ipc/handlers/`, backed by Task 7's attestation engine.

| Method | Type | Semantics |
| --- | --- | --- |
| `artifact.keyAttestationServe` | request/response | Outbound half, coordinator-called when the local node's binding must be published (relay join, Task 7 key provision): the daemon returns the **unsigned** attestation material — `sessionId`, its own `nodeId`, the durable `artifactPublicKey` — and the coordinator signs the literal Spec-014 preimage with the injected `Ed25519IdentitySigner`, assembles `ArtifactKeyAttestationPayload`, and seals it to each pairwise peer. Signing is client-side because identity custody is (ADR-021 / Plan-023); the daemon serves material, never signatures |
| `artifact.keyAttestationDeliver` | request/response | Inbound half, coordinator-called per decrypted `artifact_key_attestation`: the coordinator verifies `identitySignature` against the **sending participant's** registered identity keys (the pairwise-authenticated envelope sender — verification lives beside the bundle trust layer, client-side, and an unverified payload is refused there, never forwarded) and delivers the verified `{nodeId, artifactPublicKey}` binding plus the attesting `ParticipantId` to the daemon, which derives the key thumbprint and updates its last-received-wins recipient-key cache per [Spec-014 §Cross-Node Artifact Relay (V1)](../../specs/014-artifacts-files-and-attachments.md#cross-node-artifact-relay-v1) |

As with the History-Backfill registry: no control-plane procedure is added and nothing here rides the relay transport — these are local IPC registrations on the established daemon surface, the same trust boundary every client-initiated daemon action already crosses.

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

// ParticipantIdentityKeyRegister (Plan-018 T5.2, 2026-08-15 NS-62 pass)
// Register-once per (participant, fingerprint); self-only (authenticated sub must
// equal participantId). Same-key replay → acknowledged idempotent no-op; a different
// publicKey under an existing fingerprint → participant.identitykeyregister_conflict
// (409) BEFORE any row mutation (I-018-12; ADR-021 Refuse-On-Rotation, control-plane half).
interface ParticipantIdentityKeyRegisterRequest {
  participantId: ParticipantId;
  keyFingerprint: string; // per-key selector (the Plan-014 identityKeyFingerprint value)
  publicKey: string; // 64-char lowercase hex Ed25519 public key
}
interface ParticipantIdentityKeyRegisterResponse {
  participantId: ParticipantId;
  keyFingerprint: string;
  registeredAt: string; // original registration time — stable across idempotent replays
}

// ParticipantIdentityKeyRoster (Plan-018 T5.3, 2026-08-15 NS-62 pass)
// Membership-gated (any active session role); the membership predicate and the row
// read execute in ONE statement so non-member and nonexistent-session refusals are
// byte-identical participant.permission_denied 403s (I-018-13). Key bytes never ride
// ParticipantProjection (I-018-14). Consumers: Plan-027 dispatch intake, Plan-014
// attestation-delivery fingerprint selection, Plan-008 bundle-admission resolution
// (CP-018-13 a/b/c).
interface ParticipantIdentityKeyRosterRequest {
  sessionId: SessionId;
  participantId: ParticipantId;
  keyFingerprint?: string; // omit for the participant's full registered set
}
interface ParticipantIdentityKeyRosterResponse {
  participantId: ParticipantId;
  keys: ParticipantIdentityKey[];
}
interface ParticipantIdentityKey {
  keyFingerprint: string;
  publicKey: string; // 64-char lowercase hex Ed25519
  registeredAt: string;
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

Plan-018's identity / participant-state reads and updates are exposed as five `participant.*` methods (Plan-018 CP-018-6 — widened from three at the 2026-08-15 NS-62 promotion pass with the identity-key pair). Names are registered here pending the Plan-007 daemon method-name registry merge; the reciprocal `provides` is recorded on [Plan-007](../../plans/007-local-ipc-and-daemon-control.md). Same `dotted-camelCase` `METHOD_NAME_FORMAT` as the other namespaces above.

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `participant.projectionRead` | `query` | `ParticipantProjectionReadRequest` | `ParticipantProjectionReadResponse` |
| `participant.stateUpdate` | `mutation` | `ParticipantStateUpdateRequest` | `ParticipantStateUpdateResponse` |
| `participant.presenceDetail` | `query` | `PresenceDetailReadRequest` | `PresenceDetailReadResponse` |
| `participant.identityKeyRegister` | `mutation` | `ParticipantIdentityKeyRegisterRequest` | `ParticipantIdentityKeyRegisterResponse` |
| `participant.identityKeyRoster` | `query` | `ParticipantIdentityKeyRosterRequest` | `ParticipantIdentityKeyRosterResponse` |

`participant.presenceDetail` returns per-device presence fan-out and is **owner/operator-only** (Plan-018 D-018-5 / I-018-6): per-device detail is privacy-sensitive, so the aggregated `presenceState` on `ParticipantProjection` remains the participant-visible default and the device-level breakdown is gated to the session owner / daemon operator (see [Security Architecture §Per-Device Presence Detail Authorization](../security-architecture.md#per-device-presence-detail-authorization)). `participant.identityKeyRoster` is membership-gated (I-018-13); `participant.identityKeyRegister` is self-only register-once (I-018-12), its production caller held by Plan-018's client-side presenter carrier box. `participant.stateUpdate` and `participant.identityKeyRegister` are the two mutations. Every method's daemon-side responder is authored (T4.6 the first three; T5.8 the identity-key pair) per the D-018-6 no-method-without-responder rule. Canonical Zod schemas live in `packages/contracts/` per the §Source-of-Truth Policy.

### WebAuthn Ceremony Procedure Registry (Tier 5, Plan-018 Phase 6)

Registered 2026-09-01 ([cross-plan-dependencies.md §6](../cross-plan-dependencies.md) node NS-99, Codex round 5; widened to five rows at round 7). These are **control-plane tRPC procedures on the Plan-008 `sessionRouter`**, not daemon JSON-RPC methods: the caller is the Electron main process over its own control-plane channel per `Spec-023 §Main Process Responsibilities`, never a client reaching through the local daemon gateway. No method string is minted, the five-method `participant.*` registry above does not move, and Plan-018's I-018-8 daemon-as-gateway rule is untouched. The table holds **four ceremony operations plus one credential-lifecycle operation**; the heading keeps its original text, which six documents cite by anchor.

| Operation | Procedure type | Authentication | Request schema | Response schema |
| --- | --- | --- | --- | --- |
| `WebAuthnRegistrationOptionsIssue` | `mutation` | required | `WebAuthnRegistrationOptionsIssueRequest` | `WebAuthnRegistrationOptionsIssueResponse` |
| `WebAuthnRegistrationVerify` | `mutation` | required | `WebAuthnRegistrationVerifyRequest` | `WebAuthnRegistrationVerifyResponse` |
| `WebAuthnAuthenticationOptionsIssue` | `mutation` | **none** | `WebAuthnAuthenticationOptionsIssueRequest` | `WebAuthnAuthenticationOptionsIssueResponse` |
| `WebAuthnAuthenticationVerify` | `mutation` | **none** | `WebAuthnAuthenticationVerifyRequest` | `WebAuthnAuthenticationVerifyResponse` |
| `WebAuthnCredentialRevoke` | `mutation` | required | `WebAuthnCredentialRevokeRequest` | `WebAuthnCredentialRevokeResponse` |

Both issue legs are `mutation` rather than `query` because each one **writes** — it records a challenge row, which is the fence the whole ceremony rests on.

**The authentication pair is deliberately unauthenticated.** Sign-in is pre-authentication by construction: the ceremony is what produces the credential, so a participant on a cold install or a reinstalled machine holds nothing to present, and gating it would make the flow unreachable exactly when it is needed (`Spec-018 §Required Behavior`). What bounds that caller instead is the **ceremony transaction id** — server-minted on the options reply, quoted back on the verify request, single-use, and expiring on the challenge's own clock, so the caller is bound to one transaction rather than to a session. Throttling is the existing `Spec-021 §Canonical Endpoint Group Registry` `auth.endpoint` row (anonymous tier, per source address); **no registry row is minted**, because the second axis the invite-redemption pair uses — a per-token budget beside the per-source one — has nothing to bound here, single-use consumption already capping attempts per transaction at exactly one. The registration pair stays authenticated: enrolment binds an authenticator to an existing participant, and an unauthenticated enrolment would let anyone bind a key to someone else's account. **`WebAuthnCredentialRevoke` is authenticated for the same reason and one more (round 7):** it resolves the credential row under the **caller's own** participant id, which there is no way to know without a session. That resolution is also what makes the operation safe to expose — a request naming another participant's credential id deletes nothing and returns success, exactly as a request naming an id that does not exist does, so the reply enumerates no one's authenticators. Revocation is a hard `DELETE` rather than a `revoked_at` tombstone: a tombstone would let the verify leg tell _revoked_ from _unknown_, the one distinction every refusal arm of this registry is written to withhold, and it would mint a column to obtain it. Removing the participant's **last** credential is permitted — the Device Authorization Grant loopback `Spec-023 §Fallback Behavior` specifies is the way back in, and refusing would keep a compromised authenticator enrolled precisely when the participant is trying to retire it.

**What the replies carry, and why the split is where it is.** The authentication-**options** reply carries the `rpId`, the origin, the challenge, and the transaction id — and **no PRF evaluation input**. The authentication-**verify** reply carries the verdict, the signing credential's stored `uv_mode` (Plan-018 I-018-16), and a **freshly issued PASETO access/refresh pair**. The mode cannot be known any earlier: the desktop's credentials are discoverable, so the options leg offers no credential list and does not know which credential will answer. The token pair rides the verdict because that is the moment the participant is known, and it is issued rather than merely unlocked because a cold install holds no refresh token to unwrap — a sign-in that only unlocks a stored one is unreachable exactly after a reinstall. It is sender-constrained per [ADR-010](../../decisions/010-paseto-webauthn-mls-auth.md) to the DPoP key the caller proves possession of on the verify request; that proof binds a key and establishes no identity, so it does not make this pair a credentialed one and the `Authentication` column above stays **none**.

**Which DPoP proof, and why the shipped validator cannot serve this route (2026-09-01, Codex round 7).** [RFC 9449](https://datatracker.ietf.org/doc/html/rfc9449) defines two proof forms, and this route needs the one the corpus has not implemented. A **token-request** proof ([§5](https://datatracker.ietf.org/doc/html/rfc9449#section-5)) accompanies a request _for_ a token and carries no `ath`, because no access token exists yet. A **resource-request** proof ([§4.3](https://datatracker.ietf.org/doc/html/rfc9449#section-4.3)) accompanies a request that _presents_ one and **requires** `ath`, the hash of that token — which is the form every already-credentialed path in this corpus validates, including the CP-018-12 daemon credential seam. Pointing that validator at `WebAuthnAuthenticationVerify` would reject every legitimate sign-in for a missing `ath`; relaxing the check instead would accept a proof minted for some other request. So the verify leg validates the §5 form on its own terms: `typ` `dpop+jwt`, `htm` and `htu` matching this request's method and URI, `iat` inside the accepted window, a single-use `jti`, an embedded public `jwk` of a permitted algorithm carrying no private parameters, a signature verifying under that `jwk` — and **`ath` required to be absent** rather than merely unchecked, so an oversupplied proof is refused rather than accepted-and-ignored. The issued pair's `cnf.jkt` is the JWK SHA-256 thumbprint of that same key and is computed from the proof, never taken from a separate claim the caller makes; without that the route would hand an unauthenticated caller a bearer pair. A missing, malformed, replayed, or `ath`-bearing proof refuses the whole verification and issues nothing (Plan-018 I-018-20 / T6.3).

**The PRF evaluation input is a contract-fixed public constant (2026-09-01, Codex round 6).** Its registered value is the ASCII string `"ai-sidekicks/kek/v1"`, identical for every credential and every ceremony, and it is carried on **no** request or reply in this document — both the desktop legs and any future caller take it from this registration. Round 5 of the WebAuthn amendment had the relying party mint one per credential at registration and return it here; that is withdrawn, for a reason that is structural rather than stylistic. Options are issued **before** a discoverable sign-in names a credential, so at composition time there is no credential to look a per-credential value up for; the only way to serve one anyway is to return every candidate's, which turns a deliberately unauthenticated reply into a credential-enumeration oracle over the participant's enrolled devices. Fixing the value by contract also closes the failure the per-credential design existed to prevent — an input that varies between two ceremonies against one credential derives two unrelated keys and silently orphans everything wrapped under the first — by leaving no axis on which it can vary. It costs no security: under the [W3C WebAuthn Level 3 `prf` extension](https://www.w3.org/TR/webauthn-3/#prf-extension) the secret is the authenticator's per-credential `CredRandom` and the evaluation input only selects which evaluation of it to take, and the value was public in either design. The per-authenticator key separation a unique salt would have bought is supplied on the client instead, by [Spec-023](../../specs/023-desktop-shell-and-renderer.md#webauthn-platform-authenticator-native-module)'s custody root: each credential's derived KEK wraps a copy of one installation-scoped key rather than wrapping any envelope directly, so two authenticators have two independent paths to the same envelopes without the relying party holding anything per credential. Yubico's PRF developers' guide recommends the unique per-credential salt; `Spec-023 §References` records that recommendation and why it does not transfer to a discoverable flow. Refusals are `participant.webauthn_challenge_invalid` (400) for an unknown, consumed, or expired challenge or transaction id, and `participant.webauthn_verification_failed` (400) for every verification arm — bad signature, wrong origin, wrong `rpId`, UV mismatch, regressed counter — so the reply is no oracle for which check failed.

---

## Tier 6: Plans 009, 010, 012 (Task 4.7)

### Plan-009 — Repo Attachment And Workspace Binding

```ts
// Plan-009 shared shapes (Tier-6 audit, D-009-2 / D-009-4) — canonical origin
// packages/contracts/src/repo.ts; Plan-010 imports these per Plan-009 CP-009-1.
type VcsType = "git" | "none";
// Derived projection, never persisted — Spec-009 §Repo Mount Health (V1 Definition).
// "identity_mismatch": root reachable but the re-derived common directory no longer
// equals the attach-persisted anchor (repo_mounts.metadata.commonDir); "unreachable"
// takes precedence; re-attach is the recovery (2026-08-17 carried-findings
// adjudication — additive-on-unshipped: widened before any Phase-3 wire consumer).
interface RepoMountHealth {
  status: "healthy" | "unreachable" | "identity_mismatch";
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
  directory?: string; // relative: subdirectory under the mount canonical root; absolute: names a registered working tree of the mount's repository (Spec-009 trust-envelope two-form rule) — containment re-checked after symlink resolution either way
}
interface WorkspaceBindResponse {
  workspaceId: WorkspaceId;
  fsRoot?: string; // absent while state = 'provisioning' (writable binds — Plan-010 fills the root at provisioning completion); present for read-only binds (the EXACT ADMITTED RESOLVED DIRECTORY the bind requested — `directory` resolved against the mount canonical root for the relative form, taken as supplied for the absolute form, symlink-resolved and admitted by containment within an admitted root; equal to a containing root only when the bind names the root itself; 2026-08-17 carried-findings adjudication)
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
// category-wide within the (session, node, participant, kind) boundary — the
// candidate set additionally requires rule.participant_id = the adjudicating
// turn's effective principal (D-012-10, cross-user run-control authorization
// delta 2026-08-10): one participant's remembered grant never authorizes
// another participant's direction, so the lookup is never actor-blind.
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
  approvalRequestIds?: ApprovalRequestId[]; // present + non-empty iff reason = 'pending_approval':
  // one request per contributing principal whose evaluation required approval (D-012-19),
  // each addressed to its own principal per D-012-12. A single-principal turn yields a
  // one-element set; a mixed-input turn (unanimous conjunction per Spec-012 §Required
  // Behavior) blocks until the FULL set resolves — wait-for-all barrier, aggregate
  // approved iff every member approves (first reject/expiry refuses the whole set).
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
  createdBy?: ParticipantId; // = SQLite `created_by` — the publishing caller; absent when the daemon itself produced the artifact with no attributable caller. The permission-matrix Delete own-artifacts scope evaluates the at-rest column this mirrors FAIL-CLOSED: NULL matches no collaborator, so owner-only (PR #341 round 2)
  artifactType: ArtifactType; // discriminator — Spec-014 §Interfaces And Contracts (D-014-4: file|diff|summary|log|design|workflow_output)
  digest: string; // OCI `digest` (SHA-256) = SQLite content_hash — required: a content-addressed manifest always has one (I-014-1)
  size: number; // OCI manifest-descriptor `size` (payload byte length) = SQLite size_bytes — server-derived, always present
  annotations: Record<string, string>; // OCI `annotations` string-map = SQLite annotations (NOT NULL DEFAULT '{}') — distinct from freeform `metadata`
  subject?: ArtifactId; // OCI `subject`: present only on a derivative (redacted/summarized) manifest → source manifest (I-014-2, Spec-014 §State And Data Implications)
  visibility: ArtifactVisibility;
  state: ArtifactState;
  replicationStatus?: "pending_replication" | "pinned" | "over_cap" | "quota_exceeded" | "expired"; // = SQLite `replication_status` (A-014-3; value set spec-named by the 2026-07-08 relay amendment — Spec-014 §Fallback Behavior grants the `pending_replication` fallback; the full set is spec-named in [Spec-014 §Wire-format additivity](../../specs/014-artifacts-files-and-attachments.md#wire-format-additivity) and mirrors the at-rest CHECK column). Absent = local-only artifact. Consumers read the PERSISTED value and never recompute it from live relay state — which is what lets the unresolved-attachment marker carry a non-`pinned` status verbatim as its cause. `expired` is written on the FETCHING node by its own fetch-refusal handling — on `artifact.relay_expired` (410) and equally on a zero-row `artifact.no_access_key` (404), since a GC path that removes the blob row cascades its recipient rows away and puts the later fetch on the 404 instead ([Spec-014 §Fetch (authenticated; relay-served in V1)](../../specs/014-artifacts-files-and-attachments.md#fetch-authenticated-relay-served-in-v1), the recipient-side writer added 2026-08-17 by the ingest-protocol hardening amendment); read it as "payload not obtainable from the relay, remedy is a re-publish" rather than narrowly as "TTL elapsed". The other three are publish-path values reaching recipients through manifest-first replication.
  metadata: Record<string, unknown>; // freeform daemon-side provenance/media-type — distinct from the OCI `annotations` map above
  createdAt: string;
}

// ArtifactPublish — Spec-014 §Interfaces And Contracts: "must return artifact id and manifest metadata."
// Trust-boundary rule (2026-08-17, Spec-014 §Ingest Validation And Payload Bounds (V1)): the ingest
// pipeline binds to the TRUST BOUNDARY, not to a method name. A publish arriving from across the local
// client↔daemon boundary runs the same validation pipeline over `payload`, and one declaring
// `artifactType: "file"` is refused outright and directed to AttachmentIngest — the file family reaches
// the manifest space only through the validated ingest path. Daemon- and engine-produced publishes
// (the common case for the other five families) originate inside the boundary and are not re-validated.
interface ArtifactPublishRequest {
  sessionId: SessionId;
  runId?: RunId;
  artifactType: ArtifactType; // discriminator — see ArtifactManifest.artifactType (Spec-014 §Interfaces And Contracts; D-014-4)
  visibility: ArtifactVisibility;
  payload: string; // the artifact bytes — UTF-8 text verbatim, or base64 (RFC 4648 §4) under payloadEncoding "base64"; never a binary field, because the Spec-007 local wire is JSON-only (PR #341 round 2). The daemon decodes per the discriminator BEFORE hashing: content_hash and size_bytes bind the DECODED bytes, so an encoded and an unencoded publish of identical content share one CAS entry. A boundary-crossing publish is single-call and the 1 MB frame ceiling binds the SERIALIZED frame (PR #341 round 4): base64's fixed 4/3 expansion gives the predictable ≈700 KiB raw ceiling, while a utf8 payload's JSON-escaped size is content-dependent (quotes/backslashes/control characters expand 2–6× under JSON.stringify), so near-ceiling callers publish base64; larger file bytes take the AttachmentIngest trio, and daemon-internal publishes never cross the wire (Spec-014 §Ingest Validation And Payload Bounds (V1))
  payloadEncoding?: "utf8" | "base64"; // default "utf8" — the request-side encoding discriminator (PR #341 round 2)
  mediaType: string; // MIME type
  // --- producer-supplied OCI envelope inputs (D-014-3). `size`/`digest` are NOT here:
  //     the daemon derives size_bytes + content_hash from `payload`. ---
  subject?: ArtifactId; // OCI `subject`: set when publishing a derivative (redacted/summarized) form → points to the source manifest (I-014-2, Spec-014 §State And Data Implications); omit for originals. Resolution is SESSION-SCOPED (PR #341 round 2): the id must resolve within sessionId's manifest space, and a foreign-session or unknown id refuses artifact.not_found (404) — derivative chains never cross sessions, which is what keeps the Spec-014 session-deletion sweep complete by construction
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
  payload?: string; // only if includePayload=true and size permits — where "permits" includes the base64 expansion: the encoded member plus envelope must fit the Spec-007 1 MB frame (PR #341 round 2); UTF-8 text verbatim or base64 per payloadEncoding
  payloadEncoding?: "utf8" | "base64"; // present when payload is — "utf8" only for byte-exact valid UTF-8 payloads (which JSON round-trips losslessly), "base64" otherwise; callers switch on it, never sniff
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

// AttachmentIngest — the interface family purpose-built for untrusted caller-supplied bytes, and the
// primary surface the Spec-014 §Ingest Validation And Payload Bounds (V1) pipeline binds (the pipeline
// binds to the trust boundary, not to a method name — see the ArtifactPublish note above for the
// boundary-crossing publish arm). The other five artifactType families are daemon- or engine-produced
// in the common case and carry no untrusted-upload surface. Ingest is a THREE-CALL STREAM, not a
// single payload-bearing call (2026-08-17, Spec-014 §Ingest Validation And Payload Bounds (V1),
// transport binding): the local IPC transport enforces a hard 1 MB per-frame ceiling on the declared
// Content-Length BEFORE buffering the body (MAX_MESSAGE_BYTES, declared in
// packages/contracts/src/jsonrpc.ts and enforced by
// packages/runtime-daemon/src/ipc/local-ipc-gateway.ts, Spec-007 §Wire Format), so a payload anywhere
// near max_attachment_ingest_bytes cannot cross one frame and a single-call shape would be
// un-implementable on this wire. Chunks spool to a daemon-held temporary file OUTSIDE the CAS until
// Complete; the byte bound binds three times — the transport frame ceiling, Init's declared total, and
// the spooled running count at every Chunk, whose first breach terminates the stream and deletes the
// spool (an over-cap stream is refused garbage, not a classified threat — quarantine is reserved for
// content refusals at pipeline steps 3-8). An abandoned stream's spool is reaped by the same
// mtime-clocked reaper that owns quarantine expiry. The stream is a PROTOCOL, not a loose call
// sequence (PR #341 round 4, Spec-014 stream protocol): Init is refused
// artifact.ingest_capacity_exhausted (429 — transient, retry later, no stream state created) at
// max_active_ingest_streams or when the aggregate of open streams' declared totals would breach
// ingest_spool_max_bytes; sequencing is replay-idempotent with violations terminal
// (artifact.ingest_stream_invalid, 409 — restart from Init); and a stream's tenure is wall-clock-
// bounded by max_ingest_stream_lifetime from Init, because the mtime reaper cannot see a hostile
// trickle that keeps its spool young. `mediaType` and `declaredSizeBytes` are ADVISORY
// INPUT, never trusted facts: the daemon derives both from the spooled bytes at Complete and
// reconciles — with per-field consequences that are deliberately NOT the same (PR #341 round 2
// corrected this comment's earlier conflation). A declared TYPE that contradicts the derived type is
// refused with artifact.unsupported_media_type (415) and quarantined — never silently corrected
// (Spec-014 pipeline step 4). A declared SIZE below the cap is never refused at Init and a below-cap
// mismatch resolves to the derived value in the response — but the declaration is also the stream's
// spool RESERVATION and per-stream ceiling (PR #341 round 4): the running decoded count exceeding it
// refuses artifact.too_large (413) and deletes the spool, because the aggregate admission budget
// counts declared bytes and an unenforced declaration would make it gameable. The derived
// values are what reach the manifest, the CAS key, and every downstream consumer. No call in the trio
// carries a count to cap: max_attachments_per_carrier binds the ArtifactId[] carrier (see the
// attachment-reference note below). Distinct surface from the cross-node ArtifactUploadInit/Chunk/
// Complete relay methods (below) — the same streaming shape applied to a different boundary and
// payload (relay-bound ciphertext chunks there; cleartext local bytes under validation here).
// EVERY call of the trio is retry-safe against a lost response, and no member of these shapes carries
// idempotency state (2026-08-17 ingest-protocol hardening amendment): a replayed Chunk is acknowledged
// without re-appending, and a replayed Complete replays its original response verbatim from a
// completion record the daemon holds on the stream's own registry entry. Calls on one ingestId are
// additionally SINGLE-FLIGHT — sequence validation, spool append, running-count and digest advance,
// and acknowledgement run as one critical section per stream — so an original racing its own retry
// takes the replay path rather than double-appending; concurrent calls on DIFFERENT streams never
// contend. Admission is likewise a serialized reserve-then-install ledger over the open-stream count
// and the reservation total, so two concurrent Inits cannot both pass one remaining slot's bound.
interface AttachmentIngestInitRequest {
  sessionId: SessionId;
  runId?: RunId;
  fileName: string; // caller-supplied; length/character-bounded before it is recorded, and NEVER a storage path component — CAS addressing keys the payload by its SHA-256 (Spec-014 §Implementation Notes)
  mediaType?: string; // ADVISORY and OPTIONAL — a hint used only to narrow the expected signature, never to widen acceptance; absent is a first-class state (Spec-014 pipeline step 4: "a declared type absent altogether is fine; the derived value stands"). One consequence is normative: an undetermined-signature payload with NO declaration has nothing to admit under the step-6 signature-exempt branch and is refused
  declaredSizeBytes: number; // ADVISORY as metadata, BINDING as a reservation (PR #341 round 4): refused with artifact.too_large (413) up front when it exceeds max_attachment_ingest_bytes, counted against ingest_spool_max_bytes at admission, and enforced as the stream's per-stream spool ceiling — the running decoded count may not exceed it; a smaller actual size reconciles downward at Complete without refusal
}
interface AttachmentIngestInitResponse {
  ingestId: string; // opaque single-use stream handle, session-bound and wall-clock-bounded by max_ingest_stream_lifetime from Init; scopes every subsequent Chunk/Complete call — each refused artifact.ingest_stream_invalid (409) once the stream is terminated, expired, or unknown, and every Chunk once it is completed (PR #341 round 4). ONE carved exception: a replayed Complete on a completed stream whose completion record still lives replays the original response verbatim (2026-08-17 ingest-protocol hardening amendment) — see AttachmentIngestCompleteRequest
}
interface AttachmentIngestChunkRequest {
  ingestId: string;
  sequenceNumber: number; // 0-based, strictly consecutive. The daemon retains the last acknowledged sequence + the last appended chunk's SHA-256 (PR #341 round 4): an exact replay — same sequence, same bytes, the ordinary retry after a lost Chunk response — is acknowledged idempotently WITHOUT re-appending, so client retries are always safe; a same-sequence chunk with different bytes, a gap, or a regression terminates the stream (spool deleted) and refuses artifact.ingest_stream_invalid (409) — restart from Init
  chunk: string; // base64 (RFC 4648 §4) of at most max_attachment_chunk_bytes = 512 KiB raw payload (Spec-014 §Bounds, PR #341 round 2) — the Spec-007 wire is JSON with no binary serialization, so bytes ride encoded, sized so the 4/3 expansion plus envelope fits the 1 MB frame ceiling by arithmetic; the spool append decodes, and every byte bound counts the DECODED bytes
}
interface AttachmentIngestChunkResponse {
  ingestId: string;
  receivedBytes: number; // spooled running total of DECODED bytes after this chunk — the enforced byte bound; exceeding max_attachment_ingest_bytes refuses with artifact.too_large (413) and deletes the spool
}
interface AttachmentIngestCompleteRequest {
  ingestId: string; // the request's ONLY member — Complete runs pipeline steps 3-8 over the spooled bytes (signature detection reads a bounded leading prefix); step 8's admitting CAS rename commits the payload — admission is the pipeline's final successful act (Spec-014 pipeline step 8, PR #341 round 2). IDEMPOTENT within the stream's lifetime (2026-08-17 ingest-protocol hardening amendment): the response is recorded on the stream's registry entry, stamped with the committed digest, so a retry after a lost response replays that response VERBATIM — same artifactId, same contentHash — re-running no gate and inserting no second manifest row. Because this request carries no member beyond the ingestId, a "divergent" Complete has no wire form; the digest stamp is a fail-closed defence-in-depth check against a state a daemon-minted single-use handle makes unreachable, not a caller-supplied discriminator. The record shares the entry's in-memory lifetime, so past max_ingest_stream_lifetime the retry receives artifact.ingest_stream_invalid (409) and a re-ingest costs a second manifest row over one deduplicated CAS payload — the named residual, never duplicated bytes
}
interface AttachmentIngestCompleteResponse {
  artifactId: ArtifactId;
  contentHash: string;
  normalizedName: string;
  derivedMediaType: string; // server-derived from the payload signature — this, not Init's `mediaType`, is what the manifest records (for a signature-exempt type: the DECLARED subtype, admitted under the exemption after the UTF-8 well-formedness check — never a subtype invented from the bytes); returned so a caller that guessed wrong learns the reconciled truth
  derivedSizeBytes: number; // server-derived byte length of the spooled payload — likewise authoritative over Init's declared bound
}

// ArtifactDelete — Spec-014 §Interfaces And Contracts + §Local Artifact Deletion And CAS Reclaim (V1)
// (added 2026-08-16; Spec-022's artifact-payload posture already presupposed this mechanism — its retained
// CEK "dies with the manifest row (artifact deletion)" — while the interface list named only four, so the
// reference resolved to nothing). Three couplings are resolved by the contract rather than left implicit:
//   (a) CAS refcount — the payload is reclaimed only when the LAST manifest naming its storage key is gone.
//       The count is DERIVED from the surviving payload-reference rows, never a stored counter column
//       (a counter is a second source of truth whose drift deletes bytes another manifest still names).
//   (b) subject linkage — deleting a manifest that another names as its `subject` is REFUSED, and the
//       response names the referencing manifests. Nulling the derivative's subject is prohibited: it would
//       silently turn a derivative into an apparent original and destroy the provenance chain (I-014-2).
//   (c) retained relay CEK — the delete PROCEEDS but takes the publisher-retained relay_cek_ciphertext with
//       it, so re-publish for that artifact becomes impossible and the late-join artifact.no_access_key
//       remedy is no longer available. The response must surface that rather than deleting silently — and
//       the signal is grounded in LOCAL state alone (PR #341 round 3): the daemon reports the destroyed
//       retained CEK (rePublishForeclosed), never a "pin lost" claim, because whether the relay still holds
//       the blob is the relay's own refcount/TTL lifecycle, neither tracked after publish nor queried at
//       delete time. Any still-pinned recipients fetch normally until the blob's own refcount-zero or TTL
//       (Spec-014 §Delete step 8).
interface ArtifactDeleteRequest {
  artifactId: ArtifactId;
}
// Carried as ErrorResponse.details when the call refuses with artifact.delete_blocked (409) — the
// code-specific details shape the typed SDK consumes (2026-08-17, PR #341 round 2; without it, the
// "names the referencing manifests" requirement had no field name or value type). The generic
// Record<string, unknown> stays the ErrorResponse-level type; this shape is the artifact.delete_blocked
// contract for what that record contains.
interface ArtifactDeleteBlockedDetails {
  referencingArtifactIds: ArtifactId[]; // manifests naming the target as their `subject` — delete these derivatives first, or keep the source. BOUNDED (PR #341 round 3): at most the first 50, ascending by artifact id — deterministic across retries and always frame-fitting, because an unboundedly-derived source must not make its own 409 undeliverable; the full set is enumerable via the read path
  referencingArtifactTotal: number; // total count of referencing manifests — may exceed referencingArtifactIds.length when the list is capped
}
interface ArtifactDeleteResponse {
  artifactId: ArtifactId;
  payloadDisposition: "reclaimed" | "reclaim_pending" | "retained_by_references"; // reclaimed = the CAS bytes are unlinked; retained_by_references = another manifest still names the shared payload, so the bytes deliberately stay; reclaim_pending = the post-commit unlink failed non-ENOENT (EACCES/EIO) and the periodic orphan sweep owns the retry — the zero-reference predicate over surviving rows is the durable reclaim record (PR #341 round 4; replaces the earlier payloadReclaimed boolean, which could not report the pending state truthfully)
  rePublishForeclosed: boolean; // true when the deleted manifest carried a publisher-retained relay_cek_ciphertext, destroyed with the row: re-publish is permanently impossible for this artifact and the late-join artifact.no_access_key remedy is gone. Grounded in the destroyed LOCAL CEK alone — never a relay-liveness claim (PR #341 round 3; replaces the earlier relayPinLost spelling, whose truth value the daemon cannot derive once the relay has GC'd or expired the blob)
  deletedAt: string;
}

// --- Cross-node artifact relay methods (2026-07-08 ADR-015 amendment): the
//     ArtifactUploadInit / ArtifactUploadChunk / ArtifactUploadComplete /
//     ArtifactFetchAuthorize / ArtifactFetchComplete request/response schemas land with Plan-014
//     Tasks 7-10 when tier order reaches them (Plan-014's relay-scope readiness-audit delta landed
//     2026-08-12 and restored the plan and Spec-014 approved; the gate is now the §5 Tier-7 row —
//     Plan-008-remainder + Plan-018 at Tier 5, Plan-021 at Tier 6 — plus phase decomposition, not the
//     delta). Spec-014 §Interfaces names the methods;
//     Spec-014 §Cross-Node Artifact Relay (V1) is the normative design — ArtifactUploadInit carries the relay-visible lifecycle envelope (digest, size, chunk accounting, retentionTier, wrapped-CEK recipient entries) as authenticated plaintext; ArtifactFetchAuthorize evaluates the blob's LIVENESS first (state = 'pinned' AND expires_at > now(); a row that is not a live pin is refused artifact.relay_expired 410 at that point, AHEAD of the selector, so the same request answers 410 on both sides of the hourly TTL sweep instead of flipping to 404 once the sweep's shred has run — added 2026-08-26 by the relay TTL-sweep disposition amendment. A check that precedes the selector necessarily SUBSUMES the grant check for a non-live blob: a session member holding no recipient row gets that 410 rather than the zero-row 404, deliberately — every caller here is authenticated and manifest-first replication already named the digest on their machine, the remedy under both codes is the same publisher re-publish, and after the sweep's shred the relay no longer holds the records that could tell a grantee from a grantless member. The 404 arms below are therefore reached only against a LIVE pin), then selects the recipient row on the REQUEST path (re-specified 2026-08-16): the caller presents the set of artifact-encryption key THUMBPRINTS it holds, the issuer requires exactly one row matching (ciphertext_digest, participant_id = token sub, key_thumbprint ∈ that set) — zero is artifact.no_access_key 404, two or more is artifact.fetch_unauthorized 403 refused fail-closed — derives node_id FROM the resolved row (never caller input), and corroborates an active-state runtime_node_attachments row for that node_id AND participant_id = the authenticated sub in the blob's own session before minting (the participant leg added 2026-08-17, PR #341 round 2 — a recipient row whose attested node_id names another participant's node fails corroboration rather than minting claims that describe no real attachment of the caller); the response returns that one row's wrapped CEK plus its key_thumbprint so the daemon knows which private key to unwrap with (CEKs wrap to durable per-(participant, node) artifact-encryption keys, never session-ephemeral keys). A thumbprint is a public-key fingerprint, not a credential: it disambiguates among rows the caller already owns and grants nothing, because participant_id is pinned to sub inside the same predicate. ArtifactFetchComplete is the authenticated post-verification ack that alone writes delivered_at (never inferred from a chunk GET); the artifact.published event carries the signed cekCommitment, never wrapped CEKs (Spec-014 Publish steps 1/3/4, Fetch steps 5-6).
//     Deliberately not typed here yet — no invented shapes. ---

// --- Attachment references on turn-scoped carriers (Spec-014 §Interfaces And Contracts, 2026-08-16).
//     The element type is ArtifactId — an id into Spec-014's manifest space — carried as an ordered
//     ArtifactId[], never an untyped element and never an inline byte payload: a carrier references
//     artifacts by id only, and caller bytes enter through the boundary-validated ingest paths — the
//     AttachmentIngest trio, or a boundary-crossing ArtifactPublish payload, both of which run the
//     Spec-014 validation pipeline before anything is admitted. Caller-declared order
//     is preserved end to end, and an element the turn cannot resolve or deliver surfaces as an explicit
//     unresolved marker in its declared position naming the cause from the closed union — deleted,
//     local_only_remote, or the manifest's own non-pinned replication status carried verbatim
//     (pending_replication / over_cap / quota_exceeded / expired; PR #341 round 3) — silently dropping it
//     is prohibited (Spec-014 §Fallback Behavior). The count bound is
//     max_attachments_per_carrier, enforced here rather than on AttachmentIngest, whose Init/Chunk/Complete
//     stream carries exactly one payload and has no count to cap.
//     HumanPhaseFormSubmitRequest.attachmentArtifactIds already has this shape. The driver-boundary steer
//     and intervention arms are still typed `unknown[]` and are DELIBERATELY NOT edited from the Plan-014
//     side: those wire arms belong to the plans that own the driver boundary, and retyping them is
//     registered as a Plan-014 cross-plan follow-up obligation so the change lands under its owners. ---

// --- ArtifactKeyAttestationPayload — the `artifact_key_attestation` envelope-interior arm (typed
//     2026-08-12, Codex PR #326 round 2: the §Envelope-Interior Application-Payload Kind Registry
//     row named the arm with no named schema, so Plan-008's T-008r-1-3 had no type to build the
//     discriminatedUnion arm from — the same defect the round-1 RelayedSessionEventPayload fold
//     fixed for the live-relay arm). Realizes Spec-014 §Cross-Node Artifact Relay (V1) Publish
//     step 3; the runtime Zod schema lands in packages/contracts/src/artifacts/ (Plan-014 Task 7)
//     and Plan-008's union references it (CP-014-4 ⇄ CP-008-16).
//     The attesting PARTICIPANT is never a payload member — it is the pairwise envelope's
//     authenticated sender, exactly the party whose registered identity keys the verifier resolves
//     against (Spec-014 binds attestations to participants, not nodes). No timestamp member
//     either: the ordered pairwise channel is the sequencing authority, and receivers apply
//     last-received-wins per the same spec section. ---
interface ArtifactKeyAttestationPayload {
  kind: "artifact_key_attestation"; // the RelayApplicationPayload discriminant (Plan-008 CP-008-16, ratified as Plan-014 D-014-5)
  sessionId: SessionId;
  nodeId: NodeId; // the daemon whose artifact key this attests — inside the signed preimage, so a carrier cannot re-home a key to another node
  artifactPublicKey: string; // base64 of exactly 32 bytes — the node's durable X25519 artifact-encryption public key (the CEK-wrap recipient key, Spec-014 Publish step 1). The recipient-row key thumbprint is DERIVED from these bytes by the receiver, never carried — a carried copy could only agree or lie
  identityKeyFingerprint: string; // selector into the attesting participant's registered identity-key set — the participant_identity_keys roster read (Plan-018 CP-018-13 consumer b, 2026-08-15); the verifier resolves it within THAT participant's keys only (an unknown fingerprint refuses; the member can narrow the check, never widen trust across participants)
  identitySignature: string; // lowercase hex of 64 bytes (the Plan-006 T2.3 wire convention) — Ed25519 by the selected long-term identity key (custody ADR-021 CLI / ADR-010 + Plan-023 desktop; the signing operation is Plan-008's injected Ed25519IdentitySigner, T-008r-4-2) over the LITERAL Spec-014 preimage session_id ‖ node_id ‖ artifact_public_key — UTF-8 id bytes ‖ the raw 32 key bytes, injective without length prefixes because both ids are fixed-length canonical UUID strings; the same literal-concatenation convention as Plan-008's session_id ‖ ephemeral_x25519_public bundle signature, no re-canonicalization the spec doesn't state
}
```

> **Tier-7 audit (NS-19) — ratified design (Plan-014 → `approved`).** The ArtifactPublish/ArtifactRead pair now composes a single named `ArtifactManifest` envelope (`Spec-014 §Interfaces And Contracts`) instead of inlining and duplicating the fields — this is the `ArtifactManifest` shape Plan-014 Task 1 mints, and the envelope Plan-011's `DiffArtifact` (`artifactType: "diff"`) rides per CP-014-1 / CP-011-2 (Plan-011 consumes the envelope **concept**, unchanged, not a flat field layout). `ArtifactPublishResponse` embeds `manifest: ArtifactManifest` per `Spec-014 §Interfaces And Contracts` ("must return artifact id **and manifest metadata**") — this **replaces the prior `manifestUrl` pointer**, which was drift from that "must" clause: the `ArtifactRead` clause grants handle/inline latitude to the **payload** on _Read_ only, never to the manifest, so both responses return the manifest metadata inline (D-014-3 — resolved by aligning the wire to the spec, not an owner decision). `ArtifactReadResponse` is `manifest` + `payloadHandle?`/`payload?` (`Spec-014 §Interfaces And Contracts`). The wire envelope mirrors the `artifact_manifests` row in [Local SQLite Schema](../schemas/local-sqlite-schema.md) 1:1: `digest`/`size` are **required** on the wire because a content-addressed manifest always carries both (I-014-1), and the at-rest `content_hash`/`size_bytes` columns are correspondingly **`NOT NULL`** — each producer (AttachmentIngest, ArtifactPublish) computes the SHA-256 + byte length from its own payload and inserts its manifest with both columns set in the same transaction as the payload-ref, and AttachmentIngest and ArtifactPublish are independent producers (the `artifactId` `AttachmentIngestResponse` returns resolves from the ingest-written manifest, not a later publish), so there is no payload-less manifest to reconcile (D-014-1). _(2026-08-17: `AttachmentIngest` is now carried as the `AttachmentIngestInit`/`AttachmentIngestChunk`/`AttachmentIngestComplete` trio — the resolving response in this dated record is today's `AttachmentIngestCompleteResponse`; the producer-independence design is unchanged.)_ `annotations` is a dedicated OCI string→string column (D-014-2; at-rest `NOT NULL DEFAULT '{}'`), required on the wire, never folded into freeform `metadata`. The at-rest `replication_status` column (nullable) surfaces as the optional `replicationStatus?` wire field (A-014-3 — V1 writes `pending_replication` while a shared artifact awaits deferred payload transfer; open set, no closed union, mirroring the at-rest no-CHECK stance). _(2026-07-08: the deferred refinement arrived — the [Spec-014 §Cross-Node Artifact Relay (V1)](../../specs/014-artifacts-files-and-attachments.md#cross-node-artifact-relay-v1) amendment spec-names `pending_replication | pinned | over_cap | quota_exceeded | expired`, the at-rest column now carries the matching CHECK, and the wire field is the closed union above — the open-set stance in this dated record is superseded; the field stays optional.)_ Producer inputs are closed too (D-014-3): `ArtifactPublishRequest` accepts `subject?` (so a Task-4 I-014-2 derivative names its source at publish) and `annotations?`, while `size`/`digest` stay server-derived from `payload` — otherwise the `annotations` column and derivative `subject` would be write-dead. This wire edit + the `local-sqlite-schema.md` artifact edit + Plan-014 CP-014-1 / Task 3 form one whole-or-not bundle.

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

Every paged timeline reply is bounded by the frame it becomes (2026-09-01, Plan-013 Phase 1). A JSON-RPC reply leaves the daemon inside one `Content-Length`-framed body, and a body over `MAX_MESSAGE_BYTES` is not a failed request: the framer refuses to emit it and the **connection closes** (`Spec-007 §Wire Format`, F-007p-2-05). A row-count ceiling does not bound that — a `TimelineRow` carries three free-form fields at `EVENT_FIELD_MAX_LEN` plus a 4 KiB `summary`, and `JSON.stringify` expands a control character to a six-byte escape, so 256 contract-valid rows exceed the cap several times over before `payload`, which this contract does not bound at all. So each of the three paged members — `TimelineReadResponse.entries`, `ChildRunExpandResponse.entries`, and `ReasoningSurfaceReadResponse.reasoningEntries` — carries a byte budget (`TIMELINE_PAGE_MAX_BYTES` = `MAX_MESSAGE_BYTES` less a reserve for the envelope and the reply's non-paged members), a producer stops at whichever of the row limit and the byte budget trips first, and all three replies discriminate on `hasMore` so a caller can always continue. **The row limit that binds is the CALLER'S** (2026-09-01, Plan-013 Phase 1): `TimelineReadRequest.limit` is optional and a response schema never sees the request, so `entries` is schema-bounded only at the global `TIMELINE_READ_LIMIT_MAX` and a read for ten rows answering with two hundred and fifty-six parses — a client sizing a viewport, a budget, or a render pass from the window it asked for is handed a larger one with nothing on the reply saying the request was not honoured. The effective ceiling is therefore resolved per request — the caller's `limit` where it supplied one, the same global constant where it did not, which stays the default and the schema bound — and enforced at the daemon binder beside the request-scope checks, the only layer holding both numbers. `ChildRunExpandRequest` declares no `limit`, so its ceiling is that constant, stated on the same binder so one rule covers both paged reads. **The budget bounds aggregation and never bounds a page below one entry** (2026-09-01, Plan-013 Phase 1): a continuing arm requires at least one entry — a page promising more and delivering none re-offers the same cursor forever while reading like progress — so where the first candidate alone exceeds the budget the producer pages that single entry and the reply is refused **for its size** at the response boundary, naming the member and its measured bytes on an error frame the substrate can deliver, rather than the page-fill helper returning a bare zero whose only representable answer is the empty continuing page the schema now refuses. A **terminal** arm carries no such floor: an empty final page is the honest answer to a continuation whose cursor already sat at the end and to a filtered read that matched nothing. The budget is not bounded for one `timeline.subscribe` emission, which is a single row on its own frame: a row that blows a frame by itself is an oversized projected event payload, which `session.subscribe` has carried since it shipped, and bounding it is an event-envelope and framer decision rather than one a Plan-013 page budget may make on their behalf.

```ts
// TimelineRead
interface TimelineReadRequest {
  sessionId: SessionId;
  afterCursor?: EventCursor;
  beforeCursor?: EventCursor;
  limit?: number;
  channelId?: ChannelId; // filter to specific channel
}
// hasMore is the discriminant, not a flag beside an optional. The continuing arm REQUIRES nextCursor:
// a window promising more rows and supplying no way to ask for them leaves the caller re-reading the
// same window or giving up, and both lose rows the session holds (Spec-013 §Interfaces And Contracts,
// "cursor-based continuation"). The terminal arm PERMITS one and never requires it — the two members
// answer different questions, and a client that has just read to the end and now wants TimelineSubscribe
// to "support live append plus replay recovery" from exactly there needs that position.
// The continuing arm additionally requires entries to be NON-EMPTY (2026-09-01, Plan-013 Phase 1):
// a page promising more and delivering none advances no cursor while reading like progress, so the
// client re-asks from the same position and loops. The terminal arm keeps no floor — an empty final
// page is the honest answer to an exhausted continuation and to a filtered read that matched nothing.
// entries is additionally bounded by TIMELINE_PAGE_MAX_BYTES (see this section's opening note).
type TimelineReadResponse =
  | { entries: TimelineRow[]; hasMore: true; nextCursor: EventCursor }
  | { entries: TimelineRow[]; hasMore: false; nextCursor?: EventCursor };

interface TimelineRowBase {
  id: string;
  sessionId: SessionId;
  sequence: number;
  category: EventCategory; // open on three arms; PINNED on the rollback-boundary arm, and refused as "run_lifecycle" on the general arm
  type: string;
  actor?: string;
  summary: string; // human-readable summary
  timestamp: string;
  childRunSummary?: ChildRunSummary; // if this is a summarized child-run row
  payload: Record<string, unknown>;
}

type TimelineEntry = TimelineRowBase & { kind: "general" }; // the non-run arm (Codex round 4 on PR #232): carries no run attribution structurally — the projector stamps kind from the event family, so a run-scoped family can never arrive on this arm. The arm additionally REFUSES category: "run_lifecycle" (2026-09-01, Plan-013 Phase 1): all-or-none attribution is enforced by arm SELECTION, so a row whose kind was stamped wrong never reaches the run arm and its missing triple is never checked — it would arrive as a legitimately attribution-free general row. Every one of Spec-006 §Run Lifecycle's thirteen types is run-scoped (the nine state transitions share a payload shape carrying a required runId; the four non-state rows each re-list it), so the refusal costs no correct projection. The refusal is THREE-LEGGED, not category alone (2026-09-01, Plan-013 Phase 1): category was only ever decisive for run_lifecycle, so the arm also refuses a canonical type in the derived census of Spec-006 types whose registered payload names a run unconditionally, and — for the types whose run identity is registered OPTIONAL (every artifact_publication type, five usage_telemetry types, user.message), which no type-level test can decide — a payload naming a run under either registered spelling, runId or the intervention family's targetRunId. The census is derived from Plan-006's per-category arrays rather than transcribed, and its size is pinned by a test so a taxonomy growth changes it loudly

type RunScopedTimelineEntry = TimelineRowBase & {
  kind: "run"; // literal discriminator — row.kind narrowing is structural, never a probe of the free-form type: string
  runId: RunId; // run identity — with position + epoch, the REQUIRED all-or-none attribution triple the run.rolled_back live client rule keys on, never dug out of payload (CP-004-13, Codex rounds 2-3 on PR #232): arm selection is by kind, so a run-scoped row missing any of the three fails ITS Zod arm — the malformed-row test — and can never fall through to the general arm
  position: number; // the row's projection-resolved originating run position (Plan-004 T3.14's uniform row-to-turn assignment); the live rule compares it against the run.rolled_back boundary's carried targetPosition (sequence is the session event sequence, never a run position)
  epoch: number; // the row's projection-resolved execution epoch (T3.14's row attribution: the stamped sourceEpoch on late rows, the operation association's epoch on in-time content-asynchronous rows, the run's current epoch at emission otherwise — Codex round 2, PR #232); position alone can never recover the epoch, since re-execution reuses ordinals
  superseded?: { targetPosition: number }; // present exactly when the row's turn is superseded, absence = current (campaign B9 CP-004-13, 2026-07-20) — projection-computed from Plan-004 T3.14's exported supersededTurns(runId); deliberately single-field (Codex round 4, PR #232): the marker's run identity and source epoch ARE the containing row's runId + epoch, so no duplicated fields exist to disagree and live marking (the row plus the boundary cutoff) is identical to replay marking by construction; targetPosition = the superseding rollback's rewind cutoff — the first accepted rollback in the run's lineage, at the row's epoch or later, that rewound the surviving history containing the row (a later rollback below an earlier retained prefix supersedes the inherited rows; a row ranks superseded when position exceeds the run's effective cutoff for its epoch — the minimum cutoff among accepted rollbacks at epoch >= the row's); identical on TimelineRead and TimelineSubscribe replay, rows delivered after a boundary arriving with the marker already projection-computed — per Spec-013 §Required Behavior
  // Where a projection echoes canonical keys into payload, they must AGREE with the outer triple
  // (2026-09-01, Plan-013 Phase 1 — I-013-3's no-second-source rule reaching the payload): payload run
  // identity under either spelling (runId, targetRunId) must equal this row's runId, and payload
  // sourceEpoch / sourcePosition must equal this row's epoch / position. Echoing stays OPTIONAL and
  // absence passes; only disagreement is refused, because consumers filter and mark superseded on the
  // outer triple while the row's detail and provenance read the payload, so a row stating two
  // attributions is filed under one turn and sourced from another. The run-identity half binds every
  // arm carrying an outer runId, LegacyStubTimelineEntry included.
};

type LegacyStubTimelineEntry = TimelineRowBase & {
  kind: "legacy_stub"; // a run-scoped audit stub compacted in the vacuous-attribution era (Codex round 5, PR #232): runId is preserved — every run-scoped stub preserves it (Spec-006 §Compacted Event Format) — but position and epoch are structurally ABSENT because they are unknowable (Plan-006 T3.2/T3.5's vacuous-default era; Plan-004's span check treats such a stub as the standing-refusal class, so its run can never admit a rollback while it exists). The row renders as the compaction placeholder alone and is exempt from the marking rule by construction — it can never be ranked, never carries superseded, and the projector stamps this kind only for vacuous-era stub rows (a live run row missing attribution fails the run arm, never lands here)
  runId: RunId;
};

type TimelineRollbackBoundary = Omit<TimelineRowBase, "category" | "type" | "payload"> & {
  kind: "rollback_boundary"; // literal discriminator
  category: "run_lifecycle"; // pinned with `type`, and for the same reason (2026-09-01, Plan-013 Phase 1): run.rolled_back is registered under one category and no other, so leaving this open on the one arm whose event type is closed would leave the half that can still disagree — and a renderer grouping or filtering by category would file the rewind cutoff under the wrong family
  runId: RunId; // the rewound run
  position: number; // the boundary row's own originating position
  epoch: number; // the epoch the rollback rewound
  superseded?: { targetPosition: number }; // an earlier boundary row is itself superseded when a later rollback cuts below it — same single-field marker semantics as the run arm
  type: "run.rolled_back";
  payload: RunRolledBackEvent; // validated into the typed shape (defined at §Tier 5 run.* above) at projection, so the live client rule reads a typed targetPosition — never an unsafe cast; an entry failing that validation is a projection defect surfaced at emission, never delivered untyped (Codex round 2, PR #232). Delivery is visibility-resolved, never keyed on the event's optional channelId: the boundary fans out to every filtered subscription whose filter admits any row of the affected run (Codex round 4, PR #232), so a channel-filtered subscriber holding that run's rows always receives the cutoff. Outer attribution and payload cannot disagree (Codex round 5, PR #232): the boundary arm's schema refines runId === payload.runId, sessionId === payload.sessionId, and position === payload.targetPosition (the boundary row ranks at the confirmed rewind floor — which is why a later rollback below it supersedes it), so a conflicting boundary fails parse as a projection defect, never delivered. The `Omit` on the base is load-bearing rather than stylistic (Plan-013 T1.1, PR shipping `packages/contracts/src/timeline/row.ts`): a plain `TimelineRowBase &` intersection would type `payload` as `Record<string, unknown> & RunRolledBackEvent`, which no `RunRolledBackEvent`-typed value satisfies (an interface carries no implicit index signature) and which `RunRolledBackEventSchema` cannot be annotated against — the typed payload this comment promises would be unconstructible. `type` is Omitted for the same reason it is re-declared: this arm narrows the base's free-form string to one literal
};

type TimelineRow =
  | TimelineRollbackBoundary
  | RunScopedTimelineEntry
  | LegacyStubTimelineEntry
  | TimelineEntry; // the row union every timeline surface returns — TimelineReadResponse.entries, the TimelineSubscribe SSE stream, and ChildRunExpandResponse.entries are all TimelineRow — genuinely discriminated on the literal kind (Codex rounds 3-5, PR #232): the contracts Zod discriminatedUnion selects the arm by kind (rollback_boundary | run | legacy_stub | general), each arm validates strictly, and consumers narrow structurally on row.kind — never probing type: string, never casting

// The incompleteness marker (2026-09-01, Plan-013 T1.2) — the Tier-8 audit residual (§6 node NS-20)
// shaped. Spec-013 §Fallback Behavior requires that a child run whose detail fetch fails "remains
// visible and marked incomplete rather than disappearing"; before this, no member carried the mark, so
// the only signal of incompleteness was a low eventCount, which is indistinguishable from a child run
// that genuinely did little. The cause vocabulary is CLOSED and every member is a term the corpus
// already owns — none is minted here:
type ChildRunIncompleteCause =
  | "detail_fetch_failed" // this daemon's own expansion read failed — Spec-013 §Fallback Behavior's own
  //   naming of the condition ("if a child-run detail fetch fails"). Transient: a retry may succeed.
  | "pending_backfill" // the producing node's rows have not reached this node yet. Spec-008 §Required
  //   Behavior's coverage-state term, reused verbatim rather than paraphrased — it is the same
  //   condition at a narrower scope (one child run's rows, not the session's whole history), and that
  //   section defines the outstanding-source arm as transient, clearing when the peer serves.
  | "compacted"; // the child's rows were compacted away. Already the shipped vocabulary on this plan's
//   own sibling surface (ReasoningSurfaceReadResponse's availability arm) and on
//   HydratedContentUnavailableReason. Terminal: no retry recovers a compacted row.
// Deliberately NOT reused: session.history_backfill_unavailable (a response-level error code, not a
// coverage state — Spec-008 rules it out by name), NodeState "offline" (a node lifecycle state, which
// is the INPUT to pending_backfill rather than a synonym), and RepoMountHealth "unreachable" (scoped to
// filesystem mounts, whose own contract warns against overloading it across axes).
type ChildRunCompleteness =
  | { state: "complete" }
  | {
      state: "incomplete";
      cause: ChildRunIncompleteCause; // required on this arm only
      observedAt: string; // ISO-8601, daemon clock — when the cause was observed. Required because two
      //   of the three causes are transient: a consumer deciding whether to retry, and a renderer
      //   deciding whether to age the notice, both need to know how old the reading is. A cause with no
      //   time is unactionable.
    };

interface ChildRunSummary {
  runId: RunId;
  parentRunId: RunId;
  state: RunState;
  producingNodeId?: NodeId;
  eventCount: number; // on the incomplete arm this is a LOWER BOUND — the count this daemon currently
  //   holds, not the child run's true total, which by definition it cannot know
  completeness: ChildRunCompleteness; // REQUIRED, not optional: an absent marker would be a third state
  //   meaning "probably fine", and Spec-013 §Fallback Behavior's rule is that incompleteness is STATED,
  //   never inferred from a small count. No compatibility arm — no daemon, SDK, or client ships an
  //   emitter or parser of this shape (Plan-013 Phase 1 is the first), so ADR-018's rules, which guard
  //   deployed skew from the first shipped parser onward, impose none.
  // runId !== parentRunId (2026-09-01, Plan-013 Phase 1): a run that is its own parent makes the
  //   run-lineage graph cyclic, and every consumer of that graph walks it — the renderer nests a child
  //   under its parent, Spec-016's one-layer nesting rule is checked against the chain, and cost
  //   attribution sums along it. Refused once at the parse boundary rather than defended against
  //   separately at every walk. ChildRunExpandResponse carries the same refusal on the same pair.
}

// TimelineSubscribe
interface TimelineSubscribeRequest {
  sessionId: SessionId;
  afterCursor?: EventCursor;
  channelId?: ChannelId; // filter to a channel's rows — filtering never suppresses a run.rolled_back boundary for a run whose rows the filter admits (visibility-resolved fan-out; Codex round 4, PR #232)
}
// Response: SSE stream of TimelineRow (the discriminated union above)

// ReasoningSurfaceRead
// No principal member, by design (2026-09-01, Plan-013 Phase 1) — the Tier-8 audit's "unshaped
// principal" residual settled as an explicit no-member decision rather than left as an omission.
// The caller is resolved from the transport per the Authenticated Principal And Authorization Model
// section above: its opening rule scopes every endpoint in this document to the authenticated caller
// implicitly, and its informational-body-fields rule makes any participant-naming body field routing
// and audit metadata that Cedar does not read. A principal member here would therefore be inert at
// best, and at worst the second source of identity truth that rule exists to forbid. So the request
// declares none, and its Zod arm is strict: a caller that sends one is refused, not silently stripped.
// This is deliberately NOT a sixth instance of that section's numbered admitting-write list. Instances
// (1)-(5) each name where a resolved principal is RETAINED on a durable carrier; this read admits
// nothing and writes no row, so it has nothing to retain and belongs to the resolution rules, not
// the retention class.
interface ReasoningSurfaceReadRequest {
  runId: RunId;
  afterCursor?: EventCursor; // continuation position, the same opaque cursor the sibling reads take (2026-09-01, Plan-013 Phase 1) — a reasoning entry is projected from the run's events, so its resume position is an event position, and one namespace spelling its cursor two ways would make a client hold two kinds of bookmark for one surface
}
type ReasoningSurfaceReadResponse =
  // Closed availability discriminant (Tier-8 audit Codex round, PR #318): the prior shape — available: boolean
  // with two free optionals — serialized the available / unavailable / compacted / policy-redacted cases
  // identically, leaving Spec-013 §Acceptance Criteria's distinguish-the-cases requirement and §Fallback
  // Behavior's compacted arm unrepresentable. Amended in place rather than compatibility-extended: the shape
  // predates this PR as canonical-doc text only — no daemon, SDK, or driver ships an emitter or parser of it
  // (Plan-013 Phase 1 undispatched; Shipment Manifest empty) — so ADR-018's compatibility rules, which guard
  // deployed skew from the first shipped parser onward, impose no legacy boolean arm here.
  // The available state is the one that PAGES, so it is the one that splits on hasMore (2026-09-01,
  // Plan-013 Phase 1) — the same continuation rule TimelineReadResponse carries, nested inside the
  // availability discriminant so the four states stay four and a paged reply is not a fifth state.
  // reasoningEntries is non-empty ON THE CONTINUING ARM ONLY (narrowed 2026-09-01, Plan-013 Phase 1).
  // A zero-entry available page claims a reasoning surface exists and then shows nothing, which renders
  // identically to unavailable while asserting the opposite — true of a FIRST read, and false of a
  // continuation whose afterCursor already sat at the end of the surface, which unavailable, compacted,
  // and policy_redacted would each misstate. The schema cannot separate the two, because only the
  // request separates them: it carries the half it can see (the continuing arm, which is the arm that
  // can loop a client on a repeated cursor) and the daemon binder carries the first-page half, beside
  // the request-scope checks, under Plan-013 I-013-13.
  | {
      availability: "available"; // normalized reasoning present and permitted
      reasoningEntries: Array<{ sequence: number; content: string; timestamp: string }>; // required on this arm only, non-empty (continuing arm), bounded by TIMELINE_PAGE_MAX_BYTES
      hasMore: true;
      nextCursor: EventCursor;
    }
  | {
      availability: "available";
      reasoningEntries: Array<{ sequence: number; content: string; timestamp: string }>; // may be EMPTY on this arm — see the note above; a first read answering empty is refused at the binder
      hasMore: false;
      nextCursor?: EventCursor;
    }
  | { availability: "unavailable" } // the run surfaced no reasoning; no entries, no policyReason — the client renders the unavailability placeholder from the state itself (I-013-7: absence never renders as nothing)
  | { availability: "compacted" } // detailed payloads expired or were compacted; no entries — the durable summary and policy marker remain canonical on the summary-first timeline surface (I-013-8), and this state names why expansion is empty
  | { availability: "policy_redacted"; policyReason: string }; // withheld by policy; policyReason required, no entries — renders as an explicit redaction surface, never as absence (I-013-7)
// The contracts Zod schema (T1.3) is a discriminatedUnion on availability with strict arms: entries on a
// non-available arm, a missing policyReason on policy_redacted, or the prior available: boolean shape all
// fail parse — no tolerant fallback arm.

// ChildRunExpand
interface ChildRunExpandRequest {
  runId: RunId; // child run to expand
  afterCursor?: EventCursor; // continuation position (2026-09-01, Plan-013 Phase 1) — named to match the sibling reads rather than a bare `cursor`: one namespace, one name for the position a caller resumes from
}
// Discriminated on hasMore exactly as TimelineReadResponse is, and for the same reason: a child run is
// not inherently smaller than a session window — a long-running subagent produces more rows than fit one
// frame — so the expansion needs the same continuation, on the same two arms, with the same rule about
// which of them may carry a cursor — and the same non-empty floor on the continuing arm, for the same
// reason: a child run's expansion loops a client on a repeated cursor exactly as a session read does.
// Two further rules the schema enforces (2026-09-01, Plan-013 Phase 1):
// every entry that carries a run identity must carry THIS run's (the general arm is exempt, having none —
// a session-scoped row inside a child's window is context, not misattribution), and runId !== parentRunId,
// since a run that is its own parent makes the lineage graph cyclic and every walk of it — nesting,
// one-layer-depth checking, cost attribution — non-terminating.
type ChildRunExpandResponse = {
  runId: RunId;
  parentRunId: RunId;
  state: RunState;
  entries: TimelineRow[]; // bounded by TIMELINE_PAGE_MAX_BYTES as well as by the row cap
} & ({ hasMore: true; nextCursor: EventCursor } | { hasMore: false; nextCursor?: EventCursor });
```

### Timeline Method-Name Registry (Tier 8, Plan-013 T1.4)

Plan-013's timeline surface is exposed as four `timeline.*` methods, registered by the Tier-8 plan-readiness audit's Plan-013 restore (T1.4 registers the strings against the Plan-007-partial daemon `MethodRegistry` per the §5 substrate-vs-namespace carve-out — the `repo.*` / `approval.*` precedent). These methods ride the **daemon JSON-RPC transport only**: the timeline is a daemon-local projection over the session event log per [ADR-017](../../decisions/017-shared-event-sourcing-scope.md), and no tRPC sibling exists in V1. Method tails are camelCase per the BL-142 convention the Approval Method-Name Registry records.

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `timeline.read` | `query` | `TimelineReadRequest` | `TimelineReadResponse` |
| `timeline.subscribe` | `subscription` | `TimelineSubscribeRequest` | `TimelineRow` (stream) |
| `timeline.reasoningSurfaceRead` | `query` | `ReasoningSurfaceReadRequest` | `ReasoningSurfaceReadResponse` |
| `timeline.childRunExpand` | `query` | `ChildRunExpandRequest` | `ChildRunExpandResponse` |

The three `query` rows are idempotent reads; `timeline.subscribe` streams the discriminated `TimelineRow` union per emission — including the visibility-resolved `rollback_boundary` fan-out on channel-filtered subscriptions — rather than returning a single response. All request/response shapes are the interfaces defined directly above; the canonical Zod schemas live in `packages/contracts/src/timeline/` (T1.1–T1.3) per the §Source-of-Truth Policy.

### Plan-019 — Notifications And Attention Model

```ts
// AttentionProjectionRead
interface AttentionProjectionReadRequest {
  sessionId: SessionId;
  scope?: "run" | "session"; // omitted = full projection (run-scoped items + the session aggregate); "session" = aggregate only
  runId?: RunId; // Plan-019 D-019-4, additive-optional per ADR-018: REQUIRED when scope is "run" (a run-scope read
  // without a run identifier is refused at schema parse, never defaulted to all runs) and admissible ONLY with
  // scope "run" (refused beside "session" or an omitted scope) — a Zod cross-field refinement, not service-layer convention.
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

// NotificationEmit — the daemon→control-plane carrier (Plan-019 D-019-3): control-plane tRPC
// mutation attention.notificationEmit, daemon-called (the eventanchor.upload shape), never a
// client verb. Response: null (the runtimenode.leaseupdate / heartbeat pattern —
// NotificationEmitResponseSchema = z.null()). See the Attention Method-Name Registry below.
interface NotificationEmitParams {
  participantId: ParticipantId; // recipient — must hold an active session_memberships row for sessionId (registry predicate)
  sessionId: SessionId; // authorization context + notification_queue.session_id (NOT NULL)
  runId?: RunId; // mirrors AttentionItem.runId / notification_queue.run_id — absent for session-scoped triggers
  trigger: AttentionItem["trigger"]; // single canonical trigger — never an aggregate (D-019-2)
  severity: AttentionItem["severity"]; // read by the control-plane severity-first filter and the queue's NOT NULL column
  sourceEventId: string;
  summary: string;
  metadata?: Record<string, unknown>;
}
```

> **Scope and aggregate carrier (Plan-019 D-019-2).** `runId` is the scope discriminator: an item carrying it is run-scoped, an item omitting it is the session-scoped aggregate that [Spec-019 §Required Behavior](../../specs/019-notifications-and-attention-model.md#required-behavior) requires alongside run scope. There is no separate aggregate type and no aggregate-only field. On an aggregate, `severity` carries the aggregation — `actionable` while **any** unresolved contributor (run-scoped item, pending invite, or participant request) is actionable, `informational` only when every contributor is — per [Spec-019 §Default Behavior](../../specs/019-notifications-and-attention-model.md#default-behavior), while `trigger` and `sourceEventId` are taken from one deterministically selected representative contributor: highest severity first (`actionable` before `informational`), then earliest `createdAt`, then lexicographically smallest `id`. Because the representative is a real contributor rather than a synthesized placeholder, `sourceEventId` always resolves on an aggregate and stays non-optional. Aggregates are read-projection-only: `AttentionProjectionRead` returns them and `NotificationEmit` never carries one — a notification is emitted from the single canonical trigger that caused it, so no aggregate is ever emitted and no per-contributor fan-out is inferred from one. At rest, the queued form of this shape persists `trigger` as the column `attention_trigger` (a keyword-avoidance rename only; the domain is byte-identical) — see [shared-postgres-schema.md §Notification Queue (Plan-019)](../schemas/shared-postgres-schema.md#notification-queue-plan-019). Canonical statement: [Plan-019 §API And Transport Changes](../../plans/019-notifications-and-attention-model.md#api-and-transport-changes) and [Plan-019 §Ratified Design Decisions (Tier-8 audit)](../../plans/019-notifications-and-attention-model.md#ratified-design-decisions-tier-8-audit) D-019-2.

### Attention Method-Name Registry (Tier 8, Plan-019)

Plan-019's client-facing attention surface is exposed as three `attention.*` methods split across the two transports [Plan-019 §API And Transport Changes](../../plans/019-notifications-and-attention-model.md#api-and-transport-changes) assigns (D-019-3; the code-side registrations land at Plan-019 T2.6). `attention.projectionRead` rides the **daemon JSON-RPC transport only**: the attention projection is a daemon-local replay-derived projection over canonical session and run state per [ADR-017](../../decisions/017-shared-event-sourcing-scope.md) — the `timeline.*` posture above — registered against the Plan-007-partial daemon `MethodRegistry` per the §5 substrate-vs-namespace carve-out (the §2 `packages/runtime-daemon/src/ipc/` row's Plan-019 `attention.*` entry). `attention.preferenceRead` / `attention.preferenceUpdate` ride **control-plane tRPC only**: `notification_preferences` is control-plane Postgres and the callee is the record authority — the `runtimenode.roster` posture — mounted as an `attention`-namespaced router on `host.ts` via the §2 router-registration carve-out. Method tails are camelCase per the BL-142 convention the Approval Method-Name Registry records.

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `attention.projectionRead` | `query` | `AttentionProjectionReadRequest` | `AttentionProjectionReadResponse` |
| `attention.preferenceRead` | `query` | `NotificationPreferenceReadRequest` | `NotificationPreferenceReadResponse` |
| `attention.preferenceUpdate` | `mutation` | `NotificationPreferenceUpdateRequest` | `NotificationPreferenceUpdateResponse` |

Two deliberate non-registrations complete the namespace. **No `attention.subscribe` exists**: notification delivery rides the existing control-plane SSE subscription rather than a new endpoint per [Spec-019 §Desktop-to-Desktop Delivery](../../specs/019-notifications-and-attention-model.md#desktop-to-desktop-delivery) and [Plan-019 §API And Transport Changes](../../plans/019-notifications-and-attention-model.md#api-and-transport-changes) — a subscription method here would mint the second endpoint that bullet forbids. **`NotificationEmit` is deliberately not a client method** (the `PermissionCheck` precedent in the Approval Method-Name Registry): emission is derived from canonical state (Plan-019 I-019-1), so no V1 client emits notifications. Its wire form is the fourth `attention.*` string, `attention.notificationEmit` — a control-plane tRPC `mutation`, **daemon-called** (the `eventanchor.upload` shape; request `NotificationEmitParams`, response `null` — the `runtimenode.leaseupdate` / heartbeat pattern, `NotificationEmitResponseSchema` = `z.null()`), registered on the same `attention` router (Plan-019 T3.2). The daemon authenticates as the node-owner participant through the constructor-injected `DaemonCredentialProvider` (the CP-006-13 shape, minted per attempt; live at Tier 8 — Plan-018's Tier-5 PASETO wiring precedes this plan by tier order — so an auth failure is a retryable transport failure, the `eventanchor.upload` posture). Authorization is two predicates evaluated in the same transaction as any queue write, refusals writing nothing: the verified caller `sub` must hold a live `runtime_node_attachments` row in an active state for the named `sessionId` (the attachment-gated shape of the §Session Terminal-Control Method Registry's condition (1), evaluated over any of the caller's nodes — emission carries no node identity and pins no `attachmentId`), and the recipient `participantId` must hold an active `session_memberships` row for the same session — a queued `summary` is derived personal session content (Plan-019 CP-019-1), so a notification is never minted into a session the emitting node is not attached to nor delivered to a non-member. Filtering and routing happen control-plane-side after these predicates: the emit-time preference filter, then SSE push to a connected device or a `notification_queue` row otherwise ([shared-postgres-schema.md §Notification Queue (Plan-019)](../schemas/shared-postgres-schema.md#notification-queue-plan-019)). Not a relay op: [ADR-008](../../decisions/008-default-transports-and-relay-boundaries.md)'s relay is E2E peer connectivity, not a control-plane command channel, and the derived rendering fields are exactly what the control plane must read to filter, queue, and purge. Canonical Zod schemas live in `packages/contracts/src/attention/` per the §Source-of-Truth Policy.

### Plan-020 — Observability And Failure Recovery

```ts
// HealthStatusRead
interface HealthStatusReadRequest {
  scope?: "daemon" | "control_plane" | "provider" | "replay";
}
interface HealthStatusReadResponse {
  overall: "healthy" | "degraded" | "blocked"; // the three Spec-020 §Default Behavior status categories — blocked (replay-rebuild / policy-blocked surfaces as blocked read-only), not "unhealthy": the mirror carried the drifted third arm (Tier-8 audit reconciliation; Plan-020 T1.1 is the schema source)
  components: Array<{
    name: string;
    state: "healthy" | "degraded" | "blocked"; // same closed three-category set as overall
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

// DiagnosticRedactionPolicyRead — operator-readable policy STATE only: current TTL and opt-in
// toggle per bucket plus the retention_policy_override warning surface. The redaction DECISION
// logic (which fields are denied, placeholder shapes, sink coverage) is deliberately daemon-local
// with no wire contract — a consumer that needs to evaluate redaction rather than read policy
// state requires a Plan-020 amendment publishing the rule set first (Plan-020 §PII in Diagnostics).
interface DiagnosticRedactionPolicyReadRequest {} // daemon-singleton policy; no parameters
interface DiagnosticRedactionPolicyReadResponse {
  buckets: Array<{
    bucket: "driver_raw_events" | "command_output" | "tool_traces" | "reasoning_detail"; // closed four-bucket set (Spec-022 §PII Data Map bounded-retention tier)
    ttlDays: number; // effective TTL; default ≤ 7 (Spec-020 §PII in Diagnostics)
    rawContentOptIn: boolean; // default false; enabling is never retroactive (I-020-4)
  }>;
  outboundDefault: "deny"; // literal — default-deny outbound is not representable as anything else over this read
  retentionPolicyOverrideActive: boolean; // true while any bucket TTL override exceeds 30 days; every read observing true also emits the retention_policy_override warning metric (I-020-3)
}
```

### Health Method-Name Registry (Tier 8, Plan-020 T1.4)

Plan-020's health and recovery surface is exposed as five `health.*` methods, registered by the Tier-8 plan-readiness audit's Plan-020 walk (T1.4 exports the strings from the contracts package; T2.10 registers them against the Plan-007-partial daemon `MethodRegistry` per the §5 substrate-vs-namespace carve-out — the `repo.*` / `approval.*` / `timeline.*` precedent). These methods ride the **daemon JSON-RPC transport only**: health, failure-detail, and stuck-run projections are daemon-owned derivations over canonical state (ADR-003 / ADR-017 posture), and the control-plane dependency-health read is merged into the daemon-side projection (Plan-020 T2.3) rather than exposed as a tRPC sibling. Method tails are camelCase per the BL-142 convention the Approval Method-Name Registry records; no Spec-006 durable event family shares the `health` root, so no form collision exists.

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `health.statusRead` | `query` | `HealthStatusReadRequest` | `HealthStatusReadResponse` |
| `health.failureDetailRead` | `query` | `FailureDetailReadRequest` | `FailureDetailReadResponse` |
| `health.stuckRunInspect` | `query` | `StuckRunInspectRequest` | `StuckRunInspectResponse` |
| `health.recoveryActionRequest` | `mutation` | `RecoveryActionRequestRequest` | `RecoveryActionRequestResponse` |
| `health.redactionPolicyRead` | `query` | `DiagnosticRedactionPolicyReadRequest` | `DiagnosticRedactionPolicyReadResponse` |

The four `query` rows are idempotent reads; `health.recoveryActionRequest` is the single mutation — the operator-triggered recovery path whose every action and outcome T2.6 records as a durable audit record. Canonical Zod schemas live in `packages/contracts/src/health/health.ts` (T1.1–T1.3, method-name constants T1.4) per the §Source-of-Truth Policy.

### Shell-Hosted Method Registry (Tier 8, Plan-023 CP-023-9)

Registered 2026-09-01 ([cross-plan-dependencies.md §6](../cross-plan-dependencies.md) node NS-99, Codex round 4). Every other registry in this document names a method the **daemon** answers and a client calls. This one is the reverse leg: the method is hosted by the Electron **main process**, and its only caller is the supervised daemon child. JSON-RPC is symmetric, so nothing in the transport had to change, but the direction had never been used in this corpus and is stated rather than left implicit.

**Transport.** The `MessagePortMain` duplex created at `utilityProcess.fork` and handed to exactly one endpoint — the supervised daemon. It is never exposed on the preload bridge, never on a socket, and never on the control-plane client, so a request from any other origin is unreachable rather than refused; the handler additionally asserts the receiving port's identity and drops anything else, which is a local assertion on a private channel and **not** a wire refusal, so no error code is registered for it.

| Method | Direction | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- | --- |
| `shell.deriveKek` | daemon → shell | RPC (request/response) | `ShellDeriveKekRequest` | `ShellDeriveKekResponse` |

The namespace root is `shell` rather than `shellKey` or `daemonKey`. That choice was made under the pre-2026-09-05 rule, when §JSON-RPC Method-Name Registry's canonical regex allowed no uppercase character in the first segment; the widening to `/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/` removes that constraint but nothing else recommends the longer roots, so `shell` — one lowercase word, needing no camelCase — stands. The `register()`-time guard enforces the format on this surface exactly as on the daemon-hosted ones.

**What it carries, and where the HKDF runs (pinned 2026-09-01, Codex round 5; narrowed at round 6).** The request carries exactly **one** input, the [Plan-022](../../plans/022-data-retention-and-gdpr.md) daemon-master-key HKDF salt. Round 5 had it carry a second — the credential's persisted PRF evaluation input, passed through from the authentication-options reply — and round 6 removes it on both grounds that matter: that input is now a contract-fixed constant the shell already holds (§WebAuthn Ceremony Procedure Registry), and the daemon never had a way to obtain a per-credential one anyway, holding no credential row and sitting on the far side of this boundary. The response carries the finished **32-byte key-encryption key**. The derivation is performed **inside the shell-hosted method**, so no authenticator-derived secret crosses the RPC: main runs the ceremony, unwraps this installation's custody root key with the ceremony-derived wrapping key, feeds **the root** into HKDF-SHA-256 with the caller's salt and the contract-fixed info string `"ai-sidekicks/daemon-master/v1"`, and returns only the result. Deriving from the root rather than straight from the PRF output is what keeps the daemon's key **stable across enrolments**: a KEK derived from one credential's PRF bytes would change the moment the participant enrolled or removed an authenticator, silently orphaning everything the daemon had wrapped, and the daemon cannot re-wrap what it cannot decrypt. Putting the HKDF on the daemon side would have sent the authenticator's raw secret across a process boundary to be transformed by the party that does not own it, which is the shape this whole retirement existed to remove. The info string is fixed **by this contract** rather than supplied by the caller, because a caller-chosen info is a second axis on which two honest implementations silently derive different keys from the same authenticator. Main answers it with the injected `PrfKeyDerivationService` of [Plan-023](../../plans/023-desktop-shell-and-renderer.md) CP-023-9 (producer task T-023r-4-7), which runs the WebAuthn PRF ceremony through the resolved per-platform binding. The KEK crosses this one channel and no other; it appears in no `SidekicksBridge` type and reaches no renderer. This registry replaces the retired `webAuthn.deriveKeyMaterial` preload-bridge method, which let the untrusted renderer choose the PRF salt and returned derived key material across the bridge.

---

## Tier 6 / Tier 8: Plans 016, 017 (Task 4.10)

Heading retitled by the Tier-6 audit: Plan-016 executes at Tier 6 (cross-plan-dependencies §4 build order); Plan-017 at Tier 8. The original "Tier 9" label predated the tier graph.

### Plan-016 — Multi-Agent Channels And Orchestration

Contracts rewritten during the Tier-6 plan-readiness audit (D-016-1..20). Canonical TypeScript source once shipped: `packages/contracts/src/orchestration.ts` (single file — ChannelCreate included; Plan-002's `channels.ts` is read-projection-only and stays untouched). `AgentId` is a new branded UUID (`brandedUuidIdSchema<AgentId>("AgentId")`). All mutations are daemon JSON-RPC (channel/orchestration/agent authority is daemon-local, ADR-001/ADR-003 posture); `channel.list` remains Plan-002's SDK-declared daemon-as-gateway directory read and is NOT part of this surface.

```ts
// Typed configs (D-016-4) — replace the former Record<string, unknown> placeholders
type TurnPolicy = "free-form" | "round-robin" | "request-based"; // Spec-016 §Turn Policies; default "free-form"
type ChannelAudience = "participants" | "humans-only"; // D-016-21 (Spec-016 §Interfaces And Contracts): humans-only content is excluded by each daemon from every agent context it assembles, regardless of which participant owns the agent
interface ChannelConfig {
  turnPolicy?: TurnPolicy;
  roundRobinOrder?: AgentId[]; // REQUIRED non-empty when turnPolicy === "round-robin" (validation error otherwise)
  moderation?: { preTurnGate?: boolean; postTurnReview?: boolean }; // Spec-016 §Moderation Hooks; both default false (V1 opt-in)
  audience?: ChannelAudience; // D-016-21; default "participants"; on a direct-kind channel the daemon forces "humans-only" and refuses a conflicting supplied value (never caller-settable there)
  turnsPerAgent?: number; // D-016-23 (2026-08-11): positive integer — per-channel override of the session's per-agent consecutive-turn limit (session_budgets.turn_limit_per_agent, default 50); absent = session value. The OWN-channel budget provider Spec-017 consumes (A-017-07); enforced by the turn-policy arbiter under unchanged D-016-8 counting; refused on the direct kind with the other agent-turn members. Create-time-fixed like every ChannelConfig member — V1 ships no post-create channel-config mutation, so an overridden channel recovers from its limit by interleave alone (the owner raise via orchestration.budgetUpdate reaches only session-default channels; Spec-016 §Resolved Questions, PR #321 round 1)
}
interface OrchestrationRunConfig {
  tokenLimit?: number; // per-run token budget; default 100000 (Spec-016 §Budget Policies)
  idleTimeoutMs?: number; // idle stop condition; default 300000 (Spec-016 §Stop Conditions)
}
type LinkType = "spawn" | "delegate" | "handoff"; // D-016-17: spawn = parent-initiated helper returning output to the parent's channel context; delegate = bounded task published to its own target channel; handoff = parent transfers its continuation to the child and completes
type InterruptReason =
  | "budget_exhausted"
  | "idle_timeout"
  | "moderation_denied"
  | "workflow_phase_cancelled"; // D-016-8: closed set carried on system-initiated interrupts; the fourth member added 2026-08-11 (D-016-23) — invoked only by the workflow engine's SA-9 phase-termination cascade (Spec-017/Plan-017) through the D-016-7 in-process entrypoint

// ChannelCreate — wire: channel.create (refuses the reserved main name — main is projected, never a row; D-016-15)
interface ChannelCreateRequest {
  sessionId: SessionId;
  name?: string;
  kind?: "general" | "direct"; // D-016-21: the two-value channel-kind domain, mirroring the DDL CHECK (local-sqlite-schema.md §Channel and Orchestration Tables); absent = "general" (the DDL DEFAULT — ordinary session-wide channel). On "direct" (two-human channel) the daemon forces audience "humans-only" and refuses turnPolicy / roundRobinOrder / moderation / turnsPerAgent (agent-turn config on a channel that admits no agents; the fourth member joined the refused set 2026-08-11, D-016-23)
  memberPair?: [ParticipantId, ParticipantId]; // REQUIRED (exactly two DISTINCT human participants) when kind === "direct", refused otherwise; fixed at creation and immutable thereafter. Pair order carries no wire meaning: the daemon canonicalizes to the DDL's single a < b representation BEFORE appending the channel-creation event, so the event payload and the projected row share one representation and replay is deterministic — kind + pair ride that event payload so replay cannot widen audience (Spec-016 §State And Data Implications)
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
// — distinct from Plan-002's channel.list control-plane directory read; a direct-kind channel
// is omitted for callers outside its member pair — Spec-016 §Interfaces And Contracts, D-016-21)
interface ChannelRosterReadRequest {
  sessionId: SessionId;
}
interface ChannelRosterReadResponse {
  channels: Array<{
    id: ChannelId; // synthesized main (deriveMainChannelId(sessionId), CP-002-7) listed first
    name?: string;
    state: ChannelState;
    kind: "general" | "direct"; // D-016-21: total, mirroring the DDL NOT NULL DEFAULT 'general' (synthesized main is "general") — read-back so a pair member's client can render a direct channel as one
    memberPair?: [ParticipantId, ParticipantId]; // D-016-21: present exactly when kind === "direct" (the DDL pair-existence CHECK), served in the canonical a < b order; discloses nothing beyond the caller's own membership — a direct channel's entry is only ever served to its pair members (omitted otherwise, per the filter above)
    config: ChannelConfig;
    arbitration: {
      state: "active" | "paused"; // round-robin arbitration pause (Spec-016 §Partition And Reconnect Behavior) — daemon projection from arbitration.* events
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
  parentRunId?: RunId; // present = child run; child-of-child refused (depth 1, Spec-016 §Resolved Questions and V1 Scope Decisions)
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
  // ── Cost display consistency (Spec-016 §Cost Figure Display Consistency, 2026-08-17, D-016-24) ──
  // A DECOMPOSITION of the number this response already reported, not new arithmetic: the two
  // observed legs below are exactly the TWO folds observedCostCents is rebuilt from (see above),
  // so they are replay-stable for the same reason it is. Identities hold at every fold state
  // (asserted in Plan-016 T2.5, which also asserts the cross-surface equality with the
  // observedValue the daemon stamps on a SESSION-COST usage.budget_warning at the same fold
  // state — budgetType: 'session_cost' only; the run_tokens and agent_turns members of that
  // union carry token and turn counts, not cents, and are outside the equality):
  //   observedPricedCostCents + observedUnpricedDebitCents === observedCostCents
  //   observedCostCents + reservedCostCents === committedSpendCents
  observedPricedCostCents: number; // exact leg — Σ persisted usage.cost_update.costCents (priced-at-zero rows contribute 0)
  observedUnpricedDebitCents: number; // worst-case leg — Σ run.queued.admittedUnpricedCapCents over TERMINAL native-cap runs
  committedSpendCents: number; // the ENFORCED number — what admission compares against costLimitCents; a surfaced session cost figure is this value, never a sum over a visible run list (Spec-016 §Cost Figure Display Consistency clause (a); Plan-016 I-016-24)
  // AGGREGATE reuse of the row-level Spec-006 §Usage Telemetry vocabulary, semantics defined at the
  // Spec-016 subsection: 'priced' iff observedUnpricedDebitCents === 0 && reservedCostCents === 0
  // && no mid-run tier-(c) coverage-loss classification is recorded in the session's persisted
  // history (that class's in-flight unpriced usage is unobservable and enters no fold leg, so
  // both identities above still hold; replay key: the persisted usage.budget_warning with reason
  // 'unpriced-model' carrying the interrupted run's runId — required on that emission path by
  // Spec-016 §Cost Figure Display Consistency; an admission-time family block stamps no runId
  // and is never residue, and the once-per-family latch re-arms when the owner lifts a family's
  // block, so a repaired-then-lost family still writes its run-stamped row), else 'unpriced'.
  // Supplied by the wire so no client derives
  // provenance (Plan-016 I-016-19 zero
  // client derivation / I-016-16 SDK marshals-never-derives). Observability ONLY — enforcement
  // reads committedSpendCents and MUST NOT branch on this, per the no-dual-trust-regimes rule.
  costStatus: "priced" | "unpriced";
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
// Same state type as the read response — so the cost-display members above (including
// committedSpendCents) are REQUIRED here too, and are served from the one BudgetAccountant
// committed-spend accessor exactly as the read is: a budgetUpdate reply reports the new limits
// alongside committed spend at that post-write fold state, never a binder-assembled total
// (Spec-016 §Cost Figure Display Consistency clauses (a)+(c); Plan-016 I-016-24, T3.1 serving,
// T2.5 accessor). An update reply and an immediately following read carry an identical decomposition.
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
interface AgentAttachRequestBase {
  sessionId: SessionId;
  name: string;
  defaultNodeId?: NodeId;
  config?: Record<string, unknown>; // driver-scoped, opaque to this contract
  // 2026-08-26 (D-016-26), additive-optional: the provider axis an agent may be born with.
  providerAccountId?: ProviderAccountId; // omitted = the provider's registered default account
  effort?: string; // validated against the target model's driver-reported `effortLevels`, NOT a
  // corpus-wide enum: the vocabulary is per-model and provider-owned
}
// The inline arm: every core axis spelled out, exactly as before this member existed.
interface AgentAttachInlineRequest extends AgentAttachRequestBase {
  definitionId?: never;
  driverName: string; // Plan-005 provider-driver key
  modelId: string;
}
// 2026-08-26 (CP-016-18 ⇄ CP-030-1) the definition arm: the reference supplies the core axes, and an
// explicitly-present member overrides that axis ALONE. `driverName` / `modelId` are optional HERE and
// required THERE — a two-arm union rather than two bare optionals on one interface, because bare
// optionals would silently admit a request naming neither a definition nor a driver/model pair, which is
// the one shape nothing can resolve. Attaching by reference without respelling the axes is the point of
// the member; leaving them required would have made every definition attach restate what it references.
interface AgentAttachFromDefinitionRequest extends AgentAttachRequestBase {
  definitionId: SidekickDefinitionId; // read ONCE at attach and copied onto the agent record — no live
  // linkage and no foreign key, so editing or deleting the definition afterwards cannot reach this agent
  driverName?: string;
  modelId?: string;
}
type AgentAttachRequest = AgentAttachInlineRequest | AgentAttachFromDefinitionRequest;
interface AgentAttachResponse {
  agentId: AgentId;
  state: AgentState; // "ready" | "configured" at attach
  createdAt: string;
  // 2026-08-26 (CP-016-18 ⇄ CP-030-1), present iff the request carried `definitionId`: the echo lets a
  // client render what it actually got instead of re-reading the registry and assuming it has not moved.
  resolvedFromDefinitionId?: SidekickDefinitionId;
  // Every axis AS APPLIED, `instructions` and `goal` included: without them a caller cannot tell which
  // prompt and goal the attached agent actually received except by re-reading a registry row that may
  // already have moved — which is exactly the live-view read I-030-2 forbids.
  resolvedConfiguration?: Pick<
    SidekickDefinition,
    | "driverName"
    | "modelId"
    | "providerAccountId"
    | "effort"
    | "executionPostureMode"
    | "toolAllowlist"
    | "instructions"
    | "goal"
  >;
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
  // 2026-08-26 (D-016-26) — the provider axis (`Spec-016 §Same-Agent Provider Switch`). Every
  // member is additive-optional and an omitted member is UNCHANGED, never reset.
  driverName?: string; // moving this is the provider switch; continuity is canonical-transcript replay
  providerAccountId?: ProviderAccountId;
  effort?: string;
  // 2026-08-29 — the FIFTH provider axis (`Spec-016 §The mutation surface`). Gated on the
  // target driver's `output_speed` capability flag, which exactly one pinned provider declares;
  // a dispatch against a driver declaring it false refuses as driver.capability_unsupported and
  // is NEVER satisfied by moving `effort` instead, which is a different claim. SPAWN-BOUND, so
  // it resolves to a RUN boundary — read from the declared vocabulary like every other axis, not
  // special-cased: Spec-005 binds this axis to the provider's spawn-time settings mechanism, the
  // only one whose effect was measured. Stated explicitly because it is the minority case here.
  // Deliberately absent from AgentAttach: an agent is not born with a speed mode, so no
  // attach-time snapshot column joins the `agents` row. VALIDATED against the target driver's
  // reported `GetCapabilitiesResult.outputSpeedLevels`, never against a list hardcoded here —
  // the rule `effort?` above already follows. An absent or empty vocabulary makes the axis
  // unsettable and the mutation refuses `agent.provider_axis_invalid` (400) fail-closed, so no
  // unvalidated value is ever forwarded to a provider.
  outputSpeed?: string;
  // Applies at the next boundary the TARGET AXIS permits, never at a fixed one: a turn boundary
  // for an axis the target driver takes as a per-turn override, a run boundary for a spawn-bound
  // one (`driverName` and `providerAccountId` always, since Spec-029 binds a run's account for
  // the run's lifetime, and `outputSpeed` since 2026-08-29 — three spawn-bound axes, re-derived
  // by count when the fifth axis landed). A multi-axis update takes the WIDEST of its axes' boundaries, so no axis
  // applies earlier than its own rule allows. `true` dispatches the EXISTING `interrupt`
  // intervention first and then switches — an entry point into a control the corpus already has,
  // not a new run control, so Spec-004's V1 control set stays closed. The interrupt is
  // authorized as Action::"intervene" on the target run, and a refused interrupt refuses the
  // switch rather than leaving the agent half-moved. This arm HOLDS THE REQUEST OPEN across the
  // boundary — which is what lets its response carry the settlement below — and still writes the
  // durable pending intent BEFORE dispatching the interrupt, so a crash in between costs the
  // caller its answer and not the switch.
  interruptAndSwitch?: boolean;
}
interface AgentConfigUpdateResponse {
  agentId: AgentId;
  state: AgentState; // post-update state (rebind may have changed it)
  updatedAt: string;
  // Present exactly when this update moved the provider axis (2026-08-26, D-016-26). Absent on a
  // pure rename or node rebind, so its presence is the wire's switch discriminator.
  switch?: AgentProviderSwitchDisposition;
}

// Mutation and application are TWO MOMENTS (Spec-016 §Same-Agent Provider Switch), so what the
// mutation returns is a discriminated union and not a settlement. "pending" is the ordinary
// answer; the three SETTLED arms are reachable only on the interruptAndSwitch arm, which collapses
// the two moments into one by holding its request open until the switch settles (Plan-016 T2.16 is
// that arm's only producer). A caller that reads `switch.continuity` without discriminating is
// reading a member that is absent on both the common path and the "failed" arm.
//
// FOUR arms, because holding a request open until settlement means every settlement the boundary
// can reach must be expressible to a caller still waiting for one. "applied" and "degraded" split
// the outcome by a TOTAL and stated mapping — `degraded` iff `continuity` is "memo", `applied` iff
// it is "in_place" or "replayed" — so the honest-degrade rule Spec-006 states for the terminal
// event ("the first two are `applied` and only the last is `degraded`") is carried by the wire's
// own discriminator rather than left to each client to re-derive from `continuity`. "failed" is
// the immediate arm's share of the `agent.provider_switch_failed` terminal: an accepted switch
// that cannot be applied settles the held-open request instead of stranding it, and reuses that
// event's already-closed `reason` vocabulary verbatim — seven members since 2026-08-29 — rather than minting a second one.
type AgentProviderSwitchDisposition =
  | AgentProviderSwitchPending
  | ({ status: "applied" } & AgentProviderSwitchOutcome)
  | ({ status: "degraded" } & AgentProviderSwitchOutcome)
  | AgentProviderSwitchFailed;

interface AgentProviderSwitchPending {
  status: "pending";
  // Daemon-minted, durable on the agent row, and the correlator between this acknowledgment and
  // the terminal `agent.provider_switched` / `agent.provider_switch_failed` event. A caller never
  // supplies it.
  switchId: string;
  // The boundary this switch will apply at — resolved against the TARGET driver's declared
  // vocabulary, never assumed, and the widest of the mutated axes' individual boundaries.
  appliesAt: "turn_boundary" | "run_boundary";
  // TRUE on the interruptAndSwitch arm, FALSE on the deferred one. The boundary above says WHEN
  // the switch applies; this says whether REACHING that boundary requires an interrupt the daemon
  // must dispatch. The two are independent — a deferred switch and an interrupted one can both
  // read "turn_boundary" — so neither a client nor a restarted daemon can re-derive the owed
  // interrupt from `appliesAt`, and the record has to carry it.
  interruptRequested: boolean;
  // The axes this update moved AND the value each is moving TO. The present keys are exactly the
  // moved axes, so the boundary above stays re-derivable from it, and a client that did not issue
  // the mutation can render what the agent is switching to rather than only that it is switching.
  // Carrying the targets rather than only the axis names is load-bearing for durability: this same
  // object is what the `agents.pending_switch` slot stores and what `agent.config_updated` carries
  // (Spec-006 §Channel and Agent Lifecycle), and an intent recording only WHICH axes moved could
  // not be applied at the boundary once the caller's request is gone.
  pendingAxes: AgentProviderSwitchTarget;
  // Present when this update REPLACED an earlier still-pending switch on the same agent: at most
  // one switch is pending per agent, and a later provider-axis update supersedes rather than
  // queues (Spec-016 §Same-Agent Provider Switch). The superseded id never reaches a terminal
  // event, so surfacing it here is the only record a caller gets.
  replacedSwitchId?: string;
}

// The DURABLE SLOT IS A SUPERSET OF THE WIRE SHAPE. `agents.pending_switch` stores the
// `AgentProviderSwitchPending` record above PLUS two members that are never returned to a caller
// and never appended to an event payload:
//
//   admittingPrincipalId — the daemon-resolved, transport-authenticated principal that admitted
//     this switch, recorded under the §Authenticated Principal And Authorization Model class rule
//     above. A pending switch IS an admitting write: its acceptance authorizes work the original
//     request no longer accompanies — the application itself, and every turn the new binding then
//     executes. Both terminals require an `actor`, and a switch settling after a restart has no
//     request left to resolve one from. No `origin` discriminator accompanies it: the class rule
//     makes that member conditional on a row having a non-participant writer, and this slot has
//     none — `agent.configUpdate` is its only producer, so every pending switch is a participant
//     admission and the principal is unconditionally required. The absence is recorded here rather
//     than left silent because under that rule it is a claim, not an omission. Were a system-
//     initiated switch ever specified, the rule would oblige the discriminator AND oblige that it
//     be enforced by the recorded value's own closed shape: this carrier is a JSON blob, which no
//     table-level CHECK constrains.
//   interruptDispatch — "requested" | "dispatched", present exactly when `interruptRequested` is
//     true. Deliberately NOT a boolean and not folded into `interruptRequested`, because recovery
//     must separate "crashed before the interrupt went out, so dispatch it" from "crashed after it
//     landed, so reconcile": redispatching in the second case fires a second interrupt at a run
//     that already took one. The advance to "dispatched" is its OWN durable write, made once the
//     interrupt is accepted; a crash between the two costs one idempotent redispatch, never a lost
//     switch.
//
// Both are recovery inputs rather than session-observable facts, and the class rule binds a
// DURABLE HOME — a projection column or a canonical event payload — never a mutation reply.
// Echoing a resolved principal back to its own caller would invite a client to read it as
// authority; keeping the slot a superset is what lets the wire shape stay exactly the intent a
// client is entitled to see.

// The immediate arm's failure settlement, carrying the SAME closed seven-member vocabulary as the
// `agent.provider_switch_failed` event (Spec-006 §Channel and Agent Lifecycle) — one vocabulary
// across two surfaces, so a held-open refusal and the terminal event render the same reason set.
// This is a RESULT, not a JSON-RPC error: the switch was accepted, a `switchId` was minted, and
// `agent.config_updated` was already appended, so the mutation succeeded and only the application
// did not. Refusals that happen BEFORE acceptance — an unknown axis, an invalid value — are the
// synchronous `agent.provider_axis_invalid` error instead, and mint no `switchId` and no event.
interface AgentProviderSwitchFailed {
  status: "failed";
  switchId: string;
  reason:
    | "driver_unavailable"
    | "model_unavailable"
    | "effort_unavailable"
    | "account_unavailable"
    // 2026-08-29 — the deferred application reached a target whose driver no longer declares
    // `output_speed`, or whose declared vocabulary no longer carries the pended value. Minted
    // WITH the fifth axis rather than after it: a spawn-bound axis is settled at a run boundary
    // the caller has already been acknowledged for, so without its own member an axis-specific
    // failure would have to render as one of the four above and misname what went wrong.
    | "output_speed_unavailable"
    | "interrupt_refused"
    | "target_unstartable";
}

// The five provider axes as a partial record: an omitted key is an axis this switch does not
// move. One shape serves three surfaces — the wire acknowledgment above, the durable
// `agents.pending_switch` slot, and the `agent.config_updated` payload's `pendingSwitch` member —
// so a client, a projector, and a restarted daemon all read the same record of the same intent.
// The record is deliberately TWO-STATE and not the `defaultNodeId?: NodeId | null` tri-state
// above: no V1 operation clears a provider axis back to a driver default, so an omitted key is an
// axis not moving and there is no third meaning to encode. `driverName` and `modelId` cannot be
// cleared at all (an agent always has both), and clearing `providerAccountId`, `effort`, or
// `outputSpeed` is not an operation `AgentConfigUpdate` offers, whose omitted members are
// uniformly "unchanged, never
// reset". Minting the clear would widen this record to the tri-state in the same amendment.
// `outputSpeed` joined 2026-08-29 with the fifth axis and NOT after it: it is spawn-bound, so it
// is the axis most likely to be pending across a restart, and an axis a caller can request but
// the durable slot cannot hold would be acknowledged and then silently dropped. Its settlement is
// describable in the vocabulary already below rather than needing an arm of its own — being
// spawn-bound it reaches a FRESH provider process, so it settles "replayed" when the canonical
// transcript reaches that process and "memo" when it cannot, never "in_place", which is reserved
// for an override carried on the running one. That it changes a settings flag rather than the
// model does not make the reconstitution smaller: the same conversation has to arrive.
interface AgentProviderSwitchTarget {
  driverName?: string;
  providerAccountId?: ProviderAccountId;
  modelId?: string;
  effort?: string;
  outputSpeed?: string;
}

type AgentProviderAxis = keyof AgentProviderSwitchTarget;

// The settlement of a provider switch, mirrored onto the `agent.provider_switched` event payload.
interface AgentProviderSwitchOutcome {
  switchId: string; // correlates with the pending acknowledgment above
  // "in_place" = a per-turn-override axis carried into the next turn on the RUNNING process:
  // nothing was respawned and nothing was replayed. "replayed" = the canonical transcript reached
  // a fresh target session. "memo" = it could not and the bounded prose projection stood in.
  // A "memo" settlement is rendered `degraded` by both clients and is never presented as an
  // ordinary success; "in_place" and "replayed" are both `applied`. On the held-open arm that
  // mapping is carried by the disposition's own `status` discriminator above (`degraded` iff
  // "memo"), so a client never re-derives it; on the terminal event it is carried by this member
  // alone, the event having no status.
  continuity: "in_place" | "replayed" | "memo";
  // REQUIRED, and an EMPTY ARRAY IS A CLAIM: it asserts that nothing was dropped. A driver that
  // does not know what it lost may not emit one. Closed vocabulary — a new loss kind is an
  // amendment, never a free string. Requiredness is scoped to the continuity arm: "in_place"
  // MUST carry the empty array (no replay happened, so no loss could), "memo" MUST be non-empty
  // and MUST include "conversation_history_summarized", and "replayed" MAY be empty — that
  // emptiness being the positive assertion above.
  // The claim is scoped to TRANSCRIPT CONTENT and to nothing else (2026-08-29). An empty array
  // asserts that the conversation arrived intact; it asserts nothing about whether a requested
  // provider SETTING took effect on the new binding. Those are different facts with different
  // carriers — a spawn-bound axis the provider declined is reported by the live read-back on the
  // agent row, not by a loss kind — and conflating them would either fabricate a transcript loss
  // that did not happen or let an empty array be read as a guarantee it was never making.
  declaredLosses: DeclaredLossKind[];
}

type DeclaredLossKind =
  | "provider_private_reasoning" // non-portable by both vendors' stated rules; never translated
  | "context_truncated" // the memo budget evicted older exchanges (whole exchanges only, never halves)
  | "tool_call_history_repaired" // an unpaired call took a synthetic error result rather than being dropped
  | "conversation_history_summarized" // the memo floor: verbatim exchanges replaced by a bounded prose rendering
  | "turn_content_unavailable" // a logged turn's body could not be read when the fold ran; the turn is carried with its structural position and an empty body rather than being dropped, because an empty body alone reads as "the author said nothing" and a dropped turn reads as "the turn never happened" and both are false. The first of the two members produced at pipeline step 1 (Fold), which is daemon-side and upstream of the driver: it reaches AgentProviderSwitchOutcome.declaredLosses through the canonical projection, never through DriverTranscriptExportResult, whose own comment scopes that member to steps 3 and 4
  | "turn_content_truncated"; // a logged turn's body exceeded CONTENT_PAYLOAD_PLAINTEXT_MAX at append and is stored as a codepoint-boundary prefix in session_events.content_payload; the fold carries the prefix and names the loss rather than replaying a silently shortened turn. The second member produced at pipeline step 1 (Fold), reaching AgentProviderSwitchOutcome.declaredLosses through the canonical projection like its sibling above and never through DriverTranscriptExportResult. Deliberately NOT folded into "context_truncated", whose scope is the memo budget evicting whole exchanges and never halves, and NOT reported as "turn_content_unavailable", which would overstate a turn that is available as a prefix (Spec-006 §Assistant Output, the 2026-08-30 machine-authored prose amendment)
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
    // 2026-08-26 (D-016-26): the agent's EFFECTIVE provider axis — the binding it runs under now,
    // never the pending one. Absent `providerAccountId` = the provider's registered default;
    // absent `effort` = the driver's own default for the model; absent `outputSpeed` (added
    // 2026-08-29 with the fifth axis) = never set, so the provider's own default stands. Each is
    // served from that axis's own column on the agent row — the columns an applying switch commits
    // its binding into — so every axis a caller can move is also an axis a caller can read back.
    // A spawn-bound axis readable only as a PENDING intent would go dark at the moment it applied.
    providerAccountId?: ProviderAccountId;
    effort?: string;
    outputSpeed?: string;
    // What the PROVIDER declared, as against `outputSpeed` above, which is what was REQUESTED
    // (2026-08-29, Spec-005 §The output-speed axis). Projected at response-build time from the
    // binding-held `ProviderOutputSpeedState` — the observation the driver recorded when the
    // declaring handshake arrived — and stored in no column, so it cannot go stale. LIVE-SCOPED on
    // the SA-44 park-member precedent.
    //
    // ABSENT HAS EXACTLY THREE CAUSES, and none of them is "the mode is off" (round-3 fold): the
    // binding's driver declares no `output_speed` and there is nothing to read; the driver declares
    // it and NO TURN-BEARING EXCHANGE HAS YET CARRIED THE HANDSHAKE, so the observation has not
    // happened; or no binding for this agent is live. The middle arm is the one a spawn-time reader
    // will hit — an agent read immediately after a switch applies is expected to show the requested
    // value with this member absent — so consumers render "not yet observed", never "off" and never
    // a stand-in for `outputSpeed`. Presence stays the discriminator for "this was read from the
    // provider"; absence now means nothing has been read YET or ever, which is the same instruction
    // to the reader in every arm.
    //
    // UNDER CONCURRENT BINDINGS the projection is the agent's MOST RECENTLY ESTABLISHED live
    // binding, stated as a rule rather than left to "the live binding" (round-3 fold): an agent can
    // hold several at once, and that one is the only binding whose spawn could have realized the
    // `outputSpeed` served beside it, so the two values in this row compare like with like instead
    // of pairing a current request with an older leg's declaration. A single-binding agent — the
    // ordinary case — is unaffected. This member is what makes the prohibited false success
    // unrenderable — a provider that ACCEPTS the setting and then leaves the mode off shows a
    // requested value and a differing declared one, with the provider's own reason beside it.
    // That disagreement is deliberately NOT a switch failure: the switch applied, the provider
    // then declared something else, and reporting it as a failure would be the same false claim
    // in the other direction — so `AgentProviderSwitchFailed.reason` stays unwidened for it, and
    // `output_speed_unavailable` keeps its own narrower meaning (the mode could not be requested
    // at all: the vocabulary is gone, or the target driver stopped declaring the flag).
    observedOutputSpeed?: ProviderOutputSpeedState;
    // Present exactly while a switch is pending on this agent, so the deferred intent is readable
    // rather than inferable — including after a daemon restart, which re-arms it from the durable
    // agent row. A list read is how a caller that was not the mutator learns a switch is queued.
    pendingSwitch?: AgentProviderSwitchPending;
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
| `orchestration.costReceiptRead` | RPC | `SessionCostReceiptRequest` → `SessionCostReceiptResponse` | Read-only decomposition of the committed-spend fold (2026-08-18, D-016-25 — shapes below); served from the same accountant accessor as `orchestration.budgetRead`, so the two can never disagree |
| `orchestration.budgetUpdate` | RPC | `OrchestrationBudgetUpdateRequest` → `OrchestrationBudgetUpdateResponse` | Session-owner-only (wire-boundary authorization) |
| `session.goalUpdate` | RPC | `SessionGoalUpdateRequest` → `SessionGoalUpdateResponse` | Owner/collaborator — viewers + runtime contributors read-only, per the Security Architecture role matrix ([Spec-016 §Session Goals](../../specs/016-multi-agent-channels-and-orchestration.md#session-goals), campaign B6); an accepted update emits `session.goal_updated` carrying the same canonical `goal` |
| `session.goalClear` | RPC | `SessionGoalClearRequest` → `SessionGoalClearResponse` | Owner/collaborator; an accepted clear emits `session.goal_cleared` (clearing is the distinct operation — an update without a goal is malformed) |
| `agent.attach` | RPC | `AgentAttachRequest` → `AgentAttachResponse` | Emits `agent.attached` |
| `agent.detach` | RPC | `AgentDetachRequest` → `AgentDetachResponse` | Emits `agent.detached` |
| `agent.configUpdate` | RPC | `AgentConfigUpdateRequest` → `AgentConfigUpdateResponse` | Emits `agent.config_updated` |
| `agent.list` | RPC | `AgentListRequest` → `AgentListResponse` | agents-table projection |

Error vocabulary: [error-contracts.md](./error-contracts.md) §Channel / §Orchestration / §Agent (D-016-16) plus the §Session `session.goal_delivery_failed` (502) and `session.goal_mutation_in_flight` (409) mappings for the live goal-delivery RPCs (campaign B6). Durable events owned by Plan-016 (Spec-006 registrations): `channel.created` / `channel.muted` / `channel.unmuted` / `channel.archived`, `agent.attached` / `agent.detached` / `agent.config_updated` / `agent.provider_switched` / `agent.provider_switch_failed`, `arbitration.paused` / `arbitration.resumed`, `orchestration.rejected`, `usage.budget_warning`, `moderation.review_flagged`, `session.goal_updated` / `session.goal_cleared` (campaign B6 — emitted by the goal RPCs above) — see [Spec-006 §Event Type Registry](../../specs/006-session-event-taxonomy-and-audit-log.md).

**Session cost receipt (2026-08-18, Plan-016 D-016-25).** One new read pair, `orchestration.costReceiptRead`, taking the wire-method registry for this plan from fifteen pairs to sixteen. The reply is a **decomposition of the committed-spend fold**, not a second computation: every figure below is served from the same accountant accessor that answers `orchestration.budgetRead`, so a divergence between the two is a bug in exactly one place. Read-only — no receipt member is accepted on any request, so a caller can never assert an attribution or a total.

```ts
interface SessionCostReceiptRequest {
  sessionId: SessionId;
}

// The two partition identities below are the contract, not commentary. Each unit of
// committed spend appears in EXACTLY ONE row of each axis, so both axes total to the
// same session figure:
//   sum(runs[].costCents)      === sessionTotal.committedSpendCents
//   sum(causedBy[].costCents)  === sessionTotal.committedSpendCents
// A consumer asserting either identity is asserting that no row was double-counted or
// dropped. `byAccount` is a third partition over the same spend and totals identically.
interface SessionCostReceipt {
  sessionTotal: OrchestrationBudgetState; // the SAME shape the budget read/update replies carry — one type, one accessor
  runs: SessionCostReceiptRunRow[];
  causedBy: SessionCostReceiptCausedByRow[];
  byAccount: SessionCostReceiptAccountRow[];
}

interface SessionCostReceiptRunRow {
  runId: RunId;
  costCents: number;
  costStatus: CostStatus; // served by the daemon; enforcement MUST NOT branch on it (I-016-24)
  aggregationScope: "run-only"; // REQUIRED and closed at this single literal — the receipt is the one
  // V1 surface emitting run-scoped cost figures, and `Spec-016 §Cost Figure Display Consistency`
  // clause (b) is verified POSITIVELY by every row carrying this declaration.
}

interface SessionCostReceiptCausedByRow {
  party: SessionCostReceiptParty; // a participant, or the `system` arm
  costCents: number;
  costStatus: CostStatus;
}

// Spend no participant caused — scheduled sweeps, idle-timeout settlements, daemon-initiated
// recovery turns — lands on the `system` arm rather than being distributed across participants
// or silently dropped. An unattributable turn is NOT guessed.
//
// 2026-08-26: this is now an ALIAS of the value each metered row carries, not a parallel shape.
// The receipt's per-caused-by group key IS the `effectivePrincipal` stamped on the
// `usage.cost_update` rows being folded, carried verbatim — so the axis is a partition BY
// CONSTRUCTION (every unit of spend carries exactly one key) rather than by argument, and the two
// shapes cannot drift apart into a mismatched group key.
type SessionCostReceiptParty = EffectivePrincipal;

// The turn-scoped effective principal: the party whose causation a unit of work is attributed to.
// Daemon-resolved and NEVER wire- or driver-supplied — the run engine maintains it from the
// `interventions` admitting-principal rows (the intervener for a steered or edited-and-resent
// turn; for a run created by a peer-invocation tool call, the effective principal of the
// invoking TURN — the one that issued the call, already resolved and stamped at that moment,
// so a later steer of the asking run never re-attributes an already-created child — chained
// through the parent/child run link; otherwise the participant who started the run), and the driver's usage normalizer stamps
// it at emission. Registered as instance (4) of the §Authenticated Principal class rule, whose
// two shape deviations that section states explicitly.
//
// The two arms are closed, and the participant reference is required on the participant arm and
// ABSENT on the system arm — the same discriminator discipline the `interventions.origin` CHECK
// enforces in storage, expressed here by the union's shape because a wire payload has no table to
// constrain. A single nullable participant id was rejected for the reason NS-71 rejected it on the
// column: an unstamped value and a deliberately-unattributed one would be indistinguishable.
type EffectivePrincipal =
  | { kind: "participant"; participantId: ParticipantId }
  | { kind: "system" };

interface SessionCostReceiptAccountRow {
  providerAccountId: ProviderAccountId;
  displayLabel: string;
  billingMode: "subscription" | "metered" | "unknown"; // labels the figure; never changes how it is derived. `unknown` labels the figure as unlabelled-by-the-operator, and is never presented as billed dollars
  costCents: number;
  costStatus: CostStatus;
}
```

No new event type, no new error code, and no new table: the receipt is a decomposition of an existing in-memory fold, so `usage.budget_warning` and `session_budgets` are unchanged and `usage.cost_update` was unchanged **by this amendment** — the 2026-08-26 turn-scoped effective-principal carrier (instance (4) of §Authenticated Principal And Authorization Model) is what later added the `effectivePrincipal` member the per-caused-by axis reads. Two of the three axes are **supplied rather than minted here** — the paying account arrives as the `run.queued` server stamp `admittedProviderAccountId` plus the registry's billing mode ([Plan-029](../../plans/029-provider-accounts-and-credential-homes.md), CP-029-3), and the caused-by axis keys on the turn-scoped effective principal, which since 2026-08-26 arrives as the `effectivePrincipal` member stamped on each `usage.cost_update` row it folds ([Spec-006 §Usage Telemetry](../../specs/006-session-event-taxonomy-and-audit-log.md#usage-telemetry-usage_telemetry)) — and this plan reads both without widening either.

### Plan-017 — Workflow Authoring And Execution

Corrected by the Tier-8 plan-readiness audit (2026-08-10). Three defects closed: the `PhaseDefinition.type` union carried the pre-amendment two-value V1.1-deferred subset while the governing spec ships four phase types; five of the ten declared operations had no shape at all; and `WorkflowGateResolveResponse` carried neither half of the SA-26 dual anchor. The `scope` domain is also re-grounded — see the `WorkflowDefinitionScope` comment below — and gains the `scopeRef` companion the three-value domain needs to be storable at all. One operation is minted: `workflow.definitionList`, because the ten declared operations contained no enumeration. Field additions to already-published shapes are additive-**optional** per [ADR-018](../../decisions/018-cross-version-compatibility.md), marked as such inline, and become required at the next MAJOR; the new shapes below are unconstrained.

Extended the same day by the visual-builder amendment (`Spec-017 §Visual Workflow Builder`, ADR-026): the definition-create request gains the entry record and the copy-on-write parent pointer, `PhaseDefinition` gains reference-only tool bindings and the non-edge `go-back-to` target, and `WorkflowToolBinding` lands as a new shape. The amendment mints **no** operation — promotion to `shared` scope and file import both ride `workflow.definitionCreate` — so the method registry below stays at eleven rows.

Extended again in the same audit cycle by the graph-topology closure: `PhaseDefinition` gains the optional `dependsOn` predecessor list and the join-phase `parallelJoinPolicy` — the persisted spelling of the sequence edges, fan-out, and join policy of `Spec-017 §Graph model — nodes, ports, and edges (SA-32)`, all-or-none across a definition. Both are additive-OPTIONAL per ADR-018 on the already-published shape: a definition that omits topology throughout is the sequential chain and stays byte-identical to its pre-closure form, so no stored hash moves.

```ts
// Workflow-definition scope (Spec-017 §Resolved Questions and V1 Scope Decisions,
// amended 2026-08-10). Three values: `session` binds the definition to its authoring
// session, `project` spans a project's sessions, `shared` is the cross-project tier —
// a definition reusable by any project on the same daemon, out of the same local
// definition store. `shared` widens visibility/reuse breadth only: no distribution,
// no marketplace, no cross-machine sync. The pre-audit `channel` value appeared only
// here and in the DDL, never in the governing spec, and is struck.
type WorkflowDefinitionScope = "session" | "project" | "shared";

// Scope identity, in the shape Spec-028 already uses for scope-qualified bindings:
// non-empty for `session` (the authoring session id) and `project` (the canonical
// symlink-resolved repository root); the empty string for `shared`, which is
// daemon-wide and refers to nothing narrower. Enforced at the schema layer as a typed
// validation error, with the DDL CHECK mirroring it as defense in depth — without it,
// `project` names no project and definition dedupe cannot converge.
//
// On requests the field is additive-OPTIONAL per ADR-018 and the daemon derives what
// it can: absent at `session` means the request's own `sessionId`, absent at `shared`
// means the empty string. `project` is the one scope with nothing to derive from, so
// omitting it there is a typed refusal, never a silent default.
type WorkflowDefinitionScopeRef = string;

// WorkflowDefinitionCreate — workflow.definitionCreate
interface WorkflowDefinitionCreateRequest {
  sessionId: SessionId;
  name: string;
  // A create whose target scope is `shared` — direct authoring, file import, or the
  // SA-36 promotion, which all ride this one operation — adjudicates the daemon's
  // operator-scope authorization through the Plan-012 Cedar evaluation surface
  // (`PermissionCheckService`) against the daemon-resolved node-owner participant
  // identity before any row is written, failing closed while that resolution seam
  // is unwired. A non-operator principal is a typed refusal, never a silent
  // downgrade to a narrower scope (Spec-017 §Core SDK and persistence contracts;
  // the Spec-028 §Authorization governance-mutation boundary).
  scope: WorkflowDefinitionScope;
  scopeRef?: WorkflowDefinitionScopeRef; // additive-optional; required in practice at `project`
  // Additive-OPTIONAL per ADR-018 on this already-published shape. A stored definition
  // always carries exactly one entry record; the request may omit it because `manual` is
  // the only V1 start mode, so the daemon materializes `{ startMode: "manual" }` when
  // absent. Required at the next MAJOR, by which point a second start mode may exist.
  // Spec-017 §Entry node and the V1 trigger surface (SA-37)
  entry?: WorkflowEntry;
  // Copy-on-write provenance: the content hash of the `shared` definition this one was
  // branched from when an author edited a shared definition. Provenance only — it is NOT
  // part of the hashed body, so a branched definition and a from-scratch definition with
  // identical bodies hash alike.
  // Spec-017 §Definition scope in the builder (SA-36)
  parentContentHash?: string;
  phaseDefinitions: PhaseDefinition[];
}

// Structurally extensible single-value record — NOT a union. No `schedule`, `event`, or
// `webhook` arm is declared at V1: Spec-017 §Non-Goals records the C-11 precedent for an
// enum whose arms outran the engine and had to be break-removed. A firing engine's start
// mode is an additive-MINOR extension under ADR-018 when one ships.
interface WorkflowEntry {
  startMode: "manual";
}
interface WorkflowDefinitionCreateResponse {
  definitionId: WorkflowDefinitionId;
  versionNumber: number;
  // Additive-OPTIONAL per ADR-018 (Tier-8 audit): `WorkflowDefinitionCreateResponse`
  // is an already-published shape. Present so a caller can pin the version it just
  // authored without a follow-up read; absent from older daemons.
  contentHash?: string; // BLAKE3 over RFC 8785 JCS canonicalization
  // Additive-OPTIONAL per ADR-018, same constraint as `contentHash` above: the
  // opaque server-minted reference to the just-authored version — the exact value
  // workflow.runStart accepts as `workflowVersionId`, so an author can start what
  // it just created without a follow-up read. Absent from older daemons.
  workflowVersionId?: string;
  createdAt: string;
}

// The three-value parallel-join policy of Spec-017 §Execution semantics (SA-4), in
// lockstep with the `parallel_join_state.policy` CHECK in the DDL — the Plan-017
// conformance suite pins the pair.
type ParallelJoinPolicy = "fail-fast" | "all-settled" | "any-success";

interface PhaseDefinition {
  phaseId: WorkflowPhaseId;
  name: string;
  // The four V1 phase types (Spec-017 §Phase-Type and Gate-Type Taxonomy). The former
  // two-value union predated the 2026-04-22 full-engine amendment and was still in
  // force here until the Tier-8 audit; typing to it shipped a two-type engine.
  type: "single-agent" | "multi-agent" | "automated" | "human";
  gateType: "auto-continue" | "quality-checks" | "human-approval" | "done";
  failureBehavior: "retry" | "go-back-to" | "stop";
  // Additive-OPTIONAL per ADR-018 (visual-builder amendment). Reference-only tool
  // bindings for this phase; see WorkflowToolBinding below.
  toolBindings?: WorkflowToolBinding[];
  // Additive-OPTIONAL per ADR-018 (visual-builder amendment). The `go-back-to` failure
  // behavior's target phase. This is a state-reset target, NOT a graph edge — the
  // definition-create cycle check would reject the cyclic spelling, so the builder
  // renders it as an annotation on the phase node and never as a drawn connection
  // (Spec-017 §Graph model — nodes, ports, and edges (SA-32)).
  goBackTo?: WorkflowPhaseId;
  // Additive-OPTIONAL per ADR-018 on this already-published shape (graph-topology
  // closure). The persisted spelling of the SA-32 sequence edges: the ids of the
  // phases whose gates must resolve to continue before this phase becomes
  // eligible; an empty list marks an entry-node successor. All-or-none across a
  // definition — when every phase omits it, `phaseDefinitions` order declares the
  // sequential chain and the stored bytes are exactly what the author submitted
  // (the daemon never materializes the lists); supplying it on some phases but
  // not others is a typed refusal. Fan-out is one id appearing in more than one
  // list; a join is a phase listing more than one id
  // (Spec-017 §Graph model — nodes, ports, and edges (SA-32)).
  dependsOn?: WorkflowPhaseId[];
  // Additive-OPTIONAL per ADR-018 (graph-topology closure). Required exactly when
  // this phase is a join (`dependsOn` lists more than one id): the policy
  // governing the fan-out that converges here. A join without it is the SA-33
  // rule-7 refusal; a non-join carrying it is refused. Authoring surfaces supply
  // the `fail-fast` default of Spec-017 §Default Behavior — the wire and the
  // store never default it.
  parallelJoinPolicy?: ParallelJoinPolicy;
  config?: Record<string, unknown>;
}

// Reference only. Carries NO `enabled`, `approvalMode`, or `idempotencyClass` facet —
// those three are node-operator surface owned by Spec-028 §Tool-Level Overrides
// under Cedar authorization, resolved live at phase launch through the Spec-005
// tool-metadata layer. A definition carrying one is rejected at parse, not ignored at
// launch, so an imported or hand-edited definition cannot smuggle a weakened posture
// onto a machine (Spec-017 §Tool bindings are references, never inline policy (SA-34)).
// Identity COMPOSES the Plan-028-owned `McpServerBindingRef` discriminated union declared
// in §Plan-028 below rather than restating its members: Plan-017 consumes that identity and
// authors none of it (CP-017-6), and re-declaring it flat would admit the non-existent
// `(codex, local)` combination the union rejects at the schema layer. The binding scope here
// is Spec-028's config scope, never the workflow-definition scope above.
interface WorkflowToolBinding {
  binding: McpServerBindingRef;
  toolName: string;
}

// WorkflowDefinitionRead — workflow.definitionRead
interface WorkflowDefinitionReadRequest {
  definitionId: WorkflowDefinitionId;
  version?: number; // omit for latest
}
interface WorkflowDefinitionReadResponse {
  id: WorkflowDefinitionId;
  name: string;
  scope: WorkflowDefinitionScope;
  scopeRef?: WorkflowDefinitionScopeRef; // additive-optional per ADR-018; always set by daemons that store it
  versionNumber: number;
  // Additive-OPTIONAL per ADR-018 on this already-published shape: the opaque
  // server-minted reference to the returned version — the exact value
  // workflow.runStart accepts as `workflowVersionId`. Always emitted at this
  // contract revision; absent from older daemons.
  workflowVersionId?: string;
  phaseDefinitions: PhaseDefinition[];
  createdAt: string;
}

// WorkflowDefinitionList — workflow.definitionList. NEW at the Tier-8 audit: the ten
// pre-audit operations contained no enumeration, so neither the CLI `list` subcommand
// nor any definition picker could name a definition it did not already hold an id for.
// Enumeration is scope-resolved most-specific-first — a caller in a session sees that
// session's definitions, its project's, and the daemon's `shared` tier, deduped by
// `(scope, scopeRef, contentHash)` exactly as the store keys them.
interface WorkflowDefinitionListRequest {
  sessionId: SessionId;
  scope?: WorkflowDefinitionScope; // omit for the resolved union of all visible scopes
  limit?: number;
  cursor?: string;
}
interface WorkflowDefinitionListResponse {
  definitions: WorkflowDefinitionSummary[];
  nextCursor?: string;
}
interface WorkflowDefinitionSummary {
  id: WorkflowDefinitionId;
  name: string;
  scope: WorkflowDefinitionScope;
  scopeRef: WorkflowDefinitionScopeRef;
  latestVersionNumber: number;
  // The opaque server-minted reference to that latest version — the exact value
  // workflow.runStart accepts as `workflowVersionId`; clients pass it through
  // verbatim and never synthesize it. `latestVersionNumber` stays alongside it
  // because workflow.versionRead addresses by (definitionId, versionNumber).
  // Required: this shape is new at the Tier-8 audit, so ADR-018's
  // additive-optional rule does not bind it.
  latestWorkflowVersionId: string;
  // Required here, unlike the optional `contentHash` on WorkflowDefinitionCreateResponse:
  // this shape is new at the Tier-8 audit, so ADR-018's additive-optional rule for
  // already-published shapes does not bind it, and an enumeration entry without a hash
  // cannot be pinned by the caller that just listed it.
  contentHash: string;
  // True for the one entry per definition name that most-specific-first resolution
  // (`session`, then `project`, then `shared`) would actually pick from the caller's
  // context, so a picker or `sidekicks workflow list` can show which definition a run
  // would use rather than leaving the caller to re-derive the order
  // (Spec-017 §Definition scope in the builder (SA-36)). Required: this shape is new
  // at the Tier-8 audit, so ADR-018's additive-optional rule does not bind it.
  resolvesAtThisContext: boolean;
  createdAt: string;
}

// WorkflowVersionRead — workflow.versionRead. Reads one immutable version body.
// Versions are content-hashed and never mutated; a definition edit mints a new one.
interface WorkflowVersionReadRequest {
  definitionId: WorkflowDefinitionId;
  versionNumber: number;
}
interface WorkflowVersionReadResponse {
  definitionId: WorkflowDefinitionId;
  versionNumber: number;
  // The opaque server-minted reference to THIS version — the exact value
  // workflow.runStart accepts as `workflowVersionId`; see the constructibility
  // note there. Required: this shape is new at the Tier-8 audit, so ADR-018's
  // additive-optional rule for already-published shapes does not bind it.
  workflowVersionId: string;
  contentHash: string;
  // The schema-version marker, verbatim as stored: workflow_definitions.schema_version
  // is TEXT with an "N.N" CHECK (GLOB '[0-9]*.[0-9]*'), and the file form's marker
  // is `ai-sidekicks-schema: 1.0` (C-8). A string, deliberately not a number — a
  // number cannot round-trip the marker ("1.0" collapses to 1, losing the minor,
  // and "1.10" would collide with "1.1").
  schemaVersion: string;
  // The remaining canonical-body fields, without which export — a client-side
  // serialization of this read — could not reproduce the canonical bytes or their
  // content hash. The file form has exactly two top-level parts, the hashed
  // definition body and the optional non-hashed `layout`
  // (Spec-017 §Definition file form — export and import (C-17)), so the name, the
  // entry record, and the phase sequence all live inside the hashed body. A stored
  // definition always carries exactly one entry record — the daemon materializes
  // `{ startMode: "manual" }` when the authoring request omitted it
  // (Spec-017 §Entry node and the V1 trigger surface (SA-37)) — so `entry` is
  // required here even though it is optional on create. Both required: this shape
  // is new at the Tier-8 audit, so ADR-018's additive-optional rule does not bind
  // it.
  name: string;
  entry: WorkflowEntry;
  phaseDefinitions: PhaseDefinition[];
  createdAt: string;
}

// WorkflowRunStart. Callers: CLI, desktop, the intercepted `/workflow start` command,
// the composer affordance, and the `workflow_start` callback tool — all one operation;
// no chat caller mints a start mode (Spec-017 SA-37/SA-38). The handler adjudicates the
// SA-39 named Cedar operation action per start and refuses `workflow.start_denied`.
interface WorkflowRunStartRequest {
  // The opaque server-minted version reference — the immutable version row's
  // primary key, returned verbatim by workflow.versionRead,
  // workflow.definitionRead, workflow.definitionList, and
  // workflow.definitionCreate. Clients pass it through and never synthesize or
  // parse it: no delimiter or encoding over (definitionId, versionNumber) exists
  // on the wire.
  workflowVersionId: string;
  sessionId: SessionId;
  // Additive-OPTIONAL per ADR-018 (2026-08-11 chat-start amendment, ADR-027). The
  // originating channel of a chat-borne start — provenance and progress-surface binding
  // only. Not an input to the SA-39 role adjudication, but daemon-VALIDATED before it
  // binds a surface: the handler requires the daemon-resolved starting participant to
  // be a member of the named channel and refuses `workflow.start_denied` otherwise, so
  // a forged value can never surface run progress into (or inject a progress card
  // into) a channel the starter cannot see. Absent on CLI/desktop non-chat starts.
  channelId?: ChannelId;
}
interface WorkflowRunStartResponse {
  workflowRunId: WorkflowRunId;
  state: "pending" | "running";
  phaseStates: PhaseState[];
}

interface PhaseState {
  phaseId: WorkflowPhaseId;
  // `phaseRunId`, `attemptNumber`, and `formRevision` below are additive-OPTIONAL
  // per ADR-018 — `PhaseState` is an already-published shape, so the Tier-8 audit
  // could widen it but not make a new field required. Readers must tolerate their
  // absence.
  //
  // The execution instance, and the OWN-channel anchor (SA-6). A derived opaque
  // identifier per Spec-017 §Deterministic identity (SA-21): every bit is a function of
  // BLAKE3(workflowRunId || phaseDefinitionId || attemptNumber). NOT a ULID — a ULID's
  // leading 48 bits are a millisecond timestamp, which that preimage cannot produce.
  // The digest's text rendering is deliberately unfixed; see Spec-017 §Open Questions.
  phaseRunId?: string;
  attemptNumber?: number;
  state: "pending" | "running" | "completed" | "failed" | "skipped";
  gateState: "closed" | "open" | "bypassed";
  // The V1 optimistic-concurrency token for workflow.humanFormSubmit, per attempt:
  // 0 while the attempt has no accepted submission, 1 after its accepted submission
  // — phase_outputs is write-once per attempt, so no higher value is derivable, and
  // a retry mints a new attempt that reads 0 again. Derived from truth-tier
  // phase_outputs, never from human_phase_form_state, which ships empty at V1
  // (Spec-017 §Ship-empty tables (SA-28)). Emitted for `human` phases by daemons at
  // this contract revision; absent from older daemons and on non-`human` phases.
  formRevision?: number;
  // --- Park surface (added 2026-08-18 by the park-surface + operator-controls
  // amendment; four additive-OPTIONAL members under the same ADR-018 rule as the
  // three above — readers must tolerate their absence). They mirror the four
  // per-phase park columns of local-sqlite-schema.md §Workflow Tables (Plan-017).
  //
  // LIVE, NOT RECORD — the one producer rule that makes these readable. The
  // projection COLUMNS are a durable record that survives resume and cancellation;
  // these WIRE MEMBERS are a live view of it. A daemon emits all four (subject to
  // each member's own presence rule below) for exactly those phases that are parked
  // at the moment the response is built, and emits NONE of them for a phase that is
  // not — a phase that parked earlier in the run and has since resumed reads with no
  // park members even though its columns still hold the record. Presence of
  // `parkReason` is therefore the park's wire discriminator, which is what lets one
  // workflow.runRead render a parked phase without a timeline replay
  // (Spec-017 §Park surfacing on the read model). This is deliberately a stronger
  // guarantee than the columns give: the coarse five-value `state` union above
  // carries no `suspended` arm, so without the liveness rule a reader could not
  // separate a phase still waiting on a human form from one that already resumed
  // past that wait. The union is NOT widened — it stays in lockstep with
  // Spec-017 §Phase-Type and Gate-Type Taxonomy's five phase-run statuses.
  //
  // Present whenever the phase is parked; the closed two-value union of
  // Spec-017 §Park integrity and cancellability (SA-42), in DDL order.
  parkReason?: "waiting-human" | "provider-usage-limited";
  // The bounded engine-authored cause. Present whenever `parkReason` is — SA-42
  // requires a parked phase to always carry one — 8 KiB, truncated on a UTF-8
  // boundary, never reaching a phase output, artifact, or agent-visible context
  // (I-017-21).
  parkCause?: string;
  // RFC 3339 UTC. Present only where the park armed a durable schedule — an SA-40
  // usage-limit park whose provider reported a reset boundary. Its absence narrows
  // the park (unscheduled, operator-resumable) rather than denying it.
  autoResumeAt?: string;
  // The provider-account attention key the SA-40 fold groups concurrently parked
  // phases by. Same presence rule as `autoResumeAt`: armed by the park, cleared on
  // exit, and confined by the phase-row CHECK to the suspended state.
  parkAttentionKey?: string;
}

// WorkflowRunRead — workflow.runRead. Run header plus the per-phase state projection;
// the projection rebuilds from session_events (Spec-017 §State And Data Implications),
// so a read never consults request state.
interface WorkflowRunReadRequest {
  workflowRunId: WorkflowRunId;
}
interface WorkflowRunReadResponse {
  workflowRunId: WorkflowRunId;
  sessionId: SessionId;
  workflowVersionId: string;
  // Lockstep with the `workflow_runs.status` CHECK per I-017-12 — all six values, in
  // DDL order. A `gated` run is `suspended` on the wire as on disk.
  state: "pending" | "running" | "suspended" | "completed" | "failed" | "cancelled";
  // The park surface rides here and nowhere else: a `suspended` run's parked phases
  // carry the four live park members of PhaseState above, so one workflow.runRead is
  // sufficient to render why the run is parked, per branch, with no timeline replay
  // (Spec-017 §Park surfacing on the read model). SA-32 branches park independently
  // against different provider accounts, which is why the members are per-phase and
  // this response grows none of its own.
  phaseStates: PhaseState[];
  failureReason?: string; // preserved on any bound breach (SA-1, SA-2); also carries
  // the cancellation reason when `state` is `cancelled`, mirroring the
  // `workflow_runs.failure_reason` / `failure_detail` split
  startedAt: string;
  endedAt?: string;
}

// WorkflowRunCancel — workflow.runCancel. NEW at the 2026-08-18 park-surface +
// operator-controls amendment (BL-151, now archived). Until it landed, the `cancelled` run status
// had no named producer from the day it was declared, and Plan-017 T5.11's engine
// cancellability rule had no reachable caller. This operation and the
// workflow.cancelled event type mint TOGETHER — a cancellation that moved run status
// without appending its canonical event would break the SA-25 rebuild, because a
// replay would restore the last suspension payload's schedule and attention key and
// resurrect a run the operator cancelled (I-017-25).
interface WorkflowRunCancelRequest {
  workflowRunId: WorkflowRunId;
  // Operator-supplied cause, recorded on the run and carried in the
  // workflow.cancelled payload. Bounded exactly as `parkCause` is — 8 KiB, truncated
  // on a UTF-8 boundary — and never reaching a phase output, artifact, or
  // agent-visible context.
  reason?: string;
}
interface WorkflowRunCancelResponse {
  workflowRunId: WorkflowRunId;
  // A literal rather than the six-value run union: a successful cancel has exactly
  // one outcome, and narrowing here keeps callers from switching on states this
  // operation cannot produce.
  state: "cancelled";
  // The `session_events.id` of the workflow.cancelled event this call appended, in
  // the same unit of work as the status write (I-017-25). Returned so a caller can
  // correlate without a timeline read.
  cancelledEventId: string;
  // True when the run was ALREADY `cancelled` and this call was an idempotent
  // replay: no second status write, no second event, and `cancelledEventId` names
  // the original. Deliberately NOT how a terminal-outcome run answers — a cancel
  // against `completed` or `failed` refuses `workflow.run_not_cancellable`, because
  // reporting success for a run that ran to completion would misinform the operator
  // about what their action did.
  alreadyCancelled: boolean;
}

// WorkflowRunResume — workflow.runResume. NEW at the same amendment. Resumes a parked
// run and carries the OPTIONAL explicit re-pin of
// Spec-017 §Frozen-definition repair (SA-41). The re-pin is a member of this request
// rather than a thirteenth method by design: SA-41 defines the repair only as an
// action ON a resume, so a separate method would admit the re-pin-without-resume
// shape that spec refuses.
interface WorkflowRunResumeRequest {
  workflowRunId: WorkflowRunId;
  // Omit for an ordinary resume, which continues on the frozen pinned version.
  // Supplying it requests the SA-41 repair EXPLICITLY — no timer, no armed schedule,
  // and no ordinary resume ever re-pins.
  versionRepin?: {
    // The version the caller intends to join. REQUIRED within this member: a repair
    // that resolved "latest" server-side would race the definition's own edits and
    // leave the audited from/to pair unverifiable against what the operator saw.
    targetWorkflowVersionId: string;
  };
}
interface WorkflowRunResumeResponse {
  workflowRunId: WorkflowRunId;
  // `running` in the ordinary case. `suspended` where the engine immediately
  // re-parked — an SA-40 usage-limit park whose account is still spent re-parks on
  // the next dispatch. That is a legal outcome rather than a refusal, and the
  // re-park emits its own workflow.phase_suspended, which is how the operator sees
  // what happened. Resuming ahead of an armed `autoResumeAt` is therefore permitted
  // and needs no override flag: the machine's own schedule was advisory pacing, and
  // the worst case is one observable re-park.
  state: "running" | "suspended";
  // Present only on an ACCEPTED re-pin: the version the run left and the one it
  // joined — the same pair the audited additive-optional workflow.resumed payload
  // member carries, so the projected run row stays a function of the log.
  repinnedFromWorkflowVersionId?: string;
  repinnedToWorkflowVersionId?: string;
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
    // `artifact_ref` outputs point at a Plan-014 manifest; Plan-017 stores the
    // reference, never the bytes, and adds no second upload path. `valueKind` is
    // additive-OPTIONAL per ADR-018 — `PhaseOutputReadResponse` is an already-
    // published shape, so the Tier-8 audit could widen it but not add a required
    // field. Always emitted at this contract revision; absent from older daemons,
    // where the reader falls back to `artifactId`: set means `artifact_ref`, unset
    // means `inline`.
    valueKind?: "inline" | "artifact_ref";
    artifactId?: ArtifactId;
    summary: string;
    producedAt: string;
  }>;
}

// WorkflowGateResolve — workflow.gateResolve
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
  // The SA-26 dual anchor. Both fields are additive-OPTIONAL per ADR-018 —
  // `WorkflowGateResolveResponse` is an already-published shape, so the Tier-8 audit
  // could widen it but not add required fields. A daemon at this contract revision
  // always emits the two together; both are absent from older daemons, never one.
  // The DURABLE pairing is unconditional either way: every appended
  // workflow_gate_resolutions row is paired with a session_events row carrying the
  // same two values, written in one Plan-015 writer-worker unit of work, so a
  // partial pair is unreachable and the anchor stays readable through
  // workflow.gateChainVerify even where this response omits it. Payload additions
  // here are additive MINOR under ADR-018.
  gateResolutionId?: string;
  rowHash?: string; // BLAKE3(prev_hash || JCS-canonical(row_body))
}

// HumanPhaseFormDraftSave — workflow.humanFormDraftSave.
// V1.x-RESERVED: declared so the enablement is additive, with no V1 daemon handler.
// human_phase_form_state ships empty at V1 (Spec-017 §Ship-empty tables (SA-28)) and
// clients persist drafts in localStorage / IndexedDB. The table and this operation
// light up together in V1.x.
interface HumanPhaseFormDraftSaveRequest {
  workflowRunId: WorkflowRunId;
  phaseId: WorkflowPhaseId;
  formState: Record<string, unknown>;
  expectedRevision?: number;
}
interface HumanPhaseFormDraftSaveResponse {
  revision: number;
  savedAt: string;
}

// HumanPhaseFormSubmit — workflow.humanFormSubmit. Optimistic concurrency: a submit
// carrying a stale `expectedRevision` is refused, never silently overwritten. The
// current revision is read from the run-read projection (PhaseState.formRevision,
// also carried by WorkflowRunStartResponse.phaseStates): a fresh attempt reads 0,
// so a first submit carries expectedRevision: 0, and after an accepted submission
// any further submit against the same attempt is stale. An abandoned claim writes
// nothing, so the revision stays 0 and the next claimant's first submit succeeds
// (Spec-017 §Fallback Behavior re-claim). This is the V1 token: the V1.x draft-save
// above carries its own draft counter (its store initializes at 1), and that
// counter's integration with `expectedRevision` is defined when the operation gains
// a handler (SA-28), not here.
interface HumanPhaseFormSubmitRequest {
  workflowRunId: WorkflowRunId;
  phaseId: WorkflowPhaseId;
  fields: Record<string, unknown>;
  // Uploads are validated by the Plan-014 OWASP pipeline before this call resolves;
  // each accepted file becomes an `artifact_ref` phase output (C-16).
  attachmentArtifactIds?: ArtifactId[];
  expectedRevision: number;
}
interface HumanPhaseFormSubmitResponse {
  phaseId: WorkflowPhaseId;
  phaseRunId: string;
  outputCount: number;
  submittedAt: string;
}

// WorkflowGateChainVerify — workflow.gateChainVerify. Operator-triggered, not in the
// hot path: recomputes each row's BLAKE3 chain link in `sequence` order and
// cross-checks the paired session_events anchor. Reports the FIRST divergent
// sequence rather than a bare pass/fail.
interface WorkflowGateChainVerifyRequest {
  workflowRunId: WorkflowRunId;
}
interface WorkflowGateChainVerifyResponse {
  workflowRunId: WorkflowRunId;
  verified: boolean;
  rowsChecked: number;
  // Present only when `verified` is false.
  firstDivergentSequence?: number;
  divergence?: "row_hash_mismatch" | "sequence_gap" | "missing_event_anchor" | "signature_invalid";
}
```

**Method-string registry — Plan-017** (daemon JSON-RPC; new `workflow` root, root plus camelCase tail per the Plan-016 convention above). Added by the Tier-8 audit: the plan named ten operations in PascalCase with no wire mapping, and no `workflow` root was registered anywhere. **Thirteen rows follow** (re-derived 2026-08-18, not carried forward: eleven at the Tier-8 audit — the audit itself mints `workflow.definitionList`, without which the surface has no enumeration at all — plus the two operator-recovery operations of the park-surface + operator-controls amendment, `workflow.runCancel` and `workflow.runResume`).

| Method | Procedure type | Request → Response | Notes |
| --- | --- | --- | --- |
| `workflow.definitionCreate` | RPC | `WorkflowDefinitionCreateRequest` → `WorkflowDefinitionCreateResponse` | Content-hashes and persists version 1; cycle-check rejects an invalid DAG at author time; a `shared`-target create clears the daemon's operator-scope authorization first (Spec-017 §Core SDK and persistence contracts) |
| `workflow.definitionRead` | RPC | `WorkflowDefinitionReadRequest` → `WorkflowDefinitionReadResponse` | Latest version unless `version` is supplied |
| `workflow.definitionList` | RPC | `WorkflowDefinitionListRequest` → `WorkflowDefinitionListResponse` | **NEW at the Tier-8 audit** — the ten pre-audit operations had no enumeration, so a caller could only read a definition whose id it already held; scope-resolved most-specific-first |
| `workflow.versionRead` | RPC | `WorkflowVersionReadRequest` → `WorkflowVersionReadResponse` | Immutable version body; a running instance stays pinned to its own |
| `workflow.runStart` | RPC | `WorkflowRunStartRequest` → `WorkflowRunStartResponse` | Binds a run to a pinned version; emits `workflow.started`; adjudicates the SA-39 named action per start and refuses `workflow.start_denied` (ADR-027) |
| `workflow.runRead` | RPC | `WorkflowRunReadRequest` → `WorkflowRunReadResponse` | Projection read; rebuildable from `session_events`. Carries the four live park members on each parked `PhaseState`, so a parked run renders from this one call (Spec-017 §Park surfacing on the read model) |
| `workflow.runCancel` | RPC | `WorkflowRunCancelRequest` → `WorkflowRunCancelResponse` | **NEW 2026-08-18 (BL-151)** — the named producer of the `cancelled` run status, which had none since it was declared; emits `workflow.cancelled` in the same unit of work as the status write (I-017-25); adjudicates `Action::"workflow::cancel"` and refuses `workflow.control_denied`, or `workflow.run_not_cancellable` against a `completed` / `failed` run (an already-`cancelled` run replays idempotently) |
| `workflow.runResume` | RPC | `WorkflowRunResumeRequest` → `WorkflowRunResumeResponse` | **NEW 2026-08-18 (BL-151)** — operator resumption of a parked run, carrying the optional explicit SA-41 re-pin as a request member rather than a method of its own; emits `workflow.resumed` (with the audited re-pin member on an accepted repair); adjudicates `Action::"workflow::resume"` and refuses `workflow.control_denied`, `workflow.resume_not_parked`, or one of the three existing `workflow.repair_*` codes on the re-pin leg |
| `workflow.phaseOutputRead` | RPC | `PhaseOutputReadRequest` → `PhaseOutputReadResponse` | Outputs stay addressable after completion; a retry adds rows, never mutates (SA-16) |
| `workflow.gateResolve` | RPC | `WorkflowGateResolveRequest` → `WorkflowGateResolveResponse` | Appends one chain row plus its `session_events` anchor; emits `workflow.gate_resolved` |
| `workflow.humanFormDraftSave` | RPC | `HumanPhaseFormDraftSaveRequest` → `HumanPhaseFormDraftSaveResponse` | **V1.x-reserved** — declared, no V1 handler (SA-28) |
| `workflow.humanFormSubmit` | RPC | `HumanPhaseFormSubmitRequest` → `HumanPhaseFormSubmitResponse` | Optimistic-concurrency submit; writes `phase_outputs` |
| `workflow.gateChainVerify` | RPC | `WorkflowGateChainVerifyRequest` → `WorkflowGateChainVerifyResponse` | Backs the `sidekicks workflow verify-gate-chain <run_id>` CLI subcommand |

The canonical file form of a definition (`Spec-017 §Definition file form — export and import (C-17)`) is a serialization of these same shapes — the YAML the authoring commitment names, carrying the schema-version marker, whose canonical bytes are the JCS-canonicalized JSON of the parsed document. It is not a second dialect and has no contract types of its own. `layout` is an optional top-level section of that document, outside the hashed body, that no request or response above carries: canvas geometry is client-local at V1 (`Spec-017 §Canvas layout is not definition bytes (SA-35)`). Export is a client-side serialization of `workflow.versionRead`; import is a submission through `workflow.definitionCreate` — which is why the visual-builder amendment mints no operation.

The 2026-08-11 chat-start amendment likewise adds **no** method: the chat surfaces are client-surface sugar over `workflow.runStart` (ADR-027), and `workflow_start` below is a callback tool, not a JSON-RPC method — that amendment left the registry at the eleven rows it then held (the table above stands at thirteen since the 2026-08-18 park-surface + operator-controls amendment added the two operator-recovery operations).

```typescript
// workflow_start — the corpus's first concrete SessionCallbackTool (2026-08-11 chat-start
// amendment, ADR-027; Spec-017 SA-38/SA-39; Plan-017 T5.9 / CP-017-7). Registered into the
// Plan-005 callback-tool host registry at session spawn; every invocation routes through
// the CP-005-7 Cedar seam and lands as tool_activity. Born-withheld: while the
// approval.requestCreate seam is unregistered the registry is withheld at spawn and a
// stray invocation answers `denied` — never `completed` without Cedar. The originating
// channel is never a tool argument (the schema below carries no channel field and refuses
// a smuggled one): the daemon derives it from the invoking turn's channel context, absent
// when the turn is not channel-scoped, and runs the SA-38 membership validation on the
// derived value. The handler resolves the definition most-specific-first
// (session → project → shared) and issues the same start path as workflow.runStart; a
// Cedar denial answers `denied` carrying workflow.start_denied. NOT a JSON-RPC method:
// the chat-start amendment added no registry row, leaving the registry at the eleven
// it then held (thirteen since the 2026-08-18 operator-recovery operations).
const workflowStartCallbackTool: SessionCallbackTool = {
  name: "workflow_start",
  description:
    "Start a workflow run in this session by definition name. Resolution is most-specific-first across the session, project, and shared scopes.",
  inputSchema: {
    type: "object",
    properties: {
      definitionName: { type: "string" },
      scope: { enum: ["session", "project", "shared"] }, // optional — pins one tier instead of walking
    },
    required: ["definitionName"],
    additionalProperties: false,
  },
};
```

Error vocabulary: [error-contracts.md](./error-contracts.md) §Workflow. That section defines ten codes (`workflow.not_found`, `workflow.invalid_phase`, `workflow.gate_closed`, `workflow.start_denied`, the three SA-41 repair refusals `workflow.repair_not_parked` / `workflow.repair_attempt_in_flight` / `workflow.repair_version_unaccountable`, and the three operator-recovery refusals `workflow.control_denied` / `workflow.run_not_cancellable` / `workflow.resume_not_parked` — the seven landed entries of the owed extension: `workflow.start_denied` by the chat-start amendment, the repair codes at the workflow-hardening amendment's 2026-08-17 review round, and the recovery codes at the 2026-08-18 park-surface + operator-controls amendment) against a surface with at least twenty-two refusal points — chain-break detection, resource-pool admission refusal, `fail-fast` sibling abort, `max_phase_transitions` / `max_duration` / `max_concurrent_phases` breach, human-form optimistic-concurrency conflict, definition content-hash mismatch, expression-parse refusal, and — added by the visual-builder amendment, which mints no code of its own and opens no parallel surface — invalid graph shape (any of the seven refused shapes), scope-ref violation, a tool binding carrying an inline governance facet, and an unknown top-level key in an imported definition file, and — added with the graph-topology closure and the `shared`-scope authorization boundary of `Spec-017 §Core SDK and persistence contracts` — an inconsistent topology spelling (a partially-supplied predecessor set, or a join policy on a phase that is not a join) and the operator-authorization refusal on a `shared`-target `workflow.definitionCreate`, and — added by the 2026-08-11 chat-start amendment — the start refusal `workflow.start_denied` already covers, and — added by the 2026-08-16 workflow-hardening amendment, whose park, pacing, and cancellability rules mint no code of their own — the three refusals of the `Spec-017 §Frozen-definition repair (SA-41)` path, each now carrying its registered `workflow.repair_*` code above: a re-pin against a run that is not parked, one requested while any of the run's attempts is still in flight (the resuming phase continuing one rather than entering fresh, or a parked parallel sibling holding one — SA-41's run-wide boundary), and one whose target version cannot account for the phases the run already completed — the omitted phase id and the unreachable topology counting as one refusal point, since SA-41 states they are the same failure — and, added by the 2026-08-18 park-surface + operator-controls amendment, the three the operator-recovery operations contribute, each minting its code in the same diff so no unregistered refusal ever ships: an authorization denial on either operation (one point with two ordered arms, one code, the `workflow.start_denied` shape), a cancel against a run that already reached `completed` or `failed`, and a resume against a run that is not parked. The re-pin leg of `workflow.runResume` adds **no** point — its three refusals are the SA-41 points already counted above. **Census arithmetic (re-derived 2026-08-18, not carried forward):** nineteen at the workflow-hardening amendment's 2026-08-17 review round, plus the three operator-recovery points = twenty-two. The Tier-8 audit surfaced the gap; seven of the twenty-two points now carry registered codes, the extension covering the remaining fifteen is still owed on that document — unmoved, because every point added since has landed with its code — and until it lands no workflow handler may mint an unregistered code (`Spec-017 §Loud-errors discipline (C-12)` forbids untyped refusals). Durable events owned by Plan-017: the 24 `workflow.*` types across five categories enumerated in [Spec-017 §Workflow Timeline Integration](../../specs/017-workflow-authoring-and-execution.md#workflow-timeline-integration) — 23 through the workflow-hardening amendment, plus `workflow.cancelled`, minted 2026-08-18 together with the operation that produces it — their registration in the Plan-006 registry is an open upstream-tier amendment, so no `workflow` category exists in [Spec-006](../../specs/006-session-event-taxonomy-and-audit-log.md) yet.

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

Registered 2026-07-22 (campaign B18; [Spec-028](../../specs/028-mcp-server-configuration-and-governance.md)). The eleven `mcp.*` operations register against the Plan-007 `MethodRegistry` at Plan-028's tier (the CP-007-3 late-namespace pattern; `mcp.subscribe` rides the Plan-007 streaming primitive, the `session.subscribe` consumer shape); the five event payloads mirror [Spec-006 §MCP Governance (`mcp_governance`)](../../specs/006-session-event-taxonomy-and-audit-log.md#mcp-governance-mcp_governance) (registered into contracts by Plan-006 T1.10; payloads authored by Plan-028 — the emitter-authors-payload precedent); the status read model consumes the Plan-005 `McpServerStatusUpdate` seam (§Tier 4 above). Authorization: every mutating operation evaluates the Cedar `mcp` action family through Plan-012's `PermissionCheckService` before any provider call or store write; the V1 principal is the node-local operator (caller-owns-the-node) — no `ApprovalCategory` value is added. Idempotency: every governance mutation — and the receipted operational command `mcp.oauthLogin` — carries the mandatory requester-generated UUID `clientIdempotencyKey` (the Spec-005/B3 discipline; the intervention-surface precedent) with durable receipt replay per Spec-028 §Authorization (`mcp.reconnect` is unreceipted). Error codes: [error-contracts.md §MCP Governance](./error-contracts.md#mcp-governance). Sanitization: no payload below carries config values, env-var values, header values, tokens, or unsanitized paths (Spec-028's no-custody invariant) — raw `scopeRef` filesystem paths included: durable event payloads identify project/local bindings by the keyed `scopeRefDigest` of the audit ref (`McpServerBindingAuditRef` below), never the path itself; `serverName` / `toolName` are untrusted provider-adjacent strings, `wireFreeFormString`-bounded under the seventeen-string rule, classified as non-PII infrastructure identifiers for the plaintext audit payload per Spec-028 §Status Observation and Events — the deliberate, documented residual Plan-022's call-site PII classification pass inherits. Identity throughout is the scope-qualified binding `(provider, scope, scopeRef, serverName)` per Spec-028 §Unified Inventory — a **discriminated union on `scope`**, so an invalid shape (`scopeRef` on `user`, a missing `scopeRef` on `project`/`local`, or the non-existent `(codex, local)` combination) is a schema-level rejection, never a service-layer surprise or a collapsed primary key. Two grains share this section deliberately: the config **binding** above and the Plan-005 **runtime-binding leg** (`sessionId` + `bindingId`) — live per-session state (status legs, live mutation results, reconnect targets) always keys by leg, never by collapsing legs into the binding scalar.

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

// Effective-binding derivation output (Plan-028 T28.4.11; registered 2026-08-26 at the NS-86
// effective-binding discharge). NOT a carrier threaded in from another plan — Plan-028 derives this
// in-plan from the post-drift composed-config snapshot it already builds at T28.4.6, which is what
// discharged its §Preconditions carrier box. `null` is a first-class answer meaning the tool
// resolved from NO governed binding: a provider built-in, or a tool served by the daemon's own
// ephemeral callback-tool host (Spec-005 §Required Behavior), which sits outside Spec-028 governance
// entirely (Spec-028 §Non-Goals) and is never trusted, drift-evaluated, or override-governed.
// NEVER derived by parsing the delivered wire tool name: provider-side `mcp__<server>__<tool>`
// prefixing and collision-suffixing are provider defaults rather than wire invariants, so the
// mapping runs off the daemon's own registration identity.
type McpEffectiveBinding = McpServerBindingRef | null;

// Binding-identity digest, stamped onto `command_receipts.mcp_binding_digest` at receipt write so
// crash recovery never re-resolves an override it has no session to resolve against (Plan-028
// I-028-6; the column, its partial index, and the receipt-write argument are owned by Plan-028
// T28.4.12). Because the digest is KEYED, key availability is part of the guarantee: a revocation
// matches receipts by RECOMPUTING this value, so if the binding-identity subkey is unavailable the
// daemon cannot tell which stamped rows a revocation covers, and I-028-6 then requires neutralizing
// every non-terminal digest-bearing receipt to the manual_reconcile_only floor and refusing to stamp
// new digests — unmatchable is treated as revoked, never as untouched.
// "b3:"-prefixed keyed BLAKE3 — key = the binding-identity subkey of the daemon-held
// node-local MCP governance master key, the same derivation family as configHash and scopeRefDigest
// — over the RFC 8785 JCS canonicalization of the full McpServerBindingRef tuple: the scopeRefDigest
// discipline widened from the scopeRef alone to the whole tuple, so no raw filesystem path reaches a
// durable row and the digest is not brute-forceable from a database copy. DELIBERATELY EXCLUDES the
// config hash — a binding's config drifts while its identity does not, and a drift-triggered
// revocation must still match receipts stamped before that drift. Stable for the binding's life;
// written from the same Plan-028 resolution output that supplies idempotencyClass, so the receipt
// write gains no new seam.
type McpBindingIdentityDigest = string; // `b3:${string}`

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

## Plan-029 — Provider Accounts And Credential Homes

Wire surfaces for [Spec-029](../../specs/029-provider-accounts-and-credential-homes.md). The `providerAccount.*` namespace is node-local operator administration: every mutating verb is gated on node-operator authority, and a relayed mutation is refused rather than applied (I-029-1).

The namespace has exactly ten verbs, each carrying the payload pair named below: the two read verbs `providerAccount.list` and `providerAccount.subscribe`, and the eight mutating verbs `providerAccount.register`, `providerAccount.update`, `providerAccount.remove`, `providerAccount.setDefault`, `providerAccount.probe`, `providerAccount.resetCredentialHome`, `providerAccount.login`, and `providerAccount.loginCancel` (the last three moving the census seven → ten and six → eight at the 2026-08-26 sign-in amendment, §6 node NS-83). `providerAccount.subscribe` is grouped with the reads: it mutates nothing and takes the same node-operator gate its sibling read does, for the same disclosure reason. `providerAccount.probe` is grouped with the mutating verbs for two reasons, and the weaker one is the row write: it writes back the observed health state and its observation timestamp to the probed account's row, and — **atomically with that write** — applies I-029-2's generation rule, which names "a transition of the account's probe result into or out of `authenticated`" as a lifecycle transition. So a probe that observes the same authenticated-ness as the stored row leaves `credentialGeneration` untouched, while one that observes a **crossing** of the authenticated boundary bumps it in the same transaction as the health write. Both directions bump: a repaired credential must end the old attention epoch (`Spec-017 §Provider-limit pacing and durable resumption (SA-40)` keys on `(accountId, credentialGeneration)`, so parked work resumes against a generation that is genuinely new), and a destroyed one must not leave consumers holding a generation that still reads as usable. The verb mints and removes no account. The load-bearing reason for the gate is that it reaches into a credential home and drives provider-side credential I/O. That is operator-authority work, so it takes the node-operator gate rather than the laxer read gate.

**The probe verb is not the only writer of the stored pair.** Every validation that actually observes an account's authentication state writes it back under the same rule — the deliberate probe above, the fail-closed validation the spawn path performs (Spec-029 §Validation at spawn — fail-closed), and, from the 2026-08-26 amendment, the **background health observer** (Spec-029 §Credential-home health observation), which is the third writer and joins the set rather than replacing it. **The generation-bump authority is deliberately NOT widened with it.** `credentialGeneration` still bumps only on I-029-2's credential-home lifecycle transitions, and a background observation is not one: `Spec-017 §Provider-limit pacing and durable resumption (SA-40)` keys parked work on `(accountId, credentialGeneration)`, so an observer that bumped on a transient fault would end a parked-work attention epoch for nothing — the precise harm the both-directions bump rule above exists to produce **only** when the boundary is genuinely crossed by an act that changed the home. The observer is also constrained in what it may do to take its reading: it never requests a refresh, never calls a provider path documented to refresh proactively, and never reaches a first-party authentication endpoint, because both pinned providers rotate refresh tokens single-use and a poll that refreshes burns a rotation every tick. Anything else would make the stored reading a record of _explicit probes_ rather than of _the last validation_, which is what the readiness derivation reads and what `observedAt` claims: a node whose first run succeeded would otherwise keep serving `indeterminate` indefinitely while every run started fine. Spawn validation is a read-path caller in every other respect — it takes no operator gate and mints nothing — but its observation is an observation, and the row records observations.

**The identifier is opaque everywhere.** `ProviderAccountId` is daemon-minted and immutable. No client, driver, or renderer parses it, decomposes it, or uses it to locate credential material — it selects a credential environment and nothing else. It is deliberately not derived from an email, a provider subject id, or any credential value, because those rotate and an identity that rotates cannot key historical spend.

```ts
type ProviderAccountId = string & { readonly __brand: "ProviderAccountId" };
type BillingMode = "subscription" | "metered" | "unknown"; // `unknown` is the honest-absence arm (Spec-029 §Billing mode) — never rendered as metered

interface ProviderAccount {
  accountId: ProviderAccountId;
  provider: "claude" | "codex";
  displayLabel: string; // operator-chosen; participant-adjacent PII (Spec-022 §PII Data Map)
  credentialGeneration: number; // monotonic; bumps at every credential-home lifecycle transition (I-029-2)
  billingMode: BillingMode;
  // Provider-REPORTED identity, present only where a health observation surfaced it, each member
  // independently optional because a provider may report any subset. Participant-adjacent PII
  // (Spec-022 §PII Data Map, `provider_accounts` row): a later observation replaces these, and they
  // are never logged, evented, or carried on an error. Never operator-typed — the operator's own
  // name for the account is `displayLabel`.
  observedAccountEmail?: string;
  observedAccountOrgId?: string;
  observedAccountOrgName?: string;
  isDefault: boolean; // exactly one per provider, enforced by a partial unique index (I-029-5)
  healthState: ProviderAccountHealthState;
  // The OTHER HALF of the stored observation pair (`provider_accounts.health_observed_at`, whose
  // table-level CHECK holds the two set and cleared together). Required-shape and nullable on the
  // reading the four members below take: `null` means no observation has ever been recorded for this
  // account. That is exactly the case a bare `healthState` cannot express — a never-observed account
  // and a probe that genuinely could not decide both project `indeterminate`, and only the timestamp
  // separates them: `null` for the first, a time for the second. It rides the ACCOUNT ROW rather than
  // only `ProviderReadiness.observedAt` because readiness is derived per PROVIDER from the resolved
  // account, so every non-default account in a list reply — and every `account_changed` notification,
  // which carries this shape — would otherwise carry a state with no age at all and no surface could
  // apply the freshness test the stored reading exists to support. Carried VERBATIM from the column,
  // never re-derived and never defaulted to `updated_at`: a registry read still spawns no provider
  // process, and a display-label edit must not read as a fresh authentication observation.
  healthObservedAt: string | null;
  // The four members below land with the 2026-08-26 sign-in amendment. Each is nullable-by-absence
  // rather than defaulted: an unobserved fact is reported as unobserved, never as a value the
  // daemon has not seen. `ProviderAccount` has not shipped, so these are required-shape additions
  // in the same reading the readiness member took, not ADR-018 additive-optional retrofits.
  observedAuthMode: ProviderAuthMode | null; // = `provider_accounts.observed_auth_mode`; null until observed
  loggedInAt: string | null; // RFC 3339 UTC of the sign-in this credential came from; null where neither a brokered sign-in nor a token registration produced it
  // ESTIMATE, and the wire says so in its name. Mode-dispatched from `loggedInAt` by the provider's
  // published issuance interval for that mode; null whenever `loggedInAt` or `observedAuthMode` is
  // null, because an estimate with no anchor is a fabrication. A renderer MUST present it as an
  // approximation ("about N days after sign-in"), never as a deadline the daemon can vouch for —
  // the interval belongs to the provider's issuance policy, which the daemon cannot verify, and at
  // least one pinned leg's horizon is server-rewritable on any refresh.
  expectedReloginAtEstimate: string | null;
  probeEnabled: boolean; // false = the operator silenced the background observer for this account; the deliberate probe verb and spawn validation still write the stored pair
}

// The authentication mode the provider's OWN status surface reports for a home — OBSERVED, never
// assumed, and never derived by the daemon from the shape of a credential file. `unknown` is the
// tolerant arm for "observed, and the provider named a mode this build does not recognize": a
// vendor adding a mode must not fail an observation closed, so the union accepts and records it as
// unknown rather than refusing the observation. `oauth_token` is the ADR-028 D2 class and is the
// mode under which a token-mode account is admitted; the token VALUE is not on this wire.
type ProviderAuthMode =
  | "oauth_subscription"
  | "oauth_token"
  | "api_key"
  | "external"
  | "none"
  | "unknown";

// NOTE (amended 2026-08-26, ADR-028 D2 — this note previously stated an absolute; the ADR is
// what authorizes replacing it, and the replacement is deliberately as mechanically checkable as
// the absolute was). Credential material appears on EXACTLY ONE input on this wire surface and on
// NO output: `ProviderAccountRegisterRequest.nonInteractiveToken` below. It is write-only — it is
// on no reply, no event, no error, no notification, no metric, and no log line, and no reply type
// in this section carries a token-shaped member of any name. The census claim a reviewer can
// check: one credential-accepting input, named above, and zero credential-bearing outputs.
// `ProviderAccount` itself still carries none — tokens for interactively-authenticated accounts
// live in the per-account credential home written by the provider's own tooling, the daemon
// brokers refresh without holding values, and the ADR-028 D2 token is sealed through the ADR-021
// ladder in daemon-owned state rather than in any column or on any payload here.
type ProviderAccountHealthState =
  | "authenticated"
  | "reauth_required"
  | "home_missing"
  | "indeterminate"; // probe could not decide — treated as NOT authenticated (fail-closed, I-029-3)

// NOTE: no credential-home path appears on `ProviderAccount`. The one wire member that carries a
// home is `ProviderSignInRemedy.credentialHomePath` below — the sign-in arm alone, the two
// registry-shape arms having no resolved home to name — on the node-local, node-operator-
// authorized readiness reply, and it is operator-facing message text that travels structured. The
// prohibition it lives under is unchanged and is about the READER, not the encoding: the home
// reaches an operator's screen and never an event payload, a relayed payload, or a log line
// (Spec-029 §Node provider readiness and the sign-in handoff, on the `mcp.config_scope_unsupported`
// disclosure discipline). On every surface a session participant can reach — the whole relayed
// plane included — `credential_home_path` names a column and nothing else.

// Readiness is the pre-computed answer to the question run admission will ask, derived by the SAME
// resolution the daemon performs at spawn (Spec-029 §Validation at spawn — fail-closed) and served
// from the account row's STORED last-probe result — a list call spawns no provider process, so a
// surface may poll it; `providerAccount.probe` is the deliberate refresh. It AUTHORIZES NOTHING:
// admission re-validates unconditionally and refuses on its own reading. Enumerated in full rather
// than aliased off `ProviderAccountHealthState` so a later health arm cannot silently widen this
// client-facing union: it widens ONLY in lockstep with that union, and a new health arm requires an
// explicit readiness arm added here.
type ProviderReadinessState =
  // The first four arms are the resolved account's STORED health state, verbatim. That stored
  // value is the outcome of the last validation — probe reading plus home observation taken at the
  // same moment — so `home_missing` is a recorded observation, never a live stat() at read time.
  | "authenticated" // last validation said so — necessary, NOT sufficient (see I-029-9)
  | "reauth_required" // home was present but held no usable credential
  | "home_missing" // credential home was absent or unreadable when last observed
  | "indeterminate" // probe could not decide, or none taken yet — NOT authenticated, NOT a failure
  | "no_account" // nothing registered for this provider; mirrors `provideraccount.not_registered`
  | "no_default"; // accounts exist, none is default; mirrors `provideraccount.no_default`

interface ProviderReadiness {
  provider: "claude" | "codex";
  state: ProviderReadinessState;
  resolvedAccountId?: ProviderAccountId; // present iff resolution reached exactly one account
  // RFC 3339 UTC of the STORED observation this entry's state was read from. Absent in exactly two
  // cases, both about THIS resolution rather than about the node's probe history: resolution reached
  // no account (`no_account`, `no_default`), so there is no row to have observed — on `no_default`
  // the candidates may well have been probed, and their timestamps are deliberately not summarized
  // into one here, since averaging or picking among them would report an observation of an account
  // this reply did not resolve — or resolution reached an account whose observation pair is still
  // unset. Absence therefore never means "no probe has ever been taken on this node".
  observedAt?: string;
  // Schema-optional, PRODUCER-OBLIGATED on the `resendDisposition` precedent (Spec-004 §Required
  // Behavior): the daemon populates it on every non-authenticated arm and omits it on
  // `authenticated`. Optional at parse because the state alone does not make requiredness
  // expressible to a strict parser without splitting this interface per arm; the obligation is the
  // producer's and is tested per arm. It exists because the spec REQUIRES every non-authenticated
  // surface to display the next action, and no client can compose one — only the daemon knows which
  // account resolution reached and which home it holds. Composed at read time, never stored, so it
  // cannot go stale against the row it describes.
  remedy?: ProviderRemedy;
}

// Operator-facing guidance that happens to travel structured. The disclosure rule (Spec-029 §Node
// provider readiness and the sign-in handoff) governs it UNCHANGED and binds the READER: these
// values reach an operator's screen and NEVER an event payload, a relayed payload, a log line, or a
// refusal envelope. `providerAccount.list` is node-local and takes the SAME node-operator gate as
// the mutating verbs — not the laxer read gate a list verb would otherwise get — and that gate is
// the only reason a daemon-owned path may cross this reply at all (Spec-029 §Authorization Posture;
// enforced and tested by Plan-029 T2.5, the task that makes the reply disclose one). This shape
// must not be reused on any surface reachable by a session participant.
//
// A UNION rather than one shape, because the remedy is "the operator's next action" and the three
// non-authenticated classes have three different next actions with three different producible
// field sets. A single sign-in shape was unproducible on two of them: `no_account` has no
// credential home to name at all, and `no_default` deliberately resolved to none of several homes,
// so composing either reply would have required inventing a path or arbitrarily picking an account
// — precisely the arbitrary selection I-029-5's single-default rule exists to prevent. The
// discriminant is `kind`, and it is NOT redundant with `state`: `reauth_required`, `home_missing`,
// and `indeterminate` all map to `sign_in`, so the mapping is many-to-one and a client renders off
// `kind` without re-deriving it.
type ProviderRemedy = ProviderRegisterRemedy | ProviderChooseDefaultRemedy | ProviderSignInRemedy;

// `state: "no_account"` — nothing is registered, so there is nothing to sign into yet.
interface ProviderRegisterRemedy {
  kind: "register";
  provider: "claude" | "codex";
}

// `state: "no_default"` — accounts exist and none is default. Resolution reached no account BY
// DESIGN, so the daemon names the candidates and refuses to choose: picking one here would bind a
// run's spend to an account the operator never selected.
interface ProviderChooseDefaultRemedy {
  kind: "choose_default";
  candidateAccountIds: ProviderAccountId[]; // at least two — a one-account no-default state is
  // still `no_default`, but the daemon lists whatever exists
  // and never elects one
}

// `state: "reauth_required" | "home_missing" | "indeterminate"` — resolution reached exactly one
// account, so both the account and its home are known and the next action is the vendor's own flow.
interface ProviderSignInRemedy {
  kind: "sign_in";
  accountId: ProviderAccountId; // REQUIRED on this arm: it is the arm where an account resolved
  signInInvocation: string; // the provider's OWN first-party sign-in command, for DISPLAY — the
  // daemon never executes it, and this is not a shell string a client
  // is invited to run on the operator's behalf
  credentialHomePath: string; // the home that invocation authenticates INTO; display-only
}

interface ProviderAccountListRequest {
  provider?: "claude" | "codex";
  // Scopes the readiness derivation to ONE account instead of the provider's default. It exists for
  // a single caller: a run refused on the account plane while bound to a per-run account override
  // (Spec-029 §Node provider readiness and the sign-in handoff). Without it the post-refusal remedy
  // would necessarily describe the provider DEFAULT — a different account from the one that failed,
  // whose home and sign-in state may be entirely healthy — and the operator would be handed a
  // remedy for something that is not broken. When present, resolution is pinned to this account:
  // the two registry-shape arms cannot occur (an account was named), and the reply's single
  // readiness entry carries that account's stored reading. An unknown or removed id refuses with
  // the already-registered `provideraccount.unknown` rather than silently falling back to the
  // default, which would re-introduce exactly the wrong-account remedy this member removes.
  accountId?: ProviderAccountId;
}
interface ProviderAccountListResponse {
  accounts: ProviderAccount[];
  // The durable quota rows, delivered on the READ because the subscription is a live tail and not a
  // snapshot replay — without this a client opened after a reading, or after a daemon restart, could
  // not reach `provider_account_usage_windows` until another probe or run happened to produce an
  // update. Entries carry the provenance they were OBSERVED under, so a stored window may legitimately
  // carry `source: "run"`; provenance is a property of the reading, never of the transport that
  // delivers it, and a consumer must accept both values here rather than assuming `"probe"`.
  usageWindows: ProviderAccountUsageWindow[];
  // Required, not additive-optional: `ProviderAccountListResponse` is registered here and has not
  // shipped, so ADR-018's additive-optional rule for already-published shapes does not bind it — the
  // same reading the Tier-8 audit's new shapes carry. A reply that could omit readiness would push
  // every client back into deriving it locally, which I-029-9 exists to prevent.
  // Exactly one entry per provider the request selects: never zero, never two. With `accountId`
  // supplied the selection is that account's provider, so the reply still carries exactly one entry
  // — derived against the named account rather than the provider default.
  readiness: ProviderReadiness[];
}

interface ProviderAccountRegisterRequest {
  provider: "claude" | "codex";
  displayLabel: string;
  billingMode: BillingMode;
  makeDefault?: boolean;
  // RE-SUPPLY, not a second credential-accepting verb. Supplied, this means "replace the sealed
  // token on THIS account" and `provider` must match the stored row; omitted, this is an ordinary
  // registration and the daemon mints a new identity. It exists because the terminal
  // `reauth_required` remedy is to mint a fresh token and re-supply it, and deregister-then-register
  // would daemon-mint a NEW immutable identity — discarding the spend, quota, and attention history
  // keyed to the account the operator is trying to repair. A successful replacement bumps
  // `credentialGeneration` and re-runs the registration-time observation. The credential-accepting
  // input census is unmoved at exactly one: this adds a selector, not a second credential input.
  //
  // NEVER ADMITTED ALONE. `accountId` names a re-supply, and a re-supply with nothing to supply is
  // not a request this verb can serve: it is not a registration (an identity already exists) and not
  // a replacement (no token accompanies it), so admitting it would leave the caller's intent to be
  // guessed by a handler — and the guess a strict parser makes cheap is the wrong one, since the only
  // reading that touches nothing is a silent no-op reported as success. `accountId` present therefore
  // REQUIRES `nonInteractiveToken` present, enforced at the parse boundary and refused against the
  // absent member. The converse is deliberately unconstrained: a token with no `accountId` is the
  // ordinary token-mode registration of a new account, which is the shape this verb was written for.
  accountId?: ProviderAccountId;
  // THE ONE CREDENTIAL-ACCEPTING INPUT ON THIS WIRE (ADR-028 D2; Spec-029 §Non-interactive token
  // registration). Optional: omitted is the ordinary registration, and the account authenticates
  // through `providerAccount.login` or the operator's own out-of-band sign-in.
  //
  // WRITE-ONLY, and the rule is absolute in the direction that matters: this value is never
  // returned on this verb's response or any other, never logged, never echoed to a terminal, never
  // rendered, never placed in an error message or a diagnostic dump, and never carried in an
  // argument vector (an argv is readable by any process running as the same user). A transport
  // that logs request bodies MUST redact this member by name.
  //
  // Admitted only under ADR-028's FOUR CONJUNCTIVE conditions, and refused with
  // `provideraccount.token_class_refused` on any failure: (1) minted by the provider's own tooling
  // through a subcommand the provider documents for non-interactive use — the daemon never mints,
  // exchanges, refreshes, or derives credential material and never speaks a provider token
  // endpoint; (2) consumed through a variable the provider documents; (3) carrying no refresh
  // token, so possession mints no successors and a leak expires on the provider's own fixed
  // horizon; (4) supplied deliberately on this member, which exists for this and nothing else.
  //
  // Sealed through the ADR-021 ladder (OS keystore verified by write-probe-read-delete, then an
  // Argon2id-encrypted daemon-owned file, then a LOUD REFUSAL — never a silent plaintext write).
  // Where the ladder refuses, registration refuses with `provideraccount.credential_seal_refused`
  // rather than degrading. It is NOT written into the credential home: daemon-owned bytes in
  // provider-owned space are indistinguishable to every later reader, the provider's own tooling
  // included. It reaches the provider only as an environment variable, and only on the two
  // invocations ADR-028 D2 enumerates: the registration-time status observation, and the child
  // process of a run bound to this account. The second is gated on ADR-028 CONDITION 5 — a run
  // child executes model-directed tools, so any command the model issues can read that child's
  // environment. A provider leg with no RECORDED first-party observation that it strips the
  // variable from its tool, shell, and subagent subprocess environments does not admit the class
  // at all: `register` refuses there rather than sealing an account that would store
  // `authenticated`, report READY, and then refuse every run. Documentation asserting the strip
  // is not an observation.
  nonInteractiveToken?: string;
}
interface ProviderAccountRegisterResponse {
  account: ProviderAccount;
}

// The two operator-authored descriptive fields are correctable in place. This verb exists because
// the alternative — remove and re-register — is barred by the identity model: `accountId` is
// immutable and deliberately not re-derivable, so re-registering to fix a typo'd label or a
// mis-declared billing mode would mint a NEW identity and orphan the spend history keyed to the
// old one. A correctable typo must not cost an account its history.
interface ProviderAccountUpdateRequest {
  accountId: ProviderAccountId;
  displayLabel?: string; // omitted = unchanged
  billingMode?: BillingMode; // omitted = unchanged; this is how `unknown` is resolved to a declared mode
  // The durable per-account opt-out AC-19 requires. Carried on the existing update verb rather than
  // as a dedicated verb: it is an ordinary mutable account preference, and minting a verb for it
  // would move the namespace census for a boolean. Omitted = unchanged; the column default is
  // enabled, so silence never silences an observer.
  probeEnabled?: boolean;
}
interface ProviderAccountUpdateResponse {
  account: ProviderAccount;
}
// NOT updatable, by omission from the request and enforced on write: `accountId` (immutable
// identity), `provider` (an account does not change vendor), `credentialHomePath` (rebinding a
// registration to a different home would silently re-point historical spend at other credentials),
// and `credentialGeneration` (daemon-owned, bumped only by the lifecycle transitions in I-029-2 —
// never by an operator edit, since a descriptive correction is not a credential event).
// `isDefault` is not updatable here either: it has its own verb, whose partial-unique-index race
// semantics this verb must not duplicate.

interface ProviderAccountRemoveRequest {
  accountId: ProviderAccountId;
}
interface ProviderAccountRemoveResponse {
  accountId: ProviderAccountId;
  removed: true;
}

interface ProviderAccountSetDefaultRequest {
  accountId: ProviderAccountId;
}
interface ProviderAccountSetDefaultResponse {
  account: ProviderAccount;
}

// Rebuilds this account's credential home from empty so the operator can authenticate into it
// again — the remedy the provider-failure runbook issues when a home is absent or husked (present
// but holding no usable credential). It is a credential-home lifecycle transition under I-029-2,
// so it BUMPS `credentialGeneration`; the generation is never reset by it, which is what lets a
// stale consumer still order two readings across the rebuild. Identity survives untouched:
// `accountId` is the same afterward, so the account keeps its spend history. Its stored quota
// readings are kept for the same reason and are NOT cleared — the provider-side allowance kept
// running while the home was empty — but each carries the generation it was observed under, so a
// consumer renders a pre-rebuild reading as stale. The stored health pair is the opposite case:
// the bump invalidates it, which is why `healthState` is returned here.
interface ProviderAccountResetCredentialHomeRequest {
  accountId: ProviderAccountId;
}
interface ProviderAccountResetCredentialHomeResponse {
  accountId: ProviderAccountId;
  credentialGeneration: number; // the post-reset generation; strictly greater than the pre-reset value
  healthState: ProviderAccountHealthState; // expected `reauth_required` until the operator authenticates
}

interface ProviderAccountProbeRequest {
  accountId: ProviderAccountId;
}
interface ProviderAccountProbeResponse {
  accountId: ProviderAccountId;
  healthState: ProviderAccountHealthState;
  credentialGeneration: number; // the generation the probe observed; a later bump invalidates this reading
}

// Brokered interactive sign-in (ADR-028 D1; Spec-029 §Brokered interactive sign-in). The daemon
// constructs the invocation, spawns the provider's UNMODIFIED binary with this account's home
// pinned, and reads nothing the flow writes. What returns is what the provider emits for the
// OPERATOR to act on, plus an opaque daemon-minted attempt id. It is deliberately NOT a shell
// string: `ProviderSignInRemedy.signInInvocation` remains display-only and no client-supplied
// string is ever executed — the daemon authors this invocation itself, which is a different act
// with a different trust story, and the 2026-08-25 note that reasoned the display-only remedy is
// untouched for the surface it governs.
//
// SHAPE MIRRORS THE PROVIDER'S OWN, deliberately: the pinned Codex login-start returns either an
// authorization URL or a device code with its verification URL, and the pinned Claude flow prints
// a URL and accepts a pasted code. A provider arm emitting neither cannot be brokered and is
// refused `provideraccount.signin_unsupported` rather than spawning a flow the operator cannot
// finish. A second start against an account with one in flight is refused
// `provideraccount.signin_in_flight` — at least one pinned provider holds exactly ONE active login
// slot and SILENTLY DROPS the previous attempt, which would strand an operator mid-flow on another
// device with no signal that their code had stopped working.
interface ProviderAccountLoginRequest {
  accountId: ProviderAccountId;
}
interface ProviderAccountLoginResponse {
  attemptId: string; // opaque, daemon-minted, single-use; the correlation key for cancel and for completion
  verificationUri: string; // where the operator completes the flow — the provider's own URL, verbatim
  userCode?: string; // present on a device-code arm; the operator types it at `verificationUri`
  expiresAt?: string; // RFC 3339 UTC, where the provider bounds the attempt; null/absent = the provider published no bound. The FOURTH whitelisted field (Spec-029 §Brokered interactive sign-in), admitted under the same parse-and-validate rule as the other three: parsed to an RFC 3339 instant, required to be in the future and within the provider's documented attempt ceiling, and OMITTED rather than surfaced where it fails either test. It is a bound on an attempt, not provider state — it carries no OAuth, PKCE, or credential field.
}

// Cancellation is a FIRST-CLASS OUTCOME, not an abandonment: a broker that could only be abandoned
// would leave a provider-side login slot occupied until it timed out. `notFound` is the honest arm
// for an attempt that already completed, already cancelled, or never existed — it is NOT an error,
// because a client racing a completion should not see a refusal for having lost the race.
interface ProviderAccountLoginCancelRequest {
  attemptId: string;
}
interface ProviderAccountLoginCancelResponse {
  status: "cancelled" | "notFound";
}

// Read-shaped live tail of registry changes for this node (Plan-007 streaming primitive, the
// `session.subscribe` consumer shape). It carries a WIRE-ONLY notification and NEVER an
// `EventEnvelope`: the provider-account registry is un-evented by design (Spec-029 §State And Data
// Implications), because a node-local operator act on a node-local registry has no session to
// belong to and minting a session event type for it would put node administration into a session's
// audit timeline. So no Spec-006 event type is minted here and the taxonomy census does not move.
//
// This is where a brokered sign-in's completion arrives. Ordering matches `mcp.subscribe`'s: a
// client opens the subscription BEFORE calling `providerAccount.login`, so registration is live
// before the flow starts and a completion concurrent with the call arrives on the stream rather
// than falling between them. Re-observation is harmless — every notification is a re-entrant state
// update, not a delta.
interface ProviderAccountSubscribeRequest {}
type ProviderAccountSubscribeStream = AsyncIterable<ProviderAccountNotification>;

type ProviderAccountNotification =
  | { kind: "account_changed"; account: ProviderAccount } // registered, corrected, default moved, or a stored reading rewritten by ANY of its three writers
  | { kind: "account_removed"; accountId: ProviderAccountId }
  // Correlated on `attemptId`. `succeeded` is a report FROM THE PROVIDER that its flow finished —
  // it is NOT itself a reading that the account is authenticated. The daemon takes an ordinary
  // health observation next and publishes the result as `account_changed`; a client that treats
  // this notification as the authentication verdict will render an account as ready that a spawn
  // would refuse. `failureReason` is operator-facing message text and carries NO credential
  // material, no provider error body verbatim, and no home path.
  | {
      kind: "login_completed";
      attemptId: string;
      accountId: ProviderAccountId;
      outcome: "succeeded" | "failed" | "cancelled";
      failureReason?: string;
    }
  // The outer `accountId` is the ROUTING key and `window.accountId` is part of the reading itself.
  // Both are carried deliberately — the list reply's `usageWindows` entries carry the same member, so
  // a live update and a snapshot row key alike — and they MUST be EQUAL. A notification whose reading
  // names a different account than its routing key is not a routable update in either direction: a
  // consumer keying off the outer member files the reading under an account it does not describe, and
  // one keying off the inner member ignores the routing the daemon performed. Enforced at the parse
  // boundary rather than left to each consumer to re-check, and refused against `window.accountId`,
  // which is the half that contradicts the envelope it arrived in.
  | {
      kind: "usage_window_updated";
      accountId: ProviderAccountId;
      window: ProviderAccountUsageWindow;
    };

// The newest quota reading for one `(accountId, limitId)` pair — the wire mirror of
// `provider_account_usage_windows` (Spec-029 §Per-limit provider quota).
//
// `limitId` IS THE KEY, and `windowMins` is an attribute of the reading rather than part of its
// identity: the pinned Claude surface publishes five limit identifiers of which THREE share a
// 10080-minute window, so a `(account, windowMins)` key silently collapses them and the survivor
// depends on arrival order. A reading naming no limit takes the reserved id `default`, so a
// provider publishing one window needs no special case and the pre-amendment single-window shape
// stays valid as the degenerate case.
interface ProviderAccountUsageWindow {
  // Which account this window describes. Required, and NOT inferable from position: the read
  // returns one flat array across every registered account, and two accounts of one provider can
  // publish the same `limitId`, so without this a reconnecting client cannot associate a durable
  // window with its account and would be free to render one account's quota under another's name.
  // The live `usage_window_updated` notification already carries it; the snapshot carries the same
  // member so both paths key alike.
  accountId: ProviderAccountId;
  limitId: string; // untrusted provider-adjacent string, `wireFreeFormString`-bounded; NOT a closed union — the provider's limit vocabulary is open and versioned
  windowMins: number;
  label?: string; // the provider's own display label where it publishes one; display-only, never parsed, never a key
  usedPercent: number; // NOT clamped to 100 on the wire: a provider may report over-consumption against a soft limit and clamping would misreport it. Renderers clamp for display.
  resetsAt?: string; // RFC 3339 UTC where the provider supplies it; absent = unknown, never "now" and never "never"
  observedAt: string; // RFC 3339 UTC. THE ORDERING KEY: newest `observedAt` wins per `(accountId, limitId)`, and `source` breaks ONLY exact ties. Ordering by arrival, or by preferring one source, would let a stale reading mask real consumption.
  observedCredentialGeneration: number; // the account's `credentialGeneration` when this reading was taken — the same member `usage.rate_limit_update` carries. A credential-home rebuild does NOT clear stored readings (the provider-side allowance keeps running while the home is empty), so a renderer compares this against `ProviderAccount.credentialGeneration` and renders a behind-generation reading as STALE rather than current. The stored health pair is the opposite case: a bump invalidates it outright.
  source: "probe" | "run"; // the deliberate probe verb, or the account-scoped quota event from real traffic. The background health observer is NOT a source and no third value exists — reading quota on one pinned leg traverses a path documented to refresh proactively, which Spec-029 forbids the observer to do.
}
```

**Provider readiness.** `providerAccount.list` answers the registry question and the admissibility question in one reply, because a client that had to ask them separately would be free to combine them differently from admission. `readiness` is a **derivation**, not a stored second opinion: resolve the provider's default account, then report that account's stored health verbatim, with the two registry-shape arms standing in where resolution never reaches an account. No client re-derives it from `accounts` — a surface that recomputes readiness from account fields is the defect this member exists to remove, since the recomputed answer is the one nothing enforces. `authenticated` is a statement about the last observation and not a grant: a run bound to an `authenticated`-reading account still refuses at spawn if the home has since been signed out, and `indeterminate` is rendered as undetermined rather than as a sign-in failure.

**Run-start selection.** The per-run override rides the existing session-creation and resume parameter shapes as an additive-optional `providerAccountId` (`Spec-005 §Interfaces And Contracts`). It is an **input to resolution, never the recorded outcome**: the daemon resolves exactly one account — the override if authorized, otherwise the provider default — and stamps the result server-side as `admittedProviderAccountId` on the run's admission record. A client-supplied stamp is ignored. Resume rebinds to the account the run was admitted against rather than re-resolving the current default, so changing a default mid-session cannot silently move an in-flight run's billing.

---

## Plan-030 — Sidekick Definitions And Peer Invocation

Registered 2026-08-26 ([Spec-030](../../specs/030-sidekick-definitions-and-peer-invocation.md); [cross-plan-dependencies.md](../cross-plan-dependencies.md) §6 node NS-86). The five `sidekick.*` operations register against the Plan-007 `MethodRegistry` at Plan-030's tier — the CP-007-3 late-namespace pattern. Authorization is the two named Cedar operation actions of [Spec-012 §Implementation Notes](../../specs/012-approvals-permissions-and-trust-boundaries.md#implementation-notes): `Action::"sidekick::manage"` for every definition mutation and for turning peer invocation on, `Action::"sidekick::invoke"` for each peer-invocation call. **Each action names its own resource descriptor**, because the two planes are scoped differently: definition mutation is node-global — the four CRUD operations carry no `sessionId`, and none is invented for authorization — so `sidekick::manage` evaluates against a **node-scoped** descriptor naming this runtime node, while that same action on `sidekick.peerInvocationSet` evaluates against the **session** the request names. Two descriptors under one action rather than two actions, so Spec-012's enumeration stays at exactly the two registered here. No `ApprovalCategory` value is added — these are named-operation authorizations that do not traverse the approval pipeline — and none of them mints a `remembered_approval_rules` row: that table closes `category` over the approval-pipeline categories and requires `created_from_request_id` to reference an `approval_resolutions` row, neither of which a named-operation action produces, so a grant row here is not merely unnecessary but unrepresentable. Refusals: [error-contracts.md §Sidekick Definitions](./error-contracts.md#sidekick-definitions). **Exactly one event type is minted, and not on the definition plane**: definition mutation is node-local configuration rather than session history, and every session-visible consequence of a peer invocation is already carried by the existing tool-activity and run-lifecycle events. The mint is `session.peer_invocation_set` (taxonomy census 158 → 159), which carries the per-session opt-in because that is session state, not node configuration. Definitions never leave the node — no relay, control-plane, or export surface carries one.

```ts
// A daemon-minted opaque immutable identifier. NEVER the definition's name: the name is a mutable
// human label, and a rename must not orphan an audit row or a stored reference. Same discipline as
// ProviderAccountId (Plan-029) — identity and label are separate axes on purpose.
type SidekickDefinitionId = string & { readonly __brand: "SidekickDefinitionId" };

// A saved, node-local sidekick configuration. Configuration, not session state: not events-canonical,
// not replayed, not rebuilt from the event log. Every axis below is the SAME axis the inline attach
// surface already carries — this shape composes existing axes into a reusable named bundle and mints
// no new configuration dimension.
interface SidekickDefinition {
  definitionId: SidekickDefinitionId;
  name: string; // mutable label; unique per node under full Unicode case folding, arbitrated by the unique
  // index over the stored `name_folded` key (I-030-7); the service pre-check is a legibility affordance
  description: string; // may be empty; operator-authored
  driverName: string; // provider driver key, matching the agent surface's driver axis
  modelId: string;
  providerAccountId: ProviderAccountId | null; // null = resolve the provider's default account AT ATTACH TIME. Deliberately not a foreign key: a definition may name an account that is later removed, and that must surface as a typed resolution refusal the operator can act on, not as a delete-time cascade that silently rewrites the definition
  effort: string | null; // null = the driver's default. Validated at RESOLUTION against the target model's driver-reported `effortLevels` — never against a hardcoded list, the same rule the inline `effort?: string` axis already follows
  executionPostureMode: "trusted" | "workspace-sandboxed" | "readonly-sandboxed" | null; // null = the session default. A posture MODE only, never a composed ExecutionPosture: writableRoots and credentialPolicyRef are properties of a live run's workspace, so storing them here would freeze a path set that outlives the workspace it described
  instructions: string; // may be empty; operator-authored system-prompt content
  goal: string | null;
  toolAllowlist: string[] | null; // THREE-state and deliberately not two: null = the driver's defaults, [] = no tools at all, populated = exactly these. Collapsing null and [] would make "I did not choose" indistinguishable from "I chose nothing"
  createdAt: string; // ISO-8601
  updatedAt: string;
}

// sidekick.definitionList — node-local and unfiltered. The request carries no members, declared as an
// explicit empty interface rather than omitted, so every operation in this namespace has both halves of
// its pair and no handler signature special-cases a missing request type (the
// DiagnosticRedactionPolicyReadRequest / ProviderAccountSubscribeRequest precedent).
interface SidekickDefinitionListRequest {}
interface SidekickDefinitionListResponse {
  definitions: SidekickDefinition[];
}

// sidekick.definitionCreate — every axis except name is optional; omitted axes store as the null
// ("inherit / default") state rather than a materialized value, so a definition never silently
// pins today's default forever.
interface SidekickDefinitionCreateRequest {
  name: string;
  description?: string;
  driverName: string;
  modelId: string;
  providerAccountId?: ProviderAccountId | null;
  effort?: string | null;
  executionPostureMode?: SidekickDefinition["executionPostureMode"];
  instructions?: string;
  goal?: string | null;
  toolAllowlist?: string[] | null;
}
interface SidekickDefinitionCreateResponse {
  definition: SidekickDefinition;
}

// sidekick.definitionUpdate — a partial patch. An ABSENT key leaves the stored value alone; an
// explicit null CLEARS it back to the inherit state. That distinction is why the nullable axes are
// `field?: T | null` rather than `field?: T`: without it there is no wire way to say "stop pinning
// this", and an operator could set an account or an effort but never unset one.
interface SidekickDefinitionUpdateRequest {
  definitionId: SidekickDefinitionId;
  name?: string;
  description?: string;
  driverName?: string;
  modelId?: string;
  providerAccountId?: ProviderAccountId | null;
  effort?: string | null;
  executionPostureMode?: SidekickDefinition["executionPostureMode"];
  instructions?: string;
  goal?: string | null;
  toolAllowlist?: string[] | null;
}
interface SidekickDefinitionUpdateResponse {
  definition: SidekickDefinition; // the full post-update row, so a client never reconstructs it by merging its own patch
}

// sidekick.definitionDelete — deleting a definition NEVER touches an agent that was attached from
// it: attach copies, so there is nothing to cascade (Spec-030 §State And Data Implications).
interface SidekickDefinitionDeleteRequest {
  definitionId: SidekickDefinitionId;
}
interface SidekickDefinitionDeleteResponse {
  deleted: true;
}

// sidekick.peerInvocationSet — the per-session opt-in. It is SESSION STATE, not a remembered approval
// rule: `remembered_approval_rules` closes `category` over the approval-pipeline categories and requires
// `created_from_request_id` to reference an approval resolution, and a named-operation action produces
// neither — so a grant row for this is unrepresentable, not merely redundant. Enablement is recorded as
// `session.peer_invocation_set` in Spec-006's `session_lifecycle` category, the same shape the session goal already
// uses: session-scoped mutable configuration whose durable home is the event log, replayed rather than
// projected into a local table (the corpus has no session-config projection — session_goal_dispatch_intents
// is a crash-consistency intent row, not the goal's home). The projected flag is a Cedar CONTEXT input on
// every Action::"sidekick::invoke" evaluation, which is exactly the context = session state mapping of
// `Spec-012 §Implementation Notes`. That is why a withdrawal takes effect on the NEXT INVOCATION with no
// registry rebuild: the tools stay registered and adjudication is per call.
interface SidekickPeerInvocationSetRequest {
  sessionId: SessionId;
  enabled: boolean;
}
interface SidekickPeerInvocationSetResponse {
  enabled: boolean; // the post-set state, read back from the PROJECTED flag rather than echoed from the
  // request, so the reply reflects what the appended event actually produced
}

// ---- Peer-invocation callback tools (Plan-030 T4.1) ----
// Registered as ordinary SessionCallbackTool entries through the existing callback-tool dispatch seam
// (Spec-005 §Required Behavior) — the daemon-hosted host, which sits OUTSIDE the Spec-028 MCP
// governance model (Spec-028 §Non-Goals) and is never trusted, drift-evaluated, or override-governed.
// Both tools are registered at spawn UNCONDITIONALLY and adjudicated per invocation, exactly as
// `workflow_start` is: a session without the opt-in answers every call `denied` naming the action,
// rather than hiding the tool. Grant-gated registration was specified first and withdrawn — it made
// enablement invisible until the next spawn, because `callbackTools` rides only CreateSessionParams /
// ResumeSessionParams and no live-registry mutation seam exists, so an operator who enabled peer
// invocation mid-session would have seen nothing change until the leg respawned. Per-call adjudication
// needs no such seam. One withholding is inherited rather than invented: while Plan-012's
// approval.requestCreate seam is unregistered, Spec-005's fail-closed availability rule withholds the
// WHOLE callbackTools registry at spawn, and these two go with it.
// A definition's `toolAllowlist` filters this registry like any other tool source (I-030-10): an agent
// attached from a definition whose allowlist is `[]` receives NO peer tools, and one naming an explicit
// set receives them only if it names them — an allowlist that did not bind the daemon's own curated
// tools would report a restriction that is not in force.
// Outcomes map onto the EXISTING CallbackToolResult arms; no result arm is added.

// The target is a SIDEKICK, never a provider, model, account, or node — either a live agent in this
// session or a saved definition attached on demand. A closed discriminated union rather than a
// free-form string, so "ask claude" cannot parse as a target.
type SidekickInvocationTarget =
  | { kind: "agent"; agentId: AgentId }
  | { kind: "definition"; definitionId: SidekickDefinitionId };

// ask_sidekick — link type `spawn` (D-016-17). Waits for the peer's answer, and is therefore the one
// tool here that can outlive its own child: admission succeeding does not guarantee an answer ever comes.
// Every TERMINAL state of the child settles the waiting call — a child that fails, is cancelled, or is
// interrupted answers `failed` naming the terminal state, and a child that completes without producing an
// answer answers `failed` rather than `completed` with empty output. The child's run id does not exist
// before admission, so the waiter captures the run-lifecycle stream cursor BEFORE admitting, then
// subscribes and replays forward from that captured cursor, settling from whichever source presents the
// terminal first and deduping by `(runId, runVersion)`. Subscribing merely before the tool returns is
// insufficient — a live subscription opened after admission never replays the terminal that landed in
// between. No invocation is left unanswered (the Spec-005 dispatch-seam rule).
interface AskSidekickArguments {
  target: SidekickInvocationTarget;
  message: string;
}

// delegate_to_sidekick — link type `delegate` (D-016-17). Returns once the child run is ADMITTED,
// not once it completes, which is exactly why admission (the orchestration.depth_exceeded check
// included) is evaluated synchronously inside the creation call: a deferred check would let this
// tool answer `completed` with the identity of a run that then died at admission.
interface DelegateToSidekickArguments {
  target: SidekickInvocationTarget;
  task: string;
}

// ---- Attach-by-reference (owned by Plan-016 T3.21 in its Phase 3B supplement; CP-016-18 ⇄ CP-030-1) ----
// The members live ON the `AgentAttachRequest` union / `AgentAttachResponse` above — attach-by-reference
// splits the existing call into two arms over a shared base rather than introducing a second parameter
// object a caller could pass instead, and a standalone helper interface would have composed with nothing
// (composition here is `extends` + a union, which is a different thing), since TypeScript does not
// merge two differently-named shapes — which is why the reference is carried by ARMS of the request
// itself rather than by a helper passed beside it. Precisely: `definitionId` is REQUIRED on the
// `AgentAttachFromDefinitionRequest` arm and `never` on the inline arm, so from a caller's side the union
// accepts a request with or without it — additive-optional in effect — while the type still refuses the
// one shape nothing can resolve, naming neither a definition nor a driver/model pair. It is deliberately
// NOT mutually exclusive with the explicit per-axis members: `Spec-030 §Required Behavior` merges per field — an explicitly-present
// request member overrides the definition's value for that field only, and the response echo reports every
// field as actually applied, so the merge is never silent and no caller is left guessing which side won.
// A precedence-refusal was considered and rejected: it would force every caller to know the definition's
// contents before composing a request.

// ---- Invoking-principal carrier (Plan-016-owned `run_links`, EXTEND; CP-030-4) ----
// A peer-invoked child run is created by a TOOL CALL, so it has neither an intervention row nor a
// participant who "started" it — the two arms `EffectivePrincipal` resolves through. Chaining to the
// parent RUN does not answer it either: a run accumulates turns from potentially several principals, and
// recency is not a correct answer to which one issued this call. The invoking turn's already-resolved
// effective principal is therefore STAMPED at child-run creation on the run link itself
// (`run_links.invoking_principal_id`), the same durable-recording discipline NS-71 established for
// `interventions.admitting_principal_id`. It is daemon-resolved and never client-supplied; a child run
// whose creation cannot resolve one is refused rather than created unattributed.
interface RunLinkInvokingPrincipal {
  invokingPrincipalId?: ParticipantId; // present iff the link was created by a peer-invocation tool call
}
```

**Why no receipt growth.** A peer-invoked child's spend lands on the **child's own** `SessionCostReceiptRunRow` under the target sidekick's paying account — an ordinary value of the per-paying-account axis the session cost receipt already has. Causation rides the existing `run_links` edge (`parentRunId` + `linkType`), not a receipt roll-up — and the per-caused-by attribution reads `invoking_principal_id` on that same edge, which is why the principal is stamped at creation rather than derived at report time: the receipt is a projection of a recorded fact, not a reconstruction. Growing the receipt to carry a caused-by roll-up would have weakened `aggregationScope`, which is REQUIRED and closed at the single literal `"run-only"` and verified positively by every row, so both receipt partition identities keep summing to the session total unchanged.
