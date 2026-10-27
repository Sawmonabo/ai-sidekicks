//! `question.resolve`: the person's answers to every question of one record, checked against its
//! pages before anything goes out. A question its run waits on gets its answers through the run's
//! driver first, or through the tool-server client when a tool server asked it; only then does
//! one write settle the record `answered`, append the person's turn and move the run back to
//! `running`, guarded so a second answer that raced the first, or the run's end, is refused whole
//! and reads the state back. A question a workflow wait holds gets its
//! answers through the wait. A settled record answers its state and sends nothing.
//!
//! One window stays open on a provider that drops its own pending requests when its turn ends and
//! drops a late answer with no word back: an answer that reaches the driver in that window returns
//! with no failure, and the record keeps `answered` and the person's turn for words the agent never
//! read. The guard keeps the record whole; it does not close the window.

use serde_json::json;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::question::{
    QuestionAnswer, QuestionAnswerInvalidReason, QuestionAskedPayload, QuestionId, QuestionPrompt,
    QuestionResolveRequest, QuestionResolveResponse, QuestionSettledState,
};
use sidekicks_contracts::run::queue::{MessageContent, UserMessageSentPayload};
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::driver_resolution::read_run_driver;
use crate::questions::answer_text::compose_answer_text;
use crate::questions::schema::QuestionState;
use crate::questions::service::{
    HeldRequest, HeldRequestAnswerer, QuestionError, QuestionsService,
};
use crate::questions::store::{
    QuestionHolder, read_asked, read_question, settle_question_statement,
};
use crate::questions::waits::QuestionWaitAnswer;
use crate::run::state_change::{RunStateChange, RunStateChangeCompanions};
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_provider::driver::contract::{ProviderRequestAnswer, RespondToRequestParams};
use sidekicks_provider::run::state_entry::RunStateEntry;
use sidekicks_store::database::connection::read_pool::ReadLength;
use sidekicks_store::events::session::appender::SessionEventDraft;

impl QuestionsService {
    /// Answers every question of `request`'s record from `device_id` and answers its state.
    /// Refused `question.notFound` for an id no record holds, `question.notWaiting` for a question
    /// its agent does not wait for, `question.waitingForRun` for one that still waits for its run,
    /// `question.answersIncomplete` for a list that does not answer every question and
    /// `question.answerInvalid` for an answer its question cannot take, each with nothing sent.
    /// Fails as the driver or the wait fails, nothing written, or as the write fails after the
    /// answer went out.
    pub(crate) async fn resolve_question(
        &self,
        request: QuestionResolveRequest,
        device_id: DeviceId,
    ) -> Result<QuestionResolveResponse, QuestionError> {
        let question_id = request.question_id;
        let answers = request.answers.into_vec();
        let _question_hold = self.question_lock.acquire(question_id).await;
        let (stored, asked) = self
            .reads
            .read(ReadLength::Short, move |reader| {
                let Some(stored) = read_question(reader, &question_id)? else {
                    return Err(QuestionError::from(question_not_found(question_id)));
                };
                let asked = read_asked(reader, stored.session_id, &question_id)?;
                Ok((stored, asked))
            })
            .await?;
        if let Some(settled) = settled_state(stored.state) {
            return Ok(QuestionResolveResponse {
                question_id,
                state: settled,
            });
        }
        if !stored.is_agent_waiting {
            return Err(question_not_waiting(question_id).into());
        }
        if stored.state == QuestionState::WaitingForRun {
            return Err(question_waiting_for_run(question_id).into());
        }
        let asked = asked.ok_or(QuestionError::AskedMissing { question_id })?;
        check_answers(question_id, asked_pages(&asked), &answers)?;
        let state = match stored.holder {
            QuestionHolder::Wait(wait_id) => self
                .waits
                .require_port()?
                .answer_wait(QuestionWaitAnswer {
                    session_id: stored.session_id,
                    question_id,
                    wait_id,
                    answers,
                    device_id,
                })
                .await
                .map_err(QuestionError::Wait)?,
            QuestionHolder::Run(_) => self.answer_held(question_id, answers, device_id).await?,
        };
        Ok(QuestionResolveResponse { question_id, state })
    }

    // The answers to whoever asked, the run's driver or the tool server through the tool-server
    // client, then the settle, the person's turn and the run's move in one write. A write refused
    // after the answers went out, as when a second answer raced them or the run ended meanwhile,
    // reads the state back: the run's end settled it `canceled`. The request is let go either way,
    // since it has been answered.
    async fn answer_held(
        &self,
        question_id: QuestionId,
        answers: Vec<QuestionAnswer>,
        device_id: DeviceId,
    ) -> Result<QuestionSettledState, QuestionError> {
        let HeldRequest {
            session_id,
            run_id,
            request_id,
            answered_by,
        } = self
            .held_request(&question_id)
            .ok_or(QuestionError::RequestNotHeld { question_id })?;
        let message = MessageContent::new(compose_answer_text(&answers))
            .map_err(QuestionError::AnswerText)?;
        match answered_by {
            HeldRequestAnswerer::Driver => {
                let driver =
                    read_run_driver::<QuestionError>(&self.reads, &self.providers, run_id).await?;
                driver
                    .respond_to_request(RespondToRequestParams {
                        run_id,
                        request_id,
                        response: ProviderRequestAnswer::Question { answers },
                    })
                    .await?;
            }
            HeldRequestAnswerer::ToolServerTask(answer) => answer
                .answer(answers)
                .await
                .map_err(QuestionError::ToolServerTask)?,
        }
        let turn = SessionEventDraft::new(
            UserMessageSentPayload {
                session_id,
                queue_item_id: None,
                run_id: Some(run_id),
                actor: FreeFormText::new(device_id.as_str().to_owned())
                    .expect("a device id is a short, printable actor"),
                device_id: Some(device_id),
                message,
                origin: None,
                answers_question_id: Some(question_id),
            },
            SessionEvent::UserMessageSent,
        )?;
        let moved = self
            .engine
            .transition(
                RunStateChange {
                    expected_state: Some(RunState::WaitingForInput),
                    ..RunStateChange::new(
                        run_id,
                        RunStateEntry::Running {
                            execution_posture: None,
                        },
                    )
                },
                RunStateChangeCompanions {
                    statements: vec![settle_question_statement(
                        &question_id,
                        QuestionSettledState::Answered,
                    )],
                    preceding_events: vec![turn],
                    ..RunStateChangeCompanions::default()
                },
            )
            .await;
        let failure = match moved {
            Ok(_run) => {
                self.forget_held_request(&question_id);
                return Ok(QuestionSettledState::Answered);
            }
            Err(failure) => failure,
        };
        let stored = self.read_state(question_id).await;
        self.forget_held_request(&question_id);
        stored?
            .and_then(settled_state)
            .ok_or_else(|| failure.into())
    }
}

impl From<QuestionError> for HandlerError {
    /// A refusal answers the call by its code, a driver's or a lookup's failure as each answers;
    /// the rest are faults in the daemon.
    fn from(error: QuestionError) -> Self {
        match error {
            QuestionError::Refused(refusal) => Self::Refused(refusal),
            QuestionError::NoDriver(lookup) => lookup.into(),
            QuestionError::Driver(driver) => driver.into(),
            fault @ (QuestionError::Engine(_)
            | QuestionError::Append(_)
            | QuestionError::Draft(_)
            | QuestionError::NoQuestions { .. }
            | QuestionError::RequestNotHeld { .. }
            | QuestionError::AskedMissing { .. }
            | QuestionError::AnswerText(_)
            | QuestionError::WaitsUnregistered(_)
            | QuestionError::Wait(_)
            | QuestionError::ToolServerTask(_)
            | QuestionError::Read(_)
            | QuestionError::Database(_)) => Self::Internal(Box::new(fault)),
        }
    }
}

// The pages of a record, in its order.
fn asked_pages(asked: &QuestionAskedPayload) -> &[QuestionPrompt] {
    match asked {
        QuestionAskedPayload::Run(asked) => asked.questions.as_slice(),
        QuestionAskedPayload::Wait(asked) => asked.questions.as_slice(),
    }
}

// The settled state a row's word reads as; none while it is open or waits for its run.
fn settled_state(state: QuestionState) -> Option<QuestionSettledState> {
    match state {
        QuestionState::WaitingForRun | QuestionState::Open => None,
        QuestionState::Answered => Some(QuestionSettledState::Answered),
        QuestionState::Canceled => Some(QuestionSettledState::Canceled),
    }
}

// Refuses a list that does not answer every page, then the first answer its page cannot take.
fn check_answers(
    question_id: QuestionId,
    pages: &[QuestionPrompt],
    answers: &[QuestionAnswer],
) -> Result<(), DomainError> {
    if answers.len() != pages.len() {
        return Err(DomainError::new(
            "Every question of the record takes one answer",
            RefusalCode::QuestionAnswersIncomplete,
        )
        .with_detail(json!({
            "questionId": question_id,
            "questionCount": pages.len(),
            "answerCount": answers.len(),
        })));
    }
    for (page, (prompt, answer)) in pages.iter().zip(answers).enumerate() {
        if let Some(reason) = refused_answer(prompt, answer) {
            return Err(DomainError::new(
                "An answer does not fit its question",
                RefusalCode::QuestionAnswerInvalid,
            )
            .with_detail(json!({ "questionId": question_id, "page": page, "reason": reason })));
        }
    }
    Ok(())
}

// Why `prompt` cannot take `answer`, if it cannot: a secret question takes only a secret or a
// skip, and only it takes a secret; picked labels must be offered, one unless several are; typed
// text fits any question but a form field whose options are its only values.
fn refused_answer(
    prompt: &QuestionPrompt,
    answer: &QuestionAnswer,
) -> Option<QuestionAnswerInvalidReason> {
    match answer {
        QuestionAnswer::Skipped {} => None,
        QuestionAnswer::Secret { .. } => {
            (!prompt.secret).then_some(QuestionAnswerInvalidReason::SecretOnPlain)
        }
        QuestionAnswer::Picked { .. } | QuestionAnswer::Typed { .. } if prompt.secret => {
            Some(QuestionAnswerInvalidReason::SecretOnPlain)
        }
        QuestionAnswer::Picked { labels } => {
            let labels = labels.as_slice();
            if labels
                .iter()
                .any(|label| !prompt.options.iter().any(|option| option.label == *label))
            {
                Some(QuestionAnswerInvalidReason::LabelNotOffered)
            } else if labels.len() > 1 && !prompt.several_answers {
                Some(QuestionAnswerInvalidReason::SeveralOnSingle)
            } else {
                None
            }
        }
        QuestionAnswer::Typed { .. } => (!prompt.options.is_empty() && prompt.required.is_some())
            .then_some(QuestionAnswerInvalidReason::TextOnChoice),
    }
}

/// `question.notFound` for an id no record holds.
pub(crate) fn question_not_found(question_id: QuestionId) -> DomainError {
    DomainError::new(
        "This daemon holds no such question",
        RefusalCode::QuestionNotFound,
    )
    .with_detail(json!({ "questionId": question_id }))
}

/// `question.notWaiting` for a question its agent does not wait for, which a queued message
/// answers instead.
pub(crate) fn question_not_waiting(question_id: QuestionId) -> DomainError {
    DomainError::new(
        "The agent does not wait for this question; a message answers it",
        RefusalCode::QuestionNotWaiting,
    )
    .with_detail(json!({ "questionId": question_id }))
}

// `question.waitingForRun` for a question that waits for its run, which takes no answer until the
// run reads running and the question opens.
fn question_waiting_for_run(question_id: QuestionId) -> DomainError {
    DomainError::new(
        "The question waits for its run and takes its answer once the run reaches it",
        RefusalCode::QuestionWaitingForRun,
    )
    .with_detail(json!({ "questionId": question_id }))
}
