//! `question.resolve`: the person's answers to every question of one record, checked against its
//! pages before anything goes out. A question its run waits on gets its answers through the run's
//! driver first, or through the tool-server client when a tool server asked it; only then does
//! one write settle the record `answered`, append the person's turn and move the run back to
//! `running`, guarded so a second answer that raced the first, or the run's end, is refused whole
//! and reads the state back. Where no provider request holds the question, as after the daemon's
//! restart before its provider asked again, nothing goes out and the same write keeps the answer
//! for the question asked again and the run's continue. A question a workflow wait holds gets its
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
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::{MessageContent, UserMessageSentPayload};
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_provider::driver::contract::params_and_results::{
    ProviderRequestAnswer, RespondToRequestParams,
};
use sidekicks_provider::run::state_entry::RunStateEntry;
use sidekicks_store::database::connection::read_pool::ReadLength;
use sidekicks_store::events::session::appender::SessionEventDraft;

use crate::driver_resolution::read_run_driver;
use crate::questions::answer_text::compose_answer_text;
use crate::questions::kept_answers::insert_kept_answer_statement;
use crate::questions::schema::QuestionState;
use crate::questions::service::{
    HeldRequestAnswerer, QuestionError, QuestionResolution, QuestionsService,
};
use crate::questions::store::{
    QuestionHolder, question_input_digest, read_asked, read_question, settle_question_statement,
};
use crate::questions::waits::QuestionWaitAnswer;
use crate::run::state_change::{RunStateChange, RunStateChangeCompanions};

impl QuestionsService {
    /// Answers every question of `request`'s record from `device_id` and answers its state.
    /// Refused `question.notFound` for an id no record holds, `question.notWaiting` for a question
    /// its agent does not wait for, `question.waitingForRun` for one that still waits for its run,
    /// `question.answersIncomplete` for a list that does not answer every question and
    /// `question.answerInvalid` for an answer its question cannot take, each with nothing sent.
    /// Names the session and run of an answer kept because no provider request held its question.
    /// Fails as the driver or the wait fails, nothing written, or as the write fails after the
    /// answer went out.
    pub async fn resolve_question(
        &self,
        request: QuestionResolveRequest,
        device_id: DeviceId,
    ) -> Result<QuestionResolution, QuestionError> {
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
            return Ok(QuestionResolution {
                response: QuestionResolveResponse {
                    question_id,
                    state: settled,
                },
                kept: None,
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
        let (state, kept) = match stored.holder {
            QuestionHolder::Wait(wait_id) => (
                self.waits
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
                None,
            ),
            QuestionHolder::Run(run_id) => {
                self.answer_held(
                    question_id,
                    stored.session_id,
                    run_id,
                    asked_pages(&asked),
                    answers,
                    device_id,
                )
                .await?
            }
        };
        Ok(QuestionResolution {
            response: QuestionResolveResponse { question_id, state },
            kept,
        })
    }

    // The answers to whoever asked, the run's driver or the tool server through the tool-server
    // client, then the settle, the person's turn and the run's move in one write. Where no request
    // holds the question nothing goes out, and that write keeps the answer instead, or, where it
    // holds a secret, the answer is kept in memory once the write lands; answers the session and
    // run that keep it. A write refused after the answers went out, as when a second answer raced
    // them or the run ended meanwhile, reads the state back: the run's end settled it `canceled`.
    // The request is let go either way, since it has been answered.
    async fn answer_held(
        &self,
        question_id: QuestionId,
        session_id: SessionId,
        run_id: RunId,
        pages: &[QuestionPrompt],
        answers: Vec<QuestionAnswer>,
        device_id: DeviceId,
    ) -> Result<(QuestionSettledState, Option<(SessionId, RunId)>), QuestionError> {
        let message = MessageContent::new(compose_answer_text(&answers))
            .map_err(QuestionError::AnswerText)?;
        let mut statements = vec![settle_question_statement(
            &question_id,
            QuestionSettledState::Answered,
        )];
        let mut kept_secret = None;
        match self.held_request(&question_id) {
            Some(held) => {
                self.send_answers(run_id, held.request_id, &held.answered_by, answers)
                    .await?;
            }
            None if answers
                .iter()
                .any(|answer| matches!(answer, QuestionAnswer::Secret { .. })) =>
            {
                kept_secret = Some(answers);
            }
            None => statements.push(insert_kept_answer_statement(
                question_id,
                session_id,
                run_id,
                &answers,
            )),
        }
        let is_kept = statements.len() > 1 || kept_secret.is_some();
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
                plan_message: None,
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
                    statements,
                    preceding_events: vec![turn],
                    ..RunStateChangeCompanions::default()
                },
            )
            .await;
        let failure = match moved {
            Ok(_run) => {
                self.forget_held_request(&question_id);
                if let Some(answers) = kept_secret {
                    self.kept_secrets.keep(
                        question_id,
                        session_id,
                        run_id,
                        question_input_digest(pages),
                        answers,
                    );
                }
                let kept = is_kept.then_some((session_id, run_id));
                return Ok((QuestionSettledState::Answered, kept));
            }
            Err(failure) => failure,
        };
        let stored = self.read_state(question_id).await;
        self.forget_held_request(&question_id);
        stored?
            .and_then(settled_state)
            .map(|state| (state, None))
            .ok_or_else(|| failure.into())
    }

    /// Sends `answers` to `request_id` of `run_id` through `answered_by`: the run's driver, or the
    /// tool server whose task asked. Fails as the driver's lookup or the send fails.
    pub(super) async fn send_answers(
        &self,
        run_id: RunId,
        request_id: String,
        answered_by: &HeldRequestAnswerer,
        answers: Vec<QuestionAnswer>,
    ) -> Result<(), QuestionError> {
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
        Ok(())
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
            | QuestionError::AskedMissing { .. }
            | QuestionError::AnswerText(_)
            | QuestionError::WaitsUnregistered(_)
            | QuestionError::Wait(_)
            | QuestionError::ToolServerTask(_)
            | QuestionError::Read(_)
            | QuestionError::Database(_)
            | QuestionError::Write(_)) => Self::Internal(Box::new(fault)),
        }
    }
}

/// The pages of a record, in its order.
pub(crate) fn asked_pages(asked: &QuestionAskedPayload) -> &[QuestionPrompt] {
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
