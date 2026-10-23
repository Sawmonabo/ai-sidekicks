//! The one reader of a Claude Code process's output. It frames the output into lines under a
//! ceiling, settles each control answer at once on the reader, never behind the frames, and hands
//! every request and stream frame to the session's listener in the order read. A lead `result`
//! that ends the turn releases the turn's hold here, before the frame is handed on, so a run start
//! waiting for the turn never waits on the session's task.

use std::collections::HashSet;
use std::sync::{Arc, Weak};

use futures::StreamExt;
use serde_json::Map;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_platforms::ChildEnd;
use tokio::io::AsyncRead;
use tokio::sync::watch;
use tokio_util::codec::{AnyDelimiterCodec, AnyDelimiterCodecError, FramedRead};

use crate::provider::driver::claude::DESCRIPTOR;
use crate::provider::driver::claude::session::control_requests::{
    ClaudeControlRequests, ClaudeControlSettlement,
};
use crate::provider::driver::claude::session::frame_observation::{
    ClaudeStartupHookChange, ClaudeStreamFrameRead,
};
use crate::provider::driver::claude::session::process::{
    ClaudeChildEnds, ClaudeProcessListener, ClaudeStreamFrame, ClaudeTurnHolds,
};
use crate::provider::driver::claude::session::transport::inbound::ClaudeControlFrameReader;
use crate::provider::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, OnceReportedDiagnostics, emit_driver_diagnostic,
};
use crate::provider::inbound_json::decode_inbound_json;

/// The ceiling on one output line, in bytes; Claude Code publishes no limit. It stops a process
/// from growing one line until the daemon runs out of memory.
pub(crate) const CLAUDE_OUTPUT_LINE_MAX_BYTES: usize = 32 * 1024 * 1024;

/// What one process's output reader holds while it reads.
pub(crate) struct ClaudeOutputReader {
    /// The process's pending control requests, which its answers settle.
    pub(crate) requests: ClaudeControlRequests,
    /// Reads the process's control frames.
    pub(crate) control_frames: ClaudeControlFrameReader,
    /// Takes each frame and request in order.
    pub(crate) listener: Arc<dyn ClaudeProcessListener>,
    /// The session turn a lead `result` releases, for a session's process.
    pub(crate) turn_holds: Option<ClaudeTurnHolds>,
    /// How many start-up hooks are running, which `initialize`'s wait does not count.
    pub(crate) startup_hooks: watch::Sender<usize>,
    /// Asks the process to end when a line passes the ceiling or the output fails to read; gone
    /// once the process's handle dropped, which kills it.
    pub(crate) ends: Weak<ClaudeChildEnds>,
    /// The lines that were no frame, reported once per process.
    pub(crate) unmapped_lines: OnceReportedDiagnostics,
    /// The provider session the process runs, named in each diagnostic.
    pub(crate) provider_session_id: String,
    /// The account whose home the process runs on, named in each diagnostic.
    pub(crate) provider_account_id: Option<ProviderAccountId>,
}

impl ClaudeOutputReader {
    /// Reads `output` to its end, or until a line passes the ceiling, which records the
    /// diagnostic, or the output fails to read, which logs it; either asks the process to stop.
    pub(crate) async fn read<Output: AsyncRead + Unpin>(mut self, output: Output) {
        let codec = AnyDelimiterCodec::new_with_max_length(
            b"\n".to_vec(),
            Vec::new(),
            CLAUDE_OUTPUT_LINE_MAX_BYTES,
        );
        let mut lines = FramedRead::new(output, codec);
        let mut running_hooks = HashSet::new();
        while let Some(line) = lines.next().await {
            match line {
                Ok(line) => self.read_line(&line, &mut running_hooks),
                // The codec reads nothing more after its error, which is no clean end of output.
                Err(AnyDelimiterCodecError::MaxChunkLengthExceeded) => {
                    emit_driver_diagnostic(&self.compose_record(
                        DriverDiagnosticKind::ProviderFrameOversized,
                        "an output line passed the frame ceiling, so the process was ended",
                        Some(CLAUDE_OUTPUT_LINE_MAX_BYTES),
                    ));
                    if let Some(ends) = self.ends.upgrade() {
                        ends.ask(ChildEnd::Stop);
                    }
                    return;
                }
                // A process whose output cannot be read sends the session nothing more, so it is
                // ended rather than left running with its turn open.
                Err(AnyDelimiterCodecError::Io(error)) => {
                    tracing::warn!(
                        provider_session_id = self.provider_session_id.as_str(),
                        error = &error as &(dyn std::error::Error + 'static),
                        "the Claude Code process's output could not be read further, so the \
                         process was ended"
                    );
                    if let Some(ends) = self.ends.upgrade() {
                        ends.ask(ChildEnd::Stop);
                    }
                    return;
                }
            }
        }
    }

    fn read_line(&mut self, line: &[u8], running_hooks: &mut HashSet<String>) {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if line.iter().all(u8::is_ascii_whitespace) {
            return;
        }
        let text = decode_inbound_json(line);
        let Some(frame) = ClaudeStreamFrameRead::read(&text) else {
            // Fails closed: a line that is no frame is never routed as one.
            let record = self.compose_record(
                DriverDiagnosticKind::UnmappedWireKind,
                "an output line that is not a JSON object was dropped at the read loop",
                None,
            );
            self.unmapped_lines.report(&record);
            return;
        };
        match frame.frame_type() {
            "control_response" => self.settle_answer(&text),
            "control_request" => {
                if let Some(event) = self.control_frames.read_request(&text) {
                    self.listener.take_request(event);
                }
            }
            "control_cancel_request" => {
                if let Some(event) = self.control_frames.read_cancel(&text) {
                    self.listener.take_request(event);
                }
            }
            _ => {
                if let Some(change) = frame.startup_hook_change() {
                    self.count_startup_hook(change, running_hooks);
                }
                let frame = ClaudeStreamFrame {
                    observation: frame.into_observation(),
                    text: text.into_owned(),
                };
                self.release_ended_turn(&frame);
                self.listener.take_frame(frame);
            }
        }
    }

    fn settle_answer(&mut self, text: &str) {
        let Some(answer) = self.control_frames.read_response(text) else {
            return;
        };
        match self.requests.settle(&answer.request_id, answer.outcome) {
            ClaudeControlSettlement::Settled | ClaudeControlSettlement::Late => {}
            ClaudeControlSettlement::NeverIssued => self.control_frames.report_unissued_answer(),
        }
    }

    // A helper's `result` ends the helper's work, never the session's turn; a lead `result` the
    // listener reads as ending nothing leaves the hold in place.
    fn release_ended_turn(&self, frame: &ClaudeStreamFrame) {
        let Some(turn_holds) = &self.turn_holds else {
            return;
        };
        if frame.observation.frame_kind.split('/').next() == Some("result")
            && frame.observation.subagent_id.is_none()
            && self.listener.is_turn_ending(frame)
        {
            turn_holds.routes.settle_turn_holds(turn_holds.session_id);
        }
    }

    fn count_startup_hook(
        &self,
        change: ClaudeStartupHookChange,
        running_hooks: &mut HashSet<String>,
    ) {
        let is_changed = match change {
            ClaudeStartupHookChange::Started(hook_id) => running_hooks.insert(hook_id),
            ClaudeStartupHookChange::Ended(hook_id) => running_hooks.remove(&hook_id),
        };
        if is_changed {
            self.startup_hooks.send_replace(running_hooks.len());
        }
    }

    fn compose_record(
        &self,
        kind: DriverDiagnosticKind,
        disposition_reason: &str,
        limit: Option<usize>,
    ) -> DriverDiagnosticRecord {
        let mut details = Map::new();
        details.insert(
            "providerSessionId".to_owned(),
            self.provider_session_id.clone().into(),
        );
        if let Some(limit) = limit {
            details.insert("limit".to_owned(), limit.into());
        }
        DriverDiagnosticRecord {
            provider: DESCRIPTOR.provider_id(),
            provider_account_id: self.provider_account_id.clone(),
            kind,
            raw_wire_type: None,
            disposition_reason: disposition_reason.to_owned(),
            details,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io;
    use std::pin::Pin;
    use std::sync::{Arc, Mutex, Weak};
    use std::task::{Context, Poll};
    use std::time::Duration;

    use sidekicks_platforms::ChildEnd;
    use tokio::io::{AsyncRead, AsyncWriteExt, ReadBuf};
    use tokio::sync::watch;

    use super::{CLAUDE_OUTPUT_LINE_MAX_BYTES, ClaudeOutputReader};
    use crate::provider::driver::claude::session::control_requests::ClaudeControlRequests;
    use crate::provider::driver::claude::session::process::{
        ClaudeChildEnds, ClaudeProcessEnd, ClaudeProcessListener, ClaudeStreamFrame,
    };
    use crate::provider::driver::claude::session::transport::control::ClaudeControlSubtype;
    use crate::provider::driver::claude::session::transport::inbound::{
        ClaudeControlFrameReader, ClaudeInboundRequestEvent,
    };
    use crate::provider::driver::claude::session::transport::user_message::ClaudeWriteAttempt;
    use crate::provider::driver::diagnostics::{OnceReportedDiagnostics, RecordedEvents};

    // Keeps the frames it takes and never hands them on, as a session task blocked in a dispatch.
    #[derive(Default)]
    struct HeldFrames(Mutex<Vec<String>>);

    impl ClaudeProcessListener for HeldFrames {
        fn take_frame(&self, frame: ClaudeStreamFrame) {
            self.0
                .lock()
                .expect("the test's lock is never held across a panic")
                .push(frame.text);
        }

        fn take_request(&self, _event: ClaudeInboundRequestEvent) {}

        fn take_exit(&self, _end: ClaudeProcessEnd) {}

        fn is_turn_ending(&self, _frame: &ClaudeStreamFrame) -> bool {
            true
        }
    }

    fn reader(
        requests: ClaudeControlRequests,
        listener: Arc<HeldFrames>,
        ends: Weak<ClaudeChildEnds>,
    ) -> ClaudeOutputReader {
        ClaudeOutputReader {
            requests,
            control_frames: ClaudeControlFrameReader::new(None, "conversation".to_owned()),
            listener,
            turn_holds: None,
            startup_hooks: watch::channel(0).0,
            ends,
            unmapped_lines: OnceReportedDiagnostics::default(),
            provider_session_id: "conversation".to_owned(),
            provider_account_id: None,
        }
    }

    // Killed by handing a control answer to the listener behind the frames instead of settling it
    // on the reader: the request then waits on a task that never takes it.
    #[tokio::test(start_paused = true)]
    async fn a_control_answer_settles_while_the_frames_before_it_wait() {
        let requests = ClaudeControlRequests::new(Arc::new(|_request_id: &str| {}));
        let pending = requests
            .open(ClaudeControlSubtype::GetSettings)
            .expect("an open table takes a request");
        let listener = Arc::new(HeldFrames::default());
        let (mut provider, output) = tokio::io::duplex(4096);
        provider
            .write_all(
                format!(
                    "{}\n{}\n",
                    r#"{"type":"system","subtype":"status"}"#,
                    format_args!(
                        concat!(
                            r#"{{"type":"control_response","response":{{"subtype":"success","#,
                            r#""request_id":"{}","response":{{}}}}}}"#,
                        ),
                        pending.request_id()
                    ),
                )
                .as_bytes(),
            )
            .await
            .expect("the pipe takes the lines");
        drop(provider);
        reader(requests, Arc::clone(&listener), Weak::new())
            .read(output)
            .await;

        let answer = pending
            .answer_within(ClaudeWriteAttempt::Written, Duration::from_secs(1))
            .await;
        assert!(
            answer.is_ok(),
            "the answer settled on the reader: {answer:?}"
        );
        assert_eq!(
            listener
                .0
                .lock()
                .expect("the test's lock is never held across a panic")
                .len(),
            1,
            "only the stream frame reached the listener"
        );
    }

    // Killed by reading lines with no ceiling: the reader then waits for the line's end and never
    // records the diagnostic or asks the process to stop.
    #[test]
    fn a_line_past_the_ceiling_is_recorded_and_ends_the_process() {
        let recorded = RecordedEvents::default();
        let (ends_sender, ends) = watch::channel(None);
        let ends_sender = Arc::new(ClaudeChildEnds(ends_sender));
        recorded.record_during(|| {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("a test runtime builds")
                .block_on(async {
                    let (mut provider, output) = tokio::io::duplex(64 * 1024);
                    let writing = tokio::spawn(async move {
                        let chunk = vec![b'a'; 1024 * 1024];
                        let mut written = 0;
                        while written <= CLAUDE_OUTPUT_LINE_MAX_BYTES {
                            if provider.write_all(&chunk).await.is_err() {
                                return;
                            }
                            written += chunk.len();
                        }
                    });
                    reader(
                        ClaudeControlRequests::new(Arc::new(|_request_id: &str| {})),
                        Arc::new(HeldFrames::default()),
                        Arc::downgrade(&ends_sender),
                    )
                    .read(output)
                    .await;
                    writing
                        .await
                        .expect("the writer ends once the reader is gone");
                });
        });
        assert_eq!(
            recorded.counters(),
            vec!["driver.process.frameOversized".to_owned()]
        );
        assert_eq!(*ends.borrow(), Some(ChildEnd::Stop));
    }

    // An output whose every read fails, as a broken pipe's does.
    struct UnreadableOutput;

    impl AsyncRead for UnreadableOutput {
        fn poll_read(
            self: Pin<&mut Self>,
            _context: &mut Context<'_>,
            _buffer: &mut ReadBuf<'_>,
        ) -> Poll<io::Result<()>> {
            Poll::Ready(Err(io::Error::other("the pipe broke")))
        }
    }

    // Killed by a read error that only logs and returns (the `Io` arm leaving out the stop): the
    // process would keep running while its session receives nothing more.
    #[tokio::test]
    async fn an_output_read_error_ends_the_process() {
        let (ends_sender, ends) = watch::channel(None);
        let ends_sender = Arc::new(ClaudeChildEnds(ends_sender));

        reader(
            ClaudeControlRequests::new(Arc::new(|_request_id: &str| {})),
            Arc::new(HeldFrames::default()),
            Arc::downgrade(&ends_sender),
        )
        .read(UnreadableOutput)
        .await;

        assert_eq!(*ends.borrow(), Some(ChildEnd::Stop));
    }
}
