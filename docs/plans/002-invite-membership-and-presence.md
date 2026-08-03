# Plan-002: Invite Membership And Presence

| Field | Value |
| --- | --- |
| **Status** | `review` |
| **NNN** | `002` |
| **Slug** | `invite-membership-and-presence` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-002: Invite Membership And Presence](../specs/002-invite-membership-and-presence.md) |
| **Required ADRs** | [ADR-001](../decisions/001-session-is-the-primary-domain-object.md), [ADR-002](../decisions/002-local-execution-shared-control-plane.md), [ADR-007](../decisions/007-collaboration-trust-and-permission-model.md), [ADR-008](../decisions/008-default-transports-and-relay-boundaries.md), [ADR-015](../decisions/015-v1-feature-scope-definition.md), [ADR-018](../decisions/018-cross-version-compatibility.md) |
| **Dependencies** | [Plan-001](./001-shared-session-core.md) (session tables, `session_memberships` schema); [Plan-007 partial-deliverable](./007-local-ipc-and-daemon-control.md) (Tier 1 `Spec-007 §Wire Format` substrate — Plan-002 registers the `presence.*` JSON-RPC method namespace under it); [Plan-008 bootstrap-deliverable](./008-control-plane-relay-and-session-join.md) (Tier 1 tRPC v11 server skeleton — hosts Plan-002's invite/membership tRPC routes once Plan-002 ships at Tier 2); [Plan-023 Tier 1 Partial](./023-desktop-shell-and-renderer.md#tier-1-partial-pr-sequence) (Tier 1 — `apps/desktop/src/renderer/` substrate + preload-bridge `window.sidekicks` for Phase 6 renderer per CP-002-5; satisfied on `develop`); [Plan-025 Tier 1 Partial](./025-self-hostable-node-relay.md#tier-1-partial-pr-sequence--substrate-vs-namespace-carve-out) (Tier 1 — `packages/crypto-paseto/` v4.public + v4.local primitives for Phase 2 invite-token minting per CP-002-4; BL-119 resolved 2026-05-20 via Option A). See [cross-plan-dependencies.md §3 Plan-002 row](../architecture/cross-plan-dependencies.md#3-inter-plan-dependency-graph). **Cross-tier phase-level obligations (not plan-start deps):** [Plan-021](./021-rate-limiting-policy.md) for Phase 4 invite-endpoint rate-limit wiring per [CP-002-3](#cross-plan-obligations) ([BL-120](../backlog.md), Phase 4 deferred to Tier 6). [Spec-024](../specs/024-cross-node-dispatch-and-approval.md) is **not** a dependency for Plan-002 — historical Session H-interim header reference; cross-node dispatch implementation belongs to [Plan-027](./027-cross-node-dispatch-and-approval.md) per [cross-plan-dependencies.md §Spec-024 Implementation Plan](../architecture/cross-plan-dependencies.md#spec-024-implementation-plan). |
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

`MembershipUpdate` with `action=change_role` and `newRole=owner` MUST be issued by an existing owner. The target MUST already hold active membership (`Spec-002 §Required Behavior`). A non-owner cannot self-elevate; an invitee in a non-owner role cannot be promoted to owner during invite acceptance.

**Why load-bearing.** Owner elevation is the trust-model load-bearing surface declared by ADR-007. Allowing self-elevation or invite-time promotion would invert the permission graph.

**Verification.** Test must assert that a non-owner caller's `MembershipUpdate{action=change_role, newRole=owner}` returns the typed permission error and does not mutate `session_memberships`.

### I-002-2 — Last-owner-cannot-leave

The system MUST prevent the last remaining owner from leaving a session (`Spec-002 §Required Behavior`). A self-leave attempt by the sole owner MUST return a typed error directing the owner to transfer ownership first; `session_memberships` MUST NOT be mutated.

**Why load-bearing.** A session with zero owners is unrecoverable — no participant can issue further `MembershipUpdate` calls or transfer ownership. This is a one-way door.

**Verification.** Test must assert that a sole-owner self-leave attempt returns the typed error and the owner row remains in `session_memberships` unchanged.

### I-002-3 — Presence is ephemeral, never persisted

Presence state (Yjs Awareness CRDT) MUST live in memory only and MUST be garbage-collected on disconnect (`Spec-002 §Default Behavior`, `Spec-002 §State And Data Implications`). Plan-002 MUST NOT add a SQLite or Postgres table that stores presence rows.

**Why load-bearing.** Persisting presence creates a stale-state surface (rows survive the disconnect that should have garbage-collected them) and conflates ephemeral CRDT state with durable membership. Audit-relevant presence transitions (`presence.online`, `presence.idle`, `presence.reconnecting`, `presence.offline`) are emitted as `session_events` per Spec-006 — that event log is the durable surface; the live CRDT state is not.

**Verification.** §Data And Storage Changes already declares "Presence data is ephemeral... must NOT be persisted to a durable table." Schema-shape regression test asserts no presence-state table is created by Plan-002 migrations.

### I-002-4 — Lock-ordering inherits from Plan-001

Plan-002 transactional callers that mutate `session_memberships` while validating `sessions` MUST follow the lock-ordering invariant `sessions` → `session_memberships` declared in [Plan-001 §Invariants I-001-1](./001-shared-session-core.md#invariants). Owner-transfer, co-owner promotion, and invite-accept paths are the canonical Plan-002 callers under this constraint.

**Why load-bearing.** Cross-plan deadlocks under concurrent membership churn — the exact failure mode the Plan-001 docstring documents.

**Verification.** Each Plan-002 transactional caller extends the existing lock-ordering test in `packages/control-plane/src/sessions/__tests__/session-directory-service.test.ts` (or a sibling test under `packages/control-plane/src/memberships/__tests__/`) with an assertion that lock acquisition matches the canonical order.

### I-002-5 — The typing indicator carries no content and mints no durable event

The transient typing indicator MUST convey composition _activity_ only (`Spec-002 §Required Behavior`, `Spec-002 §Default Behavior`): message content, keystrokes, and draft text MUST NOT appear in the `activity.typing` Awareness field or in any presence payload, and a typing set/clear cycle MUST NOT append a `session_events` row. No presence surface MAY name a membership-restricted channel (`Spec-002 §Default Behavior`, sender-side suppression, 2026-08-03): composing in one publishes no typing indicator at all, and `focusedChannelId` publishes absent while focus sits in one — suppressed at the publishing daemon, fail-closed on an unresolvable channel id. The four durable `presence.*` types enumerated in `Spec-002 §State And Data Implications` remain the complete durable presence set.

**Why load-bearing.** The no-persistence half is already bound by I-002-3; this invariant binds the properties I-002-3 does not. A content-bearing typing field would turn a presence channel into an unreviewed draft-text broadcast — draft text crosses the fan-out to every session subscriber before its author has chosen to send it, and it does so over a surface with no approval gate. A durable typing event would turn composition into a per-keystroke audit trail: surveillance exhaust that is retained under the same retention policy as real session history while carrying none of its evidentiary value. And a presence payload naming a `direct` channel would fan that channel's existence to every session subscriber through the control-plane presence channel — a path that bypasses both the relay recipient filter and the I-002-6 `ChannelList` omission, so without this half the two enumeration-surface filters guard a door the presence fan-out props open. All are one-way disclosures once a wire shape ships and downstream consumers depend on it.

**Verification.** Test Pr5 asserts (a) an `activity.typing` payload validates to exactly `{channelId, since}` and rejects any content-bearing member, (b) a typing set/clear cycle appends zero `session_events` rows, (c) composing in a membership-restricted channel publishes no typing indicator and holds `focusedChannelId` absent — driven through the daemon presence handler (the production producer path), never by direct Awareness-state injection — and (d) an unresolvable channel id is suppressed (the fail-closed arm).

### I-002-6 — `ChannelList` omits `direct` channels for callers outside the member pair

The `ChannelList` projection MUST filter its response **per caller** (`Spec-002 §Interfaces And Contracts`): a channel of the `direct` kind ([Spec-016 §Interfaces And Contracts](../specs/016-multi-agent-channels-and-orchestration.md#interfaces-and-contracts), D-016-21) MUST be omitted **entirely** — `id`, `name`, `state`, and `participantCount` all absent, never blanked — for any caller outside its immutable two-human member pair. The caller MUST be the authenticated principal resolved from the control-plane auth context (the PASETO v4 identity per [ADR-010](../decisions/010-paseto-webauthn-mls-auth.md) / [Security Architecture](../architecture/security-architecture.md)); a caller-supplied identity MUST NOT be accepted, and the request shape stays exactly `{sessionId: SessionId}`. The filter binds `direct` channels only: a `participants`-audience channel — the bootstrap `main` channel included — stays visible to every session member per [Spec-016 §Resolved Questions and V1 Scope Decisions](../specs/016-multi-agent-channels-and-orchestration.md#resolved-questions-and-v1-scope-decisions).

**Why load-bearing.** Existence metadata is the whole disclosure at stake on a two-human channel: an id, a name, and a participant count identify who is talking privately to whom, which is the fact a `direct` channel exists to keep, and a leaked existence is not recoverable by a later fix because the observer has already read it. It is also this surface's **only** per-caller predicate — every other input to a `ChannelList` response is session-scoped — so the surface fails **open** by default: the next contributor to widen the projection's channel source (Plan-016's Tier-6 channel rows are the first candidate) discloses unless the omission is pinned as an invariant, and nothing else on the read path would notice. It is likewise the control-plane half of a two-surface property: `Spec-016 §Interfaces And Contracts` deliberately scopes its `channel.rosterRead` omission to the daemon surface, so channel-existence non-disclosure holds across V1 only while both halves hold.

**Verification.** Test P11 asserts (a) a non-member caller's `ChannelList` response omits the `direct` channel entirely — no blanked row, no count — (b) each member of the pair receives it, (c) a `participants`-audience channel is returned for every session member (the unchanged-path control), and (d) the predicate is evaluated against the principal the auth context authenticated, driven end-to-end through the surface that terminates authentication rather than against a principal hand-passed into the projection.

## Preconditions

- [ ] Paired spec is approved — **re-opened 2026-08-03:** Spec-002 flipped `approved → review` by the V1 product-vision reconciliation amendment (two legs in one record — the transient typing-indicator presence contract and the `ChannelList` per-caller `direct`-channel filter). Re-checks when that amendment's single restoring re-promotion returns Spec-002 to `approved`; see the readiness-audit box below for the gate this shares.
- [x] Required ADRs are accepted
- [x] Blocking open questions are resolved or explicitly deferred
- [ ] **Plan-readiness audit complete per [`docs/operations/plan-implementation-readiness-audit-runbook.md`](../operations/plan-implementation-readiness-audit-runbook.md)** — Tier 2 audit landed via NS-14 (merged 2026-05-20); see [Status Promotion Gate §1](../operations/plan-implementation-readiness-audit-runbook.md#status-promotion-gate). Audit findings amended in-PR; ACTIONABLE-class deferrals (PASETO `crypto-paseto` substrate carve-out, Phase 4 Tier 6 wiring) tracked via BL-119 + BL-120 + BL-121 per [runbook §Cross-Tier Amendment Contingency](../operations/plan-implementation-readiness-audit-runbook.md#cross-tier-amendment-contingency). Phase 2 invite-token issuer prerequisite (`packages/crypto-paseto/` v4.local substrate per CP-002-4) shipped 2026-05-21 via [PR #92](https://github.com/Sawmonabo/ai-sidekicks/pull/92) — see [Plan-025 §Decision Log](./025-self-hostable-node-relay.md#decision-log).

  **Re-opened 2026-08-03, scoped to the V1 product-vision reconciliation amendment (two legs: the transient typing indicator and the `ChannelList` per-caller `direct`-channel filter):** the amendment authors new contract surface — the `activity.typing` Awareness field in `packages/contracts/src/presence.ts` and the per-caller `direct`-channel omission on the `ChannelList` read path in `packages/control-plane/src/channels/channel-list-projection.ts`, two new load-bearing invariants (§Invariants I-002-5 and I-002-6), and two new build tasks (T3.5, T3.6) on the already-shipped Phase 3 — a NEW-contract-surface behavior change, the same rule that re-opens this row elsewhere in the corpus. So this box un-checks, Status flips `approved → review`, and no lane-1 code PR under Plan-002 (T3.5, T3.6, and the Tier-6 Phase 4 remainder included) dispatches until a targeted readiness-audit delta audits **both** legs of that amendment — additionally carrying the run-keyed agent-activity reshaping of the agent indicator that `Spec-002 §Default Behavior` pins (the scalar `activity.typing` cannot carry concurrent runs on one daemon's Awareness client; Codex PR #284 round 3) — re-checks this box, and restores `approved` — that queued delta PR is the single delivery-and-promotion vehicle for both. **Campaign collision.** The BL-resolution campaign's Task 5 (PR-B1) separately schedules an as-yet-unexecuted Spec-002 / Spec-021 / Plan-002 `approved → review` flip for the `invite.preview` contract ([BL-133](../backlog.md)), with Task 6 (PR-B1p) as its restoring re-promotion; every Task-5 and Task-6 step box in [the campaign plan](../superpowers/plans/2026-07-09-bl-resolution-campaign.md) was still unchecked as of 2026-08-03, so this amendment's flip is independent of and **precedes** it. Consequently the Task-6 restoration pass must re-promote across **both** amendments — the 2026-08-03 vision-reconciliation amendment (the typing-indicator contract and the `ChannelList` per-caller filter, one record) and `invite.preview` — not only the one it was originally written for.

Target paths below assume the canonical implementation topology defined in [Container Architecture](../architecture/container-architecture.md).

## Target Areas

- `packages/contracts/src/invites.ts`
- `packages/control-plane/src/invites/`
- `packages/control-plane/src/memberships/`
- `packages/control-plane/src/presence/`
- `packages/control-plane/src/channels/` (the `ChannelList` read-only projection — shipped at T3.4b, per-caller filtered at T3.6)
- `packages/client-sdk/src/membershipClient.ts`
- `apps/desktop/src/renderer/src/session-members/`

## Data And Storage Changes

- Add shared `session_invites` table (CREATE).
- Extend `session_memberships` (owner: Plan-001 per [cross-plan-dependencies.md §1 Contested](../architecture/cross-plan-dependencies.md#1-table-ownership-map) row for `session_memberships` — Plan-002 ALTER/USE adds invite-driven membership flows).
- Presence data is ephemeral (Yjs Awareness CRDT, in-memory only) and must NOT be persisted to a durable table.
- See [Shared Postgres Schema](../architecture/schemas/shared-postgres-schema.md) for column definitions.

## API And Transport Changes

- Add invite CRUD endpoints, membership update endpoints, and presence heartbeat transport to the client SDK.
- Add `ChannelList` read-only projection per [Spec-002 §Interfaces And Contracts](../specs/002-invite-membership-and-presence.md#interfaces-and-contracts). Request: `{sessionId: SessionId}`. Response: `{channels: Array<{id: ChannelId, name?: string, state: ChannelState, participantCount: number}>}`. The bootstrap `main` channel is a projected structural invariant synthesized at `session.created` time — 1:1 with the session, its id a pure function of the session id (`deriveMainChannelId(sessionId)`), never an event-sourced row; runtime channel creation (`ChannelCreate`) is owned by [Plan-016](./016-multi-agent-channels-and-orchestration.md) at Tier 6. `ChannelList` projects whatever channels currently exist regardless of who created them, **subject to the per-caller filter** the 2026-08-03 amendment adds to that same section (§Invariants I-002-6): a `direct` channel (Spec-016 D-016-21) is omitted entirely for any caller outside its immutable two-human member pair, keyed on the authenticated principal the control-plane auth context resolves — never a request field, so the request shape above is unchanged and the omission is a read-path predicate rather than a contract change.
- Register the `presence.*` JSON-RPC method namespace (`PresenceUpdate`, `PresenceRead`) under the Plan-007-partial wire substrate per [Spec-002 §Heartbeat Transport](../specs/002-invite-membership-and-presence.md#heartbeat-transport). Plan-002 owns the namespace handlers and Zod schemas; the substrate (framing, error model, supervision hooks) is owned by Plan-007-partial.

## Cross-Plan Obligations

- **CP-002-1 — `packages/control-plane/src/presence/`** is CREATED by Plan-002 Phase 3 (Tier 2); EXTENDED by [Plan-008-remainder](./008-control-plane-relay-and-session-join.md) (Tier 5) for hosted-relay fan-out and [Plan-018](./018-identity-and-participant-state.md) (Tier 5) for trusted-device presence trails. Plan-002 owns `presence-register-service.ts`; downstream extenders add sibling files under the same directory per [cross-plan-dependencies.md §2 row `packages/control-plane/src/presence/`](../architecture/cross-plan-dependencies.md#2-package-path-ownership-map).
- **CP-002-2 — `presence.*` JSON-RPC namespace** registered by Plan-002 Phase 3 under the [Plan-007 partial](./007-local-ipc-and-daemon-control.md) wire substrate. Handlers land at `packages/runtime-daemon/src/ipc/handlers/presence-*.ts`; the substrate (framing, error envelope, method-name registry) is owned upstream by Plan-007-partial.
- **CP-002-3 — Invite-endpoint rate-limit wiring** uses [Plan-021](./021-rate-limiting-policy.md) `rateLimitProcedure` middleware factory. Plan-021 ships the middleware at Tier 6; Plan-002 Phase 4 applies it to invite-endpoint procedures at Tier 6 (post-Plan-021). See Phase 4 below for the deferral declaration and [cross-plan-dependencies.md §3 Plan-002 ↔ Plan-021 edge](../architecture/cross-plan-dependencies.md#3-inter-plan-dependency-graph). Cross-tier deferral tracking: BL-120.
- **CP-002-4 — PASETO v4.local token minting** depends on [Plan-025](./025-self-hostable-node-relay.md) `packages/crypto-paseto/`. **Option A chosen 2026-05-20 ([BL-119](../archive/backlog-archive.md#bl-119-plan-025-crypto-paseto-tier-1-partial-carve-out-decision) resolved).** Plan-002 Phase 2 consumes the [Plan-025 Tier 1 Partial carve-out](./025-self-hostable-node-relay.md#tier-1-partial-pr-sequence--substrate-vs-namespace-carve-out) of `packages/crypto-paseto/` (v4.public + v4.local primitives + RFC vectors — substrate-vs-namespace decomposition mirroring Plan-007-partial / Plan-008-bootstrap / Plan-023-partial). Plan-002 Phase 2 implementation starts only after Plan-025 Tier 1 Partial merges; see [cross-plan-dependencies.md §5](../architecture/cross-plan-dependencies.md#5-canonical-build-order) for the carve-out's tier placement.
- **CP-002-5 — Renderer surface (`apps/desktop/src/renderer/src/session-members/`)** consumes the [Plan-023 Tier 1 Partial](./023-desktop-shell-and-renderer.md#tier-1-partial-pr-sequence) preload-bridge `window.sidekicks` surface. The two-client end-to-end manual smoke acceptance criterion (Phase 6 Goal) is gated on the Plan-023 Tier 8 IPC dispatcher; until then, Phase 6 acceptance is component-test + single-client smoke. See Phase 6 below.
- **CP-002-6 — Invite/membership lifecycle event emission** (`membership_change` category — the 9 `invite.*` / `membership.*` lifecycle types) is assigned to Plan-002 as the **emitter plan** per [Plan-006 §Event Taxonomy Coverage](./006-session-event-taxonomy-and-audit-log.md#event-taxonomy-coverage). The emitting surface is **daemon-side** — events append to the per-daemon SQLite `session_events` log per [ADR-017](../decisions/017-shared-event-sourcing-scope.md) (the control plane has no event log) — and is **NOT in Phase 2**, whose control-plane services (`invite-service.ts`, `membership-service.ts`) own only the authoritative coordination-state transitions. Emission lands once [Plan-006](./006-session-event-taxonomy-and-audit-log.md) (Tier 4) ships the `event-log-service.ts` append path + integrity protocol and [Plan-008-remainder](./008-control-plane-relay-and-session-join.md) (Tier 5) relay sync makes daemons aware of control-plane invite/membership transitions; `Spec-002 §Invite Revocation` (revocation audit events in session history) is therefore satisfied at Tier 4, not Tier 2. Same earlier-tier-emitter deferral as Plan-003's `runtime_node.*` (see the Plan-003 → Plan-006 row in [cross-plan-dependencies.md §3](../architecture/cross-plan-dependencies.md#3-inter-plan-dependency-graph)). Tracked for Plan-006's readiness audit. As part of this same change, [Spec-006](../specs/006-session-event-taxonomy-and-audit-log.md)'s `membership_change` payload was amended to carry the optional `reason?` audit field that the `InviteRevoke` contract already captures (`Spec-002 §Invite Revocation`), reconciling the event payload with the merged contract's audit-log promise. Plan-002 Phase 3's presence state-change events (`presence.online`/`idle`/`reconnecting`/`offline`) are an additional `membership_change`-category emission set, but follow a **different emission path** from the invite/membership types above: presence is **daemon-locally observed** (a dropped local-client WebSocket / missed heartbeat is detected daemon-side per `Spec-002 §Heartbeat Transport`), so it needs neither control-plane detection nor the Plan-008-remainder Tier 5 relay sync the invite/membership types require. Phase 3 ships only the canonical-shape seam + projector forward-compat-skip; the production runtime trigger is a **deferred deps-implementor obligation** on the daemon's heartbeat/WS-liveness watcher (documented on `PresenceSubscribeDeps.subscribeToPresence` in `packages/runtime-daemon/src/ipc/handlers/presence-subscribe.ts`, wired by the Plan-001 Phase 5 bootstrap layer), and once wired the events land in `session_events` via the daemon's durable append path + forward-compat-skip — originally the Plan-001 `SessionService.append` substrate, which required no Plan-006 Tier 4 dependency; since the Plan-006 T3.1 precondition discharge (2026-07-28, PR #272) that path is guarded test-only, so the production trigger lands its events through T3.1's `EventLogService.append` and inherits the Tier 4 durable-writer dependency. Presence shares with invite/membership the Plan-006 Tier 4 typed-integrity `presence.*` variant deferral (the taxonomy upgrade) and — since the append-guard discharge — the Tier 4 durable-writer substrate; it still requires neither control-plane detection nor the Plan-008-remainder Tier 5 relay sync.
- **CP-002-7 — Bootstrap main-channel identity contract.** Plan-002 Phase 3 establishes the shared `deriveMainChannelId` in [`packages/contracts/src/channel-id.ts`](../../packages/contracts/src/channel-id.ts) as the single source of truth for the bootstrap `main` channel's identity — consumed by BOTH the runtime-daemon session projector AND the control-plane `ChannelList` projection, so the same session resolves to a byte-identical main-channel id on every surface. Both the id (`deriveMainChannelId`) AND the canonical name (`MAIN_CHANNEL_NAME = "main"`) are exported from that same module as the shared source of truth, so Plan-016's "no duplicate main channels" check has a canonical-name referent. [Plan-016](./016-multi-agent-channels-and-orchestration.md) (Tier 6) owns the `channels` SQLite table (storage), but the channel's identity is Plan-002's contract:

  > storage is Plan-016's future decision, but main's identity is not. If main is ever materialized, it must use `deriveMainChannelId(sessionId)`, and the system must not allow duplicate main channels for the same session.

  i.e. when Plan-016 materializes the main channel it MUST use `deriveMainChannelId(sessionId)` for the id and MUST enforce one main channel per session. See [cross-plan-dependencies.md §3 Plan-002 → Plan-016 edge](../architecture/cross-plan-dependencies.md#3-inter-plan-dependency-graph).

- **CP-002-8 — `session_invites` Path-2 crypto-shred reciprocal (⇄ [Plan-022](./022-data-retention-and-gdpr.md) CP-022-6).** On a valid participant purge (`DELETE /participants/{id}/data`), the Plan-002-owned `session_invites` rows that reference the purged participant (e.g. `inviter_id`) are **anonymized in place** — the `inviter_id` FK is nulled via `ON DELETE SET NULL` (Plan-022's forward ALTER relaxes the FK) — not hard-DELETEd — in [Plan-022](./022-data-retention-and-gdpr.md)'s Postgres-side shred fan-out ([Spec-022 §Shred Fan-Out](../specs/022-data-retention-and-gdpr.md#shred-fan-out) Path 2 FK-safety), preserving referential integrity and the invite audit trail (`Spec-022 §Postgres (Control Plane) Deletion`). Reciprocal of Plan-022 CP-022-6 (encoded fix-in-place at the Tier-5 audit swap, satisfying Plan-022 I-022-19); shred-handler provider: Plan-022 (V1.1, owns the cross-store fan-out).

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

The TDD test list below is enumerated and ordered by implementation dependency. Each test maps to one or more [Spec-002 acceptance criteria](../specs/002-invite-membership-and-presence.md#acceptance-criteria) and `Spec-002 §Required Behavior` MUSTs. Tests run via Vitest 4.x projects per [ADR-022](../decisions/022-v1-toolchain-selection.md).

### Contract Layer (`packages/contracts/`)

| ID | Test | Asserts | Spec-002 AC / MUST |
| --- | --- | --- | --- |
| C1 | `InviteCreate payload validates required fields (sessionId, inviter, joinMode)` | request schema | `Spec-002 §Interfaces And Contracts` |
| C2 | `Invite lifecycle states enum is exactly {pending, accepted, revoked, expired}` | no `declined` state in V1 | `Spec-002 §Required Behavior` |
| C3 | `MembershipUpdate.action discriminated union covers {change_role, suspend, revoke, reactivate}` | mutation contract | `Spec-002 §Interfaces And Contracts` |
| C4 | `PresenceHeartbeat payload carries the 5 required metadata fields` | `{deviceType, focusedSessionId, focusedChannelId, lastActivityAt, appVisible}` | `Spec-002 §Interfaces And Contracts` |
| C5 | `ChannelList response shape matches the `Spec-002 §Interfaces And Contracts` projection` | read-only projection contract | `Spec-002 §Interfaces And Contracts` |

### Control Plane Layer (`packages/control-plane/`)

| ID | Test | Asserts | Spec-002 AC / MUST |
| --- | --- | --- | --- |
| P1 | `InviteAccept by valid PASETO v4 token creates active membership` | accept happy path | AC1 |
| P2 | `InviteAccept on revoked token returns "invite revoked" error and does not mutate membership` | revocation enforcement | AC3, `Spec-002 §Invite Revocation` |
| P3 | `InviteAccept on expired token returns "invite expired" error regardless of DB state` | expiry validation | `Spec-002 §Token Security Properties` |
| P4 | `Single-use enforcement: second InviteAccept on same jti returns "already accepted" error` | token consumption | `Spec-002 §Token Security Properties` |
| P5 | `Token storage uses SHA-256 hash; plaintext is never persisted` | hash storage invariant | `Spec-002 §Token Security Properties` |
| P6 | `Non-owner MembershipUpdate{action=change_role, newRole=owner} returns typed permission error` | I-002-1 owner-elevation invariant | I-002-1, `Spec-002 §Required Behavior` |
| P7 | `Sole-owner self-leave returns typed error and owner row remains unchanged` | I-002-2 last-owner-cannot-leave invariant | I-002-2, `Spec-002 §Required Behavior` |
| P8 | `Membership revocation persists; revoked participant cannot re-join without new invite` | revocation durability | AC3 |
| P9 | `Lock-ordering test: owner-transfer caller acquires sessions then session_memberships` | I-002-4 lock-ordering invariant | I-002-4 |
| P10 | `Migration shape regression: no presence-state table is created by Plan-002 migrations` | I-002-3 ephemeral-presence invariant | I-002-3, `Spec-002 §State And Data Implications` |
| P11 | `ChannelList omits a direct channel entirely for a non-member caller, returns it for each member of the pair, and returns participants-audience channels to every session member` | I-002-6 per-caller non-disclosure filter — omission not blanking; predicate evaluated against the auth-context principal, driven through the surface that terminates authentication rather than a hand-passed identity | I-002-6, `Spec-002 §Interfaces And Contracts` |

### Presence Layer (`packages/control-plane/src/presence/`)

| ID | Test | Asserts | Spec-002 AC / MUST |
| --- | --- | --- | --- |
| Pr1 | `Yjs Awareness state is in-memory only — no SQLite or Postgres write occurs on heartbeat` | I-002-3 ephemeral-presence invariant | I-002-3, `Spec-002 §State And Data Implications` |
| Pr2 | `Missed heartbeat moves participant to reconnecting before offline (45s grace)` | reconnect grace window | `Spec-002 §Fallback Behavior` |
| Pr3 | `Postgres LISTEN/NOTIFY fan-out delivers presence updates to subscribed clients` | cross-node fan-out | `Spec-002 §Default Behavior` |
| Pr4 | `Presence state-change events preserve the membership_change canonical shape through session_events; projector forward-compat-skips them` | shape-preservation + I-002-3 (production emission trigger deferred — daemon-local watcher per CP-002-6; events land via the durable append path + forward-compat-skip — Tier-4-writer-gated since the 2026-07-28 append-guard discharge, see CP-002-6) | `Spec-002 §State And Data Implications` |
| Pr5 | `activity.typing Awareness payload is exactly {channelId, since}, a typing set/clear cycle appends zero session_events rows, and composing in a membership-restricted channel publishes no typing indicator with focusedChannelId absent (driven through the daemon presence handler, fail-closed on an unresolvable channel id)` | I-002-5 no-content + no-durable-event + restricted-channel-suppression invariant | I-002-5, `Spec-002 §Required Behavior`, `Spec-002 §Default Behavior`, `Spec-002 §State And Data Implications` |

### SDK And Integration Layer (`packages/client-sdk/`, integration)

| ID | Test | Asserts | Spec-002 AC / MUST |
| --- | --- | --- | --- |
| I1 | `Invitee accepts invite into active session without resetting active runs` | live-join non-disruption | AC1 |
| I2 | `Membership remains durable across presence offline → online cycle` | membership/presence separation | AC2 |
| I3 | `ChannelList returns the bootstrap main channel projected for an existing session` | bootstrap projection | C5, AC1 |

### Verification

- `pnpm turbo test` at workspace root green across all packages
- Manual smoke: single-client invite/accept smoke runs after Phase 6 ships (component tests + single-client smoke per Phase 6 §Goal). Full two-client end-to-end smoke (invite from one desktop client, accept from second client, verify roster + presence updates across both clients) is **deferred to Tier 8** per CP-002-5 — gated on the Plan-023 Tier 8 IPC dispatcher; tracked via Phase 6's T6.4 deferred-verification note and [BL-133](../backlog.md)
- All 24 enumerated tests above pass before Plan-002 is marked complete (C1–C5, P1–P11, Pr1–Pr5, I1–I3); renderer-step tests gate Phase 6 independently

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

**Cross-plan touch rationale.** `packages/contracts/src/session.ts` is normally Plan-001 Phase 2-owned per the cross-plan ownership map. The literal "no two plans edit the same file" rule would have routed this fix through a precursor Plan-001 housekeeping PR. We applied a fix-in-place housekeeping exception because: (a) the fix is type-level only (zero runtime change, zero behavioral risk), (b) the defect is pre-existing and only discoverable via downstream composition (Plan-002 was the first composer), (c) the helper avoids ~12 lines of cast-boilerplate repeated across T1.1 / T1.2 / T1.4 plus every future V1 branded ID, and (d) bundling the housekeeping in the surfacing PR avoids cross-plan PR coordination ceremony for a sub-30-LOC fix. This is one-time correction, not Plan-002 claiming ongoing edit rights on Plan-001-owned files. The governance amendment encoding this housekeeping-exception convention has since landed as §2 §Ownership Rule's **Housekeeping Exception** clause ([cross-plan-dependencies.md §Ownership Rule](../architecture/cross-plan-dependencies.md#ownership-rule)).

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

**Files:** `packages/contracts/src/invites.ts`, `packages/contracts/src/index.ts`, `packages/contracts/src/__tests__/invites.test.ts`, `packages/contracts/src/internal/branded.ts` (cross-plan amendment — internal helper, not re-exported from `index.ts`), `packages/contracts/src/session.ts` (cross-plan amendment — refactor 4 existing UUID ID schemas to use the helper) **Spec coverage:** Spec-002 §Interfaces And Contracts (`InviteCreate` required fields); Spec-002 §Required Behavior (invite lifecycle states `{pending, accepted, revoked, expired}`; no `declined` state in V1); C1, C2 **Verifies invariant:** none (contract layer)

##### T1.2 — Define `MembershipUpdate` discriminated union, `MembershipRole`, `MembershipState` enums in `packages/contracts/src/memberships.ts`.

**Files:** `packages/contracts/src/memberships.ts`, `packages/contracts/src/index.ts`, `packages/contracts/src/__tests__/memberships.test.ts` **Spec coverage:** Spec-002 §Interfaces And Contracts (`MembershipUpdate.action` discriminated union covers {change_role, suspend, revoke, reactivate}); C3 **Verifies invariant:** none (contract layer)

##### T1.3 — Define `PresenceHeartbeat`, `PresenceUpdate`/`PresenceRead` shapes, `PresenceState` enum, `JoinMode` enum in `packages/contracts/src/presence.ts`.

**Files:** `packages/contracts/src/presence.ts`, `packages/contracts/src/index.ts`, `packages/contracts/src/__tests__/presence.test.ts` **Spec coverage:** Spec-002 §Interfaces And Contracts (`PresenceHeartbeat` carries the 5 required metadata fields `{deviceType, focusedSessionId, focusedChannelId, lastActivityAt, appVisible}`); C4 **Verifies invariant:** none (contract layer)

##### T1.4 — Define `ChannelList` request/response + `ChannelState` enum in `packages/contracts/src/channels.ts` (no channel-creation contracts — owned by Plan-016).

**Files:** `packages/contracts/src/channels.ts`, `packages/contracts/src/index.ts`, `packages/contracts/src/__tests__/channels.test.ts` **Spec coverage:** Spec-002 §Interfaces And Contracts (`ChannelList` read-only projection request/response shape); C5 **Verifies invariant:** none (contract layer)

##### T1.5 — Author Postgres migration creating `session_invites` table (no `session_memberships` ALTER — Plan-001 owns).

**Files:** `packages/control-plane/src/migrations/0002-session-invites.ts` **Spec coverage:** Spec-002 §State And Data Implications (invite records durable until terminal state; presence ephemeral — no durable presence table) **Verifies invariant:** I-002-3 (verified-by-omission: migration creates `session_invites` only and does NOT create a presence-state table; P10 regression test in T2.5 asserts this)

##### T1.6 — Wire Vitest tests C1–C5 + anti-leakage assertion (no `ChannelCreate` contracts shipped).

**Files:** `packages/contracts/src/__tests__/anti-leakage.test.ts` **Spec coverage:** Spec-002 §Interfaces And Contracts (`ChannelList` is the only channel surface contracted in Spec-002; `ChannelList` request/response shape ships here, while `ChannelCreate` is explicitly handled by Plan-016 per Spec-002) **Verifies invariant:** none (cross-plan ownership boundary)

### Phase 2 — Control-Plane Invite And Membership Services

**Precondition:** Phase 1 merged AND [Plan-025 Tier 1 Partial](./025-self-hostable-node-relay.md#tier-1-partial-pr-sequence--substrate-vs-namespace-carve-out) merged (`packages/crypto-paseto/` v4.public + v4.local primitives available as workspace dep `@ai-sidekicks/crypto-paseto`). Phase 2 consumes the v4.local `encryptV4Local`/`decryptV4Local` surface for invite-token minting per [CP-002-4](#cross-plan-obligations); BL-119 resolved 2026-05-20 via Option A.

```yaml
preconditions:
  - { type: plan_phase, plan: 2, phase: 1, status: merged }
  - { type: pr_merged, ref: 92 }
  - { type: cross_plan_carve_out, ref: "Plan-025 Substrate-vs-Namespace Carve-Out" }
```

**Goal:** Tests P1–P10 go green.

- `packages/control-plane/src/invites/invite-service.ts` — issuance (PASETO v4.local with 256-bit CSPRNG, jti, SHA-256 hash storage per [ADR-010](../decisions/010-paseto-webauthn-mls-auth.md)), acceptance (single-use enforcement), revocation (owner-only per `Spec-002 §Invite Revocation`), expiry validation
- `packages/control-plane/src/memberships/membership-service.ts` — `MembershipUpdate` handler with owner-elevation check (I-002-1), last-owner-cannot-leave guard (I-002-2), change_role/suspend/revoke/reactivate paths
- Lock-ordering inheritance from Plan-001 (I-002-4) — every transactional caller follows `sessions` → `session_memberships`
- Audit emission is **deferred** — Phase 2 control-plane services do **not** emit invite/membership lifecycle events and write no `session_events` integrity columns (no `prev_hash` / `row_hash` / `daemon_signature`, no zero-fill placeholders — 32 / 32 / 64 bytes respectively, a runtime-daemon convention, and per [ADR-017](../decisions/017-shared-event-sourcing-scope.md) the control plane has no event log). The `membership_change` emission surface is daemon-side and lands at Plan-006 Tier 4 gated on Plan-008-remainder Tier 5 per [CP-002-6](#cross-plan-obligations); `Spec-002 §Invite Revocation` (revocation audit events in session history) is satisfied at Tier 4, not Tier 2. The Phase 2 deliverable is the authoritative coordination-state transition (`session_invites.state → 'revoked'`), not the event
- Typed errors: `membership.permission_denied` (P6, I-002-1), `membership.last_owner` (P7, I-002-2), `invite.revoked` / `invite.expired` / `invite.already_accepted` (P2/P3/P4)

#### Tasks

##### T2.1 — Implement `invite-service.ts` issuance with PASETO v4.local (consumes `@ai-sidekicks/crypto-paseto` v4.local `encryptV4Local` surface from Plan-025 Tier 1 Partial per CP-002-4 — BL-119 resolved via Option A).

**Files:** `packages/control-plane/src/invites/invite-service.ts` **Spec coverage:** Spec-002 §Token Security Properties (Entropy/CSPRNG; hash storage; Token payload structure); P5 **Verifies invariant:** none (issuance path; hash-storage invariant verified by P5)

##### T2.2 — Implement invite acceptance + single-use enforcement + owner-authorized revocation (state-only: `session_invites.state → 'revoked'`) + expiry validation. Does **not** emit audit events — deferred to Plan-006 Tier 4 per [CP-002-6](#cross-plan-obligations) (the control plane has no event log per ADR-017).

**Files:** `packages/control-plane/src/invites/invite-service.ts`, `packages/control-plane/src/invites/__tests__/invite-service.test.ts` **Spec coverage:** Spec-002 AC1, AC3; Spec-002 §Token Security Properties (single-use enforcement; hash storage; expiry enforcement); Spec-002 §Invite Revocation (immediacy; audit emission — deferred to Tier 4 per CP-002-6, not emitted in Phase 2; owner-authorization); P1, P2, P3, P4, P8 **Verifies invariant:** none (issuance/acceptance path; revocation durability verified by P8)

##### T2.3 — Implement `membership-service.ts` with `MembershipUpdate` handler; enforce I-002-1 + I-002-2 with typed errors.

**Files:** `packages/control-plane/src/memberships/membership-service.ts`, `packages/control-plane/src/memberships/__tests__/membership-service.test.ts` **Spec coverage:** Spec-002 §Required Behavior (owner elevation requires an existing owner; last remaining owner cannot leave); Spec-002 AC3; P6, P7 **Verifies invariant:** I-002-1, I-002-2

##### T2.4 — Wire transactional callers (owner-transfer, co-owner promotion, invite-accept) to the canonical lock-ordering test from Plan-001 (extend `packages/control-plane/src/memberships/__tests__/`).

**Files:** `packages/control-plane/src/memberships/__tests__/lock-ordering.test.ts` **Spec coverage:** P9 **Verifies invariant:** I-002-4

##### T2.5 — Add P1–P9 + P10 (no-presence-table migration regression — coordinates with Phase 1 migration shape) test rows.

**Files:** `packages/control-plane/src/invites/__tests__/invite-service.test.ts`, `packages/control-plane/src/memberships/__tests__/membership-service.test.ts`, `packages/control-plane/src/migrations/__tests__/migration-shape.test.ts` **Spec coverage:** P1, P2, P3, P4, P5, P6, P7, P8, P9, P10 **Verifies invariant:** I-002-1, I-002-2, I-002-3, I-002-4

### Phase 3 — Presence Heartbeat + ChannelList Projection

**Precondition:** Phase 1 + Phase 2 merged (Phase 1's `presence.ts` + `channels.ts` contracts and Phase 2's transactional infrastructure are both load-bearing).

**Goal:** Tests Pr1–Pr5 + P11 + I3 go green; P10 (no-presence-table migration regression) re-verified after Phase 3 lands.

- `packages/control-plane/src/presence/presence-register-service.ts` — Yjs Awareness state ingestion (in-memory only, I-002-3), Postgres LISTEN/NOTIFY fan-out (per [ADR-008](../decisions/008-default-transports-and-relay-boundaries.md) transport choice). Owned by Plan-002 per CP-002-1.
- Local IPC bridge: `presence.*` JSON-RPC method namespace (`PresenceUpdate`, `PresenceRead`) registered under the Plan-007-partial wire substrate. Handlers at `packages/runtime-daemon/src/ipc/handlers/presence-subscribe.ts` and `packages/runtime-daemon/src/ipc/handlers/presence-read.ts` per CP-002-2.
- `ChannelList` projection that synthesizes the bootstrap `main` channel — a projected structural invariant whose id is `deriveMainChannelId(sessionId)` (a pure function of the session id), synthesized at `session.created` time rather than emitted by a `ChannelCreated` event.
- Presence state-change events (`presence.online`/`idle`/`reconnecting`/`offline`) reuse the `membership_change` canonical shape in `session_events`; this PR ships the transition seam + projector forward-compat-skip (presence rows are never persisted, I-002-3). Production emission's runtime trigger is deferred — a daemon-local deps-implementor obligation (heartbeat/WS-liveness watcher), distinct from invite/membership's control-plane + Plan-008-remainder relay path; events land via the daemon's durable append path — since the append-guard discharge (2026-07-28, PR #272) that is Plan-006 T3.1's `EventLogService.append`, so presence shares invite/membership's Plan-006 Tier 4 dependency through both the typed-integrity `presence.*` variants and the durable-writer substrate. See [CP-002-6](#cross-plan-obligations).

- Transient typing indicator (added 2026-08-03) — the `activity.typing = {channelId, since}` Yjs Awareness field per `Spec-002 §Required Behavior` and `Spec-002 §Default Behavior`. It rides the existing Awareness state Phase 3 already ingests, is never carried in `PresenceHeartbeat`, and mints no durable event (I-002-5). Liveness is receiver-evaluated against a 10s display TTL with a 3s sender stop-debounce; there is no sender-stamped deadline. Both producer legs route through the daemon presence surface (T3.5's Files entry for the T3.3 handlers names them): the human leg is driven by the composing client — the composer UI wiring is a consuming obligation on [Plan-023](./023-desktop-shell-and-renderer.md)'s renderer (Tier 8), return-cited per the cross-plan-dependencies §3 Plan-023 row — and the agent leg is daemon-written, edge-triggered off the run state machine (CP-002-6-pattern deferred seam, armed at Plan-004 Tier 5). The publishing daemon applies `Spec-002 §Default Behavior`'s sender-side membership-restricted-channel suppression — typing for such a channel is never published and `focusedChannelId` publishes absent, fail-closed on an unresolvable channel id (I-002-5).

- `ChannelList` per-caller `direct`-channel filter (added 2026-08-03) — the projection omits a `direct` channel ([Spec-016 §Interfaces And Contracts](../specs/016-multi-agent-channels-and-orchestration.md#interfaces-and-contracts), D-016-21) entirely for any caller outside its immutable two-human member pair, keyed on the authenticated principal the control-plane auth context resolves per `Spec-002 §Interfaces And Contracts` (I-002-6). **This retrofits no shipped code.** T3.4b's `channel-list-projection.ts` reads no channels table and synthesizes exactly one channel — the bootstrap `main`, a `participants`-audience structural invariant every session member sees — so no channel the shipped projection returns today changes visibility for anyone; the growth adds a caller parameter and a fail-closed predicate to the read path, and the predicate first has something to exclude when a channel source carrying `direct` channels reaches this surface ([Plan-016](./016-multi-agent-channels-and-orchestration.md), Tier 6). Pinning it now is the point: the predicate is in place **before** that source arrives, rather than being retrofitted onto a surface that has already disclosed. Request and response shapes are unchanged and `packages/contracts/src/channels.ts` is untouched — the identity is auth-context-resolved, never a contract field, so Plan-016 D-016-1 and T1.6's anti-leakage pin on that file both continue to hold.

#### Tasks

_The task ids below were reconciled post-merge to the as-shipped decomposition: the audit's single **T3.4** row shipped as **T3.4a** + **T3.4b**, and **T3.3c** was an orchestrator-introduced contract-author task. Full rationale + shipment provenance (PR + squash commit) in the Shipment Manifest Notes below._

##### T3.1 — Implement `presence-register-service.ts` with Yjs Awareness ingestion (in-memory only); add Pr1 schema-shape regression test asserting no SQLite/Postgres write occurs on heartbeat.

**Files:** `packages/control-plane/src/presence/presence-register-service.ts`, `packages/control-plane/src/presence/__tests__/presence-register-service.test.ts` **Spec coverage:** Spec-002 §Default Behavior (presence is Yjs Awareness, in-memory, garbage-collected on disconnect); Spec-002 §State And Data Implications (presence records are ephemeral — Pr1) **Verifies invariant:** I-002-3 (ephemeral presence — Pr1 schema-shape regression test directly verifies no presence-state table is created)

##### T3.2 — Wire Postgres LISTEN/NOTIFY fan-out for cross-node presence updates (Pr3); reconnect-grace window timer (Pr2).

**Files:** `packages/control-plane/src/presence/presence-register-service.ts` (extends), `packages/control-plane/src/presence/__tests__/presence-register-service.test.ts` (extends) **Spec coverage:** Spec-002 §Fallback Behavior (Pr2 — reconnect grace window before offline); Spec-002 §Default Behavior (Pr3 — Postgres LISTEN/NOTIFY cross-node fan-out) **Verifies invariant:** I-002-3 (indirect — no-persist semantics: fan-out is over the in-memory CRDT, never durable rows)

##### T3.3 — Register `presence.*` JSON-RPC handlers under Plan-007-partial wire substrate; establish the `presence.online/idle/reconnecting/offline` → `session_events` canonical-shape seam (`membership_change` category) with projector forward-compat-skip — production emission trigger deferred (daemon-local watcher; Tier-4-writer-gated since the 2026-07-28 append-guard discharge — see CP-002-6) (Pr4).

**Files:** `packages/runtime-daemon/src/ipc/handlers/presence-subscribe.ts`, `packages/runtime-daemon/src/ipc/handlers/presence-read.ts`, `packages/runtime-daemon/src/ipc/handlers/__tests__/presence-subscribe.test.ts`, `packages/runtime-daemon/src/ipc/handlers/__tests__/presence-read.test.ts` **Spec coverage:** Spec-002 §State And Data Implications (Pr4 — durable presence state-change events); Spec-002 §Interfaces And Contracts (`PresenceUpdate` and `PresenceRead` JSON-RPC surfaces) **Verifies invariant:** none (transport surface + canonical-shape seam; I-002-3 is preserved by the projector's forward-compat-skip of `presence.*` events — no presence rows materialize, and the production emission trigger is deferred — a daemon-local deps-implementor obligation per CP-002-6, whose events land through the Plan-006 T3.1 durable writer since the 2026-07-28 append-guard discharge)

##### T3.3c — Hoist `SubscribeAckResponse` generic into `jsonrpc-streaming.ts` (canonical subscribe-init ack), demote `SessionSubscribeResponse` to a one-line alias seam over it (`session-subscribe.ts` untouched), and mint the `presence.subscribe` wire contract (`PresenceSubscribeRequest`/`PresenceSubscribeResponse`) in `presence.ts`.

**Files:** `packages/contracts/src/jsonrpc-streaming.ts`, `packages/contracts/src/session.ts`, `packages/contracts/src/presence.ts` **Spec coverage:** Spec-002 §Interfaces And Contracts (presence.subscribe wire contract — request/response), Spec-007 §Wire Format (streaming subscribe-init ack primitive) **Verifies invariant:** I-007-7

##### T3.4a — Add the shared Buffer-free `deriveMainChannelId` UUIDv8 derivation + `MAIN_CHANNEL_NAME` to `packages/contracts/src/channel-id.ts` (RFC 9562 §5.8, `@noble/hashes` for Cloudflare-Workers isomorphism); golden-vector test + ESLint `no-restricted-imports`/`no-restricted-globals` guard keeping contracts `node:crypto`- and Buffer-free.

**Files:** `packages/contracts/src/channel-id.ts`, `packages/contracts/src/__tests__/channel-id.test.ts` **Spec coverage:** Spec-002 §Interfaces And Contracts (shared channel-id derivation underpinning the `ChannelList` contract) **Verifies invariant:** none (shared derivation primitive; the `ChannelList` read-path is verified at T3.4b)

##### T3.4b — Migrate the daemon session-projector (drops its local `node:crypto` UUIDv5 derivation) and the new control-plane `ChannelList` projection onto the shared `deriveMainChannelId` — byte-identical bootstrap `main` channel on every surface (CP-002-7); add the I3 projection test.

**Files:** `packages/control-plane/src/channels/channel-list-projection.ts`, `packages/control-plane/src/channels/__tests__/channel-list-projection.test.ts`, `packages/runtime-daemon/src/session/session-projector.ts`, `packages/runtime-daemon/src/session/index.ts`, `packages/runtime-daemon/src/session/__tests__/session-projector.test.ts`, `packages/runtime-daemon/src/session/__tests__/session-service.test.ts`, `packages/contracts/src/index.ts` **Spec coverage:** Spec-002 AC1 (live-join non-disruption depends on the default-channel projection being live at accept time); Spec-002 §Interfaces And Contracts (`ChannelList` projection contract, C5 + I3) **Verifies invariant:** none (the projection synthesizes the bootstrap `main` channel — a projected structural invariant — from the control-plane's own session/membership data; "read-only" means it writes no rows; no Plan-002 invariant on the read path)

##### T3.5 — Add the transient typing indicator: mint the `activity.typing` Awareness field contract in `packages/contracts/src/presence.ts`, apply the 3s sender stop-debounce + 10s receiver display TTL in `presence-register-service.ts`, render "user is typing…" in the participant roster, and add the Pr5 no-content + no-durable-event regression test.

**Files:** `packages/contracts/src/presence.ts` (extends T1.3 — adds the `activity.typing = {channelId, since}` shape; `PresenceHeartbeat` is untouched), `packages/contracts/src/__tests__/presence.test.ts` (extends), `packages/control-plane/src/presence/presence-register-service.ts` (extends T3.1/T3.2 per CP-002-1 — receiver-side TTL evaluation + throttled emission), `packages/control-plane/src/presence/__tests__/presence-register-service.test.ts` (extends — Pr5), `packages/runtime-daemon/src/ipc/handlers/presence-subscribe.ts` + `presence-read.ts` sibling surface (extends T3.3 — the **human producer leg**: the daemon presence surface accepts the `activity.typing` set/refresh/clear member on its update path and forwards it into the daemon's Awareness state, applying the `Spec-002 §Default Behavior` sender-side restricted-channel suppression before anything leaves the machine — the composing-UI wiring that drives this surface is a consuming obligation on the client shell that ships the composer, [Plan-023](./023-desktop-shell-and-renderer.md)'s renderer at Tier 8, return-cited at its audit per the cross-plan-dependencies §3 Plan-023 row; the **agent producer leg** is daemon-written and edge-triggered off the run state machine — set on run start, cleared on run end per `Spec-002 §Default Behavior` — a deferred deps-implementor seam in the CP-002-6 documented pattern, armed when the run-lifecycle substrate lands at Plan-004 Tier 5; Pr5's producer arms drive the daemon handler, never direct Awareness injection), `apps/desktop/src/renderer/src/session-members/participant-roster.tsx` (extends T6.2 per CP-002-5 — display only, over the `window.sidekicks` bridge), `apps/desktop/src/renderer/src/session-members/__tests__/participant-roster.test.tsx` (extends) **Spec coverage:** Spec-002 §Required Behavior (transient typing indicator — composition activity only, never content, and not a fifth presence state); Spec-002 §Default Behavior (`activity.typing = {channelId, since}` under the `activity` namespace; 3s sender stop-debounce; 10s receiver display TTL; receiver-evaluated liveness with no sender-stamped deadline; agent indicators edge-triggered and daemon-written); Spec-002 §State And Data Implications (the indicator mints no durable event); Pr5 **Verifies invariant:** I-002-5 (Pr5 asserts the payload admits no content-bearing member and that a typing set/clear cycle appends zero `session_events` rows), I-002-3 (indirect — the field is Awareness-only, so no durable row materializes)

**Agent-indicator production trigger — deferred deps-implementor obligation.** T3.5 ships the human path end-to-end plus the field contract both paths share. The agent activity indicator is edge-triggered off the run state machine and MUST be written by the owning daemon's Awareness client per `Spec-002 §Default Behavior`; the run state machine is [Plan-004](./004-queue-steer-pause-resume.md)'s surface, so the set-on-run-start / clear-on-run-end wiring is deferred to the deps implementor at the presence handler's deps seam — the same deferral shape [CP-002-6](#cross-plan-obligations) already uses for the presence-transition emission trigger. No new cross-plan obligation id is minted: CP-002-9 is reserved by the BL-resolution campaign's Task 5 (PR-B1) for the `invite.preview` daemon leg, so this deferral rides CP-002-1's existing `packages/control-plane/src/presence/` ownership instead of claiming an id. One shape defect is pinned on this plan's restoring targeted readiness-audit delta rather than deferred silently (Codex PR #284 round 3, recorded at `Spec-002 §Default Behavior`): the scalar `activity.typing` cannot carry two concurrent runs on one daemon's Awareness client, so the delta owes the run-keyed agent-activity contract — per-run entries set on the start edge, each deleted only by its own end edge — landing in `packages/contracts/src/presence.ts` before the Plan-004 Tier-5 seam arms; the human composer scalar is unaffected.

##### T3.6 — Add the `ChannelList` per-caller `direct`-channel filter: thread the authenticated principal into the `ChannelList` read path, omit a `direct` channel entirely for any caller outside its member pair, and add the P11 non-disclosure regression test.

**Files:** `packages/control-plane/src/channels/channel-list-projection.ts` (extends T3.4b — the read path gains a caller parameter supplied by the surface that terminates authentication, and a fail-closed omission predicate applied before the response array is assembled; the file header's verbatim quotation of the §API And Transport Changes "projects whatever channels currently exist regardless of who created them" clause is refreshed to the amended wording in the same edit, so the code's stated contract and the plan's do not diverge), `packages/control-plane/src/channels/__tests__/channel-list-projection.test.ts` (extends T3.4b — P11) **Spec coverage:** Spec-002 §Interfaces And Contracts (`ChannelList` is per-caller filtered — a `direct` channel is omitted entirely for a caller outside its immutable two-human member pair, with id, name, state, and `participantCount` non-disclosed rather than blanked; the caller is the authenticated principal resolved from the control-plane auth context, never a request field, and the request shape stays `{sessionId: SessionId}`); P11 **Verifies invariant:** I-002-6 (P11 asserts the non-member omission, the per-pair-member inclusion, the unchanged `participants`-audience path as its control arm, and that the predicate reads the auth-context principal rather than a hand-passed identity)

**Principal-resolution seam — deferred deps-implementor obligation.** T3.6 ships the predicate and the caller parameter; the **production** value flowing into that parameter is the authenticated principal the control-plane auth context resolves, and that context is not populated at Plan-002's tier — `packages/control-plane/src/server/host.ts` stubs identity resolution, and the `AuthenticatedIdentityContext` shape plus its producer wiring are [Plan-018](./018-identity-and-participant-state.md)'s surface at Tier 5 (Plan-018 CP-018-3 / D-018-1). So the auth-terminating caller is a deps seam T3.6 declares and a later plan populates — the same deferral shape [CP-002-6](#cross-plan-obligations) already uses for the presence-transition emission trigger and T3.5 uses for the agent-indicator trigger. What T3.6 must **not** do is soften the invariant to fit the tier: the parameter admits no request-derived fallback and no default-to-permissive value, so an unresolved principal excludes every `direct` channel rather than disclosing them, and P11 drives the assertion through that seam rather than constructing a principal inside the projection's own call. **No new cross-plan obligation id is minted:** CP-002-9 remains reserved by the BL-resolution campaign's Task 5 (PR-B1) for the `invite.preview` daemon leg, and this filter runs along the same Plan-002 → Plan-016 channel-surface edge [CP-002-7](#cross-plan-obligations) already records (Plan-002 provides, [Plan-016](./016-multi-agent-channels-and-orchestration.md) consumes): `Spec-016 §Interfaces And Contracts` names it as the Plan-002-owned counterpart its `direct`-channel non-disclosure posture depends on, so the obligation rides CP-002-7's ownership rather than claiming an id. **Channel-metadata seam (second input, same no-soften rule).** The predicate's other input — which listed channels are `direct`, and their member pairs, in a form this control-plane projection can read — likewise has no V1 producer: event payloads transit the relay E2E-sealed, so the `channel.created` payload (and its queued Spec-006 kind + member-pair mirror) can never feed a control-plane surface, [Spec-008 §Per-Channel Recipient Scoping (V1)](../specs/008-control-plane-relay-and-session-join.md#per-channel-recipient-scoping-v1) is daemon-side by construction with no store and no column, and the [shared Postgres schema](../architecture/schemas/shared-postgres-schema.md) defines no channel table. The producing mechanism is owed by [Plan-016](./016-multi-agent-channels-and-orchestration.md)'s Tier-6 channel source along this same CP-002-7 edge, pinned by that plan's queued restoring targeted readiness-audit delta; until it lands the projection's only entry is the synthesized `main` (never filtered), and once a channel source does land, an entry whose kind the projection cannot resolve is omitted as if `direct` — fail-closed, the same disposition as the principal seam.

**Phase-3 re-open.** T3.5 and T3.6 are post-shipment additions to an already-shipped phase, so Phase 3's declared task set is now a strict superset of its shipped set (T3.1, T3.2, T3.3, T3.3c, T3.4a, T3.4b shipped; T3.5 and T3.6 outstanding) and Phase 3 becomes Plan-002's next lane-1 dispatch target under the declared-⊆-shipped rule. The two are independent — T3.5 touches the presence contract and register service, T3.6 the channel read path — and share no file, so they carry no ordering edge between them. The Shipment Manifest below is an immutable historical record and is NOT retroactively edited to mention either.

### Phase 4 — Rate Limiting Surface (deferred to Tier 6)

**Precondition:** Phase 2 merged AND [Plan-021](./021-rate-limiting-policy.md) Tier 6 ships the `rateLimitProcedure` middleware factory at `packages/control-plane/src/middleware/rate-limit.ts`. Phase 4 is structurally deferred to Tier 6 because Plan-021 ships at Tier 6 — Plan-002 owns the wiring (CP-002-3) but the substrate is unavailable at Tier 2. Cross-tier deferral tracked via BL-120.

**Goal:** Invite rate limits per `Spec-002 §Rate Limiting` (20/session/hr, 50/participant/hr, 100 pending/session) are enforced; the canonical `RateLimitResponse` shape owned by Plan-021 (`packages/control-plane/src/middleware/rate-limit.ts`) is returned on threshold breach.

#### Tasks

##### T4.1 — [Tier 6, post-Plan-021] Apply `rateLimitProcedure({endpoint: 'invite.create' | 'invite.accept' | 'invite.revoke' | …})` middleware to the invite tRPC procedures defined in Phase 2's `invite-service.ts` surface.

**Files:** `packages/control-plane/src/invites/invite-service.ts` (extends Phase 2 surface; wires Plan-021 middleware from `packages/control-plane/src/middleware/rate-limit.ts`) **Spec coverage:** Spec-002 §Rate Limiting (20/session/hr; 50/participant/hr; 100 pending/session) **Verifies invariant:** none (Plan-021 substrate wiring; no Plan-002 invariant)

##### T4.2 — [Tier 6] Add rate-limit verification tests asserting threshold breach returns the canonical 429 + `RateLimitResponse` shape per Plan-021 §`RateLimitResponse` canonical shape.

**Files:** `packages/control-plane/src/invites/__tests__/`, `packages/control-plane/src/invites/invite-service.ts` (service under test) **Spec coverage:** Spec-002 §Rate Limiting (`RateLimitResponse` canonical shape; returned with 429 per Plan-021 §`RateLimitResponse` canonical shape) **Verifies invariant:** none (Plan-021 substrate wiring; no Plan-002 invariant)

### Phase 5 — Client SDK Membership Surface

**Precondition:** Phase 1–Phase 3 merged. `membershipClient.ts` follows the dual-transport factory precedent established by [Plan-001 Phase 5 T5.1](./001-shared-session-core.md) (`packages/client-sdk/src/sessionClient.ts` shipped 2026-05-05 via PR #30).

**Goal:** Tests I1–I3 go green; cross-client invite/accept/presence flows work end-to-end.

- `packages/client-sdk/src/membershipClient.ts` — two factories (`createDaemonMembershipClient(jsonRpcClient)` + `createControlPlaneMembershipClient({fetcher, baseUrl, endpoint?})`) sharing one `MembershipClient` interface; transport branching MUST happen at the factory boundary, not inside method bodies; subscribe paths use async generators wrapping each transport's native streaming primitive. Zod-validate at SDK boundary (mirror `packages/client-sdk/src/sessionClient.ts#createControlPlaneSessionClient` fail-fast).
- Integration tests for live-join non-disruption (I1) + membership/presence separation (I2) + `ChannelList` bootstrap projection (I3).

#### Tasks

##### T5.1 — Implement `membershipClient.ts` daemon factory wrapping `presence.*` JSON-RPC + invite/membership tRPC adapter.

**Files:** `packages/client-sdk/src/membershipClient.ts`, `packages/client-sdk/test/membershipClient.integration.test.ts` **Spec coverage:** Spec-002 AC1 (I1 live-join non-disruption; I3 `ChannelList` bootstrap projection); Spec-002 §Interfaces And Contracts (`ChannelList` contract underpinning I3) **Verifies invariant:** none (SDK transport boundary; substrate invariants verified at services layer per Phase 2/Phase 3)

##### T5.2 — Implement `membershipClient.ts` control-plane factory consuming Plan-008-remainder relay (when shipped at Tier 5; until then, control-plane factory throws `NotImplementedAtTier2Error`).

**Files:** `packages/client-sdk/src/membershipClient.ts`, `packages/client-sdk/test/membershipClient.integration.test.ts` **Spec coverage:** none (Tier 5 forward-compatibility scaffold — at Tier 2 the control-plane factory throws `NotImplementedAtTier2Error`; Spec-002 AC1/AC2 verification on this transport defers to Plan-008-remainder per CP-002-1) **Verifies invariant:** none (SDK transport boundary; deferred-behavior sentinel — `NotImplementedAtTier2Error` envelope only)

##### T5.3 — Add I1–I3 integration tests.

**Files:** `packages/client-sdk/test/membershipClient.integration.test.ts` **Spec coverage:** Spec-002 AC1 (I1), AC2 (I2 membership/presence separation); Spec-002 §Interfaces And Contracts (`ChannelList` contract underpinning I3) **Verifies invariant:** none (SDK transport boundary; substrate invariants verified at services layer per Phase 2/Phase 3)

### Phase 6 — Renderer (Tier 2)

**Precondition:** Phase 5 merged (Phase 6 consumes the Phase-5-hoisted invite/membership contract schemas in `@ai-sidekicks/contracts` + the daemon-side `invite.*` / `presence.*` surface the `membershipClient.ts` SDK wraps, over the `window.sidekicks` bridge — not the SDK client directly) AND Plan-023 Tier 1 Partial complete (`apps/desktop/src/renderer/` substrate exists; preload-bridge `window.sidekicks` typed stub in place per [Plan-023 Tier 1 Partial](./023-desktop-shell-and-renderer.md#tier-1-partial-pr-sequence)). Sequenced at Tier 2 per §Execution Windows above.

**Goal:** Phase 6 component tests + single-client smoke pass (invite acceptance UI renders; roster + presence indicators update via the preload bridge). The full two-client end-to-end smoke acceptance criterion is gated on the Plan-023 Tier 8 IPC dispatcher and ships at Tier 8 per CP-002-5; until then, the two-client smoke is a deferred manual verification step.

- `apps/desktop/src/renderer/src/session-members/` — renderer views for invite acceptance, participant roster, presence indicators (thin projection over the Spec-023 preload-bridge `window.sidekicks` surface; MUST NOT bypass the bridge to reach daemon or control-plane state directly per CP-002-5).

#### Tasks

##### T6.1 — Implement `session-members/invite-accept-view.tsx` issuing `daemon.call("invite.accept", { token })` over the generic `window.sidekicks` preload bridge.

**Files:** `apps/desktop/src/renderer/src/session-members/invite-accept-view.tsx` **Spec coverage:** Spec-002 AC1 (invited participant joins active session without resetting active runs) **Verifies invariant:** none (renderer surface)

##### T6.2 — Implement `session-members/participant-roster.tsx` rendering presence indicators over the generic `window.sidekicks` preload bridge (a `daemon.call("presence.read", { sessionId })` snapshot refreshed on each `daemon.subscribe` presence-stream push).

**Files:** `apps/desktop/src/renderer/src/session-members/participant-roster.tsx` **Spec coverage:** Spec-002 AC1 (joined-membership surface), AC2 (membership durable across presence offline → online cycle) **Verifies invariant:** none (renderer surface)

##### T6.3 — Add Vitest component tests (`@testing-library/react`) for invite-accept view + roster; assert renderer code paths never import from `packages/runtime-daemon/` or `packages/control-plane/` directly (bridge-projection invariant).

**Files:** `apps/desktop/src/renderer/src/session-members/__tests__/invite-accept-view.test.tsx`, `apps/desktop/src/renderer/src/session-members/__tests__/participant-roster.test.tsx` **Spec coverage:** Spec-002 AC1, AC2 (single-client component smoke per Plan-002 §Verification) **Verifies invariant:** none (renderer surface; CP-002-5 bridge-projection cross-plan obligation is enforced by the import-restriction assertion in this task's tests)

**Deferred verification (T6.4 — two-client manual smoke, gated on the Plan-023 Tier 8 IPC dispatcher):** Not a Phase 6 build task and intentionally excluded from the Phase 6 declared-task set — there is no Plan-002 code deliverable (`Files: none`), so the Phase 6 build set is exactly **T6.1–T6.3** (which is what the shipment manifest and the preflight `classifyPhaseShipment` gate now agree on). Once Plan-023 Tier 8 ships the `sidekicks://invite/<token>` protocol handler + bridge-event IPC dispatcher (and the [BL-133](../backlog.md) non-consuming invite-metadata endpoint lands), a manual two-client smoke exercises Spec-002 AC1 + AC2 end-to-end per `Plan-002 §Verification` — deferred to Tier 8 per CP-002-5. No automated invariant rides this PR.

**Tier-8 wiring deferral (shares T6.4's Tier-8 gate):** The end-state contract is now PINNED in the amended [Spec-023 §Deep-Link Invite Flow](../specs/023-desktop-shell-and-renderer.md#deep-link-invite-flow) (token confined to the main process; renderer receives an opaque reference + display metadata; explicit user confirmation; main process accepts on confirm; the raw token never crosses the bridge). T6.1's interim posture — renderer holds the opaque `token` prop and an explicit Accept button issues `daemon.call("invite.accept", { token })` — deviates from that pinned target on two axes: token confinement (renderer-held vs main-confined opaque reference) and acceptance mechanism (renderer-issued `daemon.call("invite.accept", { token })` vs renderer-confirms-via-opaque-reference + main-process-accepts). Only the Tier-8 runtime wiring is deferred — the `sidekicks://invite/<token>` protocol handler + the bridge-event IPC dispatcher + the opaque-reference lifecycle — not the contract decision. The interim explicit-confirmation UX is the target behavior (§Deep-Link property (b)), retained at reshape; the view drops the raw `token` prop for the opaque reference + display metadata.

After Phase 5 lands green at Tier 2, Plan-002's load-bearing semantics are complete. Phase 6 ships at Tier 2 after Phase 5 — the renderer substrate from Plan-023 Tier 1 Partial is independently in place from Tier 1, so the gating reduces to Plan-002's own Phase 5 readiness.

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
  - phase: 2
    task: [T2.1, T2.2, T2.3, T2.4, T2.5]
    pr: 105
    sha: a0b224f
    merged_at: 2026-05-24
    files:
      - packages/control-plane/package.json
      - packages/control-plane/src/invites/__tests__/invite-service.test.ts
      - packages/control-plane/src/invites/invite-service.ts
      - packages/control-plane/src/memberships/__tests__/lock-ordering.test.ts
      - packages/control-plane/src/memberships/__tests__/membership-service.test.ts
      - packages/control-plane/src/memberships/membership-service.ts
      - packages/control-plane/src/migrations/__tests__/migration-shape.test.ts
      - pnpm-lock.yaml
    verifies_invariant: [I-002-1, I-002-2, I-002-3, I-002-4]
    spec_coverage:
      [
        "Spec-002 AC1",
        "Spec-002 AC3",
        "Spec-002 §Required Behavior line 49",
        "Spec-002 §Required Behavior line 50",
        "Spec-002 §Token Security Properties line 109 (single-use enforcement)",
        "Spec-002 §Token Security Properties line 110 (Entropy/CSPRNG)",
        "Spec-002 §Token Security Properties line 111 (hash storage)",
        "Spec-002 §Token Security Properties line 112 (expiry enforcement)",
        "Spec-002 §Token Security Properties line 113 (Token payload structure)",
        "Spec-002 §Invite Revocation line 138 (immediacy)",
        "Spec-002 §Invite Revocation line 141 (audit emission — DEFERRED to Plan-006 Tier 4 per CP-002-6; NOT emitted in Phase 2 — control plane has no event log per ADR-017)",
        "Spec-002 §Invite Revocation line 142 (owner-authorization)",
      ]
  - phase: 3
    task: [T3.1, T3.2, T3.3, T3.3c, T3.4a, T3.4b]
    pr: 108
    sha: 1b8e865
    merged_at: 2026-05-25
    files:
      - docs/architecture/cross-plan-dependencies.md
      - docs/plans/002-invite-membership-and-presence.md
      - eslint.config.mjs
      - packages/contracts/package.json
      - packages/contracts/src/__tests__/channel-id.test.ts
      - packages/contracts/src/channel-id.ts
      - packages/contracts/src/channels.ts
      - packages/contracts/src/index.ts
      - packages/contracts/src/jsonrpc-streaming.ts
      - packages/contracts/src/presence.ts
      - packages/contracts/src/session.ts
      - packages/contracts/src/uuid-canonical.ts
      - packages/control-plane/package.json
      - packages/control-plane/src/channels/__tests__/channel-list-projection.test.ts
      - packages/control-plane/src/channels/channel-list-projection.ts
      - packages/control-plane/src/presence/__tests__/presence-register-service.test.ts
      - packages/control-plane/src/presence/presence-register-service.ts
      - packages/runtime-daemon/src/ipc/handlers/__tests__/presence-read.test.ts
      - packages/runtime-daemon/src/ipc/handlers/__tests__/presence-subscribe.test.ts
      - packages/runtime-daemon/src/ipc/handlers/index.ts
      - packages/runtime-daemon/src/ipc/handlers/presence-read.ts
      - packages/runtime-daemon/src/ipc/handlers/presence-subscribe.ts
      - packages/runtime-daemon/src/ipc/handlers/session-subscribe.ts
      - packages/runtime-daemon/src/session/__tests__/session-projector.test.ts
      - packages/runtime-daemon/src/session/__tests__/session-service.test.ts
      - packages/runtime-daemon/src/session/index.ts
      - packages/runtime-daemon/src/session/session-projector.ts
      - pnpm-lock.yaml
    verifies_invariant: [I-002-3, I-007-7]
    spec_coverage:
      [
        "Spec-002 §Default Behavior line 58",
        "Spec-002 §State And Data Implications line 157 (Pr1)",
        "Spec-002 §Fallback Behavior line 73 (Pr2 — reconnect grace window)",
        "Spec-002 §Default Behavior line 61 (Pr3 — Postgres LISTEN/NOTIFY fan-out)",
        "Spec-002 §State And Data Implications line 157 (Pr4 — durable presence state-change events)",
        "Spec-002 §Interfaces And Contracts line 85 (PresenceUpdate JSON-RPC surface)",
        "Spec-002 §Interfaces And Contracts line 86 (PresenceRead JSON-RPC surface)",
        "Spec-002 §Interfaces And Contracts line 85 (presence.subscribe wire contract — request/response)",
        "Spec-007 §Wire Format lines 50-56 (streaming subscribe-init ack primitive)",
        "Spec-002 §Interfaces And Contracts line 87 (shared channel-id derivation underpinning the ChannelList contract)",
        "Spec-002 AC1",
        "Spec-002 §Interfaces And Contracts line 87 (ChannelList projection contract, C5 + I3)",
      ]
  - phase: 5
    task: [T5.0a, T5.0b, T5.1, T5.2, T5.3]
    pr: 117
    sha: dff6523
    merged_at: 2026-05-26
    files:
      - docs/architecture/contracts/api-payload-contracts.md
      - packages/client-sdk/src/index.ts
      - packages/client-sdk/src/membershipClient.ts
      - packages/client-sdk/test/membershipClient.integration.test.ts
      - packages/contracts/src/invites.ts
      - packages/contracts/src/memberships.ts
      - packages/control-plane/src/invites/invite-service.ts
      - packages/control-plane/src/memberships/membership-service.ts
    verifies_invariant: []
    spec_coverage:
      [
        "Spec-002 §Interfaces And Contracts line 80 (InviteCreate)",
        "Spec-002 §Interfaces And Contracts line 81 (InviteAccept)",
        "Spec-002 §Interfaces And Contracts line 82 (InviteRevoke)",
        "Spec-002 §Interfaces And Contracts line 83 (MembershipUpdate)",
        "Spec-002 AC1 (line 178 — I1 live-join non-disruption)",
        "Spec-002 AC2 (line 179 — I2 membership/presence separation)",
        "Spec-002 line 87 + AC1 (I3 ChannelList bootstrap projection)",
      ]
  - phase: 6
    task: [T6.1, T6.2, T6.3]
    pr: 120
    sha: 9db79b4
    merged_at: 2026-05-27
    files:
      - apps/desktop/src/renderer/src/session-bootstrap/SessionBootstrap.tsx
      - apps/desktop/src/renderer/src/session-bootstrap/__tests__/SessionBootstrap.test.tsx
      - apps/desktop/src/renderer/src/session-members/invite-accept-view.tsx
      - apps/desktop/src/renderer/src/session-members/participant-roster.tsx
      - apps/desktop/src/renderer/src/session-members/__tests__/invite-accept-view.test.tsx
      - apps/desktop/src/renderer/src/session-members/__tests__/participant-roster.test.tsx
      - apps/desktop/src/renderer/src/sidekicks-bridge.d.ts
      - apps/desktop/src/renderer/tsconfig.test.json
      - docs/plans/002-invite-membership-and-presence.md
      - docs/specs/023-desktop-shell-and-renderer.md
    verifies_invariant: []
    spec_coverage:
      [
        "Spec-002 AC1 (line 178 — invited participant joins active session without resetting active runs)",
        "Spec-002 AC2 (line 179 — membership durable across presence offline → online cycle)",
      ]
```

### Notes

<!-- Per-PR human-readable commentary appended by the orchestrator at Phase E. -->

- **PR #102** (squash-commit `347d62b` on `develop`, merged 2026-05-23): Phase 1 — Invite And Membership Contracts + Migration. Six implementer tasks shipped: T1.1 `packages/contracts/src/invites.ts` (`InviteCreate` / `InviteAccept` / `InviteRevoke` / `InviteState` / `InviteId` branded — `JoinMode` consolidated from `InviteJoinMode` per spaced wire-form in Spec-002 + `MembershipRole`); T1.2 `packages/contracts/src/memberships.ts` (`MembershipUpdate` discriminated union on `action=change_role|leave` arms encoding I-002-1 issuer-must-be-owner + I-002-2 last-owner-cannot-leave at the contract layer); T1.3 `packages/contracts/src/presence.ts` (`PresenceHeartbeat` 5-required-1-nullable shape per `Spec-002 §Heartbeat Transport`,`JoinMode` enum, `PresenceUpdate` / `PresenceRead` JSON-RPC schemas registered under the Plan-007-partial wire substrate); T1.4 `packages/contracts/src/channels.ts` (`ChannelList` read-only projection + `ChannelState` + `ChannelMessage` envelope per `Spec-002 §Interfaces And Contracts`); T1.5 `packages/control-plane/src/migrations/0002-session-invites.ts` Postgres v2 migration (table + 3 indexes + 1 UNIQUE constraint, wired into the migration-runner v2 list); T1.6 strict `packages/contracts/src/__tests__/anti-leakage.test.ts` pinning `packages/contracts/src/index.ts` as the public re-export surface across all four new modules. Cross-package addition: `packages/contracts/src/internal/branded.ts` UUID helper consumed by all four new modules and the existing `session.ts` (per **NS-22 cross-plan amendment #1** — Plan-001-owned `session.ts` refactored in-PR to use the shared helper). Migration-runner extended to consume the v2 list (per **NS-23 cross-plan amendment #2** — Plan-001-owned `migration-runner.ts` switched to `applyMigrations(...)` v2 in-PR). Both amendments recorded under [§Phase 1 Cross-Plan Amendments](#phase-1--invite-and-membership-contracts--migration) rather than spawning precursor PRs (sub-day wiring this PR already covered as a side-effect of contract changes; [cross-plan-dependencies.md §Ownership Rule](../architecture/cross-plan-dependencies.md#ownership-rule) rigid single-owner clause to be amended via follow-up; the amendment has since landed as the §2 §Ownership Rule **Housekeeping Exception** clause). Reviewer chain: per-task Phase C (3-reviewer parallel) generated 8 POLISH round-trips and 0 ACTIONABLE; Phase D PR-scope final review round 1 surfaced 1 POLISH (T1.1 `InviteJoinMode` → `JoinMode` consolidation, `1870a02`) + 1 ACTIONABLE (T1.5 migration-runner v2 wiring at `applyMigrations` call-site, `6085d47`); round 2 returned clean. Phase D.5 Codex external review surfaced 1 P1 ACTIONABLE on `anti-leakage.test.ts` (then-lines 76-77) importing via the `@ai-sidekicks/contracts` package path (resolves to `./dist/index.js` — fresh checkouts haven't built it because Turbo `test` chains only on `^build` upstream-only, not the package's own build); fix switched to source-level `../index.js` import (`8781967` — preserves the index.ts re-export-graph testing intent and matches the 9/9 sibling-test convention; verified via `rm -rf dist && pnpm --filter @ai-sidekicks/contracts test`). One incidental [BL-130](../backlog.md) surface during pre-mark-ready CI: the housekeeper-design spec (`docs/superpowers/specs/2026-05-03-plan-execution-housekeeper-design.md` line 76) carried a stale `packages/contracts/src/session.ts` line-388 cite that this PR's Amendment 1 (`internal/branded.ts` extraction) had shifted to whitespace; the `cite-target-existence` hook's path-shaped discriminator caught it post-push (local pre-commit walk skips `docs/superpowers/` per the known BL-130 corpus gap). Refreshed in-PR via `a14d4ca` (substantive cite preserved at `session.ts` line 408 — the SessionSubscribe block; pre-shift line 388 noted in natural-language prose). Test count: 5 contract-package suites (anti-leakage 459 / channels 432 / invites 307 / memberships 460 / presence 764 lines) + 2 control-plane suites (`0002-session-invites` 543 / `migration-runner` 211 lines). Plan-002 Phase 1 closes; Phases 2-6 remain unscheduled (Phase 2 ships at Tier 2 with `packages/crypto-paseto/` substrate now satisfied per Plan-025 PR #92; Phase 4 deferred to Tier 6 per CP-002-3 / BL-120). <!-- cite-shape-example -->
- **PR #105** (squash-commit `a0b224f` on `develop`, merged 2026-05-24): Phase 2 — Control-Plane Invite And Membership Services, **state-only per ADR-017** (the control plane has no event log). Five implementer tasks shipped: T2.1 + T2.2 `packages/control-plane/src/invites/invite-service.ts` (PASETO v4.local invite-token issuance via `@ai-sidekicks/crypto-paseto` — 256-bit CSPRNG + `jti` + SHA-256 hash storage, plaintext never persisted per ADR-010; single-use accept creating a membership in one transaction; owner-only revoke guarded on `state = 'pending'` so a revoke never overwrites a durable terminal state per `Spec-002 §State And Data Implications`; expiry validation → `invite.expired`; typed errors `invite.revoked` / `invite.expired` / `invite.already_accepted`); T2.3 `membership-service.ts` (`MembershipUpdate` handler enforcing I-002-1 issuer-must-be-owner + I-002-2 last-owner-cannot-leave, typed errors `membership.permission_denied` / `membership.last_owner`); T2.4 `lock-ordering.test.ts` (transactional callers — owner-transfer, co-owner promotion, invite-accept — pinned to the canonical `sessions` → `session_memberships` lock order, I-002-4); T2.5 `invite-service.test.ts` + `membership-service.test.ts` + new `migrations/__tests__/migration-shape.test.ts` (P1–P10; P10 migration-shape regression asserts no presence-state table is created by Plan-002 migrations, I-002-3). Control-plane suite green (143 tests). **Scope-widening recorded** (the immutable T2.1 audit `spec_coverage` is NOT retroactively edited; the widening is journaled here): in response to Codex round-trip 1, `createInvite` gained an active-owner-membership authorization gate and now binds the body `inviter` to the authenticated actor — the body `inviter` was previously trusted for authorization (a "supply your own participant id" bypass), closed per the security-architecture Permission Matrix (owner-only "Invite participants", row 299) + `Spec-002 §Invite Revocation`. Reviewer chain: per-task Phase C (3-reviewer parallel) + Phase D PR-scope final review (clean); Phase D.5 Codex external review produced two round-trips — (1) `createInvite` owner-authorization (`bc748b5`); (2) revoke terminal-state guard (`AND state = 'pending'` so a revoke never clobbers a durable `accepted` row, which would mask single-use) + inviter case-insensitivity (RFC 9562 §4 — `.toLowerCase()` on the JS comparison; the owner-probe SQL is already case-insensitive via the `uuid` column) (`a19b943`). **State-only**: no `session_events` rows and no audit emission — `Spec-002 §Invite Revocation` audit emission deferred to Plan-006 Tier 4 per CP-002-6; the Plan-002↔Plan-006 emission seam was closed by governance precursor PR #106 (`926e7c8`) before this PR shipped. Plan-002 Phase 2 closes (NS-25 → `completed`); NS-26 (Phase 3 — presence heartbeat + ChannelList projection) promoted `blocked` → `ready` (the Plan-007-partial IPC wire substrate its `presence.*` handlers consume is shipped). Phases 3-6 remain: Phase 3 dispatchable at Tier 2; Phase 4 deferred to Tier 6 per CP-002-3 / BL-120.
- **PR #108** (squash-commit `1b8e865` on `develop`, merged 2026-05-25): Phase 3 — Presence Heartbeat + ChannelList Projection. Six tasks shipped (the audit's single T3.4 row was split into T3.4a + T3.4b, and T3.3c was an orchestrator-introduced contract-author task — see scope decisions below): **T3.1** `packages/control-plane/src/presence/presence-register-service.ts` — Yjs Awareness state ingestion into an in-memory-only presence registry (never persisted, I-002-3 — the Pr1 schema-shape regression asserting no SQLite/Postgres write on heartbeat doubles as the P10 no-presence-table re-verification); **T3.2** extends the same service — Postgres `LISTEN`/`NOTIFY` cross-node fan-out over the in-memory CRDT (Pr3, transport per [ADR-008](../decisions/008-default-transports-and-relay-boundaries.md)) + a 45s reconnect-grace-window timer driving `online → idle → reconnecting → offline` (Pr2); **T3.3** `packages/runtime-daemon/src/ipc/handlers/presence-subscribe.ts` + `presence-read.ts` — `presence.*` JSON-RPC handlers on the Plan-007-partial wire substrate, establishing the `presence.online/idle/reconnecting/offline` → `session_events` canonical-shape seam (reusing the `membership_change` category so the daemon integrity hash stays valid) with projector forward-compat-skip (Pr4); the production runtime trigger is a deferred daemon-local deps-implementor obligation (heartbeat/WS-liveness watcher) per CP-002-6 — explicitly **not** a Plan-006 Tier 4 gate (the 4 `presence.*` types are absent from CP-002-6's 9-type invite/membership enumeration; emission rides the Plan-001 `SessionService.append` substrate with zero-fill hash placeholders, identical to the existing `session.created` path); **T3.3c** (contract-author) hoisted `SubscribeAckResponse` + `SubscribeAckResponseSchema` (`{subscriptionId}`, `.strict()`) into `packages/contracts/src/jsonrpc-streaming.ts` as the canonical shared subscribe-init ack, demoted `SessionSubscribeResponse` to a one-line alias seam over it (`session-subscribe.ts` untouched), and minted `PresenceSubscribeRequest`/`PresenceSubscribeResponse` in `presence.ts` (verifies I-007-7 — the streaming subscribe-init ack primitive per `Spec-007 §Wire Format`); **T3.4a** extracted a shared Buffer-free `deriveMainChannelId` + `MAIN_CHANNEL_NAME` into `packages/contracts/src/channel-id.ts` (RFC 9562 §5.8 UUIDv8 = SHA-256 over `${sessionId}:main`, `@noble/hashes` for Cloudflare-Workers isomorphism), with a golden-vector test + an ESLint `no-restricted-imports`/`no-restricted-globals` guard keeping contracts `node:crypto`-free and Buffer-free (`6439764`); **T3.4b** migrated both consumers onto it — the daemon session-projector dropped its local `node:crypto` UUIDv5 derivation and the new control-plane `channel-list-projection.ts` synthesizes the bootstrap `main` channel as a projected structural invariant (id = `deriveMainChannelId(sessionId)`, **not** a `ChannelCreated`-sourced row — that event is reserved for Plan-016 user channels), byte-identical on every surface per CP-002-7 (I3) (`c898b4b`). **Orchestrator scope decisions:** T3.3c was introduced when a Phase C review finding flagged a cross-namespace `SessionSubscribeResponseSchema` borrow in the presence push handler — the user chose the full-hardened contracts resolution over a follow-up PR; as part of it the push handler was renamed `presence-update.ts` → `presence-subscribe.ts` to match its registered `presence.subscribe` method (the convention all sibling handlers honour), and `MAIN_CHANNEL_NAME` was unified into the single exported contracts const (Option 1, user-approved). Reviewer chain: per-task Phase C (3-reviewer parallel) + Phase D PR-scope final review. Phase D.5 Codex external review ran **five round-trips** — (1) hardened three foreign-input fields + a FIX-C matcher POLISH; (2) a timing-ceiling assertion + async `onTransition` + teardown re-publish; (3) a test-file-only typecheck fix the package `test` script surfaced that bare `tsc`/vitest missed (`0da6fc5`); (4) three P2 findings — recency state-rank ordering, fan-out `sessionId` validation, channel-id case canonicalization; (5) the presence-map key-canonicalization finding (`d11b024` control-plane + `4812703` contracts). Round-trip 5 carries the load-bearing **parse-vs-cast** insight: the case-variant UUID was canonicalized at the presence map's own key boundary (private `#getClients`/`#setClients`/`#deleteClients` accessors + `participantId` inside `clientKey`), **not** at the schema, because ids in this codebase are branded by bare cast (`as SessionId` at DB-row reads) rather than parsed through `brandedUuidIdSchema`, so a schema-level `.toLowerCase()` would be a no-op on the fan-out receive path; canonicalization is centralized in one brand-preserving `canonicalizeUuid<T>` helper (`packages/contracts/src/uuid-canonical.ts`) that `deriveMainChannelId` also routes through. **Deferred follow-up** (recorded in the `canonicalizeUuid` docstring + the round-trip-5 reply): folding `.toLowerCase()` into the `brandedUuidIdSchema` factory so every _parse_ normalizes is a defensible contracts-level invariant but out of this PR's scope — its cast-site consumers (`invite-service.ts`, `session-directory-service.ts`) belong to other plans and cannot be responsibly migrated here. Test counts: contracts 523 + control-plane 217 green, plus the runtime-daemon presence handler suites. Plan-002 Phase 3 closes (NS-26 → `completed`; a §6 DAG sink — no §6 entry lists `Upstream: NS-26`, so its completion promotes nothing from `blocked` → `ready`). Phases 4-6 remain: Phase 4 (rate-limiting surface) deferred to Tier 6 per CP-002-3 / BL-120; Phase 5 (Client SDK membership surface) + Phase 6 (renderer, Tier 2) unscheduled.
- **PR #117** (squash-commit `dff6523` on `develop`, merged 2026-05-26): Phase 5 — Client SDK Membership Surface. Five tasks shipped — the audit's T5.1/T5.2/T5.3 plus orchestrator-introduced **T5.0a/T5.0b** (a user-authorized contracts-hoist scope expansion, below): **T5.0a** (contract-author, `f6279ad`) hoisted the four invite/membership _response_ schemas (`InviteCreateResponse` / `InviteAcceptResponse` / `InviteRevokeResponse` / `MembershipUpdateResponse` + their `*Schema` Zod validators) into `packages/contracts/src/invites.ts` + `packages/contracts/src/memberships.ts` as the single source of truth, and reconciled `docs/architecture/contracts/api-payload-contracts.md` **up** to the as-built Phase 2 shapes (the doc carried a stale 4-field `InviteAccept` + no `InviteRevoke` response; as-built `InviteAcceptResponse` is 6 fields `{inviteId, membershipId, sessionId, participantId, role, state}`, `InviteRevokeResponse` is `{inviteId, state}`) — load-bearing field-type nuance preserved: `InviteAcceptResponse.state` is `MembershipState` (the new membership's state) while `InviteRevokeResponse.state` is `InviteState`; **T5.0b** (implementer, `e777c66`) a zero-behavior refactor repointing the control-plane producers (`invite-service.ts` + `membership-service.ts`) at the canonical contract types, re-exporting `MembershipUpdateResponse` from `membership-service.ts` to preserve the existing Phase-2 test import surface without editing the test — control-plane suite stays green; **T5.1** (implementer, `cbf5fe9`) `packages/client-sdk/src/membershipClient.ts` daemon factory `createDaemonMembershipClient` — **Option A daemon-as-gateway per [ADR-008](../decisions/008-default-transports-and-relay-boundaries.md)**: a single JSON-RPC transport to the local daemon (native `presence.read` / `presence.subscribe`; daemon-proxied `invite.*` / `membership.update` / `channel.list`), with Zod fail-fast at the SDK boundary mirroring the `sessionClient.ts` precedent and a `packages/client-sdk/src/index.ts` `export *` barrel re-export matching `sessionClient`; **T5.2** (implementer, `8de53f9`) `createControlPlaneMembershipClient`, a Tier-5 forward-compat scaffold whose exported signature models `sessionClient.ts`'s `ControlPlaneSessionClientOptions` (`fetcher` / `baseUrl` / `endpoint?`) but whose body throws `NotImplementedAtTier2Error` until the Plan-008-remainder relay ships at Tier 5 (deferred-behavior sentinel per CP-002-1); **T5.3** (implementer, `5b96d5c`) the I1–I3 integration tests in `packages/client-sdk/test/membershipClient.integration.test.ts` (I1 live-join non-disruption + I3 `ChannelList` bootstrap exercise the daemon factory; I2 membership-durable-across-presence-cycle exercises membership/presence separation; the control-plane transport is not asserted at Tier 2 since T5.2 throws). **Scope expansion (user-authorized 2026-05-26):** T5.0a/T5.0b **pay off** the Phase 2 contracts deferral (PR #105 declared these response types as local control-plane interfaces with explicit "recommending it land in `packages/contracts`" deferral comments) rather than extending it, per the standing hardened-implementation directive; the two tasks are orchestrator-directed, so the audit 1:1-coverage rule applies only to T5.1/T5.2/T5.3. Reviewer chain: per-task Phase C (3-reviewer parallel) + Phase D PR-scope final review; the one residual was a Phase-D **ACTIONABLE → POLISH downgrade** (`b5bae07`) — the control-plane producers `revokeInvite` / `updateMembership` return `| null` on a not-found row while the response schemas and `MembershipClient` signatures are non-null, which read as a `null`-reaches-`client.call` mis-reject risk, but the producers' own docstrings declare the `null` an internal sentinel the wire layer translates to a typed not-found error, so the non-null success schemas are correct as shipped; resolved with self-documenting cross-references at the four producer/SDK sites (zero behavior / schema / signature change). Phase D.5 Codex external review: clean (acked via the thumbs-up reaction shape on the HEAD-anchoring comment — no findings, no review threads). `verifies_invariant` is `[]` by design — Phase 5 is the SDK transport boundary; the I-002-\* substrate invariants are verified at the services layer per Phase 2 / Phase 3, and the shipment-manifest `spec_coverage` records the `Spec-002 §Interfaces And Contracts` + AC1 / AC2 surface this phase exercises. Plan-002 Phase 5 closes (**NS-28 → `completed`**); downstream **NS-29** (Phase 6 — Desktop session-members renderer) promoted `blocked` → `ready` and `P2` → `P1`, its sole upstream now merged. One follow-up surfaced: the Phase 2 invite/membership **authorization error codes** (`membership.permission_denied`, `membership.last_owner`, `invite.permission_denied`) are emitted by the control-plane services but absent from the `error-contracts.md` registry (no `### Membership` section; `invite.permission_denied` missing from the `### Invite` table) — PR #117's Review Notes routed this to BL-103, which is closed/archived, so it is now tracked as **[BL-132](../archive/backlog-archive.md#bl-132-error-contractsmd-invitemembership-authorization-error-code-registration)**. Phase 6 (renderer, Tier 2) is now dispatchable; Phase 4 (rate-limiting) remains deferred to Tier 6 per CP-002-3 / BL-120.
- **PR #120** (squash-commit `9db79b4` on `develop`, merged 2026-05-27): Phase 6 — Desktop session-members Renderer (Tier 2). Three audit tasks plus an orchestrator-introduced **T6.0** ambient-typing hoist shipped: **T6.0** lifted the `window.sidekicks` ambient `declare global` block out of `SessionBootstrap.tsx` into a dedicated `apps/desktop/src/renderer/src/sidekicks-bridge.d.ts` (the conventional Electron+Vite contextBridge-global typing pattern, so the two new views need not couple to an unrelated component's ambient block) and added a `"src/**/*.d.ts"` glob to `apps/desktop/src/renderer/tsconfig.test.json` because TS `extends` replaces rather than merges `include`, so the test typegraph would otherwise hit TS2339 on `window.sidekicks`; **T6.1** `apps/desktop/src/renderer/src/session-members/invite-accept-view.tsx` — the invite-acceptance view, which issues `window.sidekicks.daemon.call("invite.accept", { token })` over the preload bridge's generic daemon-call path — the shipped bridge exposes no `invites` namespace (`invite-accept-view.tsx` (then-lines 80-84, 93); daemon-as-gateway per ADR-008), so the Tier-8 bridge wiring must reach for that generic path rather than minting a one-off `invites` surface (Spec-002 AC1); **T6.2** `participant-roster.tsx` — the live roster, which pairs `presence.read` (decoded participant snapshot on mount, `Spec-002 §Interfaces And Contracts`) with a `presence.subscribe` trigger (each opaque push re-invokes `presence.read`; the `awarenessState` Yjs-CRDT bytes are never accumulated into React state — there is no renderer-side Yjs decoder, and adding one would breach the renderer-untrusted import allowlist), with `offline` rendered as a first-class `PresenceState` so AC2 durability holds (Spec-002 AC2); **T6.3** the Vitest `@testing-library/react` component tests plus the import-restriction assertion enforcing CP-002-5 (the subtree never imports `packages/runtime-daemon/` or `packages/control-plane/` directly). `verifies_invariant` is `[]` by design — Phase 6 is the renderer projection boundary; the I-002-\* substrate invariants are verified at the services layer per Phase 2 / Phase 3, and CP-002-5 is enforced operationally by T6.3's import-scan assertion. Reviewer chain: per-task Phase C (3-reviewer parallel) + Phase D PR-scope final review surfaced three findings — **FINDING 1** ACTIONABLE→resolved (`cc0ef80`): the T6.1 view's divergence from `Spec-023 §Deep-Link Invite Flow` was a deferred contract decision with no Tier-8 dependency, so the deep-link contract was **pinned** in Spec-023 (main confines the invite token and hands the renderer an opaque reference + display metadata; explicit user confirmation; main accepts on confirm) — only the Tier-8 runtime wiring is deferred; **FINDING 2** VERIFICATION (the T6.0 `SessionBootstrap.test.tsx` edit is comment-only — no CP-002-5 perturbation); **FINDING 3** POLISH→resolved (`af53177`): the import-scan test converted to `it.each` named tuples so each pattern self-identifies on failure. Phase D.5 Codex external review ran two round-trips — round 1 pinned the **§Preload Bridge Contract** subscribe-params gap (the daemon requires `{ sessionId }` for `presence.subscribe` but the generic `daemon.subscribe<E>` carries no request-param channel; the param-less signature is pinned as a Tier-1 placeholder, its shape deferred to Plan-007/008); round 2 resolved three P2 findings in commit `5b5c0b9` — FIX A moved `presence.read` inside the subscribe `try` so a subscribe-throw never clobbers the error state; FIX B moved the `sessionId`-change roster reset to a render-phase previous-value guard so no stale frame paints; FIX C corrected §Deep-Link step 3 (the `v4.local` token is opaque to main per ADR-010 and `acceptInvite` is consuming) by pinning a **non-consuming invite-metadata path** in Spec-023, the endpoint deferred to Spec-002/Plan-002 — acked via the thumbs-up reaction shape on the HEAD-anchoring comment. **Cross-plan amendment notes (four directed scope additions touching surfaces another plan owns):** (1) **Plan-023** — the `window.sidekicks` ambient hoist (T6.0) to `sidekicks-bridge.d.ts` lands renderer substrate the Plan-023 Tier 8 remainder had scoped; (2) **Spec-023 / Plan-023** — the [§Deep-Link Invite Flow](../specs/023-desktop-shell-and-renderer.md#deep-link-invite-flow) contract was pinned from this Plan-002 PR (FINDING 1), so the Plan-023 Tier 8 runtime-wiring task implements a pinned contract rather than designing one and should cite the pinned §Deep-Link properties (also recorded in this plan's §Phase 6 Tier-8 wiring deferral); (3) **Spec-023 / Plan-007 / Plan-008** — the [§Preload Bridge Contract](../specs/023-desktop-shell-and-renderer.md#preload-bridge-contract) was pinned to require each daemon subscription to carry its request params, so the Plan-007 / Plan-008 task that narrows `DaemonEvent` / `DaemonParams` / `DaemonEventPayload` must thread the param channel through `daemon.subscribe` and cite the pin; (4) **Spec-023 / Spec-002 / Plan-002** — the [§Deep-Link Invite Flow](../specs/023-desktop-shell-and-renderer.md#deep-link-invite-flow) was pinned to require a non-consuming invite-metadata path, so the invite contract surface (Spec-002 / Plan-002) owes that endpoint's request/response shape, consumption semantics, and expiry/error behavior — **now tracked as [BL-133](../backlog.md)** (criterion-gated; the missing precondition for Plan-023 Tier 8 deep-link rendering, which cannot render the confirmation step without it). `Spec-002 §Invite Delivery` already describes a non-consuming link-resolution surface that endpoint may reuse. Plan-002 Phase 6 closes (**NS-29 → `completed`**); with it all five on-DAG Plan-002 phases (NS-24 / NS-25 / NS-26 / NS-28 / NS-29) are `completed` and Plan-002 is fully shipped on the §6 axis. Phase 4 (rate-limiting) remains the sole NS-unlisted Plan-002 phase, structurally deferred to Tier 6 per CP-002-3 / BL-120.

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
