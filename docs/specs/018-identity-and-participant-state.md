# Spec-018: Identity And Participant State

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `018` |
| **Slug** | `identity-and-participant-state` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Depends On** | [Invite Membership And Presence](../specs/002-invite-membership-and-presence.md), [Participant And Membership Model](../domain/participant-and-membership-model.md), [Component Architecture Control Plane](../architecture/component-architecture-control-plane.md) |
| **Implementation Plan** | [Plan-018: Identity And Participant State](../plans/018-identity-and-participant-state.md) |

> **Amendment (2026-08-15, participant identity-key registration + daemon credential seam — amends the previously-`approved` spec; the header flips to `review` under the audit runbook's spec-amendment rule and is restored `approved` in this same swap by the Plan-018 NS-62 promotion-pass targeted readiness-audit delta (PR #334), whose targeted coverage audits exactly this growth — the flip-and-restore-in-one-swap shape PR #321/NS-56 and PR #323/NS-58 used, taken here additionally because a `review` window on this spec would invalidate Plan-018's own "Paired spec is approved" precondition inside its promotion PR.)** Two coordinated additions, each affected section carrying the normative text in place. (1) **Participant identity-key registration and roster** — a participant holds one registered long-term Ed25519 identity key per workstation (multi-key by construction, [trust-and-identity.md §Edge Cases](../domain/trust-and-identity.md#edge-cases)); registration is register-once with the control-plane half of [ADR-021](../decisions/021-cli-identity-key-storage-custody.md)'s Refuse-On-Rotation Invariant; the roster read is membership-gated and non-oracular; no key bytes ride `ParticipantProjection`. This closes the coherence gap [trust-and-identity.md §Related Specs](../domain/trust-and-identity.md#related-specs) already asserts — "control-plane data model for participant identities **and key registration**" — a claim this spec did not honor before this amendment. (2) **Daemon credential seam** — the daemon-resident control-plane caller credential (PASETO v4.public access token under the `DPoP` scheme + per-attempt RFC 9449 proof), its issuance-into-the-daemon and refresh path, and the proof-for-a-presented-token affordance (Plan-014 CP-014-5), implementing the Plan-006 CP-006-13 interface declaration. Plan rows: Plan-018 Phase 5 (T5.1–T5.8), invariants I-018-10..I-018-14.

## Purpose

Define how authenticated identity maps into session participants and how participant state is represented over time.

## Scope

This spec covers participant identity mapping, participant profile state, device presence fan-out, and session-scoped participant projections.

## Non-Goals

- Organization-wide directory sync
- Billing or account subscription state
- Runtime-node attach details

## Domain Dependencies

- [Participant And Membership Model](../domain/participant-and-membership-model.md)
- [Session Model](../domain/session-model.md)

## Architectural Dependencies

- [Component Architecture Control Plane](../architecture/component-architecture-control-plane.md)
- [Security Architecture](../architecture/security-architecture.md)
- [ADR-008: Default Transports And Relay Boundaries](../decisions/008-default-transports-and-relay-boundaries.md)
- [ADR-010: PASETO / WebAuthn / MLS Authentication Stack](../decisions/010-paseto-webauthn-mls-auth.md) (the daemon credential seam's token + DPoP protocol owner — 2026-08-15 amendment)
- [ADR-021: CLI Identity Key Storage Custody](../decisions/021-cli-identity-key-storage-custody.md) (client-side key custody + the Refuse-On-Rotation Invariant whose control-plane half the registration surface enforces — 2026-08-15 amendment)

## Required Behavior

- An authenticated identity must map to one canonical participant record per session.
- A participant may have multiple simultaneous device or client presences.
- Participant display state must include stable id, display name, canonical membership role, membership state, and current presence summary.
- Historical participant authorship must remain stable even when display metadata later changes.
- Participant state changes must be represented in session history when they affect collaboration semantics.
- A participant holds one registered long-term Ed25519 identity key per workstation; identity-key registration is register-once — a same-key replay is an acknowledged idempotent no-op, and a registration presenting a different key under an existing fingerprint is refused with a typed error before any row mutation, never silently overwritten (the control-plane half of ADR-021's Refuse-On-Rotation Invariant; a participant registers only their own key). (2026-08-15 amendment.)
- Roster resolution by participant and fingerprint: an authorized session member can resolve a participant's registered `(key_fingerprint, public_key)` set — the source cross-plan consumers verify against (bundle admission, attestation delivery, cross-node dispatch intake) — and an unknown fingerprint refuses within that participant's key set only. (2026-08-15 amendment.)
- Daemon-resident control-plane caller credentials: every daemon-resident control-plane caller is credentialed as the node-owner participant with a PASETO v4.public access token presented under the `DPoP` authorization scheme plus a per-attempt RFC 9449 proof — never `Bearer`. Credential issuance and refresh: the daemon acquires its daemon-scoped access + refresh pair at session establishment with `cnf.jkt` bound to the daemon-held proof key (the private key never leaves the daemon), and refreshes on the v4.local rotation family rather than re-running the interactive grant. A DPoP proof over a presented non-access token (e.g. an artifact fetch token) is minted under the same daemon-held proof key the access token's `cnf.jkt` binds. (2026-08-15 amendment.)

## Default Behavior

- Participant display name defaults to the authenticated profile display name at join time.
- Session participant projection defaults to one aggregated presence summary plus optional device-level detail.
- If multiple presences exist, participant status defaults to the highest-activity summary state, preferring `online` over `idle` over `reconnecting` over `offline`.
- When the highest-activity (precedence) device differs from the most-recently-seen device, the projection's `lastSeen` carries the **precedence device's** value — not the globally-latest timestamp across devices — so the projected `{state, lastSeen}` pair stays internally consistent (state and timestamp describe the same device). (Plan-018 D-018-4.)

## Fallback Behavior

- If authenticated profile data is partially unavailable, the system must still create a participant record with a stable id and placeholder display metadata.
- If multiple devices report conflicting activity states, the session projection must remain conservative and avoid false `offline`.
- If a participant later loses access, authorship on prior events remains attached to the stable participant id.
- Credential unavailable fails closed: when the daemon credential seam cannot mint — no issued token, refresh-family reuse detected (a burned family is never retried), or the provider still bound to the Tier-5 refusing stub — the mint refuses and the calling surface degrades honestly on its own retry/backoff path; no caller falls back to `Bearer`, a cached stale proof, or an uncredentialed call. (2026-08-15 amendment.)

## Interfaces And Contracts

- `ParticipantProjectionRead` must expose stable participant id and canonical session-scoped membership role.
- `ParticipantStateUpdate` must support display metadata changes that do not rewrite historical events.
- `PresenceDetailRead` exposes device-level presence detail and is **owner/operator-only** (Plan-018 D-018-5 / I-018-6): per-device fan-out is privacy-sensitive, so the aggregated presence summary on `ParticipantProjection` remains the participant-visible default and the device-level breakdown is gated to the session `owner` and the daemon operator. A denied read returns `presence.permission_denied` (CP-018-7). See [Security Architecture §Per-Device Presence Detail Authorization](../architecture/security-architecture.md#per-device-presence-detail-authorization).
- `ParticipantIdentityKeyRegister` registers one workstation identity key for the authenticated participant (self-only; register-once per fingerprint); a rotation attempt under an existing fingerprint returns `participant.identitykeyregister_conflict` (409) before any row mutation. (2026-08-15 amendment; Plan-018 T5.2 / I-018-12.)
- `ParticipantIdentityKeyRoster` is membership-gated (any active session role) and returns a participant's registered `(key_fingerprint, public_key)` set for one session; the membership predicate and the read execute in one statement so a non-member and a nonexistent session are refused byte-identically with `participant.permission_denied` (403) — non-oracular by construction, because the roster's set size discloses a participant's workstation count. No verification-key bytes ride `ParticipantProjection`. (2026-08-15 amendment; Plan-018 T5.3 / I-018-13 / I-018-14.)
- The daemon credential provider (the Plan-006 `DaemonCredentialProvider` declaration this spec's Phase-5 rows implement) mints per-attempt header material: the access token under `Authorization: DPoP` plus the RFC 9449 proof whose `ath` hashes the presented token. Proof for a presented token: a distinct mint arm returns proof-header-only material over a caller-presented non-access token, under the same daemon-held proof key — one proof key per daemon, or `cnf.jkt` verification fails. (2026-08-15 amendment; Plan-018 T5.4 / T5.6, CP-014-5.)
- See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed request/response schemas.
- See [Error Contracts](../architecture/contracts/error-contracts.md) for error response schemas and error codes.

## State And Data Implications

- Participant identity mapping belongs to shared control-plane storage.
- The participant's primary identity reference (`identity_ref`) is a **stable synthetic ref** — a PASETO `kid` or an internally minted handle — **not** a denormalized `{provider}:{external_id}` projection. A participant who links a second provider keeps one `identity_ref` and gains a second `identity_mappings` row, rather than colliding on the `identity_ref UNIQUE` constraint that a provider-denormalized value would force; the per-provider `{provider, external_id}` tuples live in `identity_mappings`, for which `identity_ref` is the join-stable anchor. (Plan-018 D-018-2; [shared-postgres-schema.md](../architecture/schemas/shared-postgres-schema.md).)
- Historical event authorship must reference stable participant ids, not mutable display names.
- Device-level presence detail may be ephemeral, but participant-state changes with collaboration impact must be durable.
- Participant identity keys live in shared control-plane storage (`participant_identity_keys` — one row per registered workstation key, FK-anchored to `participants(id)` and therefore inside the Spec-022 Path-2 erasure closure; a deliberate divergence from the FK-free daemon signing-key roster, safe because every consumer verifies at live time). `identity_ref` remains a key _identifier_ (a PASETO `kid`), never key material: one participant, one `identity_ref`, N key fingerprints. (2026-08-15 amendment; Plan-018 T5.1.)

## Example Flows

- `Example: One authenticated user joins the same session from desktop and CLI. The session still shows one participant with two active presences.`
- `Example: A participant changes display name after joining. Future projections show the updated name while historical authorship remains stable to the same participant id.`

## Implementation Notes

- Separate session-scoped participant state from global account state.
- Participant projection should optimize for collaboration clarity, not identity-provider completeness.
- Device fan-out is real, but participant identity must remain the stable unit of authorship.

## Pitfalls To Avoid

- Creating a new participant record per device connection
- Rewriting old event authorship when display metadata changes
- Treating identity-provider data as always complete and always available
- An uninjected credential seam fails silently: a production composition root left bound to the Tier-5 refusing stub makes every daemon-resident control-plane call unreachable by construction — ship the runtime assertion beside the real provider, never assume the wiring (2026-08-15 amendment)
- Putting verification-key bytes on the default participant projection, or minting a second daemon proof key — both erode gates the amendment's invariants pin (I-018-14, I-018-11) (2026-08-15 amendment)

## Acceptance Criteria

- [ ] One authenticated user appears as one participant per session, even with multiple active devices.
- [ ] Historical event authorship remains stable when participant profile data changes.
- [ ] Session projections can summarize multiple presences into one participant state.

## ADR Triggers

- If participant identity and membership are no longer session-scoped projections, revisit `../decisions/001-session-is-the-primary-domain-object.md`.

## Resolved Questions and V1 Scope Decisions

- No blocking open questions remain for v1.
- V1 decision: guest and anonymous participant identities are out of scope for the first release. Shared participation requires authenticated identity.

## References

- [Invite Membership And Presence](../specs/002-invite-membership-and-presence.md)
- [Participant And Membership Model](../domain/participant-and-membership-model.md)
