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
- References to the deleted participant in membership and invite records must be anonymized (replaced with a tombstone identifier) rather than deleted, to preserve referential integrity.

### Data Export

- The system must support JSON export of all events authored by or mentioning a specific participant.
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
- `GET /participants/{id}/export` must return a JSON export of all events associated with the participant, decrypted with their key.
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
- **Encryption**: Per-participant AES-256-GCM. Each participant has a unique encryption key stored in the `participant_keys` table.
- **Encryption flow**: PII fields (user messages, file paths, code snippets) are extracted from the event payload, encrypted with the participant's key, and stored in `pii_payload`. The main `payload` column contains only non-PII data (event type metadata, timestamps, structural references).
- **Key derivation**: The participant key is derived from the participant's auth credentials using HKDF-SHA256. The derived key is then encrypted at rest with the daemon's master key before storage in `participant_keys.encrypted_key_blob`.
- **Tables that do NOT get `pii_payload`**: All Postgres control-plane tables. PII in Postgres is handled via access control and row-level deletion, not column-level encryption. The control plane is a trusted environment with its own access boundaries.

### Participant Keys

The `participant_keys` table (SQLite, owned by Spec-022) stores per-participant encryption keys for the crypto-shredding mechanism.

**Schema** (matches [Local SQLite Schema](../architecture/schemas/local-sqlite-schema.md)):

```
participant_id      TEXT NOT NULL PRIMARY KEY
encrypted_key_blob  BLOB NOT NULL            -- AES-256-GCM key, encrypted at rest with daemon master key
key_version         INTEGER NOT NULL DEFAULT 1
created_at          TEXT NOT NULL             -- ISO 8601
rotated_at          TEXT                      -- ISO 8601, NULL until first rotation
```

**Key rotation**: Triggered on password change or explicit rotation request. When a key is rotated, the old key version is retained for decrypting historical events until re-encryption of those events with the new key is complete. The `key_version` column is incremented and `rotated_at` is updated on each rotation.

**Key deletion (crypto-shredding)**: Deleting a participant's row from `participant_keys` makes all their PII in `session_events.pii_payload` permanently unrecoverable. This is the GDPR right-to-erasure mechanism for the SQLite event log.

## PII Data Map

| Table | Column | PII Type | Retention | Shredding |
|-------|--------|----------|-----------|-----------|
| `session_events` (SQLite) | `pii_payload` | User messages, file paths, code snippets | 90 days (full) / indefinite (audit stub) | Crypto-shred via participant key deletion |
| `participants` (PG) | `display_name` | Name | Account lifetime | DELETE row on account deletion |
| `participants` (PG) | `identity_ref` | Email/OAuth ID | Account lifetime | DELETE row on account deletion |
| `identity_mappings` (PG) | `external_id` | Provider-specific ID | Account lifetime | DELETE row on account deletion |
| `session_invites` (PG) | `token_hash` | Invite token hash | Invite lifetime | DELETE row on invite expiry/revocation |
| `notification_preferences` (PG) | `preference_value` | Notification settings | Account lifetime | DELETE row on account deletion |

## Data Retention and Deletion Policy

This section verifies end-to-end GDPR coverage across both storage tiers.

- **Crypto-shredding**: Verified. Deleting a participant's row from `participant_keys` renders all their `pii_payload` data in the SQLite event log permanently unrecoverable.
- **Data export**: Verified. `GET /participants/{id}/export` decrypts and exports all PII for a participant using their key from `participant_keys`. Export must be completed before key deletion.
- **90-day retention**: Verified. The event compaction policy ([Spec-006](006-session-event-taxonomy-and-audit-log.md)) compacts events older than 90 days; PII is stripped at compaction, leaving only audit stubs.
- **Purge lifecycle**: Verified. Session states `purge_requested` and `purged` exist in the [Session Model](../domain/session-model.md) with transitions `archived -> purge_requested -> purged` and `closed -> purge_requested -> purged`.
- **Right to erasure**: Participant deletion triggers the following sequence:
  1. Crypto-shred via key deletion (DELETE from `participant_keys`)
  2. DELETE Postgres PII rows (`participants`, `identity_mappings`, `notification_preferences`)
  3. Revoke all session memberships (anonymize membership references with tombstone identifier)
  4. Emit `participant.deleted` event for audit trail

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

- [ ] Session state model includes `purge_requested` and `purged` states with correct transitions.
- [ ] Archived sessions are retained for 90 days before becoming purge-eligible.
- [ ] V1 schema includes `pii_payload` (encrypted) column separate from `payload` (plaintext).
- [ ] V1 schema includes `participant_keys` table for per-participant AES-256-GCM keys.
- [ ] Deleting a participant's key renders their encrypted PII in the event log unrecoverable.
- [ ] Postgres participant records are hard-deleted and membership/invite references are anonymized upon deletion.
- [ ] Data export returns a complete JSON archive of a participant's events, decrypted with their key.
- [ ] A `purged` session retains audit stubs (timestamps, event types, non-PII metadata) but no PII.
- [ ] Purge is irreversible: a `purged` session cannot transition to any other state.

## ADR Triggers

- If the product requires PII retention beyond 90 days for legal hold or compliance, create an ADR documenting the exception and its justification.
- If crypto-shredding is replaced by a different deletion mechanism, create an ADR documenting the alternative and its trade-offs.
- If a third data store is introduced that holds PII, the data map and deletion strategy must be revisited.

## Open Questions

- No blocking open questions remain for v1.
- Post-V1: determine whether key rotation for long-lived sessions is necessary and define the rotation protocol.

## References

- [Data Architecture](../architecture/data-architecture.md)
- [Session Model](../domain/session-model.md)
