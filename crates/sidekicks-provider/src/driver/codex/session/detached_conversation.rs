//! A throwaway conversation on a connection of its own, as a title pass, a hand-over's copy and a
//! side question at rest run one: its notifications handed over in arrival order until the
//! connection drops, its turn read to its end with each usage reading filed as it comes, and its
//! turn stopped within a bound of its own when the pass leaves it before it ends, so no turn is
//! left spending the account's tokens, with the readings received by then filed after the stop.

use std::error::Error;
use std::future::Future;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::value::RawValue;
use sidekicks_std::mutex_lock::lock;
use tokio::sync::mpsc;

use crate::driver::codex::run::turn_interrupt::{CodexTurnInterrupt, interrupt_codex_turn};
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::service::supervisor::routing::read_codex_frame_thread_id;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::session::side_questions::copy_turn::{
    CopyFrameReading, CopyTurn, CopyTurnMeter, SessionUsageFiling,
};
use crate::driver::codex::transport::connection::{
    CodexAppServerConnection, CodexConnectionEvents, CodexForgottenRequest,
};

/// How long a turn the daemon left may take to stop: a throwaway turn left early, the answer that
/// names it included, and a turn a restart kept. Codex's own terminal gives each request of its
/// throwaway turns this bound, the interrupt among them.
pub(crate) const CODEX_DETACHED_INTERRUPT_DEADLINE: Duration = Duration::from_secs(30);

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

    // The pass's request fails at its own deadline, and nothing ends the service for it.
    fn request_timed_out(&self, _silent_for: Duration) {}

    fn answered_after_timeout(&self) {}
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

/// What a throwaway turn's read came to: its last reply, and how the turn ended, `None` where the
/// connection dropped first.
pub(crate) struct DetachedTurnRead {
    /// The turn's last reply.
    pub(crate) answer: Option<String>,
    /// The turn's end, as its frame read.
    pub(crate) turn: Option<CopyTurn>,
}

/// Reads `meter`'s thread's frames until its turn's end or the connection's drop, each usage
/// reading filed through `filing` as it comes, its region read on `service` for `folder`. `stop` is
/// checked only while the next frame is awaited, never inside a filing, and answers `None` once it
/// fired; the readings received by then wait for [`file_received_usage`].
pub(crate) async fn read_detached_turn(
    frames: &mut mpsc::UnboundedReceiver<CodexDetachedFrame>,
    meter: &mut CopyTurnMeter,
    filing: &mut SessionUsageFiling,
    service: &CodexService,
    folder: &Path,
    stop: impl Future<Output = ()>,
) -> Option<DetachedTurnRead> {
    tokio::pin!(stop);
    let mut answer = None;
    loop {
        let frame = tokio::select! {
            biased;
            () = &mut stop => return None,
            frame = frames.recv() => frame,
        };
        let Some((method, params)) = frame else {
            return Some(DetachedTurnRead { answer, turn: None });
        };
        match read_thread_frame(meter, &method, &params) {
            CopyFrameReading::Reply(text) => answer = Some(text),
            CopyFrameReading::Usage(delta) => filing.file(*delta, service, folder).await,
            CopyFrameReading::Ended(turn) => return Some(DetachedTurnRead { answer, turn }),
            CopyFrameReading::Other => {}
        }
    }
}

/// Files, in order, every usage reading of `meter`'s thread already received on `frames`. Run after
/// a started turn's [`stop_detached_turn`]: Codex answers the interrupt only once the turn aborted,
/// after the readings of every request that completed before it.
pub(crate) async fn file_received_usage(
    frames: &mut mpsc::UnboundedReceiver<CodexDetachedFrame>,
    meter: &mut CopyTurnMeter,
    filing: &mut SessionUsageFiling,
    service: &CodexService,
    folder: &Path,
) {
    while let Ok((method, params)) = frames.try_recv() {
        if let CopyFrameReading::Usage(delta) = read_thread_frame(meter, &method, &params) {
            filing.file(*delta, service, folder).await;
        }
    }
}

// One frame read through `meter` where it is of its thread; a frame of another reads as nothing.
fn read_thread_frame(
    meter: &mut CopyTurnMeter,
    method: &str,
    params: &RawValue,
) -> CopyFrameReading {
    if read_codex_frame_thread_id(method, params).as_deref() != Some(meter.thread_id.as_str()) {
        return CopyFrameReading::Other;
    }
    meter.read_frame(method, params)
}
