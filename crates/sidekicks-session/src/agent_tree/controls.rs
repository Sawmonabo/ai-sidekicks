//! A person's controls on a session's helpers: one helper of a run, named by its handle, is
//! refused by the run it belongs to, then that run's version, then the handle, and interrupted,
//! paused or continued through its own run by the service that does so to any run; the stop of
//! every agent a session dispatched sweeps the session's tree and appends one flow row naming the
//! agents it reached.

use std::sync::Arc;

use serde_json::json;
use sidekicks_contracts::agent::tree::ChildHandle;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::run::children::{
    AgentChildRunControlRefusedDetails, AgentChildRunControlRefusedReason,
    AgentChildRunInterruptRequest, AgentChildRunInterruptResponse,
    AgentChildRunPausedUpdateNotPaused, AgentChildRunPausedUpdatePaused,
    AgentChildRunPausedUpdateRequest, AgentChildRunPausedUpdateResponse,
    AgentChildRunStopAllRequest, AgentChildRunStopAllResponse, ChildStopOutcome,
};
use sidekicks_contracts::run::control::{AgentRunPauseRequest, AgentRunResumeRequest};
use sidekicks_contracts::run::events::{AgentChildrenStoppedPayload, InterventionActor};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::{
    AgentRunInterveneRequest, AgentRunInterveneResponse, InterventionInterruptRequest,
};
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::{False, True};
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::not_found::session::session_not_found;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_provider::port::run_pause::ContinuedMessages;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::events::session::appender::{
    SessionEventAppender, SessionEventDraft, SessionEventEmitError, SessionEventLinkage,
};
use sidekicks_store::events::session::read::{DamagedFromSequenceReader, session_read_bound};

use crate::agent_tree::read::{AgentTreeReadError, resolve_child};
use crate::agent_tree::sweep::{AgentTreeSweep, AgentTreeSweepError, SweepRoot};
use crate::driver_resolution::read_session_provider;
use crate::interventions::service::InterventionService;
use crate::interventions::service::errors::InterventionError;
use crate::run::pause::{RunPauseControl, RunPauseError};
use crate::run::read::{RunStateReader, safe_run_version};
use crate::run::refusals::{RunRefusal, require_expected_version};

/// Why a child control was not answered.
#[derive(Debug, thiserror::Error)]
pub enum ChildRunControlError {
    /// The run the child belongs to is unknown or past the version the caller read
    /// (`agent.run.notFound`, `agent.run.versionStale`).
    #[error(transparent)]
    Run(#[from] RunRefusal),
    /// The handle names no child of the run (`agent.childRun.notFound`).
    #[error("the run holds no child with this handle")]
    ChildNotFound {
        /// The handle asked for.
        child_handle: ChildHandle,
    },
    /// The provider did not carry the act out (`agent.childRun.controlRefused`).
    #[error("the child's provider did not carry the control out")]
    Refused {
        /// Why.
        reason: AgentChildRunControlRefusedReason,
    },
    /// The intervention on the child's own run refused or failed, answered as it answers.
    #[error(transparent)]
    Intervention(#[from] InterventionError),
    /// The pause or the continue of the child's own run failed past a refusal of its move and the
    /// driver's refusal.
    #[error(transparent)]
    Pause(RunPauseError),
    /// The session is not one this daemon holds (`session.notFound`).
    #[error("this daemon holds no such session")]
    SessionNotFound {
        /// The session asked for.
        session_id: SessionId,
    },
    /// No driver answers the provider the session's lead runs on.
    #[error("no driver answers the provider of the session's lead")]
    LeadProvider(#[source] DomainError),
    /// The session's agents could not be read, so none was stopped.
    #[error(transparent)]
    Sweep(#[from] AgentTreeSweepError),
    /// The stop's flow row was not drafted or not kept.
    #[error("the flow row of the stop was not appended")]
    Row(#[from] SessionEventEmitError),
    /// The child's node or its own run could not be read.
    #[error(transparent)]
    Tree(#[from] AgentTreeReadError),
    /// SQLite refused a read, or a stored value did not read as its type.
    #[error("reading the run or its child failed")]
    Read(#[from] rusqlite::Error),
    /// A read did not reach a connection.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
}

impl From<ChildRunControlError> for HandlerError {
    /// A refusal answers by its code, the intervention's as it answers them (an unknown queue item
    /// among them); a failed read, a missing driver, a failed pause or continue past its
    /// refusals, a failed sweep and a lost row are faults in the daemon.
    fn from(error: ChildRunControlError) -> Self {
        match error {
            ChildRunControlError::Run(refusal) => Self::Refused(refusal.into()),
            ChildRunControlError::ChildNotFound { child_handle } => Self::Refused(
                DomainError::new(
                    "The run holds no child with this handle",
                    RefusalCode::AgentChildRunNotFound,
                )
                .with_detail(json!({ "childHandle": child_handle })),
            ),
            ChildRunControlError::Refused { reason } => Self::Refused(
                DomainError::new(
                    "The child's provider did not carry the control out",
                    RefusalCode::AgentChildRunControlRefused,
                )
                .with_detail(AgentChildRunControlRefusedDetails { reason }),
            ),
            ChildRunControlError::Intervention(error) => error.into(),
            ChildRunControlError::SessionNotFound { session_id } => {
                Self::Refused(session_not_found(&session_id))
            }
            fault @ (ChildRunControlError::Pause(_)
            | ChildRunControlError::LeadProvider(_)
            | ChildRunControlError::Sweep(_)
            | ChildRunControlError::Row(_)
            | ChildRunControlError::Tree(_)
            | ChildRunControlError::Read(_)
            | ChildRunControlError::Pool(_)) => Self::Internal(Box::new(fault)),
        }
    }
}

/// A person's controls on a session's helpers. Cloning the interventions service shares its
/// locks, so the child's own run takes its interrupts in turn with every other one.
pub struct ChildRunControls {
    // The read pool every read of a control borrows a connection from.
    pool: Arc<DatabaseReadPool>,
    // Interrupts the child's own run.
    interventions: InterventionService,
    // Pauses and continues the child's own run.
    pauses: Arc<RunPauseControl>,
    // The messages waiting for the child's own run, which its continue delivers.
    continued: Arc<dyn ContinuedMessages>,
    // Stops every agent a session dispatched.
    sweep: AgentTreeSweep,
    // The registered drivers, whose descriptor gives the stop's flow row its word.
    providers: Arc<ProviderRegistry>,
    // The session's log, which takes the stop's flow row.
    appender: Arc<SessionEventAppender>,
    // Where a damaged session's reads stop.
    read_damaged_from_sequence: Arc<DamagedFromSequenceReader>,
}

// Where the child stood when the control read it.
enum ChildStanding {
    // Ended, in this state.
    Ended(RunState),
    // Live: its own run at this version, in this state.
    Live {
        own_run_id: RunId,
        own_version: i64,
        state: RunState,
    },
}

impl ChildRunControls {
    /// Controls reading through `pool` up to where `read_damaged_from_sequence` stops a damaged
    /// session, interrupting through `interventions`, pausing and continuing through `pauses` with
    /// the waiting messages of `continued`, stopping helpers through `providers`' drivers and
    /// appending through `appender`; the sweep is built from the same parts.
    pub fn new(
        pool: Arc<DatabaseReadPool>,
        providers: Arc<ProviderRegistry>,
        interventions: InterventionService,
        pauses: Arc<RunPauseControl>,
        continued: Arc<dyn ContinuedMessages>,
        appender: Arc<SessionEventAppender>,
        read_damaged_from_sequence: Arc<DamagedFromSequenceReader>,
    ) -> Self {
        let sweep = AgentTreeSweep::new(
            Arc::clone(&pool),
            Arc::clone(&providers),
            interventions.clone(),
            Arc::clone(&appender),
        );
        Self {
            pool,
            interventions,
            pauses,
            continued,
            sweep,
            providers,
            appender,
            read_damaged_from_sequence,
        }
    }

    /// Interrupts the child `request` names, and only it: its pending messages go as its next
    /// turn, `deliver_first` ahead of the rest. A child that had ended answers the state it ended
    /// in, with nothing sent. Refuses `agent.run.notFound`, `agent.run.versionStale` for the run
    /// it belongs to, `agent.childRun.notFound` for a handle that names no child of that run, and
    /// `agent.childRun.controlRefused` (`providerRefused`) when the provider did not confirm the
    /// interrupt; the intervention's own refusals pass through.
    pub async fn interrupt(
        &self,
        request: AgentChildRunInterruptRequest,
        actor: InterventionActor,
    ) -> Result<AgentChildRunInterruptResponse, ChildRunControlError> {
        let AgentChildRunInterruptRequest {
            target_run_id,
            child_handle,
            expected_run_version,
            client_idempotency_key,
            deliver_first,
        } = request;
        let (own_run_id, own_version) = match self
            .child_standing(target_run_id, child_handle.clone(), expected_run_version)
            .await?
        {
            ChildStanding::Ended(state) => {
                return Ok(AgentChildRunInterruptResponse {
                    child_handle,
                    state,
                });
            }
            ChildStanding::Live {
                own_run_id,
                own_version,
                ..
            } => (own_run_id, own_version),
        };
        let answer = self
            .interventions
            .apply_intervention(
                AgentRunInterveneRequest::Interrupt(InterventionInterruptRequest::NextTurn {
                    target_run_id: own_run_id,
                    expected_run_version: safe_run_version(own_version),
                    client_idempotency_key,
                    reason: None,
                    deliver_first,
                }),
                actor,
            )
            .await?;
        let provider_refused = ChildRunControlError::Refused {
            reason: AgentChildRunControlRefusedReason::ProviderRefused,
        };
        match answer {
            AgentRunInterveneResponse::Applied { .. }
            | AgentRunInterveneResponse::Degraded { .. } => {
                let state = self.own_run_state(own_run_id).await?;
                Ok(AgentChildRunInterruptResponse {
                    child_handle,
                    state,
                })
            }
            // Refused or outdated: a child that ended meanwhile answers its end.
            AgentRunInterveneResponse::Rejected { .. }
            | AgentRunInterveneResponse::Expired { .. } => {
                let state = self.own_run_state(own_run_id).await?;
                if state.is_terminal() {
                    Ok(AgentChildRunInterruptResponse {
                        child_handle,
                        state,
                    })
                } else {
                    Err(provider_refused)
                }
            }
            // The provider got it with no answer back, or its dispatch failed, so it is never
            // answered as interrupted.
            AgentRunInterveneResponse::Requested { .. }
            | AgentRunInterveneResponse::Accepted { .. }
            | AgentRunInterveneResponse::Failed { .. } => Err(provider_refused),
        }
    }

    /// Pauses (`paused: true`) or continues (`paused: false`) the child `request` names, and only
    /// it, answering whether it is held paused after the set; a child already standing in the set
    /// is answered with nothing sent. A continue that reaches a hold the provider lost meanwhile
    /// answers `holdLost`, never a release. Refuses `agent.run.notFound`, `agent.run.versionStale`
    /// for the run it belongs to, `agent.childRun.notFound` for a handle that names no child of
    /// that run, and `agent.childRun.controlRefused`, `childEnded` for an ended child and
    /// `providerRefused` when the provider did not take the set.
    pub async fn paused_update(
        &self,
        request: AgentChildRunPausedUpdateRequest,
    ) -> Result<AgentChildRunPausedUpdateResponse, ChildRunControlError> {
        let AgentChildRunPausedUpdateRequest {
            target_run_id,
            child_handle,
            paused,
            expected_run_version,
            client_idempotency_key: _,
        } = request;
        let child_ended = || ChildRunControlError::Refused {
            reason: AgentChildRunControlRefusedReason::ChildEnded,
        };
        let (own_run_id, own_version, state) = match self
            .child_standing(target_run_id, child_handle.clone(), expected_run_version)
            .await?
        {
            ChildStanding::Ended(_) => return Err(child_ended()),
            ChildStanding::Live {
                own_run_id,
                own_version,
                state,
            } => (own_run_id, own_version, state),
        };
        // A pausing child's hold has not taken yet, so only a paused or a running one is answered
        // as it stands.
        if (paused && state == RunState::Paused) || (!paused && state == RunState::Running) {
            return Ok(paused_answer(child_handle, paused, false));
        }
        let expected_run_version = safe_run_version(own_version);
        let set = if paused {
            self.pauses
                .pause(&AgentRunPauseRequest {
                    target_run_id: own_run_id,
                    expected_run_version,
                })
                .await
                .map(|_| false)
        } else {
            self.pauses
                .resume(
                    &AgentRunResumeRequest {
                        target_run_id: own_run_id,
                        expected_run_version,
                    },
                    self.continued.as_ref(),
                )
                .await
                .map(|resumed| resumed.is_hold_lost)
        };
        match set {
            Ok(is_hold_lost) => Ok(paused_answer(child_handle, paused, is_hold_lost)),
            Err(RunPauseError::Driver(_)) => Err(ChildRunControlError::Refused {
                reason: AgentChildRunControlRefusedReason::ProviderRefused,
            }),
            // The own run moved after the read: an ended child answers its end, any other the set
            // as it now stands, a pausing one as held since its hold was asked for.
            Err(RunPauseError::Refused(_)) => {
                let state = self.own_run_state(own_run_id).await?;
                if state.is_terminal() {
                    Err(child_ended())
                } else {
                    let is_paused = matches!(state, RunState::Paused | RunState::Pausing);
                    Ok(paused_answer(child_handle, is_paused, false))
                }
            }
            Err(fault) => Err(ChildRunControlError::Pause(fault)),
        }
    }

    /// Stops every live or interrupted agent the session `request` names dispatched, at every
    /// depth, a helper an earlier lead run left running included, each stop from `actor`; then
    /// appends one `agent.children.stopped` whose word is the lead's provider's and whose names
    /// are the agents stopped, in dispatch order. Answers each agent's own outcome in dispatch
    /// order. Refuses `session.notFound` before anything is stopped; fails when the agents cannot
    /// be read or the row is not kept.
    pub async fn stop_all(
        &self,
        request: AgentChildRunStopAllRequest,
        actor: InterventionActor,
    ) -> Result<AgentChildRunStopAllResponse, ChildRunControlError> {
        let session_id = request.session_id;
        let (provider, _) = read_session_provider::<ChildRunControlError>(
            &self.pool,
            &*self.read_damaged_from_sequence,
            session_id,
        )
        .await?
        .ok_or(ChildRunControlError::SessionNotFound { session_id })?;
        let word = self
            .providers
            .descriptor(&provider)
            .map_err(ChildRunControlError::LeadProvider)?
            .stop_all_row_word;
        let read_bound = session_read_bound(&*self.read_damaged_from_sequence, &session_id, None);
        let children = self
            .sweep
            .stop_descendants(session_id, SweepRoot::Session, None, read_bound, actor)
            .await?;
        // A failed stop carries its failure on its own row, so only the stopped are named.
        let reached = children
            .iter()
            .filter_map(|outcome| match outcome {
                ChildStopOutcome::Stopped { child, .. } => Some(child.clone()),
                ChildStopOutcome::AlreadyEnded { .. } | ChildStopOutcome::Failed { .. } => None,
            })
            .collect();
        let draft = SessionEventDraft::of_session(
            session_id,
            &SessionEvent::AgentChildrenStopped(AgentChildrenStoppedPayload { word, reached }),
        )
        .map_err(SessionEventEmitError::from)?;
        self.appender
            .append(draft, SessionEventLinkage::default())
            .await
            .map_err(SessionEventEmitError::from)?;
        Ok(AgentChildRunStopAllResponse { children })
    }

    // Where the child `child_handle` of `target_run_id` stands, refused as a control refuses an
    // unknown run, one past `expected_run_version` and a handle that names no child of it.
    async fn child_standing(
        &self,
        target_run_id: RunId,
        child_handle: ChildHandle,
        expected_run_version: SafeInt<0>,
    ) -> Result<ChildStanding, ChildRunControlError> {
        self.pool
            .read(ReadLength::Short, move |reader| {
                let runs = RunStateReader::new(reader);
                let run = runs.read_run(&target_run_id)?.ok_or(RunRefusal::NotFound {
                    run_id: target_run_id,
                })?;
                require_expected_version(target_run_id, &run, expected_run_version)?;
                let child = resolve_child(reader, &run.session_id, &child_handle)?
                    .filter(|child| child.parent_run_id == target_run_id)
                    .ok_or(ChildRunControlError::ChildNotFound { child_handle })?;
                if child.state.is_terminal() {
                    return Ok(ChildStanding::Ended(child.state));
                }
                let own_run_id = child.node.own_run_id;
                let own_run = runs
                    .read_run(&own_run_id)?
                    .ok_or(AgentTreeReadError::RunMissing { run_id: own_run_id })?;
                Ok::<_, ChildRunControlError>(ChildStanding::Live {
                    own_run_id,
                    own_version: own_run.version,
                    state: own_run.state,
                })
            })
            .await
    }

    // The state of the child's own run `own_run_id` as it stands now.
    async fn own_run_state(&self, own_run_id: RunId) -> Result<RunState, ChildRunControlError> {
        self.pool
            .read(ReadLength::Short, move |reader| {
                let own_run = RunStateReader::new(reader)
                    .read_run(&own_run_id)?
                    .ok_or(AgentTreeReadError::RunMissing { run_id: own_run_id })?;
                Ok::<_, ChildRunControlError>(own_run.state)
            })
            .await
    }
}

// The paused update's answer for `child_handle`: held paused, or not, with `is_hold_lost` marking
// a hold the provider lost before the continue reached it.
fn paused_answer(
    child_handle: ChildHandle,
    is_paused: bool,
    is_hold_lost: bool,
) -> AgentChildRunPausedUpdateResponse {
    if is_paused {
        AgentChildRunPausedUpdateResponse::Paused(AgentChildRunPausedUpdatePaused {
            child_handle,
            paused: True::default(),
            hold_lost: None,
        })
    } else {
        AgentChildRunPausedUpdateResponse::NotPaused(AgentChildRunPausedUpdateNotPaused {
            child_handle,
            paused: False::default(),
            hold_lost: is_hold_lost.then_some(True::default()),
        })
    }
}

#[cfg(test)]
mod tests;
