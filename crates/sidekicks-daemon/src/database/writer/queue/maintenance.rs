//! The write queue's maintenance: the checkpoints, repacks and copies its callers ask for, sent to
//! the thread between batches and never while the writer holds its writes, and settled from the
//! thread's answers. A checkpoint or a repack holds the thread, so nothing else goes until it
//! answers; a copy serves the requests that come while it lives, so writes go on beside it.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::oneshot;
use tokio::sync::oneshot::error::RecvError;

use super::{ThreadStopped, WriteQueue, output_of, send_answer};
use crate::cleanup_failures::CleanupFailures;
use crate::database::checkpoint::{CheckpointMode, CheckpointResult};
use crate::database::writer::backup::BackupCopy;
use crate::database::writer::messages::ThreadRequest;
use crate::database::writer::repack::RepackReport;
use crate::database::writer::{MaintenanceError, is_interrupt};

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
    reply: MaintenanceReply<CheckpointResult>,
}

/// The maintenance asked for and in flight.
#[derive(Default)]
pub(super) struct MaintenanceSlots {
    checkpoint: Option<InFlight<CheckpointResult>>,
    repack: Option<InFlight<RepackReport>>,
    backup: Option<InFlight<BackupCopy>>,
    checkpoints: VecDeque<PendingCheckpoint>,
    repacks: VecDeque<MaintenanceReply<RepackReport>>,
    backups: VecDeque<(PathBuf, MaintenanceReply<BackupCopy>)>,
}

/// The thread's answer to the maintenance in flight.
pub(super) enum MaintenanceAnswered {
    Checkpoint(Result<MaintenanceAnswer<CheckpointResult>, RecvError>),
    Repack(Result<MaintenanceAnswer<RepackReport>, RecvError>),
    Backup(Result<MaintenanceAnswer<BackupCopy>, RecvError>),
}

impl MaintenanceSlots {
    /// The next answer the thread gives to the maintenance in flight; never while none is.
    pub(super) async fn answered(&mut self) -> MaintenanceAnswered {
        tokio::select! {
            answer = output_of(self.checkpoint.as_mut().map(|flight| &mut flight.answer)) => {
                MaintenanceAnswered::Checkpoint(answer)
            }
            answer = output_of(self.repack.as_mut().map(|flight| &mut flight.answer)) => {
                MaintenanceAnswered::Repack(answer)
            }
            answer = output_of(self.backup.as_mut().map(|flight| &mut flight.answer)) => {
                MaintenanceAnswered::Backup(answer)
            }
        }
    }

    /// Whether a checkpoint or a repack holds the thread.
    pub(super) fn holds_thread(&self) -> bool {
        self.checkpoint.is_some() || self.repack.is_some()
    }

    /// Whether the thread runs any maintenance, a copy included.
    pub(super) fn is_running(&self) -> bool {
        self.holds_thread() || self.backup.is_some()
    }

    /// Queues a checkpoint.
    pub(super) fn take_checkpoint(
        &mut self,
        mode: CheckpointMode,
        reply: MaintenanceReply<CheckpointResult>,
    ) {
        self.checkpoints
            .push_back(PendingCheckpoint { mode, reply });
    }

    /// Queues a repack.
    pub(super) fn take_repack(&mut self, reply: MaintenanceReply<RepackReport>) {
        self.repacks.push_back(reply);
    }

    /// Queues a copy into `destination`.
    pub(super) fn take_backup(
        &mut self,
        destination: PathBuf,
        reply: MaintenanceReply<BackupCopy>,
    ) {
        self.backups.push_back((destination, reply));
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

    /// Fails every checkpoint, repack and copy not yet sent with `error`.
    pub(super) fn fail_unsent(&mut self, error: impl Fn() -> MaintenanceError) {
        for checkpoint in self.checkpoints.drain(..) {
            send_answer(checkpoint.reply, Err(error()));
        }
        for reply in self.repacks.drain(..) {
            send_answer(reply, Err(error()));
        }
        for (_destination, reply) in self.backups.drain(..) {
            send_answer(reply, Err(error()));
        }
    }

    /// Sends the next queued work through `send`: a checkpoint, then a repack, then a copy while
    /// none runs. Answers whether it sent one.
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
        if let Some(reply) = self.repacks.pop_front() {
            let (thread_reply, answer) = oneshot::channel();
            send(ThreadRequest::Repack {
                reply: thread_reply,
            });
            self.repack = Some(InFlight { reply, answer });
            return true;
        }
        if self.backup.is_none()
            && let Some((destination, reply)) = self.backups.pop_front()
        {
            let (thread_reply, answer) = oneshot::channel();
            send(ThreadRequest::Backup {
                destination,
                reply: thread_reply,
            });
            self.backup = Some(InFlight { reply, answer });
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
            MaintenanceAnswered::Repack(answer) => {
                let flight = self
                    .maintenance
                    .repack
                    .take()
                    .expect("a repack is answered only while it is in flight");
                self.settle_maintenance(flight.reply, answer);
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
