//! A throwaway conversation on a connection of its own, as a title pass and a side question at
//! rest run one: its notifications handed over in arrival order until the connection drops, and
//! its turn stopped within a bound of its own when the pass leaves it before it ends, so no turn
//! is left spending the account's tokens.

use std::error::Error;
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::value::RawValue;
use tokio::sync::mpsc;

use crate::driver::codex::run::turn_interrupt::{CodexTurnInterrupt, interrupt_codex_turn};
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::transport::connection::{
    CodexAppServerConnection, CodexConnectionEvents, CodexForgottenRequest,
};
use sidekicks_std::mutex_lock::lock;

/// How long a throwaway turn left early may take to stop, the answer that names it included: the
/// bound Codex's own terminal gives each request of its throwaway turns, the interrupt among them.
const CODEX_DETACHED_INTERRUPT_DEADLINE: Duration = Duration::from_secs(30);

/// One notification of a detached connection: its method and its params.
pub(crate) type CodexDetachedFrame = (String, Box<RawValue>);

/// A detached connection's notifications, handed in arrival order to the one pass that holds the
/// connection; where they arrive ends once the connection drops.
pub(crate) struct CodexDetachedFrames {
    /// `None` once the connection dropped. Never held across an await.
    frames: Mutex<Option<mpsc::UnboundedSender<CodexDetachedFrame>>>,
}

impl CodexDetachedFrames {
    /// The connection's events, and where its notifications arrive.
    pub(crate) fn new() -> (Arc<Self>, mpsc::UnboundedReceiver<CodexDetachedFrame>) {
        let (sender, frames) = mpsc::unbounded_channel();
        (
            Arc::new(Self {
                frames: Mutex::new(Some(sender)),
            }),
            frames,
        )
    }
}

impl CodexConnectionEvents for CodexDetachedFrames {
    // A pass that already ended has no use for a late frame.
    fn notification(&self, method: &str, params: Box<RawValue>) {
        if let Some(frames) = lock(&self.frames).as_ref() {
            let _unread = frames.send((method.to_owned(), params));
        }
    }

    // A drop ends the pass's requests and its wait for the next frame.
    fn dropped(&self, _reason: &str) {
        lock(&self.frames).take();
    }

    // The throwaway conversation asks for nothing.
    fn held_requests_dropped(&self, _dropped: Vec<CodexForgottenRequest>) {}

    // The pass's request fails with Codex's own words.
    fn service_draining(&self, _message: &str) {}
}

/// Stops the throwaway turn `turn_id` names on `thread_id` over `connection`, within a bound of
/// its own that covers waiting for `turn_id` too; a failure is logged, since the pass that left
/// the turn answers nothing either way.
pub(crate) async fn stop_detached_turn(
    connection: &CodexAppServerConnection,
    thread_id: &str,
    turn_id: impl Future<Output = Result<String, CodexError>>,
) {
    let stopped = tokio::time::timeout(CODEX_DETACHED_INTERRUPT_DEADLINE, async {
        interrupt_codex_turn(connection, thread_id, &turn_id.await?).await
    })
    .await;
    match stopped {
        // A turn that already ended has nothing left to stop.
        Ok(Ok(CodexTurnInterrupt::Stopped | CodexTurnInterrupt::AlreadyEnded)) => {}
        Ok(Err(error)) => tracing::info!(
            error = &error as &(dyn Error + 'static),
            "a codex throwaway turn could not be stopped"
        ),
        Err(elapsed) => tracing::info!(
            error = &elapsed as &(dyn Error + 'static),
            "a codex throwaway turn was not stopped within its bound"
        ),
    }
}
