//! A question asked while its run waits on something else: another question, an approval or a
//! pause. It is recorded at once, waiting for its run, so the card shows it greyed; it opens, in
//! the write that moves its run to `waitingForInput` on it, once the run reads running; and it is
//! canceled, its run unmoved, when its provider withdraws it or its run ends first.

use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::question::{
    QuestionAskedState, QuestionCanceledReason, QuestionId, QuestionOpenedPayload,
    QuestionSettledState,
};
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;

use crate::events::session::appender::{SessionEventDraft, SessionEventLinkage};
use crate::provider::port::question::{ProviderQuestion, WaitingQuestionOpening};
use crate::questions::schema::QuestionState;
use crate::questions::service::{
    HeldRequestAnswerer, QuestionError, QuestionsService, canceled_event,
};
use crate::questions::store::{open_waiting_question_statement, settle_question_statement};
use crate::session::run::engine::RunEngineError;
use crate::session::run::state_change::{RunStateChange, RunStateChangeCompanions, RunStateEntry};

impl QuestionsService {
    /// Records `question`, its answer sent on by `answered_by`: open, as
    /// [`QuestionsService::take_question`] records it, when `may_open` and its run reads running,
    /// or when its agent does not wait; else waiting for its run. Fails as the record's write
    /// fails.
    pub(super) async fn record_question_in_turn(
        &self,
        question: ProviderQuestion,
        answered_by: HeldRequestAnswerer,
        may_open: bool,
    ) -> Result<QuestionAskedState, QuestionError> {
        if may_open || !question.is_agent_waiting {
            match self
                .take_question(question.clone(), answered_by.clone())
                .await
            {
                Ok(_question_id) => return Ok(QuestionAskedState::Open),
                // The run does not read running, so the question waits for it.
                Err(QuestionError::Engine(RunEngineError::Refused(_))) => {}
                Err(failure) => return Err(failure),
            }
        }
        self.record_question(question, answered_by, QuestionAskedState::WaitingForRun)
            .await?;
        Ok(QuestionAskedState::WaitingForRun)
    }

    /// Opens the question of `session_id` asked under `request_id` that waits for its run, in the
    /// write that moves the run from `running` to `waitingForInput` on it; while the run reads
    /// otherwise it waits on, and once the run has ended it is canceled. Fails as a read or a
    /// write fails for another reason, the question left waiting.
    pub(super) async fn open_waiting_question(
        &self,
        session_id: SessionId,
        request_id: &str,
    ) -> Result<WaitingQuestionOpening, QuestionError> {
        let Some(question_id) = self.held_question_of(session_id, request_id) else {
            return Ok(WaitingQuestionOpening::Settled);
        };
        let _question_hold = self.question_lock.acquire(question_id).await;
        let Some(held) = self.held_request(&question_id) else {
            return Ok(WaitingQuestionOpening::Settled);
        };
        if self.read_state(question_id).await? != Some(QuestionState::WaitingForRun) {
            self.forget_held_request(&question_id);
            return Ok(WaitingQuestionOpening::Settled);
        }
        let opened = SessionEventDraft::of_session(
            held.session_id,
            &SessionEvent::QuestionOpened(QuestionOpenedPayload {
                session_id: held.session_id,
                question_id,
            }),
        )?;
        let moved = self
            .engine
            .transition(
                RunStateChange {
                    expected_state: Some(RunState::Running),
                    ..RunStateChange::new(held.run_id, RunStateEntry::WaitingForInput)
                },
                RunStateChangeCompanions {
                    statements: vec![open_waiting_question_statement(&question_id)],
                    preceding_events: vec![opened],
                    ..RunStateChangeCompanions::default()
                },
            )
            .await;
        let failure = match moved {
            Ok(_run) => return Ok(WaitingQuestionOpening::Opened),
            Err(failure) => failure,
        };
        match self.read_state(question_id).await {
            Ok(Some(QuestionState::WaitingForRun)) => {}
            Ok(_settled) => {
                self.forget_held_request(&question_id);
                return Ok(WaitingQuestionOpening::Settled);
            }
            // The move's failure is the one the caller acts on; the read's is logged beside it.
            Err(read) => {
                tracing::warn!(
                    error = &read as &(dyn std::error::Error + 'static),
                    "a waiting question's state was not read after its opening failed"
                );
                return Err(failure.into());
            }
        }
        if !matches!(failure, RunEngineError::Refused(_)) {
            return Err(failure.into());
        }
        let run = self.engine.require_run(held.run_id).await?;
        if !run.state.is_terminal() {
            return Ok(WaitingQuestionOpening::RunNotRunning);
        }
        // Recorded after its run's end had settled the run's questions, so nothing else will.
        let reason = if run.state == RunState::Interrupted {
            QuestionCanceledReason::Interrupted
        } else {
            QuestionCanceledReason::RunEnded
        };
        self.cancel_waiting_question(question_id, held.session_id, reason)
            .await?;
        self.forget_held_request(&question_id);
        Ok(WaitingQuestionOpening::Settled)
    }

    /// Cancels `question_id` of `session_id`, which waits for its run, for `reason` in a write of
    /// its own, the run unmoved. Fails as the draft or the write fails.
    pub(super) async fn cancel_waiting_question(
        &self,
        question_id: QuestionId,
        session_id: SessionId,
        reason: QuestionCanceledReason,
    ) -> Result<(), QuestionError> {
        self.appender
            .append(
                canceled_event(session_id, question_id, reason)?,
                SessionEventLinkage {
                    transactional_prelude: vec![settle_question_statement(
                        &question_id,
                        QuestionSettledState::Canceled,
                    )],
                    ..SessionEventLinkage::default()
                },
            )
            .await?;
        Ok(())
    }
}
