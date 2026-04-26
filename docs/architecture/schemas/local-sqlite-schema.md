# Local SQLite Schema

Canonical schema for the local daemon's SQLite database. Each runtime node maintains its own instance.

**Storage boundary:** Machine-scoped execution truth and recovery data. See [Data Architecture](../data-architecture.md).

## Pragmas

```sql
PRAGMA journal_mode = WAL;      -- concurrent readers during writes
PRAGMA synchronous = FULL;      -- override better-sqlite3 default (NORMAL) for chain-of-custody durability (see Spec-015 §Pragmas + Spec-006 §Integrity Protocol)
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

---

## Session Events (Plan-001, extended by Plans 006, 015)

```sql
-- Owner: Plan-001 | Extended by: Plan-006 (event taxonomy + integrity protocol), Plan-015 (replay cursors)
CREATE TABLE session_events (
  id                     TEXT PRIMARY KEY,           -- ULID or UUID
  session_id             TEXT NOT NULL,
  sequence               INTEGER NOT NULL,           -- monotonic per session
  occurred_at            TEXT NOT NULL,              -- RFC 3339 UTC with ms precision (wall-clock; display + audit)
  monotonic_ns           INTEGER NOT NULL,           -- process.hrtime.bigint() at emit; within-daemon ordering only (see Spec-015 §Clock Handling, BL-062)
  category               TEXT NOT NULL,              -- e.g. 'run_lifecycle', 'assistant_output', 'tool_activity'
  type                   TEXT NOT NULL,              -- specific event type within category
  actor                  TEXT,                       -- participant_id or agent_id or NULL for system
  payload                TEXT NOT NULL DEFAULT '{}', -- JSON event payload
  pii_payload            BLOB,                       -- encrypted per-participant AES-256-GCM (GDPR); NOT hashed/signed
  correlation_id         TEXT,                       -- links related events
  causation_id           TEXT,                       -- parent event that caused this one
  version                TEXT NOT NULL DEFAULT '1.0'
                         CHECK (version GLOB '[0-9]*.[0-9]*'), -- semver "MAJOR.MINOR" per ADR-018 §Decision #1
                                                               -- (never INTEGER; comparison must parse MAJOR/MINOR as ints —
                                                               -- lexical TEXT comparison is unsafe, e.g. "1.10" < "1.9")
  -- Integrity protocol (BL-050): hash-chain + per-event daemon signature
  prev_hash              BLOB NOT NULL,              -- 32 bytes; row_hash of previous row (zero-filled at sequence=0)
  row_hash               BLOB NOT NULL,              -- 32 bytes; BLAKE3(prev_hash || JCS-canonical envelope bytes)
  daemon_signature       BLOB NOT NULL,              -- 64 bytes; Ed25519 over same canonical bytes
  participant_signature  BLOB,                       -- 64 bytes; Ed25519 from participant key; NULL for non-sensitive events
  UNIQUE(session_id, sequence)
);

CREATE INDEX idx_session_events_session_seq ON session_events(session_id, sequence);
CREATE INDEX idx_session_events_type ON session_events(session_id, type);
CREATE INDEX idx_session_events_correlation ON session_events(correlation_id) WHERE correlation_id IS NOT NULL;
```

**Integrity protocol.** `prev_hash`, `row_hash`, `daemon_signature` are required; `participant_signature` is NULL-able and present only for sensitive events (approvals, policy changes, membership revocations). The canonical serialization (RFC 8785 JCS) and verification order are specified in [Security Architecture § Audit Log Integrity](../security-architecture.md#audit-log-integrity) and [Spec-006 § Integrity Protocol](../../specs/006-session-event-taxonomy-and-audit-log.md#integrity-protocol).

## Session Snapshots (Plan-001, extended by Plans 006, 015)

```sql
-- Owner: Plan-001 | Extended by: Plan-006, Plan-015
CREATE TABLE session_snapshots (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  as_of_sequence  INTEGER NOT NULL,           -- snapshot reflects events up to this sequence
  state_blob      BLOB NOT NULL,              -- serialized session state
  created_at      TEXT NOT NULL,
  FOREIGN KEY (session_id, as_of_sequence) REFERENCES session_events(session_id, sequence)
);

CREATE INDEX idx_session_snapshots_session ON session_snapshots(session_id, as_of_sequence);
```

---

## Queue and Intervention Tables (Plan-004)

```sql
-- Owner: Plan-004
CREATE TABLE queue_items (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  channel_id      TEXT,                       -- nullable for session-level items
  state           TEXT NOT NULL DEFAULT 'queued'
                  CHECK(state IN ('queued', 'admitted', 'superseded', 'canceled', 'expired')),
  priority        INTEGER NOT NULL DEFAULT 0, -- higher = more urgent
  payload         TEXT NOT NULL DEFAULT '{}', -- JSON: content, context, metadata
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX idx_queue_items_session_state ON queue_items(session_id, state);
CREATE INDEX idx_queue_items_channel ON queue_items(channel_id) WHERE channel_id IS NOT NULL;

-- Owner: Plan-004
CREATE TABLE interventions (
  id                    TEXT PRIMARY KEY,
  target_run_id         TEXT NOT NULL,
  type                  TEXT NOT NULL
                        CHECK(type IN ('steer', 'interrupt', 'cancel')),
  state                 TEXT NOT NULL DEFAULT 'requested'
                        CHECK(state IN ('requested', 'accepted', 'applied', 'rejected', 'degraded', 'expired')),
  payload               TEXT NOT NULL DEFAULT '{}', -- JSON: type-specific fields
  expected_run_version  INTEGER,                    -- version guard for expiration detection
  result                TEXT,                       -- JSON: outcome details
  initiator_id          TEXT,                       -- participant or system
  created_at            TEXT NOT NULL,
  resolved_at           TEXT
);

CREATE INDEX idx_interventions_run ON interventions(target_run_id);
CREATE INDEX idx_interventions_state ON interventions(state) WHERE state IN ('requested', 'accepted');

-- Owner: Plan-004 | Extended by: Plan-015 (recovery + two-phase idempotency protocol, BL-051)
CREATE TABLE command_receipts (
  id                TEXT PRIMARY KEY,
  command_id        TEXT NOT NULL UNIQUE,         -- idempotency key (client-supplied)
  run_id            TEXT,
  status            TEXT NOT NULL
                    CHECK(status IN ('accepted', 'rejected', 'completed', 'failed')),
  -- BL-051 two-phase commit columns
  idempotency_class TEXT NOT NULL
                    CHECK(idempotency_class IN ('idempotent', 'compensable', 'manual_reconcile_only')),
  dedupe_key        TEXT,                         -- propagated to remote side for 'compensable' tools
  started_at        TEXT,                         -- set by Phase 2 optimistic CAS; NULL until claimed
  completed_at      TEXT,                         -- set by Phase 3; NULL until terminal-status
  created_at        TEXT NOT NULL
);

CREATE INDEX idx_command_receipts_run ON command_receipts(run_id) WHERE run_id IS NOT NULL;
-- Recovery sweep index: find in-flight receipts needing idempotency-class-based handling
CREATE INDEX idx_command_receipts_inflight ON command_receipts(run_id)
  WHERE started_at IS NOT NULL AND completed_at IS NULL;
```

---

## Driver and Runtime Binding Tables (Plan-005)

```sql
-- Owner: Plan-005 | Extended by: Plan-015 (recovery-aware persistence)
CREATE TABLE runtime_bindings (
  id                TEXT PRIMARY KEY,
  run_id            TEXT NOT NULL,
  driver_name       TEXT NOT NULL,            -- e.g. 'claude', 'codex'
  contract_version  TEXT NOT NULL,            -- semver of driver contract
  resume_handle     TEXT,                     -- provider-owned opaque handle
  runtime_metadata  TEXT NOT NULL DEFAULT '{}', -- JSON: provider-specific recovery data
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX idx_runtime_bindings_run ON runtime_bindings(run_id);

-- Owner: Plan-005
CREATE TABLE driver_capabilities (
  driver_name       TEXT NOT NULL,
  capability_flag   TEXT NOT NULL
                    CHECK(capability_flag IN (
                      'resume', 'steer', 'interactive_requests', 'mcp',
                      'tool_calls', 'reasoning_stream', 'model_mutation'
                    )),
  supported         INTEGER NOT NULL DEFAULT 0, -- boolean: 0 or 1
  refreshed_at      TEXT NOT NULL,
  PRIMARY KEY (driver_name, capability_flag)
);
```

---

## Runtime Node Local Tables (Plan-003)

```sql
-- Owner: Plan-003
CREATE TABLE node_capabilities (
  node_id           TEXT NOT NULL,
  capability_key    TEXT NOT NULL,
  capability_value  TEXT NOT NULL DEFAULT '{}', -- JSON
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (node_id, capability_key)
);

-- Owner: Plan-003
CREATE TABLE node_trust_state (
  node_id           TEXT NOT NULL PRIMARY KEY,
  trust_level       TEXT NOT NULL DEFAULT 'untrusted',
  established_at    TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
```

---

## Workspace and Git Tables (Plan-009, Plan-010, Plan-011)

```sql
-- Owner: Plan-009
CREATE TABLE repo_mounts (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  local_path      TEXT NOT NULL,              -- filesystem path to repo root
  vcs_type        TEXT NOT NULL DEFAULT 'git',
  state           TEXT NOT NULL DEFAULT 'attached'
                  CHECK(state IN ('attached', 'detached', 'archived')),
  attached_at     TEXT NOT NULL,
  metadata        TEXT NOT NULL DEFAULT '{}' -- JSON
);

CREATE INDEX idx_repo_mounts_session ON repo_mounts(session_id);

-- Owner: Plan-009
CREATE TABLE workspaces (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  repo_mount_id   TEXT NOT NULL REFERENCES repo_mounts(id),
  execution_mode  TEXT NOT NULL DEFAULT 'worktree'
                  CHECK(execution_mode IN ('read-only', 'branch', 'worktree', 'ephemeral clone')),
  fs_root         TEXT,                       -- resolved filesystem root
  state           TEXT NOT NULL DEFAULT 'provisioning'
                  CHECK(state IN ('provisioning', 'ready', 'busy', 'stale', 'archived')),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX idx_workspaces_session ON workspaces(session_id);
CREATE INDEX idx_workspaces_repo ON workspaces(repo_mount_id);

-- Owner: Plan-010
CREATE TABLE worktrees (
  id              TEXT PRIMARY KEY,
  repo_mount_id   TEXT NOT NULL REFERENCES repo_mounts(id),
  branch_name     TEXT NOT NULL,
  fs_root         TEXT NOT NULL,              -- filesystem path to worktree
  state           TEXT NOT NULL DEFAULT 'creating'
                  CHECK(state IN ('creating', 'ready', 'dirty', 'merged', 'retired', 'failed')),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX idx_worktrees_repo ON worktrees(repo_mount_id);

-- Owner: Plan-010
CREATE TABLE ephemeral_clones (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
  clone_root      TEXT NOT NULL,              -- filesystem path
  cleanup_policy  TEXT NOT NULL DEFAULT 'on_run_complete',
  state           TEXT NOT NULL DEFAULT 'creating'
                  CHECK(state IN ('creating', 'ready', 'retired', 'failed')),
  created_at      TEXT NOT NULL
);

-- Owner: Plan-010 | Extended by: Plan-011
CREATE TABLE branch_contexts (
  id              TEXT PRIMARY KEY,
  worktree_id     TEXT NOT NULL REFERENCES worktrees(id),
  base_branch     TEXT NOT NULL,
  head_branch     TEXT NOT NULL,
  upstream_ref    TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX idx_branch_contexts_worktree ON branch_contexts(worktree_id);

-- Owner: Plan-011
CREATE TABLE diff_artifacts (
  id                    TEXT PRIMARY KEY,
  artifact_manifest_id  TEXT REFERENCES artifact_manifests(id),
  run_id                TEXT NOT NULL,
  attribution_mode      TEXT NOT NULL,        -- e.g. 'agent_trace', 'git_diff'
  base_ref              TEXT NOT NULL,
  head_ref              TEXT NOT NULL,
  created_at            TEXT NOT NULL
);

CREATE INDEX idx_diff_artifacts_run ON diff_artifacts(run_id);

-- Owner: Plan-011
CREATE TABLE pr_preparations (
  id                  TEXT PRIMARY KEY,
  branch_context_id   TEXT NOT NULL REFERENCES branch_contexts(id),
  state               TEXT NOT NULL DEFAULT 'draft'
                      CHECK(state IN ('draft', 'ready', 'submitted', 'merged', 'abandoned')),
  proposal_blob       TEXT,                   -- JSON: title, description, reviewers
  target_branch       TEXT NOT NULL,
  created_at          TEXT NOT NULL
);

CREATE INDEX idx_pr_preparations_branch ON pr_preparations(branch_context_id);
```

---

## Artifact Tables (Plan-014)

```sql
-- Owner: Plan-014
CREATE TABLE artifact_manifests (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  run_id          TEXT,
  artifact_type   TEXT NOT NULL,              -- e.g. 'code', 'document', 'image', 'diff'
  visibility      TEXT NOT NULL DEFAULT 'local-only'
                  CHECK(visibility IN ('local-only', 'shared')),
  state           TEXT NOT NULL DEFAULT 'pending'
                  CHECK(state IN ('pending', 'published', 'superseded')),
  content_hash    TEXT,                       -- SHA-256 for deduplication
  metadata        TEXT NOT NULL DEFAULT '{}', -- JSON: provenance, media type, etc.
  created_at      TEXT NOT NULL
);

CREATE INDEX idx_artifact_manifests_session ON artifact_manifests(session_id);
CREATE INDEX idx_artifact_manifests_run ON artifact_manifests(run_id) WHERE run_id IS NOT NULL;
CREATE INDEX idx_artifact_manifests_hash ON artifact_manifests(content_hash) WHERE content_hash IS NOT NULL;

-- Owner: Plan-014
CREATE TABLE artifact_payload_refs (
  id              TEXT PRIMARY KEY,
  manifest_id     TEXT NOT NULL REFERENCES artifact_manifests(id),
  storage_path    TEXT NOT NULL,              -- filesystem path or CAS key
  media_type      TEXT NOT NULL,              -- MIME type
  size_bytes      INTEGER NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE INDEX idx_artifact_payload_refs_manifest ON artifact_payload_refs(manifest_id);
```

---

## Approval Tables (Plan-012)

The 8 canonical approval categories: `tool_execution`, `file_write`, `network_access`, `destructive_git`, `user_input`, `plan_approval`, `mcp_elicitation`, `gate`.

```sql
-- Owner: Plan-012
CREATE TABLE approval_requests (
  id                    TEXT PRIMARY KEY,
  run_id                TEXT NOT NULL,
  category              TEXT NOT NULL
                        CHECK(category IN (
                          'tool_execution', 'file_write', 'network_access', 'destructive_git',
                          'user_input', 'plan_approval', 'mcp_elicitation', 'gate'
                        )),
  scope                 TEXT NOT NULL,        -- requested scope descriptor
  resource_descriptor   TEXT,                 -- target resource details (JSON)
  expiry_at             TEXT,                 -- ISO 8601, nullable for no-expiry
  state                 TEXT NOT NULL DEFAULT 'pending'
                        CHECK(state IN ('pending', 'approved', 'rejected', 'expired', 'canceled')),
  created_at            TEXT NOT NULL
);

CREATE INDEX idx_approval_requests_run ON approval_requests(run_id);
CREATE INDEX idx_approval_requests_state ON approval_requests(state) WHERE state = 'pending';

-- Owner: Plan-012
CREATE TABLE approval_resolutions (
  id                  TEXT PRIMARY KEY,
  request_id          TEXT NOT NULL REFERENCES approval_requests(id),
  approver_id         TEXT NOT NULL,          -- participant who resolved
  decision            TEXT NOT NULL
                      CHECK(decision IN ('approved', 'rejected')),
  remembered_scope    TEXT,                   -- scope for remembered rules, nullable
  resolved_at         TEXT NOT NULL,
  audit_metadata      TEXT NOT NULL DEFAULT '{}' -- JSON: audit trail
);

CREATE UNIQUE INDEX idx_approval_resolutions_request ON approval_resolutions(request_id);

-- Owner: Plan-012
CREATE TABLE remembered_approval_rules (
  id                    TEXT PRIMARY KEY,
  participant_id        TEXT NOT NULL,
  category              TEXT NOT NULL
                        CHECK(category IN (
                          'tool_execution', 'file_write', 'network_access', 'destructive_git',
                          'user_input', 'plan_approval', 'mcp_elicitation', 'gate'
                        )),
  scope_pattern         TEXT NOT NULL,        -- pattern for matching future requests
  granted_at            TEXT NOT NULL,
  revoked_at            TEXT,                 -- nullable; set when rule is invalidated
  invalidation_trigger  TEXT                  -- what caused revocation (session end, explicit, etc.)
);

CREATE INDEX idx_remembered_rules_participant ON remembered_approval_rules(participant_id, category);
```

---

## Cross-Node Dispatch Tables (Plan-027)

Stores per-daemon ApprovalRecord envelopes for Spec-024. The same logical dispatch may produce one caller-local row and one target-local row, distinguished by `local_role`. Dispatch payloads, action payloads, and result payloads are not stored here; the durable audit artifact is the dual-signed ApprovalRecord envelope plus lifecycle metadata.

```sql
-- Owner: Plan-027
CREATE TABLE cross_node_dispatch_approvals (
  id                    TEXT PRIMARY KEY,
  dispatch_id           TEXT NOT NULL,
  session_id            TEXT NOT NULL,
  local_role            TEXT NOT NULL
                        CHECK(local_role IN ('caller', 'target')),
  caller_participant_id TEXT NOT NULL,
  target_participant_id TEXT NOT NULL,
  target_node_id        TEXT NOT NULL,
  capability            TEXT NOT NULL,
  request_body_hash     TEXT NOT NULL CHECK(request_body_hash GLOB 'b3:*'),
  approval_record_json  TEXT,                 -- JSON: Spec-024 dual-token ApprovalRecord envelope; NULL until decision
  caller_token_jti      TEXT NOT NULL,
  approver_token_jti    TEXT,                 -- NULL until target-owner decision exists
  decision              TEXT
                        CHECK(decision IS NULL OR decision IN ('allow', 'deny')),
  state                 TEXT NOT NULL DEFAULT 'requested'
                        CHECK(state IN (
                          'requested', 'approved', 'denied', 'executed',
                          'completed', 'failed', 'expired', 'rejected'
                        )),
  created_at            TEXT NOT NULL,
  resolved_at           TEXT,
  expires_at            TEXT NOT NULL,
  UNIQUE(dispatch_id, local_role)
);

CREATE INDEX idx_cross_node_dispatch_approvals_session_state
  ON cross_node_dispatch_approvals(session_id, state);

CREATE INDEX idx_cross_node_dispatch_approvals_target
  ON cross_node_dispatch_approvals(target_node_id, state);

CREATE INDEX idx_cross_node_dispatch_approvals_expiry
  ON cross_node_dispatch_approvals(expires_at)
  WHERE state IN ('requested', 'approved', 'executed');
```

---

## Workflow Tables (Plan-017)

Full workflow-engine V1 schema. Nine tables implement the 10-state phase machine, append-only hash-chained gate history (C-13/I7), parallel-join bookkeeping, and OWN-only channel linkage. `session_events` remains canonical truth; tables 3/4/7/8/9 are rebuildable projections, and 1/2/5/6 are immutable truth (6 additionally carries a per-run BLAKE3 chain anchored to [Spec-006 § Integrity Protocol](../../specs/006-session-event-taxonomy-and-audit-log.md#integrity-protocol)).

The normalized-table-over-blob shape, the per-run hash-chained gate-resolution audit trail, and the rebuildable-projection split align with industry persistence precedents: durable-execution engines persist normalized state per run rather than monolithic blobs (*"Restate stores the state of each invocation in a durable log"* — [Restate — Building Modern Durable Execution, 2025](https://restate.dev/blog/building-modern-durable-execution/), fetched 2026-04-25); large-engine persistence tiers separate hot live state from cold archive ([Argo Workflows — Workflow Archive](https://argo-workflows.readthedocs.io/en/latest/workflow-archive/), fetched 2026-04-25); and append-only hash-chained audit trails are the canonical academic precedent for tamper-evident logging (*"a tamper-evident log... uses a hash chain to detect tampering with high probability"* — [Crosby & Wallach, Efficient Data Structures for Tamper-Evident Logging, USENIX Security 2009](https://static.usenix.org/event/sec09/tech/full_papers/crosby.pdf), fetched 2026-04-25). Spec-017 §References > Persistence + hash-chain enumerates the full primary-source corpus.

```sql
-- ========================================================================
-- 1. workflow_definitions — content-hashed, immutable, schema-versioned
-- ========================================================================
-- Owner: Plan-017
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
  -- SA-1 iteration counter
  phase_transitions_count   INTEGER NOT NULL DEFAULT 0,
  max_phase_transitions     INTEGER NOT NULL DEFAULT 100, -- SA-1 default
  -- SA-2 duration deadline
  started_at                TEXT,                      -- RFC 3339 UTC
  deadline_at               TEXT,                      -- started_at + max_duration (computed at start)
  max_duration_ms           INTEGER NOT NULL DEFAULT 86400000, -- SA-2 default 24h
  completed_at              TEXT,
  -- SA-3 pool reservations (snapshot only; pool runtime state is ephemeral and NOT persisted)
  pool_reservations_snapshot TEXT NOT NULL DEFAULT '{}', -- JSON: {pty_slots: n, agent_memory_mb: n}
  -- Result
  failure_reason            TEXT,                       -- null unless status in ('failed','cancelled')
  failure_detail            TEXT,                       -- JSON; includes cancellation_reason per Pass F
  created_at                TEXT NOT NULL,
  created_by                TEXT,                       -- participant_id or trigger
  CHECK(phase_transitions_count <= max_phase_transitions),
  CHECK(max_duration_ms > 0)
);

CREATE INDEX idx_workflow_runs_session ON workflow_runs(session_id);
CREATE INDEX idx_workflow_runs_status ON workflow_runs(status)
  WHERE status IN ('pending','running','suspended');
CREATE INDEX idx_workflow_runs_deadline ON workflow_runs(deadline_at)
  WHERE status IN ('running','suspended') AND deadline_at IS NOT NULL;
CREATE INDEX idx_workflow_runs_version ON workflow_runs(workflow_version_id);

-- ========================================================================
-- 4. workflow_phase_states — per-phase state machine projection
-- ========================================================================
-- Owner: Plan-017
-- Wave-1 commitments: 10-state machine from Wave-1 §7.1 / Pass F scope
-- Phase types cover all four V1 types: single-agent, multi-agent, automated, human
-- (`automated` subtype `auto-continue`/`done`/`quality-checks`; `human` subtype `human-approval`/`human`)
CREATE TABLE workflow_phase_states (
  id                      TEXT PRIMARY KEY,            -- ULID; also the phase_run_id used by Pass B channels
  workflow_run_id         TEXT NOT NULL REFERENCES workflow_runs(id),
  phase_id                TEXT NOT NULL,               -- logical phase id from workflow_versions.phase_definitions
  phase_type              TEXT NOT NULL
                          CHECK(phase_type IN (
                            'single-agent','multi-agent','auto-continue','done',
                            'human-approval','human','quality-checks','gate','terminal'
                          )),
  -- 10-state machine per Wave-1 §7.1 / Pass F
  state                   TEXT NOT NULL DEFAULT 'admitted'
                          CHECK(state IN (
                            'admitted','waiting_on_pool','started','progressed',
                            'suspended','resumed','cancelling','failed','completed','retried'
                          )),
  attempt_number          INTEGER NOT NULL DEFAULT 1,  -- 1..max_retries; retry creates new row per C-9
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
-- Immutability invariant: no UPDATE trigger — all writes INSERT-only; a retry inserts
-- a new row under a new phase_run_id (attempt_number+1) rather than mutating the existing row.

-- ========================================================================
-- 6. workflow_gate_resolutions — append-only hash-chained per C-13 / I7
-- ========================================================================
-- Owner: Plan-017
-- Wave-1 commitment: C-13 append-only hash-chained approval history (Pass E §4.7)
-- Algorithm anchored to Spec-006 §Integrity Protocol (BLAKE3 + Ed25519 + RFC 8785 JCS)
-- to keep one canonicalization rule across the daemon.
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
-- Verification procedure: BLAKE3 chain recompute per Spec-006 §Integrity Protocol + dual-anchor cross-check vs session_events payload (see "Hash-chain verification" note below this block).

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
  -- Cancellation cascade bookkeeping (Wave-1 §3.1 synchrony verification)
  cancel_wave_tick        INTEGER,                    -- executor tick at which cancel wave fired; NULL until fail-fast triggers
  created_at              TEXT NOT NULL
);

CREATE INDEX idx_parallel_join_state_run ON parallel_join_state(workflow_run_id);
CREATE INDEX idx_parallel_join_state_unresolved ON parallel_join_state(workflow_run_id)
  WHERE resolution IS NULL;

-- ========================================================================
-- 8. workflow_channels — phase_run_id ↔ channel_id (OWN-only V1)
-- ========================================================================
-- Owner: Plan-017
-- Wave-1 commitment: SA-6 ownership: OWN V1 (BIND deferred to V1.1 under criterion-gated commitments per ADR-015)
-- Pass B §3.1 channel-lifecycle coupling; Spec-016 linkage
CREATE TABLE workflow_channels (
  id                      TEXT PRIMARY KEY,           -- ULID
  phase_run_id            TEXT NOT NULL UNIQUE REFERENCES workflow_phase_states(id), -- UNIQUE = OWN 1:1
  channel_id              TEXT NOT NULL REFERENCES channels(id),
  ownership               TEXT NOT NULL DEFAULT 'OWN'
                          CHECK(ownership IN ('OWN')),  -- V1: OWN only; BIND reserved for V1.1 per ADR-015
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
-- 9. human_phase_form_state — draft autosave (daemon-side fallback for V1.x)
-- ========================================================================
-- Owner: Plan-017
-- Wave-1 status: Pass C §3 — V1 clients use localStorage/IndexedDB; this table
-- ships empty in V1 so the V1.x daemon-side draft persistence has no migration cost.
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

**Index rationale + write-amplification estimate:** Per-index query justifications above are sized against SQLite's standard query-planner cost model — partial indexes with `WHERE` clauses are evaluated only over the matching subset, yielding the smallest workable index for the live-set queries ([SQLite — Partial Indexes](https://www.sqlite.org/partialindex.html), fetched 2026-04-25). The ~42 KB / 110-write projection for a 10-phase workflow assumes Spec-015's 50-event batch flushed under one `db.transaction(fn)` call — `better-sqlite3` commits each batch atomically and rolls back on throw (*"Calling [.transaction()] returns a new function that, when called, runs the given function inside an SQLite transaction"* — [better-sqlite3 API docs](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md), fetched 2026-04-25). Two to three batch flushes therefore absorb the full workflow lifecycle without triggering write-amplification regressions under `synchronous = FULL` WAL ([SQLite — Write-Ahead Logging](https://www.sqlite.org/wal.html), fetched 2026-04-25).

**Hash-chain verification:** Per-run BLAKE3 chain recompute follows the exact algorithm specified in [Spec-006 § Integrity Protocol](../../specs/006-session-event-taxonomy-and-audit-log.md#integrity-protocol) — recompute `BLAKE3(prev_hash || canonical_bytes(row))` for each entry and compare to the stored `row_hash`, then verify `daemon_signature` against the canonical bytes. The hash function is the BLAKE3 reference specification ([BLAKE3 specification](https://github.com/BLAKE3-team/BLAKE3-specs/blob/master/blake3.pdf), fetched 2026-04-25). The dual-anchor check additionally cross-checks `session_events` (category `workflow_gate_resolution`, payload fields `gate_resolution_id` + `row_hash`) so a tampered `workflow_gate_resolutions` row is detected even if its local chain is internally consistent — the same tamper-evidence pattern Crosby & Wallach formalized ([Efficient Data Structures for Tamper-Evident Logging, USENIX Security 2009](https://static.usenix.org/event/sec09/tech/full_papers/crosby.pdf), fetched 2026-04-25). Verification is exposed as a CLI subcommand (Plan-017).

---

## Channel and Orchestration Tables (Plan-016)

```sql
-- Owner: Plan-016
CREATE TABLE channels (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  name            TEXT,
  state           TEXT NOT NULL DEFAULT 'active'
                  CHECK(state IN ('active', 'muted', 'archived')),
  config          TEXT NOT NULL DEFAULT '{}', -- JSON: turn budget, stop policy, etc.
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX idx_channels_session ON channels(session_id);

-- Owner: Plan-016
CREATE TABLE run_links (
  parent_run_id   TEXT NOT NULL,
  child_run_id    TEXT NOT NULL,
  link_type       TEXT NOT NULL DEFAULT 'spawn', -- 'spawn', 'delegate', 'handoff'
  created_at      TEXT NOT NULL,
  PRIMARY KEY (parent_run_id, child_run_id)
);

CREATE INDEX idx_run_links_child ON run_links(child_run_id);
```

---

## GDPR and Recovery Tables (Spec-022, Plan-015)

```sql
-- Owner: Spec-022 (GDPR)
CREATE TABLE participant_keys (
  participant_id    TEXT NOT NULL PRIMARY KEY,
  encrypted_key_blob BLOB NOT NULL,           -- AES-256-GCM key, encrypted at rest
  key_version       INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,
  rotated_at        TEXT
);

-- Owner: Plan-015
CREATE TABLE replay_cursors (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL UNIQUE,
  last_sequence   INTEGER NOT NULL,           -- last replayed event sequence
  state           TEXT NOT NULL DEFAULT 'current'
                  CHECK(state IN ('current', 'rebuilding', 'stale')),
  updated_at      TEXT NOT NULL
);

-- Owner: Plan-015
CREATE TABLE recovery_checkpoints (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  checkpoint_type TEXT NOT NULL,              -- e.g. 'full', 'incremental'
  as_of_sequence  INTEGER NOT NULL,
  state_blob      BLOB NOT NULL,
  created_at      TEXT NOT NULL
);

CREATE INDEX idx_recovery_checkpoints_session ON recovery_checkpoints(session_id);
```

---

## Diagnostic Bucket Tables (Plan-020)

Runtime-local bounded-retention buckets for raw diagnostic material. These tables may contain PII-bearing content, command output, tool traces, or reasoning detail, so they stay in Local SQLite only, default-deny outbound telemetry, and support both TTL expiry and participant-scoped purge per Spec-022 shred fan-out Path 3.

```sql
-- Owner: Plan-020
CREATE TABLE driver_raw_events (
  id                  TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL,
  run_id              TEXT,
  participant_id      TEXT,
  source_ref          TEXT,
  content_kind        TEXT NOT NULL DEFAULT 'driver_raw_event',
  bucket_payload      BLOB NOT NULL,
  payload_digest      BLOB NOT NULL,
  raw_capture_opt_in  INTEGER NOT NULL DEFAULT 0 CHECK(raw_capture_opt_in IN (0, 1)),
  metadata            TEXT NOT NULL DEFAULT '{}',
  created_at          TEXT NOT NULL,
  expires_at          TEXT NOT NULL,
  purged_at           TEXT
);

CREATE INDEX idx_driver_raw_events_session ON driver_raw_events(session_id, created_at);
CREATE INDEX idx_driver_raw_events_participant ON driver_raw_events(participant_id)
  WHERE participant_id IS NOT NULL AND purged_at IS NULL;
CREATE INDEX idx_driver_raw_events_expiry ON driver_raw_events(expires_at)
  WHERE purged_at IS NULL;

-- Owner: Plan-020
CREATE TABLE command_output (
  id                  TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL,
  run_id              TEXT,
  participant_id      TEXT,
  source_ref          TEXT,
  content_kind        TEXT NOT NULL DEFAULT 'command_output',
  bucket_payload      BLOB NOT NULL,
  payload_digest      BLOB NOT NULL,
  raw_capture_opt_in  INTEGER NOT NULL DEFAULT 0 CHECK(raw_capture_opt_in IN (0, 1)),
  metadata            TEXT NOT NULL DEFAULT '{}',
  created_at          TEXT NOT NULL,
  expires_at          TEXT NOT NULL,
  purged_at           TEXT
);

CREATE INDEX idx_command_output_session ON command_output(session_id, created_at);
CREATE INDEX idx_command_output_participant ON command_output(participant_id)
  WHERE participant_id IS NOT NULL AND purged_at IS NULL;
CREATE INDEX idx_command_output_expiry ON command_output(expires_at)
  WHERE purged_at IS NULL;

-- Owner: Plan-020
CREATE TABLE tool_traces (
  id                  TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL,
  run_id              TEXT,
  participant_id      TEXT,
  source_ref          TEXT,
  content_kind        TEXT NOT NULL DEFAULT 'tool_trace',
  bucket_payload      BLOB NOT NULL,
  payload_digest      BLOB NOT NULL,
  raw_capture_opt_in  INTEGER NOT NULL DEFAULT 0 CHECK(raw_capture_opt_in IN (0, 1)),
  metadata            TEXT NOT NULL DEFAULT '{}',
  created_at          TEXT NOT NULL,
  expires_at          TEXT NOT NULL,
  purged_at           TEXT
);

CREATE INDEX idx_tool_traces_session ON tool_traces(session_id, created_at);
CREATE INDEX idx_tool_traces_participant ON tool_traces(participant_id)
  WHERE participant_id IS NOT NULL AND purged_at IS NULL;
CREATE INDEX idx_tool_traces_expiry ON tool_traces(expires_at)
  WHERE purged_at IS NULL;

-- Owner: Plan-020
CREATE TABLE reasoning_detail (
  id                  TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL,
  run_id              TEXT,
  participant_id      TEXT,
  source_ref          TEXT,
  content_kind        TEXT NOT NULL DEFAULT 'reasoning_detail',
  bucket_payload      BLOB NOT NULL,
  payload_digest      BLOB NOT NULL,
  raw_capture_opt_in  INTEGER NOT NULL DEFAULT 0 CHECK(raw_capture_opt_in IN (0, 1)),
  metadata            TEXT NOT NULL DEFAULT '{}',
  created_at          TEXT NOT NULL,
  expires_at          TEXT NOT NULL,
  purged_at           TEXT
);

CREATE INDEX idx_reasoning_detail_session ON reasoning_detail(session_id, created_at);
CREATE INDEX idx_reasoning_detail_participant ON reasoning_detail(participant_id)
  WHERE participant_id IS NOT NULL AND purged_at IS NULL;
CREATE INDEX idx_reasoning_detail_expiry ON reasoning_detail(expires_at)
  WHERE purged_at IS NULL;
```

---

## Schema Version Table

```sql
CREATE TABLE schema_version (
  version         INTEGER NOT NULL PRIMARY KEY,
  applied_at      TEXT NOT NULL,
  description     TEXT
);

INSERT INTO schema_version (version, applied_at, description)
VALUES (1, datetime('now'), 'Initial schema');
```
