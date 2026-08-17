# Spec-022: Data Retention And GDPR Compliance

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `022` |
| **Slug** | `data-retention-and-gdpr` |
| **Date** | `2026-04-15` |
| **Author(s)** | `Codex` |
| **Depends On** | [Data Architecture](../architecture/data-architecture.md), [Session Model](../domain/session-model.md) |
| **Implementation Plan** | [Plan-022: Data Retention And GDPR Compliance](../plans/022-data-retention-and-gdpr.md) |

## Purpose

Define data retention, deletion, and GDPR compliance policy to ensure the system meets regulatory obligations for personal data protection while preserving non-PII audit capability.

## Scope

This spec covers:

- Session data lifecycle beyond `archived` (the `purge_requested` and `purged` states)
- Participant data deletion via crypto-shredding
- Data export for data subject access requests
- Schema requirements for PII separation

## Non-Goals

- Consent collection UX
- Cookie policy or browser-side tracking
- Third-party data processor agreements
- Billing data retention (governed separately)

## Domain Dependencies

- [Session Model](../domain/session-model.md)
- [Participant And Membership Model](../domain/participant-and-membership-model.md)

## Architectural Dependencies

- [Data Architecture](../architecture/data-architecture.md)
- [Security Architecture](../architecture/security-architecture.md)

## Required Behavior

### Session States Beyond Archived

- The session lifecycle must include two additional states beyond `archived`: `purge_requested` and `purged`.
- `purge_requested`: a participant or admin has requested data purge for the session. The session is locked against further modification while purge processing is pending.
- `purged`: event payloads containing PII have been destroyed. Audit stubs (timestamps, event types, non-PII metadata) are retained.
- Allowed transitions: `archived -> purge_requested -> purged` and `closed -> purge_requested -> purged`. Both `archived` and `closed` sessions may be purged. Purge is irreversible. A `purged` session must not transition to any other state.

### Retention Policy

- Archived sessions must be retained for 90 days from the date of archival.
- After the 90-day retention period, archived sessions become eligible for purge. Eligibility does not imply automatic purge; purge must be triggered explicitly by a participant request, admin action, or automated retention policy execution.

### Crypto-shredding (SQLite Event Log)

- PII fields in session events must be encrypted with per-participant AES-256-GCM keys.
- Per-participant encryption keys must be stored in a separate `participant_keys` table, not inline with event data.
- Deletion of a participant's data must be accomplished by deleting their key from `participant_keys`. Once the key is deleted, the encrypted PII fields become unrecoverable.
- Non-PII fields must remain in plaintext for audit and operational purposes.

### Postgres (Control Plane) Deletion

- Participant records in the control plane Postgres database must be hard-deleted upon a valid deletion request.
- References to the deleted participant in membership and invite records must be anonymized (the data-subject FK is nulled via `ON DELETE SET NULL` — see [§Shred Fan-Out](#shred-fan-out) Path 2 FK-safety) rather than the row deleted, preserving the surviving record and its referential integrity while severing the participant linkage.

### Data Export

- The system must support JSON export of all events authored by or mentioning a specific participant.
- Export must additionally include the decrypted `replacementSend` bodies of `interventions` rows whose `pii_participant_id` stamps the participant (the [Spec-004](004-queue-steer-pause-resume.md) edit-and-resend composite's at-rest copy; added 2026-08-17, PR #344 round-2 fold) — text that exists only on a refused or suppressed intervention row is still the participant's authored content, and the event-scoped selector alone would miss it.
- Exported events must be decrypted using the participant's key from `participant_keys`.
- Export must be completable before key deletion to satisfy data subject access request obligations.

### Schema Requirements

- PII must be stored in a separate `pii_payload` column (encrypted) from day one. Non-PII must be stored in a `payload` column (plaintext).
- This schema separation must be present in the initial V1 schema to avoid costly migration later.

### Data Map Prerequisite

- A data map documenting all PII fields across both the SQLite event log and Postgres control plane must be produced before crypto-shredding logic is implemented. The PII data map is documented in the [PII Data Map](#pii-data-map) section below.

## Default Behavior

- Newly archived sessions begin their 90-day retention countdown immediately upon entering the `archived` state.
- No session is purged automatically without an explicit trigger (participant request, admin action, or retention policy execution).

## Fallback Behavior

- If the `participant_keys` table is unavailable during a data export request, the export must fail with a clear error rather than returning partially decrypted or corrupted data.
- If a purge operation fails midway, the session must remain in `purge_requested` state and the failure must be logged for operator retry. Partial purge must not leave the session in `purged` state.

## Interfaces And Contracts

- `POST /sessions/{id}/purge` must transition an `archived` session to `purge_requested` and enqueue purge processing.
- `GET /participants/{id}/export` must return a JSON export of all events associated with the participant, decrypted with their key — plus the decrypted intervention-row replacement-send bodies stamped with the participant (the [Spec-004](004-queue-steer-pause-resume.md) at-rest copy per §Data Export).
- `DELETE /participants/{id}/data` must delete the participant's key from `participant_keys` (crypto-shredding) and hard-delete their Postgres records.
- All deletion and export endpoints must require authenticated admin or self-service participant authorization.
- See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed request/response schemas.
- See [Error Contracts](../architecture/contracts/error-contracts.md) for error response schemas and error codes.

## State And Data Implications

- The `purge_requested` and `purged` states extend the session state model defined in [Session Model](../domain/session-model.md).
- The `participant_keys` table introduces a new storage dependency for the SQLite event log.
- Crypto-shredding means that once a key is deleted, historical PII in the event log is permanently unrecoverable. This is by design.
- Audit stubs in `purged` sessions provide a non-PII record that the session existed and what structural events occurred.

## PII Payload Column Pattern

Tables with PII in the SQLite event log use a dedicated encrypted column to separate PII from non-PII data:

- **Table**: `session_events` contains a `pii_payload BLOB` column (see [Local SQLite Schema](../architecture/schemas/local-sqlite-schema.md)).
- **Encryption**: Per-participant **AES-256-GCM** with a random 96-bit nonce per write and AAD = `participant_id || event_id` (record-binding — a ciphertext cannot be replayed onto another participant or event). Each participant has a unique content key stored in the `participant_keys` table.
- **Encryption flow**: PII fields (user messages, file paths, code snippets) are extracted from the event payload, encrypted with the participant's content key, and stored in `pii_payload`. The main `payload` column contains only non-PII data (event type metadata, timestamps, structural references).
- **Content-key provisioning**: The per-participant content key is a **random 32-byte AES-256 key** generated by the platform CSPRNG at participant provisioning — **not** derived from the participant's credentials or any identity record. Its only persisted copy is `participant_keys.encrypted_key_blob`, where it is envelope-encrypted (wrapped) under the daemon master key via XChaCha20-Poly1305 with AAD = `participant_id || "ais.master-wrap.v1" || key_version` (binding the wrap to the participant and key version, I-022-9). Because the key is random with no derivation, deleting the `participant_keys` row is a true cryptographic erasure: no surviving secret — credential, identity record, daemon master key, or retained signature — can reconstruct it (I-022-14). This is the GDPR Article 17 crypto-shred precondition; a credential- or identity-derived key would survive the row-DELETE via its source secret and silently defeat erasure. Envelope encryption (a random DEK wrapped by a KEK) is the AWS KMS / Google Cloud KMS / Rails ActiveRecord Encryption consensus and the only construction under which a row-DELETE is true erasure (Plan-022 D-022-2).
- **Tables that do NOT get `pii_payload`**: All Postgres control-plane tables. PII in Postgres is handled via access control and row-level deletion, not column-level encryption. The control plane is a trusted environment with its own access boundaries.

### Participant Keys

The `participant_keys` table (SQLite, owned by Spec-022) stores per-participant encryption keys for the crypto-shredding mechanism.

**Schema** (matches [Local SQLite Schema](../architecture/schemas/local-sqlite-schema.md)):

```
participant_id      TEXT NOT NULL PRIMARY KEY
encrypted_key_blob  BLOB NOT NULL            -- random per-participant AES-256 content key (DEK), XChaCha20-Poly1305-wrapped under the daemon master key (AAD = participant_id || "ais.master-wrap.v1" || key_version)
key_version         INTEGER NOT NULL DEFAULT 1
created_at          TEXT NOT NULL             -- ISO 8601
rotated_at          TEXT                      -- ISO 8601, NULL until first rotation
```

**Key rotation**: Out of scope in V1 — `key_version` stays `1` and `rotated_at` stays NULL (I-022-10). Because the content key is a random DEK (not credential-derived), rotation — a future V1.1 capability — is DEK re-generation + historical re-encryption, **not** a credential-driven re-derivation; a participant credential change re-wraps only the daemon master key (§Daemon Master Key), never the random content DEKs, which are wrapped under the master and unaffected. When rotation ships, the prior `key_version` is retained for decrypting historical events until re-encryption completes, with `key_version` incremented and `rotated_at` updated; the wrap AAD already binds `key_version` for that v1/v2 disambiguation (D-022-6).

**Key deletion (crypto-shredding)**: Deleting a participant's row from `participant_keys` makes all their PII in `session_events.pii_payload` permanently unrecoverable. This is the GDPR right-to-erasure mechanism for the SQLite event log.

### Daemon Master Key

The daemon master key is the symmetric key under which all per-participant AES-256-GCM keys in `participant_keys.encrypted_key_blob` are wrapped. Its custody model is defined in this section.

**Custody model**: The master key is wrapped by a key-encryption key (KEK) derived from participant credentials. The plaintext master key never touches persistent storage; only the wrapped blob is persisted.

**Custody ladder (two tiers + refuse)**:

1. **Tier 1 (preferred) — OS keystore caches wrapped blob**. The wrapped master key blob is stored in the OS-native credential store (`@napi-rs/keyring` v1.2.0 on daemon host):
   - macOS: login keychain service item, `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`.
   - Windows: `CRED_TYPE_GENERIC` credential, `CRED_PERSIST_LOCAL_MACHINE` (not `CRED_PERSIST_ENTERPRISE` — prevents profile roaming into backup scope).
   - Linux: Secret Service API (`libsecret`) with `default` collection and `org.freedesktop.secret.NotFromRoaming` attribute when the provider supports it; falls back to `kwallet6` or headless `keyutils` keyring if Secret Service is unavailable.

2. **Tier 2 (fallback) — encrypted file at `$XDG_DATA_HOME/ai-sidekicks/daemon-master.enc`** (resolved per platform: `~/Library/Application Support/ai-sidekicks/` on macOS, `%APPDATA%\ai-sidekicks\` on Windows, `$XDG_DATA_HOME` with `~/.local/share/ai-sidekicks/` default on Linux). File mode `0600` on POSIX; NTFS ACL restricting read to the daemon's service account on Windows.

3. **Tier 3 — refuse**. If both tier 1 and tier 2 writes fail during initial setup, or if both reads fail during daemon start, the daemon must exit with a non-zero status and a clear error. It must not fall back to a plaintext master or an in-memory-only master that cannot survive restart.

The tier 1 and tier 2 blobs are byte-identical; tier 1 is cache, tier 2 is the authoritative persisted form. A tier 1 miss triggers a tier 2 read, which on success repopulates tier 1.

**KEK derivation (two branches within tier 1)**:

- **Desktop (Electron shell, WebAuthn-capable)**: `KEK = HKDF-SHA256(prf_output, salt, info="ai-sidekicks/daemon-master/v1")` where `prf_output` is the 32-byte `CredentialsContainer.prfResults.first` value obtained from a WebAuthn assertion with the `prf` extension (W3C WebAuthn Level 3 CR, 2026-02-10). The PRF credential is bound to the participant's hardware authenticator (TPM, Secure Enclave, FIDO key). `salt` is 16 bytes, stored in the on-disk header.

- **CLI (headless, no WebAuthn)**: `KEK = Argon2id(passphrase, salt, m=19456 KiB, t=2, p=1)` (OWASP 2026 baseline). The participant is prompted for their passphrase at daemon start. Parameters are stored in the on-disk header for forward-compatibility.

**On-disk format** (extends [ADR-021](../decisions/021-cli-identity-key-storage-custody.md)'s envelope shape; ADR-021 defines a single `version=0x01` envelope for CLI identity-key storage — Spec-022 adds a KEK-branch byte at the same position where `0x01` denotes the PRF-KEK branch and `0x02` denotes the Argon2id-passphrase-KEK branch, with the remaining parameter fields zeroed under the PRF branch):

```
[version:1][argon2_m:4][argon2_t:4][argon2_p:1][salt:16][nonce:24][ciphertext:32+tag:16]
```

- `version`: `0x01` for PRF-KEK branch, `0x02` for Argon2id-passphrase-KEK branch. The remaining parameter fields are zeroed under the PRF branch.
- `salt`: 16 bytes, generated once with `randombytes_buf` and persisted. Salt is not a secret.
- `nonce`: 24-byte XChaCha20-Poly1305 nonce.
- `ciphertext||tag`: XChaCha20-Poly1305-AEAD of the 32-byte master key. AAD is the **full 50-byte header** (every byte preceding the AEAD body — `version`, KDF params, `salt`, and `nonce`), binding the `version` KEK-branch discriminator byte so a flipped version byte fails authentication and branch-confusion downgrade is blocked (`ADR-021 §Tier 2 — Argon2id-encrypted file (fallback)`; I-022-4; ratified D-022-1(b), resolving the prior 25-byte-vs-50-byte inconsistency in favour of the full header).

Total: 50-byte header + 48-byte AEAD body = 98 bytes per envelope (matches [ADR-021](../decisions/021-cli-identity-key-storage-custody.md)'s Tier 2 file format).

**In-memory handling**:

- Master key is allocated in memory locked with `sodium_mlock` (libsodium / sodium-native v5.1.0). This prevents swap-to-disk on all platforms and sets `MADV_DONTDUMP` on Linux.
- Master key is zeroed with `sodium_memzero` and unlocked with `sodium_munlock` on wipe events.
- Wipe events:
  - **Idle wipe**: default 15 minutes without a `participant_keys` read or write. Configurable via `daemon.master_key.idle_wipe_seconds` (minimum 60, no maximum). Re-unwrap via keystore + PRF assertion (desktop) or passphrase prompt (CLI) on next access.
  - **Shutdown wipe**: on `SIGTERM`, `SIGINT`, or orderly daemon shutdown. Wipe happens before closing SQLite handles so no encryption operation can execute during teardown.
  - **Lock wipe**: when the participant explicitly locks the daemon (`ai-sidekicks daemon lock`).

**Rotation policy**:

- **Rotate-on-shred**: when a participant invokes `DELETE /participants/{id}/data` or an admin initiates purge, the daemon MUST:
  1. Generate a fresh 32-byte master key `M'`.
  2. Re-wrap every remaining row in `participant_keys` by decrypting `encrypted_key_blob` with the old master `M` and re-encrypting with `M'`. The per-participant AES-256-GCM keys themselves are unchanged; only the outer wrap changes.
  3. Wrap `M'` under the current participant credential's KEK. Overwrite the tier 1 and tier 2 blobs with the new envelope; this destroys the prior envelope that was wrapping `M`.
  4. Zero `M` in memory.

  **Atomicity and crash recovery**:

  SQLite and the OS keystore are distinct durability domains. SQLite cannot roll back a keystore write, so steps 2-4 cannot be wrapped in a single ACID transaction. The daemon instead uses a write-ahead sentinel in SQLite as the recovery anchor for the non-transactional keystore/file work:
  - Step 2 executes inside a single SQLite `BEGIN EXCLUSIVE` transaction that also inserts a `rotation_in_progress` sentinel row containing the new wrapped-master envelope (wrapped under the current credential's KEK). Partial row re-wraps are not observable: either every row is under `M'` after commit or every row remains under `M`.
  - Step 3 (tier 1 + tier 2 overwrite) runs after the SQLite commit. Keystore and file writes are not inside the SQLite transaction.
  - Step 4 (zero `M` in memory) runs after step 3 reports success on both tiers. A follow-up SQLite write then clears the `rotation_in_progress` sentinel.
  - A crash between step 2 commit and sentinel clearance is recoverable without operator intervention. On daemon start, if the sentinel is present, the daemon uses the sentinel's envelope (which unwraps to `M'`) in preference to the tier 1 + tier 2 blob (still wrapping `M`), retries step 3, and clears the sentinel on success. No data is lost; approvals are never observed under mixed-wrap state.
  - A participant-credential change is blocked while the sentinel is present. A credential change completed between step 2 commit and recovery would re-derive the KEK such that the sentinel's envelope could no longer be unwrapped, and the re-wrapped rows would become permanently inaccessible.

  This makes any pre-rotation backup containing the old wrapped master blob irrecoverable — restoring it produces ciphertext that no remaining credential can unwrap. This is the load-bearing mechanism that prevents crypto-shred circumvention via backup restore.

- **Rotate-on-credential-change**: on WebAuthn credential re-enrollment or passphrase change, re-wrap only the master key (not the inner `participant_keys` rows). Persist new envelope to tier 1 + tier 2.

- **No periodic rotation**: unlike relay session keys, the master key is not rotated on a calendar schedule. Rotation is event-driven (shred, credential change). NIST SP 800-38D's ~2^32 AEAD-encryption ceiling does not bind here: master key performs O(participants) wrap operations, not O(events).

**Backup separation constraint**:

- The daemon master key's wrapped form is inside the OS keystore (tier 1) and/or `$XDG_DATA_HOME/ai-sidekicks/daemon-master.enc` (tier 2). Both MUST be excluded from backups that include `participant_keys`.
- The plaintext master key MUST never be written anywhere that can be backed up — it lives only in `sodium_mlock`-locked memory.
- On a fresh restore, the master key is NOT recovered from the backup. It is recovered by the participant re-authenticating their credential (WebAuthn PRF ceremony or passphrase prompt) against the tier 1 or tier 2 wrapped blob that was written out-of-band (see [Local Persistence Repair And Restore](../operations/local-persistence-repair-and-restore.md#backup-constraints)).
- Operator responsibility: on macOS, exclude `~/Library/Keychains/` from Time Machine via `tmutil addexclusion`. On Linux with libsecret, exclude `~/.local/share/keyrings/` from home-directory backups. On Windows, prefer `CRED_PERSIST_LOCAL_MACHINE` over `CRED_PERSIST_ENTERPRISE` so the credential does not roam into File History / OneDrive Folder Backup.

**Cross-reference to ADR-021**:

The CLI identity key storage custody policy in [ADR-021](../decisions/021-cli-identity-key-storage-custody.md) uses a three-tier ladder (OS keystore → Argon2id-encrypted file → refuse) in which the **OS keystore is the authoritative custody boundary**. The daemon master key uses a two-tier + refuse ladder in which the **participant credential is the authoritative custody boundary** and the keystore is a non-authoritative cache of the wrapped blob.

This divergence is intentional. The CLI identity key's loss is a liveness failure (cannot authenticate to relay); durability is the priority. The daemon master key's destruction is a GDPR Article 17 right-to-erasure feature; binding-to-credential is the priority. Readers implementing or reviewing this section should NOT assume ADR-021's custody model applies here.

**Explicitly NOT claimed**:

- No HSM or FIPS 140-2 Level 3 hardware custody. Master key lives in general-purpose RAM.
- No SGX, TrustZone, or equivalent trusted execution environment protection.
- No Secure Enclave custody for the master key. (Desktop PRF credentials may be Secure-Enclave-backed on Apple platforms; that is an attribute of the credential, not of the master key.)
- No protection against a root-privileged attacker on the daemon host. If an attacker can read the daemon process's memory while the master key is unlocked, the master key is exposed.
- No protection against a weak passphrase in the CLI branch. Argon2id with OWASP 2026 parameters raises the cost of offline brute-force but does not prevent it for guessable passphrases.
- No protection against exfiltration of the WebAuthn PRF credential. If an attacker can cause the credential to emit a PRF output (e.g., by coercing the user at the physical authenticator), they can unwrap any envelope encrypted under that credential's PRF output.
- No crypto-agility for AEAD. XChaCha20-Poly1305 is fixed for V1. Migration to a different AEAD requires re-wrapping every envelope.
- No distributed master key. The master is per-daemon-host. Multi-host deployment is out of scope for V1.

## PII Data Map

The data map enumerates **every** PII-carrying path reachable from `DELETE /participants/{id}/data`. [BL-066](../archive/backlog-archive.md) requires exhaustive enumeration so the shred fan-out in the next section has no gaps. Paths are grouped by durability tier.

**Durable tier (canonical audit log + control plane):**

| Table | Column | PII Type | Retention | Shredding |
| --- | --- | --- | --- | --- |
| `session_events` (SQLite) | `pii_payload` | User messages, file paths, code snippets | 90 days (full) / indefinite (audit stub) | Crypto-shred via participant key deletion |
| `interventions` (SQLite) | `pii_payload` | Rollback replacement-send message body (the [Spec-004](004-queue-steer-pause-resume.md) edit-and-resend composite's at-rest copy; added 2026-08-17, PR #344 round-2 fold) | 90 days (full), then NULLed by the daemon retention pass — a plain NULL-out, not a stub: no digest or anchor binding attaches to this ciphertext, unlike `session_events`; the non-PII intervention audit record is retained for the row's lifetime | Crypto-shred via participant key deletion — same `participant_keys` DEK as `session_events.pii_payload`, so Path 1 shreds both copies identically (`pii_participant_id` is the selector stamp) |
| `artifact_encryption_keys` (SQLite, daemon-local) | `encrypted_private_key` | Key material — per-`(participant, node)` durable artifact-encryption X25519 private key (master-key-wrapped); unwraps relay-held artifact CEKs | Participant lifetime (active); rotation-retired rows until `retired_at + 30 d + 48 h` | Row DELETE on participant erasure, active + retired together ([§Shred Fan-Out](#shred-fan-out) Path 1; [Spec-014 §Cross-Node Artifact Relay (V1)](014-artifacts-files-and-attachments.md#cross-node-artifact-relay-v1) Delete step 9) |
| `artifact_manifests` (SQLite) | `relay_cek_ciphertext` | Key material — publisher-retained per-artifact CEK (master-key-wrapped); decrypts the relay-pinned ciphertext copy | Artifact lifetime; NULL unless relay-bound (set at the first shareable publish, before any pin) | Dies with the manifest row on artifact deletion, or with daemon master-key destruction ([§Daemon Master Key](#daemon-master-key)); deliberately not a per-participant sweep — see the artifact-payload posture note below |
| `participants` (PG) | `display_name` | Name | Account lifetime | DELETE row on account deletion |
| `participants` (PG) | `identity_ref` | Email/OAuth ID | Account lifetime | DELETE row on account deletion |
| `identity_mappings` (PG) | `external_id` | Provider-specific ID | Account lifetime | DELETE row on account deletion |
| `participant_identity_keys` (PG) | `key_fingerprint`, `public_key` | Person-bound workstation identity-key identifiers (Ed25519 public halves — identifier-class PII: each row names one of the participant's devices, and the set size is their workstation count) | Account lifetime | DELETE row on account deletion (inside the Path-2 FK closure by construction — Plan-018 T5.1, 2026-08-15; safe at live-verification semantics, no retained row re-verifies post-erasure) |
| `session_invites` (PG) | `token_hash` | Invite token hash | Invite lifetime | DELETE row on invite expiry/revocation |
| `notification_preferences` (PG) | `preference_value` | Notification settings | Account lifetime | DELETE row on account deletion |
| `notification_queue` (PG) | `summary` | Derived notification-render string | 7 days (queue retention), then permanent deletion | DELETE row on account deletion |
| `session_channel_directory` (PG) | `name` | User-supplied channel name — pair-attributed PII on `direct` rows (2026-08-11) | Channel lifetime | `direct` rows: cleared by the pre-delete content-clearing `UPDATE` on either pair member's erasure ([§Shred Fan-Out](#shred-fan-out) Path 2; unresurrectable — `name` is in the ingest's create-once binding); non-`direct` rows: retained as session work product (the artifact posture below — the recorded residual: a group-channel name is shared work product even when its text mentions a person) |

> **Artifact-payload posture (2026-07-09 relay amendment).** Artifact manifests and their CAS payloads (`artifact_manifests` + `artifact_payload_refs`, and the relay's TTL-bounded ciphertext copy) are deliberately **not** per-participant erasure paths: an artifact is work-product published into a shared session — a session record under the same recipient-relative reading the shred posture already relies on ([Spec-014 §Cross-Node Artifact Relay (V1)](014-artifacts-files-and-attachments.md#cross-node-artifact-relay-v1) Delete step 9) — deletable and redactable while its publisher is active via artifact deletion and the derivative model. Erasure severs the participant's **reach**: Path 1 destroys their decryption capability (`participant_keys`, `artifact_encryption_keys`), Path 2 hard-DELETEs their relay recipient rows, and relay ciphertext dies by delivery refcount or TTL. The publisher-retained `relay_cek_ciphertext` (row above) stays sealed under the daemon master key beside the CAS plaintext it encrypts — it grants nothing the publishing machine does not already hold, and it dies with the manifest row or the master key. The manifest's nullable `created_by` attribution stamp (added 2026-08-17, PR #341 — the permission-matrix Delete rule's own-artifacts basis) takes the same reading: retained as work-product attribution for the manifest's lifetime, not a per-participant erasure path — erasure severs the participant's reach, not the session's record of who published.

**Bounded-retention diagnostic tier (daemon-local, non-canonical per [Spec-020 §Required Behavior](020-observability-and-failure-recovery.md#required-behavior)):**

| Table | Column | PII Type | Retention | Shredding |
| --- | --- | --- | --- | --- |
| `driver_raw_events` (SQLite, daemon-local) | `bucket_payload` | Provider-native prompts, completions, tool-call bodies | ≤ 7 days (bounded) | TTL bucket purge; participant-scoped rows purged on shred |
| `command_output` (SQLite, daemon-local) | `bucket_payload` | Shell command output (stdout / stderr bytes) | ≤ 7 days (bounded) | TTL bucket purge; participant-scoped rows purged on shred |
| `tool_traces` (SQLite, daemon-local) | `bucket_payload` | Tool call arguments and result bodies | ≤ 7 days (bounded) | TTL bucket purge; participant-scoped rows purged on shred |
| `reasoning_detail` (SQLite, daemon-local) | `bucket_payload` | Full reasoning/thinking payloads (if policy-enabled) | ≤ 7 days detailed / indefinite summary-only | TTL bucket purge on detailed; summary retained (non-PII stub per [Spec-006 §Event Compaction Policy](006-session-event-taxonomy-and-audit-log.md#event-compaction-policy)) |

> **Bucket-column shape (D-022-4).** Each of the four diagnostic tables stores its PII in a single `bucket_payload BLOB` column — the canonical shape per [Local SQLite Schema](../architecture/schemas/local-sqlite-schema.md), which is the build-time authority. Earlier drafts glossed these as per-field columns (`raw_payload`, `stdout`/`stderr`, `args`/`result_body`, `detailed_payload`); the **PII Type** column above names what each bucket carries, not separate columns. The map is reconciled to the single-`bucket_payload` shape here.

**Telemetry export tier (OTel/Datadog/Sentry sinks — optional, opt-in):**

| Sink | Attribute | PII Type | Retention | Shredding |
| --- | --- | --- | --- | --- |
| OTel span attributes (outbound) | `gen_ai.prompt`, `gen_ai.completion` | Model prompts/completions if opt-in | Per remote sink | Redacted by default (see [Spec-020 §PII in Diagnostics](020-observability-and-failure-recovery.md#pii-in-diagnostics)); opt-in required |
| OTel log body (outbound) | log `body` | Free-text log lines that may contain PII | Per remote sink | Redacted by default; operator scrubbing policy required |
| Error-tracker sink (outbound) | `request`, `extra` | Exception context that may reference PII | Per remote sink | Server-side scrubbing required (default-deny keyname list) |

Signed canonical-event bytes (`session_events.signature_payload`) are **not** a shred path — they are analyzed under [§Signature Safety Under Shred](#signature-safety-under-shred) below. The canonical form deliberately excludes `pii_payload` and embeds `pii_ciphertext_digest` (BLAKE3 over ciphertext) so the signature survives crypto-shred intact while committing to no plaintext PII.

## Data Retention and Deletion Policy

This section verifies end-to-end GDPR coverage across both storage tiers.

- **Crypto-shredding**: Verified. Deleting a participant's row from `participant_keys` renders all their `pii_payload` data in the SQLite event log permanently unrecoverable.
- **Data export**: Verified. `GET /participants/{id}/export` decrypts and exports all PII for a participant using their key from `participant_keys`. Export must be completed before key deletion.
- **90-day retention**: Verified. The event compaction policy ([Spec-006](006-session-event-taxonomy-and-audit-log.md)) compacts events older than 90 days; PII is stripped at compaction, leaving only audit stubs.
- **Purge lifecycle**: Verified. Session states `purge_requested` and `purged` exist in the [Session Model](../domain/session-model.md) with transitions `archived -> purge_requested -> purged` and `closed -> purge_requested -> purged`.
- **Right to erasure**: Participant deletion triggers the following sequence:
  1. Crypto-shred via key deletion (DELETE from `participant_keys` and `artifact_encryption_keys`, active + retired rows together)
  2. DELETE Postgres PII rows across the full `REFERENCES participants(id)` inbound-FK closure plus the identity-keyed rate-limit rows (per-table dispositions in [§Shred Fan-Out](#shred-fan-out) Path 2)
  3. Revoke all session memberships (anonymize membership references via `ON DELETE SET NULL` — see [§Shred Fan-Out](#shred-fan-out) Path 2 FK-safety)
  4. Emit `participant.purged` event for audit trail (see [Spec-006 §Participant Lifecycle](006-session-event-taxonomy-and-audit-log.md#participant-lifecycle-participant_lifecycle))

## Shred Fan-Out

`DELETE /participants/{id}/data` fans out across three independent storage paths enumerated below. All three MUST complete before the daemon emits `participant.purged`; on any per-path failure, `participant.purge_requested` remains the most recent durable state and the failure is logged for operator retry per [§Fallback Behavior](#fallback-behavior). No `participant.purged` event is emitted against a partial shred.

In V1, before the automated `gdpr.*` endpoint ships (Plan-022 defers it to V1.1), an operator services this fan-out by hand following the [GDPR Manual Erasure Runbook](../operations/gdpr-manual-erasure-runbook.md), which renders the Path 1 → Path 2 → Path 3 ordering below as an executable, idempotent operator sequence.

### Path 1 — SQLite `session_events.pii_payload` (crypto-shred)

**Mechanism.** DELETE the participant's row from `participant_keys`. The per-participant AES-256-GCM key is destroyed; all `pii_payload` ciphertext bytes across every session the participant touched become permanently unrecoverable. **Also DELETE their row from `artifact_encryption_keys`** (Plan-014, 2026-07-09 cross-node relay key model) on every node the participant runs: that row holds the master-key-wrapped private half of their durable artifact-encryption X25519 key, which is what unwraps relay-held CEKs — leaving it behind would preserve the participant's reach to artifact ciphertext their Path-2 `artifact_relay_recipients` deletion was meant to sever ([Spec-014 §Cross-Node Artifact Relay (V1)](./014-artifacts-files-and-attachments.md#cross-node-artifact-relay-v1) Delete step 9, CP-014-2). Both deletions are true cryptographic erasure for the same reason: each row's key is random (not credential-derived) and its only persisted copy is the wrapped blob in that row.

**Scope.** Every `session_events` row with a non-NULL `pii_payload` authored by or containing the participant's PII — and every `interventions` row whose `pii_participant_id` stamps the participant (the [Spec-004](004-queue-steer-pause-resume.md) replacement-send body encrypts under the same per-participant DEK, so the key deletion shreds both copies in one act; added 2026-08-17, PR #344 round-2 fold). The SQL selector uses the durable participant-id stamp on the row, not the ciphertext (which is opaque). Membership-level references in other participants' events remain, but their `pii_payload` columns — if any — are encrypted under a different participant's key and are not affected.

**Audit artifact.** One `event.shredded` event emitted per `Spec-006 §Event Maintenance (event_maintenance)` carrying `{participantId, affectedSessionIds[], piiPayloadsCleared, shredReason}`. The event's own payload contains no PII; it is retained indefinitely.

### Path 2 — Postgres PII rows (hard DELETE)

**Mechanism.** Path 2 is exhaustive over the complete `REFERENCES participants(id)` inbound-foreign-key closure in [shared-postgres-schema.md](../architecture/schemas/shared-postgres-schema.md) — not only the PII-content columns in the [§PII Data Map](#pii-data-map) durable tier, but **every** Postgres row that links to the erased participant — **plus** the two Plan-021 rate-limit tables, which reference participants by TEXT identity rather than FK and therefore sit outside the FK closure (explicit identity-keyed selectors below; Plan-021 D-021-13, Tier-6 audit), **plus** one content-clearing `UPDATE` on `session_channel_directory.name` for `direct` rows pairing the erased participant — an FK `DELETE`/`SET NULL` cannot clear a sibling content column, so the selector is explicit (2026-08-11; in the anonymize bullet below). Per-table disposition by retention basis:

- **Hard DELETE** (no independent retention basis): `participants`, `identity_mappings` (Plan-018), `participant_identity_keys` (Plan-018 T5.1, 2026-08-15 — person-bound workstation identity keys; deleting them is safe at live-verification semantics, since every consumer of the roster — bundle admission, attestation delivery, dispatch intake — verifies at live time and no retained row re-verifies a participant signature post-erasure), `notification_preferences` (Plan-019), `notification_queue` (Plan-019 — queued-but-undelivered notification rows; the derived `summary` render string is personal content, so severing the FK alone would leave data behind; added at the 2026-08-10 Tier-8 readiness audit), `runtime_node_attachments` (Plan-003 — operational node-attach state; the durable node-attach audit trail is the crypto-shredded `runtime_node.*` event stream, not this table), `artifact_relay_recipients` (Plan-014, 2026-07-08 cross-node relay amendment — per-blob wrapped-CEK + delivery rows; deleting them IS the crypto-shred of the participant's reach to relay-held artifact ciphertext and removes them from the intended-recipient set, keeping refcount GC consistent — [Spec-014 §Cross-Node Artifact Relay (V1)](./014-artifacts-files-and-attachments.md#cross-node-artifact-relay-v1), CP-014-2), `cross_node_dispatch_coordination` (Plan-027 — routing metadata only), `rate_limit_escalations` (Plan-021 — ephemeral ≤1-hour escalation state; **not** in the FK closure: selector is `WHERE identity = <participantId> AND identity_type = 'participant'`). Hosted deployments additionally hold per-identity escalation/window state in `RateLimitEscalationDO`; it is self-evicting (all fields horizon-bounded ≤1 hr; the DO's alarm `deleteAll`s storage once expired — Plan-021 D-021-13), so erasure requires no manual DO step. Self-host Postgres escalation rows are likewise actively swept (`PostgresEscalationStore.sweepExpired()`, 10-minute interval — Plan-021 D-021-13), so stale rows never await an erasure request.
- **Retain (GDPR Art. 17(3) abuse-prevention legitimate-interest carve-out)**: `admin_bans` (Plan-021) — rows are retained as-is on erasure, including rows whose `identity_type = 'participant'` identity matches the erased participant and rows naming the erased participant in `issued_by`/`revoked_by` (TEXT columns, deliberately no FK). Erasure MUST NOT un-ban an identity, and operator attribution MUST survive; revoked or expired rows become purgeable 90 days after revocation/expiry. No anonymization pass runs over this table.
- **Anonymize via `ON DELETE SET NULL`** (the data-subject FK is auto-nulled when the `participants` row is hard-deleted; the dependent row survives and the linkage is severed DB-side): `session_invites.inviter_id` (Plan-002), `session_memberships.participant_id` (Plan-001), `artifact_relay_blobs.publisher_participant_id` (Plan-014, 2026-07-08 — the relay blob survives to refcount-zero/TTL so other participants' availability is unaffected by the publisher's erasure; the publisher's own reach was already shredded via their `artifact_relay_recipients` rows), `session_terminal_leases.holder_participant_id` (Plan-024 Phase 3B, 2026-07-13 — auto-nulling converges on the correct fail-closed lease-free state while the per-session row survives as coordination state; **ordering:** the documented erasure flow ends the participant's memberships first, so the daemon's authorization-loss force-clear (`pty.control_changed`, [Spec-003 §Required Behavior](003-runtime-node-attach.md#required-behavior)) has already freed the lease and the `SET NULL` lands on an already-`NULL` holder as the DB-side idempotent backstop, never a daemon-bypassing primary transition — the erasure-runbook Precondition carries the operator check), and `session_channel_directory.member_pair_low_id` + `session_channel_directory.member_pair_high_id` (Plan-002, 2026-08-11 channel-directory amendment — the erased member's column auto-nulls while the directory row survives as channel-existence coordination state; a `NULL` pair member matches no caller under the fail-closed member-pair filter ([Spec-002 §Interfaces And Contracts](002-invite-membership-and-presence.md#interfaces-and-contracts)), so erasure **narrows** the channel's visibility and never widens it, and the DB-side severance sits outside the ingest's create-once disclosure binding by design; the row's `name` disposition is **scoped by kind** (2026-08-11, PR #322 Codex round 1 — honoring the [Spec-016 §Interfaces And Contracts](016-multi-agent-channels-and-orchestration.md#interfaces-and-contracts) carrier condition that routes the user-supplied `name` into this map): a `direct` row's `name` is pair-attributed PII, cleared via the explicit content-clearing selector `UPDATE session_channel_directory SET name = NULL WHERE member_pair_low_id = :pid OR member_pair_high_id = :pid` executed **before** the participant hard-DELETE (afterwards the `SET NULL` severance makes the rows unfindable by participant id) — intrinsically `direct`-scoped because only `direct` rows carry pair columns, and unresurrectable because `name` sits in the ingest's create-once binding so no redelivered or sweep publication rebinds it — while a non-`direct` row's `name` is retained as session work product under the same reading as the artifact posture above, the recorded residual in the §PII Data Map row) — per the §Postgres (Control Plane) Deletion behavior above and the **FK-safety** note below.
- **Anonymize-with-security-survival via `ON DELETE SET NULL`**: `revoked_jtis`, `revoked_token_families` (BL-070 token-revocation denylist) — the participant hard-DELETE auto-nulls `participant_id`, severing the data-subject linkage, while the denylist key (`jti` / `family_id`, the table PRIMARY KEY — **not** `participant_id`) is untouched and the row stays denied until its natural `expires_at + 24h` reap, so erasure does not resurrect a revoked token within its remaining validity window (the GDPR Art. 17(3) security/legal-obligation carve-out).

**FK-safety (the anonymize mechanism is `ON DELETE SET NULL`, not a tombstone row).** The eight anonymize-class FKs — `session_invites.inviter_id`, `session_memberships.participant_id`, `revoked_jtis.participant_id`, `revoked_token_families.participant_id`, `artifact_relay_blobs.publisher_participant_id` (the fifth joined 2026-07-08 with the cross-node relay amendment), `session_terminal_leases.holder_participant_id` (the sixth joined 2026-07-13 with the Spec-003 shared-terminal write-lease amendment), and `session_channel_directory.member_pair_low_id` + `session_channel_directory.member_pair_high_id` (the seventh and eighth joined 2026-08-11 with the Spec-002 channel-directory amendment) — all reference `participants(id)` and must survive the hard-DELETE of the participant they reference (their per-owner starting shapes differ — given below). Because erasure hard-DELETEs the `participants` row, an in-place rewrite to a non-participant "tombstone identifier" would violate the FK, and a _reserved tombstone participant row_ would collide on `session_memberships`'s `UNIQUE(session_id, participant_id)` whenever two participants in the same session are both erased. The uniform FK-safe mechanism is therefore `ON DELETE SET NULL`, applied per FK by its owner table's V1 status: the **two forward-ALTER FKs** (`session_invites.inviter_id`, `session_memberships.participant_id` — in-V1 tables shipped before this posture existed) are relaxed to nullable + `ON DELETE SET NULL` by **Plan-022's V1 control-plane migration** — a forward ALTER over the shipped owner tables — the **two `revoked_*` FKs** are born nullable + `ON DELETE SET NULL` at their **BL-070** build (an archived, post-V1 item; no V1 ALTER over a table V1 never creates), `artifact_relay_blobs.publisher_participant_id` is likewise **born nullable + `ON DELETE SET NULL` at its Plan-014 Tier-7 build** (no ALTER — the table does not exist before Plan-014 creates it), `session_terminal_leases.holder_participant_id` is **born nullable + `ON DELETE SET NULL` at its Plan-024 Phase 3B build** (same born-correct pattern; nullable is additionally its domain semantics — NULL is the lease-free state), and the two `session_channel_directory` pair FKs are **born nullable + `ON DELETE SET NULL` at their Plan-002 T3.7 build** (born-correct; nullable is likewise domain semantics — non-`direct` channels carry no pair — and the table's canonical-ordering CHECK is deliberately NULL-tolerant, `low IS NULL OR high IS NULL OR low < high`, so the FK-triggered `SET NULL` can never fail the parent DELETE against the check — [shared-postgres-schema.md §Session Channel Directory](../architecture/schemas/shared-postgres-schema.md#session-channel-directory-plan-002)). The migration is Plan-022's build ([D-022-7](../plans/022-data-retention-and-gdpr.md#ratified-design-decisions-tier-5-audit-2026-05-30)) — so the participant hard-DELETE auto-nulls each reference DB-side. `NULL` participant ids are distinct under `UNIQUE(session_id, participant_id)` (Postgres treats `NULL`s as non-equal), so multi-erasure is safe; the `revoked_*` denylist key survives the null because it is the PRIMARY KEY, not the FK.

**Scope.** Exhaustive over the `REFERENCES participants(id)` inbound-FK closure named in the Mechanism above — the closure is verifiable against [shared-postgres-schema.md](../architecture/schemas/shared-postgres-schema.md), so the set is the source of truth and cannot silently drift behind a hand-maintained list (the prior "exhaustive over the §PII Data Map durable tier" wording undercounted: the §PII Data Map enumerates PII-content columns, not the participant-FK-linkage tables) — plus the explicitly-enumerated identity-keyed Plan-021 tables above, which the FK-closure selector cannot find and which therefore ride this spec's disposition list as their source of truth (Plan-021 D-021-13) — plus the explicit `session_channel_directory.name` content-clearing selector above (2026-08-11): column content is invisible to an FK-driven `DELETE`/`SET NULL`, so it likewise rides this spec's disposition list as its source of truth. If any row fails its DELETE or the content-clearing UPDATE fails (foreign-key constraint, row lock, connection failure), the whole path is reported as failed; the daemon does not partially advance.

**Audit artifact.** No event-log row is emitted per Postgres table — the control plane's own Postgres audit logging (not in V1 scope) would record the DELETEs. The daemon records the aggregate `participant.purged` event only after all Postgres deletes succeed.

### Path 3 — Bounded-retention diagnostic buckets (TTL purge + scoped flush)

**Mechanism.** For each diagnostic table listed in the [§PII Data Map](#pii-data-map) bounded-retention tier (`driver_raw_events`, `command_output`, `tool_traces`, `reasoning_detail`):

1. Scoped flush: DELETE all rows tagged with the purged `participant_id`. This short-circuits the TTL — the rows are not waiting for the 7-day sweep.
2. Retention policy continues normally for other participants' rows.

The daemon MAY retain summary-only variants (e.g., `reasoning_summary` distinct from `reasoning_detail`) that never contained PII by construction per [Spec-020 §Required Behavior](020-observability-and-failure-recovery.md#required-behavior). Summary-only variants are not a shred path because their PII content is zero.

**Scope.** Every participant-scoped row in the bounded-retention diagnostic tier. The scoped flush is issued **before** `event.shredded` emission so the diagnostic rows are not observable by a reader between path 1 completion and this path completion.

**Audit artifact.** Counters only (`diagnostic_rows_purged` by table). The aggregate `participant.purged` event references the counts but does not enumerate row IDs.

### Ordering And Atomicity

Paths execute in the order Path 1 → Path 2 → Path 3, then the aggregate `participant.purged` event is emitted. Rationale:

- **Path 1 before Path 2** — crypto-shred first so a concurrent reader cannot decrypt `pii_payload` via a Postgres lookup chain during the Postgres-row-delete window. After Path 1, the ciphertext is unrecoverable regardless of what Postgres contains.
- **Path 2 before Path 3** — hard-delete the Postgres-side participant record before clearing diagnostic buckets so a diagnostic-bucket reader cannot re-derive PII via Postgres JOIN during the bucket-flush window.
- **Aggregate event last** — `participant.purged` is the durable audit artifact of the whole operation; emitting it before all three paths complete would misrepresent the operation's completion state.

No ACID transaction spans the three paths — SQLite and Postgres are distinct durability domains. Partial-completion recovery anchors on the earliest durable state (`participant.purge_requested` in SQLite + row-exists-in-Postgres) and the daemon re-executes the remaining paths on operator retry. Path 1 is idempotent (key already deleted is a no-op); Path 2 is idempotent (DELETE of already-deleted row affects zero rows); Path 3 is idempotent (flush of already-flushed buckets affects zero rows).

## Signature Safety Under Shred

Event rows carry an Ed25519 signature over the canonical bytes of the envelope per [Spec-006 §Integrity Protocol](006-session-event-taxonomy-and-audit-log.md#integrity-protocol). After a crypto-shred operation, the signature bytes remain in place for every pre-shred event. This section establishes that signatures do **not** re-introduce PII recoverability after a shred, so the integrity protocol and crypto-shred coexist.

### Argument

**Claim.** An attacker holding every pre-shred event row (including `signature_payload`) and the daemon's Ed25519 public key cannot recover the plaintext PII that was encrypted in `pii_payload` before the key was destroyed.

**Proof sketch.**

1. Per [Spec-006 §Canonical Serialization Rules](006-session-event-taxonomy-and-audit-log.md#canonical-serialization-rules), the canonical bytes include `id`, `sessionId`, `sequence`, `occurredAt`, `category`, `type`, `actor`, `payload`, `correlationId`, `causationId`, `version` — and **not** `pii_payload`. Events whose `pii_payload` is non-NULL embed `pii_ciphertext_digest` = `BLAKE3(pii_payload_ciphertext)` inside `payload`, which **is** in the canonical form — and, per that section's 2026-07-27 amendment, a `pii_participant_id` owner stamp alongside it. Both are members of `payload` rather than top-level fields, so the eleven-field envelope set above is unchanged.
2. The Ed25519 signature commits to the canonical bytes — i.e., to `pii_ciphertext_digest` and the `pii_participant_id` owner stamp, not to plaintext PII. The stamp does not weaken this claim: it is a participant identifier, not PII content, and the canonical form has committed to signed participant identifiers since it shipped because `actor` is already a member of the eleven. Per [RFC 8032 §5.1 — Ed25519](https://datatracker.ietf.org/doc/html/rfc8032#section-5.1), Ed25519 signature verification is a public operation: anyone with the public key can check that the signature matches the canonical bytes. No plaintext oracle is introduced by verification.
3. `pii_ciphertext_digest` is a BLAKE3 digest. BLAKE3 is one-way; given only the digest, recovering the preimage (the ciphertext bytes) requires brute force over the preimage space. The preimage space is ciphertext produced by AES-256-GCM, not plaintext.
4. Even if an attacker somehow recovered the ciphertext preimage of `pii_ciphertext_digest`, they would still need the per-participant AES-256-GCM key to decrypt. That key lived only in `participant_keys.encrypted_key_blob`, wrapped under the daemon master key. The `participant_keys` row was DELETEd in Path 1 of the shred fan-out; no credential can unwrap a key that is no longer present.
5. Per NIST SP 800-38D, AES-256-GCM provides no cryptanalytic shortcut that allows plaintext recovery without the key. Brute-forcing a 256-bit AES key is out of reach of any known-feasible attacker.

Therefore the signature bytes — although retained indefinitely for audit integrity — commit only to ciphertext that the shred operation rendered irrecoverable. Verification remains possible; plaintext recovery remains infeasible.

### Why This Matters

Without the `pii_ciphertext_digest` indirection, a naïve implementation might sign `(canonical_bytes || pii_payload_ciphertext)`. After a shred the ciphertext bytes are still on disk, with the signature over them retained beside them indefinitely — [§Shred Fan-Out](#shred-fan-out) Path 1 destroys the per-participant key and overwrites no column, so what a shred takes away is the ability to decrypt, not the bytes (corrected 2026-07-27: this paragraph previously described the ciphertext bytes as zeroed after a shred, contradicting the Path 1 mechanism defined above). Under that naïve construction the ciphertext would be an input to **verification itself**, so every party checking a retained audit row's signature would need the PII ciphertext in hand — and a sophisticated attacker holding the signature could additionally mount signature-commitment attacks to learn byte-level facts about the ciphertext (e.g., length, structure). The `pii_ciphertext_digest` indirection collapses ciphertext into a 32-byte BLAKE3 digest before the signature is computed, so the signature commits to a fixed-size preimage-hiding value instead of the variable-length ciphertext itself.

### Cross-Reference To Related Constraints

- [Spec-006 §Canonical Serialization Rules](006-session-event-taxonomy-and-audit-log.md#canonical-serialization-rules) — `pii_ciphertext_digest` field presence and position in canonical bytes
- [Spec-006 §Integrity Protocol](006-session-event-taxonomy-and-audit-log.md#integrity-protocol) — Ed25519 signature and BLAKE3 hash-chain over canonical bytes
- [Spec-006 §Event Maintenance](006-session-event-taxonomy-and-audit-log.md#event-maintenance-event_maintenance) — `event.shredded` audit artifact for the shred operation
- [Daemon Master Key](#daemon-master-key) above — master-key custody model that prevents backup-based key resurrection (the master key's deliberately-narrow custody makes Path 1 irreversible even under backup restore)

## Example Flows

- `Example: A participant requests data deletion. The system exports their data (if requested), deletes their key from participant_keys (rendering encrypted PII in the event log unrecoverable), hard-deletes their Postgres records, and anonymizes their membership references.`
- `Example: An admin triggers purge on a session that has been archived for 91 days. The session transitions to purge_requested, the system deletes all participant keys for that session, then the session transitions to purged. Audit stubs remain.`
- `Example: A participant requests a data export before account deletion. The system decrypts all events using their key and returns a JSON archive. After confirming receipt, the participant triggers deletion.`

## Implementation Notes

- Crypto-shredding logic is post-V1. The V1 deliverable is the schema support: the `pii_payload` encrypted column and the `participant_keys` table must ship in the initial schema.
- The data map of PII fields should be maintained as a living document alongside the data architecture.
- AES-256-GCM key generation must use a cryptographically secure random source. Key rotation is out of scope for V1.

## Pitfalls To Avoid

- Storing PII and non-PII in the same column, making crypto-shredding impossible without destroying audit data
- Assuming `DELETE` on Postgres is sufficient for GDPR compliance without also addressing the SQLite event log
- Allowing data export after key deletion (the export must happen first)
- Treating `purge_requested` as a terminal state instead of a transient processing state
- Shipping V1 without the `pii_payload` column, forcing a costly data migration later

## Acceptance Criteria

V1 ships the erasure _mechanism_ + the manual operator capability; the _automated_ deletion/export/purge handler is V1.1+ (see [§V1 Erasure Scope Boundary](#v1-erasure-scope-boundary) below). The criteria are grouped accordingly, so the V1 `gdpr.*` stubs that return not-implemented unconditionally do not read as failing this checklist.

**V1 — schema, mechanism, and manual capability:**

- [ ] Session state model includes `purge_requested` and `purged` states with correct transitions, including the irreversibility invariant (a `purged` session cannot transition to any other state).
- [ ] Archived sessions are retained for 90 days before becoming purge-eligible (retention policy recorded in schema).
- [ ] V1 schema includes `pii_payload` (encrypted) column separate from `payload` (plaintext).
- [ ] V1 schema includes `participant_keys` table for per-participant AES-256-GCM keys.
- [ ] Deleting a participant's key (manually, `DELETE FROM participant_keys`) renders their encrypted PII in the event log unrecoverable.
- [ ] V1 schema supports Postgres severance — the two forward-ALTER anonymize-class FKs (`session_memberships.participant_id`, `session_invites.inviter_id`) carry `ON DELETE SET NULL`, so a manual participant hard-delete anonymizes membership/invite references (the later-built FKs — `revoked_*` at BL-070, `artifact_relay_blobs.publisher_participant_id` at Plan-014's Tier-7 build, `session_terminal_leases.holder_participant_id` at Plan-024's Phase 3B build, and the two `session_channel_directory` member-pair FKs at Plan-002's T3.7 build — are born nullable + `ON DELETE SET NULL`; see §Shred Fan-Out FK-safety).
- [ ] The three `gdpr.*` daemon JSON-RPC methods exist as stubs that return a not-implemented error unconditionally (reserved surface, not silent non-existence).
- [ ] A data-subject erasure request is satisfiable via the documented [GDPR Manual Erasure Runbook](../operations/gdpr-manual-erasure-runbook.md) (crypto-shred + Postgres severance + the Path-1 → Path-2 → Path-3 fan-out).

**V1.1+ — automated handler (deferred per [§V1 Erasure Scope Boundary](#v1-erasure-scope-boundary)):**

- [ ] Automated data export returns a complete JSON archive of a participant's events, decrypted with their key.
- [ ] Automated participant deletion hard-deletes Postgres records and anonymizes membership/invite references upon a deletion request.
- [ ] Automated purge transitions a session to `purged`, retaining audit stubs (timestamps, event types, non-PII metadata) but no PII.

## ADR Triggers

- If the product requires PII retention beyond 90 days for legal hold or compliance, create an ADR documenting the exception and its justification.
- If crypto-shredding is replaced by a different deletion mechanism, create an ADR documenting the alternative and its trade-offs.
- If a third data store is introduced that holds PII, the data map and deletion strategy must be revisited.

## Resolved Questions and V1 Scope Decisions

- No blocking open questions remain for v1.
- Post-V1: determine whether key rotation for long-lived sessions is necessary and define the rotation protocol.

### V1 Erasure Scope Boundary

V1 ships the erasure _mechanism_, not its automated endpoint:

- **In V1:** the `pii_payload` encrypted column, the `participant_keys` table, the schema support for Postgres severance (the **two forward-ALTER** anonymize-class FKs' `ON DELETE SET NULL` relaxation — [§Shred Fan-Out](#shred-fan-out) Path 2 FK-safety), and the three `gdpr.*` daemon JSON-RPC stubs, which return a not-implemented error **unconditionally** (independent of request body or caller).
- **In V1.1+:** the _automated_ deletion/export/purge handler.

A data-subject erasure request is satisfiable in V1 by the documented **manual** operator procedure (crypto-shred via `DELETE FROM participant_keys`; Postgres severance via the `ON DELETE SET NULL` migration; the Path-1 → Path-2 → Path-3 fan-out), so the deferral withholds only the _automation_, not the _capability_. Promotion criteria for the automated endpoint — cross-tier fan-out completeness + the `ON DELETE SET NULL` forward ALTER + closure-equivalence tests — are enumerated in [Plan-022 §Non-Goals](../plans/022-data-retention-and-gdpr.md#non-goals); the interim manual operator procedure is the [GDPR Manual Erasure Runbook](../operations/gdpr-manual-erasure-runbook.md).

## References

- [Data Architecture](../architecture/data-architecture.md)
- [Session Model](../domain/session-model.md)
