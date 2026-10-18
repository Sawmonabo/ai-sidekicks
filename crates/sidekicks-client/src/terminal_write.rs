//! A pane's typing into one shell. At most `TERMINAL_WRITES_WAITING_PER_SHELL` writes wait for an
//! answer; keys typed past that are joined into later writes of at most `TERMINAL_WRITE_MAX_BYTES`,
//! sent in order as answers return. An interrupt, quit or suspend key goes at once, joined with the
//! keys typed before it, while fewer than `TERMINAL_WRITES_WAITING_LIMIT` writes wait, so order
//! holds and the daemon decides whether the key is a signal.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use sidekicks_contracts::jsonrpc::streaming::SubscriptionId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::terminal::{
    TERMINAL_WRITE_MAX_BYTES, TERMINAL_WRITES_WAITING_LIMIT, TERMINAL_WRITES_WAITING_PER_SHELL,
    TerminalId, TerminalWrite, TerminalWriteRequest,
};
use tokio::sync::mpsc;

use crate::error::ClientError;
use crate::transport::json_rpc::JsonRpcClient;

/// The keys a shell's terminal may turn into a signal: interrupt (Ctrl-C), quit (Ctrl-\) and
/// suspend (Ctrl-Z).
const SIGNAL_KEYS: [char; 3] = ['\u{3}', '\u{1c}', '\u{1a}'];

/// The shell a pane types into, and the pane's own output subscription its writes are bound to.
#[derive(Clone, Debug)]
pub struct ShellTarget {
    /// The session.
    pub session_id: SessionId,
    /// The shell.
    pub terminal_id: TerminalId,
    /// The pane's `terminal.output.subscribe` feed of that shell.
    pub output_subscription_id: SubscriptionId,
}

/// One pane's input to one shell. Each write that fails is sent on the receiver [`ShellInput::new`]
/// returns beside it.
pub struct ShellInput {
    input: Arc<WriteWindow>,
}

/// What the writes in flight and their answers share.
struct WriteWindow {
    client: JsonRpcClient,
    target: ShellTarget,
    state: Mutex<WindowState>,
    failures: mpsc::Sender<ClientError>,
}

/// The writes waiting for an answer, and the keys typed and not yet sent.
#[derive(Default)]
struct WindowState {
    waiting: usize,
    typed: String,
}

impl ShellInput {
    /// The input to `target` over `client`, and the receiver of its failed writes. Must be called
    /// inside a tokio runtime, which each write's answer is awaited on.
    pub fn new(client: JsonRpcClient, target: ShellTarget) -> (Self, mpsc::Receiver<ClientError>) {
        // Each write in flight fails at most once, so the window bounds the failures held.
        let (failures, failed_writes) = mpsc::channel(TERMINAL_WRITES_WAITING_LIMIT);
        let input = Arc::new(WriteWindow {
            client,
            target,
            state: Mutex::new(WindowState::default()),
            failures,
        });
        (Self { input }, failed_writes)
    }

    /// Types `keys`: sent now while the window has room, otherwise joined with the keys before
    /// them and sent as answers return.
    pub fn type_keys(&self, keys: &str) {
        let mut state = self.input.lock();
        state.typed.push_str(keys);
        self.input.send_what_fits(&mut state);
    }
}

impl WriteWindow {
    /// Sends typed keys while the window has room: up to and through the last signal key while
    /// fewer than the daemon's limit wait, the rest while fewer than the client's own figure wait.
    /// Each write takes at most `TERMINAL_WRITE_MAX_BYTES`, cut at a character boundary.
    fn send_what_fits(self: &Arc<Self>, state: &mut WindowState) {
        while !state.typed.is_empty() {
            // Every signal key is one byte, so the byte after it ends the urgent keys.
            let urgent_end = state.typed.rfind(SIGNAL_KEYS).map_or(0, |index| index + 1);
            let (room, end) = if urgent_end > 0 {
                (TERMINAL_WRITES_WAITING_LIMIT, urgent_end)
            } else {
                (TERMINAL_WRITES_WAITING_PER_SHELL, state.typed.len())
            };
            if state.waiting >= room {
                return;
            }
            let cut = state
                .typed
                .floor_char_boundary(end.min(TERMINAL_WRITE_MAX_BYTES));
            let data: String = state.typed.drain(..cut).collect();
            state.waiting += 1;
            self.write(data);
        }
    }

    /// Sends one write now, so writes leave in the order they were cut, and awaits its answer on
    /// its own task.
    fn write(self: &Arc<Self>, data: String) {
        let answer = self
            .client
            .call::<TerminalWrite>(&TerminalWriteRequest::Keys {
                session_id: self.target.session_id,
                terminal_id: self.target.terminal_id.clone(),
                output_subscription_id: self.target.output_subscription_id,
                data,
            });
        let window = Arc::clone(self);
        tokio::spawn(async move {
            if let Err(failure) = answer.await
                && let Err(unread) = window.failures.send(failure).await
            {
                tracing::warn!(
                    error = &unread.0 as &(dyn std::error::Error + 'static),
                    "A write to a shell failed after its pane stopped reading failures"
                );
            }
            let mut state = window.lock();
            state.waiting -= 1;
            window.send_what_fits(&mut state);
        });
    }

    fn lock(&self) -> MutexGuard<'_, WindowState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}
