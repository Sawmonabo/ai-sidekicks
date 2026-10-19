//! One `terminal.output.subscribe` subscription's feed: the scrollback window first, at the size
//! the shell was last drawn at, then the output after it, never a byte twice. The feed holds only
//! its place, a cursor into the shell's output: each frame is read from the scrollback window at
//! that cursor once the subscription's lane has credit, so a slow watcher costs no queue. A window
//! too large for one attachment goes on in continuation frames before any output. A watcher whose
//! cursor the window has left behind, or that declared itself behind while output passed it, gets
//! the drop mark and a fresh scrollback once it can take frames again, so it redraws from the
//! window instead of the daemon holding output for it. A reconnecting watcher whose `afterOffset`
//! the window still holds gets only the output after it.

use std::sync::Arc;

use bytes::Bytes;
use futures::future::BoxFuture;
use sidekicks_contracts::command::ExitCode;
use sidekicks_contracts::jsonrpc::framing::MAX_ONE_ATTACHMENT_BYTES;
use sidekicks_contracts::jsonrpc::streaming::SubscriptionId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::terminal::{
    OutputOffset, TerminalId, TerminalOutputChange, TerminalOutputFrame,
};
use sidekicks_contracts::wire::BoolLiteral;
use sidekicks_contracts::wire::attachment::Bytes as AttachedBytes;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::list::BoundedVec;
use sidekicks_terminal::ScrollbackRead;
use tokio::sync::watch;

use crate::ipc::registry::{HandlerError, TransportId};
use crate::ipc::stream::feed::{Feed, SendGate};
use crate::pty::control_lease::LeaseReading;
use crate::pty::shell::resize::ShellSize;

/// How a shell stands for its output streams; every change of it, and every chunk of output, is
/// signaled through the shell's progress watch.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum ShellOutputEnd {
    /// The shell runs, or is starting.
    #[default]
    Running,
    /// The shell's program exited after `cursor` bytes of output.
    Exited {
        /// The program's exit code.
        exit_code: ExitCode,
        /// The output offset its last output ended at.
        cursor: u64,
    },
    /// The shell never started, so its window is all there is.
    DidNotStart,
    /// The shell was closed or its session deleted: its streams end with no more frames.
    Closed,
}

/// What a shell's output streams read from the shell, implemented by its record in the shell
/// table. Every read is short and never waits on output.
pub(crate) trait ShellOutputSource: Send + Sync {
    /// The shell's session.
    fn session_id(&self) -> &SessionId;
    /// The shell.
    fn terminal_id(&self) -> &TerminalId;
    /// Who holds the shell once any change of holder in flight has settled.
    fn read_holder(&self) -> BoxFuture<'_, LeaseReading>;
    /// The whole scrollback window and the output offset it ends at.
    fn read_window(&self) -> ScrollbackRead;
    /// At most `max` bytes of output after `offset`; `None` once the window no longer holds it.
    fn read_output_after(&self, offset: u64, max: usize) -> Option<Vec<u8>>;
    /// The size the shell was last drawn at.
    fn size(&self) -> ShellSize;
    /// Whether `transport_id` declared itself behind on this shell.
    fn is_connection_behind(&self, transport_id: TransportId) -> bool;
    /// Ends what the subscription carried: its connection's watch, its hold bindings and any paste
    /// it left open. Called once, from the feed's drop, so it must not block.
    fn end_output_subscription(&self, subscription_id: SubscriptionId, transport_id: TransportId);
}

/// Where one stream stands.
enum StreamPlace {
    /// The scrollback goes next: on a first open past an `afterOffset` the window still holds,
    /// the output after it instead; `is_dropped` marks a reseed after output passed the watcher.
    Opening {
        after_offset: Option<u64>,
        is_dropped: bool,
    },
    /// The window's later pieces go next, before any output.
    Seeding {
        window: Bytes,
        sent: usize,
        end_offset: u64,
    },
    /// Output goes next, from `cursor`; `has_missed` once output passed it while it was behind.
    Live { cursor: u64, has_missed: bool },
    /// Nothing more is sent.
    Finished,
}

/// One subscription's view of one shell's output, as the feed its subscribe call answers.
pub(crate) struct ShellOutputStream {
    source: Arc<dyn ShellOutputSource>,
    subscription_id: SubscriptionId,
    transport_id: TransportId,
    progress: watch::Receiver<ShellOutputEnd>,
    place: StreamPlace,
}

impl ShellOutputStream {
    /// The stream of `source`'s output for `subscription_id` on `transport_id`, woken through
    /// `progress`, opening past `after_offset` when the window still holds it.
    pub(crate) fn new(
        source: Arc<dyn ShellOutputSource>,
        subscription_id: SubscriptionId,
        transport_id: TransportId,
        progress: watch::Receiver<ShellOutputEnd>,
        after_offset: Option<u64>,
    ) -> Self {
        Self {
            source,
            subscription_id,
            transport_id,
            progress,
            place: StreamPlace::Opening {
                after_offset,
                is_dropped: false,
            },
        }
    }

    /// The next frame, or `None` once the stream is done or the shell's record is gone.
    async fn next_frame(&mut self, gate: &dyn SendGate) -> Option<TerminalOutputFrame> {
        loop {
            if gate.ready().await.is_err() {
                return None;
            }
            let end = *self.progress.borrow_and_update();
            match &mut self.place {
                StreamPlace::Finished => return None,
                _ if end == ShellOutputEnd::Closed => {
                    self.place = StreamPlace::Finished;
                    return None;
                }
                StreamPlace::Opening {
                    after_offset,
                    is_dropped,
                } => {
                    let is_dropped = *is_dropped;
                    if let Some(after_offset) = after_offset.take()
                        && self.source.read_output_after(after_offset, 0).is_some()
                    {
                        self.place = StreamPlace::Live {
                            cursor: after_offset,
                            has_missed: false,
                        };
                        continue;
                    }
                    // A watcher behind waits to be seeded, unless the shell is done, since nothing
                    // would seed it later.
                    if end == ShellOutputEnd::Running
                        && self.source.is_connection_behind(self.transport_id)
                    {
                        self.progress.changed().await.ok()?;
                        continue;
                    }
                    return Some(self.open_window(is_dropped, end).await);
                }
                StreamPlace::Seeding {
                    window,
                    sent,
                    end_offset,
                } => {
                    let piece_end = window.len().min(*sent + MAX_ONE_ATTACHMENT_BYTES);
                    let data = window.slice(*sent..piece_end);
                    let cursor = *end_offset - byte_count(window.len() - piece_end);
                    let change = TerminalOutputChange::ScrollbackContinuation {
                        session_id: self.source.session_id().clone(),
                        terminal_id: self.source.terminal_id().clone(),
                        data: attached(data),
                        cursor: offset(cursor),
                    };
                    let mut changes = vec![change];
                    if piece_end == window.len() {
                        let end_offset = *end_offset;
                        self.place = StreamPlace::Live {
                            cursor: end_offset,
                            has_missed: false,
                        };
                        self.finish_if_done(end, end_offset, &mut changes);
                    } else {
                        *sent = piece_end;
                    }
                    return Some(frame(changes, false));
                }
                StreamPlace::Live { cursor, has_missed } => {
                    let cursor = *cursor;
                    let read = self
                        .source
                        .read_output_after(cursor, MAX_ONE_ATTACHMENT_BYTES);
                    let Some(output) = read else {
                        self.reseed();
                        continue;
                    };
                    if self.source.is_connection_behind(self.transport_id) {
                        if !output.is_empty() {
                            *has_missed = true;
                        }
                        if matches!(end, ShellOutputEnd::Running) {
                            self.progress.changed().await.ok()?;
                            continue;
                        }
                    }
                    if *has_missed {
                        self.reseed();
                        continue;
                    }
                    if output.is_empty() {
                        if let ShellOutputEnd::Exited { exit_code, .. } = end {
                            self.place = StreamPlace::Finished;
                            let exited = TerminalOutputChange::Exited {
                                session_id: self.source.session_id().clone(),
                                terminal_id: self.source.terminal_id().clone(),
                                exit_code,
                                cursor: offset(cursor),
                            };
                            return Some(frame(vec![exited], false));
                        }
                        if end == ShellOutputEnd::DidNotStart {
                            self.place = StreamPlace::Finished;
                            return None;
                        }
                        self.progress.changed().await.ok()?;
                        continue;
                    }
                    let next_cursor = cursor + byte_count(output.len());
                    let mut changes = vec![TerminalOutputChange::Output {
                        session_id: self.source.session_id().clone(),
                        terminal_id: self.source.terminal_id().clone(),
                        data: attached(Bytes::from(output)),
                        cursor: offset(next_cursor),
                    }];
                    self.place = StreamPlace::Live {
                        cursor: next_cursor,
                        has_missed: false,
                    };
                    self.finish_if_done(end, next_cursor, &mut changes);
                    return Some(frame(changes, false));
                }
            }
        }
    }

    // A watcher whose output went by it opens the window again, with the drop mark.
    fn reseed(&mut self) {
        self.place = StreamPlace::Opening {
            after_offset: None,
            is_dropped: true,
        };
    }

    // The window's first piece, opening with the holder read once any change in flight settled;
    // a window that fits whole goes live at its end, and a shell done there ends the stream.
    async fn open_window(&mut self, is_dropped: bool, end: ShellOutputEnd) -> TerminalOutputFrame {
        let LeaseReading {
            holder,
            lease_version,
        } = self.source.read_holder().await;
        let ScrollbackRead {
            bytes,
            output_offset,
        } = self.source.read_window();
        let window = Bytes::from(bytes);
        let size = self.source.size();
        let piece_end = window.len().min(MAX_ONE_ATTACHMENT_BYTES);
        let cursor = output_offset - byte_count(window.len() - piece_end);
        let mut changes = vec![TerminalOutputChange::Scrollback {
            session_id: self.source.session_id().clone(),
            terminal_id: self.source.terminal_id().clone(),
            data: attached(window.slice(..piece_end)),
            columns: SafeInt::new(u64::from(size.columns)).expect("a shell has a column"),
            rows: SafeInt::new(u64::from(size.rows)).expect("a shell has a row"),
            holder,
            lease_version,
            cursor: offset(cursor),
        }];
        if piece_end == window.len() {
            self.place = StreamPlace::Live {
                cursor: output_offset,
                has_missed: false,
            };
            self.finish_if_done(end, output_offset, &mut changes);
        } else {
            self.place = StreamPlace::Seeding {
                window,
                sent: piece_end,
                end_offset: output_offset,
            };
        }
        frame(changes, is_dropped)
    }

    // Ends the stream once it has sent everything a done shell has: an exited shell's exit rides
    // the frame that reaches its last output; a shell that never started ends with its window.
    fn finish_if_done(
        &mut self,
        end: ShellOutputEnd,
        cursor: u64,
        changes: &mut Vec<TerminalOutputChange>,
    ) {
        match end {
            ShellOutputEnd::Exited {
                exit_code,
                cursor: exit_cursor,
            } if exit_cursor == cursor => {
                changes.push(TerminalOutputChange::Exited {
                    session_id: self.source.session_id().clone(),
                    terminal_id: self.source.terminal_id().clone(),
                    exit_code,
                    cursor: offset(cursor),
                });
                self.place = StreamPlace::Finished;
            }
            ShellOutputEnd::DidNotStart => self.place = StreamPlace::Finished,
            ShellOutputEnd::Running | ShellOutputEnd::Exited { .. } | ShellOutputEnd::Closed => {}
        }
    }
}

impl Feed for ShellOutputStream {
    type Emission = TerminalOutputFrame;

    fn next<'a>(
        &'a mut self,
        gate: &'a dyn SendGate,
    ) -> BoxFuture<'a, Result<Option<TerminalOutputFrame>, HandlerError>> {
        Box::pin(async move { Ok(self.next_frame(gate).await) })
    }
}

impl Drop for ShellOutputStream {
    fn drop(&mut self) {
        self.source
            .end_output_subscription(self.subscription_id, self.transport_id);
    }
}

fn attached<const MIN: usize>(bytes: Bytes) -> AttachedBytes<MIN, MAX_ONE_ATTACHMENT_BYTES> {
    AttachedBytes::new(bytes).expect("a piece is cut to one attachment and is never empty here")
}

fn byte_count(length: usize) -> u64 {
    u64::try_from(length).expect("a length fits in 64 bits")
}

fn offset(cursor: u64) -> OutputOffset {
    OutputOffset::new(cursor).expect("a shell's output offset stays a safe integer")
}

fn frame(changes: Vec<TerminalOutputChange>, is_dropped: bool) -> TerminalOutputFrame {
    TerminalOutputFrame {
        changes: BoundedVec::new(changes).expect("a frame carries one to three changes"),
        dropped: is_dropped.then_some(BoolLiteral),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use futures::FutureExt as _;
    use futures::future::BoxFuture;
    use sidekicks_contracts::jsonrpc::framing::MAX_ONE_ATTACHMENT_BYTES;
    use sidekicks_contracts::jsonrpc::streaming::SubscriptionId;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::terminal::{TerminalId, TerminalOutputChange, TerminalOutputFrame};
    use sidekicks_contracts::wire::integer::SafeInt;
    use sidekicks_terminal::ScrollbackRead;
    use tokio::sync::watch;

    use super::{ShellOutputEnd, ShellOutputSource, ShellOutputStream};
    use crate::ipc::registry::TransportId;
    use crate::ipc::stream::feed::{CreditGate, Feed};
    use crate::pty::control_lease::LeaseReading;
    use crate::pty::shell::resize::ShellSize;

    /// A shell's window: its bytes and the output offset it ends at.
    struct FakeShell {
        session_id: SessionId,
        terminal_id: TerminalId,
        window: Mutex<(Vec<u8>, u64)>,
        is_behind: AtomicBool,
    }

    impl FakeShell {
        fn new(window: Vec<u8>) -> Arc<Self> {
            let end = window.len() as u64;
            Arc::new(Self {
                session_id: SessionId::new("0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c9d0e")
                    .expect("a session id"),
                terminal_id: TerminalId::new("terminal-1".to_owned()).expect("a terminal id"),
                window: Mutex::new((window, end)),
                is_behind: AtomicBool::new(false),
            })
        }

        fn append(&self, output: &[u8]) {
            let mut window = self.window.lock().expect("the window locks");
            window.0.extend_from_slice(output);
            window.1 += output.len() as u64;
        }

        // Drops the window's oldest bytes, as a full window does.
        fn trim_to(&self, kept: usize) {
            let mut window = self.window.lock().expect("the window locks");
            let cut = window.0.len() - kept;
            window.0.drain(..cut);
        }
    }

    impl ShellOutputSource for FakeShell {
        fn session_id(&self) -> &SessionId {
            &self.session_id
        }

        fn terminal_id(&self) -> &TerminalId {
            &self.terminal_id
        }

        fn read_holder(&self) -> BoxFuture<'_, LeaseReading> {
            async {
                LeaseReading {
                    holder: None,
                    lease_version: SafeInt::ZERO,
                }
            }
            .boxed()
        }

        fn read_window(&self) -> ScrollbackRead {
            let window = self.window.lock().expect("the window locks");
            ScrollbackRead {
                bytes: window.0.clone(),
                output_offset: window.1,
            }
        }

        fn read_output_after(&self, offset: u64, max: usize) -> Option<Vec<u8>> {
            let window = self.window.lock().expect("the window locks");
            let start = window.1 - window.0.len() as u64;
            if offset < start || offset > window.1 {
                return None;
            }
            let skip = usize::try_from(offset - start).expect("a skip fits");
            Some(window.0[skip..].iter().copied().take(max).collect())
        }

        fn size(&self) -> ShellSize {
            ShellSize {
                columns: 80,
                rows: 24,
            }
        }

        fn is_connection_behind(&self, _transport_id: TransportId) -> bool {
            self.is_behind.load(Ordering::SeqCst)
        }

        fn end_output_subscription(&self, _: SubscriptionId, _: TransportId) {}
    }

    fn stream_of(
        shell: &Arc<FakeShell>,
        progress: &watch::Sender<ShellOutputEnd>,
        after_offset: Option<u64>,
    ) -> ShellOutputStream {
        ShellOutputStream::new(
            Arc::clone(shell) as Arc<dyn ShellOutputSource>,
            SubscriptionId::new("0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c9d0f").expect("a subscription id"),
            TransportId(1),
            progress.subscribe(),
            after_offset,
        )
    }

    async fn next_frame(stream: &mut ShellOutputStream) -> TerminalOutputFrame {
        let gate = CreditGate::with_credit(1);
        tokio::time::timeout(Duration::from_secs(5), stream.next(&gate))
            .await
            .expect("a frame comes in time")
            .expect("the read succeeds")
            .expect("the stream goes on")
    }

    // Each change's kind, byte count and cursor.
    fn shape(frame: &TerminalOutputFrame) -> Vec<(&'static str, usize, u64)> {
        frame
            .changes
            .as_ref()
            .iter()
            .map(|change| match change {
                TerminalOutputChange::Scrollback { data, cursor, .. } => {
                    ("scrollback", data.as_bytes().len(), cursor.get())
                }
                TerminalOutputChange::ScrollbackContinuation { data, cursor, .. } => {
                    ("continuation", data.as_bytes().len(), cursor.get())
                }
                TerminalOutputChange::Output { data, cursor, .. } => {
                    ("output", data.as_bytes().len(), cursor.get())
                }
                TerminalOutputChange::Exited { cursor, .. } => ("exited", 0, cursor.get()),
            })
            .collect()
    }

    #[tokio::test]
    async fn a_window_past_one_attachment_splits_and_a_reconnect_resumes_after_its_offset() {
        let total = MAX_ONE_ATTACHMENT_BYTES + 10;
        let shell = FakeShell::new(vec![b'x'; total]);
        let progress = watch::Sender::new(ShellOutputEnd::Running);
        let mut stream = stream_of(&shell, &progress, None);
        let total = total as u64;
        let max = MAX_ONE_ATTACHMENT_BYTES;

        let opening = next_frame(&mut stream).await;
        assert_eq!(shape(&opening), [("scrollback", max, max as u64)]);
        assert!(opening.dropped.is_none());
        assert_eq!(
            shape(&next_frame(&mut stream).await),
            [("continuation", 10, total)]
        );

        shell.append(b"abc");
        progress.send_modify(|_| {});
        assert_eq!(
            shape(&next_frame(&mut stream).await),
            [("output", 3, total + 3)]
        );

        // A watcher that reconnects at the window's old end gets only what came after it.
        let mut resumed = stream_of(&shell, &progress, Some(total));
        assert_eq!(
            shape(&next_frame(&mut resumed).await),
            [("output", 3, total + 3)]
        );
    }

    #[tokio::test]
    async fn a_watcher_whose_output_went_by_gets_the_drop_mark_and_a_fresh_scrollback() {
        let shell = FakeShell::new(b"hello".to_vec());
        let progress = watch::Sender::new(ShellOutputEnd::Running);
        let mut stream = stream_of(&shell, &progress, None);
        assert_eq!(
            shape(&next_frame(&mut stream).await),
            [("scrollback", 5, 5)]
        );

        // The window moved past the watcher's cursor.
        shell.append(b" world");
        shell.trim_to(5);
        progress.send_modify(|_| {});
        let reseeded = next_frame(&mut stream).await;
        assert!(reseeded.dropped.is_some());
        assert_eq!(shape(&reseeded), [("scrollback", 5, 11)]);

        // The connection declared itself behind while output passed it; once caught up it is
        // reseeded, and an exit already come rides the fresh window.
        shell.is_behind.store(true, Ordering::SeqCst);
        shell.append(b"!");
        progress.send_modify(|_| {});
        let gate = CreditGate::with_credit(1);
        assert!(
            tokio::time::timeout(Duration::from_millis(100), stream.next(&gate))
                .await
                .is_err(),
            "a watcher behind is sent nothing"
        );
        shell.is_behind.store(false, Ordering::SeqCst);
        progress.send_replace(ShellOutputEnd::Exited {
            exit_code: sidekicks_contracts::command::ExitCode::new(0).expect("an exit code"),
            cursor: 12,
        });
        let caught_up = next_frame(&mut stream).await;
        assert!(caught_up.dropped.is_some());
        assert_eq!(
            shape(&caught_up),
            [("scrollback", 6, 12), ("exited", 0, 12)]
        );
        assert!(
            stream
                .next(&CreditGate::with_credit(1))
                .await
                .expect("the read succeeds")
                .is_none()
        );
    }
}
