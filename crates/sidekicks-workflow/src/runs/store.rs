//! Reading runs: one run with its chain's first run and every step, and the runs list with its
//! filters, its version scope and its paging. Each read is one statement, so it sees one committed
//! state of the database.

use std::sync::LazyLock;

use rusqlite::{Connection, Row, named_params};
use sidekicks_contracts::wire::id::UuidText;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::workflow::definition::document::WorkflowDefinitionId;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::list::{WorkflowRunListCursor, WorkflowRunListRequest};
use sidekicks_contracts::workflow::run::records::WorkflowChainRoot;
use sidekicks_contracts::workflow::run::status::{WorkflowStepStatus, WorkflowWaitCause};
use sidekicks_store::database::stored_column::{
    closed_word, optional_text_column, safe_int_column, text_column,
};

use crate::not_found::WorkflowNotFound;
use crate::runs::invalid_cursor::{UnresolvableCursorReason, WorkflowCursorUnresolvable};
use crate::runs::record::{
    RUN_COLUMNS, STEP_COLUMNS, StoredInstantBound, StoredWorkflowRun, StoredWorkflowStep, column,
    stored_instant_bound, stored_run_from_row, stored_step_from_row,
};
use crate::runs::spent_account::spent_account_columns;

/// The statements a [`WorkflowRunStore`] prepares on a read connection: the run read and the runs
/// list.
pub const WORKFLOW_RUN_STORE_STATEMENT_CAPACITY: usize = 2;

/// One run as `workflow.run.read` builds on it: its row, the first run of its chain, whether it
/// recorded an execution context, and every step in execution order.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct StoredWorkflowRunRead {
    /// The run's row.
    pub(crate) run: StoredWorkflowRun,
    /// The first run of its chain; absent once that run has been deleted.
    pub(crate) chain_root: Option<WorkflowChainRoot>,
    /// Whether the run recorded the checkout it works in.
    pub(crate) execution_context_captured: bool,
    /// Every step, in execution order.
    pub(crate) steps: Vec<StoredWorkflowStep>,
}

/// One run as the runs list reads it: its row, its workflow's name, how many steps it has, and,
/// while a step waits, what the first waiting step waits on and when an account wait resumes.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct StoredWorkflowRunListEntry {
    /// The run's row.
    pub(crate) run: StoredWorkflowRun,
    /// Its workflow's name in the version it pins.
    pub(crate) definition_name: String,
    /// How many steps it has.
    pub(crate) step_count: SafeInt<0>,
    /// What its first waiting step waits on.
    pub(crate) wait_cause: Option<WorkflowWaitCause>,
    /// When that step's account wait resumes itself, where one is armed.
    pub(crate) resume_at: Option<WireInstant>,
}

/// One page of the runs list, newest first, and how many runs the filters match in all. Each run
/// is listed once across pages: the order is the run's start and then its id, neither of which
/// changes after the run is written.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct StoredWorkflowRunListPage {
    /// The page's runs.
    pub(crate) runs: Vec<StoredWorkflowRunListEntry>,
    /// Where the next page starts; absent on the last.
    pub(crate) next_cursor: Option<WorkflowRunListCursor>,
    /// How many runs the filters match.
    pub(crate) total_count: SafeInt<0>,
}

/// Why a run read or a runs-list read failed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum WorkflowRunStoreError {
    /// No run answers to the id (`workflow.run.notFound`).
    #[error(transparent)]
    NotFound(#[from] WorkflowNotFound),
    /// The cursor is not one this store wrote (`workflow.cursorUnresolvable`).
    #[error(transparent)]
    CursorUnresolvable(#[from] WorkflowCursorUnresolvable),
    /// SQLite failed the read, or a stored value did not read as its type.
    #[error("reading the workflow runs failed")]
    Database(#[from] rusqlite::Error),
}

// The run's row once per step, or once with null step columns for a run with no step yet.
static READ_RUN_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {RUN_COLUMNS},
    root.id AS root_run_id, root_version.definition_id AS root_definition_id,
    json_extract(root_version.definition_body, '$.name') AS root_workflow_name,
    root.started_at AS root_started_at, root.chain_run_count AS root_run_count,
    EXISTS (SELECT 1 FROM run_execution_contexts AS context WHERE context.run_id = run.id)
      AS execution_context_captured,
    {STEP_COLUMNS}, {account_columns}
  FROM workflow_runs AS run
  JOIN workflow_versions AS version ON version.id = run.workflow_version_id
  LEFT JOIN workflow_runs AS root
    ON root.id = run.chain_root_run_id AND root.chain_run_count IS NOT NULL
  LEFT JOIN workflow_versions AS root_version ON root_version.id = root.workflow_version_id
  LEFT JOIN workflow_steps AS step ON step.workflow_run_id = run.id
  LEFT JOIN provider_accounts AS account ON account.account_id = step.wait_account_id
  WHERE run.id = @run_id
  ORDER BY step.execution_index",
        account_columns = spent_account_columns("account"),
    )
});

// One statement answers the page and the total, so the two always describe the same runs; the
// anchor row keeps the total when the page is empty. The page reads one row past its size to learn
// whether another follows.
static LIST_RUNS_SQL: LazyLock<String> = LazyLock::new(|| {
    let waiting = <&'static str>::from(WorkflowStepStatus::Waiting);
    format!(
        "WITH matched AS (
    SELECT {RUN_COLUMNS}, json_extract(version.definition_body, '$.name') AS definition_name
    FROM workflow_runs AS run
    JOIN workflow_versions AS version ON version.id = run.workflow_version_id
    WHERE (@session_id IS NULL OR run.session_id = @session_id)
      AND (@statuses_json IS NULL
           OR run.status IN (SELECT value FROM json_each(@statuses_json)))
      AND (@trigger_kinds_json IS NULL
           OR json_extract(run.trigger_json, '$.kind')
              IN (SELECT value FROM json_each(@trigger_kinds_json)))
      AND (@started_after IS NULL OR run.started_at >= @started_after)
      AND (@started_before IS NULL OR run.started_at < @started_before)
      AND (@definition_id IS NULL OR version.definition_id = @definition_id)
      AND (@workflow_version_id IS NULL OR run.workflow_version_id = @workflow_version_id)
  ),
  page AS (
    SELECT * FROM matched
    WHERE @after_started_at IS NULL
       OR run_started_at < @after_started_at
       OR (run_started_at = @after_started_at AND run_id < @after_run_id)
    ORDER BY run_started_at DESC, run_id DESC
    LIMIT @page_row_limit
  )
  SELECT (SELECT COUNT(*) FROM matched) AS total_count, page.*,
    (SELECT COUNT(*) FROM workflow_steps AS step WHERE step.workflow_run_id = page.run_id)
      AS step_count,
    waiting.wait_cause AS waiting_cause, waiting.resume_at AS waiting_resume_at
  FROM (SELECT 1) AS anchor
  LEFT JOIN page ON TRUE
  LEFT JOIN workflow_steps AS waiting
    ON waiting.workflow_run_id = page.run_id
   AND waiting.execution_index = (
     SELECT MIN(first_waiting.execution_index) FROM workflow_steps AS first_waiting
     WHERE first_waiting.workflow_run_id = page.run_id AND first_waiting.status = '{waiting}'
   )
  ORDER BY page.run_started_at DESC, page.run_id DESC"
    )
});

/// Reads runs and their steps for the run page and the runs list, on one of the daemon's read
/// connections, which sees each write once it has committed.
pub(crate) struct WorkflowRunStore<'connection> {
    /// A read-only connection.
    reader: &'connection Connection,
}

impl<'connection> WorkflowRunStore<'connection> {
    /// A store reading through `reader`, one of the daemon's read-only connections.
    pub(crate) fn new(reader: &'connection Connection) -> Self {
        Self { reader }
    }

    /// The run `workflow_run_id` names, with its chain's first run and its steps. Fails with
    /// [`WorkflowRunStoreError::NotFound`] when there is none, and with
    /// [`WorkflowRunStoreError::Database`] when SQLite fails or a stored value does not read.
    pub(crate) fn read(
        &self,
        workflow_run_id: WorkflowRunId,
    ) -> Result<StoredWorkflowRunRead, WorkflowRunStoreError> {
        let mut statement = self.reader.prepare_cached(&READ_RUN_SQL)?;
        let mut rows =
            statement.query(named_params! { "@run_id": workflow_run_id.text().as_str() })?;
        let Some(first) = rows.next()? else {
            return Err(WorkflowNotFound::Run { workflow_run_id }.into());
        };
        let run = stored_run_from_row(first)?;
        let chain_root = chain_root_from_row(first)?;
        let execution_context_captured = first.get(column(first, "execution_context_captured")?)?;
        let mut steps = Vec::new();
        let mut row = Some(first);
        while let Some(step_row) = row {
            // A run with no step yet reads as one row whose step columns are all null.
            if step_row
                .get::<_, Option<i64>>(column(step_row, "step_execution_index")?)?
                .is_some()
            {
                steps.push(stored_step_from_row(workflow_run_id, step_row)?);
            }
            row = rows.next()?;
        }
        Ok(StoredWorkflowRunRead {
            run,
            chain_root,
            execution_context_captured,
            steps,
        })
    }

    /// One page of at most `page_size` runs the request's filters match, newest first, after the
    /// run its cursor names. Fails with [`WorkflowRunStoreError::CursorUnresolvable`] for a cursor
    /// this store did not write, and [`WorkflowRunStoreError::Database`] when SQLite fails or a
    /// stored value does not read.
    pub(crate) fn list(
        &self,
        request: &WorkflowRunListRequest,
        page_size: SafeInt<1>,
    ) -> Result<StoredWorkflowRunListPage, WorkflowRunStoreError> {
        let after = request
            .cursor
            .as_ref()
            .map(decode_run_list_cursor)
            .transpose()?;
        let started_after = match request.started_after.as_ref().map(stored_instant_bound) {
            // Every stored start is after an instant before the year 0000.
            None | Some(StoredInstantBound::BeforeEvery) => None,
            Some(StoredInstantBound::At(instant)) => Some(instant),
            Some(StoredInstantBound::AfterEvery) => return Ok(empty_page()),
        };
        let started_before = match request.started_before.as_ref().map(stored_instant_bound) {
            // Every stored start is before an instant past the last a timestamp holds.
            None | Some(StoredInstantBound::AfterEvery) => None,
            Some(StoredInstantBound::At(instant)) => Some(instant),
            Some(StoredInstantBound::BeforeEvery) => return Ok(empty_page()),
        };
        let statuses_json = request.status.as_ref().map(json_list);
        let trigger_kinds_json = request.trigger_kind.as_ref().map(json_list);
        let page_size = usize::try_from(i64::from(page_size))
            .expect("a safe integer page size fits the platform's sizes");
        let page_row_limit = i64::from(page_size_plus_one(page_size));
        let mut statement = self.reader.prepare_cached(&LIST_RUNS_SQL)?;
        let mut rows = statement.query(named_params! {
            "@session_id": request.session_id.map(|id| id.text()).as_ref().map(UuidText::as_str),
            "@statuses_json": statuses_json,
            "@trigger_kinds_json": trigger_kinds_json,
            "@started_after": started_after.as_ref().map(WireInstant::as_str),
            "@started_before": started_before.as_ref().map(WireInstant::as_str),
            "@definition_id": request
                .definition_id
                .map(|id| id.text())
                .as_ref()
                .map(UuidText::as_str),
            "@workflow_version_id": request
                .workflow_version_id
                .map(|id| id.text())
                .as_ref()
                .map(UuidText::as_str),
            "@after_started_at": after.as_ref().map(|after| after.started_at.as_str()),
            "@after_run_id": after
                .as_ref()
                .map(|after| after.workflow_run_id.text())
                .as_ref()
                .map(UuidText::as_str),
            "@page_row_limit": page_row_limit,
        })?;
        let mut total_count = None;
        let mut runs = Vec::new();
        let mut has_more = false;
        while let Some(row) = rows.next()? {
            if total_count.is_none() {
                total_count = Some(safe_int_column(row, column(row, "total_count")?)?);
            }
            // The anchor row alone, with no run, holds the total of an empty page.
            if row
                .get::<_, Option<String>>(column(row, "run_id")?)?
                .is_none()
            {
                continue;
            }
            if runs.len() == page_size {
                has_more = true;
                break;
            }
            runs.push(list_entry_from_row(row)?);
        }
        let next_cursor = if has_more {
            runs.last().map(|last: &StoredWorkflowRunListEntry| {
                encode_run_list_cursor(&last.run.started_at, last.run.workflow_run_id)
            })
        } else {
            None
        };
        Ok(StoredWorkflowRunListPage {
            runs,
            next_cursor,
            total_count: total_count.expect("the anchor row always answers the total"),
        })
    }
}

// A run list's place after the run a page ended on.
struct RunListPlace {
    started_at: WireInstant,
    workflow_run_id: WorkflowRunId,
}

/// The cursor naming the run a page ended on: its stored start and its id, which a later page
/// starts after.
fn encode_run_list_cursor(
    started_at: &WireInstant,
    workflow_run_id: WorkflowRunId,
) -> WorkflowRunListCursor {
    WorkflowRunListCursor::new(format!(
        "{}_{}",
        started_at.as_str(),
        workflow_run_id.text().as_str()
    ))
    .expect("a stored instant and a run id run to 61 characters, inside the cursor's bound")
}

// Reads a cursor back. Fails for one [`encode_run_list_cursor`] did not write: its start must be
// in the stored form and its id lowercase, so the cursor re-encodes to the same text.
fn decode_run_list_cursor(
    cursor: &WorkflowRunListCursor,
) -> Result<RunListPlace, WorkflowCursorUnresolvable> {
    let not_written =
        || WorkflowCursorUnresolvable::new(cursor.as_str(), UnresolvableCursorReason::NotWritten);
    let (started_at, run_id) = cursor.as_str().split_once('_').ok_or_else(not_written)?;
    let started_at = WireInstant::try_from(started_at.to_owned()).map_err(|_not_an_instant| {
        // The cursor's text is in the refusal; the failure names nothing more.
        not_written()
    })?;
    let workflow_run_id = WorkflowRunId::new(run_id).map_err(|_not_an_id| not_written())?;
    let place = RunListPlace {
        started_at,
        workflow_run_id,
    };
    if encode_run_list_cursor(&place.started_at, place.workflow_run_id).as_str() == cursor.as_str()
        && matches!(
            stored_instant_bound(&place.started_at),
            StoredInstantBound::At(ref stored) if stored == &place.started_at
        )
    {
        Ok(place)
    } else {
        Err(not_written())
    }
}

fn empty_page() -> StoredWorkflowRunListPage {
    StoredWorkflowRunListPage {
        runs: Vec::new(),
        next_cursor: None,
        total_count: SafeInt::new(0).expect("zero is a safe integer"),
    }
}

// One row past the page says whether another page follows.
fn page_size_plus_one(page_size: usize) -> u32 {
    u32::try_from(page_size.saturating_add(1)).unwrap_or(u32::MAX)
}

// A filter's closed set as the JSON array `json_each` reads.
fn json_list(values: &impl serde::Serialize) -> String {
    serde_json::to_string(values).expect("a list of closed-set words writes as JSON")
}

fn list_entry_from_row(row: &Row<'_>) -> rusqlite::Result<StoredWorkflowRunListEntry> {
    Ok(StoredWorkflowRunListEntry {
        run: stored_run_from_row(row)?,
        definition_name: row.get(column(row, "definition_name")?)?,
        step_count: safe_int_column(row, column(row, "step_count")?)?,
        wait_cause: optional_text_column(row, column(row, "waiting_cause")?, closed_word)?,
        resume_at: optional_text_column(
            row,
            column(row, "waiting_resume_at")?,
            WireInstant::try_from,
        )?,
    })
}

// The chain's first run, absent once it has been deleted.
fn chain_root_from_row(row: &Row<'_>) -> rusqlite::Result<Option<WorkflowChainRoot>> {
    let Some(run_id) = optional_text_column(row, column(row, "root_run_id")?, |text| {
        WorkflowRunId::new(&text)
    })?
    else {
        return Ok(None);
    };
    Ok(Some(WorkflowChainRoot {
        run_id,
        definition_id: text_column(row, column(row, "root_definition_id")?, |text| {
            WorkflowDefinitionId::new(&text)
        })?,
        workflow_name: text_column(row, column(row, "root_workflow_name")?, closed_word)?,
        started_at: text_column(row, column(row, "root_started_at")?, WireInstant::try_from)?,
        run_count: safe_int_column(row, column(row, "root_run_count")?)?,
    }))
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use proptest::prelude::*;
    use rstest::rstest;
    use sidekicks_contracts::wire::instant::WireInstant;
    use sidekicks_contracts::wire::integer::SafeInt;
    use sidekicks_contracts::workflow::run::id::WorkflowRunId;
    use sidekicks_contracts::workflow::run::list::{WorkflowRunListCursor, WorkflowRunListRequest};
    use sidekicks_contracts::workflow::run::status::WorkflowRunStatus;

    use super::{WorkflowRunStore, decode_run_list_cursor, encode_run_list_cursor};
    use crate::test_rows::{insert_run, insert_workflow_version, workflow_tables};

    const DEFINITION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e50";
    const VERSION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e51";

    fn every_run_request() -> WorkflowRunListRequest {
        serde_json::from_value(serde_json::json!({})).expect("an empty filter reads")
    }

    proptest! {
        /// Mutation: write the cursor's start in another form than the stored one, so the read
        /// refuses what the store wrote.
        #[test]
        fn a_written_cursor_reads_back_to_its_run(
            millisecond in 0_i64..253_402_300_799_999,
            id_bits in any::<u128>(),
        ) {
            let started_at = WireInstant::from_timestamp(
                jiff::Timestamp::from_millisecond(millisecond).expect("in range"),
            )
            .expect("after the year 0000");
            let workflow_run_id =
                WorkflowRunId::try_from(uuid::Builder::from_random_bytes(id_bits.to_le_bytes())
                    .into_uuid())
                    .expect("a random UUID is a run id");
            let cursor = encode_run_list_cursor(&started_at, workflow_run_id);
            let place = decode_run_list_cursor(&cursor).expect("a written cursor reads back");
            prop_assert_eq!(place.started_at, started_at);
            prop_assert_eq!(place.workflow_run_id, workflow_run_id);
        }
    }

    /// Mutation: accept a cursor that does not re-encode to its own text (an offset start, an
    /// uppercase id), so a page starts at a place no page ended on.
    #[rstest]
    #[case("2026-10-02T00:00:00Z_0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e52")]
    #[case("2026-10-02T02:00:00.000+02:00_0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e52")]
    #[case("2026-10-02T00:00:00.000Z_0199C1A2-7B3E-7C4D-8E5F-0A1B2C3D4E52")]
    #[case("2026-10-02T00:00:00.000Z0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e52")]
    #[case("2026-10-02T00:00:00.000Z_")]
    #[case("_0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e52")]
    #[case("2026-02-30T00:00:00.000Z_0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e52")]
    fn a_cursor_the_store_did_not_write_is_refused(#[case] text: &str) {
        let cursor = WorkflowRunListCursor::new(text.to_owned()).expect("a cursor's length");
        assert!(decode_run_list_cursor(&cursor).is_err());
    }

    /// Mutation: page on `<=` where `<` breaks ties, so a run sharing its start with the page's
    /// last run is listed twice.
    #[rstest]
    #[case(7, 1)]
    #[case(7, 2)]
    #[case(7, 3)]
    #[case(7, 7)]
    #[case(7, 8)]
    fn paging_lists_each_run_once_newest_first(#[case] run_count: u32, #[case] page_size: u64) {
        let connection = workflow_tables();
        insert_workflow_version(&connection, DEFINITION_ID, VERSION_ID, "Nightly");
        let mut stored = Vec::new();
        for index in 0..run_count {
            // Three runs share each start, so ties are broken by the id.
            let started_at = format!("2026-10-02T00:00:0{}.000Z", index / 3);
            let run_id = format!("0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4f{index:02x}");
            insert_run(
                &connection,
                &run_id,
                VERSION_ID,
                WorkflowRunStatus::Succeeded,
                &started_at,
                Some(&started_at),
            );
            stored.push((started_at, run_id));
        }
        stored.sort_by(|left, right| right.cmp(left));
        let store = WorkflowRunStore::new(&connection);
        let page_size = SafeInt::new(page_size).expect("a page size");
        let mut request = every_run_request();
        let mut listed = Vec::new();
        loop {
            let page = store.list(&request, page_size).expect("the page reads");
            assert_eq!(i64::from(page.total_count), i64::from(run_count));
            listed.extend(page.runs.iter().map(|entry| {
                (
                    entry.run.started_at.as_str().to_owned(),
                    entry.run.workflow_run_id.text().as_str().to_owned(),
                )
            }));
            match page.next_cursor {
                Some(cursor) => request.cursor = Some(cursor),
                None => break,
            }
        }
        assert_eq!(listed, stored);
        let unique: HashSet<_> = listed.iter().collect();
        assert_eq!(unique.len(), listed.len());
    }
}
