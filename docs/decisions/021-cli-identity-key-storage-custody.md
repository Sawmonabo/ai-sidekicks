# ADR-021: Machine Identity Key Custody

| Field         | Value                                                 |
| ------------- | ----------------------------------------------------- |
| **Status**    | `accepted`                                            |
| **Type**      | `Type 2 (one-way door)`                               |
| **Domain**    | `Security / Machine Identity / Cryptographic Custody` |
| **Date**      | `2026-04-18`                                          |
| **Author(s)** | `Claude`                                              |
| **Reviewers** | `Accepted 2026-04-18`                                 |

## Context

Each machine the person uses runs one background service, and that service holds the machine's private keys: its Ed25519 identity key, which every one of the person's devices pins as this machine and which certifies the machine's end of the Remote Control channel ([Spec-028 §The encryption envelope](../specs/028-remote-control.md#the-encryption-envelope)); the hosted account's DPoP key; and its refresh token. All of them sit sealed in the daemon's database under one master key, so the custody question is where the master key lives and how it opens.

The service runs unattended. It starts at login, comes back after a reboot and runs scheduled workflows with no one present, and on Linux with lingering it may start before the person logs in. A master key that needs a touch or a typed passphrase at every start would stop all of that. The CLI holds no key of its own: it talks to the daemon on the same machine through the daemon's socket ([Spec-006](../specs/006-local-ipc-and-daemon-control.md)).

A keystore binding can silently succeed against a backend that does not provide the durability or confidentiality the caller assumes: a kernel session keyring on Linux instead of the Secret Service, a locked login keychain on macOS, a policy-blocked write on Windows. The design therefore treats a successful keystore `set` call as a claim, not evidence, and verifies a keychain tier with a write-probe-read-delete cycle before accepting it.

## Problem Statement

Where does the service keep the master key that seals every daemon private key, on macOS, Linux and Windows — including a Windows computer whose service runs in WSL 2 — so that:

1. The key opens with no person present, at every start and after a reboot.
2. At-rest exposure is bounded by the strongest custody the machine offers: a security chip the service can use unattended, then the OS keychain, then an Argon2id passphrase file.
3. No silent fallback occurs to a backend (kernel keyutils, a locked keychain, plaintext disk) the service has not verified as its custody tier.
4. The service refuses to start when no tier can be established, rather than generating a key that would not open at the next start.
5. The design claims no protection the chosen primitives do not provide.

### Trigger

- The service is the person's own background service and must open its keys with no one present; a key derived from a passkey ceremony, or a passphrase typed at every start, cannot.
- Every daemon private key needs one sealing format under one custody root, so that a key rotation re-seals them all at once.
- `@napi-rs/keyring` exposes no backend-identity signal on any platform, and on Windows writes every entry at Enterprise persistence. Silent fallback remains the dominant failure the design defends against.

## Decision

The service keeps its master key on a **four-tier custody ladder**, tried in order at first start and at every custody change — hardware wrap, OS keychain, Argon2id passphrase file, refuse — with a write-probe-read-delete verification before the keychain tier is accepted, and seals every daemon private key, the machine's identity key among them, under that master key in one format.

### Custody Tiers

#### Tier 1 — Hardware wrap

- Where the machine has a security chip the service can use with no person present, the master key is wrapped to a key that never leaves the chip. When the keychain tier also exists, both apply: reading the master key needs this machine's chip and the person's unlocked login. The chip's key is the machine's, not a master key's, and is kept across master-key rotations and custody changes.
- **macOS:** a Secure Enclave P-256 key-agreement key made with CryptoKit. Its opaque handle (284 bytes) sits in the data folder, and the master key is wrapped to it: an ephemeral P-256 key, ECDH with the enclave key, HKDF-SHA-256, then AES-256-GCM. The enclave work runs in a small Swift helper process, `sidekicks-keywrap`, shipped unsigned per architecture, because a tampered handle crashes CryptoKit and a crash must be a refusal, never a daemon fault. It needs no keychain entry and no entitlement. Measured on a Mac: the key made in 53 ms, an unwrap in a second process in 9 to 20 ms. A different unsigned binary also unwraps, so the binding is to this Mac, not to the app. An Intel Mac without a T2 chip has no Secure Enclave and uses tier 2.
- **Windows:** a user-scoped, non-exportable key with no PIN in the Microsoft Platform Crypto Provider (`MS_PLATFORM_CRYPTO_PROVIDER`, the TPM key storage provider), the master key wrapped with `NCryptEncrypt` by the service's Windows half ([ADR-041](./041-the-service-on-wsl-2.md)). A machine with no TPM uses tier 2. Its timings, and that a user-scoped key needs no prompt, are measured on a Windows machine before build.
- **Linux:** no hardware tier until a probe on a Linux machine with a TPM chooses between `systemd-creds` and the TPM2 software stack.
- If the chip is absent or its wrap fails, descend to tier 2, logging why.

#### Tier 2 — OS keychain

- The master key — already hardware-wrapped when tier 1 exists — is one entry in the operating system's keychain:
  - **macOS:** the login keychain, through [`@napi-rs/keyring`](https://github.com/Brooooooklyn/keyring-node) 2.1.0.
  - **Linux:** the D-Bus Secret Service (GNOME Keyring, KeePassXC, KDE Wallet), through `@napi-rs/keyring` 2.1.0 pinned to `{linux: {store: "secret-service"}}`, so the binding never reaches the kernel keyutils store, whose session keyring is reboot-volatile and expires after 3 days of inactivity.
  - **Windows:** Credential Manager at `CRED_PERSIST_LOCAL_MACHINE`, written by the service's Windows half through `windows-native-keyring-store` 1.1.0 with `persistence=local`, because `@napi-rs/keyring` 2.1.0 passes only the entry's target and so writes every Windows entry at Enterprise persistence, which roams with a domain profile.
- The entry is named by the master key's key id: its account is `master-key.<key id>`, so a rotation or a custody change writes the new entry beside the old one and deletes the old one only after every sealed blob names the new key and the last backup sealed with the old one has aged out ([§One Custody Root](#one-custody-root)).
- **Preconditions (all must hold before tier 2 is accepted):**
  1. Platform-specific availability probe (see [§Platform-Specific Preconditions](#platform-specific-preconditions)).
  2. Write-probe-read-delete cycle succeeds (see [§Write-Probe-Read-Delete Invariant](#write-probe-read-delete-invariant)).
  3. The backend named in the service log (macOS: the login keychain; Windows: local-machine persistence; Linux: the Secret Service's bus owner).
- If any precondition fails, descend to tier 3. The service logs which precondition failed and a concrete remediation (for example, "GNOME Keyring is locked; unlock it, then restart the background service").
- On Linux with lingering the service can start before login while the keyring is locked. It then starts locked: a run that needs sealed content fails its step and offers `Retry from this step`, never waiting, and the service reads the key again at each new run and each retry, so the first one after login succeeds.

#### Tier 3 — Argon2id passphrase file

- For a machine with neither a usable chip nor a keychain, such as Linux with no Secret Service.
- Cipher: [`@noble/ciphers`](https://github.com/paulmillr/noble-ciphers) XChaCha20-Poly1305 (AEAD; 24-byte random nonce, 16-byte authentication tag).
- KDF: Argon2id with OWASP 2026 minimum parameters — `m = 19456 KiB (19 MiB)`, `t = 2`, `p = 1`, per the [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html); supplied by [`@noble/hashes`](https://github.com/paulmillr/noble-hashes) `argon2id`.
- Passphrase source: the person chooses it at first start with `sidekicks daemon install` or on Settings › Runtime. After each start the service is locked until `sidekicks daemon unlock` reads the passphrase without echo and hands it over the daemon's socket as `daemon.unlock {passphrase}`, or the Runtime service line's field takes it; the line reads `Running · locked until its passphrase is entered`. The passphrase is held in the daemon's memory for the daemon's lifetime and never written to disk.
- File format (50-byte header + AEAD body):

  ```
  [version:1][argon2_m:4][argon2_t:4][argon2_p:1][salt:16][nonce:24][ciphertext||tag]
  ```

  - `version` — format-version byte, starts at `0x01`, reserved `0x00` for corruption detection.
  - `argon2_m` / `argon2_t` / `argon2_p` — Argon2id parameters stored inline so the cost can be raised in a future release without breaking decryption of pre-existing files.
  - `salt` — 16 bytes from `crypto.randomBytes`, per-key unique.
  - `nonce` — 24 bytes from `crypto.randomBytes`, per-encryption unique.
  - `ciphertext||tag` — XChaCha20-Poly1305 output; associated data is the 50-byte header prefix so tampering with any parameter invalidates the tag.

- POSIX file permissions: file `0600` inside parent directory `0700` (Unix-like platforms). Write path is write-temp-atomic-rename (create `*.tmp` with target permissions, `fsync`, `rename` over the target) — the same pattern HashiCorp Vault uses for its file backend to guarantee the file is never observable in a partially-written state with permissive default permissions.
- Windows file permissions: after first write, apply `icacls /inheritance:r /grant:r "%USERNAME%":F` to the containing directory. Inherited permissions are removed; only the running user gets full access. The encrypted file itself inherits from the directory after the restrictive grant lands.
- The file is `daemon-master.<key id>.enc`, named by the master key's key id, in the service's data folder; on a Windows computer, native or WSL, in the Windows data folder, because custody stays on Windows for both sides.

#### Tier 4 — Refuse

- When no tier can be established, the service does not start, and `sidekicks daemon status` says why: the failed tiers, the detected platform constraints, and the smallest set of actions that reaches a working tier.
- No key is generated when tier 4 is active. A master key with no durable custody would not open at the next start, and every key sealed under it would be lost with it.

On tiers 1 and 2 the decrypted master key is wiped from memory after 15 minutes idle and read again when next needed, which costs one keychain read and one enclave or TPM unwrap and involves no person. The idle wipe does not apply on tier 3, because an unlocked unattended service must stay unlocked.

### One Custody Root

- Every daemon private key is sealed under the master key and stored in the daemon's database. The machine's identity key and channel key, the MCP governance key, the hosted account's DPoP key and its refresh token are each a row of the `daemon_secrets` table, keyed by its purpose, which holds the key's id, its state, its public half where it has one, and the sealed secret. A tool server's sign-in is the one exception: its refresh token and, for a server that demands DPoP tokens, its signing key are items of their own in the operating system's credential store ([ADR-040](./040-mcp-credential-custody.md)).
- One sealing format. Every blob sealed under the master key — each sealed daemon private key and each session content key's wrap — begins with a master-key header, one format byte and the 16-byte key id of the master key that sealed it, ahead of the 24-byte nonce, the ciphertext and the tag. The seal is XChaCha20-Poly1305, and its associated data is the header followed by the blob's own associated data, for a daemon private key `purpose || row id || "ais.master-wrap.v1"`, so a blob cannot be relabeled to another key. A reader opens each blob with the key its header names.
- Each placement of the master key in custody has a key id, 16 random bytes written as 32 lowercase hex characters, and its custody entries carry it (`master-key.<key id>` in the keychain, `daemon-master.<key id>.enc` on the passphrase tier). The `master_keys` table records each id with its state — `active`, `incoming`, `outgoing` or `retired`: at most one row in each of the first three, and one `retired` row for each older key a backup still names — and its creation time; outside a rotation exactly one row is `active`. A write wraps under the `active` key and confirms that key is still `active` before it commits.
- `sidekicks rotate-keys` rotates the master key in six steps: it creates the new key and its key id in locked memory; writes the new key's custody entry on the highest tier that works, and its recovery envelope and iCloud Keychain item where those are on, and verifies the entry by reading it back through that tier and comparing it with the key in memory; records the new key in `master_keys` as `incoming`; re-wraps every session content key and re-seals every daemon private key under it; in the same transaction as the re-wrap, marks the new key `active` and the old one `outgoing`; and, once it confirms that no blob's header names the old key id, marks the old key `retired` and deletes its recovery envelope, its custody entries and row staying until the last backup sealed with it ages out; a retired key that no backup names is deleted at once. No row is committed under a key that exists only in memory, and at start an interrupted rotation resumes or rolls back by the table in [Spec-020 §Daemon Master Key](../specs/020-data-retention-and-gdpr.md#daemon-master-key).
- A custody change — a hardware key becomes available, or the keychain becomes usable after the passphrase file; custody only moves up the ladder — runs the same six steps with no new key: the current key takes a new key id, its entry on the new tier is written and verified beside the old one, every blob is re-wrapped to name the new id, and step 6 marks the old id `retired`: its entry on the old tier stays until the last backup sealed under that id ages out, and goes at once when no backup names it.
- The app's other keychain entries — a pasted provider token, a workflow secret — keep entries of their own ([ADR-028](./028-provider-credential-custody-posture.md), [ADR-038](./038-workflow-secrets-in-the-os-keychain.md)).

### Machine Identity

- The service's Ed25519 identity key is minted at the service's first start, with the machine's id, tagged `ed25519`, and sealed under the master key; it is minted again only at `sidekicks rotate-keys` and when a removed machine is linked again. It never leaves the machine. A Windows computer is one machine whichever side runs the service: a move between Windows and a WSL distribution carries the store, so the key and the machine's registration come along ([ADR-041](./041-the-service-on-wsl-2.md)).
- Enrollment is `sidekicks sign-in`: with the service stopped, the CLI reads the key's public half through the daemon's custody code and enrolls it with the control plane as this machine's key, under the signed-in person. When the service starts, it registers the machine (`runtimenode.register`, [Spec-002](../specs/002-runtime-node-attach.md)) with its id, that key, its name, its platform and its service version, and the control plane accepts the registration only for a key enrolled to that owner, keeping it on the machine's `runtime_nodes` row, never in `devices`. The machine's `runtimenode.added` statement enters the key in the account's chain: the first machine signs its own, and a later machine's is recorded when a device or machine the account trusts links it.
- Every device the person links pins it. `sidekicks rotate-keys` replaces it, re-enrolling the new key with a `runtimenode.key_rotated` statement signed by both the old and the new key; from that point a statement the old key signs is refused, what it signed before stands, and the old key is never trusted again. A removed machine that is linked again first mints a new identity key under its same machine id, and its new `runtimenode.added` moves every device's pin for that id, as a rotation does; its store, sessions and id stay. A device refuses a known id with a different key unless a `runtimenode.key_rotated` or a later `runtimenode.added` for that id is behind it.
- It certifies each end's X25519 channel key for the Remote Control channel, `Noise_KK_25519_ChaChaPoly_SHA256`; the product builds no construction of its own. The channel is [the channel's decision record](./010-tokens-passkeys-and-the-remote-channel.md)'s and [Spec-028 §The encryption envelope](../specs/028-remote-control.md#the-encryption-envelope)'s.
- The CLI holds no key: signing happens in the daemon.

### Cross-Platform Invariants

The following three invariants hold on every platform and are load-bearing for the correctness of each descent down the ladder.

#### Write-Probe-Read-Delete Invariant

Before accepting the keychain tier on any platform, the service performs:

1. Generate `probe_value = crypto.randomBytes(32)` (256-bit random value).
2. `keyring.set(service="ai-sidekicks-probe", account="tier2-verify", value=probe_value)`.
3. `readback = keyring.get(service="ai-sidekicks-probe", account="tier2-verify")`.
4. Assert `constantTimeEqual(readback, probe_value)`. On mismatch or read failure, treat tier 2 as unavailable and descend to tier 3.
5. `keyring.delete(service="ai-sidekicks-probe", account="tier2-verify")`. Delete failure is logged but non-fatal — the probe value is already discardable and treating delete failure as a custody error would cause spurious refusals on backends with eventual-consistency semantics.

On Windows the cycle runs through the Windows half's `keystore.set`, `keystore.get` and `keystore.delete`, the same code the entry itself is written through. This invariant is the only cross-platform defense against silent backend substitution. `@napi-rs/keyring` has no `isBackendReal()` or `getBackendIdentity()` API — the library treats a silently degraded backend as success from the caller's side. Write-probe-read-delete catches the empirically observed silent-failure modes:

- **Linux keyutils:** the binding is pinned to the Secret Service store, so it never falls back to the kernel session keyring; the D-Bus gate and live probe below decide whether a Secret Service answers at all, and this cycle checks that what it stored reads back.
- **macOS locked keychain:** A locked `login.keychain-db` can return stale-read successes and silently lose newly-written items when the user has declined an unlock prompt. Write-probe-read-delete forces a read of the just-written value and detects the case where the write was accepted by the UI layer but did not persist.
- **Windows policy:** Group Policy can block `CRED_TYPE_GENERIC` writes on managed machines. The write call reports success; subsequent reads fail or return stale values. Write-probe-read-delete detects this within a single synchronous cycle.

#### Refuse-On-Rotation Invariant

The machine's Ed25519 identity key MUST NOT be silently regenerated. Specifically:

- Key generation happens at the service's first start, and again only at `sidekicks rotate-keys` and when a removed machine is linked again.
- Any other path that would find no identity key MUST refuse rather than generate a replacement. `sidekicks rotate-keys` publishes a `runtimenode.key_rotated` statement signed by the old and the new key; a removed machine linked again mints a new key under its same machine id and publishes a new `runtimenode.added` for it. Either way a statement the old key signs afterward is refused, what it signed before stands, and the old key is never trusted again.
- This is load-bearing because every linked device pins the key: a silently rotated key would be refused by each of them ([Spec-028](../specs/028-remote-control.md)), and the machine would drop out of the person's devices until it is linked again.

#### Plaintext-In-Daemon-Memory Only

- The decrypted master key and every private key it unseals live only in the daemon process's memory.
- The CLI binary itself MUST NOT hold a decrypted key — CLI invocations talk to the daemon over the [Spec-006 local IPC contract](../specs/006-local-ipc-and-daemon-control.md) and ask the daemon to sign on their behalf. The one exception is a verb that runs with the service stopped, such as `sidekicks sign-in` sealing the hosted account's refresh token: it seals through the same custody code in its own process and holds nothing after it exits.
- This constraint is inherited from [security-architecture.md §Local Daemon Authentication](../architecture/security-architecture.md#local-daemon-authentication) and is the reason the session token is required (not optional) — if any CLI binary could silently request a private key over IPC, the daemon's confidentiality boundary would collapse into the IPC surface.
- Secret zeroization: the daemon overwrites decrypted key buffers before process exit and at the idle wipe (tiers 1 and 2).

### Platform-Specific Preconditions

#### Linux

- **Hardware tier:** none until a probe on a Linux machine with a TPM chooses between `systemd-creds` and the TPM2 software stack.
- **Environment gate:** require `DBUS_SESSION_BUS_ADDRESS` to be set and point to a reachable socket. Its absence on a headless, container or CI context means no Secret Service can answer; gating on it surfaces the context before any keystore call is made.
- **Live D-Bus probe:** call `org.freedesktop.DBus.GetNameOwner("org.freedesktop.secrets")` with a 2-second timeout. A successful response proves a Secret Service provider is currently running (not just installed — GNOME Keyring daemons can be installed but not started in headless sessions). Probe latency target is ≤ 1.5 seconds in the success case; >2 seconds is treated as failure.
- **Backend disclosure:** on success, log the bus name owner (`org.gnome.keyring`, `org.kde.KWallet5.Service`, `org.keepassxc.KeePassXC.MainWindow`, etc.) so the person knows which backend holds the master key.
- **Write-probe-read-delete** (see above).
- If any of these fail, descend to tier 3. Common contexts on Linux where tier 3 is the realistic outcome: SSH sessions without PAM keyring forwarding, containers, CI runners, and headless servers.
- **Lingering:** a service that starts before login finds the keyring locked and starts locked, as tier 2 says.

#### macOS

- **Hardware tier:** the Secure Enclave wrap needs no code signature, entitlement or keychain entry (measured with an unsigned helper), so tier 1 does not wait on signing.
- **Keychain signing requirement:** the keychain ACL stamped at first write binds to the writing program's code signature (its Designated Requirement). A program whose signature changes, or an unsigned or ad-hoc-signed one, can succeed at writing a keychain item and fail to read it back at a later start. Write-probe-read-delete catches this within the same start; a later start re-runs the cycle and descends to tier 3 as expected.
- **No backend-inspection API:** macOS's `SecKeychain` API exposes no is-backend-real signal. Write-probe-read-delete is the only verification path available for the keychain tier. The Secure Enclave exposes only NIST P-256 key types in Apple's published CryptoKit APIs ([`SecureEnclave.P256.Signing`](https://developer.apple.com/documentation/cryptokit/secureenclave/p256/signing), [`SecureEnclave.P256.KeyAgreement`](https://developer.apple.com/documentation/cryptokit/secureenclave/p256/keyagreement)); there is no `SecureEnclave.Ed25519` equivalent. The enclave key is therefore a P-256 key-agreement key that wraps the master key, and the Ed25519 identity key is sealed under the master key in software.
- **Locked-keychain handling:** a locked keychain that prompts the person for an unlock password is treated as tier-2 available if and only if the prompt completes successfully within a 30-second ceiling. Declining the prompt, or timing out, descends to tier 3. The service MUST NOT bypass the unlock prompt using stored credentials — the bypass failure modes (`security unlock-keychain` with stored passwords) are what CVE-2025-24204 and adjacent keychain CVEs exploit.
- **Write-probe-read-delete** (see above).

#### Windows

- **One implementation:** every custody call on Windows goes through the service's Windows half — as the daemon's child on native Windows, as its resident program on a WSL computer ([ADR-041](./041-the-service-on-wsl-2.md)) — over its channel while the service runs, and through its one-shot `keystore` and `keywrap` verbs while it is stopped.
- **TPM tier:** a user-scoped, non-exportable Platform Crypto Provider key with no PIN wraps the master key. A machine with no TPM descends to tier 2.
- **Wincred / DPAPI disclosure:** the stored credential is encrypted at rest by the user's DPAPI master key (derived from the user's Windows logon credential). This is software-protected — the user account's password is the confidentiality root. DPAPI offers no defense against malware running as the same user. With the TPM tier present, the entry holds the master key already wrapped by the TPM.
- **Local-machine persistence, which the pinned binding does not expose:** `@napi-rs/keyring` 2.1.0 passes only the entry's target to its Windows store, so every entry it writes is `CRED_PERSIST_ENTERPRISE`, which roams to other machines the person signs in to on a Windows domain. The Windows half writes the entry through `windows-native-keyring-store` 1.1.0 with `persistence=local`, so it is `CRED_PERSIST_LOCAL_MACHINE` and stays on this machine.
- **Credential Guard NOT in scope:** Credential Guard protects only domain credentials stored in Credential Manager (Credential Manager's "Generic credentials" — which map to the Win32 `CRED_TYPE_GENERIC` API constant we use — are explicitly unprotected), per [Microsoft's Credential Guard considerations and known issues](https://learn.microsoft.com/en-us/windows/security/identity-protection/credential-guard/considerations-known-issues#saved-windows-credentials-considerations). Our credential type is `CRED_TYPE_GENERIC` and therefore receives no Credential Guard protection. This record does not claim Credential Guard as a layer of defense.
- **Policy probe:** Group Policy can disable `CRED_TYPE_GENERIC` writes on managed machines. The write call returns success regardless; the read-back fails. Write-probe-read-delete detects this within the same synchronous cycle and descends to tier 3.
- **Write-probe-read-delete** (see above).

#### WSL 2

- On a Windows computer whose service runs in a WSL 2 distribution, custody stays on Windows: the daemon inside the distribution reaches the TPM key, Credential Manager and the passphrase file through the service's Windows half, over its channel while the service runs and through the one-shot `keystore` and `keywrap` verbs while it is stopped.
- The distribution's own keyring is never used, so none of the Linux preconditions apply inside it.
- The master key, the machine's identity and the store are the same on either side, and a move between sides moves no custody ([ADR-041](./041-the-service-on-wsl-2.md)).

## Alternatives Considered

### Option A: Hardware wrap → OS keychain → Argon2id file → refuse (Chosen)

- **What:** A custody ladder for the master key with explicit preconditions, write-probe-read-delete verification of the keychain tier, and refusal to start when no tier is available; every daemon private key sealed under the master key.
- **Steel man:** The key opens unattended on every tier but the passphrase file; every transition point is observable; no silent fallback; no silent rotation; a copied data folder or disk image is unreadable elsewhere wherever a chip exists; the file tier lives on widely deployed, audited primitives (the `@noble` stack — `@noble/ciphers` and `@noble/hashes` — is Cure53-audited, with `@noble/curves` additionally audited by Kudelski Security and Trail of Bits, and ships as pure-JS dependencies wherever npm reaches); the refuse tier is a correctness property — a service that silently generated a master key with no custody would lose every key sealed under it at the next start.
- **Weaknesses:** Linux has no hardware tier until a probe; the Windows TPM tier's timings are measured before build; the passphrase tier needs the person after every start.

### Option B: OS keystore only, refuse when unavailable (Rejected)

- **What:** The keychain is the only custody; a machine without a Secret Service, login keychain or Credential Manager cannot run the service.
- **Why rejected:** Keychain availability is patchy on Linux (headless, containers, CI commonly fail its preconditions), and a service that refused there would leave those machines out of the product. The passphrase-file tier keeps them in at an explicitly disclosed weaker custody.

### Option C: Plaintext on disk (Rejected)

- **What:** Store the Ed25519 private key in `$XDG_DATA_HOME/ai-sidekicks/identity.pem` at mode `0600`, no encryption at rest.
- **Why rejected:** Backup systems routinely capture `$HOME/.local/share/*` and upload to cloud storage without encryption. Sync tools (Dropbox, iCloud Drive, OneDrive, Syncthing) replicate the same directory tree across multiple machines the user may not consider part of their identity perimeter. Antivirus software indexes the file. Mode `0600` is defense against same-host non-root attackers only; it provides no defense against the primary threat of backup / sync exfiltration.
- Plaintext files are common CLI practice ([gh](https://github.com/cli/cli)'s `hosts.yml` fallback, [aws](https://github.com/aws/aws-cli)'s `~/.aws/credentials`, [vault](https://github.com/hashicorp/vault)'s file token helper), and the discussion at [cli/cli#10108](https://github.com/cli/cli/issues/10108) shows that practice moving _away_ from plaintext toward stricter handling. The machine identity key's role makes exfiltration here strictly worse than an exfiltrated OAuth token, which can be revoked: a leaked identity key can impersonate this machine to every linked device until `sidekicks rotate-keys` replaces it.

### Option D: age-encrypted file (Rejected)

- **What:** Use [`age`](https://github.com/FiloSottile/age) (passphrase mode) for the tier-3 passphrase file.
- **Why rejected:** `age`'s own [`scrypt.go`](https://github.com/FiloSottile/age/blob/main/scrypt.go) source comment states explicitly that passphrase-mode `age` is "not recommended for automated systems" because the scrypt cost parameters target interactive human use and can be significantly bypassed by an attacker with parallel hardware. Our daemon-driven decryption on every daemon start is precisely the automated-system case `age` warns against. `@noble/hashes` Argon2id with OWASP 2026 parameters is the documented strong choice for automated decryption scenarios.

### Option E: PBKDF2-based file encryption (Rejected)

- **What:** Use PBKDF2-HMAC-SHA256 with high iteration count instead of Argon2id.
- **Why rejected:** PBKDF2 is not memory-hard; GPU and ASIC attackers achieve orders-of-magnitude speedups against PBKDF2 that they cannot replicate against memory-hard KDFs. The [OWASP Password Storage Cheat Sheet (2026)](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) recommends Argon2id as the first choice and lists PBKDF2 only as a fallback when the operating environment cannot accommodate memory-hard KDFs. Our environment (Node.js daemon with the `@noble/*` stack already a dependency — `@noble/hashes` supplies Argon2id) has no such constraint.

### Option F: PAM-based unlocking of `login.keychain` on macOS (Rejected)

- **What:** Rely on PAM-integrated keychain unlock at interactive login to pre-unlock the keychain for the service's later unattended reads.
- **Why rejected:** The PAM integration only applies to interactive login contexts (console login, SSH with PAM keychain module); headless contexts never trigger it. The service must work the same whether or not someone logged in interactively, and the ladder's descent is the uniform mechanism that provides that property. PAM-integrated unlock is not forbidden at tier 2 — if it is how the keychain is already unlocked when the service reads, tier 2 succeeds; the rejection here is of _requiring_ PAM as a custody precondition.

### Option G: A key derived from a passkey's PRF (Rejected)

- **What:** Derive the key that wraps the master key from a WebAuthn passkey ceremony with the PRF extension.
- **Why rejected:** The master key must open with no person present, and a PRF ceremony needs a touch. The product also has no passkey on the desktop: a passkey signs a person in from another device and derives no key. The CLI holds no key of its own to derive, and a second machine runs its own service with its own custody, linked through Remote Control.

### Option H: A passphrase typed at every start (Rejected)

- **What:** Wrap the master key under a passphrase the person enters each time the service starts.
- **Why rejected:** The service starts at login and after a reboot and runs scheduled work with no one present. It remains the tier for a machine with no chip and no keychain (tier 3), where nothing unattended is possible.

### Option I: The Data Protection Keychain with a signed build (Rejected)

- **What:** Keep the macOS entry in the Data Protection Keychain, which needs an Apple-signed bundle and its entitlement.
- **Why rejected:** What it adds over the login keychain is per-item access lists and an optional biometric gate. A biometric gate would stop an unattended service, and the hardware binding comes from the Secure Enclave wrap, which works unsigned (measured).

### Option J: A hardware security module plugin (Rejected)

- **What:** A plugin surface for PKCS#11 tokens or a cloud key service to hold the keys.
- **Why rejected:** Out of scope for one person's own machines. A personal PKCS#11 token also needs a PIN or a touch per use, which an unattended service cannot give.

## Assumptions Audit

| # | Assumption | Evidence | What Breaks If Wrong |
| --- | --- | --- | --- |
| 1 | `@napi-rs/keyring` 2.1.0 remains maintained, and its Secret Service pin keeps it off kernel keyutils. | The binding's store option selects the Linux backend explicitly; the pin is set in code, not inferred. | We would bind the platform keychains directly; the other tiers do not transit this dependency. |
| 2 | `@noble/hashes` Argon2id with OWASP 2026 parameters (`m=19456 KiB, t=2, p=1`) is sufficient against offline brute-force of a person's passphrase. | OWASP Password Storage Cheat Sheet 2026 minimum; Argon2id is the Password Hashing Competition winner and OWASP's first choice, and `@noble/hashes` v2.x ships an audited `argon2id` implementation. | Parameters can be increased in place via the format-version byte + embedded `argon2_m/t/p` fields without a format break. |
| 3 | A Secure Enclave key made by an unsigned helper wraps and unwraps unattended, bound to the Mac. | Measured: key made in 53 ms by an ad-hoc-signed helper; unwrapped in 9 to 20 ms by a second process and by a different unsigned binary; a tampered handle crashes the helper (exit 133), which reads as a refusal. | A Mac where it fails uses tier 2 by design. No silent failure. |
| 4 | A user-scoped Platform Crypto Provider key wraps with no prompt when the Windows half runs from the logon task or as the daemon's child. | **Unvalidated.** Microsoft documents the provider as the TPM key storage provider; the no-prompt behavior and the timings are measured on a Windows machine before build. | Windows machines use tier 2 until it holds; custody stays correct. |
| 5 | `windows-native-keyring-store` with `persistence=local` writes `CRED_PERSIST_LOCAL_MACHINE`, resident and one-shot, on native and WSL computers. | The crate applies its persistence modifier when the secret is written, Enterprise by default. **Unvalidated** on a Windows machine; `cmdkey /list` confirms it before build. | An entry would roam with a domain profile; the probe blocks the build until it holds. |
| 6 | On Linux, `DBUS_SESSION_BUS_ADDRESS` presence + live `GetNameOwner("org.freedesktop.secrets")` reliably predicts a Secret Service that will hold the entry. | (a) env var absent → no Secret Service; (b) present but no owner → no Secret Service; (c) owner but keyring locked → the write may prompt or fail; (d) owner and unlocked → durable. | Case (c) is resolved by write-probe-read-delete. |

## Failure Mode Analysis

| Scenario | Likelihood | Impact | Detection | Mitigation |
| --- | --- | --- | --- | --- |
| A keychain write succeeds but the entry does not persist (a locked keychain, a changed code signature, a policy-blocked write) | Med | Med | Write-probe-read-delete at each custody check | Descent to tier 3 is automatic; the service log names the failed precondition |
| The Linux keyring is locked when a lingering service starts | Med | Med | The key read fails at start | The service starts locked; a run needing sealed content fails its step with `Retry from this step`, and the next read after login succeeds |
| The enclave handle or TPM key is lost or tampered with | Low | High (the master key cannot be unwrapped) | The helper exits or the unwrap fails | The helper's crash is a refusal, not a daemon fault; `sidekicks daemon status` says why; a backup restores with the recovery passphrase ([Spec-013 §Backup Policy](../specs/013-persistence-recovery-and-replay.md#backup-policy)) |
| The machine crashes or loses power during `sidekicks rotate-keys` or a custody change | Low | High (rows sealed under a key no custody entry holds would be unreadable) | At start, the `master_keys` rows and the custody entries named by key id | Nothing is wrapped under a new key until its custody entry is written, verified and recorded, and the old key's entry outlives every blob that names it; start resumes or rolls back the rotation by [Spec-020 §Daemon Master Key](../specs/020-data-retention-and-gdpr.md#daemon-master-key)'s table |
| The person's tier-3 passphrase is weak or reused | Med | High | Out of scope for at-rest storage | Argon2id cost parameters raise the attack-cost floor and can be raised in place via the format-version byte |
| A `@noble` CVE affects the Argon2id KDF or XChaCha20-Poly1305 AEAD | Low | High | GitHub advisory feed, npm audit, dependency scanning in CI, `@noble` release advisories | The cryptography adapter in `packages/crypto` isolates primitive selection; `@noble` versions are pinned |
| The machine's identity key is stolen and used from elsewhere | Low | High | A second live relay connection under one key is flagged; a reused refresh token revokes its whole family, and `sidekicks daemon status` prints that a reused sign-in was detected | `sidekicks rotate-keys` mints a new identity key and re-enrolls it with its `runtimenode.key_rotated` statement, after which a statement the old key signs is refused and the old key is never trusted again |
| The identity key goes missing through storage corruption | Low | Critical (every linked device refuses the machine) | §Refuse-On-Rotation Invariant: a path that finds no identity key refuses rather than regenerating | `sidekicks rotate-keys` is the only replacement, or a restore from backup |

## Reversibility Assessment

- **Reversal cost:** Moderate for tiers 1 and 2 (a different wrap or keychain library; the same re-seal that runs on a custody change moves the master key); moderate for tier 3's file (the `argon2_m/t/p` fields already permit cost upgrades without a format break); very high for the refusal semantics (changing "refuse" to "generate" would lose every sealed key at the next start).
- **Blast radius:** Every machine that runs the service. The master key's custody tier is observable through `sidekicks daemon status`; every daemon private key depends on it.
- **Migration path:** A custody change runs the rotation's steps with no new master key: the current key takes a new key id, its entry on the new tier is written and verified before any blob is re-wrapped, and once every blob names the new id the old id is `retired`, its entry staying until the last backup sealed under it ages out and going at once when no backup names it ([§One Custody Root](#one-custody-root)); nothing is exported by hand.
- **Point of no return:** Once linked devices have pinned the machine's identity key, replacing it requires `sidekicks rotate-keys` and its dual-signed `runtimenode.key_rotated`, or removing the machine and linking it again under a new key with a new `runtimenode.added`; any other replacement drops the machine from every device.

## Consequences

### Positive

- The service opens its keys with no person present on every tier but the passphrase file.
- No silent backend substitution — every tier transition is observable and logged.
- No silent key rotation — the only way to get a new identity key is `sidekicks rotate-keys`, which re-enrolls it with a statement signed by the old and the new key.
- One custody root and one sealing format for every daemon private key, re-sealed together on rotation or a custody change.
- Where a chip exists, a copied data folder or disk image is unreadable on another machine.
- Tier 3 uses a strong, off-the-shelf primitive stack (`@noble/hashes` Argon2id + `@noble/ciphers` XChaCha20-Poly1305).
- Refusal at tier 4 is a correctness property: a service that generated a master key with no custody would lose every sealed key at its next start.
- Cross-platform behavior is uniform at the semantic layer (the same tiers, same invariants), and a Windows computer's custody is the same whichever side runs the service.
- The design does not claim protection the primitives do not provide; §Explicitly NOT Claimed lists what it does not claim.

### Negative (accepted trade-offs)

- The keychain tier's preconditions add up to 2 seconds (the D-Bus probe) to a custody check on Linux, which runs at start and at each custody change, not per command.
- The keychain and passphrase tiers are software-protected and provide no defense against same-user malware; neither does the hardware wrap, which binds the key to this machine, not to the app. An attacker with code execution as the same person can attach to the daemon process and read decrypted keys from memory. Defense against same-user code execution is out of scope.
- The master key reads cost at most 100 ms and one short-lived helper process on macOS (measured: 53 ms to create, 9 to 20 ms to unwrap, plus the helper's start), one keychain read elsewhere, at each start and after each idle wipe; the Windows TPM figures are measured before build.
- The passphrase tier needs the person after every start; a machine on it runs nothing unattended until unlocked.
- Linux has no hardware tier until a probe on a Linux machine with a TPM.

## Explicitly NOT Claimed

This ADR makes the following explicit disclaimers to prevent misreading of the custody properties:

- **Protection against code running as the same person.** No tier stops code running as the same person on the same machine: it can ask the helper or the TPM to unwrap, or read decrypted keys from the daemon's memory.
- **Binding to the app (macOS and Windows).** The Secure Enclave wrap and the TPM wrap bind the master key to this machine, not to the app: another program running as the person on this machine can use the same key handle. What they guarantee is that a copied data folder or disk image does not open elsewhere.
- **Hardware protection of the Ed25519 key itself.** Ed25519 is not a Secure Enclave key type; the Secure Enclave supports only NIST P-256. The identity key is sealed under the master key in software; only the master key's wrap is hardware-bound.
- **Credential Guard protection (Windows).** Credential Guard protects `CRED_TYPE_DOMAIN_PASSWORD` only; our `CRED_TYPE_GENERIC` credential receives no Credential Guard protection. DPAPI wrapping is provided by the OS as an at-rest protection layer, rooted in the user's logon credential, but this is software-protected, not hardware-rooted.
- **Attestation.** Neither the TPM wrap nor the enclave wrap is used to attest the machine to anyone; no HSM is involved anywhere in the custody path.
- **Data Protection Keychain (macOS).** The keychain tier uses the login keychain; it does not provide the Data Protection Keychain's per-item access lists, biometric gate or iCloud sync. (The backups' master-key copy in iCloud Keychain on a Mac is the backup policy's own, separate entry.)
- **A hardware tier on Linux.** None until a probe on a Linux machine with a TPM.

## Decision Validation

### Success Criteria

| Metric | Target | Measurement Method | Check Date |
| --- | --- | --- | --- |
| A master-key read at start or after the idle wipe | ≤ 100 ms and one short-lived helper process on macOS; one keychain read elsewhere | Timed in the key-custody tests on each platform | When the key-custody code lands |
| A keychain tier accepted whose entry does not read back | None | The key-custody tests with the backend stopped, locked or policy-blocked | When the key-custody code lands |
| An identity key regenerated without `sidekicks rotate-keys` | None | A start with the identity row removed refuses rather than minting a key | When the key-custody code lands |
| The Windows TPM wrap: no prompt, and its timings | No prompt; timings recorded | The Windows probe, from the Windows half started by the logon task | Before the Windows custody code is built |
| Local-machine persistence on Windows | `Local machine` for every entry, resident and one-shot, native and WSL | `cmdkey /list` on a Windows machine | Before the Windows custody code is built |

## References

- [The channel's decision record](./010-tokens-passkeys-and-the-remote-channel.md) — the Remote Control channel the machine's identity key certifies.
- [ADR-041: The Service On WSL 2](./041-the-service-on-wsl-2.md) — the service's Windows half, which does custody on Windows for both kinds of Windows computer.
- [Spec-006: Local IPC And Daemon Control](../specs/006-local-ipc-and-daemon-control.md) — session-token contract that bounds CLI access to decrypted key material, and `sidekicks daemon unlock`.
- [Spec-020 §Daemon Master Key](../specs/020-data-retention-and-gdpr.md#daemon-master-key) — the master key and the content keys it wraps.
- [security-architecture.md §Local Daemon Authentication](../architecture/security-architecture.md#local-daemon-authentication) — the daemon-auth model, whose mode-0600 session token is the transport-layer peer of this record's at-rest custody model.
- [`@napi-rs/keyring` 2.1.0](https://github.com/Brooooooklyn/keyring-node) — the keychain binding for macOS and Linux; on Windows it passes only the entry's target, so every entry it writes is Enterprise persistence.
- [`windows-native-keyring-store`](https://crates.io/crates/windows-native-keyring-store) 1.1.0 — the Windows Credential Manager store the Windows half writes through with `persistence=local`.
- [Apple CryptoKit `SecureEnclave.P256.KeyAgreement`](https://developer.apple.com/documentation/cryptokit/secureenclave/p256/keyagreement) — the enclave key type tier 1 wraps the master key to on macOS.
- [Microsoft `NCryptOpenStorageProvider`](https://learn.microsoft.com/en-us/windows/win32/api/ncrypt/nf-ncrypt-ncryptopenstorageprovider) — `MS_PLATFORM_CRYPTO_PROVIDER`, the TPM key storage provider tier 1 uses on Windows.
- [OWASP Password Storage Cheat Sheet (2026 revision)](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) — Argon2id parameter source for tier 3.
- [`@noble/ciphers`](https://github.com/paulmillr/noble-ciphers) — XChaCha20-Poly1305 AEAD implementation (Cure53-audited); [`@noble/hashes`](https://github.com/paulmillr/noble-hashes) — Argon2id KDF implementation (Cure53-audited). Library selection per [ADR-010](./010-tokens-passkeys-and-the-remote-channel.md).
- [age `scrypt.go`](https://github.com/FiloSottile/age/blob/main/scrypt.go) — primary source for Option D rejection ("not recommended for automated systems").
- [HashiCorp Vault file backend](https://github.com/hashicorp/vault) — reference implementation for the write-temp-atomic-rename POSIX pattern used at tier 3.
- [cli/cli#10108](https://github.com/cli/cli/issues/10108) — live discussion of CLI credential-custody industry direction; evidence that Option C (plaintext) is moving from acceptable to deprecated in the CLI ecosystem.
- [Apple Keychain Services](https://developer.apple.com/documentation/security/keychain_services) — macOS keychain ACL and Designated Requirement documentation.
- [Apple CryptoKit `SecureEnclave.P256`](https://developer.apple.com/documentation/cryptokit/secureenclave/p256) — primary source for the claim that Secure Enclave exposes only NIST P-256 key types (no `SecureEnclave.Ed25519` equivalent exists in the published API surface).
- [Apple Secure Enclave platform documentation](https://support.apple.com/guide/security/secure-enclave-sec59b0b31ff/web) — secondary reference; describes the PKA as supporting RSA and ECC without enumerating specific curves.
- [Microsoft Wincred / CredWrite](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credwritew) — `CRED_PERSIST_*` semantics reference.
- [Microsoft Credential Guard — considerations and known issues](https://learn.microsoft.com/en-us/windows/security/identity-protection/credential-guard/considerations-known-issues#saved-windows-credentials-considerations) — primary source for the claim that Credential Manager's "Generic credentials" (mapping to the Win32 `CRED_TYPE_GENERIC` API constant) are unprotected by Credential Guard; only domain credentials receive protection.
- CVE records informing the threat model:
  - [CVE-2023-36004](https://nvd.nist.gov/vuln/detail/CVE-2023-36004) — Windows DPAPI spoofing
  - [CVE-2024-54490](https://nvd.nist.gov/vuln/detail/CVE-2024-54490) — macOS keychain items access
  - [CVE-2025-24204](https://nvd.nist.gov/vuln/detail/CVE-2025-24204) — macOS `gcore` → securityd memory → login keychain master key disclosure
  - [CVE-2025-31191](https://nvd.nist.gov/vuln/detail/CVE-2025-31191) — macOS sandbox escape (keychain-adjacent)
  - [CVE-2025-69277](https://nvd.nist.gov/vuln/detail/CVE-2025-69277) — an Ed25519 point-validation flaw (reported in libsodium); cited for the point-validation threat class applicable to any Ed25519 verifier including `@noble/curves` (informs input validation on read)
  - [CVE-2026-28864](https://nvd.nist.gov/vuln/detail/CVE-2026-28864) — macOS Keychain Access permissions
