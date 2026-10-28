//! Claude Code's review of the staged set alone, as the session's own run apart from its process:
//! a one-turn process in a worktree holding only the staged changes, on the session's account and
//! model, its commands reaching a command channel of its own and landing as rows under its run.
//! Its report lands as the run's reply and the run completes; a refusal fails it refused, a stop
//! ends it interrupted unless the daemon writes that end itself, and the worktree and channel go
//! and the review finishes however the turn ends.

use std::io;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use sidekicks_contracts::event::declared_variants::RunAgentOutputPayload;
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::run::control::RunFailureCategory;
use sidekicks_contracts::run::failure_cause::RunFailureCause;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::controls::events::SessionNotice;
use sidekicks_contracts::session::controls::methods::SessionReviewTarget;
use sidekicks_contracts::wire::text::{FreeFormText, TextError};
use sidekicks_std::cleanup_failures::CleanupFailures;
use sidekicks_std::error_description::describe_error;
use sidekicks_std::mutex_lock::lock;
use sidekicks_workspace::git::worktree::staged_changes::{
    StagedChangesError, StagedChangesWorktree,
};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use super::{ClaudeSessionControls, compose_review_command, one_turn_legs};
use crate::driver::claude::delivery::commands::ClaudeCommandChannel;
use crate::driver::claude::run::routes::ClaudeBoundRun;
use crate::driver::claude::run::start::ClaudeDaemonTurnOpening;
use crate::driver::claude::session::errors::record_unheard_claude_failure;
use crate::driver::claude::session::state::LiveClaudeSession;
use crate::driver::claude::session::transport::spawn_legs::ClaudeSpawnBoundLegs;
use crate::driver::claude::spawn::launch::ClaudeLaunchError;
use crate::driver::contract::{DriverError, bound_failure_detail};
use crate::driver::diagnostics::DriverDiagnosticKind;
use crate::driver::error_causes::UNSPECIFIED_PROVIDER_FAILURE_DETAIL;
use crate::run::delivery::{DeliveryBinding, InboundDelivery, LateAppendableRow};
use crate::run::state_entry::{RunStateEntry, RunStateReport};

// How a review of the staged set ended: refused by the model, or with its report.
enum ClaudeStagedReviewEnd {
    Refused(RunFailureCause),
    Reported {
        text: String,
        provider_message_id: FreeFormText<EVENT_FIELD_MAX_LEN>,
    },
}

// Why a review of the staged set has no end of its own.
#[derive(Debug, thiserror::Error)]
enum ClaudeStagedReviewError {
    #[error(transparent)]
    Worktree(#[from] CleanupFailures<StagedChangesError>),
    #[error(transparent)]
    Turn(#[from] CleanupFailures<ClaudeLaunchError, StagedChangesError>),
    #[error("the staged review's Claude Code process sent no report")]
    NoReport,
    #[error("the staged review's report has a message id no event carries")]
    ReportIdUnwritable(#[source] TextError),
    #[error("the staged review was stopped before it began")]
    Stopped,
    #[error("the staged review's command channel could not be opened")]
    CommandChannel(#[source] io::Error),
}

// How the review's run is stopped: its stop, and whether the daemon writes the run's end itself.
#[derive(Clone)]
struct ClaudeStagedReviewStop {
    stop: CancellationToken,
    is_end_written: Arc<AtomicBool>,
}

impl ClaudeSessionControls {
    // Starts the review's run apart from the session's process, stoppable from the moment it has
    // an id; returns once the start notice is out, so its finish can never come first.
    pub(super) async fn start_staged_review(
        self: &Arc<Self>,
        live: &Arc<LiveClaudeSession>,
    ) -> Result<(), DriverError> {
        let session_id = live.session_id;
        let stop = ClaudeStagedReviewStop {
            stop: CancellationToken::new(),
            is_end_written: Arc::new(AtomicBool::new(false)),
        };
        let (bound_sender, bound) = oneshot::channel::<ClaudeBoundRun>();
        let bound_sender = Mutex::new(Some(bound_sender));
        let routes = Arc::clone(&self.run_start.routes);
        let run_stop = stop.clone();
        let start = Arc::new(move |run: ClaudeBoundRun| {
            let run_stop = run_stop.clone();
            routes.bind_apart_run(
                run.run_id,
                Box::new(move |is_end_written| {
                    run_stop
                        .is_end_written
                        .store(is_end_written, Ordering::Release);
                    run_stop.stop.cancel();
                }),
            );
            if let Some(sender) = lock(&bound_sender).take() {
                // The start stopped waiting only once it failed, which forgets the route.
                sender.send(run).unwrap_or(());
            }
        });
        let started = self
            .run_start
            .start_daemon_turn(session_id, ClaudeDaemonTurnOpening::Apart { start })
            .await;
        let mut bound = bound;
        if let Err(error) = started {
            if let Ok(run) = bound.try_recv() {
                self.run_start.routes.forget_apart_run(run.run_id);
            }
            return Err(error);
        }
        let run = bound.await.map_err(|_never_bound| {
            DriverError::Internal("the staged review's run was started but never bound".into())
        })?;
        self.post_notice(
            session_id,
            SessionNotice::ReviewStarted {
                session_id,
                target: SessionReviewTarget::Staged,
            },
        )
        .await;
        let (controls, live) = (Arc::clone(self), Arc::clone(live));
        tokio::spawn(async move { controls.review_staged(&live, run, &stop).await });
        Ok(())
    }

    // Runs the review to its end, ends its run as the turn ended, then lets the route go and
    // finishes the review.
    async fn review_staged(
        &self,
        live: &LiveClaudeSession,
        run: ClaudeBoundRun,
        stop: &ClaudeStagedReviewStop,
    ) {
        let session_id = live.session_id;
        let ended = self.run_staged_review(live, &run, &stop.stop).await;
        let change = match ended {
            Ok(ClaudeStagedReviewEnd::Refused(cause)) => Some(RunStateReport {
                failure_category: Some(RunFailureCategory::Refused),
                ..RunStateReport::new(
                    run.run_id,
                    RunStateEntry::Failed {
                        intended_close: None,
                        failure_cause: Some(cause),
                        provider_failure_detail: None,
                        process_exit: None,
                    },
                )
            }),
            Ok(ClaudeStagedReviewEnd::Reported {
                text,
                provider_message_id,
            }) => {
                self.deliver_report(live, &run, text, provider_message_id)
                    .await;
                Some(RunStateReport::new(
                    run.run_id,
                    RunStateEntry::Completed {
                        intended_close: None,
                    },
                ))
            }
            Err(_) if stop.stop.is_cancelled() => (!stop.is_end_written.load(Ordering::Acquire))
                .then(|| {
                    RunStateReport::new(
                        run.run_id,
                        RunStateEntry::Interrupted {
                            intended_close: None,
                            trigger: None,
                        },
                    )
                }),
            Err(error) => {
                record_unheard_claude_failure(
                    DriverDiagnosticKind::ProcessReportFailed,
                    session_id,
                    "the staged review",
                    &error,
                );
                Some(RunStateReport {
                    failure_category: Some(RunFailureCategory::ProviderFailure),
                    ..RunStateReport::new(
                        run.run_id,
                        RunStateEntry::Failed {
                            intended_close: None,
                            failure_cause: None,
                            provider_failure_detail: Some(bound_failure_detail(
                                &describe_error(&error),
                                UNSPECIFIED_PROVIDER_FAILURE_DETAIL.clone(),
                            )),
                            process_exit: None,
                        },
                    )
                })
            }
        };
        if let Some(change) = change {
            drop(
                self.deliver(
                    session_id,
                    InboundDelivery::RunLifecycle {
                        binding: DeliveryBinding {
                            binding_id: run.binding_id.clone(),
                            operation: None,
                        },
                        change,
                        turn_end: None,
                        is_daemon_interrupt_end: false,
                    },
                )
                .await,
            );
        }
        self.run_start.routes.forget_apart_run(run.run_id);
        self.post_notice(session_id, SessionNotice::ReviewFinished { session_id })
            .await;
    }

    // The review's one turn on `run` in a worktree of the staged set, which goes however the turn
    // ends; a review stopped before it began opens no worktree and starts no process.
    async fn run_staged_review(
        &self,
        live: &LiveClaudeSession,
        run: &ClaudeBoundRun,
        stop: &CancellationToken,
    ) -> Result<ClaudeStagedReviewEnd, ClaudeStagedReviewError> {
        if stop.is_cancelled() {
            return Err(ClaudeStagedReviewError::Stopped);
        }
        // A session runs its process on the computer's own system, where its worktrees are made.
        let worktree = self
            .staged_changes
            .open_staged_worktree(None, &live.spawn_bound_legs.working_directory)
            .await?;
        let (legs, command_channel) = match self
            .compose_review_legs(live, run.run_id, worktree.folder().to_path_buf())
            .await
        {
            Ok(composed) => composed,
            Err(error) => {
                close_review_worktree(live, worktree).await;
                return Err(ClaudeStagedReviewError::CommandChannel(error));
            }
        };
        let turn = self
            .run_one_turn(
                &legs,
                live.admitted_provider_account_id.clone(),
                None,
                None,
                compose_review_command(SessionReviewTarget::Staged),
                stop.clone(),
            )
            .await;
        // The channel served only this turn's process, which has ended however the turn did.
        if let Some(command_channel) = command_channel
            && let Err(leftover) = command_channel.close().await
        {
            record_unheard_claude_failure(
                DriverDiagnosticKind::ProcessReportFailed,
                live.session_id,
                "the staged review's command channel removal",
                &leftover,
            );
        }
        let reply = match turn {
            Ok(reply) => reply,
            Err(turn_failure) => {
                let cleanup = worktree
                    .close()
                    .await
                    .err()
                    .map_or_else(Vec::new, |failures| {
                        let (original, mut rest, _) = failures.into_parts();
                        rest.insert(0, original);
                        rest
                    });
                return Err(CleanupFailures::new(turn_failure, cleanup, "staged review").into());
            }
        };
        close_review_worktree(live, worktree).await;
        if let Some(refusal) = reply.refusal {
            return Ok(ClaudeStagedReviewEnd::Refused(refusal));
        }
        // A review that sent no message has no report, so the run fails rather than ending empty;
        // one whose id no event carries fails too, since its report could not be stored.
        let provider_message_id = reply
            .provider_message_id
            .ok_or(ClaudeStagedReviewError::NoReport)?;
        let provider_message_id = FreeFormText::new(provider_message_id)
            .map_err(ClaudeStagedReviewError::ReportIdUnwritable)?;
        Ok(ClaudeStagedReviewEnd::Reported {
            text: reply.text,
            provider_message_id,
        })
    }

    /// The legs the review's one-turn process starts on in `worktree_folder`, and the channel of
    /// its own its commands reach as rows under `run_id`, where one opens, which the caller closes
    /// once the process ended. Fails as the channel cannot be opened.
    pub(crate) async fn compose_review_legs(
        &self,
        live: &LiveClaudeSession,
        run_id: RunId,
        worktree_folder: PathBuf,
    ) -> io::Result<(ClaudeSpawnBoundLegs, Option<Arc<ClaudeCommandChannel>>)> {
        let command_channel = self
            .command_channels
            .open_apart(live.session_id, run_id)
            .await?;
        let legs = one_turn_legs(live, Some(worktree_folder), command_channel.clone());
        Ok((legs, command_channel))
    }

    // The report lands as the run's reply.
    async fn deliver_report(
        &self,
        live: &LiveClaudeSession,
        run: &ClaudeBoundRun,
        text: String,
        provider_message_id: FreeFormText<EVENT_FIELD_MAX_LEN>,
    ) {
        let payload = RunAgentOutputPayload {
            session_id: live.session_id,
            provider_message_id,
            content_type: None,
            run_id: run.run_id,
            provider_block: None,
            origin: None,
            source_epoch: None,
            source_position: None,
            content_length: None,
            content_truncated: None,
            content_encoding: None,
        };
        drop(
            self.deliver(
                live.session_id,
                InboundDelivery::SessionRow {
                    binding: DeliveryBinding {
                        binding_id: run.binding_id.clone(),
                        operation: None,
                    },
                    row: LateAppendableRow::AgentMessageSent(payload),
                    content: Some(text),
                },
            )
            .await,
        );
    }
}

// Removes the review's worktree; the review's result stands whether or not it went, so a leftover
// is recorded.
async fn close_review_worktree(live: &LiveClaudeSession, worktree: StagedChangesWorktree) {
    if let Err(leftover) = worktree.close().await {
        record_unheard_claude_failure(
            DriverDiagnosticKind::ProcessReportFailed,
            live.session_id,
            "the staged review's worktree removal",
            &leftover,
        );
    }
}
