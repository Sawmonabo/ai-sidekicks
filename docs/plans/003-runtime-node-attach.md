# Plan-003: Runtime Node Attach

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `003` |
| **Slug** | `runtime-node-attach` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-003: Runtime Node Attach](../specs/003-runtime-node-attach.md) |
| **Required ADRs** | [ADR-001](../decisions/001-session-is-the-primary-domain-object.md), [ADR-002](../decisions/002-local-execution-shared-control-plane.md), [ADR-007](../decisions/007-collaboration-trust-and-permission-model.md), [ADR-008](../decisions/008-default-transports-and-relay-boundaries.md), [ADR-015](../decisions/015-v1-feature-scope-definition.md), [ADR-018](../decisions/018-cross-version-compatibility.md) |
| **Dependencies** | [Plan-001](./001-shared-session-core.md) (session model, `runtime_node_attachments`/`runtime_node_presence` Postgres tables, forward-declared `session_events` integrity columns); [Plan-006](./006-session-event-taxonomy-and-audit-log.md) (`runtime_node.*` event taxonomy registration at Tier 4 — Plan-003 emits 7 events at Tier 3 as event-shape stubs against the Plan-001 forward-declared columns; full taxonomy registration is an additive Plan-006 follow-up at Tier 4); [Plan-008 bootstrap-deliverable](./008-control-plane-relay-and-session-join.md) (Tier 1 tRPC v11 `sessionRouter` substrate — Plan-003's runtime-node attach calls cross the same control-plane transport). See [cross-plan-dependencies.md §3 Plan-003 row](../architecture/cross-plan-dependencies.md#3-inter-plan-dependency-graph). [Spec-024](../specs/024-cross-node-dispatch-and-approval.md) is **not** a dependency for Plan-003 — historical Session H-interim header reference; cross-node dispatch implementation belongs to [Plan-027](./027-cross-node-dispatch-and-approval.md) per [cross-plan-dependencies.md §Spec-024 Implementation Plan](../architecture/cross-plan-dependencies.md#spec-024-implementation-plan). |
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

The following invariants are **load-bearing** and MUST be preserved across all Plan-003 PRs and downstream extensions. Violations break Spec-003 acceptance criteria, ADR-018 §Decision #4 cross-version semantics, and ADR-007 trust-model expectations.

### I-003-1 — Attach is admit-not-eject for below-floor daemons

A daemon attaching with a `client_version` below the session's `min_client_version` floor MUST be admitted in read-only state — the daemon remains joined and may read session state. Any subsequent write attempt by that daemon MUST return typed `VERSION_FLOOR_EXCEEDED` per [ADR-018 §Decision #4](../decisions/018-cross-version-compatibility.md). Ejection MUST NOT be the response to a floor mismatch (graceful degradation, not ejection — Spec-003 §Required Behavior line 53; AC4 line 104).

**Why load-bearing.** Ejection breaks the cross-version-compatibility contract: a participant on a slightly-old daemon would lose all session visibility, not just write capability. ADR-018 §Decision #4 explicitly chose graceful degradation over ejection so that a session with mixed-version daemons remains coherent.

**Verification.** Test must assert that a `RuntimeNodeAttach` with a below-floor `client_version` returns success with read-only attachment state, the daemon receives subsequent reads, and only the next write attempt returns `VERSION_FLOOR_EXCEEDED`. The attach event MUST NOT detach the node.

### I-003-2 — Online state requires capability declaration

A newly attached runtime node MUST default to non-online state (e.g., `pending`/`degraded`) until the capability declaration succeeds. `runtime_node.online` MUST emit only after `runtime_node.capability_declared` (Spec-003 §Default Behavior line 57; §Implementation Notes line 89).

**Why load-bearing.** Marking a node online before capability validation succeeds would expose unvalidated capabilities to scheduler routing. Spec-003 explicitly forbids "implicit capability exposure on attach" (§Pitfalls line 96) — this invariant is the structural enforcement.

**Verification.** Test must assert that `runtime_node.online` is never emitted until after a `runtime_node.capability_declared` event lands for the same node id.

### I-003-3 — Attach is separate from membership

`RuntimeNodeAttach` MUST NOT modify session_memberships, and `MembershipUpdate` MUST NOT trigger runtime-node detach as a side effect. Membership and node attach are independent surfaces that share a participant identity but otherwise compose orthogonally (Spec-003 §Required Behavior line 47).

**Why load-bearing.** Conflating membership and attach would invert the trust-model — accepting an invite would auto-attach a runtime node (security violation per Spec-002 §Pitfalls "Auto-attaching runtime nodes as part of invite acceptance"). Conversely, a runtime-node detach would revoke membership (breaks audit trail).

**Verification.** Test must assert that (a) `RuntimeNodeAttach` succeeds without any `session_memberships` mutation and (b) detaching a node leaves `session_memberships` unchanged. The audit-trail event sequence must show attach/detach and membership changes as distinct.

### I-003-4 — `monotonic_ns` is debug data, not the replay key

Plan-003's `runtime_node.*` event emission writes the `monotonic_ns` column (per Plan-001 forward-declared schema), but Plan-003 MUST NOT use `monotonic_ns` as the replay or ordering key — see [Plan-001 §Invariants I-001-2](./001-shared-session-core.md#invariants). Sequence is the canonical replay key.

**Why load-bearing.** Same reason as Plan-001 I-001-2 — clock-skew defense.

**Verification.** Inherits Plan-001's D3 test; Plan-003 PRs that add `runtime_node.*` event emission must not introduce code paths that read `monotonic_ns` for ordering decisions.

## Cross-Plan Obligations

Plan-003 declares the following obligations on adjacent plans. Implementation of Plan-003 cannot proceed (or must defer specific surfaces) without these being satisfied or explicitly staged.

### CP-003-1 — Plan-006 owns `runtime_node.*` event taxonomy registration

Plan-003 emits 7 `runtime_node.*` events at Tier 3 against the column shape Plan-001 forward-declares (the integrity-protocol columns per [cross-plan-dependencies.md §1 Contested integrity row](../architecture/cross-plan-dependencies.md#1-table-ownership-map)). The semantics of the event taxonomy — `EventEnvelope` schema, BLAKE3 hash chain, dual-signature mechanics, JCS canonical serialization — are owned by [Plan-006 (Session Event Taxonomy And Audit Log)](./006-session-event-taxonomy-and-audit-log.md) at Tier 4.

**Resolution.** Plan-003 at Tier 3 ships **event-shape stubs only**: writes that conform to the column shape Plan-001 declared, with `monotonic_ns` populated and `prev_hash`/`row_hash`/`daemon_signature` fields written but not validated against the chain (because the verifier code path doesn't exist until Plan-006 lands). Plan-006 at Tier 4 lands the verifier and the canonical writer; an additive Tier 4 follow-up backfills any retroactive validation needed against rows Plan-003 emitted at Tier 3. The taxonomy entries themselves register at Tier 4 in Plan-006.

**Why this is the safe staging.** Re-shaping Plan-003's event emission post-Tier-4 is forbidden by Plan-001 §Invariants I-001-3 (forward-declared columns are immutable in scope at Tier 1). Therefore Plan-003 at Tier 3 must write into the column shape correctly even though full taxonomy semantics aren't registered yet.

### CP-003-2 — Plan-008 bootstrap surfaces the control-plane attach transport

`RuntimeNodeAttach`, `RuntimeNodeHeartbeat`, `RuntimeNodeCapabilityUpdate`, and `RuntimeNodeDetach` cross the control-plane tRPC transport that Plan-008-bootstrap ships at Tier 1. Plan-003 cannot run without this substrate — the routes must register on the existing `sessionRouter` skeleton (or a sibling `runtimeNodeRouter` that hangs off the same Cloudflare Workers host per [ADR-014](../decisions/014-trpc-control-plane-api.md) and Plan-008 BL-104 resolution 2026-04-30) per [cross-plan-dependencies.md §3 Plan-003 row](../architecture/cross-plan-dependencies.md#3-inter-plan-dependency-graph).

**Resolution.** Plan-008-bootstrap at Tier 1 already shipped the tRPC v11 server skeleton; Plan-003 at Tier 3 adds its routes under that skeleton. No new infrastructure work; just route registration.

## Preconditions

- [x] Paired spec is approved
- [x] Required ADRs are accepted
- [x] Blocking open questions are resolved or explicitly deferred

Target paths below assume the canonical implementation topology defined in [Container Architecture](../architecture/container-architecture.md).

## Target Areas

- `packages/contracts/src/runtimeNode.ts`
- `packages/runtime-daemon/src/node/node-registry.ts`
- `packages/runtime-daemon/src/node/node-capability-service.ts`
- `packages/control-plane/src/runtime-nodes/`
- `packages/client-sdk/src/runtimeNodeClient.ts`
- `apps/desktop/src/renderer/src/runtime-node-attach/`

## Data And Storage Changes

- Add shared `runtime_node_attachments` and `runtime_node_presence` tables.
- Add local `node_capabilities` and `node_trust_state` persistence.
- See [Local SQLite Schema](../architecture/schemas/local-sqlite-schema.md) for column definitions.
- See [Shared Postgres Schema](../architecture/schemas/shared-postgres-schema.md) for column definitions.

## API And Transport Changes

- Add `RuntimeNodeAttach`, `RuntimeNodeHeartbeat`, `RuntimeNodeCapabilityUpdate`, and `RuntimeNodeDetach` to the client SDK and control-plane contracts.
- `RuntimeNodeAttach` payload carries the daemon's `client_version` string; the control plane validates it against `sessions.min_client_version` and **admits** below-floor daemons in read-only state per [ADR-018](../decisions/018-cross-version-compatibility.md) §Decision #4 — the daemon remains joined and may read session state, but any subsequent write attempt MUST return typed `VERSION_FLOOR_EXCEEDED`. Ejection MUST NOT be the response to a floor mismatch (graceful degradation, not ejection — see [Spec-003 §Required Behavior line 53](../specs/003-runtime-node-attach.md#required-behavior) and §Invariants I-003-1).

## Event Emission

Plan-003 is the canonical emitter of the 7 `runtime_node.*` events in the `runtime_node_lifecycle` category defined in [Spec-006 §Runtime Node Lifecycle](../specs/006-session-event-taxonomy-and-audit-log.md):

- `runtime_node.registered` — RuntimeNode registered to the daemon registry.
- `runtime_node.online` — RuntimeNode passed presence heartbeat and is attached to a session.
- `runtime_node.degraded` — RuntimeNode is attached but capability health is reduced (missed heartbeats under threshold, partial provider driver failure, etc.).
- `runtime_node.offline` — RuntimeNode missed presence heartbeat beyond threshold; no longer receives dispatch.
- `runtime_node.revoked` — RuntimeNode trust state flipped to `revoked` per [ADR-007](../decisions/007-collaboration-trust-and-permission-model.md); attach is refused.
- `runtime_node.capability_declared` — Initial capability declaration on attach (provider drivers, resource class, version info).
- `runtime_node.capability_updated` — Capability declaration change mid-session (driver added/removed, health change).

The remaining 2 events in the `runtime_node_lifecycle` category — `session.clock_unsynced` and `session.clock_corrected` — describe daemon-host clock state observed at the NTP sync probe and are emitted by [Plan-015 (Persistence, Recovery, Replay)](./015-persistence-recovery-and-replay.md), which owns that probe. These 2 events preserve their `session.*` wire names (category reclassification only, not rename) per [ADR-018](../decisions/018-cross-version-compatibility.md) §Decision #8 (MINOR envelope bumps are additive-only; renaming event types is explicitly forbidden) — a rename would break readers on prior MINOR versions within the same MAJOR. Category moves are safe because the `category` field is a classification facet, not a wire-identity key — readers dispatch on event name.

## Implementation Steps

- Contracts: See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed schemas this plan consumes.
- Steps 1–3 land at Tier 3 (Plan-003's canonical tier). Step 4 (renderer integration) is **blocked until Tier 8** because `apps/desktop/src/renderer/` does not exist until Plan-023 ships at Tier 8 — see [cross-plan-dependencies.md §2 `apps/desktop/src/renderer/` row](../architecture/cross-plan-dependencies.md#2-package-path-ownership-map) and §Execution Windows below. Plan-003 ships steps 1–3 at Tier 3; step 4 is added as a follow-up PR at Tier 8 once the renderer tree exists.

1. **[Tier 3]** Define node contracts and migration shape.
2. **[Tier 3]** Implement Local Runtime Daemon node registry and capability declaration service; emit the 7 `runtime_node.*` events above through the canonical session-event append path. Per §Invariants I-003-2, `runtime_node.online` MUST emit only after `runtime_node.capability_declared` succeeds. Per §Cross-Plan Obligations CP-003-1, events are shipped as event-shape stubs against the Plan-001 forward-declared integrity columns; Plan-006 at Tier 4 lands the verifier and the canonical writer.
3. **[Tier 3]** Implement Collaboration Control Plane RuntimeNode attach and presence services. **Per [Spec-003 §Required Behavior line 53](../specs/003-runtime-node-attach.md#required-behavior):** at attach, the control plane MUST verify the daemon's reported version against the session's `min_client_version` floor. A NULL floor permits all daemons. A daemon below the floor MUST be admitted in read-only state — the daemon remains joined and may read session state, but any subsequent write attempt MUST return typed `VERSION_FLOOR_EXCEEDED` per [ADR-018 §Decision #4](../decisions/018-cross-version-compatibility.md). Ejection MUST NOT be the response to a floor mismatch (graceful degradation, not ejection — per §Invariants I-003-1).
4. **[Tier 8 — blocked until Plan-023 ships]** Add desktop attach flow and session node roster UI under `apps/desktop/src/renderer/src/runtime-node-attach/` (per [cross-plan-dependencies.md §2 row for `apps/desktop/src/renderer/`](../architecture/cross-plan-dependencies.md#2-package-path-ownership-map)). This step lands as a follow-up PR sequenced after Plan-023.

## Execution Windows

Plan-003's steps cross two execution tiers:

- **Tier 3 window** (canonical Plan-003 tier): steps 1–3 ship as Phase sequence below. Surfaces all node-attach/capability/presence/version-floor behavior over the Plan-008-bootstrap Tier 1 substrate.
- **Tier 8 window** (renderer follow-up): step 4 ships as a single PR after Plan-023 creates `apps/desktop/src/renderer/` at Tier 8. The renderer subtree at `apps/desktop/src/renderer/src/runtime-node-attach/` is the only deliverable in this window.

Splitting prevents Plan-003 from being parked at Tier 3 waiting five tiers for the renderer to exist; the attach/capability semantics are the load-bearing surface and ship at Tier 3.

## Parallelization Notes

- Local node registry and shared control-plane attach services can proceed in parallel.
- Desktop attach UI should wait for stable capability payloads.

## Test And Verification Plan

The TDD test list below is enumerated and ordered by implementation dependency. Each test maps to one or more [Spec-003 acceptance criteria](../specs/003-runtime-node-attach.md#acceptance-criteria) and Spec-003 §Required Behavior MUSTs. Tests run via Vitest 4.x projects per [ADR-022](../decisions/022-v1-toolchain-selection.md).

### Contract Layer (`packages/contracts/`)

| ID | Test | Asserts | Spec-003 AC / MUST |
| --- | --- | --- | --- |
| C1 | `RuntimeNodeAttach payload validates required fields including client_version` | request schema | line 56, 69 |
| C2 | `RuntimeNodeCapabilityUpdate payload supports add/remove/health-change variants` | mutation contract | line 71 |
| C3 | `RuntimeNodeDetach payload validates session id + node id + reason` | retire contract | line 72 |
| C4 | `runtime_node.* event names exactly match the 7-event taxonomy in Spec-006` | taxonomy conformance | line 60 |
| C5 | `VERSION_FLOOR_EXCEEDED error contract matches ADR-018 typed shape` | error contract | line 53, AC4 |

### Daemon Layer (`packages/runtime-daemon/src/node/`)

| ID | Test | Asserts | Spec-003 AC / MUST |
| --- | --- | --- | --- |
| D1 | `Node registry persists node identity across daemon restart` | stable identity (Spec-003 line 90) | AC1 |
| D2 | `Capability declaration service emits runtime_node.capability_declared on success` | event emission | line 67 |
| D3 | `runtime_node.online MUST NOT emit until runtime_node.capability_declared lands` | I-003-2 ordering invariant | I-003-2, line 57 |
| D4 | `Detach emits runtime_node.offline; subsequent reconnect under same node id succeeds` | reconnect identity | line 65, line 90 |
| D5 | `Event emission writes monotonic_ns into Plan-001 forward-declared column shape` | CP-003-1 shape conformance | CP-003-1 |
| D6 | `Replay code paths do not read monotonic_ns for ordering — sequence is the canonical key` | I-003-4 inherits I-001-2 | I-003-4 |

### Control Plane Layer (`packages/control-plane/src/runtime-nodes/`)

| ID | Test | Asserts | Spec-003 AC / MUST |
| --- | --- | --- | --- |
| P1 | `RuntimeNodeAttach with NULL min_client_version floor admits all daemon versions` | NULL-floor permissive | line 53 |
| P2 | `RuntimeNodeAttach with client_version >= floor admits with full read/write` | happy-path floor | line 53, AC4 |
| P3 | `RuntimeNodeAttach with client_version < floor admits in read-only state — node remains joined and reads succeed` | I-003-1 admit-in-read-only invariant | I-003-1, line 53 |
| P4 | `Read-only-attached daemon's subsequent write attempt returns typed VERSION_FLOOR_EXCEEDED; node remains joined (no detach)` | I-003-1 admit-not-eject invariant | I-003-1, AC4 |
| P5 | `Multiple runtime nodes can attach to the same session without changing session identity` | multi-node co-existence | AC3, line 49 |
| P6 | `Heartbeat ingestion updates runtime_node_presence; missed heartbeat past threshold emits runtime_node.degraded then offline` | health transitions | line 64–65 |
| P7 | `RuntimeNodeAttach MUST NOT mutate session_memberships` | I-003-3 attach-membership-separation | I-003-3, line 47 |
| P8 | `RuntimeNodeDetach leaves session_memberships unchanged` | I-003-3 attach-membership-separation | I-003-3, line 51 |

### SDK And Integration Layer (`packages/client-sdk/`, integration)

| ID | Test | Asserts | Spec-003 AC / MUST |
| --- | --- | --- | --- |
| I1 | `Participant joins live session, then attaches local runtime node — session not recreated` | live attach | AC1, line 50 |
| I2 | `Degraded node remains visible and distinguishable from healthy online node in roster` | degraded visibility | AC2 |
| I3 | `Mixed-version attach scenario: one daemon at floor, one below — both joined; below-floor blocked on write only` | I-003-1 end-to-end | I-003-1, AC4 |

### Verification

- `pnpm turbo test` at workspace root green across all packages
- Manual smoke: join a live session from one client, attach one runtime node, then attach a second node from a sibling client and verify roster shows both (Tier 8 follow-up after step 4 ships)
- All 22 enumerated tests above pass before Plan-003 Tier 3 PRs are marked complete; renderer-step tests (Tier 8 follow-up) gate the Tier 8 PR independently

## Implementation Phase Sequence

Plan-003 implementation lands as a sequence of small PRs. Tier 3 PRs ship steps 1–3; the Tier 8 PR is a follow-up after Plan-023 ships the renderer tree. Note: Plan-003 may run in parallel with Plan-002 at Tier 2 if PR scheduling permits — both depend only on Plan-001 completion (per [cross-plan-dependencies.md §5 Optimization Notes](../architecture/cross-plan-dependencies.md#optimization-notes)).

### Phase 1 — Node Contracts + Migrations

**Precondition:** Plan-001 complete (Tier 1 substrate carve-outs + Plan-001's `runtime_node_attachments`/`runtime_node_presence` Postgres tables + forward-declared `session_events` integrity columns in place).

**Goal:** Tests C1–C5 go green; SQLite migration for `node_capabilities`/`node_trust_state` and Postgres reads against the Plan-001 attach tables work cleanly.

- `packages/contracts/src/runtimeNode.ts` — `RuntimeNodeAttach`, `RuntimeNodeHeartbeat`, `RuntimeNodeCapabilityUpdate`, `RuntimeNodeDetach` payloads
- `packages/contracts/src/error.ts` — `VERSION_FLOOR_EXCEEDED` typed error shape per ADR-018 §Decision #4
- Local SQLite migration (Plan-003-owned): `node_capabilities`, `node_trust_state`
- Confirm Plan-001 already created `runtime_node_attachments` + `runtime_node_presence` (Plan-003 reads, does not CREATE)

### Phase 2 — Daemon Node Registry + Capability Service

**Precondition:** Phase 1 merged.

**Goal:** Tests D1–D6 go green.

- `packages/runtime-daemon/src/node/node-registry.ts` — node identity, registration, persistence across restart
- `packages/runtime-daemon/src/node/node-capability-service.ts` — declaration validation; emits `runtime_node.capability_declared`
- Event emission paths for the 7 `runtime_node.*` events through the canonical session-event append path; per CP-003-1 ship as event-shape stubs against the Plan-001 forward-declared columns
- I-003-2 ordering: `runtime_node.online` only after `runtime_node.capability_declared` succeeds

### Phase 3 — Control-Plane Attach + Heartbeat Services + Version-Floor Enforcement

**Precondition:** Phase 2 merged.

**Goal:** Tests P1–P8 go green; cross-version-compatibility surface works end-to-end.

- `packages/control-plane/src/runtime-nodes/attach-service.ts` — attach flow that reads `sessions.min_client_version` and applies the I-003-1 admit-in-read-only logic per Spec-003 line 53. Below-floor daemons remain joined; subsequent writes return `VERSION_FLOOR_EXCEEDED`.
- `packages/control-plane/src/runtime-nodes/heartbeat-service.ts` — presence ingestion, degraded/offline transitions
- I-003-3 enforcement: attach/detach paths MUST NOT mutate `session_memberships` (and vice versa)
- Routes register on the Plan-008-bootstrap tRPC `sessionRouter` substrate (or sibling `runtimeNodeRouter`) per CP-003-2

### Phase 4 — Client SDK Runtime-Node Surface + Integration

**Precondition:** Phase 3 merged.

**Goal:** Tests I1–I3 go green; mixed-version attach scenario works end-to-end.

- `packages/client-sdk/src/runtimeNodeClient.ts` — wraps attach/heartbeat/capability/detach over the daemon and control-plane transports
- Integration tests for live attach, multi-node co-existence, mixed-version below-floor read-only behavior

### Phase 5 — Renderer (Tier 8 Follow-Up)

**Precondition:** Plan-023 complete (`apps/desktop/src/renderer/` exists). Sequenced at Tier 8 per §Execution Windows above.

**Goal:** Step 4 ships; manual two-client attach smoke passes (one client at floor, one below — verify both visible in roster, below-floor blocked on write).

- `apps/desktop/src/renderer/src/runtime-node-attach/` — renderer views for attach flow, capability declaration, node roster, mixed-version status indicators (thin projection over the Spec-023 preload-bridge `window.sidekicks` surface; MUST NOT bypass the bridge to reach daemon or control-plane state directly)

After Phase 4 lands green at Tier 3, Plan-003's load-bearing semantics are complete. Phase 5 ships at Tier 8 as a renderer follow-up.

## Rollout Order

1. Ship local node registry and shared attach endpoint (Phase 1 + Phase 2 + Phase 3)
2. Enable heartbeats and node roster (Phase 3)
3. Wire client SDK and integration paths (Phase 4)
4. Enable desktop attach flow (Phase 5, Tier 8 follow-up)

## Rollback Or Fallback

- Disable shared node attach and preserve `local-only` node usage if attach regressions appear.

## Risks And Blockers

- Stable node identity across reconnect needs careful design
- Capability declarations may drift from actual node health without refresh rules

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
