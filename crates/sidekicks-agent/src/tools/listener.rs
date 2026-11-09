//! The daemon's one loopback HTTP listener: every streamable-HTTP tool server it serves, and the
//! routes other receivers mount beside them, on `127.0.0.1` at the port kept in the data folder,
//! so a provider conversation that kept the address still reaches the daemon after a restart.
//! When another program holds that port, the listener binds a new one and tells its caller.

use std::future::ready;
use std::io;
use std::mem;
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::Router;
use axum::http::{StatusCode, Uri};
use axum::middleware;
use axum::response::{IntoResponse as _, Response};
use rmcp::ServerHandler;
use rmcp::transport::streamable_http_server::session::local::{LocalSessionManager, SessionConfig};
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use sidekicks_platforms::{AtomicWriteError, LeftoverSweep, replace_file_atomically};
use sidekicks_provider::pricing::receiver::refuse_unknown_telemetry_path;
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

use crate::tools::admission::{ToolServerAdmission, admit};
use crate::tools::entries::ToolServerEntries;
use crate::tools::server::TOOL_SERVER_PATH_ROOT;

/// The file in the data folder that keeps the listener's port from one start to the next.
const PORT_FILE_NAME: &str = "tool-server-port";

/// The port file's mode: only the person's account reads it.
const PORT_FILE_MODE: u32 = 0o600;

/// Why the listener did not bind; nothing is listening.
#[derive(Debug, thiserror::Error)]
pub enum ToolServerListenerError {
    /// The port file stands but could not be read.
    #[error("the tool servers' port file {} could not be read", path.display())]
    ReadPort {
        /// The port file.
        path: PathBuf,
        /// What the read reported.
        #[source]
        source: io::Error,
    },
    /// The port file holds no port.
    #[error("the tool servers' port file {} holds no port", path.display())]
    NoPortInFile {
        /// The port file.
        path: PathBuf,
    },
    /// Loopback refused the listener.
    #[error("the tool servers' listener could not bind loopback")]
    Bind(#[source] io::Error),
    /// The new port could not be written to the port file.
    #[error("the tool servers' new port could not be kept")]
    KeepPort(#[source] AtomicWriteError),
}

/// The bound listener: routes are mounted on it, then [`Self::serve`] answers them.
pub struct ToolServerListener {
    /// The bound socket.
    listener: TcpListener,
    /// Its port on `127.0.0.1`.
    port: u16,
    /// The kept port another program held, which the listener moved away from.
    moved_from: Option<u16>,
    /// Every route mounted so far.
    router: Router,
    /// The daemon's stop, which ends serving and every MCP session.
    stop: CancellationToken,
}

impl ToolServerListener {
    /// Binds `127.0.0.1` at the port kept in `data_folder`, or, when none is kept or another
    /// program holds it, at a port the system picks, which it keeps there for the next start.
    /// Serving and every MCP session end once `stop` is canceled.
    pub async fn bind(
        data_folder: &Path,
        stop: CancellationToken,
    ) -> Result<Self, ToolServerListenerError> {
        let port_file = data_folder.join(PORT_FILE_NAME);
        let kept = read_kept_port(&port_file).await?;
        let listener = match kept {
            Some(kept) => match TcpListener::bind((Ipv4Addr::LOCALHOST, kept)).await {
                Ok(listener) => listener,
                Err(error) if error.kind() == io::ErrorKind::AddrInUse => bind_free_port().await?,
                Err(error) => return Err(ToolServerListenerError::Bind(error)),
            },
            None => bind_free_port().await?,
        };
        let port = listener
            .local_addr()
            .map_err(ToolServerListenerError::Bind)?
            .port();
        if kept != Some(port) {
            keep_port(port_file, port).await?;
        }
        Ok(Self {
            listener,
            port,
            moved_from: kept.filter(|kept| *kept != port),
            router: Router::new(),
            stop,
        })
    }

    /// The listener's port on `127.0.0.1`.
    pub fn port(&self) -> u16 {
        self.port
    }

    /// The port kept from the last start when another program held it and the listener moved to
    /// [`Self::port`]: every provider conversation that kept the old address needs the new one.
    pub fn moved_from(&self) -> Option<u16> {
        self.moved_from
    }

    /// Adds `router`'s routes, whose paths no earlier mount holds.
    pub fn mount(&mut self, router: Router) {
        self.router = mem::replace(&mut self.router, Router::new()).merge(router);
    }

    /// Mounts the tool servers at `/tools/…`, each MCP session served by a handler `server`
    /// makes, every request admitted against `entries` before rmcp reads it. Sessions on both
    /// handshake revisions are kept, a body past rmcp's 4 MiB cap is refused, and an idle session
    /// sends nothing and is never reaped: its client's close or its spawn's end closes it.
    pub fn mount_tool_servers<S>(
        &mut self,
        server: impl Fn() -> S + Send + Sync + 'static,
        entries: Arc<ToolServerEntries>,
    ) where
        S: ServerHandler + Send + 'static,
    {
        let mut session_config = SessionConfig::default();
        session_config.keep_alive = None;
        let mut sessions = LocalSessionManager::default();
        sessions.session_config = session_config;
        let sessions = Arc::new(sessions);
        let config = StreamableHttpServerConfig::default()
            .enforce_origin_validation()
            .with_cancellation_token(self.stop.child_token())
            .with_sse_keep_alive(None);
        let service =
            StreamableHttpService::new(move || Ok(server()), Arc::clone(&sessions), config);
        let admission = Arc::new(ToolServerAdmission::new(entries, sessions));
        self.mount(
            Router::new()
                .route_service(&format!("/{TOOL_SERVER_PATH_ROOT}/{{*route}}"), service)
                .route_layer(middleware::from_fn_with_state(admission, admit)),
        );
    }

    /// Serves every mounted route on one accept task until the stop is canceled; an unknown
    /// telemetry path is answered as OTLP asks, and any other unmounted path is 404.
    pub async fn serve(self) -> io::Result<()> {
        let Self {
            listener,
            router,
            stop,
            ..
        } = self;
        let router = router.fallback(|uri: Uri| ready(answer_unmounted(&uri)));
        axum::serve(listener, router)
            .with_graceful_shutdown(stop.cancelled_owned())
            .await
    }
}

// The port `port_file` keeps; `None` when no file stands there yet.
async fn read_kept_port(port_file: &Path) -> Result<Option<u16>, ToolServerListenerError> {
    let text = match tokio::fs::read_to_string(port_file).await {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(source) => {
            return Err(ToolServerListenerError::ReadPort {
                path: port_file.to_owned(),
                source,
            });
        }
    };
    match text.trim().parse::<u16>() {
        Ok(port) if port != 0 => Ok(Some(port)),
        Ok(_) | Err(_) => Err(ToolServerListenerError::NoPortInFile {
            path: port_file.to_owned(),
        }),
    }
}

async fn bind_free_port() -> Result<TcpListener, ToolServerListenerError> {
    TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(ToolServerListenerError::Bind)
}

// Writes `port` to `port_file`, whole or not at all.
async fn keep_port(port_file: PathBuf, port: u16) -> Result<(), ToolServerListenerError> {
    tokio::task::spawn_blocking(move || {
        replace_file_atomically(
            &port_file,
            port.to_string().as_bytes(),
            PORT_FILE_MODE,
            LeftoverSweep::Unswept,
        )
    })
    .await
    .expect("the port file's write does not panic")
    .map_err(ToolServerListenerError::KeepPort)
}

// The answer to a path no route is mounted at.
fn answer_unmounted(uri: &Uri) -> Response {
    refuse_unknown_telemetry_path(uri.path())
        .unwrap_or_else(|| StatusCode::NOT_FOUND.into_response())
}

#[cfg(test)]
pub(super) mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use reqwest::header::ACCEPT;
    use reqwest::{RequestBuilder, StatusCode};
    use rmcp::ServerHandler;
    use rmcp::transport::common::http_header::{HEADER_MCP_PROTOCOL_VERSION, HEADER_SESSION_ID};
    use serde_json::{Value, json};
    use sidekicks_contracts::provider::id::ProviderId;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_provider::bearer_token::BearerToken;
    use sidekicks_provider::port::tool_server_route::ToolServerConversation;
    use sidekicks_provider::tool_server_name::DAEMON_TOOL_SERVER_NAME;
    use tempfile::TempDir;
    use tokio::time::timeout;
    use tokio_util::sync::{CancellationToken, DropGuard};

    use super::ToolServerListener;
    use crate::tools::entries::tests::dispatcher;
    use crate::tools::entries::{ToolServerEntries, ToolServerEntryGuard};
    use crate::tools::server::ToolServerPath;

    /// A Codex session the tests route to.
    pub(in crate::tools) const CODEX_SESSION: &str = "0192f3a4-5b6c-7d8e-9f01-23456789abce";

    /// A Claude Code session the tests route to.
    pub(in crate::tools) const CLAUDE_SESSION: &str = "0192f3a4-5b6c-7d8e-9f01-23456789abcd";

    /// A tool server that answers only the handshake and pings.
    struct Stub;

    impl ServerHandler for Stub {}

    /// A listener serving [`Stub`] on loopback, with the entries it admits against.
    pub(in crate::tools) struct Served {
        /// The listener's address, `http://127.0.0.1:<port>`.
        base: String,
        /// The entries the listener admits against.
        pub(in crate::tools) entries: Arc<ToolServerEntries>,
        /// The client the requests go out on.
        client: reqwest::Client,
        /// Stops the listener when the test ends.
        _stop: DropGuard,
        /// The data folder its port is kept in.
        _data_folder: TempDir,
    }

    impl Served {
        /// A POST of `body` to `path`, accepting both answer forms.
        fn post(&self, path: &str, body: &Value) -> RequestBuilder {
            self.client
                .post(format!("{}{path}", self.base))
                .header(ACCEPT, "application/json, text/event-stream")
                .json(body)
        }

        /// Opens an MCP session on `path` at `revision`, presenting `secret`: the handshake and
        /// its `initialized` notice. Answers the session's id.
        pub(in crate::tools) async fn open_session(
            &self,
            path: &str,
            secret: &str,
            revision: &str,
        ) -> String {
            let handshake = initialize(self, path, revision)
                .bearer_auth(secret)
                .send()
                .await
                .expect("an answer");
            assert_eq!(handshake.status(), StatusCode::OK, "{revision}");
            let mcp_session = mcp_session_of(&handshake).expect("rmcp mints a session");
            let notice = json!({"jsonrpc": "2.0", "method": "notifications/initialized"});
            let initialized = self
                .post(path, &notice)
                .bearer_auth(secret)
                .header(HEADER_SESSION_ID, &mcp_session)
                .header(HEADER_MCP_PROTOCOL_VERSION, revision)
                .send()
                .await
                .expect("an answer");
            assert_eq!(initialized.status(), StatusCode::ACCEPTED, "{revision}");
            mcp_session
        }
    }

    /// Binds a listener in a fresh data folder, mounts [`Stub`] and serves it.
    pub(in crate::tools) async fn serve_stub() -> Served {
        let data_folder = tempfile::tempdir().expect("a scratch folder");
        let stop = CancellationToken::new();
        let mut listener = ToolServerListener::bind(data_folder.path(), stop.clone())
            .await
            .expect("loopback binds");
        let entries = Arc::new(ToolServerEntries::default());
        listener.mount_tool_servers(|| Stub, Arc::clone(&entries));
        let base = format!("http://127.0.0.1:{}", listener.port());
        tokio::spawn(listener.serve());
        Served {
            base,
            entries,
            client: reqwest::Client::builder()
                .no_proxy()
                .build()
                .expect("the client builds"),
            _stop: stop.drop_guard(),
            _data_folder: data_folder,
        }
    }

    /// Adds a Codex spawn's entry for `session` on the daemon's own server. Answers its guard,
    /// its route's path and its secret.
    pub(in crate::tools) fn add_spawn(
        entries: &ToolServerEntries,
        session: &str,
    ) -> (ToolServerEntryGuard, String, String) {
        let session_id = SessionId::new(session).expect("the text is a UUID");
        let token = BearerToken::mint().expect("the system's random source reads");
        let secret = token.text().to_owned();
        let path = ToolServerPath {
            session_id,
            conversation: ToolServerConversation::of_session(session_id),
            server_name: DAEMON_TOOL_SERVER_NAME.to_owned(),
        };
        let printed = path.to_string();
        let guard = entries.insert(
            path,
            ProviderId::new("codex".to_owned()).expect("the id is well formed"),
            token,
            dispatcher(),
        );
        (guard, printed, secret)
    }

    /// The handshake at `revision` on `path`, with no secret yet.
    pub(in crate::tools) fn initialize(
        served: &Served,
        path: &str,
        revision: &str,
    ) -> RequestBuilder {
        served.post(
            path,
            &json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": revision,
                    "capabilities": {},
                    "clientInfo": {"name": "test", "version": "1"},
                },
            }),
        )
    }

    /// A ping on `mcp_session` at `revision` on `path`, with no secret yet.
    pub(in crate::tools) fn ping(
        served: &Served,
        path: &str,
        mcp_session: &str,
        revision: &str,
    ) -> RequestBuilder {
        served
            .post(path, &json!({"jsonrpc": "2.0", "id": 2, "method": "ping"}))
            .header(HEADER_SESSION_ID, mcp_session)
            .header(HEADER_MCP_PROTOCOL_VERSION, revision)
    }

    /// The `Mcp-Session-Id` an answer carries.
    pub(in crate::tools) fn mcp_session_of(response: &reqwest::Response) -> Option<String> {
        let value = response.headers().get(HEADER_SESSION_ID)?;
        Some(value.to_str().expect("a session id is text").to_owned())
    }

    // Codex and Claude Code each open a session on their own revision, and each is kept and
    // served: its handshake mints a session id and a ping on it is answered. Killed by turning
    // `legacy_session_mode` off, which mints no session id.
    #[tokio::test]
    async fn sessions_on_both_handshake_revisions_are_kept_and_served() {
        let served = serve_stub().await;
        let (_spawn, path, secret) = add_spawn(&served.entries, CODEX_SESSION);
        for revision in ["2025-11-25", "2025-06-18"] {
            let mcp_session = served.open_session(&path, &secret, revision).await;
            let mut answer = ping(&served, &path, &mcp_session, revision)
                .bearer_auth(&secret)
                .send()
                .await
                .expect("an answer");
            assert_eq!(answer.status(), StatusCode::OK, "{revision}");
            let mut text = String::new();
            let reading = async {
                while !text.contains("\"result\"") {
                    let Some(chunk) = answer.chunk().await.expect("the stream reads") else {
                        break;
                    };
                    text.push_str(&String::from_utf8_lossy(&chunk));
                }
            };
            timeout(Duration::from_secs(10), reading)
                .await
                .expect("the ping is answered in time");
            assert!(text.contains("\"result\""), "{revision}: {text}");
        }
    }

    // The kept port is bound again at the next start; while another program holds it, the
    // listener moves, says from where, and keeps the new port for the start after. Killed by
    // binding a fresh port each start, by failing on a held port, and by not keeping a new one.
    #[tokio::test]
    async fn the_kept_port_is_bound_again_and_a_held_one_moves_and_is_kept() {
        let data_folder = tempfile::tempdir().expect("a scratch folder");
        let bind = || ToolServerListener::bind(data_folder.path(), CancellationToken::new());
        let first = bind().await.expect("loopback binds");
        let kept = first.port();
        assert_eq!(first.moved_from(), None);
        drop(first);

        let again = bind().await.expect("the kept port binds again");
        assert_eq!((again.port(), again.moved_from()), (kept, None));

        let moved = bind().await.expect("a held port moves");
        assert_ne!(moved.port(), kept);
        assert_eq!(moved.moved_from(), Some(kept));
        let moved_to = moved.port();
        drop((again, moved));

        let after = bind().await.expect("the new port binds again");
        assert_eq!((after.port(), after.moved_from()), (moved_to, None));
    }
}
