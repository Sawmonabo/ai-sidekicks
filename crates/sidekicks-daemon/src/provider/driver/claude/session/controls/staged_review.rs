//! Claude Code's review of the staged set alone, as the session's own run apart from its process:
//! a one-turn process in a worktree holding only the staged changes, on the session's account and
//! model. Its report lands as the run's reply and the run completes; a refusal fails it refused, a
//! stop ends it interrupted unless the daemon writes that end itself, and the worktree goes and the
//! review finishes however the turn ends.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use sidekicks_contracts::event::declared_variants::RunAgentOutputPayload;
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::run::control::RunFailureCategory;
use sidekicks_contracts::run::failure_cause::RunFailureCause;
use sidekicks_contracts::session::controls::events::SessionNotice;
use sidekicks_contracts::session::controls::methods::SessionReviewTarget;
use sidekicks_contracts::wire::text::{FreeFormText, TextError};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use super::{ClaudeSessionControls, compose_review_command, one_turn_legs};
use crate::cleanup_failures::CleanupFailures;
use crate::error_description::describe_error;
use crate::git::worktree::staged_changes::StagedChangesError;
use crate::mutex_lock::lock;
use crate::provider::driver::claude::run::routes::ClaudeBoundRun;
use crate::provider::driver::claude::run::start::ClaudeDaemonTurnOpening;
use crate::provider::driver::claude::session::errors::record_unheard_claude_failure;
use crate::provider::driver::claude::session::state::LiveClaudeSession;
use crate::provider::driver::claude::spawn::launch::ClaudeLaunchError;
use crate::provider::driver::contract::{DriverError, bound_failure_detail};
use crate::provider::driver::diagnostics::DriverDiagnosticKind;
use crate::provider::driver::error_causes::UNSPECIFIED_PROVIDER_FAILURE_DETAIL;
use crate::session::run::inbound::rows::LateAppendableRow;
use crate::session::run::inbound::{DeliveryBinding, InboundDelivery};
use crate::session::run::state_change::{RunStateChange, RunStateEntry};

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
        let ended = self.run_staged_review(live, &stop.stop).await;
        let change = match ended {
            Ok(ClaudeStagedReviewEnd::Refused(cause)) => Some(RunStateChange {
                failure_category: Some(RunFailureCategory::Refused),
                ..RunStateChange::new(
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
                Some(RunStateChange::new(
                    run.run_id,
                    RunStateEntry::Completed {
                        intended_close: None,
                    },
                ))
            }
            Err(_) if stop.stop.is_cancelled() => (!stop.is_end_written.load(Ordering::Acquire))
                .then(|| {
                    RunStateChange::new(
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
                Some(RunStateChange {
                    failure_category: Some(RunFailureCategory::ProviderFailure),
                    ..RunStateChange::new(
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

    // The review's one turn in a worktree of the staged set, which goes however the turn ends; a
    // review stopped before it began opens no worktree and starts no process.
    async fn run_staged_review(
        &self,
        live: &LiveClaudeSession,
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
        let legs = one_turn_legs(live, Some(worktree.folder().to_path_buf()));
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
        // The review's result stands whether or not its worktree went; a leftover is recorded.
        if let Err(leftover) = worktree.close().await {
            record_unheard_claude_failure(
                DriverDiagnosticKind::ProcessReportFailed,
                live.session_id,
                "the staged review's worktree removal",
                &leftover,
            );
        }
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
