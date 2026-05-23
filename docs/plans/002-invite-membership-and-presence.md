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
| **Dependencies** | [Plan-001](./001-shared-session-core.md) (session tables, `session_memberships` schema); [Plan-007 partial-deliverable](./007-local-ipc-and-daemon-control.md) (Tier 1 Spec-007 §Wire Format substrate — Plan-002 registers the `presence.*` JSON-RPC method namespace under it); [Plan-008 bootstrap-deliverable](./008-control-plane-relay-and-session-join.md) (Tier 1 tRPC v11 server skeleton — hosts Plan-002's invite/membership tRPC routes once Plan-002 ships at Tier 2); [Plan-023 Tier 1 Partial](./023-desktop-shell-and-renderer.md#tier-1-partial-pr-sequence) (Tier 1 — `apps/desktop/src/renderer/` substrate + preload-bridge `window.sidekicks` for Phase 6 renderer per CP-002-5; satisfied on `develop`); [Plan-025 Tier 1 Partial](./025-self-hostable-node-relay.md#tier-1-partial-pr-sequence--substrate-vs-namespace-carve-out) (Tier 1 — `packages/crypto-paseto/` v4.public + v4.local primitives for Phase 2 invite-token minting per CP-002-4; BL-119 resolved 2026-05-20 via Option A). See [cross-plan-dependencies.md §3 Plan-002 row](../architecture/cross-plan-dependencies.md#3-inter-plan-dependency-graph). **Cross-tier phase-level obligations (not plan-start deps):** [Plan-021](./021-rate-limiting-policy.md) for Phase 4 invite-endpoint rate-limit wiring per [CP-002-3](#cross-plan-obligations) ([BL-120](../backlog.md), Phase 4 deferred to Tier 6). [Spec-024](../specs/024-cross-node-dispatch-and-approval.md) is **not** a dependency for Plan-002 — historical Session H-interim header reference; cross-node dispatch implementation belongs to [Plan-027](./027-cross-node-dispatch-and-approval.md) per [cross-plan-dependencies.md §Spec-024 Implementation Plan](../architecture/cross-plan-dependencies.md#spec-024-implementation-plan). |
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
- [x] **Plan-readiness audit complete per [`docs/operations/plan-implementation-readiness-audit-runbook.md`](../operations/plan-implementation-readiness-audit-runbook.md)** — Tier 2 audit landed via NS-14 (merged 2026-05-20); see [Status Promotion Gate §1](../operations/plan-implementation-readiness-audit-runbook.md#status-promotion-gate). Audit findings amended in-PR; ACTIONABLE-class deferrals (PASETO `crypto-paseto` substrate carve-out, Phase 4 Tier 6 wiring) tracked via BL-119 + BL-120 + BL-121 per [runbook §Cross-Tier Amendment Contingency](../operations/plan-implementation-readiness-audit-runbook.md#cross-tier-amendment-contingency). Phase 2 invite-token issuer prerequisite (`packages/crypto-paseto/` v4.local substrate per CP-002-4) shipped 2026-05-21 via [PR #92](https://github.com/Sawmonabo/ai-sidekicks/pull/92) — see [Plan-025 §Decision Log](./025-self-hostable-node-relay.md#decision-log).

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
- Add `ChannelList` read-only projection per [Spec-002 line 87](../specs/002-invite-membership-and-presence.md#interfaces-and-contracts). Request: `{sessionId: SessionId}`. Response: `{channels: Array<{id: ChannelId, name?: string, state: ChannelState, participantCount: number}>}`. Channels are bootstrapped at session create by Plan-001's `ChannelCreated` event (default channel); runtime channel creation (`ChannelCreate`) is owned by [Plan-016](./016-multi-agent-channels-and-orchestration.md) at Tier 6. `ChannelList` projects whatever channels currently exist regardless of who created them.
- Register the `presence.*` JSON-RPC method namespace (`PresenceUpdate`, `PresenceRead`) under the Plan-007-partial wire substrate per [Spec-002 §Heartbeat Transport](../specs/002-invite-membership-and-presence.md#heartbeat-transport). Plan-002 owns the namespace handlers and Zod schemas; the substrate (framing, error model, supervision hooks) is owned by Plan-007-partial.

## Cross-Plan Obligations

- **CP-002-1 — `packages/control-plane/src/presence/`** is CREATED by Plan-002 Phase 3 (Tier 2); EXTENDED by [Plan-008-remainder](./008-control-plane-relay-and-session-join.md) (Tier 5) for hosted-relay fan-out and [Plan-018](./018-identity-and-participant-state.md) (Tier 5) for trusted-device presence trails. Plan-002 owns `presence-register-service.ts`; downstream extenders add sibling files under the same directory per [cross-plan-dependencies.md §2 row `packages/control-plane/src/presence/`](../architecture/cross-plan-dependencies.md#2-package-path-ownership-map).
- **CP-002-2 — `presence.*` JSON-RPC namespace** registered by Plan-002 Phase 3 under the [Plan-007 partial](./007-local-ipc-and-daemon-control.md) wire substrate. Handlers land at `packages/runtime-daemon/src/ipc/handlers/presence-*.ts`; the substrate (framing, error envelope, method-name registry) is owned upstream by Plan-007-partial.
- **CP-002-3 — Invite-endpoint rate-limit wiring** uses [Plan-021](./021-rate-limiting-policy.md) `rateLimitProcedure` middleware factory. Plan-021 ships the middleware at Tier 6; Plan-002 Phase 4 applies it to invite-endpoint procedures at Tier 6 (post-Plan-021). See Phase 4 below for the deferral declaration and [cross-plan-dependencies.md §3 Plan-002 ↔ Plan-021 edge](../architecture/cross-plan-dependencies.md#3-inter-plan-dependency-graph). Cross-tier deferral tracking: BL-120.
- **CP-002-4 — PASETO v4.local token minting** depends on [Plan-025](./025-self-hostable-node-relay.md) `packages/crypto-paseto/`. **Option A chosen 2026-05-20 ([BL-119](../archive/backlog-archive.md#bl-119-plan-025-crypto-paseto-tier-1-partial-carve-out-decision) resolved).** Plan-002 Phase 2 consumes the [Plan-025 Tier 1 Partial carve-out](./025-self-hostable-node-relay.md#tier-1-partial-pr-sequence--substrate-vs-namespace-carve-out) of `packages/crypto-paseto/` (v4.public + v4.local primitives + RFC vectors — substrate-vs-namespace decomposition mirroring Plan-007-partial / Plan-008-bootstrap / Plan-023-partial). Plan-002 Phase 2 implementation starts only after Plan-025 Tier 1 Partial merges; see [cross-plan-dependencies.md §5](../architecture/cross-plan-dependencies.md#5-canonical-build-order) for the carve-out's tier placement.
- **CP-002-5 — Renderer surface (`apps/desktop/src/renderer/src/session-members/`)** consumes the [Plan-023 Tier 1 Partial](./023-desktop-shell-and-renderer.md#tier-1-partial-pr-sequence) preload-bridge `window.sidekicks` surface. The two-client end-to-end manual smoke acceptance criterion (Phase 6 Goal) is gated on the Plan-023 Tier 8 IPC dispatcher; until then, Phase 6 acceptance is component-test + single-client smoke. See Phase 6 below.

## Implementation Steps

- Contracts: See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed schemas this plan consumes.
- The four steps below land at Tier 2 (Plan-002's canonical tier). Phase 4 (invite rate-limit wiring) is **structurally deferred to Tier 6** because [Plan-021](./021-rate-limiting-policy.md)'s `rateLimitProcedure` middleware factory ships at Tier 6 — see [Phase 4 §Precondition](#phase-4--rate-limiting-surface-deferred-to-tier-6) and cross-tier deferral tracked via [BL-120](../backlog.md). The `apps/desktop/src/renderer/` substrate is created by [Plan-023 Tier 1 Partial](./023-desktop-shell-and-renderer.md#tier-1-partial-pr-sequence) per BL-101 (a) resolution, so step 4 (renderer integration) has no cross-tier blocker — it ships as the final PR in the Plan-002 sequence after step 3's SDK lands. See [cross-plan-dependencies.md §2 `apps/desktop/src/renderer/` row](../architecture/cross-plan-dependencies.md#2-package-path-ownership-map) and §Execution Windows below.

1. **[Tier 2]** Implement invite and membership contracts plus migrations. Invite tokens use PASETO v4 (see ADR-010). Define the four invite lifecycle states: `pending`, `accepted`, `revoked`, `expired`. Declining is implicit in V1 (unopened invites expire); no explicit `declined` state is required.
2. **[Tier 2]** Build control-plane services for invite issuance, acceptance, revocation, and role update. Owner-elevation and last-owner-cannot-leave checks (per §Invariants I-002-1, I-002-2) gate the `MembershipUpdate` paths. Lock-ordering inherits from Plan-001 (per §Invariants I-002-4).
3. **[Tier 2]** Add participant presence heartbeat ingestion and summary projection. Use Yjs Awareness (`y-protocols/awareness`) as the presence CRDT; fan out updates via Postgres LISTEN/NOTIFY in V1. Expose `PresenceUpdate` and `PresenceRead` JSON-RPC methods for local IPC bridging under the Plan-007-partial wire substrate. Default heartbeat timing: 15 s heartbeat interval, 45 s grace period before marking a participant offline. Presence MUST remain in-memory only (per §Invariants I-002-3). Add `ChannelList` read-only projection per §API And Transport Changes.
4. **[Tier 2]** Integrate desktop invite acceptance and participant roster surfaces under `apps/desktop/src/renderer/src/session-members/` (per [cross-plan-dependencies.md §2 row for `apps/desktop/src/renderer/`](../architecture/cross-plan-dependencies.md#2-package-path-ownership-map)). This step lands as the final PR in the Plan-002 sequence after step 3 ships the SDK; the renderer substrate is created by Plan-023 Tier 1 Partial per BL-101 (a) resolution, not blocked behind Plan-023's Tier 8 remainder.

## Execution Windows

Plan-002 Phases 1–3, 5, and 6 land at Tier 2 (Plan-002's canonical tier); Phase 4 (invite rate-limit wiring) is deferred to Tier 6 because [Plan-021](./021-rate-limiting-policy.md)'s `rateLimitProcedure` middleware factory ships at Tier 6 (see [Phase 4 §Precondition](#phase-4--rate-limiting-surface-deferred-to-tier-6); cross-tier deferral tracked via [BL-120](../backlog.md)). Phases ship as the sequence below over the Plan-007-partial + Plan-008-bootstrap Tier 1 substrate; surfaces all invite/membership/presence behavior and the `ChannelList` projection. The renderer subtree at `apps/desktop/src/renderer/src/session-members/` (Phase 6) ships after Phase 5's `membershipClient.ts` SDK lands — the `apps/desktop/src/renderer/` substrate is created independently by [Plan-023 Tier 1 Partial](./023-desktop-shell-and-renderer.md#tier-1-partial-pr-sequence) per BL-101 (a) resolution, so the renderer phase has no cross-tier blocker.

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
| C3 | `MembershipUpdate.action discriminated union covers role-change/suspend/revoke` | mutation contract | line 83 |
| C4 | `PresenceHeartbeat payload carries the 5 required metadata fields` | `{deviceType, focusedSessionId, focusedChannelId, lastActivityAt, appVisible}` | line 84 |
| C5 | `ChannelList response shape matches Spec-002:87 projection` | read-only projection contract | line 87 |

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
- Manual smoke: single-client invite/accept smoke runs after Phase 6 ships (component tests + single-client smoke per Phase 6 §Goal). Full two-client end-to-end smoke (invite from one desktop client, accept from second client, verify roster + presence updates across both clients) is **deferred to Tier 8** per CP-002-5 — gated on the Plan-023 Tier 8 IPC dispatcher; tracked via Phase 6 task T6.4
- All 22 enumerated tests above pass before Plan-002 is marked complete; renderer-step tests gate Phase 6 independently

## Implementation Phase Sequence

Plan-002 implementation lands as a sequence of small PRs primarily at Tier 2 (Phases 1, 2, 3, 5, 6) with a single Tier 6 follow-up (Phase 4 — invite rate-limit wiring; see [Phase 4 §Precondition](#phase-4--rate-limiting-surface-deferred-to-tier-6); cross-tier deferral tracked via [BL-120](../backlog.md)). Phases 1–3 ship contracts/services/presence + ChannelList; Phase 5 ships the SDK; Phase 6 ships the renderer subtree after Phase 5 lands the SDK (the renderer substrate is created independently by Plan-023 Tier 1 Partial per BL-101 (a) resolution).

### Phase 1 — Invite And Membership Contracts + Migration

**Precondition:** Plan-001 Phase 3 (daemon migration substrate) merged; control-plane scaffolding in place via Plan-001 Phase 4.

**Goal:** Tests C1–C5 go green; `session_invites` migration applies cleanly; contract types exported from `packages/contracts/src/invites.ts` and `packages/contracts/src/memberships.ts`.

- `packages/contracts/src/invites.ts` — `InviteCreate`, `InviteAccept`, `InviteRevoke` (shape: `{sessionId: SessionId, inviteId: InviteId, reason?: string}`), `InviteState` enum (4 states only; no `declined`)
- `packages/contracts/src/memberships.ts` — `MembershipUpdate` discriminated union + `MembershipRole` enum
- `packages/contracts/src/presence.ts` — `PresenceHeartbeat` payload with the 5 required metadata fields, `PresenceUpdate`/`PresenceRead` JSON-RPC method shapes
- `packages/contracts/src/channels.ts` — `ChannelList` request/response, `ChannelState` enum (channel creation contracts owned by Plan-016 are NOT shipped here)
- Migration creates `session_invites` (Postgres); `session_memberships` is already created by Plan-001 (no ALTER needed at this PR)

#### Tasks

##### T1.1 — Define `InviteCreate`, `InviteAccept`, `InviteRevoke`, `InviteState`, `InviteId` (branded) in `packages/contracts/src/invites.ts`; export via `packages/contracts/src/index.ts`.

**Files:** `packages/contracts/src/invites.ts`, `packages/contracts/src/index.ts`, `packages/contracts/test/invites.test.ts` **Spec coverage:** C1 (Spec-002 line 80 — `InviteCreate` required fields), C2 (Spec-002 line 43 — invite lifecycle states `{pending, accepted, revoked, expired}` (no `declined` in V1)) **Verifies invariant:** none (contract layer)

##### T1.2 — Define `MembershipUpdate` discriminated union, `MembershipRole`, `MembershipState` enums in `packages/contracts/src/memberships.ts`.

**Files:** `packages/contracts/src/memberships.ts`, `packages/contracts/test/memberships.test.ts` **Spec coverage:** C3 (Spec-002 line 83 — `MembershipUpdate.action` discriminated union covers role-change / suspend / revoke) **Verifies invariant:** none (contract layer)

##### T1.3 — Define `PresenceHeartbeat`, `PresenceUpdate`/`PresenceRead` shapes, `PresenceState` enum, `JoinMode` enum in `packages/contracts/src/presence.ts`.

**Files:** `packages/contracts/src/presence.ts`, `packages/contracts/test/presence.test.ts` **Spec coverage:** C4 (Spec-002 line 84 — `PresenceHeartbeat` carries 5 required metadata fields `{deviceType, focusedSessionId, focusedChannelId, lastActivityAt, appVisible}`) **Verifies invariant:** none (contract layer)

##### T1.4 — Define `ChannelList` request/response + `ChannelState` enum in `packages/contracts/src/channels.ts` (no channel-creation contracts — owned by Plan-016).

**Files:** `packages/contracts/src/channels.ts`, `packages/contracts/test/channels.test.ts` **Spec coverage:** C5 (Spec-002 line 87 — `ChannelList` read-only projection request/response shape) **Verifies invariant:** none (contract layer)

##### T1.5 — Author Postgres migration creating `session_invites` table (no `session_memberships` ALTER — Plan-001 owns).

**Files:** `packages/control-plane/src/migrations/0002-session-invites.ts` **Spec coverage:** Spec-002 §State And Data Implications line 155 (invite records durable until terminal state) + line 157 (presence ephemeral — no durable presence table) **Verifies invariant:** I-002-3 (verified-by-omission: migration creates `session_invites` only and does NOT create a presence-state table; P10 regression test in T2.5 asserts this)

##### T1.6 — Wire Vitest tests C1–C5 + anti-leakage assertion (no `ChannelCreate` contracts shipped).

**Files:** `packages/contracts/test/anti-leakage.test.ts` **Spec coverage:** Spec-002 line 87 (`ChannelList` is the only channel surface contracted in Spec-002; `ChannelList` request/response shape ships here, while `ChannelCreate` is explicitly handled by Plan-016 per Spec-002) **Verifies invariant:** none (cross-plan ownership boundary)

### Phase 2 — Control-Plane Invite And Membership Services

**Precondition:** Phase 1 merged AND [Plan-025 Tier 1 Partial](./025-self-hostable-node-relay.md#tier-1-partial-pr-sequence--substrate-vs-namespace-carve-out) merged (`packages/crypto-paseto/` v4.public + v4.local primitives available as workspace dep `@ai-sidekicks/crypto-paseto`). Phase 2 consumes the v4.local `encrypt`/`decrypt` surface for invite-token minting per [CP-002-4](#cross-plan-obligations); BL-119 resolved 2026-05-20 via Option A.

```yaml
preconditions:
  - { type: plan_phase, plan: 2, phase: 1, status: merged }
  - { type: pr_merged, ref: 92 }
  - { type: cross_plan_carve_out, ref: "Plan-025 Substrate-vs-Namespace Carve-Out" }
```

**Goal:** Tests P1–P10 go green.

- `packages/control-plane/src/invites/invite-service.ts` — issuance (PASETO v4.local with 256-bit CSPRNG, jti, SHA-256 hash storage per [ADR-010](../decisions/010-paseto-webauthn-mls-auth.md)), acceptance (single-use enforcement), revocation (owner-only per Spec-002 line 142), expiry validation
- `packages/control-plane/src/memberships/membership-service.ts` — `MembershipUpdate` handler with owner-elevation check (I-002-1), last-owner-cannot-leave guard (I-002-2), role-change/suspend/revoke paths
- Lock-ordering inheritance from Plan-001 (I-002-4) — every transactional caller follows `sessions` → `session_memberships`
- Audit emission: revocation events emit to session history per Spec-002 line 141; integrity columns (`prev_hash`, `row_hash`, `daemon_signature`) follow the Plan-001 Phase 3 placeholder convention (`Buffer.alloc(32)`) until Plan-006 Tier 4 ships real event-taxonomy hashing/signing
- Typed errors: `membership.permission_denied` (P6, I-002-1), `membership.last_owner` (P7, I-002-2), `invite.revoked` / `invite.expired` / `invite.already_accepted` (P2/P3/P4)

#### Tasks

##### T2.1 — Implement `invite-service.ts` issuance with PASETO v4.local (consumes `@ai-sidekicks/crypto-paseto` v4.local `encrypt` surface from Plan-025 Tier 1 Partial per CP-002-4 — BL-119 resolved via Option A).

**Files:** `packages/control-plane/src/invites/invite-service.ts` **Spec coverage:** Spec-002 §Token Security Properties lines 110 (Entropy/CSPRNG), 111 (hash storage), 113 (Token payload structure); P5 **Verifies invariant:** none (issuance path; hash-storage invariant verified by P5)

##### T2.2 — Implement invite acceptance + single-use enforcement + revocation + expiry validation; emit revocation audit events.

**Files:** `packages/control-plane/src/invites/invite-service.ts`, `packages/control-plane/src/invites/__tests__/invite-service.test.ts` **Spec coverage:** Spec-002 AC1, AC3, §Token Security Properties lines 109 (single-use enforcement), 111 (hash storage), 112 (expiry enforcement), §Invite Revocation lines 138 (immediacy), 141 (audit emission), 142 (owner-authorization); P1, P2, P3, P4, P8 **Verifies invariant:** none (issuance/acceptance path; revocation durability verified by P8)

##### T2.3 — Implement `membership-service.ts` with `MembershipUpdate` handler; enforce I-002-1 + I-002-2 with typed errors.

**Files:** `packages/control-plane/src/memberships/membership-service.ts`, `packages/control-plane/src/memberships/__tests__/membership-service.test.ts` **Spec coverage:** Spec-002 §Required Behavior lines 49, 50; Spec-002 AC3; P6, P7 **Verifies invariant:** I-002-1, I-002-2

##### T2.4 — Wire transactional callers (owner-transfer, co-owner promotion, invite-accept) to the canonical lock-ordering test from Plan-001 (extend `packages/control-plane/src/memberships/__tests__/`).

**Files:** `packages/control-plane/src/memberships/__tests__/lock-ordering.test.ts` **Spec coverage:** P9 **Verifies invariant:** I-002-4

##### T2.5 — Add P1–P9 + P10 (no-presence-table migration regression — coordinates with Phase 1 migration shape) test rows.

**Files:** `packages/control-plane/src/invites/__tests__/invite-service.test.ts`, `packages/control-plane/src/memberships/__tests__/membership-service.test.ts`, `packages/control-plane/src/migrations/__tests__/migration-shape.test.ts` **Spec coverage:** P1, P2, P3, P4, P5, P6, P7, P8, P9, P10 **Verifies invariant:** I-002-1, I-002-2, I-002-3, I-002-4

### Phase 3 — Presence Heartbeat + ChannelList Projection

**Precondition:** Phase 1 + Phase 2 merged (Phase 1's `presence.ts` + `channels.ts` contracts and Phase 2's transactional infrastructure are both load-bearing).

**Goal:** Tests Pr1–Pr4 + I3 go green; P10 (no-presence-table migration regression) re-verified after Phase 3 lands.

- `packages/control-plane/src/presence/presence-register-service.ts` — Yjs Awareness state ingestion (in-memory only, I-002-3), Postgres LISTEN/NOTIFY fan-out (per [ADR-008](../decisions/008-default-transports-and-relay-boundaries.md) transport choice). Owned by Plan-002 per CP-002-1.
- Local IPC bridge: `presence.*` JSON-RPC method namespace (`PresenceUpdate`, `PresenceRead`) registered under the Plan-007-partial wire substrate. Handlers at `packages/runtime-daemon/src/ipc/handlers/presence-update.ts` and `packages/runtime-daemon/src/ipc/handlers/presence-read.ts` per CP-002-2.
- `ChannelList` projection over the channels collection bootstrapped by Plan-001's `ChannelCreated` (default-channel emission at session create).
- Durable presence-state-change events emit via Plan-006 path (`presence.online`/`idle`/`reconnecting`/`offline`); presence rows themselves are never persisted.

#### Tasks

##### T3.1 — Implement `presence-register-service.ts` with Yjs Awareness ingestion (in-memory only); add Pr1 schema-shape regression test asserting no SQLite/Postgres write occurs on heartbeat.

**Files:** `packages/control-plane/src/presence/presence-register-service.ts`, `packages/control-plane/src/presence/__tests__/presence-register-service.test.ts` **Spec coverage:** Spec-002 §Default Behavior line 58, §State And Data Implications line 157 (Pr1) **Verifies invariant:** I-002-3 (ephemeral presence — Pr1 schema-shape regression test directly verifies no presence-state table is created)

##### T3.2 — Wire Postgres LISTEN/NOTIFY fan-out for cross-node presence updates (Pr3); reconnect-grace window timer (Pr2).

**Files:** `packages/control-plane/src/presence/presence-register-service.ts` (extends), `packages/control-plane/src/presence/__tests__/presence-register-service.test.ts` (extends) **Spec coverage:** Spec-002 §Fallback Behavior line 73 (Pr2 — reconnect grace window), §Default Behavior line 61 (Pr3 — Postgres LISTEN/NOTIFY fan-out) **Verifies invariant:** I-002-3 (indirect — no-persist semantics: fan-out is over the in-memory CRDT, never durable rows)

##### T3.3 — Register `presence.*` JSON-RPC handlers under Plan-007-partial wire substrate; emit `presence.online/idle/reconnecting/offline` audit events to `session_events` per Plan-006 path (Pr4).

**Files:** `packages/runtime-daemon/src/ipc/handlers/presence-update.ts`, `packages/runtime-daemon/src/ipc/handlers/presence-read.ts`, `packages/runtime-daemon/src/ipc/handlers/__tests__/presence-update.test.ts`, `packages/runtime-daemon/src/ipc/handlers/__tests__/presence-read.test.ts` **Spec coverage:** Spec-002 §State And Data Implications line 157 (Pr4 — durable presence state-change events), §Interfaces And Contracts line 85 (`PresenceUpdate` JSON-RPC surface), line 86 (`PresenceRead` JSON-RPC surface) **Verifies invariant:** none (transport surface + audit-event emission; I-002-3 is preserved by routing only state-change events — not presence rows — to `session_events`)

##### T3.4 — Implement `ChannelList` read-only projection consuming the channels collection bootstrapped by Plan-001's `ChannelCreated`; add I3 test asserting bootstrap projection returns the default channel.

**Files:** `packages/control-plane/src/channels/channel-list-projection.ts`, `packages/control-plane/src/channels/__tests__/channel-list-projection.test.ts` **Spec coverage:** Spec-002 AC1 (live-join non-disruption depends on the default-channel projection being live at accept time), §Interfaces And Contracts line 87 (`ChannelList` projection contract, C5 + I3) **Verifies invariant:** none (read-only projection over the upstream-bootstrapped channels collection; no Plan-002 invariant on read path)

### Phase 4 — Rate Limiting Surface (deferred to Tier 6)

**Precondition:** Phase 2 merged AND [Plan-021](./021-rate-limiting-policy.md) Tier 6 ships the `rateLimitProcedure` middleware factory at `packages/control-plane/src/middleware/rate-limit.ts`. Phase 4 is structurally deferred to Tier 6 because Plan-021 ships at Tier 6 — Plan-002 owns the wiring (CP-002-3) but the substrate is unavailable at Tier 2. Cross-tier deferral tracked via BL-120.

**Goal:** Invite rate limits per Spec-002 §Rate Limiting (20/session/hr, 50/participant/hr, 100 pending/session) are enforced; the canonical `RateLimitResponse` shape owned by Plan-021 (`packages/control-plane/src/middleware/rate-limit.ts`) is returned on threshold breach.

#### Tasks

##### T4.1 — [Tier 6, post-Plan-021] Apply `rateLimitProcedure({endpoint: 'invite.create' | 'invite.accept' | 'invite.revoke' | …})` middleware to the invite tRPC procedures defined in Phase 2's `invite-service.ts` surface.

**Files:** `packages/control-plane/src/invites/invite-service.ts` (extends Phase 2 surface; wires Plan-021 middleware from `packages/control-plane/src/middleware/rate-limit.ts`) **Spec coverage:** Spec-002 §Rate Limiting line 121 (20/session/hr), line 122 (50/participant/hr), line 123 (100 pending/session) **Verifies invariant:** none (Plan-021 substrate wiring; no Plan-002 invariant)

##### T4.2 — [Tier 6] Add rate-limit verification tests asserting threshold breach returns the canonical 429 + `RateLimitResponse` shape per Plan-021 §`RateLimitResponse` canonical shape.

**Files:** `packages/control-plane/src/invites/__tests__/`, `packages/control-plane/src/invites/invite-service.ts` (service under test) **Spec coverage:** Spec-002 §Rate Limiting lines 127-133 (`RateLimitResponse` canonical shape; returned with 429 per Plan-021 §`RateLimitResponse` canonical shape) **Verifies invariant:** none (Plan-021 substrate wiring; no Plan-002 invariant)

### Phase 5 — Client SDK Membership Surface

**Precondition:** Phase 1–Phase 3 merged. `membershipClient.ts` follows the dual-transport factory precedent established by [Plan-001 Phase 5 T5.1](./001-shared-session-core.md) (`packages/client-sdk/src/sessionClient.ts` shipped 2026-05-05 via PR #30).

**Goal:** Tests I1–I3 go green; cross-client invite/accept/presence flows work end-to-end.

- `packages/client-sdk/src/membershipClient.ts` — two factories (`createDaemonMembershipClient(jsonRpcClient)` + `createControlPlaneMembershipClient({fetcher, baseUrl, endpoint?})`) sharing one `MembershipClient` interface; transport branching MUST happen at the factory boundary, not inside method bodies; subscribe paths use async generators wrapping each transport's native streaming primitive. Zod-validate at SDK boundary (mirror `sessionClient.ts:363` fail-fast).
- Integration tests for live-join non-disruption (I1) + membership/presence separation (I2) + `ChannelList` bootstrap projection (I3).

#### Tasks

##### T5.1 — Implement `membershipClient.ts` daemon factory wrapping `presence.*` JSON-RPC + invite/membership tRPC adapter.

**Files:** `packages/client-sdk/src/membershipClient.ts`, `packages/client-sdk/test/membershipClient.integration.test.ts` **Spec coverage:** Spec-002 AC1 (line 178 — I1 live-join non-disruption), Spec-002 line 87 + AC1 (I3 `ChannelList` bootstrap projection) **Verifies invariant:** none (SDK transport boundary; substrate invariants verified at services layer per Phase 2/Phase 3)

##### T5.2 — Implement `membershipClient.ts` control-plane factory consuming Plan-008-remainder relay (when shipped at Tier 5; until then, control-plane factory throws `NotImplementedAtTier2Error`).

**Files:** `packages/client-sdk/src/membershipClient.ts`, `packages/client-sdk/test/membershipClient.integration.test.ts` **Spec coverage:** none (Tier 5 forward-compatibility scaffold — at Tier 2 the control-plane factory throws `NotImplementedAtTier2Error`; Spec-002 AC1/AC2 verification on this transport defers to Plan-008-remainder per CP-002-1) **Verifies invariant:** none (SDK transport boundary; deferred-behavior sentinel — `NotImplementedAtTier2Error` envelope only)

##### T5.3 — Add I1–I3 integration tests.

**Files:** `packages/client-sdk/test/membershipClient.integration.test.ts` **Spec coverage:** Spec-002 AC1 (line 178 — I1), Spec-002 AC2 (line 179 — I2 membership/presence separation), Spec-002 line 87 + AC1 (I3) **Verifies invariant:** none (SDK transport boundary; substrate invariants verified at services layer per Phase 2/Phase 3)

### Phase 6 — Renderer (Tier 2)

**Precondition:** Phase 5 merged (consumes `membershipClient.ts` SDK) AND Plan-023 Tier 1 Partial complete (`apps/desktop/src/renderer/` substrate exists; preload-bridge `window.sidekicks` typed stub in place per [Plan-023 Tier 1 Partial](./023-desktop-shell-and-renderer.md#tier-1-partial-pr-sequence)). Sequenced at Tier 2 per §Execution Windows above.

**Goal:** Phase 6 component tests + single-client smoke pass (invite acceptance UI renders; roster + presence indicators update via the preload bridge). The full two-client end-to-end smoke acceptance criterion is gated on the Plan-023 Tier 8 IPC dispatcher and ships at Tier 8 per CP-002-5; until then, the two-client smoke is a deferred manual verification step.

- `apps/desktop/src/renderer/src/session-members/` — renderer views for invite acceptance, participant roster, presence indicators (thin projection over the Spec-023 preload-bridge `window.sidekicks` surface; MUST NOT bypass the bridge to reach daemon or control-plane state directly per CP-002-5).

#### Tasks

##### T6.1 — Implement `session-members/invite-accept-view.tsx` consuming the preload-bridge `window.sidekicks.invites.accept` surface.

**Files:** `apps/desktop/src/renderer/src/session-members/invite-accept-view.tsx` **Spec coverage:** Spec-002 AC1 (line 178 — invited participant joins active session without resetting active runs) **Verifies invariant:** none (renderer surface)

##### T6.2 — Implement `session-members/participant-roster.tsx` rendering presence indicators via `window.sidekicks.presence.subscribe` async iterator.

**Files:** `apps/desktop/src/renderer/src/session-members/participant-roster.tsx` **Spec coverage:** Spec-002 AC1 (line 178 — joined-membership surface), AC2 (line 179 — membership durable across presence offline → online cycle) **Verifies invariant:** none (renderer surface)

##### T6.3 — Add Vitest component tests (`@testing-library/react`) for invite-accept view + roster; assert renderer code paths never import from `packages/runtime-daemon/` or `packages/control-plane/` directly (bridge-projection invariant).

**Files:** `apps/desktop/src/renderer/src/session-members/__tests__/invite-accept-view.test.tsx`, `apps/desktop/src/renderer/src/session-members/__tests__/participant-roster.test.tsx` **Spec coverage:** Spec-002 AC1 (line 178), AC2 (line 179) (single-client component smoke per Plan-002 §Verification) **Verifies invariant:** none (renderer surface; CP-002-5 bridge-projection cross-plan obligation is enforced by the import-restriction assertion in this task's tests)

##### T6.4 — [Deferred to Tier 8] Two-client manual smoke verification after Plan-023 Tier 8 IPC dispatcher ships.

**Files:** none (manual two-client verification gated on Plan-023 Tier 8 IPC dispatcher; no Plan-002 code deliverable) **Spec coverage:** Spec-002 AC1 (line 178), AC2 (line 179) (two-client end-to-end realization per Plan-002 §Verification — verification deferred to Tier 8 per CP-002-5) **Verifies invariant:** none (deferred manual verification; no automated invariant in this PR)

After Phase 5 lands green at Tier 2, Plan-002's load-bearing semantics are complete. Phase 6 ships at Tier 2 after Phase 5 — the renderer substrate from Plan-023 Tier 1 Partial is independently in place from Tier 1, so the gating reduces to Plan-002's own SDK readiness.

## Rollout Order

1. Ship invite and membership APIs (Phase 1 + Phase 2)
2. Add presence heartbeat, `ChannelList` projection, and participant roster (Phase 3)
3. Wire client SDK and integration paths (Phase 5; Phase 4 deferred to Tier 6 per CP-002-3)
4. Enable desktop invite acceptance UI (Phase 6, Tier 2 — after Phase 5)
5. [Tier 6] Apply Plan-021's `rateLimitProcedure` middleware to invite endpoints (Phase 4)

## Rollback Or Fallback

- Disable live invite acceptance and keep membership changes admin-only if invite flows regress.

## Risks And Blockers

- Guest identity policy remains unresolved (deferral tracked in parent [Spec-002](../specs/002-invite-membership-and-presence.md))
- Presence churn can create noisy state unless heartbeat thresholds are tuned carefully

## Progress Log

### Shipment Manifest

<!-- Machine-readable. Housekeeper-emitted, orchestrator-written, preflight-read.
     Schema authoritative in:
       .claude/skills/plan-execution/scripts/lib/manifest.mjs -->

```yaml
manifest_schema_version: 1
shipped: []
```

### Notes

<!-- Per-PR human-readable commentary appended by the orchestrator at Phase E. -->

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
