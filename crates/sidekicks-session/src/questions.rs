//! Questions: the record of each question an agent, a tool server or a workflow step asks the
//! person, its turn when its run waits on something else, its answer, its cancellation, and the
//! queued messages that answer one its agent does not wait for.

pub(crate) mod answer_text;
pub mod projection;
pub(crate) mod resolve;
pub(crate) mod restart;
pub(crate) mod run_end;
pub mod schema;
pub mod service;
pub(crate) mod store;
pub(crate) mod waiting_for_run;
pub(crate) mod waits;

use sidekicks_contracts::question::QuestionResolveState;

/// A settled question's state as the store writes it: answered, or canceled with the turn that
/// held it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum QuestionSettledState {
    /// Answered.
    Answered,
    /// Canceled with the turn that held it.
    Canceled,
}

impl From<QuestionSettledState> for QuestionResolveState {
    fn from(state: QuestionSettledState) -> Self {
        match state {
            QuestionSettledState::Answered => Self::Answered,
            QuestionSettledState::Canceled => Self::Canceled,
        }
    }
}
