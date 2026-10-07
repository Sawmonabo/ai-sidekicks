# Workflow Tables (Plan-014)

The workflow tables of the daemon's one SQLite schema. The [Local SQLite Schema](local-sqlite-schema.md) holds its pragmas, its conventions and every other area.

Full workflow-engine schema. Its tables hold the definitions and their version chain, the runs, the append-only gate history (C-13/I5), a form step's draft, the per-step record, the armed triggers, the webhook tokens, the per-node key-value store, the workflow secrets' records and the builder's unsaved drafts ([Spec-015 §Interfaces And Contracts](../../specs/015-workflow-authoring-and-execution.md#interfaces-and-contracts)). `session_events` remains canonical truth; tables 3, 5 and 6 are rebuildable projections, 1, 2 and 4 are immutable truth, and 7 to 11 are MUTABLE truth: what this machine is armed to do next, which secrets it holds and what the person has drafted but not saved are facts no event history can reconstruct, so the durable row is the truth and the in-process timer is only a cache over it, re-armed from the row after a restart ([Spec-015 §Truth vs projection vs ephemeral (SA-24)](../../specs/015-workflow-authoring-and-execution.md#truth-vs-projection-vs-ephemeral-sa-24)). One column on the projection tier is truth as well: a waiting step's `wait_deadline_at` is written when the step starts waiting, and the deadline timer is a cache over it.

The normalized-table-over-blob shape and the rebuildable-projection split align with industry persistence precedents: durable-execution engines persist normalized state per run rather than monolithic blobs ([Restate — What is Durable Execution](https://restate.dev/what-is-durable-execution)); and large-engine persistence tiers separate hot live state from cold archive ([Argo Workflows — Workflow Archive](https://argo-workflows.readthedocs.io/en/latest/workflow-archive/)). [Spec-015 §References](../../specs/015-workflow-authoring-and-execution.md#references) enumerates the full primary-source corpus.

**Canvas geometry is stored, and it is not definition bytes.** A document's own `layout` section — a position per node, an optional viewport and the sticky notes — sits **outside** the hashed body and outside the BLAKE3 preimage, and is persisted in a `layout_json` column beside the body on `workflow_definitions` and on `workflow_versions` ([Workflow Graph Model §Canvas layout is not definition bytes (SA-32)](../../domain/workflow-graph-model.md#canvas-layout-is-not-definition-bytes-sa-32)). It is part of the document rather than a client's private note, so it travels with the document — the file form carries it as an optional section, and a document that arrives with none is laid out deterministically, left to right, by the same layout library in the daemon and in the renderer, so a definition is never unopenable and opens the same way twice. Because no byte the engine reads changes with it, a drag mints no version and enters no rebuild; it is not a storage tier of its own. Park-and-resume is the `waiting` status on tables 3 and 6, with a waiting step's cause, its armed resume instant, the spent account an `account` wait groups under and its deadline on the step's row; its always-on engine event record lands on the Plan-017-owned bounded-retention diagnostic tier ([Spec-015 §Engine event record (SA-40)](../../specs/015-workflow-authoring-and-execution.md#engine-event-record-sa-40)), whose buckets are log files in the daemon's data folder, never tables of this schema (Plan-014 CP-014-9).

```sql
-- ========================================================================
-- 1. workflow_definitions — one row per workflow: its current document and its settings outside the hash
-- ========================================================================
-- Owner: Plan-014
-- Commitments: C-1 (one document plus a typed TypeScript SDK), C-8 (schema version marker)
CREATE TABLE workflow_definitions (
  id                   TEXT PRIMARY KEY,               -- UUID v7; NOT the content hash
  name                 TEXT NOT NULL,                  -- author-facing name, in the person's own casing
  name_folded          TEXT NOT NULL,                  -- the full-Unicode case fold of name, written by the store on every insert and rename
  content_hash         TEXT NOT NULL,                  -- BLAKE3 over JCS-canonicalized definition body
  schema_version       TEXT NOT NULL                   -- the document's own schemaVersion, verbatim; V1 value '2' (Spec-015 §Required Behavior). A string rather than a number so a later '2.1' round-trips
                       CHECK(schema_version GLOB '[0-9]*'),
  definition_body      TEXT NOT NULL,                  -- JSON (canonicalized per RFC 8785); full author-supplied definition
  layout_json          TEXT,                           -- JSON: the document's own layout section — a position per node, an optional viewport, the sticky notes. OUTSIDE the content_hash preimage, so editing it mints no version; NULL = written with no layout, which opens laid out deterministically left to right
  -- The workflow's tags: matched ignoring case, nested with '/', no spaces. Set from the builder
  -- header or by an agent through the workflow authoring call; OUTSIDE the content_hash preimage, so
  -- a change mints no version. The Workflows tab's row and its tag filter read them.
  tags                 TEXT NOT NULL DEFAULT '[]'
                       CHECK(json_valid(tags) AND json_type(tags) = 'array'),
  -- The workflow's own permission level, set from the builder's level pill and starting at 'yolo':
  -- every run of the workflow uses it wherever the run lives, and a live run takes a change from its
  -- next step. OUTSIDE the content_hash preimage, so a change mints no version.
  permission_level     TEXT NOT NULL DEFAULT 'yolo'
                       CHECK(permission_level IN ('readonly','ask','reviewed','sandboxed','yolo')),
  -- The node's pinned test data: an item array per node id. OUTSIDE the content_hash preimage and on
  -- the definition only, so a pin mints no version; NULL = nothing pinned.
  pin_data_json        TEXT
                       CHECK(pin_data_json IS NULL OR (json_valid(pin_data_json) AND json_type(pin_data_json) = 'object')),
  created_at           TEXT NOT NULL,
  created_by           TEXT,                           -- the device the save came from
  updated_at           TEXT NOT NULL,                  -- the last change to the row: a save, a rename, a layout, tags, level or pin write, or the soft delete; the Workflows tab's row reads it
  deleted_at           TEXT                            -- the soft delete: set when the person deletes the workflow, whose runs keep their pinned versions; NULL while it is in the library
) STRICT;

-- One library, so a name names one workflow: unique among the workflows not deleted ignoring case,
-- on the stored fold key, the same rule agent definition names follow, and a deleted workflow's name
-- can be used again. A save, an import or a create whose name another workflow holds in any letter
-- case is refused with workflow.definition_refused (finding name_taken).
CREATE UNIQUE INDEX idx_workflow_definitions_name_folded ON workflow_definitions(name_folded) WHERE deleted_at IS NULL;
CREATE INDEX idx_workflow_definitions_content_hash ON workflow_definitions(content_hash);

-- A saved document never changes in place: a save writes a new immutable row in workflow_versions and
-- moves this row's current body, hash and name to it. The columns outside the hash change here alone.

-- ========================================================================
-- 2. workflow_versions — definition history chain (F13 additive versioning)
-- ========================================================================
-- Owner: Plan-014
-- Commitments: F13 / C-8 version-API-at-V1; see Spec-015 §Required Behavior
CREATE TABLE workflow_versions (
  id                   TEXT PRIMARY KEY,               -- UUID v7
  definition_id        TEXT NOT NULL REFERENCES workflow_definitions(id),
  version_number       INTEGER NOT NULL,               -- monotonic per definition_id
  parent_version_id    TEXT REFERENCES workflow_versions(id), -- NULL at version_number=1
  parent_content_hash  TEXT,                           -- BLAKE3 of parent definition body; NULL at version 1
  content_hash         TEXT NOT NULL,                  -- BLAKE3 of THIS version's body
  definition_body      TEXT NOT NULL,                  -- JSON (canonicalized per RFC 8785); THIS version's full definition document — name, the trigger node, the nodes and the edges (Workflow Graph Model §Graph model — nodes, ports, and edges (SA-29)) — the BLAKE3 preimage of content_hash, so a version read serves the whole document parsed from this body and read -> export reproduces the canonical bytes verbatim (storing the nodes alone would leave a later version's name and trigger unreconstructable against content_hash; not a duplicate of workflow_definitions.definition_body above — that row carries the definition's current author-supplied body, each version row snapshots its own immutable bytes)
  layout_json          TEXT,                           -- JSON: this version's layout section, snapshotted beside its immutable body and outside content_hash's preimage, so an export of any version reproduces the file form it was written as
  author_note          TEXT,                           -- opt-in changelog message
  created_at           TEXT NOT NULL,
  created_by           TEXT,                           -- the device the save came from
  saved_by_agent_id    TEXT,                           -- the agent that saved this version through the authoring call; NULL where the person saved it in the builder, so the Versions panel names the user or that agent
  code_locks_json      TEXT NOT NULL DEFAULT '{}'          -- JSON object: each full-tier Code node's package lock (with the package list the lock was made from), keyed by node id, written when this version is saved and carried forward for a node whose code did not change; '{}' where the version locks none. The step's code itself is a param inside definition_body
                       CHECK(json_valid(code_locks_json) AND json_type(code_locks_json) = 'object'),
  UNIQUE(definition_id, version_number),
  UNIQUE(definition_id, content_hash)                  -- per-definition: one definition never stores the same bytes as two versions
) STRICT;

CREATE INDEX idx_workflow_versions_definition ON workflow_versions(definition_id, version_number DESC);
CREATE INDEX idx_workflow_versions_parent ON workflow_versions(parent_version_id)
  WHERE parent_version_id IS NOT NULL;

-- ========================================================================
-- 3. workflow_runs — one row per run: status, timings, trigger, chain
-- ========================================================================
-- Owner: Plan-014
-- A run's row and its step data on workflow_steps are kept until the person deletes the run or its
-- session; nothing drops them on a timer. A run's time cap is the
-- one `Stop a run after` setting on Settings › Runtime, off by default, and time spent waiting on a person
-- does not count against it; no run carries a cap, a step budget or a pool reservation of its own.
CREATE TABLE workflow_runs (
  id                        TEXT PRIMARY KEY,          -- the workflow run id, an event-sourced UUID; run_execution_contexts keys the captured context of a run that works in a repository by it
  workflow_version_id       TEXT NOT NULL REFERENCES workflow_versions(id),
  session_id                TEXT NOT NULL,             -- the asking chat's session, or the workflow's own session for a run no chat asked for
  status                    TEXT NOT NULL DEFAULT 'new'
                            CHECK(status IN (
                              'new','running','waiting','succeeded','failed','canceled','crashed'
                            )),
  mode                      TEXT NOT NULL
                            CHECK(mode IN ('manual','trigger','webhook','chat','agent','retry','sub-workflow')),
  trigger_json              TEXT NOT NULL DEFAULT '{}', -- JSON: the trigger record — which trigger node started the run and with what
  started_by                TEXT NOT NULL,             -- who or what started it: the user, a schedule, chat, an agent, a webhook, a file event or a parent workflow
  started_at                TEXT,                      -- RFC 3339 UTC; NULL while the run is new
  finished_at               TEXT,
  -- Result
  error_json                TEXT                        -- JSON: the run's typed error, the contracts' WorkflowStepError; NULL unless status in ('failed','canceled','crashed')
                            CHECK(error_json IS NULL OR json_valid(error_json)),
  -- Chains: a run that starts runs. Every row names its chain's first run; the first run's own row
  -- counts the runs the chain has started and records the person's answer to the chain's question,
  -- which is itself a row in workflow_gate_resolutions, so a chain needs no table of its own.
  chain_root_run_id         TEXT NOT NULL,             -- the chain's first run; the run's own id for a first run
  chain_from_error          INTEGER NOT NULL DEFAULT 0 -- 1 when an error trigger joined the chain
                            CHECK(chain_from_error IN (0,1)),
  chain_run_count           INTEGER,                   -- first run only: runs the chain has started, the first included, incremented in the transaction that creates each run
  chain_kept_going          INTEGER                    -- first run only: 1 once the person answered `Keep going`
                            CHECK(chain_kept_going IS NULL OR chain_kept_going IN (0,1)),
  kept                      INTEGER NOT NULL DEFAULT 0 -- the run's Keep mark: deleting old runs (workflow.runsDelete) leaves a kept run
                            CHECK(kept IN (0,1)),
  created_at                TEXT NOT NULL,
  CHECK((chain_root_run_id = id) = (chain_run_count IS NOT NULL)),
  CHECK((chain_run_count IS NULL) = (chain_kept_going IS NULL))
) STRICT;

CREATE INDEX idx_workflow_runs_session ON workflow_runs(session_id);
CREATE INDEX idx_workflow_runs_status ON workflow_runs(status)
  WHERE status IN ('new','running','waiting');
CREATE INDEX idx_workflow_runs_chain ON workflow_runs(chain_root_run_id);  -- `Stop them all` cancels every run of the chain still going
CREATE INDEX idx_workflow_runs_version ON workflow_runs(workflow_version_id);
CREATE INDEX idx_workflow_runs_created ON workflow_runs(created_at, id);  -- the runs list pages newest first by creation, ties broken by id

-- ========================================================================
-- 4. workflow_gate_resolutions — append-only per C-13 / I5
-- ========================================================================
-- Owner: Plan-014
-- Commitment: C-13 append-only approval history; the invariant
-- is I5 in Spec-015 §Pitfalls To Avoid.
CREATE TABLE workflow_gate_resolutions (
  id                         TEXT PRIMARY KEY,          -- UUID v7
  workflow_run_id            TEXT NOT NULL REFERENCES workflow_runs(id),
  sequence                   INTEGER NOT NULL,          -- per-run monotonic starting at 1
  node_id                    TEXT,                      -- the human.approval node answered; NULL for a chain's question, which belongs to the run
  -- Gate identity
  gate_kind                  TEXT NOT NULL
                             CHECK(gate_kind IN (
                               'human.approval','chain'
                             )),
  approval_category          TEXT                       -- mirrors Plan-009 approval_requests.category when applicable
                             CHECK(approval_category IS NULL OR approval_category IN (
                               'tool_execution','file_write','network_access','destructive_git',
                               'plan_approval','gate'
                             )),
  approval_request_id        TEXT NOT NULL REFERENCES approval_requests(id), -- the Plan-009 approval request this gate answered
  -- Resolution
  outcome                    TEXT NOT NULL
                             CHECK(outcome IN ('approved','rejected')),
  device_id                  TEXT NOT NULL,             -- the answering device, as on approval_resolutions
  resolved_at                TEXT NOT NULL,
  decision_context           TEXT NOT NULL DEFAULT '{}', -- JSON: scope, resource, reason text, etc.
  UNIQUE(workflow_run_id, sequence),
  CHECK((gate_kind = 'human.approval') = (node_id IS NOT NULL))
) STRICT;

CREATE INDEX idx_gate_resolutions_node ON workflow_gate_resolutions(workflow_run_id, node_id)
  WHERE node_id IS NOT NULL;
CREATE INDEX idx_gate_resolutions_approval ON workflow_gate_resolutions(approval_request_id);

-- No UPDATE or DELETE triggers — append-only enforced at application layer (writer worker only inserts).
-- Each row's id is the gateResolutionId that the session's workflow.gate_resolved event carries.

-- ========================================================================
-- 5. human_phase_form_state — daemon-held draft of a form step
-- ========================================================================
-- Owner: Plan-014
-- Carries a form step's drafts (Spec-015 §Human form drafts (SA-26)), keyed by run and node.
-- Written through `workflow.humanFormDraftSave`; each autosave bumps the row's own
-- draft version. A client never keeps a form draft in window storage.
CREATE TABLE human_phase_form_state (
  id                      TEXT PRIMARY KEY,           -- UUID v7
  workflow_run_id         TEXT NOT NULL REFERENCES workflow_runs(id),
  node_id                 TEXT NOT NULL,              -- the form node in the run's pinned definition
  draft_json              TEXT NOT NULL DEFAULT '{}', -- JSON: current form field values
  draft_version           INTEGER NOT NULL DEFAULT 1, -- bumps on each autosave tick; optimistic-concurrency token
  submitted               INTEGER NOT NULL DEFAULT 0  -- boolean; 1 terminal
                          CHECK(submitted IN (0,1)),
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  UNIQUE(workflow_run_id, node_id)                    -- one draft row per (run, form node)
) STRICT;

CREATE INDEX idx_human_phase_form_state_step ON human_phase_form_state(workflow_run_id, node_id)
  WHERE submitted = 0;

-- ========================================================================
-- 6. workflow_steps — one row per step attempt (projection over the events
--     the run, approval and form pipelines already emit)
-- ========================================================================
-- Owner: Plan-014
-- A projection, not a second account of the run: every field below except wait_deadline_at is derivable
-- from the log, which is what keeps one step's history a function of the events rather than a parallel
-- record. wait_deadline_at is truth: it is written when the step starts waiting, and the deadline timer
-- is a cache over it, re-armed from the row when the daemon starts.
CREATE TABLE workflow_steps (
  workflow_run_id   TEXT NOT NULL REFERENCES workflow_runs(id),
  node_id           TEXT NOT NULL,                 -- the node in the pinned definition this attempt ran
  attempt           INTEGER NOT NULL,              -- 1-based; a retry of the same node at the same point
  execution_index   INTEGER NOT NULL,              -- per-run monotonic: the faithful what-happened-when order for a branching run, independent of graph shape
  source_json       TEXT NOT NULL DEFAULT '[]'     -- JSON array, one entry per input slot: the edge that ACTUALLY fed it and which run of the source produced it (null for a slot nothing fed), so a run page can say this merge consumed the third run of a loop
                    CHECK(json_valid(source_json) AND json_type(source_json) = 'array'),
  status            TEXT NOT NULL
                    CHECK(status IN ('pending', 'running', 'waiting', 'waiting-memory', 'succeeded', 'failed', 'skipped', 'canceled')),
                                                 -- 'waiting-memory' = held by the memory gate before it starts; 'canceled' = running or waiting when its run ended failed or canceled
  wait_cause        TEXT                         -- what a waiting step waits on: a person ('approval', 'form', 'reply'), its chain's question ('chain'), or a spent provider account ('account')
                    CHECK(wait_cause IS NULL OR wait_cause IN ('approval', 'form', 'reply', 'chain', 'account')),
  resume_at         TEXT,                        -- the instant a step parked on a spent account resumes itself, where one is armed; NULL where none is, which reads as awaiting resume
  wait_account_id   TEXT,                        -- a step waiting on 'account': the spent provider account, which workflow.runAttentionList groups by, so every run waiting on one account presents as one entry
  wait_deadline_at  TEXT,                        -- the instant a step waiting on a person gives up, set only where its Timeout is
  started_at        TEXT NOT NULL,
  finished_at       TEXT,                          -- NULL until the step settles
  -- The payload refs a step panel reads, each stored as the JSON WorkflowPayloadRef shape so a
  -- run read stays bounded whatever the step produced: under the 64 KiB inline bound the payload is
  -- items on this row, above it an artifact through the ordinary ingest pipeline and this row keeps the
  -- reference.
  input_ref         TEXT NOT NULL
                    CHECK(json_valid(input_ref)),
  output_ref        TEXT NOT NULL
                    CHECK(json_valid(output_ref)),
  log_ref           TEXT NOT NULL
                    CHECK(json_valid(log_ref)),
  cost_usd_micros   INTEGER,                     -- integer micro-dollars; NULL = never billed; the step still reads `$0.00` and names no account
  cost_account_id   TEXT,                          -- the provider account that paid; deliberately no foreign key, for the reason agent_definitions states
  error_json        TEXT                           -- JSON: the typed step error (message plus the node it belongs to); NULL on every non-failed status
                    CHECK(error_json IS NULL OR json_valid(error_json)),
  advisories_json   TEXT                           -- JSON array of non-fatal hints — an unwired branch that dropped items, a deprecated param, a truncated output. Never errors, and NULL where the step attached none
                    CHECK(advisories_json IS NULL OR (json_valid(advisories_json) AND json_type(advisories_json) = 'array')),
  PRIMARY KEY (workflow_run_id, node_id, attempt, execution_index),  -- the whole WorkflowStepKey the contracts address a step by; with node_id after the run id it also serves a lookup by run and node
  CHECK((cost_usd_micros IS NULL) = (cost_account_id IS NULL)),  -- a figure always names the account that paid it
  CHECK((status = 'waiting') = (wait_cause IS NOT NULL)),
  -- The live wait state clears in the same statement that moves the step out of 'waiting'.
  CHECK(status = 'waiting' OR (resume_at IS NULL AND wait_account_id IS NULL AND wait_deadline_at IS NULL)),
  CHECK(wait_cause = 'account' OR (resume_at IS NULL AND wait_account_id IS NULL)),
  CHECK(wait_deadline_at IS NULL OR wait_cause IN ('approval', 'form', 'reply'))
) STRICT;

CREATE INDEX idx_workflow_steps_resume ON workflow_steps(resume_at)
  WHERE resume_at IS NOT NULL;                   -- the resume sweep's scan
CREATE INDEX idx_workflow_steps_wait_deadline ON workflow_steps(wait_deadline_at)
  WHERE wait_deadline_at IS NOT NULL;            -- re-arming the deadline timers at start
CREATE INDEX idx_workflow_steps_wait_account ON workflow_steps(wait_account_id)
  WHERE wait_account_id IS NOT NULL;             -- one attention entry per spent account

-- ========================================================================
-- 7. workflow_triggers — one row per armed trigger (MUTABLE TRUTH)
-- ========================================================================
-- Owner: Plan-014
-- Arming is durable and the in-process timer is only a cache over these rows: on daemon start, after
-- the projection rebuild, every enabled workflow re-arms from them. No event history can reconstruct
-- what this machine is armed to do next, which is why the row is the truth.
CREATE TABLE workflow_triggers (
  definition_id     TEXT NOT NULL REFERENCES workflow_definitions(id),
  node_id           TEXT NOT NULL,                 -- the trigger node in the definition
  kind              TEXT NOT NULL,                 -- the trigger node kind, in the node catalog's own vocabulary; no CHECK list, because the catalog owns it and a copy here would go stale behind it
  config_hash       TEXT NOT NULL,                 -- over the trigger's own params: a re-arm compares it, so an unchanged trigger is not disarmed and re-armed for a save that did not touch it
  next_fire_at      TEXT,                          -- NULL where the kind has no schedule (a webhook, a chat start) or while disarmed
  last_fire_at      TEXT,                          -- NULL until it has fired once
  enabled           INTEGER NOT NULL DEFAULT 0
                    CHECK(enabled IN (0, 1)),      -- a workflow is enabled or not as a whole: enabling arms every trigger it declares, disabling disarms all of them
  PRIMARY KEY (definition_id, node_id)
) STRICT;

CREATE INDEX idx_workflow_triggers_due ON workflow_triggers(next_fire_at)
  WHERE enabled = 1 AND next_fire_at IS NOT NULL;  -- the arming sweep's only scan

-- ========================================================================
-- 8. workflow_webhook_tokens — one row per workflow with a webhook trigger
--     (MUTABLE TRUTH)
-- ========================================================================
-- Owner: Plan-014
-- The bearer token the loopback listener checks. Only its hash is stored: a stolen database must not
-- yield a working token, and the listener compares a hash to a hash.
CREATE TABLE workflow_webhook_tokens (
  definition_id     TEXT PRIMARY KEY REFERENCES workflow_definitions(id),
  token_hash        TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  last_used_at      TEXT                           -- NULL until the address is first called
) STRICT;

-- ========================================================================
-- 9. workflow_node_state — the per-(workflow, node) key-value store
--     (MUTABLE TRUTH)
-- ========================================================================
-- Owner: Plan-014
-- Trigger cursor state — the last session event read, the last file-watch stamp — lives here and NEVER
-- on the document, so the document stays hashable and safe to edit: a cursor written into the body
-- would change the content hash on every fire and mint a version for nothing. It also holds the values a
-- `Keep for later runs` step keeps: one entry per (workflow, name), with the value, the run that kept it and
-- when. A value over 64 KiB is kept as a file and read back the same way, by the rule a step's payload over
-- the inline bound follows. Kept values belong to the workflow, not to a version: saving, restoring or
-- duplicating a version leaves them, a duplicate starts with none, and `workflow.keptVarsClear` or deleting
-- the workflow removes them.
CREATE TABLE workflow_node_state (
  definition_id     TEXT NOT NULL REFERENCES workflow_definitions(id),
  node_id           TEXT NOT NULL,               -- '' for a kept value, which belongs to the workflow rather than to one node
  key               TEXT NOT NULL,               -- a cursor's key, or a kept value's name
  value_json        TEXT NOT NULL
                    CHECK(json_valid(value_json)),
  kept_by_run_id    TEXT,                        -- the run that kept the value; NULL for trigger cursor state
  updated_at        TEXT NOT NULL,               -- when the value was written or kept
  PRIMARY KEY (definition_id, node_id, key),
  CHECK(kept_by_run_id IS NULL OR node_id = '')
) STRICT;

-- ========================================================================
-- 10. workflow_secrets — one row per workflow secret (MUTABLE TRUTH)
-- ========================================================================
-- Owner: Plan-014
-- A secret's record, never its value: the daemon keeps the value as its own item in the operating system's credential store
-- (ADR-036), and no read, reply, event, log or error carries it. A step parameter stores only
-- secret://<scope>/<name>, resolved when the step runs and only in a field its kind marks sensitive.
-- Managed through workflow.secretCreate, workflow.secretReplace, workflow.secretDelete and
-- workflow.secretList, from the step's Credential field; nothing on Settings holds them.
CREATE TABLE workflow_secrets (
  id                TEXT PRIMARY KEY,            -- the secretId
  scope             TEXT NOT NULL
                    CHECK(scope IN ('project', 'shared')),  -- never a session
  scope_ref         TEXT NOT NULL,               -- the project record's id at 'project'; '' at 'shared'
  name              TEXT NOT NULL                -- lowercase letters, digits and hyphens, starting with a letter or digit, at most 64 characters
                    CHECK(length(name) BETWEEN 1 AND 64 AND name GLOB '[a-z0-9]*' AND name NOT GLOB '*[^a-z0-9-]*'),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,               -- the last `Replace value`
  CHECK((scope = 'shared') = (scope_ref = '')),
  UNIQUE(scope, scope_ref, name)                 -- a name taken in its scope is refused with workflow.secret_name_invalid (reason: taken)
) STRICT;

-- ========================================================================
-- 11. workflow_drafts — the builder's unsaved draft (MUTABLE TRUTH)
-- ========================================================================
-- Owner: Plan-014
-- Written through workflow.draftUpdate and read back by workflow.draftRead, so a draft survives a
-- reload. One row per saved workflow and one for a new workflow, keyed '' (the convention
-- workflow_node_state.node_id uses); no foreign key, because '' names no definition.
CREATE TABLE workflow_drafts (
  definition_id            TEXT PRIMARY KEY,
  based_on_version_number  INTEGER,                -- the version the draft was loaded from; NULL for a new workflow
  document_json            TEXT NOT NULL
                           CHECK(json_valid(document_json)),
  updated_at               TEXT NOT NULL,
  CHECK(definition_id <> '' OR based_on_version_number IS NULL)
) STRICT;
```

**Index rationale + write-amplification estimate:** Per-index query justifications above are sized against SQLite's standard query-planner cost model — partial indexes with `WHERE` clauses are evaluated only over the matching subset, yielding the smallest workable index for the live-set queries ([SQLite — Partial Indexes](https://www.sqlite.org/partialindex.html)). The engine commits the step rows one turn of its loop started or settled in one transaction and hands that turn's events to the event log as one batch — Spec-013's 50 events or 10 ms to a transaction, flushed under one `db.transaction(fn)` call — `better-sqlite3` commits each batch atomically and rolls back on throw (_"Calling [.transaction()] returns a new function that, when called, runs the given function inside an SQLite transaction"_ — [better-sqlite3 API docs](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md)). Measured, twenty steps starting and finishing together cost 1.3 to 2.3 ms of the daemon's time in one transaction against up to 12.3 ms one by one, and a sustained 10,000 step boundaries cost 17 to 19 µs each, so nothing the engine emits outruns the store under `synchronous = FULL` WAL and no write rate limit is needed ([SQLite — Write-Ahead Logging](https://www.sqlite.org/wal.html)).
