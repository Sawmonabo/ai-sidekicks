//! The model endpoint a calibration run's Codex talks to: a loopback stand-in for the Responses
//! API that answers every request with one short finished reply, so a measured turn spends no
//! tokens and needs no account.

use std::future::IntoFuture;
use std::io;
use std::net::{Ipv4Addr, SocketAddr};

use axum::Router;
use axum::http::header::CONTENT_TYPE;
use axum::routing::post;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use tokio_util::sync::{CancellationToken, DropGuard};

/// The path Codex posts a model request to, under the base address it is given.
const RESPONSES_PATH: &str = "/v1/responses";

/// One finished reply as the Responses API streams it: its start, its one message and its end
/// with the request's usage.
const FINISHED_REPLY: &str = concat!(
    "event: response.created\n",
    r#"data: {"type":"response.created","response":{"id":"resp_calibration"}}"#,
    "\n\n",
    "event: response.output_item.done\n",
    r#"data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","role":"assistant","id":"msg_calibration","content":[{"type":"output_text","text":"ok","annotations":[]}]}}"#,
    "\n\n",
    "event: response.completed\n",
    r#"data: {"type":"response.completed","response":{"id":"resp_calibration","usage":{"input_tokens":1,"input_tokens_details":{"cached_tokens":0},"output_tokens":1,"output_tokens_details":{"reasoning_tokens":0},"total_tokens":2}}}"#,
    "\n\n",
);

/// A running stand-in: the base address Codex's provider entry names, and the task serving it,
/// which shuts down once the stand-in stops or is dropped.
pub(super) struct ModelEndpointStandIn {
    /// The base address, `http://127.0.0.1:<port>/v1`.
    pub(super) base_url: String,
    stop: DropGuard,
    serving: JoinHandle<io::Result<()>>,
}

impl ModelEndpointStandIn {
    /// Starts the stand-in on a free loopback port. Fails when no port could be bound.
    pub(super) async fn start() -> io::Result<Self> {
        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).await?;
        let port = listener.local_addr()?.port();
        let stop = CancellationToken::new();
        let router = Router::new().route(
            RESPONSES_PATH,
            post(|| async { ([(CONTENT_TYPE, "text/event-stream")], FINISHED_REPLY) }),
        );
        let serving = tokio::spawn(
            axum::serve(listener, router)
                .with_graceful_shutdown(stop.clone().cancelled_owned())
                .into_future(),
        );
        Ok(Self {
            base_url: format!("http://127.0.0.1:{port}/v1"),
            stop: stop.drop_guard(),
            serving,
        })
    }

    /// Stops the stand-in and waits for its task. Fails when serving failed.
    pub(super) async fn stop(self) -> io::Result<()> {
        drop(self.stop);
        self.serving.await.map_err(io::Error::other)?
    }
}
