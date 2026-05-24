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
- **CP-002-6 — Invite/membership lifecycle event emission** (`membership_change` category — the 9 `invite.*` / `membership.*` lifecycle types) is assigned to Plan-002 as the **emitter plan** per [Plan-006 §Event Taxonomy Coverage](./006-session-event-taxonomy-and-audit-log.md). The emitting surface is **daemon-side** — events append to the per-daemon SQLite `session_events` log per [ADR-017](../decisions/017-shared-event-sourcing-scope.md) (the control plane has no event log) — and is **NOT in Phase 2**, whose control-plane services (`invite-service.ts`, `membership-service.ts`) own only the authoritative coordination-state transitions. Emission lands once [Plan-006](./006-session-event-taxonomy-and-audit-log.md) (Tier 4) ships the `event-log-service.ts` append path + integrity protocol and [Plan-008-remainder](./008-control-plane-relay-and-session-join.md) (Tier 5) relay sync makes daemons aware of control-plane invite/membership transitions; Spec-002 line 141 (revocation audit events in session history) is therefore satisfied at Tier 4, not Tier 2. Same earlier-tier-emitter deferral as Plan-003's `runtime_node.*` (see the Plan-003 → Plan-006 row in [cross-plan-dependencies.md §3](../architecture/cross-plan-dependencies.md)). Tracked for Plan-006's readiness audit. As part of this same change, [Spec-006](../specs/006-session-event-taxonomy-and-audit-log.md)'s `membership_change` payload was amended to carry the optional `reason?` audit field that the `InviteRevoke` contract already captures (Spec-002 line 141), reconciling the event payload with the merged contract's audit-log promise.

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
| C3 | `MembershipUpdate.action discriminated union covers {change_role, suspend, revoke, reactivate}` | mutation contract | line 83 |
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

#### Cross-Plan Amendments

**PR #102 (2026-05-22) — `packages/contracts/src/internal/branded.ts` introduction + `packages/contracts/src/session.ts` brand-schema refactor.**

T1.1's implementation surfaced a pre-existing typing inconsistency in `packages/contracts/src/session.ts` (owned by Plan-001 Phase 2 per [cross-plan-dependencies.md §2 `packages/contracts/src/`](../architecture/cross-plan-dependencies.md#2-package-path-ownership-map)): `ParticipantIdSchema` / `MembershipIdSchema` / `ChannelIdSchema` were declared `z.ZodType<T>` (single-T) while sibling `SessionIdSchema` / `EventCursorSchema` followed the double-T `z.ZodType<T, T>` form required for Standard-Schema-V1 input inference in tRPC v11 consumers (per [ADR-014](../decisions/014-trpc-control-plane-api.md)). Composing any single-T branded ID inside an outer double-T request schema fails typecheck.

To avoid replicating local-cast workarounds across T1.1 / T1.2 / T1.4 and every future V1 branded ID, this PR:

1. **Adds `packages/contracts/src/internal/branded.ts`** — exports `brandedUuidIdSchema<T>(brandName)` helper encapsulating the Zod-v4 brand cast idiom in a single fix-point. The helper lives under `src/internal/` (not re-exported from `index.ts`) following the convention established by `packages/crypto-paseto/src/internal/v4-local-deterministic.ts` — internal modules imported relatively by sibling files in the same package, never exposed to consumers.
2. **Refactors `packages/contracts/src/session.ts`** — the 4 UUID-based branded ID schemas (`SessionIdSchema`, `ParticipantIdSchema`, `MembershipIdSchema`, `ChannelIdSchema`) switch to the helper. `EventCursorSchema` retains its inline cast because its parser is `z.string().min(1).max(EVENT_CURSOR_MAX_LEN)` (Plan-006-owned opaque cursor form, not a UUID); substituting the helper would silently narrow runtime validation. Type-level only; zero runtime change.
3. **Declares `InviteIdSchema` in T1.1's new `invites.ts`** using the helper (no local cast).

**Cross-plan touch rationale.** `packages/contracts/src/session.ts` is normally Plan-001 Phase 2-owned per the cross-plan ownership map. The literal "no two plans edit the same file" rule would have routed this fix through a precursor Plan-001 housekeeping PR. We applied a fix-in-place housekeeping exception because: (a) the fix is type-level only (zero runtime change, zero behavioral risk), (b) the defect is pre-existing and only discoverable via downstream composition (Plan-002 was the first composer), (c) the helper avoids ~12 lines of cast-boilerplate repeated across T1.1 / T1.2 / T1.4 plus every future V1 branded ID, and (d) bundling the housekeeping in the surfacing PR avoids cross-plan PR coordination ceremony for a sub-30-LOC fix. This is one-time correction, not Plan-002 claiming ongoing edit rights on Plan-001-owned files. A separate governance amendment to `cross-plan-dependencies.md:90` is queued to encode this housekeeping-exception convention.

**Refs:** Plan-001 Phase 2 (`packages/contracts/src/session.ts` original ship), [ADR-014](../decisions/014-trpc-control-plane-api.md) (tRPC v11 / Standard Schema V1).

**PR #102 (2026-05-23) — Amendment 2: `applyMigrations()` per-version loop wires v2 (cross-plan touch on Plan-001 Phase 4-owned `migration-runner.ts`).**

Phase D code-reviewer surfaced that T1.5 shipped `SESSION_INVITES_MIGRATION_SQL` (the v2 migration constant) while `applyMigrations()` in `packages/control-plane/src/sessions/migration-runner.ts` (owned by Plan-001 Phase 4 per PR #10) was hardcoded to probe-and-apply v1 only. Any deployer pulling `develop` would have received an orphan v2 migration file that the runner never executed until Plan-002 Phase 2's service-layer PR wired it. The originally-planned deferral (per the `0002-session-invites.ts` file-level "Cross-plan boundary" header) postponed the runner wiring to Phase 2; the user explicitly chose to fix-in-place during Phase D round-trip rather than defer.

1. **Restructures `applyMigrations()`** — replaces the hardcoded `version: 1` outer/inner probes with a `for ({ version, sql } of MIGRATIONS)` loop over a new module-scope `MIGRATIONS` array `[{version: 1, sql: INITIAL_MIGRATION_SQL}, {version: 2, sql: SESSION_INVITES_MIGRATION_SQL}]`. Per-version transaction + advisory lock + outer probe + re-probe-in-lock are all preserved unchanged; the SQL atomicity boundary, race-defense pattern, and `MIGRATION_LOCK_ID` constant are untouched. Each migration version goes through its own transaction so concurrent racers on different versions interleave correctly through the shared advisory lock.
2. **Updates the `applyMigrations()` JSDoc + file-level header** — generalizes the v1-specific tone to describe per-version iteration; removes the now-stale "Multi-version expansion" TODO; explains why each version takes its own transaction boundary (DDL blast-radius minimization + per-version racer interleaving).
3. **Adds `packages/control-plane/src/sessions/__tests__/migration-runner.test.ts`** — new test file pinning two canonical-path properties: R1 (`applyMigrations()` on a fresh database applies BOTH v1 AND v2, materializing `session_invites`); R2 (`applyMigrations()` is idempotent at the runner-loop layer — re-call on a fully-migrated DB is a no-op).
4. **Updates two existing test files transitively** as a mechanical consequence of the runner change:
   - `packages/control-plane/src/sessions/__tests__/session-directory-service.test.ts` (Plan-001 Phase 4-owned) — the two `expect(probe.rows).toEqual([{ version: 1 }])` assertions become `[{ version: 1 }, { version: 2 }]`; Codex-R8 concurrency-test narration around the single-row claim updates to match. The composition-level coverage that the runner is idempotent when run through the directory-service test fixture is preserved.
   - `packages/control-plane/src/migrations/__tests__/0002-session-invites.test.ts` (this plan's own T1.5 file) — `beforeEach` switches from `applyMigrations(querier)` to direct `tx.exec(INITIAL_MIGRATION_SQL)` so v2 isn't pre-applied (the file exercises v2 SQL semantics in isolation); the `applySessionInvitesMigration` local helper is preserved unchanged; file-level header, T7 docstring, and `beforeEach` docstring update to reflect the new framing. T7's runtime behavior is preserved — it now reads as a SQL-direct-exec idempotency test complementary to the new `migration-runner.test.ts` R2 canonical-path idempotency test.

**Cross-plan touch rationale.** `packages/control-plane/src/sessions/migration-runner.ts` and `packages/control-plane/src/sessions/__tests__/session-directory-service.test.ts` are normally Plan-001 Phase 4-owned per the cross-plan ownership map. We applied the same fix-in-place housekeeping exception established by Amendment 1 above because: (a) the defect surfaced only via downstream composition (T1.5 shipped the v2 SQL; the orphan-migration gap was only visible once the v2 constant existed), (b) the fix is structural-only (no semantic change to v1 application, no new public surface, no spec change), (c) wiring v2 now empties the original Plan-002 Phase 2 T2.1 sub-scope (which was originally going to wire the runner), removing a cross-plan dependency, (d) sub-30 LOC for the runner change itself; the transitive test updates are mechanical assertion + narration changes that follow as a direct consequence (assertion shape `[{v:1}]` → `[{v:1},{v:2}]`; `beforeEach` bootstrap path switch from `applyMigrations` to direct-exec to preserve in-isolation v2 SQL testing), and (e) this is one-time correction, NOT Plan-002 claiming ongoing edit rights on Plan-001-owned `migration-runner.ts` or `session-directory-service.test.ts`. The new `migration-runner.test.ts` file lives at a Plan-001-adjacent path (`packages/control-plane/src/sessions/__tests__/`) but is authored by Plan-002 to pin the per-version-loop properties Plan-002 just added; future canonical-path runner tests owned by Plan-001 can compose alongside it.

**Refs:** Plan-001 Phase 4 (`migration-runner.ts` original ship PR #10), `packages/control-plane/src/migrations/0002-session-invites.ts` (the v2 migration SQL T1.5 ships in this PR), Phase D code-reviewer round-1 review.

#### Tasks

##### T1.1 — Define `InviteCreate`, `InviteAccept`, `InviteRevoke`, `InviteState`, `InviteId` (branded) in `packages/contracts/src/invites.ts`; export via `packages/contracts/src/index.ts`.

**Files:** `packages/contracts/src/invites.ts`, `packages/contracts/src/index.ts`, `packages/contracts/src/__tests__/invites.test.ts`, `packages/contracts/src/internal/branded.ts` (cross-plan amendment — internal helper, not re-exported from `index.ts`), `packages/contracts/src/session.ts` (cross-plan amendment — refactor 4 existing UUID ID schemas to use the helper) **Spec coverage:** C1 (Spec-002 line 80 — `InviteCreate` required fields), C2 (Spec-002 line 43 — invite lifecycle states `{pending, accepted, revoked, expired}` (no `declined` in V1)) **Verifies invariant:** none (contract layer)

##### T1.2 — Define `MembershipUpdate` discriminated union, `MembershipRole`, `MembershipState` enums in `packages/contracts/src/memberships.ts`.

**Files:** `packages/contracts/src/memberships.ts`, `packages/contracts/src/index.ts`, `packages/contracts/src/__tests__/memberships.test.ts` **Spec coverage:** C3 (Spec-002 line 83 — `MembershipUpdate.action` discriminated union covers {change_role, suspend, revoke, reactivate}) **Verifies invariant:** none (contract layer)

##### T1.3 — Define `PresenceHeartbeat`, `PresenceUpdate`/`PresenceRead` shapes, `PresenceState` enum, `JoinMode` enum in `packages/contracts/src/presence.ts`.

**Files:** `packages/contracts/src/presence.ts`, `packages/contracts/src/index.ts`, `packages/contracts/src/__tests__/presence.test.ts` **Spec coverage:** C4 (Spec-002 line 84 — `PresenceHeartbeat` carries 5 required metadata fields `{deviceType, focusedSessionId, focusedChannelId, lastActivityAt, appVisible}`) **Verifies invariant:** none (contract layer)

##### T1.4 — Define `ChannelList` request/response + `ChannelState` enum in `packages/contracts/src/channels.ts` (no channel-creation contracts — owned by Plan-016).

**Files:** `packages/contracts/src/channels.ts`, `packages/contracts/src/index.ts`, `packages/contracts/src/__tests__/channels.test.ts` **Spec coverage:** C5 (Spec-002 line 87 — `ChannelList` read-only projection request/response shape) **Verifies invariant:** none (contract layer)

##### T1.5 — Author Postgres migration creating `session_invites` table (no `session_memberships` ALTER — Plan-001 owns).

**Files:** `packages/control-plane/src/migrations/0002-session-invites.ts` **Spec coverage:** Spec-002 §State And Data Implications line 155 (invite records durable until terminal state) + line 157 (presence ephemeral — no durable presence table) **Verifies invariant:** I-002-3 (verified-by-omission: migration creates `session_invites` only and does NOT create a presence-state table; P10 regression test in T2.5 asserts this)

##### T1.6 — Wire Vitest tests C1–C5 + anti-leakage assertion (no `ChannelCreate` contracts shipped).

**Files:** `packages/contracts/src/__tests__/anti-leakage.test.ts` **Spec coverage:** Spec-002 line 87 (`ChannelList` is the only channel surface contracted in Spec-002; `ChannelList` request/response shape ships here, while `ChannelCreate` is explicitly handled by Plan-016 per Spec-002) **Verifies invariant:** none (cross-plan ownership boundary)

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
- `packages/control-plane/src/memberships/membership-service.ts` — `MembershipUpdate` handler with owner-elevation check (I-002-1), last-owner-cannot-leave guard (I-002-2), change_role/suspend/revoke/reactivate paths
- Lock-ordering inheritance from Plan-001 (I-002-4) — every transactional caller follows `sessions` → `session_memberships`
- Audit emission is **deferred** — Phase 2 control-plane services do **not** emit invite/membership lifecycle events and write no `session_events` integrity columns (no `prev_hash` / `row_hash` / `daemon_signature`, no `Buffer.alloc(32)` placeholder — that is a runtime-daemon convention, and per [ADR-017](../decisions/017-shared-event-sourcing-scope.md) the control plane has no event log). The `membership_change` emission surface is daemon-side and lands at Plan-006 Tier 4 gated on Plan-008-remainder Tier 5 per [CP-002-6](#cross-plan-obligations); Spec-002 line 141 (revocation audit events in session history) is satisfied at Tier 4, not Tier 2. The Phase 2 deliverable is the authoritative coordination-state transition (`session_invites.state → 'revoked'`), not the event
- Typed errors: `membership.permission_denied` (P6, I-002-1), `membership.last_owner` (P7, I-002-2), `invite.revoked` / `invite.expired` / `invite.already_accepted` (P2/P3/P4)

#### Tasks

##### T2.1 — Implement `invite-service.ts` issuance with PASETO v4.local (consumes `@ai-sidekicks/crypto-paseto` v4.local `encrypt` surface from Plan-025 Tier 1 Partial per CP-002-4 — BL-119 resolved via Option A).

**Files:** `packages/control-plane/src/invites/invite-service.ts` **Spec coverage:** Spec-002 §Token Security Properties lines 110 (Entropy/CSPRNG), 111 (hash storage), 113 (Token payload structure); P5 **Verifies invariant:** none (issuance path; hash-storage invariant verified by P5)

##### T2.2 — Implement invite acceptance + single-use enforcement + owner-authorized revocation (state-only: `session_invites.state → 'revoked'`) + expiry validation. Does **not** emit audit events — deferred to Plan-006 Tier 4 per [CP-002-6](#cross-plan-obligations) (the control plane has no event log per ADR-017).

**Files:** `packages/control-plane/src/invites/invite-service.ts`, `packages/control-plane/src/invites/__tests__/invite-service.test.ts` **Spec coverage:** Spec-002 AC1, AC3, §Token Security Properties lines 109 (single-use enforcement), 111 (hash storage), 112 (expiry enforcement), §Invite Revocation lines 138 (immediacy), 141 (audit emission — **deferred to Tier 4 per [CP-002-6](#cross-plan-obligations)**, not emitted in Phase 2), 142 (owner-authorization); P1, P2, P3, P4, P8 **Verifies invariant:** none (issuance/acceptance path; revocation durability verified by P8)

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
shipped:
  - phase: 1
    task: [T1.1, T1.2, T1.3, T1.4, T1.5, T1.6]
    pr: 102
    sha: 347d62b
    merged_at: 2026-05-23
    files:
      - docs/architecture/cross-plan-dependencies.md
      - docs/plans/002-invite-membership-and-presence.md
      - docs/superpowers/specs/2026-05-03-plan-execution-housekeeper-design.md
      - packages/contracts/src/__tests__/anti-leakage.test.ts
      - packages/contracts/src/__tests__/channels.test.ts
      - packages/contracts/src/__tests__/invites.test.ts
      - packages/contracts/src/__tests__/memberships.test.ts
      - packages/contracts/src/__tests__/presence.test.ts
      - packages/contracts/src/channels.ts
      - packages/contracts/src/index.ts
      - packages/contracts/src/internal/branded.ts
      - packages/contracts/src/invites.ts
      - packages/contracts/src/memberships.ts
      - packages/contracts/src/presence.ts
      - packages/contracts/src/session.ts
      - packages/control-plane/src/index.ts
      - packages/control-plane/src/migrations/0002-session-invites.ts
      - packages/control-plane/src/migrations/__tests__/0002-session-invites.test.ts
      - packages/control-plane/src/sessions/__tests__/migration-runner.test.ts
      - packages/control-plane/src/sessions/__tests__/session-directory-service.test.ts
      - packages/control-plane/src/sessions/migration-runner.ts
```

### Notes

<!-- Per-PR human-readable commentary appended by the orchestrator at Phase E. -->

- **PR #102** (squash-commit `347d62b` on `develop`, merged 2026-05-23): Phase 1 — Invite And Membership Contracts + Migration. Six implementer tasks shipped: T1.1 `packages/contracts/src/invites.ts` (`InviteCreate` / `InviteAccept` / `InviteRevoke` / `InviteState` / `InviteId` branded — `JoinMode` consolidated from `InviteJoinMode` per spaced wire-form in Spec-002 + `MembershipRole`); T1.2 `packages/contracts/src/memberships.ts` (`MembershipUpdate` discriminated union on `action=change_role|leave` arms encoding I-002-1 issuer-must-be-owner + I-002-2 last-owner-cannot-leave at the contract layer); T1.3 `packages/contracts/src/presence.ts` (`PresenceHeartbeat` 5-required-1-nullable shape per Spec-002 §Heartbeat Transport, `JoinMode` enum, `PresenceUpdate` / `PresenceRead` JSON-RPC schemas registered under the Plan-007-partial wire substrate); T1.4 `packages/contracts/src/channels.ts` (`ChannelList` read-only projection + `ChannelState` + `ChannelMessage` envelope per Spec-002:87); T1.5 `packages/control-plane/src/migrations/0002-session-invites.ts` Postgres v2 migration (table + 3 indexes + 1 UNIQUE constraint, wired into the migration-runner v2 list); T1.6 strict `packages/contracts/src/__tests__/anti-leakage.test.ts` pinning `packages/contracts/src/index.ts` as the public re-export surface across all four new modules. Cross-package addition: `packages/contracts/src/internal/branded.ts` UUID helper consumed by all four new modules and the existing `session.ts` (per **NS-22 cross-plan amendment #1** — Plan-001-owned `session.ts` refactored in-PR to use the shared helper). Migration-runner extended to consume the v2 list (per **NS-23 cross-plan amendment #2** — Plan-001-owned `migration-runner.ts` switched to `applyMigrations(...)` v2 in-PR). Both amendments recorded under [§Phase 1 Cross-Plan Amendments](#phase-1--invite-and-membership-contracts--migration) rather than spawning precursor PRs (sub-day wiring this PR already covered as a side-effect of contract changes; [cross-plan-dependencies.md:90](../architecture/cross-plan-dependencies.md) rigid single-owner clause to be amended via follow-up per `feedback_cross_plan_rigid_ownership_problematic`). Reviewer chain: per-task Phase C (3-reviewer parallel) generated 8 POLISH round-trips and 0 ACTIONABLE; Phase D PR-scope final review round 1 surfaced 1 POLISH (T1.1 `InviteJoinMode` → `JoinMode` consolidation, `1870a02`) + 1 ACTIONABLE (T1.5 migration-runner v2 wiring at `applyMigrations` call-site, `6085d47`); round 2 returned clean. Phase D.5 Codex external review surfaced 1 P1 ACTIONABLE on `anti-leakage.test.ts:76-77` importing via the `@ai-sidekicks/contracts` package path (resolves to `./dist/index.js` — fresh checkouts haven't built it because Turbo `test` chains only on `^build` upstream-only, not the package's own build); fix switched to source-level `../index.js` import (`8781967` — preserves the index.ts re-export-graph testing intent and matches the 9/9 sibling-test convention; verified via `rm -rf dist && pnpm --filter @ai-sidekicks/contracts test`). One incidental [BL-130](../backlog.md) surface during pre-mark-ready CI: the housekeeper-design spec (`docs/superpowers/specs/2026-05-03-plan-execution-housekeeper-design.md` line 76) carried a stale `packages/contracts/src/session.ts` line-388 cite that this PR's Amendment 1 (`internal/branded.ts` extraction) had shifted to whitespace; the `cite-target-existence` hook's path-shaped discriminator caught it post-push (local pre-commit walk skips `docs/superpowers/` per the known BL-130 corpus gap). Refreshed in-PR via `a14d4ca` (substantive cite preserved at `session.ts` line 408 — the SessionSubscribe block; pre-shift line 388 noted in natural-language prose). Test count: 5 contract-package suites (anti-leakage 459 / channels 432 / invites 307 / memberships 460 / presence 764 lines) + 2 control-plane suites (`0002-session-invites` 543 / `migration-runner` 211 lines). Plan-002 Phase 1 closes; Phases 2-6 remain unscheduled (Phase 2 ships at Tier 2 with `packages/crypto-paseto/` substrate now satisfied per Plan-025 PR #92; Phase 4 deferred to Tier 6 per CP-002-3 / BL-120).

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
