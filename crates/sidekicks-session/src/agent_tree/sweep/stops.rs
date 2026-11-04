//! The stops a sweep sends: every descendant it lists is stopped at once, a helper by its
//! provider's driver and a bridged or workflow run by the run engine's interrupt, each under its
//! own driver's deadline and each answering its own outcome; nothing is atomic.

use std::sync::Arc;

use futures::future::join_all;
use sidekicks_contracts::agent::tree::AgentTreeMember;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::driver::methods::PROVIDER_WIRE_REASON_MAX_LEN;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::children::{ChildStopOutcome, ChildStoppedState};
use sidekicks_contracts::run::events::InterventionActor;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::{
    AgentRunInterveneRequest, AgentRunInterveneResponse, InterventionInterruptRequest,
    InterventionState,
};
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::run::subagent::{SubagentId, SubagentLifecyclePayload};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_provider::driver::contract::error::bound_provider_words;
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_provider::driver::run_control::{HelperStopOutcome, HelperStopParams};
use sidekicks_std::error_description::describe_error;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::events::session::appender::{
    SessionEventAppender, SessionEventDraft, SessionEventLinkage,
};

use crate::agent_tree::read::AgentTreeReadError;
use crate::agent_tree::sweep::{Descendant, DescendantStop, SweepRoot, read_descendants};
use crate::interventions::limit_stop::mint_client_key;
use crate::interventions::service::InterventionService;
use crate::interventions::service::errors::driver_failure_text;
use crate::run::engine::errors::RunEngineError;
use crate::run::read::{read_run_through, safe_run_version};

// The reason a failed stop gives when its failure's text holds no words.
const SILENT_FAILURE_REASON: &str = "The stop failed without a message";

/// Why a sweep stopped nothing: the session's agents could not be read. A stop that fails is its
/// descendant's own `failed` outcome, never this.
#[derive(Debug, thiserror::Error)]
pub enum AgentTreeSweepError {
    /// The session's tree or a listed run's agent could not be read.
    #[error("the session's agents could not be read")]
    Read(#[from] AgentTreeReadError),
    /// The read did not reach a connection.
    #[error("the session's agents could not be read: the read pool did not run it")]
    Pool(#[from] DatabaseReadError),
}

/// Stops every live or interrupted agent below a root of a session's tree, one stop per agent,
/// all at once, a helper through its provider's driver and a bridged or workflow run through the
/// interventions service's interrupt.
pub struct AgentTreeSweep {
    // The read pool the descendants and each run's version are read through.
    pool: Arc<DatabaseReadPool>,
    // The registered drivers, which stop a helper.
    providers: Arc<ProviderRegistry>,
    // The interventions service, which interrupts a bridged or workflow run.
    interventions: InterventionService,
    // The session's log, which a helper already interrupted and then stopped is told to.
    appender: Arc<SessionEventAppender>,
}

// How one descendant's stop came out, before it is told with its member.
enum StopAnswer {
    // Stopped, leaving it in this state.
    Stopped(ChildStoppedState),
    // It had already ended, or was found interrupted.
    AlreadyEnded,
    // The stop failed, with why.
    Failed(String),
}

impl AgentTreeSweep {
    /// A sweep reading through `pool`, stopping helpers through `providers`' drivers and runs
    /// through `interventions`, and appending through `appender` one `agent.subagent.stopped` for
    /// each helper read interrupted that its driver then stopped for good.
    pub fn new(
        pool: Arc<DatabaseReadPool>,
        providers: Arc<ProviderRegistry>,
        interventions: InterventionService,
        appender: Arc<SessionEventAppender>,
    ) -> Self {
        Self {
            pool,
            providers,
            interventions,
            appender,
        }
    }

    /// Stops every agent below `root` in `session_id`'s tree that is live or interrupted, and,
    /// with `started_after`, queued after that sequence of the session's log, reading helper starts
    /// before `read_bound`; every stop starts at once, each bounded by its own driver's deadline,
    /// and an interrupt goes out from `actor`. Answers one outcome per agent in dispatch order,
    /// a failed stop as its own `failed` outcome. Fails only when the agents cannot be read.
    pub async fn stop_descendants(
        &self,
        session_id: SessionId,
        root: SweepRoot,
        started_after: Option<i64>,
        read_bound: i64,
        actor: InterventionActor,
    ) -> Result<Vec<ChildStopOutcome>, AgentTreeSweepError> {
        let descendants = self
            .pool
            .read(
                ReadLength::Long,
                move |reader| -> Result<_, AgentTreeSweepError> {
                    Ok(read_descendants(
                        reader,
                        &session_id,
                        &root,
                        started_after,
                        read_bound,
                    )?)
                },
            )
            .await?;
        Ok(join_all(
            descendants
                .into_iter()
                .map(|descendant| self.stop(session_id, descendant, &actor)),
        )
        .await)
    }

    // Stops one descendant and tells how, with its member.
    async fn stop(
        &self,
        session_id: SessionId,
        descendant: Descendant,
        actor: &InterventionActor,
    ) -> ChildStopOutcome {
        let answer = match descendant.stop {
            DescendantStop::Helper {
                provider_name,
                carrying_run_id,
                run_id,
                subagent_id,
            } => {
                let answer = self
                    .stop_helper(session_id, &provider_name, run_id, subagent_id.clone())
                    .await;
                match answer {
                    // A helper read interrupted keeps its run's record, so its stop for good is
                    // told by an event of its own, once the driver has answered.
                    StopAnswer::Stopped(ChildStoppedState::Stopped)
                        if descendant.state == RunState::Interrupted =>
                    {
                        self.record_held_stop(SubagentLifecyclePayload {
                            session_id,
                            run_id: carrying_run_id,
                            provider: provider_name,
                            subagent_id,
                            child_run_id: Some(run_id),
                            parent_tool_call_id: None,
                            source_epoch: None,
                            source_position: None,
                        })
                        .await
                    }
                    answer => answer,
                }
            }
            DescendantStop::Run { run_id } => self.stop_run(run_id, actor).await,
        };
        outcome_of(descendant.member, answer)
    }

    // Appends `agent.subagent.stopped` of `stopped`, the stop answered stopped once it is kept and
    // failed when it is not.
    async fn record_held_stop(&self, stopped: SubagentLifecyclePayload) -> StopAnswer {
        let session_id = stopped.session_id;
        let draft = match SessionEventDraft::of_session(
            session_id,
            &SessionEvent::AgentSubagentStopped(stopped),
        ) {
            Ok(draft) => draft,
            Err(error) => return StopAnswer::Failed(describe_error(&error)),
        };
        match self
            .appender
            .append(draft, SessionEventLinkage::default())
            .await
        {
            Ok(_) => StopAnswer::Stopped(ChildStoppedState::Stopped),
            Err(error) => StopAnswer::Failed(describe_error(&error)),
        }
    }

    // A helper's stop by its provider's driver.
    async fn stop_helper(
        &self,
        session_id: SessionId,
        provider_name: &ProviderId,
        run_id: RunId,
        subagent_id: SubagentId,
    ) -> StopAnswer {
        let driver = match self.providers.lookup(provider_name) {
            Ok(driver) => driver,
            Err(refusal) => return StopAnswer::Failed(refusal.code.as_str().to_owned()),
        };
        let stopped = driver
            .stop_child_run(HelperStopParams {
                session_id,
                run_id,
                subagent_id,
            })
            .await;
        match stopped {
            Ok(HelperStopOutcome::Stopped) => StopAnswer::Stopped(ChildStoppedState::Stopped),
            Ok(HelperStopOutcome::Interrupted) => {
                StopAnswer::Stopped(ChildStoppedState::Interrupted)
            }
            Ok(HelperStopOutcome::AlreadyInterrupted | HelperStopOutcome::AlreadyEnded) => {
                StopAnswer::AlreadyEnded
            }
            Err(error) => StopAnswer::Failed(driver_failure_text(&error)),
        }
    }

    // A bridged or workflow run's stop by the run engine's interrupt at its current version, its
    // waiting messages returned to the draft. A run read ended, interrupted among them, is sent
    // nothing; a stop its provider has not confirmed is never told as stopped.
    async fn stop_run(&self, run_id: RunId, actor: &InterventionActor) -> StopAnswer {
        let run = match read_run_through::<RunEngineError>(&self.pool, run_id).await {
            Ok(Some(run)) => run,
            Ok(None) => {
                return StopAnswer::Failed(RefusalCode::AgentRunNotFound.as_str().to_owned());
            }
            Err(error) => return StopAnswer::Failed(describe_error(&error)),
        };
        if run.state.is_terminal() {
            return StopAnswer::AlreadyEnded;
        }
        let interrupt =
            AgentRunInterveneRequest::Interrupt(InterventionInterruptRequest::ReturnToDraft {
                target_run_id: run_id,
                expected_run_version: safe_run_version(run.version),
                client_idempotency_key: mint_client_key(),
                reason: None,
                deliver_first: None,
            });
        let answer = self
            .interventions
            .apply_intervention(interrupt, actor.clone())
            .await;
        match answer {
            Ok(
                AgentRunInterveneResponse::Applied { .. }
                | AgentRunInterveneResponse::Degraded { .. },
            ) => StopAnswer::Stopped(ChildStoppedState::Interrupted),
            // The dispatch went out with no answer back, so its row stays open until the run ends.
            Ok(
                AgentRunInterveneResponse::Accepted { .. }
                | AgentRunInterveneResponse::Requested { .. },
            ) => StopAnswer::Failed(RefusalCode::ProviderTimeout.as_str().to_owned()),
            Ok(AgentRunInterveneResponse::Expired { .. }) => {
                self.unapplied(run_id, <&'static str>::from(InterventionState::Expired))
                    .await
            }
            Ok(AgentRunInterveneResponse::Rejected {
                rejection_reason, ..
            }) => self.unapplied(run_id, rejection_reason.as_str()).await,
            Ok(AgentRunInterveneResponse::Failed { failure_reason, .. }) => {
                StopAnswer::Failed(failure_reason.as_str().to_owned())
            }
            Err(error) => StopAnswer::Failed(describe_error(&error)),
        }
    }

    // An interrupt that applied nothing: the run read once more counts as already ended once it
    // has ended, and otherwise the stop failed for `reason`; nothing is sent again.
    async fn unapplied(&self, run_id: RunId, reason: &str) -> StopAnswer {
        match read_run_through::<RunEngineError>(&self.pool, run_id).await {
            Ok(Some(run)) if run.state.is_terminal() => StopAnswer::AlreadyEnded,
            Ok(_) => StopAnswer::Failed(reason.to_owned()),
            Err(error) => StopAnswer::Failed(describe_error(&error)),
        }
    }
}

// The outcome `answer` tells for `child`, a failure's text fitted to the wire's reason.
fn outcome_of(child: AgentTreeMember, answer: StopAnswer) -> ChildStopOutcome {
    match answer {
        StopAnswer::Stopped(state) => ChildStopOutcome::Stopped {
            child,
            state,
            reason: None,
        },
        StopAnswer::AlreadyEnded => ChildStopOutcome::AlreadyEnded {
            child,
            state: None,
            reason: None,
        },
        StopAnswer::Failed(text) => ChildStopOutcome::Failed {
            child,
            state: None,
            reason: bound_provider_words::<PROVIDER_WIRE_REASON_MAX_LEN>(&text).unwrap_or_else(
                || {
                    FreeFormText::new(SILENT_FAILURE_REASON.to_owned())
                        .expect("the fallback is non-blank and within the cap")
                },
            ),
        },
    }
}

#[cfg(test)]
mod tests;
