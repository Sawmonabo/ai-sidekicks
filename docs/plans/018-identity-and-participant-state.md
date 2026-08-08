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
| **Dependencies** | [Plan-002](./002-invite-membership-and-presence.md) (presence infrastructure; `presence-register-service.ts` shipped NS-26/PR #108); [Plan-001](./001-shared-session-core.md) (`participants` table owner, `session_memberships`, `joinSession`); [Plan-007](./007-local-ipc-and-daemon-control.md) (daemon JSON-RPC method-name registry + `apps/cli` scaffold, Tier 4 remainder); [Plan-008](./008-control-plane-relay-and-session-join.md) **bootstrap** (Tier 1, shipped — the Tier-1 tRPC v11 server skeleton hosts Plan-018's participant/presence control-plane routes, the same bootstrap-hosting edge as [Plan-002](./002-invite-membership-and-presence.md); it does **not** populate the `AuthenticatedIdentityContext` — see CP-018-3) — **not** the co-tier Plan-008-remainder, which itself depends on Plan-018 for the PASETO issuer + `AuthenticatedIdentityContext` + `RelayConnectionTokenIssuer` (CP-008-4 / CP-018-10), so the Tier-5 build order stays acyclic; [Plan-023 Tier 1 Partial](./023-desktop-shell-and-renderer.md#tier-1-partial-pr-sequence) (`window.sidekicks` renderer bridge substrate — the Tier-1-shipped slice, not the Tier-8 remainder, so no Tier-5 → Tier-8 back-edge gates this plan); [Plan-025 Tier 1 Partial](./025-self-hostable-node-relay.md#tier-1-partial-pr-sequence--substrate-vs-namespace-carve-out) (provides `packages/crypto-paseto/` PASETO v4.public primitives for access-token issuance + v4.local primitives for refresh-token issuance per [ADR-010 §Decision](../decisions/010-paseto-webauthn-mls-auth.md#decision) — symmetric co-dep with Plan-025 resolves at Tier 1 Partial; see [cross-plan-dependencies.md §5 carve-out](../architecture/cross-plan-dependencies.md#5-canonical-build-order); BL-119 resolved 2026-05-20 via Option A; `packages/crypto-paseto/` shipped 2026-05-21 via PR #92); [Plan-006](./006-session-event-taxonomy-and-audit-log.md) (Tier 4 — Plan-006 T3.3 declares the constructor-injected credential-provider interface (`DaemonCredentialProvider`; declaration hoisted from T4.10 at Codex PR #278 round 1) for Plan-006's daemon-resident callers; this plan's Tier-5 PASETO wiring owes the implementation + injection at every consuming composition root per CP-006-13 / CP-018-12) |
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
- `packages/control-plane/src/identity/relay-connection-token-issuer.ts` (CREATE — Plan-018-owned relay connection-token custody, T4.5)
- `packages/client-sdk/src/participantClient.ts`
- `apps/desktop/src/renderer/src/participants/`
- `apps/cli/src/participants/`

## Data And Storage Changes

- Extend `participants` (owner: Plan-001 per [cross-plan-dependencies.md §1 Contested](../architecture/cross-plan-dependencies.md#1-table-ownership-map) row for `participants` — Plan-018 ALTER/USE adds `display_name`, `identity_ref`, `metadata` columns via additive migrations; columns already recorded in [shared-postgres-schema.md §Participants and Identity (Plan-018)](../architecture/schemas/shared-postgres-schema.md#participants-and-identity-plan-018), reciprocity present). `participants.identity_ref` carries a `UNIQUE` constraint (see D-018-2 — a stable synthetic ref, not a `{provider}:{external_id}` projection).
- Add shared `identity_mappings` side table (CREATE per §1 Uncontested row) with `UNIQUE(provider, external_id)` enforcing one canonical mapping per authenticated identity. Participant-profile projection records and device-presence aggregation read from these base tables; presence data is ephemeral per Plan-002 (Yjs Awareness CRDT, in-memory only) and MUST NOT be persisted to a durable table.
- One-participant-per-session is enforced by `session_memberships UNIQUE(session_id, participant_id)` (Plan-001-owned, Plan-002-extended table — Plan-001 CREATEs per [cross-plan §1](../architecture/cross-plan-dependencies.md#1-table-ownership-map), Plan-002 EXTENDs), not a new constraint on `participants`.
- Ensure canonical event authorship references stable participant ids rather than mutable display metadata.
- See [Shared Postgres Schema](../architecture/schemas/shared-postgres-schema.md) for column definitions.

## API And Transport Changes

- Add `ParticipantProjectionRead`, `ParticipantStateUpdate`, and `PresenceDetailRead` to shared contracts and the typed client SDK.
- Expose one session-scoped participant identity with aggregated presence plus optional authorized device detail.
- Client surfaces reach these reads through the local daemon JSON-RPC gateway (I-018-8), not a direct control-plane client — mirroring the shipped `membershipClient.ts` daemon-proxy pattern.

## Invariants

Behavioral guarantees this plan must preserve. Each is bound to the Tasks that uphold it (see §Implementation Phase Sequence) and is the unit the spec-reviewer checks during code execution.

- **I-018-1 — One participant per identity per session.** A given authenticated identity (`provider` + `external_id`) resolves to exactly one participant record within a session; re-authentication or multi-device login MUST NOT mint a second participant. Backed by `identity_mappings UNIQUE(provider, external_id)` + `session_memberships UNIQUE(session_id, participant_id)`. (`Spec-018 §Required Behavior` + `Spec-018 §Pitfalls To Avoid` + `Spec-018 §Acceptance Criteria` — the last is where the count and the multi-device case are stated together, "one participant per session, even with multiple active devices"; ADR-001.) Tasks: T2.1, T2.2, T2.4.
- **I-018-2 — Stable placeholder identity.** When authenticated profile metadata is incomplete, the participant still resolves to a stable, non-empty placeholder identity that persists for the session rather than a null/transient value. (`Spec-018 §Fallback Behavior`.) Tasks: T2.3.
- **I-018-3 — Stable historical authorship.** Event/run authorship references the immutable participant id, never mutable display metadata; a display-name change MUST NOT rewrite or re-attribute prior events. (`Spec-018 §Required Behavior` + `Spec-018 §Fallback Behavior` + `Spec-018 §State And Data Implications`; ADR-001.) Tasks: T1.1, T1.2, T3.3, T3.5.
- **I-018-4 — Highest-activity presence precedence.** Aggregated session presence reflects the participant's highest-activity device per the ordering `online > idle > reconnecting > offline`, NOT the most-recent device. (`Spec-018 §Default Behavior`.) Tasks: T1.4, T3.1, T3.2, T3.4.
- **I-018-5 — Conservative no-false-offline.** Presence aggregation never reports a participant offline while any device retains live or reconnecting state; ambiguity resolves toward the more-present state. (`Spec-018 §Fallback Behavior`.) Tasks: T3.1.
- **I-018-6 — Device-detail read authorization.** `PresenceDetailRead` (per-device fan-out) is served only to the authorized set (D-018-5: owner/operator-only); the aggregated summary is the unauthorized default. (`Spec-018 §Interfaces And Contracts`; ADR-007.) Tasks: T1.3, T3.4, T4.4.
- **I-018-7 — Self-authorized state update.** A participant may update only their own display state; `ParticipantStateUpdate` is self-scoped and carries no actor-override field. (`Spec-018 §Interfaces And Contracts`; ADR-007.) Tasks: T1.2, T3.5, T4.4.
- **I-018-8 — Daemon-as-gateway single transport.** Client surfaces (SDK, CLI, renderer) reach participant/presence reads through the local daemon JSON-RPC gateway, never a direct control-plane client; the daemon proxies control-plane-stored identity/membership truth. (ADR-008 transport-boundary decision; `packages/client-sdk/src/membershipClient.ts#createDaemonMembershipClient` precedent.) Tasks: T4.1, T4.3.
- **I-018-9 — Renderer is bridge-only.** The desktop renderer reads participant/presence state exclusively through the `window.sidekicks` preload bridge projection, never a direct daemon socket or control-plane fetch. (ADR-009; Spec-023.) Tasks: T4.2.

## Cross-Plan Obligations

Surfaces this plan shares with, consumes from, or owes back to other plans. Format mirrors the §3 dependency map; each names the provider plan and whether reciprocity is present or owed.

- **CP-018-1 — `participants` ALTER (record-only).** Plan-018 adds `display_name`, `identity_ref`, `metadata` to the Plan-001-owned `participants` table via additive migration ([cross-plan-deps §1 Contested](../architecture/cross-plan-dependencies.md#1-table-ownership-map); columns already in `docs/architecture/schemas/shared-postgres-schema.md §Participants and Identity (Plan-018)`). Provider: Plan-001 (owner). Reciprocity present — no precursor PR needed.
- **CP-018-2 — `identity_mappings` CREATE.** Plan-018 creates the `identity_mappings` side table ([§1 Uncontested](../architecture/cross-plan-dependencies.md#1-table-ownership-map)). Uncontested ownership; Plan-018 ships the migration.
- **CP-018-3 — First-sighting auth context producer (ratified — D-018-1).** The `(provider, external_id, profile)` input to T2.1 is produced outside Plan-018 by the auth-callback / token-exchange path. **Ratified (D-018-1, reading (c)):** Plan-018 owns the `AuthenticatedIdentityContext` contract shape (sole consumer); the producer surface populates it via injection. No shipped code populates it yet — the Tier-1 bootstrap stubs identity resolution (`host.ts`'s `resolveIdentityHandle` throws a tier-5 deferral, naming the Plan-018/Plan-002 resolution wiring as the future producer), so the populated context is a future DI seam, not a Tier-1 deliverable. This is a non-secret tuple — no per-participant secret crosses the seam (the former shared-`ikm` pairing with Plan-022 is dissolved; see D-018-1).
- **CP-018-4 — Per-device presence accessor on `presence-register-service.ts` (ratified — D-018-3, fix-in-place).** T3.2 adds a per-device read accessor to the shipped `presence-register-service.ts` (Plan-002 NS-26/PR #108; [§2 ownership row](../architecture/cross-plan-dependencies.md#2-package-path-ownership-map) planning-time-attributes the file to Plan-008, now overtaken by the NS-26 ship). Disposition: fix-in-place EXTEND (file is live; project fix-in-place-over-rigid-ownership stance). Reciprocity owed: amendment note on the Plan-002/Plan-008 presence surface (cross-plan-deps §2 presence-directory row, executed at swap).
- **CP-018-5 — `membership.created` emission (deferred, informational).** Plan-018 consumes `session_memberships` rows but does NOT emit membership-lifecycle events; that emission is Plan-006's obligation (Tier 4, ADR-017 event-sourcing). No new obligation on Plan-018.
- **CP-018-6 — `participant.*` JSON-RPC namespace: names registered + daemon-side handlers authored.** T4.1/T4.2/T4.3 consume `participant.projectionRead` / `participant.stateUpdate` / `participant.presenceDetail` method strings; these are ratified into the Plan-007 daemon method-name registry, **and the daemon-side handlers that answer them are authored by T4.6** (`packages/runtime-daemon/src/ipc/handlers/participant-*.ts`, registered on `registry.ts`) — registering a method name is not the same as implementing its handler, so the client-side consume (T4.1) requires the daemon-side responder (T4.6) or the call resolves to `method-not-found` (the F2 round-4 Codex finding). Plan-018 is added as a `participant.*` extender on the [cross-plan-dependencies.md §2 `ipc/` ownership row](../architecture/cross-plan-dependencies.md#2-package-path-ownership-map) at this swap, mirroring Plan-002 (`presence.*`) / Plan-022 (`gdpr.*`).
- **CP-018-7 — `presence.permission_denied` 403 error code (registered at swap).** T4.4's `PresenceDetailRead` gate returns a `presence.permission_denied` error; this requires a `presence` ErrorNamespace + code in the `error-contracts.md` corpus, registered at swap alongside this flip (batched with the other Tier-5 error codes).
- **CP-018-8 — `ParticipantProjection.state` field (author-internal + wire-doc sync).** T1.1 authors the `state: MembershipState` field that the [api-payload-contracts.md](../architecture/contracts/api-payload-contracts.md) `ParticipantProjection` illustration omits (F-018-1-01). Code-canonical per `Spec-018 §Required Behavior`; recommend re-syncing the wire-doc illustration.
- **CP-018-9 — Renderer presence-subscribe reuse.** T4.2 reuses the Plan-002 `presence.subscribe({ sessionId })` bridge channel (CP-002-5 projection shape) rather than minting a new subscription. Provider: Plan-002 (shipped NS-26).
- **CP-018-10 — `RelayConnectionTokenIssuer` provides-surface owed to Plan-008 R3 (reciprocal of [Plan-008](./008-control-plane-relay-and-session-join.md) CP-008-4 surface (c) / OD-008r-3).** Plan-018 **provides** a constructor-injected `RelayConnectionTokenIssuer` whose signing key + custody stay **entirely within Plan-018** — the same custody-stays-with-producer seam as CP-008-8's injected Ed25519 signer. It mints the short-lived (TTL 300s, `Spec-008 §Relay Negotiation`) `RelayNegotiationResponse.connectionToken` PASETO v4.public, an Ed25519 **sign** that MUST NOT execute inside Plan-008's verify-only zero-knowledge relay broker (holding this signing key in the broker would breach I-008-5). Consumer: Plan-008 R3 `RelayNegotiation` endpoint (T-008r-3-6) injects the issuer and authors no sign. The issuer-surface shape is Plan-018-owned (ratified OD-008r-3); the concrete issuer + its `FixtureRelayConnectionTokenIssuer` test double are authored by **T4.5** (Phase 4 — relay connection-token custody). Ordering reciprocal: Plan-018 lands **before** the Plan-008-remainder surfaces per F-008r-C — this issuer surface's consumer is R3 (T-008r-3-6), and the full edge also orders Plan-018 before Plan-008's R1 auth-middleware ([cross-plan-dependencies.md §5](../architecture/cross-plan-dependencies.md#5-canonical-build-order) F-008r-C, recorded at swap; R1 widening at the W2.5 promotion).
- **CP-018-11 — Path-2 crypto-shred reciprocal (⇄ [Plan-022](./022-data-retention-and-gdpr.md) CP-022-6).** On a valid participant purge (`DELETE /participants/{id}/data`), the Plan-018-owned `participants` identity columns + `identity_mappings` rows are **hard-DELETEd** in the Spec-022 Postgres-side shred fan-out (`Spec-022 §Path 2 — Postgres PII rows (hard DELETE)`). Reciprocal of Plan-022 CP-022-6 (encoded fix-in-place at the Tier-5 audit swap, satisfying Plan-022 I-022-19); shred-handler provider: Plan-022 (V1.1).
- **CP-018-12 — Daemon credential provider for the daemon-resident control-plane callers: Plan-006's T4.10 signing-key registrar, T3.3 anchor uploader + T4.2 roster caller, and Plan-024's T-024-3B-3 lease publisher (reciprocal of [Plan-006 CP-006-13](./006-session-event-taxonomy-and-audit-log.md#cross-plan-obligations) and of [Plan-024 CP-024-5](./024-rust-pty-sidecar.md#cross-plan-obligations); registered at PR #274 round 4, 2026-07-31; widened to the Plan-006 caller set 2026-08-01 by the Plan-006 T4.10 targeted readiness-audit delta and its Codex PR #278 round 1, and to the four-caller set by CP-024-5, PR #279, 2026-08-02).** Plan-006 (Tier 4) declares a constructor-injected credential-provider INTERFACE — `DaemonCredentialProvider` at T3.3's `daemon-credential-provider.ts`, the declaration hoisted from T4.10 at Codex PR #278 round 1 — for the daemon-resident callers — four consume it: the T4.10 `runtimenode.signingkeyregister` registrar caller, Plan-006 T3.3's anchor-upload caller (brought onto the seam by the 2026-08-01 delta), T4.2's `runtimenode.signingkeyroster` observer caller (round 1), and — foreign-owned — Plan-024 T-024-3B-3's `runtimenode.leaseupdate` lease publisher (CP-024-5, PR #279, 2026-08-02) (one interface, one Tier-5 implementation, every injection site Tier-5-dormant behind the same runtime stub assertion) — and ships only the interface plus a test-only stub; this plan's Tier-5 PASETO wiring owes the real implementation + composition-root injection, with the runtime assertion against the stub landing alongside the implementation it guards — the CP-006-1/CP-006-11 injected-interface shape, so tier order is preserved. The credential class is pinned by CP-006-13, not renegotiated here: the node-owner participant's PASETO v4.public access token with a per-request DPoP proof signed by a daemon-held key the token's `cnf.jkt` binds, minted fresh per attempt across the registrar's session-lifetime retry loop. What this plan must additionally specify — because no V1 document does today — is the token's issuance-into-the-daemon path and its refresh across that loop, landing with the same Tier-5 wiring that already gates every shipped `runtimenode.*` procedure through the production `resolveCurrentParticipantId` tier-5 deferral stub. No current T4.x row covers this obligation: the task decomposition is owed at this plan's `review` → `approved` promotion pass (the same registration-then-fold path CP-018-6 → D-018-6/T4.6 took). Provider of the interface shape: Plan-006 (T3.3).

## Ratified Design Decisions (Tier 5 audit, 2026-05-30)

The Tier-5 plan-readiness audit (NS-17) surfaced five open decisions; all five were ratified at the user-review pause and are folded here as the plan's design of record. The cross-cutting corpus amendments they entail (`Spec-018 §State And Data Implications` pins; `shared-postgres-schema.md`; `api-payload-contracts.md`; `error-contracts.md`) are executed at swap alongside this `approved → review` flip. (The G3 length-ratio gate mechanically failed on this sub-100-line stub; the exceedance is 100% required-section backfill, leaner in absolute terms than the in-band Tier-5 plans, and the override was accepted at the pause.)

- **D-018-1 (was Open Decision 1, CP-018-3) — Plan-018 owns the `AuthenticatedIdentityContext` contract shape (reading (c)).** The `(provider, external_id, profile)` first-sighting input is a **non-secret** auth-context tuple; Plan-018 defines its contract shape (it is the sole consumer) and the producer plans (Plan-008 session-bootstrap / Plan-025 token-issuance) populate it. This avoids a cross-tier contract handshake. **Dissolution note:** this is purely the non-secret identity tuple — Plan-018 produces **no per-participant secret** for any consumer. The former "shared `ikm`" framing (the C-5-01 dedup that paired this with Plan-022's content-key decision) is **dissolved**: Plan-022's content key is now an independent random 32-byte AES-256 DEK (Plan-022 D-022-2), so Plan-022 consumes nothing secret from Plan-018. The two decisions are independent and were ratified independently.
- **D-018-2 (was Open Decision 2, F-018-2-02) — `participants.identity_ref` is a stable synthetic ref (reading (b)).** A distinct stable primary ref (PASETO `kid` / synthetic handle) decoupled from any single provider — not a denormalized `{provider}:{external_id}` projection, which would break `identity_ref UNIQUE` when a second provider links to the same person. Entails a `Spec-018 §State And Data Implications` / `docs/architecture/schemas/shared-postgres-schema.md §Participants and Identity (Plan-018)` pin (executed at swap).
- **D-018-3 (was Open Decision 3, CP-018-4 / F-018-3-02) — per-device accessor lands fix-in-place (reading (b)).** Plan-018 EXTENDs the shipped `presence-register-service.ts` (Plan-002 NS-26) in place with an amendment note, rather than handing the accessor off to the §2-recorded planning-time owner via a precursor PR. The file is already live and the project's recorded stance treats rigid one-plan-per-file ownership as an anti-pattern. Reciprocity owed: a cross-plan-deps §2 presence-row amendment note (executed at swap).
- **D-018-4 (was Open Decision 4, F-018-3-05) — `lastSeen` carries the winning (precedence) device's value.** When the highest-activity device ≠ the most-recently-seen device, the projection carries the precedence-device's `lastSeen`, so `{state, lastSeen}` stay internally consistent. Entails a Spec-018 pin (executed at swap).
- **D-018-5 (was Open Decision 5, F-018-3-06 / I-018-6) — `PresenceDetailRead` is owner/operator-only (reading (b)).** Per-device detail is privacy-sensitive fan-out; the aggregated summary remains the participant default. Entails a Spec-018 / security-architecture pin (executed at swap).
- **D-018-6 (round-4 Codex review, 2026-05-31 — F2 finding) — Plan-018 authors the daemon-side `participant.*` handlers (T4.6).** The original Phase-4 decomposition shipped the client-side `participantClient` (T4.1, consuming the `participant.*` method strings) and ratified the method **names** into the Plan-007 registry (CP-018-6) but had **no task implementing the daemon-side handlers** that answer those calls — so the daemon-as-gateway transport (I-018-8) had a client with no responder (`method-not-found` at runtime). **Resolution:** a new Phase-4 task **T4.6** authors `packages/runtime-daemon/src/ipc/handlers/participant-*.ts` (daemon-as-gateway proxy to the control-plane participant services), registered on `registry.ts`, **reusing the exact per-namespace-handler pattern** Plan-002 (`presence.*`, NS-26/PR #108) and Plan-022 (`gdpr.*`) follow — no new mechanism. Plan-018 is added as a `participant.*` extender on the [cross-plan-dependencies.md §2 `ipc/` ownership row](../architecture/cross-plan-dependencies.md#2-package-path-ownership-map) at this swap (the reciprocal of CP-018-6). **Type 1.**

Cross-cutting amendments owed (author-proposed, executed at swap): CP-018-6 (`participant.*` method strings → Plan-007 registry + `api-payload-contracts.md`; daemon-side handlers authored by T4.6 + the §2 `ipc/` extender-row entry — round-4 D-018-6), CP-018-7 (`presence.permission_denied` error code → `error-contracts.md`), CP-018-8 (wire-doc `ParticipantProjection.state` re-sync).

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
  - **Spec coverage:** Spec-018 §Interfaces And Contracts (ParticipantProjectionRead), Spec-018 §Required Behavior (display state = id + name + role + membership state + presence summary)
  - **Verifies invariant:** I-018-3
  - Consumes: `ParticipantId`, `SessionId`, `MembershipRole`, `MembershipState` from `packages/contracts/src/session.ts` (shipped); `PresenceState` from `packages/contracts/src/presence.ts` (shipped, Plan-002 NS-26)
  - Note: authors the `state: MembershipState` field the wire-doc illustration omits (CP-018-8); code-canonical per `Spec-018 §Required Behavior`.
- **T1.2 — `ParticipantStateUpdate` request/response.**
  - Files: `packages/contracts/src/participants/state-update.ts` (CREATE), index barrel (EXTEND)
  - **Spec coverage:** Spec-018 §Interfaces And Contracts (ParticipantStateUpdate), Spec-018 §Required Behavior, Spec-018 §State And Data Implications (display-name change MUST NOT rewrite authorship)
  - **Verifies invariant:** I-018-3, I-018-7
  - Consumes: `ParticipantId` (session.ts, shipped)
  - Note: schema is `.strict()` so the request cannot carry an authorship/actor-override field — binds I-018-3 and I-018-7 at the wire boundary.
- **T1.3 — `PresenceDetailRead` request/response.**
  - Files: `packages/contracts/src/participants/presence-detail.ts` (CREATE), index barrel (EXTEND)
  - **Spec coverage:** Spec-018 §Interfaces And Contracts (PresenceDetailRead, authz-gated), Spec-018 §Required Behavior, Spec-018 §Default Behavior (per-device detail)
  - **Verifies invariant:** I-018-6
  - Consumes: `ParticipantId`, `SessionId`, `PresenceState` (shipped)
- **T1.4 — `PRESENCE_SUMMARY_PRECEDENCE` ordering constant.**
  - Files: `packages/contracts/src/participants/presence-precedence.ts` (CREATE), index barrel (EXTEND)
  - **Spec coverage:** Spec-018 §Default Behavior (online > idle > reconnecting > offline)
  - **Verifies invariant:** I-018-4
  - Consumes: `PresenceState` (shipped Plan-002)
  - Note: distinct from the shipped `PRESENCE_PROGRESSION` degradation table (F-018-3-04 — wrong rank order, ties online/idle); this is the activity-rank used by aggregation.

### Phase 2 — Identity → Participant Mapping

Control-plane service mapping authenticated identity to one canonical participant per session. Ships the `participants` ALTER + `identity_mappings` CREATE migration.

#### Tasks

- **T2.1 — Idempotent identity→participant upsert (participant-first FK ordering).**
  - Files: `packages/control-plane/src/participants/participant-mapping-service.ts` (CREATE); migration `packages/control-plane/src/migrations/00NN-participants-identity.ts` (CREATE — `participants` ALTER (+`display_name`, +`identity_ref`, +`metadata`) + `identity_mappings` CREATE; `NNNN` assigned by append-order) wired into the Plan-001-owned `migration-runner.ts` as `{ version: N, sql: PARTICIPANTS_IDENTITY_MIGRATION_SQL }` — appended **after v3** (Plan-003's `0003-runtime-nodes.ts` — shipped 2026-06-09, NS-32; campaign B16 additionally schedules Plan-024's unpinned `00NN-session-terminal-leases.ts` at its Phase-3B wall-clock, order-independent of the Tier-5 three, so the Tier-5 integers stay append-order-assigned). Plan-018 lands first of the Tier-5 control-plane migrations (F-008r-C orders it before Plan-008-remainder; Plan-022 T22.5.2 appends last), but the version integer is assigned at build by append-order, **not pinned** ([cross-plan-dependencies.md §5](../architecture/cross-plan-dependencies.md#5-canonical-build-order) Tier-5 migration landing-order note)
  - **Spec coverage:** Spec-018 §Required Behavior (one identity → one participant per session), Spec-018 §State And Data Implications (mapping in shared control-plane storage)
  - **Verifies invariant:** I-018-1
  - Consumes: `identity_mappings` / `participants` rows; `ParticipantId` (contracts); `session_memberships` (Plan-002, shipped); `joinSession` (Plan-001, shipped). Repairs the double-mint documented in the `packages/control-plane/src/sessions/session-directory-service.ts#CreateSessionInput` JSDoc (the earlier-draft inline participant auto-mint; per that JSDoc, identity resolution belongs upstream until Plan-018 lands the registration flow — T2.1 is that flow).
  - Decided: D-018-1 (Plan-018-owned `AuthenticatedIdentityContext` shape, CP-018-3) + D-018-2 (`identity_ref` = stable synthetic ref) — both ratified Tier-5; the prior Phase-2 gate is cleared. Uniqueness keys source-forced: `identity_mappings UNIQUE(provider, external_id)`, `participants.identity_ref UNIQUE`, `session_memberships UNIQUE(session_id, participant_id)`.
- **T2.2 — Default display metadata from authenticated profile.**
  - Files: `participant-mapping-service.ts` (same)
  - **Spec coverage:** Spec-018 §Default Behavior (display name/metadata seeded from authenticated profile)
  - **Verifies invariant:** I-018-1
  - Consumes: `participants.display_name` / `metadata` columns; `authContext.profile` from the Plan-018-owned `AuthenticatedIdentityContext` (CP-018-3 / D-018-1; producer plan populates it)
- **T2.3 — Placeholder identity on partial profile.**
  - Files: `participant-mapping-service.ts` (same)
  - **Spec coverage:** Spec-018 §Fallback Behavior (stable placeholder when profile incomplete)
  - **Verifies invariant:** I-018-2
  - Consumes: `participants` ALTER columns
- **T2.4 — One-participant-per-session enforcement (`session_memberships UNIQUE` + `joinSession`).**
  - Files: `participant-mapping-service.ts` (same)
  - **Spec coverage:** Spec-018 §Required Behavior, Spec-018 §Pitfalls To Avoid (pitfall: duplicate participants on re-auth)
  - **Verifies invariant:** I-018-1
  - Consumes: `session_memberships` (Plan-002), `joinSession` (Plan-001)

### Phase 3 — Presence Aggregation & Projection

Highest-activity presence reduction, participant projection assembly, and stable-authorship display updates. Diverges from the shipped recency-collapse reader (author-internal — F-018-3-01/02 are CRITICAL but resolve without a new table or concept).

#### Tasks

- **T3.1 — Highest-activity presence aggregation.**
  - Files: `packages/control-plane/src/presence/presence-aggregation-service.ts` (CREATE)
  - **Spec coverage:** Spec-018 §Required Behavior (aggregate device presence), Spec-018 §Default Behavior (presence summary + precedence), Spec-018 §Fallback Behavior (conservative no-false-offline)
  - **Verifies invariant:** I-018-4, I-018-5
  - Consumes: per-device presence rows via the T3.2 accessor (NOT the recency-collapsing `readPresence` accessor on `packages/control-plane/src/presence/presence-register-service.ts#PresenceRegisterService` — F-018-3-01); `PRESENCE_SUMMARY_PRECEDENCE` (T1.4)
  - Note: authors a new highest-activity reduction; the shipped `readPresence` collapses by recency and MUST NOT be reused for the summary.
  - Decided: D-018-4 (`lastSeen` = winning precedence-device's value) — ratified Tier-5.
- **T3.2 — Per-device presence read accessor on the substrate.**
  - Files: `packages/control-plane/src/presence/presence-register-service.ts` (EXTEND — shipped via Plan-002 NS-26; fix-in-place)
  - **Spec coverage:** Spec-018 §Required Behavior, Spec-018 §Default Behavior, Spec-018 §Interfaces And Contracts (enabling step for all three)
  - **Verifies invariant:** I-018-4 (participates in; upholds Plan-002's I-002-3 — presence ephemeral: accessor reads the in-memory `#sessions` snapshot, persists nothing)
  - Consumes: private `#sessions` per-device snapshots (author-internal exposure; no new table — F-018-3-02)
  - Note: disposition = fix-in-place (D-018-3, ratified); accessor added to the live file.
- **T3.3 — Participant projection assembly.**
  - Files: `packages/control-plane/src/participants/participant-projection-service.ts` (CREATE)
  - **Spec coverage:** Spec-018 §Required Behavior (display state), Spec-018 §Required Behavior, Spec-018 §Default Behavior, Spec-018 §Interfaces And Contracts, Spec-018 §State And Data Implications (one participant, profile defaults, projection read, stable authorship)
  - **Verifies invariant:** I-018-3
  - Consumes: T3.1 aggregate; `session_memberships` role + state; `participants.display_name`; the `state` field authored in T1.1 (Phase 1 → Phase 3 ordering)
- **T3.4 — Device-detail presence projection (`PresenceDetailRead`).**
  - Files: `presence-aggregation-service.ts` (EXTEND own file)
  - **Spec coverage:** Spec-018 §Interfaces And Contracts (device detail), Spec-018 §Required Behavior, Spec-018 §Default Behavior
  - **Verifies invariant:** I-018-4, I-018-6
  - Consumes: T3.2 accessor; T3.1 reduction
  - Decided: D-018-5 (PresenceDetailRead = owner/operator-only) — ratified Tier-5.
- **T3.5 — Stable-authorship-preserving display update.**
  - Files: `packages/control-plane/src/participants/participant-state-update-service.ts` (CREATE)
  - **Spec coverage:** Spec-018 §Required Behavior, Spec-018 §State And Data Implications (display-name change preserves authorship), Spec-018 §Interfaces And Contracts (ParticipantStateUpdate), Spec-018 §Pitfalls To Avoid (pitfall: mutable display rewriting history)
  - **Verifies invariant:** I-018-3, I-018-7
  - Consumes: `participants` display-metadata columns

### Phase 4 — Client Surfaces & Authorization

Typed SDK (daemon-as-gateway), renderer subtree, CLI commands, and the service-layer authz binding. CLI depends on the Plan-007-remainder Tier-4 `apps/cli` scaffold (Tier 4 < Tier 5 — resolved by build order, not an open decision).

#### Tasks

- **T4.1 — `participantClient` SDK (daemon-as-gateway).**
  - Files: `packages/client-sdk/src/participantClient.ts` (CREATE), client-sdk index barrel (EXTEND)
  - **Spec coverage:** Spec-018 §Interfaces And Contracts (the three reads/updates), Spec-018 §Default Behavior (presence summary)
  - **Verifies invariant:** I-018-8
  - Consumes: the three Phase-1 contracts; `JsonRpcClient` (Plan-007 substrate, shipped Tier 1); `participant.*` method strings (CP-018-6, proposed)
  - Note: transport authored daemon-as-gateway (author-with-citation: ADR-008 transport boundary + `packages/client-sdk/src/membershipClient.ts#createDaemonMembershipClient` precedent; `Spec-018 §State And Data Implications`-as-forcing-fact rebutted — membership is equally control-plane-stored yet daemon-proxied — F-018-4-05).
- **T4.2 — `participants/` renderer subtree.**
  - Files: `apps/desktop/src/renderer/src/participants/` (CREATE) + `apps/desktop/src/renderer/src/participants/__tests__/*.test.tsx`
  - **Spec coverage:** Spec-018 §Required Behavior (display state, partial), Spec-018 §Default Behavior (presence summary)
  - **Verifies invariant:** I-018-9
  - Consumes: `window.sidekicks` daemon bridge (Spec-023); `presence.subscribe({ sessionId })` (Plan-002, CP-018-9); `participant.*` methods (CP-018-6)
  - Note: single-client RTL component tests ship NOW, mirroring merged NS-29 `apps/desktop/src/renderer/src/session-members/__tests__/participant-roster.test.tsx` (`@testing-library/react` `render`/`screen` + `installMockBridge` `{ daemon: { call, subscribe } }` + bridge-projection assertion). Two-client live-presence E2E defers to the Tier-8 Playwright harness (Plan-023), NOT BL-131 (Plan-003-scoped, premise overtaken by NS-29 — F-018-4-06).
- **T4.3 — `participants/` CLI commands.**
  - Files: `apps/cli/src/participants/` (CREATE)
  - **Spec coverage:** Spec-018 §Required Behavior (partial), Spec-018 §Default Behavior
  - **Verifies invariant:** I-018-8
  - Consumes: T4.1 `participantClient`; `apps/cli` harness (Plan-007-remainder Tier 4 scaffold)
  - BLOCKED-ON: Plan-007-remainder Tier 4 `apps/cli` scaffold (`depends_on` ordering, resolved by Tier 4 < Tier 5 — F-018-4-07; not an open decision).
- **T4.4 — Authorization-gate enforcement binding.**
  - Files: enforced in `presence-aggregation-service.ts` (PresenceDetailRead gate) + `participant-state-update-service.ts` (self-only gate) — no new file
  - **Spec coverage:** Spec-018 §Interfaces And Contracts (PresenceDetailRead authorized-only), api-payload-contracts self-update self-authz (ADR-007)
  - **Verifies invariant:** I-018-6, I-018-7
  - Consumes: `presence.permission_denied` 403 error code (CP-018-7, proposed); ADR-007 permission model
  - Decided: D-018-5 (the gate enforces owner/operator-only) — ratified Tier-5.
- **T4.5 — `RelayConnectionTokenIssuer` (relay connection-token custody, Plan-018-owned).**
  - Files: `packages/control-plane/src/identity/relay-connection-token-issuer.ts` (CREATE) + `packages/control-plane/src/identity/__tests__/relay-connection-token-issuer.test.ts` (CREATE — `FixtureRelayConnectionTokenIssuer` test double)
  - **Spec coverage:** Spec-008 §Relay Negotiation (300s-TTL `RelayNegotiationResponse.connectionToken`), Spec-008 §Relay Negotiation (connection-token issuance)
  - **Verifies invariant:** none (custody-stays-with-producer — OD-008r-3 / CP-018-10; upholds Plan-008's I-008-5 — relay is zero-knowledge: the PASETO v4.public Ed25519 **sign** executes only inside this Plan-018-owned issuer, never in the verify-only broker)
  - Consumes: `@ai-sidekicks/crypto-paseto` v4.public sign primitives (Plan-025 Tier 1 Partial, shipped); the `connectionToken` claim shape (`Spec-008 §Relay Negotiation`)
  - Provides: `RelayConnectionTokenIssuer` + `FixtureRelayConnectionTokenIssuer` — constructor-injected into Plan-008 R3's `RelayNegotiation` endpoint (T-008r-3-6), which authors no sign (reciprocal of CP-008-4 surface (c) / CP-018-10)
  - Behavior: mint the connection token carrying the [Spec-008 §Relay Negotiation](../specs/008-control-plane-relay-and-session-join.md#relay-negotiation) claim shape — `iss` / `sub` (the authenticated `ParticipantId`) / `aud = relay-connect` / `exp` (300s) / `sessionId` / `nodeId` — and bind the negotiated `sessionId` as the PASETO v4 **implicit assertion** at sign (via the `signV4Public` implicit-assertion parameter, `@ai-sidekicks/crypto-paseto`), so a token minted for one session cannot verify on another — the mint half of the R3 WSS verifier gate (Plan-008 T-008r-3-5). Test: the minted token carries every claim and verifies under the matching-`sessionId` implicit assertion but **fails** under a different `sessionId` (cross-channel-mint refusal).
  - Note: independent of T4.1–T4.4 (no intra-phase dependency — consumes only the shipped crypto-paseto substrate + the Spec-008 claim shape); lands so Plan-018 ships the issuer before its Plan-008-remainder R3 consumer per its F-008r-C leg (the full edge — widened to R1 at the W2.5 promotion — also orders Plan-018 before Plan-008's R1 auth-middleware).
  - Decided: OD-008r-3 (issuer-surface Plan-018-owned, ratified Tier-5); signing key + custody stay entirely within Plan-018.
- **T4.6 — `participant.*` daemon-side IPC handlers (daemon-as-gateway proxy).**
  - Files: `packages/runtime-daemon/src/ipc/handlers/participant-projection-read.ts` (CREATE), `packages/runtime-daemon/src/ipc/handlers/participant-state-update.ts` (CREATE), `packages/runtime-daemon/src/ipc/handlers/participant-presence-detail.ts` (CREATE) + register on the Plan-007 namespace `registry.ts` (EXTEND — `participant.*` namespace) + `packages/runtime-daemon/src/ipc/handlers/__tests__/participant-*.test.ts` (CREATE)
  - **Spec coverage:** Spec-018 §Interfaces And Contracts (the three reads/updates the handlers answer), Spec-018 §State And Data Implications (daemon-as-gateway transport boundary, ADR-008)
  - **Verifies invariant:** I-018-8 (daemon-as-gateway single transport — the **daemon-side** half: the handlers that ANSWER the `participant.*` calls T4.1's `participantClient` makes)
  - Consumes: `participant.*` method strings (CP-018-6); Plan-007's `registry.ts` namespace registry + `MethodRegistry` (Tier-1 substrate, shipped); the control-plane participant projection / state-update / presence-detail services (Phase-1/Phase-3 tasks — the daemon proxies to them per I-018-8); `AuthenticatedIdentityContext` (D-018-1) for gateway identity resolution
  - Provides: the daemon-side `participant.projectionRead` / `participant.stateUpdate` / `participant.presenceDetail` handlers — the counterpart T4.1's client invokes, closing the daemon-as-gateway loop (client → daemon handler → control-plane service); registered under `handlers/` per the [cross-plan-dependencies.md §2 `ipc/` ownership row](../architecture/cross-plan-dependencies.md#2-package-path-ownership-map) (Plan-018 added as a `participant.*` extender at this swap)
  - Note: mirrors the Plan-002 `presence.*` handler-registration precedent (`packages/runtime-daemon/src/ipc/handlers/{presence-subscribe,presence-read}.ts`, NS-26) and the Plan-022 `gdpr-stub-handlers.ts` precedent — each plan that adds a daemon-proxied namespace registers explicit handler files under `handlers/`. **Without this task the `participant.*` method strings T4.1 registers (CP-018-6) have no daemon-side responder — the SDK call resolves to `method-not-found` at runtime** (the F2 round-4 Codex finding). Independent of T4.1–T4.5 for unit-test purposes (handlers test against a stubbed control-plane service), but completes the runtime transport loop the client half assumes.
  - Decided: daemon-side handler home `packages/runtime-daemon/src/ipc/handlers/participant-*.ts` follows the §2 `ipc/` per-namespace-handler convention; ratified at the 2026-05-31 round-4 Codex-review pass (D-018-6).

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

<!-- Per-PR human commentary (round-trips, learnings, partial-ship details). Append-only. -->

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
