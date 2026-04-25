# ADR-021: CLI Identity Key Storage Custody

| Field | Value |
| -------------- | ------------------------------------------------------------------------ |
| **Status** | `accepted` |
| **Type** | `Type 2 (one-way door)` |
| **Domain** | `Security / CLI Identity / Cryptographic Custody` |
| **Date** | `2026-04-18` |
| **Author(s)** | `Claude` |
| **Reviewers** | `Accepted 2026-04-18` |

## Context

[ADR-010](./010-paseto-webauthn-mls-auth.md) chose a long-term Ed25519 identity key per participant as the cryptographic anchor for the V1 relay encryption layer. That key signs each session's ephemeral X25519 public key inside `SessionKeyBundle`, binding the session key exchange to the participant's control-plane-registered identity ([Spec-008 §Relay Encryption](../specs/008-control-plane-relay-and-session-join.md)).

The desktop client derives (or wraps) its Ed25519 identity key from a WebAuthn/passkey PRF ceremony — the passkey's resident key material never leaves the authenticator, and the derived key is reconstructed per session without hitting disk in plaintext.

The CLI ships before the desktop app, has no WebAuthn UI affordance, and therefore cannot use PRF. Its Ed25519 identity key must live at rest somewhere on the operator's workstation. This ADR decides where, how, and under what invariants.

The design is further constrained by an advisor-validated class of failure that is not typically handled by node-level keystore wrappers: the keystore binding can silently succeed against a backend that does not provide the durability or confidentiality properties the caller assumes (e.g., kernel session keyring on Linux instead of Secret Service; locked login keychain on macOS; enterprise-policy-blocked writes on Windows). The chosen design therefore treats a successful keystore `set` call as a claim, not evidence, and requires an explicit write-probe-read-delete verification before accepting tier-1 custody.

## Problem Statement

Where and how should the CLI persist the long-term Ed25519 identity key that ADR-010 requires, across Linux, macOS, and Windows, so that:

1. The key survives daemon restart, host reboot, and CLI re-installation.
2. At-rest exposure is bounded by an OS-native keystore whenever one is present and verifiably functional, and by an Argon2id-encrypted file otherwise.
3. No silent fallback occurs to a backend (kernel keyutils, locked keychain, plaintext disk) that the CLI has not explicitly acknowledged as the current custody tier.
4. The CLI refuses to participate in shared-session E2EE when none of the supported custody tiers can be established, rather than generating an ephemeral key that would break session signature verification on subsequent runs.
5. The design does not claim hardware-rooted protection (Secure Enclave, Credential Guard for generic credentials, TPM binding) that the chosen primitives do not actually provide.

### Trigger

- [BL-057](../backlog.md) names the storage contract gap: ADR-010 references the long-term Ed25519 identity key but does not specify at-rest storage for the CLI, which cannot use WebAuthn PRF.
- The four research passes dispatched 2026-04-18 (Linux headless behavior of `@napi-rs/keyring`; Windows Wincred `CRED_PERSIST_ENTERPRISE` disclosure; macOS Data Protection Keychain eligibility; encrypted-file primitive choice + CLI industry precedent) independently surfaced the same cross-platform gap: `@napi-rs/keyring` does not expose a backend-identity signal on any of its three target platforms. Silent fallback is the dominant failure mode the ADR must defend against.

## Decision

The CLI stores its long-term Ed25519 identity key using a **three-tier custody ladder** with an explicit verification invariant at tier 1 and a loud refusal at tier 3.

### Custody Tiers

#### Tier 1 — OS-native keystore (preferred)

- Transport library: [`@napi-rs/keyring`](https://github.com/Brooooooklyn/keyring-node) (v1.2.0), a thin N-API wrapper over [`keyring-rs`](https://github.com/open-source-cooperative/keyring-rs) (v3.6.3).
- Platform backends:
  - **Linux:** D-Bus Secret Service (GNOME Keyring, KeePassXC, KDE Wallet). Never kernel keyutils at tier 1 — kernel session keyring's reboot-volatile, 3-day TTL semantics are incompatible with a long-term identity key, and `keyring-rs` will silently fall back to it when D-Bus is unreachable.
  - **macOS:** Legacy file-based keychain via `SecKeychainAddGenericPassword` (`login.keychain-db`). Not Data Protection Keychain — Data Protection Keychain requires app entitlements and an Apple-signed bundle path that a Homebrew-installed CLI cannot satisfy in V1.
  - **Windows:** Wincred (DPAPI-wrapped generic credential), persistence level `CRED_PERSIST_ENTERPRISE` (hardcoded by `keyring-rs` at `src/windows.rs:413` — not tunable at the `@napi-rs/keyring` layer).
- **Preconditions (all must hold before tier 1 is accepted):**
  1. Platform-specific availability probe (see [§Cross-Platform Invariants](#cross-platform-invariants)).
  2. Write-probe-read-delete cycle succeeds (see [§Write-Probe-Read-Delete Invariant](#write-probe-read-delete-invariant)).
  3. Platform-specific secondary disclosure emitted to the operator (macOS: Developer-ID signing requirement; Windows: enterprise-wide persistence; Linux: backend name from D-Bus probe).
- If any precondition fails, descend to tier 2. The CLI must log which precondition failed and the concrete remediation hint (e.g., "GNOME Keyring is locked; run `gnome-keyring-daemon --unlock` or fall back to file tier with `--storage=file`").

#### Tier 2 — Argon2id-encrypted file (fallback)

- Cipher: [libsodium](https://libsodium.gitbook.io/doc/) XChaCha20-Poly1305 (AEAD; 24-byte random nonce, 16-byte authentication tag).
- KDF: Argon2id with OWASP 2026 minimum parameters — `m = 19456 KiB (19 MiB)`, `t = 2`, `p = 1`, per the [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).
- Password source: operator-supplied on daemon first start or `cli login`; cached in memory by the daemon for the lifetime of the daemon process only; never written to disk.
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
- The file lives at `$XDG_DATA_HOME/ai-sidekicks/identity.enc` (Linux), `~/Library/Application Support/ai-sidekicks/identity.enc` (macOS), `%APPDATA%\ai-sidekicks\identity.enc` (Windows).

#### Tier 3 — Refuse to participate in shared-session E2EE

- When tier 1 is unavailable *and* tier 2 cannot be established (e.g., no writable data directory, operator declined to set a password in a non-interactive context), the CLI refuses shared-session participation with an actionable diagnostic.
- Local-only sessions remain fully usable — tier 3 only blocks shared-session join and relay-backed flows where ADR-010's Ed25519 identity key is required.
- Refusal message names the failed tiers, the detected platform constraints, and the smallest set of actions the operator can take to reach tier 1 or tier 2.
- No key is generated when tier 3 is active. A key generated at tier 3 would have no durable custody and would rotate on every CLI invocation, breaking every `SessionKeyBundle` signature the participant had previously published.

### Cross-Platform Invariants

The following three invariants hold on every platform and are load-bearing for the correctness of the tier-1 → tier-2 descent.

#### Write-Probe-Read-Delete Invariant

Before accepting a tier-1 outcome on any platform, the CLI must perform:

1. Generate `probe_value = crypto.randomBytes(32)` (256-bit random value).
2. `keyring.set(service="ai-sidekicks-probe", account="tier1-verify", value=probe_value)`.
3. `readback = keyring.get(service="ai-sidekicks-probe", account="tier1-verify")`.
4. Assert `constantTimeEqual(readback, probe_value)`. On mismatch or read failure, treat tier 1 as unavailable and descend to tier 2.
5. `keyring.delete(service="ai-sidekicks-probe", account="tier1-verify")`. Delete failure is logged but non-fatal — the probe value is already discardable and treating delete failure as a custody error would cause spurious refusals on backends with eventual-consistency semantics.

This invariant is the only cross-platform defense against silent backend substitution. `@napi-rs/keyring` has no `isBackendReal()` or `getBackendIdentity()` API — the library treats silent fallback (Linux keyutils, locked macOS keychain, enterprise-policy-blocked Windows Wincred) as successful from the caller's perspective. Write-probe-read-delete catches the three empirically-observed silent-failure modes:

- **Linux silent keyutils:** `keyring-rs` falls back to the kernel session keyring when D-Bus is unreachable. Kernel session keyring is reboot-volatile and expires after 3 days of inactivity; a probe written there does not survive a reboot, but the synchronous write-read cycle succeeds, so this invariant alone does not distinguish keyutils from Secret Service. Linux-specific invariants below (D-Bus environment gate + live probe) handle that distinction; write-probe-read-delete here is the correctness check that both backends share.
- **macOS locked keychain:** A locked `login.keychain-db` can return stale-read successes and silently lose newly-written items when the user has declined an unlock prompt. Write-probe-read-delete forces a read of the just-written value and detects the case where the write was accepted by the UI layer but did not persist.
- **Windows enterprise policy:** Group Policy can block `CRED_PERSIST_ENTERPRISE` writes on managed domains. The write call reports success; subsequent reads fail or return stale values. Write-probe-read-delete detects this within a single synchronous cycle.

#### Refuse-On-Rotation Invariant

The Ed25519 identity key MUST NOT be silently regenerated. Specifically:

- Key generation happens exactly once per workstation, on first CLI identity setup.
- Any subsequent call path that would return "no identity key found" MUST refuse rather than generate a replacement, unless the operator explicitly passed `cli identity rotate` (V1.x: stolen-key reuse detection; see [§Success Criteria](#success-criteria)).
- This is load-bearing because a silently rotated Ed25519 key invalidates every `SessionKeyBundle` signature the participant previously published, and the control plane's rejection path ([Spec-008 §Relay Negotiation](../specs/008-control-plane-relay-and-session-join.md)) would drop the participant from all active shared sessions without a recoverable path.

#### Plaintext-In-Daemon-Memory Only

- The decrypted Ed25519 private key lives only in the daemon process's memory.
- The CLI binary itself MUST NOT hold the decrypted key — CLI invocations talk to the daemon over the [Spec-007 local IPC contract](../specs/007-local-ipc-and-daemon-control.md) and ask the daemon to perform signing operations on their behalf.
- This constraint is inherited from [security-architecture.md §Local Daemon Authentication](../architecture/security-architecture.md) and is the reason the session token is required (not optional) — if any CLI binary could silently request the private key over IPC, the daemon's confidentiality boundary would collapse into the IPC surface.
- Secret zeroization at daemon shutdown: the daemon overwrites the decrypted private-key buffer before process exit and on idle-timeout eviction (see [BL-058 forward declaration](../backlog.md)).

### Platform-Specific Preconditions

#### Linux

- **Environment gate:** require `DBUS_SESSION_BUS_ADDRESS` to be set and point to a reachable socket. Absence of this env var on a headless / CI / Docker / WSL context is the dominant case in which `keyring-rs` falls back silently to kernel keyutils; gating on the env var surfaces the context before any keystore call is made.
- **Live D-Bus probe:** call `org.freedesktop.DBus.GetNameOwner("org.freedesktop.secrets")` with a 2-second timeout. A successful response proves a Secret Service provider is currently running (not just installed — GNOME Keyring daemons can be installed but not started in headless sessions). Probe latency target is ≤ 1.5 seconds in the success case; >2 seconds is treated as failure.
- **Backend disclosure:** on success, log the bus name owner (`org.gnome.keyring`, `org.kde.KWallet5.Service`, `org.keepassxc.KeePassXC.MainWindow`, etc.) so the operator knows which backend is holding their identity.
- **Write-probe-read-delete** (see above).
- If any of these fail, descend to tier 2. Common failure contexts on Linux where tier 2 is the realistic outcome: SSH sessions without PAM keyring forwarding, Docker containers, WSL distributions without `dbus-user-session`, CI runners, and headless servers.

#### macOS

- **Developer-ID signing requirement:** the CLI binary MUST be signed with a Developer-ID certificate matching the Designated Requirement (DR) stamped onto the keychain ACL at first write. An unsigned (Homebrew-built-from-source) or ad-hoc-signed CLI will succeed at writing a keychain item but fail to read it back on a subsequent invocation — the ACL check rejects the caller's code signature. The tier-1 write-probe-read-delete cycle catches this within the same invocation; a fresh invocation of an unsigned build will re-run the cycle and descend to tier 2 as expected.
- **No backend-inspection API:** unlike Electron's [`safeStorage.getSelectedStorageBackend()`](https://www.electronjs.org/docs/latest/api/safe-storage), macOS's `SecKeychain` API exposes no is-backend-real signal. Write-probe-read-delete is the only verification path available. The CLI MUST NOT claim Secure Enclave protection on macOS because Ed25519 is not a Secure Enclave key type — the Secure Enclave exposes only NIST P-256 key types in Apple's published CryptoKit APIs ([`SecureEnclave.P256.Signing`](https://developer.apple.com/documentation/cryptokit/secureenclave/p256/signing), [`SecureEnclave.P256.KeyAgreement`](https://developer.apple.com/documentation/cryptokit/secureenclave/p256/keyagreement)); there is no `SecureEnclave.Ed25519` equivalent. Apple's [Secure Enclave platform documentation](https://support.apple.com/guide/security/secure-enclave-sec59b0b31ff/web) describes the PKA as supporting RSA and ECC but does not further enumerate curves. Ed25519 private-key storage in `login.keychain-db` is software-protected at rest (macOS login-password-derived KEK), not hardware-protected.
- **Locked-keychain handling:** a locked keychain that prompts the user for an unlock password is treated as tier-1 available if and only if the prompt completes successfully within a 30-second ceiling. Declining the prompt, or timing out, descends to tier 2. The CLI MUST NOT bypass the unlock prompt using stored credentials — the bypass failure modes (`security unlock-keychain` with stored passwords) are what CVE-2025-24204 and adjacent keychain CVEs exploit.
- **Write-probe-read-delete** (see above).

#### Windows

- **Wincred / DPAPI disclosure:** the stored credential is encrypted at rest by the user's DPAPI master key (derived from the user's Windows logon credential). This is software-protected — the user account's password is the confidentiality root. DPAPI offers no defense against malware running as the same user. This is stronger than plaintext on disk but weaker than Credential Guard or a TPM-bound key.
- **`CRED_PERSIST_ENTERPRISE` is not tunable:** `keyring-rs` hardcodes `CRED_PERSIST_ENTERPRISE` at `src/windows.rs:413`. This means the credential can roam to other machines the same user logs into on the same Windows domain (domain-credential roaming). For a single-user workstation CLI this is functionally equivalent to `CRED_PERSIST_LOCAL_MACHINE`; for a domain-joined workstation the credential may reach other machines the user logs into. The disclosure is logged on first write so an enterprise operator can descend to tier 2 explicitly with `--storage=file` if the roaming behavior is undesirable.
- **Credential Guard NOT in scope:** Credential Guard protects only domain credentials stored in Credential Manager (Credential Manager's "Generic credentials" — which map to the Win32 `CRED_TYPE_GENERIC` API constant we use — are explicitly unprotected), per [Microsoft's Credential Guard considerations and known issues](https://learn.microsoft.com/en-us/windows/security/identity-protection/credential-guard/considerations-known-issues#saved-windows-credentials-considerations). Our credential type is `CRED_TYPE_GENERIC` and therefore receives no Credential Guard protection. The ADR MUST NOT claim Credential Guard as a layer of defense for the CLI identity key.
- **Enterprise-policy probe:** Group Policy can disable `CRED_TYPE_GENERIC` writes on managed workstations. The write call returns success regardless; the read-back fails. Write-probe-read-delete detects this within the same synchronous cycle and descends to tier 2.
- **Write-probe-read-delete** (see above).

## Alternatives Considered

### Option A: OS keystore → Argon2id file → refuse (Chosen)

- **What:** Three-tier ladder with explicit preconditions, write-probe-read-delete verification, and refusal to generate an ephemeral key when no tier is available.
- **Steel man:** Every transition point is observable; no silent fallback; no silent rotation; the file tier lives on widely-deployed primitives (libsodium is audited and packaged everywhere); the refuse tier is a correctness property, not a UX failure — a CLI that silently regenerates an Ed25519 identity key would invalidate every prior session signature without a recovery path.

### Option B: OS keystore only, refuse when unavailable (Rejected)

- **What:** Tier 1 is the only custody; operators without Secret Service / Keychain / Wincred cannot participate in shared sessions.
- **Why rejected:** Tier-1 availability is realistically patchy on Linux (headless, Docker, WSL, CI all commonly fail tier-1 preconditions) and on macOS (unsigned / Homebrew-from-source builds fail Developer-ID-signing preconditions). A rejection rate at first-run that approached the fraction of Linux operators on SSH / WSL / Docker would render the CLI effectively unusable in V1. Tier 2 is the bridge that keeps those operators in the product at an explicitly-disclosed weaker-tier custody.

### Option C: Plaintext on disk (Rejected)

- **What:** Store the Ed25519 private key in `$XDG_DATA_HOME/ai-sidekicks/identity.pem` at mode `0600`, no encryption at rest.
- **Why rejected:** Backup systems routinely capture `$HOME/.local/share/*` and upload to cloud storage without encryption. Sync tools (Dropbox, iCloud Drive, OneDrive, Syncthing) replicate the same directory tree across multiple machines the user may not consider part of their identity perimeter. Antivirus software indexes the file. Mode `0600` is defense against same-host non-root attackers only; it provides no defense against the primary threat of backup / sync exfiltration.
- This option is the industry-standard CLI practice as of 2026-04 ([gh](https://github.com/cli/cli)'s `hosts.yml` fallback, [aws](https://github.com/aws/aws-cli)'s `~/.aws/credentials`, [vault](https://github.com/hashicorp/vault)'s file token helper), and the ongoing discussion at [cli/cli#10108](https://github.com/cli/cli/issues/10108) shows the industry moving *away* from plaintext toward stricter handling. Adopting Option C would be aligned with 2020–2025 practice but out of step with the 2026+ direction, and the Ed25519 identity key's session-signature role means exfiltration here is a strictly worse outcome than exfiltrated OAuth tokens (which can be revoked) — a leaked Ed25519 identity key can forge `SessionKeyBundle` signatures until the operator rotates on every workstation that holds the key.

### Option D: age-encrypted file (Rejected)

- **What:** Use [`age`](https://github.com/FiloSottile/age) (passphrase mode) for the tier-2 encrypted file.
- **Why rejected:** `age`'s own [`scrypt.go`](https://github.com/FiloSottile/age/blob/main/scrypt.go) source comment states explicitly that passphrase-mode `age` is "not recommended for automated systems" because the scrypt cost parameters target interactive human use and can be significantly bypassed by an attacker with parallel hardware. Our daemon-driven decryption on every daemon start is precisely the automated-system case `age` warns against. libsodium Argon2id with OWASP 2026 parameters is the documented strong choice for automated decryption scenarios.

### Option E: PBKDF2-based file encryption (Rejected)

- **What:** Use PBKDF2-HMAC-SHA256 with high iteration count instead of Argon2id.
- **Why rejected:** PBKDF2 is not memory-hard; GPU and ASIC attackers achieve orders-of-magnitude speedups against PBKDF2 that they cannot replicate against memory-hard KDFs. The [OWASP Password Storage Cheat Sheet (2026)](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) recommends Argon2id as the first choice and lists PBKDF2 only as a fallback when the operating environment cannot accommodate memory-hard KDFs. Our environment (Node.js daemon with libsodium already a dependency via `@noble/*`) has no such constraint.

### Option F: PAM-based unlocking of `login.keychain` on macOS (Rejected for CLI)

- **What:** Rely on PAM-integrated keychain unlock at interactive login to pre-unlock the keychain for the CLI's subsequent non-interactive writes.
- **Why rejected for CLI:** The PAM integration only applies to interactive login contexts (console login, SSH with PAM keychain module). Headless CI and Docker-for-Mac contexts never trigger PAM keychain unlock. The V1 CLI must work identically across interactive and non-interactive contexts, and tier-2 fallback is the uniform mechanism that provides that property. PAM-integrated unlock is not forbidden at tier 1 — if it happens to be the mechanism by which the keychain is already unlocked at CLI invocation time, tier 1 will succeed; the rejection here is of *requiring* PAM as a custody precondition.

## Assumptions Audit

| # | Assumption | Evidence | What Breaks If Wrong |
|---|-----------|----------|----------------------|
| 1 | `@napi-rs/keyring` v1.2.0 remains maintained and tracks `keyring-rs` upstream. | Active release cadence observed 2025-09-02 v1.2.0 matched to `keyring-rs` v3.6.3; repo has multi-year release history; maintainer (napi-rs org) ships monthly N-API updates. | We would re-wrap `keyring-rs` directly via N-API, a multi-week but bounded engineering task. Tier-2 is unaffected because it does not transit this dependency. |
| 2 | `libsodium` Argon2id with OWASP 2026 parameters (`m=19456 KiB, t=2, p=1`) is sufficient against offline brute-force for a CLI operator-password threat model. | OWASP Password Storage Cheat Sheet 2026 minimum; libsodium ships Argon2id by default and is the reference implementation cited in PHC winner selection. | Parameters can be increased in-place via the format-version byte + embedded `argon2_m/t/p` fields without a format break. Upgrading tier-2 cost is a non-breaking change. |
| 3 | On macOS, a Developer-ID-signed CLI can pass the Designated Requirement ACL check without requiring Data Protection Keychain entitlements. | Apple's [Keychain Services docs](https://developer.apple.com/documentation/security/keychain_services) describe DR-based ACL matching for the legacy keychain path. Data Protection Keychain's stricter ACL model requires an entitlement not available to a Homebrew-installed CLI. | If Developer-ID alone proves insufficient on some macOS version we ship through, tier 1 fails consistently on that version and all affected users land on tier 2 by design. No silent failure. |
| 4 | `CRED_PERSIST_ENTERPRISE` domain-credential roaming is acceptable for a workstation-scoped CLI identity key on most Windows deployments. | Microsoft Credential Manager docs describe enterprise persistence as roaming within the same user's domain profile; single-user and home-edition workstations behave identically to `LOCAL_MACHINE`. | Enterprise operators who need stricter locality can invoke `--storage=file` to use tier 2, which is local-disk by design. The disclosure-on-first-write mechanism makes this opt-out explicit. |
| 5 | On Linux, `DBUS_SESSION_BUS_ADDRESS` presence + live `GetNameOwner("org.freedesktop.secrets")` probe reliably predicts tier-1 write durability. | Four-way correspondence observed in research: (a) env var absent → keyutils silent fallback always; (b) env var present but GetNameOwner returns no owner → keyutils silent fallback or ephemeral daemon; (c) env var present + GetNameOwner returns owner but keyring locked → tier-1 write prompts for unlock, may fail; (d) env var present + GetNameOwner returns owner + keyring unlocked → tier 1 durable. | Cases (c) and (d) are ambiguous from the D-Bus probe alone; write-probe-read-delete resolves the ambiguity in (c) by catching the prompt-decline / lock-reject case. Combined invariant is empirically complete for the observed failure set. |

## Failure Mode Analysis

| Scenario | Likelihood | Impact | Detection | Mitigation |
|----------|-----------|--------|-----------|------------|
| Linux CLI silently binds to kernel keyutils and loses key on reboot | Would be Med | High | Environment gate + live D-Bus probe + write-probe-read-delete | Preconditions catch the case pre-write; even if all three were bypassed, the 3-day keyutils TTL would cause key-loss within days and §Refuse-On-Rotation Invariant prevents silent regeneration |
| macOS keychain write succeeds, read fails on next invocation due to unsigned binary | Med | Med | Write-probe-read-delete on every invocation | Tier-1 fails on the next invocation of the same unsigned build; user is routed to tier 2 or to signing the binary |
| Windows Group Policy blocks `CRED_TYPE_GENERIC` writes on managed workstation | Low–Med (depends on deployment mix) | Med | Write-probe-read-delete detects blocked writes within a single invocation | Tier-2 descent is automatic; disclosure message names GP as likely cause |
| Operator's tier-2 password is weak / reused | Med | High | Out of scope for at-rest storage — handled by operator-education materials outside this ADR | Argon2id cost parameters raise GPU/ASIC attack cost floor; parameters can be upgraded in place via format-version byte |
| libsodium CVE affects Argon2id KDF or XChaCha20-Poly1305 AEAD | Low | High | GitHub advisory feed, npm audit, dependency scanning in CI, libsodium release notes | Cryptography adapter layer in `packages/crypto` (per ADR-010) isolates primitive selection; libsodium version is pinned |
| Ed25519 private key exfiltrated via backup / cloud sync of the file-tier directory | Low at tier 1 (keystore-held); Med at tier 2 (backup systems can capture the file) | High | Out-of-band — operator notices unexpected `SessionKeyBundle` signatures from another machine (stolen-key reuse detection, V1.x) | Tier 2 is Argon2id-encrypted, so backup-captured file resists offline brute-force per OWASP 2026 parameters; stolen-key detection provides response capability |
| Tier-3 refuse-to-participate misfires and blocks a user whose tier-2 could have succeeded | Low | Med | CLI refusal message names the specific precondition that failed; operator telemetry (opt-in) tracks tier-3 rate | Clear remediation hint in the refusal message; `--storage=file` flag forces tier-2 attempt explicitly |
| Silent rotation of Ed25519 key due to storage corruption or path migration | Low | Critical (all prior session signatures become unverifiable) | §Refuse-On-Rotation Invariant: any "no identity found" path without `cli identity rotate` flag must refuse, not regenerate | Explicit `cli identity rotate` command is the only silent-rotation-safe path; control-plane revocation + re-enrollment flow covers the intentional rotation case |

## Reversibility Assessment

- **Reversal cost:** Moderate for tier 1 (rewrite the keystore adapter to use a different library; existing keys can be exported and re-imported), high for tier 2 (format change would require a file-version migration step with the old password still valid for the old file), very high for tier 3 refusal semantics (changing "refuse" to "generate ephemeral" would silently break all prior session signatures product-wide).
- **Blast radius:** Every CLI installation that has run `cli login` at least once. On-disk file-tier files carry the format version; tier-1 custody state is opaque in the keystore but observable via the write-probe-read-delete cycle.
- **Migration path:** For tier-2 format changes, add a new version byte and keep both paths live for one LTS window — the `argon2_m/t/p` fields already permit cost upgrades without a format break, so the expected migration is not a format change but a parameter raise.
- **Point of no return:** Once an Ed25519 identity key has been published as the signer of a live `SessionKeyBundle` in the control plane, rotating that key requires either (a) an explicit `cli identity rotate` flow with control-plane acknowledgment or (b) the stolen-key reuse detection + forced-revocation path (V1.x).

## Consequences

### Positive

- No silent backend substitution — every tier transition is observable and logged.
- No silent key rotation — the only way to get a new Ed25519 identity key is `cli identity rotate`, which triggers the control-plane re-enrollment path.
- Tier 2 uses a strong, off-the-shelf primitive stack (libsodium Argon2id + XChaCha20-Poly1305) that survives dependency-compromise scenarios that target any single upstream.
- Refusal at tier 3 is a correctness property: a CLI that silently generates ephemeral keys would be indistinguishable from a misconfigured one, and would silently invalidate prior session signatures.
- Cross-platform behavior is uniform at the semantic layer (three tiers, same invariants) while allowing the platform-specific preconditions to differ.
- The design does not claim hardware-rooted protection the primitives do not provide. "Explicitly NOT claimed" disclosures below prevent the ADR from being cited as evidence of claims it does not make.

### Negative (accepted trade-offs)

- Tier-1 preconditions add 1–2 seconds of startup latency on Linux (D-Bus probe) per CLI invocation. Acceptable for a CLI whose per-invocation latency target is 5 seconds and whose successful tier-1 case is expected to dominate desktop-operator runs.
- Tier-2 is software-protected and provides no defense against same-user malware. The encrypted file plus `0600` perms plus `0700` directory is the standard defensive stack for CLI secrets at rest on unsandboxed general-purpose OSes, but an attacker with code execution as the same user can attach to the daemon process and read the decrypted key from memory. Defense against same-user code execution is out of scope for a CLI identity key — that threat model requires process isolation and OS-mediated attestation outside the V1 scope (see §V1.x Forward Declarations).
- The ADR intentionally does not ship TPM-bound Windows storage in V1. Enterprise operators who require TPM attestation for their identity keys will wait until V1.x (see forward declarations below).
- Developer-ID signing is a shipping prerequisite on macOS to make tier 1 reachable for end users. Unsigned / Homebrew-from-source builds function correctly, but always land on tier 2, not tier 1. This is explicitly disclosed in the CLI first-run banner on macOS.

## Explicitly NOT Claimed

This ADR makes the following explicit disclaimers to prevent misreading of the custody properties:

- **Secure Enclave protection (macOS).** Ed25519 is not a Secure Enclave key type; the Secure Enclave supports only NIST P-256 (per Apple's Secure Enclave documentation). The CLI Ed25519 identity key on macOS is software-protected by the login-keychain KEK, which is derived from the login password. No hardware root of trust is claimed for this key.
- **Credential Guard protection (Windows).** Credential Guard protects `CRED_TYPE_DOMAIN_PASSWORD` only; our `CRED_TYPE_GENERIC` credential receives no Credential Guard protection. DPAPI wrapping is provided by the OS as an at-rest protection layer, rooted in the user's logon credential, but this is software-protected, not hardware-rooted.
- **TPM-bound key material (all platforms).** V1 makes no use of TPM 2.0 for key wrapping. The file tier's KDF is pure software (Argon2id). TPM integration is a V1.x forward declaration.
- **Hardware-attested offline root signing (all platforms).** No HSM is involved in the CLI key custody path. Enterprise / compliance contexts requiring HSM-rooted attestation will need the V1.x hardware plugin points (see forward declarations).
- **Data Protection Keychain (macOS).** V1 uses the legacy file-based keychain (`login.keychain-db`) via `SecKeychainAddGenericPassword`. Data Protection Keychain migration is a V1.x forward declaration; V1 does not provide its stricter ACL, its per-item encryption, or its relocatable-iCloud-sync properties.

## V1.x Forward Declarations

The following are explicitly deferred past V1 and are recorded here so downstream readers can see the upgrade envelope this ADR leaves room for.

- **TPM-wrap on Windows.** Adopt Windows 10+ Credential Management API with TPM 2.0 virtual smart card or direct `NCryptCreatePersistedKey` with `NCRYPT_PREFER_VIRTUAL_ISOLATION_FLAG` + `NCRYPT_MACHINE_KEY_FLAG` to bind the Ed25519 identity key to the workstation's TPM. Precondition: TPM 2.0 present + user has TPM-enabled; fallback remains tier 2. Invariant: ADR-021's three-tier structure extends to a four-tier structure with TPM-bound at tier 0 and existing tiers unchanged.
- **Data Protection Keychain on macOS.** Migrate from legacy `login.keychain-db` to Data Protection Keychain once the CLI ships as a bundled Apple-signed application (not Homebrew-installed source build). This raises the macOS at-rest protection from login-password-derived software KEK to per-item ACL with optional biometric gate.
- **WebAuthn PRF for the CLI.** Once desktop + CLI pairing UX lands (V1.x), the CLI can derive its Ed25519 identity key from a desktop-mediated WebAuthn PRF ceremony, matching the desktop's custody model. Pairing UX is the gating item — the CLI cannot drive a WebAuthn ceremony on its own.
- **Hardware security module plugin points.** Generic plugin surface for HSM-backed key operations (PKCS#11, Azure Key Vault HSM, AWS KMS CMK). Targets enterprise deployments where the Ed25519 identity key must stay in an HSM boundary. Tier structure unchanged; HSM lives above tier 0 as an enterprise-only additional tier.

## Decision Validation

### Pre-Implementation Checklist

- [x] All unvalidated assumptions have a validation plan (see Assumption 3 — Developer-ID ACL on macOS; Assumption 5 — Linux D-Bus probe completeness).
- [x] At least one alternative was seriously considered and steel-manned (Options B, C, D, E, F above).
- [x] Antithesis was reviewed by someone other than the author (Opus 4.7 BL-057 review pass, Session D1 close-out 2026-04-18 — blocking citation errors surfaced in B1–B4 resolved in the same session).
- [x] Failure modes have detection mechanisms (see Failure Mode Analysis table).
- [x] Point of no return is identified and communicated (silent key rotation would invalidate all prior session signatures — §Refuse-On-Rotation Invariant).

### Success Criteria

| Metric | Target | Measurement Method | Check Date |
|--------|--------|--------------------|------------|
| Tier-3 refusal rate at first `cli login` on fresh installs | ≤ 3% across Linux/macOS/Windows mix | Opt-in CLI first-run telemetry | `2026-10-01` |
| Silent key rotation incidents | 0 | Control-plane `SessionKeyBundle` signature-verification-failure logs correlated with CLI invocation telemetry | `2026-12-01` |
| Tier-1 write-probe-read-delete false-positive rate (tier 1 accepted, subsequent read fails) | ≤ 1 per 10,000 tier-1 acceptances | CLI error telemetry cross-referenced with daemon identity-key-read failures | `2026-12-01` |
| Stolen-key reuse detection | V1.x implementation begins | Control-plane-side detection (same Ed25519 pubkey from distinct workstations with overlapping session liveness) | `2027-03-01` |

## References

- [ADR-010: PASETO / WebAuthn / MLS Authentication Stack](./010-paseto-webauthn-mls-auth.md) — defines the Ed25519 identity key this ADR stores.
- [Spec-008 §Relay Encryption](../specs/008-control-plane-relay-and-session-join.md) — describes the `SessionKeyBundle` Ed25519 signing role.
- [Spec-007: Local IPC And Daemon Control](../specs/007-local-ipc-and-daemon-control.md) — session-token contract that bounds CLI access to decrypted key material.
- [security-architecture.md §Local Daemon Authentication](../architecture/security-architecture.md) — authoritative daemon-auth model whose mode-0600 session token is the transport-layer peer of this ADR's at-rest custody model.
- [`@napi-rs/keyring` v1.2.0](https://github.com/Brooooooklyn/keyring-node) — transport library for tier 1.
- [`keyring-rs` v3.6.3](https://github.com/open-source-cooperative/keyring-rs) — wrapped backend; `src/windows.rs:413` is the `CRED_PERSIST_ENTERPRISE` hardcoding site.
- [OWASP Password Storage Cheat Sheet (2026 revision)](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) — Argon2id parameter source for tier 2.
- [libsodium documentation](https://libsodium.gitbook.io/doc/) — XChaCha20-Poly1305 AEAD and Argon2id KDF reference implementation.
- [age `scrypt.go`](https://github.com/FiloSottile/age/blob/main/scrypt.go) — primary source for Option D rejection ("not recommended for automated systems").
- [HashiCorp Vault file backend](https://github.com/hashicorp/vault) — reference implementation for the write-temp-atomic-rename POSIX pattern used at tier 2.
- [cli/cli#10108](https://github.com/cli/cli/issues/10108) — live discussion of CLI credential-custody industry direction; evidence that Option C (plaintext) is moving from acceptable to deprecated in the CLI ecosystem.
- [Apple Keychain Services](https://developer.apple.com/documentation/security/keychain_services) — macOS keychain ACL and Designated Requirement documentation.
- [Apple CryptoKit `SecureEnclave.P256`](https://developer.apple.com/documentation/cryptokit/secureenclave/p256) — primary source for the claim that Secure Enclave exposes only NIST P-256 key types (no `SecureEnclave.Ed25519` equivalent exists in the published API surface).
- [Apple Secure Enclave platform documentation](https://support.apple.com/guide/security/secure-enclave-sec59b0b31ff/web) — secondary reference; describes the PKA as supporting RSA and ECC without enumerating specific curves.
- [Microsoft Wincred / CredWrite](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credwritew) — `CRED_PERSIST_*` semantics reference.
- [Microsoft Credential Guard — considerations and known issues](https://learn.microsoft.com/en-us/windows/security/identity-protection/credential-guard/considerations-known-issues#saved-windows-credentials-considerations) — primary source for the claim that Credential Manager's "Generic credentials" (mapping to the Win32 `CRED_TYPE_GENERIC` API constant) are unprotected by Credential Guard; only domain credentials receive protection.
- [Electron `safeStorage.getSelectedStorageBackend()`](https://www.electronjs.org/docs/latest/api/safe-storage) — referenced for absence of equivalent on macOS / Windows direct keychain APIs.
- CVE records informing the threat model:
  - [CVE-2023-36004](https://nvd.nist.gov/vuln/detail/CVE-2023-36004) — Windows DPAPI spoofing
  - [CVE-2024-54490](https://nvd.nist.gov/vuln/detail/CVE-2024-54490) — macOS keychain items access
  - [CVE-2025-24204](https://nvd.nist.gov/vuln/detail/CVE-2025-24204) — macOS `gcore` → securityd memory → login keychain master key disclosure
  - [CVE-2025-31191](https://nvd.nist.gov/vuln/detail/CVE-2025-31191) — macOS sandbox escape (keychain-adjacent)
  - [CVE-2025-69277](https://nvd.nist.gov/vuln/detail/CVE-2025-69277) — libsodium Ed25519 point validation (informs input validation on read)
  - [CVE-2026-28864](https://nvd.nist.gov/vuln/detail/CVE-2026-28864) — macOS Keychain Access permissions

## Decision Log

| Date | Event | Notes |
|------|-------|-------|
| 2026-04-18 | Proposed | Initial draft resolving [BL-057](../backlog.md). Three-tier custody ladder with write-probe-read-delete invariant. Research-informed via 4 Opus 4.7 passes (Linux silent-keyutils, Windows `CRED_PERSIST_ENTERPRISE` hardcoding, macOS no-backend-inspection / no-Secure-Enclave, encrypted-file primitive selection + CLI industry precedent). |
| 2026-04-18 | Amended | Opus 4.7 BL-057 review pass resolved blocking citation errors: `keyring-rs` hardcoding line corrected to `src/windows.rs:413` (v3.6.3); age scrypt path corrected to root `scrypt.go` (quoted phrase verbatim preserved); Credential Guard URL updated to `considerations-known-issues` (the page that actually states Generic-credentials are unprotected); Secure Enclave citation expanded to cite CryptoKit `SecureEnclave.P256` API surface as primary source with sec59b0b31ff retained as secondary. `@napi-rs/keyring` release-date removed (npm signal inconsistent with research claim); `hwchen/keyring-rs` URL updated to canonical `open-source-cooperative/keyring-rs`. Antithesis-review checkbox flipped. |
| 2026-04-18 | Accepted | ADR accepted at Session D1 close-out. BL-057 Exit Criteria satisfied: ADR-010 amended with §CLI Identity Key Storage cross-reference; security-architecture.md cites fallback order; Spec-008 references storage contract. |
