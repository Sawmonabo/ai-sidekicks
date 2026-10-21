//! Where a driver hands the structured questions a provider asks the person, so the questions card
//! asks them and the answer goes back through the driver's `respond_to_request`.

use std::error::Error;

use futures::future::BoxFuture;
use sidekicks_contracts::question::QuestionPrompt;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;

/// The questions one provider request asks, in its order, with the provider's own request id the
/// answer goes back under, and whether the agent waits for the answer.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ProviderQuestion {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The run that asks.
    pub(crate) run_id: RunId,
    /// The provider's own request id.
    pub(crate) request_id: String,
    /// The questions, in the request's order.
    pub(crate) questions: Vec<QuestionPrompt>,
    /// False only on a question the agent does not wait for: its run keeps running and the
    /// person's queued message answers it.
    pub(crate) is_agent_waiting: bool,
}

/// A question the provider withdrew before anyone answered it, by the request id it came under.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ProviderQuestionWithdrawal {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The provider's own request id.
    pub(crate) request_id: String,
}

/// The questions card's intake, registered through a `PortRegistration`. Until it is registered, a
/// question stays pending at the provider: nothing answers it.
pub(crate) trait QuestionPort: Send + Sync {
    /// Records `question`, whose answer comes later. An error when it could not be recorded.
    fn take_question(
        &self,
        question: ProviderQuestion,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>>;

    /// Settles a withdrawn question's card canceled. An error when it could not be settled.
    fn withdraw_question(
        &self,
        withdrawal: ProviderQuestionWithdrawal,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>>;
}
