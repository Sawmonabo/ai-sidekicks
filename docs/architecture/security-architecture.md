# Security Architecture

## Purpose

Define the system's trust boundaries, permission layers, and transport security posture.

## Scope

This document covers identity, membership authorization, node trust, approvals, capability grants, and transport boundaries.

## Context

The product combines multiple humans, multiple runtime nodes, and local code execution. Security depends on not collapsing those concerns into one flat trust model.

## Responsibilities

- authenticate users and authorize session membership
- distinguish participant trust from runtime-node trust
- govern tool, file, network, and execution permissions
- protect remote transport and relay paths
- preserve auditable approval and grant history

## Component Boundaries

| Component | Responsibility |
| --- | --- |
| `Identity And Session Authorization` | Authenticates users and authorizes membership in sessions. Auth methods are deployed incrementally: Device Authorization Grant (RFC 8628) at CLI launch (browser handshake for primary auth), WebAuthn/Passkeys added at desktop launch, with WebAuthn becoming the recommended default for desktop users. Tokens: PASETO v4 — access tokens (v4.public, 15 min), refresh tokens (v4.local, 7 days, rotated on use). OAuth 2.1 with PKCE mandatory. DPoP sender-constraining for access tokens. |
| `Membership Policy Engine` | Determines session roles and participant capabilities. |
| `Runtime Capability Registry` | Tracks what each runtime node can expose and under what trust envelope. |
| `Approval Policy Engine` | Evaluates and records approval requests and resolutions. Uses Cedar (CNCF sandbox) with principal-action-resource-context model: V1 compiles YAML policy definitions to Cedar policy sets at build time and evaluates them in-process with the resident, signature-verified `@cedar-policy/cedar-wasm` authorizer; V1.1 adds runtime policy-bundle loading into the already-resident evaluator (dynamic updates without redeployment — loading only, not WASM arrival; 2026-07-02 ADR-012 amendment). Policy chain of custody (signing, verification, operator key lifecycle) is governed by [ADR-012 §Policy Chain of Custody](../decisions/012-cedar-approval-policy-engine.md#policy-chain-of-custody); operational procedures are in [Cedar Policy Signing And Rotation](../operations/cedar-policy-signing-and-rotation.md). |
| `Transport Security Layer` | Protects local IPC, client-daemon, and relay/control-plane traffic. Local daemon: socket reachability plus a required 256-bit session token (mode 0600, rotated per restart) presented by the Desktop Shell or CLI client — see §Local Daemon Authentication for the authoritative model (BL-056 reconciliation, 2026-04-18). Control plane: HTTPS/TLS. Relay (V1): pairwise X25519 ECDH + XChaCha20-Poly1305 via audited `@noble/curves` and `@noble/ciphers` with ephemeral per-session X25519 keys authenticated by long-term Ed25519 identity keys — session-granularity forward secrecy, zero-knowledge relay (see §Relay Authentication And Encryption and [ADR-010](../decisions/010-paseto-webauthn-mls-auth.md)). Relay (V1.1+ upgrade path): MLS (RFC 9420) via an audited implementation once the promotion gates in ADR-010 pass, adding per-message ratcheting and post-compromise security. |
| `Audit Layer` | Records grants, denials, escalations, and revocations. |

## Data Flow

1. Identity claims enter through the control plane.
2. Membership policy determines whether the participant may join and what actions are allowed.
3. Runtime nodes declare capabilities and are accepted or rejected by trust policy.
4. Runs request tool, file, or network permissions when needed.
5. Approval decisions are recorded and propagated back into the run engine.

## Trust Boundaries

- Session membership does not imply local machine trust.
- Runtime-node capability declaration does not bypass approval policy.
- The relay path must be treated as less trusted than direct local transport.
- The local daemon remains the enforcement point for local execution permissions.

### Inter-Node Trust Boundaries

When one participant's daemon dispatches work to another participant's daemon, three invariants govern the cross-machine boundary. The full protocol is [Spec-024: Cross-Node Dispatch And Approval](../specs/024-cross-node-dispatch-and-approval.md).

- **Authenticated caller identity.** The target daemon must cryptographically verify the caller's PASETO v4.public token before any policy evaluation. The Cedar `principal` is set from the token's verified `sub` claim only after signature verification succeeds; the `request_body_hash` carried in both envelope and token binds the signature to the exact request body. An unverified participant-id header must never reach Cedar.
- **Per-dispatch target-owner approval.** No session role grants standing authority to execute on another participant's machine. Every cross-node dispatch requires an explicit approval signed by the target-node owner for that specific request; session-membership, runtime-node attachment, and capability declaration are necessary but not sufficient pre-conditions.
- **Tamper-evident dual-signed audit.** Each successful dispatch produces an `ApprovalRecord` envelope containing two PASETO v4.public tokens — the caller's request and the approver's decision — bound by a shared `request_body_hash` and by the approver's `bound_jti` claim pointing back to the caller token's `jti`. The envelope is independently verifiable by either party or by an auditor holding both long-term public keys, with no reliance on the relay or the control plane.

These invariants hold regardless of the network path (direct local, relay-mediated, offline-then-synced) and regardless of the caller's session role — a session owner dispatching to a collaborator's node is bound by the same rules as the reverse.

## Failure Modes

- An invited participant is over-trusted and gains unintended execution capability.
- Remembered approvals outlive their intended scope and create hidden privilege drift.
- Transport authentication succeeds while local authorization policy is misapplied.
- Relay or remote-path compromise exposes data that should have remained end-to-end protected.

---

## Authentication Implementation Specification

### Local Daemon Authentication (Task 5.1)

The local daemon uses a layered trust model based on socket reachability **plus** a 256-bit session token. The desktop **renderer is not a direct daemon client** — all renderer-originated requests are brokered by the Desktop Shell via the preload bridge and arrive at the daemon as shell-originated traffic. See [Spec-023 §Trust Stance](../specs/023-desktop-shell-and-renderer.md#trust-stance) and [container-architecture.md §Trust Boundaries](./container-architecture.md#trust-boundaries) for the canonical renderer-untrusted stance this section aligns with.

**Socket reachability model:**

| Client Type | Auth Required | Rationale |
| --- | --- | --- |
| Desktop shell (same machine) | Socket access + 256-bit session token | Shell is the daemon client for the desktop tier; holds all session-scoped auth material per `Spec-023 §Trust Stance`; forwards renderer-originated requests with auth headers attached and response payloads sanitized. |
| CLI (same machine) | Socket access + 256-bit session token | Same-user process; socket permissions (mode 0700) prevent cross-user access; token is defense-in-depth against misconfigured socket permissions. |
| External process (same machine) | 256-bit session token (required) | Untrusted processes on the same machine must present a token. |
| Desktop renderer (same machine) | Not a daemon client | All renderer-originated requests flow through the preload bridge to the Desktop Shell, which forwards them to the daemon with attached auth headers. The renderer never holds the daemon session token, PASETO access tokens, or the Ed25519 DPoP key per `Spec-023 §Trust Stance`. |
| Remote client | Not supported in V1 | Remote daemon access is out of scope; all remote communication goes through the control plane. |

**Session token specification:**

- **Generation:** CSPRNG (Node.js `crypto.randomBytes(32)`) producing a 256-bit token
- **Storage:** Written to `$XDG_RUNTIME_DIR/ai-sidekicks/daemon.token` with mode `0600` (owner read/write only)
- **Rotation:** Regenerated on every daemon restart. Previous tokens are immediately invalidated.
- **Verification:** Constant-time comparison (`crypto.timingSafeEqual`) to prevent timing attacks
- **Transport:** Passed in the `Authorization: Bearer <token>` header for HTTP, or as the first message in the IPC handshake for Unix domain sockets

**Token presentation requirements:**

- **Always required** for Desktop Shell and CLI clients. Both read the token from `$XDG_RUNTIME_DIR/ai-sidekicks/daemon.token` at daemon-connect time and present it. Socket permissions (mode 0700) are defense-in-depth; the token is primary. The prior "token optional for renderer / CLI" framing — which treated the renderer as a trusted local process — was reconciled under BL-056; renderer is no longer a direct daemon client, and CLI presentation of the token is no longer optional.
- **Required** for any external integration or tool connecting to the daemon socket.
- **Not applicable** to the desktop renderer, which is not a direct daemon client per `Spec-023 §Trust Stance`.

### Control-Plane Authentication (Task 5.2)

**PASETO v4 access tokens (v4.public):**

```
Header: v4.public
Payload: {
  sub: ParticipantId,          // participant UUID
  iss: "ai-sidekicks-cp",     // issuer: control plane
  aud: "ai-sidekicks-api",    // audience: API endpoints
  exp: <issued_at + 900>,     // 15-minute TTL
  iat: <unix_timestamp>,
  jti: <unique_token_id>,     // for revocation tracking
  cnf: {                      // DPoP confirmation claim
    jkt: <JWK_thumbprint>     // SHA-256 thumbprint of client's public key
  },
  scope: "session:read session:write run:create"  // space-delimited scopes
}
Signed with: Ed25519 signing key (control plane's private key)
```

**PASETO v4 refresh tokens (v4.local):**

```
Header: v4.local
Payload: {
  sub: ParticipantId,
  iss: "ai-sidekicks-cp",
  exp: <issued_at + 604800>,  // 7-day TTL
  iat: <unix_timestamp>,
  jti: <unique_token_id>,
  family: <rotation_family_id> // tracks rotation chain for reuse detection
}
Encrypted with: PASETO v4.local (XChaCha20 stream + BLAKE2b-MAC, encrypt-then-MAC; **not** XChaCha20-Poly1305 AEAD) under the control plane's symmetric key — per [ADR-010 §PASETO v4 Implementation Library](../decisions/010-paseto-webauthn-mls-auth.md#paseto-v4-implementation-library).
```

**Refresh token rotation:**

1. Client presents refresh token to `/auth/token` endpoint
2. Control plane validates token, checks `jti` against revocation list
3. Control plane issues new access token + new refresh token (new `jti`, same `family`)
4. Old refresh token's `jti` is added to the used-token set
5. If a used `jti` is presented again (reuse detection), the entire `family` is revoked — all tokens in the rotation chain are invalidated. This detects token theft.

**OAuth 2.1 + PKCE flows:**

- **Desktop:** Standard Authorization Code flow with PKCE (`code_challenge_method=S256`). Redirect to `http://localhost:<port>/callback` for local capture.
- **CLI:** Device Authorization Grant (RFC 8628). The CLI displays a URL and user code. The user visits the URL in a browser, enters the code, and authenticates. The CLI polls `/auth/device` until the grant is approved.
- **WebAuthn/Passkeys:** Added at desktop launch. Uses the PRF extension for E2EE key derivation where available. Not required for V1 CLI.

**DPoP sender-constraining:**

- Client generates an ephemeral Ed25519 key pair at session start
- Each API request includes a `DPoP` header containing a signed proof: `{jti, htm, htu, iat}` signed by the client's private key
- The control plane verifies the DPoP proof's signature matches the `cnf.jkt` thumbprint in the access token
- Prevents stolen access tokens from being used by a different client

#### Token revocation

- **Single-token revocation** via `POST /auth/revoke` per [RFC 7009](https://www.rfc-editor.org/rfc/rfc7009) (the token to revoke is supplied in the request body).
- **Bulk-per-participant revocation** via `POST /auth/revoke-all-for-participant` for account-compromise recovery (see §Bulk Revoke All For Participant (BL-070) below).
- **Propagation semantics:** access tokens are short-lived (15 min — see refresh token claims above) so access-token revocation is eventual; refresh-token revocation is immediate because every refresh checks `revoked_jtis` and `revoked_token_families` on the request path.
- **On participant removal from a session:** all that participant's tokens for that session scope are revoked. This is a scoped variant of single-token revocation; it does not trigger bulk family invalidation.

#### Bulk Revoke All For Participant (BL-070)

For account-compromise recovery, credential-reset flows, and admin termination-of-session per [OWASP ASVS 5.0 V7.4.5](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x16-V7-Session-Management.md), the control plane exposes an endpoint that invalidates **every** refresh-token family for a participant in a single atomic operation.

**Endpoint:** `POST /auth/revoke-all-for-participant`

**Authentication (one of):**

- Admin scope `admin:participants:revoke` (RBAC policy; applies to organization administrators acting on a user).
- The participant's own current access token **plus step-up reauth**. The step-up requires a fresh WebAuthn assertion or equivalent within the last 5 minutes to confirm possession of the authenticator. The step-up design is informed by the AAL2 reauthentication principles in [NIST SP 800-63B §4.2.3](https://pages.nist.gov/800-63-3/sp800-63b.html#aal2) (§4.2.3 establishes a 12-hour cadence baseline and a 30-minute inactivity threshold for AAL2); the 5-minute step-up for bulk revocation is a BL-070 tightening above that baseline, not a NIST mandate.

**Request body:**

```ts
{
  participantId: ParticipantId;
  reason: "account_compromise" | "password_reset" | "admin_action" | "self_service";
}
```

**Response:** `204 No Content` on success. No body.

**Side effects:**

1. All active refresh-token families for the participant are inserted into `revoked_token_families`.
2. All unexpired `jti` values across those families are inserted into `revoked_jtis` (bounded by the 7-day refresh-token TTL).
3. A `participant.tokens_revoked_all` event is emitted per [Spec-006](../specs/006-session-event-taxonomy-and-audit-log.md) (payload `base + {revokedAt, tokenCount}`).
4. No per-access-token invalidation is performed. Access tokens are bounded by their short TTL (see Token revocation above); bulk revocation targets refresh tokens and future issuance.

**Multi-region propagation:** The local region's Postgres commit triggers logical replication (publication/subscription) to peer regions. Aurora Global Database models sub-second cross-region replication for typical write rates. During a partition, the worst-case eventual-consistency window equals partition heal time for refresh tokens.

**Regulatory and control mapping:**

| Control | Source |
| --- | --- |
| Admin ability to terminate all active sessions for a user | [OWASP ASVS 5.0 V7.4.5](https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x16-V7-Session-Management.md) |
| AAL2 reauthentication cadence baseline (12-hour cadence / 30-min inactivity); 5-minute step-up for bulk revocation is a BL-070 tightening above this baseline | [NIST SP 800-63B §4.2.3](https://pages.nist.gov/800-63-3/sp800-63b.html#aal2) |
| Ability to restore availability and access to personal data in a timely manner after an incident | [GDPR Article 32(1)(c)](https://gdpr-info.eu/art-32-gdpr/) |

**IdP-API precedent** (surveyed 2026-04-19 — informs endpoint shape, not security posture):

| Vendor | Endpoint | Scope |
| --- | --- | --- |
| Auth0 | `DELETE /api/v2/users/{id}/refresh-tokens` | Bulk per user, admin-only ([docs](https://auth0.com/docs/api/management/v2/users-by-id/delete-refresh-tokens-for-user)) |
| Okta | `DELETE /api/v1/users/{uid}/sessions?oauthTokens=true` | Sessions + optional tokens ([docs](https://developer.okta.com/docs/api/openapi/okta-management/management/tag/User/#tag/User/operation/revokeUserSessions)) |
| Keycloak | `POST /admin/realms/{realm}/users/{id}/logout` | Revokes all sessions, admin-only ([docs](https://www.keycloak.org/docs-api/latest/rest-api/index.html#_logout)) |
| Amazon Cognito | `AdminUserGlobalSignOut` | Signs out all sessions for a user ([docs](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_AdminUserGlobalSignOut.html)) |

All four vendors treat bulk per-user revocation as a vendor extension beyond [RFC 7009](https://www.rfc-editor.org/rfc/rfc7009), which scopes formally only to per-token revocation. BL-070 follows this industry precedent.

### Relay Authentication And Encryption (Task 5.3)

Per [ADR-010](../decisions/010-paseto-webauthn-mls-auth.md), relay E2EE ships as two distinct layers: V1 uses a pairwise X25519 + XChaCha20-Poly1305 construction; V1.1+ introduces MLS (RFC 9420) via an audited implementation once the promotion gates in ADR-010 are met. The V1 subsection below is authoritative for the V1 product horizon and stands on its own.

#### V1 Relay Encryption: Pairwise X25519 + XChaCha20-Poly1305

**Cipher construction:**

| Component | Specification |
| --- | --- |
| Key agreement | X25519 ECDH via `@noble/curves` (audited: Cure53, Kudelski Security, Trail of Bits) |
| Handshake authentication | Long-term Ed25519 identity key signs the ephemeral X25519 public key |
| Key derivation | HKDF-SHA256 (RFC 5869) from the X25519 shared secret, 32-byte output |
| AEAD | XChaCha20-Poly1305 (Bernstein 2011) via `@noble/ciphers` (audited: Cure53), 24-byte random nonce, 16-byte authentication tag |
| Forward secrecy | Session-granularity: each session generates a fresh X25519 key pair per participant, zeroed at session end. Compromise of a long-term Ed25519 identity key does not reveal past session keys. |
| Post-compromise security | Not provided in V1. Session keys remain fixed for the session's lifetime. V1.1+ MLS introduces per-message ratcheting and post-compromise security. |
| Participant cap | ≤ 10 active participants per pairwise session to bound the N² per-message encryption cost |

**Session key establishment (per participant pair):**

1. At session start, each participant generates an ephemeral X25519 key pair
2. Each participant signs its ephemeral X25519 public key with its long-term Ed25519 identity key; the signature and both keys are bound into a `SessionKeyBundle` posted to the control plane
3. The control plane verifies each `SessionKeyBundle` signature against the participant's registered Ed25519 identity key before distribution
4. Each participant computes `shared = X25519(mySecret, peerPublic)` for every other participant, then derives `sessionKey = HKDF-SHA256(shared, salt=session_id, info="ai-sidekicks/v1/pairwise", length=32)`
5. On session end, ephemeral X25519 secret keys are zeroed in memory; the control plane discards the `SessionKeyBundle` entries

**Long-term Ed25519 identity key custody:**

- Desktop clients derive (or wrap) the long-term Ed25519 identity key from a WebAuthn/passkey PRF ceremony per [ADR-010](../decisions/010-paseto-webauthn-mls-auth.md); the key is reconstructed per session and never hits disk in plaintext.
- CLI clients store the long-term Ed25519 identity key at rest using the three-tier custody ladder defined in [ADR-021](../decisions/021-cli-identity-key-storage-custody.md): (1) OS-native keystore (libsecret / Keychain / DPAPI) gated by write-probe-read-delete verification, (2) `@noble/ciphers` XChaCha20-Poly1305 + `@noble/hashes` Argon2id file with OWASP 2026 parameters, (3) refuse to participate in shared-session E2EE. Silent backend substitution and silent key rotation are both explicitly prohibited — silent rotation would invalidate every prior `SessionKeyBundle` signature and drop the participant from all active shared sessions.

**Message encryption:**

- Sender: for each recipient, encrypt plaintext under that pair's `sessionKey` with a fresh 24-byte random nonce and associated data `recipient_id ‖ seq` (the per-sender monotonic sequence, carried in the clear and authenticated by the tag); the frame also carries `sender_ephemeral` — the sender's session ephemeral X25519 public key, the recipient's key-selection handle — so the relay sees `(sender_ephemeral, recipient_id, seq, nonce, ciphertext+tag)`
- Relay: never sees plaintext; forwards each per-recipient envelope as opaque ciphertext
- Recipient: resolves the pairwise key via `sender_ephemeral` (sender authenticity follows from which key verifies the tag), verifies associated data `recipient_id ‖ seq` and rejects any replay at or below the last accepted `seq` for that sender, decrypts, and delivers to local session state

**WebSocket authentication to relay:**

1. Client connects to relay via WSS
2. Client presents a PASETO v4.public connection token in the initial WebSocket handshake via two `Sec-WebSocket-Protocol` subprotocol values — `paseto-v4, <base64url(connectionToken)>` (value 1 `paseto-v4` names the scheme and is echoed by the relay as the negotiated subprotocol; value 2 carries the base64url-encoded token, since browsers cannot set custom WebSocket request headers — per Spec-008/Plan-008)
3. Relay validates token and establishes the session-scoped channel
4. All subsequent message payloads are encrypted under the pairwise session keys derived above — the relay sees only opaque ciphertext per-recipient envelopes

**Concrete API shape (`@noble/curves` v2.x, `@noble/ciphers` v2.x, `@noble/hashes` v2.x):**

```ts
import { x25519 } from "@noble/curves/ed25519.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/ciphers/utils.js";

const { secretKey, publicKey } = x25519.keygen(); // ephemeral per session
const shared = x25519.getSharedSecret(secretKey, peerPublic); // 32 bytes
const sessionKey = hkdf(sha256, shared, salt, info, 32); // RFC 5869
const nonce = randomBytes(24); // 192-bit
const aead = xchacha20poly1305(sessionKey, nonce, aad); // 16-byte auth tag
```

#### V1.1+ Relay Encryption: MLS (Planned Upgrade Path)

V1.1 introduces MLS (RFC 9420) via an audited implementation to provide per-message ratcheting, post-compromise security, and O(log N) group rekeying. The upgrade ships behind a feature flag and negotiates cipher suite at session start; the V1 pairwise layer continues to serve sessions whose participants have not yet adopted V1.1. MLS becomes the default relay cipher once all three promotion gates defined in [ADR-010 §Success Criteria — V1.1 MLS Promotion Gates](../decisions/010-paseto-webauthn-mls-auth.md#success-criteria) pass:

- External third-party security audit of the selected implementation
- Interoperability tests against at least one other MLS implementation at a pinned commit
- ≥ 4 weeks of production soak behind the feature flag with < 1% MLS-code-path session error rate

Candidate implementations under evaluation include OpenMLS (Rust, MIT) and mls-rs (Rust, Apache-2.0 or MIT, AWS Labs). The V1.1 cipher suite target is `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`. Full KeyPackage distribution, group-add/remove, and welcome-message flows will be specified in the V1.1 relay spec once implementation selection lands.

### Daemon Master Key Rotation

- **Event-driven, not periodic**. The daemon master key is rotated only on specific events: participant crypto-shred, participant credential change, or explicit administrative rotation. It is not rotated on a calendar schedule. NIST SP 800-38D's AEAD encryption-count ceiling does not bind because the master key performs O(participants) wrap operations rather than O(events).
- **Rotate-on-shred re-wraps all remaining participant keys**. When `DELETE /participants/{id}/data` fires, the daemon generates a fresh master `M'`, decrypts each remaining `participant_keys.encrypted_key_blob` with the old master `M`, re-encrypts with `M'`, and destroys `M`. This is the mechanism that prevents crypto-shred circumvention via backup restore: a pre-rotation backup contains the old wrapped master blob, which no remaining credential can unwrap after rotation.
- **Rotate-on-credential-change re-wraps the master only**. On WebAuthn credential re-enrollment or passphrase change, the inner `participant_keys` rows are untouched; only the outer master-key envelope is re-encrypted under the new KEK.
- **Rotation is atomic or it fails**. A partial rotation that re-wraps some `participant_keys` rows but not others must be rolled back. The daemon uses SQLite's write-ahead log and a single BEGIN EXCLUSIVE transaction for the row-level re-wrap; failure aborts the transaction and retains the old master.
- **Rotation cannot be disabled**. There is no configuration flag to suppress rotate-on-shred; it is a load-bearing invariant of the GDPR compliance posture documented in [Spec-022 §Daemon Master Key](../specs/022-data-retention-and-gdpr.md#daemon-master-key).

### Permission Matrix (Task 5.4)

| Action | `owner` | `collaborator` | `runtime contributor` | `viewer` |
| --- | --- | --- | --- | --- |
| **Session lifecycle** |  |  |  |  |
| Create session | Yes | No | No | No |
| Archive/close session | Yes | No | No | No |
| Configure session settings | Yes | No | No | No |
| **Membership** |  |  |  |  |
| Invite participants | Yes | No | No | No |
| Elevate member role | Yes | No | No | No |
| Suspend/revoke member | Yes | No | No | No |
| **Runtime nodes** |  |  |  |  |
| Attach own runtime node | Yes | Yes | Yes | No |
| Detach own runtime node | Yes | Yes | Yes | No |
| Detach another's runtime node | Yes | No | No | No |
| **Runs and messaging** |  |  |  |  |
| Send messages / create runs | Yes | Yes (with approval) | No | No |
| Queue work items | Yes | Yes | No | No |
| Steer/interrupt/cancel runs | Yes | Yes (own runs) | No | No |
| Take terminal control (release is holder-gated, role-independent — a holder stripped of authorization mid-hold, by demotion, suspension, or revocation, can still relinquish during the signal-propagation window, and the membership transition itself force-clears an active lease on arrival at the lease authority, per `Spec-003 §Required Behavior`) | Yes | Yes | No | No |
| Set/clear session goal | Yes | Yes | No | No |
| **Approvals** |  |  |  |  |
| Configure approval policies | Yes | No | No | No |
| Resolve approval requests | Yes | Yes (own scope) | No | No |
| **Artifacts and workspace** |  |  |  |  |
| Publish artifacts | Yes | Yes | No | No |
| Attach repositories | Yes | Yes | No | No |
| **Read access** |  |  |  |  |
| Read timeline | Yes | Yes | Yes (own node) | Yes |
| Read artifacts | Yes | Yes | Yes (own node) | Yes |
| Read presence | Yes | Yes | Yes | Yes |

**Actions requiring approval regardless of role:**

- `file_write` outside the bound workspace
- `network_access` unless the active policy explicitly allows it
- `destructive_git` operations (force push, branch delete)
- `mcp_elicitation` from MCP servers

**Unconditional actions (no approval needed):**

- Reading timeline, artifacts, presence (for roles with read access)
- Sending presence heartbeats
- Attaching own runtime node (for roles with attach permission)

### Per-Device Presence Detail Authorization

The **Read presence** row above governs the _aggregated_ presence summary — a single per-participant state (`online` / `idle` / `reconnecting` / `offline`) that every role with read access may read. The per-device breakdown behind that summary — `PresenceDetailRead` (`participant.presenceDetail`), returning each device's `{deviceId, state, lastSeen}` — is **owner/operator-only** (`Spec-018 §Interfaces And Contracts`, Plan-018 D-018-5 / I-018-6): it is granted to the session `owner` role and to the daemon operator (the machine-local authority hosting the session), and denied to `collaborator`, `runtime contributor`, and `viewer`.

**Rationale.** Per-device presence is privacy-sensitive fan-out: it reveals how many devices a participant runs, each device's individual activity, and its last-seen timestamp — a behavioral-tracking surface disproportionate to collaboration need. The aggregated summary conveys what a collaborator needs (is this participant present?) without the device-level exhaust, so the default projection stays aggregated and the device-level detail is gated. A denied `PresenceDetailRead` returns `presence.permission_denied` (Plan-018 CP-018-7; [Error Contracts](contracts/error-contracts.md)).

### Transport Security Requirements (Task 5.5)

| Transport | Protocol | Authentication | Encryption | Trust Boundary |
| --- | --- | --- | --- | --- |
| Local daemon (Unix socket) | Unix domain socket | Socket permissions (mode 0700) + 256-bit session token (required for Desktop Shell + CLI per §Local Daemon Authentication) | None needed (same-machine) | Highest trust — local execution authority |
| Local daemon (localhost TCP) | TCP on 127.0.0.1 | 256-bit session token required | None needed (loopback only) | High trust — token prevents cross-process access |
| Client to control plane | HTTPS | PASETO v4.public + DPoP | TLS 1.3 minimum, no TLS 1.2 fallback | Medium trust — authenticated but shared infrastructure |
| Client to relay | WSS | PASETO v4.public initial auth | V1: pairwise X25519 + XChaCha20-Poly1305 (relay sees only per-recipient ciphertext). V1.1+: MLS E2EE once promotion gates pass. | Low trust — relay is zero-knowledge |
| Node to node (via relay) | WSS via relay | Pairwise Ed25519-signed X25519 key bundle (V1); MLS group membership (V1.1+) | V1: pairwise X25519 + XChaCha20-Poly1305. V1.1+: MLS E2EE. | Low trust — all inter-node traffic is E2EE |

**Certificate requirements:**

- Control plane: Valid TLS certificate from a public CA. No self-signed certificates in production.
- Relay: Valid TLS certificate. Certificate pinning optional but recommended for the relay endpoint.
- Local daemon: No TLS needed (Unix socket or localhost-only TCP).

**Inter-node trust boundaries:**

- Session membership does NOT imply machine trust. A participant's runtime node cannot execute code on another participant's machine.
- Runtime node capability declaration is self-asserted. The approval policy engine governs what a node is actually allowed to do.
- Node-to-node communication is always relay-mediated and end-to-end encrypted. V1 uses the pairwise X25519 + XChaCha20-Poly1305 construction defined above; V1.1+ upgrades to MLS once the promotion gates in [ADR-010](../decisions/010-paseto-webauthn-mls-auth.md) pass. Direct node-to-node connections are not supported in V1.

---

## Audit Log Integrity

Local per-daemon event logs are tamper-evident. Each `session_events` row is chained to its predecessor via a BLAKE3 hash and carries a per-event Ed25519 signature from the emitting daemon. A Merkle root is computed over contiguous event ranges on a bounded cadence and anchored to the control plane as metadata only — the control plane never stores event payloads, keeping this design consistent with [ADR-017 Shared Event-Sourcing Scope](../decisions/017-shared-event-sourcing-scope.md).

### Hash Chain

Every `session_events` row carries two new columns:

- `prev_hash BLOB(32)`: the `row_hash` of the immediately preceding row in `(session_id, sequence)` order. For `sequence = 0` the value is 32 zero bytes.
- `row_hash BLOB(32)`: `BLAKE3( prev_hash || canonical_bytes(row) )`, where `canonical_bytes(row)` is the [RFC 8785 JSON Canonicalization Scheme (JCS)](https://datatracker.ietf.org/doc/html/rfc8785) serialization of the event envelope fields (`id`, `sessionId`, `sequence`, `occurredAt`, `category`, `type`, `actor`, `payload`, `correlationId`, `causationId`, `version`). `pii_payload` is **not** included in the canonical form. Events whose `pii_payload` column is non-NULL MUST embed a `pii_ciphertext_digest` field in `payload` (BLAKE3 over the ciphertext bytes of `pii_payload`); the digest is inside the canonical bytes and is never shredded, so [Spec-022](../specs/022-data-retention-and-gdpr.md) crypto-shredding of `pii_payload` does not break the chain.

BLAKE3 is the same digest used for `request_body_hash` in [Spec-024 Cross-Node Dispatch And Approval](../specs/024-cross-node-dispatch-and-approval.md). JCS is reused identically — two honest implementations producing divergent serializations would produce divergent chains, so a single canonicalization rule is mandatory.

References:

- [RFC 8785 — JSON Canonicalization Scheme (JCS)](https://datatracker.ietf.org/doc/html/rfc8785)
- [BLAKE3 specification](https://github.com/BLAKE3-team/BLAKE3-specs/blob/master/blake3.pdf)

### Per-Event Daemon Signature

Every row carries `daemon_signature BLOB(64)` — an Ed25519 signature (per [RFC 8032 §5.1](https://datatracker.ietf.org/doc/html/rfc8032#section-5.1)) over the **same** `canonical_bytes(row)` that feeds `row_hash`. Signing and hashing share one byte string so a verifier never has to re-canonicalize: it hashes and signature-verifies the identical input.

Signing key resolution:

- Each daemon holds a session-scoped Ed25519 signing keypair. The public key is registered in the **session participant roster** at join time, keyed by `NodeId`. Any audit reader — local replay, peer daemon verifying relayed events, forensic export — resolves the verification key by looking up `NodeId` in the roster snapshot for the anchored range. (The registration store is the control-plane [`daemon_signing_public_keys` table](schemas/shared-postgres-schema.md#daemon-signing-public-keys-plan-006--verification-key-roster) — written register-once by the post-attach `runtimenode.signingkeyregister` mutation and read through the `runtimenode.signingkeyroster` query, Plan-006 T4.10 per CP-006-7 leg B / CP-003-5. The table carries no participant FK, so it sits outside the [Spec-022 §Shred Fan-Out](../specs/022-data-retention-and-gdpr.md#shred-fan-out) Path-2 closure and the resolution surface SURVIVES participant erasure — load-bearing, since the crypto-shredded `runtime_node.*` stream and the `event_log_anchors` rows it verifies are retained. The daemon-local verifier checking rows it authored resolves its own `session_id`-keyed `daemon_signing_keys` store, the degenerate `NodeId` = self arm.)
- V1 ships **no daemon signing-key rotation ceremony** — none is specified in any governing document ([ADR-010](../decisions/010-paseto-webauthn-mls-auth.md) covers CLI-identity and session-auth custody, not daemon session signing keys) — so V1 enforces key stability end-to-end by refusal: the daemon-side key-reuse observer enforces `refuse_on_rotation` (Plan-006 T4.2), and `runtimenode.signingkeyregister` refuses a registration presenting a key that differs from the stored value for its `(session, node)` pair (T4.10) — register-once, never a silent overwrite. Rotation-with-validity-windows — superseded public keys remaining resolvable for the ranges they anchored, so historical rows stay verifiable across a rotation — is the V1.1+ extension a specified rotation ceremony would unlock. (Posture pinned 2026-07-29; this bullet previously attributed daemon-key rotation to ADR-010, which does not govern it.)

Sensitive events (approvals, policy changes, membership revocations) additionally carry `participant_signature BLOB(64)` — a second Ed25519 signature from the participant's own key. Desktop uses the WebAuthn PRF-derived key ([ADR-010](../decisions/010-paseto-webauthn-mls-auth.md)); CLI uses the at-rest identity key whose custody is specified by [ADR-021](../decisions/021-cli-identity-key-storage-custody.md). The column is `NULL` for events that do not require participant attestation.

References:

- [RFC 8032 — Edwards-Curve Digital Signature Algorithm (EdDSA), §5.1 Ed25519](https://datatracker.ietf.org/doc/html/rfc8032#section-5.1)

### Merkle Anchors (Control-Plane Witness)

Anchoring converts per-row tamper-evidence into tamper-evidence against an external timestamp without exposing event content. On the earlier of `ANCHOR_INTERVAL_EVENTS = 1000` events or `ANCHOR_INTERVAL_SECONDS = 300` seconds the emitting daemon:

1. Builds a binary Merkle tree over the `row_hash` values of the range `[last_anchored_sequence + 1, current_sequence]`, using BLAKE3 as the internal node-hash function (concatenated left‖right children).
2. Signs the Merkle root with its session-scoped Ed25519 key (same key used for `daemon_signature`).
3. Uploads `(session_id, node_id, start_sequence, end_sequence, merkle_root, root_signature, anchored_at)` to the control plane's `event_log_anchors` table. **Only anchor metadata is uploaded — event payloads stay on the emitting daemon**, preserving ADR-017's rejection of a shared event log.

Precedent: hash-chain plus periodic root anchor is the core transparency-log pattern specified in [RFC 9162 — Certificate Transparency v2](https://datatracker.ietf.org/doc/html/rfc9162). V1 applies the scoped-down local variant (no third-party auditors, no gossip protocol); RFC 9162's leaf-prefix is omitted because this is an internal log, not a CT log.

References:

- [RFC 9162 — Certificate Transparency v2](https://datatracker.ietf.org/doc/html/rfc9162)

### Verification Rules

A read-side verifier runs four checks, in order (the fourth applies only to compacted rows; rule 2 additionally carries two column-SHAPE preconditions — the all-placeholder refusal and the stored-`occurred_at` form check — the second of which runs on both retention classes, and TWO content-binding POSTconditions, the `pii_payload` digest check and the PII owner-stamp check, both of which necessarily run AFTER the Ed25519 verification rather than before it, and for the same reason: the value each compares against lives inside the bytes that verification authenticates). Any failure halts replay and emits `audit_integrity_failed` per [Spec-006 §Integrity Protocol](../specs/006-session-event-taxonomy-and-audit-log.md#integrity-protocol):

1. **Chain check.** For each row where `retention_class IS NULL` (un-compacted), recompute `BLAKE3(prev_hash || canonical_bytes(row))` and compare to the stored `row_hash`. Mismatch → `audit_integrity_failed { failureMode: 'hash_mismatch', failurePath: 'inclusion' }` per `Spec-006 §Audit Integrity (audit_integrity)` — EXCEPT for a row whose integrity columns ALL still hold Plan-001's zero-fill placeholders, which rule 2's placeholder precondition refuses ahead of this recomputation: such a row's `row_hash` is 32 zero bytes and so fails this compare too, and reporting it here would both make that precondition unreachable and mislabel a never-signed row as a chain break. For rows where `retention_class = 'audit_stub'`, the original canonical bytes have been discarded by compaction, so per-row chain recomputation against the original is impossible — those rows are instead verified by the anchor check (rule 3, original-existence) AND the stub-signature check (rule 4, stub-authenticity) per [Spec-006 §Post-Compaction Integrity](../specs/006-session-event-taxonomy-and-audit-log.md#post-compaction-integrity).
2. **Signature check.** For each `retention_class IS NULL` row, **the placeholder precondition is checked first**: if the row's integrity columns ALL still hold Plan-001's zero-fill placeholders — `prev_hash` and `row_hash` 32 zero bytes each, `daemon_signature` 64 zero bytes — then no signature was ever produced for that row and there is nothing to verify, so emit `audit_integrity_failed { failureMode: 'signature_placeholder', failurePath: 'signature' }` and stop, before any Ed25519 verification is attempted (and, per rule 1's carve-out, ahead of the chain recomputation a zero `row_hash` would otherwise fail first). The predicate requires all three columns: a genuine genesis row carries a zero `prev_hash` beside a REAL `row_hash` and a real signature, and the `row_hash` conjunct is what keeps it out. Such a row MUST NEVER be "repaired" by signing it with a current key — retro-signing an old record with a later key is a published attack that no conforming raw-Ed25519 verifier can detect after the fact, per [Spec-006 §Integrity Protocol](../specs/006-session-event-taxonomy-and-audit-log.md#integrity-protocol), which is normative for this precondition. The verdict is deliberately NOT folded into `signature_mismatch` because the operator response is the opposite: a mismatch is possible tampering and warrants security incident response, whereas a placeholder is an engineering sequencing bug and warrants a code fix — conflating them pages the wrong on-call. Otherwise verify `daemon_signature` against `canonical_bytes(row)` using the `NodeId`-resolved Ed25519 public key from the session participant roster. If `participant_signature` is present, verify it with the participant's public key. Failure → `audit_integrity_failed { failureMode: 'signature_mismatch', failurePath: 'signature' }`. For `retention_class = 'audit_stub'` rows, the ORIGINAL canonical bytes are gone — per-row signature verification against the original is skipped; original-range tamper-evidence comes from the Ed25519-signed Merkle root checked in rule 3, and post-compaction stub authenticity comes from the per-row `stub_signature` checked in rule 4. **Stored-`occurred_at` form check (same rule, BOTH retention classes).** A verified signature binds the canonical BYTES, and `canonicalizeEvent` normalizes exactly one canonical member — `occurredAt` — while passing every other through byte-for-byte. That single column is therefore committed as an INSTANT rather than as the bytes stored beside it, so an at-rest respelling into a different spelling of the same instant (`+00:00` or `-05:00` in place of `Z`, appended trailing zeros) re-canonicalizes identically and passes every check above, while the respelled row sorts out of position in this lexically-ordered TEXT column and drops out of the very date-range scans a verifier walks. Rule 2 therefore also asserts that the stored `occurred_at` IS the canonical spelling, via Plan-006 T2.1's exported `isCanonicalOccurredAt` — a pure, total, never-throwing predicate, the never-throwing part being load-bearing because a throw inside a range walk would abort it and silence audit of the entire remaining tail. Non-canonical → `audit_integrity_failed { failureMode: 'occurred_at_not_canonical', failurePath: 'signature' }`, `failurePath` naming the guarantee that failed — the signature binding the stored bytes — rather than the column the defect occupies. Like the placeholder precondition above it this is a column-SHAPE check rather than a second verification, which is why it lives inside rule 2 instead of becoming a fifth rule. It runs on `audit_stub` rows too and is NOT subsumed by rule 4's scalar binding: that check catches a respelling applied AFTER compaction, whereas one applied while the row was still live is copied verbatim into the projection per [Spec-006 §Compacted Event Format](../specs/006-session-event-taxonomy-and-audit-log.md#compacted-event-format), signed into the stub bytes, and byte-equal to its column forever — compaction launders the live-path defect into signed bytes, so rule 2's form check is the only thing that catches it in either state. **PII-ciphertext digest binding (same rule, POSTcondition, both retention classes).** `pii_payload` is excluded from the canonical form by design — that exclusion is what lets a Spec-022 crypto-shred leave the chain intact — and the column is bound instead by a `pii_ciphertext_digest` member carried INSIDE the signed payload, BLAKE3 over the ciphertext bytes per [Spec-006 §Canonical Serialization Rules](../specs/006-session-event-taxonomy-and-audit-log.md#canonical-serialization-rules). Signing that digest binds nothing on its own: until this rule existed the digest was minted, signed, and never recomputed, so substituting, truncating, or deleting `pii_payload` at rest left both the chain and the signature verifying green. Rule 2 therefore also asserts, for every row whose `pii_payload` is non-NULL, that `BLAKE3(pii_payload)` equals the digest in the just-verified payload, via Plan-006 T2.4's exported `isCiphertextDigestBound` — pure, total, and never-throwing for the same range-walk reason as the form check above, and additionally shape-guarding the column, since a `BLOB`-affinity read can hand back a `string` on which the hash primitive would throw. Divergence → `audit_integrity_failed { failureMode: 'pii_ciphertext_digest_unbound', failurePath: 'signature' }`, `failurePath` again naming the broken guarantee — the signature's commitment to the ciphertext — rather than the column. Unlike the two preconditions this one runs AFTER the Ed25519 check and is meaningless before it: an unverified payload's digest is not evidence of anything. Three states besides the ordinary compare are decided by the same predicate: a non-NULL column with NO digest violates the non-NULL MUST; a digest whose column has been emptied is the evidence-destruction case, where the signature still verifies over a commitment that outlived its subject; and neither present is a pass, covering both no-PII rows and compacted stubs, which [Spec-006 §Compacted Event Format](../specs/006-session-event-taxonomy-and-audit-log.md#compacted-event-format) NULLs and re-projects without a digest. There is deliberately NO crypto-shred carve-out: [Spec-022 §Shred Fan-Out](../specs/022-data-retention-and-gdpr.md#shred-fan-out) Path 1 destroys the per-participant key and overwrites no column, so a shredded row's retained ciphertext still hashes to its signed digest and passes unchanged. Were a future amendment to make Path 1 overwrite the column, it would have to amend this rule in the same change — that collision is intentional, and CP-006-12 registers it. **PII owner-stamp binding (same rule, POSTcondition).** The digest above binds WHICH bytes the row is holding; it says nothing about WHOSE data they are, and neither question implies the other — a row can hold exactly the sealed bytes its signature attests and still be attributed to the wrong participant. [Spec-006 §Canonical Serialization Rules](../specs/006-session-event-taxonomy-and-audit-log.md#canonical-serialization-rules) therefore also requires a `pii_participant_id` member INSIDE the signed `payload` on every row whose `pii_payload` is non-NULL, naming the participant whose content key sealed that ciphertext. It is not redundant with `actor`, which the same section keeps as a canonical member: `actor` names who EMITTED the row, the stamp names whose key SEALED it, and an agent-emitted or system-emitted row can still carry a participant's PII. Signing it also spends no confidentiality the canonical form does not already spend, since `actor` has carried participant identifiers since the schema shipped. The binding matters most exactly where the digest stops helping: after a [Spec-022 §Shred Fan-Out](../specs/022-data-retention-and-gdpr.md#shred-fan-out) Path 1 shred the per-participant key is destroyed, so no decrypt can ever re-attribute the retained ciphertext and the stamp is the SOLE surviving evidence of whose data the row held — a tampered stamp cannot stop that global key deletion, but it corrupts the SCOPE SELECTOR, falsifying the `affectedSessionIds[]` / `piiPayloadsCleared` an `event.shredded` event retains indefinitely as compliance evidence. Rule 2 therefore also asserts that the row's durable owner stamp equals the `pii_participant_id` carried in the just-verified payload, via Plan-006 T2.4's exported `isPiiOwnerStampBound` — pure, total, and never-throwing for the same range-walk reason as the checks above, and fail-closed on a shape it cannot compare, since a non-string, non-NULL column value is reported unbound rather than skipped (a verifier that cannot confirm the binding has not confirmed it). Divergence → `audit_integrity_failed { failureMode: 'pii_owner_stamp_unbound', failurePath: 'signature' }`, `failurePath` again naming the broken GUARANTEE — the signature's commitment to the row's PII owner — rather than the column the defect occupies. Four states are decided by the one predicate: stamp and claim both present → compare; both absent → bound, an ordinary no-PII row; a stamp with no claim → unbound, an owner nothing vouches for; a claim whose stamp is gone → unbound, the stamp cleared after signing. Like the digest binding this runs AFTER the Ed25519 check and is meaningless before it. **The stamp column does not exist yet:** Plan-006 T3.1's additive migration creates it, so until that lands the signed claim is the only copy of the stamp and this half of rule 2 has nothing to compare against. Its compacted-row disposition is SET rather than open, and set in two halves. The signed CLAIM always retires, because the stub projection carries no `pii_participant_id`. The durable COLUMN is cleared alongside `pii_payload`, the disposition [Spec-006 §Compacted Event Format](../specs/006-session-event-taxonomy-and-audit-log.md#compacted-event-format)'s 2026-07-27 amendment sets on its two stated grounds — the stamp and the ciphertext are halves of one PII partition, and the Path 1 selector scopes itself to rows whose `pii_payload` is non-NULL, so a destroyed ciphertext leaves the stamp with no consumer — pending T3.1, which creates the column and confirms the disposition by naming it in that section's removal list. Should T3.1 resolve otherwise and retain the stamp on compacted rows, this check reports every one of them unbound and its CALLER must scope it to `retention_class IS NULL`, never softening the state into a pass.
3. **Anchor check.** For each anchored range, recompute the Merkle root from locally stored `row_hash` values and compare to `event_log_anchors.merkle_root`; verify `root_signature` against the same `NodeId`-resolved key. Failure → `audit_integrity_failed { failureMode: 'anchor_mismatch', failurePath: 'consistency' }`. For ranges entirely composed of `retention_class = 'audit_stub'` rows the same Merkle-root + signature check applies (the stored `row_hash` was frozen pre-compaction by I-006-3-03 chain-commitment-frozen invariant). A **covering** anchor is one whose `[start_sequence, end_sequence]` spans the range under verification (`anchor.start_sequence ≤ range_start AND anchor.end_sequence ≥ range_end` — the same single-anchor coverage test the compactor applies in [Spec-006 §Post-Compaction Integrity](../specs/006-session-event-taxonomy-and-audit-log.md#post-compaction-integrity) step 1, NOT an exact-`start_sequence` match; a cadence anchor and a wider force-fire anchor may share a `start_sequence`). If a compacted range has no covering anchor, → `audit_integrity_failed { failureMode: 'anchor_missing_for_compacted_range' }`; if the covering anchor's signature fails to verify, → `audit_integrity_failed { failureMode: 'anchor_signature_invalid' }`. Additional `failureMode` values per `Spec-006 §Audit Integrity (audit_integrity)`: `inclusion_proof_failed`, `consistency_proof_failed`, `log_file_missing`, `log_file_moved` cover anchor-substrate failures beyond the core checks.
4. **Stub-signature check** (compacted rows only). For each `retention_class = 'audit_stub'` row, verify the stored `stub_signature` **directly over the canonical byte string stored in `payload`** (the exact bytes the compactor signed at compaction — not re-canonicalized, not reconstructed from the scalar columns) using the same `NodeId`-resolved Ed25519 public key. The anchor (rule 3) commits to the ORIGINAL pre-compaction `row_hash`, not to the post-compaction stub bytes, so without this check a local tamper of the visible stub (`summary`, `actor`, …) would pass rule 3 undetected. A `stub_signature` that fails to verify OR is absent on an `audit_stub` row → `audit_integrity_failed { failureMode: 'stub_signature_invalid', failurePath: 'signature' }` (the signature is REQUIRED on every compacted row; absence is a failure, never a skip). Because the canonical bytes bind `id` + `sequence`, a `stub_signature` cannot be replayed from another row, and a `retention_class` flip in either direction is caught (NULL→stub fails rules 3+4; stub→NULL fails rule 1's chain recomputation against the now-mismatched frozen `row_hash`). **Scalar-column binding (same rule, compacted rows).** The surviving scalar columns (`id`, `session_id`, `sequence`, `occurred_at`, `category`, `type`, `actor`) are a denormalized cache for SQL filters (`idx_session_events_type`) and envelope reconstruction; they are NOT covered by `stub_signature`, which signs only the `payload` projection bytes. So rule 4 additionally decodes the projection from the just-verified `payload` bytes and asserts each scalar column byte-equals its projection counterpart (`occurred_at` ↔ `occurredAt`, `session_id` ↔ `sessionId`, …) — a divergence (e.g. an at-rest edit of `actor`/`type` while `payload` is untouched, which would otherwise pass rules 3+4 yet forge a filter/reconstruction value) → `audit_integrity_failed { failureMode: 'stub_scalar_mismatch', failurePath: 'signature' }`. The signed `payload` projection is the authoritative source for a compacted row's envelope fields. For `occurred_at` specifically this binding is only half the story and the two halves are not interchangeable: it catches a respelling applied AFTER compaction, because the column then diverges from the signed projection, but a row respelled while still LIVE carries the bad spelling into the projection verbatim, so column and projection agree forever and this check passes — that case is rule 2's stored-form precondition, which is why that precondition runs on compacted rows too.

**Verifier roles.** The three checks above require access to the local event rows on the emitting daemon (or to a peer that has replicated those rows through the relay). A control-plane-only auditor — seeing only `event_log_anchors` metadata, never event payloads or stub bytes, consistent with [ADR-017](../decisions/017-shared-event-sourcing-scope.md) — cannot perform the chain check, the per-row signature check (including both of its column-shape preconditions AND both of its content-binding postconditions, which read columns it never sees — `pii_payload` least of all, since ADR-017 keeps PII ciphertext off the control plane entirely), or the stub-signature check (rule 4 needs the stub rows). Its available checks reduce to verifying each anchor's `root_signature` against `merkle_root` (using the `NodeId`-resolved Ed25519 key) and confirming anchor-sequence monotonicity per `(session_id, node_id)`. Post-compaction, a LOCAL verifier (holding the `audit_stub` rows) retains THREE tamper-evidence shapes — the range-level anchor (rule 3, original-existence), the per-row `stub_signature` (rule 4, stub-authenticity), and the stored-`occurred_at` form check (rule 2, stored-spelling binding) — whereas the control-plane-only auditor is limited to the anchor shape alone. THREE is the post-compaction count on purpose: a LIVE row carries a FOURTH and a FIFTH — rule 2's `pii_payload` digest binding and its PII owner-stamp binding — and compaction retires BOTH rather than preserving them, for related but distinct reasons worth separating. The digest retires because the stub projection NULLs `pii_payload` and carries no digest forward: after compaction there is no ciphertext left to bind. The owner stamp's signed CLAIM retires by a different route — per [Spec-006 §Compacted Event Format](../specs/006-session-event-taxonomy-and-audit-log.md#compacted-event-format) the stub projection REPLACES `payload` wholesale with a fixed field set carrying no PII members, so the claim is gone whatever becomes of the column — and that section's 2026-07-27 amendment SETS the other half, clearing the durable stamp alongside `pii_payload`, pending the Plan-006 T3.1 migration that creates the column and confirms the disposition by naming it in that section's removal list. THREE holds under that disposition and would hold without it, which is why the count above is stated flatly: cleared, the binding is simply gone; retained, the check reports every compacted row unbound, so its caller scopes it to `retention_class IS NULL` and it stays off the compacted path regardless. Both retirements are real coverage boundaries rather than oversights, and together they mean each PII binding's whole window is the row's uncompacted life — the same window the `occurred_at` binding was minted to cover. This is why the anchor-before-compaction protocol AND the per-row stub commitment per `Spec-006 §Post-Compaction Integrity` are BOTH load-bearing: the anchor is the only original-existence proof a remote auditor can check, and the `stub_signature` is the only per-row authenticity proof for the bytes that survive locally. The third shape covers what neither of those can — a timestamp respelled before compaction froze it, which the anchor and the stub signature both certify faithfully because it was already there when they were computed.

The `audit_integrity_failed` event is itself a `session_events` row and is therefore covered by the chain/signature/anchor protocol going forward — a tampered integrity failure cannot be silently appended after the fact.

### Schema Migration

- **Local SQLite** — the integrity protocol lands across two migration waves. (a) Plan-001 forward-declares the four integrity columns on `session_events` in the Tier-1 initial migration: `prev_hash BLOB(32) NOT NULL`, `row_hash BLOB(32) NOT NULL`, `daemon_signature BLOB(64) NOT NULL`, `participant_signature BLOB(64)` (NULL-able). (b) Plan-006 then ships its own ADDITIVE Tier-4 migrations for the post-compaction integrity protocol: `session_events.retention_class TEXT` (NULL-able — the `'audit_stub'` discriminator Verification Rules 1/2/4 branch on), `session_events.stub_signature BLOB(64)` (NULL-able — the per-row stub-authenticity signature Rule 4 verifies), the `daemon_signing_keys` table (the sealed-Ed25519 custody store whose public key resolves the Rule 2/3/4 signature checks), and the `pending_anchor_uploads` table (the local queue of Merkle-anchor uploads awaiting replication to the shared `event_log_anchors` table — partition tolerance for the Rule 3 anchor checks). An implementer must run the Plan-006 Tier-4 migrations — not only the Tier-1 forward-declared columns — before the post-compaction verifier can run — and note the Plan-006 Tier-4 migration set spans BOTH databases, since T4.10 adds a control-plane migration (next bullet). See [Local SQLite Schema](schemas/local-sqlite-schema.md) § Session Events.
- **Shared Postgres** — two new tables are added. `event_log_anchors` stores anchor metadata only (Merkle roots + signatures), never event payloads — see [Shared Postgres Schema](schemas/shared-postgres-schema.md) § Event Log Anchors. `daemon_signing_public_keys` (T4.10's control-plane migration, the 2026-07-29 CP-006-7 amendment) is the register-once daemon verification-key roster §Per-Event Daemon Signature resolves against — public key material only, deliberately no participant FK, so it sits outside the [Spec-022 §Shred Fan-Out](../specs/022-data-retention-and-gdpr.md#shred-fan-out) Path-2 erasure closure and anchors stay independently verifiable for the audit-retention lifetime — see [Shared Postgres Schema](schemas/shared-postgres-schema.md) § Daemon Signing Public Keys (Plan-006 — Verification-Key Roster).

---

## Related Domain Docs

- [Trust And Identity](../domain/trust-and-identity.md) — canonical domain model for identity-material provisioning, fingerprint verification, and the trust-state lifecycle that this architecture implements.
- [Participant And Membership Model](../domain/participant-and-membership-model.md)
- [Runtime Node Model](../domain/runtime-node-model.md)
- [Artifact Diff And Approval Model](../domain/artifact-diff-and-approval-model.md)

## Related Specs

- [Invite Membership And Presence](../specs/002-invite-membership-and-presence.md)
- [Control Plane Relay And Session Join](../specs/008-control-plane-relay-and-session-join.md)
- [Approvals Permissions And Trust Boundaries](../specs/012-approvals-permissions-and-trust-boundaries.md)

## Related ADRs

- [Collaboration Trust And Permission Model](../decisions/007-collaboration-trust-and-permission-model.md)
- [Default Transports And Relay Boundaries](../decisions/008-default-transports-and-relay-boundaries.md)
- [PASETO WebAuthn MLS Auth](../decisions/010-paseto-webauthn-mls-auth.md)
- [Cedar Approval Policy Engine](../decisions/012-cedar-approval-policy-engine.md)
