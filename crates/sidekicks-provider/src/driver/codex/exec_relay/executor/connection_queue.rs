//! One connection's queue toward its socket. A line goes straight onto the queue its socket's
//! writer drains; once that queue is full, lines wait in order in a spill bounded by bytes, which a
//! task of the connection's own hands on as the writer takes them. So a burst of output keeps the
//! connection, while one whose writer takes nothing for the stall bound, or whose spill passes its
//! bytes, is let go; the executor's reader never waits on either.

use std::collections::VecDeque;
use std::sync::{Arc, Weak};
use std::time::Duration;

use sidekicks_std::mutex_lock::lock;
use tokio::sync::mpsc;
use tokio::sync::mpsc::error::TrySendError;
use tokio_util::sync::CancellationToken;

use super::{CodexExecutor, RelayConnectionId};

/// How long a connection's writer may take nothing from its full queue before it is let go.
pub(in crate::driver::codex::exec_relay) const QUEUE_STALL_BOUND: Duration =
    Duration::from_secs(10);

/// The most bytes that wait in a connection's spill; a line that would pass it lets the connection
/// go, unless the spill is empty, so one long line alone never does.
const SPILL_MAX_BYTES: usize = 16 << 20;

/// Where a line handed to a connection went.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum HandOn {
    /// Onto the queue its writer drains.
    Queued,
    /// Into the spill; `is_drain_needed` when no task hands the spill on yet.
    Spilled { is_drain_needed: bool },
    /// Past the spill's bound, so the connection goes.
    Overflowed,
    /// Nowhere: the connection's writer is gone.
    Closed,
}

/// One connection's queue toward its socket, which its own task drains, the token that tells its
/// socket to close once it fell behind its bound, and the environment whose token admitted it.
pub(super) struct ConnectionQueue {
    lines: mpsc::Sender<String>,
    closed: CancellationToken,
    environment: Arc<str>,
    spill: VecDeque<String>,
    spill_bytes: usize,
    // Whether a task hands the spill on, holding a line of it the while.
    is_draining: bool,
}

impl ConnectionQueue {
    /// The queue onto `lines`, closing through `closed`, of a connection `environment` admitted.
    pub(super) fn new(
        lines: mpsc::Sender<String>,
        closed: CancellationToken,
        environment: Arc<str>,
    ) -> Self {
        Self {
            lines,
            closed,
            environment,
            spill: VecDeque::new(),
            spill_bytes: 0,
            is_draining: false,
        }
    }

    /// The environment whose token admitted the connection.
    pub(super) fn environment(&self) -> &Arc<str> {
        &self.environment
    }

    /// Hands `line` on behind every line before it, without waiting.
    pub(super) fn hand_on(&mut self, line: String) -> HandOn {
        let line = if self.is_draining {
            line
        } else {
            match self.lines.try_send(line) {
                Ok(()) => return HandOn::Queued,
                Err(TrySendError::Closed(_line)) => return HandOn::Closed,
                Err(TrySendError::Full(line)) => line,
            }
        };
        if !self.spill.is_empty() && self.spill_bytes + line.len() > SPILL_MAX_BYTES {
            return HandOn::Overflowed;
        }
        self.spill_bytes += line.len();
        self.spill.push_back(line);
        let is_drain_needed = !self.is_draining;
        self.is_draining = true;
        HandOn::Spilled { is_drain_needed }
    }

    /// The spill's next line and the queue to send it on; `None` once the spill is empty, which
    /// ends its draining.
    pub(super) fn next_spilled(&mut self) -> Option<(String, mpsc::Sender<String>)> {
        let Some(line) = self.spill.pop_front() else {
            self.is_draining = false;
            return None;
        };
        self.spill_bytes -= line.len();
        Some((line, self.lines.clone()))
    }

    /// Tells the connection's socket to close, since it fell behind its bound.
    pub(super) fn close(&self) {
        self.closed.cancel();
    }
}

impl CodexExecutor {
    /// Hands `line` to the connection `connection` alone without waiting, answering whether it
    /// was handed on: dropped once that connection is gone. A line that meets a full queue waits
    /// in order in the connection's spill, and a connection whose writer takes nothing for
    /// [`QUEUE_STALL_BOUND`], or whose spill passes its bytes, is let go as a closed socket is, so
    /// a burst keeps the connection and one that stops reading never holds up another's lines.
    pub(in crate::driver::codex::exec_relay) fn answer_connection(
        &self,
        connection: RelayConnectionId,
        line: String,
    ) -> bool {
        let mut clients = lock(&self.clients);
        let Some(queue) = clients.get_mut(&connection) else {
            tracing::debug!("the Codex relay's client went away before its line was handed on");
            return false;
        };
        match queue.hand_on(line) {
            HandOn::Queued
            | HandOn::Spilled {
                is_drain_needed: false,
            } => true,
            HandOn::Spilled {
                is_drain_needed: true,
            } => {
                tokio::spawn(drain_spill(self.me.clone(), connection));
                true
            }
            HandOn::Overflowed => {
                tracing::warn!("a Codex relay client's spill passed its bytes, so it is let go");
                if let Some(queue) = clients.remove(&connection) {
                    queue.close();
                }
                false
            }
            HandOn::Closed => {
                tracing::debug!("the Codex relay's client went away before its line reached it");
                false
            }
        }
    }

    // Lets the connection `connection` go, its writer having taken nothing for the stall bound.
    fn let_stalled_connection_go(&self, connection: RelayConnectionId) {
        tracing::warn!("a Codex relay client took nothing from its full queue, so it is let go");
        if let Some(queue) = lock(&self.clients).remove(&connection) {
            queue.close();
        }
    }
}

// Hands the spill of the connection `connection` on to its queue in order until it is empty, the
// connection or the executor goes, or its writer takes nothing for the stall bound, which lets
// the connection go.
async fn drain_spill(executor: Weak<CodexExecutor>, connection: RelayConnectionId) {
    loop {
        let Some(next) = executor.upgrade().and_then(|executor| {
            lock(&executor.clients)
                .get_mut(&connection)
                .and_then(ConnectionQueue::next_spilled)
        }) else {
            return;
        };
        let (line, queue) = next;
        match tokio::time::timeout(QUEUE_STALL_BOUND, queue.send(line)).await {
            Ok(Ok(())) => {}
            Ok(Err(_closed)) => return,
            Err(_stalled) => {
                if let Some(executor) = executor.upgrade() {
                    executor.let_stalled_connection_go(connection);
                }
                return;
            }
        }
    }
}
