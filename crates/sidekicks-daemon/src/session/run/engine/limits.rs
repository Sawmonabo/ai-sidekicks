//! The daemon's own stop of a run at a limit: the step limit on a run whose provider does not bound
//! a turn's steps, and the spend and token limits the budget accountant holds each run and session
//! to. The stop is recorded while the run is live, the run's driver interrupts it, and the run ends
//! with the stop applied, so a restart in between settles the run with the limit's cause.

use std::borrow::Cow;
use std::sync::LazyLock;

use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::orchestration::InterruptReason;
use sidekicks_contracts::provider::driver::length_limits::PROVIDER_FAILURE_DETAIL_MAX_LEN;
use sidekicks_contracts::run::control::StopTrigger;
use sidekicks_contracts::run::events::{
    AgentInterventionAcceptedPayload, AgentInterventionAcceptedState,
    AgentInterventionFailedPayload, AgentInterventionFailedState,
    AgentInterventionRequestedPayload, AgentInterventionRequestedState, DaemonInterventionActor,
    InterventionActor,
};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::{
    InterruptInterventionRecord, InterventionId, InterventionType, LimitInterruptRecord, RunLimit,
};
use sidekicks_contracts::session::controls::events::{
    AgentRunStepLimitReachedPayload, AgentRunTokenLimitReachedPayload,
};
use sidekicks_contracts::session::cost::TokensPerRun;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::database::statement::{StatementBindings, WriteStatement, text_binding};
use crate::events::session::appender::SessionEventDraft;
use crate::interventions::store::{
    InterventionTransition, RequestedIntervention, UnresolvedInterventionState,
    insert_requested_intervention_statement, move_intervention_statement,
};
use crate::provider::driver::contract::{DriverError, bound_failure_detail};
use crate::provider::driver::run_control::InterruptRunRequest;
use crate::recovery::database_file::damage::describe_error;
use crate::session::run::engine::{
    LiveAppend, RunEngine, RunEngineError, refused_statement_index, safe_run_version,
    with_cleanup_failures,
};
use crate::session::run::read::LiveRun;
use crate::session::run::refusals::RunRefusal;
use crate::session::run::restart::{PendingInterrupt, applied_pending_interrupt_of};
use crate::session::run::state_change::{RunStateChange, RunStateChangeCompanions, RunStateEntry};
use crate::session::run::transitions::is_transition_allowed;
use crate::uuid_v7::mint_uuid_v7;

// A token-limit stop's guard that the run never reached its limit before follows the version guard.
const TOKEN_LIMIT_ONCE_GUARD_INDEX: usize = 1;

// The failure an interrupt the driver refused records when its words fit nothing.
static INTERRUPT_FAILURE_FALLBACK: LazyLock<FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>> =
    LazyLock::new(|| {
        FreeFormText::new("The provider could not interrupt the run".to_owned())
            .expect("the fallback is non-blank and within the cap")
    });

// Refuses a token-limit stop once the run reached its limit; the reached event names no run
// version, so the guard reads the run and the type alone.
static SELECT_TOKEN_LIMIT_REACHED_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT 1 FROM session_events
  WHERE category = '{}'
    AND type = '{}'
    AND run_id = @run_id
  LIMIT 1",
        SessionEventType::AgentRunTokenLimitReached
            .category()
            .as_str(),
        SessionEventType::AgentRunTokenLimitReached.as_str()
    )
});

/// The turn a limit stop cut, kept until that turn's end is written.
pub(super) struct CutTurn {
    /// The limit that cut it.
    pub(super) limit: RunLimit,
    /// The turn.
    pub(super) turn_number: SafeInt<1>,
}

/// A limit the daemon stops a run at by itself, with what its reached event records. Spend has no
/// run-level reached event: its accepted interrupt is the stop's record.
#[derive(Clone, Copy)]
pub(super) enum LimitStop {
    /// The open turn took the steps its bound allows.
    Step {
        /// The bound reached.
        count: SafeInt<1>,
    },
    /// The session reached its spend limit.
    Spend,
    /// The run passed its token limit.
    Token {
        /// The limit passed.
        token_limit: TokensPerRun,
    },
}

impl LimitStop {
    fn limit(self) -> RunLimit {
        match self {
            Self::Step { .. } => RunLimit::StepLimit,
            Self::Spend => RunLimit::SpendLimit,
            Self::Token { .. } => RunLimit::TokenLimit,
        }
    }

    // Step and spend rest the run interrupted with the limit; the token limit stops it.
    fn run_end(self) -> RunStateEntry {
        match self {
            Self::Step { .. } => RunStateEntry::Interrupted {
                intended_close: None,
                trigger: Some(InterruptReason::StepLimit),
            },
            Self::Spend => RunStateEntry::Interrupted {
                intended_close: None,
                trigger: Some(InterruptReason::SpendLimit),
            },
            Self::Token { .. } => RunStateEntry::Stopped {
                intended_close: None,
                trigger: Some(StopTrigger::TokenLimit),
            },
        }
    }

    // The stop's own event: the run's reached event, or the accepted interrupt itself for spend.
    fn reached_event(
        self,
        session_id: SessionId,
        run_id: RunId,
        accepted: SessionEvent,
    ) -> (SessionEvent, Option<SessionEvent>) {
        match self {
            Self::Step { count } => (
                SessionEvent::AgentRunStepLimitReached(AgentRunStepLimitReachedPayload {
                    session_id,
                    run_id,
                    count,
                }),
                Some(accepted),
            ),
            Self::Token { token_limit } => (
                SessionEvent::AgentRunTokenLimitReached(AgentRunTokenLimitReachedPayload {
                    session_id,
                    run_id,
                    token_limit,
                }),
                Some(accepted),
            ),
            Self::Spend => (accepted, None),
        }
    }
}

impl RunEngine {
    /// Stops `run_id` at the session's spend limit: the daemon's own interrupt accepted, the driver
    /// told to interrupt the run, and the run rested `interrupted` with the limit. Fails as the
    /// stop fails; the interrupt then records the driver's failure.
    #[expect(
        dead_code,
        reason = "the budget accountant calls it when a session's spend reaches its limit"
    )]
    pub(crate) async fn stop_at_spend_limit(&self, run_id: RunId) -> Result<(), RunEngineError> {
        self.stop_at_limit(run_id, LimitStop::Spend).await
    }

    /// Stops `run_id` at its token limit, once per run: `agent.run.tokenLimit.reached` written with
    /// the daemon's own interrupt, the driver told to interrupt the run, and the run `stopped`.
    /// Fails as the stop fails; the interrupt then records the driver's failure.
    #[expect(
        dead_code,
        reason = "the budget accountant calls it when a run's tokens pass its limit"
    )]
    pub(crate) async fn stop_at_token_limit(
        &self,
        run_id: RunId,
        token_limit: TokensPerRun,
    ) -> Result<(), RunEngineError> {
        self.stop_at_limit(run_id, LimitStop::Token { token_limit })
            .await
    }

    /// The daemon's own stop of a live run at a limit. First the stop is recorded while the run is
    /// live: its interrupt requested and accepted, with the limit's reached event, so a crash from
    /// here on leaves the accepted interrupt a restart settles. Then the run's driver interrupts
    /// the run, and on its success the run ends with the interrupt applied in one write; on its
    /// failure the interrupt records it and the failure returns. The turn the stop cuts is
    /// remembered, so its provider's end is written interrupted with the limit. A run that has
    /// ended is left as it is; one the limit's end may not leave its state from is refused with
    /// nothing written.
    pub(super) async fn stop_at_limit(
        &self,
        run_id: RunId,
        stop: LimitStop,
    ) -> Result<(), RunEngineError> {
        let provider = self.provider_of(&run_id)?;
        let driver = self
            .providers
            .lookup(&provider)
            .map_err(RunEngineError::Provider)?;
        let open_turn = self.read_open_turn(run_id).await?;
        let limit = stop.limit();
        let run_end = stop.run_end();
        let intervention_id =
            InterventionId::try_from(mint_uuid_v7()).expect("a minted UUID is an intervention id");
        let record = InterruptInterventionRecord::Limit(LimitInterruptRecord { limit });
        let payload = serde_json::to_string(&record).expect("a limit record serializes");
        let actor = InterventionActor::Daemon(DaemonInterventionActor::Value);
        let recorded = self
            .append_while_live(run_id, |run| {
                if !is_transition_allowed(run.state, run_end.state()) {
                    return Err(RunRefusal::InvalidTransition {
                        run_id,
                        from_state: run.state,
                        to_state: run_end.state(),
                        source: None,
                    }
                    .into());
                }
                let requested = RequestedIntervention {
                    intervention_id,
                    target_run_id: run_id,
                    intervention_type: InterventionType::Interrupt,
                    payload: payload.clone(),
                    expected_run_version: safe_run_version(run.version),
                    client_idempotency_key: ClientUuid::new(mint_uuid_v7().to_string())
                        .expect("a minted UUID is a client UUID"),
                    device_id: None,
                };
                let mut statements = Vec::with_capacity(3);
                if matches!(stop, LimitStop::Token { .. }) {
                    statements.push(no_token_limit_reached_statement(&run_id));
                }
                statements.push(insert_requested_intervention_statement(&requested));
                statements.push(move_intervention_statement(
                    &intervention_id,
                    &InterventionTransition::Accept,
                ));
                let session_id = run.session_id;
                let requested_event =
                    SessionEvent::AgentInterventionRequested(AgentInterventionRequestedPayload {
                        session_id,
                        intervention_id,
                        target_run_id: run_id,
                        intervention_type: InterventionType::Interrupt,
                        state: AgentInterventionRequestedState::Value,
                        actor: actor.clone(),
                    });
                let accepted_event =
                    SessionEvent::AgentInterventionAccepted(AgentInterventionAcceptedPayload {
                        session_id,
                        intervention_id,
                        target_run_id: run_id,
                        intervention_type: InterventionType::Interrupt,
                        state: AgentInterventionAcceptedState::Value,
                        actor: actor.clone(),
                    });
                let (reached, accepted) = stop.reached_event(session_id, run_id, accepted_event);
                let mut preceding_events =
                    vec![SessionEventDraft::of_session(session_id, &requested_event)?];
                if let Some(accepted) = accepted {
                    preceding_events.push(SessionEventDraft::of_session(session_id, &accepted)?);
                }
                Ok(LiveAppend {
                    draft: SessionEventDraft::of_session(session_id, &reached)?,
                    preceding_events,
                    statements,
                })
            })
            .await;
        let accepted_run = match recorded {
            Ok(Some((run, _receipt))) => run,
            // The run ended before the stop was recorded, so nothing is left to stop.
            Ok(None) => return Ok(()),
            Err(RunEngineError::Append(error))
                if matches!(stop, LimitStop::Token { .. })
                    && refused_statement_index(&error) == Some(TOKEN_LIMIT_ONCE_GUARD_INDEX) =>
            {
                // The run reached its token limit before, and that stop is the one that stands.
                return Ok(());
            }
            Err(error) => return Err(error),
        };
        if let Some(turn_number) = open_turn {
            self.live()
                .cut_turns
                .insert(run_id, CutTurn { limit, turn_number });
        }

        let interrupted = driver
            .interrupt_run(InterruptRunRequest {
                run_id,
                reason: None,
            })
            .await;
        let pending = PendingInterrupt {
            intervention_id,
            state: UnresolvedInterventionState::Accepted,
            actor: actor.clone(),
            record,
        };
        match interrupted {
            Ok(()) => {
                let live_run = LiveRun {
                    run_id,
                    run: accepted_run.clone(),
                    parent_run_id: None,
                    reached_by: None,
                };
                let verdict = applied_pending_interrupt_of(&live_run, &pending)?;
                let is_ended = self
                    .end_run_since(
                        RunStateChange::new(run_id, run_end),
                        accepted_run.version,
                        verdict.clone(),
                    )
                    .await?;
                if !is_ended {
                    // The run ended on its own after the stop was accepted, which is what the stop
                    // asked for; the stop's outcome is recorded alone.
                    self.append_verdict_alone(verdict).await?;
                }
                Ok(())
            }
            Err(driver_error) => {
                // The turn was not cut, so its provider's end is written as reported.
                if let Some(turn_number) = open_turn {
                    self.forget_cut_turn(&run_id, turn_number);
                }
                let reason = bound_failure_detail(
                    &interrupt_failure_reason(&driver_error),
                    INTERRUPT_FAILURE_FALLBACK.clone(),
                );
                let failed =
                    SessionEvent::AgentInterventionFailed(AgentInterventionFailedPayload {
                        session_id: accepted_run.session_id,
                        intervention_id,
                        target_run_id: run_id,
                        intervention_type: InterventionType::Interrupt,
                        state: AgentInterventionFailedState::Value,
                        actor,
                        failure_reason: reason.clone(),
                    });
                let stop_failure = RunEngineError::Interrupt {
                    run_id,
                    source: driver_error,
                };
                let recorded = match SessionEventDraft::of_session(accepted_run.session_id, &failed)
                {
                    Ok(draft) => self
                        .append(
                            draft,
                            vec![move_intervention_statement(
                                &intervention_id,
                                &InterventionTransition::Fail { reason },
                            )],
                            Vec::new(),
                        )
                        .await
                        .map(drop)
                        .map_err(RunEngineError::from),
                    Err(error) => Err(error.into()),
                };
                Err(with_cleanup_failures(
                    stop_failure,
                    [recorded],
                    "interrupting a run stopped at a limit and recording the interrupt's failure",
                ))
            }
        }
    }

    // Records an interrupt's outcome with no run change: its row's move and its event.
    async fn append_verdict_alone(
        &self,
        verdict: RunStateChangeCompanions,
    ) -> Result<(), RunEngineError> {
        let RunStateChangeCompanions {
            statements,
            mut preceding_events,
        } = verdict;
        let draft = preceding_events
            .pop()
            .expect("an interrupt's outcome carries its event");
        self.append(draft, statements, preceding_events).await?;
        Ok(())
    }
}

// What an interrupt the driver refused records: the refusal's code, else the failure's words.
fn interrupt_failure_reason(error: &DriverError) -> String {
    match error {
        DriverError::Refused(refusal) => refusal.code.as_str().to_owned(),
        DriverError::SteerTurnEnded(_)
        | DriverError::CapabilityProbe(_)
        | DriverError::Internal(_) => describe_error(error),
    }
}

// Refuses a token-limit stop once the run reached its limit.
fn no_token_limit_reached_statement(run_id: &RunId) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(SELECT_TOKEN_LIMIT_REACHED_SQL.as_str()),
        bindings: StatementBindings::Named(vec![text_binding("@run_id", run_id.text().as_str())]),
        expected_row_count: Some(0),
    }
}
