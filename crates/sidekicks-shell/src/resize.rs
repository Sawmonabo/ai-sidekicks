//! One shell's sizes on their way to the terminal: one resize in flight at a time, and a backlog
//! collapses to the newest size, so the shell is told the size a drag stopped at rather than every
//! size it passed through.

use std::future::Future;
use std::mem;
use std::sync::{Arc, Mutex, MutexGuard};

use futures::future::BoxFuture;
use sidekicks_terminal::TerminalError;
use tokio::sync::oneshot;

/// A shell's size in character cells.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ShellSize {
    /// Columns.
    pub(crate) columns: u16,
    /// Rows.
    pub(crate) rows: u16,
}

/// Applies one size to the shell's terminal; the shell table passes `Terminals::resize` for its
/// shell, answering at once for a shell that has stopped running.
pub(crate) type ResizeTerminal =
    Box<dyn Fn(ShellSize) -> BoxFuture<'static, Result<(), TerminalError>> + Send + Sync>;

/// Why a size asked for did not reach the shell.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ShellResizeError {
    /// The resize that carried the size failed; every caller it carried shares its failure.
    #[error("the terminal could not be resized")]
    Failed(#[source] Arc<TerminalError>),
    /// The resize ended before it answered, as when the runtime stops.
    #[error("the terminal's resize ended before it answered")]
    Ended,
}

/// The sizes of one shell, applied through its resize one at a time, newest wins.
pub(crate) struct ShellResizeQueue {
    shared: Arc<ResizeShared>,
}

/// What the queue and its running resizes share.
struct ResizeShared {
    resize: ResizeTerminal,
    slot: Mutex<ResizeSlot>,
}

/// Whether a resize is in flight, and the newest size asked for since it began.
struct ResizeSlot {
    is_resizing: bool,
    pending: Option<PendingResize>,
}

/// The newest size asked for while a resize was in flight, and everyone waiting on it.
struct PendingResize {
    size: ShellSize,
    waiters: Vec<oneshot::Sender<Result<(), Arc<TerminalError>>>>,
}

impl ShellResizeQueue {
    /// A queue that applies each size through `resize`.
    pub(crate) fn new(resize: ResizeTerminal) -> Self {
        Self {
            shared: Arc::new(ResizeShared {
                resize,
                slot: Mutex::new(ResizeSlot {
                    is_resizing: false,
                    pending: None,
                }),
            }),
        }
    }

    /// Asks for `size` at the call, behind every size asked for before it. The future answers once
    /// the terminal has this size or a newer one asked for after it, and fails with the failure of
    /// the resize that would have carried it; the resize goes on when the caller stops waiting.
    pub(crate) fn request(
        &self,
        size: ShellSize,
    ) -> impl Future<Output = Result<(), ShellResizeError>> + Send + 'static {
        let (waiter, answer) = oneshot::channel();
        let should_start = {
            let mut slot = lock_slot(&self.shared.slot);
            match &mut slot.pending {
                Some(pending) => {
                    pending.size = size;
                    pending.waiters.push(waiter);
                }
                None => {
                    slot.pending = Some(PendingResize {
                        size,
                        waiters: vec![waiter],
                    });
                }
            }
            !mem::replace(&mut slot.is_resizing, true)
        };
        if should_start {
            tokio::spawn(resize_backlog(Arc::clone(&self.shared)));
        }
        async move {
            match answer.await {
                Ok(Ok(())) => Ok(()),
                Ok(Err(failure)) => Err(ShellResizeError::Failed(failure)),
                Err(_) => Err(ShellResizeError::Ended),
            }
        }
    }
}

/// Applies the newest size waiting, one at a time, until none waits, answering everyone each
/// resize carried.
async fn resize_backlog(shared: Arc<ResizeShared>) {
    loop {
        let next = {
            let mut slot = lock_slot(&shared.slot);
            let Some(next) = slot.pending.take() else {
                slot.is_resizing = false;
                return;
            };
            next
        };
        let outcome = (shared.resize)(next.size).await.map_err(Arc::new);
        for waiter in next.waiters {
            if waiter.send(outcome.clone()).is_err() {
                tracing::trace!("a resize's caller stopped waiting before it was applied");
            }
        }
    }
}

/// Locks a queue's slot.
fn lock_slot(slot: &Mutex<ResizeSlot>) -> MutexGuard<'_, ResizeSlot> {
    slot.lock()
        .expect("no panic holds a resize queue's lock, since a panic ends the daemon")
}
