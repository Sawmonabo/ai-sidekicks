//! Where `question.resolve` hands the answer to a question a workflow wait holds, so the wait that
//! asked settles it, through this door or the run page's own, whichever answers first.

use std::error::Error;

use futures::future::BoxFuture;
use sidekicks_contracts::question::{
    QuestionAnswer, QuestionAnswerInvalidReason, QuestionId, WaitQuestionAskedPayload,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::id::UuidTextForm;

use crate::questions::QuestionSettledState;

/// The person's answers to a question a workflow wait holds.
#[derive(Debug)]
pub struct QuestionWaitAnswer {
    /// The session.
    pub session_id: SessionId,
    /// The question.
    pub question_id: QuestionId,
    /// The wait that holds it.
    pub wait_id: UuidTextForm,
    /// The record as it was asked: its pages and, for a form, its fields' schema.
    pub asked: WaitQuestionAskedPayload,
    /// One answer per question, in the record's order, already checked against its pages; a
    /// secret's value reaches only the wait.
    pub answers: Vec<QuestionAnswer>,
    /// The device that answered.
    pub device_id: DeviceId,
}

/// Why a workflow wait did not take the answers to its question.
#[derive(Debug, thiserror::Error)]
pub enum QuestionWaitError {
    /// The answer to the question at `page` is one its wait does not take; nothing was sent and
    /// the question stays open.
    #[error("the answer to page {page} does not fit its wait")]
    Refused {
        /// The question's index in the record.
        page: usize,
        /// Why.
        reason: QuestionAnswerInvalidReason,
    },
    /// No run the engine holds waits on the wait: its run ended, or is not loaded yet; nothing
    /// was taken and the question stays open.
    #[error("no run the engine holds waits on this question's wait")]
    NotHeld,
    /// The wait could not take the answers.
    #[error("the workflow wait did not take the answer")]
    Failed(#[source] Box<dyn Error + Send + Sync>),
}

/// The workflow waits' answer intake, registered through a `PortRegistration` by the workflow
/// engine. Until it is registered, an answer to a wait's question is refused as a fault.
pub trait QuestionWaits: Send + Sync {
    /// Settles the question `answer` names at its wait and answers the record's state after: the
    /// state the other door left when it answered first. Fails as [`QuestionWaitError`] says.
    fn answer_wait(
        &self,
        answer: QuestionWaitAnswer,
    ) -> BoxFuture<'_, Result<QuestionSettledState, QuestionWaitError>>;
}
