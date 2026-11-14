//! The daemon's one MCP client, on `rmcp`: the connections a session's tool servers are reached
//! over, by stdio or at an address, each speaking either MCP Tasks protocol (2026-07-28 or
//! 2025-11-25); the `/` list's prompts read over those same connections; the resources a server
//! offers to attach, read over a connection made for the read; and the questions a server's task
//! asks, on the session's questions card.

mod calls;
mod connection;
pub mod dispatch;
pub(crate) mod http;
mod idle_window;
mod poll;
mod prompts;
mod raw_copy;
mod requests;
pub mod resources;
mod stdio;
pub(crate) mod tasks;
#[cfg(test)]
mod test_server;

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use sidekicks_contracts::mcp::server::McpServerName;
use sidekicks_contracts::release_manifest::ReleaseVersion;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_provider::port::question::QuestionPort;
use sidekicks_std::keyed_lock::KeyedLock;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::outbound_http::outbound_client_builder;
use sidekicks_std::port_registration::PortRegistration;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;
#[cfg(any(test, feature = "test-support"))]
use tokio_util::task::task_tracker::TaskTrackerToken;

use crate::binding::store::McpBindingKey;
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

/// The standing connections of the sessions still open, and the sessions closed, of which none
/// opens again, so nothing made for one after its close is left open.
#[derive(Default)]
struct StandingState {
    connections: StandingConnections,
    /// Each session closed since the daemon started.
    closed_sessions: HashSet<SessionId>,
}

/// Why the client could not be made.
#[derive(Debug, thiserror::Error)]
pub enum McpClientError {
    /// The HTTP client every server at an address is reached through could not be built.
    #[error("the HTTP client for the tool servers could not be built")]
    HttpClient(#[source] reqwest::Error),
}

/// The client: each session's standing connection to each of its tool servers, whose feed holds
/// the live connection; the mark set when the daemon stops; the listeners of the servers'
/// prompts, the tasks they follow, and the one HTTP client every server at an address is reached
/// through.
pub struct McpClient {
    standing: Mutex<StandingState>,
    /// Set once the client stops, before any connection closes, so an end the stop caused is
    /// read as the stop.
    stopping: CancellationToken,
    /// The session closes under way and the restart sweep's resumes, which the stop waits for.
    closings: TaskTracker,
    /// One connection pool for every HTTP tool server of the daemon: at most two idle sockets per
    /// host, each closed by reqwest's 90 s idle timeout.
    http: reqwest::Client,
    prompt_watchers: Arc<PromptWatchers>,
    task_watches: Arc<TaskWatches>,
    /// The daemon's release version, which each connection declares to its server.
    release_version: ReleaseVersion,
    /// The program servers whose copy a resource read runs now, so each runs one copy at a time.
    resource_copies: KeyedLock<McpBindingKey>,
}

impl McpClient {
    /// A client asking its tasks' questions through `questions`, the drivers' questions card
    /// intake, and declaring `release_version`, the daemon's, to each server. Fails when its HTTP
    /// client cannot be built.
    pub fn new(
        questions: Arc<PortRegistration<Arc<dyn QuestionPort>>>,
        release_version: ReleaseVersion,
    ) -> Result<Self, McpClientError> {
        // No `timeout` or `read_timeout`: either would cut a quiet event stream; each request
        // keeps its own bound.
        let http = outbound_client_builder(IDLE_CONNECTIONS_PER_HOST)
            .build()
            .map_err(McpClientError::HttpClient)?;
        Ok(Self {
            standing: Mutex::new(StandingState::default()),
            stopping: CancellationToken::new(),
            closings: TaskTracker::new(),
            http,
            prompt_watchers: Arc::new(PromptWatchers::default()),
            task_watches: Arc::new(TaskWatches::new(questions)),
            release_version,
            resource_copies: KeyedLock::new(),
        })
    }

    /// The standing connection of `session_id` to `server_name`, made at its first use; one
    /// already closed, kept nowhere, once the session closed or the client stopped.
    pub(crate) fn standing_connection(
        &self,
        session_id: SessionId,
        server_name: &McpServerName,
    ) -> McpStandingConnection {
        let mut standing = lock(&self.standing);
        match self.standing_entry(&mut standing, session_id, server_name) {
            Some((connection, _)) => connection.clone(),
            None => McpStandingConnection::already_closed(self.stopping.clone()),
        }
    }

    /// Publishes `connection` as the live connection of its session to its server, then closes
    /// the one it replaced, so a task's follow finds the new connection before the old one's
    /// close cuts it. The connection stays open until the session's connections close; one added
    /// after its session closed, or while the client stops, is closed at once.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the session's tool-server connection opener keeps its connections here"
        )
    )]
    pub(crate) async fn add_connection(
        &self,
        connection: McpServerConnection,
    ) -> Arc<McpServerConnection> {
        let connection = Arc::new(connection);
        let published = {
            let mut standing = lock(&self.standing);
            self.standing_entry(
                &mut standing,
                connection.scope.session_id,
                &connection.scope.server_name,
            )
            .map(|(_, feed)| feed.publish(Some(Arc::clone(&connection))))
        };
        match published {
            Some(Some(replaced)) => replaced.close().await,
            Some(None) => {}
            // Nothing would ever close it.
            None => connection.close().await,
        }
        connection
    }

    /// Starts closing every standing connection of `session_id`, as [`Self::close_session`]
    /// does, and returns at once; the client's stop waits for the close.
    pub fn start_session_close(self: &Arc<Self>, session_id: SessionId) {
        let client = Arc::clone(self);
        self.closings
            .spawn(async move { client.close_session(session_id).await });
    }

    /// Closes every standing connection of `session_id` at once: marks each closed, waits for the
    /// work it tracks, then closes its live connection as [`McpServerConnection::close`] says.
    /// Never fails.
    pub(crate) async fn close_session(&self, session_id: SessionId) {
        let feeds: Vec<McpStandingConnectionFeed> = {
            let mut standing = lock(&self.standing);
            standing.closed_sessions.insert(session_id);
            standing
                .connections
                .extract_if(|(session, _), _| *session == session_id)
                .map(|(_, (_, feed))| feed)
                .collect()
        };
        close_feeds(feeds).await;
    }

    /// Stops the client: sets its stopping mark first, so an end the stop causes writes nothing,
    /// then closes every session's standing connections as [`Self::close_session`] does and
    /// waits for every session close under way. Never fails.
    pub async fn stop(&self) {
        self.stopping.cancel();
        let feeds: Vec<McpStandingConnectionFeed> = lock(&self.standing)
            .connections
            .drain()
            .map(|(_, (_, feed))| feed)
            .collect();
        self.closings.close();
        tokio::join!(close_feeds(feeds), self.closings.wait());
    }

    /// A probe over the standing connection of `session_id` to `server_name`, for a test to hold
    /// it in use and read its marks.
    #[cfg(any(test, feature = "test-support"))]
    pub fn probe_standing_connection(
        &self,
        session_id: SessionId,
        server_name: &McpServerName,
    ) -> McpStandingConnectionProbe {
        McpStandingConnectionProbe(self.standing_connection(session_id, server_name))
    }

    /// The scope a new connection of `session_id` to `server_name` is opened in.
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
            .connections
            .iter()
            .filter(|((session, _), _)| *session == session_id)
            .filter_map(|(_, (_, feed))| feed.current())
            .collect()
    }

    // The pair of `session_id` and `server_name` in `standing`, made with the client's stopping
    // mark when there is none; `None` once the session closed or the client stopped, since
    // nothing would close a pair made then.
    fn standing_entry<'a>(
        &self,
        standing: &'a mut StandingState,
        session_id: SessionId,
        server_name: &McpServerName,
    ) -> Option<&'a (McpStandingConnection, McpStandingConnectionFeed)> {
        if self.stopping.is_cancelled() || standing.closed_sessions.contains(&session_id) {
            return None;
        }
        Some(
            standing
                .connections
                .entry((session_id, server_name.as_str().to_owned()))
                .or_insert_with(|| McpStandingConnection::new(self.stopping.clone())),
        )
    }
}

/// A test's view of one standing connection: a hold that keeps its close waiting, as a call under
/// way does, and its closed and stopping marks.
#[cfg(any(test, feature = "test-support"))]
pub struct McpStandingConnectionProbe(McpStandingConnection);

#[cfg(any(test, feature = "test-support"))]
impl McpStandingConnectionProbe {
    /// Counts as work on the connection until the token drops, so its close waits for it.
    pub fn hold(&self) -> TaskTrackerToken {
        self.0.track()
    }

    /// Resolves once the connection's session closed or the client stopped.
    pub async fn closed(&self) {
        self.0.closed().await;
    }

    /// Whether the client is stopping.
    pub fn is_stopping(&self) -> bool {
        self.0.is_stopping()
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
    use std::pin::pin;
    use std::process::Stdio;
    use std::sync::Arc;
    use std::time::Duration;

    use serde_json::json;
    use sidekicks_contracts::mcp::server::McpServerName;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use sidekicks_contracts::wire::text::FreeFormText;
    use sidekicks_platforms::{POSIX_SHELL, Spawner, shell_line_command, wrap_group_child_command};
    use tokio::time::timeout;

    use super::McpClient;
    use crate::client::connection::standing::McpReplacement;
    use crate::client::connection::{McpConnectionStart, McpServerConnection};
    use crate::client::stdio::StdioProcess;
    use crate::client::tasks::McpServerEndpoint;
    use crate::client::test_server::{
        Reply, method_not_found, start_test_server, test_client, tracker_digest,
        v1_initialize_result,
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
            McpConnectionStart::stdio(None, process),
        )
        .await;
        opened.expect("the test server completes its start")
    }

    // A process that runs until it is signaled, so a connection holding it waits in its close.
    pub(super) async fn lasting_process(
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
                .replacement(Some(&after), &McpServerEndpoint::stdio(), &|_| {})
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
        let mut waiter = tokio::spawn(async move {
            standing
                .replacement(
                    Some(&old),
                    &McpServerEndpoint::at_address(&tracker_digest()),
                    &|_| {},
                )
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
                .replacement(Some(&old), &McpServerEndpoint::stdio(), &|_| {})
                .await
        });
        tokio::time::sleep(Duration::from_secs(1)).await;

        client.stop().await;
        assert!(matches!(
            waiter.await.expect("the waiter ends"),
            McpReplacement::ClientStopping
        ));
    }

    // Mutation: in `add_connection`, publish into a pair made after the session's close or the
    // client's stop, leaving the connection open with nothing to close it.
    #[tokio::test(start_paused = true)]
    async fn a_connection_added_after_its_sessions_close_or_the_stop_is_closed_at_once() {
        let (client, _card) = test_client();
        let (session_id, name) = session_and_name();
        client.close_session(session_id).await;

        let after_close = client
            .add_connection(open(&client, session_id, &name, None).await)
            .await;
        let (other_session, _) = session_and_name();
        let opened = open(&client, other_session, &name, None).await;
        client.stop().await;
        let after_stop = client.add_connection(opened).await;

        assert!(
            after_close.service.is_closed(),
            "closed after the session's"
        );
        assert!(after_stop.service.is_closed(), "closed after the stop");
        assert!(
            client.standing_connection(session_id, &name).is_closed(),
            "the closed session's standing connection reads closed"
        );
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
                .replacement(Some(&old), &McpServerEndpoint::stdio(), &|_| {})
                .await
        });
        tokio::time::sleep(Duration::from_secs(1)).await;

        drop(client);
        assert!(matches!(
            waiter.await.expect("the waiter ends"),
            McpReplacement::ClientStopping
        ));
    }

    // Mutation: in `start_session_close`, spawn the close untracked, or leave out the wait on
    // `closings` in `stop`; the stop then ends while the close still waits on the held work.
    #[tokio::test(start_paused = true)]
    async fn the_stop_waits_for_a_session_close_under_way() {
        let (client, _card) = test_client();
        let client = Arc::new(client);
        let (session_id, name) = session_and_name();
        let standing = client.standing_connection(session_id, &name);
        let held = standing.track();

        client.start_session_close(session_id);
        standing.closed().await;
        let mut stopping = pin!(client.stop());
        assert!(
            futures::poll!(&mut stopping).is_pending(),
            "the stop waits for the close, which waits for the held work"
        );

        drop(held);
        stopping.await;
    }
}
