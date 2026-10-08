// The workflow tables of the daemon's one schema, appended to it in `session/daemon-schema.ts`.
//
// The versions and the gate answers never change once written. A definition's row is current
// state that changes in place: its settings outside the hash, and its current body on a save.
// The runs and the steps are projections the event log can rebuild, except a waiting step's
// `wait_deadline_at`. The triggers, webhook tokens, node state and secrets are
// truth that changes: no event history can say what this machine is armed to do next or which
// secrets it holds, so the row is the truth and any in-process timer is a cache over it, re-armed
// from the row at start. The form drafts and the builder drafts are durable state with no timer:
// what the person has typed but not sent is in no event, so the row holds it.

/** The SQL of every workflow table and index, run as part of the daemon schema's one script. */
export const WORKFLOW_SCHEMA_SQL: string = `
-- ---------------------------------------------------------------------------
-- workflow_definitions: one row per workflow in the one library.
-- ---------------------------------------------------------------------------
-- The layout, tags, permission level and pinned data sit outside the content
-- hash, so changing any of them mints no version.
CREATE TABLE workflow_definitions (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,                -- as the person cased it
  -- The full-Unicode case fold of name, written on every insert and rename.
  name_folded          TEXT NOT NULL,
  content_hash         TEXT NOT NULL,                -- BLAKE3 over the canonical hashed body
  -- The document's own schemaVersion, verbatim; text so a later '2.1' round-trips.
  schema_version       TEXT NOT NULL
                       CHECK(schema_version GLOB '[0-9]*'),
  definition_body      TEXT NOT NULL,                -- JSON: the canonical document body
  -- JSON: a position per node, an optional viewport and the sticky notes. NULL
  -- opens laid out deterministically, left to right.
  layout_json          TEXT,
  -- Matched ignoring case, nested with '/', no spaces.
  tags                 TEXT NOT NULL DEFAULT '[]'
                       CHECK(json_valid(tags) AND json_type(tags) = 'array'),
  -- Every run of the workflow uses this level; a live run takes a change from
  -- its next step.
  permission_level     TEXT NOT NULL DEFAULT 'yolo'
                       CHECK(permission_level IN (
                         'readonly', 'ask', 'reviewed', 'sandboxed', 'yolo'
                       )),
  -- JSON object of node id to a pinned item array; NULL when nothing is pinned.
  pin_data_json        TEXT
                       CHECK(pin_data_json IS NULL
                         OR (json_valid(pin_data_json) AND json_type(pin_data_json) = 'object')),
  created_at           TEXT NOT NULL,
  created_by           TEXT,                         -- the device the save came from
  -- The last change to this row: a save, a rename, or a write outside the hash.
  updated_at           TEXT NOT NULL,
  -- The soft delete: the workflow's runs keep their pinned versions. NULL while
  -- it is in the library.
  deleted_at           TEXT
) STRICT;

-- A name names one workflow among those not deleted, ignoring case; a deleted
-- workflow's name can be used again.
CREATE UNIQUE INDEX idx_workflow_definitions_name_folded
  ON workflow_definitions(name_folded) WHERE deleted_at IS NULL;
CREATE INDEX idx_workflow_definitions_content_hash ON workflow_definitions(content_hash);

-- ---------------------------------------------------------------------------
-- workflow_versions: each saved version, immutable once written.
-- ---------------------------------------------------------------------------
CREATE TABLE workflow_versions (
  id                   TEXT PRIMARY KEY,
  definition_id        TEXT NOT NULL REFERENCES workflow_definitions(id),
  version_number       INTEGER NOT NULL,             -- monotonic per definition
  parent_version_id    TEXT REFERENCES workflow_versions(id), -- NULL at version 1
  parent_content_hash  TEXT,                         -- NULL at version 1
  content_hash         TEXT NOT NULL,
  -- The version's own schemaVersion, verbatim; the body holds only the hashed members.
  schema_version       TEXT NOT NULL
                       CHECK(schema_version GLOB '[0-9]*'),
  -- JSON: this version's canonical hashed body, the preimage of content_hash, so a
  -- read or an export reproduces its bytes.
  definition_body      TEXT NOT NULL,
  -- JSON: this version's layout, outside the hash, so an export of any version
  -- reproduces the file it was written as.
  layout_json          TEXT,
  author_note          TEXT,
  created_at           TEXT NOT NULL,
  created_by           TEXT,                         -- the device the save came from
  -- The agent that saved it through the authoring call; NULL when the person did.
  saved_by_agent_id    TEXT,
  -- JSON object of full-tier Code node id to the package lock written when this
  -- version was saved; '{}' where the version locks none.
  code_locks_json      TEXT NOT NULL DEFAULT '{}'
                       CHECK(json_valid(code_locks_json) AND json_type(code_locks_json) = 'object'),
  UNIQUE(definition_id, version_number),
  -- One definition never stores the same bytes as two versions.
  UNIQUE(definition_id, content_hash)
) STRICT;

CREATE INDEX idx_workflow_versions_definition
  ON workflow_versions(definition_id, version_number DESC);
CREATE INDEX idx_workflow_versions_parent ON workflow_versions(parent_version_id)
  WHERE parent_version_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- workflow_runs: one row per run, kept until the person deletes it or its
-- session.
-- ---------------------------------------------------------------------------
-- A chain is the runs that runs start. Every row names its chain's first run;
-- the first run's row counts the runs the chain has started and records the
-- answer to the chain's question.
CREATE TABLE workflow_runs (
  id                        TEXT PRIMARY KEY,
  workflow_version_id       TEXT NOT NULL REFERENCES workflow_versions(id),
  -- The asking chat's session, or the workflow's own for a run no chat asked for.
  session_id                TEXT NOT NULL,
  status                    TEXT NOT NULL DEFAULT 'new'
                            CHECK(status IN (
                              'new', 'running', 'waiting', 'succeeded', 'failed', 'canceled',
                              'crashed'
                            )),
  mode                      TEXT NOT NULL
                            CHECK(mode IN (
                              'manual', 'trigger', 'webhook', 'chat', 'agent', 'retry',
                              'sub-workflow'
                            )),
  -- JSON: which trigger node started the run and with what.
  trigger_json              TEXT NOT NULL DEFAULT '{}'
                            CHECK(json_valid(trigger_json)),
  -- JSON: who or what started the run.
  started_by                TEXT NOT NULL
                            CHECK(json_valid(started_by)),
  started_at                TEXT,                    -- NULL while the run is new
  finished_at               TEXT,
  -- JSON: the run's typed error; NULL unless it failed, was canceled or crashed.
  error_json                TEXT
                            CHECK(error_json IS NULL OR json_valid(error_json)),
  chain_root_run_id         TEXT NOT NULL,           -- the run's own id on a first run
  chain_from_error          INTEGER NOT NULL DEFAULT 0 -- 1 when an error trigger joined
                            CHECK(chain_from_error IN (0, 1)),
  -- First run only: the runs the chain has started, this one included,
  -- incremented in the transaction that creates each run.
  chain_run_count           INTEGER,
  -- First run only: 1 once the person answered Keep going.
  chain_kept_going          INTEGER
                            CHECK(chain_kept_going IS NULL OR chain_kept_going IN (0, 1)),
  -- The run's Keep mark: deleting old runs leaves a kept run.
  kept                      INTEGER NOT NULL DEFAULT 0
                            CHECK(kept IN (0, 1)),
  created_at                TEXT NOT NULL,
  CHECK((chain_root_run_id = id) = (chain_run_count IS NOT NULL)),
  CHECK((chain_run_count IS NULL) = (chain_kept_going IS NULL))
) STRICT;

CREATE INDEX idx_workflow_runs_session ON workflow_runs(session_id);
CREATE INDEX idx_workflow_runs_status ON workflow_runs(status)
  WHERE status IN ('new', 'running', 'waiting');
-- Stop them all cancels every run of the chain still going.
CREATE INDEX idx_workflow_runs_chain ON workflow_runs(chain_root_run_id);
CREATE INDEX idx_workflow_runs_version ON workflow_runs(workflow_version_id);
-- The runs list pages newest first by creation, ties broken by id.
CREATE INDEX idx_workflow_runs_created ON workflow_runs(created_at, id);

-- ---------------------------------------------------------------------------
-- workflow_gate_resolutions: every answer to an approval node or a chain's
-- question, append-only.
-- ---------------------------------------------------------------------------
-- Rows are never updated; they are removed only with their run. Each row's id is
-- the gateResolutionId the session's workflow.gate_resolved event carries.
CREATE TABLE workflow_gate_resolutions (
  id                         TEXT PRIMARY KEY,
  workflow_run_id            TEXT NOT NULL REFERENCES workflow_runs(id),
  sequence                   INTEGER NOT NULL,       -- per run, from 1
  -- The approval node answered; NULL for a chain's question, which belongs to
  -- the run.
  node_id                    TEXT,
  gate_kind                  TEXT NOT NULL
                             CHECK(gate_kind IN ('human.approval', 'chain')),
  -- Mirrors approval_requests.category where one applies.
  approval_category          TEXT
                             CHECK(approval_category IS NULL OR approval_category IN (
                               'tool_execution', 'file_write', 'network_access',
                               'destructive_git', 'plan_approval', 'gate'
                             )),
  approval_request_id        TEXT NOT NULL REFERENCES approval_requests(id),
  outcome                    TEXT NOT NULL
                             CHECK(outcome IN ('approved', 'rejected')),
  device_id                  TEXT NOT NULL,          -- the answering device
  resolved_at                TEXT NOT NULL,
  -- JSON: scope, resource, reason text.
  decision_context           TEXT NOT NULL DEFAULT '{}',
  UNIQUE(workflow_run_id, sequence),
  CHECK((gate_kind = 'human.approval') = (node_id IS NOT NULL))
) STRICT;

CREATE INDEX idx_gate_resolutions_node ON workflow_gate_resolutions(workflow_run_id, node_id)
  WHERE node_id IS NOT NULL;
CREATE INDEX idx_gate_resolutions_approval ON workflow_gate_resolutions(approval_request_id);

-- ---------------------------------------------------------------------------
-- human_phase_form_state: a form step's draft, held by the daemon so a
-- half-filled form is restored from here and never from window storage.
-- ---------------------------------------------------------------------------
CREATE TABLE human_phase_form_state (
  id                      TEXT PRIMARY KEY,
  workflow_run_id         TEXT NOT NULL REFERENCES workflow_runs(id),
  node_id                 TEXT NOT NULL,           -- the form node in the run's pinned version
  draft_json              TEXT NOT NULL DEFAULT '{}', -- JSON: the field values so far
  -- Bumped by each autosave; the optimistic-concurrency token.
  draft_version           INTEGER NOT NULL DEFAULT 1,
  submitted               INTEGER NOT NULL DEFAULT 0
                          CHECK(submitted IN (0, 1)),
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  UNIQUE(workflow_run_id, node_id)
) STRICT;

CREATE INDEX idx_human_phase_form_state_step ON human_phase_form_state(workflow_run_id, node_id)
  WHERE submitted = 0;

-- ---------------------------------------------------------------------------
-- workflow_steps: one row per step attempt, a projection over the events the
-- run, approval and form pipelines emit.
-- ---------------------------------------------------------------------------
-- Every column but wait_deadline_at can be rebuilt from the log. That one is
-- written when the step starts waiting, and the deadline timer is a cache over
-- it, re-armed from the row when the daemon starts.
CREATE TABLE workflow_steps (
  workflow_run_id   TEXT NOT NULL REFERENCES workflow_runs(id),
  node_id           TEXT NOT NULL,                 -- the node in the pinned version
  attempt           INTEGER NOT NULL,              -- from 1; a retry of the node at one point
  -- Per run, a total order: what happened when, whatever the graph's shape.
  execution_index   INTEGER NOT NULL,
  -- JSON array, one entry per input slot: the edge that fed it and which run of
  -- the source produced it, or null where nothing fed it.
  source_json       TEXT NOT NULL DEFAULT '[]'
                    CHECK(json_valid(source_json) AND json_type(source_json) = 'array'),
  -- 'waiting-memory' is held by the memory gate before it starts; 'canceled' was
  -- running or waiting when its run ended failed or canceled.
  status            TEXT NOT NULL
                    CHECK(status IN (
                      'pending', 'running', 'waiting', 'waiting-memory', 'succeeded', 'failed',
                      'skipped', 'canceled'
                    )),
  -- What a waiting step waits on: a person, its chain's question or a spent
  -- provider account.
  wait_cause        TEXT
                    CHECK(wait_cause IS NULL
                      OR wait_cause IN ('approval', 'form', 'reply', 'chain', 'account')),
  -- When a step parked on a spent account resumes itself; NULL where nothing is
  -- armed, which reads as awaiting resume.
  resume_at         TEXT,
  -- The spent account an 'account' wait groups under, so every run waiting on
  -- one account is one attention entry.
  wait_account_id   TEXT,
  -- When a step waiting on a person gives up; set only where its Timeout is.
  wait_deadline_at  TEXT,
  -- When the step started waiting; set exactly while it waits. The attention list's
  -- waiting-since and its oldest-first order read it.
  wait_started_at   TEXT,
  started_at        TEXT NOT NULL,
  finished_at       TEXT,                          -- NULL until the step settles
  -- JSON payload refs: inline items under the 64 KiB bound, an artifact
  -- reference above it, so a run read stays bounded.
  input_ref         TEXT NOT NULL
                    CHECK(json_valid(input_ref)),
  output_ref        TEXT NOT NULL
                    CHECK(json_valid(output_ref)),
  log_ref           TEXT NOT NULL
                    CHECK(json_valid(log_ref)),
  cost_usd_micros   INTEGER,                       -- NULL when never billed
  -- The account that paid. No foreign key: removing an account must neither
  -- rewrite nor block the step's cost record.
  cost_account_id   TEXT,
  -- JSON: the typed step error; NULL on every status but failed.
  error_json        TEXT
                    CHECK(error_json IS NULL OR json_valid(error_json)),
  -- JSON array of non-fatal hints; NULL where the step attached none.
  advisories_json   TEXT
                    CHECK(advisories_json IS NULL
                      OR (json_valid(advisories_json) AND json_type(advisories_json) = 'array')),
  -- The whole step key; it also serves a lookup by run and node.
  PRIMARY KEY (workflow_run_id, node_id, attempt, execution_index),
  UNIQUE(workflow_run_id, execution_index),
  -- A cost always names the account that paid it.
  CHECK((cost_usd_micros IS NULL) = (cost_account_id IS NULL)),
  CHECK((status = 'waiting') = (wait_cause IS NOT NULL)),
  -- The live wait state clears in the same statement that moves the step out of
  -- 'waiting'.
  CHECK((status = 'waiting') = (wait_started_at IS NOT NULL)),
  CHECK(status = 'waiting'
    OR (resume_at IS NULL AND wait_account_id IS NULL AND wait_deadline_at IS NULL)),
  CHECK(wait_cause = 'account' OR (resume_at IS NULL AND wait_account_id IS NULL)),
  CHECK(wait_deadline_at IS NULL OR wait_cause IN ('approval', 'form', 'reply'))
) STRICT;

CREATE INDEX idx_workflow_steps_resume ON workflow_steps(resume_at)
  WHERE resume_at IS NOT NULL;
CREATE INDEX idx_workflow_steps_wait_deadline ON workflow_steps(wait_deadline_at)
  WHERE wait_deadline_at IS NOT NULL;
CREATE INDEX idx_workflow_steps_wait_account ON workflow_steps(wait_account_id)
  WHERE wait_account_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- workflow_triggers: one row per armed trigger.
-- ---------------------------------------------------------------------------
CREATE TABLE workflow_triggers (
  definition_id     TEXT NOT NULL REFERENCES workflow_definitions(id),
  node_id           TEXT NOT NULL,                 -- the trigger node
  -- The trigger node's kind. No CHECK: the node catalog owns the list.
  kind              TEXT NOT NULL,
  -- Over the trigger's own params, so a save that did not touch it re-arms nothing.
  config_hash       TEXT NOT NULL,
  -- NULL where the kind has no schedule, or while disarmed.
  next_fire_at      TEXT,
  last_fire_at      TEXT,                          -- NULL until it first fires
  -- A workflow is enabled as a whole: enabling arms every trigger it declares.
  enabled           INTEGER NOT NULL DEFAULT 0
                    CHECK(enabled IN (0, 1)),
  PRIMARY KEY (definition_id, node_id)
) STRICT;

-- The arming sweep's only scan.
CREATE INDEX idx_workflow_triggers_due ON workflow_triggers(next_fire_at)
  WHERE enabled = 1 AND next_fire_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- workflow_webhook_tokens: one row per workflow with a webhook trigger.
-- ---------------------------------------------------------------------------
-- Only the hash is stored, so a stolen database yields no working token.
CREATE TABLE workflow_webhook_tokens (
  definition_id     TEXT PRIMARY KEY REFERENCES workflow_definitions(id),
  token_hash        TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  last_used_at      TEXT                           -- NULL until the address is first called
) STRICT;

-- ---------------------------------------------------------------------------
-- workflow_node_state: the key-value store per workflow and node.
-- ---------------------------------------------------------------------------
-- Trigger cursors live here and never on the document, so a fire changes no
-- content hash. It also holds the values a Keep for later runs step keeps, which
-- belong to the workflow rather than to a version.
CREATE TABLE workflow_node_state (
  definition_id     TEXT NOT NULL REFERENCES workflow_definitions(id),
  -- '' for a kept value, which belongs to the workflow rather than to one node.
  node_id           TEXT NOT NULL,
  key               TEXT NOT NULL,                 -- a cursor's key, or a kept value's name
  value_json        TEXT NOT NULL
                    CHECK(json_valid(value_json)),
  kept_by_run_id    TEXT,                          -- NULL for trigger cursor state
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (definition_id, node_id, key),
  CHECK(kept_by_run_id IS NULL OR node_id = '')
) STRICT;

-- ---------------------------------------------------------------------------
-- workflow_secrets: one row per workflow secret, never its value.
-- ---------------------------------------------------------------------------
-- The value lives in the operating system's credential store, or in the daemon's
-- secrets.json items file where that store cannot be used. A step parameter
-- stores only secret://<scope>/<name>, resolved when the step runs.
CREATE TABLE workflow_secrets (
  id                TEXT PRIMARY KEY,
  scope             TEXT NOT NULL
                    CHECK(scope IN ('project', 'shared')),
  scope_ref         TEXT NOT NULL,                 -- the project's id; '' at 'shared'
  -- Lowercase letters, digits and hyphens, starting with a letter or digit, at
  -- most 64 characters.
  name              TEXT NOT NULL
                    CHECK(length(name) BETWEEN 1 AND 64 AND name GLOB '[a-z0-9]*'
                      AND name NOT GLOB '*[^a-z0-9-]*'),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,                 -- the last value replacement
  -- NULL until a delete starts: the delete records its intent here, removes the
  -- stored value, then the row.
  removal_requested_at TEXT,
  CHECK((scope = 'shared') = (scope_ref = '')),
  UNIQUE(scope, scope_ref, name)
) STRICT;

-- ---------------------------------------------------------------------------
-- workflow_drafts: the builder's unsaved draft, so it survives a reload.
-- ---------------------------------------------------------------------------
-- One per saved workflow and one for a new workflow, keyed ''. No foreign key,
-- because '' names no definition.
CREATE TABLE workflow_drafts (
  definition_id            TEXT PRIMARY KEY,
  based_on_version_number  INTEGER,                -- NULL for a new workflow
  document_json            TEXT NOT NULL
                           CHECK(json_valid(document_json)),
  updated_at               TEXT NOT NULL,
  CHECK(definition_id <> '' OR based_on_version_number IS NULL)
) STRICT;
`;
