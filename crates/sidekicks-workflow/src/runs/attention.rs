//! The runs-needing-you section: every run waiting on a person, oldest first, with the runs parked
//! on a spent provider account folded into one line per account above them. No runs-list filter
//! narrows it.

use std::sync::LazyLock;

use rusqlite::{Connection, Row};
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_contracts::workflow::run::attention::WorkflowPersonWaitCause;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::status::{WorkflowStepStatus, WorkflowWaitCause};
use sidekicks_store::database::stored_column::{
    closed_word, optional_text_column, safe_int_column, text_column,
};

use crate::runs::record::{GOING_RUN_STATUSES_SQL, column};
use crate::runs::spent_account::{SpentAccountColumns, spent_account_columns};

/// The statements a [`WorkflowRunAttentionList`] prepares on a read connection: the person waits
/// and the account waits.
pub const WORKFLOW_RUN_ATTENTION_STATEMENT_CAPACITY: usize = 2;

/// One line of the runs-needing-you section as the rows hold it. An account line names its
/// account by id, with the columns it is labeled from while the account's row is stored.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum StoredWorkflowRunAttentionEntry {
    /// A run waiting on a person, named by the step that waits longest.
    Run {
        /// The run.
        workflow_run_id: WorkflowRunId,
        /// Its workflow's name in the version it pins.
        workflow_name: NonEmptyText,
        /// What it waits on.
        wait_cause: WorkflowPersonWaitCause,
        /// The name of the step that waits.
        waiting_step_name: NonEmptyText,
        /// Since when it waits.
        waiting_since: WireInstant,
    },
    /// The runs one spent provider account holds.
    Account {
        /// The account the waiting steps name.
        provider_account_id: ProviderAccountId,
        /// Its stored columns; absent once the account's row is gone.
        account: Option<SpentAccountColumns>,
        /// How many runs it holds.
        affected_run_count: SafeInt<1>,
        /// Since when the oldest of them waits.
        waiting_since: WireInstant,
        /// The earliest armed resume instant among its waits.
        resume_at: Option<WireInstant>,
    },
}

/// The runs-needing-you section as the rows hold it: the account lines first, then the runs
/// waiting on a person, oldest first, with how many runs wait on a person.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct StoredWorkflowRunAttentionList {
    /// The lines, in the order `Next waiting` walks them.
    pub(crate) entries: Vec<StoredWorkflowRunAttentionEntry>,
    /// How many runs wait on a person; an account wait is never in it.
    pub(crate) waiting_on_person_count: SafeInt<0>,
}

/// Why the runs-needing-you section could not be read.
#[derive(Debug, thiserror::Error)]
pub(crate) enum WorkflowRunAttentionError {
    /// A waiting step's node is missing from its run's version, so its line cannot be named.
    #[error("A waiting step of run {workflow_run_id} names no node of its version")]
    StepNamesNoNode {
        /// The run whose step names no node.
        workflow_run_id: WorkflowRunId,
    },
    /// SQLite failed the read, or a stored value did not read as its type.
    #[error("reading the runs needing someone failed")]
    Database(#[from] rusqlite::Error),
}

// Waiting steps are read only in going runs, the set the runs table's partial status index holds.
// A run with several steps waiting on a person is one line, named by the step that waits longest.
static PERSON_WAITS_SQL: LazyLock<String> = LazyLock::new(|| {
    let waiting = <&'static str>::from(WorkflowStepStatus::Waiting);
    let account = <&'static str>::from(WorkflowWaitCause::Account);
    format!(
        "SELECT run_id, wait_cause, waiting_since, workflow_name, step_name
  FROM (
    SELECT step.workflow_run_id AS run_id, step.wait_cause, step.wait_started_at AS waiting_since,
      json_extract(version.definition_body, '$.name') AS workflow_name,
      (SELECT json_extract(node.value, '$.name')
         FROM json_each(version.definition_body, '$.nodes') AS node
        WHERE json_extract(node.value, '$.id') = step.node_id) AS step_name,
      ROW_NUMBER() OVER (
        PARTITION BY step.workflow_run_id ORDER BY step.wait_started_at, step.execution_index
      ) AS place_in_run
    FROM workflow_runs AS run
    JOIN workflow_versions AS version ON version.id = run.workflow_version_id
    JOIN workflow_steps AS step ON step.workflow_run_id = run.id
    WHERE run.status IN ({going})
      AND step.status = '{waiting}' AND step.wait_cause <> '{account}'
  )
  WHERE place_in_run = 1
  ORDER BY waiting_since, run_id",
        going = *GOING_RUN_STATUSES_SQL,
    )
});

// The earliest armed resume instant stands for the account: the first of its runs to go on.
static ACCOUNT_WAITS_SQL: LazyLock<String> = LazyLock::new(|| {
    let waiting = <&'static str>::from(WorkflowStepStatus::Waiting);
    let account = <&'static str>::from(WorkflowWaitCause::Account);
    format!(
        "SELECT step.wait_account_id,
    COUNT(DISTINCT step.workflow_run_id) AS affected_run_count,
    MIN(step.wait_started_at) AS waiting_since, MIN(step.resume_at) AS resume_at,
    {account_columns}
  FROM workflow_runs AS run
  JOIN workflow_steps AS step ON step.workflow_run_id = run.id
  LEFT JOIN provider_accounts AS account ON account.account_id = step.wait_account_id
  WHERE run.status IN ({going})
    AND step.status = '{waiting}' AND step.wait_cause = '{account}'
  GROUP BY step.wait_account_id
  ORDER BY waiting_since, step.wait_account_id",
        going = *GOING_RUN_STATUSES_SQL,
        account_columns = spent_account_columns("account"),
    )
});

/// Reads the runs-needing-you section that the Runs tab and `Next waiting` walk, on one of the
/// daemon's read connections.
pub(crate) struct WorkflowRunAttentionList<'connection> {
    /// A read-only connection.
    reader: &'connection Connection,
}

impl<'connection> WorkflowRunAttentionList<'connection> {
    /// A list reading through `reader`, one of the daemon's read-only connections.
    pub(crate) fn new(reader: &'connection Connection) -> Self {
        Self { reader }
    }

    /// The account lines, oldest first, then one line per run waiting on a person, oldest first.
    /// Fails with [`WorkflowRunAttentionError::StepNamesNoNode`] when a waiting step's node is
    /// missing from its run's version, and with [`WorkflowRunAttentionError::Database`] when
    /// SQLite fails or a stored value does not read.
    pub(crate) fn read(&self) -> Result<StoredWorkflowRunAttentionList, WorkflowRunAttentionError> {
        let mut entries = self
            .reader
            .prepare_cached(&ACCOUNT_WAITS_SQL)?
            .query_map([], account_entry_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut person_waits = self.reader.prepare_cached(&PERSON_WAITS_SQL)?;
        let mut rows = person_waits.query([])?;
        let mut waiting_on_person_count: u64 = 0;
        while let Some(row) = rows.next()? {
            entries.push(person_entry_from_row(row)?);
            waiting_on_person_count += 1;
        }
        Ok(StoredWorkflowRunAttentionList {
            entries,
            waiting_on_person_count: SafeInt::new(waiting_on_person_count)
                .expect("a count of stored rows is a safe integer"),
        })
    }
}

fn account_entry_from_row(row: &Row<'_>) -> rusqlite::Result<StoredWorkflowRunAttentionEntry> {
    Ok(StoredWorkflowRunAttentionEntry::Account {
        provider_account_id: text_column(row, column(row, "wait_account_id")?, closed_word)?,
        account: SpentAccountColumns::read(row)?,
        affected_run_count: safe_int_column(row, column(row, "affected_run_count")?)?,
        waiting_since: text_column(row, column(row, "waiting_since")?, WireInstant::try_from)?,
        resume_at: optional_text_column(row, column(row, "resume_at")?, WireInstant::try_from)?,
    })
}

fn person_entry_from_row(
    row: &Row<'_>,
) -> Result<StoredWorkflowRunAttentionEntry, WorkflowRunAttentionError> {
    let workflow_run_id = text_column(row, column(row, "run_id")?, |text| {
        WorkflowRunId::new(&text)
    })?;
    let Some(waiting_step_name) =
        optional_text_column(row, column(row, "step_name")?, closed_word)?
    else {
        return Err(WorkflowRunAttentionError::StepNamesNoNode { workflow_run_id });
    };
    Ok(StoredWorkflowRunAttentionEntry::Run {
        workflow_run_id,
        workflow_name: text_column(row, column(row, "workflow_name")?, closed_word)?,
        wait_cause: text_column(row, column(row, "wait_cause")?, closed_word)?,
        waiting_step_name,
        waiting_since: text_column(row, column(row, "waiting_since")?, WireInstant::try_from)?,
    })
}
