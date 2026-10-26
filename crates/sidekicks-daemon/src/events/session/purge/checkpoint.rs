//! The write-ahead log's truncation after a purge. The purge's deletes leave the deleted pages'
//! earlier images in the log until a checkpoint moves every frame and truncates it, and the
//! writer's truncating checkpoint answers busy at once while a reader holds an older snapshot, so
//! the truncation is tried again after a doubling wait until it succeeds. One loop runs at a time:
//! a request while it runs has it truncate once more after.

use std::error::Error;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::database::checkpoint::CheckpointMode;
use crate::database::writer::{DatabaseWriter, MaintenanceError};
use crate::mutex_lock::lock;

// The first wait after a busy try, doubled after each until the last.
const FIRST_RETRY_WAIT: Duration = Duration::from_millis(50);
const LAST_RETRY_WAIT: Duration = Duration::from_secs(5);

/// Truncates the write-ahead log, retried until it succeeds, one loop at a time.
pub(crate) struct WriteAheadLogTruncation {
    writer: Arc<DatabaseWriter>,
    state: Arc<Mutex<TruncationState>>,
    tasks: TaskTracker,
    stop: CancellationToken,
}

#[derive(Default)]
struct TruncationState {
    is_running: bool,
    is_requested_again: bool,
}

impl WriteAheadLogTruncation {
    /// The truncation of `writer`'s log.
    pub(crate) fn new(writer: Arc<DatabaseWriter>) -> Self {
        Self {
            writer,
            state: Arc::new(Mutex::new(TruncationState::default())),
            tasks: TaskTracker::new(),
            stop: CancellationToken::new(),
        }
    }

    /// Truncates the log, tried again until it succeeds: after a purge, and at the daemon's start
    /// once its check of the file has ended. A request while a truncation runs has it truncate once
    /// more after. Answers whether a truncation runs, false once the stop has ended them.
    pub(crate) fn request(&self) -> bool {
        if self.stop.is_cancelled() {
            return false;
        }
        let mut state = lock(&self.state);
        if state.is_running {
            state.is_requested_again = true;
            return true;
        }
        state.is_running = true;
        drop(state);
        self.tasks.spawn(truncate_until_done(
            Arc::clone(&self.writer),
            Arc::clone(&self.state),
            self.stop.clone(),
        ));
        true
    }

    /// Ends the truncation for the daemon's stop and waits for its task; a log left untruncated is
    /// truncated by the next start's request.
    pub(crate) async fn stop(&self) {
        self.stop.cancel();
        self.tasks.close();
        self.tasks.wait().await;
    }
}

#[cfg(test)]
impl WriteAheadLogTruncation {
    /// Waits until no truncation runs.
    pub(crate) async fn settled(&self) {
        self.tasks.close();
        self.tasks.wait().await;
        self.tasks.reopen();
    }
}

// Truncates until a try is not busy, then again while a request came meanwhile. A writer ended or
// closed ends the loop, since no checkpoint can run on it again.
async fn truncate_until_done(
    writer: Arc<DatabaseWriter>,
    state: Arc<Mutex<TruncationState>>,
    stop: CancellationToken,
) {
    loop {
        if !truncate_once(&writer, &stop).await {
            *lock(&state) = TruncationState::default();
            return;
        }
        let mut state = lock(&state);
        if !state.is_requested_again {
            state.is_running = false;
            return;
        }
        state.is_requested_again = false;
    }
}

// One truncation, tried again until it succeeds; false when it ended without succeeding.
async fn truncate_once(writer: &DatabaseWriter, stop: &CancellationToken) -> bool {
    let mut wait = FIRST_RETRY_WAIT;
    let mut busy_tries = 0_u32;
    loop {
        match writer.checkpoint(CheckpointMode::Truncate).await {
            Ok(result) if !result.is_busy => return true,
            Ok(result) => {
                busy_tries += 1;
                // The first busy answer is the usual reader finishing; later ones are worth a line.
                if busy_tries > 1 {
                    tracing::info!(
                        busy_tries,
                        log_frames = result.log_frames,
                        "a reader keeps the write-ahead log busy; its truncation is tried again"
                    );
                }
            }
            Err(error @ (MaintenanceError::Failed(_) | MaintenanceError::Held)) => {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    "the write-ahead log's truncation failed; it is tried again"
                );
            }
            Err(error @ (MaintenanceError::Ended(_) | MaintenanceError::Closed)) => {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    "the write-ahead log was left untruncated; the next start truncates it"
                );
                return false;
            }
        }
        tokio::select! {
            () = tokio::time::sleep(wait) => {}
            () = stop.cancelled() => return false,
        }
        wait = (wait * 2).min(LAST_RETRY_WAIT);
    }
}
