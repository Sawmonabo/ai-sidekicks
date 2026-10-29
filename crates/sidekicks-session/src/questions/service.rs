//! The question record's intake from the drivers: a question a provider asks is recorded open in
//! one write, which moves its run to `waitingForInput` when its agent waits, and a question the
//! provider withdraws is canceled in one write that moves its run back to `running`; one waiting
//! for its run is canceled with the run unmoved. The provider's request id is held in memory for
//! the answer and kept on the record, so a request its provider sends again after the daemon's
//! restart is held again for its open question, with no second record and the run unmoved.

use std::collections::HashMap;
use std::error::Error;
use std::sync::LazyLock;
use std::sync::{Arc, Mutex};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use rusqlite::{Connection, named_params};
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::question::{
    QuestionAskedPayload, QuestionAskedState, QuestionCanceledPayload, QuestionCanceledReason,
    QuestionId, QuestionSettledState, RunQuestionAskedPayload,
};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::{InterventionState, InterventionType};
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::list::BoundedVec;
use sidekicks_contracts::wire::text::{FreeFormText, TextError};
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_provider::driver::contract::error::DriverError;
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_provider::port::question::{
    ProviderQuestion, ProviderQuestionWithdrawal, QuestionPort, ToolServerQuestionAnswer,
    WaitingQuestionOpening,
};
use sidekicks_provider::run::state_entry::RunStateEntry;
use sidekicks_std::keyed_lock::KeyedLock;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::{PortRegistration, PortRegistrationError};
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::events::session::appender::{
    SessionEventAppendError, SessionEventAppender, SessionEventDraft, SessionEventDraftError,
    SessionEventLinkage,
};

use crate::driver_resolution::LiveRunDriverError;
use crate::questions::schema::QuestionState;
use crate::questions::store::{
    insert_question_statement, read_open_question_of_request, read_question, read_unsettled_among,
    settle_question_statement,
};
use crate::questions::waits::QuestionWaits;
use crate::run::engine::{RunEngine, RunEngineError};
use crate::run::state_change::{RunStateChange, RunStateChangeCompanions};

#[cfg(any(test, feature = "test-support"))]
pub mod test_fixture;
#[cfg(test)]
mod tests;

/// The statements [`QuestionsService`] prepares on a read connection: a record, its pages,
/// whether its run has an interrupt recorded, which held questions are still open, and the open
/// question a provider's request came on.
pub const QUESTION_STATEMENT_CAPACITY: usize = 5;

// Whether a person's or the daemon's interrupt of the run was asked for or carried out.
static RUN_INTERRUPTED_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT EXISTS (SELECT 1 FROM interventions
   WHERE target_run_id = @runId AND type = '{interrupt}'
     AND state IN ('{requested}', '{accepted}', '{applied}', '{degraded}'))",
        interrupt = <&'static str>::from(InterventionType::Interrupt),
        requested = <&'static str>::from(InterventionState::Requested),
        accepted = <&'static str>::from(InterventionState::Accepted),
        applied = <&'static str>::from(InterventionState::Applied),
        degraded = <&'static str>::from(InterventionState::Degraded)
    )
});

/// The provider request a held question's answer goes back under.
#[derive(Clone)]
pub(super) struct HeldRequest {
    /// The session.
    pub(super) session_id: SessionId,
    /// The run that holds it.
    pub(super) run_id: RunId,
    /// The provider's own request id.
    pub(super) request_id: String,
    /// Who sends the answer on.
    pub(super) answered_by: HeldRequestAnswerer,
    /// Whether its question's record is written; until then a read of the settled questions
    /// keeps it.
    pub(super) is_recorded: bool,
}

/// Who sends a held question's answer to whoever asked it.
#[derive(Clone)]
pub(super) enum HeldRequestAnswerer {
    /// The run's driver, to its provider.
    Driver,
    /// The tool-server client, to the server whose task asked.
    ToolServerTask(Arc<dyn ToolServerQuestionAnswer>),
}

/// Why a question was not recorded, answered or withdrawn; nothing of the failed write is kept.
#[derive(Debug, thiserror::Error)]
pub enum QuestionError {
    /// A refusal with its code.
    #[error(transparent)]
    Refused(#[from] DomainError),
    /// The run's move, with the record's write in it, was not written.
    #[error("the question's run move was not written")]
    Engine(#[from] RunEngineError),
    /// The record's write was not kept.
    #[error("the question's write was not kept")]
    Append(#[from] SessionEventAppendError),
    /// An event breaks a check of its type.
    #[error("the question's event could not be drafted")]
    Draft(#[from] SessionEventDraftError),
    /// The provider's request held no question.
    #[error("the provider's request {request_id} asks no question")]
    NoQuestions {
        /// The provider's request id.
        request_id: String,
    },
    /// The run's provider has no driver, or the run is bound to none.
    #[error(transparent)]
    NoDriver(#[from] LiveRunDriverError),
    /// The driver did not take the answer; nothing was written.
    #[error("the provider's driver did not take the answer")]
    Driver(#[from] DriverError),
    /// No provider request is held for an open question its run waits on.
    #[error("no provider request is held for question {question_id}")]
    RequestNotHeld {
        /// The question.
        question_id: QuestionId,
    },
    /// The log holds no `question.asked` for a recorded question.
    #[error("the log holds no question.asked for question {question_id}")]
    AskedMissing {
        /// The question.
        question_id: QuestionId,
    },
    /// The person's turn could not be written as message text.
    #[error("the answer's words cannot be a message")]
    AnswerText(#[source] TextError),
    /// The workflow waits' port is not registered.
    #[error(transparent)]
    WaitsUnregistered(#[from] PortRegistrationError),
    /// The workflow wait did not take the answer.
    #[error("the workflow wait did not take the answer")]
    Wait(#[source] Box<dyn Error + Send + Sync>),
    /// The tool server whose task asked could not be sent the answer; nothing was written.
    #[error("the tool server's task did not take the answer")]
    ToolServerTask(#[source] Box<dyn Error + Send + Sync>),
    /// A read of the question rows did not reach a connection.
    #[error(transparent)]
    Read(#[from] DatabaseReadError),
    /// SQLite refused a read, or a stored column does not read as its type.
    #[error("a read of the question rows failed")]
    Database(#[from] rusqlite::Error),
}

/// Records the questions the drivers hand, answers them and cancels the ones they withdraw.
pub struct QuestionsService {
    pub(super) appender: Arc<SessionEventAppender>,
    pub(super) reads: Arc<DatabaseReadPool>,
    pub(super) engine: Arc<RunEngine>,
    pub(super) providers: Arc<ProviderRegistry>,
    pub(super) waits: PortRegistration<Arc<dyn QuestionWaits>>,
    // Answers, withdrawals and takes of one question take turns.
    pub(super) question_lock: KeyedLock<QuestionId>,
    // Each open held question's provider request; never locked across an await.
    held_requests: Mutex<HashMap<QuestionId, HeldRequest>>,
    // Told each time a request is held or a question's record lands, so a test awaits either
    // instead of polling.
    #[cfg(test)]
    pub(super) held_or_recorded: tokio::sync::Notify,
}

/// The three ways a question's record is written: open, waiting for its run, or open where its
/// run reads running and else waiting for it.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum QuestionRecording {
    /// Open.
    Open,
    /// Waiting for its run.
    WaitingForRun,
    /// Open, else, where the run does not read running, waiting for it.
    OpenElseWaitingForRun,
}

impl QuestionsService {
    /// A service writing through `appender`, reading through `reads`, moving runs through
    /// `engine` and reaching each run's provider through its driver in `providers`.
    pub fn new(
        appender: Arc<SessionEventAppender>,
        reads: Arc<DatabaseReadPool>,
        engine: Arc<RunEngine>,
        providers: Arc<ProviderRegistry>,
    ) -> Self {
        Self {
            appender,
            reads,
            engine,
            providers,
            waits: PortRegistration::new("question waits"),
            question_lock: KeyedLock::new(),
            held_requests: Mutex::new(HashMap::new()),
            #[cfg(test)]
            held_or_recorded: tokio::sync::Notify::new(),
        }
    }

    /// The workflow waits' port, which the workflow engine registers once.
    #[expect(dead_code, reason = "the workflow engine, which registers its waits")]
    pub(crate) fn waits(&self) -> &PortRegistration<Arc<dyn QuestionWaits>> {
        &self.waits
    }

    /// Records `question` open under a minted id: when its agent waits, in the write that moves
    /// its run from `running` to `waitingForInput`, keeping its request for the answer, which
    /// `answered_by` sends on; else in a write of its own, the run unmoved. Fails as the draft,
    /// the move or the write fails.
    pub(super) async fn take_question(
        &self,
        question: ProviderQuestion,
        answered_by: HeldRequestAnswerer,
    ) -> Result<QuestionId, QuestionError> {
        let (question_id, _state) = self
            .record(question, answered_by, QuestionRecording::Open)
            .await?;
        Ok(question_id)
    }

    /// Records `question` under a minted id as `recording` names, holding its request, where its
    /// agent waits or it waits for its run, from before its record's write: a withdrawal that
    /// lands meanwhile finds the hold, waits on this question's lock for the record, and settles
    /// it. A refused open falls back to the waiting record under the same id and lock, its hold
    /// kept. An open one whose request no held question has, which the run's open question came
    /// on, is that question asked again: its request is held for it, with no second record and the
    /// run unmoved. Answers the id and the state recorded; fails as the read, the draft, the move
    /// or the write fails, the hold let go.
    pub(super) async fn record(
        &self,
        question: ProviderQuestion,
        answered_by: HeldRequestAnswerer,
        recording: QuestionRecording,
    ) -> Result<(QuestionId, QuestionAskedState), QuestionError> {
        let ProviderQuestion {
            session_id,
            run_id,
            request_id,
            questions,
            is_agent_waiting,
        } = question;
        let questions = BoundedVec::new(questions).ok_or_else(|| QuestionError::NoQuestions {
            request_id: request_id.clone(),
        })?;
        let mut state = match recording {
            QuestionRecording::Open | QuestionRecording::OpenElseWaitingForRun => {
                QuestionAskedState::Open
            }
            QuestionRecording::WaitingForRun => QuestionAskedState::WaitingForRun,
        };
        if state == QuestionAskedState::Open
            && let Some(question_id) = self
                .hold_open_question(session_id, run_id, &request_id, &answered_by)
                .await?
        {
            return Ok((question_id, state));
        }
        let question_id =
            QuestionId::try_from(mint_uuid_v7()).expect("a minted UUID is in a question id's form");
        let provider_request_id = FreeFormText::new(request_id.clone()).ok();
        let asked = |state| {
            QuestionAskedPayload::Run(RunQuestionAskedPayload {
                question_id,
                session_id,
                run_id,
                state,
                provider_request_id: provider_request_id.clone(),
                wait_id: None,
                is_agent_waiting,
                questions: questions.clone(),
            })
        };
        let is_run_moved = |state| is_agent_waiting && state == QuestionAskedState::Open;
        let held = HeldRequest {
            session_id,
            run_id,
            request_id,
            answered_by,
            is_recorded: false,
        };
        let _question_hold = self.question_lock.acquire(question_id).await;
        // Taken before the read of settled holds, which keeps a hold whose record is unwritten.
        if is_agent_waiting || state == QuestionAskedState::WaitingForRun {
            self.hold_request(question_id, held);
        }
        let mut recorded = match self.forget_settled_requests().await {
            Ok(()) => {
                self.write_record(asked(state), session_id, run_id, is_run_moved(state))
                    .await
            }
            Err(failure) => Err(failure),
        };
        if recording == QuestionRecording::OpenElseWaitingForRun
            && matches!(
                recorded,
                Err(QuestionError::Engine(RunEngineError::Refused(_)))
            )
        {
            // The run does not read running, so the question waits for it.
            state = QuestionAskedState::WaitingForRun;
            recorded = self
                .write_record(asked(state), session_id, run_id, is_run_moved(state))
                .await;
        }
        if let Err(failure) = recorded {
            self.forget_held_request(&question_id);
            return Err(failure);
        }
        if let Some(held) = lock(&self.held_requests).get_mut(&question_id) {
            held.is_recorded = true;
        }
        #[cfg(test)]
        self.held_or_recorded.notify_waiters();
        Ok((question_id, state))
    }

    // Writes `asked`'s record, in session `session_id`: where `is_run_moved`, in the write that
    // moves run `run_id` from `running` to `waitingForInput`; else in a write of its own.
    async fn write_record(
        &self,
        asked: QuestionAskedPayload,
        session_id: SessionId,
        run_id: RunId,
        is_run_moved: bool,
    ) -> Result<(), QuestionError> {
        let insert = insert_question_statement(&asked);
        let event = SessionEventDraft::of_session(session_id, &SessionEvent::QuestionAsked(asked))?;
        if is_run_moved {
            self.engine
                .transition(
                    RunStateChange {
                        expected_state: Some(RunState::Running),
                        ..RunStateChange::new(run_id, RunStateEntry::WaitingForInput)
                    },
                    RunStateChangeCompanions {
                        statements: vec![insert],
                        preceding_events: vec![event],
                        ..RunStateChangeCompanions::default()
                    },
                )
                .await
                .map(drop)
                .map_err(Into::into)
        } else {
            self.appender
                .append(
                    event,
                    SessionEventLinkage {
                        transactional_prelude: vec![insert],
                        ..SessionEventLinkage::default()
                    },
                )
                .await
                .map(drop)
                .map_err(Into::into)
        }
    }

    // Holds `request_id` again for the run's open question that came on it, as its provider sends a
    // waiting request again after the daemon's restart; answers that question, or `None` where a
    // held question has the request, none came on it, or it is held under another request here.
    async fn hold_open_question(
        &self,
        session_id: SessionId,
        run_id: RunId,
        request_id: &str,
        answered_by: &HeldRequestAnswerer,
    ) -> Result<Option<QuestionId>, QuestionError> {
        if self.held_question_of(session_id, request_id).is_some() {
            return Ok(None);
        }
        let read_request_id = request_id.to_owned();
        let Some(question_id) = self
            .reads
            .read(ReadLength::Short, move |reader| {
                Ok::<_, QuestionError>(read_open_question_of_request(
                    reader,
                    &run_id,
                    &read_request_id,
                )?)
            })
            .await?
        else {
            return Ok(None);
        };
        let _question_hold = self.question_lock.acquire(question_id).await;
        if self.held_request(&question_id).is_some()
            || self.read_state(question_id).await? != Some(QuestionState::Open)
        {
            return Ok(None);
        }
        self.hold_request(
            question_id,
            HeldRequest {
                session_id,
                run_id,
                request_id: request_id.to_owned(),
                answered_by: answered_by.clone(),
                is_recorded: true,
            },
        );
        Ok(Some(question_id))
    }

    /// Cancels the open question the provider asked under `withdrawal`'s request, in the write
    /// that moves its run back to `running`, or in a write of its own while it waits for its run:
    /// `interrupted` when the run has an interrupt recorded, else `withdrawn`. A question whose
    /// record is still being written is canceled once it lands. A request no open or waiting
    /// question holds, its question answered or settled by its run's end, or its record's write
    /// failed, is left as it is. Fails as the read or the move fails, the question left as it was.
    pub(crate) async fn withdraw_question(
        &self,
        withdrawal: ProviderQuestionWithdrawal,
    ) -> Result<(), QuestionError> {
        let Some(question_id) =
            self.held_question_of(withdrawal.session_id, &withdrawal.request_id)
        else {
            return Ok(());
        };
        let _question_hold = self.question_lock.acquire(question_id).await;
        let Some(held) = self.held_request(&question_id) else {
            return Ok(());
        };
        let run_id = held.run_id;
        let (is_interrupted, state) = self
            .reads
            .read(ReadLength::Short, move |reader| {
                Ok::<_, QuestionError>((
                    has_interrupt(reader, &run_id)?,
                    read_question(reader, &question_id)?.map(|stored| stored.state),
                ))
            })
            .await?;
        let reason = if is_interrupted {
            QuestionCanceledReason::Interrupted
        } else {
            QuestionCanceledReason::Withdrawn
        };
        if state == Some(QuestionState::WaitingForRun) {
            let canceled = self
                .cancel_waiting_question(question_id, held.session_id, reason)
                .await;
            // One its run's end canceled meanwhile stays as that end settled it.
            if let Err(failure) = canceled {
                match self.read_state(question_id).await {
                    Ok(Some(QuestionState::WaitingForRun)) => return Err(failure),
                    Ok(_settled) => {}
                    // The cancel's failure is the one the caller acts on; the read's is logged.
                    Err(read) => {
                        tracing::warn!(
                            error = &read as &(dyn Error + 'static),
                            "a waiting question's state was not read after its cancel failed"
                        );
                        return Err(failure);
                    }
                }
            }
            self.forget_held_request(&question_id);
            // Its take, waiting for the run, reads it settled and lets the run's line move on.
            self.engine.wake_running_waiters(&run_id);
            return Ok(());
        }
        let canceled = canceled_event(held.session_id, question_id, reason)?;
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
                        QuestionSettledState::Canceled,
                    )],
                    preceding_events: vec![canceled],
                    ..RunStateChangeCompanions::default()
                },
            )
            .await;
        if let Err(failure) = moved {
            // A question its run's end or an answer settled since stays as that settled it.
            if self.read_state(question_id).await? == Some(QuestionState::Open) {
                return Err(failure.into());
            }
        }
        self.forget_held_request(&question_id);
        Ok(())
    }

    // Lets go every held request whose question a run's end settled with no word from its driver,
    // so the map holds only open questions. A request taken after the read, or whose question's
    // record is still being written, is kept.
    async fn forget_settled_requests(&self) -> Result<(), QuestionError> {
        let held: Vec<QuestionId> = lock(&self.held_requests)
            .iter()
            .filter(|(_, held)| held.is_recorded)
            .map(|(question_id, _)| *question_id)
            .collect();
        if held.is_empty() {
            return Ok(());
        }
        let read_ids = held.clone();
        let open = self
            .reads
            .read(ReadLength::Short, move |reader| {
                Ok::<_, QuestionError>(read_unsettled_among(reader, &read_ids)?)
            })
            .await?;
        lock(&self.held_requests)
            .retain(|question_id, _| !held.contains(question_id) || open.contains(question_id));
        Ok(())
    }

    /// The question `session_id`'s provider asked under `request_id`, while its request is held.
    pub(super) fn held_question_of(
        &self,
        session_id: SessionId,
        request_id: &str,
    ) -> Option<QuestionId> {
        lock(&self.held_requests)
            .iter()
            .find(|(_, held)| held.session_id == session_id && held.request_id == request_id)
            .map(|(question_id, _)| *question_id)
    }

    /// Keeps `held`, the request `question_id`'s answer goes back under, until it settles.
    fn hold_request(&self, question_id: QuestionId, held: HeldRequest) {
        lock(&self.held_requests).insert(question_id, held);
        #[cfg(test)]
        self.held_or_recorded.notify_waiters();
    }

    /// The request `question_id`'s answer goes back under, while it is held.
    pub(super) fn held_request(&self, question_id: &QuestionId) -> Option<HeldRequest> {
        lock(&self.held_requests).get(question_id).cloned()
    }

    /// Lets go the request `question_id` was held under, once the question is settled.
    pub(super) fn forget_held_request(&self, question_id: &QuestionId) {
        lock(&self.held_requests).remove(question_id);
    }

    /// The state `question_id`'s row holds, or `None` when no row holds it.
    pub(super) async fn read_state(
        &self,
        question_id: QuestionId,
    ) -> Result<Option<QuestionState>, QuestionError> {
        self.reads
            .read(ReadLength::Short, move |reader| {
                Ok::<_, QuestionError>(
                    read_question(reader, &question_id)?.map(|stored| stored.state),
                )
            })
            .await
    }
}

impl QuestionPort for QuestionsService {
    fn take_tool_server_question(
        &self,
        question: ProviderQuestion,
        answer: Arc<dyn ToolServerQuestionAnswer>,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        QuestionsService::take_question(self, question, HeldRequestAnswerer::ToolServerTask(answer))
            .map(|taken| taken.map(drop).map_err(Into::into))
            .boxed()
    }

    fn record_question_in_turn(
        &self,
        question: ProviderQuestion,
        answer: Option<Arc<dyn ToolServerQuestionAnswer>>,
        may_open: bool,
    ) -> BoxFuture<'_, Result<QuestionAskedState, Box<dyn Error + Send + Sync>>> {
        let answered_by = answer.map_or(
            HeldRequestAnswerer::Driver,
            HeldRequestAnswerer::ToolServerTask,
        );
        QuestionsService::record_question_in_turn(self, question, answered_by, may_open)
            .map(|taken| taken.map_err(Into::into))
            .boxed()
    }

    fn open_waiting_question(
        &self,
        session_id: SessionId,
        request_id: String,
    ) -> BoxFuture<'_, Result<WaitingQuestionOpening, Box<dyn Error + Send + Sync>>> {
        async move {
            QuestionsService::open_waiting_question(self, session_id, &request_id)
                .await
                .map_err(Into::into)
        }
        .boxed()
    }

    fn wait_for_running_wake(
        &self,
        run_id: RunId,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        async move {
            self.engine
                .wait_for_running_wake(run_id)
                .await
                .map_err(Into::into)
        }
        .boxed()
    }

    fn wait_while_question_waits(
        &self,
        session_id: SessionId,
        request_id: String,
        run_id: RunId,
    ) -> BoxFuture<'_, Result<bool, Box<dyn Error + Send + Sync>>> {
        async move {
            QuestionsService::wait_while_question_waits(self, session_id, &request_id, run_id)
                .await
                .map_err(Into::into)
        }
        .boxed()
    }

    fn withdraw_question(
        &self,
        withdrawal: ProviderQuestionWithdrawal,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        QuestionsService::withdraw_question(self, withdrawal)
            .map(|withdrawn| withdrawn.map_err(Into::into))
            .boxed()
    }
}

/// Whether `run_id` has an interrupt asked for or carried out, so a question it withdraws was cut
/// by that interrupt. Fails as SQLite does.
pub(crate) fn has_interrupt(reader: &Connection, run_id: &RunId) -> rusqlite::Result<bool> {
    reader
        .prepare_cached(&RUN_INTERRUPTED_SQL)?
        .query_row(named_params! { "@runId": run_id.text().as_str() }, |row| {
            row.get(0)
        })
}

/// The `question.canceled` of `question_id` in `session_id`, for `reason`. Fails as the draft does.
pub(super) fn canceled_event(
    session_id: SessionId,
    question_id: QuestionId,
    reason: QuestionCanceledReason,
) -> Result<SessionEventDraft, SessionEventDraftError> {
    SessionEventDraft::of_session(
        session_id,
        &SessionEvent::QuestionCanceled(QuestionCanceledPayload {
            session_id,
            question_id,
            reason,
        }),
    )
}
