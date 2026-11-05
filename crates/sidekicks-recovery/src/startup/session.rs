//! The settle of one session the recovery pass lists: the resume of its conversation where it had
//! work in progress, or none where the stop intent names it, then the settle of what the restart
//! left in it.

use std::collections::BTreeSet;
use std::error::Error;
use std::sync::LazyLock;

use sidekicks_contracts::daemon::recovery::DaemonRecoveryHaltedRun;
use sidekicks_contracts::provider::driver::length_limits::PROVIDER_FAILURE_DETAIL_MAX_LEN;
use sidekicks_contracts::provider::driver::recovery::RecoveryCondition;
use sidekicks_contracts::run::control::RunFailureCategory;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_provider::driver::contract::error::bound_failure_detail;
use sidekicks_provider::driver::session_control::KeptRunTurns;
use sidekicks_queue::provider_session::errors::ProviderSessionError;
use sidekicks_session::run::read::RunStateReader;
use sidekicks_session::run::restart::read_has_own_stop;
use sidekicks_std::error_description::describe_error;
use sidekicks_store::database::connection::read_pool::ReadLength;
use tokio_util::sync::CancellationToken;

use crate::restart_settle::{LiveRunsEnd, RESTART_FAILURE_DETAIL};
use crate::startup::{PassFailure, PassTally, StartupRecovery};

// What a run records when its provider refused the resume without a message.
static UNDESCRIBED_RESUME_FAILURE: LazyLock<FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>> =
    LazyLock::new(|| {
        FreeFormText::new("The provider could not resume the conversation".to_owned())
            .expect("the words are free-form text")
    });

// How a session's resume ended for the runs it did not leave live: the runs it took, the
// provider's refusal the others end with, where it refused, and the turns the restart kept of the
// runs that end with no resume, which are ended on the provider.
#[derive(Default)]
struct SessionResume {
    resumed: BTreeSet<RunId>,
    refusal: Option<ResumeRefusal>,
    kept_turns: Vec<KeptRunTurns>,
}

// A resume the provider refused: what the runs' recovery needs and the provider's own words.
struct ResumeRefusal {
    recovery_condition: RecoveryCondition,
    detail: FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>,
}

impl StartupRecovery {
    /// Resumes the session's conversation where it had work in progress, then settles what the
    /// restart left in it; a listed one takes calls again after, except one under the stop intent,
    /// whose runs end as the person's Stop ends them with no resume and which the pass lets take
    /// calls once it has dropped its name. Fails at the first step that fails.
    pub(super) async fn settle_session(
        &self,
        session_id: SessionId,
        is_under_stop: bool,
        tally: &mut PassTally,
        stop: &CancellationToken,
    ) -> Result<(), PassFailure> {
        if stop.is_cancelled() {
            return Err(PassFailure::Stopped);
        }
        let status = &self.deps.status;
        status.mark_session_settling(&session_id);
        let resume = self
            .resume_session(session_id, is_under_stop, tally, stop)
            .await?;
        let end = if is_under_stop {
            LiveRunsEnd::AtStop
        } else {
            LiveRunsEnd::AfterRestart(
                resume
                    .refusal
                    .as_ref()
                    .map_or(RESTART_FAILURE_DETAIL, |refusal| refusal.detail.as_str()),
            )
        };
        let settled = self
            .deps
            .restart_settle
            .settle_live(session_id, &resume.resumed, end, None, Some(stop))
            .await?;
        tally.restart.add(settled.tally);
        // The runs are settled; their turns end on the provider off the pass, which only waits
        // for the driver to hold the session, so no run reaches it before the work.
        if !resume.kept_turns.is_empty()
            && let Err(failure) = self
                .deps
                .provider_sessions
                .end_kept_turns(session_id, resume.kept_turns, stop.clone())
                .await
        {
            tracing::warn!(
                session_id = %session_id,
                error = &failure as &(dyn Error + 'static),
                "the turns a restart kept in a session not resumed could not be ended; they run on"
            );
        }
        if let Some(refusal) = resume.refusal {
            for run_id in settled.failed_run_ids {
                status.mark_run_halted(
                    &session_id,
                    DaemonRecoveryHaltedRun {
                        run_id,
                        recovery_condition: refusal.recovery_condition,
                        failure_category: Some(RunFailureCategory::ProviderFailure),
                    },
                );
            }
        }
        self.deps
            .restart_settle
            .settle_ended(session_id, Some(stop))
            .await?;
        // The client's open questions came on requests the restart ended, so they are withdrawn
        // before the session takes calls.
        self.deps
            .questions
            .withdraw_tool_server_questions(session_id)
            .await?;
        if !is_under_stop {
            status.mark_session_healthy(&session_id);
        }
        Ok(())
    }

    // Re-arms the session's runs in progress and resumes its conversation through the provider
    // sessions, which settle each run the resume names as the provider answers for it; a session
    // with no run in progress, its paused runs included, or whose runs in progress each wait on a
    // pending stop of their own, is not opened, so no process is started for work the person
    // stopped, and neither is a session the stop intent names. Answers the runs the resume took, a
    // paused one among them staying paused, and the provider's refusal where it refused; a session
    // with no conversation to resume, or whose resume failed short of the provider's answer,
    // answers neither, and its runs are settled as before any resume. Where the session is not
    // opened for its runs in progress, it answers the kept turns of every one of them too.
    async fn resume_session(
        &self,
        session_id: SessionId,
        is_under_stop: bool,
        tally: &mut PassTally,
        stop: &CancellationToken,
    ) -> Result<SessionResume, PassFailure> {
        let rearmed = self
            .deps
            .restart_settle
            .rearm_live(session_id, stop)
            .await?;
        let in_progress: Vec<RunId> = rearmed
            .in_progress
            .iter()
            .map(|live_run| live_run.run_id)
            .collect();
        if is_under_stop
            || in_progress
                .iter()
                .all(|run_id| rearmed.stopping.contains(run_id))
        {
            return Ok(SessionResume {
                kept_turns: self
                    .read_kept_turns(session_id, in_progress, is_under_stop)
                    .await?,
                ..SessionResume::default()
            });
        }
        if stop.is_cancelled() {
            return Err(PassFailure::Stopped);
        }
        let refusal = match self
            .deps
            .provider_sessions
            .resume_after_restart(session_id)
            .await
        {
            Ok(resumed) => {
                tally.bindings_restored += u64::from(resumed.is_binding_recorded);
                return Ok(SessionResume {
                    resumed: resumed
                        .named_run_ids
                        .into_iter()
                        .filter(|run_id| {
                            rearmed.paused_run_ids.contains(run_id)
                                || rearmed
                                    .in_progress
                                    .iter()
                                    .any(|live_run| live_run.run_id == *run_id)
                        })
                        .collect(),
                    refusal: None,
                    kept_turns: Vec::new(),
                });
            }
            Err(ProviderSessionError::ResumeRefused {
                recovery_condition,
                provider_failure_detail,
                ..
            }) => ResumeRefusal {
                recovery_condition,
                detail: provider_failure_detail,
            },
            Err(ProviderSessionError::Driver(refused)) => ResumeRefusal {
                recovery_condition: RecoveryCondition::RecoveryNeeded,
                detail: bound_failure_detail(
                    &describe_error(&refused),
                    UNDESCRIBED_RESUME_FAILURE.clone(),
                ),
            },
            Err(ProviderSessionError::NoConversation { .. }) => {
                return Ok(SessionResume::default());
            }
            Err(failure) => {
                tracing::warn!(
                    session_id = %session_id,
                    error = &failure as &(dyn Error + 'static),
                    "a session's conversation could not be resumed; its runs are settled as \
                     though none came back"
                );
                return Ok(SessionResume {
                    kept_turns: self.read_kept_turns(session_id, in_progress, false).await?,
                    ..SessionResume::default()
                });
            }
        };
        Ok(SessionResume {
            resumed: BTreeSet::new(),
            refusal: Some(refusal),
            kept_turns: self.read_kept_turns(session_id, in_progress, false).await?,
        })
    }

    // The turns the restart kept of `in_progress`, read before the settle ends the runs: each run's
    // open turns under the provider's ids, a run with none left out, and whether a stop ends it,
    // its own or, where `is_under_stop`, the person's Stop of the service.
    async fn read_kept_turns(
        &self,
        session_id: SessionId,
        in_progress: Vec<RunId>,
        is_under_stop: bool,
    ) -> Result<Vec<KeptRunTurns>, PassFailure> {
        if in_progress.is_empty() {
            return Ok(Vec::new());
        }
        self.deps
            .reads
            .read(ReadLength::Short, move |reader| {
                let mut kept_turns = Vec::new();
                for run in RunStateReader::new(reader).list_live_run_resumes(&session_id)? {
                    if !in_progress.contains(&run.run_id) {
                        continue;
                    }
                    let is_for_stop = is_under_stop || read_has_own_stop(reader, &run.run_id)?;
                    let turn_ids: Vec<_> = run
                        .open_turns
                        .into_iter()
                        .filter_map(|turn| turn.provider_turn_id)
                        .collect();
                    if !turn_ids.is_empty() {
                        kept_turns.push(KeptRunTurns {
                            run_id: run.run_id,
                            subagent_id: run.subagent_id,
                            turn_ids,
                            is_for_stop,
                        });
                    }
                }
                Ok::<_, PassFailure>(kept_turns)
            })
            .await
    }
}
