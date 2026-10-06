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

A keystore binding can silently succeed against a backend that does not provide the durability or confidentiality the caller assumes: a kernel session keyring on Linux instead of the Secret Service, a locked login keychain on macOS, a policy-blocked write on Windows. The design therefore treats a successful keystore `set` call as a claim, not evidence, and verifies the store with a write-probe-read-delete cycle before accepting it.

## Problem Statement

Where does the service keep each of its secrets, on macOS, Linux and Windows — including a Windows computer whose service runs in WSL 2 — so that:

1. Every secret opens with no person present, at every start and after a reboot.
2. Every secret lives in the operating system's credential store, protected by the person's login, and nothing in the daemon's database is encrypted by the app.
3. No silent fallback occurs to a backend (kernel keyutils, a locked keychain) the service has not verified, and the person can see where secrets are kept.
4. A Linux machine with no Secret Service still runs the service.
5. The service mints no key that the store has not taken, rather than a key that would not open at the next start.
6. The design claims no protection the chosen store does not provide.

### Trigger

- The service is the person's own background service and must open its secrets with no one present.
- `@napi-rs/keyring` exposes no backend-identity signal on any platform, falls back to the kernel keyring on its own when no Secret Service answers on Linux, and on Windows writes every entry at Enterprise persistence. Silent fallback remains the dominant failure the design defends against.

## Decision

The service keeps **each secret as its own item in the operating system's credential store**: through `@napi-rs/keyring` the login keychain on macOS and the Secret Service on Linux; on Windows Credential Manager, written in the service's Windows half through `windows-native-keyring-store` on both kinds of Windows computer, with `@napi-rs/keyring` not used for the daemon's entries there. On Linux it opens the Secret Service store explicitly, and when no Secret Service answers it keeps its items in one file in its own data folder, readable by this account alone; a Mac whose service runs while the person is logged out keeps them in the same file, because that service cannot reach the login keychain. A write-probe-read-delete cycle verifies the store before the service accepts it. Nothing in the daemon's database is encrypted by the app.

### The Credential Store

- **The items.** Each of these is its own item: the machine's Remote Control identity key and its channel key; the hosted sign-in's refresh token and DPoP key; a pasted provider token ([ADR-026](./026-provider-credential-custody-posture.md)); a workflow secret, the notification web address and its signing secret, and the mail password ([ADR-036](./036-workflow-secrets-in-the-os-keychain.md)); and each tool server sign-in's refresh token and DPoP key ([ADR-038](./038-mcp-credential-custody.md)).
- **macOS:** the login keychain, through [`@napi-rs/keyring`](https://github.com/Brooooooklyn/keyring-node) 2.1.0.
- **Linux:** the D-Bus Secret Service (GNOME Keyring, KeePassXC, KDE Wallet), through `@napi-rs/keyring` 2.1.0 opened with `{linux: {store: "secret-service"}}`. The binding falls back to the kernel keyring on its own when no Secret Service answers, and the kernel keyring is cleared at every restart, so the service picks the Secret Service store explicitly and never uses the kernel keyring.
- **Linux with no Secret Service:** the service keeps its items in one file, `secrets.json` in its own data folder, readable by this account alone (mode `0600`, inside a parent directory at `0700`), as `gh` and Codex do. Each write goes to a temporary file with those permissions, is flushed with `fsync` and renamed over the target, so the file is never seen half-written. It never falls back silently: Settings › Runtime then shows one line under the service's own, `Secrets are kept unencrypted in <path>, readable by this account alone, because no Secret Service is running.`, `<path>` being that file.
- **macOS with the service running while the person is logged out:** `sidekicks daemon install --while-signed-out` has the app register a system service that runs the daemon before login and after logout ([Spec-006 §The service on a Mac while logged out](../specs/006-local-ipc-and-daemon-control.md#the-service-on-a-mac-while-logged-out)). A process outside a user context has only the System keychain in its search list ([TN3137: On Mac keychains](https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains)), so that service cannot reach the login keychain, and on install the daemon moves its items into the same `secrets.json` file, written the same way; `sidekicks daemon uninstall` moves them back into the login keychain. Each item is written at its destination, read back, and only then deleted from its source, and a move stopped partway finishes at the next start. Settings › Runtime then shows the same line ending `because the service runs while you are logged out.`; the line is absent on every other machine.
- **Windows, native and WSL alike:** each item is a Credential Manager generic credential at `CRED_PERSIST_LOCAL_MACHINE`, written and read in the service's Windows half ([ADR-039](./039-the-service-on-wsl-2.md)), never in the daemon's own process, through `windows-native-keyring-store` 1.1.0 with `persistence=local`, because `@napi-rs/keyring` 2.1.0 passes only the entry's target and so writes every Windows entry at Enterprise persistence, which roams with a domain profile.
- **Preconditions (all must hold before the store is accepted):**
  1. Platform-specific availability probe (see [§Platform-Specific Preconditions](#platform-specific-preconditions)).
  2. Write-probe-read-delete cycle succeeds (see [§Write-Probe-Read-Delete Invariant](#write-probe-read-delete-invariant)).
  3. The backend named in the service log (macOS: the login keychain, or the file under the service that runs while the person is logged out; Windows: local-machine persistence; Linux: the Secret Service's bus owner, or the file).
- **When the store cannot take an item.** On Linux, when the environment gate or the live D-Bus probe finds no Secret Service, the service keeps its items in the file, as a Mac's service running while the person is logged out does. Anywhere else, a store that is locked refuses with `cause: locked`, and one that fails a precondition refuses with `cause: unavailable`; each caller's `*_store_unavailable` error carries that cause, and nothing is stored anywhere else. The service log names the failed precondition and a concrete remediation.
- **Lingering.** On Linux with lingering the service can start before login while the keyring is locked. A run that needs an item then fails its step with `cause: locked` and offers `Retry from this step`, never waiting, and the service reads the item again at each new run and each retry, so the first one after login succeeds.
- **No key without a home.** The identity key and the channel key are minted at the service's first start only once the store takes them. When it refuses, no key is minted and `sidekicks daemon status` says why: the failed preconditions, the detected platform constraints, and the smallest set of actions that reaches a working store.
- **`Erase all data`** deletes the app's credential-store items and the store.

### Machine Identity

- The service's Ed25519 identity key is minted at the service's first start, with the machine's id, tagged `ed25519`, and kept as its own item in the credential store; it is minted again only when a removed machine is linked again. It never leaves the machine. A Windows computer is one machine whichever side runs the service: a move between Windows and a WSL distribution carries the store, and the items stay in Credential Manager, so the key and the machine's registration come along ([ADR-039](./039-the-service-on-wsl-2.md)).
- Enrollment is `sidekicks sign-in`: with the service stopped, the CLI reads the key's public half through the daemon's custody code and enrolls it with the control plane as this machine's key, under the signed-in person. When the service starts, it registers the machine (`runtimenode.register`, [Spec-002](../specs/002-machine-registration.md)) with its id, that key, its name, its platform and its service version, and the control plane accepts the registration only for a key enrolled to that owner, keeping it on the machine's `runtime_nodes` row, never in `devices`. The machine's `runtimenode.added` statement enters the key in the account's chain: the first machine signs its own, and a later machine's is recorded when a device or machine the account trusts links it.
- Every device the person links pins it. A removed machine that is linked again first mints a new identity key under its same machine id, and its new `runtimenode.added` moves every device's pin for that id; its store, sessions and id stay. From that point a statement the old key signs is refused, what it signed before stands, and the old key is never trusted again. A device refuses a known id with a different key unless a later `runtimenode.added` for that id is behind it.
- It certifies each end's X25519 channel key for the Remote Control channel, `Noise_KK_25519_ChaChaPoly_SHA256`; the product builds no construction of its own. The channel is [the channel's decision record](./010-tokens-passkeys-and-the-remote-channel.md)'s and [Spec-027 §The encryption envelope](../specs/027-remote-control.md#the-encryption-envelope)'s.
- The CLI holds no key: signing happens in the daemon.

### Cross-Platform Invariants

The following three invariants hold on every platform.

#### Write-Probe-Read-Delete Invariant

Before accepting the credential store on any platform, the service performs:

1. Generate `probe_value = crypto.randomBytes(32)` (256-bit random value).
2. `keyring.set(service="ai-sidekicks-probe", account="store-verify", value=probe_value)`.
3. `readback = keyring.get(service="ai-sidekicks-probe", account="store-verify")`.
4. Assert `constantTimeEqual(readback, probe_value)`. On mismatch or read failure, the store is not accepted, and a write that needs it refuses with its cause.
5. `keyring.delete(service="ai-sidekicks-probe", account="store-verify")`. Delete failure is logged but non-fatal — the probe value is already discardable and treating delete failure as a custody error would cause spurious refusals on backends with eventual-consistency semantics.

On Windows the cycle runs through the Windows half's `keystore.set`, `keystore.get` and `keystore.delete`, the same code every item is written through. This invariant is the only cross-platform defense against silent backend substitution. `@napi-rs/keyring` has no `isBackendReal()` or `getBackendIdentity()` API — the library treats a silently degraded backend as success from the caller's side. Write-probe-read-delete catches the empirically observed silent-failure modes:

- **Linux keyutils:** the binding is opened on the Secret Service store, so it never falls back to the kernel session keyring; the D-Bus gate and live probe below decide whether a Secret Service answers at all, and this cycle checks that what it stored reads back.
- **macOS locked keychain:** A locked `login.keychain-db` can return stale-read successes and silently lose newly-written items when the user has declined an unlock prompt. Write-probe-read-delete forces a read of the just-written value and detects the case where the write was accepted by the UI layer but did not persist.
- **Windows policy:** Group Policy can block `CRED_TYPE_GENERIC` writes on managed machines. The write call reports success; subsequent reads fail or return stale values. Write-probe-read-delete detects this within a single synchronous cycle.

#### Refuse-On-Rotation Invariant

The machine's Ed25519 identity key MUST NOT be silently regenerated. Specifically:

- Key generation happens at the service's first start, and again only when a removed machine is linked again.
- Any other path that would find no identity key MUST refuse rather than generate a replacement. A removed machine linked again mints a new key under its same machine id and publishes a new `runtimenode.added` for it; a statement the old key signs afterward is refused, what it signed before stands, and the old key is never trusted again.
- This is load-bearing because every linked device pins the key: a silently rotated key would be refused by each of them ([Spec-027](../specs/027-remote-control.md)), and the machine would drop out of the person's devices until it is linked again.

#### Plaintext-In-Daemon-Memory Only

- Every private key and token the service reads from the store lives only in the daemon process's memory.
- The CLI binary itself MUST NOT hold a decrypted key — CLI invocations talk to the daemon over the [Spec-006 local IPC contract](../specs/006-local-ipc-and-daemon-control.md) and ask the daemon to sign on their behalf. The one exception is a verb that runs with the service stopped, such as `sidekicks sign-in` writing the hosted account's refresh token: it writes the item through the same custody code in its own process and holds nothing after it exits.
- This constraint is inherited from [security-architecture.md §Local Daemon Authentication](../architecture/security-architecture.md#local-daemon-authentication) and is the reason the session token is required (not optional) — if any CLI binary could silently request a private key over IPC, the daemon's confidentiality boundary would collapse into the IPC surface.

### Platform-Specific Preconditions

#### Linux

- **Environment gate:** require `DBUS_SESSION_BUS_ADDRESS` to be set and point to a reachable socket. Its absence on a headless, container or CI context means no Secret Service can answer; gating on it surfaces the context before any keystore call is made.
- **Live D-Bus probe:** call `org.freedesktop.DBus.GetNameOwner("org.freedesktop.secrets")` with a 2-second timeout. A successful response proves a Secret Service provider is currently running (not just installed — GNOME Keyring daemons can be installed but not started in headless sessions). Probe latency target is ≤ 1.5 seconds in the success case; >2 seconds is treated as failure.
- **Backend disclosure:** on success, log the bus name owner (`org.gnome.keyring`, `org.kde.KWallet5.Service`, `org.keepassxc.KeePassXC.MainWindow`, etc.) so the person knows which backend holds the items.
- **Write-probe-read-delete** (see above).
- If the gate or the probe finds no Secret Service, the service keeps its items in the file. Common contexts on Linux where that is the realistic outcome: SSH sessions without PAM keyring forwarding, containers, CI runners, and headless servers.
- **Lingering:** a service that starts before login finds the keyring locked, and a run that needs an item fails its step until the person logs in, as [§The Credential Store](#the-credential-store) says.

#### macOS

- **Keychain signing requirement:** the keychain ACL stamped at first write binds to the writing program's code signature (its Designated Requirement). A program whose signature changes, or an unsigned or ad-hoc-signed one, can succeed at writing a keychain item and fail to read it back at a later start. Write-probe-read-delete catches this within the same start; a later start re-runs the cycle and refuses with its cause.
- **No backend-inspection API:** macOS's `SecKeychain` API exposes no is-backend-real signal. Write-probe-read-delete is the only verification path available for the keychain.
- **Locked-keychain handling:** a locked keychain that prompts the person for an unlock password is treated as available if and only if the prompt completes successfully within a 30-second ceiling. Declining the prompt, or timing out, refuses with `cause: locked`. The service MUST NOT bypass the unlock prompt using stored credentials — the bypass failure modes (`security unlock-keychain` with stored passwords) are what CVE-2025-24204 and adjacent keychain CVEs exploit.
- **Write-probe-read-delete** (see above).

#### Windows

- **One implementation:** every custody call on Windows goes through the service's Windows half — as the daemon's child on native Windows, as its resident program on a WSL computer ([ADR-039](./039-the-service-on-wsl-2.md)) — over its channel while the service runs, and through its one-shot `keystore` verbs while it is stopped.
- **Wincred / DPAPI disclosure:** the stored credential is encrypted at rest by the user's DPAPI master key (derived from the user's Windows logon credential). This is software-protected — the user account's password is the confidentiality root. DPAPI offers no defense against malware running as the same user.
- **Local-machine persistence, which the pinned binding does not expose:** `@napi-rs/keyring` 2.1.0 passes only the entry's target to its Windows store, so every entry it writes is `CRED_PERSIST_ENTERPRISE`, which roams to other machines the person signs in to on a Windows domain. The Windows half writes each item through `windows-native-keyring-store` 1.1.0 with `persistence=local`, so it is `CRED_PERSIST_LOCAL_MACHINE` and stays on this machine.
- **Credential Guard NOT in scope:** Credential Guard protects only domain credentials stored in Credential Manager (Credential Manager's "Generic credentials" — which map to the Win32 `CRED_TYPE_GENERIC` API constant we use — are explicitly unprotected), per [Microsoft's Credential Guard considerations and known issues](https://learn.microsoft.com/en-us/windows/security/identity-protection/credential-guard/considerations-known-issues#saved-windows-credentials-considerations). Our credential type is `CRED_TYPE_GENERIC` and therefore receives no Credential Guard protection. This record does not claim Credential Guard as a layer of defense.
- **Policy probe:** Group Policy can disable `CRED_TYPE_GENERIC` writes on managed machines. The write call returns success regardless; the read-back fails. Write-probe-read-delete detects this within the same synchronous cycle and refuses with `cause: unavailable`.
- **Write-probe-read-delete** (see above).

#### WSL 2

- On a Windows computer whose service runs in a WSL 2 distribution, the daemon inside the distribution keeps its items in Windows' Credential Manager through the service's Windows half, over its channel while the service runs and through the one-shot `keystore` verbs while it is stopped, so a Windows computer has one place for secrets on either side.
- The distribution's own keyring is never used, so none of the Linux preconditions apply inside it.
- The items, the machine's identity and the store are the same on either side, and a move between sides moves no secret ([ADR-039](./039-the-service-on-wsl-2.md)).

## Alternatives Considered

### Option A: Each secret its own credential-store item, with a `0600` file where that store cannot be used (Chosen)

- **What:** Every secret is its own item in the operating system's credential store, verified by write-probe-read-delete before the store is accepted; the Secret Service opened explicitly on Linux, and one file readable by this account alone where no Secret Service answers and on a Mac whose service runs while the person is logged out; Windows' Credential Manager through the Windows half on both kinds of Windows computer.
- **Steel man:** Every secret opens unattended; the store is the one each platform's own sign-in tools use, protected by the person's login; the app runs no key, wrap or sealing format of its own; no silent fallback, since the store the items are in is named; no silent rotation of the identity key; a headless Linux machine still runs, the way `gh` and Codex do.
- **Weaknesses:** The `0600` file protects only against other users on the machine; a locked keychain fails a run that needs an item until the person unlocks it.

### Option B: OS keystore only, refuse when unavailable (Rejected)

- **What:** The credential store is the only custody; a machine without a Secret Service, login keychain or Credential Manager cannot run the service, and a Mac's service cannot run while the person is logged out.
- **Why rejected:** Keychain availability is patchy on Linux (headless, containers, CI commonly fail its preconditions), and a launchd daemon cannot reach the login keychain at all ([TN3137: On Mac keychains](https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains)), so a service that refused would leave those machines out of the product, and a Mac out while the person is logged out. The `0600` file keeps them in, at a custody the person can see.

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
| 1 | `@napi-rs/keyring` 2.1.0 remains maintained, and opening it on the Secret Service store keeps it off kernel keyutils. | The binding's store option selects the Linux backend explicitly; the choice is set in code, not inferred. | We would bind the platform keychains directly; the Windows items do not transit this dependency. |
| 2 | `windows-native-keyring-store` with `persistence=local` writes `CRED_PERSIST_LOCAL_MACHINE`, resident and one-shot, on native and WSL computers. | The crate applies its persistence modifier when the secret is written, Enterprise by default. **Unvalidated** on a Windows machine; `cmdkey /list` confirms it before build. | An item would roam with a domain profile; the probe blocks the build until it holds. |
| 3 | On Linux, `DBUS_SESSION_BUS_ADDRESS` presence + live `GetNameOwner("org.freedesktop.secrets")` reliably predicts a Secret Service that will hold the items. | (a) env var absent → no Secret Service; (b) present but no owner → no Secret Service; (c) owner but keyring locked → the write may prompt or fail; (d) owner and unlocked → durable. | Case (c) refuses with `cause: locked`; write-probe-read-delete catches a write that reports success and does not persist. |

## Failure Mode Analysis

| Scenario | Likelihood | Impact | Detection | Mitigation |
| --- | --- | --- | --- | --- |
| A keychain write succeeds but the item does not persist (a locked keychain, a changed code signature, a policy-blocked write) | Med | Med | Write-probe-read-delete before the store is accepted | The write refuses with its cause; the service log names the failed precondition |
| The Linux keyring is locked when a lingering service starts | Med | Med | The item read fails with `cause: locked` | A run needing an item fails its step with `Retry from this step`, and the next read after login succeeds |
| The `0600` file is read by another program running as the person, or copied off the machine | Low | High | Out of scope for at-rest storage | The file is used only where no Secret Service answers, and the person can see that it is; a stolen identity key is answered by removing the machine and linking it again |
| The machine's identity key is stolen and used from elsewhere | Low | High | A second live relay connection under one key is flagged; a reused refresh token revokes its whole family, and `sidekicks daemon status` prints that a reused sign-in was detected | Removing the machine and linking it again mints a new identity key under its same id, after which a statement the old key signs is refused and the old key is never trusted again |
| A move into the files at install, or back into the login keychain at uninstall, stops partway (a crash, a power cut) | Low | Critical if an item were lost (the identity key) | The move record in the data folder names each item's step | Each item is written, read back and only then deleted from its source, and the next start finishes the move in the same direction, so no item is ever in neither place |
| `sidekicks daemon uninstall` runs while the login keychain is locked, as over SSH while the person is logged out | Med | Low | The keychain write refuses with `cause: locked` before anything moves | The command changes nothing and asks the person to log in at the Mac and run it again |
| The identity key goes missing from the store | Low | Critical (every linked device refuses the machine) | §Refuse-On-Rotation Invariant: a path that finds no identity key refuses rather than regenerating | The machine is removed and linked again; a backup holds no credential, so a restore does not bring the key back ([Spec-013 §Backup Policy](../specs/013-persistence-and-recovery.md#backup-policy)) |

## Reversibility Assessment

- **Reversal cost:** Moderate for the store (a different keychain library behind the same custody code); very high for the refusal semantics (changing "refuse" to "generate" would mint an identity key every device refuses).
- **Blast radius:** Every machine that runs the service. Where the items are kept is observable through `sidekicks daemon status`; every secret the service holds depends on it.
- **Migration path:** A different store sits behind the same custody code; each item is read out through the daemon and written into the new store, on every machine.
- **Point of no return:** Once linked devices have pinned the machine's identity key, replacing it requires removing the machine and linking it again under a new key with a new `runtimenode.added`; any other replacement drops the machine from every device.

## Consequences

### Positive

- The service opens every secret with no person present.
- No silent backend substitution — the store is verified before it is accepted, and where the items are kept is named.
- No silent key rotation — the only way to get a new identity key is to remove the machine and link it again.
- One store per platform for every secret the service holds, with no key, wrap or sealing format of the app's own.
- A headless Linux machine runs the service, as it runs `gh` and Codex.
- Cross-platform behavior is uniform at the semantic layer (the same store rule, same invariants), and a Windows computer keeps its secrets in one place whichever side runs the service.
- The design does not claim protection the store does not provide; §Explicitly NOT Claimed lists what it does not claim.

### Negative (accepted trade-offs)

- The store's preconditions add up to 2 seconds (the D-Bus probe) to the store check on Linux, which runs at start, not per command.
- The keychain and the file are software-protected and provide no defense against same-user malware. An attacker with code execution as the same person can read the items through the store or read decrypted keys from the daemon's memory. Defense against same-user code execution is out of scope.
- A locked keychain fails a run that needs an item until the person unlocks it.

## Explicitly NOT Claimed

This ADR makes the following explicit disclaimers to prevent misreading of the custody properties:

- **Protection against code running as the same person.** No store stops code running as the same person on the same machine: it can read the items through the store, or read decrypted keys from the daemon's memory.
- **Protection of the daemon's database.** Nothing in the daemon's database is encrypted by the app; it holds no secret.
- **Protection by the `0600` file beyond other users.** Mode `0600` is defense against other non-root users on the same machine only; it provides no defense against a backup tool, sync folder or copy outside the app that carries the file off the machine; the app's own backup holds no credential.
- **Hardware binding.** No item is bound to a security chip; a store's own protection is all the items have.
- **Credential Guard protection (Windows).** Credential Guard protects `CRED_TYPE_DOMAIN_PASSWORD` only; our `CRED_TYPE_GENERIC` credential receives no Credential Guard protection. DPAPI wrapping is provided by the OS as an at-rest protection layer, rooted in the user's logon credential, but this is software-protected, not hardware-rooted.
- **Attestation.** No item is used to attest the machine to anyone; no HSM is involved anywhere in the custody path.
- **Data Protection Keychain (macOS).** The items use the login keychain, or `secrets.json` on a Mac whose service runs while the person is logged out; they do not get the Data Protection Keychain's per-item access lists, biometric gate or iCloud sync, which a launchd daemon cannot use ([TN3137: On Mac keychains](https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains)).

## Decision Validation

### Success Criteria

| Metric | Target | Measurement Method | Check Date |
| --- | --- | --- | --- |
| A store accepted whose item does not read back | None | The key-custody tests with the backend stopped, locked or policy-blocked | When the key-custody code lands |
| An item written to the kernel keyring on Linux | None | The key-custody tests on a Linux host with no Secret Service | When the key-custody code lands |
| An identity key regenerated outside a removed machine's relink | None | A start with the identity item removed refuses rather than minting a key | When the key-custody code lands |
| Local-machine persistence on Windows | `Local machine` for every item, resident and one-shot, native and WSL | `cmdkey /list` on a Windows machine | Before the Windows custody code is built |

## References

- [The channel's decision record](./010-tokens-passkeys-and-the-remote-channel.md) — the Remote Control channel the machine's identity key certifies.
- [ADR-039: The Service On WSL 2](./039-the-service-on-wsl-2.md) — the service's Windows half, which does custody on Windows for both kinds of Windows computer.
- [Spec-006: Local IPC And Daemon Control](../specs/006-local-ipc-and-daemon-control.md) — session-token contract that bounds CLI access to decrypted key material.
- [security-architecture.md §Local Daemon Authentication](../architecture/security-architecture.md#local-daemon-authentication) — the daemon-auth model, whose mode-0600 session token is the transport-layer peer of this record's at-rest custody model.
- [`@napi-rs/keyring` 2.1.0](https://github.com/Brooooooklyn/keyring-node) — the keychain binding for macOS and Linux; on Windows it passes only the entry's target, so every entry it writes is Enterprise persistence.
- [`windows-native-keyring-store`](https://crates.io/crates/windows-native-keyring-store) 1.1.0 — the Windows Credential Manager store the Windows half writes through with `persistence=local`.
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
