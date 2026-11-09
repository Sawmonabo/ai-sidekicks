//! The reads of the cards workflow waits hold: the card a wait holds open, and the pending cards
//! no wait holds any more, which the restart withdraws.

use std::sync::LazyLock;

use rusqlite::{OptionalExtension as _, named_params};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::UuidTextForm;
use sidekicks_contracts::workflow::run::status::WorkflowStepStatus;
use sidekicks_store::database::stored_column::text_column;
use sidekicks_workflow::runs::record::{chain_question_waiting_condition, finished_run_condition};

use super::{
    ApprovalRequestReader, SELECT_REQUESTS_SQL, StoredApprovalRequest, pending, stored_request_of,
};

// The card a workflow wait holds open, through the open wait's unique index.
static SELECT_OPEN_WAIT_REQUEST_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "{SELECT_REQUESTS_SQL}
  WHERE request.session_id = @session_id AND request.wait_id = @wait_id
    AND request.state = '{}'",
        pending()
    )
});

// Reads each card beside its workflow run as `workflow_run`.
const WORKFLOW_RUN_JOIN_SQL: &str =
    "LEFT JOIN workflow_runs AS workflow_run ON workflow_run.id = request.workflow_run_id";

// A pending card of a workflow wait no one holds any more: its run is gone; a step's card's run
// has finished or no step waits on its wait; or a chain's card's question no longer waits.
static UNHELD_WAIT_REQUEST_CONDITION: LazyLock<String> = LazyLock::new(|| {
    format!(
        "request.wait_id IS NOT NULL AND request.state = '{pending}'
    AND (workflow_run.id IS NULL
         OR (request.node_id IS NOT NULL
             AND ({finished}
                  OR NOT EXISTS (SELECT 1 FROM workflow_steps AS step
                                  WHERE step.wait_id = request.wait_id
                                    AND step.status = '{waiting}')))
         OR (request.node_id IS NULL AND NOT {chain_waiting}))",
        pending = pending(),
        finished = finished_run_condition("workflow_run"),
        waiting = <&'static str>::from(WorkflowStepStatus::Waiting),
        chain_waiting = chain_question_waiting_condition("workflow_run.id"),
    )
});

// The unheld cards of one session, oldest first.
static SELECT_SESSION_UNHELD_WAIT_REQUESTS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "{SELECT_REQUESTS_SQL}
  {WORKFLOW_RUN_JOIN_SQL}
  WHERE {} AND request.session_id = @session_id
  ORDER BY request.created_at, request.id",
        *UNHELD_WAIT_REQUEST_CONDITION
    )
});

// The sessions holding an unheld card, each once.
static SELECT_SESSIONS_WITH_UNHELD_WAIT_REQUESTS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT DISTINCT request.session_id
  FROM approval_requests AS request
  {WORKFLOW_RUN_JOIN_SQL}
  WHERE {}",
        *UNHELD_WAIT_REQUEST_CONDITION
    )
});

impl ApprovalRequestReader<'_> {
    /// The card the workflow wait `wait_id` holds open in `session_id`, or `None` when it holds
    /// none.
    pub(crate) fn read_open_wait_request(
        &self,
        session_id: &SessionId,
        wait_id: &UuidTextForm,
    ) -> rusqlite::Result<Option<StoredApprovalRequest>> {
        self.reader
            .prepare_cached(&SELECT_OPEN_WAIT_REQUEST_SQL)?
            .query_row(
                named_params! {
                    "@session_id": session_id.text().as_str(),
                    "@wait_id": wait_id.text().as_str(),
                },
                stored_request_of,
            )
            .optional()
    }

    /// The pending cards of `session_id` whose workflow wait no one holds any more, oldest first:
    /// what a daemon that went down between a wait's end and its card's withdraw left.
    pub(crate) fn list_unheld_wait_requests(
        &self,
        session_id: &SessionId,
    ) -> rusqlite::Result<Vec<StoredApprovalRequest>> {
        self.reader
            .prepare_cached(&SELECT_SESSION_UNHELD_WAIT_REQUESTS_SQL)?
            .query_map(
                named_params! { "@session_id": session_id.text().as_str() },
                stored_request_of,
            )?
            .collect()
    }

    /// The sessions holding a pending card whose workflow wait no one holds any more, each once.
    pub fn list_sessions_with_unheld_wait_requests(&self) -> rusqlite::Result<Vec<SessionId>> {
        self.reader
            .prepare_cached(&SELECT_SESSIONS_WITH_UNHELD_WAIT_REQUESTS_SQL)?
            .query_map([], |row| text_column(row, 0, |text| SessionId::new(&text)))?
            .collect()
    }
}
