//! `question.resolve`: the person's answers to every question of one record, checked against its
//! pages before anything goes out. A question its run waits on gets its answers through the run's
//! driver first, or through the tool-server client when a tool server asked it; only then does
//! one write settle the record `answered`, append the person's turn and move the run back to
//! `running`, guarded so a second answer that raced the first, or the run's end, is refused whole
//! and reads the state back. Where no provider request holds the question, as after the daemon's
//! restart before its provider asked again, nothing goes out and the same write keeps it as an
//! orphaned answer for the question asked again and the run's continue. An answer the tool server
//! keeps for its next ask leaves the question open and its run waiting until that ask takes it,
//! when the same one write settles it. A question a workflow wait holds gets its answers through
//! the wait. A settled record answers its state and sends nothing.
//!
//! One window stays open on a provider that drops its own pending requests when its turn ends and
//! drops a late answer with no word back: an answer that reaches the driver in that window returns
//! with no failure, and the record keeps `answered` and the person's turn for words the agent never
//! read. The guard keeps the record whole; it does not close the window.

use serde_json::json;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::question::{
    QuestionAnswer, QuestionAnswerInvalidReason, QuestionAskedPayload, QuestionId, QuestionKind,
    QuestionPrompt, QuestionResolveRequest, QuestionResolveResponse, QuestionResolveState,
    read_typed_flag, read_typed_number,
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
use sidekicks_provider::port::question::ToolServerAnswerDelivery;
use sidekicks_provider::run::state_entry::RunStateEntry;
use sidekicks_store::database::connection::read_pool::ReadLength;
use sidekicks_store::events::session::appender::SessionEventDraft;

use crate::driver_resolution::read_run_driver;
use crate::questions::QuestionSettledState;
use crate::questions::answer_text::compose_answer_text;
use crate::questions::orphaned_answers::insert_orphaned_answer_statement;
use crate::questions::schema::QuestionState;
use crate::questions::service::{
    HeldRequestAnswerer, KeptAnswer, QuestionError, QuestionResolution, QuestionsService,
};
use crate::questions::store::{
    QuestionHolder, question_input_digest, read_asked, read_question, settle_question_statement,
};
use crate::questions::waits::QuestionWaitAnswer;
use crate::run::state_change::{RunStateChange, RunWriteCompanions};

// An orphaned answer, which no provider request took, kept by the write that settles its
// question: the pages of the question asked again that takes it, and the answers.
struct OrphanedAnswer<'a> {
    pages: &'a [QuestionPrompt],
    answers: Vec<QuestionAnswer>,
}

impl QuestionsService {
    /// Answers every question of `request`'s record from `device_id` and answers its state, or
    /// `kept` for an answer the tool server kept for its next ask, the question left open.
    /// Refused `question.notFound` for an id no record holds, `question.notWaiting` for a question
    /// its agent does not wait for, `question.waitingForRun` for one that still waits for its run,
    /// `question.answersIncomplete` for a list that does not answer every question and
    /// `question.answerInvalid` for an answer its question cannot take, each with nothing sent.
    /// Names the session and run of an orphaned answer, kept because no provider request held its
    /// question.
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
                    state: settled.into(),
                },
                orphaned: None,
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
        let (state, orphaned): (QuestionResolveState, _) = match stored.holder {
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
                    .map_err(QuestionError::Wait)?
                    .into(),
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
            orphaned,
        })
    }

    // The answers to whoever asked, the run's driver or the tool server through the tool-server
    // client, then the settle, the person's turn and the run's move in one write. An answer the
    // tool server kept for its next ask is held with its turn and its device, the question left
    // open and nothing written. Where no request holds the question nothing goes out, and that
    // write keeps the answer instead; answers the session and run that keep it.
    async fn answer_held(
        &self,
        question_id: QuestionId,
        session_id: SessionId,
        run_id: RunId,
        pages: &[QuestionPrompt],
        answers: Vec<QuestionAnswer>,
        device_id: DeviceId,
    ) -> Result<(QuestionResolveState, Option<(SessionId, RunId)>), QuestionError> {
        let message = MessageContent::new(compose_answer_text(&answers))
            .map_err(QuestionError::AnswerText)?;
        let Some(held) = self.held_request(&question_id) else {
            let orphaned = OrphanedAnswer { pages, answers };
            let (state, is_orphaned) = self
                .settle_answered(
                    question_id,
                    session_id,
                    run_id,
                    message,
                    device_id,
                    Some(orphaned),
                )
                .await?;
            return Ok((state.into(), is_orphaned.then_some((session_id, run_id))));
        };
        let delivery = self
            .send_answers(run_id, held.request_id, &held.answered_by, answers)
            .await?;
        let state = match delivery {
            ToolServerAnswerDelivery::Delivered => {
                self.settle_answered(question_id, session_id, run_id, message, device_id, None)
                    .await?
                    .0
            }
            ToolServerAnswerDelivery::Kept => {
                if self.keep_answer(&question_id, KeptAnswer { message, device_id }) {
                    return Ok((QuestionResolveState::Kept, None));
                }
                // Let go meanwhile: the question was settled, so its state is read back.
                self.read_state(question_id)
                    .await?
                    .and_then(settled_state)
                    .ok_or(QuestionError::RequestNotHeld { question_id })?
            }
        };
        Ok((state.into(), None))
    }

    /// Settles answered the open question `session_id`'s tool server asked under `request_id`,
    /// whose answer was kept, in one write with the person's turn and the run's move, a question
    /// no longer held left as it is. Fails with [`QuestionError::AnswerNotKept`] when no answer
    /// was kept, and as the write fails.
    pub(crate) async fn settle_kept_answer(
        &self,
        session_id: SessionId,
        request_id: &str,
    ) -> Result<(), QuestionError> {
        let Some(question_id) = self.held_question_of(session_id, request_id) else {
            return Ok(());
        };
        let _question_hold = self.question_lock.acquire(question_id).await;
        let Some(held) = self.held_request(&question_id) else {
            return Ok(());
        };
        let KeptAnswer { message, device_id } = held
            .kept_answer
            .ok_or(QuestionError::AnswerNotKept { question_id })?;
        self.settle_answered(
            question_id,
            held.session_id,
            held.run_id,
            message,
            device_id,
            None,
        )
        .await?;
        Ok(())
    }

    // The settle `answered`, the person's turn and the run's move back to `running` in one write,
    // with `keep`'s answer kept where no request took it: its row in that write, or, where it
    // holds a secret, in memory once the write lands. A write refused, as when a second answer
    // raced it or the run ended meanwhile, reads the state back: the run's end settled it
    // `canceled`. The request is let go either way, since it has been answered. Answers the state
    // and whether this write kept the answer.
    async fn settle_answered(
        &self,
        question_id: QuestionId,
        session_id: SessionId,
        run_id: RunId,
        message: MessageContent,
        device_id: DeviceId,
        orphaned: Option<OrphanedAnswer<'_>>,
    ) -> Result<(QuestionSettledState, bool), QuestionError> {
        let mut statements = vec![settle_question_statement(
            &question_id,
            QuestionSettledState::Answered,
        )];
        let is_orphaned = orphaned.is_some();
        let mut orphaned_secret = None;
        if let Some(OrphanedAnswer { pages, answers }) = orphaned {
            if answers
                .iter()
                .any(|answer| matches!(answer, QuestionAnswer::Secret { .. }))
            {
                orphaned_secret = Some((pages, answers));
            } else {
                statements.push(insert_orphaned_answer_statement(
                    question_id,
                    session_id,
                    run_id,
                    &answers,
                ));
            }
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
                RunWriteCompanions {
                    statements,
                    preceding_events: vec![turn],
                    ..RunWriteCompanions::default()
                },
            )
            .await;
        let failure = match moved {
            Ok(_run) => {
                self.forget_held_request(&question_id);
                if let Some((pages, answers)) = orphaned_secret {
                    self.orphaned_secrets.record(
                        question_id,
                        session_id,
                        run_id,
                        question_input_digest(pages),
                        answers,
                    );
                }
                return Ok((QuestionSettledState::Answered, is_orphaned));
            }
            Err(failure) => failure,
        };
        let stored = self.read_state(question_id).await;
        self.forget_held_request(&question_id);
        stored?
            .and_then(settled_state)
            .map(|state| (state, false))
            .ok_or_else(|| failure.into())
    }

    /// Sends `answers` to `request_id` of `run_id` through `answered_by`: the run's driver, or the
    /// tool server whose task asked, which answers whether a waiting request took them or it kept
    /// them for its next ask. Fails as the driver's lookup or the send fails.
    pub(super) async fn send_answers(
        &self,
        run_id: RunId,
        request_id: String,
        answered_by: &HeldRequestAnswerer,
        answers: Vec<QuestionAnswer>,
    ) -> Result<ToolServerAnswerDelivery, QuestionError> {
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
                Ok(ToolServerAnswerDelivery::Delivered)
            }
            HeldRequestAnswerer::ToolServerTask(answer) => answer
                .answer(answers)
                .await
                .map_err(QuestionError::ToolServerTask),
        }
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
            | QuestionError::AnswerNotKept { .. }
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
// text fits any question but a form field whose options are its only values, and on a number
// question it must spell a number.
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
        QuestionAnswer::Typed { .. } if !prompt.options.is_empty() && prompt.required.is_some() => {
            Some(QuestionAnswerInvalidReason::TextOnChoice)
        }
        QuestionAnswer::Typed { text } => refused_typed_text(prompt.kind, text.as_str()),
    }
}

// Why typed `text` is no value of a question of `kind`, by the kind's own refusal; `None` where it
// is one, and for a kind that takes any text.
fn refused_typed_text(kind: QuestionKind, text: &str) -> Option<QuestionAnswerInvalidReason> {
    match kind {
        QuestionKind::Number => read_typed_number(text)
            .is_none()
            .then_some(QuestionAnswerInvalidReason::NotANumber),
        QuestionKind::Integer => match read_typed_number(text) {
            None => Some(QuestionAnswerInvalidReason::NotANumber),
            Some(number) if number.fract() != 0.0 => {
                Some(QuestionAnswerInvalidReason::NotAWholeNumber)
            }
            Some(_) => None,
        },
        QuestionKind::Flag => read_typed_flag(text)
            .is_none()
            .then_some(QuestionAnswerInvalidReason::NotAFlag),
        QuestionKind::Choice | QuestionKind::Text => None,
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

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::json;
    use sidekicks_contracts::question::{
        QuestionAnswer, QuestionAnswerInvalidReason, QuestionPrompt,
    };

    use super::refused_answer;

    // A question with no range refuses typed text that is no value of its kind and takes one, by
    // its kind alone, since a wrong answer would reach the provider as a value it did not ask
    // for. Killed by reading a number question from its bounds, by dropping a kind's check, and
    // by a whole number read as any number.
    #[rstest]
    #[case::words("number", "ten", Some(QuestionAnswerInvalidReason::NotANumber))]
    #[case::a_number("number", "1.5", None)]
    #[case::a_fraction_for_a_whole_number(
        "integer",
        "1.5",
        Some(QuestionAnswerInvalidReason::NotAWholeNumber)
    )]
    #[case::words_for_a_whole_number(
        "integer",
        "ten",
        Some(QuestionAnswerInvalidReason::NotANumber)
    )]
    #[case::a_whole_number("integer", "10", None)]
    #[case::maybe_for_a_flag("flag", "maybe", Some(QuestionAnswerInvalidReason::NotAFlag))]
    #[case::a_flag("flag", " true ", None)]
    fn a_question_with_no_range_takes_only_a_value_of_its_kind(
        #[case] kind: &str,
        #[case] typed: &str,
        #[case] refused: Option<QuestionAnswerInvalidReason>,
    ) {
        let prompt: QuestionPrompt = serde_json::from_value(json!({
            "text": "How many retries?",
            "kind": kind,
            "options": [],
            "severalAnswers": false,
            "secret": false,
        }))
        .expect("a number question reads");
        let answer: QuestionAnswer =
            serde_json::from_value(json!({ "kind": "typed", "text": typed }))
                .expect("typed text reads");

        assert_eq!(refused_answer(&prompt, &answer), refused);
    }
}
