# Plan-018: Identity And Participant State

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `018` |
| **Slug** | `identity-and-participant-state` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-018: Identity And Participant State](../specs/018-identity-and-participant-state.md) |
| **Required ADRs** | [ADR-001](../decisions/001-session-is-the-primary-domain-object.md), [ADR-007](../decisions/007-collaboration-trust-and-permission-model.md), [ADR-008](../decisions/008-default-transports-and-relay-boundaries.md) (daemon-as-gateway transport boundary governs I-018-8), [ADR-010](../decisions/010-paseto-webauthn-mls-auth.md) (Phase 5's PASETO v4.public access-token + RFC 9449 DPoP credential posture and the v4.local refresh rotation family — the protocol owner CP-006-13 names; added by the 2026-08-15 NS-62 promotion-pass delta, mirroring the same addition Plan-006 made for T4.10 on 2026-08-01), [ADR-021](../decisions/021-cli-identity-key-storage-custody.md) (T5.2's register-once / refuse-on-rotation posture is the control-plane half of ADR-021's Refuse-On-Rotation Invariant — a registration presenting a different `public_key` under an existing fingerprint is refused, never silently overwritten; the client-side custody ladder itself stays ADR-021/CLI territory per the §Preconditions carrier box; added 2026-08-15), [ADR-015](../decisions/015-v1-feature-scope-definition.md) |
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
- [x] **Plan-readiness audit complete per [`docs/operations/plan-implementation-readiness-audit-runbook.md`](../operations/plan-implementation-readiness-audit-runbook.md)** — Tier-5 audit (NS-17, 2026-05-30): findings folded below; the five Open Decisions were ratified at the user-review pause (D-018-1..D-018-5) and the G3 length-ratio override accepted; status flipped `approved` → `review`. **Restored `approved` 2026-08-15 (PR #334, §6 node NS-62):** the `review → approved` promotion pass carries the targeted readiness-audit delta the post-audit growth obligated — CP-018-12 (registered 2026-07-31, widened 2026-08-01 / 2026-08-02 / 2026-08-12) and CP-018-13 (registered 2026-08-12) both postdate the 2026-05-30 audit and both schedule their task decomposition at exactly this pass, so a plain promotion citing the Tier-5 audit alone would promote a plan whose two newest cross-plan obligations no audit examined (the CP-024-5 / PR #283 / NS-44 correction's failure mode). The delta's audit scope is the growth (the Plan-014-delta partial-coverage shape): the authored Phase 5 (T5.1–T5.8), invariants I-018-10..I-018-14, the `participant_identity_keys` table, the CP-018-11/12/13 amendments, and the Plan-006 T3.3 interface-growth registration. Delivered in the same swap; §Status Promotion Gate criteria cited in the PR body alongside the delta.
- [ ] **Client-side identity-key presenter carrier registered** (minted born-unchecked 2026-08-15 at the NS-62 promotion pass; scoped hold: **the client-side custody caller only** — the surface that generates a workstation's long-term Ed25519 identity key under the [ADR-021](../decisions/021-cli-identity-key-storage-custody.md) custody ladder and presents `(key_fingerprint, public_key)` to T5.2's registration endpoint, the `sidekicks login` leg [trust-and-identity.md §Example 2](../domain/trust-and-identity.md#example-flows) narrates. **No T5.x row is held**: the control-plane write leg (T5.1/T5.2), the roster read (T5.3/T5.8), and the credential seam (T5.4–T5.7) all land regardless — T5.2's endpoint ships production-complete but caller-dormant, the same posture as every Tier-5-dormant seam injection site). A lead-owned amendment must register the carrier — the concrete client enrollment surface (CLI login flow, desktop enrollment, or both) and its custody home, plus the explicit-rotation revocation affordance the ADR-021 `cli identity rotate` flow's control-plane signal needs (no V1 surface authors it; the same amendment owns both halves of the client key lifecycle) — before the `verified → bound` enrollment flow ([trust-and-identity.md §Trust-State Lifecycle](../domain/trust-and-identity.md#trust-state-lifecycle)) is claimed end-to-end live; Plan-027's Tier-9 roster-read §Preconditions entry consumes populated rows only after that carrier lands. The same class as the NS-54 admitting-principal carrier box (Plan-012 T2.2/T2.7) and the Plan-014 fetch-selector carrier box.

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
- `packages/contracts/src/participants/identity-key-roster.ts` (CREATE — T5.3 roster + register contracts)
- `packages/control-plane/src/participants/participant-identity-key-service.ts` (CREATE — T5.2 register-once write path + T5.3 membership-gated roster read)
- `packages/control-plane/src/migrations/00NN-participant-identity-keys.ts` (CREATE — T5.1 `participant_identity_keys` migration; `NNNN` assigned by append-order per the [cross-plan-dependencies.md §5](../architecture/cross-plan-dependencies.md#5-canonical-build-order) Tier-5 migration landing-order note)
- `packages/runtime-daemon/src/identity/paseto-daemon-credential-provider.ts` (CREATE — T5.4/T5.5/T5.6 real credential provider; new Plan-018-owned `identity/` daemon subdirectory)
- `packages/runtime-daemon/src/events/daemon-credential-provider.ts` (EXTEND — T5.6's presented-token interface arm on the Plan-006-owned T3.3 declaration; sanctioned seam edit per CP-006-13 / CP-018-12)
- `packages/runtime-daemon/src/bootstrap/index.ts` (EXTEND — T5.7 composition-root injection; the sanctioned wiring-call edit on the Plan-007-owned daemon bootstrap orchestrator, the §2 bootstrap-row precedent)
- `packages/runtime-daemon/src/ipc/handlers/participant-identity-key-roster.ts` + `packages/runtime-daemon/src/ipc/handlers/participant-identity-key-register.ts` (CREATE — T5.8 daemon-side gateway handlers for the two `participant.*` identity-key methods)

## Data And Storage Changes

- Extend `participants` (owner: Plan-001 per [cross-plan-dependencies.md §1 Contested](../architecture/cross-plan-dependencies.md#1-table-ownership-map) row for `participants` — Plan-018 ALTER/USE adds `display_name`, `identity_ref`, `metadata` columns via additive migrations; columns already recorded in [shared-postgres-schema.md §Participants and Identity (Plan-018)](../architecture/schemas/shared-postgres-schema.md#participants-and-identity-plan-018), reciprocity present). `participants.identity_ref` carries a `UNIQUE` constraint (see D-018-2 — a stable synthetic ref, not a `{provider}:{external_id}` projection).
- Add shared `identity_mappings` side table (CREATE per §1 Uncontested row) with `UNIQUE(provider, external_id)` enforcing one canonical mapping per authenticated identity. Participant-profile projection records and device-presence aggregation read from these base tables; presence data is ephemeral per Plan-002 (Yjs Awareness CRDT, in-memory only) and MUST NOT be persisted to a durable table.
- One-participant-per-session is enforced by `session_memberships UNIQUE(session_id, participant_id)` (Plan-001-owned, Plan-002-extended table — Plan-001 CREATEs per [cross-plan §1](../architecture/cross-plan-dependencies.md#1-table-ownership-map), Plan-002 EXTENDs), not a new constraint on `participants`.
- Ensure canonical event authorship references stable participant ids rather than mutable display metadata.
- Add shared `participant_identity_keys` table (CREATE per §1 Uncontested row; T5.1, 2026-08-15 NS-62 promotion pass) — one row per registered workstation identity key: `participant_id UUID NOT NULL REFERENCES participants(id)`, `key_fingerprint TEXT NOT NULL` (the selector [Plan-014](./014-artifacts-files-and-attachments.md)'s `identityKeyFingerprint` resolves through), `public_key TEXT NOT NULL` (64-char lowercase hex Ed25519 — the `daemon_signing_public_keys` column shape), `registered_at TIMESTAMPTZ NOT NULL DEFAULT now()`, `UNIQUE(participant_id, key_fingerprint)` + a `participant_id` index. Multi-row per participant by construction (one per workstation, per the domain model's multiple-`bound`-identities edge case). The `REFERENCES participants(id)` FK is deliberate: it places the table inside the `Spec-022 §Path 2 — Postgres PII rows (hard DELETE)` exhaustive inbound-FK closure (CP-018-11), deliberately DIVERGING from Plan-006's FK-free `daemon_signing_public_keys` — that exemption's "machine-generated key material, no personal data" ground does not transfer to a person-bound identity key, and the closure costs nothing because all three consumers (Plan-008 bundle admission, Plan-014 attestation delivery, Plan-027 dispatch intake) verify at LIVE time; no retained row re-verifies a participant signature post-erasure, unlike the `event_log_anchors` rows Plan-006's exemption protects.
- See [Shared Postgres Schema](../architecture/schemas/shared-postgres-schema.md) for column definitions.

## API And Transport Changes

- Add `ParticipantProjectionRead`, `ParticipantStateUpdate`, and `PresenceDetailRead` to shared contracts and the typed client SDK.
- Expose one session-scoped participant identity with aggregated presence plus optional authorized device detail.
- Client surfaces reach these reads through the local daemon JSON-RPC gateway (I-018-8), not a direct control-plane client — mirroring the shipped `membershipClient.ts` daemon-proxy pattern.
- Add `ParticipantIdentityKeyRegister` and `ParticipantIdentityKeyRoster` to shared contracts, registered as the fourth and fifth `participant.*` daemon methods (`participant.identityKeyRegister` / `participant.identityKeyRoster` — CP-018-6 widened at the NS-62 pass; daemon-side responders authored by T5.8, honoring the D-018-6 no-method-without-responder rule). The roster read is membership-gated and non-oracular (I-018-13); no key bytes ride `ParticipantProjection` (I-018-14).
- Implement the real `DaemonCredentialProvider` behind Plan-006's T3.3 declaration (CP-006-13 / CP-018-12): PASETO v4.public access token under the `DPoP` scheme + per-attempt RFC 9449 proof (T5.4), the token's issuance-into-the-daemon path + refresh across the registrar's session-lifetime retry loop (T5.5), the CP-014-5 proof-for-a-presented-token affordance (T5.6), and composition-root injection at every consuming site with the runtime stub assertion (T5.7).

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
- **I-018-10 — Daemon credentials are DPoP-bound, never `Bearer`.** Every credential the daemon mints for a control-plane call carries the `DPoP` authorization scheme with a matching per-attempt proof (`{jti, htm, htu, iat, ath}` per RFC 9449) — never `Bearer` — and production construction never leaves the Tier-5 refusing stub bound at a composition root. (`Spec-018 §Required Behavior`; ADR-010; CP-006-13.) Tasks: T5.4, T5.5, T5.7.
- **I-018-11 — One daemon proof key.** The presented-token proof (T5.6) and the access-token proof (T5.4) are minted under the same daemon-held key whose thumbprint the access token's `cnf.jkt` binds; a second proof key is a construction error, not a fallback — proofs under a different key fail `cnf.jkt` verification on every fetch. (`Spec-018 §Interfaces And Contracts`; CP-014-5.) Tasks: T5.6.
- **I-018-12 — Identity-key registration is additive and register-once.** A replay of the same `(participant_id, key_fingerprint, public_key)` is an acknowledged idempotent no-op; a registration presenting a different `public_key` under an existing fingerprint is refused with a typed error before any row mutation — the control-plane half of ADR-021's Refuse-On-Rotation Invariant, mirroring Plan-006's I-006-4-08 at participant granularity. (`Spec-018 §Required Behavior`; ADR-021.) Tasks: T5.1, T5.2.
- **I-018-13 — Identity-key roster read is membership-gated and non-oracular.** The membership predicate and the row read execute in one statement, so a non-member and a nonexistent session are refused byte-identically with `participant.permission_denied` — no membership or session-existence oracle (the `runtimenode.signingkeyroster` discipline; ADR-025's uniform-403 shape as precedent). (`Spec-018 §Interfaces And Contracts`.) Tasks: T5.3, T5.8.
- **I-018-14 — No verification-key bytes on the projection.** Key material is reachable only through the gated roster read; `ParticipantProjection` never carries key bytes. Scoped, not absolute: `participants.identity_ref` (a PASETO `kid` — a key identifier, never key material, D-018-2) rides the participant record and is unaffected. (`Spec-018 §State And Data Implications`.) Tasks: T5.3.

## Cross-Plan Obligations

Surfaces this plan shares with, consumes from, or owes back to other plans. Format mirrors the §3 dependency map; each names the provider plan and whether reciprocity is present or owed.

- **CP-018-1 — `participants` ALTER (record-only).** Plan-018 adds `display_name`, `identity_ref`, `metadata` to the Plan-001-owned `participants` table via additive migration ([cross-plan-deps §1 Contested](../architecture/cross-plan-dependencies.md#1-table-ownership-map); columns already in `docs/architecture/schemas/shared-postgres-schema.md §Participants and Identity (Plan-018)`). Provider: Plan-001 (owner). Reciprocity present — no precursor PR needed.
- **CP-018-2 — `identity_mappings` CREATE.** Plan-018 creates the `identity_mappings` side table ([§1 Uncontested](../architecture/cross-plan-dependencies.md#1-table-ownership-map)). Uncontested ownership; Plan-018 ships the migration.
- **CP-018-3 — First-sighting auth context producer (ratified — D-018-1).** The `(provider, external_id, profile)` input to T2.1 is produced outside Plan-018 by the auth-callback / token-exchange path. **Ratified (D-018-1, reading (c)):** Plan-018 owns the `AuthenticatedIdentityContext` contract shape (sole consumer); the producer surface populates it via injection. No shipped code populates it yet — the Tier-1 bootstrap stubs identity resolution (`host.ts`'s `resolveIdentityHandle` throws a tier-5 deferral, naming the Plan-018/Plan-002 resolution wiring as the future producer), so the populated context is a future DI seam, not a Tier-1 deliverable. This is a non-secret tuple — no per-participant secret crosses the seam (the former shared-`ikm` pairing with Plan-022 is dissolved; see D-018-1).
- **CP-018-4 — Per-device presence accessor on `presence-register-service.ts` (ratified — D-018-3, fix-in-place).** T3.2 adds a per-device read accessor to the shipped `presence-register-service.ts` (Plan-002 NS-26/PR #108; [§2 ownership row](../architecture/cross-plan-dependencies.md#2-package-path-ownership-map) planning-time-attributes the file to Plan-008, now overtaken by the NS-26 ship). Disposition: fix-in-place EXTEND (file is live; project fix-in-place-over-rigid-ownership stance). Reciprocity owed: amendment note on the Plan-002/Plan-008 presence surface (cross-plan-deps §2 presence-directory row, executed at swap).
- **CP-018-5 — `membership.created` emission (deferred, informational).** Plan-018 consumes `session_memberships` rows but does NOT emit membership-lifecycle events; that emission is Plan-006's obligation (Tier 4, ADR-017 event-sourcing). No new obligation on Plan-018.
- **CP-018-6 — `participant.*` JSON-RPC namespace: names registered + daemon-side handlers authored (widened 2026-08-15, NS-62 pass — the identity-key pair).** T4.1/T4.2/T4.3 consume `participant.projectionRead` / `participant.stateUpdate` / `participant.presenceDetail` method strings; these are ratified into the Plan-007 daemon method-name registry, **and the daemon-side handlers that answer them are authored by T4.6** (`packages/runtime-daemon/src/ipc/handlers/participant-*.ts`, registered on `registry.ts`) — registering a method name is not the same as implementing its handler, so the client-side consume (T4.1) requires the daemon-side responder (T4.6) or the call resolves to `method-not-found` (the F2 round-4 Codex finding). The NS-62 pass widens the namespace to five methods: `participant.identityKeyRegister` and `participant.identityKeyRoster` (the T5.2 write leg and T5.3 read leg), whose daemon-side responders are authored by **T5.8** under the same no-method-without-responder rule — the registry table at [api-payload-contracts.md §Participant Method-Name Registry (Tier 5)](../architecture/contracts/api-payload-contracts.md#participant-method-name-registry-tier-5) is re-derived to five rows in the same swap. Plan-018 is added as a `participant.*` extender on the [cross-plan-dependencies.md §2 `ipc/` ownership row](../architecture/cross-plan-dependencies.md#2-package-path-ownership-map) at this swap, mirroring Plan-002 (`presence.*`) / Plan-022 (`gdpr.*`).
- **CP-018-7 — `presence.permission_denied` 403 error code (registered at swap).** T4.4's `PresenceDetailRead` gate returns a `presence.permission_denied` error; this requires a `presence` ErrorNamespace + code in the `error-contracts.md` corpus, registered at swap alongside this flip (batched with the other Tier-5 error codes).
- **CP-018-8 — `ParticipantProjection.state` field (author-internal + wire-doc sync).** T1.1 authors the `state: MembershipState` field that the [api-payload-contracts.md](../architecture/contracts/api-payload-contracts.md) `ParticipantProjection` illustration omits (F-018-1-01). Code-canonical per `Spec-018 §Required Behavior`; recommend re-syncing the wire-doc illustration.
- **CP-018-9 — Renderer presence-subscribe reuse.** T4.2 reuses the Plan-002 `presence.subscribe({ sessionId })` bridge channel (CP-002-5 projection shape) rather than minting a new subscription. Provider: Plan-002 (shipped NS-26).
- **CP-018-10 — `RelayConnectionTokenIssuer` provides-surface owed to Plan-008 R3 (reciprocal of [Plan-008](./008-control-plane-relay-and-session-join.md) CP-008-4 surface (c) / OD-008r-3).** Plan-018 **provides** a constructor-injected `RelayConnectionTokenIssuer` whose signing key + custody stay **entirely within Plan-018** — the same custody-stays-with-producer seam as CP-008-8's injected Ed25519 signer. It mints the short-lived (TTL 300s, `Spec-008 §Relay Negotiation`) `RelayNegotiationResponse.connectionToken` PASETO v4.public, an Ed25519 **sign** that MUST NOT execute inside Plan-008's verify-only zero-knowledge relay broker (holding this signing key in the broker would breach I-008-5). Consumer: Plan-008 R3 `RelayNegotiation` endpoint (T-008r-3-6) injects the issuer and authors no sign. The issuer-surface shape is Plan-018-owned (ratified OD-008r-3); the concrete issuer + its `FixtureRelayConnectionTokenIssuer` test double are authored by **T4.5** (Phase 4 — relay connection-token custody). Ordering reciprocal: Plan-018 lands **before** the Plan-008-remainder surfaces per F-008r-C — this issuer surface's consumer is R3 (T-008r-3-6), and the full edge also orders Plan-018 before Plan-008's R1 auth-middleware ([cross-plan-dependencies.md §5](../architecture/cross-plan-dependencies.md#5-canonical-build-order) F-008r-C, recorded at swap; R1 widening at the W2.5 promotion).
- **CP-018-11 — Path-2 crypto-shred reciprocal (⇄ [Plan-022](./022-data-retention-and-gdpr.md) CP-022-6; widened 2026-08-15, NS-62 pass).** On a valid participant purge (`DELETE /participants/{id}/data`), the Plan-018-owned `participants` identity columns + `identity_mappings` rows **+ `participant_identity_keys` rows (T5.1)** are **hard-DELETEd** in the Spec-022 Postgres-side shred fan-out (`Spec-022 §Path 2 — Postgres PII rows (hard DELETE)`). The new table joins the closure automatically — Path 2 is rule-exhaustive over the `REFERENCES participants(id)` inbound-FK closure — and its enumeration rows (the Spec-022 hard-DELETE bullet, the §PII Data Map, and the erasure runbook's Path-2 statement list) are widened in the same swap; deleting a participant's identity-key rows is safe at LIVE-verification semantics (no retained row re-verifies a participant signature post-erasure — the deliberate divergence from Plan-006's FK-free `daemon_signing_public_keys` recorded at §Data And Storage Changes). Reciprocal of Plan-022 CP-022-6 (encoded fix-in-place at the Tier-5 audit swap, satisfying Plan-022 I-022-19); shred-handler provider: Plan-022 (V1.1).
- **CP-018-12 — Daemon credential provider for the daemon-resident control-plane callers: Plan-006's T4.10 signing-key registrar, T3.3 anchor uploader + T4.2 roster caller, Plan-024's T-024-3B-3 lease publisher, and Plan-014's relay transfer service (reciprocal of [Plan-006 CP-006-13](./006-session-event-taxonomy-and-audit-log.md#cross-plan-obligations), of [Plan-024 CP-024-5](./024-rust-pty-sidecar.md#cross-plan-obligations), and of [Plan-014 CP-014-5](./014-artifacts-files-and-attachments.md#cross-plan-obligations-provided); registered at PR #274 round 4, 2026-07-31; widened to the Plan-006 caller set 2026-08-01 by the Plan-006 T4.10 targeted readiness-audit delta and its Codex PR #278 round 1, to the four-caller set by CP-024-5, PR #279, 2026-08-02, and to the five-caller set by CP-014-5, Codex PR #326 round 2, 2026-08-12).** Plan-006 (Tier 4) declares a constructor-injected credential-provider INTERFACE — `DaemonCredentialProvider` at T3.3's `daemon-credential-provider.ts`, the declaration hoisted from T4.10 at Codex PR #278 round 1 — for the daemon-resident callers — five are live at this pass and wired by T5.7: the T4.10 `runtimenode.signingkeyregister` registrar caller, Plan-006 T3.3's anchor-upload caller (brought onto the seam by the 2026-08-01 delta), T4.2's `runtimenode.signingkeyroster` observer caller (round 1), — foreign-owned — Plan-024 T-024-3B-3's `runtimenode.leaseupdate` lease publisher (CP-024-5, PR #279, 2026-08-02), and — likewise foreign-owned — Plan-014's relay transfer service, whose Task-7 upload calls (`ArtifactUploadInit`/`ArtifactUploadChunk`/`ArtifactUploadComplete`) and Task-8 `ArtifactFetchAuthorize` mint present the seam's token + proof (CP-014-5, Codex PR #326 round 2, 2026-08-12) — plus two forward-declared consumers injected by their own plans at their own tiers: Plan-019 T3.1's `attention.notificationEmit` publisher (D-019-3, Tier 8) and Plan-027 T2.1's participant-roster reader (Tier 9, itself a daemon-resident control-plane call) — the enumeration is live-plus-forward-declared, never a bare count (one interface, one Tier-5 implementation, every injection site Tier-5-dormant behind the same runtime stub assertion) — and ships only the interface plus a test-only stub; this plan's Tier-5 PASETO wiring owes the real implementation + composition-root injection, with the runtime assertion against the stub landing alongside the implementation it guards — the CP-006-1/CP-006-11 injected-interface shape, so tier order is preserved. The credential class is pinned by CP-006-13, not renegotiated here: the node-owner participant's PASETO v4.public access token with a per-request DPoP proof signed by a daemon-held key the token's `cnf.jkt` binds, minted fresh per attempt across the registrar's session-lifetime retry loop. What this plan must additionally specify — because no V1 document did before the NS-62 pass — is the token's issuance-into-the-daemon path and its refresh across that loop, landing with the same Tier-5 wiring that already gates every shipped `runtimenode.*` procedure through the production `resolveCurrentParticipantId` tier-5 deferral stub. **Discharged 2026-08-15 (NS-62 promotion pass):** the owed decomposition is authored as Phase 5 — T5.4 (the real `PasetoDaemonCredentialProvider`), T5.5 (issuance-into-the-daemon + refresh across the retry loop, now specified at `Spec-018 §Required Behavior`), and T5.7 (composition-root injection + runtime stub assertion at every live site) — the same registration-then-fold path CP-018-6 → D-018-6/T4.6 took. The seam's one scope growth (CP-014-5, 2026-08-12) — the **proof-for-a-presented-token affordance**: Plan-014's fetch legs (chunk GETs, `ArtifactFetchComplete`) present the minted _fetch token_ rather than the daemon's access token, so they need DPoP proofs whose `ath` hashes that presented token, computed under the same daemon-held proof key the token's `cnf.jkt` was bound from at mint — is authored as **T5.6**, with the affordance's interface growth registered on the Plan-006-owned T3.3 declaration in this same swap (the CP-024-5 registration-now-authoring-at-the-fold path: the `.ts` edit lands at T5.6's dispatch as a sanctioned seam edit). Provider of the interface shape: Plan-006 (T3.3).
- **CP-018-13 — Participant identity-key store + roster read path for cross-plan key resolution (registered 2026-08-12 by the Tier-9 plan-readiness audit; discharged and widened 2026-08-15, NS-62 pass).** Plan-027's target-side dispatch intake resolves a calling participant's known long-term public key from the session participant roster on the target daemon ([Spec-024 §Target-Side Authentication And Cedar Evaluation](../specs/024-cross-node-dispatch-and-approval.md#target-side-authentication-and-cedar-evaluation), step 1 — token verification). `ParticipantProjection` carries no key material — `participants.identity_ref` is a stable synthetic ref (D-018-2), not a verification key (I-018-14) — so the key-material affordance is a distinct gated surface. **Discharged 2026-08-15:** authored as T5.1 (the `participant_identity_keys` store), T5.3 (the membership-gated `ParticipantIdentityKeyRoster` read), and T5.8 (the daemon gateway responder). The widening consolidates the roster read's three registered consumers: **(a)** [Plan-027](./027-cross-node-dispatch-and-approval.md) T2.1's dispatch intake (Tier 9) — Plan-027 owns the target-local freshness cache and the `participant_roster_stale` refusal past 5 minutes (`Spec-024 §Fallback Behavior`); this plan authors neither, and that refusal code is registered nowhere today — its `error-contracts.md` registration is Plan-027's at its Tier-9 fold; **(b)** [Plan-014](./014-artifacts-files-and-attachments.md)'s attestation delivery (Tier 7) — `identityKeyFingerprint` is a selector into this store's `(participant_id, key_fingerprint)` rows per [api-payload-contracts.md](../architecture/contracts/api-payload-contracts.md)'s attestation gloss; **(c)** [Plan-008](./008-control-plane-relay-and-session-join.md) T-008r-3-1's `RegisteredIdentityResolver` (co-tier Tier 5) — resolving `ed25519_identity_public` → `ParticipantId` at bundle admission (I-008-7b) is a key-roster read over this store, the backing surface that resolver named with no store behind it until T5.3 (CP-008-4's owed-surface enumeration widens to four in the same swap). Provider: Plan-018 (T5.1 / T5.3 / T5.8). Reciprocity present — Plan-027's paired §Preconditions entry landed in the Tier-9 audit swap; rows are populated only after the client-side presenter carrier lands (the §Preconditions born-unchecked box).

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
5. Implement the daemon credential seam (the real `DaemonCredentialProvider`: PASETO access-token issuance-into-the-daemon, refresh, per-attempt DPoP proofs, the presented-token affordance, composition-root injection) and the participant identity-key registration + membership-gated roster surfaces.

## Implementation Phase Sequence

Audit-derived task decomposition. Five phases map 1:1 to the five Implementation Steps; 27 Tasks total (the pre-NS-62 "17" was a pre-existing miscount of the then-19 rows — T1.1–T1.4, T2.1–T2.4, T3.1–T3.5, T4.1–T4.6 — re-derived with Phase 5's eight at the 2026-08-15 pass). Each Task row carries the fields the plan-execution plan-analyst consumes verbatim: **Files** (target paths), **Spec coverage** (the spec rows the Task satisfies), **Verifies invariant** (the I-018-N it upholds), **Consumes** (upstream symbols/rows + their provider), **BLOCKED-ON** where a build-order dependency must resolve first, and **Decided** recording the ratified Tier-5 decision (D-018-N) that cleared a former Open-Decision gate.

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

### Phase 5 — Daemon Credential Seam & Participant Identity-Key Roster

Tier-5 PASETO wiring authored at the 2026-08-15 NS-62 promotion pass — the decomposition CP-018-12 and CP-018-13 scheduled here: the real `DaemonCredentialProvider` behind the Plan-006 T3.3 declaration (CP-006-13 / CP-018-12), its issuance-and-refresh path, the CP-014-5 proof-for-a-presented-token affordance, and the participant identity-key store + roster the target-side dispatch intake, the attestation-delivery selector, and the bundle-admission resolver all read (CP-018-13). Ships the `participant_identity_keys` CREATE migration.

#### Tasks

- **T5.1 — `participant_identity_keys` table + migration (Plan-018-owned).**
  - Files: `packages/control-plane/src/migrations/00NN-participant-identity-keys.ts` (CREATE — `participant_identity_keys`; `NNNN` assigned by append-order per the Tier-5 migration landing-order note) wired into the Plan-001-owned `migration-runner.ts` as its own `{ version, sql }` entry in the same commit
  - **Spec coverage:** Spec-018 §State And Data Implications (participant identity keys in shared control-plane storage), Spec-018 §Required Behavior (one registered identity key per workstation)
  - **Verifies invariant:** I-018-12
  - Consumes: `participants(id)` anchor (Plan-001, shipped); the `identity_mappings` sibling shape (T2.1) as the FK + uniqueness precedent
  - Provides: the `(participant_id, key_fingerprint) → public_key` rows the T5.3 roster read serves (CP-018-13 consumers a/b/c)
  - Behavior: `participant_id UUID NOT NULL REFERENCES participants(id)`, `key_fingerprint TEXT NOT NULL`, `public_key TEXT NOT NULL` (64-char lowercase hex Ed25519, the `daemon_signing_public_keys` column shape), `registered_at TIMESTAMPTZ NOT NULL DEFAULT now()`, `UNIQUE(participant_id, key_fingerprint)` + a `participant_id` index. Multi-row per participant by construction — one row per workstation, per `Spec-018 §State And Data Implications` and the domain model's multiple-`bound`-identities edge case.
  - Note: the `REFERENCES participants(id)` FK is deliberate and puts the table inside the `Spec-022 §Path 2 — Postgres PII rows (hard DELETE)` exhaustive inbound-FK closure (CP-018-11, widened at this swap). This DIVERGES from `daemon_signing_public_keys`, which Plan-006 CP-006-7 deliberately keeps FK-free as "machine-generated key material, no personal data" — a justification that does not transfer to a person-bound identity key. The cost is nil because all three consumers (Plan-008 bundle admission, Plan-014 attestation delivery, Plan-027 dispatch intake) verify at LIVE time; nothing retained post-erasure re-verifies a participant signature, unlike the `event_log_anchors` rows Plan-006's exemption protects.
- **T5.2 — Identity-key registration endpoint (register-once, refuse-on-rotation).**
  - Files: `packages/control-plane/src/participants/participant-identity-key-service.ts` (CREATE) + tests
  - **Spec coverage:** Spec-018 §Required Behavior (identity-key registration is register-once), Spec-018 §Interfaces And Contracts (ParticipantIdentityKeyRegister)
  - **Verifies invariant:** I-018-12
  - Consumes: `participant_identity_keys` rows (T5.1); `AuthenticatedIdentityContext` (D-018-1) for the self-registration binding; `participant.identitykeyregister_conflict` 409 (registered in `error-contracts.md` at this swap)
  - Provides: the `verified → bound` control-plane registration transition [trust-and-identity.md §Trust-State Lifecycle](../domain/trust-and-identity.md#trust-state-lifecycle) names with no V1 producer until this task, and the write half of the resolution surface [security-architecture.md](../architecture/security-architecture.md) already asserts ("the participant's registered Ed25519 identity key")
  - Behavior: register-once per `(participant_id, key_fingerprint)`; a same-key replay is an acknowledged idempotent no-op (retry-safe re-enrollment); a registration presenting a DIFFERENT `public_key` under an existing fingerprint is refused with the typed 409 BEFORE any row mutation, never silently overwritten — the control-plane half of [ADR-021](../decisions/021-cli-identity-key-storage-custody.md)'s Refuse-On-Rotation Invariant, mirroring Plan-006's `refuse_on_rotation` posture (I-006-4-08) at participant granularity. A participant registers only its OWN key: the authenticated `sub` must equal the target `participant_id`, mirroring T3.5's self-only gate (I-018-7).
  - Note: this authors the CONTROL-PLANE endpoint plus its T5.8 daemon gateway responder only. The client-side custody caller that generates the key and presents it rides the ADR-021 custody ladder and is held by the §Preconditions born-unchecked carrier box — production-complete but caller-dormant until that carrier lands.
- **T5.3 — `ParticipantIdentityKeyRoster` read (membership-gated, non-oracular).**
  - Files: `packages/contracts/src/participants/identity-key-roster.ts` (CREATE — roster + register request/response schemas), index barrel (EXTEND); `participant-identity-key-service.ts` (EXTEND own file)
  - **Spec coverage:** Spec-018 §Interfaces And Contracts (ParticipantIdentityKeyRoster, membership-gated), Spec-018 §Required Behavior (roster resolution by participant and fingerprint)
  - **Verifies invariant:** I-018-13, I-018-14
  - Consumes: `participant_identity_keys` rows (T5.1); `session_memberships` (Plan-001-owned, Plan-002-extended, shipped); `participant.permission_denied` 403 (registered at this swap)
  - Provides: the participant-roster key-material read Plan-027 T2.1 resolves a caller's long-term public key through (CP-018-13 consumer a), the resolution surface Plan-014's `identityKeyFingerprint` selector names (consumer b), and the backing store for Plan-008 T-008r-3-1's `RegisteredIdentityResolver` (`ed25519_identity_public` → `ParticipantId`, I-008-7b — consumer c; a resolver named in that plan with no store behind it until this task)
  - Behavior: return the requested participant's registered `(key_fingerprint, public_key)` set scoped to one session. The membership predicate and the row read execute in ONE statement so a non-member and a nonexistent session are refused byte-identically — the `runtimenode.signingkeyroster` no-oracle discipline and the [ADR-025](../decisions/025-runtime-node-control-plane-caller-authorization.md) uniform-403 shape as precedent. An unknown fingerprint refuses within that participant's keys only and never widens across participants (the Plan-014 narrowing rule).
  - Note: the gate is real despite the payload being public keys — the SET SIZE discloses a participant's workstation count, which [trust-and-identity.md §Edge Cases](../domain/trust-and-identity.md#edge-cases) treats as security-relevant (stolen-key reuse detection reads exactly that signal). Plan-027 owns the target-local freshness cache and the `participant_roster_stale` refusal past 5 minutes (`Spec-024 §Fallback Behavior`); this task authors neither.
- **T5.4 — `PasetoDaemonCredentialProvider` — the real implementation behind the T3.3 declaration.**
  - Files: `packages/runtime-daemon/src/identity/paseto-daemon-credential-provider.ts` (CREATE) + tests
  - **Spec coverage:** Spec-018 §Required Behavior (daemon-resident control-plane caller credentials), Spec-018 §Interfaces And Contracts (daemon credential provider)
  - **Verifies invariant:** I-018-10
  - Consumes: the `DaemonCredentialProvider` interface + `DaemonCredentialAttempt` / `DaemonCredentialMaterial` + `assertDpopCredentialMaterial` from `packages/runtime-daemon/src/events/daemon-credential-provider.ts` (Plan-006 T3.3, shipped PR #287); `@ai-sidekicks/crypto-paseto` v4.public sign primitives (Plan-025 Tier 1 Partial, shipped); the ADR-010 DPoP proof shape
  - Provides: the first non-refusing `DaemonCredentialProvider`, replacing `Tier5DeferredDaemonCredentialProvider` at every production composition root (T5.7)
  - Behavior: `mintForAttempt({sessionId, nodeId, htm, htu})` returns `Authorization: DPoP <access token>` plus a `DPoP` proof header carrying `{jti, htm, htu, iat, ath}` per [RFC 9449 §4.3](https://datatracker.ietf.org/doc/html/rfc9449#section-4.3) and [security-architecture.md §Control-Plane Authentication](../architecture/security-architecture.md#control-plane-authentication-task-52), where `ath` is the SHA-256 of the presented access token and the proof key's thumbprint is the token's `cnf.jkt`. The `DPoP` authorization scheme is mandatory — never `Bearer` — the property the shipped `assertDpopCredentialMaterial` already enforces and this task must satisfy rather than bypass.
- **T5.5 — Token issuance-into-the-daemon path + refresh across the registrar's session-lifetime retry loop.**
  - Files: `paseto-daemon-credential-provider.ts` (EXTEND own file) + tests
  - **Spec coverage:** Spec-018 §Required Behavior (credential issuance and refresh), Spec-018 §Fallback Behavior (credential unavailable fails closed)
  - **Verifies invariant:** I-018-10
  - Consumes: the v4.local refresh-token rotation family + reuse detection ([security-architecture.md §Control-Plane Authentication](../architecture/security-architecture.md#control-plane-authentication-task-52)); the T4.10 registrar's session-lifetime retry loop (Plan-006, the consumer whose loop outlives a 15-minute access token)
  - Provides: the answer to the gap CP-006-13 named verbatim — "the token's issuance-into-the-daemon path and its refresh across the registrar's session-lifetime retry loop", specified by no V1 document before this pass
  - Behavior: the daemon acquires its access + refresh pair at session establishment — the node-owner participant's authenticated client requests a daemon-scoped pair whose `cnf.jkt` binds the DAEMON-held proof key (the daemon supplies its proof-key thumbprint over local IPC; the private key never leaves the daemon) — and thereafter refreshes on the rotation family rather than re-running the interactive grant. A refresh that trips reuse detection fails the mint CLOSED (the credential seam refuses, callers degrade honestly on their existing backoff) rather than retrying with a burned family. The proof key persists across refreshes so `cnf.jkt` continues to bind — the property T5.6 depends on.
- **T5.6 — Proof-for-a-presented-token affordance (CP-014-5).**
  - Files: `packages/runtime-daemon/src/events/daemon-credential-provider.ts` (EXTEND — the interface growth, the sanctioned seam edit CP-006-13 / CP-018-12 registered at this pass); `paseto-daemon-credential-provider.ts` (EXTEND own file) + tests
  - **Spec coverage:** Spec-018 §Interfaces And Contracts (proof for a presented token), Spec-018 §Required Behavior (DPoP proof over a presented non-access token)
  - **Verifies invariant:** I-018-11, I-018-10
  - Consumes: the T5.4 proof key + its `cnf.jkt` binding; the Plan-014 fetch-token shape (chunk GETs and `ArtifactFetchComplete`)
  - Provides: the affordance CP-014-5 scopes — DPoP proofs whose `ath` hashes a PRESENTED fetch token rather than the daemon's access token, minted under the SAME daemon-held proof key the access token's `cnf.jkt` was bound from at mint
  - Behavior: grow the T3.3-declared interface with a presented-token mint arm (`mintProofForPresentedToken({sessionId, nodeId, htm, htu, presentedToken})`) returning proof-header-only material. The single-proof-key requirement is load-bearing, not an implementation detail: a second key would produce proofs whose thumbprint does not match the bound `cnf.jkt`, and the control plane would reject every fetch (I-018-11).
  - Note: the interface growth lands on the Plan-006-owned declaration because CP-018-12 commits it there and because the same-key-custody requirement forces both arms onto one provider instance — a Plan-018-owned sibling interface would contradict a registered obligation and break `cnf.jkt` binding. The CP-024-5 path: the growth is registered in Plan-006's T3.3 body at this promotion pass; the `.ts` edit lands at this task's dispatch.
- **T5.7 — Composition-root injection at every consuming site + runtime stub assertion.**
  - Files: `packages/runtime-daemon/src/bootstrap/index.ts` (EXTEND — the sanctioned wiring-call edit into the Plan-007-owned daemon bootstrap orchestrator, the §2 bootstrap-row precedent) + tests
  - **Spec coverage:** Spec-018 §Required Behavior (every daemon-resident control-plane caller is credentialed), Spec-018 §Pitfalls To Avoid (an uninjected seam fails silently)
  - **Verifies invariant:** I-018-10
  - Consumes: `PasetoDaemonCredentialProvider` (T5.4/T5.6); the consuming sites CP-006-13 and CP-018-12 enumerate
  - Provides: the seam-wide composition-root ownership the CP-024-5 targeted delta (PR #283) explicitly routed to "Plan-018's promotion pass"
  - Behavior: inject the real provider at the five sites live at this pass — Plan-006 T4.10's signing-key registrar, T3.3's anchor uploader, T4.2's `runtimenode.signingkeyroster` observer, Plan-024 T-024-3B-3's lease publisher, and Plan-014's relay transfer service — and ship a runtime assertion that production construction never leaves `Tier5DeferredDaemonCredentialProvider` bound, in the CP-006-1 assertion-pattern shape. Two further sites are forward-declared, injected by their own plans at their own tiers: Plan-019 T3.1's `attention.notificationEmit` publisher (D-019-3, Tier 8) and Plan-027 T2.1's participant-roster reader (Tier 9, itself a daemon-resident control-plane call and therefore a credential-seam consumer).
  - Note: the enumeration is stated live-plus-forward-declared, never a bare count — the corpus's former "five callers" statements predate Plan-019's sixth and this pass's Plan-027 seventh and are swept in this same PR.
- **T5.8 — `participant.*` identity-key daemon-side gateway handlers.**
  - Files: `packages/runtime-daemon/src/ipc/handlers/participant-identity-key-roster.ts` (CREATE), `packages/runtime-daemon/src/ipc/handlers/participant-identity-key-register.ts` (CREATE) + register on the Plan-007 namespace `registry.ts` (EXTEND — `participant.*` namespace) + tests
  - **Spec coverage:** Spec-018 §Interfaces And Contracts (the identity-key register and roster surfaces the handlers answer), Spec-018 §State And Data Implications (daemon-as-gateway transport boundary, ADR-008)
  - **Verifies invariant:** I-018-8
  - Consumes: `participant.identityKeyRegister` / `participant.identityKeyRoster` method strings (CP-018-6, widened at this pass); Plan-007's `registry.ts` + `MethodRegistry` (Tier-1 substrate, shipped); the T5.2/T5.3 control-plane service; `AuthenticatedIdentityContext` (D-018-1) for gateway identity resolution — gateway-proxied calls relay the CLIENT's authenticated identity, never the daemon's own T5.4 standing credential
  - Provides: the daemon-side responders for both identity-key methods, closing the daemon-as-gateway loop for the fourth and fifth `participant.*` methods
  - Note: mirrors T4.6's three handlers and the Plan-002 `presence.*` registration precedent. Without this task the method strings CP-018-6 registers have no daemon-side responder — the SDK call resolves to `method-not-found` at runtime (the F2 round-4 Codex finding T4.6 records; the D-018-6 rule applied to the widened namespace).

## Parallelization Notes

- Participant mapping and presence aggregation can proceed in parallel once id and authorship contracts are fixed.
- Client surfaces should wait for aggregated-status precedence rules and device-detail authorization to stabilize.
- Phase 5 splits into two independent chains: the identity-key leg (T5.1 → T5.2/T5.3 → T5.8) and the credential-seam leg (T5.4 → T5.5/T5.6 → T5.7). The two legs share no symbol and can proceed in parallel; T5.7 lands last in its leg (it injects what T5.4–T5.6 build), and T5.6 depends on T5.4's proof-key custody.

## Test And Verification Plan

- Multi-device presence tests proving one authenticated identity still yields one participant per session
- Historical authorship tests proving display-name changes do not rewrite prior events
- Fallback-profile tests proving stable placeholder identity works when profile metadata is incomplete
- Identity-key registration tests proving register-once semantics: same-key replay acknowledged idempotent, different-key-same-fingerprint refused with the typed 409 before any row mutation (I-018-12), and self-only binding (`sub` ≠ target refused)
- Roster-read authorization tests proving the one-statement membership gate: non-member and nonexistent-session refusals byte-identical (I-018-13), and no key bytes on `ParticipantProjection` (I-018-14)
- Credential-seam tests proving every mint carries the `DPoP` scheme + per-attempt proof (never `Bearer`, I-018-10), presented-token proofs share the access token's proof key (I-018-11 — with a negative control proving a second key fails `cnf.jkt` verification), refresh-reuse detection fails the mint closed, and the runtime stub assertion rejects a production root still bound to `Tier5DeferredDaemonCredentialProvider`

## Rollout Order

1. Land participant and authorship contracts plus shared persistence
2. Enable presence aggregation and participant projection reads
3. Enable participant display-state editing and device-detail reads where authorized
4. Land the identity-key store + register/roster surfaces and the daemon credential seam (Phase 5) — the identity-key leg before its Tier-7/Tier-9 consumers need rows, the credential-seam leg before any CP-018-12 caller goes live; enrollment stays caller-dormant until the client-side presenter carrier lands (§Preconditions box)

## Rollback Or Fallback

- Hide device-level detail and keep only aggregated participant presence if device fan-out semantics regress.

## Risks And Blockers

- Guest or anonymous identity support remains unresolved for the first implementation (deferral tracked in parent [Spec-018](../specs/018-identity-and-participant-state.md))
- Presence aggregation can become misleading if conflicting device activity is not handled conservatively
- **Phase-2 code-land was gated on Open Decisions 1 and 2** (auth context producer shape, identity_ref derivation) — both ratified at the Tier-5 pause (D-018-1 Plan-018-owned `AuthenticatedIdentityContext`; D-018-2 stable synthetic ref), so the gate is cleared; the Spec-018 / `shared-postgres-schema.md` pins land at swap.
- **Phase-3/4 Tasks T3.1/T3.4/T4.4 were gated on Open Decisions 4 and 5** (lastSeen source, PresenceDetailRead authorized-set) — both ratified (D-018-4 precedence-device `lastSeen`; D-018-5 owner/operator-only); the Spec-018 pins land at swap.
- **Identity-key enrollment is caller-dormant until the client-side presenter carrier lands** (§Preconditions born-unchecked box, NS-62): T5.2's endpoint and T5.8's handlers ship production-complete with no production caller, and Plan-027's Tier-9 roster consumption reads populated rows only after the ADR-021 custody-ladder client flow (key generation + presentation + the explicit-rotation revocation signal) is registered by a lead-owned amendment. Dormancy is a hold on the end-to-end enrollment claim, not on any T5.x dispatch.

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

- **2026-08-15 — `review → approved` promotion carrying the NS-62 targeted readiness-audit delta (PR #334).** The Tier-5 audit's flip (NS-17, 2026-05-30) is discharged by a promotion pass that could not be plain: CP-018-12 (2026-07-31, widened three times) and CP-018-13 (2026-08-12) are post-audit growth the 2026-05-30 walk never examined, and both schedule their task decomposition at exactly this pass — so the promotion carries a targeted readiness-audit delta scoped to that growth (the CP-024-5 / PR #283 / NS-44 correction's rule; the Plan-014-delta partial-coverage shape), minted as cross-plan §6 node NS-62. Authored in the swap: **Phase 5** (T5.1–T5.8 — the identity-key leg: `participant_identity_keys` store, register-once/refuse-on-rotation endpoint, membership-gated roster read, daemon gateway handlers; and the credential-seam leg: the real `PasetoDaemonCredentialProvider`, the issuance-into-the-daemon + refresh path, the CP-014-5 presented-token affordance, seam-wide composition-root injection), invariants **I-018-10..I-018-14**, the CP-018-6/11/12/13 amendments, ADR-010 + ADR-021 added to Required ADRs, and the **client-side presenter carrier box** (born-unchecked, NS-54 class — no T5.x held). Cross-corpus in the same PR: Spec-018 flip-and-restored `approved` (the §Spec-Status Promotion Gate one-swap shape — its `review` window would otherwise invalidate this plan's own "Paired spec is approved" precondition), Plan-006 flip-and-restored `approved` (the T3.3 interface-growth registration — the PR #278 self-audit shape), the `participant_identity_keys` DDL + PII-map + erasure-runbook rows, the two `participant.*` error codes, the five-method registry re-derivation, the caller-enumeration sweep to live-plus-forward-declared (Plan-019's sixth, Plan-027's seventh), and the §1/§2/§3/§5/§6 map deltas (Postgres census 25 → 26). Promotion is status-gate clearance only: lane-1 dispatch still rides Tier-5 order and this plan's §Preconditions.

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
