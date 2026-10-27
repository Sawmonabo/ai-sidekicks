//! The write queue's maintenance: the checkpoints, optimizes, repacks and copies its callers ask
//! for, sent to the thread between batches and never while the writer holds its writes, and settled
//! from the thread's answers. A checkpoint, an optimize or a repack holds the thread, so nothing
//! else goes until it answers; a copy serves the requests that come while it lives, so writes go on
//! beside it, and a repack waits until no copy lives, so a `VACUUM` never runs beside one. A repack
//! canceled while it runs is interrupted, which only the queue may do, since only it knows the
//! repack and nothing else holds the thread.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::oneshot;
use tokio::sync::oneshot::error::RecvError;
use tokio_util::sync::CancellationToken;

use super::{ThreadStopped, WriteQueue, output_of, send_answer};
use crate::database::checkpoint::CheckpointMode;
use crate::database::writer::backup::BackupCopy;
use crate::database::writer::messages::{CheckpointReport, ThreadRequest};
use crate::database::writer::repack::RepackEnd;
use crate::database::writer::{MaintenanceError, is_interrupt};
use sidekicks_std::cleanup_failures::CleanupFailures;
use sidekicks_std::scheduler::budget::Measured;

/// Where a caller hears how its checkpoint, repack or copy went.
pub(super) type MaintenanceReply<Report> = oneshot::Sender<Result<Report, MaintenanceError>>;

/// The thread's answer to a checkpoint, a repack or a copy.
type MaintenanceAnswer<Report> = Result<Report, CleanupFailures<rusqlite::Error>>;

struct InFlight<Report> {
    reply: MaintenanceReply<Report>,
    answer: oneshot::Receiver<MaintenanceAnswer<Report>>,
}

struct PendingCheckpoint {
    mode: CheckpointMode,
    reply: MaintenanceReply<Measured<CheckpointReport>>,
}

/// A repack or a copy asked for: the token its caller cancels, and where its answer goes.
pub(super) struct CancelableWork<Report> {
    pub(super) cancel: CancellationToken,
    pub(super) reply: MaintenanceReply<Measured<Report>>,
}

struct InFlightRepack {
    flight: InFlight<Measured<RepackEnd>>,
    cancel: CancellationToken,
    is_interrupted: bool,
}

/// The maintenance asked for and in flight.
#[derive(Default)]
pub(super) struct MaintenanceSlots {
    checkpoint: Option<InFlight<Measured<CheckpointReport>>>,
    optimize: Option<InFlight<Measured<()>>>,
    repack: Option<InFlightRepack>,
    backup: Option<InFlight<Measured<BackupCopy>>>,
    checkpoints: VecDeque<PendingCheckpoint>,
    optimizes: VecDeque<MaintenanceReply<Measured<()>>>,
    repacks: VecDeque<CancelableWork<RepackEnd>>,
    backups: VecDeque<(PathBuf, CancelableWork<BackupCopy>)>,
}

/// The thread's answer to the maintenance in flight.
pub(super) enum MaintenanceAnswered {
    Checkpoint(Result<MaintenanceAnswer<Measured<CheckpointReport>>, RecvError>),
    Optimize(Result<MaintenanceAnswer<Measured<()>>, RecvError>),
    Repack(Result<MaintenanceAnswer<Measured<RepackEnd>>, RecvError>),
    Backup(Result<MaintenanceAnswer<Measured<BackupCopy>>, RecvError>),
}

impl MaintenanceSlots {
    /// The next answer the thread gives to the maintenance in flight; never while none is.
    pub(super) async fn answered(&mut self) -> MaintenanceAnswered {
        tokio::select! {
            answer = output_of(self.checkpoint.as_mut().map(|flight| &mut flight.answer)) => {
                MaintenanceAnswered::Checkpoint(answer)
            }
            answer = output_of(self.optimize.as_mut().map(|flight| &mut flight.answer)) => {
                MaintenanceAnswered::Optimize(answer)
            }
            answer = output_of(self.repack.as_mut().map(|repack| &mut repack.flight.answer)) => {
                MaintenanceAnswered::Repack(answer)
            }
            answer = output_of(self.backup.as_mut().map(|flight| &mut flight.answer)) => {
                MaintenanceAnswered::Backup(answer)
            }
        }
    }

    /// Whether a checkpoint, an optimize or a repack holds the thread.
    pub(super) fn holds_thread(&self) -> bool {
        self.checkpoint.is_some() || self.optimize.is_some() || self.repack.is_some()
    }

    /// Whether the thread runs any maintenance, a copy included.
    pub(super) fn is_running(&self) -> bool {
        self.holds_thread() || self.backup.is_some()
    }

    /// The cancel of the repack in flight, until the queue has interrupted it.
    pub(super) fn uninterrupted_repack_cancel(&self) -> Option<CancellationToken> {
        self.repack
            .as_ref()
            .filter(|repack| !repack.is_interrupted)
            .map(|repack| repack.cancel.clone())
    }

    /// Marks the repack in flight interrupted, answering whether one is, so its interrupt can only
    /// land on its own statements.
    pub(super) fn mark_repack_interrupted(&mut self) -> bool {
        self.repack.as_mut().is_some_and(|repack| {
            repack.is_interrupted = true;
            true
        })
    }

    /// Queues a checkpoint.
    pub(super) fn take_checkpoint(
        &mut self,
        mode: CheckpointMode,
        reply: MaintenanceReply<Measured<CheckpointReport>>,
    ) {
        self.checkpoints
            .push_back(PendingCheckpoint { mode, reply });
    }

    /// Queues an optimize.
    pub(super) fn take_optimize(&mut self, reply: MaintenanceReply<Measured<()>>) {
        self.optimizes.push_back(reply);
    }

    /// Queues a repack.
    pub(super) fn take_repack(&mut self, repack: CancelableWork<RepackEnd>) {
        self.repacks.push_back(repack);
    }

    /// Queues a copy into `destination`.
    pub(super) fn take_backup(&mut self, destination: PathBuf, copy: CancelableWork<BackupCopy>) {
        self.backups.push_back((destination, copy));
    }

    /// Fails each passive checkpoint queued, which never waits a hold out.
    pub(super) fn refuse_passive_checkpoints(&mut self) {
        let (passive, truncating): (VecDeque<_>, VecDeque<_>) =
            std::mem::take(&mut self.checkpoints)
                .into_iter()
                .partition(|checkpoint| checkpoint.mode == CheckpointMode::Passive);
        self.checkpoints = truncating;
        for checkpoint in passive {
            send_answer(checkpoint.reply, Err(MaintenanceError::Held));
        }
    }

    /// Fails every checkpoint, optimize, repack and copy not yet sent with `error`.
    pub(super) fn fail_unsent(&mut self, error: impl Fn() -> MaintenanceError) {
        for checkpoint in self.checkpoints.drain(..) {
            send_answer(checkpoint.reply, Err(error()));
        }
        for optimize in self.optimizes.drain(..) {
            send_answer(optimize, Err(error()));
        }
        for repack in self.repacks.drain(..) {
            send_answer(repack.reply, Err(error()));
        }
        for (_destination, copy) in self.backups.drain(..) {
            send_answer(copy.reply, Err(error()));
        }
    }

    /// Sends the next queued work through `send`: a checkpoint, then an optimize, then a repack
    /// while no copy runs, then a copy while none runs. Answers whether it sent one.
    pub(super) fn send_next(&mut self, send: impl FnOnce(ThreadRequest)) -> bool {
        if let Some(checkpoint) = self.checkpoints.pop_front() {
            let (reply, answer) = oneshot::channel();
            send(ThreadRequest::Checkpoint {
                mode: checkpoint.mode,
                reply,
            });
            self.checkpoint = Some(InFlight {
                reply: checkpoint.reply,
                answer,
            });
            return true;
        }
        if let Some(reply) = self.optimizes.pop_front() {
            let (thread_reply, answer) = oneshot::channel();
            send(ThreadRequest::Optimize {
                reply: thread_reply,
            });
            self.optimize = Some(InFlight { reply, answer });
            return true;
        }
        if self.backup.is_none()
            && let Some(repack) = self.repacks.pop_front()
        {
            let (thread_reply, answer) = oneshot::channel();
            send(ThreadRequest::Repack {
                cancel: repack.cancel.clone(),
                reply: thread_reply,
            });
            self.repack = Some(InFlightRepack {
                flight: InFlight {
                    reply: repack.reply,
                    answer,
                },
                cancel: repack.cancel,
                is_interrupted: false,
            });
            return true;
        }
        if self.backup.is_none()
            && let Some((destination, copy)) = self.backups.pop_front()
        {
            let (thread_reply, answer) = oneshot::channel();
            send(ThreadRequest::Backup {
                destination,
                cancel: copy.cancel,
                reply: thread_reply,
            });
            self.backup = Some(InFlight {
                reply: copy.reply,
                answer,
            });
            return true;
        }
        false
    }
}

impl WriteQueue {
    /// Settles the maintenance the thread answered.
    pub(super) fn settle_maintenance_answer(&mut self, answered: MaintenanceAnswered) {
        match answered {
            MaintenanceAnswered::Checkpoint(answer) => {
                let flight = self
                    .maintenance
                    .checkpoint
                    .take()
                    .expect("a checkpoint is answered only while it is in flight");
                self.settle_maintenance(flight.reply, answer);
            }
            MaintenanceAnswered::Optimize(answer) => {
                let flight = self
                    .maintenance
                    .optimize
                    .take()
                    .expect("an optimize is answered only while it is in flight");
                self.settle_maintenance(flight.reply, answer);
            }
            MaintenanceAnswered::Repack(answer) => {
                let repack = self
                    .maintenance
                    .repack
                    .take()
                    .expect("a repack is answered only while it is in flight");
                self.settle_maintenance(repack.flight.reply, answer);
            }
            MaintenanceAnswered::Backup(answer) => {
                let flight = self
                    .maintenance
                    .backup
                    .take()
                    .expect("a copy is answered only while it is in flight");
                self.settle_maintenance(flight.reply, answer);
            }
        }
    }

    fn settle_maintenance<Report>(
        &mut self,
        reply: MaintenanceReply<Report>,
        answer: Result<MaintenanceAnswer<Report>, RecvError>,
    ) {
        let result = match answer {
            Ok(Ok(result)) => Ok(result),
            // The stop interrupted the work, which fails as the stop's writes do.
            Ok(Err(failure))
                if self.shared.stop.is_stopped() && is_interrupt(failure.original()) =>
            {
                for cleanup_failure in failure.cleanup_failures() {
                    self.report_unless_interrupted(cleanup_failure);
                }
                Err(self
                    .shared
                    .end_reason()
                    .map_or(MaintenanceError::Closed, MaintenanceError::Ended))
            }
            Ok(Err(failure)) => {
                self.report_failure(&failure);
                Err(MaintenanceError::Failed(failure))
            }
            Err(_unanswered) => Err(MaintenanceError::Ended(
                self.end_writer(Arc::new(ThreadStopped)),
            )),
        };
        send_answer(reply, result);
    }
}
