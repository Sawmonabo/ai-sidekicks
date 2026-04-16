# Local SQLite Schema

Canonical schema for the local daemon's SQLite database. Each runtime node maintains its own instance.

**Storage boundary:** Machine-scoped execution truth and recovery data. See [Data Architecture](../data-architecture.md).

## Pragmas

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

---

## Session Events (Plan-001, extended by Plans 006, 015)

```sql
-- Owner: Plan-001 | Extended by: Plan-006 (event taxonomy), Plan-015 (replay cursors)
CREATE TABLE session_events (
  id              TEXT PRIMARY KEY,           -- ULID or UUID
  session_id      TEXT NOT NULL,
  sequence        INTEGER NOT NULL,           -- monotonic per session
  occurred_at     TEXT NOT NULL,              -- ISO 8601 timestamp
  category        TEXT NOT NULL,              -- e.g. 'run_lifecycle', 'assistant_output', 'tool_activity'
  type            TEXT NOT NULL,              -- specific event type within category
  actor           TEXT,                       -- participant_id or agent_id or NULL for system
  payload         TEXT NOT NULL DEFAULT '{}', -- JSON event payload
  pii_payload     BLOB,                       -- encrypted per-participant AES-256-GCM (GDPR)
  correlation_id  TEXT,                       -- links related events
  causation_id    TEXT,                       -- parent event that caused this one
  version         INTEGER NOT NULL DEFAULT 1, -- schema version for payload evolution
  UNIQUE(session_id, sequence)
);

CREATE INDEX idx_session_events_session_seq ON session_events(session_id, sequence);
CREATE INDEX idx_session_events_type ON session_events(session_id, type);
CREATE INDEX idx_session_events_correlation ON session_events(correlation_id) WHERE correlation_id IS NOT NULL;
```

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

-- Owner: Plan-004 | Extended by: Plan-015 (recovery)
CREATE TABLE command_receipts (
  id              TEXT PRIMARY KEY,
  command_id      TEXT NOT NULL UNIQUE,       -- idempotency key
  run_id          TEXT,
  status          TEXT NOT NULL
                  CHECK(status IN ('accepted', 'rejected', 'completed', 'failed')),
  created_at      TEXT NOT NULL
);

CREATE INDEX idx_command_receipts_run ON command_receipts(run_id) WHERE run_id IS NOT NULL;
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

## Workflow Tables (Plan-017)

```sql
-- Owner: Plan-017
CREATE TABLE workflow_definitions (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  name            TEXT NOT NULL,
  scope           TEXT NOT NULL DEFAULT 'session', -- 'session' or 'channel'
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX idx_workflow_definitions_session ON workflow_definitions(session_id);

-- Owner: Plan-017
CREATE TABLE workflow_versions (
  id                TEXT PRIMARY KEY,
  definition_id     TEXT NOT NULL REFERENCES workflow_definitions(id),
  version_number    INTEGER NOT NULL,
  phase_definitions TEXT NOT NULL DEFAULT '[]', -- JSON array of phase configs
  created_at        TEXT NOT NULL,
  UNIQUE(definition_id, version_number)
);

-- Owner: Plan-017
CREATE TABLE workflow_runs (
  id                    TEXT PRIMARY KEY,
  workflow_version_id   TEXT NOT NULL REFERENCES workflow_versions(id),
  session_id            TEXT NOT NULL,
  state                 TEXT NOT NULL DEFAULT 'pending'
                        CHECK(state IN ('pending', 'running', 'completed', 'failed', 'canceled')),
  started_at            TEXT,
  completed_at          TEXT
);

CREATE INDEX idx_workflow_runs_session ON workflow_runs(session_id);

-- Owner: Plan-017
CREATE TABLE workflow_phase_states (
  id                TEXT PRIMARY KEY,
  workflow_run_id   TEXT NOT NULL REFERENCES workflow_runs(id),
  phase_id          TEXT NOT NULL,            -- references phase_definitions JSON key
  state             TEXT NOT NULL DEFAULT 'pending'
                    CHECK(state IN ('pending', 'running', 'completed', 'failed', 'skipped')),
  gate_state        TEXT DEFAULT 'closed'
                    CHECK(gate_state IN ('closed', 'open', 'bypassed')),
  started_at        TEXT,
  completed_at      TEXT,
  UNIQUE(workflow_run_id, phase_id)
);
```

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
