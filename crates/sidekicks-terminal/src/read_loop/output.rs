//! What a shell's output carries to the caller: each chunk as the filter kept it, holding its
//! bytes' room in the output's budget until the caller takes it, then the program's exit.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use bytes::Bytes;
use tokio::sync::{OwnedSemaphorePermit, mpsc};

use crate::exit::TerminalExit;
use crate::read_loop::control::TerminalControl;

/// Takes a shell's output before the screen copy, the scrollback and the caller see it.
pub trait OutputFilter: Send + 'static {
    /// Appends to `kept` what stays of `chunk`; it may hold bytes back for a later chunk.
    fn filter(&mut self, chunk: &[u8], kept: &mut Vec<u8>);

    /// Appends to `kept` what the filter still holds, once the output has ended.
    fn finish(&mut self, kept: &mut Vec<u8>);
}

/// What a shell's output reports to the caller.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TerminalEvent {
    /// A chunk of the shell's output, as the filter kept it.
    Output(Bytes),
    /// The program's exit, after its last output.
    Exit(TerminalExit),
}

/// One chunk on its way to the caller and the room the bytes read for it hold in the output's
/// budget, given back once the caller takes it.
pub(super) struct OutputChunk {
    pub(super) bytes: Bytes,
    pub(super) room: OwnedSemaphorePermit,
}

/// A shell's output, then its exit; nothing is reported once the terminal's close begins.
pub struct TerminalOutput {
    pub(super) chunks: mpsc::UnboundedReceiver<OutputChunk>,
    pub(super) control: Arc<TerminalControl>,
    pub(super) has_yielded_exit: bool,
}

impl TerminalOutput {
    /// The next chunk of output, then the exit once, then `None`; `None` at once when the close
    /// began, which reports no exit.
    pub async fn next(&mut self) -> Option<TerminalEvent> {
        if self.control.is_closing() {
            return None;
        }
        let chunk = self.chunks.recv().await;
        if self.control.is_closing() {
            return None;
        }
        match chunk {
            Some(OutputChunk { bytes, room }) => {
                drop(room);
                if self
                    .control
                    .is_waiting_for_room
                    .swap(false, Ordering::SeqCst)
                {
                    self.control.waker.wake();
                }
                Some(TerminalEvent::Output(bytes))
            }
            None if self.has_yielded_exit => None,
            None => {
                self.has_yielded_exit = true;
                self.control.reported_exit().map(TerminalEvent::Exit)
            }
        }
    }
}

impl Drop for TerminalOutput {
    fn drop(&mut self) {
        // Closed first, so the woken loop finds the output gone and reads on without it.
        self.chunks.close();
        self.control.waker.wake();
    }
}
