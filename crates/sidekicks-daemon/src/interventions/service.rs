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
//! that throws ends the request `failed`; one the provider got with no answer back leaves its row
//! `accepted`, and an interrupt's queue hold held, until the run's end or a turn's end settles
//! both, and a row such a settle reached while its dispatch was out answers that outcome. Retries
//! on one run take turns under a per-run lock, and interrupts, the daemon's own at a limit among
//! them, under another, so a stop never waits behind a retry and a retry still queued when it
//! lands meets the advanced version and expires.

pub(crate) mod errors;
pub(super) mod reached_state;
mod request;
mod saved;
#[cfg(test)]
pub(super) mod tests;

use std::sync::Arc;

use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::driver::length_limits::{
    PROVIDER_FAILURE_DETAIL_MAX_LEN, PROVIDER_FALLBACK_ACTION_MAX_LEN,
};
use sidekicks_contracts::provider::driver::methods::PROVIDER_WIRE_HANDLE_MAX_LEN;
use sidekicks_contracts::run::events::{InterventionActor, RunStateChangeState};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::{
    AgentRunInterveneRequest, AgentRunInterveneResponse, InterventionId, InterventionType,
};
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;

use self::errors::{DispatchError, InterventionError, failure_text_of};
use self::reached_state::{ReachedState, draft};
use self::request::{
    interrupt_choice_of, interrupt_keys, interrupt_reason, intervention_type_of, request_guards,
    stored_payload_of,
};
use self::saved::{idempotency_conflict, with_failed_read};
use crate::database::connection::read_pool::DatabaseReadPool;
use crate::database::statement::WriteStatement;
use crate::events::log_service::EventLogService;
use crate::events::session::appender::{
    SessionEventAppendError, SessionEventAppender, SessionEventDraft, SessionEventLinkage,
};
use crate::events::session::version::SESSION_EVENT_VERSION;
use crate::interventions::interrupt_queue::{InterruptCause, InterruptEnd, InterruptQueue};
use crate::interventions::store::{
    InterventionTransition, RequestedIntervention, UnresolvedInterventionState,
    insert_requested_intervention_statement, move_intervention_statement, run_at_version_statement,
    run_in_states_statement,
};
use crate::ipc::handlers::driver::resolution::read_run_driver;
use crate::keyed_lock::KeyedLock;
use crate::provider::driver::contract::{DriverError, bound_failure_detail};
use crate::provider::driver::registry::ProviderRegistry;
use crate::provider::driver::run_control::{
    ApplyInterventionParams, FasterModelRetryOutcome, FasterModelRetryParams, InterruptPayload,
    InterventionResultStatus,
};
use crate::session::run::engine::{InterruptRoute, RunEngine, RunEngineError};
use crate::session::run::projection::advance_run_version_statement;
use crate::session::run::read::{RunRead, read_run_through};
use crate::session::run::refusals::RunRefusal;
use crate::session::run::state_change::{RunStateChangeCompanions, refused_statement_index};
use crate::session::run::transitions::states_that_may_enter;
use crate::settle_all::{SettleFailures, settle_all};
use crate::text_cut::cut_to_code_points;
use crate::uuid_v7::mint_uuid_v7;

/// The statements the service's reads prepare on its pooled connection: the run's row, its
/// provider, and an intervention's row by its id and under a reused key.
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's start"))]
pub(crate) const INTERVENTION_SERVICE_STATEMENT_CAPACITY: usize = 4;

// The insert of a request is the first statement of its write.
const INSERT_STATEMENT_INDEX: usize = 0;

// The positions of the accepting write's two guards and its row's move among its statements.
const ACCEPT_VERSION_GUARD_INDEX: usize = 0;
const ACCEPT_STATE_GUARD_INDEX: usize = 1;
const ACCEPT_MOVE_INDEX: usize = 2;

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

/// What carrying out an intervention did, with the waiting messages an interrupt took back from
/// the provider, which none of it runs.
pub(super) enum Verdict {
    /// Carried out as asked.
    Applied {
        /// The messages taken back.
        cancelled: Vec<QueueItemId>,
    },
    /// Carried out through the fallback the driver names, where it named one.
    Degraded {
        /// The fallback taken.
        fallback_action: Option<FreeFormText<PROVIDER_FALLBACK_ACTION_MAX_LEN>>,
        /// The messages taken back.
        cancelled: Vec<QueueItemId>,
    },
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

// What accepting and dispatching a person's recorded request came to.
enum Dispatched {
    // The accept's guards refused it, with the outcome that ends the row from `requested`.
    Unaccepted(Resolution),
    // The dispatch answered.
    Answered(DispatchOutcome),
    // The dispatch threw.
    Threw(DispatchError),
    // The provider got it with no answer back.
    Unanswered,
    // A turn's end settled the row before the accept could move it.
    SettledSince,
}

/// A row's move as written, or none where the row reached an outcome since it was read: its run's
/// end or a turn's end settled it, and let go a person's interrupt's queue hold with it.
pub(super) enum RowMove<T> {
    /// The move landed, with what it recorded.
    Made(T),
    /// Another write settled the row first.
    SettledSince,
}

/// A dispatch's failure as the row's `failed` outcome records it, with what the dispatch threw.
pub(super) enum RecordedFailure {
    /// The row ended `failed` with this reason, which its event and the answer carry.
    Recorded {
        /// The reason recorded.
        reason: FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>,
        /// What the dispatch threw.
        dispatch: DispatchError,
    },
    /// The row reached an outcome another write gave it before the failure could be recorded.
    SettledSince {
        /// What the dispatch threw.
        dispatch: DispatchError,
    },
}

// Who lets go a person's interrupt's run queue hold: the request, once its own write settled the
// row or it failed, or the run engine, whose settle of the row at the run's end or a turn's end
// lets it go.
#[derive(Clone, Copy, PartialEq, Eq)]
enum HoldRelease {
    ByRequest,
    BySettle,
}

// A recorded request's answer, with who lets go its interrupt's queue hold.
struct Applied {
    answer: Result<AgentRunInterveneResponse, InterventionError>,
    hold_release: HoldRelease,
}

impl Applied {
    // A failure before any settle could reach the row's hold.
    fn failed(error: InterventionError) -> Self {
        Self {
            answer: Err(error),
            hold_release: HoldRelease::ByRequest,
        }
    }
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
    /// request differs; a dispatch that throws answers `failed` with its reason, and one the
    /// provider got with no answer back answers `accepted`, its row and an interrupt's queue hold
    /// left for the run's end or a turn's end to settle, or the outcome such a settle gave it.
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
        // A reused key answers what it saved before any hold is taken, so its replay redoes none
        // of the queue's work; read under the lock, it never sees a request of its type in flight.
        let payload = stored_payload_of(&request);
        let (_, key) = request_guards(&request);
        if let Some(saved) = self.read_saved_intervention(run_id, key).await? {
            return self.answer_saved(&request, run_id, saved, &payload).await;
        }
        let target = InterventionTarget {
            session_id: run.session_id,
            intervention_id: mint_intervention_id(),
            target_run_id: run_id,
            intervention_type: intervention_type_of(&request),
            actor,
        };
        let AgentRunInterveneRequest::Interrupt(interrupt) = &request else {
            return self
                .record_and_apply(&target, &request, payload)
                .await
                .answer;
        };
        // The queue's hold comes before the row, so a hold that fails leaves no row to apply.
        let choice = interrupt_choice_of(interrupt);
        self.queue
            .hold_for_interrupt(run_id, choice)
            .await
            .map_err(InterventionError::Queue)?;
        let Applied {
            answer: applied,
            hold_release,
        } = self.record_and_apply(&target, &request, payload).await;
        if hold_release == HoldRelease::BySettle {
            return applied;
        }
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

    // Records the request with its stored `payload`, then accepts, dispatches and settles it.
    async fn record_and_apply(
        &self,
        target: &InterventionTarget,
        request: &AgentRunInterveneRequest,
        payload: String,
    ) -> Applied {
        match self.record(target, request, payload).await {
            Ok(()) => self.accept_and_apply(target, request).await,
            Err(error) => Applied::failed(error),
        }
    }

    // Records the request with its stored `payload`. A key refused at the insert was spent since
    // the caller's read by a request of the other type, under the other lock, so it answers a
    // conflict.
    async fn record(
        &self,
        target: &InterventionTarget,
        request: &AgentRunInterveneRequest,
        payload: String,
    ) -> Result<(), InterventionError> {
        let run_id = target.target_run_id;
        let (expected_run_version, key) = request_guards(request);
        let requested = RequestedIntervention {
            intervention_id: target.intervention_id,
            target_run_id: run_id,
            intervention_type: target.intervention_type,
            payload,
            expected_run_version,
            client_idempotency_key: key.clone(),
            device_id: device_of(&target.actor),
        };
        let inserted = self
            .append(
                draft(target, &ReachedState::Requested)?,
                vec![insert_requested_intervention_statement(&requested)],
                Vec::new(),
            )
            .await;
        match inserted {
            Ok(()) => Ok(()),
            Err(error) => match refused_statement_index(&error) {
                Some(INSERT_STATEMENT_INDEX) => {
                    let saved = self
                        .read_saved_intervention(run_id, key)
                        .await?
                        // An intervention row is never deleted.
                        .ok_or_else(|| InterventionError::Unsaved {
                            run_id,
                            key: key.as_str().to_owned(),
                        })?;
                    Err(idempotency_conflict(run_id, saved.intervention_id))
                }
                _ => Err(error.into()),
            },
        }
    }

    // Accepts the recorded request against the run, dispatches it once and records its outcome.
    async fn accept_and_apply(
        &self,
        target: &InterventionTarget,
        request: &AgentRunInterveneRequest,
    ) -> Applied {
        let dispatched = match self.accept_and_dispatch(target, request).await {
            Ok(dispatched) => dispatched,
            Err(error) => return Applied::failed(error),
        };
        let row_move = match dispatched {
            // The provider may still carry it out, so the row and the hold stay for the run's end
            // or a turn's end, the run's end settling it here when it read the row too early.
            Dispatched::Unanswered => {
                let answer = match self
                    .engine
                    .settle_unresolved_of_ended_run(target.target_run_id)
                    .await
                {
                    Ok(_) => self.answer_stored(target).await,
                    Err(error) => Err(error.into()),
                };
                return Applied {
                    answer,
                    hold_release: HoldRelease::BySettle,
                };
            }
            Dispatched::SettledSince => Ok(RowMove::SettledSince),
            Dispatched::Unaccepted(resolution) => {
                self.resolve(target, UnresolvedInterventionState::Requested, resolution)
                    .await
            }
            Dispatched::Answered(DispatchOutcome::Unapplied(resolution)) => {
                self.resolve(target, UnresolvedInterventionState::Accepted, resolution)
                    .await
            }
            Dispatched::Answered(DispatchOutcome::Carried(verdict)) => {
                let end = match request {
                    AgentRunInterveneRequest::Interrupt(interrupt) => Some(RunEndOfVerdict {
                        accepted_run_version: i64::from(request_guards(request).0),
                        cause: InterruptCause::Person(interrupt_choice_of(interrupt)),
                    }),
                    AgentRunInterveneRequest::FasterModelRetry { .. } => None,
                };
                self.record_verdict(target, verdict, end).await
            }
            Dispatched::Threw(dispatch) => match self.record_failure(target, dispatch).await {
                Ok(RecordedFailure::Recorded { reason, .. }) => {
                    Ok(RowMove::Made(ReachedState::Failed(reason)))
                }
                Ok(RecordedFailure::SettledSince { .. }) => Ok(RowMove::SettledSince),
                Err(error) => Err(error),
            },
        };
        match row_move {
            Ok(RowMove::Made(state)) => Applied {
                answer: self.answer(target, &state).await,
                hold_release: HoldRelease::ByRequest,
            },
            Ok(RowMove::SettledSince) => Applied {
                answer: self.answer_stored(target).await,
                hold_release: HoldRelease::BySettle,
            },
            Err(error) => Applied::failed(error),
        }
    }

    // Accepts the recorded request against the run and dispatches it once.
    async fn accept_and_dispatch(
        &self,
        target: &InterventionTarget,
        request: &AgentRunInterveneRequest,
    ) -> Result<Dispatched, InterventionError> {
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
            return match refused_statement_index(&error) {
                Some(ACCEPT_VERSION_GUARD_INDEX) => Ok(Dispatched::Unaccepted(Resolution::Expired)),
                Some(ACCEPT_STATE_GUARD_INDEX) => Ok(Dispatched::Unaccepted(Resolution::Rejected(
                    FreeFormText::new(RefusalCode::AgentRunInvalidTransition.as_str().to_owned())
                        .expect("a refusal code is a machine-readable cause"),
                ))),
                Some(ACCEPT_MOVE_INDEX) => Ok(Dispatched::SettledSince),
                _ => Err(error.into()),
            };
        }
        Ok(match self.dispatch(target.session_id, request).await {
            Ok(outcome) => Dispatched::Answered(outcome),
            Err(DispatchError::Driver(DriverError::Unanswered(unanswered))) => {
                tracing::info!(
                    intervention_id = %target.intervention_id,
                    error = %unanswered,
                    "the provider got the intervention with no answer back"
                );
                Dispatched::Unanswered
            }
            Err(dispatch) => Dispatched::Threw(dispatch),
        })
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
                let driver =
                    read_run_driver::<DispatchError>(&self.pool, &self.providers, *target_run_id)
                        .await?;
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
                        Ok(DispatchOutcome::Carried(Verdict::Applied {
                            cancelled: Vec::new(),
                        }))
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
                    InterruptRoute::Claimed => Ok(DispatchOutcome::Carried(Verdict::Applied {
                        cancelled: Vec::new(),
                    })),
                    InterruptRoute::Ended => Ok(DispatchOutcome::Unapplied(Resolution::Expired)),
                    InterruptRoute::Driver => self
                        .interrupt_through_driver(
                            run_id,
                            expected_run_version,
                            key.clone(),
                            InterruptPayload {
                                pending: interrupt_choice_of(interrupt).pending,
                                reason: interrupt_reason(interrupt).cloned(),
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
        let answered = read_run_driver::<DispatchError>(&self.pool, &self.providers, run_id)
            .await?
            .apply_intervention(ApplyInterventionParams::Interrupt {
                target_run_id: run_id,
                expected_run_version,
                client_idempotency_key,
                payload,
            })
            .await
            .map_err(DispatchError::Driver)?;
        let cancelled = answered.cancelled;
        Ok(match answered.status {
            InterventionResultStatus::Applied => Verdict::Applied { cancelled },
            InterventionResultStatus::Degraded => Verdict::Degraded {
                fallback_action: answered.fallback_action,
                cancelled,
            },
        })
    }

    /// Records an applied or degraded verdict from `accepted`: an interrupt's in the write that
    /// ends its run through the run queue as `end` says, handing it the messages the provider gave
    /// back, and alone where the run ended since; a retry's with the run's version advanced.
    /// Answers the state reached, or none where the run's end or a turn's end settled the row
    /// first. Fails as the run queue or the write fails.
    pub(super) async fn record_verdict(
        &self,
        target: &InterventionTarget,
        verdict: Verdict,
        end: Option<RunEndOfVerdict>,
    ) -> Result<RowMove<ReachedState>, InterventionError> {
        let (transition, state, is_degraded, cancelled) = match verdict {
            Verdict::Degraded {
                fallback_action,
                cancelled,
            } => (
                InterventionTransition::Degrade { fallback_action },
                ReachedState::Degraded,
                true,
                cancelled,
            ),
            Verdict::Applied { cancelled } => (
                InterventionTransition::Apply {
                    from: UnresolvedInterventionState::Accepted,
                },
                ReachedState::Applied,
                false,
                cancelled,
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
                    cancelled,
                    verdict: RunStateChangeCompanions {
                        statements: vec![row_move.clone()],
                        preceding_events: vec![event.clone()],
                        leading_event: None,
                        settled_interventions: vec![target.intervention_id],
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
            let row_move_index = statements.len() - 1;
            if let Err(error) = self.append(event, statements, Vec::new()).await {
                return match refused_statement_index(&error) {
                    Some(index) if index == row_move_index => {
                        self.settled_since_or(target, error.into()).await
                    }
                    _ => Err(error.into()),
                };
            }
        }
        Ok(RowMove::Made(state))
    }

    /// Ends the row `failed` from `accepted` with what `dispatch` threw, its event and the row
    /// carrying one reason, unless the run's end or a turn's end settled the row first. Fails with
    /// [`InterventionError::Unrecorded`], keeping both causes, when the write does not land.
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
        let record = match recorded {
            Ok(()) => return Ok(RecordedFailure::Recorded { reason, dispatch }),
            Err(record) => record,
        };
        // The row's move is the write's one statement.
        let is_settled_since = if refused_statement_index(&record) == Some(0) {
            self.is_settled_since(target).await
        } else {
            Ok(false)
        };
        let unrecorded = |dispatch, record| InterventionError::Unrecorded {
            intervention_id: target.intervention_id,
            dispatch,
            record,
        };
        match is_settled_since {
            Ok(true) => Ok(RecordedFailure::SettledSince { dispatch }),
            Ok(false) => Err(unrecorded(dispatch, record)),
            Err(read) => Err(with_failed_read(unrecorded(dispatch, record), read)),
        }
    }

    // Ends the row from `from` in an outcome that applies nothing, with its event, unless the run's
    // end or a turn's end settled it first.
    async fn resolve(
        &self,
        target: &InterventionTarget,
        from: UnresolvedInterventionState,
        resolution: Resolution,
    ) -> Result<RowMove<ReachedState>, InterventionError> {
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
        let resolved = self
            .append(
                draft(target, &state)?,
                vec![move_intervention_statement(
                    &target.intervention_id,
                    &transition,
                )],
                Vec::new(),
            )
            .await;
        match resolved {
            Ok(()) => Ok(RowMove::Made(state)),
            // The row's move is the write's one statement.
            Err(error) if refused_statement_index(&error) == Some(0) => {
                self.settled_since_or(target, error.into()).await
            }
            Err(error) => Err(error.into()),
        }
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
