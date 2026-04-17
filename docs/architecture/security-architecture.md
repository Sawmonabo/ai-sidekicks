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
| `Approval Policy Engine` | Evaluates and records approval requests and resolutions. Uses Cedar (CNCF sandbox) with principal-action-resource-context model: V1 compiles YAML policy definitions to Cedar policy sets at build time; V1.1 evaluates Cedar WASM in-process for runtime policy updates without redeployment. |
| `Transport Security Layer` | Protects local IPC, client-daemon, and relay/control-plane traffic. Local daemon: socket reachability + optional 256-bit session token (mode 0600, rotated per restart). Control plane: HTTPS/TLS. Relay (V1): pairwise X25519 ECDH + XChaCha20-Poly1305 via audited `@noble/curves` and `@noble/ciphers` with ephemeral per-session X25519 keys authenticated by long-term Ed25519 identity keys — session-granularity forward secrecy, zero-knowledge relay (see §Relay Authentication And Encryption and [ADR-010](../decisions/010-paseto-webauthn-mls-auth.md)). Relay (V1.1+ upgrade path): MLS (RFC 9420) via an audited implementation once the promotion gates in ADR-010 pass, adding per-message ratcheting and post-compromise security. |
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

## Failure Modes

- An invited participant is over-trusted and gains unintended execution capability.
- Remembered approvals outlive their intended scope and create hidden privilege drift.
- Transport authentication succeeds while local authorization policy is misapplied.
- Relay or remote-path compromise exposes data that should have remained end-to-end protected.

---

## Authentication Implementation Specification

### Local Daemon Authentication (Task 5.1)

The local daemon uses a layered trust model based on socket reachability.

**Socket reachability model:**

| Client Type | Auth Required | Rationale |
| --- | --- | --- |
| Desktop renderer (same machine) | Socket access only | Process isolation is sufficient; the renderer is a trusted local process |
| CLI (same machine) | Socket access only | Same-user process; socket permissions (mode 0700) prevent cross-user access |
| External process (same machine) | 256-bit session token | Untrusted processes on the same machine must present a token |
| Remote client | Not supported in V1 | Remote daemon access is out of scope; all remote communication goes through the control plane |

**Session token specification:**
- **Generation:** CSPRNG (Node.js `crypto.randomBytes(32)`) producing a 256-bit token
- **Storage:** Written to `$XDG_RUNTIME_DIR/ai-sidekicks/daemon.token` with mode `0600` (owner read/write only)
- **Rotation:** Regenerated on every daemon restart. Previous tokens are immediately invalidated.
- **Verification:** Constant-time comparison (`crypto.timingSafeEqual`) to prevent timing attacks
- **Transport:** Passed in the `Authorization: Bearer <token>` header for HTTP, or as the first message in the IPC handshake for Unix domain sockets

**When token is required vs optional:**
- **Required:** When the connecting process is not the desktop renderer or CLI launched by the same user (i.e., any external integration or tool)
- **Optional:** When socket permissions alone provide sufficient isolation (desktop renderer, CLI). The daemon accepts connections without a token if the socket's file permissions restrict access to the owning user.

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
Encrypted with: XChaCha20-Poly1305 (control plane's symmetric key)
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

**Token revocation:**
- Explicit revocation via `POST /auth/revoke` with the token to revoke
- Revocation propagation: access tokens are short-lived (15 min) so revocation is eventual. Refresh token revocation is immediate (checked on every refresh).
- On participant removal from a session: all that participant's tokens for that session scope are revoked.

### Relay Authentication And Encryption (Task 5.3)

Per [ADR-010](../decisions/010-paseto-webauthn-mls-auth.md), relay E2EE ships as two distinct layers: V1 uses a pairwise X25519 + XChaCha20-Poly1305 construction; V1.1+ introduces MLS (RFC 9420) via an audited implementation once the promotion gates in ADR-010 are met. The V1 subsection below is authoritative for the V1 product horizon and stands on its own.

#### V1 Relay Encryption: Pairwise X25519 + XChaCha20-Poly1305

**Cipher construction:**

| Component | Specification |
| --- | --- |
| Key agreement | X25519 ECDH via `@noble/curves` (audited: Cure53, Kudelski Security) |
| Handshake authentication | Long-term Ed25519 identity key signs the ephemeral X25519 public key |
| Key derivation | HKDF-SHA256 (RFC 5869) from the X25519 shared secret, 32-byte output |
| AEAD | XChaCha20-Poly1305 (Bernstein 2011) via `@noble/ciphers` (audited), 24-byte random nonce, 16-byte authentication tag |
| Forward secrecy | Session-granularity: each session generates a fresh X25519 key pair per participant, zeroed at session end. Compromise of a long-term Ed25519 identity key does not reveal past session keys. |
| Post-compromise security | Not provided in V1. Session keys remain fixed for the session's lifetime. V1.1+ MLS introduces per-message ratcheting and post-compromise security. |
| Participant cap | ≤ 10 active participants per pairwise session to bound the N² per-message encryption cost |

**Session key establishment (per participant pair):**
1. At session start, each participant generates an ephemeral X25519 key pair
2. Each participant signs its ephemeral X25519 public key with its long-term Ed25519 identity key; the signature and both keys are bound into a `SessionKeyBundle` posted to the control plane
3. The control plane verifies each `SessionKeyBundle` signature against the participant's registered Ed25519 identity key before distribution
4. Each participant computes `shared = X25519(mySecret, peerPublic)` for every other participant, then derives `sessionKey = HKDF-SHA256(shared, salt=session_id, info="ai-sidekicks/v1/pairwise", length=32)`
5. On session end, ephemeral X25519 secret keys are zeroed in memory; the control plane discards the `SessionKeyBundle` entries

**Message encryption:**
- Sender: for each recipient, encrypt plaintext under that pair's `sessionKey` with a fresh 24-byte random nonce and the recipient's principal identifier as AEAD associated data; relay sees `(recipient_id, nonce, ciphertext+tag)`
- Relay: never sees plaintext; forwards each per-recipient envelope as opaque ciphertext
- Recipient: verifies associated data, decrypts, and delivers to local session state

**WebSocket authentication to relay:**
1. Client connects to relay via WSS
2. Client presents a PASETO v4.public token in the initial WebSocket handshake (`Sec-WebSocket-Protocol: paseto-v4`)
3. Relay validates token and establishes the session-scoped channel
4. All subsequent message payloads are encrypted under the pairwise session keys derived above — the relay sees only opaque ciphertext per-recipient envelopes

**Concrete API shape (`@noble/curves` v2.x, `@noble/ciphers` v2.x, `@noble/hashes` v2.x):**

```ts
import { x25519 } from '@noble/curves/ed25519.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/ciphers/utils.js';

const { secretKey, publicKey } = x25519.keygen();            // ephemeral per session
const shared     = x25519.getSharedSecret(secretKey, peerPublic); // 32 bytes
const sessionKey = hkdf(sha256, shared, salt, info, 32);    // RFC 5869
const nonce      = randomBytes(24);                          // 192-bit
const aead       = xchacha20poly1305(sessionKey, nonce, aad);// 16-byte auth tag
```

#### V1.1+ Relay Encryption: MLS (Planned Upgrade Path)

V1.1 introduces MLS (RFC 9420) via an audited implementation to provide per-message ratcheting, post-compromise security, and O(log N) group rekeying. The upgrade ships behind a feature flag and negotiates cipher suite at session start; the V1 pairwise layer continues to serve sessions whose participants have not yet adopted V1.1. MLS becomes the default relay cipher once all three promotion gates defined in [ADR-010 §Success Criteria — V1.1 MLS Promotion Gates](../decisions/010-paseto-webauthn-mls-auth.md) pass:

- External third-party security audit of the selected implementation
- Interoperability tests against at least one other MLS implementation at a pinned commit
- ≥ 4 weeks of production soak behind the feature flag with < 1% MLS-code-path session error rate

Candidate implementations under evaluation include OpenMLS (Rust, MIT) and mls-rs (Rust, Apache-2.0, AWS Labs). The V1.1 cipher suite target is `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`. Full KeyPackage distribution, group-add/remove, and welcome-message flows will be specified in the V1.1 relay spec once implementation selection lands.

### Permission Matrix (Task 5.4)

| Action | `owner` | `collaborator` | `runtime contributor` | `viewer` |
| --- | --- | --- | --- | --- |
| **Session lifecycle** | | | | |
| Create session | Yes | No | No | No |
| Archive/close session | Yes | No | No | No |
| Configure session settings | Yes | No | No | No |
| **Membership** | | | | |
| Invite participants | Yes | No | No | No |
| Elevate member role | Yes | No | No | No |
| Suspend/revoke member | Yes | No | No | No |
| **Runtime nodes** | | | | |
| Attach own runtime node | Yes | Yes | Yes | No |
| Detach own runtime node | Yes | Yes | Yes | No |
| Detach another's runtime node | Yes | No | No | No |
| **Runs and messaging** | | | | |
| Send messages / create runs | Yes | Yes (with approval) | No | No |
| Queue work items | Yes | Yes | No | No |
| Steer/interrupt/cancel runs | Yes | Yes (own runs) | No | No |
| **Approvals** | | | | |
| Configure approval policies | Yes | No | No | No |
| Resolve approval requests | Yes | Yes (own scope) | No | No |
| **Artifacts and workspace** | | | | |
| Publish artifacts | Yes | Yes | No | No |
| Attach repositories | Yes | Yes | No | No |
| **Read access** | | | | |
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

### Transport Security Requirements (Task 5.5)

| Transport | Protocol | Authentication | Encryption | Trust Boundary |
| --- | --- | --- | --- | --- |
| Local daemon (Unix socket) | Unix domain socket | Socket permissions (mode 0700) + optional 256-bit token | None needed (same-machine) | Highest trust — local execution authority |
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

## Related Domain Docs

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
