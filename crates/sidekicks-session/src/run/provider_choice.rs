//! A person's answer to a choice the provider holds a run on: the retry-or-edit choice on a
//! refused turn and the switch-or-credits choice on a turn whose model needs usage credits. The
//! first answer settles the choice; the run's driver is found only once the run is found waiting
//! on the choice, the answer goes to the provider before anything is written, and the settlement
//! row and the run's move commit in one write, guarded so a second settlement of the same request
//! is refused whole. An answer the provider got with no reply back is held, the run left waiting,
//! until the provider's report on the run or its answer to a second one shows what it did; one
//! whose report moved the run without it settles as its settlement event alone.

use std::borrow::Cow;
use std::sync::Arc;

use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension, named_params};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::control::{AgentRunControlResponse, RunFailureCategory};
use sidekicks_contracts::run::events::RunStateChangeState;
use sidekicks_contracts::run::failure_cause::{RunFailureCause, RunRefusedOrigin};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::provider_choice::{
    AgentRunRefusalChoiceRequestedPayload, AgentRunRefusalChoiceResolveRequest,
    AgentRunRefusalChoiceResolvedPayload, AgentRunUsageCreditsChoiceResolveRequest,
    AgentRunUsageCreditsChoiceResolvedPayload, RunRefusalChoice, RunRefusalChoiceSettlement,
    RunUsageCreditsChoiceSettlement,
};
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_provider::driver::contract::{DriverError, ProviderDriver};
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_provider::driver::run_control::{
    AnswerProviderChoiceParams, AnswerProviderChoiceResult, ProviderChoiceAnswer,
};
use sidekicks_provider::run::state_entry::RunStateEntry;
use sidekicks_std::keyed_lock::KeyedLock;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::statement::{
    StatementBindings, WriteStatement, named_bindings, text_binding,
};
use sidekicks_store::events::session::appender::{SessionEventDraft, SessionEventDraftError};

use crate::driver_resolution::{LiveRunDriverError, resolve_live_run_driver};
use crate::run::engine::{RunEngine, RunEngineError};
use crate::run::pause::run_control_response;
use crate::run::read::{RunRead, RunStateReader, read_run_provider, read_run_through};
use crate::run::refusals::RunRefusal;
use crate::run::state_change::{
    RunStateChange, RunStateChangeCompanions, RunStateChangeError, refused_statement_index,
};

pub mod held;
pub mod run_end;
#[cfg(test)]
mod tests;

use held::{HeldAnswer, HeldChoiceAnswers};

/// The statements [`ProviderChoiceResolver`] prepares on a read connection: the run, the provider
/// it runs on, the newest request of a choice and a settlement since it.
pub const PROVIDER_CHOICE_STATEMENT_CAPACITY: usize = 4;

// The settlement guard is the one companion of a settlement's move, terminal or not.
const SETTLEMENT_GUARD_COMPANION_INDEX: usize = 0;

// The settlement guard is the one statement of a settlement written alone.
const SETTLEMENT_GUARD_INDEX: usize = 0;

// The newest request of one kind of choice on a run; it reads `idx_session_events_run`.
const SELECT_LATEST_REQUEST_SQL: &str = "SELECT sequence, payload FROM session_events
  WHERE session_id = @session_id
    AND type = @requested_type
    AND run_id = @run_id
  ORDER BY sequence DESC
  LIMIT 1";

// A settlement of the run's choice recorded after the request at `@requested_sequence`; read
// before the answer goes out, and again inside the settlement's write as its guard.
const SELECT_SETTLEMENT_SINCE_SQL: &str = "SELECT 1 FROM session_events
  WHERE session_id = @session_id
    AND type = @resolved_type
    AND run_id = @run_id
    AND sequence > @requested_sequence
  LIMIT 1";

/// Who answered a choice: the device of the connection the answer arrived on.
#[derive(Clone, Debug)]
pub struct ProviderChoiceAnswerOrigin {
    /// The answering device.
    pub device_id: DeviceId,
}

/// Why an answer to a provider's choice did not settle it; a refusal wrote nothing.
#[derive(Debug, thiserror::Error)]
pub enum ProviderChoiceError {
    /// The run is unknown, or waits on no such choice because it was settled or never asked.
    #[error(transparent)]
    Refused(#[from] RunRefusal),
    /// The run's driver was not found: no registered driver answers its provider, or the live run
    /// has no binding.
    #[error(transparent)]
    NoDriver(#[from] LiveRunDriverError),
    /// The driver did not take the answer; nothing was written.
    #[error("the provider driver did not take the answer to the run's choice")]
    Driver(#[source] DriverError),
    /// The settlement's move was not written for a reason other than a refusal.
    #[error("the settlement of the run's choice was not written")]
    Change(#[source] RunEngineError),
    /// The settlement event breaks a check of its type.
    #[error("the settlement of the run's choice could not be drafted")]
    Draft(#[from] SessionEventDraftError),
    /// The stored request of the refused turn's choice does not read as its payload.
    #[error("the stored request of the run's refusal choice does not read as its payload")]
    MalformedRequest(#[source] serde_json::Error),
    /// SQLite refused a read, or a stored column does not read as its type.
    #[error("the run or its choice could not be read")]
    Read(#[from] rusqlite::Error),
    /// The read pool did not run the read.
    #[error("the read pool did not run the read of the run's choice")]
    Pool(#[from] DatabaseReadError),
}

impl From<RunEngineError> for ProviderChoiceError {
    // A refusal of the move is the answer's refusal; any other failure keeps the engine's error.
    fn from(error: RunEngineError) -> Self {
        match error {
            RunEngineError::Refused(refusal) => Self::Refused(refusal),
            other @ (RunEngineError::Change(_)
            | RunEngineError::Released(_)
            | RunEngineError::Gate { .. }
            | RunEngineError::NoResolvedPosture { .. }
            | RunEngineError::Driver { .. }
            | RunEngineError::LimitInterrupterGone { .. }
            | RunEngineError::LimitInterrupt { .. }
            | RunEngineError::InterruptRelease { .. }
            | RunEngineError::Provider(_)
            | RunEngineError::DaemonTurn(_)
            | RunEngineError::Agent(_)
            | RunEngineError::Draft(_)
            | RunEngineError::Append(_)
            | RunEngineError::Read(_)
            | RunEngineError::Pool(_)
            | RunEngineError::Several(_)) => Self::Change(other),
        }
    }
}

impl From<ProviderChoiceError> for HandlerError {
    /// A refusal answers by its code, the driver's failure as a driver error answers, and a
    /// provider no driver answers `provider.notFound`; the rest are faults in the daemon.
    fn from(error: ProviderChoiceError) -> Self {
        match error {
            ProviderChoiceError::Refused(refusal) => Self::Refused(refusal.into()),
            ProviderChoiceError::NoDriver(lookup) => lookup.into(),
            ProviderChoiceError::Driver(driver) => driver.into(),
            fault @ (ProviderChoiceError::Change(_)
            | ProviderChoiceError::Draft(_)
            | ProviderChoiceError::MalformedRequest(_)
            | ProviderChoiceError::Read(_)
            | ProviderChoiceError::Pool(_)) => Self::Internal(Box::new(fault)),
        }
    }
}

/// The kinds of choice a provider holds a run on, each with the events that ask and settle it.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum ChoiceDialog {
    /// Retry a refused turn on a fallback model, or edit it.
    Refusal,
    /// Switch off the model that needs usage credits, or spend them.
    UsageCredits,
}

impl ChoiceDialog {
    fn requested_type(self) -> SessionEventType {
        match self {
            Self::Refusal => SessionEventType::AgentRunRefusalChoiceRequested,
            Self::UsageCredits => SessionEventType::AgentRunUsageCreditsChoiceRequested,
        }
    }

    fn resolved_type(self) -> SessionEventType {
        match self {
            Self::Refusal => SessionEventType::AgentRunRefusalChoiceResolved,
            Self::UsageCredits => SessionEventType::AgentRunUsageCreditsChoiceResolved,
        }
    }
}

// A choice the run still waits on: the request's place in the log and its payload as stored.
struct PendingChoice {
    sequence: i64,
    payload: String,
}

// A run waiting on a choice, the choice, and the provider the run runs on.
struct WaitingRun {
    run: RunRead,
    pending: PendingChoice,
    bound: Option<ProviderId>,
}

/// Answers the choices a provider holds runs on. Answers on one run take turns, so of two answers
/// to one choice the second meets a settled one and is refused with `agent.run.invalidTransition`.
pub struct ProviderChoiceResolver {
    pool: Arc<DatabaseReadPool>,
    engine: Arc<RunEngine>,
    providers: Arc<ProviderRegistry>,
    run_lock: KeyedLock<RunId>,
    held_answers: Arc<HeldChoiceAnswers>,
}

impl ProviderChoiceResolver {
    /// A resolver reading runs and their log through `pool`, moving them through `engine`,
    /// reaching each run's provider through its driver in `providers` and holding each answer that
    /// got no reply back in `held_answers`, the store `engine`'s run ends read.
    pub fn new(
        pool: Arc<DatabaseReadPool>,
        engine: Arc<RunEngine>,
        providers: Arc<ProviderRegistry>,
        held_answers: Arc<HeldChoiceAnswers>,
    ) -> Self {
        Self {
            pool,
            engine,
            providers,
            run_lock: KeyedLock::new(),
            held_answers,
        }
    }

    /// Answers the retry-or-edit choice the run waits on and settles it: `retryFallback` returns
    /// the run to `running`, `editPrompt` ends it `failed` with the provider's refusal. Fails with
    /// [`RunRefusal::NotFound`] for an unknown run and [`RunRefusal::InvalidTransition`] when the
    /// run waits on no such choice because it was settled or never asked, then with
    /// [`ProviderChoiceError::NoDriver`], each with nothing sent or written. An answer the
    /// provider got with no reply back fails with [`ProviderChoiceError::Driver`] and is held, the
    /// run left waiting, for `ProviderChoiceResolver::settle_held_answer` or a second answer to
    /// settle.
    pub async fn resolve_refusal_choice(
        &self,
        request: &AgentRunRefusalChoiceResolveRequest,
        origin: ProviderChoiceAnswerOrigin,
    ) -> Result<AgentRunControlResponse, ProviderChoiceError> {
        let run_id = request.run_id;
        let choice = request.choice;
        let _run_hold = self.run_lock.acquire(run_id).await;
        self.forget_answers_of_ended_runs().await?;
        let new_state = match choice {
            RunRefusalChoice::RetryFallback => RunStateChangeState::Running,
            RunRefusalChoice::EditPrompt => RunStateChangeState::Failed,
        };
        let WaitingRun {
            run,
            pending,
            bound,
        } = self
            .read_pending_choice(run_id, ChoiceDialog::Refusal, new_state)
            .await?;
        let driver = resolve_live_run_driver(&self.providers, run_id, bound)?;
        // The stored request is read before the answer goes out, so a log that does not read sends
        // nothing.
        let change = match choice {
            RunRefusalChoice::RetryFallback => RunStateChange {
                expected_state: Some(RunState::WaitingForInput),
                ..RunStateChange::new(
                    run_id,
                    RunStateEntry::Running {
                        execution_posture: None,
                    },
                )
            },
            RunRefusalChoice::EditPrompt => {
                let requested: AgentRunRefusalChoiceRequestedPayload =
                    serde_json::from_str(&pending.payload)
                        .map_err(ProviderChoiceError::MalformedRequest)?;
                RunStateChange {
                    expected_state: Some(RunState::WaitingForInput),
                    failure_category: Some(RunFailureCategory::Refused),
                    ..RunStateChange::new(
                        run_id,
                        RunStateEntry::Failed {
                            intended_close: None,
                            failure_cause: Some(refused_cause_of(requested)),
                            provider_failure_detail: None,
                            process_exit: None,
                        },
                    )
                }
            }
        };
        let settlement =
            SessionEvent::AgentRunRefusalChoiceResolved(AgentRunRefusalChoiceResolvedPayload {
                session_id: run.session_id,
                run_id,
                choice: RunRefusalChoiceSettlement::Answered(choice),
                device_id: Some(origin.device_id),
            });
        let answer = HeldAnswer {
            answer: ProviderChoiceAnswer::Refusal { choice },
            change,
            is_move_made: false,
            session_id: run.session_id,
            dialog: ChoiceDialog::Refusal,
            pending,
            settlement,
        };
        self.answer(driver.as_ref(), &run, answer).await
    }

    /// Answers the switch-or-credits choice the run waits on and settles it; either answer returns
    /// the run to `running`, where a limit it owes is handed again on its own. Refused as
    /// [`ProviderChoiceResolver::resolve_refusal_choice`] is, nothing sent or written, and held as
    /// it holds an answer that got no reply back.
    pub async fn resolve_usage_credits_choice(
        &self,
        request: &AgentRunUsageCreditsChoiceResolveRequest,
        origin: ProviderChoiceAnswerOrigin,
    ) -> Result<AgentRunControlResponse, ProviderChoiceError> {
        let run_id = request.run_id;
        let choice = request.choice;
        let _run_hold = self.run_lock.acquire(run_id).await;
        self.forget_answers_of_ended_runs().await?;
        let new_state = RunStateChangeState::Running;
        let WaitingRun {
            run,
            pending,
            bound,
        } = self
            .read_pending_choice(run_id, ChoiceDialog::UsageCredits, new_state)
            .await?;
        let driver = resolve_live_run_driver(&self.providers, run_id, bound)?;
        let change = RunStateChange {
            expected_state: Some(RunState::WaitingForInput),
            ..RunStateChange::new(
                run_id,
                RunStateEntry::Running {
                    execution_posture: None,
                },
            )
        };
        let settlement = SessionEvent::AgentRunUsageCreditsChoiceResolved(
            AgentRunUsageCreditsChoiceResolvedPayload {
                session_id: run.session_id,
                run_id,
                choice: RunUsageCreditsChoiceSettlement::Answered(choice),
                device_id: Some(origin.device_id),
            },
        );
        let answer = HeldAnswer {
            answer: ProviderChoiceAnswer::UsageCredits { choice },
            change,
            is_move_made: false,
            session_id: run.session_id,
            dialog: ChoiceDialog::UsageCredits,
            pending,
            settlement,
        };
        self.answer(driver.as_ref(), &run, answer).await
    }

    /// Settles the answer the provider got with no reply back on `run_id`, once the provider
    /// reports the run in `reported`: called before that report is applied, so the answer's
    /// settlement and move are written first and the report, a move the run already made, is
    /// refused. A report that the run still waits on input keeps the answer held, and a run the
    /// provider ended drops an answer that would have returned it to `running`. An answer whose
    /// run a report already moved settles at any report as its event alone, the provider having
    /// shown it took it. A driver's own signal that the provider resolved the choice settles the
    /// held answer the same way. Answers whether it wrote the settlement; fails as the
    /// settlement's write fails, the answer held again for the next report or answer to settle.
    pub(crate) async fn settle_held_answer(
        &self,
        run_id: RunId,
        reported: RunState,
    ) -> Result<bool, ProviderChoiceError> {
        let _run_hold = self.run_lock.acquire(run_id).await;
        let Some(held) = self.held_answers.take(run_id) else {
            return Ok(false);
        };
        if !held.is_move_made {
            if reported == RunState::WaitingForInput {
                self.held_answers.hold_again(held);
                return Ok(false);
            }
            if reported.is_terminal() && !RunState::from(held.change.entry.state()).is_terminal() {
                tracing::info!(
                    run_id = %run_id,
                    "the provider ended the run before showing it took the answer to its choice"
                );
                return Ok(false);
            }
        }
        match self.settle_held(held).await {
            Ok(_settled) => Ok(true),
            // Settled since, or no longer waiting: nothing is left to record.
            Err(ProviderChoiceError::Refused(RunRefusal::InvalidTransition { .. })) => Ok(false),
            Err(failure) => Err(failure),
        }
    }

    /// Leaves the answer held on `run_id`, if any, to settle as its settlement event alone, once a
    /// report moved the run without the answer's move because the settle failed.
    pub(crate) fn hold_answer_as_settlement_alone(&self, run_id: RunId) {
        self.held_answers.mark_move_made(run_id);
    }

    // The run, the request it waits on and its provider, or the refusal of an answer that settles
    // nothing.
    async fn read_pending_choice(
        &self,
        run_id: RunId,
        dialog: ChoiceDialog,
        new_state: RunStateChangeState,
    ) -> Result<WaitingRun, ProviderChoiceError> {
        self.pool
            .read(
                ReadLength::Short,
                move |reader| -> Result<_, ProviderChoiceError> {
                    let Some(run) = RunStateReader::new(reader).read_run(&run_id)? else {
                        return Err(RunRefusal::NotFound { run_id }.into());
                    };
                    if run.state == RunState::WaitingForInput
                        && let Some(pending) =
                            latest_request(reader, run.session_id, run_id, dialog)?
                        && !is_settled_since(reader, run.session_id, run_id, dialog, &pending)?
                    {
                        let bound = read_run_provider(reader, &run_id)?.map(|bound| bound.provider);
                        return Ok(WaitingRun {
                            run,
                            pending,
                            bound,
                        });
                    }
                    Err(RunRefusal::InvalidTransition {
                        run_id,
                        from_state: run.state,
                        to_state: new_state,
                        source: None,
                    }
                    .into())
                },
            )
            .await
    }

    // Sends `answer` to the provider and settles it once taken. A provider that holds no such
    // choice any more answers `NotPending`: it took an earlier answer that got no reply back,
    // which is settled then, this one answering as it did only when it chose the same; with none
    // held it is refused with nothing written. An answer that gets no reply back is held, the run
    // left waiting, and fails with the driver's error.
    async fn answer(
        &self,
        driver: &dyn ProviderDriver,
        run: &RunRead,
        answer: HeldAnswer,
    ) -> Result<AgentRunControlResponse, ProviderChoiceError> {
        let run_id = answer.change.run_id;
        let answered = driver
            .answer_provider_choice(AnswerProviderChoiceParams {
                session_id: run.session_id,
                run_id,
                answer: answer.answer,
            })
            .await;
        match answered {
            Ok(AnswerProviderChoiceResult::Answered {}) => {
                drop(self.held_answers.take(run_id));
                self.settle_held(answer).await
            }
            Ok(AnswerProviderChoiceResult::NotPending {}) => {
                let to_state = answer.change.entry.state();
                let Some(earlier) = self.held_answers.take(run_id) else {
                    return Err(RunRefusal::InvalidTransition {
                        run_id,
                        from_state: run.state,
                        to_state,
                        source: None,
                    }
                    .into());
                };
                let is_same_answer = earlier.answer == answer.answer;
                let settled = self.settle_held(earlier).await?;
                if is_same_answer {
                    return Ok(settled);
                }
                Err(RunRefusal::InvalidTransition {
                    run_id,
                    from_state: settled.new_state,
                    to_state,
                    source: None,
                }
                .into())
            }
            Err(unanswered @ DriverError::Unanswered(_)) => {
                // The first answer held stays held: the provider may have taken it, and its word
                // settles whichever it took.
                self.held_answers.hold(answer);
                Err(ProviderChoiceError::Driver(unanswered))
            }
            Err(failed) => Err(ProviderChoiceError::Driver(failed)),
        }
    }

    // Lets go every held answer whose run ended: the run's end wrote the settlement of one a report
    // showed the provider took and settled the rest `Unanswered`, so nothing is left to write. A
    // read that fails refuses the answer, as the answer's own read on the same pool would next.
    async fn forget_answers_of_ended_runs(&self) -> Result<(), ProviderChoiceError> {
        let held = self.held_answers.held_run_ids();
        if held.is_empty() {
            return Ok(());
        }
        let ended = self
            .pool
            .read(ReadLength::Short, move |reader| {
                let runs = RunStateReader::new(reader);
                let mut ended = Vec::new();
                for run_id in held {
                    if runs
                        .read_run(&run_id)?
                        .is_none_or(|run| run.state.is_terminal())
                    {
                        ended.push(run_id);
                    }
                }
                Ok::<_, ProviderChoiceError>(ended)
            })
            .await?;
        self.held_answers.forget_ended(&ended);
        Ok(())
    }

    // Writes the settlement `held` carries. A write that fails for any reason but the choice
    // settled since holds the answer again, the provider having taken it, so the next report or
    // answer settles it; one held meanwhile defers to it.
    async fn settle_held(
        &self,
        held: HeldAnswer,
    ) -> Result<AgentRunControlResponse, ProviderChoiceError> {
        let settled = if held.is_move_made {
            self.settle_alone(&held).await
        } else {
            self.settle(
                held.change.clone(),
                held.session_id,
                held.dialog,
                &held.pending,
                &held.settlement,
            )
            .await
        };
        if let Err(failure) = &settled
            && !matches!(
                failure,
                ProviderChoiceError::Refused(RunRefusal::InvalidTransition { .. })
            )
        {
            self.held_answers.hold_again(held);
        }
        settled
    }

    // The settlement row and the run's move in one write, refused whole when the request was
    // settled since it was read.
    async fn settle(
        &self,
        change: RunStateChange,
        session_id: SessionId,
        dialog: ChoiceDialog,
        pending: &PendingChoice,
        settlement: &SessionEvent,
    ) -> Result<AgentRunControlResponse, ProviderChoiceError> {
        let run_id = change.run_id;
        let new_state = change.entry.state();
        let companions = RunStateChangeCompanions {
            statements: vec![settlement_guard(session_id, run_id, dialog, pending)],
            preceding_events: vec![SessionEventDraft::of_session(session_id, settlement)?],
            settled_choices: vec![dialog],
            ..RunStateChangeCompanions::default()
        };
        match self.engine.transition(change, companions).await {
            Ok(written) => Ok(run_control_response(run_id, &written)),
            Err(RunEngineError::Change(RunStateChangeError::CompanionRefused {
                companion_index: SETTLEMENT_GUARD_COMPANION_INDEX,
                source,
            })) => match read_run_through::<ProviderChoiceError>(&self.pool, run_id).await? {
                None => Err(RunRefusal::NotFound { run_id }.into()),
                Some(now) => Err(RunRefusal::InvalidTransition {
                    run_id,
                    from_state: now.state,
                    to_state: new_state,
                    source: Some(Box::new(source)),
                }
                .into()),
            },
            Err(other) => Err(other.into()),
        }
    }

    // The settlement row alone, under its guard, for an answer whose run a report already moved,
    // and the run as it reads after; refused as `settle` refuses a request settled since.
    async fn settle_alone(
        &self,
        held: &HeldAnswer,
    ) -> Result<AgentRunControlResponse, ProviderChoiceError> {
        let run_id = held.change.run_id;
        let appended = self
            .engine
            .append(
                SessionEventDraft::of_session(held.session_id, &held.settlement)?,
                vec![settlement_guard(
                    held.session_id,
                    run_id,
                    held.dialog,
                    &held.pending,
                )],
                Vec::new(),
                None,
            )
            .await;
        let refusal = match appended {
            Ok(_receipt) => None,
            Err(error) if refused_statement_index(&error) == Some(SETTLEMENT_GUARD_INDEX) => {
                Some(error)
            }
            Err(error) => return Err(RunEngineError::from(error).into()),
        };
        let Some(now) = read_run_through::<ProviderChoiceError>(&self.pool, run_id).await? else {
            return Err(RunRefusal::NotFound { run_id }.into());
        };
        match refusal {
            None => Ok(run_control_response(run_id, &now)),
            Some(source) => Err(RunRefusal::InvalidTransition {
                run_id,
                from_state: now.state,
                to_state: held.change.entry.state(),
                source: Some(Box::new(source)),
            }
            .into()),
        }
    }
}

// The newest request of `dialog`'s choice on the run, if the log holds one.
fn latest_request(
    reader: &Connection,
    session_id: SessionId,
    run_id: RunId,
    dialog: ChoiceDialog,
) -> rusqlite::Result<Option<PendingChoice>> {
    reader
        .prepare_cached(SELECT_LATEST_REQUEST_SQL)?
        .query_row(
            named_params! {
                "@session_id": session_id.text().as_str(),
                "@requested_type": dialog.requested_type().as_str(),
                "@run_id": run_id.text().as_str(),
            },
            |row| {
                Ok(PendingChoice {
                    sequence: row.get(0)?,
                    payload: row.get(1)?,
                })
            },
        )
        .optional()
}

// Whether the log settled `pending` already, read as the settlement's guard reads it.
fn is_settled_since(
    reader: &Connection,
    session_id: SessionId,
    run_id: RunId,
    dialog: ChoiceDialog,
    pending: &PendingChoice,
) -> rusqlite::Result<bool> {
    let bindings = settlement_bindings(session_id, run_id, dialog, pending);
    reader
        .prepare_cached(SELECT_SETTLEMENT_SINCE_SQL)?
        .exists(named_bindings(&bindings).as_slice())
}

// Refuses a settlement's write once the log settled `pending` since it was read.
fn settlement_guard(
    session_id: SessionId,
    run_id: RunId,
    dialog: ChoiceDialog,
    pending: &PendingChoice,
) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(SELECT_SETTLEMENT_SINCE_SQL),
        bindings: StatementBindings::Named(settlement_bindings(
            session_id, run_id, dialog, pending,
        )),
        expected_row_count: Some(0),
    }
}

// The settlement read's bindings, which its read and its guard share.
fn settlement_bindings(
    session_id: SessionId,
    run_id: RunId,
    dialog: ChoiceDialog,
    pending: &PendingChoice,
) -> Vec<(Cow<'static, str>, Value)> {
    vec![
        text_binding("@session_id", session_id.text().as_str()),
        text_binding("@resolved_type", dialog.resolved_type().as_str()),
        text_binding("@run_id", run_id.text().as_str()),
        (
            Cow::Borrowed("@requested_sequence"),
            Value::Integer(pending.sequence),
        ),
    ]
}

// The refusal a refused turn ends with: the model that refused it and the provider's own words.
fn refused_cause_of(requested: AgentRunRefusalChoiceRequestedPayload) -> RunFailureCause {
    RunFailureCause::Refused {
        origin: RunRefusedOrigin::Provider,
        model: requested.refused_model,
        sentence: requested.sentence,
        explanation: None,
        safety_category: requested.safety_category,
    }
}
