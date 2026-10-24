//! The workflow tables, which the daemon's schema runs with the rest. Every closed set a column
//! holds is written from its enum.
//!
//! The versions and the gate answers never change once written. A definition's row is current
//! state that changes in place: its settings outside the hash, and its current body on a save. The
//! runs and the steps are projections the event log can rebuild, except a waiting step's
//! `wait_deadline_at`. The triggers, webhook tokens, node state and secrets are truth that changes:
//! no event history can say what this machine is armed to do next or which secrets it holds, so
//! the row is the truth and any in-process timer is a cache over it, re-armed from the row at
//! start. The form drafts and the builder drafts are durable state with no timer: what the person
//! has typed but not saved is in no event, so the row holds it.

use std::sync::LazyLock;

use sidekicks_contracts::approval::ApprovalDecision;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::workflow::definition::builder::WorkflowBackgroundBrowser;
use sidekicks_contracts::workflow::definition::methods::WorkflowWebhookFireOutcome;
use sidekicks_contracts::workflow::run::gate_resolution::{
    WorkflowGateApprovalCategory, WorkflowGateKind,
};
use sidekicks_contracts::workflow::run::status::{
    WorkflowRunStatus, WorkflowStepStatus, WorkflowWaitCause,
};
use sidekicks_contracts::workflow::run::trigger::WorkflowRunMode;
use sidekicks_contracts::workflow::secret::WorkflowSecretScope;

use crate::database::sql_list::{sql_list_of, sql_list_of_every};
use crate::workflow::runs::record::GOING_RUN_STATUSES_SQL;

/// The workflow part of the daemon's schema: the definitions, their versions, the runs, the gate
/// answers, the form drafts, the steps, the triggers, the webhook tokens, the node state, the
/// secrets' records and the builder drafts, in foreign-key order.
pub(crate) static WORKFLOW_SCHEMA_SQL: LazyLock<String> = LazyLock::new(workflow_schema_sql);

fn workflow_schema_sql() -> String {
    let permission_levels = sql_list_of_every::<PermissionLevel>();
    let yolo = <&'static str>::from(PermissionLevel::Yolo);
    let background_browsers = sql_list_of_every::<WorkflowBackgroundBrowser>();
    let settings_default = <&'static str>::from(WorkflowBackgroundBrowser::SettingsDefault);
    let webhook_fire_outcomes = sql_list_of_every::<WorkflowWebhookFireOutcome>();
    let run_statuses = sql_list_of_every::<WorkflowRunStatus>();
    let new_run = <&'static str>::from(WorkflowRunStatus::New);
    let going_run_statuses = &*GOING_RUN_STATUSES_SQL;
    let run_modes = sql_list_of_every::<WorkflowRunMode>();
    let gate_kinds = sql_list_of_every::<WorkflowGateKind>();
    let human_approval = <&'static str>::from(WorkflowGateKind::HumanApproval);
    let approval_categories = sql_list_of_every::<WorkflowGateApprovalCategory>();
    let approval_decisions = sql_list_of_every::<ApprovalDecision>();
    let step_statuses = sql_list_of_every::<WorkflowStepStatus>();
    let waiting = <&'static str>::from(WorkflowStepStatus::Waiting);
    let failed = <&'static str>::from(WorkflowStepStatus::Failed);
    let wait_causes = sql_list_of_every::<WorkflowWaitCause>();
    let account = <&'static str>::from(WorkflowWaitCause::Account);
    let person_wait_causes = sql_list_of(
        [
            WorkflowWaitCause::Approval,
            WorkflowWaitCause::Form,
            WorkflowWaitCause::Reply,
        ]
        .map(<&'static str>::from),
    );
    let secret_scopes = sql_list_of_every::<WorkflowSecretScope>();
    let shared = <&'static str>::from(WorkflowSecretScope::Shared);
    format!(
        "
-- ---------------------------------------------------------------------------
-- workflow_definitions: one row per workflow in the one library.
-- ---------------------------------------------------------------------------
-- The layout, tags, permission level, background browser and pinned data sit
-- outside the content hash, so changing any of them mints no version.
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
  permission_level     TEXT NOT NULL DEFAULT '{yolo}'
                       CHECK(permission_level IN ({permission_levels})),
  -- Every later run of the workflow uses this browser; a live run keeps the
  -- browser it started with.
  background_browser   TEXT NOT NULL DEFAULT '{settings_default}'
                       CHECK(background_browser IN ({background_browsers})),
  -- JSON object of node id to a pinned item array; NULL when nothing is pinned.
  pin_data_json        TEXT
                       CHECK(pin_data_json IS NULL
                         OR (json_valid(pin_data_json) AND json_type(pin_data_json) = 'object')),
  -- The last call to the workflow's webhook address and what became of it. It
  -- lives here rather than on workflow_webhook_tokens because a call while no
  -- token exists is recorded too. Written by the webhook listener; both NULL
  -- until the address is first called.
  webhook_last_fire_at       TEXT,
  webhook_last_fire_outcome  TEXT
                             CHECK(webhook_last_fire_outcome IS NULL
                               OR webhook_last_fire_outcome IN ({webhook_fire_outcomes})),
  created_at           TEXT NOT NULL,
  created_by           TEXT,                         -- the device the save came from
  -- The last change to this row: a save, a rename, or a write outside the hash.
  updated_at           TEXT NOT NULL,
  -- The soft delete: the workflow's runs keep their pinned versions. NULL while
  -- it is in the library.
  deleted_at           TEXT,
  CHECK((webhook_last_fire_at IS NULL) = (webhook_last_fire_outcome IS NULL))
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
  -- version was saved; '{{}}' where the version locks none.
  code_locks_json      TEXT NOT NULL DEFAULT '{{}}'
                       CHECK(json_valid(code_locks_json) AND json_type(code_locks_json) = 'object'),
  -- Two versions may hold the same bytes: Restore saves an older version again as the newest.
  UNIQUE(definition_id, version_number)
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
  status                    TEXT NOT NULL DEFAULT '{new_run}'
                            CHECK(status IN ({run_statuses})),
  mode                      TEXT NOT NULL
                            CHECK(mode IN ({run_modes})),
  -- JSON: which trigger node started the run and with what.
  trigger_json              TEXT NOT NULL DEFAULT '{{}}'
                            CHECK(json_valid(trigger_json)),
  -- JSON: who or what started the run.
  started_by                TEXT NOT NULL
                            CHECK(json_valid(started_by)),
  -- When the request, fire or call that asked for the run started it: its
  -- workflow.run.started. A run reads '{new_run}' from then until the engine
  -- admits it.
  started_at                TEXT NOT NULL,
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
  CHECK((chain_root_run_id = id) = (chain_run_count IS NOT NULL)),
  CHECK((chain_run_count IS NULL) = (chain_kept_going IS NULL))
) STRICT;

-- Deleting old runs pages in session order, each page seeking past the last one's final run.
CREATE INDEX idx_workflow_runs_session ON workflow_runs(session_id, id);
CREATE INDEX idx_workflow_runs_status ON workflow_runs(status)
  WHERE status IN ({going_run_statuses});
-- Stop them all cancels every run of the chain still going.
CREATE INDEX idx_workflow_runs_chain ON workflow_runs(chain_root_run_id);
CREATE INDEX idx_workflow_runs_version ON workflow_runs(workflow_version_id);
-- The runs list pages newest first by start, ties broken by id.
CREATE INDEX idx_workflow_runs_started ON workflow_runs(started_at, id);

-- ---------------------------------------------------------------------------
-- workflow_gate_resolutions: every answer to an approval node or a chain's
-- question, append-only.
-- ---------------------------------------------------------------------------
-- Rows are never updated; they are removed only with their run. Each row's id is
-- the gateResolutionId the session's workflow.gate.resolved event carries.
CREATE TABLE workflow_gate_resolutions (
  id                         TEXT PRIMARY KEY,
  workflow_run_id            TEXT NOT NULL REFERENCES workflow_runs(id),
  sequence                   INTEGER NOT NULL,       -- per run, from 1
  -- The approval node answered; NULL for a chain's question, which belongs to
  -- the run.
  node_id                    TEXT,
  gate_kind                  TEXT NOT NULL
                             CHECK(gate_kind IN ({gate_kinds})),
  -- Mirrors approval_requests.category where one applies.
  approval_category          TEXT
                             CHECK(approval_category IS NULL
                               OR approval_category IN ({approval_categories})),
  approval_request_id        TEXT NOT NULL REFERENCES approval_requests(id),
  outcome                    TEXT NOT NULL
                             CHECK(outcome IN ({approval_decisions})),
  device_id                  TEXT NOT NULL,          -- the answering device
  resolved_at                TEXT NOT NULL,
  -- JSON: scope, resource, reason text.
  decision_context           TEXT NOT NULL DEFAULT '{{}}',
  UNIQUE(workflow_run_id, sequence),
  CHECK((gate_kind = '{human_approval}') = (node_id IS NOT NULL))
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
  draft_json              TEXT NOT NULL DEFAULT '{{}}', -- JSON: the field values so far
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
  -- A step waiting for memory is held by the memory gate before it starts; a
  -- canceled step was running or waiting when its run ended failed or canceled.
  status            TEXT NOT NULL
                    CHECK(status IN ({step_statuses})),
  -- What a waiting step waits on: a person, its chain's question or a spent
  -- provider account.
  wait_cause        TEXT
                    CHECK(wait_cause IS NULL OR wait_cause IN ({wait_causes})),
  -- When a step parked on a spent account resumes itself; NULL where nothing is
  -- armed, which reads as awaiting resume.
  resume_at         TEXT,
  -- The spent account an account wait groups under, so every run waiting on
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
  -- An agent step whose account cannot run its run's level: the level it ran
  -- at in its place, from its workflow.step.started. NULL on every other step.
  permission_level  TEXT
                    CHECK(permission_level IS NULL OR permission_level IN ({permission_levels})),
  -- The words typed with the Decline on a command step's own approval card that
  -- failed it, from its workflow.step.failed. NULL on every other step and on a
  -- bare decline.
  decline_reason    TEXT,
  -- The whole step key; it also serves a lookup by run and node.
  PRIMARY KEY (workflow_run_id, node_id, attempt, execution_index),
  UNIQUE(workflow_run_id, execution_index),
  -- A cost always names the account that paid it.
  CHECK((cost_usd_micros IS NULL) = (cost_account_id IS NULL)),
  CHECK((status = '{waiting}') = (wait_cause IS NOT NULL)),
  -- The live wait state clears in the same statement that moves the step out of
  -- waiting.
  CHECK((status = '{waiting}') = (wait_started_at IS NOT NULL)),
  CHECK(status = '{waiting}'
    OR (resume_at IS NULL AND wait_account_id IS NULL AND wait_deadline_at IS NULL)),
  CHECK(wait_cause = '{account}' OR (resume_at IS NULL AND wait_account_id IS NULL)),
  CHECK(wait_deadline_at IS NULL OR wait_cause IN ({person_wait_causes})),
  CHECK(decline_reason IS NULL OR status = '{failed}')
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
-- The value lives in the operating system's credential store on macOS and
-- Windows, and on Linux in the daemon's secrets.json items file, sealed through
-- systemd's credential service where it can seal; a Mac's service running while
-- the person is logged out keeps it plain in that same file. A step parameter
-- stores only secret://<scope>/<name>, resolved when the step runs.
CREATE TABLE workflow_secrets (
  id                TEXT PRIMARY KEY,
  scope             TEXT NOT NULL
                    CHECK(scope IN ({secret_scopes})),
  scope_ref         TEXT NOT NULL,                 -- the project's id; '' for a shared one
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
  CHECK((scope = '{shared}') = (scope_ref = '')),
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
"
    )
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use rusqlite::ErrorCode;
    use sidekicks_contracts::workflow::run::status::{
        WorkflowRunStatus, WorkflowStepStatus, WorkflowWaitCause,
    };

    use crate::workflow::test_rows::{insert_run, insert_workflow_version, workflow_tables};

    const AT: &str = "2026-10-14T09:30:00.000Z";
    const DEFINITION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e50";
    const VERSION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e51";

    fn sql_text(value: Option<&str>) -> String {
        value.map_or_else(|| "NULL".to_owned(), |value| format!("'{value}'"))
    }

    // A step at `status`, waiting on `wait_cause` where one is given, with the wait columns set as
    // the case gives them; it started waiting when it started, while it waits.
    fn step_row(
        status: WorkflowStepStatus,
        wait_cause: Option<WorkflowWaitCause>,
        wait_account_id: Option<&str>,
        resume_at: Option<&str>,
        wait_deadline_at: Option<&str>,
    ) -> String {
        let wait_started_at = (status == WorkflowStepStatus::Waiting).then_some(AT);
        format!(
            "INSERT INTO workflow_steps (workflow_run_id, node_id, attempt, execution_index, \
             status, wait_cause, wait_account_id, resume_at, wait_deadline_at, wait_started_at, \
             started_at, input_ref, output_ref, log_ref) VALUES ('run', 'node', 1, 0, '{}', {}, \
             {}, {}, {}, {}, '{AT}', '{{}}', '{{}}', '{{}}')",
            <&'static str>::from(status),
            sql_text(wait_cause.map(<&'static str>::from)),
            sql_text(wait_account_id),
            sql_text(resume_at),
            sql_text(wait_deadline_at),
            sql_text(wait_started_at),
        )
    }

    /// A step's wait columns are set only while it waits, so a settled step never keeps a resume
    /// or a deadline armed. Mutation: drop `CHECK(status = 'waiting' OR (resume_at IS NULL AND
    /// …))`.
    #[rstest]
    #[case::waiting_on_a_spent_account(
        step_row(
            WorkflowStepStatus::Waiting,
            Some(WorkflowWaitCause::Account),
            Some("account"),
            Some(AT),
            None,
        ),
        true
    )]
    #[case::settled_with_a_resume_armed(
        step_row(WorkflowStepStatus::Succeeded, None, None, Some(AT), None),
        false
    )]
    #[case::settled_with_a_deadline_armed(
        step_row(WorkflowStepStatus::Succeeded, None, None, None, Some(AT)),
        false
    )]
    fn keeps_wait_columns_to_a_waiting_step(#[case] row: String, #[case] is_admitted: bool) {
        let connection = workflow_tables();
        insert_workflow_version(&connection, DEFINITION_ID, VERSION_ID, "Nightly");
        insert_run(
            &connection,
            "run",
            VERSION_ID,
            WorkflowRunStatus::Running,
            AT,
            None,
        );
        // `None` is a failure other than a constraint's, such as a mistyped statement.
        let outcome = match connection.execute_batch(&row) {
            Ok(()) => Some(true),
            Err(error) => {
                (error.sqlite_error_code() == Some(ErrorCode::ConstraintViolation)).then_some(false)
            }
        };
        assert_eq!(outcome, Some(is_admitted));
    }
}
