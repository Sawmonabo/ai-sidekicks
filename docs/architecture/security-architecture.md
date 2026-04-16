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
| `Identity And Session Authorization` | Authenticates users and authorizes membership in sessions. Auth methods are deployed incrementally: Device Auth Grant (RFC 8628) + password/TOTP at CLI launch, WebAuthn/Passkeys added at desktop launch, with WebAuthn becoming the recommended default for desktop users. Tokens: PASETO v4 — access tokens (v4.public, 15 min), refresh tokens (v4.local, 7 days, rotated on use). OAuth 2.1 with PKCE mandatory. DPoP sender-constraining for access tokens. |
| `Membership Policy Engine` | Determines session roles and participant capabilities. |
| `Runtime Capability Registry` | Tracks what each runtime node can expose and under what trust envelope. |
| `Approval Policy Engine` | Evaluates and records approval requests and resolutions. |
| `Transport Security Layer` | Protects local IPC, client-daemon, and relay/control-plane traffic. Local daemon: socket reachability + optional 256-bit session token (mode 0600, rotated per restart). Control plane: HTTPS/TLS. Relay: MLS (RFC 9420) group E2EE via `ts-mls` — forward secrecy, post-compromise security, zero-knowledge relay. KeyPackages distributed via control plane with Ed25519 signature verification to prevent MITM substitution. Fallback: X25519 + XChaCha20-Poly1305 via `@noble/curves` + `@noble/ciphers` if MLS libraries prove immature. |
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

**MLS (RFC 9420) group encryption:**

| Component | Specification |
| --- | --- |
| Protocol | MLS RFC 9420 via `ts-mls` or equivalent WASM-portable implementation |
| Cipher suite | MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519 |
| Forward secrecy | Yes — tree-based key ratcheting ensures past messages are undecryptable after key update |
| Post-compromise security | Yes — compromised member can be removed and group re-keyed |

**KeyPackage format and distribution:**
1. Each participant generates an Ed25519 signing key pair and an X25519 encryption key pair
2. KeyPackage bundles: `{protocol_version, cipher_suite, init_key (X25519), credential (Ed25519 public key), signature}`
3. KeyPackages are uploaded to the control plane and signed with the participant's Ed25519 key
4. When joining a group, the control plane distributes KeyPackages to existing members
5. **MITM prevention:** KeyPackages are verified against the participant's known Ed25519 public key (bound to their identity via the control plane). Any KeyPackage with an unknown signing key is rejected.

**WebSocket authentication to relay:**
1. Client connects to relay via WSS
2. Client presents a PASETO v4.public token in the initial WebSocket handshake (`Sec-WebSocket-Protocol: paseto-v4`)
3. Relay validates token and establishes the session-scoped channel
4. All subsequent messages are MLS-encrypted — the relay sees only opaque ciphertext

**Fallback path (if MLS libraries prove immature):**
- Pairwise X25519 ECDH key agreement via `@noble/curves`
- XChaCha20-Poly1305 symmetric encryption via `@noble/ciphers`
- No forward secrecy (accepted trade-off for fallback only)
- Upgrade path: replace fallback with MLS when library stability is confirmed

### Permission Matrix (Task 5.4)

| Action | Owner | Collaborator | Runtime Contributor | Viewer |
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
| Client to relay | WSS | PASETO v4.public initial auth | MLS E2EE (relay sees only ciphertext) | Low trust — relay is zero-knowledge |
| Node to node (via relay) | WSS via relay | MLS group membership | MLS E2EE | Low trust — all inter-node traffic is E2EE |

**Certificate requirements:**
- Control plane: Valid TLS certificate from a public CA. No self-signed certificates in production.
- Relay: Valid TLS certificate. Certificate pinning optional but recommended for the relay endpoint.
- Local daemon: No TLS needed (Unix socket or localhost-only TCP).

**Inter-node trust boundaries:**
- Session membership does NOT imply machine trust. A participant's runtime node cannot execute code on another participant's machine.
- Runtime node capability declaration is self-asserted. The approval policy engine governs what a node is actually allowed to do.
- Node-to-node communication is always relay-mediated and MLS-encrypted. Direct node-to-node connections are not supported in V1.

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
