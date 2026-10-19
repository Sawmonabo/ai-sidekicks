//! One shell's input on its way in: each typed write and paste part admitted under the shell's
//! lease in the order the calls came and handed to its terminal at once, the screen copy's answers
//! held behind an open marked paste, and each connection's writes counted while they wait for the
//! terminal's write queue, so a connection's write past [`TERMINAL_WRITES_WAITING_LIMIT`] of them
//! is refused.

use std::collections::HashMap;
use std::error::Error;
use std::sync::{Arc, Mutex, MutexGuard};

use bytes::Bytes;
use futures::future::BoxFuture;
use serde_json::json;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::jsonrpc::streaming::SubscriptionId;
use sidekicks_contracts::method_descriptor::NullPayload;
use sidekicks_contracts::terminal::{TERMINAL_WRITES_WAITING_LIMIT, TerminalId};
use sidekicks_terminal::TerminalWriteError;
use tokio::runtime::Handle;

use crate::ipc::domain_error::DomainError;
use crate::ipc::registry::{HandlerError, TransportId};
use crate::pty::control_lease::{ShellControlLease, ShellLeaseCaller, ShellWriter, WriteAdmission};
use crate::pty::shell::paste::{PasteInput, ShellPastePart, ShellPastes};
use crate::pty::shell::refusals::terminal_not_found;

/// Hands bytes to a shell's terminal at once, behind every write before them, answering a future
/// that resolves once the terminal's write queue takes them; the shell table passes
/// `Terminals::queue_write` for its shell, a terminal no longer tracked answering `Closed`. It runs
/// under the shell's lease lock, so it never blocks.
pub(crate) type QueueTerminalWrite =
    Box<dyn Fn(Bytes) -> BoxFuture<'static, Result<(), TerminalWriteError>> + Send + Sync>;

/// What a shell's input calls out to. Each runs under the shell's lease lock or its pastes' lock,
/// so none may block or take either.
pub(crate) struct ShellInputHooks {
    /// Hands a write to the terminal.
    pub(crate) queue_write: QueueTerminalWrite,
    /// Hands an answer to the program to the terminal, as `TerminalAnswers::queue` does.
    pub(crate) queue_answer: Box<dyn Fn(Bytes) + Send + Sync>,
    /// Whether the program asked for pasted text to be marked as pasted, read from the screen copy.
    pub(crate) is_bracketed_paste_requested: Box<dyn Fn() -> bool + Send + Sync>,
}

/// What one write puts on a shell's input.
pub(crate) enum ShellWriteInput {
    /// Typed text.
    Keys(String),
    /// One part of a paste.
    Paste(ShellPastePart),
}

/// One shell's input: its lease, its terminal's intake and answers, its open paste, and how many
/// writes each connection has waiting on it.
pub(crate) struct ShellInput {
    terminal_id: TerminalId,
    lease: Arc<ShellControlLease>,
    hooks: ShellInputHooks,
    /// Taken after the screen copy's lock wherever both are held, since the screen's answers reach
    /// it under that lock.
    pastes: Mutex<ShellPastes>,
    /// How many writes each connection has waiting for the terminal's write queue.
    waiting_writes: Mutex<HashMap<TransportId, usize>>,
    /// The daemon's runtime, which a paste's close started from a drop runs on.
    runtime: Handle,
}

impl ShellInput {
    /// The input of the shell `terminal_id`, admitted under `lease` and handed on through `hooks`,
    /// its unawaited work running on `runtime`.
    pub(crate) fn new(
        terminal_id: TerminalId,
        lease: Arc<ShellControlLease>,
        hooks: ShellInputHooks,
        runtime: Handle,
    ) -> Arc<Self> {
        Arc::new(Self {
            terminal_id,
            lease,
            hooks,
            pastes: Mutex::new(ShellPastes::default()),
            waiting_writes: Mutex::new(HashMap::new()),
            runtime,
        })
    }

    /// Admits one write from `caller` without waiting: counts it among its connection's writes
    /// waiting on the shell, refusing it `terminal.write.limitReached` when
    /// [`TERMINAL_WRITES_WAITING_LIMIT`] already wait, then hands it to the lease, which keeps the
    /// order of the calls and refuses it as `ShellControlLease::admit_write` does. A lone key goes
    /// to the terminal here too, where it may go as its signal.
    pub(crate) fn admit_write(
        self: &Arc<Self>,
        caller: ShellLeaseCaller,
        input: ShellWriteInput,
    ) -> Result<AdmittedShellWrite, DomainError> {
        let waiting = self.count_waiting(caller.connection.transport_id)?;
        let shell = Arc::clone(self);
        let admission = self
            .lease
            .admit_write(&ShellWriter::Device(caller), move || shell.hand_over(input))?;
        Ok(AdmittedShellWrite {
            terminal_id: self.terminal_id.clone(),
            admission,
            _waiting: waiting,
        })
    }

    /// Hands an answer to the program on to the terminal, held until the end mark of an open
    /// marked paste; the screen copy's listener calls it under the screen's lock.
    pub(crate) fn answer(&self, answer: Bytes) {
        if let Some(answer) = self.lock_pastes().hold_answer(answer) {
            (self.hooks.queue_answer)(answer);
        }
    }

    /// Closes the paste the pane `output_subscription_id` left open, once that pane has ended, so
    /// the program is never left inside it.
    pub(crate) fn close_paste_of(&self, output_subscription_id: SubscriptionId) {
        let mut pastes = self.lock_pastes();
        let closing = pastes.close_for(output_subscription_id);
        self.queue_unawaited(closing, "a paste its pane left unfinished");
    }

    /// Closes the open paste whichever pane it came through, as the shell changes holder, so the
    /// new holder's keys never land inside it.
    pub(crate) fn close_open_paste(&self) {
        let mut pastes = self.lock_pastes();
        let closing = pastes.close_all();
        self.queue_unawaited(closing, "a paste open as its holder changed");
    }

    /// Forgets the open paste and the answers it held, for a shell that takes no more input.
    pub(crate) fn clear_pastes(&self) {
        self.lock_pastes().clear();
    }

    /// Puts a paste's close on the terminal's input, called under the pastes' lock so no answer
    /// lands between them; no caller waits on it, so its failure goes to the service log.
    fn queue_unawaited(&self, closing: Option<PasteInput>, what: &'static str) {
        let Some(closing) = closing else {
            return;
        };
        let taken = (self.hooks.queue_write)(closing.bytes);
        for answer in closing.held_answers {
            (self.hooks.queue_answer)(answer);
        }
        let terminal_id = self.terminal_id.clone();
        self.runtime.spawn(async move {
            if let Err(error) = taken.await {
                tracing::warn!(
                    terminal = terminal_id.as_str(),
                    what,
                    error = &error as &(dyn Error + 'static),
                    "a shell could not close a paste"
                );
            }
        });
    }

    /// Puts one admitted write on the terminal's input, a paste part with the close of a paste it
    /// displaces and the answers that waited for an end mark, under the pastes' lock so no answer
    /// lands between them; answers the take of the write's own bytes.
    fn hand_over(
        &self,
        input: ShellWriteInput,
    ) -> BoxFuture<'static, Result<(), TerminalWriteError>> {
        match input {
            ShellWriteInput::Keys(text) => (self.hooks.queue_write)(Bytes::from(text)),
            ShellWriteInput::Paste(part) => {
                let is_bracketed = (self.hooks.is_bracketed_paste_requested)();
                let mut pastes = self.lock_pastes();
                let mut taken = None;
                for input in pastes.encode_part(part, is_bracketed) {
                    taken = Some((self.hooks.queue_write)(input.bytes));
                    for answer in input.held_answers {
                        (self.hooks.queue_answer)(answer);
                    }
                }
                taken.expect("a part always puts its own bytes last")
            }
        }
    }

    /// Counts one more write of the connection `transport_id` as waiting, refusing it once
    /// [`TERMINAL_WRITES_WAITING_LIMIT`] already wait.
    fn count_waiting(
        self: &Arc<Self>,
        transport_id: TransportId,
    ) -> Result<WaitingWrite, DomainError> {
        let mut waiting_writes = self.lock_waiting_writes();
        let waiting = waiting_writes.entry(transport_id).or_default();
        if *waiting >= TERMINAL_WRITES_WAITING_LIMIT {
            return Err(DomainError::new(
                format!(
                    "{TERMINAL_WRITES_WAITING_LIMIT} writes of this connection already wait on \
                     shell {}",
                    self.terminal_id.as_str()
                ),
                RefusalCode::TerminalWriteLimitReached,
            )
            .with_detail(json!({
                "terminalId": self.terminal_id,
                "limit": TERMINAL_WRITES_WAITING_LIMIT,
            })));
        }
        *waiting += 1;
        Ok(WaitingWrite {
            shell: Arc::clone(self),
            transport_id,
        })
    }

    fn lock_pastes(&self) -> MutexGuard<'_, ShellPastes> {
        self.pastes
            .lock()
            .expect("no panic holds a shell's pastes, since a panic ends the daemon")
    }

    fn lock_waiting_writes(&self) -> MutexGuard<'_, HashMap<TransportId, usize>> {
        self.waiting_writes
            .lock()
            .expect("no panic holds a shell's write counts, since a panic ends the daemon")
    }
}

/// One write counted as waiting on its shell until the terminal's write queue answers it or its
/// call ends; dropping it counts it off.
struct WaitingWrite {
    shell: Arc<ShellInput>,
    transport_id: TransportId,
}

impl Drop for WaitingWrite {
    fn drop(&mut self) {
        let mut waiting_writes = self.shell.lock_waiting_writes();
        if let Some(waiting) = waiting_writes.get_mut(&self.transport_id) {
            *waiting -= 1;
            if *waiting == 0 {
                waiting_writes.remove(&self.transport_id);
            }
        }
    }
}

/// A write past its admission step, counted as waiting until it is answered.
pub(crate) struct AdmittedShellWrite {
    terminal_id: TerminalId,
    admission: WriteAdmission<BoxFuture<'static, Result<(), TerminalWriteError>>>,
    _waiting: WaitingWrite,
}

impl AdmittedShellWrite {
    /// Answers once the terminal's write queue takes the write. Fails with a refusal the write met
    /// in line, `terminal.notFound` once the shell closed, and as a fault when the system refused
    /// the write; a write to a shell whose program has exited goes nowhere and is answered.
    pub(crate) async fn answered(self) -> Result<NullPayload, HandlerError> {
        let taken = self.admission.admitted().await?;
        match taken.await {
            Ok(()) => Ok(NullPayload),
            Err(TerminalWriteError::Closed) => Err(terminal_not_found(&self.terminal_id).into()),
            Err(TerminalWriteError::Ended) => {
                tracing::debug!(
                    terminal = self.terminal_id.as_str(),
                    "a write came after the shell's program exited, so it goes nowhere"
                );
                Ok(NullPayload)
            }
            Err(error @ TerminalWriteError::Failed(_)) => Err(HandlerError::Internal(
                Box::new(error) as Box<dyn Error + Send + Sync>,
            )),
        }
    }
}

#[cfg(test)]
mod tests;
