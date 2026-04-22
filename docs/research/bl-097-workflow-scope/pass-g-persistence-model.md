# BL-097 Wave 2 Pass G — Persistence Model (SQLite schema for workflow engine)

**Date:** 2026-04-22
**Author:** Opus 4.7 subagent
**Wave:** 2 · Pass G (persistence model) — feeds Wave 2 synthesis
**Scope:** Design the SQLite schema that carries Option-6 full-workflow-engine V1 state on top of Plan-015 recovery foundation and Plan-014 artifact signing. Align with Wave-1 commitments C-1…C-16 pinned in `wave-1-synthesis.md`.

---

## §1 Schema Overview

Nine workflow-engine tables, all owned by Plan-017. They extend the existing local SQLite schema (`docs/architecture/schemas/local-sqlite-schema.md` §Workflow Tables) rather than replace it; the placeholder rows Plan-017 already reserves (`workflow_definitions`, `workflow_versions`, `workflow_runs`, `workflow_phase_states`) expand here. `session_events` remains the canonical append-only audit log; the tables below are mostly **projections of truth** that live in `session_events`, the single exception being `workflow_gate_resolutions` which carries its own per-run hash chain for tamper-evidence (§5).

| # | Table | Purpose (1 line) | Truth? |
| --- | --- | --- | --- |
| 1 | `workflow_definitions` | Content-hashed immutable definition identity; carries schema-version marker (C-8). | Truth (immutable) |
| 2 | `workflow_versions` | Parent-linked definition history; supports F13 additive evolution. | Truth (immutable) |
| 3 | `workflow_runs` | One row per run; counters/deadlines for `max_phase_transitions`, `max_duration`; status. | Projection |
| 4 | `workflow_phase_states` | Per-phase state-machine row (10 states) under a run; parallel siblings coexist. | Projection |
| 5 | `phase_outputs` | Immutable-once-written outputs per C-9; retry creates new row not mutation. | Truth (immutable) |
| 6 | `workflow_gate_resolutions` | Append-only hash-chained gate/approval log per C-13, per-run chain. | Truth (immutable, hash-chained) |
| 7 | `parallel_join_state` | Sibling-set bookkeeping for `ParallelJoinPolicy` cancellation cascade. | Projection |
| 8 | `workflow_channels` | `phase_run_id ↔ channel_id` mapping; OWN-only V1 per Wave-1 §3.2. | Projection |
| 9 | `human_phase_form_state` | Optional draft autosave (V1 optional; feeds Wave-2 synthesis decision). | Projection (transient) |

**Source-of-truth hierarchy.** (1) `session_events` (BLAKE3+Ed25519 chained per Spec-006, categories enumerated by Pass F) is the canonical log; (2) `workflow_definitions`, `workflow_versions`, `phase_outputs` are immutable by construction — row bytes are the truth; (3) `workflow_gate_resolutions` carries a parallel per-run hash chain anchored to `session_events` because C-13 requires dedicated tamper-evident approval history (per-run verification is the audit primitive auditors exercise); (4) everything else is a projection rebuildable via `ProjectionRebuild` per Spec-015.

---

## §2 Per-Table Schema (DDL)

Follows existing `local-sqlite-schema.md` conventions: TEXT primary keys (ULID), RFC 3339 UTC text timestamps, JSON held in TEXT columns (the repo's existing pattern — STRICT tables not yet adopted, so introducing them here would diverge from convention; left as an §10 open question). All pragmas inherited from Spec-015 (`journal_mode=WAL`, `synchronous=FULL`, `foreign_keys=ON`, `busy_timeout=5000`).

```sql
-- ========================================================================
-- 1. workflow_definitions — content-hashed, immutable, schema-versioned
-- ========================================================================
-- Owner: Plan-017 | Extends placeholder row in local-sqlite-schema.md §Workflow Tables
-- Wave-1 commitments: C-1 (YAML + TS SDK), C-8 (schema version marker)
CREATE TABLE workflow_definitions (
  id                   TEXT PRIMARY KEY,               -- ULID; NOT the content hash
  session_id           TEXT NOT NULL,                  -- owning session
  name                 TEXT NOT NULL,                  -- author-facing name
  scope                TEXT NOT NULL DEFAULT 'session'
                       CHECK(scope IN ('session','channel')),
  content_hash         TEXT NOT NULL,                  -- BLAKE3 over JCS-canonicalized definition body
  schema_version       TEXT NOT NULL                   -- `ai-sidekicks-schema: 1.0` per C-8
                       CHECK(schema_version GLOB '[0-9]*.[0-9]*'),
  definition_body      TEXT NOT NULL,                  -- JSON (canonicalized per RFC 8785); full author-supplied definition
  created_at           TEXT NOT NULL,
  created_by           TEXT,                           -- participant_id
  UNIQUE(session_id, content_hash)                     -- dedupe identical submissions
);

CREATE INDEX idx_workflow_definitions_session ON workflow_definitions(session_id);
CREATE INDEX idx_workflow_definitions_content_hash ON workflow_definitions(content_hash);

-- Note: `updated_at` intentionally absent — definitions are immutable by C-9/F13 convention.
-- Edits create a new row in workflow_versions referencing this row as a parent.

-- ========================================================================
-- 2. workflow_versions — definition history chain (F13 additive versioning)
-- ========================================================================
-- Owner: Plan-017
-- Wave-1 commitments: F13 / C-8 version-API-at-V1 (Pass D §2.2)
CREATE TABLE workflow_versions (
  id                   TEXT PRIMARY KEY,               -- ULID
  definition_id        TEXT NOT NULL REFERENCES workflow_definitions(id),
  version_number       INTEGER NOT NULL,               -- monotonic per definition_id
  parent_version_id    TEXT REFERENCES workflow_versions(id), -- NULL at version_number=1
  parent_content_hash  TEXT,                           -- BLAKE3 of parent definition body; NULL at version 1
  content_hash         TEXT NOT NULL,                  -- BLAKE3 of THIS version's body
  phase_definitions    TEXT NOT NULL DEFAULT '[]',     -- JSON array of phase configs
  author_note          TEXT,                           -- opt-in changelog message
  created_at           TEXT NOT NULL,
  created_by           TEXT,                           -- participant_id
  UNIQUE(definition_id, version_number),
  UNIQUE(content_hash)                                 -- dedupe across definitions too
);

CREATE INDEX idx_workflow_versions_definition ON workflow_versions(definition_id, version_number DESC);
CREATE INDEX idx_workflow_versions_parent ON workflow_versions(parent_version_id)
  WHERE parent_version_id IS NOT NULL;

-- ========================================================================
-- 3. workflow_runs — top-level run state; counters and deadlines
-- ========================================================================
-- Owner: Plan-017
-- Wave-1 commitments: SA-1 (max_phase_transitions), SA-2 (max_duration), SA-3 (resource pools)
CREATE TABLE workflow_runs (
  id                        TEXT PRIMARY KEY,          -- ULID
  workflow_version_id       TEXT NOT NULL REFERENCES workflow_versions(id),
  session_id                TEXT NOT NULL,
  status                    TEXT NOT NULL DEFAULT 'pending'
                            CHECK(status IN (
                              'pending','running','suspended','completed','failed','cancelled'
                            )),
  -- Wave-1 §3.1 iteration counters
  phase_transitions_count   INTEGER NOT NULL DEFAULT 0,
  max_phase_transitions     INTEGER NOT NULL DEFAULT 100, -- SA-1 default
  -- Wave-1 §3.1 duration deadline
  started_at                TEXT,                      -- RFC 3339 UTC
  deadline_at               TEXT,                      -- started_at + max_duration (computed at start)
  max_duration_ms           INTEGER NOT NULL DEFAULT 86400000, -- SA-2 default 24h
  completed_at              TEXT,
  -- Wave-1 §3.1 pool reservations (snapshot only; pool runtime state is ephemeral and NOT persisted)
  pool_reservations_snapshot TEXT NOT NULL DEFAULT '{}', -- JSON: {pty_slots: n, agent_memory_mb: n}
  -- Result
  failure_reason            TEXT,                       -- null unless status in ('failed','cancelled')
  failure_detail            TEXT,                       -- JSON; includes cancellation_reason per SA Pass F
  created_at                TEXT NOT NULL,
  created_by                TEXT,                       -- participant_id or trigger
  CHECK(phase_transitions_count <= max_phase_transitions),
  CHECK(max_duration_ms > 0)
);

CREATE INDEX idx_workflow_runs_session ON workflow_runs(session_id);
CREATE INDEX idx_workflow_runs_status ON workflow_runs(status) WHERE status IN ('pending','running','suspended');
CREATE INDEX idx_workflow_runs_deadline ON workflow_runs(deadline_at)
  WHERE status IN ('running','suspended') AND deadline_at IS NOT NULL;
CREATE INDEX idx_workflow_runs_version ON workflow_runs(workflow_version_id);

-- ========================================================================
-- 4. workflow_phase_states — per-phase state machine projection
-- ========================================================================
-- Owner: Plan-017
-- Wave-1 commitments: 10 state machine from Wave-1 synthesis §7.1 Pass F
CREATE TABLE workflow_phase_states (
  id                      TEXT PRIMARY KEY,            -- ULID; this is the phase_run_id used by Pass B channels
  workflow_run_id         TEXT NOT NULL REFERENCES workflow_runs(id),
  phase_id                TEXT NOT NULL,               -- logical phase id from workflow_versions.phase_definitions
  phase_type              TEXT NOT NULL
                          CHECK(phase_type IN (
                            'single-agent','multi-agent','auto-continue','done',
                            'human-approval','human','quality-checks','gate','terminal'
                          )),
  -- 10-state machine per Wave-1 §7.1 Pass F scope
  state                   TEXT NOT NULL DEFAULT 'admitted'
                          CHECK(state IN (
                            'admitted','waiting_on_pool','started','progressed',
                            'suspended','resumed','cancelling','failed','completed','retried'
                          )),
  attempt_number          INTEGER NOT NULL DEFAULT 1,  -- 1..max_retries; retry creates new row per C-9, this column identifies it
  -- Parent-sibling (for parallel blocks)
  parallel_join_id        TEXT REFERENCES parallel_join_state(id), -- NULL unless under a parallel join
  -- Timing
  admitted_at             TEXT NOT NULL,
  started_at              TEXT,
  progressed_at           TEXT,                        -- most recent progress heartbeat
  completed_at            TEXT,
  -- Failure & cancellation
  failure_reason          TEXT,
  cancellation_reason     TEXT
                          CHECK(cancellation_reason IS NULL
                                OR cancellation_reason IN ('sibling_failure','deadline_exceeded','user_cancel','gate_rejected')),
  -- Pool reservation (transient; for crash recovery decision)
  pool_reservation        TEXT,                        -- JSON {pty_slots: n, agent_memory_mb: n}; NULL after release
  -- Resume metadata
  resume_cursor           TEXT,                        -- opaque; for driver adapter; see Plan-015 recovery
  last_event_sequence     INTEGER,                     -- session_events.sequence projected from at rebuild
  UNIQUE(workflow_run_id, phase_id, attempt_number)    -- retry creates new attempt row per C-9
);

CREATE INDEX idx_workflow_phase_states_run ON workflow_phase_states(workflow_run_id);
CREATE INDEX idx_workflow_phase_states_active ON workflow_phase_states(workflow_run_id, state)
  WHERE state IN ('admitted','waiting_on_pool','started','progressed','suspended','cancelling');
CREATE INDEX idx_workflow_phase_states_parallel ON workflow_phase_states(parallel_join_id)
  WHERE parallel_join_id IS NOT NULL;

-- ========================================================================
-- 5. phase_outputs — immutable per C-9; retry creates new output identity
-- ========================================================================
-- Owner: Plan-017
-- Wave-1 commitment: C-9 output immutability; GitHub Actions v3→v4 artifact-API lesson
CREATE TABLE phase_outputs (
  id                      TEXT PRIMARY KEY,            -- ULID; content-stable identity
  phase_run_id            TEXT NOT NULL REFERENCES workflow_phase_states(id),
  workflow_run_id         TEXT NOT NULL REFERENCES workflow_runs(id), -- denormalized for index
  output_name             TEXT NOT NULL,               -- name within the phase's output contract
  value_kind              TEXT NOT NULL
                          CHECK(value_kind IN ('scalar','json','artifact_ref','agent_transcript_ref')),
  value_json              TEXT,                        -- primitive/JSON payload; NULL when value_kind=artifact_ref
  artifact_manifest_id    TEXT REFERENCES artifact_manifests(id), -- Plan-014 integration; NULL unless value_kind=artifact_ref
  content_hash            TEXT NOT NULL,               -- BLAKE3 of canonicalized output bytes (for dedupe + replay check)
  created_at              TEXT NOT NULL,
  UNIQUE(phase_run_id, output_name)                    -- outputs are write-once per attempt
);

CREATE INDEX idx_phase_outputs_run ON phase_outputs(workflow_run_id);
CREATE INDEX idx_phase_outputs_phase ON phase_outputs(phase_run_id);
CREATE INDEX idx_phase_outputs_artifact ON phase_outputs(artifact_manifest_id)
  WHERE artifact_manifest_id IS NOT NULL;
-- Immutability invariant: no UPDATE trigger — all writes INSERT-only; a retry inserts new row under new phase_run_id (§3)

-- ========================================================================
-- 6. workflow_gate_resolutions — append-only hash-chained per C-13 / I7
-- ========================================================================
-- Owner: Plan-017
-- Wave-1 commitment: C-13 append-only hash-chained approval history (Pass E §4.7)
-- Algorithm anchored to Spec-006 §Integrity Protocol (BLAKE3 + Ed25519 + RFC 8785 JCS)
-- to keep one canonicalization rule across the daemon (per Spec-006 guidance).
CREATE TABLE workflow_gate_resolutions (
  id                         TEXT PRIMARY KEY,          -- ULID
  workflow_run_id            TEXT NOT NULL REFERENCES workflow_runs(id),
  sequence                   INTEGER NOT NULL,          -- per-run monotonic starting at 1
  phase_run_id               TEXT REFERENCES workflow_phase_states(id), -- NULL for run-level gates
  -- Gate identity
  gate_kind                  TEXT NOT NULL
                             CHECK(gate_kind IN (
                               'human-approval','quality-checks','human','channel-moderation',
                               'workflow-phase','definition-edit-audit'
                             )),
  approval_category          TEXT                       -- mirrors Plan-012 approval_requests.category when applicable
                             CHECK(approval_category IS NULL OR approval_category IN (
                               'tool_execution','file_write','network_access','destructive_git',
                               'user_input','plan_approval','mcp_elicitation','gate',
                               'human_phase_contribution'                                      -- SA-12 addition
                             )),
  approval_request_id        TEXT REFERENCES approval_requests(id), -- Plan-012 integration; NULL for non-approval gate kinds
  -- Resolution
  outcome                    TEXT NOT NULL
                             CHECK(outcome IN ('approved','rejected','timed_out','withdrawn','admin_override')),
  approver_id                TEXT,                      -- participant_id; NULL for 'timed_out' / 'withdrawn'
  approver_capability        TEXT,                      -- Cedar capability string (C-14 typed capability)
  resolved_at                TEXT NOT NULL,
  -- Policy-at-resolution-time (C-13: replays use at-execution-time policy, not current)
  policy_snapshot_hash       TEXT NOT NULL,             -- BLAKE3 of the Plan-012 policy bundle active at resolved_at
  decision_context           TEXT NOT NULL DEFAULT '{}', -- JSON: scope, resource, reason text, etc.
  -- Hash chain (per-run, anchored to Spec-006 scheme)
  prev_hash                  BLOB NOT NULL,             -- 32 bytes; row_hash of prior entry; zero-filled at sequence=1
  row_hash                   BLOB NOT NULL,             -- 32 bytes; BLAKE3(prev_hash || JCS-canonical(row_body))
  daemon_signature           BLOB NOT NULL,             -- 64 bytes; Ed25519 over same canonical bytes
  approver_signature         BLOB,                      -- 64 bytes; Ed25519 from approver's participant key; NULL for 'timed_out'
  UNIQUE(workflow_run_id, sequence)
);

CREATE INDEX idx_gate_resolutions_run ON workflow_gate_resolutions(workflow_run_id, sequence);
CREATE INDEX idx_gate_resolutions_phase ON workflow_gate_resolutions(phase_run_id)
  WHERE phase_run_id IS NOT NULL;
CREATE INDEX idx_gate_resolutions_approval ON workflow_gate_resolutions(approval_request_id)
  WHERE approval_request_id IS NOT NULL;

-- No UPDATE or DELETE triggers — append-only enforced at application layer (writer worker only inserts).
-- Verification procedure: §5.

-- ========================================================================
-- 7. parallel_join_state — sibling set + cancellation bookkeeping
-- ========================================================================
-- Owner: Plan-017
-- Wave-1 commitment: SA-4 ParallelJoinPolicy (Pass A §3.4)
CREATE TABLE parallel_join_state (
  id                      TEXT PRIMARY KEY,           -- ULID; referenced by workflow_phase_states.parallel_join_id
  workflow_run_id         TEXT NOT NULL REFERENCES workflow_runs(id),
  join_node_id            TEXT NOT NULL,              -- phase id of the join node in the DAG
  policy                  TEXT NOT NULL
                          CHECK(policy IN ('fail-fast','all-settled','any-success')),
  expected_sibling_count  INTEGER NOT NULL,           -- number of siblings entering the join
  completed_count         INTEGER NOT NULL DEFAULT 0,
  failed_count            INTEGER NOT NULL DEFAULT 0,
  cancelled_count         INTEGER NOT NULL DEFAULT 0,
  resolution              TEXT
                          CHECK(resolution IS NULL OR resolution IN ('all_succeeded','any_succeeded','any_failed','all_failed','cancelled')),
  resolved_at             TEXT,                       -- set when the join condition fires
  -- Cancellation cascade bookkeeping (SA Wave-1 §3.1 synchrony verification)
  cancel_wave_tick        INTEGER,                    -- executor tick number at which cancel wave fired; NULL until fail-fast triggers
  created_at              TEXT NOT NULL
);

CREATE INDEX idx_parallel_join_state_run ON parallel_join_state(workflow_run_id);
CREATE INDEX idx_parallel_join_state_unresolved ON parallel_join_state(workflow_run_id)
  WHERE resolution IS NULL;

-- ========================================================================
-- 8. workflow_channels — phase_run_id ↔ channel_id (OWN-only V1)
-- ========================================================================
-- Owner: Plan-017
-- Wave-1 commitment: SA-6 ownership: OWN V1; Pass B §3.1; Spec-016 linkage
CREATE TABLE workflow_channels (
  id                      TEXT PRIMARY KEY,           -- ULID
  phase_run_id            TEXT NOT NULL UNIQUE REFERENCES workflow_phase_states(id), -- UNIQUE = OWN 1:1
  channel_id              TEXT NOT NULL REFERENCES channels(id),
  ownership               TEXT NOT NULL DEFAULT 'OWN'
                          CHECK(ownership IN ('OWN')),  -- V1: OWN only; BIND reserved V1.1 per §5.3 synthesis
  termination_policy      TEXT NOT NULL DEFAULT 'CLOSE_WITH_RECORDS_PRESERVED'
                          CHECK(termination_policy IN (
                            'CLOSE_WITH_RECORDS_PRESERVED','REQUEST_CANCEL','TERMINATE'
                          )),
  grace_period_ms         INTEGER NOT NULL DEFAULT 30000, -- SA-9: 30s grace on REQUEST_CANCEL
  created_at              TEXT NOT NULL,
  terminated_at           TEXT,
  termination_reason      TEXT
);

CREATE INDEX idx_workflow_channels_channel ON workflow_channels(channel_id);

-- ========================================================================
-- 9. human_phase_form_state — draft autosave (V1 optional)
-- ========================================================================
-- Owner: Plan-017
-- Wave-1 status: Pass C §3 — V1 localStorage/IndexedDB local-only; this table is V1.x daemon-side fallback.
-- Included here so V1 schema doesn't need migration when daemon-side draft persistence ships.
CREATE TABLE human_phase_form_state (
  id                      TEXT PRIMARY KEY,           -- ULID
  phase_run_id            TEXT NOT NULL REFERENCES workflow_phase_states(id),
  participant_id          TEXT NOT NULL,              -- who's drafting (implicit-claim on first open)
  draft_json              TEXT NOT NULL DEFAULT '{}', -- JSON: current form field values
  draft_version           INTEGER NOT NULL DEFAULT 1, -- bumps on each autosave tick; optimistic-concurrency token
  submitted               INTEGER NOT NULL DEFAULT 0  -- boolean; 1 terminal
                          CHECK(submitted IN (0,1)),
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  UNIQUE(phase_run_id, participant_id)                -- one draft slot per (phase, participant)
);

CREATE INDEX idx_human_phase_form_state_phase ON human_phase_form_state(phase_run_id)
  WHERE submitted = 0;
```

---

## §3 Index Strategy

Each index is justified against a concrete V1 query pattern. Redundant indexes are explicitly avoided — SQLite's single-writer model means every index pays a write-path cost, and the Spec-015 writer worker's 50-event batch budget is tight.

| # | Index | Query pattern | Justification |
| --- | --- | --- | --- |
| 1 | `idx_workflow_definitions_session` | "List all workflows in session S" | Session overview UI lists per-session definitions. |
| 2 | `idx_workflow_definitions_content_hash` | "Is this definition already known (dedupe)?" | Submit-time dedupe check before INSERT; avoids full scan. |
| 3 | `idx_workflow_versions_definition` | "Show latest version of definition D" | `DESC` order lets `LIMIT 1` hit the index directly. |
| 4 | `idx_workflow_versions_parent` | "Walk the version chain up to root" (audit, replay) | Partial index — only present for non-root versions. |
| 5 | `idx_workflow_runs_session` | "List runs for session S" | Core session UI. |
| 6 | `idx_workflow_runs_status` | "Which runs are active right now?" | Partial index on in-progress states; executor tick loop checks readiness. |
| 7 | `idx_workflow_runs_deadline` | "Which runs are nearing their `max_duration`?" | Partial index — a tick-loop deadline sweeper scans only runs with unresolved deadlines. |
| 8 | `idx_workflow_runs_version` | "What runs use version V?" (migration impact analysis) | Low-cost; used by version-edit tooling. |
| 9 | `idx_workflow_phase_states_run` | "All phase states for run R" | The primary read for run-detail UI and replay reconstruction. |
| 10 | `idx_workflow_phase_states_active` | "Executor tick: which phases are ready/in-flight?" | Partial index on non-terminal states — the hot path of the scheduler. |
| 11 | `idx_workflow_phase_states_parallel` | "All siblings under parallel join J" | Partial; used by the join resolver and cancellation cascade. |
| 12 | `idx_phase_outputs_run` | "Collect all outputs from run R" (downstream consumers) | Accumulator phases read upstream outputs. |
| 13 | `idx_phase_outputs_phase` | "Outputs from this phase attempt" | Retry-replay lookup. |
| 14 | `idx_phase_outputs_artifact` | "Which phase outputs reference this artifact?" (Plan-014 GC) | Partial index — only rows that reference artifacts. |
| 15 | `idx_gate_resolutions_run` | "Walk the chain for run R in order" (verification) | Primary read for §5 verification procedure. |
| 16 | `idx_gate_resolutions_phase` | "Gate history for this phase" | Per-phase audit view. |
| 17 | `idx_gate_resolutions_approval` | "Find gate resolution for approval X" | Plan-012 cross-reference. |
| 18 | `idx_parallel_join_state_run` | "Joins under run R" | Used with `workflow_phase_states.parallel_join_id`. |
| 19 | `idx_parallel_join_state_unresolved` | "Tick loop: which joins are still open?" | Partial; scheduler hot path. |
| 20 | `idx_workflow_channels_channel` | "Which phase owns channel C?" (reverse lookup) | Used by Spec-016 moderation hooks to route channel events to owning phase. |
| 21 | `idx_human_phase_form_state_phase` | "Active drafts for this phase" | Partial on `submitted=0`. |

**Explicitly not indexed:** `workflow_gate_resolutions.resolved_at` (temporal range queries Pass H scope); `phase_outputs.content_hash` (dedupe is Plan-014-owned); `workflow_phase_states.phase_id` (joined via workflow_version JSON; no standalone lookup pattern).

---

## §4 Normalized vs JSON-Blob Trade-Off Analysis

**Recommendation: Normalized (9 tables) with JSON columns reserved for genuinely variable-shape fields.**

**Alternative (steel-manned).** A single `workflow_runs_blob` table storing an entire run's state as one JSON document, updated atomically per tick — closer to how Temporal Mutable State is stored ([Temporal custom persistence blog, 2024](https://temporal.io/blog/higher-throughput-and-lower-latency-temporal-clouds-custom-persistence-layer)) and how Argo stores `nodeStatus` in a CRD field before offloading ([Argo offloading-large-workflows](https://argo-workflows.readthedocs.io/en/latest/offloading-large-workflows/)). Virtues: atomic-per-tick updates, easier future schema evolution.

**Decisive counterarguments for V1:**

1. **Replay determinism requires projection anyway.** Spec-015's `ProjectionRebuild` must parse the blob back into normalized structure to project. You pay normalization on every read. Better to pay it once at write.
2. **C-9 immutability + retry semantics fight blob writes.** Retry creates new output identity (per-attempt row). Blob forces read-modify-write, reintroducing the mutable-output footgun.
3. **Index-friendliness is load-bearing.** "Which runs are active?" / "Which join is blocking?" / "Which phase failed?" all need column-level indexes. JSON-generated-column indexing exists ([SQLite JSON1](https://sqlite.org/json1.html)) but diverges from `local-sqlite-schema.md` convention.
4. **Hash-chain verification is per-row.** C-13 requires a sequence of append-only rows; blob storage re-opens "blob is mutable from SQLite's perspective" — the writer can overwrite without DB detecting it.
5. **Write amplification is smaller than it looks under WAL.** 50-event batch + single WAL frame group (Spec-015) amortize fsync cost; the blob's atomic-per-tick advantage evaporates under batching (§7).
6. **Single-writer-worker already serializes writes.** The "atomic per-tick" virtue is redundant; batch transactions already give atomicity.

**JSON columns retained where justified (bounded, explicit):** `definition_body`, `phase_definitions` (variable-shape author content); `pool_reservations_snapshot`, `pool_reservation` (opaque to DB); `failure_detail`, `decision_context` (tail-of-schema metadata); `draft_json` (form dictionary).

**Convergent external precedent.** Argo started with the blob approach and **had to add** normalization (`workflow_archive_nodes`) when the 1 MB etcd limit bit ([Argo Persistence and Archiving](https://deepwiki.com/argoproj/argo-workflows/2.9-persistence-and-archiving)). Cadence keeps per-shard event history normalized for concurrency ([Cadence persistence docs](https://github.com/cadence-workflow/cadence/blob/master/docs/persistence.md)). 2024-2026 convergence for embedded-DB durable execution: normalize state, keep genuinely-variable fields in JSON.

---

## §5 Hash-Chain Implementation for `workflow_gate_resolutions`

**Scheme.** Per-`workflow_run_id` chain. Each row references its predecessor via `prev_hash`; `row_hash` is `BLAKE3(prev_hash || JCS-canonical(row_body))`; `daemon_signature` is Ed25519 over the same canonical bytes; `approver_signature` is optionally Ed25519 from the approver's participant key.

**Why anchor to Spec-006's scheme (not invent a new SHA-256 scheme).** Spec-006 §Integrity Protocol already pins BLAKE3 + Ed25519 + RFC 8785 JCS for `session_events`. Introducing SHA-256 + a different canonicalization for workflow gates would:

1. Double the crypto surface (two primitives to verify, rotate, and audit).
2. Confuse verifiers — operators would need two verification tools.
3. Break the cross-reference: a single `WorkflowGateResolve` event in `session_events` (Pass F) and its corresponding `workflow_gate_resolutions` row would carry different hashes of the same decision.

BLAKE3 is fast enough (multi-GB/s on commodity CPU per [BLAKE3 spec](https://github.com/BLAKE3-team/BLAKE3-specs/blob/master/blake3.pdf)) that per-gate-resolution hashing is sub-microsecond — not a bottleneck.

**Canonical row body (the bytes that go into `BLAKE3(prev_hash || ...)`).** Ordered field list, RFC 8785 JCS canonicalized:

1. `id` (ULID)
2. `workflow_run_id`
3. `sequence`
4. `phase_run_id` (may be null — present-as-null per Spec-006 rule)
5. `gate_kind`
6. `approval_category` (nullable)
7. `approval_request_id` (nullable)
8. `outcome`
9. `approver_id` (nullable)
10. `approver_capability` (nullable)
11. `resolved_at` (RFC 3339 UTC ms precision)
12. `policy_snapshot_hash` (hex string of BLAKE3 over the Plan-012 policy bundle bytes active at `resolved_at`)
13. `decision_context` (JSON, already canonicalized)

**Chain bootstrap (sequence=1).** `prev_hash = 0x00 * 32` (32 zero bytes), matching Spec-006's session-chain bootstrap.

**Per-run (not per-session) chain rationale.** Workflow runs can outlive individual sessions' ordering requirements (e.g., a long-human-phase run suspended across daemon restart); the gate-resolution audit verifies per-run integrity, which is what the audit API exposes. A per-session chain would tangle with Spec-006's per-session chain, creating dual-chained rows. Per-run is clean.

**Anchoring to `session_events` (required for full integrity).** Every row in `workflow_gate_resolutions` MUST be paired with exactly one `session_events` row of category `workflow_gate_resolution` (Pass F event type) whose payload contains the `workflow_gate_resolutions.id` AND the `row_hash`. This makes the gate-resolution chain anchored to the session event chain — tampering with the gate table alone is detectable by cross-reference. This pattern is the Trillian "pre-ordered log" pattern applied in miniature ([Trillian Transparent Logging docs](https://google.github.io/trillian/docs/TransparentLogging.html)): the workflow_gate_resolutions table is the primary log, the session_events row is the inclusion proof.

**Verification procedure** (implemented in a V1 `sidekicks workflow verify-gate-chain <run_id>` CLI subcommand):

```
Input: workflow_run_id R
1. Load all workflow_gate_resolutions rows WHERE workflow_run_id = R ORDER BY sequence ASC.
2. prev = 0x00 * 32
3. For each row in order:
   a. canonical_bytes = RFC_8785_canonicalize(row.canonical_body_fields)
   b. expected_row_hash = BLAKE3(prev || canonical_bytes)
   c. ASSERT row.row_hash == expected_row_hash  (else FAIL: tamper-or-gap at sequence S)
   d. ASSERT Ed25519.verify(daemon_pubkey, canonical_bytes, row.daemon_signature)  (else FAIL: forged row)
   e. IF row.approver_signature IS NOT NULL:
        ASSERT Ed25519.verify(approver_pubkey, canonical_bytes, row.approver_signature)
   f. Cross-check: SELECT * FROM session_events WHERE
        category = 'workflow_gate_resolution' AND payload->>'$.gate_resolution_id' = row.id.
      ASSERT rowcount = 1 AND payload->>'$.row_hash' = hex(row.row_hash)  (else FAIL: orphaned chain row)
   g. prev = row.row_hash
4. If all rows pass: emit audit_integrity_verified event per Spec-006 category audit_integrity
5. If any row fails: emit integrity failure event (category audit_integrity, type=chain_break_detected),
   halt replay for this run, surface to operator.
```

**Negative precedent.** Do NOT implement a Merkle *tree* for V1 (flat hash chain is sufficient). Trillian's append-only Merkle tree ([Trillian README](https://github.com/google/trillian)) is overkill — it exists to support efficient non-repudiation proofs over millions of log entries, which is not V1's scale. A flat chain is the pattern in [Crosby & Wallach's USENIX 2009 tamper-evident logging paper](https://static.usenix.org/event/sec09/tech/full_papers/crosby.pdf) for small-to-medium logs and matches Spec-006's existing per-session chain. Merkle anchoring is deferred to V1.x when the first operator demands external anchoring.

---

## §6 Integration With Plan-015 Recovery + Plan-014 Artifacts

### Plan-015 integration

- **Pragmas inherited.** `journal_mode=WAL`, `synchronous=FULL`, `foreign_keys=ON`, `busy_timeout=5000` — all carry from Spec-015 §Pragmas. No table-local pragma overrides.
- **Writer-worker boundary.** All workflow-engine writes route through the single writer worker (Spec-015 §Writer Concurrency). The workflow executor tick emits events + state updates via the shared writer queue; the 50-event / 10 ms batch cadence amortizes cost (§7).
- **Recovery primitive reuse.** `ProjectionRebuild` (Spec-015) replays session_events category `workflow_lifecycle` + `workflow_gate_resolution` + `workflow_phase_transition` to rebuild `workflow_runs`, `workflow_phase_states`, and `parallel_join_state`. Tables 3, 4, 7 are therefore *projections*, fully rebuildable from session_events; a lost file (WAL corruption) doesn't lose truth, only the projection.
- **Idempotency class alignment.** Phases that invoke tools with side effects inherit Plan-015's `idempotency_class` dispatch via `command_receipts`. A phase-level retry under C-9 creates a new `workflow_phase_states` row; the tool calls inside it get new `command_id`s to avoid double-execution through the Plan-015 two-phase receipt protocol.
- **Backup scope.** All 9 workflow tables are captured by `better-sqlite3.backup()` because they live in the same DB file as session_events. No separate backup flow needed.
- **Replay cursor integration.** Workflow-level replay uses `replay_cursors` (Plan-015) keyed on `session_id`; workflow-run-specific cursors are derived from `workflow_phase_states.last_event_sequence` during projection rebuild.

### Plan-014 integration

- **Artifact foreign keys.** `phase_outputs.artifact_manifest_id` and implicit references from `human` phase uploads (C-16) link to `artifact_manifests.id` (Plan-014 owner).
- **Human phase upload flow (C-16).** When a `human` phase's `inputSchema` includes an `artifact` field:
  1. The participant uploads via Plan-014's OWASP-minimums-compliant upload endpoint (size cap, magic-byte sniff, AV hook — per SA Pass E §4.6).
  2. Plan-014 emits an `artifact.manifest_created` event and returns an `ArtifactId`.
  3. On phase submit, the form draft in `human_phase_form_state.draft_json` carries the `ArtifactId` reference.
  4. Phase submit writes a `phase_outputs` row with `value_kind='artifact_ref'`, `artifact_manifest_id=ArtifactId`.
- **Content-hash alignment.** `phase_outputs.content_hash` for `value_kind='artifact_ref'` is `BLAKE3(artifact_manifest.content_hash)` (a digest-of-digest), which keeps workflow-level verification decoupled from the underlying artifact SHA-256.
- **Artifact GC coordination.** `idx_phase_outputs_artifact` lets Plan-014's GC sweep find workflow-pinned artifacts before reclamation. An artifact referenced by any non-`failed`/`cancelled` run is pinned; Plan-014's retention policy consults this index.

---

## §7 Write-Amplification Estimate

**Per phase transition** (e.g., `started → progressed` on one row):

| Write | Target | Bytes (approx) |
| --- | --- | --- |
| 1 | `session_events` INSERT (hash+sig) | ~500 B |
| 1 | `workflow_phase_states` UPDATE | ~150 B |
| 0-1 | `workflow_runs` UPDATE (transitions_count++) | ~50 B |
| 0-1 | `parallel_join_state` UPDATE | ~50 B |
| 0-N | `phase_outputs` INSERT | ~300 B each |
| 0-1 | `workflow_gate_resolutions` INSERT | ~800 B |

Classes: steady-state `progressed` ≈ 650 B / 2 tables; state-machine transition ≈ 1,550 B / 4 tables; gate-crossing ≈ 2,350 B / 5 tables.

**10-phase workflow projection.** Assume 10 phases, 3 with gates, 2 parallel siblings, 1 human phase, 5 progress heartbeats per phase avg, 10% retry rate:

| Event class | Count | Bytes | Subtotal |
| --- | --- | --- | --- |
| Run lifecycle | 3 | 500 | 1,500 |
| Phase state transitions (admit/start/complete × 10 + 1 retry) | 33 | 650 | 21,450 |
| Progress heartbeats | 50 | 200 | 10,000 |
| Phase outputs | 10 | 400 | 4,000 |
| Gate resolutions | 3 | 800 | 2,400 |
| Parallel join updates | 4 | 150 | 600 |
| Channel links | 2 | 300 | 600 |
| Human form autosaves | 5 | 250 | 1,250 |
| **Total** | **110** | — | **~42 KB** |

**WAL behavior.** Under Spec-015's 50-event / 10 ms batch, 110 writes fit in 2–3 batches (2–3 `fsync()` with `synchronous=FULL`) — well under daemon throughput budget.

**Scale failure modes (Pass H testing).** Pathological `progressed` heartbeat floods at 100 ms cadence would need rate-limiting at the executor — V1.x tightening, not a V1 schema concern. Gate-chain verification scales linearly at ~1 ms/row × 100 rows = 100 ms per run; acceptable for operator-triggered audit.

---

## §8 Replay Contract

**Source of truth.** `session_events` table (append-only, hash-chained per Spec-006) plus the immutable tables `workflow_definitions`, `workflow_versions`, `phase_outputs`, `workflow_gate_resolutions`. A daemon could in principle drop the projection tables and rebuild them from these four inputs.

**Deterministic-replayable state from this schema:**

- `workflow_runs` state + counters — reconstruct from session_events `workflow_lifecycle` + phase transition events.
- `workflow_phase_states` state machine — reconstruct from session_events per-phase event stream.
- `parallel_join_state` counters and resolution — reconstruct by replaying sibling completion events against the join's `policy`.
- `workflow_channels` termination record — reconstruct from session_events `workflow.channel_*` events.

**Not deterministic-replayable (ephemeral; lost on daemon restart):**

- Pool reservation state (`pool_reservations_snapshot`, `pool_reservation`) — these are runtime-ephemeral. On restart the executor re-requests pool admission; rows that were `waiting_on_pool` re-enter admission.
- Executor tick counter — `cancel_wave_tick` is an internal ordering primitive; new tick numbers are assigned on resumed execution.
- Human phase draft contents (`human_phase_form_state`) — the daemon doesn't reconstruct drafts; clients resume from their own localStorage per Pass C §3 (the daemon table is present for V1.x fallback, not V1 replay).

**Retry replay.** Per C-9, retry creates a new attempt row, not a mutation. Replay of a retried phase produces exactly the same `workflow_phase_states` row sequence as the original execution (attempt 1 row is still there, attempt 2 row is still there, both preserved). This makes replay idempotent even for retried workflows.

**Hash-chain replay.** `workflow_gate_resolutions` is replayed row-by-row in `sequence` order; each row's `row_hash` is re-verified against recomputed `BLAKE3(prev_hash || canonical_bytes)`. A chain break halts replay for that run and emits an `audit_integrity` failure event. This is the Temporal Event History verification pattern at smaller scale ([Temporal Events and Event History docs](https://docs.temporal.io/workflow-execution/event)).

**Explicit limitation.** Workflow-run-level replay does **not** reconstruct intermediate agent-driver internal state (e.g., conversation tokens mid-turn). That's deferred to Plan-015's `RuntimeBindingRead` + provider-specific resume handle recovery. Phase-level replay establishes the state-machine position; driver-level replay then resumes the agent from that position.

---

## §9 Websearch Evidence Table

Primary-source citations from 2024–2026 covering the 5 required research areas (minimum 5; 9 provided).

| # | Source | Area | Relevance |
| --- | --- | --- | --- |
| 1 | [Temporal — Events and Event History](https://docs.temporal.io/workflow-execution/event) | Temporal persistence | Event history as append-only log; 51,200/50 MB limits; append-only-by-construction anchor for §8 replay pattern. |
| 2 | [Temporal blog — Custom persistence layer, 2024](https://temporal.io/blog/higher-throughput-and-lower-latency-temporal-clouds-custom-persistence-layer) | Temporal persistence | Normalized-vs-chunked history trade-off; informs §4 normalized choice. |
| 3 | [Restate — Building a modern durable-execution engine, 2025](https://www.restate.dev/blog/building-a-modern-durable-execution-engine-from-first-principles) | Restate architecture | Log-plus-processor pattern (Bifrost log, RocksDB state); contrasts with our single-SQLite embedded pattern. |
| 4 | [SQLite — Write-Ahead Logging](https://www.sqlite.org/wal.html) + [SQLite JSON1](https://sqlite.org/json1.html) | SQLite best practices | WAL concurrency semantics; JSONB on-disk format (v3.45.0 2024-01-15) justifies bounded JSON-column use. |
| 5 | [Crosby & Wallach — Efficient Tamper-Evident Logging, USENIX 2009](https://static.usenix.org/event/sec09/tech/full_papers/crosby.pdf) + [AuditableLLM, MDPI Electronics Dec 2025](https://www.mdpi.com/2079-9292/15/1/56) | Hash-chain audit logs | Foundational flat-chain pattern + 2025 validation for LLM-adjacent audit trails; informs §5 flat-chain choice. |
| 6 | [Google Trillian — Transparent Logging](https://google.github.io/trillian/docs/TransparentLogging.html) | Merkle hash-chain | Pre-ordered log mode as inclusion-proof pattern; informs §5 `session_events`-anchor design. |
| 7 | [Argo Workflows — Persistence and Archiving](https://deepwiki.com/argoproj/argo-workflows/2.9-persistence-and-archiving) + [Offloading Large Workflows](https://argo-workflows.readthedocs.io/en/latest/offloading-large-workflows/) | Argo persistence | Node-status-offloading; 1 MB etcd limit drove normalization — convergent with §4 recommendation. |
| 8 | [Cadence — Persistence docs](https://github.com/cadence-workflow/cadence/blob/master/docs/persistence.md) | Cadence persistence | Per-shard history chain pattern; informs per-run chain choice in §5. |
| 9 | [better-sqlite3 API docs, v12.9.0 (2026-04-12)](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md) | SQLite driver | `db.transaction(fn)` atomicity + `.backup()` contracts; anchor for §6 integration. |

---

## §10 Open Questions for Wave 2 Synthesis

1. **STRICT-tables adoption.** Schema uses the repo's TEXT-column convention (no STRICT). SQLite 3.37+ STRICT is a cheap correctness win but diverges from the rest of `local-sqlite-schema.md`. Recommend: raise as cross-cutting ADR (affects all plans, not just Plan-017) rather than resolve inside Pass G.
2. **Per-run vs per-session gate chain.** §5 argues per-run because run lifetimes exceed session ordering scope. Counterpoint: per-session chain tooling already exists in Spec-006. Accept per-run anyway; flag for Wave-2 synthesis review.
3. **`human_phase_form_state` V1 status.** Recommend: ship the table empty in V1 (zero migration cost when V1.x daemon-side drafts land, zero runtime cost if unused).
4. **Rebuild-from-event-payload path for `workflow_gate_resolutions`.** Table is truth (hash-chained), but `session_events` anchor carries the row bytes in payload. Spec-015 doesn't enumerate this rebuild path. Recommend: add explicit rebuild-from-event path to Plan-015.
5. **Content-hash scheme for `workflow_definitions.content_hash`.** Recommend BLAKE3 over JCS for Spec-006 consistency; SHA-256 would match Plan-014's `artifact_manifests.content_hash`. Resolve as "BLAKE3 for daemon-internal identity, SHA-256 for Plan-014-owned artifact content".
6. **`phase_transitions_count` CHECK behavior.** On trip, UPDATE fails and executor halts run with `failure_reason='RUN_ITERATION_LIMIT'` (hard-fail matching Pass A §3.2). Confirm in Wave-2; alternative is soft-cap with observer event.
7. **Pool reservation durability.** Recommend: write-once reservation intent to `workflow_phase_states.pool_reservation` at admit time; don't persist runtime pool counts. Flag for Pass A author.
8. **Retention for completed workflow runs.** Recommend: reuse Spec-022 crypto-shred for PII, inherit Spec-015 backup policy. No workflow-engine-specific TTL.

---

*End of Pass G.*
