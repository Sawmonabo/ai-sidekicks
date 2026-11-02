//! The daemon's one MCP client, on `rmcp`: the connections a session's tool servers are reached
//! over, by stdio or at an address, each speaking either MCP Tasks protocol (2026-07-28 or
//! 2025-11-25); the `/` list's prompts read over those same connections; and the questions a
//! server's task asks, on the session's questions card.

mod calls;
mod connection;
pub(crate) mod dispatch;
pub(crate) mod http;
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
use sidekicks_contracts::release_manifest::ReleaseVersion;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_provider::port::question::QuestionPort;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::outbound_http::outbound_client_builder;
use sidekicks_std::port_registration::PortRegistration;
use tokio_util::sync::CancellationToken;

use crate::client::connection::McpServerConnection;
use crate::client::connection::standing::{McpStandingConnection, McpStandingConnectionFeed};
use crate::client::prompts::PromptWatchers;
use crate::client::tasks::watches::TaskWatches;

/// The idle connections the HTTP client keeps per host: a server's standing event stream and one
/// request.
const IDLE_CONNECTIONS_PER_HOST: usize = 2;

/// A session's standing connection to one server, by session and server name, with its feed.
type StandingConnections =
    HashMap<(SessionId, String), (McpStandingConnection, McpStandingConnectionFeed)>;

/// Why the client could not be made.
#[derive(Debug, thiserror::Error)]
pub(crate) enum McpClientError {
    /// The HTTP client every server at an address is reached through could not be built.
    #[error("the HTTP client for the tool servers could not be built")]
    HttpClient(#[source] reqwest::Error),
}

/// The client: each session's standing connection to each of its tool servers, whose feed holds
/// the live connection; the mark set when the daemon stops; the listeners of the servers'
/// prompts, the tasks they follow, and the one HTTP client every server at an address is reached
/// through.
pub(crate) struct McpClient {
    standing: Mutex<StandingConnections>,
    /// Set once the client stops, before any connection closes, so an end the stop caused is
    /// read as the stop.
    stopping: CancellationToken,
    /// One connection pool for every HTTP tool server of the daemon: at most two idle sockets per
    /// host, each closed by reqwest's 90 s idle timeout.
    http: reqwest::Client,
    prompt_watchers: Arc<PromptWatchers>,
    task_watches: Arc<TaskWatches>,
    /// The daemon's release version, which each connection declares to its server.
    release_version: ReleaseVersion,
}

impl McpClient {
    /// A client asking its tasks' questions through `questions`, the drivers' questions card
    /// intake, and declaring `release_version`, the daemon's, to each server. Fails when its HTTP
    /// client cannot be built.
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
        release_version: ReleaseVersion,
    ) -> Result<Self, McpClientError> {
        // No `timeout` or `read_timeout`: either would cut a quiet event stream; each request
        // keeps its own bound.
        let http = outbound_client_builder(IDLE_CONNECTIONS_PER_HOST)
            .build()
            .map_err(McpClientError::HttpClient)?;
        Ok(Self {
            standing: Mutex::new(HashMap::new()),
            stopping: CancellationToken::new(),
            http,
            prompt_watchers: Arc::new(PromptWatchers::default()),
            task_watches: Arc::new(TaskWatches::new(questions)),
            release_version,
        })
    }

    /// The standing connection of `session_id` to `server_name`, made at its first use.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the tool route and the workflow tool step take the standing connection they \
                      dispatch a call over through it"
        )
    )]
    pub(crate) fn standing_connection(
        &self,
        session_id: SessionId,
        server_name: &McpServerName,
    ) -> McpStandingConnection {
        let mut standing = lock(&self.standing);
        let (connection, _) = self.standing_entry(&mut standing, session_id, server_name);
        connection.clone()
    }

    /// Publishes `connection` as the live connection of its session to its server, then closes
    /// the one it replaced, so a task's follow finds the new connection before the old one's
    /// close cuts it. The connection stays open until the session's connections close.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the session's tool-server connections, which the tool-server units open, \
                      are kept here"
        )
    )]
    pub(crate) async fn add_connection(
        &self,
        connection: McpServerConnection,
    ) -> Arc<McpServerConnection> {
        let connection = Arc::new(connection);
        let replaced = {
            let mut standing = lock(&self.standing);
            let (_, feed) = self.standing_entry(
                &mut standing,
                connection.scope.session_id,
                &connection.scope.server_name,
            );
            feed.publish(Some(Arc::clone(&connection)))
        };
        if let Some(replaced) = replaced {
            replaced.close().await;
        }
        connection
    }

    /// Closes every standing connection of `session_id` at once: marks each closed, waits for the
    /// work it tracks, then closes its live connection as [`McpServerConnection::close`] says.
    /// Never fails.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the session's tool-server connections, which the tool-server units open, \
                      close with the session through it"
        )
    )]
    pub(crate) async fn close_session(&self, session_id: SessionId) {
        let feeds: Vec<McpStandingConnectionFeed> = lock(&self.standing)
            .extract_if(|(session, _), _| *session == session_id)
            .map(|(_, (_, feed))| feed)
            .collect();
        close_feeds(feeds).await;
    }

    /// Stops the client: sets its stopping mark first, so an end the stop causes writes nothing,
    /// then closes every session's standing connections as [`Self::close_session`] does. Never
    /// fails.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the daemon's stop closes every tool-server connection through it"
        )
    )]
    pub(crate) async fn stop(&self) {
        self.stopping.cancel();
        let feeds: Vec<McpStandingConnectionFeed> = lock(&self.standing)
            .drain()
            .map(|(_, (_, feed))| feed)
            .collect();
        close_feeds(feeds).await;
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
            release_version: self.release_version.clone(),
        }
    }

    /// The live connections of `session_id`.
    fn session_connections(&self, session_id: SessionId) -> Vec<Arc<McpServerConnection>> {
        lock(&self.standing)
            .iter()
            .filter(|((session, _), _)| *session == session_id)
            .filter_map(|(_, (_, feed))| feed.current())
            .collect()
    }

    // The pair of `session_id` and `server_name` in `standing`, made with the client's stopping
    // mark when there is none.
    fn standing_entry<'a>(
        &self,
        standing: &'a mut StandingConnections,
        session_id: SessionId,
        server_name: &McpServerName,
    ) -> &'a (McpStandingConnection, McpStandingConnectionFeed) {
        standing
            .entry((session_id, server_name.as_str().to_owned()))
            .or_insert_with(|| McpStandingConnection::new(self.stopping.clone()))
    }
}

// Closes each feed at once, then each live connection the feeds took down, and waits for them all.
async fn close_feeds(feeds: Vec<McpStandingConnectionFeed>) {
    let connections = futures::future::join_all(feeds.iter().map(McpStandingConnectionFeed::close))
        .await
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    futures::future::join_all(connections.iter().map(|connection| connection.close())).await;
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::process::Stdio;
    use std::sync::Arc;
    use std::time::Duration;

    use serde_json::json;
    use sidekicks_contracts::mcp::server::McpServerName;
    use sidekicks_contracts::mcp::server::config::McpServerAddress;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use sidekicks_contracts::wire::text::FreeFormText;
    use sidekicks_platforms::{POSIX_SHELL, Spawner, shell_line_command, wrap_group_child_command};
    use tokio::time::timeout;

    use super::McpClient;
    use crate::client::connection::McpServerConnection;
    use crate::client::connection::standing::McpReplacement;
    use crate::client::stdio::StdioProcess;
    use crate::client::tasks::McpServerEndpoint;
    use crate::client::test_server::{
        Reply, method_not_found, start_test_server, test_client, v1_initialize_result,
    };

    // A new session and the server name `tracker`.
    fn session_and_name() -> (SessionId, McpServerName) {
        (
            SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id"),
            FreeFormText::new("tracker".to_owned()).expect("a short server name"),
        )
    }

    // A stdio connection of `client` to a server of no tools, in `session_id` to `name`, holding
    // `process` for its life.
    async fn open(
        client: &McpClient,
        session_id: SessionId,
        name: &McpServerName,
        process: Option<StdioProcess>,
    ) -> McpServerConnection {
        let (opened, _server) = start_test_server(
            client.connection_scope(session_id, name.clone()),
            Box::new(|method, _params| match method {
                "initialize" => Reply::Answer(json!({ "result": v1_initialize_result() })),
                "tools/list" => Reply::Answer(json!({ "result": { "tools": [] } })),
                _ => method_not_found(),
            }),
            process,
        )
        .await;
        opened.expect("the test server completes its start")
    }

    // A process that runs until it is signaled, so a connection holding it waits in its close.
    async fn lasting_process(
        client: &McpClient,
        session_id: SessionId,
        name: &McpServerName,
    ) -> StdioProcess {
        let spawner = Spawner::new(tokio::runtime::Handle::current()).expect("the spawner starts");
        let mut command = shell_line_command(Path::new(POSIX_SHELL), "sleep 60");
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let daemon_pid = std::process::id();
        let child = spawner
            .run(move || wrap_group_child_command(command, daemon_pid).spawn())
            .await
            .and_then(|spawned| spawned)
            .expect("the child starts");
        StdioProcess::supervise(
            child,
            None,
            &client.connection_scope(session_id, name.clone()),
        )
    }

    // Mutation: in `replacement`, leave out the `Arc::ptr_eq` check; the waiter then returns the
    // connection it waits to see replaced.
    #[tokio::test(start_paused = true)]
    async fn a_follower_waiting_on_a_reconnect_finds_the_new_connection() {
        let (client, _card) = test_client();
        let (session_id, name) = session_and_name();
        let old = client
            .add_connection(open(&client, session_id, &name, None).await)
            .await;
        let standing = client.standing_connection(session_id, &name);
        let after = Arc::clone(&old);
        let waiter = tokio::spawn(async move {
            standing
                .replacement(&after, &McpServerEndpoint::stdio())
                .await
        });
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert!(
            !waiter.is_finished(),
            "the old connection is no replacement"
        );

        let new = client
            .add_connection(open(&client, session_id, &name, None).await)
            .await;
        let McpReplacement::Replaced(found) = waiter.await.expect("the waiter ends") else {
            panic!("the waiter finds the replacement");
        };
        assert!(
            Arc::ptr_eq(&found, &new),
            "the waiter finds the new connection"
        );
    }

    // Mutation: in `replacement`, leave out the endpoint check; the waiter then takes the stdio
    // connection for the server at an address.
    #[tokio::test(start_paused = true)]
    async fn a_replacement_at_another_endpoint_waits_until_the_session_closes() {
        let (client, _card) = test_client();
        let (session_id, name) = session_and_name();
        let old = client
            .add_connection(open(&client, session_id, &name, None).await)
            .await;
        let standing = client.standing_connection(session_id, &name);
        let address = McpServerAddress::new("http://127.0.0.1:1/mcp").expect("a loopback address");
        let mut waiter = tokio::spawn(async move {
            standing
                .replacement(&old, &McpServerEndpoint::at_address(&address))
                .await
        });

        client
            .add_connection(open(&client, session_id, &name, None).await)
            .await;
        assert!(
            timeout(Duration::from_secs(10), &mut waiter).await.is_err(),
            "a stdio connection does not replace a server at an address"
        );

        client.close_session(session_id).await;
        assert!(matches!(
            waiter.await.expect("the waiter ends"),
            McpReplacement::SessionClosed
        ));
    }

    // Mutation: in `stop`, set the stopping mark after the sessions close; the waiter then reads
    // the session's close while the connection's close waits on its process.
    #[tokio::test(start_paused = true)]
    async fn a_waiter_during_the_stop_reads_the_stop() {
        let (client, _card) = test_client();
        let (session_id, name) = session_and_name();
        let process = lasting_process(&client, session_id, &name).await;
        let old = client
            .add_connection(open(&client, session_id, &name, Some(process)).await)
            .await;
        let standing = client.standing_connection(session_id, &name);
        let waiter = tokio::spawn(async move {
            standing
                .replacement(&old, &McpServerEndpoint::stdio())
                .await
        });
        tokio::time::sleep(Duration::from_secs(1)).await;

        client.stop().await;
        assert!(matches!(
            waiter.await.expect("the waiter ends"),
            McpReplacement::ClientStopping
        ));
    }

    // Mutation: in `replacement`, read a failed `changed` as `SessionClosed`; a dropped client
    // then reads as a closed session.
    #[tokio::test(start_paused = true)]
    async fn a_waiter_whose_client_is_dropped_reads_the_stop() {
        let (client, _card) = test_client();
        let (session_id, name) = session_and_name();
        let old = client
            .add_connection(open(&client, session_id, &name, None).await)
            .await;
        let standing = client.standing_connection(session_id, &name);
        let waiter = tokio::spawn(async move {
            standing
                .replacement(&old, &McpServerEndpoint::stdio())
                .await
        });
        tokio::time::sleep(Duration::from_secs(1)).await;

        drop(client);
        assert!(matches!(
            waiter.await.expect("the waiter ends"),
            McpReplacement::ClientStopping
        ));
    }
}
