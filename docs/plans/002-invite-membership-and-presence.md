# Plan-002: Invite Membership And Presence

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `002` |
| **Slug** | `invite-membership-and-presence` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-002: Invite Membership And Presence](../specs/002-invite-membership-and-presence.md) |
| **Required ADRs** | [ADR-001](../decisions/001-session-is-the-primary-domain-object.md), [ADR-002](../decisions/002-local-execution-shared-control-plane.md), [ADR-007](../decisions/007-collaboration-trust-and-permission-model.md), [ADR-008](../decisions/008-default-transports-and-relay-boundaries.md), [ADR-015](../decisions/015-v1-feature-scope-definition.md), [ADR-018](../decisions/018-cross-version-compatibility.md) |
| **Dependencies** | [Plan-001](./001-shared-session-core.md) (session tables, `session_memberships` schema); [Plan-007 partial-deliverable](./007-local-ipc-and-daemon-control.md) (Tier 1 Spec-007 §Wire Format substrate — Plan-002 registers the `presence.*` JSON-RPC method namespace under it); [Plan-008 bootstrap-deliverable](./008-control-plane-relay-and-session-join.md) (Tier 1 tRPC v11 server skeleton — hosts Plan-002's invite/membership tRPC routes once Plan-002 ships at Tier 2). See [cross-plan-dependencies.md §3 Plan-002 row](../architecture/cross-plan-dependencies.md#3-inter-plan-dependency-graph). [Spec-024](../specs/024-cross-node-dispatch-and-approval.md) is **not** a dependency for Plan-002 — historical Session H-interim header reference; cross-node dispatch implementation belongs to [Plan-027](./027-cross-node-dispatch-and-approval.md) per [cross-plan-dependencies.md §Spec-024 Implementation Plan](../architecture/cross-plan-dependencies.md#spec-024-implementation-plan). |
| **Cross-Plan Deps** | [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md) |
| **References** | [Spec-002 presence amendments](../specs/002-invite-membership-and-presence.md) (Yjs Awareness, Postgres LISTEN/NOTIFY), [ADR-010](../decisions/010-paseto-webauthn-mls-auth.md) (auth model) |

## Goal

Implement durable invites, membership state, and participant presence tracking for live sessions.

## Scope

This plan covers invite create or accept or revoke flows, membership storage, presence heartbeats, and session participant projections.

## Non-Goals

- Runtime-node attach
- Full identity-provider integration breadth
- Notification fan-out beyond minimal invite and presence updates

## Invariants

The following invariants are **load-bearing** and MUST be preserved across all Plan-002 PRs and downstream extensions. Violations break Spec-002 acceptance criteria and the audit/permission model declared by [ADR-007](../decisions/007-collaboration-trust-and-permission-model.md).

### I-002-1 — Owner elevation requires an existing owner

`MembershipUpdate` with `action=change_role` and `newRole=owner` MUST be issued by an existing owner. The target MUST already hold active membership (Spec-002 §Required Behavior line 49). A non-owner cannot self-elevate; an invitee in a non-owner role cannot be promoted to owner during invite acceptance.

**Why load-bearing.** Owner elevation is the trust-model load-bearing surface declared by ADR-007. Allowing self-elevation or invite-time promotion would invert the permission graph.

**Verification.** Test must assert that a non-owner caller's `MembershipUpdate{action=change_role, newRole=owner}` returns the typed permission error and does not mutate `session_memberships`.

### I-002-2 — Last-owner-cannot-leave

The system MUST prevent the last remaining owner from leaving a session (Spec-002 §Required Behavior line 50). A self-leave attempt by the sole owner MUST return a typed error directing the owner to transfer ownership first; `session_memberships` MUST NOT be mutated.

**Why load-bearing.** A session with zero owners is unrecoverable — no participant can issue further `MembershipUpdate` calls or transfer ownership. This is a one-way door.

**Verification.** Test must assert that a sole-owner self-leave attempt returns the typed error and the owner row remains in `session_memberships` unchanged.

### I-002-3 — Presence is ephemeral, never persisted

Presence state (Yjs Awareness CRDT) MUST live in memory only and MUST be garbage-collected on disconnect (Spec-002 §Default Behavior line 58, §State And Data Implications line 156). Plan-002 MUST NOT add a SQLite or Postgres table that stores presence rows.

**Why load-bearing.** Persisting presence creates a stale-state surface (rows survive the disconnect that should have garbage-collected them) and conflates ephemeral CRDT state with durable membership. Audit-relevant presence transitions (`presence.online`, `presence.idle`, `presence.reconnecting`, `presence.offline`) are emitted as `session_events` per Spec-006 — that event log is the durable surface; the live CRDT state is not.

**Verification.** §Data And Storage Changes already declares "Presence data is ephemeral... must NOT be persisted to a durable table." Schema-shape regression test asserts no presence-state table is created by Plan-002 migrations.

### I-002-4 — Lock-ordering inherits from Plan-001

Plan-002 transactional callers that mutate `session_memberships` while validating `sessions` MUST follow the lock-ordering invariant `sessions` → `session_memberships` declared in [Plan-001 §Invariants I-001-1](./001-shared-session-core.md#invariants). Owner-transfer, co-owner promotion, and invite-accept paths are the canonical Plan-002 callers under this constraint.

**Why load-bearing.** Cross-plan deadlocks under concurrent membership churn — the exact failure mode the Plan-001 docstring documents.

**Verification.** Each Plan-002 transactional caller extends the existing lock-ordering test in `packages/control-plane/src/sessions/__tests__/session-directory-service.test.ts` (or a sibling test under `packages/control-plane/src/memberships/__tests__/`) with an assertion that lock acquisition matches the canonical order.

## Preconditions

- [x] Paired spec is approved
- [x] Required ADRs are accepted
- [x] Blocking open questions are resolved or explicitly deferred

Target paths below assume the canonical implementation topology defined in [Container Architecture](../architecture/container-architecture.md).

## Target Areas

- `packages/contracts/src/invites.ts`
- `packages/control-plane/src/invites/`
- `packages/control-plane/src/memberships/`
- `packages/control-plane/src/presence/`
- `packages/client-sdk/src/membershipClient.ts`
- `apps/desktop/src/renderer/src/session-members/`

## Data And Storage Changes

- Add shared `session_invites` table (CREATE).
- Extend `session_memberships` (owner: Plan-001 per [cross-plan-dependencies.md §1 Contested](../architecture/cross-plan-dependencies.md#1-table-ownership-map) row for `session_memberships` — Plan-002 ALTER/USE adds invite-driven membership flows).
- Presence data is ephemeral (Yjs Awareness CRDT, in-memory only) and must NOT be persisted to a durable table.
- See [Shared Postgres Schema](../architecture/schemas/shared-postgres-schema.md) for column definitions.

## API And Transport Changes

- Add invite CRUD endpoints, membership update endpoints, and presence heartbeat transport to the client SDK.
- Add `ChannelList` read-only projection per [Spec-002 line 86](../specs/002-invite-membership-and-presence.md#interfaces-and-contracts). Request: `{sessionId: SessionId}`. Response: `{channels: Array<{id: ChannelId, name?: string, state: ChannelState, participantCount: number}>}`. Channels are bootstrapped at session create by Plan-001's `ChannelCreated` event (default channel); runtime channel creation (`ChannelCreate`) is owned by [Plan-016](./016-multi-agent-channels-and-orchestration.md) at Tier 6. `ChannelList` projects whatever channels currently exist regardless of who created them.
- Register the `presence.*` JSON-RPC method namespace (`PresenceUpdate`, `PresenceRead`) under the Plan-007-partial wire substrate per [Spec-002 §Heartbeat Transport](../specs/002-invite-membership-and-presence.md#heartbeat-transport). Plan-002 owns the namespace handlers and Zod schemas; the substrate (framing, error model, supervision hooks) is owned by Plan-007-partial.

## Implementation Steps

- Contracts: See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed schemas this plan consumes.
- Steps 1–3 land at Tier 2 (Plan-002's canonical tier). Step 4 (renderer integration) is **blocked until Tier 8** because `apps/desktop/src/renderer/` does not exist until Plan-023 ships at Tier 8 — see [cross-plan-dependencies.md §2 `apps/desktop/src/renderer/` row](../architecture/cross-plan-dependencies.md#2-package-path-ownership-map) and §Execution Windows below. Plan-002 ships steps 1–3 at Tier 2; step 4 is added as a follow-up PR at Tier 8 once the renderer tree exists.

1. **[Tier 2]** Implement invite and membership contracts plus migrations. Invite tokens use PASETO v4 (see ADR-010). Define the four invite lifecycle states: `pending`, `accepted`, `revoked`, `expired`. Declining is implicit in V1 (unopened invites expire); no explicit `declined` state is required.
2. **[Tier 2]** Build control-plane services for invite issuance, acceptance, revocation, and role update. Owner-elevation and last-owner-cannot-leave checks (per §Invariants I-002-1, I-002-2) gate the `MembershipUpdate` paths. Lock-ordering inherits from Plan-001 (per §Invariants I-002-4).
3. **[Tier 2]** Add participant presence heartbeat ingestion and summary projection. Use Yjs Awareness (`y-protocols/awareness`) as the presence CRDT; fan out updates via Postgres LISTEN/NOTIFY in V1. Expose `PresenceUpdate` and `PresenceRead` JSON-RPC methods for local IPC bridging under the Plan-007-partial wire substrate. Default heartbeat timing: 15 s heartbeat interval, 45 s grace period before marking a participant offline. Presence MUST remain in-memory only (per §Invariants I-002-3). Add `ChannelList` read-only projection per §API And Transport Changes.
4. **[Tier 8 — blocked until Plan-023 ships]** Integrate desktop invite acceptance and participant roster surfaces under `apps/desktop/src/renderer/src/session-members/` (per [cross-plan-dependencies.md §2 row for `apps/desktop/src/renderer/`](../architecture/cross-plan-dependencies.md#2-package-path-ownership-map)). This step lands as a follow-up PR sequenced after Plan-023.

## Execution Windows

Plan-002's steps cross two execution tiers:

- **Tier 2 window** (canonical Plan-002 tier): steps 1–3 ship as Phase sequence below. Surfaces all invite/membership/presence behavior and the `ChannelList` projection over the Plan-007-partial + Plan-008-bootstrap Tier 1 substrate.
- **Tier 8 window** (renderer follow-up): step 4 ships as a single PR after Plan-023 creates `apps/desktop/src/renderer/` at Tier 8. The renderer subtree at `apps/desktop/src/renderer/src/session-members/` is the only deliverable in this window.

Splitting prevents Plan-002 from being parked at Tier 2 waiting six tiers for the renderer to exist; the membership/presence semantics are the load-bearing surface and ship at Tier 2.

## Parallelization Notes

- Invite service and presence service can be implemented in parallel after shared identity assumptions are fixed.
- Desktop roster and invite UI should follow stable projection payloads.

## Test And Verification Plan

The TDD test list below is enumerated and ordered by implementation dependency. Each test maps to one or more [Spec-002 acceptance criteria](../specs/002-invite-membership-and-presence.md#acceptance-criteria) and Spec-002 §Required Behavior MUSTs. Tests run via Vitest 4.x projects per [ADR-022](../decisions/022-v1-toolchain-selection.md).

### Contract Layer (`packages/contracts/`)

| ID | Test | Asserts | Spec-002 AC / MUST |
| --- | --- | --- | --- |
| C1 | `InviteCreate payload validates required fields (sessionId, inviter, joinMode)` | request schema | line 80 |
| C2 | `Invite lifecycle states enum is exactly {pending, accepted, revoked, expired}` | no `declined` state in V1 | line 43 |
| C3 | `MembershipUpdate.action discriminated union covers role-change/suspend/revoke` | mutation contract | line 82 |
| C4 | `PresenceHeartbeat payload carries the 5 required metadata fields` | `{deviceType, focusedSessionId, focusedChannelId, lastActivityAt, appVisible}` | line 83 |
| C5 | `ChannelList response shape matches Spec-002:86 projection` | read-only projection contract | line 86 |

### Control Plane Layer (`packages/control-plane/`)

| ID | Test | Asserts | Spec-002 AC / MUST |
| --- | --- | --- | --- |
| P1 | `InviteAccept by valid PASETO v4 token creates active membership` | accept happy path | AC1 |
| P2 | `InviteAccept on revoked token returns "invite revoked" error and does not mutate membership` | revocation enforcement | AC3, line 138 |
| P3 | `InviteAccept on expired token returns "invite expired" error regardless of DB state` | expiry validation | line 111 |
| P4 | `Single-use enforcement: second InviteAccept on same jti returns "already accepted" error` | token consumption | line 108 |
| P5 | `Token storage uses SHA-256 hash; plaintext is never persisted` | hash storage invariant | line 110 |
| P6 | `Non-owner MembershipUpdate{action=change_role, newRole=owner} returns typed permission error` | I-002-1 owner-elevation invariant | I-002-1, line 49 |
| P7 | `Sole-owner self-leave returns typed error and owner row remains unchanged` | I-002-2 last-owner-cannot-leave invariant | I-002-2, line 50 |
| P8 | `Membership revocation persists; revoked participant cannot re-join without new invite` | revocation durability | AC3 |
| P9 | `Lock-ordering test: owner-transfer caller acquires sessions then session_memberships` | I-002-4 lock-ordering invariant | I-002-4 |
| P10 | `Migration shape regression: no presence-state table is created by Plan-002 migrations` | I-002-3 ephemeral-presence invariant | I-002-3, line 156 |

### Presence Layer (`packages/control-plane/src/presence/`)

| ID | Test | Asserts | Spec-002 AC / MUST |
| --- | --- | --- | --- |
| Pr1 | `Yjs Awareness state is in-memory only — no SQLite or Postgres write occurs on heartbeat` | I-002-3 ephemeral-presence invariant | I-002-3, line 156 |
| Pr2 | `Missed heartbeat moves participant to reconnecting before offline (45s grace)` | reconnect grace window | line 73 |
| Pr3 | `Postgres LISTEN/NOTIFY fan-out delivers presence updates to subscribed clients` | cross-node fan-out | line 61 |
| Pr4 | `Durable presence state-change events (presence.online/idle/reconnecting/offline) emit` | audit trail per Spec-006 §Presence | line 156 |

### SDK And Integration Layer (`packages/client-sdk/`, integration)

| ID | Test | Asserts | Spec-002 AC / MUST |
| --- | --- | --- | --- |
| I1 | `Invitee accepts invite into active session without resetting active runs` | live-join non-disruption | AC1 |
| I2 | `Membership remains durable across presence offline → online cycle` | membership/presence separation | AC2 |
| I3 | `ChannelList returns the default channel after Plan-001 SessionCreate emits ChannelCreated` | bootstrap projection | C5, AC1 |

### Verification

- `pnpm turbo test` at workspace root green across all packages
- Manual smoke: invite from one desktop client, accept from second client, verify roster + presence updates (Tier 8 follow-up after step 4 ships)
- All 22 enumerated tests above pass before Plan-002 Tier 2 PRs are marked complete; renderer-step tests (Tier 8 follow-up) gate the Tier 8 PR independently

## Implementation Phase Sequence

Plan-002 implementation lands as a sequence of small PRs. Tier 2 PRs ship steps 1–3; the Tier 8 PR is a follow-up after Plan-023 ships the renderer tree.

### Phase 1 — Invite And Membership Contracts + Migration

**Precondition:** Plan-001 complete (Tier 1 substrate carve-outs + session-directory-service + control-plane scaffolding in place).

**Goal:** Tests C1–C5 go green; `session_invites` migration applies cleanly; contract types exported from `packages/contracts/src/invites.ts` and `packages/contracts/src/memberships.ts`.

- `packages/contracts/src/invites.ts` — `InviteCreate`, `InviteAccept`, `InviteRevoke`, `InviteState` enum (4 states only; no `declined`)
- `packages/contracts/src/memberships.ts` — `MembershipUpdate` discriminated union + `MembershipRole` enum
- `packages/contracts/src/presence.ts` — `PresenceHeartbeat` payload with the 5 required metadata fields, `PresenceUpdate`/`PresenceRead` JSON-RPC method shapes
- `packages/contracts/src/channels.ts` — `ChannelList` request/response, `ChannelState` enum (channel creation contracts owned by Plan-016 are NOT shipped here)
- Migration creates `session_invites` (Postgres); `session_memberships` is already created by Plan-001 (no ALTER needed at this PR)

### Phase 2 — Control-Plane Invite And Membership Services

**Precondition:** Phase 1 merged.

**Goal:** Tests P1–P10 go green.

- `packages/control-plane/src/invites/invite-service.ts` — issuance (PASETO v4.local with 256-bit CSPRNG, jti, SHA-256 hash storage), acceptance (single-use enforcement), revocation, expiry validation
- `packages/control-plane/src/memberships/membership-service.ts` — `MembershipUpdate` handler with owner-elevation check (I-002-1), last-owner-cannot-leave guard (I-002-2), role-change/suspend/revoke paths
- Lock-ordering inheritance from Plan-001 (I-002-4) — every transactional caller follows `sessions` → `session_memberships`
- Audit emission: revocation events emit to session history per Spec-002 line 140

### Phase 3 — Presence Heartbeat + ChannelList Projection

**Precondition:** Phase 2 merged.

**Goal:** Tests Pr1–Pr4 + I3 go green.

- `packages/control-plane/src/presence/presence-register-service.ts` — Yjs Awareness state ingestion (in-memory only, I-002-3), Postgres LISTEN/NOTIFY fan-out
- Local IPC bridge: `presence.*` JSON-RPC method namespace (`PresenceUpdate`, `PresenceRead`) registered under the Plan-007-partial wire substrate
- `ChannelList` projection over the channels collection bootstrapped by Plan-001's `ChannelCreated`
- Durable presence-state-change events emit via Plan-006 path (`presence.online`/`idle`/`reconnecting`/`offline`); presence rows themselves are never persisted

### Phase 4 — Rate Limiting Surface (Optional Slot)

**Precondition:** Phase 2 merged. Phase 4 may slip to Plan-021's Tier 6 surface if the cross-plan rate-limiter contract isn't ready by Tier 2; in that case Plan-002 documents the deferral and Plan-021 adds the invite-rate-limit middleware when it ships.

**Goal:** Invite rate limits per Spec-002 §Rate Limiting (20/session/hr, 50/participant/hr, 100 pending/session) are enforced; standard `RateLimitResponse` returned on threshold breach.

- Add rate-limit middleware to invite endpoints; defer rate-limiter implementation to [Plan-021](./021-server-side-rate-limiting-and-admin-bans.md) if not yet shipped (cross-plan deferral note added here, contract stub in `packages/contracts/src/rate-limiter.ts` already owned by Plan-021)

### Phase 5 — Client SDK Membership Surface

**Precondition:** Phase 1–Phase 3 merged.

**Goal:** Tests I1–I3 go green; cross-client invite/accept/presence flows work end-to-end.

- `packages/client-sdk/src/membershipClient.ts` — wraps invite/membership/presence/`ChannelList` over both daemon and control-plane transports
- Integration tests for live-join non-disruption + membership/presence separation

### Phase 6 — Renderer (Tier 8 Follow-Up)

**Precondition:** Plan-023 complete (`apps/desktop/src/renderer/` exists). Sequenced at Tier 8 per §Execution Windows above.

**Goal:** Step 4 ships; manual two-client invite/accept smoke passes.

- `apps/desktop/src/renderer/src/session-members/` — renderer views for invite acceptance, participant roster, presence indicators (thin projection over the Spec-023 preload-bridge `window.sidekicks` surface; MUST NOT bypass the bridge to reach daemon or control-plane state directly)

After Phase 5 lands green at Tier 2, Plan-002's load-bearing semantics are complete. Phase 6 ships at Tier 8 as a renderer follow-up.

## Rollout Order

1. Ship invite and membership APIs (Phase 1 + Phase 2)
2. Add presence heartbeat, `ChannelList` projection, and participant roster (Phase 3)
3. Enable rate-limit enforcement (Phase 4 — may slip to Plan-021's surface if deferred)
4. Wire client SDK and integration paths (Phase 5)
5. Enable desktop invite acceptance UI (Phase 6, Tier 8 follow-up)

## Rollback Or Fallback

- Disable live invite acceptance and keep membership changes admin-only if invite flows regress.

## Risks And Blockers

- Guest identity policy remains unresolved (deferral tracked in parent [Spec-002](../specs/002-invite-membership-and-presence.md))
- Presence churn can create noisy state unless heartbeat thresholds are tuned carefully

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
