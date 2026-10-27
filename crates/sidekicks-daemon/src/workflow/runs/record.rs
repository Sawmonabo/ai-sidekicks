//! A run and its steps as their rows store them, and the mapping from those rows. A run's read and
//! the runs list share the run's mapping; the run read alone carries the steps.

use std::sync::LazyLock;

use rusqlite::Row;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_contracts::session::cost::UsdMicros;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::ComposedText;
use sidekicks_contracts::workflow::definition::document::{
    WorkflowDefinitionId, WorkflowNodeId, WorkflowVersionId,
};
use sidekicks_contracts::workflow::definition::item::WorkflowStepError;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::status::{
    GOING_RUN_STATUSES, WorkflowRunStatus, WorkflowStepStatus, WorkflowWaitCause,
};
use sidekicks_contracts::workflow::run::step::record::{
    WorkflowCost, WorkflowPayloadRef, WorkflowStepSource,
};
use sidekicks_contracts::workflow::run::trigger::{
    WorkflowRunMode, WorkflowStartedBy, WorkflowTriggerKind,
};

use crate::runs::spent_account::SpentAccountColumns;
use sidekicks_store::database::sql_list::sql_list_of;
use sidekicks_store::database::stored_column::{
    closed_word, optional_text_column, safe_int_column, text_column,
};

/// One run as its row stores it. `finished_at` once present is when the run ended, and `error`
/// says why a failed, canceled or crashed run ended.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct StoredWorkflowRun {
    /// The run.
    pub(crate) workflow_run_id: WorkflowRunId,
    /// The session it lives in.
    pub(crate) session_id: SessionId,
    /// The workflow it came from.
    pub(crate) definition_id: WorkflowDefinitionId,
    /// The version it pins.
    pub(crate) workflow_version_id: WorkflowVersionId,
    /// Where it stands.
    pub(crate) status: WorkflowRunStatus,
    /// How it was started.
    pub(crate) mode: WorkflowRunMode,
    /// The kind of trigger node that started it.
    pub(crate) trigger_kind: WorkflowTriggerKind,
    /// Who or what started it.
    pub(crate) started_by: WorkflowStartedBy,
    /// Its Keep mark.
    pub(crate) keep: bool,
    /// When it started.
    pub(crate) started_at: WireInstant,
    /// When it ended; absent while it has not.
    pub(crate) finished_at: Option<WireInstant>,
    /// Why it ended failed, canceled or crashed.
    pub(crate) error: Option<WorkflowStepError>,
}

/// One step as its row stores it. The wait members are present only while the step is `waiting`,
/// because the table clears them in the statement that moves a step out of `waiting`.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct StoredWorkflowStep {
    /// The run.
    pub(crate) workflow_run_id: WorkflowRunId,
    /// The node it ran.
    pub(crate) node_id: WorkflowNodeId,
    /// Which attempt, from 1.
    pub(crate) attempt: SafeInt<1>,
    /// Which execution of the node, increasing through the run.
    pub(crate) execution_index: SafeInt<0>,
    /// Per input slot, the feed that fed it, or `None` for a slot nothing fed.
    pub(crate) source: Vec<Option<WorkflowStepSource>>,
    /// Where it stands.
    pub(crate) status: WorkflowStepStatus,
    /// When it started.
    pub(crate) started_at: WireInstant,
    /// When it settled; absent while it has not.
    pub(crate) finished_at: Option<WireInstant>,
    /// The input it ran on.
    pub(crate) input_ref: WorkflowPayloadRef,
    /// The output it produced.
    pub(crate) output_ref: WorkflowPayloadRef,
    /// Its log.
    pub(crate) log_ref: WorkflowPayloadRef,
    /// What it cost and the account that paid; absent where no provider was billed.
    pub(crate) cost: Option<WorkflowCost>,
    /// Its error; present only on a failed step.
    pub(crate) error: Option<WorkflowStepError>,
    /// Non-fatal hints it attached.
    pub(crate) advisories: Option<Vec<ComposedText>>,
    /// What a waiting step waits on.
    pub(crate) wait_cause: Option<WorkflowWaitCause>,
    /// The spent account an `account` wait waits on.
    pub(crate) wait_account_id: Option<ProviderAccountId>,
    /// That account's stored columns; absent where the account has been removed since the wait
    /// began.
    pub(crate) wait_account: Option<SpentAccountColumns>,
    /// The instant an `account` wait resumes itself, where one is armed.
    pub(crate) resume_at: Option<WireInstant>,
    /// The instant a wait on a person gives up, where its `Timeout` set one.
    pub(crate) wait_deadline_at: Option<WireInstant>,
    /// The level an agent step ran at in place of its run's, where its account could not run the
    /// run's level.
    pub(crate) permission_level: Option<PermissionLevel>,
    /// The words typed with the Decline that failed a command step, where there were any.
    pub(crate) decline_reason: Option<String>,
}

/// The statuses of a run still going, as a SQL list for `status IN (...)`. Written out rather than
/// bound, so a read can use the runs table's partial index over the same statuses.
pub(crate) static GOING_RUN_STATUSES_SQL: LazyLock<String> =
    LazyLock::new(|| sql_list_of(GOING_RUN_STATUSES.map(<&'static str>::from)));

/// The SQL condition on the runs table read as `alias` that holds for a failed run still parked on
/// its failed step, waiting on Resume: it has not ended, so it can still be resumed or canceled.
pub(crate) fn parked_failed_run_condition(alias: &str) -> String {
    let failed = <&'static str>::from(WorkflowRunStatus::Failed);
    format!("({alias}.status = '{failed}' AND {alias}.finished_at IS NULL)")
}

/// Where a request's instant falls among the stored instants, which compare as text in their one
/// stored form: before every one, at a stored-form text, or after every one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum StoredInstantBound {
    /// Before the year 0000, which no stored instant precedes.
    BeforeEvery,
    /// The instant in the stored form, so it compares with the stored instants as text.
    At(WireInstant),
    /// Past the last instant a timestamp holds, which every stored instant precedes.
    AfterEvery,
}

/// `instant` placed among the stored instants: a request's instant may carry an offset or another
/// fraction length, which would compare wrongly as written. It is rounded up to the millisecond the
/// stored instants keep, so a stored instant is before it, or at or after it, exactly when it is
/// so against the rounded text.
pub(crate) fn stored_instant_bound(instant: &WireInstant) -> StoredInstantBound {
    let Some(timestamp) = millisecond_ceiling(instant) else {
        // The instant's pattern holds only days of the calendar, so the text failed to read or
        // round for an offset that carries it past the last timestamp.
        return StoredInstantBound::AfterEvery;
    };
    WireInstant::from_timestamp(timestamp)
        .map_or(StoredInstantBound::BeforeEvery, StoredInstantBound::At)
}

// `instant` rounded up to the millisecond, `None` past the last timestamp: its millisecond, and
// the next one when any fraction digit past the third is not zero, a digit past the ninth that the
// timestamp drops included.
fn millisecond_ceiling(instant: &WireInstant) -> Option<jiff::Timestamp> {
    let millisecond = instant
        .timestamp()?
        .round(
            jiff::TimestampRound::new()
                .smallest(jiff::Unit::Millisecond)
                .mode(jiff::RoundMode::Floor),
        )
        .ok()?;
    let text = instant.as_str();
    let fraction = text.find('.').map_or("", |dot| &text[dot + 1..]);
    let is_past_millisecond = fraction
        .bytes()
        .take_while(u8::is_ascii_digit)
        .skip(3)
        .any(|digit| digit != b'0');
    if is_past_millisecond {
        millisecond
            .checked_add(jiff::SignedDuration::from_millis(1))
            .ok()
    } else {
        Some(millisecond)
    }
}

/// The select-list that reads a run's columns from `workflow_runs AS run` joined to its pinned
/// `workflow_versions AS version`, as [`stored_run_from_row`] reads them.
pub(crate) const RUN_COLUMNS: &str = "run.id AS run_id, run.session_id AS run_session_id,
  version.definition_id AS run_definition_id, run.workflow_version_id AS run_workflow_version_id,
  run.status AS run_status, run.mode AS run_mode,
  json_extract(run.trigger_json, '$.kind') AS run_trigger_kind, run.started_by AS run_started_by,
  run.started_at AS run_started_at, run.finished_at AS run_finished_at,
  run.error_json AS run_error_json, run.kept AS run_kept";

/// The run [`RUN_COLUMNS`] read on `row`. Fails with
/// `rusqlite::Error::FromSqlConversionFailure` for a stored value that does not read as its type.
pub(crate) fn stored_run_from_row(row: &Row<'_>) -> rusqlite::Result<StoredWorkflowRun> {
    Ok(StoredWorkflowRun {
        workflow_run_id: text_column(row, column(row, "run_id")?, |text| {
            WorkflowRunId::new(&text)
        })?,
        session_id: text_column(row, column(row, "run_session_id")?, |text| {
            SessionId::new(&text)
        })?,
        definition_id: text_column(row, column(row, "run_definition_id")?, |text| {
            WorkflowDefinitionId::new(&text)
        })?,
        workflow_version_id: text_column(row, column(row, "run_workflow_version_id")?, |text| {
            WorkflowVersionId::new(&text)
        })?,
        status: text_column(row, column(row, "run_status")?, closed_word)?,
        mode: text_column(row, column(row, "run_mode")?, closed_word)?,
        trigger_kind: text_column(row, column(row, "run_trigger_kind")?, closed_word)?,
        started_by: json_column(row, "run_started_by")?,
        keep: row.get(column(row, "run_kept")?)?,
        started_at: text_column(row, column(row, "run_started_at")?, WireInstant::try_from)?,
        finished_at: optional_text_column(
            row,
            column(row, "run_finished_at")?,
            WireInstant::try_from,
        )?,
        error: optional_json_column(row, "run_error_json")?,
    })
}

/// The select-list that reads a step's own columns from `workflow_steps AS step`, as
/// [`stored_step_from_row`] reads them beside the spent account's columns.
pub(crate) const STEP_COLUMNS: &str = "step.node_id AS step_node_id,
  step.attempt AS step_attempt, step.execution_index AS step_execution_index,
  step.source_json AS step_source_json, step.status AS step_status,
  step.wait_cause AS step_wait_cause, step.resume_at AS step_resume_at,
  step.wait_account_id AS step_wait_account_id, step.wait_deadline_at AS step_wait_deadline_at,
  step.started_at AS step_started_at, step.finished_at AS step_finished_at,
  step.input_ref AS step_input_ref, step.output_ref AS step_output_ref,
  step.log_ref AS step_log_ref, step.cost_usd_micros AS step_cost_usd_micros,
  step.cost_account_id AS step_cost_account_id, step.error_json AS step_error_json,
  step.advisories_json AS step_advisories_json, step.permission_level AS step_permission_level,
  step.decline_reason AS step_decline_reason";

/// The step of run `workflow_run_id` that [`STEP_COLUMNS`] and the spent account's columns read on
/// `row`. Fails with `rusqlite::Error::FromSqlConversionFailure` for a stored value that does not
/// read as its type.
pub(crate) fn stored_step_from_row(
    workflow_run_id: WorkflowRunId,
    row: &Row<'_>,
) -> rusqlite::Result<StoredWorkflowStep> {
    let cost_usd_micros = column(row, "step_cost_usd_micros")?;
    // The table pairs the amount with the account that paid it, so either column decides.
    let cost = match row.get::<_, Option<i64>>(cost_usd_micros)? {
        None => None,
        Some(_) => Some(WorkflowCost {
            usd_micros: UsdMicros(safe_int_column(row, cost_usd_micros)?),
            provider_account_id: text_column(
                row,
                column(row, "step_cost_account_id")?,
                closed_word,
            )?,
        }),
    };
    Ok(StoredWorkflowStep {
        workflow_run_id,
        node_id: text_column(row, column(row, "step_node_id")?, closed_word)?,
        attempt: safe_int_column(row, column(row, "step_attempt")?)?,
        execution_index: safe_int_column(row, column(row, "step_execution_index")?)?,
        source: json_column(row, "step_source_json")?,
        status: text_column(row, column(row, "step_status")?, closed_word)?,
        started_at: text_column(row, column(row, "step_started_at")?, WireInstant::try_from)?,
        finished_at: optional_text_column(
            row,
            column(row, "step_finished_at")?,
            WireInstant::try_from,
        )?,
        input_ref: json_column(row, "step_input_ref")?,
        output_ref: json_column(row, "step_output_ref")?,
        log_ref: json_column(row, "step_log_ref")?,
        cost,
        error: optional_json_column(row, "step_error_json")?,
        advisories: optional_json_column(row, "step_advisories_json")?,
        wait_cause: optional_text_column(row, column(row, "step_wait_cause")?, closed_word)?,
        wait_account_id: optional_text_column(
            row,
            column(row, "step_wait_account_id")?,
            closed_word,
        )?,
        wait_account: SpentAccountColumns::read(row)?,
        resume_at: optional_text_column(
            row,
            column(row, "step_resume_at")?,
            WireInstant::try_from,
        )?,
        wait_deadline_at: optional_text_column(
            row,
            column(row, "step_wait_deadline_at")?,
            WireInstant::try_from,
        )?,
        permission_level: optional_text_column(
            row,
            column(row, "step_permission_level")?,
            closed_word,
        )?,
        decline_reason: row.get(column(row, "step_decline_reason")?)?,
    })
}

/// The index of the column a select-list names `alias`; fails with
/// `rusqlite::Error::InvalidColumnName` for a name the statement does not select.
pub(crate) fn column(row: &Row<'_>, alias: &str) -> rusqlite::Result<usize> {
    row.as_ref().column_index(alias)
}

// The JSON column `alias`, which this store wrote from a typed value, read back as that type.
fn json_column<Value: serde::de::DeserializeOwned>(
    row: &Row<'_>,
    alias: &str,
) -> rusqlite::Result<Value> {
    text_column(row, column(row, alias)?, |text| serde_json::from_str(&text))
}

// The nullable JSON column `alias`, `None` for `NULL`.
fn optional_json_column<Value: serde::de::DeserializeOwned>(
    row: &Row<'_>,
    alias: &str,
) -> rusqlite::Result<Option<Value>> {
    optional_text_column(row, column(row, alias)?, |text| serde_json::from_str(&text))
}
