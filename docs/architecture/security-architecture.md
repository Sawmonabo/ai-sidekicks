# Security Architecture

## Purpose

Define the system's trust boundaries, permission layers, and transport security posture.

## Scope

This document covers identity, session ownership, device and node trust, approvals, capability grants, and transport boundaries.

## Context

The product combines one account, several of that account's devices, one or more runtime nodes, and local code execution. Security depends on not collapsing those concerns into one flat trust model: authenticating the account says nothing about which device is acting, and neither says a machine may execute.

## Responsibilities

- authenticate the user and authorize access to their own sessions
- distinguish device trust from runtime-node trust
- govern tool, file, network, and execution permissions
- protect remote transport and relay paths
- preserve auditable approval and grant history

## Component Boundaries

| Component | Responsibility |
| --- | --- |
| `Identity And Session Authorization` | Authenticates the user and authorizes access to sessions they own. A machine signs in to the hosted account with the Device Authorization Grant (RFC 8628) through `sidekicks sign-in`. Passkeys (WebAuthn) are used only in a browser and the phone apps: on the device-code page, to approve a machine's sign-in and to make a new account's first passkey, and in the web client and the phone apps, to sign in and to link a device with no other device at hand; the desktop app carries no WebAuthn. Tokens: PASETO v4 — access tokens (`v4.public`, 15 min, never stored) presented with a DPoP proof; a refresh token bound to the machine's DPoP key, kept as its own item in the machine's credential store, spent and replaced at each trade, lasting until sign-out or revocation. |
| `Approval Policy Engine` | Evaluates and records approval requests and resolutions. A provider's ask gets its designed answer from plain code in the service: it refuses `claude agents`, `claude daemon` and `--bg` and keeps Claude Code's own switch that turns them off pinned, allows an agent's own memory `.md` file, and answers for Codex where Codex has no command of its own. The app's own tools use Cedar (CNCF sandbox) with principal-action-resource-context model: their built-in rules are `.cedar` files in the service's own source, compiled into the service with it and changed only by an app update, like any other code, and evaluated in-process by the resident `@cedar-policy/cedar-wasm` authorizer ([ADR-012](../decisions/012-cedar-approval-policy-engine.md)). |
| `Device And Machine Trust` | The account's append-only statement chain (`device.linked`, `device.renamed`, `device.revoked`, `passkey.added`, `passkey.removed`, `runtimenode.added`, `runtimenode.renamed`, `runtimenode.removed`), which every machine verifies itself to decide which device and machine keys it trusts, and each machine's registration (id, owning user, public key, name, platform, version). |
| `Transport Security Layer` | Protects local IPC, client-daemon, and relay/control-plane traffic. Local daemon: socket reachability plus a required 256-bit session token (mode 0600, rotated per restart) presented by the desktop app's main process or the CLI — see §Local Daemon Authentication for the model. Control plane: HTTPS/TLS. Relay: one end-to-end channel per device and machine on the Noise Protocol Framework's `Noise_KK_25519_ChaChaPoly_SHA256`, with a fresh handshake on every connection and every 10 minutes, the relay seeing ids, the profile, sizes and times and nothing else (see §Relay Authentication And Encryption and [ADR-010](../decisions/010-tokens-passkeys-and-the-remote-channel.md)). |
| `Audit Layer` | Records grants, denials, escalations, and revocations. |

## Data Flow

1. Identity claims enter through the control plane.
2. A connection carries its device, and a write records the device it came from; nothing checks ownership per caller.
3. A device reaches a machine only over a channel whose keys that machine finds trusted in the account's statement chain.
4. Runs request tool, file, or network permissions when needed.
5. Approval decisions are recorded and propagated back into the run engine.

## Trust Boundaries

- Owning a session does not imply local machine trust.
- Reaching a machine over the channel does not bypass approval policy.
- The relay path must be treated as less trusted than direct local transport.
- The local daemon remains the enforcement point for local execution permissions.

## Failure Modes

- A linked device is over-trusted and gains unintended execution capability.
- Approval rules outlive their intended scope and create hidden privilege drift.
- Transport authentication succeeds while local authorization policy is misapplied.
- Relay or remote-path compromise exposes data that should have remained end-to-end protected.

---

## Authentication Implementation Specification

### Local Daemon Authentication

The local daemon uses a layered trust model based on socket reachability **plus** a 256-bit session token. The desktop **renderer is not a direct daemon client** — all renderer-originated requests are brokered by the desktop app's main process via the preload bridge and arrive at the daemon as main-process traffic. See [Spec-021 §Trust Stance](../specs/021-desktop-app-and-renderer.md#trust-stance) and [container-architecture.md §Trust Boundaries](./container-architecture.md#trust-boundaries) for the renderer-untrusted stance this section follows.

**Socket reachability model:**

| Client Type | Auth Required | Rationale |
| --- | --- | --- |
| Main process of the desktop app (same machine) | Socket access + 256-bit session token | The main process is the daemon client for the desktop app; holds the daemon session token and no control-plane credential, since the service holds the machine's DPoP key and tokens and makes every control-plane call, per [Spec-021 §Trust Stance](../specs/021-desktop-app-and-renderer.md#trust-stance); forwards renderer-originated requests over its own connection, which presented the token, with response payloads sanitized. |
| CLI (same machine) | Socket access + 256-bit session token | Same-user process; socket permissions (mode 0700 on macOS and Linux, a user-only access list on the Windows pipe) prevent cross-user access; token is defense-in-depth against misconfigured socket permissions. |
| External process (same machine) | 256-bit session token (required) | Untrusted processes on the same machine must present a token. |
| Desktop renderer (same machine) | Not a daemon client | All renderer-originated requests flow through the preload bridge to the main process, which forwards them to the daemon over its own token-presenting connection. The renderer never holds the daemon session token, PASETO access tokens, or the DPoP key per [Spec-021 §Trust Stance](../specs/021-desktop-app-and-renderer.md#trust-stance). |
| Another of the person's devices | Not a daemon-socket client | It reaches the daemon only over its end-to-end channel through the relay (§Relay Authentication And Encryption). The service binds no TCP port for its clients. |

**Session token specification:**

- **Generation:** CSPRNG (Node.js `crypto.randomBytes(32)`) producing a 256-bit token
- **Storage:** Written with owner-only access: on macOS and Linux `$XDG_RUNTIME_DIR/ai-sidekicks/daemon.token` where the session sets `XDG_RUNTIME_DIR` (a Linux login session does), and otherwise `<temporary folder>/ai-sidekicks-<uid>/daemon.token`, the temporary folder being `os.tmpdir()` (always the case on macOS, which never sets it, where that is the per-user `$TMPDIR`), each with mode `0600` in a folder of mode `0700` beside `daemon.sock`; on Windows `%LOCALAPPDATA%\ai-sidekicks\run\daemon.token` with an access list that grants the person alone. On a Windows computer whose service runs in a WSL 2 distribution, the daemon keeps its Linux copy in its run folder and hands the value to its Windows half, which writes the Windows file; a daemon running natively on Windows writes the same file itself, so Windows has one location for both sides.
- **Rotation:** Regenerated on every daemon restart. Previous tokens are immediately invalidated.
- **Verification:** Constant-time comparison (`crypto.timingSafeEqual`, after a length check) to prevent timing attacks
- **Transport:** The first message on every connection: `daemon.hello` carries it as `sessionToken`. A hello without it or with a wrong one is refused with `auth.token_invalid`, and nothing more is served on that connection

**Token presentation requirements:**

- **Always required** for the main process and the CLI. Both read the token file at every connect, never once at their own startup, because the daemon makes a new token at every restart, and present it. Socket permissions are defense-in-depth; the token is primary. The renderer is not a direct daemon client, and CLI presentation of the token is not optional.
- **Required** for any external integration or tool connecting to the daemon socket.
- **Not applicable** to the desktop renderer, which is not a direct daemon client per [Spec-021 §Trust Stance](../specs/021-desktop-app-and-renderer.md#trust-stance).
- **On Windows the daemon's socket is a named pipe**, `\\.\pipe\ai-sidekicks-<user SID>`, one per person on both kinds of Windows computer. Where Claude Code and Codex live in WSL 2, the service is the daemon in that distribution plus its Windows half, one service per computer, started by a per-user logon task through one attached `wsl.exe`. The pipe has the same name for a native daemon and one inside WSL 2, served on both by the service's Windows half: a native daemon starts the same binary as its own child (`--daemon-child`) to serve it, so there is one pipe implementation. The server grants the person's SID alone, refuses remote clients, fails closed when the name is already held, and closes any client that is not the person; the client opens the pipe at identification level and checks that the pipe's owner is the person before it writes a byte. The daemon still demands the token as the first message.

### Control-Plane Authentication

**PASETO v4 access tokens (v4.public):**

```
Header: v4.public
Payload: {
  sub: UserId,          // user UUID
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
  sub: UserId,
  iss: "ai-sidekicks-cp",
  iat: <unix_timestamp>,
  jti: <unique_token_id>,
  cnf: { jkt: <JWK_thumbprint> }, // the machine's DPoP key
  family: <rotation_family_id> // tracks rotation chain for reuse detection
}
Encrypted with: PASETO v4.local (XChaCha20 stream + BLAKE2b-MAC, encrypt-then-MAC; **not** XChaCha20-Poly1305 AEAD) under the control plane's symmetric key — per [ADR-010 §PASETO v4 Implementation Library](../decisions/010-tokens-passkeys-and-the-remote-channel.md#paseto-v4-implementation-library). No `exp`: the token lasts until sign-out or revocation, and each trade spends it.
```

**Refresh token rotation:**

1. Client presents refresh token to `/auth/token` endpoint
2. Control plane validates token and reads its `family`: a live `refresh_token_families` row goes on to the trade, a `revoked_token_families` row refuses it, and a family with neither row is refused
3. Control plane issues new access token + new refresh token (new `jti`, same `family`)
4. The family's row records the new `jti` as its current one; any other `jti` of that family is spent. The trade is one compare-and-swap, `UPDATE refresh_token_families SET current_jti = <new> WHERE family_id = <presented family> AND current_jti = <presented jti>`: one row updated is a good trade, so two trades racing with one token settle to one
5. If a used `jti` is presented again (reuse detection), the entire `family` is revoked — all tokens in the rotation chain are invalidated. This detects token theft.

Each live sign-in has one row in `refresh_token_families` (`family_id`, `user_id` referencing `users` with `ON DELETE CASCADE`, `cnf_jkt`, `current_jti`, `issued_at`, `last_traded_at`), so the table holds one row per signed-in machine and nothing grows per trade. Every revocation ends the family the same way, in one transaction: the family's `refresh_token_families` row is deleted and its `revoked_token_families` row is written. That covers reuse (a swap that updates no row while the family's row exists), sign-out, a device revoked through the statement chain, and `account.delete`, where the live row also goes by `ON DELETE CASCADE`.

**Sign-in and the service's own credential:**

- `sidekicks sign-in` runs the Device Authorization Grant (RFC 8628): the CLI prints a code and an address, opens the address in the browser where one exists, and waits until the grant is approved. The device-code page, where the person approves the code, accepts the account's passkey and verifies the person with it before it approves the code, so a computer the person has never used signs in without any machine of theirs. With no account yet, its `Create an account` asks for `Name` once, makes the account's first passkey and approves the code for the new account. That registration needs no sign-in, because it makes a new account and adds nothing to one that exists: it is bound to the device-code transaction the page was opened with, good once, and limited per source address under the same `auth.endpoint` row as the passkey sign-in. Adding a passkey to an account that exists stays signed in. Sign-in runs with the service stopped, and the CLI writes what it receives to the credential store through the service's own custody code.
- The control plane issues a refresh token bound to the machine's DPoP key (`cnf.jkt`), kept as its own item in the machine's credential store, or, where that store cannot be used (Linux with no Secret Service; a Mac from its approved logged-out service's takeover until `sidekicks daemon uninstall`, even after that service is turned off in Login Items & Extensions), in the service's one file readable by this account alone ([ADR-020 §The Credential Store](../decisions/020-cli-identity-key-storage-custody.md#the-credential-store)). Every control-plane call the service makes on its own authenticates with an access token it gets by trading that refresh token; each trade returns a new refresh token and spends the old one, and the access token is never stored. Those calls are the machine's registration and its certificate challenge (`runtimenode.register`, `runtimenode.certificateChallengeSet`) and `push.send`.
- A spent refresh token presented again revokes its whole family (step 5 above). The service's next trade then fails, and `sidekicks daemon status` prints `Hosted account: signed out · a reused sign-in was detected; sign in again`. Sign-out revokes the family: its `refresh_token_families` row is deleted and its `revoked_token_families` row written in one transaction.
- **WebAuthn/Passkeys:** used only in a browser and the phone apps: on the device-code page, to approve a machine's sign-in and to make a new account's first passkey, and in the web client and the phone apps, to sign in and to link a device with no other device at hand. The desktop app carries no WebAuthn, and no key is derived from a passkey.

**DPoP sender-constraining:**

- The client holds a DPoP key pair; the machine's is its own credential-store item like every daemon secret, and its private half never leaves the daemon
- The access token accompanying the proof is presented as `Authorization: DPoP <token>` per [RFC 9449 §7.1](https://www.rfc-editor.org/rfc/rfc9449#section-7.1) — **never `Bearer`**, which a conforming resource server rejects for a DPoP-bound token and a lax one accepts while silently dropping proof-of-possession enforcement. The daemon session token, presented as `sessionToken` in `daemon.hello` above, is a different credential on a different transport
- Each API request includes a `DPoP` header containing a signed proof: `{jti, htm, htu, iat, ath}` signed by the client's private key — `ath` is the SHA-256 hash of the presented access token, required by [RFC 9449 §4.3](https://www.rfc-editor.org/rfc/rfc9449#section-4.3) when a proof accompanies an access-token presentation
- The control plane verifies the DPoP proof's signature matches the `cnf.jkt` thumbprint in the access token
- Prevents stolen access tokens from being used by a different client

#### Token revocation

- **Single-token revocation** via `POST /auth/revoke` per [RFC 7009](https://www.rfc-editor.org/rfc/rfc7009) (the token to revoke is supplied in the request body).
- **Propagation semantics:** access tokens are short-lived (15 min) so access-token revocation is eventual; refresh-token revocation is immediate because every trade checks `revoked_jtis` and `revoked_token_families` on the request path.
- **How long a revocation is kept:** a refresh token has no fixed lifetime, so a revoked family never expires on its own. Its `revoked_token_families` row, written in the same transaction that deletes the family's live `refresh_token_families` row (at reuse, sign-out, a device's revocation or `account.delete`), stays for the account's life and goes with `account.delete`; a `revoked_jtis` entry is reaped a margin past the access token's lifetime, once the access token it blocks has expired anyway.
- **On device revocation:** a device is revoked one at a time, from the Devices page or `sidekicks devices`, as a `device.revoked` statement signed by any trusted key. When the statement reaches the control plane, it revokes that device's refresh-token family and every unexpired `jti` in it — in one transaction the family's `refresh_token_families` row is deleted and its `revoked_token_families` row written — so the device is signed out everywhere and cannot link again. Every device and passkey it linked or added before stays trusted, flagged on its card or row as linked or added from a device the person revoked. The hosted account itself is deleted one way only, by `sidekicks delete-account` over the control plane's `account.delete`, run from a signed-in machine. A person who has lost every machine installs the command-line tool on another computer, runs `sidekicks sign-in`, confirms it with a passkey on the device-code page, and runs `sidekicks delete-account`. The SQL in the [Hosted Account Deletion Runbook](../operations/hosted-account-deletion-runbook.md) is a break-glass procedure for the relay's owner, used only when the authenticated path is genuinely impossible (for example, the owner has no passkey left to verify a sign-in); it is never a second way to delete an account.

### Relay Authentication And Encryption

Per [ADR-010](../decisions/010-tokens-passkeys-and-the-remote-channel.md), every channel joins one device and one machine through the person's own relay and carries every session and screen on that machine. [Spec-027 §The encryption envelope](../specs/027-remote-control.md#the-encryption-envelope) is the full design; this section is its security summary.

**Keys and trust:**

| Key | Where it lives | What it does |
| --- | --- | --- |
| Machine identity key | Ed25519, minted at the service's first start, kept as its own item in the machine's credential store, or in the service's one file where that store cannot be used ([ADR-020](../decisions/020-cli-identity-key-storage-custody.md)); never leaves the machine | Signs the machine's statements; every device pins it |
| Device identity key | P-256 in the iPhone's Secure Enclave or the Android Keystore; a non-extractable WebCrypto key in the web client; never exported | Signs the device's statements |
| Channel key | X25519, one per device and per machine; the machine's its own credential-store item, or in the service's one file where that store cannot be used, the phones' in the Keychain and the Android Keystore's wrapped storage, the web client's a non-extractable WebCrypto key | The static key of the Noise handshake; certified by its identity key in the statement that trusts it |

Every public key carries its algorithm tag (`p256` or `ed25519`). Trust is the account's append-only statement chain, which every machine verifies itself: a key is trusted only when a path of `runtimenode.added`, `device.linked` and `passkey.added` statements reaches it from the machine's own key, each signed while its signer was still trusted at that point in the chain. A `device.revoked`, `runtimenode.removed` or `passkey.removed` ends the key it names at that point: a statement that key signs afterward is refused, and what it signed before stands, so every device, machine and passkey it added stays trusted, and what a revoked device added is flagged on its card or row. An ended key is never trusted again. Every channel open exchanges the chain head, so a withheld revoke is caught at the next honest connection. A device refuses a machine that answers under a known id with a different key and no later `runtimenode.added` for that id behind it; a removed machine that is linked again first mints a new identity key under its same machine id, and its new `runtimenode.added` moves every device's pin for that id.

**The channel:**

| Component | Specification |
| --- | --- |
| Protocol | The Noise Protocol Framework's `Noise_KK_25519_ChaChaPoly_SHA256` handshake and transport; no construction of the product's own |
| Authentication | Both static keys are known from the statement chain (`KK`); a handshake from a key the chain does not hold fails with nothing to click past |
| Forward secrecy | A fresh handshake on every connection and every 10 minutes on a long one, with the old keys erased |
| Profile | The connection's first frame offers the channel version and the profiles the device runs; the machine answers with one it runs or closes the connection (`channel.no_common_profile`); offer and answer are bound into the handshake's prologue. One profile, no fallback |
| Post-quantum | Not provided: traffic recorded today could be opened by a future large quantum computer. The hybrid profile joins through the same negotiation once its specification is reviewed |
| What the relay sees | The device id and machine id at connection, the channel version and the profile, frame sizes and times; never a method, a name or a byte of a session |

**Events a device originates:** no device signs the events it sends. The channel's handshake proves the device, and the machine records the connection's device on each event that device originates; an approval, question or plan resolution carries the answering device's id. A revoked device's channel is closed, so nothing new reaches the machine from it ([Plan-025](../plans/025-remote-control.md)).

**Access to the relay:**

1. A device or machine negotiates relay access with the control plane and receives a relay endpoint and a short-lived connect token bound to that device and that machine, never to a session; a token replayed for another device or machine, or an expired one, is refused.
2. The client connects over WSS and presents the connect token in the initial WebSocket handshake via two `Sec-WebSocket-Protocol` subprotocol values — `paseto-v4, <base64url(connectionToken)>` (value 1 names the scheme and is echoed by the relay as the negotiated subprotocol; value 2 carries the base64url-encoded token, since browsers cannot set custom WebSocket request headers).
3. The relay forwards the channel's frames and inspects none of them. It holds at most one live connection per device key and one per machine key; a new connection under a key closes the one before it, and the key is flagged.
4. The relay forwards each device's frames as fast as the machine drains them; backpressure on the channel bounds both directions.

### Permission Matrix

A session has exactly one owner and no other people, so the matrix is not a grid of roles: every row below is something the session's owner may do from any of their linked devices, and every linked device can do everything the desktop can. A write records the device it came from; nothing checks ownership per caller.

| Action | Rule |
| --- | --- |
| **Session lifecycle** |  |
| Create, archive/close, and configure a session | Owner, from any linked device |
| **Devices** |  |
| Link a device, list linked devices, revoke a device | Owner, from any linked device |
| **Machines** |  |
| Rename or remove one of the account's machines, and read the account's machines | Owner, from any linked device |
| **Runs and messaging** |  |
| Send messages / create runs, queue work items, set/clear the session goal | Owner |
| Start workflow runs (an agent's start and each run a trigger fires are adjudicated per start under the named Cedar operation action `Action::"workflow::start"` — never an approval category; the person's own starts — the desktop app, the `/workflow` verbs, the CLI and any linked device — pass no policy check; an agent's start is a tool call under its chat's level, so a chat that asks first asks before it starts one; every adjudicated start carries a daemon-resolved principal, the one user, never a client-supplied field, and one whose principal does not resolve is refused — [ADR-025](../decisions/025-chat-invoked-workflow-start.md)) | Owner |
| Steer/interrupt, the faster-model retry, undo (`session.restore`), pause/resume runs, and compact a bound run's provider context (authorized by session write access, never by run authorship — "own" never scopes this row, so a run started from one device is steerable from any other. User-triggered context compaction shares this row's adjudication rather than minting a Cedar action of its own, per [Spec-004 §User-triggered context compaction](../specs/004-provider-driver-contract-and-capabilities.md#user-triggered-context-compaction) — a compaction target is always a binding this daemon holds) | Owner |
| Take a shell's control lease (one device holds a given shell at a time; there is no release — a lease ends when another device takes it, when a forced take moves it, or when the last of the holding device's connections that took it ends, and a revoked device's channel is closed, which ends its leases, per [Spec-002 §Required Behavior](../specs/002-machine-registration.md#required-behavior)) | Owner, one holding device per shell |
| **Approvals** |  |
| Configure approval policies, resolve approval requests | Owner |
| **Artifacts and workspace** |  |
| Publish artifacts, attach repositories | Owner |
| Delete a session's artifacts: only with the session itself — `Delete old data` (`daemon.retentionPurge`) of an archived or closed session, or `Erase all data`; no person or method deletes a single artifact | Owner |
| **Read access** |  |
| Read the transcript, artifacts, and device presence | Owner |

**Actions that ask at the asking levels:** at the session's permission levels that ask, these ask before they run unless an approval rule answers them; at Sandboxed and at YOLO nothing asks, as the person chose ([Spec-010 §Default Behavior](../specs/010-approvals-permissions-and-trust-boundaries.md#default-behavior)):

- `file_write` outside the bound workspace
- `network_access` unless the active policy explicitly allows it
- `destructive_git` operations (force push, branch delete)

**Unconditional actions (no approval needed):**

- Reading the transcript, artifacts, and device presence
- Sending device presence heartbeats
- Registering the machine the service runs on

### Per-Device Presence Detail Authorization

The **Read the transcript, artifacts, and device presence** row above also governs the Devices page's reads: `device.list`, which returns each machine, device and passkey with its connected state and last-seen time, and a machine's `presence.read` and `presence.subscribe`, which report the devices connected to it and whether an app window is in front on each. They are authorized as the transcript is: the owner, from any of their devices.

**Rationale.** Under Remote Control the device list is the product, not an exhaust: a person deciding whether to steer from their phone has to see which of their machines is reachable, and a person revoking a lost device has to find it. There is no second person for it to leak to — every entry belongs to the caller's own account — so no separate gate stands in front of it.

### Transport Security Requirements

| Transport | Protocol | Authentication | Encryption | Trust Boundary |
| --- | --- | --- | --- | --- |
| Local daemon (Unix socket) | Unix domain socket | Socket permissions (mode 0700) + 256-bit session token (required for the main process and the CLI per §Local Daemon Authentication) | None needed (same-machine) | Highest trust — local execution authority |
| Local daemon (Windows named pipe) | Per-user named pipe, served by the service's Windows half on a native and a WSL 2 daemon alike | Pipe access list granting the person alone, remote clients refused, the client's owner check + 256-bit session token | None needed (same-machine) | Highest trust — local execution authority |
| Client to control plane | HTTPS | PASETO v4.public + DPoP | TLS 1.3 minimum, no TLS 1.2 fallback | Medium trust — authenticated, reached over the public internet |
| Device to machine (via the relay) | WSS to the relay | Connect token bound to the device and the machine; inside it, the Noise `KK` handshake over keys the statement chain trusts | `Noise_KK_25519_ChaChaPoly_SHA256`, rekeyed on every connection and every 10 minutes | Low trust — the relay sees ids, the profile, sizes and times only |

**Certificate requirements:**

- Control plane: Valid TLS certificate from a public CA. No self-signed certificates in production.
- Relay: a relay whose certificate chains to a root the operating system trusts is checked by the platform's certificate validation and its host name; only a relay without a publicly trusted certificate has its key pinned when it is linked, and a changed key is refused (`relay.pin_refused`) until `sidekicks relay repin --force` accepts it. The machine-key pin inside the channel holds on either relay.
- Local daemon: No TLS needed (Unix socket or the Windows named pipe).

**Machine boundaries:**

- Owning a session does NOT imply machine trust. A session runs only on the machine it was started on, and no machine executes anything for another.
- Every channel is relay-mediated and end-to-end encrypted. There is no direct connection between a device and a machine, and none between machines.

---

## Related Domain Docs

- [Trust And Identity](../domain/trust-and-identity.md) — canonical domain model for identity-material provisioning, fingerprint verification, and the trust-state lifecycle that this architecture implements.
- [User And Device Model](../domain/user-and-device-model.md)
- [Runtime Node Model](../domain/runtime-node-model.md)
- [Artifact Diff And Approval Model](../domain/artifact-diff-and-approval-model.md)

## Related Specs

- [Approvals Permissions And Trust Boundaries](../specs/010-approvals-permissions-and-trust-boundaries.md)

## Related ADRs

- [Device Trust and Permission Model](../decisions/007-device-trust-and-permission-model.md)
- [Default Transports And Relay Boundaries](../decisions/008-default-transports-and-relay-boundaries.md)
- [Tokens, Passkeys And The Remote Channel](../decisions/010-tokens-passkeys-and-the-remote-channel.md)
- [Cedar Approval Policy Engine](../decisions/012-cedar-approval-policy-engine.md)
