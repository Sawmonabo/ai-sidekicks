//! A session's connection to one tool server across its Reconnects: the live connection, which
//! the client publishes each time it opens one, so an answer given after a Reconnect reaches the
//! new connection; the marks that say the session closed or the client is stopping; and the work
//! that uses it, which the session's close waits for.

use std::sync::Arc;

use tokio::sync::watch;
use tokio_util::sync::{CancellationToken, WaitForCancellationFuture};
use tokio_util::task::TaskTracker;
use tokio_util::task::task_tracker::TaskTrackerToken;

use crate::client::connection::McpServerConnection;
use crate::client::tasks::McpServerEndpoint;

/// A session's connection to one tool server, which reads the live connection at each use. Every
/// clone reads the same publications and marks.
#[derive(Clone)]
pub(crate) struct McpStandingConnection {
    live: watch::Receiver<Option<Arc<McpServerConnection>>>,
    /// Set when the session's connections close.
    closed: CancellationToken,
    /// The client's one mark, set when the daemon stops.
    stopping: CancellationToken,
    /// The feed's tracker, which the session's close waits on.
    tracker: TaskTracker,
}

/// Where the client publishes a standing connection's live connection, and closes it.
pub(crate) struct McpStandingConnectionFeed {
    live: watch::Sender<Option<Arc<McpServerConnection>>>,
    closed: CancellationToken,
    /// The work that uses the standing connection, which its close waits for.
    tracker: TaskTracker,
}

/// Why a standing connection has no live connection of the endpoint asked for.
#[derive(Debug, thiserror::Error)]
pub(crate) enum McpConnectionAbsence {
    /// No connection is published.
    #[error("the tool server is not connected in this session")]
    NotConfigured,
    /// The live connection reaches another endpoint.
    #[error("the tool server's address changed since the task was accepted")]
    Reconfigured,
}

/// How a wait for the connection that replaces another ends.
pub(crate) enum McpReplacement {
    /// A new live connection of the endpoint asked for.
    Replaced(Arc<McpServerConnection>),
    /// The session's connections closed.
    SessionClosed,
    /// The client is stopping, or is gone.
    ClientStopping,
}

impl McpStandingConnection {
    /// A standing connection with no live connection yet, reading the client's `stopping` mark,
    /// and the feed that publishes one.
    pub(crate) fn new(stopping: CancellationToken) -> (Self, McpStandingConnectionFeed) {
        let (sender, receiver) = watch::channel(None);
        let closed = CancellationToken::new();
        let tracker = TaskTracker::new();
        (
            Self {
                live: receiver,
                closed: closed.clone(),
                stopping,
                tracker: tracker.clone(),
            },
            McpStandingConnectionFeed {
                live: sender,
                closed,
                tracker,
            },
        )
    }

    /// A standing connection already closed, with no live connection and no feed, reading the
    /// client's `stopping` mark: what a session closed, or a stopping client, hands out.
    pub(crate) fn already_closed(stopping: CancellationToken) -> Self {
        let (standing, feed) = Self::new(stopping);
        feed.closed.cancel();
        feed.tracker.close();
        standing
    }

    /// Counts the caller's work as using the standing connection until the token drops, so the
    /// session's close waits for it before closing the live connection. Take it before reading
    /// the closed mark: a close that marks after the read waits for the token.
    pub(crate) fn track(&self) -> TaskTrackerToken {
        self.tracker.token()
    }

    /// Whether the session's connections closed.
    pub(crate) fn is_closed(&self) -> bool {
        self.closed.is_cancelled()
    }

    /// Resolves once the session's connections close.
    pub(crate) fn closed(&self) -> WaitForCancellationFuture<'_> {
        self.closed.cancelled()
    }

    /// Whether the client is stopping.
    pub(crate) fn is_stopping(&self) -> bool {
        self.stopping.is_cancelled()
    }

    /// The live connection, whatever its endpoint, if one is published.
    pub(crate) fn current(&self) -> Option<Arc<McpServerConnection>> {
        self.live.borrow().clone()
    }

    /// The live connection, when it reaches `endpoint`. Fails with `NotConfigured` when none is
    /// published and `Reconfigured` when the live one reaches another endpoint.
    pub(crate) fn live(
        &self,
        endpoint: &McpServerEndpoint,
    ) -> Result<Arc<McpServerConnection>, McpConnectionAbsence> {
        let live = self.live.borrow();
        let connection = live.as_ref().ok_or(McpConnectionAbsence::NotConfigured)?;
        if connection.endpoint.as_ref() != Some(endpoint) {
            return Err(McpConnectionAbsence::Reconfigured);
        }
        Ok(Arc::clone(connection))
    }

    /// Waits for a live connection other than `after`, any when `None`, that reaches `endpoint`,
    /// telling `show_absence` why none is at the start and at each publication: no connection is
    /// published, the one published reaches another endpoint, or `None` while it is `after`. Ends
    /// early when the client stops or is dropped, then when the session closes, the stop read
    /// first; never times out.
    pub(crate) async fn replacement(
        &self,
        after: Option<&Arc<McpServerConnection>>,
        endpoint: &McpServerEndpoint,
        show_absence: &impl Fn(Option<McpConnectionAbsence>),
    ) -> McpReplacement {
        let mut live = self.live.clone();
        loop {
            if self.stopping.is_cancelled() {
                return McpReplacement::ClientStopping;
            }
            if self.closed.is_cancelled() {
                return McpReplacement::SessionClosed;
            }
            let absence = match live.borrow_and_update().as_ref() {
                None => Some(McpConnectionAbsence::NotConfigured),
                Some(connection) if connection.endpoint.as_ref() != Some(endpoint) => {
                    Some(McpConnectionAbsence::Reconfigured)
                }
                Some(connection) if after.is_some_and(|after| Arc::ptr_eq(connection, after)) => {
                    None
                }
                Some(connection) => return McpReplacement::Replaced(Arc::clone(connection)),
            };
            show_absence(absence);
            tokio::select! {
                biased;
                () = self.stopping.cancelled() => return McpReplacement::ClientStopping,
                () = self.closed.cancelled() => return McpReplacement::SessionClosed,
                changed = live.changed() => {
                    // The feed is dropped only with its client.
                    if changed.is_err() {
                        return McpReplacement::ClientStopping;
                    }
                }
            }
        }
    }
}

impl McpStandingConnectionFeed {
    /// Publishes `connection` as the live connection, `None` for none, and returns the one it
    /// replaced, so the caller can close it.
    pub(crate) fn publish(
        &self,
        connection: Option<Arc<McpServerConnection>>,
    ) -> Option<Arc<McpServerConnection>> {
        self.live.send_replace(connection)
    }

    /// The live connection, if one is published.
    pub(crate) fn current(&self) -> Option<Arc<McpServerConnection>> {
        self.live.borrow().clone()
    }

    /// Marks the standing connection closed, waits for the work it tracks to end, then takes the
    /// live connection down, so no clone keeps it, and returns it for the caller to close.
    pub(crate) async fn close(&self) -> Option<Arc<McpServerConnection>> {
        self.closed.cancel();
        self.tracker.close();
        self.tracker.wait().await;
        self.publish(None)
    }
}
