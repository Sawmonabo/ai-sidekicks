# Plan-003: Runtime Node Attach

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `003` |
| **Slug** | `runtime-node-attach` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-003: Runtime Node Attach](../specs/003-runtime-node-attach.md) |
| **Required ADRs** | [ADR-001](../decisions/001-session-is-the-primary-domain-object.md), [ADR-002](../decisions/002-local-execution-shared-control-plane.md), [ADR-005](../decisions/005-provider-drivers-use-a-normalized-interface.md), [ADR-007](../decisions/007-collaboration-trust-and-permission-model.md), [ADR-008](../decisions/008-default-transports-and-relay-boundaries.md), [ADR-015](../decisions/015-v1-feature-scope-definition.md), [ADR-018](../decisions/018-cross-version-compatibility.md); transitive/substrate pointers (not Plan-003 decisions) — [ADR-009](../decisions/009-json-rpc-ipc-wire-format.md) (the daemon SDK + renderer ride the JSON-RPC IPC wire that Plan-007 owns; Plan-003 decides no wire format), [ADR-023](../decisions/023-v1-ci-cd-and-release-automation.md) (the Phase-5 renderer subtree runs under the Plan-023-owned `test:renderer` CI surface; Plan-003 adds no CI decision) |
| **Dependencies** | [Plan-001](./001-shared-session-core.md) (session model, forward-declared `session_events` integrity columns, and the `sessions.min_client_version` floor column — Plan-001 ships the physical column; Plan-003 picks up the read/write floor **semantics** at Tier 3 per [cross-plan-dependencies.md §1 Contested `min_client_version` row](../architecture/cross-plan-dependencies.md#1-table-ownership-map)). **The `runtime_node_attachments`/`runtime_node_presence` Postgres tables are Plan-003-owned, not Plan-001's** — Plan-003 CREATEs them in its own control-plane migration (Phase 3) per [cross-plan-dependencies.md §1 Uncontested row](../architecture/cross-plan-dependencies.md#1-table-ownership-map) and the `-- Owner: Plan-003` stamps in [shared-postgres-schema.md](../architecture/schemas/shared-postgres-schema.md); [Plan-007 bootstrap-deliverable](./007-local-ipc-and-daemon-control.md) (Tier 1 daemon JSON-RPC IPC substrate `packages/runtime-daemon/src/ipc/` incl. the namespace `registry.ts` and the `METHOD_NAME_FORMAT` guard — Plan-003 registers its runtime-node method handlers under it per [cross-plan-dependencies.md §2 `ipc/` row](../architecture/cross-plan-dependencies.md#2-package-path-ownership-map)); [Plan-006](./006-session-event-taxonomy-and-audit-log.md) (`runtime_node.*` event taxonomy registration at Tier 4 — Plan-003 emits the 5 daemon-authored events in V1 at Tier 3 as event-shape stubs against the Plan-001 forward-declared columns; the per-event **payload-shape** Zod schemas are Plan-003-owned (CREATE — the 5 daemon-reachable shapes in Phase 2; the `degraded`/`revoked` durable-event schemas are V1.1-gated on the node-identity trust anchor per [ADR-017 §Server-Derived Runtime-Node Lifecycle Events](../decisions/017-shared-event-sourcing-scope.md#server-derived-runtime-node-lifecycle-events), their server-derived producers having no sound V1 author — V1 records those transitions as coordination records), while the additive Plan-006 Tier-4 follow-up is discriminated-union registration + the `EventEnvelope` integrity wrapper + `CapabilityDetails` binding, not the payload shapes); [Plan-008 bootstrap-deliverable](./008-control-plane-relay-and-session-join.md) (Tier 1 tRPC v11 `sessionRouter` substrate — Plan-003's runtime-node calls — the four dual-transport mutations (`attach`/`heartbeat`/`capabilityupdate`/`detach`) plus the control-plane-only `runtimenode.roster` query added by the user-directed Phase 5 scope expansion (2026-06-09, PR #150) — cross the same control-plane transport as the sibling `runtimeNodeRouter`'s `runtimenode.*` procedures). See [cross-plan-dependencies.md §3 Plan-003 row](../architecture/cross-plan-dependencies.md#3-inter-plan-dependency-graph). [Spec-024](../specs/024-cross-node-dispatch-and-approval.md) is **not** a dependency for Plan-003 — historical Session H-interim header reference; cross-node dispatch implementation belongs to [Plan-027](./027-cross-node-dispatch-and-approval.md) per [cross-plan-dependencies.md §Spec-024 Implementation Plan](../architecture/cross-plan-dependencies.md#spec-024-implementation-plan). |
| **Cross-Plan Deps** | [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md) |

## Goal

Implement participant-owned RuntimeNode registration and attach into live sessions.

## Scope

This plan covers node identity, capability declaration, presence heartbeat, and attach or detach behavior between the Local Runtime Daemon and the Collaboration Control Plane.

## Non-Goals

- Provider driver internals
- Queue or workflow scheduling
- Cross-session node sharing policy

## Invariants

The following invariants are **load-bearing** and MUST be preserved across all Plan-003 PRs and downstream extensions. Violations break Spec-003 acceptance criteria, `ADR-018 §Decision` #4 cross-version semantics, and ADR-007 trust-model expectations.

### I-003-1 — Attach is admit-not-eject for below-floor daemons

A daemon attaching with a `client_version` below the session's `min_client_version` floor MUST be admitted in read-only state — the daemon remains joined and may read session state. Any subsequent version-sensitive domain write by that daemon (e.g. a capability declaration via `capabilityupdate`) MUST return typed `VERSION_FLOOR_EXCEEDED` per [ADR-018 §Decision #4](../decisions/018-cross-version-compatibility.md#decision). Ejection MUST NOT be the response to a floor mismatch (graceful degradation, not ejection — `Spec-003 §Required Behavior` version-floor bullet; `Spec-003 §Acceptance Criteria` below-floor read-only-admission criterion).

**Why load-bearing.** Ejection breaks the cross-version-compatibility contract: a participant on a slightly-old daemon would lose all session visibility, not just write capability. `ADR-018 §Decision` #4 explicitly chose graceful degradation over ejection so that a session with mixed-version daemons remains coherent.

**Verification.** Test must assert that a `RuntimeNodeAttach` with a below-floor `client_version` returns success with read-only attachment state, the daemon receives subsequent reads, and only the next write attempt returns `VERSION_FLOOR_EXCEEDED`. The attach event MUST NOT detach the node.

### I-003-2 — Online state requires capability declaration

A newly attached runtime node MUST default to non-online state (e.g., `pending`/`degraded`) until the capability declaration succeeds. `runtime_node.online` MUST emit only after `runtime_node.capability_declared` (`Spec-003 §Default Behavior`; `Spec-003 §Implementation Notes`).

**Why load-bearing.** Marking a node online before capability validation succeeds would expose unvalidated capabilities to scheduler routing. Spec-003 explicitly forbids "implicit capability exposure on attach" (`Spec-003 §Pitfalls To Avoid`) — this invariant is the structural enforcement.

**Verification.** Test must assert that `runtime_node.online` is never emitted until after a `runtime_node.capability_declared` event lands for the same node id.

### I-003-3 — Attach is separate from membership

`RuntimeNodeAttach` MUST NOT modify session_memberships, and `MembershipUpdate` MUST NOT trigger runtime-node detach as a side effect. Membership and node attach are independent surfaces that share a participant identity but otherwise compose orthogonally (`Spec-003 §Required Behavior`).

**Why load-bearing.** Conflating membership and attach would invert the trust-model — accepting an invite would auto-attach a runtime node (security violation per `Spec-002 §Pitfalls To Avoid` "Auto-attaching runtime nodes as part of invite acceptance"). Conversely, a runtime-node detach would revoke membership (breaks audit trail).

**Verification.** Test must assert that (a) `RuntimeNodeAttach` succeeds without any `session_memberships` mutation and (b) detaching a node leaves `session_memberships` unchanged. The audit-trail event sequence must show attach/detach and membership changes as distinct.

### I-003-4 — `monotonic_ns` is debug data, not the replay key

Plan-003's `runtime_node.*` event emission writes the `monotonic_ns` column (per Plan-001 forward-declared schema), but Plan-003 MUST NOT use `monotonic_ns` as the replay or ordering key — see [Plan-001 §Invariants I-001-2](./001-shared-session-core.md#invariants). Sequence is the canonical replay key.

**Why load-bearing.** Same reason as Plan-001 I-001-2 — clock-skew defense.

**Verification.** Inherits Plan-001's D3 test; Plan-003 PRs that add `runtime_node.*` event emission must not introduce code paths that read `monotonic_ns` for ordering decisions.

### I-003-5 — A runtime node has at most one active attachment (single active session)

In v1, a runtime node MAY be actively attached to at most one session at a time. This ratifies the Spec-003 V1 scope decision ([Spec-003 §Resolved Questions and V1 Scope Decisions](../specs/003-runtime-node-attach.md#resolved-questions-and-v1-scope-decisions): "a runtime node may participate in one active session at a time in v1. Multi-session sharing is deferred."). "Active" means a `runtime_node_attachments` row in state `registering`, `online`, or `degraded`; `offline` and `revoked` are inactive. The constraint is enforced at the database by a partial `UNIQUE(node_id)` index scoped to those active states (`idx_node_attachments_active`, see [shared-postgres-schema.md §Runtime Node Attachments](../architecture/schemas/shared-postgres-schema.md#runtime-node-attachments-plan-003)) — not by an application-level read-then-write — so a concurrent second active attach is rejected by the constraint with no TOCTOU window.

**Why load-bearing.** It collapses the node↔session cardinality the heartbeat and detach wire shapes depend on. Because the `idx_node_attachments_active` partial unique index (`UNIQUE(node_id) WHERE state IN ('registering', 'online', 'degraded')`) admits at most one active row per `node_id`, `RuntimeNodeHeartbeatRequest` and `RuntimeNodeDetachRequest` key on `nodeId` alone (no `sessionId`) and a server-side lookup `WHERE node_id = $1 AND state IN ('registering', 'online', 'degraded')` resolves to exactly that one row — the single active attachment. (The composite `idx_node_attachments_node (node_id, session_id)` index is the upsert `ON CONFLICT` target for T3.2's reconnect path, not the resolution index for these `nodeId`-only reads.) Without single-active-session those `nodeId`-only requests would be ambiguous across a node's several attachments; the v1 decision is what makes the wire shape sound (see T1.3, T3.6, T3.7).

**Verification.** Test P9 asserts a node already actively attached to session A is refused a second active attach to session B (the partial unique constraint fires), while a reconnect to A after detach — its row left `offline` — succeeds via the T3.2 upsert (`Spec-003 §Fallback Behavior`: reconnect under the same node identity). Heartbeat- and detach-by-`nodeId` therefore resolve the node's one active row unambiguously.

## Cross-Plan Obligations

Plan-003 declares the following obligations on adjacent plans. Implementation of Plan-003 cannot proceed (or must defer specific surfaces) without these being satisfied or explicitly staged.

### CP-003-1 — Plan-006 owns `runtime_node.*` event taxonomy registration

Plan-003 emits the 5 daemon-authored `runtime_node.*` events in V1 at Tier 3 against the column shape Plan-001 forward-declares (the integrity-protocol columns per [cross-plan-dependencies.md §1 Contested integrity row](../architecture/cross-plan-dependencies.md#1-table-ownership-map)); the `degraded`/`revoked` server-derived transitions are V1 coordination records, their durable events V1.1-gated ([ADR-017 §Server-Derived Runtime-Node Lifecycle Events](../decisions/017-shared-event-sourcing-scope.md#server-derived-runtime-node-lifecycle-events)). The semantics of the event taxonomy — `EventEnvelope` schema, BLAKE3 hash chain, dual-signature mechanics, JCS canonical serialization, and the discriminated-union **registration** into `SessionEventSchema` (`event.ts`) — are owned by [Plan-006 (Session Event Taxonomy And Audit Log)](./006-session-event-taxonomy-and-audit-log.md) at Tier 4. The per-event **payload-shape** schemas (the Zod object shape for each `runtime_node.*` payload) are NOT in that Plan-006-owned set — they are Plan-003-owned and authored in Plan-003's own `packages/contracts/src/runtime-node.ts` (see **Payload-shape ownership** below).

**Resolution.** Plan-003 at Tier 3 ships **event-shape stubs only**: writes that conform to the column shape Plan-001 declared, with `monotonic_ns` populated and `prev_hash`/`row_hash`/`daemon_signature` fields written but not validated against the chain (because the verifier code path doesn't exist until Plan-006 lands). Plan-006 at Tier 4 lands the verifier and the canonical writer; an additive Tier 4 follow-up backfills any retroactive validation needed against rows Plan-003 emitted at Tier 3. The discriminated-union **registration** of the taxonomy entries (folding each `runtime_node.*` payload schema into `SessionEventSchema` in `event.ts`) lands at Tier 4 in Plan-006.

**Payload-shape ownership (cross-plan amendment 2026-06-02, PR #137).** "Event-shape stubs only" governs the **integrity envelope** (the zero-filled `prev_hash`/`row_hash`/`daemon_signature` + real `monotonic_ns`) and the global-union registration — it does **not** mean Plan-003 emits untyped payloads. Plan-003 Phase 2 **CREATEs** the per-event payload-shape Zod schemas for the 5 daemon-reachable `runtime_node.*` events (`registered`, `online`, `offline`, `capability_declared`, `capability_updated`) directly in `packages/contracts/src/runtime-node.ts` — the file Plan-003 itself created at Phase 1, so this is Plan-003 extending its own surface, not a second writer on a Plan-006 file (the [§2 one-writer-per-file rule](../architecture/cross-plan-dependencies.md#2-package-path-ownership-map) holds). This realizes the `runtime-node.ts` self-citation that the per-event payload schemas are "a later Plan-003 phase," follows the Plan-001 precedent (every emitting plan authors its own payload schemas in `contracts`, e.g. `sessionCreatedPayloadSchema` in `event.ts`), and gives the emitter a `.parse()` validation boundary instead of ad-hoc objects. The `degraded` + `revoked` schemas are deferred to **V1.1**, gated on the node-identity trust anchor ([ADR-017 §Server-Derived Runtime-Node Lifecycle Events](../decisions/017-shared-event-sourcing-scope.md#server-derived-runtime-node-lifecycle-events)): their producers are **server-derived** (heartbeat-loss staleness and authority-issued revocation), which the control plane cannot author as durable session events in V1 (no event log; no roster-resolvable node-identity key) and which no other V1 party can author soundly, so writing the schemas now would be untested speculative surface with no V1 emitter. V1 records these transitions as coordination records (`runtime_node_presence.health_state` / `runtime_node_attachments.state`) only. The `capabilityDetails` field (on `capability_declared`) and the `previousState`/`newState` fields (on `capability_updated`) ship as an **interim opaque** `z.record(z.string(), z.unknown())` — their canonical type `CapabilityDetails` consumes Plan-005's `provider-driver.ts` types, which do not yet exist; this mirrors the existing loose `capabilities: z.record(z.string(), z.unknown())` in `packages/contracts/src/runtime-node.ts#RuntimeNodeAttachRequestSchema` and is the honest-forward-dep case, NOT the lazy-`Record` anti-pattern. **Plan-006 Tier 4 EXTENDs** by (a) registering these schemas into the discriminated `SessionEventSchema` union in `event.ts`, (b) wrapping them in the `EventEnvelope` integrity schema, and (c) binding the canonical `CapabilityDetails` wrapper over the interim-opaque fields (closes Plan-005 CP-005-5 / Plan-006 CP-006-5). See [cross-plan-dependencies.md §3 Plan-003 row](../architecture/cross-plan-dependencies.md#3-inter-plan-dependency-graph).

**Why this is the safe staging.** Re-shaping Plan-003's event emission post-Tier-4 is forbidden by `Plan-001 §Invariants` I-001-3 (forward-declared columns are immutable in scope at Tier 1). Therefore Plan-003 at Tier 3 must write into the column shape correctly even though full taxonomy semantics aren't registered yet.

### CP-003-2 — Plan-008 bootstrap surfaces the control-plane attach transport

`RuntimeNodeAttach`, `RuntimeNodeHeartbeat`, `RuntimeNodeCapabilityUpdate`, and `RuntimeNodeDetach` cross the control-plane tRPC transport that Plan-008-bootstrap ships at Tier 1. Plan-003 cannot run without this substrate — the routes must register on the existing `sessionRouter` skeleton (or a sibling `runtimeNodeRouter` that hangs off the same Cloudflare Workers host per [ADR-014](../decisions/014-trpc-control-plane-api.md) and Plan-008 BL-104 resolution 2026-04-30) per [cross-plan-dependencies.md §3 Plan-003 row](../architecture/cross-plan-dependencies.md#3-inter-plan-dependency-graph).

**Resolution.** Plan-008-bootstrap at Tier 1 already shipped the tRPC v11 server skeleton; Plan-003 at Tier 3 mounts a sibling `runtimeNodeRouter` (T3.8) under it. This is more than route registration: the router's four procedures call four backing control-plane service methods — `AttachService.attach` (T3.2), `HeartbeatService` ingest (T3.6), the `AttachService` detach path (T3.7), and `AttachService.updateCapabilities` (T3.9, the `capabilityupdate` discovery-snapshot refresh) — so all four are sequenced **before** T3.8. No new _transport_ infrastructure is required (the Cloudflare Workers host substrate exists); the new work is the `runtimeNodeRouter` factory plus the `updateCapabilities` service method — the one Phase-3 procedure that had no backing method in the original task list. **(Amended 2026-06-09, PR #150: the user-directed Phase 5 scope expansion mounts the namespace's first — and only — `query`, the control-plane-only `runtimenode.roster` backed by `AttachService.readRoster` (T5.0c), as the router's fifth procedure; the four-procedure description above is the Phase-3 record.)**

### CP-003-3 — Plan-023 owns the `window.sidekicks` preload bridge the Phase-5 renderer projects over

Plan-003's Phase 5 renderer subtree (`apps/desktop/src/renderer/src/runtime-node-attach/`) is a thin projection over the Spec-023 preload-bridge `window.sidekicks` surface owned by [Plan-023](./023-desktop-shell-and-renderer.md) (the renderer substrate + `SidekicksBridge` type at `packages/contracts/src/desktop-bridge.ts` shipped at Plan-023 Tier 1 Partial — NS-03). Per [Spec-023 §Trust Stance](../specs/023-desktop-shell-and-renderer.md#trust-stance) the renderer is untrusted and is **not a direct daemon client**: all runtime-node attach / heartbeat / capability / roster reads route through `window.sidekicks.controlPlane.call(...)` or `window.sidekicks.daemon.{call,subscribe}(...)`, never directly to daemon or control-plane state. See [cross-plan-dependencies.md §2 `apps/desktop/src/renderer/` row](../architecture/cross-plan-dependencies.md#2-package-path-ownership-map).

**Resolution.** Plan-023 Tier 1 Partial already shipped the bridge substrate and the renderer-untrusted import-ban lint; Plan-003 Phase 5 adds its renderer subtree as an extender under that substrate. No new bridge infrastructure — the Phase-5 views consume the existing typed surface. This entry codifies an obligation already doubly stated (Phase 5 prose below + the cross-plan-deps §2 ownership row, which lists Plan-003's `runtime-node-attach/` subtree among the bridge's extending plans) and mirrors how Plan-002 names its renderer-bridge dependency (CP-002-5); it introduces no new coordination requirement.

### CP-003-4 — `runtime_node_attachments` is a Path-2 participant-erasure target (⇄ Plan-022 CP-022-6)

`runtime_node_attachments` (Plan-003-owned — the `-- Owner: Plan-003` stamp in [shared-postgres-schema.md §Runtime Node Attachments](../architecture/schemas/shared-postgres-schema.md#runtime-node-attachments-plan-003)) carries `participant_id UUID NOT NULL REFERENCES participants(id)`, so it is inside the `REFERENCES participants(id)` inbound-foreign-key closure that [Plan-022](./022-data-retention-and-gdpr.md)'s GDPR Art. 17 Path-2 participant-erasure fan-out must address ([CP-022-6](./022-data-retention-and-gdpr.md#cross-plan-obligations)). On a participant-erasure request, the V1.1 shred handler **hard-DELETEs** the participant's `runtime_node_attachments` rows: these are operational node-attach state (the durable node-attach audit trail lives in the crypto-shredded `runtime_node.*` event stream — Path 1 — not in this table), so there is no independent retention basis and no referential-integrity reason to anonymize-and-retain.

**Resolution.** This is the live in-tier reciprocal for Plan-022 CP-022-6, added fix-in-place at the Tier-5 audit swap (2026-05-31 — the F3 round-4 Codex finding that the Path-2 closure omitted this table). No Plan-003 V1 code change: the erasure handler is V1.1 (`Plan-022 §Non-Goals`), and `runtime_node_attachments` already exists with its `participant_id` FK. This entry encodes the obligation so the closure carries no one-sided edge (Plan-022 I-022-19).

## Preconditions

- [x] Paired spec is approved — dated note (2026-07-13): recorded at this completed plan's audit/dispatch window; Spec-003 is temporarily `review` for the campaign B4 amendment window (campaign Task 28 restores `approved`). This plan is `completed` — no code dispatch gates on this box; the amendment's code leg belongs to Plan-024 Phase 3B.
- [x] Required ADRs are accepted
- [x] Blocking open questions are resolved or explicitly deferred
- [x] **Plan-readiness audit complete per [`docs/operations/plan-implementation-readiness-audit-runbook.md`](../operations/plan-implementation-readiness-audit-runbook.md)** — Tier 3 audit landed via NS-15; see [Status Promotion Gate §1](../operations/plan-implementation-readiness-audit-runbook.md#status-promotion-gate). Per-Phase `#### Tasks` blocks authored (Phases 1–5) and cite anchors corrected in-PR; the runtime-node table-CREATE-ownership self-misattribution (header + Phase 1) corrected to Plan-003-owned. Cross-cutting contract/schema fills (`clientVersion` on `RuntimeNodeAttachRequest`, the below-floor read-only attach representation, the JSON-RPC/tRPC method namespace, and the node↔session cardinality) plus the Spec-003 heartbeat degraded→offline threshold are dispositioned in this PR — the wire shapes in [`api-payload-contracts.md`](../architecture/contracts/api-payload-contracts.md) (the `clientVersion` field, the derived `readOnly` flag, and the Runtime-Node Method-Name Registry), the cardinality as [§Invariants I-003-5](#invariants), and the remainder in the per-task Contract-dependency notes below — per the [runbook §Cross-Tier Amendment Contingency](../operations/plan-implementation-readiness-audit-runbook.md#cross-tier-amendment-contingency); the `Spec-003 §Default Behavior` threshold addition re-discharges the Spec-Status Promotion Gate via a separate Spec-003 amendment PR ([BL-140](../archive/backlog-archive.md)).

Target paths below assume the canonical implementation topology defined in [Container Architecture](../architecture/container-architecture.md).

## Target Areas

- `packages/contracts/src/runtime-node.ts`
- `packages/runtime-daemon/src/node/node-registry.ts`
- `packages/runtime-daemon/src/node/node-capability-service.ts`
- `packages/control-plane/src/runtime-nodes/`
- `packages/client-sdk/src/runtimeNodeClient.ts`
- `apps/desktop/src/renderer/src/runtime-node-attach/`

## Data And Storage Changes

- Add shared `runtime_node_attachments` and `runtime_node_presence` tables — **Plan-003-owned** (the `-- Owner: Plan-003` stamps in [shared-postgres-schema.md](../architecture/schemas/shared-postgres-schema.md)); Plan-003 CREATEs them in its own control-plane migration at Phase 3, **not** Plan-001.
- Add local `node_capabilities` and `node_trust_state` persistence (daemon SQLite migration, Phase 1).
- **Node-registry persistence reuses these SQLite tables:** a row in `node_trust_state` (PK `node_id`) is the durable registration record — a node is "registered to this daemon" iff a `node_trust_state` row exists — and `node_capabilities` rows persist the declared capability set. Identity-payload fields carried only on the wire (`nodeVersion`, `platform` per the Spec-006 `runtime_node.registered` payload) are recovered by event replay, not stored as dedicated columns.
- See [Local SQLite Schema](../architecture/schemas/local-sqlite-schema.md) for column definitions.
- See [Shared Postgres Schema](../architecture/schemas/shared-postgres-schema.md) for column definitions.

## API And Transport Changes

- Add `RuntimeNodeAttach`, `RuntimeNodeHeartbeat`, `RuntimeNodeCapabilityUpdate`, and `RuntimeNodeDetach` to the client SDK and control-plane contracts. **(2026-06-09 scope expansion, PR #150: `RuntimeNodeRoster` is also added to the control-plane contracts and the SDK's control-plane factory — a control-plane-only `query`.)**
- `RuntimeNodeAttach` payload carries the daemon's `client_version` string; the control plane validates it against `sessions.min_client_version` and **admits** below-floor daemons in read-only state per [ADR-018](../decisions/018-cross-version-compatibility.md) §Decision #4 — the daemon remains joined and may read session state, but any subsequent version-sensitive domain write (e.g. a capability declaration via `capabilityupdate`) MUST return typed `VERSION_FLOOR_EXCEEDED`. Ejection MUST NOT be the response to a floor mismatch (graceful degradation, not ejection — see [Spec-003 §Required Behavior](../specs/003-runtime-node-attach.md#required-behavior) and §Invariants I-003-1).

## Event Emission

Plan-003 is the canonical emitter of the 7 `runtime_node.*` events in the `runtime_node_lifecycle` category defined in [Spec-006 §Runtime Node Lifecycle](../specs/006-session-event-taxonomy-and-audit-log.md#runtime-node-lifecycle-runtime_node_lifecycle):

- `runtime_node.registered` — RuntimeNode registered to the daemon registry.
- `runtime_node.online` — RuntimeNode passed presence heartbeat and is attached to a session.
- `runtime_node.degraded` — RuntimeNode is attached but capability health is reduced (missed heartbeats under threshold, partial provider driver failure, etc.).
- `runtime_node.offline` — RuntimeNode missed presence heartbeat beyond threshold; no longer receives dispatch.
- `runtime_node.revoked` — RuntimeNode trust state flipped to `revoked` per [ADR-007](../decisions/007-collaboration-trust-and-permission-model.md); attach is refused.
- `runtime_node.capability_declared` — Initial capability declaration on attach (provider drivers, resource class, version info).
- `runtime_node.capability_updated` — Capability declaration change mid-session (driver added/removed, health change).

> **V1 emission scope ([ADR-017 §Server-Derived Runtime-Node Lifecycle Events](../decisions/017-shared-event-sourcing-scope.md#server-derived-runtime-node-lifecycle-events)).** Plan-003 owns all 7 event types above, but V1 emits only the **5 daemon-authored** events as durable session events through the canonical append path — `registered`, `online`, explicit-shutdown `offline`, `capability_declared`, `capability_updated` (Phase 2). The **server-derived** transitions — heartbeat-staleness `degraded`, heartbeat-loss `offline`, authority-issued `revoked` — are recorded in V1 as **coordination records** (`runtime_node_presence.health_state` / `runtime_node_attachments.state`), their durable emission and the `degraded`/`revoked` payload schemas **V1.1-gated** on the node-identity trust anchor (their server-derived producers have no sound V1 author — the control plane has no event log or roster-resolvable node-identity key, and a dead/untrusted node cannot self-report). `offline` spans both classes: daemon-authored on explicit detach in V1, only the sweep-derived (heartbeat-loss) `offline` is V1.1-gated.

The remaining 2 events in the `runtime_node_lifecycle` category — `session.clock_unsynced` and `session.clock_corrected` — describe daemon-host clock state observed at the NTP sync probe and are emitted by [Plan-015 (Persistence, Recovery, Replay)](./015-persistence-recovery-and-replay.md), which owns that probe. These 2 events preserve their `session.*` wire names (category reclassification only, not rename) per [ADR-018](../decisions/018-cross-version-compatibility.md) §Decision #8 (MINOR envelope bumps are additive-only; renaming event types is explicitly forbidden) — a rename would break readers on prior MINOR versions within the same MAJOR. Category moves are safe because the `category` field is a classification facet, not a wire-identity key — readers dispatch on event name.

## Implementation Steps

- Contracts: See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed schemas this plan consumes.
- All five steps land at Tier 3 (Plan-003's canonical tier) and map 1:1 to the five phases in §Implementation Phase Sequence below (contracts → daemon → control-plane → SDK → renderer). The `apps/desktop/src/renderer/` substrate is created by [Plan-023 Tier 1 Partial](./023-desktop-shell-and-renderer.md#tier-1-partial-pr-sequence) per BL-101 (a) resolution, so step 5 (renderer integration) has no cross-tier blocker — it ships as the final PR in the Plan-003 sequence after step 4's SDK lands. See [cross-plan-dependencies.md §2 `apps/desktop/src/renderer/` row](../architecture/cross-plan-dependencies.md#2-package-path-ownership-map) and §Execution Windows below.

1. **[Tier 3]** Define node contracts and migration shape.
2. **[Tier 3]** Implement Local Runtime Daemon node registry and capability declaration service; emit the **5 daemon-authored** `runtime_node.*` events (`registered`, `online`, explicit-shutdown `offline`, `capability_declared`, `capability_updated`) through the canonical session-event append path. The server-derived `degraded` / heartbeat-loss `offline` / `revoked` transitions are V1 coordination-record updates (Phase 3), not durable events — their durable emission is V1.1-gated ([ADR-017 §Server-Derived Runtime-Node Lifecycle Events](../decisions/017-shared-event-sourcing-scope.md#server-derived-runtime-node-lifecycle-events)); see §Event Emission. Per §Invariants I-003-2, `runtime_node.online` MUST emit only after `runtime_node.capability_declared` succeeds. Per §Cross-Plan Obligations CP-003-1, events are shipped as event-shape stubs against the Plan-001 forward-declared integrity columns; Plan-006 at Tier 4 lands the verifier and the canonical writer.
3. **[Tier 3]** Implement Collaboration Control Plane RuntimeNode attach and presence services. **Per [Spec-003 §Required Behavior](../specs/003-runtime-node-attach.md#required-behavior):** at attach, the control plane MUST verify the daemon's reported version against the session's `min_client_version` floor. A NULL floor permits all daemons. A daemon below the floor MUST be admitted in read-only state — the daemon remains joined and may read session state, but any subsequent version-sensitive domain write (e.g. a capability declaration via `capabilityupdate`) MUST return typed `VERSION_FLOOR_EXCEEDED` per [ADR-018 §Decision #4](../decisions/018-cross-version-compatibility.md#decision). Ejection MUST NOT be the response to a floor mismatch (graceful degradation, not ejection — per §Invariants I-003-1).
4. **[Tier 3]** Implement the client SDK runtime-node surface (`packages/client-sdk/src/runtimeNodeClient.ts`) wrapping attach/heartbeat/capability/detach over the daemon and control-plane transports, plus the mixed-version integration tests (I1–I3). This is a standalone step (Phase 4) gated on step 3 — it is **not** folded into the control-plane step.
5. **[Tier 3]** Add desktop attach flow and session node roster UI under `apps/desktop/src/renderer/src/runtime-node-attach/` (per [cross-plan-dependencies.md §2 row for `apps/desktop/src/renderer/`](../architecture/cross-plan-dependencies.md#2-package-path-ownership-map)). This step lands as the final PR in the Plan-003 sequence after step 4 ships the SDK; the renderer substrate is created by Plan-023 Tier 1 Partial per BL-101 (a) resolution, not blocked behind Plan-023's Tier 8 remainder.

## Execution Windows

All Plan-003 steps land at Tier 3 (Plan-003's canonical tier). Phases ship as the sequence below over the Plan-008-bootstrap Tier 1 substrate; surfaces all node-attach/capability/presence/version-floor behavior. The renderer subtree at `apps/desktop/src/renderer/src/runtime-node-attach/` (Phase 5) ships after Phase 4's `runtimeNodeClient.ts` SDK lands — the `apps/desktop/src/renderer/` substrate is created independently by [Plan-023 Tier 1 Partial](./023-desktop-shell-and-renderer.md#tier-1-partial-pr-sequence) per BL-101 (a) resolution, so the renderer phase has no cross-tier blocker.

## Parallelization Notes

- Local node registry and shared control-plane attach services can proceed in parallel.
- Desktop attach UI should wait for stable capability payloads.

## Test And Verification Plan

The TDD test list below is enumerated and ordered by implementation dependency. Each test maps to one or more [Spec-003 acceptance criteria](../specs/003-runtime-node-attach.md#acceptance-criteria) and `Spec-003 §Required Behavior` MUSTs. Tests run via Vitest 4.x projects per [ADR-022](../decisions/022-v1-toolchain-selection.md).

### Contract Layer (`packages/contracts/`)

| ID | Test | Asserts | Spec-003 AC / MUST |
| --- | --- | --- | --- |
| C1 | `RuntimeNodeAttach payload validates required fields including client_version` | request schema | line 83 (required fields), line 53 (client_version) |
| C2 | `RuntimeNodeCapabilityUpdate payload supports add/remove/health-change variants` | mutation contract | line 84 |
| C3 | `RuntimeNodeDetach payload validates session id + node id + reason` | retire contract | line 85 |
| C4 | `runtime_node.* event names exactly match the 7-event taxonomy in Spec-006` | taxonomy conformance | `Spec-006 §Runtime Node Lifecycle (runtime_node_lifecycle)` |
| C5 | `VERSION_FLOOR_EXCEEDED error contract matches ADR-018 typed shape` | error contract | line 53, AC4 |
| C6 | `RuntimeNodeHeartbeat payload validates node id + health state` | presence-update contract | line 83 |

### Daemon Layer (`packages/runtime-daemon/src/node/`)

| ID | Test | Asserts | Spec-003 AC / MUST |
| --- | --- | --- | --- |
| D1 | `Node registry persists node identity across daemon restart` | stable identity (`Spec-003 §Implementation Notes`) | AC1 |
| D2 | `Capability declaration service emits runtime_node.capability_declared on success` | event emission | line 103 |
| D3 | `runtime_node.online MUST NOT emit until runtime_node.capability_declared lands` | I-003-2 ordering invariant | I-003-2, line 58 |
| D4 | `Detach emits runtime_node.offline; subsequent reconnect under same node id succeeds` | reconnect identity | line 79, line 120 |
| D5 | `Event emission writes monotonic_ns into Plan-001 forward-declared column shape` | CP-003-1 shape conformance | CP-003-1 |
| D6 | `Replay code paths do not read monotonic_ns for ordering — sequence is the canonical key` | I-003-4 inherits I-001-2 | I-003-4 |

### Control Plane Layer (`packages/control-plane/src/runtime-nodes/`)

| ID | Test | Asserts | Spec-003 AC / MUST |
| --- | --- | --- | --- |
| P1 | `RuntimeNodeAttach with NULL min_client_version floor admits all daemon versions` | NULL-floor permissive | line 53 |
| P2 | `RuntimeNodeAttach with client_version >= floor admits with full read/write` | happy-path floor | line 53, AC4 |
| P3 | `RuntimeNodeAttach with client_version < floor admits in read-only state — node remains joined and reads succeed` | I-003-1 admit-in-read-only invariant | I-003-1, line 53 |
| P4 | `Read-only-attached daemon's subsequent capability write returns typed VERSION_FLOOR_EXCEEDED; node remains joined (no detach)` | I-003-1 admit-not-eject invariant | I-003-1, AC4 |
| P5 | `Multiple runtime nodes can attach to the same session without changing session identity` | multi-node co-existence | AC3, line 49 |
| P6 | `Heartbeat ingestion updates runtime_node_presence; missed heartbeat past threshold transitions health_state to degraded then offline (coordination record — no durable event in V1)` | health transitions | line 60 (cadence); line 61 (`degraded` older than `30s` / `offline` older than `60s`); line 62 (control-plane sweep; no durable event) |
| P7 | `RuntimeNodeAttach MUST NOT mutate session_memberships` | I-003-3 attach-membership-separation | I-003-3, line 47 |
| P8 | `RuntimeNodeDetach leaves session_memberships unchanged` | I-003-3 attach-membership-separation | I-003-3, line 51 |
| P9 | `Node actively attached to session A is refused a second active attach to session B with a typed CONFLICT (409) wire error; reconnect to A after detach reactivates the offline row` | I-003-5 single-active-session (partial unique index) | I-003-5, `Spec-003 §Resolved Questions and V1 Scope Decisions` (single-active-session V1 decision) |
| P10 | `Re-attach to a session whose attachment row is revoked is refused with a typed CONFLICT (409) wire error — revocation is terminal, not a reconnect` | revoked-row terminality — a revoked (node, session) row is never reactivated | runtime-node-model.md (`revoked` is terminal) |

### SDK And Integration Layer (`packages/client-sdk/`, integration)

| ID | Test | Asserts | Spec-003 AC / MUST |
| --- | --- | --- | --- |
| I1 | `Participant joins live session, then attaches local runtime node — session not recreated` | live attach | AC1, line 50 |
| I2 | `Degraded node remains visible and distinguishable from healthy online node in roster` | degraded visibility | AC2 |
| I3 | `Mixed-version attach scenario: one daemon at floor, one below — both joined; below-floor blocked on write only` | I-003-1 end-to-end | I-003-1, AC4 |

### Verification

- `pnpm turbo test` at workspace root green across all packages
- Manual smoke: join a live session from one client, attach one runtime node, then attach a second node from a sibling client and verify roster shows both (after Phase 5 ships)
- All 25 enumerated tests above pass before Plan-003 is marked complete; Phase 5's renderer projection is gated by the manual two-client smoke (the load-bearing floor/attach/membership semantics are already proven by Phases 1–4 — C1–C6, D1–D6, P1–P10, I1–I3). Automated renderer component/E2E coverage is a criterion-gated V1.1 backfill tracked in BL-131 (not a V1/Tier-3 gate). **(Amended 2026-06-09, PR #150: the user-directed Phase 5 roster-read scope expansion adds automated contracts/control-plane/SDK coverage for `runtimenode.roster` — T5.0b–T5.0d — on top of the 25; the manual smoke remains the renderer-projection gate.)**

## Implementation Phase Sequence

Plan-003 implementation lands as a sequence of small PRs at Tier 3. Phases 1–4 ship the contract/daemon/control-plane/SDK layers; Phase 5 ships the renderer subtree after Phase 4 lands the SDK (the renderer substrate is created independently by Plan-023 Tier 1 Partial per BL-101 (a) resolution). Note: Plan-003 may run in parallel with Plan-002 at Tier 2 if PR scheduling permits — both depend only on Plan-001 completion (per [cross-plan-dependencies.md §5 Optimization Notes](../architecture/cross-plan-dependencies.md#optimization-notes)).

### Phase 1 — Node Contracts + Migrations

**Precondition:** Plan-001 complete (Tier 1 substrate carve-outs + forward-declared `session_events` integrity columns + the `sessions.min_client_version` column in place). Plan-001 does **not** create the `runtime_node_attachments`/`runtime_node_presence` Postgres tables — those are Plan-003-owned and created in Phase 3 (see §Dependencies and cross-plan-dependencies.md §1).

**Goal:** Tests C1–C6 go green; the daemon SQLite migration for `node_capabilities`/`node_trust_state` lands; Phase 1 confirms the Plan-001 upstream anchors (`participants`, `sessions.min_client_version`) that the Plan-003 Postgres tables will FK/read (the Postgres tables themselves are created in Phase 3).

- `packages/contracts/src/runtime-node.ts` — `RuntimeNodeAttach`, `RuntimeNodeHeartbeat`, `RuntimeNodeCapabilityUpdate`, `RuntimeNodeDetach` payloads, plus the `NodeId` (string brand) and `NodeState` types.
- `packages/contracts/src/error.ts` — **no authoring.** The `VersionFloorExceededError` shape + `VersionFloorExceededErrorSchema` + `VERSION_FLOOR_EXCEEDED_CODE` (literal `version.floor_exceeded`) already shipped at Plan-001 T2.3 (see cross-plan-dependencies.md §1 `sessions.min_client_version` row). Plan-003 **imports** this shape; C5 asserts the existing export conforms to `ADR-018 §Decision` #10. Plan-003 owns the **emit site** (control-plane attach/write path, Phase 3), not the contract.
- Local SQLite migration (Plan-003-owned, daemon `0002-runtime-node.ts`): `node_capabilities`, `node_trust_state`.
- Confirm the Plan-001 upstream schema (read-only): the `participants` identity anchor + `sessions.min_client_version` (Plan-003 FK-references / reads; does not duplicate-CREATE). The Plan-003-owned `runtime_node_attachments`/`runtime_node_presence` Postgres tables are created in the Phase 3 control-plane migration, **not** here and **not** by Plan-001.

#### Tasks

##### T1.1 — `runtime-node.ts`: `RuntimeNodeAttach` request/response + `NodeId`/`NodeState` brands

- **Files:** `packages/contracts/src/runtime-node.ts` (new), `packages/contracts/src/__tests__/runtime-node.test.ts` (new), `packages/contracts/src/index.ts` (add re-export).
- **Step:** Define `NodeId` as a string brand (mirror `packages/contracts/src/session.ts#SessionId`). Define `NodeState` as `z.enum(["registering","online","degraded","offline","revoked"])`, aligned with the `runtime_node_attachments.state` CHECK (`shared-postgres-schema.md`). Author `RuntimeNodeAttachRequestSchema` (zod `.strict()`) with `sessionId`, `participantId`, `nodeId`, `capabilities: z.record(z.unknown())`, `healthState: z.enum(["online","degraded"])`, and `clientVersion` (the daemon's reported version, validated against `sessions.min_client_version` per `Spec-003 §Required Behavior`). Author `RuntimeNodeAttachResponseSchema` with `attachmentId`, `state: NodeState`, `readOnly: z.boolean()` (derived below-floor flag — `true` iff `client_version` is below the session floor; orthogonal to `state`, populated by the Phase-3 attach service per `ADR-018 §Decision` #4), and `attachedAt` (ISO string).
- **Contract dependency:** `clientVersion` on `RuntimeNodeAttachRequest` is required by `Spec-003 §Required Behavior` + C1; this PR's Tier-3 plan-readiness audit adds it to the canonical wire shape in `api-payload-contracts.md` (see §Preconditions). The below-floor read-only attach representation is ratified there too as a derived `readOnly: boolean` on `RuntimeNodeAttachResponse` — orthogonal to `state` (not a `NodeState` member), `true` iff `client_version` is below the session floor.
- **Test (C1):** assert `RuntimeNodeAttachRequestSchema.parse` accepts a payload with all required fields including `clientVersion`, and rejects a payload missing `clientVersion`, missing `nodeId`, or with an out-of-enum `healthState`; and assert `RuntimeNodeAttachResponseSchema.parse` accepts a response carrying `readOnly: boolean`.
- **Spec coverage:** Spec-003 line 83 (RuntimeNodeAttach required fields), Spec-003 line 53 (`client_version` floor field)
- **Verifies invariant:** none (I-003-1 enforcement is Phase 3)

##### T1.2 — `runtime-node.ts`: `RuntimeNodeCapabilityUpdate` request/response

- **Files:** `packages/contracts/src/runtime-node.ts`, `packages/contracts/src/__tests__/runtime-node.test.ts`.
- **Step:** Author `RuntimeNodeCapabilityUpdateRequestSchema` (`.strict()`) with `nodeId`, `capabilities: z.record(z.unknown())`, and optional `healthChanges: { state: NodeState; reason?: string }` (additions/removals via the replacement `capabilities` map; health change via `healthChanges`). Author `RuntimeNodeCapabilityUpdateResponseSchema` with `nodeId`, `state: NodeState`, `updatedAt`.
- **Test (C2):** assert the schema accepts (a) an add-only payload, (b) a removal payload, (c) a health-change payload; assert `.strict()` rejects unknown keys.
- **Spec coverage:** Spec-003 line 85 (capability additions, removals, health changes)
- **Verifies invariant:** none (contract-schema definition)

##### T1.3 — `runtime-node.ts`: `RuntimeNodeHeartbeat` + `RuntimeNodeDetach` requests

- **Files:** `packages/contracts/src/runtime-node.ts`, `packages/contracts/src/__tests__/runtime-node.test.ts`.
- **Step:** Author `RuntimeNodeHeartbeatRequestSchema` (`.strict()`: `nodeId`, `healthState: z.enum(["online","degraded"])`) and `RuntimeNodeDetachRequestSchema` (`.strict()`: `nodeId`, optional `reason: string`). Both methods return no content, so also author the canonical no-content response schemas `RuntimeNodeHeartbeatResponseSchema = z.null()` and `RuntimeNodeDetachResponseSchema = z.null()` as named exports: over the JSON-RPC daemon transport a success carries `result: null` (JSON-RPC 2.0 requires a `result` member), which `z.null()` validates; over the tRPC control-plane transport the resolver returns `null`, surfaced as a normal HTTP 200 tRPC success envelope `{ result: { data: null } }` (not a 204 — the SDK's `parseTrpcResult` calls `response.json()` on every 2xx response, so an empty 204 body would throw), which `z.null()` likewise validates (see [api-payload-contracts.md §Runtime-Node Method-Name Registry](../architecture/contracts/api-payload-contracts.md#runtime-node-method-name-registry-tier-3)). Naming them here gives T4.1's SDK `client.call(...)` a concrete result schema and stops implementers inventing a per-call shape. (`Spec-003 §Interfaces And Contracts` Detach "must explicitly retire or disconnect a node" — the wire shape keys on `nodeId` only, with `session_id` resolved server-side to the node's single active attachment per [§Invariants I-003-5](#invariants); the "session id + node id" phrasing in C3 reflects the logical key, not two request fields.)
- **Test (C3):** assert `RuntimeNodeDetachRequestSchema` accepts `{nodeId, reason}` and `{nodeId}`, rejects a missing `nodeId`, and `.strict()`-rejects unknown keys; assert `RuntimeNodeDetachResponseSchema.parse(null)` succeeds and a non-`null` value is rejected.
- **Test (C6):** assert `RuntimeNodeHeartbeatRequestSchema` accepts `{nodeId, healthState:"online"}` and rejects an out-of-enum `healthState` or a missing `nodeId`; assert `RuntimeNodeHeartbeatResponseSchema.parse(null)` succeeds and a non-`null` value is rejected.
- **Spec coverage:** Spec-003 line 84 (RuntimeNodeHeartbeat updates presence/health), line 85 (RuntimeNodeDetach retire/disconnect)
- **Verifies invariant:** none (contract-schema definition)

##### T1.4 — `runtime-node.ts`: `runtime_node.*` event-name taxonomy constants (C4 conformance)

- **Files:** `packages/contracts/src/runtime-node.ts`, `packages/contracts/src/__tests__/runtime-node.test.ts`.
- **Step:** Export the 7 `runtime_node.*` event-name string literals (`registered`, `online`, `degraded`, `offline`, `revoked`, `capability_declared`, `capability_updated`) as a frozen tuple, sourced verbatim from `Spec-006 §Runtime Node Lifecycle (runtime_node_lifecycle)`. The 2 `session.clock_*` events in the same category are Plan-015-owned and out of scope. Per CP-003-1, Plan-003 ships event-shape stubs only — these are name constants, not the `EventEnvelope` schema. The `category` literal `runtime_node_lifecycle` already exists in the `EventCategory` union.
- **Test (C4):** assert the exported 7-name set is exactly equal (as a sorted set) to the 7 `runtime_node.*` names in `Spec-006 §Runtime Node Lifecycle (runtime_node_lifecycle)` — neither superset nor subset. Re-derive the expected set against that section's seven rows; do not transcribe from a Plan-003 gloss.
- **Spec coverage:** Spec-006 line 401 (payload base) + Spec-006 lines 407-413 (the full seven-row `runtime_node.*` set the C4 conformance test re-derives — `registered` / `online` / `degraded` / `offline` / `revoked` / `capability_declared` / `capability_updated`)
- **Verifies invariant:** none (event-name taxonomy constants — C4 conformance)

##### T1.5 — C5: `VERSION_FLOOR_EXCEEDED` conformance assertion against the existing `error.ts` export

- **Files:** `packages/contracts/src/__tests__/runtime-node.test.ts` (or co-located). **No edit to `error.ts`** (already shipped by Plan-001 T2.3).
- **Step:** Import `VersionFloorExceededErrorSchema`, `VersionFloorExceededError`, and `VERSION_FLOOR_EXCEEDED_CODE` from `packages/contracts/src/error.ts`. This is a conformance assertion against the existing Plan-001 T2.3 export — **not** a contract author (no edit to `error.ts`).
- **Test (C5):** assert (a) `VERSION_FLOOR_EXCEEDED_CODE` equals the literal `version.floor_exceeded`; (b) `VersionFloorExceededErrorSchema` accepts a payload whose `details` conforms to the shared `VersionBoundExceededDetails` shape (`attemptedVersion`, `acceptedRange:{min,max}`, optional `upgradePath`) per `ADR-018 §Decision` #10; (c) the schema is `.strict()` — rejects an unknown extra top-level key.
- **Spec coverage:** Spec-003 line 53 (typed `VERSION_FLOOR_EXCEEDED` on below-floor write), Spec-003 AC4 (line 134)
- **Verifies invariant:** I-003-1 (the typed-error contract; full admit-not-eject behavior is verified at P3/P4 in Phase 3)

##### T1.6 — Local SQLite migration `0002-runtime-node.ts`: `node_capabilities` + `node_trust_state`

- **Files:** `packages/runtime-daemon/src/migrations/0002-runtime-node.ts` (new), migration-shape test (extend or new).
- **Step:** Add the daemon migration `0002-runtime-node.ts` (Plan-003-owned; daemon `0001-initial.ts` is Plan-001's and does NOT contain these tables). Inline the SQL per the `0001-initial.ts` header convention (copy the `node_capabilities` and `node_trust_state` blocks verbatim from `local-sqlite-schema.md`, including `-- Owner:` and per-column comments). Register the migration in the daemon migration runner. Do NOT CREATE `runtime_node_attachments`/`runtime_node_presence` (Postgres, created at Phase 3).
- **Test:** assert (a) applying `0002` against a `0001`-migrated SQLite DB creates `node_capabilities` and `node_trust_state` with the exact column set + PKs (introspect via `PRAGMA table_info`); (b) idempotent under the runner's version anchor; (c) `node_capabilities` PK is `(node_id, capability_key)` and `node_trust_state` PK is `node_id`.
- **Spec coverage:** Spec-003 line 102 (runtime-node records durable for reconnect/audit)
- **Verifies invariant:** none

##### T1.7 — Confirm Plan-001 upstream schema (read-only; no CREATE)

- **Files:** assertion-only (co-locate in a Phase-1 migration test).
- **Step:** Confirm — by reading the shipped Plan-001 migrations, NOT by creating tables — that (a) the Postgres `runtime_node_attachments`/`runtime_node_presence` tables are Plan-003-owned and created at Phase 3 (control-plane), and (b) Plan-001 already ships the `participants` identity anchor and `sessions.min_client_version TEXT` that Plan-003 FK-references / reads. A guard that Plan-003 does not duplicate-CREATE upstream tables.
- **Test:** assert (via migration introspection) that no Plan-003 Phase-1 migration CREATEs `runtime_node_attachments`/`runtime_node_presence` (deferred to the Phase-3 Postgres migration), and that the Plan-001-shipped `participants` anchor + `sessions.min_client_version` column are present for Plan-003 to FK-reference / read.
- **Spec coverage:** none (structural guard — closes the "reads, does not CREATE" obligation against cross-plan-dependencies.md §1)
- **Verifies invariant:** none

### Phase 2 — Daemon Node Registry + Capability Service

**Precondition:** Phase 1 merged.

**Goal:** Tests D1–D6 go green.

- `packages/contracts/src/runtime-node.ts` — **CREATE** the 5 daemon-reachable `runtime_node.*` payload-shape Zod schemas (T2.0). Cross-plan amendment 2026-06-02 (PR #137) per §CP-003-1 (Payload-shape ownership); Plan-006 Tier 4 registers them into `SessionEventSchema` + binds the canonical `CapabilityDetails`.
- `packages/runtime-daemon/src/node/node-registry.ts` — node identity, registration, persistence across restart
- `packages/runtime-daemon/src/node/node-capability-service.ts` — declaration validation; emits `runtime_node.capability_declared`
- Event-emission wrapper that routes the 5 daemon-authored `runtime_node.*` event shapes through the canonical session-event append path (`SessionService.append`); per CP-003-1 ship as event-shape stubs against the Plan-001 forward-declared columns. Payload shapes per event are Spec-006-owned (`Spec-006 §Runtime Node Lifecycle (runtime_node_lifecycle)`); construct payloads against the **T2.0 payload-shape schemas** in `runtime-node.ts`, validating with `.parse()` at the emission boundary. **Phase 2 triggers the five daemon-reachable events** — `registered`, `capability_declared`, `capability_updated`, `online` (only after `capability_declared`, per I-003-2), and `offline` with `reason = explicit_shutdown` (detach, required by D4). The server-derived transitions (`degraded`, heartbeat-loss `offline`, and the admin/trust `revoked`) are Phase 3 coordination-record updates (the staleness sweep T3.6 / detach-revoke T3.7), not durable events — their durable emission is V1.1-gated ([ADR-017 §Server-Derived Runtime-Node Lifecycle Events](../decisions/017-shared-event-sourcing-scope.md#server-derived-runtime-node-lifecycle-events)). The runtime-node emitter receives its per-session `sequence` from a **deps-injected `nextSequence(sessionId)` allocator** (no parallel counter): the Phase-2 allocator derives the next value from the durable log (`SessionService.readEvents`, last `sequence` + 1 — synchronous, hence atomic in the single-threaded daemon, with `SessionService.append`'s `UNIQUE(session_id, sequence)` throw as the backstop). The coordinated production allocator is a **forward-dep on Plan-001 Phase 5**: the "existing seam" this plan originally assumed is unbuilt — SessionService Phase 3 (PR #9) shipped only `append`/`readEvents`/`replay`, and `append` deliberately pushes sequence assignment to the caller (`packages/runtime-daemon/src/session/session-service.ts#SessionService`, the `append` seam). Plan-003 therefore deps-injects the seam rather than authoring an allocator onto Plan-001-owned `SessionService` (ownership-respecting forward-dep, parallel to CP-003-1's interim-opaque fields; corrected 2026-06-02, PR #137).
- I-003-2 ordering: `runtime_node.online` only after `runtime_node.capability_declared` succeeds

#### Tasks

##### T2.0 — Contracts: per-event `runtime_node.*` payload-shape schemas (CREATE)

- **Files:** `packages/contracts/src/runtime-node.ts` (extend — Plan-003-owned, created at Phase 1). Barrel re-export is automatic (`packages/contracts/src/index.ts` does `export * from "./runtime-node.js"`).
- **Step:** Author the 5 daemon-reachable per-event payload-shape Zod schemas in `runtime-node.ts`, reusing the Phase-1 field types (`NodeIdSchema`, `NodeStateSchema`, `SessionIdSchema`, `ParticipantIdSchema`) — do **not** re-derive branded primitives. **Lifecycle events** carry the full base `{sessionId?, nodeId, previousState?: NodeState, newState: NodeState, actor?}` + extension; **capability events** carry the reduced base `{sessionId?, nodeId, actor?}` + capability fields (no `NodeState` transition — the canonical typed-payload source, [api-payload-contracts.md §Plan-006](../architecture/contracts/api-payload-contracts.md#plan-006--session-event-taxonomy), defines capability payloads without `previousState`/`newState: NodeState`). Shapes (`Spec-006 §Runtime Node Lifecycle (runtime_node_lifecycle)`):
  - `registered` → base + `{capabilities: z.record(z.string(), z.unknown()), nodeVersion, platform}`
  - `online` → base
  - `offline` → base + `{lastHeartbeatAt, reason ∈ ['heartbeat_lost','explicit_shutdown','network_partition']}` (author the **full** enum even though Phase 2 emits only `explicit_shutdown`)
  - `capability_declared` → reduced base + `{capability, capabilityDetails}`
  - `capability_updated` → reduced base + `{capability, previousState, newState}`
  - `capabilityDetails` and capability `previousState`/`newState` ship as **interim opaque** `z.record(z.string(), z.unknown())` — the canonical `CapabilityDetails` consumes Plan-005's `provider-driver.ts` types (absent); mirror the existing loose `capabilities` record in `packages/contracts/src/runtime-node.ts#RuntimeNodeAttachRequestSchema` and comment the forward-dep (Plan-006 Tier 4 binds canonical `CapabilityDetails`). Match the file's `.strict()` object house style, typed **single-`T`** `z.ZodType<T>` — these are non-input event payloads (constructed daemon-side, validated at the emission boundary with `.parse()`, never a tRPC request input), so they follow the single-T `packages/contracts/src/runtime-node.ts#RuntimeNodeAttachResponseSchema` and `event.ts`'s single-T event schemas, **not** the double-`T` `RuntimeNodeAttachRequestSchema` input surface (corrected 2026-06-02: the prior "double-`T`" instruction over-generalized the file's input-schema idiom to a non-input surface).
  - Update the `RUNTIME_NODE_EVENT_NAMES` comment block (`packages/contracts/src/runtime-node.ts#RUNTIME_NODE_EVENT_NAMES`): the per-event payload schemas are now authored here; only the **discriminated-union registration** (into `SessionEventSchema` in `event.ts`) + the `EventEnvelope` integrity wrapper remain deferred to Plan-006 Tier 4. Do **not** edit `event.ts` (no local discriminated union — no Phase-2 consumer; it would duplicate Plan-006's future global union). `degraded`/`revoked` durable-event schemas are V1.1-gated on the node-identity trust anchor ([ADR-017 §Server-Derived Runtime-Node Lifecycle Events](../decisions/017-shared-event-sourcing-scope.md#server-derived-runtime-node-lifecycle-events)) — no V1 producer.
- **Test:** schema parse/reject unit tests in `packages/contracts/src/__tests__/` — a valid payload per shape `.parse()`-es; a missing required field, a wrong-`reason`-enum value, and an extra key (`.strict()`) each reject.
- **Spec coverage:** Spec-006 lines 401, 403, 407-413 (payload base; session binding; per-event payload shapes); api-payload-contracts.md §Plan-006 (capability payload typing).
- **Verifies invariant:** none directly (contract surface consumed by T2.1/T2.2/T2.3 emission + the I-003-2/I-003-4 tests).
- **Cross-plan:** CREATE per §CP-003-1 (Payload-shape ownership); Plan-006 Tier 4 EXTENDs (union-registration + `EventEnvelope` + canonical `CapabilityDetails` binding).

##### T2.1 — Node registry: durable node identity + registration across restart

- **Files:** `packages/runtime-daemon/src/node/node-registry.ts` (new)
- **Step:** Implement a `NodeRegistry` over the canonical SQLite handle (per the migration-runner). A node is "registered to this daemon" iff a `node_trust_state` row (PK `node_id`, `trust_level DEFAULT 'untrusted'`) exists for it; `node_capabilities` rows persist the declared capability set. `register(nodeId, ...)` upserts the `node_trust_state` row; `lookup(nodeId)` reads it back — identity is stable across restart because it is durable SQLite, not in-memory state. On successful registration, emit `runtime_node.registered` through the T2.3 emission helper (payload base + `{capabilities[], nodeVersion, platform}`, `Spec-006 §Runtime Node Lifecycle (runtime_node_lifecycle)`). `nodeVersion`/`platform` are carried only on the wire and recovered by event replay — do not add columns for them.
- **Test (D1):** open a registry, register a node, close + reopen the DB handle, assert the same node identity is recoverable.
- **Spec coverage:** Spec-003 line 102 (durable runtime-node records), line 120 (node identity stable across reconnect), AC1 (line 131).
- **Verifies invariant:** I-003-3 (daemon-side — registration records a node without mutating membership; the daemon SQLite schema has no `session_memberships` table, so this is a structural defense-in-depth check. The canonical I-003-3 verification — the control-plane attach/detach RPC leaving Postgres `session_memberships` untouched, per the §Invariants verification clause — is P7/P8 in Phase 3, which is why the Phase-2 shipment manifest does not list I-003-3).

##### T2.2 — Capability service: declaration + update validation + capability_declared/\_updated emission

- **Files:** `packages/runtime-daemon/src/node/node-capability-service.ts` (new)
- **Step:** Validate the capability declaration (only explicitly declared capabilities are persisted/schedulable, per `Spec-003 §Default Behavior`). Persist accepted capabilities to `node_capabilities` (PK `node_id + capability_key`). On a first declaration, emit `runtime_node.capability_declared` through the T2.3 wrapper (reduced base + `{capability, capabilityDetails}`, `Spec-006 §Runtime Node Lifecycle (runtime_node_lifecycle)`). On a **change** to an already-declared capability (re-declare with different `capabilityDetails`), emit `runtime_node.capability_updated` through the T2.3 wrapper (reduced base + `{capability, previousState, newState}`, `Spec-006 §Runtime Node Lifecycle (runtime_node_lifecycle)` / [api-payload-contracts §Plan-006](../architecture/contracts/api-payload-contracts.md#plan-006--session-event-taxonomy)) carrying the prior and new detail snapshots — this is the `Spec-003 §State And Data Implications` "capability/trust changes emitted as session events" path. A re-declare with **identical** details is idempotent and emits **no** event (no spurious update spam). `previousState`/`newState` are interim-opaque (mirror the T2.0 schema; Plan-006 Tier 4 binds canonical `CapabilityDetails`).
- **Test (D2):** declare a capability → assert exactly one `runtime_node.capability_declared` event with the `Spec-006 §Runtime Node Lifecycle (runtime_node_lifecycle)` payload shape; re-declare the same capability with changed details → assert exactly one `runtime_node.capability_updated` event carrying the prior/new snapshots (`Spec-006 §Runtime Node Lifecycle (runtime_node_lifecycle)`); re-declare with unchanged details → assert no further event appended (idempotent).
- **Spec coverage:** Spec-003 line 59 (least-privilege schedulability), line 103 (capability/trust changes emitted as session events — covers both declaration and update), line 126 (no implicit capability exposure on attach).
- **Verifies invariant:** I-003-2 (the declaration is the precondition that gates `online`).

##### T2.3 — Event-emission wrapper: route runtime_node.\* shapes through the canonical append path

- **Files:** `packages/runtime-daemon/src/node/node-event-emitter.ts` (new) + its test `packages/runtime-daemon/src/node/__tests__/node-event-emitter.test.ts`. The shared emission helper is a **standalone module**, not co-located in `node-registry.ts`/`node-capability-service.ts`: T2.1's registry and T2.2's capability-service both import it, so a standalone module avoids a registry↔capability coupling and keeps this L1 task's file disjoint from the L2 consumers that import it and the L3 tasks that extend them (corrected 2026-06-02 — the original two-file listing collided with T2.1/T2.2/T2.4/T2.5 file ownership across DAG levels).
- **Step:** Build one emission helper that constructs each `runtime_node.*` event as an `AppendableEvent` and routes it through `SessionService.append`. The append path already zero-fills `prev_hash`/`row_hash`/`daemon_signature` and writes the caller-supplied `monotonic_ns` — Phase 2 does NOT reimplement integrity columns (CP-003-1; Plan-006 lands real hash-chain/signatures at Tier 4). Phase 2 wires triggers for the five daemon-reachable events (registered, capability_declared, capability_updated, online, offline/explicit_shutdown); the helper defines constructors for the 5 schema-backed shapes (`degraded`/`revoked` constructors + schemas are V1.1-gated on the node-identity anchor — no V1 producer; [ADR-017 §Server-Derived Runtime-Node Lifecycle Events](../decisions/017-shared-event-sourcing-scope.md#server-derived-runtime-node-lifecycle-events)). Construct payloads against the **T2.0 payload-shape schemas** (`@ai-sidekicks/contracts`), validating with `.parse()` at the emission boundary — not ad-hoc objects. Obtain the per-session `sequence` from a **deps-injected `nextSequence(sessionId)` allocator** (no parallel counter); the Phase-2 allocator derives it from the durable log (`SessionService.readEvents`, last `sequence` + 1 — atomic in the single-threaded daemon, `append`'s `UNIQUE(session_id, sequence)` throw as the backstop). The coordinated allocator is a forward-dep on Plan-001 Phase 5 — Plan-003 deps-injects rather than authoring an allocator onto Plan-001-owned `SessionService` (see the §Phase 2 intro note). Inject the monotonic clock + event-id source as deps too, so D6 can drive non-monotonic `monotonic_ns` without reaching past the emitter.
- **Test (D5):** emit a `runtime_node.*` event, assert the `session_events` row carries `monotonic_ns` in the Plan-001 column shape (zero-filled integrity columns; non-null `monotonic_ns`).
- **Spec coverage:** Spec-003 line 103 (capability/trust changes emitted as session events); Spec-006 lines 407-413 (per-event payload shapes)
- **Verifies invariant:** I-003-4 (`monotonic_ns` is debug data, not the replay key).

##### T2.4 — Ordering: online only after capability_declared

- **Files:** `packages/runtime-daemon/src/node/node-capability-service.ts` (or the state coordinator that fires `online`), consuming the T2.3 helper.
- **Step:** Gate the `runtime_node.online` emission on a prior successful `runtime_node.capability_declared` for the same node id. Before declaration succeeds, the node remains in a non-online state (`Spec-003 §Default Behavior` — `online` only after capability declaration succeeds). This daemon-side gate is **node-scoped**: it reads the node-keyed `node_capabilities` state (PK `(node_id, capability_key)`, no `session_id` column — `0002-runtime-node.ts`), not a per-session `runtime_node.capability_declared` event-stream scan. So a node that already declared satisfies the gate on serial re-attach (`Spec-003 §Resolved Questions and V1 Scope Decisions` — one active session at a time in v1) without re-emitting `capability_declared` — consistent with T2.2's node-scoped change-detection dedup (an identical re-declare is a node-keyed no-op, which a per-session event scan would otherwise starve). The control-plane attach gate (T3.2) is a distinct surface that reads relayed events, not this daemon-local table. (Clarified 2026-06-02, resolving the T2.2 Phase-C cross-session question.)
- **Test (D3):** drive a node through attach without declaration, assert no `runtime_node.online`; then declare, assert `runtime_node.online` follows `runtime_node.capability_declared` for the same node id.
- **Spec coverage:** Spec-003 line 58 (online only after capability declaration) — the gate D3 verifies (no `runtime_node.online` until a declaration row exists). Spec-003 line 77 (capability-validation FAILURE → `degraded`/`offline`, not healthy) is the sibling not-healthy principle; the `degraded`/`offline` it names are server-derived coordination-record transitions (Phase 3 T3.6), whose durable-event emission is V1.1-gated ([ADR-017 §Server-Derived Runtime-Node Lifecycle Events](../decisions/017-shared-event-sourcing-scope.md#server-derived-runtime-node-lifecycle-events)) — Phase 2 has no `degraded` emit shape; D3 exercises declaration ABSENCE via the :58 gate, not validation failure, so it codifies none of :77's emission. (Scoped 2026-06-02 to match the T2.4/D3 test.)
- **Verifies invariant:** I-003-2 (online requires capability declaration; Plan-003 §Invariants I-003-2 Verification clause).

##### T2.5 — Detach + reconnect under stable node identity

- **Files:** `packages/runtime-daemon/src/node/node-registry.ts`, consuming the T2.3 helper.
- **Step:** On detach, emit `runtime_node.offline` (payload base + `{lastHeartbeatAt, reason}`, `Spec-006 §Runtime Node Lifecycle (runtime_node_lifecycle)`) and leave the `node_trust_state` registration row intact so the node can reconnect under the same `node_id`. In Phase 2 the explicit-detach trigger fires `offline` with `reason = explicit_shutdown`; the sweep-derived (heartbeat-loss) `offline` is a coordination-record transition (Phase 3 T3.6), and its durable event is V1.1-gated ([ADR-017 §Server-Derived Runtime-Node Lifecycle Events](../decisions/017-shared-event-sourcing-scope.md#server-derived-runtime-node-lifecycle-events)).
- **Test (D4):** detach a node, assert one `runtime_node.offline` event; reconnect under the same node id, assert the registry resolves the same identity.
- **Spec coverage:** Spec-003 line 79 (reconnect under same identity — a durable-row behavior; the active-membership-intact clause is the I-003-3 invariant verified control-plane-side at P7/P8 in Phase 3), line 120 (node identity stable across reconnect).
- **Verifies invariant:** I-003-3 (daemon-side — detach does not revoke membership; structural defense-in-depth, as with T2.1. The canonical I-003-3 verification — control-plane attach/detach leaving Postgres `session_memberships` untouched — is P7/P8 in Phase 3, which is why the Phase-2 shipment manifest does not list I-003-3).

##### T2.6 — Replay does not read monotonic_ns for ordering (regression guard)

- **Files:** test only — `packages/runtime-daemon/` (the runtime-node emission + replay paths).
- **Step:** Add the regression guard against the new `runtime_node.*` emission + replay code: assert that ordering/replay reads `sequence ASC` and that no `runtime_node.*` code path reads `monotonic_ns` for an ordering decision. The legacy Plan-001 D3 covers the shared replay path; this guard covers the runtime-node-specific code.
- **Test (D6):** drive non-monotonic `monotonic_ns` values into emitted `runtime_node.*` events, replay, assert ordering follows `sequence` not `monotonic_ns`.
- **Spec coverage:** none (internal correctness invariant; see Plan-003 §Invariants I-003-4)
- **Verifies invariant:** I-003-4 (inherits Plan-001 I-001-2 / D3).

### Phase 3 — Control-Plane Attach + Heartbeat Services + Version-Floor Enforcement

**Precondition:** Phase 2 merged AND [BL-140](../archive/backlog-archive.md) closed. Phase 2 is satisfied by PR #137. BL-140 carries the `Spec-003 §Default Behavior` heartbeat degraded→offline threshold + sweep-owner amendment that T3.6/P6 below depend on; with it closed, [Spec-003 §Default Behavior](../specs/003-runtime-node-attach.md#default-behavior) specify `degraded` when the latest heartbeat is older than `30s` and `offline` when older than `60s` under a control-plane staleness sweep, so T3.6 no longer defers those values. The machine-readable `bl_closed` gate below enforces this ordering; the lane is tracked at [cross-plan-dependencies.md §6 NS-32](../architecture/cross-plan-dependencies.md#6-active-next-steps-dag).

```yaml
preconditions:
  - { type: plan_phase, plan: 3, phase: 2, status: merged }
  - { type: bl_closed, ref: 140 }
```

**Goal:** Tests P1–P10 go green; cross-version-compatibility surface works end-to-end.

- Control-plane migration (Plan-003-owned): CREATE `runtime_node_attachments` + `runtime_node_presence` (Postgres) per `shared-postgres-schema.md` — these tables are Plan-003-owned (`-- Owner: Plan-003`), created here, **not** by Plan-001.
- `packages/control-plane/src/runtime-nodes/attach-service.ts` — attach flow that reads `sessions.min_client_version` and applies the I-003-1 admit-in-read-only logic per `Spec-003 §Required Behavior`. Below-floor daemons remain joined; subsequent writes return `VERSION_FLOOR_EXCEEDED`.
- `packages/control-plane/src/runtime-nodes/heartbeat-service.ts` — presence ingestion, degraded/offline transitions
- `packages/contracts/src/runtime-node.ts` — narrow `capabilityupdate.healthChanges.state` to the 2-value `RuntimeNodeHealthState` self-report enum (T3.0), so a daemon cannot assert `offline`/`revoked` (least-privilege; `offline` is sweep-derived, `revoked` is authority-issued — `Spec-003 §Default Behavior` `capabilityupdate` amendment)
- `attach-service.ts` `updateCapabilities` — control-plane `capabilityupdate` discovery-snapshot refresh of a node's declared `capabilities` (plus an optional daemon-reported `online ↔ degraded` capability-health change on the T3.0-narrowed self-report enum); the daemon's node-capability service stays the authoritative declarer (no `registering → online` from the control plane, per I-003-2)
- I-003-3 enforcement: attach/detach paths MUST NOT mutate `session_memberships` (and vice versa)
- Routes register as a sibling `runtimeNodeRouter` composed into the Plan-008-bootstrap tRPC host alongside `createSessionRouter` per CP-003-2 (see T3.8)

#### Tasks

##### T3.0 — Contract: narrow `capabilityupdate.healthChanges.state` to the daemon self-report enum

- **Files:** `packages/contracts/src/runtime-node.ts` (the `RuntimeNodeCapabilityUpdateRequestSchema` `healthChanges.state` field + the `RuntimeNodeCapabilityUpdateRequest` interface + the surrounding `healthChanges` / heartbeat cross-reference comments), `packages/contracts/src/__tests__/runtime-node.test.ts` (**invert** the shipped `"accepts a healthChanges.state that is a 5-value NodeState…"` assertion — `runtime-node.test.ts`, then-lines 306-319 — which at authoring iterated `["registering", "offline", "revoked"]` and asserts ACCEPT), `docs/architecture/contracts/api-payload-contracts.md` (the `RuntimeNodeCapabilityUpdateRequest` wire-shape interface block — the synchronized description of this canonical schema, flipped in lockstep with the code per the file's §Source-of-Truth Policy, so it MUST NOT lead the code).
- **Role:** implementer — T3.0 **narrows an already-shipped contract** (`runtime-node.ts` type + `RuntimeNodeCapabilityUpdateRequestSchema`), **inverts its shipped conformance test** (`runtime-node.test.ts`), and **flips the synchronized wire-doc description** (`api-payload-contracts.md`); these **must co-commit** (the narrowed schema fails the old test, so the inversion cannot lag the type, and the role needs `Bash` to run the contracts test suite). It is **not** a pure new-artifact `contract-author` task — no same-level task consumes its output (T3.8 / T3.9 are downstream levels), so contract-author's run-first-in-level semantics buy nothing. It still **precedes all control-plane service tasks**.
- **Step:** Narrow `healthChanges.state` from the 5-value `NodeState` to the existing 2-value `RuntimeNodeHealthState` (`online | degraded`) — the **same self-reported-health enum** `RuntimeNodeAttachRequest.healthState` and `RuntimeNodeHeartbeatRequest.healthState` already carry — so all three daemon-self-report surfaces are consistent. Swap the schema member from `NodeStateSchema` to the hoisted `RuntimeNodeHealthStateSchema` (`packages/contracts/src/runtime-node.ts#RuntimeNodeHealthStateSchema`), mirroring the heartbeat-request schema's existing single-T cast handling, and reconcile the request-schema cast commentary (the "single-T `NodeStateSchema` member" note) with the new member type. Leave the **response** `state: NodeState` and `RuntimeNodeCapabilityUpdateResponseSchema` unchanged — the response is the server-derived liveness projection the control plane owns (the request→response asymmetry is intentional: daemon asserts narrow, server reports broad). Rewrite the `healthChanges` doc-comment (and the heartbeat comment that currently calls `capabilityupdate` the "full 5-value liveness axis" mover) to the least-privilege model: a daemon self-reports only its own capability-health; `offline` is server-derived liveness-death (the staleness sweep, T3.6) and `revoked` is an authority-issued trust decision (detach / admin, T3.7), and **neither is representable** in any daemon self-report. Flip the `api-payload-contracts.md` `RuntimeNodeCapabilityUpdateRequest` wire-shape block to the narrowed `state: "online" | "degraded"` in the same change (its explanatory comment carrying the authority-model summary + the intentional request-narrow/response-broad asymmetry), so the synchronized description and its canonical `packages/contracts/` source move together.
- **Step (why):** the Phase-1 contract (T1.2) typed this one field broad — inconsistent with its `attach`/`heartbeat` siblings and silent on the authority boundary. Narrowing it makes the illegal `offline`/`revoked` self-report **unconstructable** rather than runtime-rejected (`Spec-003 §Default Behavior` `capabilityupdate` amendment; authority-model grounding + primary sources in `Spec-003 §References`). This narrows a shipped contract; it does not touch `attach`/`heartbeat` or any response shape.
- **Test (unit — contract):** **invert the existing** `"accepts a healthChanges.state that is a 5-value NodeState but NOT a 2-value health value"` test (`runtime-node.test.ts`, then-lines 306-319) — `registering` / `offline` / `revoked` now **reject** (`.success === false`), with its proof comment rewritten to reference the 2-value `RuntimeNodeHealthStateSchema`. **Then sweep the whole test file** (`grep -nE 'NodeState|5-value' packages/contracts/src/__tests__/runtime-node.test.ts`) for **every other comment that still claims `healthChanges.state` is the 5-value `NodeState`** — the capability-update `describe`-block header (~line 256), the inline `(c) health change` note (~288), the `wire shape is { state: NodeState }` comment (~350), and the mis-wire-guard comments framing the capability-update proof as "the 5-value proof" (~442-482) — and reconcile each to the narrowed 2-value model, so no comment outlives the type change. Leave the **`NodeStateSchema` enum tests untouched** (`runtime-node.test.ts`, then-lines 227-236) — `NodeState` stays the 5-value liveness enum; only `healthChanges`'s _use_ of it narrows. Retain the existing `online` / `degraded` acceptance cases (`runtime-node.test.ts`, then-lines 294-312); `healthChanges` stays optional; the response schema and its tests are unchanged. Net: `RuntimeNodeCapabilityUpdateRequestSchema` **accepts** `online` / `degraded` and **rejects** `offline` / `revoked` / `registering`.
- **Spec coverage:** Spec-003 line 58 (online requires daemon-side declaration), line 66 (2026-06-04 `capabilityupdate` amendment — the daemon self-report axis is `online ↔ degraded`).
- **Verifies invariant:** I-003-2 (least-privilege: a daemon self-report cannot assert liveness-death or revocation; the control plane is not the declaration authority).

##### T3.1 — Control-plane migration: CREATE `runtime_node_attachments` + `runtime_node_presence`

- **Files:** `packages/control-plane/src/migrations/0003-runtime-nodes.ts` (new), `packages/control-plane/src/sessions/migration-runner.ts` (extended — append `{ version: 3, sql }` to `MIGRATIONS`, mirroring Plan-002's v2 in-place extension), migration-shape test.
- **Step:** Add the Plan-003-owned control-plane Postgres migration. Copy the `runtime_node_attachments` and `runtime_node_presence` blocks verbatim from `shared-postgres-schema.md` (including the `-- Owner: Plan-003` stamps, the `state` CHECK, the `idx_node_attachments_node` composite `(node_id, session_id)` unique index, and the `runtime_node_presence` PK). Register it as control-plane migration **version 3** (`0003-runtime-nodes.ts`) — append `{ version: 3, sql: ... }` to the runner's `MIGRATIONS` array in ascending version order, after Plan-002's v2 `0002-session-invites` (the `migration-runner.ts` header already names Plan-003 as the next v3+ registrant; `0002` is taken, so reusing it would break the monotonic sequence the runner depends on). Plan-001 does **not** create these tables (header §Dependencies + cross-plan-dependencies.md §1 Uncontested row); this Task is where they come into existence.
- **Test:** assert applying `0003` against a Postgres DB already migrated through `0002` (`0001-initial` + `0002-session-invites`) creates both tables with the exact column set, the `state` CHECK enum, the composite uniqueness, and the presence PK; idempotent under the runner.
- **Spec coverage:** Spec-003 line 102 (durable runtime-node records for reconnect/audit).
- **Verifies invariant:** none (substrate for I-003-1/I-003-3 persistence)

##### T3.2 — Attach service: NULL-floor unconditional admission

- **Files:** `packages/control-plane/src/runtime-nodes/attach-service.ts` (new); `packages/control-plane/src/runtime-nodes/errors.ts` (new — the attach-refusal throwables; T3.4 extends it).
- **Step:** Add a `Querier`-injected `AttachService` (mirror `MembershipService` constructor-injection). On attach, read `sessions.min_client_version`; when NULL, admit the node unconditionally and **upsert** into `runtime_node_attachments` (state `registering` → `online` after capability declaration per I-003-2). The write is `INSERT ... ON CONFLICT (node_id, session_id) DO UPDATE` against the `idx_node_attachments_node` unique key: a prior `offline` row for the same node and session is reactivated to `registering` (reconnect under the same node identity — `Spec-003 §Fallback Behavior` / `Spec-003 §Implementation Notes`; a plain `INSERT` would violate the unique key on reconnect). **Refuse** the (re)attach when the existing row is `revoked` — a revoked node is "no longer trusted or allowed to participate" ([runtime-node-model.md](../domain/runtime-node-model.md)), so revocation is terminal, not a reconnect. The distinct _cross-session_ case — a second active attach for a node already active on another session — is rejected by the `idx_node_attachments_active` partial unique constraint (§Invariants I-003-5), not by this clause. Both refusals surface as typed wire errors, not bare `500`s: each throws a typed control-plane exception (declared in `runtime-nodes/errors.ts` alongside T3.4's, with a dotted-lowercase `code` registered in [error-contracts.md](../architecture/contracts/error-contracts.md) per the existing convention) that the shared runtime-node-router catch-arm rethrows as `new TRPCError({ code: "CONFLICT", message, cause })` (HTTP 409) and the shared `errorFormatter` projects onto `shape.data.aisError` — the same two-part wiring T3.4 details. The cross-session refusal is detected by catching the Postgres unique-violation (SQLSTATE `23505`) on `idx_node_attachments_active`, matched portably across the `pg` and PGlite adapters. Acquire no `session_memberships` lock.
- **Test (P1, P9, P10):** `RuntimeNodeAttach` with NULL floor admits all daemon versions (P1); a node already actively attached elsewhere is refused a second active attach with a typed `CONFLICT` (409) error and a reconnect after detach reactivates the `offline` row (P9, I-003-5); a re-attach of a `revoked` row is refused with a typed `CONFLICT` (409) error — revocation is terminal (P10).
- **Spec coverage:** Spec-003 line 53 (NULL floor permits all daemons).
- **Verifies invariant:** I-003-3 (no `session_memberships` mutation on attach); I-003-5 (upsert reactivates an `offline` row; the `idx_node_attachments_active` partial unique index enforces single-active-session). Revocation terminality (a `revoked` row is not reactivated) is grounded in [runtime-node-model.md](../domain/runtime-node-model.md), verified by P10.

##### T3.3 — Attach service: floor comparison (≥ floor → read/write; < floor → read-only)

- **Files:** `packages/control-plane/src/runtime-nodes/attach-service.ts`.
- **Step:** Compare the daemon's reported version against a non-NULL `sessions.min_client_version`. At/above floor → full read/write attachment. Below floor → admit in read-only state; the node stays joined and reads succeed.
- **Contract dependency:** requires (a) the `clientVersion` field on `RuntimeNodeAttachRequest` and (b) the below-floor read-only attach representation (`RuntimeNodeAttachResponse` + the persisted `runtime_node_attachments` shape) — both ratified by the Tier-3 plan-readiness audit (see §Preconditions). Do not author the comparison or the read-only persistence until the request field and the read-only representation are ratified.
- **Test (P2, P3):** `client_version ≥ floor` admits read/write; `client_version < floor` admits read-only (node joined, reads succeed).
- **Spec coverage:** Spec-003 line 53 (verify daemon version against floor; below-floor admitted read-only).
- **Verifies invariant:** I-003-1 (admit-in-read-only).

##### T3.4 — Write-after-read-only-attach returns typed `VERSION_FLOOR_EXCEEDED`; node not detached

- **Files:** `packages/control-plane/src/runtime-nodes/errors.ts` (extended — adds `VersionFloorExceededException`; the file is created in T3.2 for the attach-refusal throwables), `packages/control-plane/src/runtime-nodes/attach-service.ts` + the control-plane write paths, the runtime-node router (catch-arm), `packages/control-plane/src/sessions/trpc.ts` (shared `errorFormatter`).
- **Step:** `packages/contracts/src/error.ts` exports the **wire shape** `VersionFloorExceededError` + `VersionFloorExceededErrorSchema` (Plan-001 T2.3) — a payload interface, **not** a throwable. Author a control-plane `VersionFloorExceededException` (`class … extends Error` with `readonly code = VERSION_FLOOR_EXCEEDED_CODE` — the constant imported from `packages/contracts/src/error.ts` per T1.5, not a re-spelled string literal — mirroring `sessions/errors.ts` `ResourceLimitExceededException` and the Plan-002 per-domain exception classes), or reuse one if it has already landed by Phase 3 (none exists today — check before authoring). Its projection conforms to the imported wire shape/schema. Throw it from the write paths reachable by a read-only-admitted node, then surface it via the Plan-001 AC8 two-part pattern: (i) a runtime-node-router **catch-arm** that rethrows as `new TRPCError({ code: "CONFLICT", message, cause })` (`CONFLICT` → HTTP **409** per [error-contracts.md §Version](../architecture/contracts/error-contracts.md#version)), and (ii) an `errorFormatter` branch on the shared `t` builder (`sessions/trpc.ts`, which the T3.8 sibling router reuses) projecting `cause.code/message/details` onto `shape.data.aisError`. Follow the existing `ResourceLimitExceededException` reference — or conform to the `AisWireException` base-class refactor the [Plan-001 decision-log](../plans/001-shared-session-core.md) prescribes once ≥3 typed exceptions share the formatter, if it has landed by Phase 3. The attachment row is left intact (no transition to `revoked`/`offline`, no `session_memberships` change). Depends on T3.3's read-only state.
- **Test (P4):** read-only-attached daemon's write returns typed `VERSION_FLOOR_EXCEEDED`; node remains joined (no detach).
- **Spec coverage:** Spec-003 line 134 (AC4 — `VERSION_FLOOR_EXCEEDED` on write, never ejected).
- **Verifies invariant:** I-003-1 (admit-not-eject).

##### T3.5 — Multiple nodes attach to one session without changing session identity

- **Files:** `packages/control-plane/src/runtime-nodes/attach-service.ts`.
- **Step:** Ensure `attach-service.ts` inserts under the composite `(node_id, session_id)` uniqueness so two distinct nodes attach to the same `session_id` without re-creating the session or mutating `sessions`.
- **Test (P5):** multiple runtime nodes attach to the same session without changing session identity.
- **Spec coverage:** Spec-003 line 49 (multiple runtime nodes per session), line 133 (AC3 — multiple nodes coexist without changing session identity).
- **Verifies invariant:** I-003-3 (attach does not touch session identity / membership).

##### T3.6 — Heartbeat service: presence ingestion + degraded/offline transitions

- **Files:** `packages/control-plane/src/runtime-nodes/heartbeat-service.ts` (new).
- **Step:** On each heartbeat, upsert `runtime_node_presence` (`last_heartbeat_at`, `health_state`). Separately, run a periodic staleness **sweep** (every `5s` — finer than the `15s` cadence, bounding detection lag to ≤ `5s` past a crossing) that reads `last_heartbeat_at` and **transitions `runtime_node_presence.health_state`** to `degraded` (heartbeat older than `30s`), then `offline` (older than `60s`) — a **coordination-record update, not a durable event**: the control plane authors no `runtime_node.*` session event for these server-derived transitions in V1, their durable emission being V1.1-gated ([ADR-017 §Server-Derived Runtime-Node Lifecycle Events](../decisions/017-shared-event-sourcing-scope.md#server-derived-runtime-node-lifecycle-events)). The demotion is **sweep-driven, not heartbeat-ingest-driven** — a silent or dead node sends nothing, so a missed-beat transition cannot be detected on ingest (`Spec-003 §Default Behavior`).
- **Contract/spec dependency:** the degraded→offline thresholds and the sweep owner are now specified by [Spec-003 §Default Behavior](../specs/003-runtime-node-attach.md#default-behavior) (BL-140 amendment): `degraded` when the latest heartbeat is older than `30s`, `offline` when older than `60s`, **server-derived** by the control-plane heartbeat service on a periodic staleness sweep — never self-reported (the wire `healthState` enum is `online | degraded` only, so a node cannot report itself `offline`). Spec-003 delegates the _sweep interval_ to this Task; T3.6 pins it at `5s` (finer than the `15s` cadence), satisfying the spec's guarantee that a transition is recorded within one sweep interval of a threshold crossing at ≤ `5s`. The presence→attachment fan-out join (presence is keyed `node_id`-global while attachments are per-`(node_id, session_id)`; `RuntimeNodeHeartbeatRequest` carries only `nodeId`) is resolved by the single-active-session invariant ([§Invariants I-003-5](#invariants)) — a heartbeat keyed on `nodeId` maps to the node's one active attachment, so no `sessionId` is needed on the wire.
- **Test (P6):** heartbeat ingestion updates `runtime_node_presence`; a node whose latest heartbeat ages past `30s` then `60s` is demoted by the staleness sweep to `health_state = degraded` then `offline` (coordination-record transition; no durable event in V1).
- **Spec coverage:** Spec-003 line 60 (heartbeat cadence 15s), line 61 (degraded `30s` / offline `60s` thresholds), line 62 (control-plane staleness-sweep owner)
- **Verifies invariant:** none (health-state lifecycle)

##### T3.7 — I-003-3 enforcement: attach/detach never mutate `session_memberships`

- **Files:** `packages/control-plane/src/runtime-nodes/attach-service.ts` + the detach path.
- **Step:** Assert (via test-visible query logging or a contract test) that the attach and detach paths write only `runtime_node_attachments` / `runtime_node_presence` and issue no INSERT/UPDATE/DELETE against `session_memberships`. Detach resolves the node's single active attachment by `nodeId` (unambiguous per §Invariants I-003-5) and updates that `runtime_node_attachments.state` (→ `offline` for a clean disconnect, `revoked` for a trust revocation) and `runtime_node_presence.health_state`, leaving membership rows untouched. Mirror the `MembershipService` no-mutation precedent (membership paths conversely never touch the attach tables).
- **Sequencing:** the detach method authored here backs T3.8's `runtimenode.detach` procedure, so T3.7 **precedes T3.8**. (The original Phase-3 DAG mis-sequenced T3.7 after T3.8 — an unsatisfiable forward reference, since the router cannot mount `runtimenode.detach` before its method exists. Corrected in this four-procedure reconciliation.)
- **Test (P7, P8):** `RuntimeNodeAttach` does not mutate `session_memberships`; `RuntimeNodeDetach` leaves `session_memberships` unchanged.
- **Spec coverage:** Spec-003 line 47 (attach is a separate step from membership acceptance), line 51 (detach/offline must not revoke membership by default).
- **Verifies invariant:** I-003-3 (attach-membership separation).

##### T3.8 — Route registration on the Plan-008-bootstrap tRPC host

- **Files:** `packages/control-plane/src/runtime-nodes/runtime-node-router.factory.ts` (new).
- **Step:** Export `createRuntimeNodeRouter(deps)` built on the shared `t` builder from `packages/control-plane/src/sessions/trpc.ts`, with `runtimenode.attach` / `runtimenode.heartbeat` / `runtimenode.capabilityupdate` / `runtimenode.detach` tRPC procedures. Compose it as a sibling `runtimeNodeRouter` merged into the root router in `packages/control-plane/src/server/host.ts` alongside `createSessionRouter` (resolves the "sessionRouter substrate or sibling" choice in favor of the sibling).
- **Backing services (all precede T3.8):** the four procedures call four service methods — `runtimenode.attach` → `AttachService.attach` (T3.2), `runtimenode.heartbeat` → `HeartbeatService` ingest (T3.6), `runtimenode.detach` → the `AttachService` detach path (T3.7), `runtimenode.capabilityupdate` → `AttachService.updateCapabilities` (T3.9). T3.8 `depends_on` all four; none may be a forward reference.
- **Contract dependency:** the runtime-node tRPC procedure names + their request/response schemas, and the daemon-side JSON-RPC method namespace (regex-valid `dotted-camelCase`, since Plan-007's `ipc/registry.ts` enforces `METHOD_NAME_FORMAT` and rejects the underscore `runtime_node.*` style), are ratified by the Tier-3 audit (see §Preconditions). The `runtime_node.*` **event** namespace is distinct from and unaffected by the JSON-RPC **method** namespace.
- **Test:** (enables P1–P10 transport; no standalone assertion.)
- **Spec coverage:** Spec-003 line 52 (control plane coordinates discovery/presence; execution stays local).
- **Verifies invariant:** none (transport wiring per CP-003-2)

##### T3.9 — Capability-update service: control-plane discovery-snapshot refresh

- **Files:** `packages/control-plane/src/runtime-nodes/attach-service.ts` (the `updateCapabilities` method) + the co-located service test.
- **Sequencing:** **precedes T3.8** — T3.8's `runtimenode.capabilityupdate` procedure calls this method — and **depends on T3.0**, whose narrowed `RuntimeNodeCapabilityUpdateRequest.healthChanges.state` (`online | degraded`) this method consumes. The after-T3.8 file position is append-only numbering stability, **not** execution order; this task joins the `attach-service.ts` writer chain after T3.2 (`AttachService` class + its single-active-attachment resolution), alongside T3.3/T3.5/T3.7. It is the one Phase-3 procedure that had no backing service method in the original task list — the gap this reconciliation closes.
- **Step:** Add a `Querier`-injected `updateCapabilities(request: RuntimeNodeCapabilityUpdateRequest): Promise<RuntimeNodeCapabilityUpdateResponse>` method on `AttachService` (cohesive with `attach`/`detach` — all three own the `runtime_node_attachments` row lifecycle; **not** a fragmented second service class). In a `transaction()`: resolve the node's single active attachment by `nodeId` `FOR UPDATE` (unambiguous per [§Invariants I-003-5](#invariants)); refresh the `capabilities` JSONB snapshot — the control-plane discovery roster — via `capabilities = $N::jsonb`; and, when `healthChanges` is present, apply `healthChanges.state` to `runtime_node_attachments.state` under the I-003-2 guard below. Return via `RETURNING node_id, state, now() AS updated_at` (map `node_id`/`updated_at` → `nodeId`/`updatedAt` per the existing `attach` row-mapping) — `updatedAt` is the **transaction-time server clock**, sourced transiently, **not** a stored column: the canonical [`runtime_node_attachments`](../architecture/schemas/shared-postgres-schema.md) schema has only `attached_at` (the creation timestamp), which this method MUST NOT overwrite. Parse the mapped row through `RuntimeNodeCapabilityUpdateResponseSchema`. Mutate **no** `session_memberships` (I-003-3). Emit **no** durable `runtime_node.*` event (ADR-017 — the control plane has no event log; the daemon's node-capability service stays the `runtime_node.capability_updated` writer, so this control-plane method only refreshes the coordination snapshot).
- **I-003-2 guard:** `offline` / `revoked` never reach this method — `healthChanges.state` is the 2-value `RuntimeNodeHealthState` (T3.0), so they are rejected at the **schema boundary**, not here (make-illegal-states-unrepresentable: liveness-death is the sweep's, T3.6; revocation is the detach/admin authority's, T3.7). The one residual **state-context** guard is `registering → online`: the _value_ `online` is legal, but applying it to a `registering` attachment is not — bringing a node `online` requires a successful **daemon-side** capability declaration ([§Invariants I-003-2](#invariants); `Spec-003 §Default Behavior`), and the control plane is not the declaration authority (`Spec-003 §Required Behavior` — "execution must remain local to the attached node"). That refusal surfaces as the same typed control-plane exception family as the T3.2 attach refusals (409 `CONFLICT`), not a bare `500`. The permitted application is the `online ↔ degraded` capability-health axis (`Spec-003 §Fallback Behavior` — capability-validation failure leaves the node `degraded`).
- **Test (unit — no P-AC):** `capabilityupdate` has no Phase-3 acceptance criterion (P1–P10 do not exercise it); it is built so T3.8 can mount the fourth procedure and the Phase-4 SDK (T4.1) can bind it. Unit-cover: the `capabilities` snapshot is refreshed on the active row; a `healthChanges.state` of `online` against a `registering` attachment is rejected (I-003-2 guard); `updatedAt` is the server `now()` while `attached_at` is unchanged; no `session_memberships` write occurs; and the control-plane path emits **no** durable `runtime_node.*` event (the projection boundary — ADR-017; the daemon's `runtime_node.capability_updated` is the authoritative audit record this refresh projects).
- **Spec coverage:** Spec-003 line 52 (control plane coordinates discovery/presence; execution stays local), line 58 (online requires capability declaration), line 77 (capability-validation failure → `degraded`), line 66 (2026-06-04 `capabilityupdate`-semantics amendment).
- **Verifies invariant:** I-003-2 (the control-plane `capabilityupdate` cannot drive `registering → online` — daemon-gated declaration); I-003-3 (no `session_memberships` mutation); I-003-5 (single-active-attachment resolution).

### Phase 4 — Client SDK Runtime-Node Surface + Integration

**Precondition:** Phase 3 merged.

**Goal:** Tests I1–I3 go green; mixed-version attach scenario works end-to-end.

- `packages/client-sdk/src/runtimeNodeClient.ts` — wraps attach/heartbeat/capability/detach over the daemon and control-plane transports
- Integration tests for live attach, multi-node co-existence, mixed-version below-floor read-only behavior

#### Tasks

##### T4.1 — `runtimeNodeClient.ts` SDK surface (two-factory)

- **Files:** `packages/client-sdk/src/runtimeNodeClient.ts` (new).
- **Step:** Mirror `packages/client-sdk/src/sessionClient.ts`. Define a `RuntimeNodeClient` interface exposing `attach`, `heartbeat`, `capabilityUpdate`, `detach`. Export `createDaemonRuntimeNodeClient(client: JsonRpcClient): RuntimeNodeClient` — each method calls `client.call(<METHOD_NAME>, request, <RequestSchema>, <ResponseSchema>)` using the Phase-1 Zod schemas (`RuntimeNodeAttachRequest/Response`, `RuntimeNodeHeartbeat*`, `RuntimeNodeCapabilityUpdate*`, `RuntimeNodeDetach*`). `JsonRpcClient.call<P, R>` requires a result schema — there is no void overload (see the three `sessionClient.ts` call sites) — so `heartbeat` and `detach` pass their Phase-1 no-content schemas (`RuntimeNodeHeartbeatResponseSchema` / `RuntimeNodeDetachResponseSchema`, both `z.null()`, validating the JSON-RPC `result: null`), while `attach` and `capabilityUpdate` pass their content response schemas. Export `createControlPlaneRuntimeNodeClient(fetcher)` for the tRPC transport, mirroring the `sessionClient.ts` control-plane factory and binding the `runtimenode.*` procedure paths from the sibling `runtimeNodeRouter` (T3.8). Carry a file-header `Spec coverage:` JSDoc block matching the `sessionClient.ts` precedent.
- **Contract dependency:** the daemon-side JSON-RPC method-name constants (regex-valid `dotted-camelCase` per the Phase-2/Phase-3 registry) and the control-plane tRPC procedure paths are ratified by the Tier-3 audit (see §Preconditions); do not author literal wire strings until that namespace lands. Control-plane router placement is already resolved — the SDK binds the sibling `runtimeNodeRouter` composed in T3.8 (no `sessionRouter` extension).
- **Test:** (factory surface — exercised in `packages/client-sdk/test/runtimeNodeClient.integration.test.ts`: the control-plane transport drives all four methods against the real services (I1–I3 + the detach lifecycle leg); the daemon transport drives all four methods through the scripted reply-table breadth suite; no standalone unit file.)
- **Spec coverage:** Spec-003 line 83 (RuntimeNodeAttach fields), line 84 (RuntimeNodeHeartbeat updates presence and health), line 85 (RuntimeNodeCapabilityUpdate add/remove/health variants), line 86 (RuntimeNodeDetach retires a node).
- **Verifies invariant:** none (SDK transport wrapper)

##### T4.2 — I1 integration test: live attach without session recreation

- **Files:** `packages/client-sdk/test/runtimeNodeClient.integration.test.ts` (new, following the `sessionClient.integration.test.ts` precedent).
- **Step:** Assert that a participant who has joined a live session can attach a local runtime node and that session identity is unchanged by the attach (the session id observed before and after attach is identical; no new session is materialized). Drive the attach through `createDaemonRuntimeNodeClient` / `createControlPlaneRuntimeNodeClient`.
- **Test (I1):** live attach to an already-active session leaves session identity unchanged.
- **Spec coverage:** Spec-003 line 131 (AC1 — participant attaches a local runtime node to an already active session), line 50 (attach must not require session recreation).
- **Verifies invariant:** none (I1 is an AC-coverage test — no Plan-003 invariant exclusively verified here)

##### T4.3 — I2 integration test: degraded node remains distinguishable in roster

- **Files:** `packages/client-sdk/test/runtimeNodeClient.integration.test.ts`.
- **Step (amended 2026-06-09 — drive `degraded` on the capability-health axis; the original heartbeat-driven roster-read is not a Phase-4 surface):** Attach two nodes to one live session through the SDK. Drive node A `registering → degraded` via `capabilityUpdate` with `healthChanges: { state: "degraded" }` (the self-reported capability-health axis — `Spec-003 §Fallback Behavior` — explicitly permitted by the I-003-2 guard, which blocks only `registering → online`), and drive node B to a healthy `online` contrast via the permitted `registering → degraded → online` recovery. Assert distinguishability through the client: A's latest `capabilityUpdate` response `state` reads `degraded` while B's reads `online` (the response `state` is the server-derived full `NodeState` — `Spec-003 §Default Behavior`), and A is not absent — a subsequent capabilities-only `capabilityUpdate` on A still resolves its active attachment (a retired slot would surface the typed 409 refusal) and still reads `degraded`. Additionally exercise the SDK `heartbeat` path end-to-end: it resolves to the no-content `null` response, the `runtime_node_presence` row lands server-side, and the liveness axis stays independent of the capability axis (presence `health_state` still `online` after A's capability-`degraded`) — asserted at the persistence layer, since no Phase-4 client surface reads the presence axis. **Why amended:** the original step ("drive `degraded` via the Phase-3 heartbeat transition, then read the roster through the client") is unimplementable against the shipped Phase-4 surface — heartbeat/staleness transitions write only the `runtime_node_presence.health_state` liveness axis, which no Phase-4 SDK response surfaces, and the reconciled roster-read (presence × slot) is downstream of this plan (`Spec-003 §Default Behavior` — per-axis storage "not pinned in this contract"; `ADR-017 §Server-Derived Runtime-Node Lifecycle Events`). \*\*(Reconciled 2026-06-09: the "downstream of this plan" roster-read deferral is superseded for the read path — the user-directed Phase 5 scope expansion ships the reconciled roster-read in this plan as the control-plane-only `runtimenode.roster` query (T5.0a–T5.0d), its projection now pinned in `Spec-003 §Interfaces And Contracts` while per-axis storage stays writer-owned; this T4.3 step itself is unchanged — the capability-health-axis I2 test remains as shipped in Phase 4 (Shipment Manifest).)\*\*
- **Test (I2):** a degraded node stays visible and distinguishable from a healthy online node through the client-observable `NodeState` (capability-health axis).
- **Spec coverage:** Spec-003 line 132 (AC2 — a degraded or offline node remains distinguishable from a healthy online node), line 77 (capability-validation failure leaves the node `degraded` — the self-reported capability-health axis driven here), line 73 (the `capabilityupdate` response `state` is the server-derived full `NodeState`; the effective roster state reconciles both independent axes).
- **Verifies invariant:** none (I2 is an AC-coverage test)

##### T4.4 — I3 integration test: mixed-version attach, below-floor read-only (behavioral)

- **Files:** `packages/client-sdk/test/runtimeNodeClient.integration.test.ts`.
- **Step:** Set a session `min_client_version` floor, then attach two daemons through the SDK — one at/above floor, one below. Assert end-to-end: (1) **both** attach and remain joined (below-floor is admitted, not rejected); (2) the at-floor daemon reads and writes; (3) the below-floor daemon **reads** successfully; (4) any **version-sensitive domain write** (e.g. a capability declaration via `capabilityupdate`) by the below-floor daemon returns typed `VERSION_FLOOR_EXCEEDED` (dotted `version.floor_exceeded`, HTTP 409 per `error-contracts.md §Version` row / the JSON-RPC two-layer equivalent); (5) the below-floor daemon is **never detached** for the floor mismatch (no `runtime_node.offline`/detach emitted by the floor check). Set the daemon's reported version via the attach-request floor field.
- **Contract dependency:** the below-floor branch requires the `clientVersion` request field added by this PR's Tier-3 audit (see §Preconditions). Beyond the behavioral assertions (read succeeds, write → `VERSION_FLOOR_EXCEEDED`, no detach), also assert the derived `readOnly` flag ratified in this PR: `response.readOnly === true` for the below-floor daemon and `=== false` for the at-floor daemon (orthogonal to `state`, not a `NodeState` member).
- **Test (I3):** mixed-version attach — at-floor reads/writes; below-floor reads but writes return `VERSION_FLOOR_EXCEEDED`; neither node is ejected.
- **Spec coverage:** Spec-003 line 134 (AC4 — below-floor daemon admitted read-only, `VERSION_FLOOR_EXCEEDED` on subsequent write, never ejected).
- **Verifies invariant:** I-003-1 (admit-in-read-only / admit-not-eject) — verified end-to-end this Phase.

### Phase 5 — Renderer (Tier 3)

**Precondition:** Phase 4 merged (the `runtimeNodeClient.ts` SDK is consumed by the desktop **main process** to back the preload-bridge handlers — the renderer itself never imports the Node-side SDK; it reaches runtime-node state only through `window.sidekicks` per `Spec-023 §Trust Stance`) AND Plan-023 Tier 1 Partial complete (`apps/desktop/src/renderer/` substrate exists). Sequenced at Tier 3 per §Execution Windows above.

**Goal:** Step 4 ships; manual two-client attach smoke passes (one client at floor, one below — verify both visible in roster, below-floor blocked on write).

- `apps/desktop/src/renderer/src/runtime-node-attach/` — renderer views for attach flow, capability declaration, node roster, mixed-version status indicators (thin projection over the Spec-023 preload-bridge `window.sidekicks` surface; MUST NOT bypass the bridge to reach daemon or control-plane state directly)

**Scope expansion (user-directed 2026-06-09, PR #150).** Phase 5 additionally ships the full `runtimenode.roster` read path end-to-end — governance pin (T5.0a), contracts schemas (T5.0b), control-plane read service + the namespace's first router `query` (T5.0c), and the SDK roster query on the control-plane factory (T5.0d) — pulling the reconciled roster-read (presence × slot) **in-scope** rather than extending the T4.3 "downstream of this plan" deferral, per the standing hardened-implementation directive. T5.0a–T5.0d are orchestrator-introduced per the [Plan-002 PR #117 precedent](./002-invite-membership-and-presence.md#progress-log), so the audit 1:1-coverage rule applies only to T5.1–T5.4. The contract is pinned in [Spec-003 §Interfaces And Contracts (2026-06-09 amendment)](../specs/003-runtime-node-attach.md#interfaces-and-contracts) and the [Runtime-Node Method-Name Registry](../architecture/contracts/api-payload-contracts.md#runtime-node-method-name-registry-tier-3): `runtimenode.roster` is a **`query`** (its four namespace siblings are mutations), **control-plane tRPC only** — the roster is control-plane-owned cross-node state; a daemon knows only itself — and the read projects coordination records, authoring no durable event (no collision with the [ADR-017 §Server-Derived Runtime-Node Lifecycle Events](../decisions/017-shared-event-sourcing-scope.md#server-derived-runtime-node-lifecycle-events) V1.1 gate).

#### Tasks

##### T5.0a — Governance: register `runtimenode.roster` + pin the roster-read contract (orchestrator-introduced, 2026-06-09 scope expansion)

- **Files:** `docs/specs/003-runtime-node-attach.md`, `docs/plans/003-runtime-node-attach.md`, `docs/architecture/contracts/api-payload-contracts.md`, `docs/architecture/cross-plan-dependencies.md`. Plus corpus-wide re-anchoring of the drifted citer files (see Step).
- **Scope note:** orchestrator-introduced under the user-directed 2026-06-09 scope expansion; doc lands first in-PR — the doc never trails the code.
- **Step:** register `runtimenode.roster` in the Method-Name Registry as the namespace's first `query` (control-plane tRPC only) with the `RuntimeNodeRosterRequest`/`RuntimeNodeRosterEntry`/`RuntimeNodeRosterResponse` wire shapes; pin the roster-read contract in `Spec-003 §Interfaces And Contracts` (visibility: all `runtime_node_attachments` rows, all five `state` values verbatim; nullable LEFT-JOINed presence axis; per-row derived `readOnly`; both axes verbatim with no collapsed scalar; the read never derives staleness — T3.6 stays the single liveness-derivation writer; ADR-017 non-collision); reconcile the T4.3 "downstream of this plan" sentence; re-derive the four-method/all-mutation quantifiers here, in `api-payload-contracts.md`, and in `cross-plan-dependencies.md`. Also: corpus-wide inbound-cite re-anchoring for the Spec-003 +7 / `api-payload-contracts.md` +23 line shifts (15 citer files, including three orchestrator-authorized string-literal cites), and the T5.1-row stale-instruction correction (the ambient-augmentation re-declare superseded by the Plan-002 T6.0 `sidekicks-bridge.d.ts` hoist).
- **Test:** none (governance docs only; `prettier --check` green on the four files).
- **Spec coverage:** Spec-003 line 132 (AC2 — a degraded or offline node remains distinguishable from a healthy online node), line 133 (AC3 — multiple nodes coexist without changing session identity), line 49 (multiple runtime nodes per session), line 73 (both health axes reconciled client-side; the read-side projection now pinned).
- **Verifies invariant:** none (governance).

##### T5.0b — Contracts: `RuntimeNodeRoster*` request/entry/response Zod schemas (orchestrator-introduced, 2026-06-09 scope expansion)

- **Files:** `packages/contracts/src/runtime-node.ts` (extend), `packages/contracts/src/__tests__/runtime-node.test.ts` (extend).
- **Scope note:** orchestrator-introduced under the user-directed 2026-06-09 scope expansion.
- **Step:** author `RuntimeNodeRosterRequestSchema` (`.strict()`: `sessionId`), `RuntimeNodeRosterEntrySchema` (the nine-field entry pinned in `Spec-003 §Interfaces And Contracts` — `nodeId`, `participantId`, `state: NodeState` carrying all five values, nullable `healthState` on the 3-value presence enum (`online | degraded | offline`, mirroring the `runtime_node_presence.health_state` CHECK), nullable `lastHeartbeatAt`, `readOnly`, `capabilities`, `clientVersion`, `attachedAt`), and `RuntimeNodeRosterResponseSchema` (`{ nodes: RuntimeNodeRosterEntry[] }` as built 2026-06-09; the 2026-07-13 campaign-B4 write-lease amendment extends the response contract with `controlHolder: ParticipantId | null` — that schema extension is implemented by Plan-024's Phase 3B lease leg per `Spec-003 §Interfaces And Contracts`, not by re-opening this completed task), mirroring the registry wire shapes. Non-input projection schemas follow the file's single-`T` house style (the T2.0 precedent). Also re-anchor the T5.0a-drifted `Spec-003`/`api-payload-contracts.md` cites in this task's files (content-verified mappings carried in the 2026-06-09 scope-expansion dispatch DAG).
- **Test (unit — contract):** a full entry parses; null `healthState` + null `lastHeartbeatAt` parse (pre-first-heartbeat row); all five `state` values parse; out-of-enum `state`/`healthState` reject; `.strict()` rejects unknown keys.
- **Spec coverage:** Spec-003 line 73 (the wire carries both axes verbatim — no collapsed scalar), line 132 (AC2 — `degraded`/`offline` representable on the wire), line 49 (multiple runtime nodes per session — `nodes[]`).
- **Verifies invariant:** none (contract-schema definition).

##### T5.0c — Control plane: `AttachService.readRoster` + the `runtimenode.roster` router `query` (orchestrator-introduced, 2026-06-09 scope expansion)

- **Files:** `packages/control-plane/src/runtime-nodes/attach-service.ts` (extend), `packages/control-plane/src/runtime-nodes/runtime-node-router.factory.ts` (extend), co-located service/router tests.
- **Scope note:** orchestrator-introduced under the user-directed 2026-06-09 scope expansion.
- **Step:** add `readRoster(request: RuntimeNodeRosterRequest): Promise<RuntimeNodeRosterResponse>` on `AttachService`: SELECT **all** `runtime_node_attachments` rows for the session (all five `state` values verbatim — no server-side hiding; row count bounded by distinct nodes ever attached under the `(node_id, session_id)` uniqueness), LEFT JOIN `runtime_node_presence` on `node_id` carrying `health_state`/`last_heartbeat_at` verbatim (NULL until the node's first heartbeat), and derive `readOnly` per row from the stored `client_version` vs `sessions.min_client_version` (NULL floor → `false`; identical semantics to the attach-time verdict). The read MUST NOT derive staleness (the T3.6 sweep stays the single liveness-derivation writer) and MUST NOT collapse the two axes. (2026-07-13, campaign B4: the response additionally carries `controlHolder: ParticipantId | null` from the `session_terminal_leases` join once Plan-024 Phase 3B ships the lease table — the read extension rides that leg per `Spec-003 §Interfaces And Contracts`; this completed task's attachments × presence join is unchanged until then.) Mount `runtimenode.roster` as the router's first `query` — control-plane tRPC only, no daemon JSON-RPC registration — and reconcile the router/SDK "all four are mutations / no query" comments in the touched files. Emit no durable event (ADR-017 non-collision). Also re-anchor the T5.0a-drifted `Spec-003`/`api-payload-contracts.md` cites in this task's files (content-verified mappings carried in the 2026-06-09 scope-expansion dispatch DAG).
- **Test (unit/integration):** the roster returns every state including `offline`/`revoked`; a never-heartbeated node carries `healthState: null` + `lastHeartbeatAt: null`; the presence axis reflects the sweep's verdict verbatim (the read derives nothing); `readOnly` is `true` below floor, `false` at floor and on a NULL floor; no `session_memberships` mutation; no event append.
- **Spec coverage:** Spec-003 line 132 (AC2 — degraded/offline distinguishable in the roster read), line 133 (AC3 — multiple nodes coexist), line 49 (multiple runtime nodes per session), line 52 (control plane coordinates discovery/presence; execution stays local), line 53 (the derived read-only verdict against the floor), line 73 (axes carried verbatim; reconciliation is the client's render-time concern).
- **Verifies invariant:** none new (read-only projection over coordination records; I-003-3 untouched — asserted by the no-membership-mutation test).

##### T5.0d — SDK: `roster` query on the control-plane runtime-node factory (orchestrator-introduced, 2026-06-09 scope expansion)

- **Files:** `packages/client-sdk/src/runtimeNodeClient.ts` (extend), `packages/client-sdk/test/runtimeNodeClient.integration.test.ts` (extend).
- **Scope note:** orchestrator-introduced under the user-directed 2026-06-09 scope expansion.
- **Step:** expose `roster` on the control-plane factory (`createControlPlaneRuntimeNodeClient`) as the surface's first tRPC `query`, validating with `RuntimeNodeRosterResponseSchema` at the SDK boundary (the Zod fail-fast precedent). The daemon factory does NOT gain `roster` (control-plane-only transport — a daemon knows only itself); reconcile the factory-header "ALL MUTATIONS / NO query" comments. Also re-anchor the T5.0a-drifted `Spec-003`/`api-payload-contracts.md` cites in this task's files (content-verified mappings carried in the 2026-06-09 scope-expansion dispatch DAG).
- **Test (integration):** the roster read through the SDK against the real Phase-3 services — a degraded/offline node remains visible and distinguishable from a healthy online node; a below-floor node's entry reads `readOnly: true`; the two health axes surface independently (a capability-`degraded` node with fresh heartbeats shows its presence axis verbatim).
- **Spec coverage:** Spec-003 line 132 (AC2 — distinguishability through the client roster read), line 133 (AC3 — multiple nodes coexist through the client), line 49 (multiple runtime nodes per session).
- **Verifies invariant:** none (SDK transport wrapper).

##### T5.1 — Node roster view (read + live health)

- **Files:** `apps/desktop/src/renderer/src/runtime-node-attach/NodeRoster.tsx` (new), `apps/desktop/src/renderer/src/runtime-node-attach/index.ts` (new — barrel export).
- **Step:** React component rendering the set of runtime nodes attached to the active session, visually distinguishing health states (`online` vs `degraded`/`offline`) and mixed-version status (at-floor vs below-floor read-only). Consumes session-scoped node state and `runtime_node.*` lifecycle events through the Spec-023 preload bridge ONLY — `window.sidekicks.controlPlane.call(...)` for the roster read and `window.sidekicks.daemon.subscribe(...)` for live health transitions; MUST NOT import the Node-side `runtimeNodeClient.ts` SDK or any `node:*` / `electron` module (renderer-untrusted boundary per `Spec-023 §Trust Stance`, statically enforced by `apps/desktop/eslint.config.mjs` `no-restricted-imports`). Declare the `window.sidekicks` ambient augmentation inline following the Plan-001 Phase 5 precedent (`apps/desktop/src/renderer/src/session-bootstrap/SessionBootstrap.tsx#SessionBootstrap`, then-lines 41-45). **(Corrected 2026-06-09: superseded — the ambient `window.sidekicks` augmentation has been renderer-wide in `apps/desktop/src/renderer/src/sidekicks-bridge.d.ts` since the Plan-002 Phase 6 T6.0 hoist, and `SessionBootstrap.tsx` now carries only a pointer comment (see `apps/desktop/src/renderer/src/session-bootstrap/SessionBootstrap.tsx#SessionBootstrap`), not the inline ambient block. T5.1 MUST NOT re-declare the ambient augmentation inline; it consumes the shared renderer-wide declaration.)**
- **Test:** (no automated component test this Phase — covered by the T5.4 manual smoke; automated coverage backfilled per BL-131, V1.1.)
- **Spec coverage:** Spec-003 line 132 (AC2 — degraded/offline distinguishable from healthy online), line 133 (AC3 — multiple nodes coexist without changing session identity), line 49 (multiple runtime nodes per session), line 77 (capability-validation failure keeps node degraded/offline, distinguishable from healthy).
- **Verifies invariant:** none (roster projection)

##### T5.2 — Attach flow + capability-declaration view

- **Files:** `apps/desktop/src/renderer/src/runtime-node-attach/AttachFlow.tsx` (new), `apps/desktop/src/renderer/src/runtime-node-attach/CapabilityDeclaration.tsx` (new), `apps/desktop/src/renderer/src/runtime-node-attach/index.ts` (extend — add barrel exports).
- **Step:** Renderer surface that initiates attach of a local runtime node into an already-live session (no session recreation) and renders the node's declared capabilities. Attach is presented as a step distinct from session-membership acceptance — the view MUST NOT couple attach to a membership mutation. The attach request and capability declaration flow through `window.sidekicks.controlPlane.call(...)` / `window.sidekicks.daemon.call(...)` ONLY (bridge, never direct daemon/control-plane access). Pending/resolved/rejected render states follow the `SessionBootstrap.tsx` three-state precedent, including the async-IIFE sync-throw normalization defense against the Tier-1-stub bridge shape.
- **Test:** (no automated component test this Phase — covered by the T5.4 manual smoke; automated coverage backfilled per BL-131, V1.1.)
- **Spec coverage:** Spec-003 line 131 (AC1 — attach a local runtime node to an active session), line 47 (attach is a separate step from membership acceptance), line 48 (attach includes node identity, capabilities, health, trust context), line 50 (attach must not require session recreation).
- **Verifies invariant:** I-003-3 (renderer surfaces attach and membership as distinct actions; does not couple attach to a `session_memberships` mutation).

##### T5.3 — Mixed-version status indicator (below-floor read-only surfacing)

- **Files:** `apps/desktop/src/renderer/src/runtime-node-attach/MixedVersionStatus.tsx` (new), `apps/desktop/src/renderer/src/runtime-node-attach/index.ts` (extend — add barrel export).
- **Step:** Indicator that surfaces a below-floor daemon's read-only attachment state and the typed `VERSION_FLOOR_EXCEEDED` outcome on a write attempt — the daemon remains visible/joined in the roster (admit-not-eject), and the indicator distinguishes "read-only (below floor)" from "full read/write (at floor)" and from "detached". All state is read through the bridge surface; the renderer does not re-derive floor logic (the version-floor verdict is computed by the Phase-3 control-plane service and consumed here as already-resolved state).
- **Test:** (no automated component test this Phase — covered by the T5.4 manual smoke; automated coverage backfilled per BL-131, V1.1.)
- **Spec coverage:** Spec-003 line 134 (AC4 — below-floor admitted read-only, write returns typed `VERSION_FLOOR_EXCEEDED`, never ejected for the floor mismatch), line 53 (control plane verifies daemon version against the floor).
- **Verifies invariant:** I-003-1 (renderer presents below-floor nodes as joined-but-read-only, never as ejected).

##### T5.4 — Manual two-client attach smoke (verification step, not an automated test)

- **Files:** (none — manual verification per the §Verification renderer-smoke step.)
- **Step:** Join a live session, attach one runtime node at the session `min_client_version` floor from one client, attach a second node below the floor from a sibling client. Verify through the desktop renderer that (a) the roster shows BOTH nodes (below-floor node is joined and visible, not ejected), (b) the below-floor node's writes surface typed `VERSION_FLOOR_EXCEEDED` in the mixed-version status indicator while reads continue to succeed, and (c) a node detach leaves the other node and session membership intact. This exercises I-003-1 and I-003-3 end-to-end through the renderer/bridge surface; the underlying floor/attach/membership semantics are already proven by the Phase-3/Phase-4 automated suite (P3, P4, P7, P8, I3) — this step verifies the renderer projection faithfully surfaces them, it does not re-prove the semantics.
- **Test:** manual two-client attach smoke; automated component/E2E coverage backfilled per BL-131 (V1.1).
- **Spec coverage:** Spec-003 line 131 (AC1), line 132 (AC2), line 134 (AC4), line 51 (detach/offline must not revoke membership), line 79 (node may reconnect under the same node identity).
- **Verifies invariant:** I-003-1 (end-to-end, bridge-routed), I-003-3 (detach leaves membership intact, observed through the renderer).

After Phase 4 lands green at Tier 3, Plan-003's load-bearing semantics are complete. Phase 5 ships at Tier 3 after Phase 4 — the renderer substrate from Plan-023 Tier 1 Partial is independently in place from Tier 1, so the gating reduces to Plan-003's own SDK readiness. Phase 5's acceptance rests on the manual two-client smoke (T5.4); automated renderer component / E2E coverage is a criterion-gated V1.1 backfill tracked as [BL-131](../backlog.md) — not a Tier-3 gate.

## Rollout Order

1. Ship local node registry and shared attach endpoint (Phase 1 + Phase 2 + Phase 3)
2. Enable heartbeats and node roster (Phase 3)
3. Wire client SDK and integration paths (Phase 4)
4. Enable desktop attach flow (Phase 5, Tier 3 — after Phase 4)

## Rollback Or Fallback

- Disable shared node attach and preserve `local-only` node usage if attach regressions appear.

## Risks And Blockers

- Stable node identity across reconnect needs careful design
- Capability declarations may drift from actual node health without refresh rules

## Progress Log

### Shipment Manifest

<!-- Machine-readable. Housekeeper-emitted, orchestrator-written, preflight-read.
     Schema authoritative in:
       .claude/skills/plan-execution/scripts/lib/manifest.mjs -->

```yaml
manifest_schema_version: 1
shipped:
  - phase: 1
    task: [T1.1, T1.2, T1.3, T1.4, T1.5, T1.6, T1.7]
    pr: 135
    sha: a08db3c
    merged_at: 2026-06-02
    files:
      - packages/contracts/src/__tests__/runtime-node.test.ts
      - packages/contracts/src/index.ts
      - packages/contracts/src/runtime-node.ts
      - packages/control-plane/src/migrations/__tests__/runtime-node-upstream-anchors.test.ts
      - packages/control-plane/vitest.config.ts
      - packages/runtime-daemon/src/migrations/0002-runtime-node.ts
      - packages/runtime-daemon/src/session/__tests__/migration-shape.test.ts
      - packages/runtime-daemon/src/session/__tests__/session-service.test.ts
      - packages/runtime-daemon/src/session/migration-runner.ts
    verifies_invariant: [I-003-1]
    spec_coverage:
      [
        "Spec-003 line 83",
        "Spec-003 line 53",
        "Spec-003 line 85",
        "Spec-003 line 84",
        "Spec-003 line 86",
        "Spec-006 lines 407-413",
        "Spec-003 AC4 line 134",
        "Spec-003 line 102",
      ]
  - phase: 2
    task: [T2.0, T2.1, T2.2, T2.3, T2.4, T2.5, T2.6]
    pr: 137
    sha: da95c62
    merged_at: 2026-06-03
    files:
      - docs/architecture/contracts/api-payload-contracts.md
      - docs/architecture/cross-plan-dependencies.md
      - docs/plans/003-runtime-node-attach.md
      - docs/plans/004-queue-steer-pause-resume.md
      - docs/plans/006-session-event-taxonomy-and-audit-log.md
      - docs/plans/008-control-plane-relay-and-session-join.md
      - packages/contracts/src/__tests__/runtime-node.test.ts
      - packages/contracts/src/runtime-node.ts
      - packages/runtime-daemon/src/node/__tests__/node-capability-service.test.ts
      - packages/runtime-daemon/src/node/__tests__/node-event-emitter.test.ts
      - packages/runtime-daemon/src/node/__tests__/node-registry.test.ts
      - packages/runtime-daemon/src/node/node-capability-service.ts
      - packages/runtime-daemon/src/node/node-event-emitter.ts
      - packages/runtime-daemon/src/node/node-registry.ts
    verifies_invariant: [I-003-2, I-003-4]
    spec_coverage:
      [
        "Spec-003 line 58",
        "Spec-003 line 59",
        "Spec-003 line 79 (reconnect-under-same-identity clause — a durable-row behavior; the active-membership-intact clause is the I-003-3 invariant verified control-plane-side at P7/P8 in Phase 3)",
        "Spec-003 line 102",
        "Spec-003 line 103",
        "Spec-003 line 120",
        "Spec-003 line 126",
        "Spec-006 lines 407, 408, 410, 412, 413",
        "api-payload-contracts.md §Plan-006 capability payload typing",
      ]
  - phase: 3
    task: [T3.0, T3.1, T3.2, T3.3, T3.4, T3.5, T3.6, T3.7, T3.8, T3.9]
    pr: 145
    sha: aee347e
    merged_at: 2026-06-09
    files:
      - docs/architecture/contracts/api-payload-contracts.md
      - docs/architecture/contracts/error-contracts.md
      - docs/plans/003-runtime-node-attach.md
      - docs/specs/003-runtime-node-attach.md
      - packages/client-sdk/test/sessionClient.integration.test.ts
      - packages/client-sdk/test/transport/sse-roundtrip.test.ts
      - packages/contracts/src/__tests__/error.test.ts
      - packages/contracts/src/__tests__/runtime-node.test.ts
      - packages/contracts/src/__tests__/session-event.test.ts
      - packages/contracts/src/error.ts
      - packages/contracts/src/event.ts
      - packages/contracts/src/runtime-node.ts
      - packages/control-plane/src/ais-wire-exception.ts
      - packages/control-plane/src/index.ts
      - packages/control-plane/src/migrations/0003-runtime-nodes.ts
      - packages/control-plane/src/migrations/__tests__/0002-session-invites.test.ts
      - packages/control-plane/src/migrations/__tests__/0003-runtime-nodes.test.ts
      - packages/control-plane/src/migrations/__tests__/migration-shape.test.ts
      - packages/control-plane/src/migrations/__tests__/runtime-node-upstream-anchors.test.ts
      - packages/control-plane/src/presence/__tests__/presence-register-service.test.ts
      - packages/control-plane/src/runtime-nodes/__tests__/attach-service.test.ts
      - packages/control-plane/src/runtime-nodes/__tests__/heartbeat-service.test.ts
      - packages/control-plane/src/runtime-nodes/__tests__/runtime-node-router.test.ts
      - packages/control-plane/src/runtime-nodes/attach-service.ts
      - packages/control-plane/src/runtime-nodes/errors.ts
      - packages/control-plane/src/runtime-nodes/heartbeat-service.ts
      - packages/control-plane/src/runtime-nodes/runtime-node-router.factory.ts
      - packages/control-plane/src/server/__tests__/_helpers.ts
      - packages/control-plane/src/server/__tests__/host-runtime-node.test.ts
      - packages/control-plane/src/server/host.ts
      - packages/control-plane/src/sessions/__tests__/migration-runner.test.ts
      - packages/control-plane/src/sessions/__tests__/session-directory-service.test.ts
      - packages/control-plane/src/sessions/errors.ts
      - packages/control-plane/src/sessions/migration-runner.ts
      - packages/control-plane/src/sessions/trpc.ts
    verifies_invariant: [I-003-1, I-003-2, I-003-3, I-003-5]
    spec_coverage:
      [
        "Spec-003 line 47",
        "Spec-003 line 49",
        "Spec-003 line 51",
        "Spec-003 line 52",
        "Spec-003 line 53",
        "Spec-003 line 58",
        "Spec-003 line 60",
        "Spec-003 line 61",
        "Spec-003 line 62",
        "Spec-003 line 66",
        "Spec-003 line 77",
        "Spec-003 line 102",
        "Spec-003 line 133",
        "Spec-003 line 134",
      ]
  - phase: 4
    task: [T4.1, T4.2, T4.3, T4.4]
    pr: 147
    sha: 3e27048
    merged_at: 2026-06-09
    files:
      - docs/plans/003-runtime-node-attach.md
      - packages/client-sdk/package.json
      - packages/client-sdk/src/index.ts
      - packages/client-sdk/src/runtimeNodeClient.ts
      - packages/client-sdk/test/runtimeNodeClient.integration.test.ts
      - pnpm-lock.yaml
    verifies_invariant: [I-003-1]
    spec_coverage:
      [
        "Spec-003 line 83",
        "Spec-003 line 84",
        "Spec-003 line 85",
        "Spec-003 line 86",
        "Spec-003 line 131",
        "Spec-003 line 50",
        "Spec-003 line 132 (capability-health axis per the in-PR T4.3 plan-row amendment, 2026-06-09)",
        "Spec-003 line 77",
        "Spec-003 line 73",
        "Spec-003 AC4 line 134",
      ]
    notes: |
      I2 verified on the client-observable capability-health axis per the in-PR T4.3 plan-row amendment (2026-06-09). The detach lifecycle leg (Spec-003 lines 86 + 70) and the 4-method daemon-transport breadth suite were added by the PR-final coverage review (commit e6df973).
  - phase: 5
    task: [T5.0a, T5.0b, T5.0c, T5.0d, T5.1, T5.2, T5.3]
    pr: 150
    sha: 8eb2a74
    merged_at: 2026-06-10
    files:
      - apps/desktop/src/renderer/src/runtime-node-attach/AttachFlow.tsx
      - apps/desktop/src/renderer/src/runtime-node-attach/CapabilityDeclaration.tsx
      - apps/desktop/src/renderer/src/runtime-node-attach/MixedVersionStatus.tsx
      - apps/desktop/src/renderer/src/runtime-node-attach/NodeRoster.tsx
      - apps/desktop/src/renderer/src/runtime-node-attach/index.ts
      - docs/architecture/contracts/api-payload-contracts.md
      - docs/architecture/cross-plan-dependencies.md
      - docs/architecture/schemas/shared-postgres-schema.md
      - docs/plans/003-runtime-node-attach.md
      - docs/plans/004-queue-steer-pause-resume.md
      - docs/plans/005-provider-driver-contract-and-capabilities.md
      - docs/plans/006-session-event-taxonomy-and-audit-log.md
      - docs/plans/008-control-plane-relay-and-session-join.md
      - docs/specs/003-runtime-node-attach.md
      - packages/client-sdk/src/runtimeNodeClient.ts
      - packages/client-sdk/test/runtimeNodeClient.integration.test.ts
      - packages/contracts/src/__tests__/runtime-node.test.ts
      - packages/contracts/src/runtime-node.ts
      - packages/control-plane/src/migrations/0003-runtime-nodes.ts
      - packages/control-plane/src/migrations/__tests__/0003-runtime-nodes.test.ts
      - packages/control-plane/src/runtime-nodes/__tests__/attach-service.test.ts
      - packages/control-plane/src/runtime-nodes/__tests__/runtime-node-router.test.ts
      - packages/control-plane/src/runtime-nodes/attach-service.ts
      - packages/control-plane/src/runtime-nodes/errors.ts
      - packages/control-plane/src/runtime-nodes/runtime-node-router.factory.ts
      - packages/control-plane/src/server/__tests__/host-runtime-node.test.ts
      - packages/runtime-daemon/src/node/__tests__/node-capability-service.test.ts
      - packages/runtime-daemon/src/node/__tests__/node-event-emitter.test.ts
      - packages/runtime-daemon/src/node/__tests__/node-registry.test.ts
      - packages/runtime-daemon/src/node/node-capability-service.ts
      - packages/runtime-daemon/src/node/node-event-emitter.ts
      - packages/runtime-daemon/src/node/node-registry.ts
    verifies_invariant: []
    spec_coverage:
      [
        "Spec-003 line 47",
        "Spec-003 line 48",
        "Spec-003 line 49",
        "Spec-003 line 50",
        "Spec-003 line 52",
        "Spec-003 line 53",
        "Spec-003 line 73",
        "Spec-003 line 77",
        "Spec-003 AC1 line 131",
        "Spec-003 AC2 line 132",
        "Spec-003 AC3 line 133",
        "Spec-003 AC4 line 134",
      ]
    notes: |
      T5.4 (manual two-client attach smoke) deliberately excluded from the task list: its Tier-8-gated disposition is recorded on PR #150 — the live two-client leg is impossible at Tier 1; the floor/attach/membership semantics are already proven by the Phase 1-4 automated suites; owner = user at Tier 8; automated renderer component/E2E coverage backfills per BL-131. Plan-003 plan-level status therefore stays `approved`. verifies_invariant is deliberately EMPTY (Codex P2, PR #151): the only Phase-5 rows carrying invariant markers — T5.2 (I-003-3) and T5.3 (I-003-1) — defer their verification to the T5.4 smoke per their own Test fields ("no automated component test this Phase — covered by the T5.4 manual smoke"), and T5.4 did not run, so recording them here would overstate renderer-projection verification. The service/SDK legs of both invariants remain verified by the Phase 3 and Phase 4 entries above; the renderer-projection legs verify when T5.4 runs at Tier 8 or the BL-131 backfill lands. spec_coverage is the union of the T5.0a-T5.3 `Spec coverage:` fields.
```

### Notes

<!-- Per-PR human-readable commentary appended by the orchestrator at Phase E. -->

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
