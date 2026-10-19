//! A person's answer to a choice the provider holds a run on: the retry-or-edit choice on a
//! refused turn and the switch-or-credits choice on a turn whose model needs usage credits. The
//! first answer settles the choice; the answer goes to the provider before anything is written,
//! and the settlement row and the run's move commit in one write, guarded so a second settlement
//! of the same request is refused whole.

use std::borrow::Cow;
use std::sync::Arc;

use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension, named_params};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::session::SessionEvent;
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

use crate::database::connection::read_pool::{DatabaseReadError, DatabaseReadPool, ReadLength};
use crate::database::statement::{StatementBindings, WriteStatement, named_bindings, text_binding};
use crate::events::session::appender::{SessionEventDraft, SessionEventDraftError};
use crate::keyed_lock::KeyedLock;
use crate::provider::driver::contract::{DriverError, ProviderDriver};
use crate::provider::driver::run_control::{
    AnswerProviderChoiceParams, AnswerProviderChoiceResult, ProviderChoiceAnswer,
};
use crate::session::run::engine::{RunEngine, RunEngineError};
use crate::session::run::pause::run_control_response;
use crate::session::run::read::{RunRead, RunStateReader, read_run_through};
use crate::session::run::refusals::RunRefusal;
use crate::session::run::state_change::{
    RunStateChange, RunStateChangeCompanions, RunStateChangeError, RunStateEntry,
};

/// The statements [`ProviderChoiceResolver`] prepares on a read connection: the newest request of
/// a choice and a settlement since it.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's start"))]
pub(crate) const PROVIDER_CHOICE_STATEMENT_CAPACITY: usize = 2;

// The settlement guard is the one companion of a settlement's move, terminal or not.
const SETTLEMENT_GUARD_COMPANION_INDEX: usize = 0;

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
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the provider choice answer handlers")
)]
pub(crate) struct ProviderChoiceAnswerOrigin {
    /// The answering device, where the connection names one.
    pub(crate) device_id: Option<DeviceId>,
}

/// Why an answer to a provider's choice did not settle it; a refusal wrote nothing.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ProviderChoiceError {
    /// The run is unknown, or waits on no such choice because it was settled or never asked.
    #[error(transparent)]
    Refused(#[from] RunRefusal),
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
            | RunEngineError::Provider(_)
            | RunEngineError::ProviderUnknown { .. }
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

// The kinds of choice a provider holds a run on, each with the events that ask and settle it.
#[derive(Clone, Copy)]
enum ChoiceDialog {
    Refusal,
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

/// Answers the choices a provider holds runs on. Answers on one run take turns, so of two answers
/// to one choice the second meets a settled one and is refused with `agent.run.invalidTransition`.
pub(crate) struct ProviderChoiceResolver {
    pool: Arc<DatabaseReadPool>,
    engine: Arc<RunEngine>,
    run_lock: KeyedLock<RunId>,
}

impl ProviderChoiceResolver {
    /// A resolver reading runs and their log through `pool` and moving them through `engine`.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the provider choice answer handlers")
    )]
    pub(crate) fn new(pool: Arc<DatabaseReadPool>, engine: Arc<RunEngine>) -> Self {
        Self {
            pool,
            engine,
            run_lock: KeyedLock::new(),
        }
    }

    /// Answers the retry-or-edit choice the run waits on and settles it: `retryFallback` returns
    /// the run to `running`, `editPrompt` ends it `failed` with the provider's refusal. Fails with
    /// [`RunRefusal::InvalidTransition`], nothing sent or written, when the run waits on no such
    /// choice because it was settled or never asked.
    #[expect(dead_code, reason = "the provider choice answer handlers")]
    pub(crate) async fn resolve_refusal_choice(
        &self,
        request: &AgentRunRefusalChoiceResolveRequest,
        origin: ProviderChoiceAnswerOrigin,
        driver: &dyn ProviderDriver,
    ) -> Result<AgentRunControlResponse, ProviderChoiceError> {
        let run_id = request.run_id;
        let choice = request.choice;
        let _run_hold = self.run_lock.acquire(run_id).await;
        let new_state = match choice {
            RunRefusalChoice::RetryFallback => RunStateChangeState::Running,
            RunRefusalChoice::EditPrompt => RunStateChangeState::Failed,
        };
        let (run, pending) = self
            .read_pending_choice(run_id, ChoiceDialog::Refusal, new_state)
            .await?;
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
        self.answer(
            driver,
            run_id,
            &run,
            ProviderChoiceAnswer::Refusal { choice },
            new_state,
        )
        .await?;
        let settlement =
            SessionEvent::AgentRunRefusalChoiceResolved(AgentRunRefusalChoiceResolvedPayload {
                session_id: run.session_id,
                run_id,
                choice: RunRefusalChoiceSettlement::Answered(choice),
                device_id: origin.device_id,
            });
        self.settle(
            change,
            run.session_id,
            ChoiceDialog::Refusal,
            &pending,
            &settlement,
        )
        .await
    }

    /// Answers the switch-or-credits choice the run waits on and settles it; either answer returns
    /// the run to `running`, where a limit it owes is handed again on its own. Fails with
    /// [`RunRefusal::InvalidTransition`], nothing sent or written, when the run waits on no such
    /// choice.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the provider choice answer handlers")
    )]
    pub(crate) async fn resolve_usage_credits_choice(
        &self,
        request: &AgentRunUsageCreditsChoiceResolveRequest,
        origin: ProviderChoiceAnswerOrigin,
        driver: &dyn ProviderDriver,
    ) -> Result<AgentRunControlResponse, ProviderChoiceError> {
        let run_id = request.run_id;
        let choice = request.choice;
        let _run_hold = self.run_lock.acquire(run_id).await;
        let new_state = RunStateChangeState::Running;
        let (run, pending) = self
            .read_pending_choice(run_id, ChoiceDialog::UsageCredits, new_state)
            .await?;
        self.answer(
            driver,
            run_id,
            &run,
            ProviderChoiceAnswer::UsageCredits { choice },
            new_state,
        )
        .await?;
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
                device_id: origin.device_id,
            },
        );
        self.settle(
            change,
            run.session_id,
            ChoiceDialog::UsageCredits,
            &pending,
            &settlement,
        )
        .await
    }

    // The run and the request it waits on, or the refusal of an answer that settles nothing.
    async fn read_pending_choice(
        &self,
        run_id: RunId,
        dialog: ChoiceDialog,
        new_state: RunStateChangeState,
    ) -> Result<(RunRead, PendingChoice), ProviderChoiceError> {
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
                        return Ok((run, pending));
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

    // A provider that holds no such choice any more answers `NotPending`, refused with nothing
    // written.
    async fn answer(
        &self,
        driver: &dyn ProviderDriver,
        run_id: RunId,
        run: &RunRead,
        answer: ProviderChoiceAnswer,
        new_state: RunStateChangeState,
    ) -> Result<(), ProviderChoiceError> {
        let answered = driver
            .answer_provider_choice(AnswerProviderChoiceParams {
                session_id: run.session_id,
                run_id,
                answer,
            })
            .await
            .map_err(ProviderChoiceError::Driver)?;
        match answered {
            AnswerProviderChoiceResult::Answered {} => Ok(()),
            AnswerProviderChoiceResult::NotPending {} => Err(RunRefusal::InvalidTransition {
                run_id,
                from_state: run.state,
                to_state: new_state,
                source: None,
            }
            .into()),
        }
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
            statements: vec![WriteStatement {
                sql: Cow::Borrowed(SELECT_SETTLEMENT_SINCE_SQL),
                bindings: StatementBindings::Named(settlement_bindings(
                    session_id, run_id, dialog, pending,
                )),
                expected_row_count: Some(0),
            }],
            preceding_events: vec![SessionEventDraft::of_session(session_id, settlement)?],
            leading_event: None,
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
