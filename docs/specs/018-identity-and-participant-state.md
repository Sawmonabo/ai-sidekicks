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

> **Amendment (2026-09-01, WebAuthn ceremony server side — amends the previously-`approved` spec; the header flips to `review` under the audit runbook's spec-amendment rule and is restored `approved` in this same swap by the Plan-018 targeted readiness-audit delta riding this same diff ([cross-plan-dependencies.md §6](../architecture/cross-plan-dependencies.md) node NS-99, Codex round 4), the in-swap flip-and-restore shape PR #321 / NS-56 and PR #323 / NS-58 established.)** [ADR-010](../decisions/010-paseto-webauthn-mls-auth.md) has named WebAuthn the desktop's primary authentication factor since it was accepted, and [Spec-023](./023-desktop-shell-and-renderer.md) makes the Electron main process the party that runs the ceremony — but **no** document assigned the relying party's half of it to any plan: nothing issued a challenge, nothing recorded a credential, and nothing verified a response, so Plan-023's `register()` and `signIn()` reached a native binding with no server to call. This spec takes that half, because the ceremony's product is a participant identity and this spec is where identity mapping lives. Three rules land: server-issued **single-use, short-lived** ceremony options; a credential row that **records the user-verification mode observed at registration** and a reply that returns it, so the client compares against a server-held value rather than a locally-remembered one; and response verification through a **maintained library**, never hand-rolled COSE/CBOR. **Codex round 5 revises the swap in four ways rather than adding a fifth rule:** the mode moves from the options reply to the **verification** reply, since a discoverable sign-in offers no credential list and the options leg cannot know which credential will answer; PRF material is **provisional until that verdict arrives** and is destroyed on every refusal; the credential row gains a **minted-once PRF evaluation input** without which every restart derives a different key; and the two authentication operations are stated **unauthenticated** — sign-in is pre-authentication by construction — correlated by a server-minted single-use transaction id and rate-limited under the existing `Spec-021` `auth.endpoint` row. Plan rows: Plan-018 Phase 6 (T6.1–T6.4), invariants I-018-15..I-018-17, tables `webauthn_credentials` + `webauthn_challenges`.

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
- WebAuthn ceremony options are issued by the control plane, and every challenge it issues is **single-use and short-lived**: the challenge is recorded when the options are issued, consumed atomically at verification, and expires on its own clock, so a replayed or late response is refused with nothing to compare against rather than verified twice. The client never chooses a challenge, an `rpId`, or an origin. (2026-09-01 amendment.)
- Each registered credential records the **user-verification mode observed at registration** — bit 2 of the returned authenticator-data flags byte, read from the verified registration response — as that credential's mode, and the **verification** reply returns the stored mode of the credential that actually signed. The client's response-side UV check (`Spec-023 §WebAuthn Platform-Authenticator Native Module` guard 4) therefore compares against a **server-held** value, not a value the client remembered: CTAP 2.1 mints two per-credential secrets and selects between them on that bit, so a mode the client guesses wrong is a silently different derived key rather than a refusal. The mode rides the verification reply and **not** the options reply because the desktop's credentials are discoverable — the options leg offers no credential list and does not know which credential will answer — so the earliest reply that can name the signing credential is the one that follows the signature. (2026-09-01 amendment, revised in the same swap's Codex round 5.)
- **PRF-derived key material is provisional until the server has verified the assertion, and the ordering is normative.** A client holding an assertion and its PRF output uses neither until the verify leg answers; on any refusal — unknown credential, bad signature, wrong origin, wrong `rpId`, UV mismatch, counter regression — it destroys the provisional bytes before caching, deriving, or unwrapping anything. Deriving first and verifying second produces key material from an assertion the relying party then rejects, and a wrong wrapping key is indistinguishable from a right one until something later fails to open. (2026-09-01 amendment, Codex round 5.)
- **The PRF evaluation input is minted once per credential and served back on every options reply.** Registration generates a random 32-byte evaluation input, stores it on the credential row, and every subsequent authentication-options reply returns it for that credential. It is not regenerated per ceremony: PRF output is a function of the credential secret _and_ that input, so a fresh input each sign-in derives a fresh key and leaves everything wrapped under the previous one unopenable — a failure that appears only after a restart. It is a per-credential value (two authenticators hold two secrets, so one shared input would still yield two keys), it is distinct from the key-derivation salt the consuming branch supplies, and it is not confidential — it is useless without the authenticator, which is why it is served on an uncredentialed reply. (2026-09-01 amendment, Codex round 5.)
- Registration and assertion responses are verified **server-side, through a maintained WebAuthn verification library** — never through hand-rolled COSE or CBOR parsing in this codebase. Verification records the credential's signature counter and refuses a response whose counter regresses on an authenticator that reports one. **The counter check is a locked read-and-conditional-write inside the verification transaction**: the credential row is taken `FOR UPDATE` before the stored counter is read, and the advance commits only if the presented value exceeds it. Read-then-write without the lock makes the check useless against the exact adversary it exists to detect — a cloned authenticator replaying concurrently — because two transactions each read the old value and each conclude the counter advanced. (2026-09-01 amendment; the lock clause added in the same swap's Codex round 5.)
- **The authentication ceremony is reachable without a credential; the enrolment ceremony is not.** Sign-in is pre-authentication by construction — the ceremony is what produces the credential, so a participant on a cold install or a fresh machine has nothing to present — and the two authentication operations are therefore unauthenticated control-plane procedures. They are correlated by a **server-minted ceremony transaction id**, returned by the options leg, presented by the verify leg, single-use and expiring on the challenge's own clock, so an unauthenticated caller is bounded to the transaction it was issued rather than to a session. They are rate-limited under `Spec-021 §Canonical Endpoint Group Registry`'s `auth.endpoint` row (anonymous tier, per source address) and mint no registry row of their own: the second axis the invite-redemption pair uses — a per-token budget beside the per-source one — has nothing to bound here, since single-use consumption already caps attempts per transaction at exactly one. The registration operations stay authenticated: enrolment adds a credential to a participant who already exists and is already signed in, and admitting an unauthenticated enrolment would let anyone bind an authenticator to someone else's account. (2026-09-01 amendment, Codex round 5.)
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
- A ceremony that cannot be verified fails closed and is never partially applied: no credential row is written on a failed registration verification, no session is established on a failed assertion verification, and the challenge is consumed either way, so a failed attempt cannot be retried against the same challenge. The caller restarts the ceremony from a fresh options issue. (2026-09-01 amendment.)
- Credential unavailable fails closed: when the daemon credential seam cannot mint — no issued token, refresh-family reuse detected (a burned family is never retried), or the provider still bound to the Tier-5 refusing stub — the mint refuses and the calling surface degrades honestly on its own retry/backoff path; no caller falls back to `Bearer`, a cached stale proof, or an uncredentialed call. (2026-08-15 amendment.)

## Interfaces And Contracts

- `ParticipantProjectionRead` must expose stable participant id and canonical session-scoped membership role.
- `ParticipantStateUpdate` must support display metadata changes that do not rewrite historical events.
- `PresenceDetailRead` exposes device-level presence detail and is **owner/operator-only** (Plan-018 D-018-5 / I-018-6): per-device fan-out is privacy-sensitive, so the aggregated presence summary on `ParticipantProjection` remains the participant-visible default and the device-level breakdown is gated to the session `owner` and the daemon operator. A denied read returns `presence.permission_denied` (CP-018-7). See [Security Architecture §Per-Device Presence Detail Authorization](../architecture/security-architecture.md#per-device-presence-detail-authorization).
- `ParticipantIdentityKeyRegister` registers one workstation identity key for the authenticated participant (self-only; register-once per fingerprint); a rotation attempt under an existing fingerprint returns `participant.identitykeyregister_conflict` (409) before any row mutation. (2026-08-15 amendment; Plan-018 T5.2 / I-018-12.)
- `ParticipantIdentityKeyRoster` is membership-gated (any active session role) and returns a participant's registered `(key_fingerprint, public_key)` set for one session; the membership predicate and the read execute in one statement so a non-member and a nonexistent session are refused byte-identically with `participant.permission_denied` (403) — non-oracular by construction, because the roster's set size discloses a participant's workstation count. No verification-key bytes ride `ParticipantProjection`. (2026-08-15 amendment; Plan-018 T5.3 / I-018-13 / I-018-14.)
- The daemon credential provider (the Plan-006 `DaemonCredentialProvider` declaration this spec's Phase-5 rows implement) mints per-attempt header material: the access token under `Authorization: DPoP` plus the RFC 9449 proof whose `ath` hashes the presented token. Proof for a presented token: a distinct mint arm returns proof-header-only material over a caller-presented non-access token, under the same daemon-held proof key — one proof key per daemon, or `cnf.jkt` verification fails. (2026-08-15 amendment; Plan-018 T5.4 / T5.6, CP-014-5.)
- `WebAuthnRegistrationOptionsIssue` / `WebAuthnRegistrationVerify` and `WebAuthnAuthenticationOptionsIssue` / `WebAuthnAuthenticationVerify` are the four control-plane ceremony operations, registered in [API Payload Contracts §WebAuthn Ceremony Procedure Registry](../architecture/contracts/api-payload-contracts.md). Each issue leg records its challenge and returns the ceremony transaction id; each verify leg presents that id and consumes the challenge. The **authentication-verify** reply carries the verdict together with the signing credential's stored user-verification mode and — as of the same swap's round 5 — that credential's persisted PRF evaluation input rides the **options** reply, since the client needs it before the ceremony rather than after it. The two authentication operations are unauthenticated (see §Required Behavior); the two registration operations are not. A ceremony whose challenge or transaction id is unknown, already consumed, or expired returns `participant.webauthn_challenge_invalid` (400); a response that fails verification returns `participant.webauthn_verification_failed` (400) — the same code for a bad signature, a wrong origin, a wrong `rpId`, a UV mismatch, and a regressed counter, so the reply discloses no oracle about which check failed. (2026-09-01 amendment; Plan-018 T6.2 / T6.3 / I-018-15 / I-018-16.)
- See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed request/response schemas.
- See [Error Contracts](../architecture/contracts/error-contracts.md) for error response schemas and error codes.

## State And Data Implications

- Participant identity mapping belongs to shared control-plane storage.
- The participant's primary identity reference (`identity_ref`) is a **stable synthetic ref** — a PASETO `kid` or an internally minted handle — **not** a denormalized `{provider}:{external_id}` projection. A participant who links a second provider keeps one `identity_ref` and gains a second `identity_mappings` row, rather than colliding on the `identity_ref UNIQUE` constraint that a provider-denormalized value would force; the per-provider `{provider, external_id}` tuples live in `identity_mappings`, for which `identity_ref` is the join-stable anchor. (Plan-018 D-018-2; [shared-postgres-schema.md](../architecture/schemas/shared-postgres-schema.md).)
- Historical event authorship must reference stable participant ids, not mutable display names.
- Device-level presence detail may be ephemeral, but participant-state changes with collaboration impact must be durable.
- WebAuthn credentials and ceremony challenges live in shared control-plane storage. `webauthn_credentials` holds one row per enrolled authenticator credential — the credential id, the COSE public key, the signature counter, the registration-time user-verification mode, and the credential's minted-once PRF evaluation input — FK-anchored to `participants(id)` and therefore inside the Spec-022 Path-2 erasure closure. `webauthn_challenges` holds the outstanding ceremony transactions and is the **single-use fence**: a challenge is a row, and consuming it is deleting it. A sealed stateless challenge was considered and rejected — single-use is the property that matters, and a self-contained token is replayable until it expires unless a durable fence records its consumption, so the stateless design does not remove the write, it only adds a second secret to manage beside it. (2026-09-01 amendment; Plan-018 T6.1.)
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
- Hand-rolling COSE key decoding or CBOR attestation parsing instead of using a maintained verification library — the attestation formats are a moving target and a parser bug here is an authentication bypass (2026-09-01 amendment)
- Trusting a client-asserted user-verification mode, or leaving the mode unrecorded so the client has nothing authoritative to compare its response against — the mode selects which of the authenticator's two per-credential secrets is derived, so an unpinned mode is a silently wrong key rather than a visible failure (2026-09-01 amendment)
- Putting verification-key bytes on the default participant projection, or minting a second daemon proof key — both erode gates the amendment's invariants pin (I-018-14, I-018-11) (2026-08-15 amendment)

## Acceptance Criteria

- [ ] One authenticated user appears as one participant per session, even with multiple active devices.
- [ ] Historical event authorship remains stable when participant profile data changes.
- [ ] Session projections can summarize multiple presences into one participant state.
- [ ] A WebAuthn challenge verifies at most once: a second verification against the same challenge is refused. (2026-09-01 amendment.)
- [ ] An assertion whose authenticator-data user-verification bit differs from the mode recorded at that credential's registration is refused, and no key is derived from it. (2026-09-01 amendment.)
- [ ] A participant with no session and no stored credential completes a full sign-in: the authentication-options and authentication-verify procedures both answer an uncredentialed caller, and the pair is correlated only by the server-minted transaction id. (2026-09-01 amendment, Codex round 5.)
- [ ] Two authentications against one credential, separated by a process restart, are served the same PRF evaluation input and derive byte-identical key material. (2026-09-01 amendment, Codex round 5.)
- [ ] Two verifications of one credential committed in either order leave the signature counter at the higher value and refuse the lower, with the losing transaction refused rather than silently overwriting. (2026-09-01 amendment, Codex round 5.)

## ADR Triggers

- If participant identity and membership are no longer session-scoped projections, revisit `../decisions/001-session-is-the-primary-domain-object.md`.

## Resolved Questions and V1 Scope Decisions

- No blocking open questions remain for v1.
- V1 decision: guest and anonymous participant identities are out of scope for the first release. Shared participation requires authenticated identity.

## References

- [Invite Membership And Presence](../specs/002-invite-membership-and-presence.md)
- [Participant And Membership Model](../domain/participant-and-membership-model.md)
