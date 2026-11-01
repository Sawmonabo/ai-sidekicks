//! The daemon's record of the provider processes it starts as its own children, which the next
//! start's sweep ends when a daemon dies without reaping them, and the start of a child recorded
//! in it: the intent made durable before the start with the nonce in the child's environment, the
//! child once it runs, and its end once its reap sees it. A lasting service, which outlives the
//! daemon by design, keeps its own record and never starts through it.

use std::error::Error;
use std::io;
use std::sync::Arc;

use futures::future::BoxFuture;
use process_wrap::tokio::ChildWrapper;
use sidekicks_platforms::{Spawner, wrap_leading_child_command};
use tokio::process::Command;

/// The environment variable that carries a recorded child's nonce, by which the sweep recognizes
/// the child and every process it started.
pub const SPAWN_NONCE_ENVIRONMENT_NAME: &str = "SIDEKICKS_SPAWN_NONCE";

/// The daemon's durable record of its own children. The daemon's start opens it, sweeping what a
/// former run left, before any driver is built, and hands it to every driver at build.
pub trait DaemonChildRecords: Send + Sync {
    /// Durably records that a child is about to start, and answers the nonce its environment
    /// carries under [`SPAWN_NONCE_ENVIRONMENT_NAME`]. Fails when the nonce cannot be drawn or the
    /// record written, and then the child must not start.
    fn prepare_spawn(&self) -> BoxFuture<'_, Result<String, Box<dyn Error + Send + Sync>>>;

    /// Records the started child `process_id` under `nonce`. Fails when it cannot be recorded, and
    /// the caller then ends the child, so no child runs unrecorded.
    fn complete_spawn<'call>(
        &'call self,
        nonce: &'call str,
        process_id: u32,
    ) -> BoxFuture<'call, Result<(), Box<dyn Error + Send + Sync>>>;

    /// Forgets the child recorded under `nonce` once it has ended. A failed write is logged, and
    /// the next start's sweep finds the child gone.
    fn retire<'call>(&'call self, nonce: &'call str) -> BoxFuture<'call, ()>;
}

/// A child of the daemon started through [`spawn_recorded_child`]: the child, leading a process
/// group of its own, and its entry in the records, which its reap retires.
pub(crate) struct RecordedChild {
    /// The child.
    pub(crate) child: Box<dyn ChildWrapper>,
    /// Its entry in the daemon's child records.
    pub(crate) record: ChildRecord,
}

/// One child's entry in the daemon's child records.
pub(crate) struct ChildRecord {
    records: Arc<dyn DaemonChildRecords>,
    nonce: String,
}

impl ChildRecord {
    /// Forgets the child, once its reap saw it end.
    pub(crate) async fn retire(self) {
        self.records.retire(&self.nonce).await;
    }
}

/// Starts `command` on `spawner`'s thread as a child of the daemon leading a process group of its
/// own, so the sweep's kill and its end of survivors reach what the child started, while the
/// daemon's own stop reaches the child alone; recorded in `records` across the start. Fails with
/// the record's error, the spawn's or the spawner's; a child that could not be recorded is killed
/// and reaped first.
pub(crate) async fn spawn_recorded_child(
    spawner: &Spawner,
    records: &Arc<dyn DaemonChildRecords>,
    mut command: Command,
) -> io::Result<RecordedChild> {
    let nonce = records.prepare_spawn().await.map_err(io::Error::other)?;
    let record = ChildRecord {
        records: Arc::clone(records),
        nonce,
    };
    // Set last, so no variable the command already carries replaces it.
    command.env(SPAWN_NONCE_ENVIRONMENT_NAME, &record.nonce);
    let daemon_pid = std::process::id();
    let spawned = spawner
        .run(move || wrap_leading_child_command(command, daemon_pid).spawn())
        .await
        .and_then(|spawned| spawned);
    let mut child = match spawned {
        Ok(child) => child,
        Err(error) => {
            record.retire().await;
            return Err(error);
        }
    };
    let recorded = match child.id() {
        Some(process_id) => records
            .complete_spawn(&record.nonce, process_id)
            .await
            .map_err(io::Error::other),
        None => Err(io::Error::other("the child started with no process id")),
    };
    match recorded {
        Ok(()) => Ok(RecordedChild { child, record }),
        Err(error) => {
            end_unrecorded_child(&mut *child, record).await;
            Err(error)
        }
    }
}

// Kills a child that could not be recorded, reaps it and forgets its intent; one whose kill or
// reap fails keeps its intent for the next start's sweep.
async fn end_unrecorded_child(child: &mut dyn ChildWrapper, record: ChildRecord) {
    let ended = match child.start_kill() {
        Ok(()) => child.wait().await.map(drop),
        Err(error) => Err(error),
    };
    match ended {
        Ok(()) => record.retire().await,
        Err(error) => tracing::warn!(
            error = &error as &(dyn Error + 'static),
            "a child that could not be recorded could not be killed and reaped, so its intent \
             stays for the next start's sweep"
        ),
    }
}

/// Child records that record nothing, for the tests whose drivers start no child a sweep follows.
#[cfg(any(test, feature = "test-support"))]
pub struct UnrecordedChildren;

#[cfg(any(test, feature = "test-support"))]
impl DaemonChildRecords for UnrecordedChildren {
    fn prepare_spawn(&self) -> BoxFuture<'_, Result<String, Box<dyn Error + Send + Sync>>> {
        Box::pin(async { Ok("unrecorded".to_owned()) })
    }

    fn complete_spawn<'call>(
        &'call self,
        _nonce: &'call str,
        _process_id: u32,
    ) -> BoxFuture<'call, Result<(), Box<dyn Error + Send + Sync>>> {
        Box::pin(async { Ok(()) })
    }

    fn retire<'call>(&'call self, _nonce: &'call str) -> BoxFuture<'call, ()> {
        Box::pin(async {})
    }
}
