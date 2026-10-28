# ADR-020: Machine Identity Key Custody

| Field         | Value                                                 |
| ------------- | ----------------------------------------------------- |
| **Status**    | `accepted`                                            |
| **Type**      | `Type 2 (one-way door)`                               |
| **Domain**    | `Security / Machine Identity / Cryptographic Custody` |
| **Date**      | `2026-04-18`                                          |
| **Author(s)** | `Claude`                                              |
| **Reviewers** | `Accepted 2026-04-18`                                 |

## Context

Each machine the person uses runs one background service, and that service holds the machine's secrets: its Ed25519 identity key, which every one of the person's devices pins as this machine and which certifies the machine's end of the Remote Control channel ([Spec-027 §The encryption envelope](../specs/027-remote-control.md#the-encryption-envelope)), and its X25519 channel key; the hosted account's DPoP key and its refresh token; and the secrets the person hands it, from a pasted provider token to a tool server's sign-in. The custody question is where each of them lives at rest.

The service runs unattended. It starts at login, comes back after a reboot and runs scheduled workflows with no one present, and on Linux with lingering it may start before the person logs in. A secret that needs a touch or a typed passphrase at every start would stop all of that. The CLI holds no key of its own: it talks to the daemon on the same machine through the daemon's socket ([Spec-006](../specs/006-local-ipc-and-daemon-control.md)).

A keystore binding can silently succeed against a backend that does not provide the durability or confidentiality the caller assumes: a kernel session keyring on Linux, a locked login keychain on macOS, a policy-blocked write on Windows. The design therefore treats a successful keystore `set` call as a claim, not evidence, and verifies the store with a write-probe-read-delete cycle before accepting it.

## Problem Statement

Where does the service keep each of its secrets, on macOS, Linux and Windows — including a Windows computer with sessions in WSL 2 distributions — so that:

1. Every secret opens with no person present, at every start and after a reboot.
2. Every secret is protected by the computer, in the operating system's credential store on macOS and Windows and sealed to the computer on Linux, and nothing in the daemon's database is encrypted by the app.
3. No silent fallback occurs to a backend (kernel keyutils, a locked keychain) the service has not verified, and the person can see where secrets are kept.
4. A Linux machine whose systemd cannot seal still runs the service.
5. The service mints no key that the store has not taken, rather than a key that would not open at the next start.
6. The design claims no protection the chosen store does not provide.

### Trigger

- The service is the person's own background service and must open its secrets with no one present.
- `keyring-core` exposes no backend-identity signal on any platform, a Linux program can choose the kernel keyring's store, which is cleared at every restart, and `windows-native-keyring-store` writes every entry at Enterprise persistence unless told otherwise. Silent fallback remains the dominant failure the design defends against.

## Decision

The service keeps **each secret as its own item**, written in its own process through `sidekicks-platforms`: on macOS and Windows in the operating system's credential store through `keyring-core` with the platform's store, the login keychain on macOS and Credential Manager on Windows, with or without WSL; on Linux in one file in its own data folder, readable by this account alone, each item sealed through systemd's credential service for this user, which opens with nobody present at every start. Where that service is absent, refuses to seal at the first start, or would bind the seal to the Secure Boot state, the file is plain, and it is sealed once a later start finds the service sealing unbound; the pick is recorded in the data folder, so a later start keeps it; a Mac keeps them in the same file, plain, from the logged-out service's takeover until `sidekicks daemon uninstall` moves them back, including after that service is turned off in Login Items & Extensions, because its logged-out service cannot reach the login keychain. A write-probe-read-delete cycle verifies the store before the service accepts it. Nothing in the daemon's database is encrypted by the app.

### The Credential Store

- **The items.** Each of these is its own item: the machine's Remote Control identity key and its channel key; the hosted sign-in's refresh token and DPoP key; a pasted provider token ([ADR-026](./026-provider-credential-custody-posture.md)); a workflow secret, the notification web address and its signing secret, and the mail password ([ADR-036](./036-workflow-secrets-in-the-os-keychain.md)); and each tool server sign-in's refresh token and DPoP key ([ADR-038](./038-mcp-credential-custody.md)).
- **macOS:** the login keychain, through [`keyring-core`](https://crates.io/crates/keyring-core) 1.0.1 with `apple-native-keyring-store` 1.0.2.
- **Linux:** one file, `secrets.json` in the service's own data folder, readable by this account alone (mode `0600`, inside a parent directory at `0700`), each item sealed through systemd's credential service for this user (systemd 256 or newer). `sidekicks-platforms` calls it with its own client: one connection per call to `/run/systemd/io.systemd.Credentials`, one JSON message ended by a NUL byte each way, `io.systemd.Credentials.Encrypt` and `Decrypt` with `scope: "user"` and nothing that would ask polkit, so no prompt is ever shown, and every buffer holding a value wiped on drop. The service seals with the computer's security chip and systemd's system key where the computer has a chip systemd can use, and with the system key alone where not; each blob's header names its key, so the key kind is read, never recorded. Each item is its own credential, named for its keychain service and a hash of its account, so a read opens only the item it needs and a blob moved into another item's slot refuses. The desktop keyring, which opens only after a password login, and the kernel keyring, which is cleared at every restart, are never used.
- **Linux where systemd cannot seal:** the file is plain, as `gh` and Codex keep theirs, where the credential service is absent (systemd older than 256, no systemd, most containers), where it refuses to seal at the first start (no such user, no key it can keep, or a build without the cipher), and where its seal would be bound to the Secure Boot state (systemd 256 and 257 with a chip bind the seal to PCR 7, which a Secure Boot update changes). A later start whose check finds the service sealing with no such binding seals every item once, in one atomic replace of the file, and abandons the pass, keeping the old file, if any new blob would be weaker than the one it replaces; an item sealed with the chip is never sealed again with the system key alone. The pick, and on a Mac a move's direction, is kept in the data folder's place record, `secrets-place.json` (mode `0600`), so a later start keeps the pick whatever it finds, and a record that cannot be read refuses every call and is left as it is. Each write goes to a temporary file with those permissions, is flushed with `fsync` and renamed over the target, so the file is never seen half-written, and the file is deleted with its last item. It never falls back silently: Settings › Runtime and `sidekicks daemon status` show one notice under the service's own, a title over one short line saying how the secrets are protected or why the sealed file cannot be opened, and under the line that file's path in its own row ([Spec-020 §Daemon Secrets](../specs/020-data-retention-export-and-deletion.md#daemon-secrets)).
- **macOS with the service running while the person is logged out:** `sidekicks daemon install --while-signed-out` installs a system service that runs the daemon before login and after logout ([Spec-006 §The service on a Mac while logged out](../specs/006-local-ipc-and-daemon-control.md#the-service-on-a-mac-while-logged-out)). A process outside a user context has only the System keychain in its search list ([TN3137: On Mac keychains](https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains)), so that service cannot reach the login keychain, and once the service is installed and takes over, the daemon moves its items into the same `secrets.json` file, written the same way; `sidekicks daemon uninstall` moves them back into the login keychain. Each item is written at its destination, read back, and only then deleted from its source, and a move stopped partway finishes at the next start. Settings › Runtime then shows `Secrets stored without encryption` over a line saying only this account can read them, or once that service is turned off in Login Items & Extensions the command that moves them back, the file's path in its own row; the notice is absent on every other machine.
- **Windows:** each item is a Credential Manager generic credential at `CRED_PERSIST_LOCAL_MACHINE`, written through `keyring-core` with `windows-native-keyring-store` 1.1.0, each entry built with `persistence` = `local`, because that store otherwise writes Enterprise persistence, which roams with a domain profile. The service writes and reads each item in its own process through `sidekicks-platforms`' credential code, and with the service stopped `sidekicks data erase` starts the daemon program in its erase mode, which calls the same code in its own process, on every Windows computer, with or without WSL ([ADR-039](./039-sessions-in-wsl-2-distributions.md)).
- **Preconditions (all must hold before the store is accepted):**
  1. Platform-specific availability probe (see [§Platform-Specific Preconditions](#platform-specific-preconditions)).
  2. Write-probe-read-delete cycle succeeds (see [§Write-Probe-Read-Delete Invariant](#write-probe-read-delete-invariant)).
  3. The backend named in the service log (macOS: the login keychain, or the file under the service that runs while the person is logged out; Windows: local-machine persistence; Linux: the file, its place, and the key kind and PCR binding of the start's probe, with the credential service's socket).
- **When the store cannot take an item.** On Linux, when the first start finds no credential service, or the service refuses to seal there, the service keeps its items in the plain file, as a Mac's service running while the person is logged out does; a time-out or a closed connection at the first start refuses that call and the next call checks again. A sealed file that cannot be opened is left byte for byte, and every call that needs it refuses with `cause: unavailable`: while the service is gone or cannot open the key form that sealed an item, does not answer, or the chip that sealed an item is not available, the next call checks again; where the key changed, where the service keeps another value than it was given, or where the file cannot be read, every call refuses until the next start, and removing the computer and linking it again empties the file and its record, whose secrets could not be read anyway. Elsewhere a store that is locked refuses with `cause: locked`, and one that fails a precondition refuses with `cause: unavailable`; on Linux nothing can be unlocked, so every refusal there is `unavailable`. Each caller's `*_store_unavailable` error carries that cause, and nothing is stored anywhere else. The service log names the failed precondition and a concrete remediation.
- **Lingering.** On Linux with lingering the service can start before login; the credential service needs no login, so the file opens then as at any start, and a sealed file is never swapped for the plain one. A run whose item the service cannot open fails its step with `cause: unavailable` and offers `Retry from this step`, never waiting, and the service reads the item again at each new run and each retry.
- **No key without a home.** The identity key and the channel key are minted at the service's first start only once the store takes them. When it refuses, no key is minted and `sidekicks daemon status` says why: the failed preconditions, the detected platform constraints, and the smallest set of actions that reaches a working store.
- **`Erase all data`** deletes the app's credential-store items and the store; on Linux it deletes the file and its record without opening any item.

### Machine Identity

- The service's Ed25519 identity key, tagged `ed25519`, is minted at the service's first start with the machine's id, together with the machine's X25519 channel key. Each is its own item in the credential store, and `local_machine` pins each by its public key, empty until the first mint, so a later start tells a key it holds from one that is lost or changed; the private key is never in the database. Both are minted again only on the paths [§Refuse-On-Rotation Invariant](#refuse-on-rotation-invariant) names. The identity key never leaves the machine. A Windows computer is one machine with one identity key, with or without WSL: the service is the native daemon, and its sessions in WSL 2 distributions run through it ([ADR-039](./039-sessions-in-wsl-2-distributions.md)).
- Enrollment is the machine's sign-in, which the service runs whether Settings › Devices' `Sign in` or `sidekicks account login` started it; with the service stopped, `sidekicks account login` starts it first and signs in through it. The service sends the key's public half in its pushed sign-in request and the control plane enrolls it as this machine's key, under the signed-in person. The service then registers the machine (`machine.register`, [Spec-002](../specs/002-machine-registration.md)) with its id, that key, its name, its platform and its service version, and the control plane accepts the registration only for a key enrolled to that owner, keeping it on the machine's row in `machines`, never in `devices`. The machine's `machine.added` statement enters the key in the account's chain: the first machine signs its own, and a later machine's is recorded when a device or machine the account trusts links it.
- Every device the person links pins it. A removed machine that is linked again first mints a new identity key and a new channel key under its same machine id, and its new `machine.added` moves every device's pin for that id; its store, sessions and id stay. From that point a statement the old key signs is refused, what it signed before stands, and the old key is never trusted again. A device refuses a known id with a different key unless a later `machine.added` for that id is behind it, and the control plane refuses `machine.register` for a known id under another key with `machine.keyChanged`.
- It certifies each end's X25519 channel key for the Remote Control channel, `Noise_KK_25519_AESGCM_SHA256` or `Noise_KK_25519_ChaChaPoly_SHA256`; the product builds no construction of its own. The channel is [the channel's decision record](./010-tokens-passkeys-and-the-remote-channel.md)'s and [Spec-027 §The encryption envelope](../specs/027-remote-control.md#the-encryption-envelope)'s.
- The CLI holds no key: signing happens in the daemon.

### Cross-Platform Invariants

The following three invariants hold on every platform.

#### Write-Probe-Read-Delete Invariant

Before accepting the credential store on any platform, the service performs the cycle below; on Linux the probe is sealed into the file, opened from it, compared and deleted the same way, and one existing item per key id in the file is opened beside it:

1. Generate `probe_value` with `getrandom::fill` into 32 bytes (a 256-bit random value).
2. `keyring.set(service="ai-sidekicks-probe", account="store-verify-<hex>", value=probe_value)`, the account fresh at each start, `<hex>` random.
3. `readback = keyring.get(service="ai-sidekicks-probe", account="store-verify-<hex>")`.
4. Assert that `readback` equals `probe_value` through `subtle`'s `ConstantTimeEq`. On a mismatch the store is not accepted until the next start, and every call that needs it refuses with `cause: unavailable`; a store that is locked or does not answer refuses that call with its cause, and the next call runs the cycle again.
5. `keyring.delete(service="ai-sidekicks-probe", account="store-verify-<hex>")`. Delete failure is logged but non-fatal — the probe value is already discardable and treating delete failure as a custody error would cause spurious refusals on backends with eventual-consistency semantics; `Erase all data` deletes any probe item left behind.

On Windows the cycle runs through `sidekicks-platforms`' credential code, the same code every item is written through, in the service's own process. This invariant is the only cross-platform defense against silent backend substitution. `keyring-core` has no backend-identity API — the library treats a silently degraded backend as success from the caller's side. Write-probe-read-delete catches the empirically observed silent-failure modes:

- **Linux:** the service seals through systemd's credential service into its own file, so it never uses the kernel session keyring; this cycle proves the service seals and opens now, and opening one existing item per key id beside it tells a key that changed from a service that is gone or failing, without reading the service's error names, which differ between systemd releases.
- **macOS locked keychain:** A locked `login.keychain-db` can return stale-read successes and silently lose newly-written items when the user has declined an unlock prompt. Write-probe-read-delete forces a read of the just-written value and detects the case where the write was accepted by the UI layer but did not persist.
- **Windows policy:** Group Policy can block `CRED_TYPE_GENERIC` writes on managed machines. The write call reports success; subsequent reads fail or return stale values. Write-probe-read-delete detects this within a single synchronous cycle.

#### Refuse-On-Rotation Invariant

The machine's Ed25519 identity key and its X25519 channel key MUST NOT be silently regenerated. Specifically:

- Key generation happens at the service's first start; when a removed machine is linked again; and at a sign-in that finds the key lost or changed while the machine has no registration (no `machine_trust_state` row), since nothing pins a key that was never registered. Each of these mints both keys, so the relink rotates the channel key with the identity key.
- Any other path that would find no identity key, or a key other than the one `local_machine` pins, MUST refuse rather than generate a replacement. A removed machine linked again mints new keys under its same machine id and publishes a new `machine.added` for them; a statement the old key signs afterward is refused, what it signed before stands, and the old key is never trusted again.
- The control plane is the authority on whether a key was registered: `machine.register` naming a machine id the account holds under another identity key is refused with `machine.keyChanged` ([Spec-002](../specs/002-machine-registration.md)), so a machine whose database was restored from before its registration is linked again.
- This is load-bearing because every linked device pins the key: a silently rotated key would be refused by each of them ([Spec-027](../specs/027-remote-control.md)), and the machine would drop out of the person's devices until it is linked again.

#### Plaintext-In-Daemon-Memory Only

- Every private key and token the service reads from the store lives only in the daemon process's memory.
- The CLI binary itself MUST NOT hold a decrypted key — CLI invocations talk to the daemon over the [Spec-006 local IPC contract](../specs/006-local-ipc-and-daemon-control.md) and ask the daemon to sign on their behalf. The one exception is `sidekicks data erase` with the service stopped, which starts the daemon program in its erase mode on every platform; that process deletes the items through the same custody code and holds nothing after it exits; `sidekicks account login` and `sidekicks account logout` start the service and go through it.
- This constraint is inherited from [security-architecture.md §Local Daemon Authentication](../architecture/security-architecture.md#local-daemon-authentication) and is the reason the session token is required (not optional) — if any CLI binary could silently request a private key over IPC, the daemon's confidentiality boundary would collapse into the IPC surface.

### Platform-Specific Preconditions

#### Linux

- **The credential service:** the first call connects to `/run/systemd/io.systemd.Credentials`, which systemd 256 and newer enables wherever it is built; no socket or no listener there means no service, found by the call itself with no separate probe. Every call runs within its caller's time, the start's check within 2 seconds.
- **Which errors decide a place:** at the first start only, a definite refusal (`io.systemd.Credentials.NoSuchUser`, or `io.systemd.System` with `ENOTRECOVERABLE` or `EOPNOTSUPP`) picks the plain file; nowhere else does the service branch on an error name, which goes to the log.
- **The Secure Boot binding:** the probe blob's header names its key and, for a chip, the PCRs it is bound to; a seal bound to PCR 7 (systemd 256 and 257 with a chip) keeps the plain file.
- **Backend disclosure:** log the place, the probe's key kind and PCR mask, the socket path, and logind's state for this user (`lingering`, `online` or `active`), so the person knows how the items are held and whether the service started before login.
- **Write-probe-read-delete** (see above), with the open check beside it.
- Common contexts on Linux where the file is plain: systemd older than 256 (Ubuntu 24.04 carries 255), containers with no systemd or a temporary `/var/lib/systemd`, and systemd 256 or 257 with a chip.
- **Lingering:** a service that starts before login opens its file as at any start, as [§The Credential Store](#the-credential-store) says.

#### macOS

- **Keychain signing requirement:** the keychain ACL stamped at first write binds to the writing program's code signature (its Designated Requirement). A program whose signature changes, or an unsigned or ad-hoc-signed one, can succeed at writing a keychain item and fail to read it back at a later start. Write-probe-read-delete catches this within the same start; a later start re-runs the cycle and refuses with its cause.
- **No backend-inspection API:** macOS's `SecKeychain` API exposes no is-backend-real signal. Write-probe-read-delete is the only verification path available for the keychain.
- **Locked-keychain handling:** a locked keychain that prompts the person for an unlock password is treated as available if and only if the prompt completes successfully within a 30-second ceiling. Declining the prompt, or timing out, refuses with `cause: locked`. The service MUST NOT bypass the unlock prompt using stored credentials — the bypass failure modes (`security unlock-keychain` with stored passwords) are what CVE-2025-24204 and adjacent keychain CVEs exploit.
- **Write-probe-read-delete** (see above).

#### Windows

- **One implementation:** every custody call on Windows runs `sidekicks-platforms`' credential code in the service's own process, and with the service stopped `sidekicks data erase` starts the daemon program in its erase mode, which calls it in that process; the in-distribution CLI's `sidekicks data erase` hands the command to the Windows CLI through interop ([ADR-039](./039-sessions-in-wsl-2-distributions.md)).
- **Wincred / DPAPI disclosure:** the stored credential is encrypted at rest by the user's DPAPI master key (derived from the user's Windows logon credential). This is software-protected — the user account's password is the confidentiality root. DPAPI offers no defense against malware running as the same user.
- **Local-machine persistence, which the store does not take by default:** `windows-native-keyring-store` writes `CRED_PERSIST_ENTERPRISE` unless told otherwise, which roams to other machines the person signs in to on a Windows domain. Every entry is built with `persistence` = `local` (`Entry::new_with_modifiers`), so it is `CRED_PERSIST_LOCAL_MACHINE` and stays on this machine, and a test reads the entry's `persistence` attribute back as `Local`.
- **Credential Guard NOT in scope:** Credential Guard protects only domain credentials stored in Credential Manager (Credential Manager's "Generic credentials" — which map to the Win32 `CRED_TYPE_GENERIC` API constant we use — are explicitly unprotected), per [Microsoft's Credential Guard considerations and known issues](https://learn.microsoft.com/en-us/windows/security/identity-protection/credential-guard/considerations-known-issues#saved-windows-credentials-considerations). Our credential type is `CRED_TYPE_GENERIC` and therefore receives no Credential Guard protection. This record does not claim Credential Guard as a layer of defense.
- **Policy probe:** Group Policy can disable `CRED_TYPE_GENERIC` writes on managed machines. The write call returns success regardless; the read-back fails. Write-probe-read-delete detects this within the same synchronous cycle and refuses with `cause: unavailable`.
- **Write-probe-read-delete** (see above).

#### WSL 2

- On a Windows computer with sessions in a WSL 2 distribution, every item stays in Windows' Credential Manager, written and read by the native daemon in its own process; the distribution's WSL server holds no credential and no secret at rest, and a token a provider there needs reaches it as an environment value or a provider request the daemon sends over the channel ([ADR-039](./039-sessions-in-wsl-2-distributions.md)).
- A distribution's own systemd credential service, desktop keyring and keyutils are never used, so none of the Linux preconditions apply inside it.

## Alternatives Considered

### Option A: Each secret its own item, in the platform's credential store or the service's `0600` file (Chosen)

- **What:** Every secret is its own item, verified by write-probe-read-delete before the store is accepted: in the operating system's credential store on macOS and Windows, Windows' Credential Manager in the service's own process; on Linux in one file readable by this account alone, each item sealed through systemd's credential service, and plain where that service cannot seal; and in the same file, plain, on a Mac whose secrets are in it.
- **Steel man:** Every secret opens unattended, on Linux before login and with no desktop keyring too; the store is the one each platform's own tools use, protected by the computer; the app runs no key, wrap or sealing format of its own; no silent fallback, since the place the items are in is named; no silent rotation of the identity key; a headless Linux machine still runs, the way `gh` and Codex do.
- **Weaknesses:** The plain `0600` file protects only against other users on the machine; a locked keychain fails a run that needs an item until the person unlocks it; a sealed file is lost when the key it was sealed with changes (the chip cleared or replaced, the Secure Boot settings, the account or the machine id changed), ending in removing the computer and linking it again, and cannot be opened while systemd's credential service is absent or cannot open the key form that sealed an item, ending in an update of the system or in the same relink.

### Option B: OS keystore only, refuse when unavailable (Rejected)

- **What:** The credential store is the only custody; a machine without a systemd credential service that seals, a login keychain or Credential Manager cannot run the service, and a Mac's service cannot run while the person is logged out.
- **Why rejected:** Sealing is patchy on Linux (older systemd releases, containers and CI commonly lack it), and a launchd daemon cannot reach the login keychain at all ([TN3137: On Mac keychains](https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains)), so a service that refused would leave those machines out of the product, and a Mac out while the person is logged out. The `0600` file keeps them in, at a custody the person can see.

### Option C: PAM-based unlocking of `login.keychain` on macOS (Rejected)

- **What:** Rely on PAM-integrated keychain unlock at interactive login to pre-unlock the keychain for the service's later unattended reads.
- **Why rejected:** The PAM integration only applies to interactive login contexts (console login, SSH with PAM keychain module); headless contexts never trigger it. The service must work the same whether or not someone logged in interactively, and on a Mac whose service runs while the person is logged out no login unlocks anything it can use, because it never reaches the login keychain ([TN3137: On Mac keychains](https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains)). PAM-integrated unlock is not forbidden — if it is how the keychain is already unlocked when the service reads, the read succeeds; the rejection here is of _requiring_ PAM as a custody precondition.

### Option D: The Data Protection Keychain with a signed build (Rejected)

- **What:** Keep the macOS items in the Data Protection Keychain, which needs an Apple-signed bundle and its entitlement.
- **Why rejected:** What it adds over the login keychain is per-item access lists and an optional biometric gate, and a biometric gate would stop an unattended service.

### Option E: A hardware security module plugin (Rejected)

- **What:** A plugin surface for PKCS#11 tokens or a cloud key service to hold the keys.
- **Why rejected:** Out of scope for one person's own machines. A personal PKCS#11 token also needs a PIN or a touch per use, which an unattended service cannot give.

## Assumptions Audit

| # | Assumption | Evidence | What Breaks If Wrong |
| --- | --- | --- | --- |
| 1 | `keyring-core` and its macOS and Windows stores remain maintained, and systemd's credential service keeps its varlink interface for `Encrypt` and `Decrypt`. | The stores are chosen in code, not inferred; `keyring` 4's own documentation recommends `keyring-core` with the stores a program wants; the credential service's `Encrypt` and `Decrypt` with `name`, `data` or `blob` and `scope` are the same from systemd 256 to its main branch. | We would bind the platform keychains directly, or follow the service's interface in the platforms crate's client. |
| 2 | `windows-native-keyring-store` with `persistence=local` writes `CRED_PERSIST_LOCAL_MACHINE`, from the daemon and from the Windows CLI with the service stopped. | The crate applies its persistence modifier when the secret is written, Enterprise by default. **Unvalidated** on a Windows machine; `cmdkey /list` confirms it before build. | An item would roam with a domain profile; the probe blocks the build until it holds. |
| 3 | On Linux, a probe sealed and opened at each start, beside one existing item per key id opened, tells a working service, a missing one, a failing one, an unavailable chip and a changed key apart without the service's error names. | (a) no socket or no listener → no service; (b) the probe refuses or does not answer → failing; (c) the probe passes with a weaker key than an item that fails → the chip is not available; (d) the probe passes with the item's key and the item fails → the key changed. | Case (a) at the first start picks the plain file, and over a sealed file refuses until the service is back; (b) and (c) refuse that call and the next call checks again; (d) refuses until the next start and leaves the file as it is; one damaged blob the open check picks reads as (d), and the log names the item. |

## Failure Mode Analysis

| Scenario | Likelihood | Impact | Detection | Mitigation |
| --- | --- | --- | --- | --- |
| A keychain write succeeds but the item does not persist (a locked keychain, a changed code signature, a policy-blocked write) | Med | Med | Write-probe-read-delete before the store is accepted | The write refuses with its cause; the service log names the failed precondition |
| The key a Linux file was sealed with changes (the chip cleared or replaced, the Secure Boot settings, the account or the machine id changed) | Low | High (every secret on the machine is lost) | The start's probe opens and an existing item with the probe's key does not | Every call refuses with `unavailable` and the file is left as it is; Runtime and `sidekicks daemon status` name the cause, and removing the computer and linking it again empties the file |
| systemd's credential service is gone (no systemd, or one older than 256) or cannot open the key form that sealed an item, or does not answer, or the chip that sealed an item is not available | Low | High while it lasts | The connect finds no service, the probe fails, or the probe seals with a weaker key than an item that fails | Each call refuses with `unavailable` and checks again, so the file opens once the service or chip is back; Runtime names the cause and the act |
| A Secure Boot update changes PCR 7 under items sealed by systemd 256 or 257 with a chip | High where such a seal were taken | High | The probe blob's header shows PCR 7 bound | Not sealed there: the file stays plain until a later systemd seals with no PCR bound, then is sealed once |
| The plain `0600` file is read by another program running as the person, or copied off the machine | Low | High | Out of scope for at-rest storage | The file is plain only where systemd cannot seal and on a Mac running while logged out, and the person can see that it is; a stolen identity key is answered by removing the machine and linking it again |
| The machine's identity key is stolen and used from elsewhere | Low | High | A second live relay connection under one key is flagged; a reused refresh token revokes its whole family, and `sidekicks daemon status` prints that its sign-in was used in two places | Removing the machine and linking it again mints a new identity key under its same id, after which a statement the old key signs is refused and the old key is never trusted again |
| A move into the files at install or back into the login keychain at uninstall stops partway, or a Linux re-seal stops before its record moves (a crash, a power cut) | Low | Critical if an item were lost (the identity key) | The place record names the move's direction; the file's form tag says whether it is sealed or plain | Each moved item is written, read back and only then deleted from its source, and the next start finishes the move in the same direction; a re-seal replaces the file in one atomic write, so the next start finds the old file or the new one and records it, and no item is ever in neither place |
| `sidekicks daemon uninstall` runs while the login keychain is locked, as over SSH while the person is logged out | Med | Low | The keychain write refuses with `cause: locked` before anything moves | The command changes nothing and asks the person to log in at the Mac and run it again |
| The identity key goes missing from the store | Low | Critical (every linked device refuses the machine) | §Refuse-On-Rotation Invariant: a path that finds no identity key refuses rather than regenerating | The machine is removed and linked again, or, while it has no registration, its next sign-in mints both keys again; a backup holds no credential, so a restore does not bring the key back ([Spec-013 §Backup Policy](../specs/013-persistence-and-recovery.md#backup-policy)) |

## Reversibility Assessment

- **Reversal cost:** Moderate for the store (a different keychain library behind the same custody code); very high for the refusal semantics (changing "refuse" to "generate" would mint an identity key every device refuses).
- **Blast radius:** Every machine that runs the service. Where the items are kept is observable through `sidekicks daemon status`; every secret the service holds depends on it.
- **Migration path:** A different store sits behind the same custody code; each item is read out through the daemon and written into the new store, on every machine.
- **Point of no return:** Once linked devices have pinned the machine's identity key, replacing it requires removing the machine and linking it again under a new key with a new `machine.added`; any other replacement drops the machine from every device.

## Consequences

### Positive

- The service opens every secret with no person present.
- No silent backend substitution — the store is verified before it is accepted, and where the items are kept is named.
- No silent key rotation: a new identity key is minted only when a removed machine is linked again, or at a sign-in while the machine has no registration; `machine.register` refuses a known id under another key with `machine.keyChanged`.
- One store per platform for every secret the service holds, with no key, wrap or sealing format of the app's own; on Linux systemd's own sealing, with the security chip where systemd can use it.
- A headless Linux machine runs the service, as it runs `gh` and Codex.
- Cross-platform behavior is uniform at the semantic layer (the same store rule, same invariants), and a Windows computer keeps its secrets in one place, the native daemon's Credential Manager items, with or without WSL.
- The design does not claim protection the store does not provide; §Explicitly NOT Claimed lists what it does not claim.

### Negative (accepted trade-offs)

- The start's check on Linux, a probe sealed and opened and one item per key id opened, adds up to 2 seconds at start, not per command, and each call seals or opens one item over one short connection to systemd's credential service.
- On Linux a sealed file is lost when the key it was sealed with changes, and cannot be opened while systemd's credential service is absent or cannot open the key form that sealed an item; the system is then updated, or the computer is removed and linked again and the secrets the person handed it are entered again.
- The keychain and the file are software-protected and provide no defense against same-user malware. An attacker with code execution as the same person can read the items through the store or read decrypted keys from the daemon's memory. Defense against same-user code execution is out of scope.
- A locked keychain fails a run that needs an item until the person unlocks it.

## Explicitly NOT Claimed

This ADR makes the following explicit disclaimers to prevent misreading of the custody properties:

- **Protection against code running as the same person.** No store stops code running as the same person on the same machine: it can read the items through the store, or read decrypted keys from the daemon's memory.
- **Protection of the daemon's database.** Nothing in the daemon's database is encrypted by the app; it holds no secret.
- **Protection by the plain `0600` file beyond other users.** Mode `0600` is defense against other non-root users on the same machine only; it provides no defense against a backup tool, sync folder or copy outside the app that carries the file off the machine; the app's own backup holds no credential.
- **Hardware binding beyond Linux's chip seal.** On Linux an item sealed with the chip opens only on this computer's chip, beside systemd's system key; an item sealed with the system key alone opens from a copy of the whole disk. On macOS and Windows no item is bound to a security chip, and a store's own protection is all the items have.
- **Credential Guard protection (Windows).** Credential Guard protects `CRED_TYPE_DOMAIN_PASSWORD` only; our `CRED_TYPE_GENERIC` credential receives no Credential Guard protection. DPAPI wrapping is provided by the OS as an at-rest protection layer, rooted in the user's logon credential, but this is software-protected, not hardware-rooted.
- **Attestation.** No item is used to attest the machine to anyone; no HSM is involved anywhere in the custody path.
- **Data Protection Keychain (macOS).** The items use the login keychain, or `secrets.json` on a Mac whose logged-out service has moved them there; they do not get the Data Protection Keychain's per-item access lists, biometric gate or iCloud sync, which a launchd daemon cannot use ([TN3137: On Mac keychains](https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains)).

## Decision Validation

### Success Criteria

| Metric | Target | Measurement Method | Check Date |
| --- | --- | --- | --- |
| A store accepted whose item does not read back | None | The key-custody tests with the backend stopped, locked or policy-blocked | When the key-custody code lands |
| An item written to the kernel keyring on Linux | None | The key-custody tests on a Linux host with no credential service | When the key-custody code lands |
| A sealed Linux file served plain, or rewritten, while it cannot be opened | None | The key-custody tests with the service missing, failing and the key changed | When the key-custody code lands |
| An identity key regenerated outside a removed machine's relink | None | A start with the identity item removed refuses rather than minting a key | When the key-custody code lands |
| Local-machine persistence on Windows | `Local machine` for every item, written by the daemon and by the Windows CLI | `cmdkey /list` on a Windows machine | Before the Windows custody code is built |

## References

- [The channel's decision record](./010-tokens-passkeys-and-the-remote-channel.md) — the Remote Control channel the machine's identity key certifies.
- [ADR-039: Sessions In WSL 2 Distributions](./039-sessions-in-wsl-2-distributions.md) — the native daemon keeps every item on a Windows computer with sessions in WSL 2 distributions.
- [Spec-006: Local IPC And Daemon Control](../specs/006-local-ipc-and-daemon-control.md) — session-token contract that bounds CLI access to decrypted key material.
- [security-architecture.md §Local Daemon Authentication](../architecture/security-architecture.md#local-daemon-authentication) — the daemon-auth model, whose mode-0600 session token is the transport-layer peer of this record's at-rest custody model.
- [`keyring-core`](https://crates.io/crates/keyring-core) 1.0.1 — the credential API every value goes through on macOS and Windows, with `apple-native-keyring-store` 1.0.2 on macOS.
- [`systemd-creds`](https://www.freedesktop.org/software/systemd/man/latest/systemd-creds.html) — systemd's credential sealing, whose `io.systemd.Credentials` service seals each Linux item for this user.
- [`windows-native-keyring-store`](https://crates.io/crates/windows-native-keyring-store) 1.1.0 — the Windows Credential Manager store every Windows entry is written through with `persistence` = `local`.
- [HashiCorp Vault file backend](https://github.com/hashicorp/vault) — reference implementation for the write-temp-atomic-rename POSIX pattern the `0600` file uses.
- [`gh`](https://github.com/cli/cli) — its `hosts.yml` fallback keeps the token in a file where no keyring is available.
- [Apple Keychain Services](https://developer.apple.com/documentation/security/keychain_services) — macOS keychain ACL and Designated Requirement documentation.
- [TN3137: On Mac keychains](https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains) — a launchd daemon has only the System keychain in its search list, so a Mac's service running while the person is logged out cannot reach the login keychain.
- [Microsoft Wincred / CredWrite](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credwritew) — `CRED_PERSIST_*` semantics reference.
- [Microsoft Credential Guard — considerations and known issues](https://learn.microsoft.com/en-us/windows/security/identity-protection/credential-guard/considerations-known-issues#saved-windows-credentials-considerations) — primary source for the claim that Credential Manager's "Generic credentials" (mapping to the Win32 `CRED_TYPE_GENERIC` API constant) are unprotected by Credential Guard; only domain credentials receive protection.
- CVE records informing the threat model:
  - [CVE-2023-36004](https://nvd.nist.gov/vuln/detail/CVE-2023-36004) — Windows DPAPI spoofing
  - [CVE-2024-54490](https://nvd.nist.gov/vuln/detail/CVE-2024-54490) — macOS keychain items access
  - [CVE-2025-24204](https://nvd.nist.gov/vuln/detail/CVE-2025-24204) — macOS `gcore` → securityd memory → login keychain master key disclosure
  - [CVE-2025-31191](https://nvd.nist.gov/vuln/detail/CVE-2025-31191) — macOS sandbox escape (keychain-adjacent)
  - [CVE-2025-69277](https://nvd.nist.gov/vuln/detail/CVE-2025-69277) — an Ed25519 point-validation flaw (reported in libsodium); cited for the point-validation threat class applicable to any Ed25519 verifier including `@noble/curves` (informs input validation on read)
  - [CVE-2026-28864](https://nvd.nist.gov/vuln/detail/CVE-2026-28864) — macOS Keychain Access permissions
