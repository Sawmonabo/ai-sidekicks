// Plan-004 T1.4 + T1.5 — version-15 migration: the queue, intervention, and
// command-receipt tables.
//
// SQL is inlined as a TypeScript string constant rather than loaded from a
// sibling `.sql` file, for the reasons the `0001-initial.ts` header sets out in
// full (tsc -b does not copy non-TS assets into `dist/`; `"files": ["dist"]`
// would exclude `src/migrations/` from the published tarball; bundlers handle
// `import.meta.url` inconsistently).
//
// PROVENANCE. The canonical schema source-of-truth is
// `docs/architecture/schemas/local-sqlite-schema.md`
// §"Queue and Intervention Tables (Plan-004)". The three CREATE statements
// below transcribe that block; they do not re-derive it.
//
// ----------------------------------------------------------------------------
// Why three tables in one ordinal
// ----------------------------------------------------------------------------
//
// `queue_items` and `interventions` are the two halves of one admission
// story — an admitted queue item can carry the id of the intervention that
// created it (`admitting_intervention_id`), and a composite intervention's
// single durable transaction writes an `interventions` row and a run-bound
// `queue_items` row together. Splitting them across ordinals would let a crash
// land a schema in which that transaction cannot be written at all, gated on a
// version marker that says the queue is ready.
//
// `command_receipts` joins them because it is a forward-declared SHELL with no
// behavior of its own (T1.5, CP-004-2) and no reader until Plan-015 arrives.
// Giving it an ordinal to itself would buy a rollback boundary around a table
// nothing writes.
//
// None of the three participates in a foreign key in either direction, so the
// version is order-independent of every earlier one: it creates three tables
// and nothing else, references no column any prior migration added, and is
// referenced by none.
//
// ----------------------------------------------------------------------------
// What the `command_receipts` shell deliberately omits
// ----------------------------------------------------------------------------
//
// The canonical block for this table is a COMPOSITE of four plans' columns.
// Plan-004 CREATEs only the crash-recovery log's own five — `id`,
// `command_id`, `run_id`, `status`, `created_at` — exactly as
// `docs/architecture/cross-plan-dependencies.md` §Contested Tables scopes the
// CREATE. The rest belong to plans that ship later and EXTEND through their own
// migrations, never through an edit of this file:
//
//   * Plan-015 (BL-051): `idempotency_class`, `dedupe_key`, `started_at`,
//     `completed_at`. `idempotency_class` is `NOT NULL` with no default in the
//     canonical block, so that EXTEND is a table REBUILD rather than an
//     `ALTER TABLE ... ADD COLUMN` — SQLite refuses to add a NOT NULL column
//     without a default to a table that may hold rows. That cost is Plan-015's
//     to pay and is recorded here so it is not discovered at authoring time.
//   * Plan-005 (campaign B10): the additive nullable `mcp_task_id`.
//   * Plan-028 (CP-028-7): the additive nullable `mcp_binding_digest`.
//
// The two partial indexes in the canonical block that read those columns
// (`idx_command_receipts_inflight` over `started_at` / `completed_at`,
// `idx_command_receipts_mcp_binding` over `mcp_binding_digest`) are omitted for
// the same reason and belong to the same EXTENDs. `idx_command_receipts_run` IS
// created here: its predicate reads only `run_id`, a shell column.
//
// ----------------------------------------------------------------------------
// The two constraints worth reading twice
// ----------------------------------------------------------------------------
//
//   * `interventions.origin` carries NO DEFAULT by design. A default would fail
//     OPEN for the system path, so every insert site must declare which
//     admission path it represents, and an unstamped insert fails at the
//     database rather than silently becoming a system-origin row.
//   * The table-level CHECK makes the admitting principal required IFF the
//     origin is `participant` (D-004-4): the participant arm can never persist
//     without its verified identity, and the system arm can never smuggle one
//     in. It is a biconditional rather than a one-way implication precisely
//     because both failure directions matter.
//
// Neither `queue_items.pii_participant_id` nor `interventions.pii_participant_id`
// is indexed. That is deliberate and matched between the two tables: the
// Plan-022 Path-1 erasure/export selector is a maintenance scan, never a hot
// path, and an index on a column read once per erasure would cost every write.
//
// Spec coverage: `Spec-004 §State And Data Implications` (queue items durable
// storage + intervention audit records). Refs: Plan-004 T1.4, T1.5, I-004-1,
// I-004-2, I-004-3, I-004-4, I-004-22, I-004-23, CP-004-2,
// `docs/architecture/schemas/local-sqlite-schema.md` §"Queue and Intervention
// Tables (Plan-004)".

export const QUEUE_AND_INTERVENTIONS_MIGRATION_SQL: string = `
-- Owner: Plan-004 | Migration: 0015-queue-and-interventions.ts (Tier 5 Phase 1)

-- ---------------------------------------------------------------------------
-- queue_items: the durable admission queue.
-- ---------------------------------------------------------------------------
CREATE TABLE queue_items (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  channel_id      TEXT,                       -- nullable for session-level items
  state           TEXT NOT NULL DEFAULT 'queued'
                  CHECK(state IN ('queued', 'admitted', 'superseded', 'canceled', 'expired')),
  priority        INTEGER NOT NULL DEFAULT 0, -- higher = more urgent
  payload         TEXT NOT NULL DEFAULT '{}', -- JSON: NON-PII members only -- context, metadata, and the
                                              -- non-PII identifiers. A participant-authored send's body
                                              -- never rides this column (it encrypts into pii_payload).
                                              -- Orchestration-authored content (a workflow phase input, an
                                              -- orchestrated child-run prompt) is session work product,
                                              -- not participant PII, and stays here in plaintext with both
                                              -- PII columns NULL -- the system arm has no participant DEK
                                              -- to encrypt under. Every drain-selection field is its own
                                              -- column (state, priority, target_run_id, channel_id,
                                              -- session_id), so the split costs no queryability.
  pii_payload     BLOB,                       -- encrypted per-participant AES-256-GCM via Plan-006's
                                              -- PiiEncryptor: the participant-authored send body.
                                              -- Same-key parity with session_events.pii_payload and
                                              -- interventions.pii_payload, so one Plan-022 Path-1 key
                                              -- deletion shreds every copy of the same send identically.
                                              -- NULL on rows carrying no participant-authored body.
  pii_participant_id TEXT,                    -- PII owner stamp: the authoring participant whose key
                                              -- encrypts pii_payload -- the erasure/export selector this
                                              -- table otherwise lacks entirely (no other column names a
                                              -- participant, so without it the GDPR fan-out cannot address
                                              -- these rows); NULL on rows carrying no PII leg
  target_run_id   TEXT,                       -- run-bound admission arm: NULL on ordinary follow-up items
                                              -- (admission converts them into a new run); stamped solely
                                              -- by the edit-and-resend composite's admission in V1 -- the
                                              -- item delivers into its bound run as its next provider
                                              -- send on run.resume, never converting into a new run
  admitting_intervention_id TEXT,             -- row-anchored linkage to the interventions row whose
                                              -- admission created this item: NULL on ordinary participant
                                              -- sends, stamped beside target_run_id in the composite's
                                              -- single durable transaction. The resume-time drain reads it
                                              -- to resolve the drained turn's admitting principal -- a run
                                              -- accumulates interventions over its life, so the resolution
                                              -- is durable on the row and never inferred from run history
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX idx_queue_items_session_state ON queue_items(session_id, state);
CREATE INDEX idx_queue_items_target_run ON queue_items(target_run_id) WHERE target_run_id IS NOT NULL;
CREATE INDEX idx_queue_items_channel ON queue_items(channel_id) WHERE channel_id IS NOT NULL;
-- No index on pii_participant_id, matching the interventions.pii_participant_id sibling: the Plan-022
-- Path-1 erasure/export selector is a V1.1 maintenance scan, never a hot path, and both tables carry the
-- stamp unindexed for the same reason.

-- ---------------------------------------------------------------------------
-- interventions: the durable per-outcome intervention audit record.
-- ---------------------------------------------------------------------------
CREATE TABLE interventions (
  id                     TEXT PRIMARY KEY,
  target_run_id          TEXT NOT NULL,
  type                   TEXT NOT NULL
                         CHECK(type IN ('steer', 'interrupt', 'cancel', 'rollback')),
  state                  TEXT NOT NULL DEFAULT 'requested'
                         CHECK(state IN ('requested', 'accepted', 'applied', 'rejected', 'degraded', 'expired')),
  payload                TEXT NOT NULL DEFAULT '{}', -- JSON: type-specific NON-PII fields only -- neither a rollback's replacementSend body nor a steer's directive text rides this column (both encrypt into pii_payload)
  expected_run_version   INTEGER NOT NULL,           -- MANDATORY fail-closed comparand (D-004-2)
  client_idempotency_key TEXT NOT NULL,              -- MANDATORY requester-generated UUID (participant client or daemon system-origination); replay-or-conflict intervention dedupe
  pii_payload            BLOB,                       -- encrypted per-participant AES-256-GCM via Plan-006's PiiEncryptor: the participant-authored intervention body -- the rollback replacementSend body and the steer directive text; same-key parity with session_events.pii_payload, so the Plan-022 Path-1 key deletion shreds every copy identically; NULLed by the daemon retention pass past the 90-day full-retention bound (no digest binding attaches, unlike session_events)
  pii_participant_id     TEXT,                       -- PII owner stamp: the requesting participant whose key encrypts pii_payload; NULL on rows carrying no PII leg
  origin                 TEXT NOT NULL               -- daemon-resolved admission-path discriminator: 'participant' for a request admitted over an identity-carrying transport, 'system' for the in-process orchestration entrypoint below the wire authz boundary. NO DEFAULT by design -- a default would fail OPEN for the system path, so every insert site declares. Deliberately NOT inferred from initiator_id IS NULL: initiator_id is client-supplied and informational, so its absence proves nothing about how the request was admitted
                         CHECK(origin IN ('participant', 'system')),
  admitting_principal_id TEXT,                       -- participant recorded as the intervention's admitting principal, daemon-resolved at acceptance (node-owner binding on the local socket; verified PASETO sub on authenticated surfaces; caller_token.sub on the cross-node arm). NEVER read from the wire: a body-supplied actor disagreeing with the verified identity refuses as auth.principal_mismatch. Read by the turn-scoped effective-principal resolution
  result                 TEXT,                       -- JSON: outcome details
  rejection_reason       TEXT,                       -- machine-readable rejected cause (driver.capability_unsupported foremost) -- replay-durable: the wire contract forbids result on rejected, so an idempotent replay reconstructs rejectionReason from this column
  initiator_id           TEXT,                       -- participant or system -- routing/audit metadata only, never an authorization input (see admitting_principal_id)
  created_at             TEXT NOT NULL,
  resolved_at            TEXT,
  UNIQUE(target_run_id, client_idempotency_key),     -- identical retry replays the recorded outcome; key reuse with a differing payload rejects as intervention.idempotency_conflict -- the PII body compared by decrypt-and-compare under the requester's live key, never by ciphertext or persisted digest -- distinct grain from command_receipts.command_id (per-command crash-recovery dedupe)
  CHECK((origin = 'participant' AND admitting_principal_id IS NOT NULL)
        OR (origin = 'system' AND admitting_principal_id IS NULL))
                                                     -- principal required iff participant-origin: the participant arm can never persist without its verified identity, and the system arm can never smuggle one in. Enforced by the engine, not by convention
);

CREATE INDEX idx_interventions_run ON interventions(target_run_id);
CREATE INDEX idx_interventions_state ON interventions(state) WHERE state IN ('requested', 'accepted');

-- ---------------------------------------------------------------------------
-- command_receipts: forward-declared SHELL (CP-004-2). Plan-004 CREATEs the
-- crash-recovery command-receipt log's own five columns; Plan-015 owns the
-- two-phase idempotency columns and the read model, Plan-005 the mcp_task_id
-- handle, Plan-028 the mcp_binding_digest provenance -- each through its own
-- migration, never through an edit of this file. See the file header for why
-- Plan-015's EXTEND is a table rebuild rather than an ADD COLUMN.
-- ---------------------------------------------------------------------------
CREATE TABLE command_receipts (
  id                TEXT PRIMARY KEY,
  command_id        TEXT NOT NULL UNIQUE,         -- idempotency key (client-supplied)
  run_id            TEXT,
  status            TEXT NOT NULL
                    CHECK(status IN ('accepted', 'rejected', 'completed', 'failed')),
  created_at        TEXT NOT NULL
);

CREATE INDEX idx_command_receipts_run ON command_receipts(run_id) WHERE run_id IS NOT NULL;

INSERT INTO schema_version (version, applied_at, description)
VALUES (15, datetime('now'), 'Queue and intervention tables (queue_items, interventions, command_receipts forward-declared shell)');
`;
