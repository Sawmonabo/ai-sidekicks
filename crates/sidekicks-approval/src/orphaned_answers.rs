//! The orphaned answers: an answer to a card no live call held when the person gave it, kept so the
//! call made again and the run's continue each take it once.
//!
//! - The orphaned row is written in the answer's own write, so the answer never stands without it.
//!   A card answered while a live call held it has no row: that call took the answer.
//! - Each hand claims its mark before the answer goes out, so a stop between the two loses that
//!   hand and never repeats it. A continue that failed gives its mark back for the next continue.

use std::borrow::Cow;
use std::sync::{Arc, LazyLock};

use rusqlite::named_params;
use sidekicks_contracts::approval::{ApprovalDecision, ApprovalRequestId};
use sidekicks_contracts::free_form_string::FILE_PATH_MAX_LEN;
use sidekicks_contracts::release_manifest::Sha256Hex;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::{FreeFormText, NonEmptyText};
use sidekicks_store::database::connection::read_pool::{DatabaseReadPool, ReadLength};
use sidekicks_store::database::handed_mark::HandedMark;
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::database::writer::DatabaseWriter;

use crate::refusals::approval_persistence_unavailable;
use crate::service::ApprovalServiceError;
use crate::store::{SELECT_REQUESTS_SQL, StoredApprovalRequest, stored_request_of};

const INSERT_ORPHANED_ANSWER_SQL: &str = "INSERT INTO approval_orphaned_answers
    (approval_request_id, session_id, run_id, recorded_at)
  VALUES (@id, @session_id, @run_id, @recorded_at)";

const CALL_HAND: HandedMark = HandedMark {
    table: "approval_orphaned_answers",
    key_column: "approval_request_id",
    mark_column: "call_handed_at",
};

const CONTINUE_HAND: HandedMark = HandedMark {
    table: "approval_orphaned_answers",
    key_column: "approval_request_id",
    mark_column: "continue_handed_at",
};

static SELECT_ORPHANED_CALL_REQUESTS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "{SELECT_REQUESTS_SQL}
  JOIN approval_orphaned_answers AS orphaned ON orphaned.approval_request_id = request.id
  WHERE request.run_id = @run_id AND request.input_digest = @input_digest
    AND orphaned.call_handed_at IS NULL
  ORDER BY request.created_at, request.id"
    )
});

// An orphaned answer the call made again already took is not repeated to the agent, and a workflow
// step's card, which no agent's call holds (no ask and no tool call), is owed to no continue.
static SELECT_OWED_CONTINUES_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "{SELECT_REQUESTS_SQL}
  JOIN approval_orphaned_answers AS orphaned ON orphaned.approval_request_id = request.id
  WHERE orphaned.session_id = ? AND orphaned.continue_handed_at IS NULL
    AND orphaned.call_handed_at IS NULL
    AND (request.ask_id IS NOT NULL OR request.tool_call_id IS NOT NULL)
    AND resolution.request_id IS NOT NULL
  ORDER BY orphaned.recorded_at, request.id"
    )
});

/// An answer a run's continue still owes its agent: the card it answers and what the person said.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OwedContinue {
    /// The card.
    pub approval_request_id: ApprovalRequestId,
    /// The run the card held.
    pub run_id: RunId,
    /// The words the card named.
    pub subject: FreeFormText<FILE_PATH_MAX_LEN>,
    /// The tool the card held a call of, where it named one.
    pub tool_name: Option<NonEmptyText>,
    /// The person's answer.
    pub decision: ApprovalDecision,
    /// The `why not` words, on a decline that carried any.
    pub decline_reason: Option<NonEmptyText>,
    /// The command or path as the person corrected it, on an approval that corrected one.
    pub edited_action: Option<NonEmptyText>,
}

/// Reads the answers the runs' continues owe and claims each hand of an orphaned answer; shared by
/// `Arc`.
pub struct OrphanedAnswers {
    /// Where the orphaned answers are read.
    reads: Arc<DatabaseReadPool>,
    /// Where each hand is claimed.
    writer: Arc<DatabaseWriter>,
}

impl OrphanedAnswers {
    /// The orphaned answers, read through `reads` and claimed through `writer`.
    pub fn new(reads: Arc<DatabaseReadPool>, writer: Arc<DatabaseWriter>) -> Self {
        Self { reads, writer }
    }

    /// Every orphaned answer the session's runs' continues still owe, oldest first: one no call
    /// made again took, to a card an agent's call raised. Fails as the read fails.
    pub async fn owed_continues(
        &self,
        session_id: SessionId,
    ) -> Result<Vec<OwedContinue>, ApprovalServiceError> {
        let cards = self
            .reads
            .read(ReadLength::Short, move |connection| {
                Ok::<_, ApprovalServiceError>(
                    connection
                        .prepare_cached(&SELECT_OWED_CONTINUES_SQL)?
                        .query_map([session_id.text().as_str()], stored_request_of)?
                        .collect::<rusqlite::Result<Vec<_>>>()?,
                )
            })
            .await?;
        Ok(cards.into_iter().map(owed_continue_of).collect())
    }

    /// Claims the card's orphaned answer for a run's continue: true for the one caller that takes
    /// it, false once it was taken and for a card with no orphaned answer. Refuses
    /// `approval.persistenceUnavailable` when the claim could not be recorded.
    pub async fn claim_continue(
        &self,
        approval_request_id: ApprovalRequestId,
    ) -> Result<bool, ApprovalServiceError> {
        self.claim(CONTINUE_HAND, approval_request_id).await
    }

    /// Gives back a continue's claim on the card's orphaned answer, the continue having failed
    /// before it reached the agent, so the next continue takes it. Refuses
    /// `approval.persistenceUnavailable` when the release could not be recorded.
    pub async fn release_continue(
        &self,
        approval_request_id: ApprovalRequestId,
    ) -> Result<(), ApprovalServiceError> {
        CONTINUE_HAND
            .release(&self.writer, approval_request_id.text().as_str())
            .await
            .map_err(|failure| approval_persistence_unavailable(failure).into())
    }

    /// Claims the card's orphaned answer for the call made again, as [`Self::claim_continue`]
    /// claims it for a continue.
    pub(crate) async fn claim_call(
        &self,
        approval_request_id: ApprovalRequestId,
    ) -> Result<bool, ApprovalServiceError> {
        self.claim(CALL_HAND, approval_request_id).await
    }

    /// The run's answered asks of `input_digest` whose orphaned answer no call made again took yet,
    /// oldest first. Fails as the read fails.
    pub(crate) async fn read_call_requests(
        &self,
        run_id: RunId,
        input_digest: Sha256Hex,
    ) -> Result<Vec<StoredApprovalRequest>, ApprovalServiceError> {
        self.reads
            .read(ReadLength::Short, move |connection| {
                Ok::<_, ApprovalServiceError>(
                    connection
                        .prepare_cached(&SELECT_ORPHANED_CALL_REQUESTS_SQL)?
                        .query_map(
                            named_params! {
                                "@run_id": run_id.text().as_str(),
                                "@input_digest": input_digest.as_str(),
                            },
                            stored_request_of,
                        )?
                        .collect::<rusqlite::Result<Vec<_>>>()?,
                )
            })
            .await
    }

    // Takes `hand` of the card's orphaned answer, a failed write refused as unkept.
    async fn claim(
        &self,
        hand: HandedMark,
        approval_request_id: ApprovalRequestId,
    ) -> Result<bool, ApprovalServiceError> {
        hand.claim(&self.writer, approval_request_id.text().as_str())
            .await
            .map_err(|failure| approval_persistence_unavailable(failure).into())
    }
}

/// The statement that keeps the answer to `request`, which its run `run_id` holds, given at
/// `recorded_at`, in the answer's own write.
pub(crate) fn insert_orphaned_answer_statement(
    request: &StoredApprovalRequest,
    run_id: RunId,
    recorded_at: &WireInstant,
) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(INSERT_ORPHANED_ANSWER_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@id", request.approval_request_id.text().as_str()),
            text_binding("@session_id", request.session_id.text().as_str()),
            text_binding("@run_id", run_id.text().as_str()),
            text_binding("@recorded_at", recorded_at.as_str()),
        ]),
        expected_row_count: Some(1),
    }
}

fn owed_continue_of(card: StoredApprovalRequest) -> OwedContinue {
    let resolution = card
        .resolution
        .expect("the read takes only a card that holds its answer");
    OwedContinue {
        approval_request_id: card.approval_request_id,
        run_id: card
            .holder
            .run_id()
            .expect("an orphaned answer is kept only for a run's card"),
        subject: card.resource_descriptor.subject,
        tool_name: card.resource_descriptor.tool_name,
        decision: resolution.decision,
        decline_reason: resolution.decline_reason,
        edited_action: resolution.edited_action,
    }
}
