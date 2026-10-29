//! How a run reaches its provider: a send's run and a turn the daemon or its provider starts on a
//! session pass `starting`, every setup gate and the driver's start before `running`; a provider's
//! own subagent is queued beneath its parent and runs at once; an interrupted run is continued on
//! its next turn, through the gates and the driver again or on the turn its provider started; a
//! paused run is resumed, written `running` only once its driver took the resume.

use std::error::Error;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};

use jiff::Timestamp;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::provider::driver::capabilities::ExecutionPosture;
use sidekicks_contracts::provider::driver::length_limits::PROVIDER_FAILURE_DETAIL_MAX_LEN;
use sidekicks_contracts::provider::driver::methods::PROVIDER_WIRE_HANDLE_MAX_LEN;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::control::RunFailureCategory;
use sidekicks_contracts::run::events::RunStateChangeState;
use sidekicks_contracts::run::failure_cause::{
    DaemonFailureOrigin, RunFailureCause, RunRefusedOrigin,
};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queued::{
    AgentRunQueuedNewState, AgentRunQueuedPayload, ChildRunProvenance, RunQueuedSessionAgentPayload,
};
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_provider::driver::contract::bound_failure_detail;
use sidekicks_provider::driver::run_control::DriverRunRefusal;
use sidekicks_provider::run::start_request::DaemonTurnStartRequest;
use sidekicks_provider::run::state_entry::RunStateEntry;
use sidekicks_std::error_description::describe_error;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::connection::read_pool::ReadLength;
use sidekicks_store::database::statement::WriteStatement;
use sidekicks_store::events::session::appender::SessionEventDraft;
use sidekicks_workspace::run_setup_gates::{
    RunSetupContext, RunSetupGateError, RunTerminalContext,
};
use tokio::sync::SetOnce;

use crate::queue_store::take_over_interrupted_statement;
use crate::run::agent::RunAgentReader;
use crate::run::daemon_turn::queue_daemon_turn_run;
use crate::run::engine::live::{ContinuingGuard, StartingGuard, StartingRun};
use crate::run::engine::{
    LiveAppend, RunEngine, RunEngineError, RunResumeError, with_cleanup_failures,
};
use crate::run::projection::insert_queued_run_statement;
use crate::run::read::{RunRead, RunStateReader, read_run_provider};
use crate::run::refusals::{RunRefusal, require_expected_version};
use crate::run::start_request::{RunContinueRequest, RunStartRequest, RunTurnStart};
use crate::run::state_change::{RunStateChange, RunStateChangeCompanions};

// The states a resume continues: a run still finishing its step, or one already held.
const RESUMABLE_STATES: [RunState; 2] = [RunState::Pausing, RunState::Paused];

// The failure a start records when the driver's words fit nothing.
static DRIVER_START_FAILURE_FALLBACK: LazyLock<FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>> =
    LazyLock::new(|| {
        FreeFormText::new("The provider could not start the run".to_owned())
            .expect("the fallback is non-blank and within the cap")
    });

// The failure a gate's refusal records when its words fit nothing.
static SETUP_FAILURE_FALLBACK: LazyLock<FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>> =
    LazyLock::new(|| {
        FreeFormText::new("The run's setup failed".to_owned())
            .expect("the fallback is non-blank and within the cap")
    });

impl RunEngine {
    /// Starts a queued run: `starting`, every setup gate in order, the driver's start with the
    /// posture the posture gate resolved, then `running` stamped with that posture. A gate's
    /// failure ends the run `failed` with the gate's failure as its cause, unless an interrupt
    /// claimed or ended it first, and is returned; a run interrupted in its gates is never handed
    /// to the driver; a driver's failure ends the run `failed` and is returned, and so does a
    /// `running` write that fails once the driver has the run, after the driver's turn is
    /// interrupted. An interrupt that arrives after the gates is routed once the start settles (see
    /// `RunEngine::route_interrupt`).
    pub async fn start_run(&self, request: RunStartRequest) -> Result<RunRead, RunEngineError> {
        let RunStartRequest {
            turn:
                RunTurnStart {
                    run_id,
                    workspace_id,
                    execution_posture,
                    start_driver,
                    interrupt_driver,
                },
            queue_item,
            provider,
            output_speed,
            running_statements,
        } = request;
        // A carried speed is read against its provider's standard before anything is written, so
        // a provider no driver answers refuses the start whole.
        let carried_output_speed = match output_speed {
            Some(speed) => {
                let standard = self
                    .providers
                    .descriptor(&provider)
                    .map_err(|refusal| RunEngineError::Provider(Box::new(refusal)))?
                    .standard_output_speed;
                (speed.as_str() != standard).then_some(speed)
            }
            None => None,
        };
        let starting = self
            .change(
                RunStateChange {
                    expected_state: Some(RunState::Queued),
                    ..RunStateChange::new(run_id, RunStateEntry::Starting)
                },
                RunStateChangeCompanions::default(),
                None,
            )
            .await?;
        let entry = Arc::new(StartingRun {
            is_claimable: AtomicBool::new(true),
            is_interrupted: AtomicBool::new(false),
            has_ended: AtomicBool::new(false),
            settled: SetOnce::new(),
        });
        lock(&self.live).starting.insert(run_id, Arc::clone(&entry));
        let mut guard = StartingGuard {
            live: &self.live,
            run_id,
            entry: Arc::clone(&entry),
            has_driver_run: false,
        };

        let gated = self
            .gates
            .assert_run_ready(&RunSetupContext {
                run_id,
                session_id: starting.session_id,
                queue_item,
                workspace_id,
                execution_posture,
            })
            .await;
        entry.is_claimable.store(false, Ordering::Release);
        if let Err(source) = gated {
            let gate_error = RunEngineError::Gate {
                run_id,
                source: Box::new(source),
            };
            if entry.is_interrupted.load(Ordering::Acquire) {
                return Err(gate_error);
            }
            return Err(self.fail_setup(run_id, gate_error).await);
        }
        // An interrupt may have landed while a gate ran; a run no longer starting is not started.
        let after_gates = self.require_run(run_id).await?;
        if entry.is_interrupted.load(Ordering::Acquire) || after_gates.state != RunState::Starting {
            return Err(RunRefusal::InvalidTransition {
                run_id,
                from_state: after_gates.state,
                to_state: RunStateChangeState::Running,
                source: None,
            }
            .into());
        }
        // The driver runs at, and the run records, the posture the gate checked and resolved.
        let Some(resolved_posture) = self.execution_postures.resolved_posture_for(&run_id) else {
            return Err(self
                .fail_setup(run_id, RunEngineError::NoResolvedPosture { run_id })
                .await);
        };

        // Held before the driver starts, since the driver may report the settled state at once.
        if let Some(speed) = carried_output_speed {
            lock(&self.live).carried_output_speeds.insert(run_id, speed);
        }
        if let Err(source) = start_driver(resolved_posture.clone()).await {
            return Err(self
                .fail_start(run_id, RunEngineError::Driver { run_id, source })
                .await);
        }
        guard.has_driver_run = true;
        // Written before a waiting interrupt is released, so a stop the driver applies never ends
        // the run under its own `running` write.
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
                RunStateChangeCompanions {
                    statements: running_statements.map(|build| build()).unwrap_or_default(),
                    ..RunStateChangeCompanions::default()
                },
                None,
            )
            .await;
        match running {
            Ok(run) => Ok(run),
            Err(running_error) => {
                // The driver runs a turn the run never records as running, so the turn is
                // interrupted and the run ends: a live run with no recorded turn would hold the
                // session for good.
                let interrupted = interrupt_driver()
                    .await
                    .map_err(|source| RunEngineError::Driver { run_id, source });
                let ended = self.end_failed_start(run_id, &running_error).await;
                Err(with_cleanup_failures(
                    running_error,
                    [interrupted, ended],
                    "recording a started run running failed, and ending its turn or the run failed",
                ))
            }
        }
    }

    /// Starts a turn the daemon starts on a session itself, such as a goal, as the
    /// session's own run: `agent.run.queued` naming the session's lead and no parent, then the
    /// start [`RunEngine::start_run`] makes, its setup gates given no queue item, and returns the
    /// new run's id once it is `running`. Refuses with [`RunRefusal::SessionTurnHeld`], writing
    /// nothing, while a lead run of the session is live, and for a turn the daemon starts while a
    /// lead message waits for the session's interrupted lead run, whose continue is the session's
    /// next turn; a turn in a process of its own is neither refused nor the session's lead run.
    /// The run of a provider's own turn takes over, in its `running` write, the lead messages
    /// waiting for the session's interrupted lead runs, so a turn that fails to open leaves them
    /// where they were. Fails as [`RunEngine::start_run`] does.
    pub(crate) async fn start_daemon_turn(
        &self,
        request: DaemonTurnStartRequest,
    ) -> Result<RunId, RunEngineError> {
        let session_id = request.session_id;
        let lead_agent = self
            .pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, RunEngineError>(RunAgentReader::new(reader).read_lead_agent(&session_id)?)
            })
            .await?;
        let run_id = queue_daemon_turn_run(&self.appender, &request, lead_agent).await?;
        let DaemonTurnStartRequest {
            provider,
            execution_posture,
            is_provider_started,
            start_turn,
            interrupt_turn,
            ..
        } = request;
        let running_statements: Option<Box<dyn FnOnce() -> Vec<WriteStatement> + Send>> =
            is_provider_started.then(|| {
                let take_over: Box<dyn FnOnce() -> Vec<WriteStatement> + Send> =
                    Box::new(move || {
                        let now = WireInstant::from_timestamp(Timestamp::now())
                            .expect("the clock reads after year 0000");
                        vec![take_over_interrupted_statement(&session_id, &run_id, &now)]
                    });
                take_over
            });
        self.start_run(RunStartRequest {
            turn: RunTurnStart {
                run_id,
                workspace_id: None,
                execution_posture,
                start_driver: Box::new(move |_resolved_posture: ExecutionPosture| {
                    start_turn(run_id)
                }),
                interrupt_driver: Box::new(move || interrupt_turn(run_id)),
            },
            queue_item: None,
            provider,
            output_speed: None,
            running_statements,
        })
        .await?;
        Ok(run_id)
    }

    /// Starts the run of a subagent the provider started beneath `parent_run_id`, sharing its
    /// process and so its provider and account: `agent.run.queued` naming the parent, the parent's
    /// agent, which asked its provider for the subagent, and the account the parent was admitted
    /// against, then `starting` and `running`, and returns the new run's id. Returns `None` with
    /// nothing written when the parent has ended, and fails with [`RunRefusal::NotFound`] for a
    /// parent the daemon has no run for.
    pub(crate) async fn start_provider_subagent_run(
        &self,
        parent_run_id: RunId,
    ) -> Result<Option<RunId>, RunEngineError> {
        let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
        let (agent_id, admitted_provider_account_id) = self
            .pool
            .read(ReadLength::Short, move |reader| {
                let parent = RunStateReader::new(reader)
                    .read_run(&parent_run_id)?
                    .ok_or(RunEngineError::Refused(RunRefusal::NotFound {
                        run_id: parent_run_id,
                    }))?;
                let agents = RunAgentReader::new(reader);
                Ok::<_, RunEngineError>((
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
        self.change(
            RunStateChange {
                expected_state: Some(RunState::Starting),
                ..RunStateChange::new(
                    run_id,
                    RunStateEntry::Running {
                        execution_posture: None,
                    },
                )
            },
            RunStateChangeCompanions::default(),
            None,
        )
        .await?;
        Ok(Some(run_id))
    }

    /// Continues the interrupted run `request.turn.run_id` on its next turn, admitted from
    /// `request.queue_item`: every setup gate again, as at a start, the driver's start of the turn
    /// with the posture the posture gate resolved, then `running` stamped with it; what the
    /// provider reports meanwhile waits for that write. A gate's or the driver's failure leaves
    /// the run interrupted, every terminal hook releasing what the gates took for the continue,
    /// and is returned; a `running` write that fails once the driver started the turn does so
    /// after the turn is interrupted. Fails with [`RunRefusal::InvalidTransition`] for a run that
    /// does not read interrupted or is already being continued.
    pub async fn continue_run(
        &self,
        request: RunContinueRequest,
    ) -> Result<RunRead, RunEngineError> {
        let RunContinueRequest {
            turn:
                RunTurnStart {
                    run_id,
                    workspace_id,
                    execution_posture,
                    start_driver,
                    interrupt_driver,
                },
            queue_item,
        } = request;
        let run = self.require_run(run_id).await?;
        if run.state != RunState::Interrupted {
            return Err(continue_refusal(run_id, &run, false));
        }
        let entry = lock(&self.live)
            .insert_continuing(run_id, false)
            .ok_or_else(|| continue_refusal(run_id, &run, true))?;
        let _settles_on_exit = ContinuingGuard {
            live: &self.live,
            run_id,
            entry: Arc::clone(&entry),
        };
        let continued = async {
            self.gates
                .assert_run_ready(&RunSetupContext {
                    run_id,
                    session_id: run.session_id,
                    queue_item: Some(queue_item),
                    workspace_id,
                    execution_posture,
                })
                .await
                .map_err(|source| RunEngineError::Gate {
                    run_id,
                    source: Box::new(source),
                })?;
            let resolved_posture = self
                .execution_postures
                .resolved_posture_for(&run_id)
                .ok_or(RunEngineError::NoResolvedPosture { run_id })?;
            start_driver(resolved_posture.clone())
                .await
                .map_err(|source| RunEngineError::Driver { run_id, source })?;
            entry.is_turn_started.store(true, Ordering::Release);
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
            Ok(run) => Ok(run),
            Err(continue_error) => {
                // A turn the driver started for a continue that was never recorded is
                // interrupted, the run keeping its interrupted end.
                let interrupted = if entry.is_turn_started.load(Ordering::Acquire) {
                    interrupt_driver()
                        .await
                        .map_err(|source| RunEngineError::Driver { run_id, source })
                } else {
                    Ok(())
                };
                let released = self.release_failed_continue(run_id).await;
                Err(with_cleanup_failures(
                    continue_error,
                    [interrupted, released],
                    "continuing a run failed, and ending its turn or a terminal hook failed",
                ))
            }
        }
    }

    /// Resumes the paused or pausing run `run_id` through `resume`, the driver's resume, which the
    /// caller builds from the run and the provider it runs on as one read gives them: the run is
    /// registered as being continued first, once every provider change already past its check has
    /// been written, so what its provider reports from then on waits, then read and refused unless
    /// it is still at `expected_run_version` and pausing or paused, and only once `resume` answers
    /// `Ok` is `running` written, with `companions` in the same write. Fails with
    /// [`RunResumeError::Unstarted`], `resume` never run, for a run unknown, held by another
    /// continue or a resume, at another version or in another state, refused as
    /// [`RunRefusal::NotFound`], [`RunRefusal::InvalidTransition`] and
    /// [`RunRefusal::VersionStale`]; a failed `resume` writes nothing and comes back whole as
    /// [`RunResumeError::Driver`]; and [`RunResumeError::Change`] is the write refused or failed
    /// once the driver took the resume.
    pub(crate) async fn resume_run<DriverFailure, Resume>(
        &self,
        run_id: RunId,
        expected_run_version: SafeInt<0>,
        companions: RunStateChangeCompanions,
        resume: impl FnOnce(RunRead, Option<ProviderId>) -> Resume,
    ) -> Result<RunRead, RunResumeError<DriverFailure>>
    where
        Resume: Future<Output = Result<(), DriverFailure>>,
    {
        // A provider change past its check for a continue is written first, so the run read under
        // the entry is never moved under the resume by a report that came before it.
        let entry = loop {
            let marks = {
                let mut live = lock(&self.live);
                match live.provider_changes.get(&run_id) {
                    Some(marks) => marks.clone(),
                    None => break live.insert_continuing(run_id, false),
                }
            };
            for mark in marks {
                mark.landed.wait().await;
            }
        };
        let Some(entry) = entry else {
            let run = self
                .require_run(run_id)
                .await
                .map_err(RunResumeError::Unstarted)?;
            return Err(RunResumeError::Unstarted(continue_refusal(
                run_id, &run, true,
            )));
        };
        let _settles_on_exit = ContinuingGuard {
            live: &self.live,
            run_id,
            entry: Arc::clone(&entry),
        };
        #[cfg(test)]
        self.resume_read_pause.pass().await;
        let (run, bound) = self
            .pool
            .read(
                ReadLength::Short,
                move |reader| -> Result<_, RunEngineError> {
                    let Some(run) = RunStateReader::new(reader).read_run(&run_id)? else {
                        return Err(RunRefusal::NotFound { run_id }.into());
                    };
                    let bound = read_run_provider(reader, &run_id)?.map(|bound| bound.provider);
                    Ok((run, bound))
                },
            )
            .await
            .map_err(RunResumeError::Unstarted)?;
        require_expected_version(run_id, &run, expected_run_version)
            .map_err(|stale| RunResumeError::Unstarted(stale.into()))?;
        if !RESUMABLE_STATES.contains(&run.state) {
            return Err(RunResumeError::Unstarted(continue_refusal(
                run_id, &run, false,
            )));
        }
        resume(run, bound).await.map_err(RunResumeError::Driver)?;
        entry.is_turn_started.store(true, Ordering::Release);
        self.change(
            RunStateChange::new(
                run_id,
                RunStateEntry::Running {
                    execution_posture: None,
                },
            ),
            companions,
            None,
        )
        .await
        .map_err(RunResumeError::Change)
    }

    /// Continues the interrupted run `run_id` on the turn its provider started itself with
    /// messages it kept from the run's interrupted turn, and returns the run as `running` left it;
    /// `None` with nothing written when the run no longer reads interrupted, or while another
    /// continue or a resume holds it. Whatever the provider reports on the run after this call
    /// waits for its write. Fails as [`RunEngine::transition`] does.
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
        let continued = self
            .change(
                RunStateChange {
                    expected_state: Some(RunState::Interrupted),
                    ..RunStateChange::new(
                        run_id,
                        RunStateEntry::Running {
                            execution_posture: None,
                        },
                    )
                },
                RunStateChangeCompanions::default(),
                None,
            )
            .await;
        match continued {
            Ok(run) => Ok(Some(run)),
            Err(RunEngineError::Refused(RunRefusal::InvalidTransition { .. })) => Ok(None),
            Err(error) => Err(error),
        }
    }

    // Ends a run whose setup failed `failed`, its cause the failure. A run an interrupt moved out
    // of `starting` while a gate ran keeps that end. Returns what the start fails with.
    async fn fail_setup(&self, run_id: RunId, setup_error: RunEngineError) -> RunEngineError {
        let failed = RunStateChange {
            expected_state: Some(RunState::Starting),
            failure_category: Some(RunFailureCategory::SetupFailure),
            ..RunStateChange::new(
                run_id,
                RunStateEntry::Failed {
                    intended_close: None,
                    failure_cause: Some(setup_failed_cause(&setup_error)),
                    provider_failure_detail: None,
                    process_exit: None,
                },
            )
        };
        match self
            .change(failed, RunStateChangeCompanions::default(), None)
            .await
        {
            Ok(_run) => setup_error,
            Err(RunEngineError::Refused(RunRefusal::AlreadyEnded { .. })) => setup_error,
            Err(RunEngineError::Refused(RunRefusal::InvalidTransition { from_state, .. }))
                if from_state != RunState::Starting =>
            {
                setup_error
            }
            Err(fail_error) => with_cleanup_failures(
                setup_error,
                [Err(fail_error)],
                "a run's setup failed, and ending the run or a terminal hook after it failed",
            ),
        }
    }

    // Ends a run whose driver could not start it `failed`. Returns what the start fails with.
    async fn fail_start(&self, run_id: RunId, driver_error: RunEngineError) -> RunEngineError {
        match self.end_failed_start(run_id, &driver_error).await {
            Ok(()) => driver_error,
            Err(fail_error) => with_cleanup_failures(
                driver_error,
                [Err(fail_error)],
                "the driver could not start a run, and ending the run or a terminal hook failed",
            ),
        }
    }

    // Ends a run whose start failed `failed`: refused as the daemon's own refusal where its driver
    // refused the start, else a provider failure carrying the failure's words.
    async fn end_failed_start(
        &self,
        run_id: RunId,
        start_error: &RunEngineError,
    ) -> Result<(), RunEngineError> {
        let (failure_category, failure_cause, provider_failure_detail) =
            match driver_run_refusal(start_error) {
                Some(refusal) => (
                    RunFailureCategory::Refused,
                    Some(RunFailureCause::Refused {
                        origin: RunRefusedOrigin::Daemon,
                        model: refusal.model.clone(),
                        sentence: Some(bound_failure_detail(
                            &refusal.sentence,
                            DRIVER_START_FAILURE_FALLBACK.clone(),
                        )),
                        explanation: None,
                        safety_category: None,
                    }),
                    None,
                ),
                None => (
                    RunFailureCategory::ProviderFailure,
                    None,
                    Some(bound_failure_detail(
                        &failure_words(start_error),
                        DRIVER_START_FAILURE_FALLBACK.clone(),
                    )),
                ),
            };
        let failed = RunStateChange {
            expected_state: Some(RunState::Starting),
            failure_category: Some(failure_category),
            ..RunStateChange::new(
                run_id,
                RunStateEntry::Failed {
                    intended_close: None,
                    failure_cause,
                    provider_failure_detail,
                    process_exit: None,
                },
            )
        };
        self.change(failed, RunStateChangeCompanions::default(), None)
            .await
            .map(drop)
    }

    // A continue that failed with its run still interrupted leaves the run at that end, so what
    // the gates took for it, its resolved posture among it, is released as at the end itself.
    async fn release_failed_continue(&self, run_id: RunId) -> Result<(), RunEngineError> {
        let Some(run) = self
            .read_run(run_id)
            .await?
            .filter(|run| run.state == RunState::Interrupted)
        else {
            return Ok(());
        };
        self.gates
            .release_for_terminal(
                &RunTerminalContext {
                    run_id,
                    session_id: run.session_id,
                    terminal_state: run.state,
                    run_version: run.version,
                },
                None,
            )
            .await?;
        Ok(())
    }
}

// A failure's own words: a gate's or a driver's failure as it came, any other as the engine
// describes it.
fn failure_words(error: &RunEngineError) -> String {
    let own: &(dyn Error + 'static) = if let RunEngineError::Gate { source, .. } = error {
        source.as_ref()
    } else if let RunEngineError::Driver { source, .. } = error {
        source.as_ref()
    } else {
        error
    };
    describe_error(own)
}

// The refusal a driver's failed start carries, wherever in the failure's causes it sits.
fn driver_run_refusal(start_error: &RunEngineError) -> Option<&DriverRunRefusal> {
    let RunEngineError::Driver { source, .. } = start_error else {
        return None;
    };
    std::iter::successors(Some(&**source as &(dyn Error + 'static)), |&cause| {
        cause.source()
    })
    .find_map(|cause| cause.downcast_ref::<DriverRunRefusal>())
}

// The cause a setup failure records: a refusing gate's code, and the failure's own words.
fn setup_failed_cause(setup_error: &RunEngineError) -> RunFailureCause {
    let code = if let RunEngineError::Gate { source, .. } = setup_error
        && let RunSetupGateError::Refused(refusal) = source.as_ref()
    {
        Some(
            FreeFormText::<PROVIDER_WIRE_HANDLE_MAX_LEN>::new(refusal.code.as_str().to_owned())
                .expect("a refusal code is a short wire name"),
        )
    } else {
        None
    };
    RunFailureCause::SetupFailed {
        origin: DaemonFailureOrigin::Value,
        code,
        message: bound_failure_detail(&failure_words(setup_error), SETUP_FAILURE_FALLBACK.clone()),
    }
}

// The cause of a continue or a resume refused while another of the run is in flight, whose state
// alone would allow the move.
#[derive(Debug, thiserror::Error)]
#[error("another continue or resume of the run is in flight")]
struct ContinueHeld;

// The refusal of a continue or a resume of `run`, which reads no state it moves from, or, where
// `is_held`, is held by another continue or resume already, which it names as its cause.
fn continue_refusal(run_id: RunId, run: &RunRead, is_held: bool) -> RunEngineError {
    RunRefusal::InvalidTransition {
        run_id,
        from_state: run.state,
        to_state: RunStateChangeState::Running,
        source: is_held.then(|| Box::new(ContinueHeld) as Box<dyn Error + Send + Sync>),
    }
    .into()
}

#[cfg(test)]
mod tests;
