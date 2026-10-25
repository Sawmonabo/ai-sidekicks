//! The daemon's one MCP client, on `rmcp`: the connections a session's tool servers are reached
//! over, by stdio or at an address, each speaking either MCP Tasks protocol (2026-07-28 or
//! 2025-11-25); the `/` list's prompts read over those same connections; and the questions a
//! server's task asks, on the session's questions card.

mod connection;
mod http;
mod poll;
mod prompts;
mod raw_copy;
pub(crate) mod tasks;
#[cfg(test)]
mod test_server;

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use sidekicks_contracts::session::id::SessionId;

use crate::mcp::client::connection::McpServerConnection;
use crate::mcp::client::prompts::PromptWatchers;
use crate::mcp::client::tasks::TaskWatches;
use crate::provider::port::question::QuestionPort;
use crate::provider::port::registration::PortRegistration;

/// The client: each session's open tool-server connections, the listeners of their prompts and
/// the tasks they follow.
pub(crate) struct McpClient {
    connections: Mutex<HashMap<SessionId, Vec<Arc<McpServerConnection>>>>,
    prompt_watchers: Arc<PromptWatchers>,
    task_watches: Arc<TaskWatches>,
}

impl McpClient {
    /// A client asking its tasks' questions through `questions`, the drivers' questions card
    /// intake.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the daemon's start builds the one client the session's tool-server \
                      connections, which the tool-server units open, share"
        )
    )]
    pub(crate) fn new(questions: Arc<PortRegistration<Arc<dyn QuestionPort>>>) -> Self {
        Self {
            connections: Mutex::new(HashMap::new()),
            prompt_watchers: Arc::new(PromptWatchers::default()),
            task_watches: Arc::new(TaskWatches::new(questions)),
        }
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
        self.lock()
            .entry(connection.scope.session_id)
            .or_default()
            .push(Arc::clone(&connection));
        connection
    }

    /// Closes every connection of `session_id`; a stdio server's process ends with its last
    /// holder.
    #[expect(
        dead_code,
        reason = "the session's tool-server connections, which the tool-server units open, close \
                  with the session through it"
    )]
    pub(crate) fn close_session(&self, session_id: SessionId) {
        self.lock().remove(&session_id);
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
        server_name: sidekicks_contracts::mcp::server::McpServerName,
    ) -> connection::McpConnectionScope {
        connection::McpConnectionScope {
            session_id,
            server_name,
            prompt_watchers: Arc::clone(&self.prompt_watchers),
            task_watches: Arc::clone(&self.task_watches),
        }
    }

    /// The open connections of `session_id`.
    fn session_connections(&self, session_id: SessionId) -> Vec<Arc<McpServerConnection>> {
        self.lock().get(&session_id).cloned().unwrap_or_default()
    }

    // No holder awaits or panics while it changes the map, so a poisoned lock still guards a whole
    // map.
    fn lock(&self) -> MutexGuard<'_, HashMap<SessionId, Vec<Arc<McpServerConnection>>>> {
        self.connections
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }
}
