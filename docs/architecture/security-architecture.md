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
| `Identity And Session Authorization` | Authenticates the user and authorizes access to sessions they own. A machine signs in to the hosted account with the Device Authorization Grant (RFC 8628) through `sidekicks sign-in`. Passkeys (WebAuthn) are used only in a browser and the phone apps: on the device-code page, to approve a machine's sign-in, and in the web client and the phone apps, to sign in and to link a device with no other device at hand; the desktop app carries no WebAuthn. Tokens: PASETO v4 — access tokens (`v4.public`, 15 min, never stored) presented with a DPoP proof; a refresh token bound to the machine's DPoP key, sealed under the master key, spent and replaced at each trade, lasting until sign-out or revocation. |
| `Approval Policy Engine` | Evaluates and records approval requests and resolutions. Uses Cedar (CNCF sandbox) with principal-action-resource-context model: policies are written in YAML, compiled to Cedar at the release build and shipped in one signed bundle form. The set built into the service is the first bundle, and a later bundle arrives on the update feed, so an approval rule is fixed without a service update. Every bundle passes the same verifier and is evaluated in-process by the resident `@cedar-policy/cedar-wasm` authorizer. Policy chain of custody (signing, verification, operator key lifecycle) is governed by [ADR-012 §Policy Chain of Custody](../decisions/012-cedar-approval-policy-engine.md#policy-chain-of-custody); operational procedures are in [Cedar Policy Signing And Rotation](../operations/cedar-policy-signing-and-rotation.md). |
| `Device And Machine Trust` | The account's append-only statement chain (`device.linked`, `device.renamed`, `device.revoked`, `passkey.added`, `passkey.removed`, `runtimenode.added`, `runtimenode.renamed`, `runtimenode.removed`, `runtimenode.key_rotated`), which every machine verifies itself to decide which device and machine keys it trusts, and each machine's registration (id, owning user, public key, name, platform, version). |
| `Transport Security Layer` | Protects local IPC, client-daemon, and relay/control-plane traffic. Local daemon: socket reachability plus a required 256-bit session token (mode 0600, rotated per restart) presented by the desktop app's main process or the CLI — see §Local Daemon Authentication for the model. Control plane: HTTPS/TLS. Relay: one end-to-end channel per device and machine on the Noise Protocol Framework's `Noise_KK_25519_ChaChaPoly_SHA256`, with a fresh handshake on every connection and every 10 minutes, the relay seeing ids, the profile, sizes and times and nothing else (see §Relay Authentication And Encryption and [ADR-010](../decisions/010-tokens-passkeys-and-the-remote-channel.md)). |
| `Audit Layer` | Records grants, denials, escalations, and revocations. |

## Data Flow

1. Identity claims enter through the control plane.
2. Session ownership determines whether the caller reaches the session at all.
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
- Remembered approvals outlive their intended scope and create hidden privilege drift.
- Transport authentication succeeds while local authorization policy is misapplied.
- Relay or remote-path compromise exposes data that should have remained end-to-end protected.

---

## Authentication Implementation Specification

### Local Daemon Authentication

The local daemon uses a layered trust model based on socket reachability **plus** a 256-bit session token. The desktop **renderer is not a direct daemon client** — all renderer-originated requests are brokered by the desktop app's main process via the preload bridge and arrive at the daemon as main-process traffic. See [Spec-021 §Trust Stance](../specs/021-desktop-app-and-renderer.md#trust-stance) and [container-architecture.md §Trust Boundaries](./container-architecture.md#trust-boundaries) for the canonical renderer-untrusted stance this section aligns with.

**Socket reachability model:**

| Client Type | Auth Required | Rationale |
| --- | --- | --- |
| Main process of the desktop app (same machine) | Socket access + 256-bit session token | The main process is the daemon client for the desktop app; holds the daemon session token and no control-plane credential, since the service holds the machine's DPoP key and tokens and makes every control-plane call, per [Spec-021 §Trust Stance](../specs/021-desktop-app-and-renderer.md#trust-stance); forwards renderer-originated requests with auth headers attached and response payloads sanitized. |
| CLI (same machine) | Socket access + 256-bit session token | Same-user process; socket permissions (mode 0700 on macOS and Linux, a user-only access list on the Windows pipe) prevent cross-user access; token is defense-in-depth against misconfigured socket permissions. |
| External process (same machine) | 256-bit session token (required) | Untrusted processes on the same machine must present a token. |
| Desktop renderer (same machine) | Not a daemon client | All renderer-originated requests flow through the preload bridge to the main process, which forwards them to the daemon with attached auth headers. The renderer never holds the daemon session token, PASETO access tokens, or the DPoP key per [Spec-021 §Trust Stance](../specs/021-desktop-app-and-renderer.md#trust-stance). |
| Another of the person's devices | Not a daemon-socket client | It reaches the daemon only over its end-to-end channel through the relay (§Relay Authentication And Encryption). The service binds no TCP port for its clients. |

**Session token specification:**

- **Generation:** CSPRNG (Node.js `crypto.randomBytes(32)`) producing a 256-bit token
- **Storage:** Written with owner-only access, one location per platform: on macOS and Linux `$XDG_RUNTIME_DIR/ai-sidekicks/daemon.token` with mode `0600`; on Windows `%LOCALAPPDATA%\ai-sidekicks\run\daemon.token` with an access list that grants the person alone. On a Windows computer whose service runs in a WSL 2 distribution, the daemon keeps its Linux copy in its run folder and hands the value to its Windows half, which writes the Windows file; a daemon running natively on Windows writes the same file itself, so Windows has one location for both sides.
- **Rotation:** Regenerated on every daemon restart. Previous tokens are immediately invalidated.
- **Verification:** Constant-time comparison (`crypto.timingSafeEqual`) to prevent timing attacks
- **Transport:** Passed in the `Authorization: Bearer <token>` header for HTTP, or as the first message in the IPC handshake for Unix domain sockets

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

- `sidekicks sign-in` runs the Device Authorization Grant (RFC 8628): the CLI prints a code and an address, opens the address in the browser where one exists, and waits until the grant is approved. The device-code page, where the person approves the code, accepts the account's passkey and verifies the person with it before it approves the code, so a computer the person has never used signs in without any machine of theirs. Sign-in runs with the service stopped, and the CLI seals what it receives through the service's own custody code.
- The control plane issues a refresh token bound to the machine's DPoP key (`cnf.jkt`), sealed under the daemon master key in the daemon's database as the `daemon_secrets` row for its purpose. Every control-plane call the service makes on its own authenticates with an access token it gets by trading that refresh token; each trade returns a new refresh token and spends the old one, and the access token is never stored. Those calls are the machine's registration and its certificate challenge (`runtimenode.register`, `runtimenode.certificateChallengeSet`), the signing-key registration and roster read (`runtimenode.signingkeyregister`, `runtimenode.signingkeyroster`), the audit anchor upload, and `push.send`.
- A spent refresh token presented again revokes its whole family (step 5 above). The service's next trade then fails, and `sidekicks daemon status` prints `Hosted account: signed out · a reused sign-in was detected; sign in again`. Sign-out revokes the family: its `refresh_token_families` row is deleted and its `revoked_token_families` row written in one transaction.
- **WebAuthn/Passkeys:** used only in a browser and the phone apps: on the device-code page, to approve a machine's sign-in, and in the web client and the phone apps, to sign in and to link a device with no other device at hand. The desktop app carries no WebAuthn, and no key is derived from a passkey.

**DPoP sender-constraining:**

- The client holds a DPoP key pair; the machine's is sealed under the daemon master key like every daemon private key, and its private half never leaves the daemon
- The access token accompanying the proof is presented as `Authorization: DPoP <token>` per [RFC 9449 §7.1](https://www.rfc-editor.org/rfc/rfc9449#section-7.1) — **never `Bearer`**, which a conforming resource server rejects for a DPoP-bound token and a lax one accepts while silently dropping proof-of-possession enforcement. This is the canonical statement of the scheme; the daemon session token's `Authorization: Bearer` above is a different credential on a different transport
- Each API request includes a `DPoP` header containing a signed proof: `{jti, htm, htu, iat, ath}` signed by the client's private key — `ath` is the SHA-256 hash of the presented access token, required by [RFC 9449 §4.3](https://www.rfc-editor.org/rfc/rfc9449#section-4.3) when a proof accompanies an access-token presentation
- The control plane verifies the DPoP proof's signature matches the `cnf.jkt` thumbprint in the access token
- Prevents stolen access tokens from being used by a different client

#### Token revocation

- **Single-token revocation** via `POST /auth/revoke` per [RFC 7009](https://www.rfc-editor.org/rfc/rfc7009) (the token to revoke is supplied in the request body).
- **Propagation semantics:** access tokens are short-lived (15 min) so access-token revocation is eventual; refresh-token revocation is immediate because every trade checks `revoked_jtis` and `revoked_token_families` on the request path.
- **How long a revocation is kept:** a refresh token has no fixed lifetime, so a revoked family never expires on its own. Its `revoked_token_families` row, written in the same transaction that deletes the family's live `refresh_token_families` row (at reuse, sign-out, a device's revocation or `account.delete`), stays for the account's life and goes with `account.delete`; a `revoked_jtis` entry is reaped a margin past the access token's lifetime, once the access token it blocks has expired anyway.
- **On device revocation:** a device is revoked one at a time, from the Devices page or `sidekicks devices`, as a `device.revoked` statement signed by any trusted key. When the statement reaches the control plane, it revokes that device's refresh-token family and every unexpired `jti` in it — in one transaction the family's `refresh_token_families` row is deleted and its `revoked_token_families` row written — so the device is signed out everywhere and cannot link again. Every device and passkey it linked or added before stays trusted, flagged on its card or row as linked or added from a device the person revoked. The hosted account itself is deleted one way only, by `sidekicks delete-account` over the control plane's `account.delete`, run from a signed-in machine. A person who has lost every machine installs the command-line tool on another computer, runs `sidekicks sign-in`, confirms it with a passkey on the device-code page, and runs `sidekicks delete-account`. The SQL in the [Hosted Account Deletion Runbook](../operations/hosted-account-deletion-runbook.md) is an operator break-glass procedure, used only when the authenticated path is genuinely impossible (for example, the owner has no passkey left to verify a sign-in); it is never a second way to delete an account.

### Relay Authentication And Encryption

Per [ADR-010](../decisions/010-tokens-passkeys-and-the-remote-channel.md), every channel joins one device and one machine through the person's own relay and carries every session and screen on that machine. [Spec-028 §The encryption envelope](../specs/028-remote-control.md#the-encryption-envelope) is the full design; this section is its security summary.

**Keys and trust:**

| Key | Where it lives | What it does |
| --- | --- | --- |
| Machine identity key | Ed25519, minted at the service's first start, sealed under the daemon master key ([ADR-021](../decisions/021-cli-identity-key-storage-custody.md)); never leaves the machine | Signs the machine's statements; every device pins it |
| Device identity key | P-256 in the iPhone's Secure Enclave or the Android Keystore; a non-extractable WebCrypto key in the web client; never exported | Signs the device's statements and the events it originates |
| Channel key | X25519, one per device and per machine; the machine's sealed under the master key, the phones' in the Keychain and the Android Keystore's wrapped storage, the web client's a non-extractable WebCrypto key | The static key of the Noise handshake; certified by its identity key in the statement that trusts it |

Every public key carries its algorithm tag (`p256` or `ed25519`). Trust is the account's append-only statement chain, which every machine verifies itself: a key is trusted only when a path of `runtimenode.added`, `device.linked`, `passkey.added` and `runtimenode.key_rotated` statements reaches it from the machine's own key, each signed while its signer was still trusted at that point in the chain. A `device.revoked`, `runtimenode.removed`, `passkey.removed` or `runtimenode.key_rotated` ends the key it names at that point: a statement that key signs afterward is refused, and what it signed before stands, so every device, machine and passkey it added stays trusted, and what a revoked device added is flagged on its card or row. An ended key is never trusted again. Every channel open exchanges the chain head, so a withheld revoke is caught at the next honest connection. A device refuses a machine that answers under a known id with a different key and no `runtimenode.key_rotated` statement (signed by the old key and the new one) or later `runtimenode.added` for that id behind it; a removed machine that is linked again first mints a new identity key under its same machine id, and its new `runtimenode.added` moves every device's pin for that id.

**The channel:**

| Component | Specification |
| --- | --- |
| Protocol | The Noise Protocol Framework's `Noise_KK_25519_ChaChaPoly_SHA256` handshake and transport; no construction of the product's own |
| Authentication | Both static keys are known from the statement chain (`KK`); a handshake from a key the chain does not hold fails with nothing to click past |
| Forward secrecy | A fresh handshake on every connection and every 10 minutes on a long one, with the old keys erased |
| Profile | The connection's first frame offers the channel version and the profiles the device runs; the machine answers with one it runs or closes the connection (`channel.no_common_profile`); offer and answer are bound into the handshake's prologue. One profile today, no fallback |
| Post-quantum | Not provided: traffic recorded today could be opened by a future large quantum computer. The hybrid profile joins through the same negotiation once its specification is reviewed |
| What the relay sees | The device id and machine id at connection, the channel version and the profile, frame sizes and times; never a method, a name or a byte of a session |

**Access to the relay:**

1. A device or machine negotiates relay access with the control plane and receives a relay endpoint and a short-lived connect token bound to that device and that machine, never to a session; a token replayed for another device or machine, or an expired one, is refused.
2. The client connects over WSS and presents the connect token in the initial WebSocket handshake via two `Sec-WebSocket-Protocol` subprotocol values — `paseto-v4, <base64url(connectionToken)>` (value 1 names the scheme and is echoed by the relay as the negotiated subprotocol; value 2 carries the base64url-encoded token, since browsers cannot set custom WebSocket request headers).
3. The relay forwards the channel's frames and inspects none of them. It holds at most one live connection per device key and one per machine key; a new connection under a key closes the one before it, and two connections that keep displacing each other, three times within a minute, are refused for a minute and the key is flagged.
4. Each device carries a quota of 6,000 device-sent frames a minute with no byte figure; frames the machine sends, and bytes either way, are bounded by the channel's per-connection backpressure.

### Daemon Master Key Rotation

- **Explicit, never event-triggered**. The daemon master key is rotated only by `sidekicks rotate-keys` (`daemon.keyRotate`). There is no calendar rotation and no rotation on a session's end, a purge or an erasure: a purge deletes the session's own content key, `Erase all data` destroys the master key, and a rotation erases no data.
- **Every sealed blob names its key**. Each placement of the master key in custody has a key id, 16 random bytes written as 32 lowercase hex characters. The `master_keys` table records each id with its state (`active`, `incoming`, `outgoing` or `retired`: at most one row in each of the first three, and one `retired` row for each older key a backup still names) and its creation time; outside a rotation exactly one row is `active`. Custody entries carry the id: the keychain entry's account is `master-key.<key id>`, and the passphrase file is `daemon-master.<key id>.enc`. Every blob sealed under the master key — each `session_content_keys` wrap and each sealed daemon private key — begins with a header of one format byte and the 16-byte key id, bound into its associated data, so a blob cannot be relabeled to another key, and a reader opens each blob with the key its header names. A write wraps under the key `master_keys` names `active`, and its transaction confirms that key is still `active` before it commits, so no row is ever committed under a retired key or one that exists only in memory.
- **The six steps**. A rotation (1) creates the new key and its key id in locked memory; (2) writes the new key's custody entry, named by its key id, on the highest custody tier that works, and its recovery envelope and iCloud Keychain item where those are on, and verifies the entry by reading it back through that tier and comparing it with the key in memory; (3) inserts the new key's `master_keys` row as `incoming` beside the `active` old key; (4) re-wraps every `session_content_keys` row and re-seals every daemon private key under the new key, each header naming the new key id, each content key's `key_version` rising by one and its `rotated_at` stamped; (5) in the same `BEGIN EXCLUSIVE` transaction as step 4, marks the new key `active` and the old one `outgoing`, then commits; and (6) confirms that no blob's header names the outgoing key id, re-wrapping any that does, then marks the old key `retired` and deletes its recovery envelope, its custody entries and `master_keys` row staying until the last backup sealed with it ages out; a retired key that no backup names is deleted at once. Nothing is wrapped under the new key until its custody entry is written and verified and the store records it.
- **An interrupted rotation resumes or rolls back at start**, by the table in [Spec-020 §Daemon Master Key](../specs/020-data-retention-and-gdpr.md#daemon-master-key): a custody entry whose key id has no `master_keys` row is deleted; an `incoming` key whose entry opens is carried through steps 4 to 6, and one whose entry is missing or does not open is removed with the old key still active; an `outgoing` key is carried through step 6. Every step is idempotent, and a service whose custody is locked at start applies the table once custody opens.
- **What else a rotation does**. It also mints a new identity key and new per-session signing keys; rows signed before keep verifying under the retired signing keys, and the `runtimenode.key_rotated` statement ends the old identity key: a statement it signs afterward is refused, what it signed before stands, and it is never trusted again. A custody change — a hardware key becomes available, or the keychain becomes usable after the passphrase file — runs the same six steps and the same start rule, except that step 1 mints no key and gives the current key a new key id, so the new tier's entry is written and verified before any blob moves, and step 6 marks the old id `retired`: its entry on the old tier stays until the last backup sealed under that id ages out, and goes at once when no backup names it.
- **Erasure destroys the key, not a rotation**. `Erase all data` destroys every custody copy of the master key and deletes the store, which leaves every sealed field unrecoverable ([Spec-020 §Daemon Master Key](../specs/020-data-retention-and-gdpr.md#daemon-master-key)).

### Permission Matrix

A session has exactly one owner and no other people, so the matrix is not a grid of roles: every row below is either something the session's owner may do from any of their linked devices, or something no caller may do. A caller who does not own the session is refused uniformly, and the refusal never distinguishes "not yours" from "does not exist".

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
| Start workflow runs (adjudicated per start as the named Cedar operation action — never an approval category, never remembered; every start path carries a daemon-resolved principal, the one user, never a client-supplied field, and a start whose principal does not resolve is refused — [ADR-027](../decisions/027-chat-invoked-workflow-start.md)) | Owner |
| Steer/interrupt/cancel, undo (`session.restore`), pause/resume runs, and compact a bound run's provider context (authorized by session write access, never by run authorship — "own" never scopes this row, so a run started from one device is steerable from any other. User-triggered context compaction shares this row's adjudication rather than minting a Cedar action of its own, per [Spec-004 §User-triggered context compaction](../specs/004-provider-driver-contract-and-capabilities.md#user-triggered-context-compaction) — a compaction target is always a binding this daemon holds) | Owner |
| Take a shell's control lease (one device holds a given shell at a time; there is no release — a lease ends when another device takes it, when a forced take moves it, or when the holding connection ends, and a revoked device's channel is closed, which ends its leases, per [Spec-002 §Required Behavior](../specs/002-runtime-node-attach.md#required-behavior)) | Owner, one holding device per shell |
| **Approvals** |  |
| Configure approval policies, resolve approval requests | Owner |
| **Artifacts and workspace** |  |
| Publish artifacts, attach repositories | Owner |
| Delete a session's artifacts: only with the session itself — `Delete old data` (`daemon.retentionPurge`) of an archived or closed session, or `Erase all data`; no person or method deletes a single artifact | Owner |
| **Read access** |  |
| Read the timeline, artifacts, and device presence | Owner |

**Actions requiring approval regardless of caller:**

- `file_write` outside the bound workspace
- `network_access` unless the active policy explicitly allows it
- `destructive_git` operations (force push, branch delete)

**Unconditional actions (no approval needed):**

- Reading the timeline, artifacts, and device presence
- Sending device presence heartbeats
- Registering the machine the service runs on

### Per-Device Presence Detail Authorization

The **Read the timeline, artifacts, and device presence** row above also governs the Devices page's reads: `device.list`, which returns each machine, device and passkey with its connected state and last-seen time, and a machine's `presence.read` and `presence.subscribe`, which report the devices connected to it and whether an app window is in front on each. They are authorized as the timeline is: the owner, from any of their devices.

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

## Audit Log Integrity

Local per-daemon event logs are tamper-evident. Each `session_events` row is chained to its predecessor via a BLAKE3 hash and carries a per-event Ed25519 signature from the emitting daemon. A Merkle root is computed over contiguous event ranges on a bounded cadence and anchored to the control plane as metadata only — the control plane never stores event payloads, keeping this design consistent with [ADR-017 Shared Event-Sourcing Scope](../decisions/017-shared-event-sourcing-scope.md).

### Hash Chain

Every `session_events` row carries two new columns:

- `prev_hash BLOB(32)`: the `row_hash` of the immediately preceding row in `(session_id, sequence)` order. For `sequence = 0` the value is 32 zero bytes.
- `row_hash BLOB(32)`: `BLAKE3( prev_hash || canonical_bytes(row) )`, where `canonical_bytes(row)` is the [RFC 8785 JSON Canonicalization Scheme (JCS)](https://datatracker.ietf.org/doc/html/rfc8785) serialization of the event envelope fields (`id`, `sessionId`, `sequence`, `occurredAt`, `category`, `type`, `actor`, `payload`, `correlationId`, `causationId`, `version`). `pii_payload` is **not** included in the canonical form. Events whose `pii_payload` column is non-NULL MUST embed a `pii_ciphertext_digest` field in `payload` (BLAKE3 over the ciphertext bytes of `pii_payload`); the digest is inside the canonical bytes and is never shredded, so [Spec-020](../specs/020-data-retention-and-gdpr.md) crypto-shredding of `pii_payload` does not break the chain.

One canonicalization rule, JCS, is mandatory: two honest implementations producing divergent serializations would produce divergent chains.

References:

- [RFC 8785 — JSON Canonicalization Scheme (JCS)](https://datatracker.ietf.org/doc/html/rfc8785)
- [BLAKE3 specification](https://github.com/BLAKE3-team/BLAKE3-specs/blob/master/blake3.pdf)

### Per-Event Daemon Signature

Every row carries `daemon_signature BLOB(64)` — an Ed25519 signature (per [RFC 8032 §5.1](https://datatracker.ietf.org/doc/html/rfc8032#section-5.1)) over the **same** `canonical_bytes(row)` that feeds `row_hash`. Signing and hashing share one byte string so a verifier never has to re-canonicalize: it hashes and signature-verifies the identical input.

Signing key resolution:

- Each daemon holds a session-scoped Ed25519 signing keypair. The public key is registered in the **session verification-key roster** when the daemon establishes the session, keyed by `NodeId`. Any audit reader — local replay or forensic export — resolves the verification key by looking up `NodeId` in the roster snapshot for the anchored range. (The registration store is the control-plane [`daemon_signing_public_keys` table](schemas/shared-postgres-schema.md#daemon-signing-public-keys-plan-005--verification-key-roster) — written by the admission-time `runtimenode.signingkeyregister` mutation, one current key per `(session, node)` pair with every earlier key kept marked retired, and read through the `runtimenode.signingkeyroster` query, Plan-005 T4.10 per CP-005-7 leg B. The table carries no account FK, so it sits outside the [Spec-020 §Erasure Paths](../specs/020-data-retention-and-gdpr.md#erasure-paths) Path-2 closure and the resolution surface SURVIVES user erasure — load-bearing, since account deletion never erases a machine, so the session event streams the person's machines keep and the `event_log_anchors` rows the roster verifies are retained. The daemon-local verifier checking rows it authored resolves its own `session_id`-keyed `daemon_signing_keys` store, the degenerate `NodeId` = self arm. **Registration timing.** Registration fires when the daemon establishes a control-plane-admitted session, before the session's first event and with no delivered-artifact dependency, so no row the daemon signs — even in a session that only appends [Spec-005 §User Message Events](../specs/005-session-event-taxonomy-and-audit-log.md#user-message-events)'s `user.message` rows — is left with no roster key to resolve it.)
- Signing keys rotate only through `sidekicks rotate-keys` (`daemon.keyRotate`), which mints a new master key and, with it, a new identity key and new per-session signing keys. Each new signing key is registered as its pair's current key, and the key before it stays in the roster marked retired, so rows signed before a rotation keep verifying under the key that signed them; a retired key is refused for good. Outside a rotation the key is stable, and refusal holds at both ends: the daemon-side key-reuse observer enforces `refuse_on_rotation` (Plan-005 T4.2), and a halted identity resumes only through `rotate-keys`; `runtimenode.signingkeyregister` refuses a registration presenting a key that differs from the current one for its `(session, node)` pair (T4.10), never a silent overwrite. Registration is bound to the machine that makes it: every registration carries a signature by the machine's identity key, and a rotation's registration carries a second, by the retiring signing key. The control plane checks the first against the machine's registered key (`runtime_nodes.public_key`, which the machine registration of [Plan-028 §Phase 3 — The relay and the channel](../plans/028-remote-control.md#phase-3--the-relay-and-the-channel) records) and refuses another machine's `nodeId` with `runtimenode.permission_denied`, so one machine cannot register a key into another machine's slot, even within the one account. A device checks the same signature against the machine key its own statement chain trusts, so the binding never rests on the control plane's word; the caller's DPoP thumbprint proves its token only and is not the binding. A genuine daemon refused the different-key 409 for its own slot appends the durable `audit_integrity_failed` `failureMode: 'signing_key_slot_conflict'` ([Spec-005 §Audit Integrity](../specs/005-session-event-taxonomy-and-audit-log.md#audit-integrity-audit_integrity)) rather than holding a local log line. That row is signed with the very key the roster refused, so roster-resolving external verifiers see it only as one more `signature_mismatch` among every row the refused daemon signs; the durable append serves local replay, the anchor-covered post-repair forensic record, and operator surfacing, and an independently verifiable trust path for the conflict is the open Plan-005 T4.10 audit-delta design item.

Besides the daemon signature above, each linked device signs the events it originates with its own identity key, and the machine verifies that signature before it appends and refuses one it cannot resolve to a trusted device key; an approval, question or plan resolution carries the answering device's id. A revoked device's past signatures still verify, and nothing new it signs is admitted ([Plan-028](../plans/028-remote-control.md) Phase 6).

References:

- [RFC 8032 — Edwards-Curve Digital Signature Algorithm (EdDSA), §5.1 Ed25519](https://datatracker.ietf.org/doc/html/rfc8032#section-5.1)

### Merkle Anchors (Control-Plane Witness)

Anchoring converts per-row tamper-evidence into tamper-evidence against an external timestamp without exposing event content. On the earlier of `ANCHOR_INTERVAL_EVENTS = 1000` events or `ANCHOR_INTERVAL_SECONDS = 300` seconds the emitting daemon:

1. Builds the [RFC 9162 §2.1.1](https://datatracker.ietf.org/doc/html/rfc9162#section-2.1.1) Merkle Tree Hash over the `row_hash` values of the range `[last_anchored_sequence + 1, current_sequence]`, with BLAKE3 as `HASH`. Each `row_hash` is a data entry rather than a leaf hash: a leaf is `BLAKE3(0x00 || row_hash)`, an interior node is `BLAKE3(0x01 || left || right)`, a single-entry range's root is its leaf hash, and for `n > 1` entries the list splits at `k`, the largest power of two smaller than `n` (`k < n <= 2k`), giving `MTH(D_n) = HASH(0x01 || MTH(D[0:k]) || MTH(D[k:n]))`. An EMPTY range is refused rather than hashed to `HASH()`: `[start_sequence, end_sequence]` is inclusive and the schema `CHECK (end_sequence >= start_sequence)` refuses an inverted one, so the interval always spans at least one sequence number and zero leaves means rows are MISSING, not that the range is empty.
2. Signs the **anchor claim** with its session-scoped Ed25519 key (same key used for `daemon_signature`): the RFC 8785 canonicalization of `{endSequence, merkleRoot, nodeId, sessionId, startSequence}` per [Spec-005 §Anchoring Cadence](../specs/005-session-event-taxonomy-and-audit-log.md#anchoring-cadence) — coordinates inside the signature, not beside it, so a stored or carried anchor record cannot be relabeled onto a different span or log after signing.
3. Uploads `(session_id, node_id, start_sequence, end_sequence, merkle_root, root_signature, anchored_at)` to the control plane's `event_log_anchors` table. **Only anchor metadata is uploaded — event payloads stay on the emitting daemon**, preserving ADR-017's rejection of a shared event log.

Precedent: hash-chain plus periodic root anchor is the core transparency-log pattern specified in [RFC 9162 — Certificate Transparency v2](https://datatracker.ietf.org/doc/html/rfc9162). V1 scopes down the DEPLOYMENT (no third-party auditors, no gossip protocol) while conforming to the §2.1.1 tree construction exactly, domain-separation prefixes included. The domain-separation prefixes are load-bearing and not deployment-scope-dependent: the RFC states the leaf and node calculations differ because "this domain separation is required to give second preimage resistance", a property an internal log needs exactly as much as a public one, and the split-at-largest-power-of-two shape is what makes the tree "uniquely determined by the number of leaves", refusing the two-entry-lists-one-root collapse (CVE-2012-2459) that the odd-leaf-duplication construction admits. The shipped `computeMerkleRoot` implements §2.1.1.

References:

- [RFC 9162 — Certificate Transparency v2](https://datatracker.ietf.org/doc/html/rfc9162)

### Verification Rules

An audit stub (`retention_class = 'audit_stub'`) exists only in a session that was purged whole: `Delete old data` (`daemon.retentionPurge`) of an archived or closed session anchors the range first, then replaces each row's body with a signed stub. Background compaction is lossless and never turns a live row into a stub, so every row of a session that has not been purged is live and takes the live checks. The checks below apply to live rows and purge stubs as each says; the post-compaction checks named in Spec-005 are the checks on purge stubs.

A read-side verifier runs four checks, in order (the fourth applies only to purge stubs; rule 2 additionally carries two column-SHAPE preconditions — the all-placeholder refusal and the stored-`occurred_at` form check — the second of which runs on both retention classes, and TWO content-binding POSTconditions — the `pii_payload` digest check and the `content_payload` digest check — both of which necessarily run AFTER the Ed25519 verification rather than before it, and for the same reason: the value each compares against lives inside the bytes that verification authenticates). Any failure halts replay and emits `audit_integrity_failed` per [Spec-005 §Integrity Protocol](../specs/005-session-event-taxonomy-and-audit-log.md#integrity-protocol):

1. **Chain check.** For each row where `retention_class IS NULL` (live), recompute `BLAKE3(prev_hash || canonical_bytes(row))` and compare to the stored `row_hash`. Mismatch → `audit_integrity_failed { failureMode: 'hash_mismatch', failurePath: 'inclusion' }` per [Spec-005 §Audit Integrity (audit_integrity)](../specs/005-session-event-taxonomy-and-audit-log.md#audit-integrity-audit_integrity) — EXCEPT for a row whose integrity columns ALL still hold Plan-001's zero-fill placeholders, which rule 2's placeholder precondition refuses ahead of this recomputation: such a row's `row_hash` is 32 zero bytes and so fails this compare too, and reporting it here would both make that precondition unreachable and mislabel a never-signed row as a chain break. For rows where `retention_class = 'audit_stub'`, the original canonical bytes have been discarded by the purge, so per-row chain recomputation against the original is impossible — those rows are instead verified by the anchor check (rule 3, original-existence) AND the stub-signature check (rule 4, stub-authenticity) per [Spec-005 §Post-Compaction Integrity](../specs/005-session-event-taxonomy-and-audit-log.md#post-compaction-integrity).
2. **Signature check.** For each `retention_class IS NULL` row, **the placeholder precondition is checked first**: if the row's integrity columns ALL still hold Plan-001's zero-fill placeholders — `prev_hash` and `row_hash` 32 zero bytes each, `daemon_signature` 64 zero bytes — then no signature was ever produced for that row and there is nothing to verify, so emit `audit_integrity_failed { failureMode: 'signature_placeholder', failurePath: 'signature' }` and stop, before any Ed25519 verification is attempted (and, per rule 1's carve-out, ahead of the chain recomputation a zero `row_hash` would otherwise fail first). The predicate requires all three columns: a genuine genesis row carries a zero `prev_hash` beside a REAL `row_hash` and a real signature, and the `row_hash` conjunct is what keeps it out. Such a row MUST NEVER be "repaired" by signing it with a current key — retro-signing an old record with a later key is a published attack that no conforming raw-Ed25519 verifier can detect after the fact, per [Spec-005 §Integrity Protocol](../specs/005-session-event-taxonomy-and-audit-log.md#integrity-protocol), which is normative for this precondition. The verdict is deliberately NOT folded into `signature_mismatch` because the operator response is the opposite: a mismatch is possible tampering and warrants security incident response, whereas a placeholder is an engineering sequencing bug and warrants a code fix — conflating them pages the wrong on-call. Otherwise verify `daemon_signature` against `canonical_bytes(row)` using the `NodeId`-resolved Ed25519 public key from the session verification-key roster. Failure → `audit_integrity_failed { failureMode: 'signature_mismatch', failurePath: 'signature' }`. For `retention_class = 'audit_stub'` rows, the ORIGINAL canonical bytes are gone — per-row signature verification against the original is skipped; original-range tamper-evidence comes from the Ed25519-signed Merkle root checked in rule 3, and purge-stub authenticity comes from the per-row `stub_signature` checked in rule 4. **Stored-`occurred_at` form check (same rule, BOTH retention classes).** A verified signature binds the canonical BYTES, and `canonicalizeEvent` normalizes exactly one canonical member — `occurredAt` — while passing every other through byte-for-byte. That single column is therefore committed as an INSTANT rather than as the bytes stored beside it, so an at-rest respelling into a different spelling of the same instant (`+00:00` or `-05:00` in place of `Z`, appended trailing zeros) re-canonicalizes identically and passes every check above, while the respelled row sorts out of position in this lexically-ordered TEXT column and drops out of the very date-range scans a verifier walks. Rule 2 therefore also asserts that the stored `occurred_at` IS the canonical spelling, via Plan-005 T2.1's exported `isCanonicalOccurredAt` — a pure, total, never-throwing predicate, the never-throwing part being load-bearing because a throw inside a range walk would abort it and silence audit of the entire remaining tail. Non-canonical → `audit_integrity_failed { failureMode: 'occurred_at_not_canonical', failurePath: 'signature' }`, `failurePath` naming the guarantee that failed — the signature binding the stored bytes — rather than the column the defect occupies. Like the placeholder precondition above it this is a column-SHAPE check rather than a second verification, which is why it lives inside rule 2 instead of becoming a rule of its own. It runs on `audit_stub` rows too and is NOT subsumed by rule 4's scalar binding: that check catches a respelling applied AFTER the purge, whereas one applied while the row was still live is copied verbatim into the projection per [Spec-005 §Compacted Event Format](../specs/005-session-event-taxonomy-and-audit-log.md#compacted-event-format), signed into the stub bytes, and byte-equal to its column forever — the purge launders the live-path defect into signed bytes, so rule 2's form check is the only thing that catches it in either state. **PII-ciphertext digest binding (same rule, POSTcondition, both retention classes).** `pii_payload` — the person's own words, sealed AES-256-GCM under the session's content key with the PII partition's own associated-data label, `ais.session-pii.v1` — is excluded from the canonical form by design, which keeps the PII partition out of the signed bytes so they commit to the ciphertext without carrying it, and the column is bound instead by a `pii_ciphertext_digest` member carried INSIDE the signed payload, BLAKE3 over the ciphertext bytes per [Spec-005 §Canonical Serialization Rules](../specs/005-session-event-taxonomy-and-audit-log.md#canonical-serialization-rules). Signing that digest binds nothing on its own: a digest that is minted and signed but never recomputed lets a substitution, truncation, or deletion of `pii_payload` at rest leave both the chain and the signature verifying green. Rule 2 therefore also asserts, for every row whose `pii_payload` is non-NULL, that `BLAKE3(pii_payload)` equals the digest in the just-verified payload, via Plan-005 T2.4's exported `isCiphertextDigestBound` — pure, total, and never-throwing for the same range-walk reason as the form check above, and additionally shape-guarding the column, since a `BLOB`-affinity read can hand back a `string` on which the hash primitive would throw. Divergence → `audit_integrity_failed { failureMode: 'pii_ciphertext_digest_unbound', failurePath: 'signature' }`, `failurePath` again naming the broken guarantee — the signature's commitment to the ciphertext — rather than the column. Unlike the preconditions this one runs AFTER the Ed25519 check and is meaningless before it: an unverified payload's digest is not evidence of anything. Three states besides the ordinary compare are decided by the same predicate: a non-NULL column with NO digest violates the non-NULL MUST; a digest whose column has been emptied is the evidence-destruction case, where the signature still verifies over a commitment that outlived its subject; and neither present is a pass, covering both no-PII rows and purge stubs, which [Spec-005 §Compacted Event Format](../specs/005-session-event-taxonomy-and-audit-log.md#compacted-event-format) NULLs and re-projects without a digest. There is deliberately NO shred carve-out, because no row keeps ciphertext whose key is gone: a session's purge deletes the session's content key first and then stubs its rows, NULLing `pii_payload`, and [Spec-020 §Erasure Paths](../specs/020-data-retention-and-gdpr.md#erasure-paths) Path 1, `Erase all data`, destroys every custody copy of the master key and deletes the store, so no row survives it. Were a data act ever to clear the column on a row it keeps outside the purge's stub builder, or to keep a row whose key it destroyed, this rule would have to change in the same edit — that collision is intentional, and CP-005-12 registers it. **Machine-authored content digest binding (same rule, POSTcondition, both retention classes).** `session_events.content_payload` — the assistant-message, reasoning-update, and tool-call bodies, sealed AES-256-GCM under the same session content key — is excluded from the canonical form for the same structural reason `pii_payload` is, and is bound instead by a `contentCiphertextDigest` member carried INSIDE the signed payload, BLAKE3 over the ciphertext bytes per [Spec-005 §Canonical Serialization Rules](../specs/005-session-event-taxonomy-and-audit-log.md#canonical-serialization-rules). Without this assertion a ciphertext replaced or removed after signing would leave both the chain and the signature verifying green and surface only as a body that will not decrypt — silently reclassifying at-rest tampering as ordinary transcript loss, which is exactly what the canonical-transcript fold's `'turn_content_unavailable'` must not be able to absorb: a report that can mean either "the key is gone" or "someone edited the column" means neither. Rule 2 therefore also asserts, for every row whose `content_payload` is non-NULL, that `BLAKE3(content_payload)` equals the digest in the just-verified payload, via Plan-005 T3.8's exported `isContentCiphertextDigestBound` — pure, total, and never-throwing for the same range-walk reason as its siblings, and fail-closed on a shape it cannot digest, since a non-`Uint8Array`, non-NULL column value is reported unbound rather than skipped. Divergence → `audit_integrity_failed { failureMode: 'content_ciphertext_digest_unbound', failurePath: 'signature' }`, `failurePath` again naming the broken guarantee rather than the column. It decides the same states its PII sibling does. **Neither partition carries an owner stamp, and the absence is a conclusion rather than a gap:** both are sealed under the SESSION's content key, and `session_id` is already a canonical signed member, so the binding an owner stamp would carry is committed by the canonical form as it stands, and who wrote a row is its signed `actor`. Sharing the key costs no separation: the PII partition's label sits in its associated data, so a row's `pii_payload` ciphertext can never authenticate as that row's `content_payload`, and no owner-stamp failure mode exists. As with `pii_payload`, this column's ciphertext is REMOVED by the purge along with the payload carrying its digest, so the two disappear together and the purge stub lands in the both-absent state with no carve-out required.
3. **Anchor check.** For each anchored range, recompute the Merkle root from locally stored `row_hash` values and compare to `event_log_anchors.merkle_root`; verify `root_signature` over the anchor claim — coordinates and root together, per [Spec-005 §Anchoring Cadence](../specs/005-session-event-taxonomy-and-audit-log.md#anchoring-cadence) — against the same `NodeId`-resolved key. Failure → `audit_integrity_failed { failureMode: 'anchor_mismatch', failurePath: 'consistency' }`. For ranges entirely composed of `retention_class = 'audit_stub'` rows the same Merkle-root + signature check applies (the stored `row_hash` was frozen pre-purge by I-005-3-03 chain-commitment-frozen invariant). A **covering** anchor is one whose `[start_sequence, end_sequence]` spans the range under verification (`anchor.start_sequence ≤ range_start AND anchor.end_sequence ≥ range_end` — the same single-anchor coverage test the purge applies in [Spec-005 §Post-Compaction Integrity](../specs/005-session-event-taxonomy-and-audit-log.md#post-compaction-integrity) step 1, NOT an exact-`start_sequence` match; a cadence anchor and a wider force-fire anchor may share a `start_sequence`). If a purged range has no covering anchor, → `audit_integrity_failed { failureMode: 'anchor_missing_for_compacted_range' }`; if the covering anchor's signature fails to verify, → `audit_integrity_failed { failureMode: 'anchor_signature_invalid' }`. Additional `failureMode` values per [Spec-005 §Audit Integrity (audit_integrity)](../specs/005-session-event-taxonomy-and-audit-log.md#audit-integrity-audit_integrity): `inclusion_proof_failed`, `consistency_proof_failed`, `log_file_missing`, `log_file_moved` cover anchor-substrate failures beyond the core checks.
4. **Stub-signature check** (purge stubs only). For each `retention_class = 'audit_stub'` row, verify the stored `stub_signature` **directly over the canonical byte string stored in `payload`** (the exact bytes the purge signed when it wrote the stub — not re-canonicalized, not reconstructed from the scalar columns) using the same `NodeId`-resolved Ed25519 public key. The anchor (rule 3) commits to the ORIGINAL pre-purge `row_hash`, not to the purge stub bytes, so without this check a local tamper of the visible stub (`summary`, `actor`, …) would pass rule 3 undetected. A `stub_signature` that fails to verify OR is absent on an `audit_stub` row → `audit_integrity_failed { failureMode: 'stub_signature_invalid', failurePath: 'signature' }` (the signature is REQUIRED on every purge stub; absence is a failure, never a skip). Because the canonical bytes bind `id` + `sequence`, a `stub_signature` cannot be replayed from another row, and a `retention_class` flip in either direction is caught (NULL→stub fails rules 3+4; stub→NULL fails rule 1's chain recomputation against the now-mismatched frozen `row_hash`). **Scalar-column binding (same rule, purge stubs).** The surviving scalar columns (`id`, `session_id`, `sequence`, `occurred_at`, `category`, `type`, `actor`) are a denormalized cache for SQL filters (`idx_session_events_type`) and envelope reconstruction; they are NOT covered by `stub_signature`, which signs only the `payload` projection bytes. So rule 4 additionally decodes the projection from the just-verified `payload` bytes and asserts each scalar column byte-equals its projection counterpart (`occurred_at` ↔ `occurredAt`, `session_id` ↔ `sessionId`, …) — a divergence (e.g. an at-rest edit of `actor`/`type` while `payload` is untouched, which would otherwise pass rules 3+4 yet forge a filter/reconstruction value) → `audit_integrity_failed { failureMode: 'stub_scalar_mismatch', failurePath: 'signature' }`. The signed `payload` projection is the authoritative source for a purge stub's envelope fields. For `occurred_at` specifically this binding is only half the story and the two halves are not interchangeable: it catches a respelling applied AFTER the purge, because the column then diverges from the signed projection, but a row respelled while still LIVE carries the bad spelling into the projection verbatim, so column and projection agree forever and this check passes — that case is rule 2's stored-form precondition, which is why that precondition runs on purge stubs too.

**Verifier roles.** The checks above require access to the local event rows on the emitting daemon, which is the only place they exist — a session binds to exactly one runtime node, and the relay carries no event rows. A control-plane-only auditor — seeing only `event_log_anchors` metadata, never event payloads or stub bytes, consistent with [ADR-017](../decisions/017-shared-event-sourcing-scope.md) — cannot perform the chain check, the per-row signature check (including both of its column-shape preconditions AND both of its content-binding postconditions, which read columns it never sees — `pii_payload` least of all, since ADR-017 keeps PII ciphertext off the control plane entirely, and `content_payload` no more reachably, being node-local and excluded from the canonical bytes), or the stub-signature check (rule 4 needs the stub rows). Its available checks reduce to verifying each anchor's `root_signature` over the anchor claim — coordinates and root together per [Spec-005 §Anchoring Cadence](../specs/005-session-event-taxonomy-and-audit-log.md#anchoring-cadence), which is precisely what lets this auditor trust the stored coordinates as origin-attested rather than server-asserted (using the `NodeId`-resolved Ed25519 key) — and confirming anchor-sequence monotonicity per `(session_id, node_id)`. After a purge, a LOCAL verifier (holding the `audit_stub` rows) retains THREE tamper-evidence shapes — the range-level anchor (rule 3, original-existence), the per-row `stub_signature` (rule 4, stub-authenticity), and the stored-`occurred_at` form check (rule 2, stored-spelling binding) — whereas the control-plane-only auditor is limited to the anchor shape alone. The post-purge set is smaller on purpose: a LIVE row also carries rule 2's `pii_payload` digest binding and its `content_payload` digest binding, and the purge retires BOTH rather than preserving them, for one reason: the stub projection NULLs `pii_payload` and `content_payload` and carries neither `pii_ciphertext_digest` nor `contentCiphertextDigest` forward, per [Spec-005 §Compacted Event Format](../specs/005-session-event-taxonomy-and-audit-log.md#compacted-event-format), so after the purge there is no ciphertext left to bind and the row lands in each binding's both-absent state. Both retirements are real coverage boundaries rather than oversights, and together they mean each digest binding's whole window is the row's life before any purge — the same window the `occurred_at` binding was minted to cover. This is why the anchor-before-stub protocol AND the per-row stub commitment per [Spec-005 §Post-Compaction Integrity](../specs/005-session-event-taxonomy-and-audit-log.md#post-compaction-integrity) are BOTH load-bearing: the anchor is the only original-existence proof a remote auditor can check, and the `stub_signature` is the only per-row authenticity proof for the bytes that survive locally. The third shape covers what neither of those can — a timestamp respelled before the purge froze it, which the anchor and the stub signature both certify faithfully because it was already there when they were computed.

The `audit_integrity_failed` event is itself a `session_events` row and is therefore covered by the chain/signature/anchor protocol going forward — a tampered integrity failure cannot be silently appended after the fact.

### Schema

- **Local SQLite** — the daemon's one schema carries the integrity protocol. Plan-001 adds the three integrity columns on `session_events`: `prev_hash BLOB(32) NOT NULL`, `row_hash BLOB(32) NOT NULL`, `daemon_signature BLOB(64) NOT NULL`. Plan-005 adds what the purge-stub integrity protocol needs: `session_events.retention_class TEXT` (NULL-able — the `'audit_stub'` discriminator Verification Rules 1/2/4 branch on), `session_events.stub_signature BLOB(64)` (NULL-able — the per-row stub-authenticity signature Rule 4 verifies), the `daemon_signing_keys` table (the sealed-Ed25519 custody store whose public key resolves the Rule 2/3/4 signature checks), and the `pending_anchor_uploads` table (the local queue of Merkle-anchor uploads awaiting replication to the shared `event_log_anchors` table — partition tolerance for the Rule 3 anchor checks). The purge-stub verifier needs Plan-005's columns and tables, not only Plan-001's, and Plan-005's part spans BOTH databases, since T4.10 adds a table to the control plane's one schema (next bullet). See [Local SQLite Schema](schemas/local-sqlite-schema.md) § Session Events.
- **Shared Postgres** — the control plane's one schema carries two tables for the protocol. `event_log_anchors` stores anchor metadata only (Merkle roots + signatures), never event payloads — see [Shared Postgres Schema](schemas/shared-postgres-schema.md) § Event Log Anchors. `daemon_signing_public_keys` (Plan-005 T4.10, CP-005-7) is the daemon verification-key roster §Per-Event Daemon Signature resolves against — one current key per `(session, node)` pair with every earlier key kept marked retired, public key material only, deliberately no account FK, so it sits outside the [Spec-020 §Erasure Paths](../specs/020-data-retention-and-gdpr.md#erasure-paths) Path-2 erasure closure and anchors stay independently verifiable for the audit-retention lifetime — see [Shared Postgres Schema](schemas/shared-postgres-schema.md) § Daemon Signing Public Keys (Plan-005 — Verification-Key Roster).

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
