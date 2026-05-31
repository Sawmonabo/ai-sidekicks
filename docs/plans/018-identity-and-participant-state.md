# Plan-018: Identity And Participant State

| Field | Value |
| --- | --- |
| **Status** | `review` |
| **NNN** | `018` |
| **Slug** | `identity-and-participant-state` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-018: Identity And Participant State](../specs/018-identity-and-participant-state.md) |
| **Required ADRs** | [ADR-001](../decisions/001-session-is-the-primary-domain-object.md), [ADR-007](../decisions/007-collaboration-trust-and-permission-model.md), [ADR-008](../decisions/008-default-transports-and-relay-boundaries.md) (daemon-as-gateway transport boundary governs I-018-8), [ADR-015](../decisions/015-v1-feature-scope-definition.md) |
| **Dependencies** | [Plan-002](./002-invite-membership-and-presence.md) (presence infrastructure; `presence-register-service.ts` shipped NS-26/PR #108); [Plan-001](./001-shared-session-core.md) (`participants` table owner, `session_memberships`, `joinSession`); [Plan-007](./007-local-ipc-and-daemon-control.md) (daemon JSON-RPC method-name registry + `apps/cli` scaffold, Tier 4 remainder); [Plan-008](./008-control-plane-relay-and-session-join.md) **bootstrap** (Tier 1, shipped — the session-bootstrap auth-callback path populates the Plan-018-owned `AuthenticatedIdentityContext`, see D-018-1 / CP-018-3) — **not** the co-tier Plan-008-remainder, which itself depends on Plan-018 for the PASETO issuer + `AuthenticatedIdentityContext` + `RelayConnectionTokenIssuer` (CP-008-4 / CP-018-10), so the Tier-5 build order stays acyclic; [Plan-023](./023-desktop-shell-and-renderer.md) (`window.sidekicks` renderer bridge substrate); [Plan-025 Tier 1 Partial](./025-self-hostable-node-relay.md#tier-1-partial-pr-sequence--substrate-vs-namespace-carve-out) (provides `packages/crypto-paseto/` PASETO v4.public primitives for access-token issuance + v4.local primitives for refresh-token issuance per [ADR-010:29](../decisions/010-paseto-webauthn-mls-auth.md) — symmetric co-dep with Plan-025 resolves at Tier 1 Partial; see [cross-plan-dependencies.md §5 carve-out](../architecture/cross-plan-dependencies.md#5-canonical-build-order); BL-119 resolved 2026-05-20 via Option A; `packages/crypto-paseto/` shipped 2026-05-21 via PR #92) |
| **Cross-Plan Deps** | [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md) |

## Goal

Implement session-scoped participant identity, stable historical authorship, and multi-device presence aggregation for shared collaboration.

## Scope

This plan covers authenticated-identity mapping, participant projection state, device presence fan-out, and stable participant authorship references.

## Non-Goals

- Organization directory sync
- Billing or subscription identity state
- Runtime-node attach internals

## Preconditions

- [x] Paired spec is approved
- [x] Required ADRs are accepted
- [x] Blocking open questions are resolved or explicitly deferred
- [x] Plan-implementation-readiness audit completed (Tier-5 / NS-17, 2026-05-30) — findings folded below; the five Open Decisions were ratified at the user-review pause (D-018-1..D-018-5) and the G3 length-ratio override accepted; status flipped `approved` → `review`

Target paths below assume the canonical implementation topology defined in [Container Architecture](../architecture/container-architecture.md).

## Target Areas

- `packages/contracts/src/participants/`
- `packages/control-plane/src/participants/participant-mapping-service.ts`
- `packages/control-plane/src/participants/participant-projection-service.ts`
- `packages/control-plane/src/participants/participant-state-update-service.ts`
- `packages/control-plane/src/presence/presence-aggregation-service.ts`
- `packages/control-plane/src/presence/presence-register-service.ts` (EXTEND — shipped by Plan-002 NS-26; per-device read accessor added fix-in-place, see CP-018-4)
- `packages/client-sdk/src/participantClient.ts`
- `apps/desktop/src/renderer/src/participants/`
- `apps/cli/src/participants/`

## Data And Storage Changes

- Extend `participants` (owner: Plan-001 per [cross-plan-dependencies.md §1 Contested](../architecture/cross-plan-dependencies.md#1-table-ownership-map) row for `participants` — Plan-018 ALTER/USE adds `display_name`, `identity_ref`, `metadata` columns via additive migrations; columns already recorded in [shared-postgres-schema.md:117,123-126](../architecture/schemas/shared-postgres-schema.md), reciprocity present). `participants.identity_ref` carries a `UNIQUE` constraint (see D-018-2 — a stable synthetic ref, not a `{provider}:{external_id}` projection).
- Add shared `identity_mappings` side table (CREATE per §1 Uncontested row) with `UNIQUE(provider, external_id)` enforcing one canonical mapping per authenticated identity. Participant-profile projection records and device-presence aggregation read from these base tables; presence data is ephemeral per Plan-002 (Yjs Awareness CRDT, in-memory only) and MUST NOT be persisted to a durable table.
- One-participant-per-session is enforced by `session_memberships UNIQUE(session_id, participant_id)` (Plan-002-owned table), not a new constraint on `participants`.
- Ensure canonical event authorship references stable participant ids rather than mutable display metadata.
- See [Shared Postgres Schema](../architecture/schemas/shared-postgres-schema.md) for column definitions.

## API And Transport Changes

- Add `ParticipantProjectionRead`, `ParticipantStateUpdate`, and `PresenceDetailRead` to shared contracts and the typed client SDK.
- Expose one session-scoped participant identity with aggregated presence plus optional authorized device detail.
- Client surfaces reach these reads through the local daemon JSON-RPC gateway (I-018-8), not a direct control-plane client — mirroring the shipped `membershipClient.ts` daemon-proxy pattern.

## Invariants

Behavioral guarantees this plan must preserve. Each is bound to the Tasks that uphold it (see §Implementation Phase Sequence) and is the unit the spec-reviewer checks during code execution.

- **I-018-1 — One participant per identity per session.** A given authenticated identity (`provider` + `external_id`) resolves to exactly one participant record within a session; re-authentication or multi-device login MUST NOT mint a second participant. Backed by `identity_mappings UNIQUE(provider, external_id)` + `session_memberships UNIQUE(session_id, participant_id)`. (Spec-018:40,87; ADR-001.) Tasks: T2.1, T2.2, T2.4.
- **I-018-2 — Stable placeholder identity.** When authenticated profile metadata is incomplete, the participant still resolves to a stable, non-empty placeholder identity that persists for the session rather than a null/transient value. (Spec-018:55.) Tasks: T2.3.
- **I-018-3 — Stable historical authorship.** Event/run authorship references the immutable participant id, never mutable display metadata; a display-name change MUST NOT rewrite or re-attribute prior events. (Spec-018:43,57,71; ADR-001.) Tasks: T1.1, T1.2, T3.3, T3.5.
- **I-018-4 — Highest-activity presence precedence.** Aggregated session presence reflects the participant's highest-activity device per the ordering `online > idle > reconnecting > offline`, NOT the most-recent device. (Spec-018:49,50.) Tasks: T1.4, T3.1, T3.2, T3.4.
- **I-018-5 — Conservative no-false-offline.** Presence aggregation never reports a participant offline while any device retains live or reconnecting state; ambiguity resolves toward the more-present state. (Spec-018:56.) Tasks: T3.1.
- **I-018-6 — Device-detail read authorization.** `PresenceDetailRead` (per-device fan-out) is served only to the authorized set (D-018-5: owner/operator-only); the aggregated summary is the unauthorized default. (Spec-018:63; ADR-007.) Tasks: T1.3, T3.4, T4.4.
- **I-018-7 — Self-authorized state update.** A participant may update only their own display state; `ParticipantStateUpdate` is self-scoped and carries no actor-override field. (Spec-018:62; ADR-007.) Tasks: T1.2, T3.5, T4.4.
- **I-018-8 — Daemon-as-gateway single transport.** Client surfaces (SDK, CLI, renderer) reach participant/presence reads through the local daemon JSON-RPC gateway, never a direct control-plane client; the daemon proxies control-plane-stored identity/membership truth. (ADR-008 transport-boundary decision; `membershipClient.ts:24-51` precedent.) Tasks: T4.1, T4.3.
- **I-018-9 — Renderer is bridge-only.** The desktop renderer reads participant/presence state exclusively through the `window.sidekicks` preload bridge projection, never a direct daemon socket or control-plane fetch. (ADR-009; Spec-023.) Tasks: T4.2.

## Cross-Plan Obligations

Surfaces this plan shares with, consumes from, or owes back to other plans. Format mirrors the §3 dependency map; each names the provider plan and whether reciprocity is present or owed.

- **CP-018-1 — `participants` ALTER (record-only).** Plan-018 adds `display_name`, `identity_ref`, `metadata` to the Plan-001-owned `participants` table via additive migration ([cross-plan-deps §1 Contested](../architecture/cross-plan-dependencies.md#1-table-ownership-map); columns already in shared-postgres-schema.md:117,123-126). Provider: Plan-001 (owner). Reciprocity present — no precursor PR needed.
- **CP-018-2 — `identity_mappings` CREATE.** Plan-018 creates the `identity_mappings` side table ([§1 Uncontested](../architecture/cross-plan-dependencies.md#1-table-ownership-map)). Uncontested ownership; Plan-018 ships the migration.
- **CP-018-3 — First-sighting auth context producer (ratified — D-018-1).** The `(provider, external_id, profile)` input to T2.1 is produced outside Plan-018 by the auth-callback / token-exchange path (Plan-008 bootstrap / Plan-025 token issuance). **Ratified (D-018-1, reading (c)):** Plan-018 owns the `AuthenticatedIdentityContext` contract shape (sole consumer); producer plans populate it. This is a non-secret tuple — no per-participant secret crosses the seam (the former shared-`ikm` pairing with Plan-022 is dissolved; see D-018-1).
- **CP-018-4 — Per-device presence accessor on `presence-register-service.ts` (ratified — D-018-3, fix-in-place).** T3.2 adds a per-device read accessor to the shipped `presence-register-service.ts` (Plan-002 NS-26/PR #108; [§2:82](../architecture/cross-plan-dependencies.md#2-package-path-ownership-map) planning-time-attributes the file to Plan-008, now overtaken by the NS-26 ship). Disposition: fix-in-place EXTEND (file is live; project fix-in-place-over-rigid-ownership stance). Reciprocity owed: amendment note on the Plan-002/Plan-008 presence surface (cross-plan-deps §2:82, executed at swap).
- **CP-018-5 — `membership.created` emission (deferred, informational).** Plan-018 consumes `session_memberships` rows but does NOT emit membership-lifecycle events; that emission is Plan-006's obligation (Tier 4, ADR-017 event-sourcing). No new obligation on Plan-018.
- **CP-018-6 — `participant.*` JSON-RPC method-name registry (proposed).** T4.1/T4.2/T4.3 consume `participant.projectionRead` / `participant.stateUpdate` / `participant.presenceDetail` method strings; these must be ratified into the Plan-007 daemon method-name registry. Names proposed pending Plan-007 registry merge.
- **CP-018-7 — `presence.permission_denied` 403 error code (registered at swap).** T4.4's `PresenceDetailRead` gate returns a `presence.permission_denied` error; this requires a `presence` ErrorNamespace + code in the `error-contracts.md` corpus, registered at swap alongside this flip (batched with the other Tier-5 error codes).
- **CP-018-8 — `ParticipantProjection.state` field (author-internal + wire-doc sync).** T1.1 authors the `state: MembershipState` field that the [api-payload-contracts.md](../architecture/contracts/api-payload-contracts.md) `ParticipantProjection` illustration omits (F-018-1-01). Code-canonical per Spec-018:42; recommend re-syncing the wire-doc illustration.
- **CP-018-9 — Renderer presence-subscribe reuse.** T4.2 reuses the Plan-002 `presence.subscribe({ sessionId })` bridge channel (CP-002-5 projection shape) rather than minting a new subscription. Provider: Plan-002 (shipped NS-26).
- **CP-018-10 — `RelayConnectionTokenIssuer` provides-surface owed to Plan-008 R3 (reciprocal of [Plan-008](./008-control-plane-relay-and-session-join.md) CP-008-4 surface (c) / OD-008r-3).** Plan-018 **provides** a constructor-injected `RelayConnectionTokenIssuer` whose signing key + custody stay **entirely within Plan-018** — the same custody-stays-with-producer seam as CP-008-8's injected Ed25519 signer. It mints the short-lived (TTL 300s, Spec-008:156) `RelayNegotiationResponse.connectionToken` PASETO v4.public, an Ed25519 **sign** that MUST NOT execute inside Plan-008's verify-only zero-knowledge relay broker (holding this signing key in the broker would breach I-008-5). Consumer: Plan-008 R3 `RelayNegotiation` endpoint (T-008r-3-6) injects the issuer and authors no sign. The issuer-surface shape is Plan-018-owned (ratified OD-008r-3); the concrete issuer + its `FixtureRelayConnectionTokenIssuer` test double are authored at Plan-018 execution (no new task minted in this `review`-state stub — surfaced for the implementer, parallel to CP-018-4). Ordering reciprocal: Plan-018 lands **before** Plan-008-remainder R2/R3 ([cross-plan-dependencies.md §5](../architecture/cross-plan-dependencies.md#5-canonical-build-order) F-008r-C, recorded at swap).

## Ratified Design Decisions (Tier 5 audit, 2026-05-30)

The Tier-5 plan-readiness audit (NS-17) surfaced five open decisions; all five were ratified at the user-review pause and are folded here as the plan's design of record. The cross-cutting corpus amendments they entail (Spec-018 §State pins; `shared-postgres-schema.md`; `api-payload-contracts.md`; `error-contracts.md`) are executed at swap alongside this `approved → review` flip. (The G3 length-ratio gate mechanically failed on this sub-100-line stub; the exceedance is 100% required-section backfill, leaner in absolute terms than the in-band Tier-5 plans, and the override was accepted at the pause.)

- **D-018-1 (was Open Decision 1, CP-018-3) — Plan-018 owns the `AuthenticatedIdentityContext` contract shape (reading (c)).** The `(provider, external_id, profile)` first-sighting input is a **non-secret** auth-context tuple; Plan-018 defines its contract shape (it is the sole consumer) and the producer plans (Plan-008 session-bootstrap / Plan-025 token-issuance) populate it. This avoids a cross-tier contract handshake. **Dissolution note:** this is purely the non-secret identity tuple — Plan-018 produces **no per-participant secret** for any consumer. The former "shared `ikm`" framing (the C-5-01 dedup that paired this with Plan-022's content-key decision) is **dissolved**: Plan-022's content key is now an independent random 32-byte AES-256 DEK (Plan-022 D-022-2), so Plan-022 consumes nothing secret from Plan-018. The two decisions are independent and were ratified independently.
- **D-018-2 (was Open Decision 2, F-018-2-02) — `participants.identity_ref` is a stable synthetic ref (reading (b)).** A distinct stable primary ref (PASETO `kid` / synthetic handle) decoupled from any single provider — not a denormalized `{provider}:{external_id}` projection, which would break `identity_ref UNIQUE` when a second provider links to the same person. Entails a Spec-018 §State / `shared-postgres-schema.md:125` pin (executed at swap).
- **D-018-3 (was Open Decision 3, CP-018-4 / F-018-3-02) — per-device accessor lands fix-in-place (reading (b)).** Plan-018 EXTENDs the shipped `presence-register-service.ts` (Plan-002 NS-26) in place with an amendment note, rather than handing the accessor off to the §2:82 planning-time owner via a precursor PR. The file is already live and the project's recorded stance treats rigid one-plan-per-file ownership as an anti-pattern. Reciprocity owed: a cross-plan-deps §2:82 amendment note (executed at swap).
- **D-018-4 (was Open Decision 4, F-018-3-05) — `lastSeen` carries the winning (precedence) device's value.** When the highest-activity device ≠ the most-recently-seen device, the projection carries the precedence-device's `lastSeen`, so `{state, lastSeen}` stay internally consistent. Entails a Spec-018 pin (executed at swap).
- **D-018-5 (was Open Decision 5, F-018-3-06 / I-018-6) — `PresenceDetailRead` is owner/operator-only (reading (b)).** Per-device detail is privacy-sensitive fan-out; the aggregated summary remains the participant default. Entails a Spec-018 / security-architecture pin (executed at swap).

Cross-cutting amendments owed (author-proposed, executed at swap): CP-018-6 (`participant.*` method strings → Plan-007 registry + `api-payload-contracts.md`), CP-018-7 (`presence.permission_denied` error code → `error-contracts.md`), CP-018-8 (wire-doc `ParticipantProjection.state` re-sync).

## Implementation Steps

- Contracts: See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed schemas this plan consumes.

1. Define participant-id, authorship, projection, and device-presence contracts in shared packages.
2. Implement control-plane participant mapping from authenticated identity into one canonical participant record per session.
3. Implement presence aggregation, display-state updates, and stable historical authorship projection.
4. Add desktop and CLI participant surfaces for aggregated presence and session-scoped participant state.

## Implementation Phase Sequence

Audit-derived task decomposition. Four phases map 1:1 to the four Implementation Steps; 17 Tasks total. Each Task row carries the fields the plan-execution plan-analyst consumes verbatim: **Files** (target paths), **Spec coverage** (the spec rows the Task satisfies), **Verifies invariant** (the I-018-N it upholds), **Consumes** (upstream symbols/rows + their provider), **BLOCKED-ON** where a build-order dependency must resolve first, and **Decided** recording the ratified Tier-5 decision (D-018-N) that cleared a former Open-Decision gate.

### Phase 1 — Participant & Presence Contracts

Shared Zod/TypeScript contracts. No control-plane logic; pure schema. All consumed primitives ship from Plan-001 (`session.ts`) and Plan-002 (`presence.ts`).

#### Tasks

- **T1.1 — `ParticipantProjectionRead` + `ParticipantProjection` (with `state` field).**
  - Files: `packages/contracts/src/participants/projection.ts` (CREATE), `packages/contracts/src/participants/index.ts` (CREATE barrel)
  - Spec coverage: Spec-018:61 (ParticipantProjectionRead), Spec-018:42 (display state = id + name + role + membership state + presence summary)
  - Verifies invariant: I-018-3
  - Consumes: `ParticipantId`, `SessionId`, `MembershipRole`, `MembershipState` from `packages/contracts/src/session.ts` (shipped); `PresenceState` from `packages/contracts/src/presence.ts` (shipped, Plan-002 NS-26)
  - Note: authors the `state: MembershipState` field the wire-doc illustration omits (CP-018-8); code-canonical per Spec-018:42.
- **T1.2 — `ParticipantStateUpdate` request/response.**
  - Files: `packages/contracts/src/participants/state-update.ts` (CREATE), index barrel (EXTEND)
  - Spec coverage: Spec-018:62 (ParticipantStateUpdate), Spec-018:43,71 (display-name change MUST NOT rewrite authorship)
  - Verifies invariant: I-018-3, I-018-7
  - Consumes: `ParticipantId` (session.ts, shipped)
  - Note: schema is `.strict()` so the request cannot carry an authorship/actor-override field — binds I-018-3 and I-018-7 at the wire boundary.
- **T1.3 — `PresenceDetailRead` request/response.**
  - Files: `packages/contracts/src/participants/presence-detail.ts` (CREATE), index barrel (EXTEND)
  - Spec coverage: Spec-018:63 (PresenceDetailRead, authz-gated), Spec-018:41,49 (per-device detail)
  - Verifies invariant: I-018-6
  - Consumes: `ParticipantId`, `SessionId`, `PresenceState` (shipped)
- **T1.4 — `PRESENCE_SUMMARY_PRECEDENCE` ordering constant.**
  - Files: `packages/contracts/src/participants/presence-precedence.ts` (CREATE), index barrel (EXTEND)
  - Spec coverage: Spec-018:50 (online > idle > reconnecting > offline)
  - Verifies invariant: I-018-4
  - Consumes: `PresenceState` (shipped Plan-002)
  - Note: distinct from the shipped `PRESENCE_PROGRESSION` degradation table (F-018-3-04 — wrong rank order, ties online/idle); this is the activity-rank used by aggregation.

### Phase 2 — Identity → Participant Mapping

Control-plane service mapping authenticated identity to one canonical participant per session. Ships the `participants` ALTER + `identity_mappings` CREATE migration.

#### Tasks

- **T2.1 — Idempotent identity→participant upsert (participant-first FK ordering).**
  - Files: `packages/control-plane/src/participants/participant-mapping-service.ts` (CREATE); migration: `participants` ALTER (+`display_name`, +`identity_ref`, +`metadata`) + `identity_mappings` CREATE
  - Spec coverage: Spec-018:40 (one identity → one participant per session), Spec-018:69 (mapping in shared control-plane storage)
  - Verifies invariant: I-018-1
  - Consumes: `identity_mappings` / `participants` rows; `ParticipantId` (contracts); `session_memberships` (Plan-002, shipped); `joinSession` (Plan-001, shipped). Repairs the double-mint at `session-directory-service.ts:180-186`.
  - Decided: D-018-1 (Plan-018-owned `AuthenticatedIdentityContext` shape, CP-018-3) + D-018-2 (`identity_ref` = stable synthetic ref) — both ratified Tier-5; the prior Phase-2 gate is cleared. Uniqueness keys source-forced: `identity_mappings UNIQUE(provider, external_id)`, `participants.identity_ref UNIQUE`, `session_memberships UNIQUE(session_id, participant_id)`.
- **T2.2 — Default display metadata from authenticated profile.**
  - Files: `participant-mapping-service.ts` (same)
  - Spec coverage: Spec-018:48 (display name/metadata seeded from authenticated profile)
  - Verifies invariant: I-018-1
  - Consumes: `participants.display_name` / `metadata` columns; `authContext.profile` from the Plan-018-owned `AuthenticatedIdentityContext` (CP-018-3 / D-018-1; producer plan populates it)
- **T2.3 — Placeholder identity on partial profile.**
  - Files: `participant-mapping-service.ts` (same)
  - Spec coverage: Spec-018:55 (stable placeholder when profile incomplete)
  - Verifies invariant: I-018-2
  - Consumes: `participants` ALTER columns
- **T2.4 — One-participant-per-session enforcement (`session_memberships UNIQUE` + `joinSession`).**
  - Files: `participant-mapping-service.ts` (same)
  - Spec coverage: Spec-018:40, Spec-018:87 (pitfall: duplicate participants on re-auth)
  - Verifies invariant: I-018-1
  - Consumes: `session_memberships` (Plan-002), `joinSession` (Plan-001)

### Phase 3 — Presence Aggregation & Projection

Highest-activity presence reduction, participant projection assembly, and stable-authorship display updates. Diverges from the shipped recency-collapse reader (author-internal — F-018-3-01/02 are CRITICAL but resolve without a new table or concept).

#### Tasks

- **T3.1 — Highest-activity presence aggregation.**
  - Files: `packages/control-plane/src/presence/presence-aggregation-service.ts` (CREATE)
  - Spec coverage: Spec-018:41 (aggregate device presence), Spec-018:49,50 (presence summary + precedence), Spec-018:56 (conservative no-false-offline)
  - Verifies invariant: I-018-4, I-018-5
  - Consumes: per-device presence rows via the T3.2 accessor (NOT the recency-collapsing `readPresence`, `presence-register-service.ts:719-753` — F-018-3-01); `PRESENCE_SUMMARY_PRECEDENCE` (T1.4)
  - Note: authors a new highest-activity reduction; the shipped `readPresence` collapses by recency and MUST NOT be reused for the summary.
  - Decided: D-018-4 (`lastSeen` = winning precedence-device's value) — ratified Tier-5.
- **T3.2 — Per-device presence read accessor on the substrate.**
  - Files: `packages/control-plane/src/presence/presence-register-service.ts` (EXTEND — shipped Plan-002 NS-26/PR #108; fix-in-place)
  - Spec coverage: enabling step for Spec-018:41,49,50,63
  - Verifies invariant: participates in I-018-4; upholds I-002-3 (presence ephemeral — accessor reads the in-memory `#sessions` snapshot, persists nothing)
  - Consumes: private `#sessions` per-device snapshots (author-internal exposure; no new table — F-018-3-02)
  - Note: disposition = fix-in-place (D-018-3, ratified); accessor added to the live file.
- **T3.3 — Participant projection assembly.**
  - Files: `packages/control-plane/src/participants/participant-projection-service.ts` (CREATE)
  - Spec coverage: Spec-018:42 (display state), Spec-018:40,48,61,71 (one participant, profile defaults, projection read, stable authorship)
  - Verifies invariant: I-018-3
  - Consumes: T3.1 aggregate; `session_memberships` role + state; `participants.display_name`; the `state` field authored in T1.1 (Phase 1 → Phase 3 ordering)
- **T3.4 — Device-detail presence projection (`PresenceDetailRead`).**
  - Files: `presence-aggregation-service.ts` (EXTEND own file)
  - Spec coverage: Spec-018:63 (device detail), Spec-018:41,49
  - Verifies invariant: I-018-4, I-018-6
  - Consumes: T3.2 accessor; T3.1 reduction
  - Decided: D-018-5 (PresenceDetailRead = owner/operator-only) — ratified Tier-5.
- **T3.5 — Stable-authorship-preserving display update.**
  - Files: `packages/control-plane/src/participants/participant-state-update-service.ts` (CREATE)
  - Spec coverage: Spec-018:43,71 (display-name change preserves authorship), Spec-018:62 (ParticipantStateUpdate), Spec-018:88 (pitfall: mutable display rewriting history)
  - Verifies invariant: I-018-3, I-018-7
  - Consumes: `participants` display-metadata columns

### Phase 4 — Client Surfaces & Authorization

Typed SDK (daemon-as-gateway), renderer subtree, CLI commands, and the service-layer authz binding. CLI depends on the Plan-007-remainder Tier-4 `apps/cli` scaffold (Tier 4 < Tier 5 — resolved by build order, not an open decision).

#### Tasks

- **T4.1 — `participantClient` SDK (daemon-as-gateway).**
  - Files: `packages/client-sdk/src/participantClient.ts` (CREATE), client-sdk index barrel (EXTEND)
  - Spec coverage: Spec-018:61,62,63 (the three reads/updates), Spec-018:49 (presence summary)
  - Verifies invariant: I-018-8
  - Consumes: the three Phase-1 contracts; `JsonRpcClient` (Plan-007 substrate, shipped Tier 1); `participant.*` method strings (CP-018-6, proposed)
  - Note: transport authored daemon-as-gateway (author-with-citation: ADR-008 transport boundary + `membershipClient.ts:24-51` precedent; Spec-018:69-as-forcing-fact rebutted — membership is equally control-plane-stored yet daemon-proxied — F-018-4-05).
- **T4.2 — `participants/` renderer subtree.**
  - Files: `apps/desktop/src/renderer/src/participants/` (CREATE) + `apps/desktop/src/renderer/src/participants/__tests__/*.test.tsx`
  - Spec coverage: Spec-018:42 (display state, partial), Spec-018:49 (presence summary)
  - Verifies invariant: I-018-9
  - Consumes: `window.sidekicks` daemon bridge (Spec-023); `presence.subscribe({ sessionId })` (Plan-002, CP-018-9); `participant.*` methods (CP-018-6)
  - Note: single-client RTL component tests ship NOW, mirroring merged NS-29 `apps/desktop/src/renderer/src/session-members/__tests__/participant-roster.test.tsx` (`@testing-library/react` `render`/`screen` + `installMockBridge` `{ daemon: { call, subscribe } }` + bridge-projection assertion). Two-client live-presence E2E defers to the Tier-8 Playwright harness (Plan-023), NOT BL-131 (Plan-003-scoped, premise overtaken by NS-29 — F-018-4-06).
- **T4.3 — `participants/` CLI commands.**
  - Files: `apps/cli/src/participants/` (CREATE)
  - Spec coverage: Spec-018:42 (partial), Spec-018:49
  - Verifies invariant: I-018-8
  - Consumes: T4.1 `participantClient`; `apps/cli` harness (Plan-007-remainder Tier 4 scaffold)
  - BLOCKED-ON: Plan-007-remainder Tier 4 `apps/cli` scaffold (`depends_on` ordering, resolved by Tier 4 < Tier 5 — F-018-4-07; not an open decision).
- **T4.4 — Authorization-gate enforcement binding.**
  - Files: enforced in `presence-aggregation-service.ts` (PresenceDetailRead gate) + `participant-state-update-service.ts` (self-only gate) — no new file
  - Spec coverage: Spec-018:63 (PresenceDetailRead authorized-only), api-payload-contracts self-update self-authz (ADR-007)
  - Verifies invariant: I-018-6, I-018-7
  - Consumes: `presence.permission_denied` 403 error code (CP-018-7, proposed); ADR-007 permission model
  - Decided: D-018-5 (the gate enforces owner/operator-only) — ratified Tier-5.

## Parallelization Notes

- Participant mapping and presence aggregation can proceed in parallel once id and authorship contracts are fixed.
- Client surfaces should wait for aggregated-status precedence rules and device-detail authorization to stabilize.

## Test And Verification Plan

- Multi-device presence tests proving one authenticated identity still yields one participant per session
- Historical authorship tests proving display-name changes do not rewrite prior events
- Fallback-profile tests proving stable placeholder identity works when profile metadata is incomplete

## Rollout Order

1. Land participant and authorship contracts plus shared persistence
2. Enable presence aggregation and participant projection reads
3. Enable participant display-state editing and device-detail reads where authorized

## Rollback Or Fallback

- Hide device-level detail and keep only aggregated participant presence if device fan-out semantics regress.

## Risks And Blockers

- Guest or anonymous identity support remains unresolved for the first implementation (deferral tracked in parent [Spec-018](../specs/018-identity-and-participant-state.md))
- Presence aggregation can become misleading if conflicting device activity is not handled conservatively
- **Phase-2 code-land was gated on Open Decisions 1 and 2** (auth context producer shape, identity_ref derivation) — both ratified at the Tier-5 pause (D-018-1 Plan-018-owned `AuthenticatedIdentityContext`; D-018-2 stable synthetic ref), so the gate is cleared; the Spec-018 / `shared-postgres-schema.md` pins land at swap.
- **Phase-3/4 Tasks T3.1/T3.4/T4.4 were gated on Open Decisions 4 and 5** (lastSeen source, PresenceDetailRead authorized-set) — both ratified (D-018-4 precedence-device `lastSeen`; D-018-5 owner/operator-only); the Spec-018 pins land at swap.

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
