//! The runs a provider starts itself in a session's open process: a subagent the provider started
//! beneath a live run, queued beneath its parent, and the turn it started on an interrupted run
//! with messages it kept from that run's interrupted turn. Each passes every setup gate at the
//! posture the session's process runs at now before `running` is written, stamped with the posture
//! the gates resolved.

use std::sync::Weak;

use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queued::{
    AgentRunQueuedNewState, AgentRunQueuedPayload, ChildRunProvenance, RunQueuedSessionAgentPayload,
};
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_provider::driver::run_control::InterruptRunRequest;
use sidekicks_provider::run::delivery::RunSetupRefusal;
use sidekicks_provider::run::state_entry::RunStateEntry;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::connection::read_pool::ReadLength;
use sidekicks_store::events::session::appender::SessionEventDraft;
use sidekicks_workspace::run_setup_gates::RunSetupContext;

use crate::driver_resolution::read_run_driver;
use crate::run::agent::RunAgentReader;
use crate::run::engine::live::ContinuingGuard;
use crate::run::engine::start::{has_left_interrupted, setup_failure_message};
use crate::run::engine::{
    LiveAppend, RunEngine, RunEngineError, SubagentRunStart, with_cleanup_failures,
};
use crate::run::projection::insert_queued_run_statement;
use crate::run::read::{RunRead, RunStateReader};
use crate::run::refusals::RunRefusal;
use crate::run::state_change::{RunStateChange, RunStateChangeCompanions};

impl RunEngine {
    /// Starts the run of a subagent the provider started beneath `parent_run_id`, sharing its
    /// process and so its provider and account: `agent.run.queued` naming the parent, the parent's
    /// agent, which asked its provider for the subagent, and the account the parent was admitted
    /// against, then `starting`, every setup gate at the posture the session's open process runs
    /// at now, and `running` stamped with the posture the gates resolved. A gate's refusal ends
    /// the run `failed` with no posture stamped and answers [`SubagentRunStart::Refused`]. Returns
    /// `None` with nothing written when the parent has ended, and `None`, what its gates took let
    /// go, when the subagent's run ended some other way while its gates ran; fails with [`RunRefusal::NotFound`]
    /// for a parent the daemon has no run for, with [`RunEngineError::NoSessionPosture`], the run
    /// ended `failed`, when no posture of the session's open process can be read, and when a
    /// refused run's end is not written.
    pub(crate) async fn start_provider_subagent_run(
        &self,
        parent_run_id: RunId,
    ) -> Result<Option<SubagentRunStart>, RunEngineError> {
        let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
        let (session_id, agent_id, admitted_provider_account_id) = self
            .pool
            .read(ReadLength::Short, move |reader| {
                let parent = RunStateReader::new(reader)
                    .read_run(&parent_run_id)?
                    .ok_or(RunEngineError::Refused(RunRefusal::NotFound {
                        run_id: parent_run_id,
                    }))?;
                let agents = RunAgentReader::new(reader);
                Ok::<_, RunEngineError>((
                    parent.session_id,
                    agents.read_agent(&parent.session_id, &parent_run_id)?,
                    agents.read_admitted_account(&parent.session_id, &parent_run_id)?,
                ))
            })
            .await?;
        let appended = self
            .append_while_live(parent_run_id, |parent| {
                let queued = AgentRunQueuedPayload::SessionAgent(RunQueuedSessionAgentPayload {
                    session_id: parent.session_id,
                    run_id,
                    run_version: SafeInt::ZERO,
                    new_state: AgentRunQueuedNewState::Value,
                    agent_id,
                    resolved_agent: None,
                    parent_run_id: Some(parent_run_id),
                    reached_by: Some(ChildRunProvenance::ProviderSubagent),
                    effective_run_config: None,
                    admitted_model_family: None,
                    admitted_provider_account_id: admitted_provider_account_id.clone(),
                });
                Ok(LiveAppend {
                    statements: vec![insert_queued_run_statement(&queued)],
                    draft: SessionEventDraft::of_session(
                        parent.session_id,
                        &SessionEvent::AgentRunQueued(queued),
                    )?,
                    preceding_events: Vec::new(),
                })
            })
            .await?;
        if appended.is_none() {
            return Ok(None);
        }
        self.change(
            RunStateChange {
                expected_state: Some(RunState::Queued),
                ..RunStateChange::new(run_id, RunStateEntry::Starting)
            },
            RunStateChangeCompanions::default(),
            None,
        )
        .await?;
        // The subagent runs in its session's process, so it is gated at what that process runs at
        // now, a level move since its parent's start included.
        let Some(execution_posture) = self
            .session_postures
            .get()
            .and_then(Weak::upgrade)
            .and_then(|source| source.opened_execution_posture(&session_id))
        else {
            return Err(self
                .fail_setup(run_id, RunEngineError::NoSessionPosture { run_id })
                .await);
        };
        let gated = self
            .gates
            .assert_run_ready(&RunSetupContext {
                run_id,
                session_id,
                queue_item: None,
                workspace_id: None,
                execution_posture,
            })
            .await;
        if let Err(source) = gated {
            // A run that ended while its gates ran is no refusal: its helper is not stopped, and
            // what a gate took after that end is let go.
            if let Some(ended) = self.read_ended(run_id).await? {
                self.release_gates_after_end(run_id, &ended).await?;
                return Ok(None);
            }
            let gate_error = RunEngineError::Gate { run_id, source };
            return match self.end_setup_failed(run_id, &gate_error).await {
                Ok(()) => Ok(Some(SubagentRunStart::Refused(
                    run_id,
                    RunSetupRefusal {
                        cause: setup_failure_message(&gate_error).as_str().to_owned(),
                    },
                ))),
                Err(fail_error) => Err(with_cleanup_failures(
                    gate_error,
                    [Err(fail_error)],
                    "a subagent's run was refused at its setup, and ending the run failed",
                )),
            };
        }
        let Some(resolved_posture) = self.execution_postures.resolved_posture_for(&run_id) else {
            return Err(self
                .fail_setup(run_id, RunEngineError::NoResolvedPosture { run_id })
                .await);
        };
        let running = self
            .change(
                RunStateChange {
                    expected_state: Some(RunState::Starting),
                    ..RunStateChange::new(
                        run_id,
                        RunStateEntry::Running {
                            execution_posture: Some(resolved_posture),
                        },
                    )
                },
                RunStateChangeCompanions::default(),
                None,
            )
            .await;
        match running {
            Ok(_) => Ok(Some(SubagentRunStart::Running(run_id))),
            // A run that ended while its gates ran let go only what they held by then; what a gate
            // took after that end is let go here.
            Err(
                refusal @ RunEngineError::Refused(
                    RunRefusal::InvalidTransition { .. } | RunRefusal::AlreadyEnded { .. },
                ),
            ) => {
                let Some(ended) = self.read_ended(run_id).await? else {
                    return Err(refusal);
                };
                self.release_gates_after_end(run_id, &ended).await?;
                Ok(None)
            }
            Err(running_error) => Err(running_error),
        }
    }

    /// Continues the interrupted run `run_id` on the turn its provider started itself with
    /// messages it kept from the run's interrupted turn: every setup gate at the posture the
    /// session's open process runs at now, then `running` stamped with the posture the gates
    /// resolved; returns the run as `running` left it. Answers `None` with nothing written when the
    /// run no longer reads interrupted, or while another continue or a resume holds it; a run that
    /// ended meanwhile has what the gates took released first. Whatever the provider reports on the
    /// run after this call waits for its write. A gate's refusal, a missing posture
    /// ([`RunEngineError::NoSessionPosture`], [`RunEngineError::NoResolvedPosture`]) or a failed
    /// write interrupts the provider's turn, unless the run ended meanwhile, and leaves the run
    /// interrupted, every terminal hook releasing what the gates took, and is returned.
    pub(crate) async fn continue_run_with_kept_messages(
        &self,
        run_id: RunId,
    ) -> Result<Option<RunRead>, RunEngineError> {
        // Taken before any await, so a marker the provider sends next waits for the run to run.
        let Some(entry) = lock(&self.live).insert_continuing(run_id, true) else {
            return Ok(None);
        };
        let _settles_on_exit = ContinuingGuard {
            live: &self.live,
            run_id,
            entry,
        };
        // The provider reported the interrupted turn's end just before it started this one.
        self.wait_for_ending_writes(&run_id).await;
        let run = self.require_run(run_id).await?;
        if run.state != RunState::Interrupted {
            return Ok(None);
        }
        let continued = async {
            // The turn runs in its session's process, so it is gated at what that process runs at
            // now, a level move since the run was interrupted included.
            let execution_posture = self
                .session_postures
                .get()
                .and_then(Weak::upgrade)
                .and_then(|source| source.opened_execution_posture(&run.session_id))
                .ok_or(RunEngineError::NoSessionPosture { run_id })?;
            self.gates
                .assert_run_ready(&RunSetupContext {
                    run_id,
                    session_id: run.session_id,
                    queue_item: None,
                    workspace_id: None,
                    execution_posture,
                })
                .await
                .map_err(|source| RunEngineError::Gate { run_id, source })?;
            let resolved_posture = self
                .execution_postures
                .resolved_posture_for(&run_id)
                .ok_or(RunEngineError::NoResolvedPosture { run_id })?;
            self.change(
                RunStateChange {
                    expected_state: Some(RunState::Interrupted),
                    ..RunStateChange::new(
                        run_id,
                        RunStateEntry::Running {
                            execution_posture: Some(resolved_posture),
                        },
                    )
                },
                RunStateChangeCompanions::default(),
                None,
            )
            .await
        }
        .await;
        match continued {
            Ok(run) => Ok(Some(run)),
            Err(RunEngineError::Refused(RunRefusal::InvalidTransition { .. })) => {
                // A run that ended while its gates ran let go only what they held by then; what a
                // gate took after that end is let go here, so no resolved posture outlives the run.
                let Some(ended) = self.read_ended(run_id).await? else {
                    return Ok(None);
                };
                self.release_gates_after_end(run_id, &ended).await?;
                Ok(None)
            }
            Err(continue_error) => {
                // The provider already runs the turn, so it is interrupted, the run keeping its
                // interrupted end; a run that ended meanwhile has no turn left to interrupt.
                let read = self.read_run(run_id).await;
                let interrupted = if matches!(&read, Ok(Some(run)) if has_left_interrupted(run)) {
                    Ok(())
                } else {
                    self.interrupt_provider_turn(run_id).await
                };
                let released = self.release_failed_continue(run_id, read).await;
                Err(with_cleanup_failures(
                    continue_error,
                    [interrupted, released],
                    "continuing a run on its provider's turn failed, and ending the turn or a \
                     terminal hook failed",
                ))
            }
        }
    }

    // The run `run_id` as read now when it has ended, `None` while it has not.
    async fn read_ended(&self, run_id: RunId) -> Result<Option<RunRead>, RunEngineError> {
        Ok(self
            .read_run(run_id)
            .await?
            .filter(|run| run.state.is_terminal()))
    }

    // Interrupts the turn the provider of `run_id` runs, through the run's own driver.
    async fn interrupt_provider_turn(&self, run_id: RunId) -> Result<(), RunEngineError> {
        let driver = read_run_driver::<RunEngineError>(&self.pool, &self.providers, run_id).await?;
        driver
            .interrupt_run(InterruptRunRequest {
                run_id,
                reason: None,
            })
            .await
            .map_err(|source| RunEngineError::Driver {
                run_id,
                source: Box::new(source),
            })
    }
}

#[cfg(test)]
pub(super) mod tests;
