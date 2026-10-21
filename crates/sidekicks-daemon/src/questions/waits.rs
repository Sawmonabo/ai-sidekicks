//! Where `question.resolve` hands the answer to a question a workflow wait holds, so the wait that
//! asked settles it, through this door or the run page's own, whichever answers first.

use std::error::Error;

use futures::future::BoxFuture;
use sidekicks_contracts::question::{QuestionAnswer, QuestionId, QuestionSettledState};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::id::UuidTextForm;

/// The person's answers to a question a workflow wait holds.
#[derive(Debug)]
pub(crate) struct QuestionWaitAnswer {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The question.
    pub(crate) question_id: QuestionId,
    /// The wait that holds it.
    pub(crate) wait_id: UuidTextForm,
    /// One answer per question, in the record's order, already checked against its pages; a
    /// secret's value reaches only the wait.
    pub(crate) answers: Vec<QuestionAnswer>,
    /// The device that answered.
    pub(crate) device_id: DeviceId,
}

/// The workflow waits' answer intake, registered through a `PortRegistration` by the workflow
/// engine. Until it is registered, an answer to a wait's question is refused as a fault.
pub(crate) trait QuestionWaits: Send + Sync {
    /// Settles the question `answer` names at its wait and answers the record's state after: the
    /// state the other door left when it answered first. An error when the wait could not take it.
    fn answer_wait(
        &self,
        answer: QuestionWaitAnswer,
    ) -> BoxFuture<'_, Result<QuestionSettledState, Box<dyn Error + Send + Sync>>>;
}
