//! A session's connection to one tool server across its Reconnects: the live connection, which
//! the client publishes each time it opens one, so an answer given after a Reconnect reaches the
//! new connection.

use std::sync::Arc;

use tokio::sync::watch;

use crate::client::connection::McpServerConnection;
use crate::client::tasks::McpServerEndpoint;

/// A session's connection to one tool server, which reads the live connection at each use. Every
/// clone reads the same publications.
#[derive(Clone)]
pub(crate) struct McpStandingConnection {
    live: watch::Receiver<Option<Arc<McpServerConnection>>>,
}

/// Where the client publishes a standing connection's live connection.
pub(crate) struct McpStandingConnectionFeed {
    live: watch::Sender<Option<Arc<McpServerConnection>>>,
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

impl McpStandingConnection {
    /// A standing connection with no live connection yet, and the feed that publishes one.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the client publishes each session's live connection to a tool server \
                      through it"
        )
    )]
    pub(crate) fn new() -> (Self, McpStandingConnectionFeed) {
        let (sender, receiver) = watch::channel(None);
        (
            Self { live: receiver },
            McpStandingConnectionFeed { live: sender },
        )
    }

    /// The live connection, when it reaches `endpoint`. Fails with `NotConfigured` when none is
    /// published and `Reconfigured` when the live one reaches another endpoint.
    pub(crate) fn live(
        &self,
        endpoint: &McpServerEndpoint,
    ) -> Result<Arc<McpServerConnection>, McpConnectionAbsence> {
        let live = self.live.borrow();
        let connection = live.as_ref().ok_or(McpConnectionAbsence::NotConfigured)?;
        if connection.endpoint != *endpoint {
            return Err(McpConnectionAbsence::Reconfigured);
        }
        Ok(Arc::clone(connection))
    }
}

impl McpStandingConnectionFeed {
    /// Publishes `connection` as the live connection, `None` for none, and returns the one it
    /// replaced, so the caller can close it.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the client publishes each session's live connection to a tool server \
                      through it"
        )
    )]
    pub(crate) fn publish(
        &self,
        connection: Option<Arc<McpServerConnection>>,
    ) -> Option<Arc<McpServerConnection>> {
        self.live.send_replace(connection)
    }
}
