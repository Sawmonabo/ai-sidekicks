//! The one path every intervention takes: record it, accept it against the run, dispatch it once
//! and record its outcome. Each step is one write carrying its row's move, its guards and its
//! `agent.intervention.*` event, so a crash leaves the row at the last step that committed, and
//! every decision read from the run is checked again by a guarded statement inside the write it
//! decides.
//!
//! A person's request whose run moved before its accept expires undispatched, and once dispatched
//! the driver's verdict is recorded whatever the run did meanwhile. An interrupt holds the run
//! queue's hands to its run from before its accept until it settles, and its applied or degraded
//! verdict is written with the run's end; a retry's verdict advances the run's version. A dispatch
//! that throws ends the request `failed`. Retries on one run take turns under a per-run lock, and
//! interrupts, the daemon's own at a limit among them, under another, so a stop never waits behind
//! a retry and a retry still queued when it lands meets the advanced version and expires.

pub(super) mod reached_state;
mod request;
#[cfg(test)]
pub(super) mod tests;

use std::sync::Arc;

use serde_json::json;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::driver::length_limits::{
    PROVIDER_FAILURE_DETAIL_MAX_LEN, PROVIDER_FALLBACK_ACTION_MAX_LEN,
};
use sidekicks_contracts::provider::driver::methods::PROVIDER_WIRE_HANDLE_MAX_LEN;
use sidekicks_contracts::run::events::{InterventionActor, RunStateChangeState};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::{
    AgentRunInterveneRequest, AgentRunInterveneResponse, InterventionId, InterventionState,
    InterventionType,
};
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::{FreeFormText, TextError};

use self::reached_state::{ReachedState, draft, response};
use self::request::{
    interrupt_choice_of, interrupt_keys, interrupt_reason, intervention_type_of, request_guards,
    stored_payload_of,
};
use crate::database::connection::read_pool::{DatabaseReadPool, ReadLength};
use crate::database::statement::WriteStatement;
use crate::error_description::describe_error;
use crate::events::log_service::EventLogService;
use crate::events::session::appender::{
    SessionEventAppendError, SessionEventAppender, SessionEventDraft, SessionEventDraftError,
    SessionEventLinkage,
};
use crate::events::session::version::SESSION_EVENT_VERSION;
use crate::interventions::interrupt_queue::{
    InterruptCause, InterruptEnd, InterruptQueue, InterruptQueueError,
};
use crate::interventions::store::{
    InterventionTransition, RequestedIntervention, UnresolvedInterventionState,
    insert_requested_intervention_statement, move_intervention_statement,
    read_intervention_by_idempotency_key, run_at_version_statement, run_in_states_statement,
};
use crate::ipc::domain_error::DomainError;
use crate::ipc::handlers::driver::resolution::resolve_run_driver;
use crate::keyed_lock::KeyedLock;
use crate::provider::driver::contract::{DriverError, ProviderDriver, bound_failure_detail};
use crate::provider::driver::registry::ProviderRegistry;
use crate::provider::driver::run_control::{
    ApplyInterventionParams, FasterModelRetryOutcome, FasterModelRetryParams, InterruptPayload,
    InterventionResultStatus,
};
use crate::session::run::engine::{InterruptRoute, RunEngine, RunEngineError};
use crate::session::run::projection::advance_run_version_statement;
use crate::session::run::read::{RunRead, read_run_provider, read_run_through};
use crate::session::run::refusals::RunRefusal;
use crate::session::run::state_change::{RunStateChangeCompanions, refused_statement_index};
use crate::session::run::transitions::states_that_may_enter;
use crate::settle_all::{SettleFailures, settle_all};
use crate::text_cut::cut_to_code_points;
use crate::uuid_v7::mint_uuid_v7;

/// The statements the service's reads prepare on its pooled connection: the run's row, its
/// provider and the row saved under a reused key.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's start"))]
pub(crate) const INTERVENTION_SERVICE_STATEMENT_CAPACITY: usize = 3;

// The insert of a request is the first statement of its write.
const INSERT_STATEMENT_INDEX: usize = 0;

// The positions of the accepting write's two guards among its statements.
const ACCEPT_VERSION_GUARD_INDEX: usize = 0;
const ACCEPT_STATE_GUARD_INDEX: usize = 1;

/// What the interventions service reads and writes through.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's start"))]
pub(crate) struct InterventionServiceDeps {
    /// The read pool every read borrows a connection from.
    pub(crate) pool: Arc<DatabaseReadPool>,
    /// The event log every intervention event is appended to.
    pub(crate) event_log: Arc<EventLogService>,
    /// The run engine, which routes an interrupt and forgets a limit's late hand.
    pub(crate) engine: Arc<RunEngine>,
    /// The registered drivers, which carry out a dispatch.
    pub(crate) providers: Arc<ProviderRegistry>,
    /// The run queue, which an interrupt's end goes through.
    pub(crate) queue: Arc<dyn InterruptQueue>,
}

/// Takes every intervention on a run, a person's from their device's connection and the daemon's
/// own at a limit, to one durable row, at most one dispatch and one outcome. Cloning shares its
/// locks, so a clone a task carries orders its writes with the rest.
#[derive(Clone)]
pub(crate) struct InterventionService {
    /// The read pool every read borrows a connection from.
    pub(super) pool: Arc<DatabaseReadPool>,
    /// The appender every intervention event goes through.
    pub(super) appender: Arc<SessionEventAppender>,
    /// The run engine.
    pub(super) engine: Arc<RunEngine>,
    /// The registered drivers.
    pub(super) providers: Arc<ProviderRegistry>,
    /// The run queue.
    pub(super) queue: Arc<dyn InterruptQueue>,
    /// Orders each run's interrupts, a person's and the daemon's own alike, apart from its
    /// retries.
    pub(super) interrupt_lock: Arc<KeyedLock<RunId>>,
    // Orders each run's retries.
    retry_lock: Arc<KeyedLock<RunId>>,
}

/// What one intervention's writes and events name.
#[derive(Clone, Debug)]
pub(super) struct InterventionTarget {
    /// The run's session.
    pub(super) session_id: SessionId,
    /// The intervention.
    pub(super) intervention_id: InterventionId,
    /// The run it acts on.
    pub(super) target_run_id: RunId,
    /// What it does.
    pub(super) intervention_type: InterventionType,
    /// Who it is from.
    pub(super) actor: InterventionActor,
}

/// What carrying out an intervention did.
pub(super) enum Verdict {
    /// Carried out as asked.
    Applied,
    /// Carried out through the fallback the driver names, where it named one.
    Degraded(Option<FreeFormText<PROVIDER_FALLBACK_ACTION_MAX_LEN>>),
}

// An outcome that applies nothing.
enum Resolution {
    // Refused, with why.
    Rejected(FreeFormText<PROVIDER_WIRE_HANDLE_MAX_LEN>),
    // Outdated before it could apply.
    Expired,
}

// What a person's dispatch produced, as the row's next move from `accepted`.
enum DispatchOutcome {
    Carried(Verdict),
    Unapplied(Resolution),
}

/// A failure recorded as the row's `failed` outcome, with the reason the row, its event and the
/// answer carry.
pub(super) struct RecordedFailure {
    /// The reason recorded.
    pub(super) reason: FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>,
    /// What the dispatch threw.
    pub(super) dispatch: DispatchError,
}

/// Why a dispatch threw or could not run; its row moves to `failed` with a refusal's code, else
/// its description.
#[derive(Debug, thiserror::Error)]
pub(crate) enum DispatchError {
    /// A refusal with a code: the run has no row or no driver, or its provider answers no
    /// driver.
    #[error(transparent)]
    Refused(DomainError),
    /// The driver failed.
    #[error(transparent)]
    Driver(DriverError),
    /// The run engine's route or read failed.
    #[error(transparent)]
    Engine(RunEngineError),
    /// The retry's refusal gave a reason that is no machine-readable cause.
    #[error("the retry's refusal gave a reason that cannot be recorded")]
    RejectionReason(#[source] TextError),
    /// A token or spend limit's run ended and was continued before the dispatch, so the continued
    /// run's own stop cuts it.
    #[error("the run ended and was continued before the dispatch")]
    RunContinued,
}

impl From<RunEngineError> for DispatchError {
    /// A refusal keeps its code; any other engine failure is kept whole.
    fn from(error: RunEngineError) -> Self {
        match error {
            RunEngineError::Refused(refusal) => Self::Refused(refusal.into()),
            RunEngineError::Provider(refusal) => Self::Refused(refusal),
            error @ (RunEngineError::Change { .. }
            | RunEngineError::Released { .. }
            | RunEngineError::Gate { .. }
            | RunEngineError::NoResolvedPosture { .. }
            | RunEngineError::Driver { .. }
            | RunEngineError::LimitInterrupterGone { .. }
            | RunEngineError::LimitInterrupt { .. }
            | RunEngineError::ProviderUnknown { .. }
            | RunEngineError::DaemonTurn { .. }
            | RunEngineError::Agent { .. }
            | RunEngineError::Draft { .. }
            | RunEngineError::Append { .. }
            | RunEngineError::Read { .. }
            | RunEngineError::Pool { .. }
            | RunEngineError::Several { .. }) => Self::Engine(error),
        }
    }
}

/// Why the service did not answer an intervention; what each step wrote before the failure is
/// kept.
#[derive(Debug, thiserror::Error)]
pub(crate) enum InterventionError {
    /// A refusal with a code: an unknown run, or a reused key with another request.
    #[error(transparent)]
    Refused(DomainError),
    /// The insert was refused on a spent key, and the row saved under it cannot be read back.
    #[error("the intervention saved under key {key} on run {run_id} cannot be read back")]
    Unsaved {
        /// The run.
        run_id: RunId,
        /// The spent key.
        key: String,
    },
    /// A rejected or failed row holds no reason.
    #[error(
        "intervention {intervention_id} ended {} with no reason",
        <&'static str>::from(*.state)
    )]
    Unreasoned {
        /// The intervention.
        intervention_id: InterventionId,
        /// Its state.
        state: InterventionState,
    },
    /// An intervention's event breaks a check of its type.
    #[error("the intervention's event could not be drafted")]
    Draft(#[from] SessionEventDraftError),
    /// The event log did not keep a step's write.
    #[error("the intervention's step was not recorded")]
    Append(#[from] SessionEventAppendError),
    /// A read or the run's end failed.
    #[error(transparent)]
    Engine(#[from] RunEngineError),
    /// The run queue's part in an interrupt failed.
    #[error("the run queue failed its part in the interrupt")]
    Queue(#[source] InterruptQueueError),
    /// The dispatch threw, and the write recording its failure did not land.
    #[error(
        "intervention {intervention_id} failed in dispatch ({}), and recording it failed too",
        describe_error(dispatch)
    )]
    Unrecorded {
        /// The intervention.
        intervention_id: InterventionId,
        /// What the dispatch threw.
        dispatch: DispatchError,
        /// Why the failure was not recorded.
        #[source]
        record: SessionEventAppendError,
    },
    /// A step failed and so did the release of the queue's hold after it, both kept.
    #[error(transparent)]
    Several(Box<SettleFailures<InterventionError>>),
}

impl InterventionService {
    /// A service over `deps`, with no run locked.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's start"))]
    pub(crate) fn new(deps: InterventionServiceDeps) -> Self {
        let InterventionServiceDeps {
            pool,
            event_log,
            engine,
            providers,
            queue,
        } = deps;
        Self {
            pool,
            appender: Arc::new(SessionEventAppender::new(
                event_log,
                SESSION_EVENT_VERSION.clone(),
            )),
            engine,
            providers,
            queue,
            interrupt_lock: Arc::new(KeyedLock::new()),
            retry_lock: Arc::new(KeyedLock::new()),
        }
    }

    /// Records `request` from `actor`, accepts it if the run is still at its expected version and
    /// in a state its type acts on, dispatches it once and answers with the state it reached. A
    /// reused key answers the saved result and dispatches nothing. Refuses `agent.run.notFound`
    /// for an unknown run and `agent.intervention.idempotencyConflict` for a reused key whose
    /// request differs; a dispatch that throws answers `failed` with its reason.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the agent.run.intervene handler")
    )]
    pub(crate) async fn apply_intervention(
        &self,
        request: AgentRunInterveneRequest,
        actor: InterventionActor,
    ) -> Result<AgentRunInterveneResponse, InterventionError> {
        let (run_id, lock) = match &request {
            AgentRunInterveneRequest::Interrupt(interrupt) => {
                (interrupt_keys(interrupt).0, &self.interrupt_lock)
            }
            AgentRunInterveneRequest::FasterModelRetry { target_run_id, .. } => {
                (*target_run_id, &self.retry_lock)
            }
        };
        let _hold = lock.acquire(run_id).await;
        let run = self.require_run(run_id).await?;
        let target = InterventionTarget {
            session_id: run.session_id,
            intervention_id: mint_intervention_id(),
            target_run_id: run_id,
            intervention_type: intervention_type_of(&request),
            actor,
        };
        let payload = stored_payload_of(&request);
        let (expected_run_version, key) = request_guards(&request);
        let requested = RequestedIntervention {
            intervention_id: target.intervention_id,
            target_run_id: run_id,
            intervention_type: target.intervention_type,
            payload: payload.clone(),
            expected_run_version,
            client_idempotency_key: key.clone(),
            device_id: device_of(&target.actor),
        };
        let inserted = self
            .append(
                draft(&target, &ReachedState::Requested)?,
                vec![insert_requested_intervention_statement(&requested)],
                Vec::new(),
            )
            .await;
        if let Err(error) = inserted {
            return match refused_statement_index(&error) {
                Some(INSERT_STATEMENT_INDEX) => {
                    self.answer_reused_key(&request, run_id, key, &payload)
                        .await
                }
                _ => Err(error.into()),
            };
        }
        let AgentRunInterveneRequest::Interrupt(interrupt) = &request else {
            return self.accept_and_apply(&target, &request).await;
        };
        let choice = interrupt_choice_of(interrupt);
        self.queue
            .hold_for_interrupt(run_id, choice)
            .await
            .map_err(InterventionError::Queue)?;
        let applied = self.accept_and_apply(&target, &request).await;
        let released = self
            .queue
            .release_interrupt(run_id, choice)
            .await
            .map_err(InterventionError::Queue);
        match settle_all(
            (applied, released),
            "applying an interrupt and releasing its hold",
        ) {
            Ok((answer, ())) => Ok(answer),
            Err(SettleFailures::One(failure)) => Err(failure),
            Err(many @ SettleFailures::Many { .. }) => {
                Err(InterventionError::Several(Box::new(many)))
            }
        }
    }

    // Accepts the recorded request against the run, dispatches it once and records its outcome.
    async fn accept_and_apply(
        &self,
        target: &InterventionTarget,
        request: &AgentRunInterveneRequest,
    ) -> Result<AgentRunInterveneResponse, InterventionError> {
        let (expected_run_version, _key) = request_guards(request);
        let accepting_states = match target.intervention_type {
            InterventionType::Interrupt => states_that_may_enter(RunStateChangeState::Interrupted),
            InterventionType::FasterModelRetry => vec![RunState::Running],
        };
        let accepted = self
            .append(
                draft(target, &ReachedState::Accepted)?,
                vec![
                    run_at_version_statement(
                        &target.target_run_id,
                        i64::from(expected_run_version),
                    ),
                    run_in_states_statement(&target.target_run_id, &accepting_states),
                    move_intervention_statement(
                        &target.intervention_id,
                        &InterventionTransition::Accept,
                    ),
                ],
                Vec::new(),
            )
            .await;
        if let Err(error) = accepted {
            let resolution = match refused_statement_index(&error) {
                Some(ACCEPT_VERSION_GUARD_INDEX) => Resolution::Expired,
                Some(ACCEPT_STATE_GUARD_INDEX) => Resolution::Rejected(
                    FreeFormText::new(RefusalCode::AgentRunInvalidTransition.as_str().to_owned())
                        .expect("a refusal code is a machine-readable cause"),
                ),
                _ => return Err(error.into()),
            };
            return self
                .resolve(target, UnresolvedInterventionState::Requested, resolution)
                .await;
        }
        let outcome = match self.dispatch(target.session_id, request).await {
            Ok(outcome) => outcome,
            Err(dispatch) => {
                let failure = self.record_failure(target, dispatch).await?;
                return self
                    .answer(target, &ReachedState::Failed(failure.reason))
                    .await;
            }
        };
        let end = match request {
            AgentRunInterveneRequest::Interrupt(interrupt) => Some(RunEndOfVerdict {
                accepted_run_version: i64::from(expected_run_version),
                cause: InterruptCause::Person(interrupt_choice_of(interrupt)),
            }),
            AgentRunInterveneRequest::FasterModelRetry { .. } => None,
        };
        match outcome {
            DispatchOutcome::Carried(verdict) => {
                let state = self.record_verdict(target, verdict, end).await?;
                self.answer(target, &state).await
            }
            DispatchOutcome::Unapplied(resolution) => {
                self.resolve(target, UnresolvedInterventionState::Accepted, resolution)
                    .await
            }
        }
    }

    // Sends a person's request to whatever carries it out, exactly once.
    async fn dispatch(
        &self,
        session_id: SessionId,
        request: &AgentRunInterveneRequest,
    ) -> Result<DispatchOutcome, DispatchError> {
        match request {
            AgentRunInterveneRequest::FasterModelRetry {
                target_run_id,
                expected_turn_id,
                model,
                ..
            } => {
                let driver = self.run_driver(*target_run_id).await?;
                let retried = driver
                    .retry_turn_on_faster_model(FasterModelRetryParams {
                        session_id,
                        run_id: *target_run_id,
                        expected_turn_id: expected_turn_id.as_str().to_owned(),
                        model: model.clone(),
                    })
                    .await
                    .map_err(DispatchError::Driver)?;
                match retried {
                    FasterModelRetryOutcome::Applied {} => {
                        Ok(DispatchOutcome::Carried(Verdict::Applied))
                    }
                    FasterModelRetryOutcome::Rejected { rejection_reason } => {
                        let reason =
                            cut_to_code_points(&rejection_reason, PROVIDER_WIRE_HANDLE_MAX_LEN);
                        FreeFormText::new(reason.to_owned())
                            .map(|reason| DispatchOutcome::Unapplied(Resolution::Rejected(reason)))
                            .map_err(DispatchError::RejectionReason)
                    }
                }
            }
            AgentRunInterveneRequest::Interrupt(interrupt) => {
                let (run_id, expected_run_version, key) = interrupt_keys(interrupt);
                // A stop never reaches a driver that does not have the run.
                match self.engine.route_interrupt(run_id).await? {
                    InterruptRoute::Claimed => Ok(DispatchOutcome::Carried(Verdict::Applied)),
                    InterruptRoute::Ended => Ok(DispatchOutcome::Unapplied(Resolution::Expired)),
                    InterruptRoute::Driver => self
                        .interrupt_through_driver(
                            run_id,
                            expected_run_version,
                            key.clone(),
                            InterruptPayload {
                                pending: interrupt_choice_of(interrupt).pending,
                                reason: interrupt_reason(interrupt).clone(),
                            },
                        )
                        .await
                        .map(DispatchOutcome::Carried),
                }
            }
        }
    }

    /// Has the driver of `run_id` interrupt its turn with `payload` and answers its verdict.
    /// Fails as the driver's resolution or the driver fails.
    pub(super) async fn interrupt_through_driver(
        &self,
        run_id: RunId,
        expected_run_version: SafeInt<0>,
        client_idempotency_key: ClientUuid,
        payload: InterruptPayload,
    ) -> Result<Verdict, DispatchError> {
        let answered = self
            .run_driver(run_id)
            .await?
            .apply_intervention(ApplyInterventionParams::Interrupt {
                target_run_id: run_id,
                expected_run_version,
                client_idempotency_key,
                payload,
            })
            .await
            .map_err(DispatchError::Driver)?;
        Ok(match answered.status {
            InterventionResultStatus::Applied => Verdict::Applied,
            InterventionResultStatus::Degraded => Verdict::Degraded(answered.fallback_action),
        })
    }

    // The driver of the provider `run_id` runs on.
    async fn run_driver(&self, run_id: RunId) -> Result<Arc<dyn ProviderDriver>, DispatchError> {
        let bound = self
            .pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, RunEngineError>(read_run_provider(reader, &run_id)?)
            })
            .await?;
        resolve_run_driver(&self.providers, run_id, bound)
            .map(|resolved| resolved.driver)
            .map_err(DispatchError::Refused)
    }

    /// Records an applied or degraded verdict from `accepted`: an interrupt's in the write that
    /// ends its run through the run queue as `end` says, and alone where the run ended since; a
    /// retry's with the run's version advanced. Answers the state reached. Fails as the run
    /// queue or the write fails.
    pub(super) async fn record_verdict(
        &self,
        target: &InterventionTarget,
        verdict: Verdict,
        end: Option<RunEndOfVerdict>,
    ) -> Result<ReachedState, InterventionError> {
        let (transition, state, is_degraded) = match verdict {
            Verdict::Degraded(fallback_action) => (
                InterventionTransition::Degrade { fallback_action },
                ReachedState::Degraded,
                true,
            ),
            Verdict::Applied => (
                InterventionTransition::Apply {
                    from: UnresolvedInterventionState::Accepted,
                },
                ReachedState::Applied,
                false,
            ),
        };
        let row_move = move_intervention_statement(&target.intervention_id, &transition);
        let event = draft(target, &state)?;
        let has_ended_run = match end {
            Some(RunEndOfVerdict {
                accepted_run_version,
                cause,
            }) => self
                .queue
                .end_run_for_interrupt(InterruptEnd {
                    run_id: target.target_run_id,
                    accepted_run_version,
                    cause,
                    is_degraded,
                    verdict: RunStateChangeCompanions {
                        statements: vec![row_move.clone()],
                        preceding_events: vec![event.clone()],
                        leading_event: None,
                    },
                })
                .await
                .map_err(InterventionError::Queue)?,
            None => false,
        };
        if !has_ended_run {
            // An interrupt's verdict never advances the version, having found its run ended. Any
            // other verdict stands whatever the run did since the accept, so its advance holds no
            // comparand.
            let statements = match target.intervention_type {
                InterventionType::Interrupt => vec![row_move],
                InterventionType::FasterModelRetry => vec![
                    advance_run_version_statement(&target.session_id, &target.target_run_id),
                    row_move,
                ],
            };
            self.append(event, statements, Vec::new()).await?;
        }
        Ok(state)
    }

    /// Ends the row `failed` from `accepted` with what `dispatch` threw, its event and the row
    /// carrying one reason. Fails with [`InterventionError::Unrecorded`], keeping both causes,
    /// when the write does not land.
    pub(super) async fn record_failure(
        &self,
        target: &InterventionTarget,
        dispatch: DispatchError,
    ) -> Result<RecordedFailure, InterventionError> {
        let reason = bound_failure_detail(
            &failure_text_of(&dispatch),
            FreeFormText::new("The intervention's dispatch failed without a message".to_owned())
                .expect("the fallback is non-blank and within the cap"),
        );
        let state = ReachedState::Failed(reason.clone());
        let recorded = self
            .append(
                draft(target, &state)?,
                vec![move_intervention_statement(
                    &target.intervention_id,
                    &InterventionTransition::Fail {
                        reason: reason.clone(),
                    },
                )],
                Vec::new(),
            )
            .await;
        match recorded {
            Ok(()) => Ok(RecordedFailure { reason, dispatch }),
            Err(record) => Err(InterventionError::Unrecorded {
                intervention_id: target.intervention_id,
                dispatch,
                record,
            }),
        }
    }

    // Ends the row from `from` in an outcome that applies nothing, with its event, and answers it.
    async fn resolve(
        &self,
        target: &InterventionTarget,
        from: UnresolvedInterventionState,
        resolution: Resolution,
    ) -> Result<AgentRunInterveneResponse, InterventionError> {
        let (transition, state) = match resolution {
            Resolution::Rejected(reason) => (
                InterventionTransition::Reject {
                    from,
                    reason: reason.clone(),
                },
                ReachedState::Rejected(reason),
            ),
            Resolution::Expired => (
                InterventionTransition::Expire { from },
                ReachedState::Expired,
            ),
        };
        self.append(
            draft(target, &state)?,
            vec![move_intervention_statement(
                &target.intervention_id,
                &transition,
            )],
            Vec::new(),
        )
        .await?;
        self.answer(target, &state).await
    }

    // A reused key answers what the first request saved when the two ask for the same thing.
    async fn answer_reused_key(
        &self,
        request: &AgentRunInterveneRequest,
        run_id: RunId,
        key: &ClientUuid,
        payload: &str,
    ) -> Result<AgentRunInterveneResponse, InterventionError> {
        let read_key = key.clone();
        let saved = self
            .pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, RunEngineError>(read_intervention_by_idempotency_key(
                    reader, &run_id, &read_key,
                )?)
            })
            .await?
            // The insert was refused on this key, and an intervention row is never deleted.
            .ok_or_else(|| InterventionError::Unsaved {
                run_id,
                key: key.as_str().to_owned(),
            })?;
        if saved.intervention_type != intervention_type_of(request) || saved.payload != payload {
            return Err(InterventionError::Refused(
                DomainError::new(
                    "The idempotency key was already used for a different intervention on this \
                     run",
                    RefusalCode::AgentInterventionIdempotencyConflict,
                )
                .with_detail(
                    json!({ "targetRunId": run_id, "interventionId": saved.intervention_id }),
                ),
            ));
        }
        let reason_missing = || InterventionError::Unreasoned {
            intervention_id: saved.intervention_id,
            state: saved.state,
        };
        let state = match saved.state {
            InterventionState::Requested => ReachedState::Requested,
            InterventionState::Accepted => ReachedState::Accepted,
            InterventionState::Applied => ReachedState::Applied,
            InterventionState::Degraded => ReachedState::Degraded,
            InterventionState::Expired => ReachedState::Expired,
            InterventionState::Rejected => {
                ReachedState::Rejected(saved.rejection_reason.clone().ok_or_else(reason_missing)?)
            }
            InterventionState::Failed => {
                ReachedState::Failed(saved.failure_reason.clone().ok_or_else(reason_missing)?)
            }
        };
        let run = self.require_run(run_id).await?;
        Ok(response(
            saved.intervention_id,
            saved.intervention_type,
            &run,
            &state,
        ))
    }

    // The answer for `state`, with the run's version as it is now.
    async fn answer(
        &self,
        target: &InterventionTarget,
        state: &ReachedState,
    ) -> Result<AgentRunInterveneResponse, InterventionError> {
        let run = self.require_run(target.target_run_id).await?;
        Ok(response(
            target.intervention_id,
            target.intervention_type,
            &run,
            state,
        ))
    }

    /// The run as it reads now, refused `agent.run.notFound` for a run the daemon has no row for.
    /// Fails as the read fails.
    pub(super) async fn require_run(&self, run_id: RunId) -> Result<RunRead, RunEngineError> {
        read_run_through::<RunEngineError>(&self.pool, run_id)
            .await?
            .ok_or(RunEngineError::Refused(RunRefusal::NotFound { run_id }))
    }

    /// Appends `draft` after `preceding_events`, with `statements` in its write.
    pub(super) async fn append(
        &self,
        draft: SessionEventDraft,
        statements: Vec<WriteStatement>,
        preceding_events: Vec<SessionEventDraft>,
    ) -> Result<(), SessionEventAppendError> {
        self.appender
            .append(
                draft,
                SessionEventLinkage {
                    transactional_prelude: statements,
                    preceding_events,
                    ..SessionEventLinkage::default()
                },
            )
            .await
            .map(drop)
    }
}

/// What an interrupt's verdict ends its run with.
pub(super) struct RunEndOfVerdict {
    /// The run version the interrupt was accepted at.
    pub(super) accepted_run_version: i64,
    /// Whose interrupt it is.
    pub(super) cause: InterruptCause,
}

/// A fresh intervention id.
pub(super) fn mint_intervention_id() -> InterventionId {
    InterventionId::new(&mint_uuid_v7().to_string()).expect("a minted UUID is an intervention id")
}

// The stored device of a request from `actor`: none for the daemon's own.
fn device_of(actor: &InterventionActor) -> Option<DeviceId> {
    match actor {
        InterventionActor::Daemon(_) => None,
        InterventionActor::Device(device) => Some(device.device_id().clone()),
    }
}

// What a dispatch failure records: a refusal's code, else its description.
fn failure_text_of(error: &DispatchError) -> String {
    match error {
        DispatchError::Refused(refusal) | DispatchError::Driver(DriverError::Refused(refusal)) => {
            refusal.code.as_str().to_owned()
        }
        DispatchError::Driver(_)
        | DispatchError::Engine(_)
        | DispatchError::RejectionReason(_)
        | DispatchError::RunContinued => describe_error(error),
    }
}
