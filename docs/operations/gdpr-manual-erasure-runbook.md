# GDPR Manual Erasure Runbook

## Purpose

Service a verified GDPR Article 17 ("right to erasure") data-subject request **by hand** in V1. The automated `DELETE /participants/{id}/data` endpoint is deferred to V1.1 — the V1 `gdpr.*` daemon methods are not-implemented stubs per [Plan-022 §API And Transport Changes](../plans/022-data-retention-and-gdpr.md#api-and-transport-changes) and [Spec-022 §Non-Goals](../specs/022-data-retention-and-gdpr.md#non-goals) — but V1 ships the full erasure _capability_: the schema, the crypto-shred write-path, and the `ON DELETE SET NULL` severance migration. This runbook is the operator procedure that drives that capability to a compliant erasure without reading the spec internals.

It renders [Spec-022 §Shred Fan-Out](../specs/022-data-retention-and-gdpr.md#shred-fan-out) as an ordered, idempotent operator sequence. The V1.1 automated handler will execute the **same** three paths in the **same** order ([Plan-022 §Implementation Steps step 11](../plans/022-data-retention-and-gdpr.md#implementation-steps)).

## Symptoms

Run this procedure when **all** of the following hold:

- A data subject (or an admin acting on their behalf) has submitted a verified erasure request for a known `participant_id`.
- The automated path is unavailable: a call to the daemon `gdpr.delete` / `gdpr.purge` method returns JSON-RPC `-32603` with `data.type = "gdpr.endpoint_not_v1"` (the V1 stub).
- The request is not blocked by a legal-hold or security carve-out (token-revocation denylist survival is expected and compliant — see Preconditions — not a block).

## Detection

Establish **scope** before mutating anything — separate identification from remediation:

1. **Resolve the `participant_id`.** Confirm the UUID against the control-plane `participants` row: `SELECT id, display_name, identity_ref FROM participants WHERE id = :pid;`.
2. **Enumerate the blast radius** against [Spec-022 §PII Data Map](../specs/022-data-retention-and-gdpr.md#pii-data-map) — the authoritative list of every PII-carrying path. The erasure touches **two durability domains**:
   - **Daemon-local SQLite** (Paths 1 + 3): `participant_keys`, `session_events.pii_payload`, and the four diagnostic buckets (`driver_raw_events`, `command_output`, `tool_traces`, `reasoning_detail`).
   - **Control-plane Postgres** (Path 2): the full `REFERENCES participants(id)` inbound-FK closure — verifiable against [shared-postgres-schema.md](../architecture/schemas/shared-postgres-schema.md), so the set is the source of truth and cannot drift behind a hand-maintained list. **Deployment scope:** the closure spans dependency tiers, so a given deployment may not yet contain every table — `cross_node_dispatch_coordination` lands in Tier 9 (Plan-027) and `revoked_jtis` / `revoked_token_families` at the post-V1 BL-070 build. Before each Path-2 statement, guard existence (`SELECT to_regclass('<table>') IS NOT NULL;`) and **skip absent tables**: a table that does not exist holds no rows to erase, so skipping it is correct, not a closure gap. The `DELETE FROM participants` cascade likewise fires `ON DELETE SET NULL` only on the FKs that exist.
3. **Confirm no in-flight runs** for the participant — a live run may re-author `pii_payload` after the shred. Quiesce the participant's sessions or wait for completion.

## Preconditions

- **Export first (mandatory).** Crypto-shred is irreversible. Complete and durably store the participant's data export and confirm a `participant.exported` event before any key deletion ([Spec-022 §Data Export](../specs/022-data-retention-and-gdpr.md#data-export); [Spec-006 §Participant Lifecycle](../specs/006-session-event-taxonomy-and-audit-log.md#participant-lifecycle-participant_lifecycle)). Export is a required pre-requisite for `participant.purged`.
- **Durable request marker.** Emit `participant.purge_requested` through the daemon's canonical append path so the operation has a durable anchor; if any path below fails, this remains the most-recent state and the request stays retryable ([Spec-022 §Shred Fan-Out](../specs/022-data-retention-and-gdpr.md#shred-fan-out)).
- **Access to both stores.** Operator credentials for the daemon-local SQLite store **and** the control-plane Postgres database. On hosted SaaS these are different systems; on self-host they may share a host.
- **Severance migration applied (verify _before_ the irreversible Path 1 crypto-shred).** Path 2's `DELETE FROM participants` relies on the anonymize-class FKs being `ON DELETE SET NULL`. The **two in-V1** FKs — `session_memberships.participant_id` (Plan-001) and `session_invites.inviter_id` (Plan-002) — are born `NOT NULL REFERENCES` by their owners and relaxed to nullable + `ON DELETE SET NULL` by [Plan-022's D-022-7 / T22.5.2 control-plane migration](../plans/022-data-retention-and-gdpr.md#ratified-design-decisions-tier-5-audit-2026-05-30) ([Spec-022 §Shred Fan-Out FK-safety](../specs/022-data-retention-and-gdpr.md#shred-fan-out)); this precondition verifies **that migration**. (The other two anonymize-class FKs, `revoked_jtis.participant_id` / `revoked_token_families.participant_id`, are born nullable + `ON DELETE SET NULL` at their post-V1 BL-070 build — no migration, and absent in a V1-only deployment — so they are not part of this pre-shred check; see the Detection deployment-scope note.) Confirm the migration is live **before shredding anything**: `SELECT conrelid::regclass AS child_table, confdeltype FROM pg_constraint WHERE confrelid = 'participants'::regclass AND conrelid IN ('session_memberships'::regclass, 'session_invites'::regclass);` — both MUST read `confdeltype = 'n'` (SET NULL). A `'a'` (NO ACTION) means the migration is unapplied: **stop** — `DELETE FROM participants` would fail at Path 2 _after_ Path 1 has already destroyed the keys, leaving a half-erased participant (recoverable, since the sequence is idempotent, only by applying the migration and re-running from Path 1).
- **Daemon append access.** The signed audit events (`event.shredded`, `participant.purge_requested`, `participant.purged`) MUST be written through the daemon's canonical append path (Ed25519-signed + BLAKE3 hash-chained per [Spec-006 §Integrity Protocol](../specs/006-session-event-taxonomy-and-audit-log.md#integrity-protocol)) — **never** a raw `INSERT` into `session_events`, which breaks the chain and fails verification.
- **Understand denylist survival.** Where `revoked_jtis` / `revoked_token_families` exist (post-BL-070 — they are absent in a V1-only deployment), their rows survive erasure by design — `participant_id` is auto-nulled, but the denylist key persists until its natural `expires_at + 24h` reap (the GDPR Art. 17(3) security carve-out). This is **not** a precondition failure.

## Recovery Steps

Execute the three paths **strictly in order** — `Path 1 → Path 2 → Path 3` — then emit the aggregate event. The ordering is load-bearing: each path closes a re-derivation window the next would otherwise leave open. No ACID transaction spans the three paths (SQLite and Postgres are distinct durability domains); each path is individually idempotent, so a failed run is safely re-executed from the top.

### Path 1 — Crypto-shred the SQLite event log (daemon-local)

1. Delete the per-participant key: `DELETE FROM participant_keys WHERE participant_id = :pid;` (daemon-local SQLite). This destroys the AES-256-GCM key; every `pii_payload` ciphertext the participant authored, across every session, becomes permanently unrecoverable. (`participant_keys` is a separate table from the signed event chain, so this DELETE does not affect hash-chain integrity.)
2. Emit one `event.shredded` event via the daemon append path with `{participantId, affectedSessionIds[], piiPayloadsCleared, shredReason}` ([Spec-006 §Event Maintenance](../specs/006-session-event-taxonomy-and-audit-log.md#event-maintenance-event_maintenance)). Its payload carries no PII and is retained indefinitely.

_Idempotency:_ a re-run where the key row is already gone affects zero rows.

### Path 2 — Hard-delete + sever Postgres rows (control plane)

Run as a **single Postgres transaction** (one durability domain — the whole path succeeds or is reported failed; the daemon does not partially advance):

1. Hard-DELETE the participant's rows from the no-retention-basis tables present in your deployment: `identity_mappings`, `notification_preferences`, `runtime_node_attachments`, `cross_node_dispatch_coordination` (`DELETE FROM <table> WHERE participant_id = :pid;`; skip any table absent per the Detection deployment-scope note — `cross_node_dispatch_coordination` is Tier 9). The durable node-attach audit trail is the crypto-shredded `runtime_node.*` event stream, not `runtime_node_attachments`.
2. Hard-DELETE the participant anchor: `DELETE FROM participants WHERE id = :pid;`. This triggers the `ON DELETE SET NULL` severance DB-side on every anonymize-class FK that exists — the two in-V1 FKs `session_invites.inviter_id` and `session_memberships.participant_id` (relaxed by the D-022-7 / T22.5.2 migration), plus `revoked_jtis.participant_id` / `revoked_token_families.participant_id` once BL-070 has shipped (born `ON DELETE SET NULL`) ([Spec-022 §Shred Fan-Out FK-safety](../specs/022-data-retention-and-gdpr.md#shred-fan-out); Plan-022 D-022-7). `NULL` participant ids are non-equal under `UNIQUE(session_id, participant_id)`, so erasing two participants in the same session is safe.
3. If any DELETE fails (FK constraint, row lock, connection loss), roll back the transaction and report Path 2 failed — do not advance. An FK-constraint violation on the `participants` DELETE specifically points to the D-022-7 severance migration being unapplied (see Preconditions) — the two in-V1 anonymize-class FKs are still `NOT NULL NO ACTION` and block the parent delete.

_Idempotency:_ a DELETE of an already-deleted row affects zero rows.

### Path 3 — Flush diagnostic buckets (daemon-local)

1. For each bounded-retention diagnostic table — `driver_raw_events`, `command_output`, `tool_traces`, `reasoning_detail` — issue `DELETE FROM <table> WHERE participant_id = :pid;` (daemon-local SQLite). This short-circuits the ≤ 7-day TTL sweep. Summary-only variants (e.g. `reasoning_summary`) are non-PII by construction and are not a shred path ([Spec-020 §Required Behavior](../specs/020-observability-and-failure-recovery.md#required-behavior)).
2. Record `diagnostic_rows_purged` counts per table.

_Idempotency:_ flushing already-empty buckets affects zero rows.

### Emit the aggregate event

After **all three** paths complete, emit `participant.purged` via the daemon append path with `{purgedAt, affectedSessionIds[], piiPayloadsCleared}` ([Spec-006 §Participant Lifecycle](../specs/006-session-event-taxonomy-and-audit-log.md#participant-lifecycle-participant_lifecycle)). **Never** emit `participant.purged` against a partial shred.

## Validation

The erasure is complete when **all** of the following hold:

- `participant.purged` is present in the event log and verifies under [Spec-006 §Integrity Protocol](../specs/006-session-event-taxonomy-and-audit-log.md#integrity-protocol).
- **Path 1:** `SELECT count(*) FROM participant_keys WHERE participant_id = :pid;` returns `0`. Spot-check that a previously-readable `pii_payload` for the participant no longer decrypts (key absent).
- **Path 2:** `SELECT count(*) FROM participants WHERE id = :pid;` returns `0`; the anonymize-class FKs (`session_memberships.participant_id`, `session_invites.inviter_id`) read `NULL` for the formerly-linked rows; and — where `revoked_*` exist in the deployment (post-BL-070) — the denylist rows still exist with `participant_id IS NULL` and their key intact.
- **Path 3:** each diagnostic table returns `0` rows for `:pid`.
- The `event.shredded` + `participant.purged` audit pair is intact — these are never compacted or shredded per [Spec-006 §Event Maintenance](../specs/006-session-event-taxonomy-and-audit-log.md#event-maintenance-event_maintenance).

## Escalation

- **Partial shred / per-path failure.** The operation stays at `participant.purge_requested` (the durable anchor); the failure is logged for retry per [Spec-022 §Fallback Behavior](../specs/022-data-retention-and-gdpr.md#fallback-behavior). Re-run the **entire** sequence from Path 1 — all three paths are idempotent, so re-execution converges. Do not hand-patch a half-completed state.
- **FK-closure drift.** If a Path-2 DELETE encounters a `REFERENCES participants(id)` table not listed here, the [shared-postgres-schema.md](../architecture/schemas/shared-postgres-schema.md) inbound-FK closure is the source of truth — extend the procedure to cover the row, do not skip it, and flag the gap for a runbook update. A forward-declared closure table may also link the participant through a **table-specific FK column** rather than a bare `participant_id` — e.g. the Tier-9 `cross_node_dispatch_coordination` references `participants(id)` via `caller_participant_id` / `target_participant_id` — so confirm each table's actual erasure predicate against that schema before applying the generic `WHERE participant_id = :pid`; the owning tier's plan-readiness audit pins the exact predicate when the table enters a live deployment.
- **No daemon append interface in the deployed build.** If the operator cannot reach the daemon's canonical append path to emit the signed audit events, do **not** raw-`INSERT` them — escalate. The audit emission must use the signed path; raw rows fail integrity verification and corrupt the chain.
- **Signed-bytes concern.** A retained Ed25519 signature does not re-introduce PII after shred (it commits to `pii_ciphertext_digest`, not plaintext) — see [Spec-022 §Signature Safety Under Shred](../specs/022-data-retention-and-gdpr.md#signature-safety-under-shred). No action needed; do not attempt to strip signatures.

## Related Architecture Docs

- [Shared Postgres Schema](../architecture/schemas/shared-postgres-schema.md) — the `REFERENCES participants(id)` inbound-FK closure (Path 2 source of truth).
- [Local SQLite Schema](../architecture/schemas/local-sqlite-schema.md) — `participant_keys`, `session_events.pii_payload`, and the diagnostic-bucket tables.
- [Security Architecture §Audit Log Integrity](../architecture/security-architecture.md#audit-log-integrity) — the signed append path the audit events use.

## Related Specs

- [Spec-022 — Data Retention and GDPR](../specs/022-data-retention-and-gdpr.md) — §Shred Fan-Out, §PII Data Map, §Signature Safety Under Shred, §Fallback Behavior.
- [Spec-006 — Session Event Taxonomy and Audit Log](../specs/006-session-event-taxonomy-and-audit-log.md) — `event.shredded` / `participant.purged` emission + integrity protocol.
- [Spec-020 — Observability and Failure Recovery](../specs/020-observability-and-failure-recovery.md) — the bounded-retention diagnostic tier.

## Related Plans

- [Plan-022 — Data Retention and GDPR](../plans/022-data-retention-and-gdpr.md) — V1 schema + write-path + the `ON DELETE SET NULL` severance migration (D-022-7); §Implementation Steps step 11 reserves the V1.1 automated orchestration this runbook stands in for.
- [Plan-006 — Session Event Taxonomy and Audit Log](../plans/006-session-event-taxonomy-and-audit-log.md) — the canonical append path + `event.shredded` emission.

## On-Call Routing

GDPR erasure requests route to the data-protection on-call (privacy / compliance), who coordinates with a daemon / control-plane operator holding both-store access. Erasure is operator-initiated, never automated in V1.
