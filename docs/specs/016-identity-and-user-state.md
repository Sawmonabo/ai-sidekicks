# Spec-016: Identity And User State

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `016` |
| **Slug** | `identity-and-user-state` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Depends On** | [User And Device Model](../domain/user-and-device-model.md), [Control Plane Architecture](../architecture/control-plane.md) |
| **Implementation Plan** | [Plan-016: Identity And User State](../plans/016-identity-and-user-state.md) |

## Purpose

Define how authenticated identity maps into session users and how user state is represented over time.

## Scope

This spec covers the hosted account and its one user record, user profile state, the keys each of the person's machines and devices holds, the hosted-account sign-in, the owner's passkeys, and session-scoped user projections.

## Non-Goals

- Organization-wide directory sync
- Billing or account subscription state
- Guest or anonymous identity, and hardware-security-module custody: the product has one user, who signs in as themself
- A sign-in of the console's own: the console holds no identity, and the desktop app carries no WebAuthn

## Domain Dependencies

- [User And Device Model](../domain/user-and-device-model.md)
- [Session Model](../domain/session-model.md)

## Architectural Dependencies

- [Control Plane Architecture](../architecture/control-plane.md)
- [Security Architecture](../architecture/security-architecture.md)
- [ADR-008: Default Transports And Relay Boundaries](../decisions/008-default-transports-and-relay-boundaries.md)
- [ADR-010: Tokens, Passkeys And The Remote Channel](../decisions/010-tokens-passkeys-and-the-remote-channel.md) (the daemon credential seam's token + DPoP protocol owner)
- [ADR-021: Machine Identity Key Custody](../decisions/021-cli-identity-key-storage-custody.md) (the machine key's custody under the master key, and the rule that a key is never replaced in place)

## Required Behavior

- The hosted account is one user record: every passkey the account holds resolves to that user, and no sign-in, passkey or device link makes a second user.
- The person may reach a session from several devices at once, and each is the same user.
- User display state is the stable id and the display name.
- Historical user authorship must remain stable even when display metadata later changes.
- User state changes must be represented in session history when they affect session semantics.
- Every machine and every linked device holds its own identity key. A machine's is one Ed25519 key, minted by its background service at first start, and again only at `sidekicks rotate-keys` and when a removed machine is linked again, and sealed under the master key; it never leaves the machine. A phone's or browser's is made on the device and never exported: P-256 in the iPhone's Secure Enclave or the Android Keystore, a non-extractable WebCrypto key in the web client. Every public key carries its algorithm (`p256` or `ed25519`). The control plane keeps one `devices` row per linked device and one `runtime_nodes` row per machine, each holding its public key, name, platform and version; the account's trust in those keys is the signed statement chain, kept in `trust_statements`, of [Spec-028 §Device registration and revocation](./028-remote-control.md#device-registration-and-revocation), and the Devices page in Settings lists the machines, the devices and the passkeys.
- A key enters the account only with its statement in the account's statement chain: the person's first machine opens the chain with a `runtimenode.added` it signs itself, every later machine joins by linking, which records its `runtimenode.added` signed by the device or machine that links it, and a device's key enters with its `device.linked` ([Spec-028 §Device registration and revocation](./028-remote-control.md#device-registration-and-revocation); built by [Plan-028 §Phase 2 — Identity keys and the statement chain](../plans/028-remote-control.md#phase-2--identity-keys-and-the-statement-chain)). No `user.*` verb registers a key. `sidekicks sign-in` enrolls the machine's identity key with the control plane, which then accepts the service's `runtimenode.register` only for that key: enrollment is the control plane's admission record, and the statement is the trust record. The key moves only through `sidekicks rotate-keys`, which records a `runtimenode.key_rotated` statement signed by the old key and the new one and re-enrolls the new key, and when a removed machine is linked again, which first mints a new identity key under its same machine id and records its new `runtimenode.added`, moving every device's pin for that id as a rotation does; the machine's store, sessions and id stay.
- A machine or device learns another's key only from the account's statement chain: it verifies the chain itself and trusts a key only when a path of `runtimenode.added`, `device.linked`, `passkey.added` and `runtimenode.key_rotated` statements reaches it from its own machine key, each signed while its signer was still trusted at that point in the chain ([Spec-028 §Device registration and revocation](./028-remote-control.md#device-registration-and-revocation); built by [Plan-028 §Phase 2 — Identity keys and the statement chain](../plans/028-remote-control.md#phase-2--identity-keys-and-the-statement-chain)). A `device.revoked`, `runtimenode.removed`, `passkey.removed` or `runtimenode.key_rotated` ends the key it names at that point: a statement that key signs afterward is refused, and what it signed before stands, so every device, machine and passkey it added stays trusted. An ended key is never trusted again. A device that a since-revoked device linked carries `Linked from <device>, which you revoked. Revoke it if that device was lost.` on its card. A device refuses a known machine id with a different key unless a `runtimenode.key_rotated` or a later `runtimenode.added` for that id is behind it. The control plane serves no read that resolves a user's keys.
- The console holds no identity of its own and draws no sign-in: no sign-in gate in front of the first session, no passkey card, and no account step. The only sign-in on any of its screens is a provider account's, on Settings › Providers. The desktop app carries no WebAuthn. Passkeys are the owner's way in beside a device link: the web client and the phone apps create and use them, the device-code page makes the account's first one when it creates the account and uses one to verify the person before it approves a sign-in code, and any device lists and removes them on the Devices page, where the desktop app shows no `Add a passkey`. A passkey lets a new phone or browser link itself with no other device at hand.
- Passkey (WebAuthn) ceremony options are issued by the control plane to the web client, the phone apps and the device-code page, and every challenge it issues is **single-use and short-lived**: the challenge is recorded when the options are issued, consumed atomically at verification, and expires on its own clock, so a replayed or late response is refused with nothing to compare against rather than verified twice. The client never chooses a challenge, an `rpId`, or an origin.
- **A successful authentication verification issues a fresh, sender-bound token pair.** The verify leg answers a positive verdict with a newly minted PASETO access/refresh pair, sender-constrained per [ADR-010](../decisions/010-tokens-passkeys-and-the-remote-channel.md) to the DPoP key the caller proved possession of on that same request. The ceremony is what a cold install has — it holds no refresh token to present and none to unwrap — so a design in which sign-in only unlocks an already-stored token is unreachable exactly after a reinstall, which is the case sign-in exists to serve. The DPoP proof binds the issued pair to a key; it establishes no identity and does not make this pre-authentication procedure a credentialed one. Re-issuance is unconditional on success rather than conditional on the caller claiming to lack a token, because a conditional issue would take the client's word for its own state. **The proof this route validates is the token-request form, and the distinction is load-bearing.** [RFC 9449 §5](https://datatracker.ietf.org/doc/html/rfc9449#section-5) governs a proof accompanying a request for a token: it carries no `ath`, because no access token exists yet. [§4.3](https://datatracker.ietf.org/doc/html/rfc9449#section-4.3) governs a proof accompanying a request that presents one, and requires `ath` — which is the form every already-credentialed path in this product implements, and which therefore cannot serve this route. The verify leg validates the §5 form explicitly: `typ` `dpop+jwt`, `htm` and `htu` matching this request, `iat` inside the accepted window, a single-use `jti`, an embedded public `jwk` of a permitted algorithm carrying no private parameters, a signature verifying under that `jwk`, and **`ath` required to be absent** rather than merely unchecked — an `ath`-bearing proof is refused, not accepted-and-ignored, so a proof minted for another request cannot be replayed onto this one. The issued pair's `cnf.jkt` is computed as that key's JWK SHA-256 thumbprint and never taken from anything the caller states separately; without that binding the route would hand an unauthenticated caller a bearer pair. A missing, malformed, replayed, or `ath`-bearing proof refuses the whole verification and issues nothing.
- Registration and assertion responses are verified **server-side, through a maintained WebAuthn verification library** — never through hand-rolled COSE or CBOR parsing in this codebase. Verification records the credential's signature counter and refuses a response whose counter regresses on an authenticator that reports one. **The counter check is a locked read-and-conditional-write inside the verification transaction**: the credential row is taken `FOR UPDATE` before the stored counter is read, and the advance commits only if the presented value exceeds it. Read-then-write without the lock makes the check useless against the exact adversary it exists to detect — a cloned authenticator replaying concurrently — because two transactions each read the old value and each conclude the counter advanced.
- **A credential can be revoked, and revocation is a relying-party act on the credential row.** An authenticated operation deletes the caller's own `webauthn_credentials` row, after which that credential resolves to nothing on every assertion and can complete no ceremony from any installation. The invariant lives on the server row rather than on client state because the authentication pair is deliberately reachable without a session: removing the passkey only from the device that holds it leaves a lost or stolen authenticator able to sign in from any other browser or phone, which is exactly the failure revocation exists to prevent. Revocation is `Remove` on a passkey in the Devices page's Passkeys section, recorded in the statement chain as a `passkey.removed`; a site cannot delete the key on the person's device, so the web client and the phone apps then tell the platform, each time they sign in, which passkeys are still accepted. Three properties are stated rather than left to the implementation. The row is resolved **under the caller's own user id**, so a request naming another user's credential id is indistinguishable from one naming an id that does not exist, and an absent id succeeds — the same non-disclosure the assertion path keeps, and the property that makes the operation safe to expose. Storage is a **hard delete and not a revocation tombstone**: a tombstone would let the verification leg distinguish _revoked_ from _unknown_, which is the oracle every other arm of this flow refuses, and would mint a column to obtain it. And revoking the user's **last** credential is permitted rather than blocked — a link from a device already in use is a way back in, which the confirm says (`New devices will need a link from one you already use.`), and a rule that keeps a compromised key enrolled because it is the only one preserves precisely the state the user is trying to escape.
- **The authentication ceremony is reachable without a credential; the enrollment ceremony is not.** Sign-in is pre-authentication by construction — the ceremony is what produces the credential, so a user on a cold install or a fresh machine has nothing to present — and the two authentication operations are therefore unauthenticated control-plane procedures. They are correlated by a **server-minted ceremony transaction id**, returned by the options leg, presented by the verify leg, single-use and expiring on the challenge's own clock, so an unauthenticated caller is bounded to the transaction it was issued rather than to a session. They are rate-limited under [Spec-019 §Canonical Endpoint Group Registry](./019-rate-limiting-policy.md#canonical-endpoint-group-registry)'s `auth.endpoint` row (anonymous tier, per source address) and mint no registry row of their own: a per-transaction budget beside the per-source one has nothing to bound here, since single-use consumption already caps attempts per transaction at exactly one. The registration operations stay authenticated: enrollment adds a credential to a user who already exists and is already signed in, and admitting an unauthenticated enrollment would let anyone bind an authenticator to someone else's account.
- Daemon-resident control-plane caller credentials: every daemon-resident control-plane caller is credentialed as the machine's owner with a PASETO v4.public access token presented under the `DPoP` authorization scheme plus a per-attempt RFC 9449 proof — never `Bearer`.
- The service gets its hosted-account tokens from `sidekicks sign-in`, which runs the OAuth device-code flow: the command line prints a code and an address, opens the address in the browser where one exists, and waits. The page at the address offers `Sign in with a passkey` and `Create an account`. `Sign in with a passkey` accepts the account's passkey and verifies the person with it before the page approves the code. `Create an account` is the way in the first time the person runs `sidekicks sign-in` with no account yet: it asks for `Your name` once, then the platform's own passkey sheet makes the account's first passkey, and the page approves the code for the new account. Either way a computer the person has never used signs in without any machine of theirs, and the page receives no token and keeps nothing in the browser. No GitHub or other outside sign-in makes or finds the account. The control plane then issues a refresh token bound to this machine's DPoP key (`cnf.jkt`; the private key never leaves the machine), which is sealed under the master key in the daemon's database; sign-in runs with the service stopped, so the command line seals it through the same custody code. The service trades the refresh token for short-lived access tokens, and each trade returns a new refresh token and spends the old one. A spent refresh token presented again revokes its whole family: the service's next trade fails, and `sidekicks daemon status` prints `Hosted account: signed out · a reused sign-in was detected; sign in again`. Sign-out revokes the family. The refresh token lasts until sign-out or revocation; the access token lasts its own short lifetime and is never stored. The verbs are [Plan-006 §Phase R3 — Client Delivery](../plans/006-local-ipc-and-daemon-control.md#phase-r3--client-delivery)'s, and the control plane's half is [Plan-016](../plans/016-identity-and-user-state.md) Phase 5's.

## Default Behavior

- The user's display name is the one typed in `Your name` when the account is created. The person can change it later, and it is never read from a profile.

## Fallback Behavior

- If a user later loses access, authorship on prior events remains attached to the stable user id.
- A ceremony that cannot be verified fails closed and is never partially applied: no credential row is written on a failed registration verification, no session is established on a failed assertion verification, and the challenge is consumed either way, so a failed attempt cannot be retried against the same challenge. The caller restarts the ceremony from a fresh options issue.
- Credential unavailable fails closed: when the daemon credential seam cannot mint — no issued token, refresh-family reuse detected (a burned family is never retried), or the provider still bound to the refusing stub — the mint refuses and the calling surface degrades honestly on its own retry/backoff path; no caller falls back to `Bearer`, a cached stale proof, or an uncredentialed call.

## Interfaces And Contracts

- `UserProjectionRead` exposes the stable user id and the display metadata, and no presence.
- `UserStateUpdate` must support display metadata changes that do not rewrite historical events.
- No `user.*` read carries presence, and nothing in a session names which devices are connected. The Devices page in Settings draws each machine's and device's connected state and last-seen time from `device.list`, and a machine reports the devices connected to it through `presence.read` and `presence.subscribe` ([Spec-028](./028-remote-control.md)).
- No verification-key bytes ride `UserProjection`, no `user.*` operation registers a key and no operation reads a user's key set (the one key write is a machine's enrollment at `sidekicks sign-in`); another machine learns a key only from the statement chain ([Spec-028 §Device registration and revocation](./028-remote-control.md#device-registration-and-revocation)).
- The daemon credential provider (`DaemonCredentialProvider`) mints per-attempt header material: the access token under `Authorization: DPoP` plus the RFC 9449 proof whose `ath` hashes the presented token.
- `WebAuthnRegistrationOptionsIssue` / `WebAuthnRegistrationVerify`, `WebAuthnAuthenticationOptionsIssue` / `WebAuthnAuthenticationVerify`, and `WebAuthnCredentialRevoke` are the control-plane operations — the ceremony operations plus one credential-lifecycle operation — registered in [API Payload Contracts §WebAuthn Ceremony Procedure Registry](../architecture/contracts/api-payload-contracts.md). The web client and the phone apps call the ceremony operations, and the page at the device-code address calls `WebAuthnAuthenticationOptionsIssue` and hands the assertion to the device-code grant's approval route, which checks it as the verify leg does and issues no token ([Plan-016](../plans/016-identity-and-user-state.md) T5.9); any linked device calls `WebAuthnCredentialRevoke` from the Devices page. Each issue leg records its challenge and returns the ceremony transaction id; each verify leg presents that id and consumes the challenge. The **authentication-verify** reply carries the verdict and a freshly issued DPoP-bound PASETO access/refresh pair. The authentication operations are unauthenticated (see §Required Behavior); the registration operations and `WebAuthnCredentialRevoke` are not — revocation resolves the row under the caller's own user id, which requires one. A ceremony whose challenge or transaction id is unknown, already consumed, or expired returns `user.webauthn_challenge_invalid` (400); a response that fails verification returns `user.webauthn_verification_failed` (400) — the same code for a bad signature, a wrong origin, a wrong `rpId`, and a regressed counter, so the reply discloses no oracle about which check failed. `WebAuthnCredentialRevoke` returns success for an id the caller does not own and for one that does not exist, deleting nothing in both cases, so it discloses no enrolled-credential set.
- The command line's sign-in and sign-out verbs are not this spec's surface: they are the two daemon-control verbs [Spec-006 §Required Behavior](./006-local-ipc-and-daemon-control.md#required-behavior) owns, each refused while the daemon holds the data directory. This spec keeps what a sign-in is and what it leaves behind; that spec keeps the two verbs, and neither states the other's half a second time.
- See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed request/response schemas.
- See [Error Contracts](../architecture/contracts/error-contracts.md) for error response schemas and error codes.

## State And Data Implications

- The user record belongs to shared control-plane storage.
- The account is keyed by its own id. The user's `identity_ref` is the account's WebAuthn user handle: random bytes minted when the account is created, at most 64 of them and carrying no personal data ([WebAuthn Level 3 §5.4.3](https://www.w3.org/TR/webauthn-3/#dictionary-user-credential-params)), and carried by every passkey the account holds. A passkey resolves to its one user through its `webauthn_credentials` row. (See [shared-postgres-schema.md](../architecture/schemas/shared-postgres-schema.md).)
- Historical event authorship must reference stable user ids, not mutable display names.
- User-state changes with session impact must be durable.
- WebAuthn credentials and ceremony challenges live in shared control-plane storage. `webauthn_credentials` holds one row per enrolled passkey — the credential id, the COSE public key and the signature counter — FK-anchored to `users(id)` and therefore inside the Spec-020 Path-2 erasure closure. `webauthn_challenges` holds the outstanding ceremony transactions and is the **single-use fence**: a challenge is a row, and consuming it is deleting it. A sealed stateless challenge would not remove that write — single-use is the property that matters, and a self-contained token is replayable until it expires unless a durable fence records its consumption — so it would only add a second secret to manage beside the fence.
- Device keys live in shared control-plane storage in the `devices` table and machine keys in `runtime_nodes`, one row per linked device and per machine, and the account's statement chain in `trust_statements`, each FK-anchored to `users(id)` and therefore inside the Spec-020 Path-2 erasure closure, safe because every consumer verifies at live time. `identity_ref` is the passkey user handle, never key material: one user, one `identity_ref`, N key fingerprints.

## Example Flows

- `Example: One authenticated user joins the same session from desktop and CLI. The session still shows one user, and nothing in it names which devices are connected.`
- `Example: A user changes display name after joining. Future projections show the updated name while historical authorship remains stable to the same user id.`

## Implementation Notes

- Separate session-scoped user state from global account state.
- The person uses several devices, but user identity remains the stable unit of authorship.

## Pitfalls To Avoid

- Creating a new user record per device connection
- Rewriting old event authorship when display metadata changes
- An uninjected credential seam fails silently: a production composition root left bound to the refusing stub makes every daemon-resident control-plane call unreachable by construction — ship the runtime assertion beside the real provider, never assume the wiring
- Hand-rolling COSE key decoding or CBOR attestation parsing instead of using a maintained verification library — the attestation formats are a moving target and a parser bug here is an authentication bypass
- Putting verification-key bytes on the default user projection, or minting a second daemon proof key — both erode invariants this spec pins

## Acceptance Criteria

- [ ] One authenticated user appears as one user per session, even with multiple active devices.
- [ ] Historical event authorship remains stable when the display name changes.
- [ ] No session projection and no `user.*` read carries a presence state or names a connected device.
- [ ] A WebAuthn challenge verifies at most once: a second verification against the same challenge is refused.
- [ ] A successful authentication verification carrying a valid token-request DPoP proof returns a token pair whose `cnf.jkt` is that proof key's JWK thumbprint; the same verification carrying a proof with `ath` present returns no pair.
- [ ] A revoked credential completes no ceremony: an assertion signed by it fails verification and issues no token pair, from any installation.
- [ ] A user with no session and no stored credential completes a full sign-in: the authentication-options and authentication-verify procedures both answer an uncredentialed caller, and the pair is correlated only by the server-minted transaction id.
- [ ] A successful authentication verification returns a newly minted PASETO access/refresh pair bound to the DPoP key presented on that request, and returns a different pair on a second verification by the same user.
- [ ] Two verifications of one credential committed in either order leave the signature counter at the higher value and refuse the lower, with the losing transaction refused rather than silently overwriting.
- [ ] The desktop app offers no sign-in card and no `Add a passkey`; the only sign-in its screens draw is a provider account's on Settings › Providers.
- [ ] A machine's key reaches another machine only through its `runtimenode.added`, `device.linked` or `runtimenode.key_rotated` statement in the chain; signing in enrolls the machine's key with the control plane, which accepts the service's registration only for that key; a statement the old key signs after `sidekicks rotate-keys` is refused everywhere, while what it signed before stands.
- [ ] A refresh token presented a second time revokes its family: the next trade fails and `sidekicks daemon status` prints `Hosted account: signed out · a reused sign-in was detected; sign in again`.

## Open Questions

None.

## References

- [User And Device Model](../domain/user-and-device-model.md)
