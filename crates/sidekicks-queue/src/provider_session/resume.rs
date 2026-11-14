//! A session's conversation resumed from its stored leg: composed from the session's lead, handed
//! to the driver's resume at its first admission, the idle sleep's wake, the start's recovery pass
//! or the person's answer to a lead the restart held, or to its restart after the process ended
//! and stayed down, under a binding minted here whose cursor opens before the driver runs, and
//! recorded as the session's opening, so the next message opens nothing again; a resume the
//! provider deferred, starting no process, opens nothing. Each relaunch carries the held lead's
//! continue where the person's answers are owed it, and the person's continue of a paused run,
//! a helper beneath it or the held lead itself, also carries that run's kept words. A relaunch
//! that records its binding hands the driver the helpers live before it to re-attach.

use std::error::Error;
use std::sync::Arc;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::provider::driver::capabilities::ExecutionPosture;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_provider::driver::capabilities::DriverCapabilityFlag;
use sidekicks_provider::driver::contract::ProviderDriver;
use sidekicks_provider::driver::idle_sleep::SessionSleepState;
use sidekicks_provider::driver::run_control::ReattachHelpersParams;
use sidekicks_provider::driver::session_control::{
    DriverResumeResult, ProviderTurnAnswer, ResumeSessionParams, ResumedRunAnswer,
};
use sidekicks_provider::left_conversations::LeftConversation;
use sidekicks_provider::runtime_binding::resume::{
    ResumeFunctionLegs, compose_resume_session_params,
};
use sidekicks_provider::runtime_binding::store::{
    RuntimeBinding, RuntimeBindingRelaunch, mint_runtime_binding_id,
};
use sidekicks_session::agent_tree::reattach::read_helpers_to_reattach;
use sidekicks_session::console_state::read_session_mode;
use sidekicks_session::directory::provider_port::OpeningToolServers;
use sidekicks_session::idle_sleep::kept_schedules::read_session_schedules;
use sidekicks_session::idle_sleep::openings::SessionProcessWaker;
use sidekicks_session::run::read::RunStateReader;
use sidekicks_session::run::stored_leg::read_session_leg;
use sidekicks_store::database::connection::read_pool::ReadLength;

use crate::provider_session::errors::ProviderSessionError;
use crate::provider_session::held_run_continue::{ClaimedContinue, ContinuedWords};
use crate::provider_session::resumed_runs::ResumedRuns;
use crate::provider_session::{OpenedSession, ProviderSessions, close_unrecorded, posture_of};

/// A session's resume composed from its stored leg: the params its driver resumes it with, with no
/// function legs, the posture and git folder the resumed process runs at, and the legs a caller
/// that starts the process under its own binding opens for it.
pub struct ComposedResume {
    /// The params the session's driver resumes it with; they carry no function legs, so composing
    /// them opens no status leg, and a driver that asks the session directory for its legs, or a
    /// side question's copy, which runs under no binding of the session's, holds none.
    pub params: ResumeSessionParams,
    // The posture of the level the session stands at.
    execution_posture: ExecutionPosture,
    // The git folder each level's posture is built on.
    git_folder: FilesystemPath,
    // Opens the function legs of a binding: called only by a relaunch that hands them to the
    // driver, since each call opens a status leg.
    function_legs_for: Arc<dyn Fn(&RuntimeBindingId) -> ResumeFunctionLegs + Send + Sync>,
}

/// What a session's resume brought back: the runs the provider answered for, each settled as it
/// answered before the resumed binding was recorded, and whether a binding was recorded for the
/// resumed process.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ResumedSession {
    /// The runs the resume named, lead and children alike, in the provider's order.
    pub named_run_ids: Vec<RunId>,
    /// Whether the resumed process runs under a binding recorded for it; a process already up
    /// answers on the binding that brought it up, and none is recorded.
    pub is_binding_recorded: bool,
    /// Whether the provider started no process because every run the resume named waits or
    /// stops, so no binding was recorded and the session stays unopened in this process.
    pub is_deferred: bool,
}

// Which of the driver's verbs brings a session's conversation back in a fresh process: the resume
// of a session's first admission or wake, the restart of a process that ended and stayed down, or
// the resume of a person's answer, which runs only with a held lead's continue to carry.
#[derive(Clone, Copy)]
enum Relaunch {
    Resume,
    Restart,
    Continue,
}

impl ProviderSessions {
    /// The resume of `session_id`'s conversation from its stored `leg` under `binding_id`,
    /// composed from the session's lead as it stands now on the account the leg ran on, at the
    /// level it stands at, in the mode it was last moved to, with the timed fires the idle sleep
    /// stored for it and its live runs as its log names them, under `binding_id`, with no function
    /// legs. Its opening takes the tool servers the leg stored, the set the resume sends, so no set
    /// is composed afresh, nothing waits on the tool-server table's first fill, and the legs it
    /// opens later report status for that stored set. Fails as the composition, the posture or the
    /// read of the mode, the timed fires or the live runs fails, and with
    /// [`ProviderSessionError::NotResumable`] for a leg with no conversation.
    pub async fn compose_resume(
        &self,
        session_id: SessionId,
        leg: &RuntimeBinding,
        binding_id: RuntimeBindingId,
    ) -> Result<ComposedResume, ProviderSessionError> {
        // The resume runs on the account the leg ran on, with the tool servers it stored, both read
        // back from its spawn record; a switch keeps that set current, so none is composed afresh.
        let opening = self
            .compose(
                session_id,
                leg.spawn_config.provider_account_id.clone(),
                OpeningToolServers::Stored(leg.spawn_config.tool_servers.clone()),
            )
            .await?;
        let execution_posture = posture_of(session_id, &opening)?;
        let (mode, kept_schedules, live_runs) = self
            .deps
            .pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, ProviderSessionError>((
                    read_session_mode(reader, &session_id)?,
                    read_session_schedules(reader, session_id)?,
                    RunStateReader::new(reader).list_live_run_resumes(&session_id)?,
                ))
            })
            .await?;
        let params = compose_resume_session_params(
            session_id,
            opening.create_params.agent_id,
            leg,
            binding_id.clone(),
            opening.create_params.model,
            opening.create_params.larger_window,
            mode,
            execution_posture.clone(),
            opening.create_params.options,
            opening.create_params.row_values,
            opening.create_params.subagent_policy,
            kept_schedules,
            live_runs,
        )?;
        Ok(ComposedResume {
            params,
            execution_posture,
            git_folder: opening.git_folder,
            function_legs_for: opening.function_legs_for,
        })
    }

    /// Starts the session's provider process again after it ended and stayed down, its newest
    /// conversation brought back through the driver's restart as an opening's resume brings it
    /// back, and keeps the session open in this process, the idle sleep following it awake; where
    /// every run in progress waits on the person, is pausing, or stops, the provider starts and
    /// reports no process and the session stays unopened, answered `Ok` with nothing recorded.
    /// Fails with [`ProviderSessionError::Closed`] or [`ProviderSessionError::BeingDeleted`] for an
    /// ended session, [`ProviderSessionError::NoConversation`] for one with none to resume,
    /// [`ProviderSessionError::Provider`] when no driver answers its provider or the driver cannot
    /// resume, the driver never called, [`ProviderSessionError::ResumeRefused`] for a restart the
    /// provider refused, [`ProviderSessionError::ResumedRuns`] for runs the resume named that were
    /// not settled, and as the composition, the driver or the binding's record fails. A restart
    /// whose provider no driver answers, or is not installed, posts the `providerMissing` notice
    /// first.
    pub async fn restart(&self, session_id: SessionId) -> Result<(), ProviderSessionError> {
        let _hold = self.deps.transition_lock.acquire(session_id).await;
        self.refuse_ended(session_id).await?;
        let leg = read_session_leg(&self.deps.pool, session_id)
            .await?
            .ok_or(ProviderSessionError::NoConversation { session_id })?;
        if let Err(refusal) = self
            .deps
            .providers
            .check_capability(&leg.provider_name, DriverCapabilityFlag::Resume)
        {
            return Err(self
                .answer_failed_start(session_id, &leg.provider_name, refusal.into())
                .await);
        }
        let (opened, _resumed) = self
            .relaunch(session_id, leg, Relaunch::Restart, None)
            .await?;
        if let Some(opened) = opened {
            self.record_opened(session_id, opened);
        }
        Ok(())
    }

    /// Resumes `session_id`'s conversation from its stored leg after the daemon started, as its
    /// first admission would, and keeps the session open in this process, the idle sleep following
    /// it awake; each run the resume names is settled through the resumed runs' ingress as the
    /// provider answers for it. Answers what the resume brought back, nothing for a session this
    /// process already opened. Fails with [`ProviderSessionError::Closed`] or
    /// [`ProviderSessionError::BeingDeleted`] for an ended session,
    /// [`ProviderSessionError::UnclosedFork`] while an unrecorded fork of it left running does not
    /// close, [`ProviderSessionError::NoConversation`] for one with none to resume, the driver
    /// never called, [`ProviderSessionError::ResumeRefused`] for a resume the provider refused,
    /// [`ProviderSessionError::ResumedRuns`] for runs the resume named that were not settled, and
    /// as the composition, the driver or the binding's record fails. A resume whose provider no
    /// driver answers, or is not installed, posts the `providerMissing` notice first.
    pub async fn resume_after_restart(
        &self,
        session_id: SessionId,
    ) -> Result<ResumedSession, ProviderSessionError> {
        let _hold = self.deps.transition_lock.acquire(session_id).await;
        self.refuse_ended(session_id).await?;
        self.close_held_fork(session_id).await?;
        if self.is_opened(session_id) {
            return Ok(ResumedSession::default());
        }
        let leg = read_session_leg(&self.deps.pool, session_id)
            .await?
            .ok_or(ProviderSessionError::NoConversation { session_id })?;
        self.resume_leg(session_id, leg).await
    }

    /// Continues `session_id`'s lead with the answers the person gave while the daemon's restart
    /// held it and the words of each paused run `continued_words` carries, once none is still owed.
    /// Fails for an ended session, one with no conversation, the provider's refusal (its answers
    /// owed to the next resume) and as the composition, the driver or the binding's record fails.
    pub(crate) async fn resume_after_answer(
        &self,
        session_id: SessionId,
        continued_words: &ContinuedWords<'_>,
    ) -> Result<(), ProviderSessionError> {
        // Resumed under the transition lock even where this process opened the conversation, so
        // the resume carries the continue: a driver holding the session live lets its record go
        // and takes it again, one holding nothing brings a process up, and nothing is resumed
        // while the lead is still held or nothing is owed.
        let _hold = self.deps.transition_lock.acquire(session_id).await;
        self.refuse_ended(session_id).await?;
        // A missing conversation, the provider's refusal or the driver's failure posts the
        // provider's words as the session's provider warning, and a provider no driver answers
        // posts the `providerMissing` notice first. The carried runs' messages are delivered once
        // the provider carried the continue.
        let Some(leg) = read_session_leg(&self.deps.pool, session_id).await? else {
            let failed = ProviderSessionError::NoConversation { session_id };
            return Err(self.answer_failed_continue(session_id, failed).await);
        };
        let relaunched = self
            .relaunch(session_id, leg, Relaunch::Continue, Some(continued_words))
            .await;
        let (opened, _resumed) = match relaunched {
            Ok(relaunched) => relaunched,
            Err(failed) => return Err(self.answer_failed_continue(session_id, failed).await),
        };
        // The opening it replaces holds the provider, the posture and the git folder, each composed
        // again from the stored leg and level, which every level move stores under this lock.
        if let Some(opened) = opened {
            self.record_opened(session_id, opened);
        }
        Ok(())
    }

    // The session's conversation is resumed in a fresh process from its stored `leg` and recorded
    // as its opening, unless the provider deferred it; answers what the resume brought back.
    pub(super) async fn resume_leg(
        &self,
        session_id: SessionId,
        leg: RuntimeBinding,
    ) -> Result<ResumedSession, ProviderSessionError> {
        let (opened, resumed) = self
            .relaunch(session_id, leg, Relaunch::Resume, None)
            .await?;
        if let Some(opened) = opened {
            self.record_opened(session_id, opened);
        }
        Ok(resumed)
    }

    // Brings `leg`'s conversation back in a fresh process through `relaunch`, under a binding
    // minted here whose cursor carries on where the leg's stands, opened before the driver runs,
    // since the provider delivers under it at once, and recorded once the driver answers and the
    // runs the resume named are settled as it answered for them; a process whose runs or record
    // fail is closed. A process already up that answers on its own binding records nothing, and
    // stays up when its runs fail; a deferred resume started none and records nothing. The held
    // lead's continue is claimed before the driver runs and given back when it fails, defers or
    // does not run the lead on; one the provider carried stays claimed whatever fails after, since
    // the lead has its answers, and the kept messages of each run whose words it carried are
    // delivered before the runs are taken. Only a relaunch given `continued_words` carries a
    // continued run. A `Continue` with none to carry calls no driver. Answers the opening,
    // `None` for a deferred resume or a continue not run, beside what the resume brought back.
    async fn relaunch(
        &self,
        session_id: SessionId,
        leg: RuntimeBinding,
        relaunch: Relaunch,
        continued_words: Option<&ContinuedWords<'_>>,
    ) -> Result<(Option<OpenedSession>, ResumedSession), ProviderSessionError> {
        let minted_id = mint_runtime_binding_id();
        let ComposedResume {
            mut params,
            execution_posture,
            git_folder,
            function_legs_for,
        } = self
            .compose_resume(session_id, &leg, minted_id.clone())
            .await?;
        let driver = match self.deps.providers.lookup(&leg.provider_name) {
            Ok(driver) => driver,
            Err(refusal) => {
                return Err(self
                    .answer_failed_start(session_id, &leg.provider_name, refusal.into())
                    .await);
            }
        };
        let ClaimedContinue {
            held_run_continue,
            claims,
            answered_runs,
            continued_messages,
        } = self
            .claim_held_run_continue(
                session_id,
                &mut params.live_runs,
                &params.kept_schedules,
                continued_words,
            )
            .await?;
        if matches!(relaunch, Relaunch::Continue) && held_run_continue.is_none() {
            return Ok((None, ResumedSession::default()));
        }
        let continued_lead_id = held_run_continue
            .as_ref()
            .map(|held_run_continue| held_run_continue.lead_run_id);
        params.held_run_continue = held_run_continue;
        // Status legs open only once the driver will run, so a continue that runs none opens none.
        params.on_mcp_server_status = function_legs_for(&minted_id).on_mcp_server_status;
        if let Err(unopened) = self
            .deps
            .binding_cursors
            .open_relaunch(session_id, &leg, minted_id.clone())
            .await
        {
            return Err(self
                .release_marks_after(session_id, claims, unopened.into())
                .await);
        }
        // Kept before the driver runs, so a give-back it sends before it answers finds them.
        self.hand_continue(session_id, continued_lead_id, claims);
        // The helpers live before the driver runs, read here because the settle of its answer may
        // record each one ended; a stop in progress is never revived.
        let live_helper_runs: Vec<RunId> = params
            .live_runs
            .iter()
            .filter(|run| run.subagent_id.is_some() && !run.is_stopping)
            .map(|run| run.run_id)
            .collect();
        let answered = match relaunch {
            Relaunch::Resume | Relaunch::Continue => driver.resume_session(params).await,
            Relaunch::Restart => driver.restart_session(params).await,
        };
        let answer = match answered {
            Ok(answer) => answer,
            Err(error) => {
                self.deps.binding_cursors.forget_binding(&minted_id);
                let failed = self
                    .answer_failed_start(session_id, &leg.provider_name, error.into())
                    .await;
                let claims = self.take_handed_continue(session_id);
                return Err(self.release_marks_after(session_id, claims, failed).await);
            }
        };
        let (binding_id, resume_handle, spawned_version, runs) = match answer {
            DriverResumeResult::Resumed {
                binding_id,
                resume_handle,
                spawned_version,
                runs,
                ..
            } => (binding_id, resume_handle, spawned_version, runs),
            DriverResumeResult::Failed {
                recovery_condition,
                provider_failure_detail,
            } => {
                self.deps.binding_cursors.forget_binding(&minted_id);
                let refused = ProviderSessionError::ResumeRefused {
                    session_id,
                    provider: leg.provider_name,
                    recovery_condition,
                    provider_failure_detail,
                };
                let claims = self.take_handed_continue(session_id);
                return Err(self.release_marks_after(session_id, claims, refused).await);
            }
            // An admission never meets this arm: with a live lead a send goes to that lead, a
            // queued lead is made only at the last lead's end, and the run being admitted is
            // itself named queued or starting, so the provider starts a process for it. Were one to
            // meet it anyway, the admission's binding refuses the unopened session before any
            // write.
            DriverResumeResult::Deferred { runs } => {
                self.deps.binding_cursors.forget_binding(&minted_id);
                // The continue reached no process, so the next relaunch carries it.
                self.release_marks(self.take_handed_continue(session_id))
                    .await
                    .map_err(|cause| ProviderSessionError::OrphanedAnswers { session_id, cause })?;
                let named_run_ids = runs.iter().map(|run| run.run_id).collect();
                // No process was started, so an untaken run has none to close.
                self.take_resumed_runs(session_id, runs).await?;
                return Ok((
                    None,
                    ResumedSession {
                        named_run_ids,
                        is_binding_recorded: false,
                        is_deferred: true,
                    },
                ));
            }
        };
        // A continue reached its lead only where the provider runs the lead's turn on; one it did
        // not take up is given back, so the next relaunch of that lead carries it. One it took up
        // stays handed, for the driver to give back should its turn not carry it after all.
        let is_continue_carried = continued_lead_id.is_some_and(|lead_run_id| {
            runs.iter().any(|run| {
                run.run_id == lead_run_id && run.turn == ProviderTurnAnswer::StillRunning
            })
        });
        if continued_lead_id.is_some()
            && !is_continue_carried
            && let Err(cause) = self
                .release_marks(self.take_handed_continue(session_id))
                .await
        {
            let unreleased = ProviderSessionError::OrphanedAnswers { session_id, cause };
            self.deps.binding_cursors.forget_binding(&minted_id);
            // A process this relaunch brought up is closed, as one whose runs were not taken is.
            return Err(if binding_id == minted_id {
                close_unrecorded(driver.as_ref(), session_id, unreleased).await
            } else {
                unreleased
            });
        }
        // A failure from here on, after the provider carried the continue, says so, since the lead
        // runs on with its answers.
        let after_carried = |failed: ProviderSessionError| {
            if is_continue_carried {
                ProviderSessionError::AfterCarriedContinue {
                    session_id,
                    failed: Box::new(failed),
                }
            } else {
                failed
            }
        };
        // A run the continue carries on from a wait whose asks are all answered runs again before
        // the runs are taken, so its settle reads it running; one the provider did not run on
        // keeps its wait.
        if is_continue_carried
            && !answered_runs.is_empty()
            && let Err(cause) = self.continue_answered_runs(answered_runs).await
        {
            let unmoved = ProviderSessionError::ResumedRuns { session_id, cause };
            self.deps.binding_cursors.forget_binding(&minted_id);
            return Err(after_carried(if binding_id == minted_id {
                close_unrecorded(driver.as_ref(), session_id, unmoved).await
            } else {
                unmoved
            }));
        }
        // A continued run's kept messages are delivered with it before its old run is settled,
        // which would otherwise give them back to go again beside the words the lead was sent.
        if is_continue_carried
            && let Some(continued_words) = continued_words
            && let Err(cause) =
                deliver_continued_messages(continued_words, continued_messages).await
        {
            let undelivered = ProviderSessionError::ResumedRuns { session_id, cause };
            self.deps.binding_cursors.forget_binding(&minted_id);
            return Err(after_carried(if binding_id == minted_id {
                close_unrecorded(driver.as_ref(), session_id, undelivered).await
            } else {
                undelivered
            }));
        }
        let named_run_ids = runs.iter().map(|run| run.run_id).collect();
        // Each run the resume named is settled before the binding is recorded, so none goes live
        // on the resumed process ahead of its settlement. A failure from here on gives nothing
        // back: a continue the lead did not take was given back above, and one it took reached it.
        let taken = self.take_resumed_runs(session_id, runs).await;
        let is_binding_recorded = binding_id == minted_id;
        if is_binding_recorded {
            if let Err(untaken) = taken {
                self.deps.binding_cursors.forget_binding(&minted_id);
                return Err(after_carried(
                    close_unrecorded(driver.as_ref(), session_id, untaken).await,
                ));
            }
            // A provider that continued the conversation in a new one left the old one behind.
            let left_conversations =
                LeftConversation::of_relaunch(session_id, &leg, resume_handle.as_str())
                    .into_iter()
                    .collect();
            let recorded = self
                .deps
                .binding_cursors
                .record_relaunch(
                    RuntimeBindingRelaunch {
                        predecessor_id: leg.id.clone(),
                        binding_id,
                        resume_handle: resume_handle.as_str().to_owned(),
                        spawned_version,
                        left_conversations,
                    },
                    Vec::new(),
                )
                .await;
            if let Err(unrecorded) = recorded {
                return Err(after_carried(
                    close_unrecorded(driver.as_ref(), session_id, unrecorded.into()).await,
                ));
            }
            self.reattach_helpers(driver.as_ref(), session_id, live_helper_runs)
                .await;
        } else {
            // A process already up answered on the binding that brought it up, which has its
            // cursor and its row, and whichever relaunch brought it up re-attached its helpers.
            self.deps.binding_cursors.forget_binding(&minted_id);
            taken.map_err(after_carried)?;
        }
        Ok((
            Some(OpenedSession {
                provider: leg.provider_name,
                execution_posture,
                git_folder,
            }),
            ResumedSession {
                named_run_ids,
                is_binding_recorded,
                is_deferred: false,
            },
        ))
    }

    // Hands `driver` the helpers of `session_id` whose runs `live_helper_runs` names, with their
    // ancestors, parents first, under the caller's transition lock; with none it reads and calls
    // nothing. A failed read or call is logged and the relaunch stands, since the settle already
    // recorded each helper as the provider answered for it.
    async fn reattach_helpers(
        &self,
        driver: &dyn ProviderDriver,
        session_id: SessionId,
        live_helper_runs: Vec<RunId>,
    ) {
        if live_helper_runs.is_empty() {
            return;
        }
        let reattached: Result<(), Box<dyn Error + Send + Sync>> = async {
            let helpers = self
                .deps
                .pool
                .read(ReadLength::Short, move |reader| {
                    read_helpers_to_reattach(reader, session_id, &live_helper_runs)
                        .map_err(Box::<dyn Error + Send + Sync>::from)
                })
                .await?;
            if !helpers.is_empty() {
                driver
                    .reattach_helpers(ReattachHelpersParams {
                        session_id,
                        helpers,
                    })
                    .await?;
            }
            Ok(())
        }
        .await;
        if let Err(error) = reattached {
            tracing::warn!(
                session_id = %session_id,
                error = &*error as &(dyn Error + 'static),
                "the helpers live before the relaunch could not be re-attached"
            );
        }
    }

    // Moves each run `runs` names on from its answered wait to running, through the resumed runs'
    // ingress.
    async fn continue_answered_runs(
        &self,
        runs: Vec<(RunId, RunState)>,
    ) -> Result<(), Box<dyn Error + Send + Sync>> {
        self.deps
            .resumed_runs
            .require_port()?
            .continue_answered_runs(runs)
            .await
    }

    // Hands the provider's answer for each run `session_id`'s resume named to the resumed runs'
    // ingress, under the caller's transition lock.
    async fn take_resumed_runs(
        &self,
        session_id: SessionId,
        runs: Vec<ResumedRunAnswer>,
    ) -> Result<(), ProviderSessionError> {
        self.deps
            .resumed_runs
            .require_port()?
            .take_resumed_runs(ResumedRuns { session_id, runs })
            .await
            .map_err(|cause| ProviderSessionError::ResumedRuns { session_id, cause })
    }

    // Brings `session_id`'s process up for the idle sleep under the session's transition lock.
    async fn wake(&self, session_id: SessionId) -> Result<SessionSleepState, ProviderSessionError> {
        let _hold = self.deps.transition_lock.acquire(session_id).await;
        // Read under the lock, so a close that took it first refuses the wake.
        self.refuse_ended(session_id).await?;
        let opened = self
            .lock_opened()
            .get(&session_id)
            .map(|opened| opened.provider.clone());
        if let Some(provider) = opened {
            let driver = self.deps.providers.lookup(&provider)?;
            return Ok(driver.wake_session(session_id).await?);
        }
        let leg = read_session_leg(&self.deps.pool, session_id)
            .await?
            .ok_or(ProviderSessionError::NoConversation { session_id })?;
        let resumed = self.resume_leg(session_id, leg).await?;
        Ok(if resumed.is_deferred {
            SessionSleepState::Asleep
        } else {
            SessionSleepState::Awake
        })
    }
}

// Delivers the kept messages of each run whose words a carried continue held, stopping at the
// first failure.
async fn deliver_continued_messages(
    continued_words: &ContinuedWords<'_>,
    continued_messages: Vec<(RunId, Vec<QueueItemId>)>,
) -> Result<(), Box<dyn Error + Send + Sync>> {
    for (run_id, message_ids) in continued_messages {
        continued_words
            .messages
            .deliver_carried(run_id, message_ids)
            .await?;
    }
    Ok(())
}

impl SessionProcessWaker for ProviderSessions {
    fn wake_process(
        &self,
        session_id: SessionId,
    ) -> BoxFuture<'_, Result<SessionSleepState, Box<dyn Error + Send + Sync>>> {
        async move { self.wake(session_id).await.map_err(Into::into) }.boxed()
    }
}
