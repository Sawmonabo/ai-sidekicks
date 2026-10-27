//! The daemon's one MCP client, on `rmcp`: the connections a session's tool servers are reached
//! over, by stdio or at an address, each speaking either MCP Tasks protocol (2026-07-28 or
//! 2025-11-25); the `/` list's prompts read over those same connections; and the questions a
//! server's task asks, on the session's questions card.

mod calls;
mod connection;
mod http;
mod idle_window;
mod poll;
mod prompts;
mod raw_copy;
mod requests;
mod stdio;
pub(crate) mod tasks;
#[cfg(test)]
mod test_server;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use sidekicks_contracts::mcp::server::McpServerName;
use sidekicks_contracts::session::id::SessionId;

use crate::client::connection::McpServerConnection;
use crate::client::prompts::PromptWatchers;
use crate::client::tasks::TaskWatches;
use sidekicks_provider::port::question::QuestionPort;
use sidekicks_provider::port::registration::PortRegistration;
use sidekicks_std::mutex_lock::lock;

/// The idle connections the HTTP client keeps per host: a server's standing event stream and one
/// request.
const IDLE_CONNECTIONS_PER_HOST: usize = 2;

/// Why the client could not be made.
#[derive(Debug, thiserror::Error)]
pub(crate) enum McpClientError {
    /// The HTTP client every server at an address is reached through could not be built.
    #[error("the HTTP client for the tool servers could not be built")]
    HttpClient(#[source] reqwest::Error),
}

/// The client: each session's open tool-server connections, the listeners of their prompts, the
/// tasks they follow, and the one HTTP client every server at an address is reached through.
pub(crate) struct McpClient {
    connections: Mutex<HashMap<SessionId, Vec<Arc<McpServerConnection>>>>,
    /// One connection pool for every HTTP tool server of the daemon: at most two idle sockets per
    /// host, each closed by reqwest's 90 s idle timeout.
    http: reqwest::Client,
    prompt_watchers: Arc<PromptWatchers>,
    task_watches: Arc<TaskWatches>,
}

impl McpClient {
    /// A client asking its tasks' questions through `questions`, the drivers' questions card
    /// intake. Fails when its HTTP client cannot be built.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the daemon's start builds the one client the session's tool-server \
                      connections, which the tool-server units open, share"
        )
    )]
    pub(crate) fn new(
        questions: Arc<PortRegistration<Arc<dyn QuestionPort>>>,
    ) -> Result<Self, McpClientError> {
        // No `timeout` or `read_timeout`: either would cut a quiet event stream; each request
        // keeps its own bound.
        let http = reqwest::Client::builder()
            .pool_max_idle_per_host(IDLE_CONNECTIONS_PER_HOST)
            .build()
            .map_err(McpClientError::HttpClient)?;
        Ok(Self {
            connections: Mutex::new(HashMap::new()),
            http,
            prompt_watchers: Arc::new(PromptWatchers::default()),
            task_watches: Arc::new(TaskWatches::new(questions)),
        })
    }

    /// Keeps `connection` open for its session until the session's connections close.
    #[expect(
        dead_code,
        reason = "the session's tool-server connections, which the tool-server units open, are \
                  kept here"
    )]
    pub(crate) fn add_connection(
        &self,
        connection: McpServerConnection,
    ) -> Arc<McpServerConnection> {
        let connection = Arc::new(connection);
        lock(&self.connections)
            .entry(connection.scope.session_id)
            .or_default()
            .push(Arc::clone(&connection));
        connection
    }

    /// Closes every connection of `session_id` at once, each as [`McpServerConnection::close`]
    /// says, and waits for them all. Never fails.
    #[expect(
        dead_code,
        reason = "the session's tool-server connections, which the tool-server units open, close \
                  with the session through it"
    )]
    pub(crate) async fn close_session(&self, session_id: SessionId) {
        let connections = lock(&self.connections)
            .remove(&session_id)
            .unwrap_or_default();
        futures::future::join_all(connections.iter().map(|connection| connection.close())).await;
    }

    /// The scope a new connection of `session_id` to `server_name` is opened in.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the session's tool-server connections, which the tool-server units open, \
                      are opened in it"
        )
    )]
    pub(crate) fn connection_scope(
        &self,
        session_id: SessionId,
        server_name: McpServerName,
    ) -> connection::McpConnectionScope {
        connection::McpConnectionScope {
            session_id,
            server_name,
            http: self.http.clone(),
            prompt_watchers: Arc::clone(&self.prompt_watchers),
            task_watches: Arc::clone(&self.task_watches),
        }
    }

    /// The open connections of `session_id`.
    fn session_connections(&self, session_id: SessionId) -> Vec<Arc<McpServerConnection>> {
        lock(&self.connections)
            .get(&session_id)
            .cloned()
            .unwrap_or_default()
    }
}
