//! The writes to a shell over one client, in one queue per shell that every pane typing into it
//! shares. At most `TERMINAL_WRITES_WAITING_PER_SHELL` of them wait for an answer; a pane's keys
//! typed past that are joined into later writes of at most `TERMINAL_WRITE_MAX_BYTES`, never with
//! another pane's, and every pane's writes leave in the order they were typed. An interrupt, quit
//! or suspend key goes at once, with every write queued before it, while fewer than
//! `TERMINAL_WRITES_WAITING_LIMIT` wait, so order holds and the daemon decides whether the key is
//! a signal. A paste goes in parts of at most the byte cap, each whole and never joined with keys.
//! What the daemon answers a write is told to the pane that typed it.

use std::collections::{HashMap, VecDeque};
use std::error::Error;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};

use sidekicks_contracts::jsonrpc::streaming::SubscriptionId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::terminal::{
    TERMINAL_WRITE_MAX_BYTES, TERMINAL_WRITES_WAITING_LIMIT, TERMINAL_WRITES_WAITING_PER_SHELL,
    TerminalId, TerminalWrite, TerminalWriteRequest,
};
use sidekicks_contracts::wire::id::ClientUuid;
use tokio::runtime::Handle;
use tokio::sync::mpsc;
use uuid::Uuid;

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

/// What a pane is told of its writes, in the order the daemon answered them.
#[derive(Debug)]
pub enum WriteNotice {
    /// The daemon or the client refused one of the pane's writes.
    Refused(ClientError),
    /// The daemon took a write of the pane's: told for its first and for the first after a
    /// refusal, so a refusal the pane drew can be cleared.
    Taken,
}

/// One pane's input to one shell, typed into from any thread: a handle onto the queue its client
/// holds for that shell, which every other pane's handle to the shell over that client shares.
/// Dropping it drops the keys and pastes it queued and has not sent and ends its notices, while
/// the writes it sent count until they are answered.
pub struct ShellInput {
    queue: Arc<ShellQueue>,
    pane: Arc<Pane>,
}

/// The shells' write queues a client holds, by session and shell, each kept while a handle or a
/// write waiting for its answer holds it.
#[derive(Default)]
pub(crate) struct ShellQueues {
    /// Each shell's queue, held weakly so it goes with its last holder.
    queues: Mutex<HashMap<ShellKey, Weak<ShellQueue>>>,
}

/// The session and shell a queue writes to.
type ShellKey = (SessionId, TerminalId);

/// One shell's writes over one client: what every pane's handle and every write waiting for its
/// answer share.
struct ShellQueue {
    client: JsonRpcClient,
    key: ShellKey,
    /// The runtime each write's answer is awaited on.
    runtime: Handle,
    state: Mutex<QueueState>,
}

/// The writes waiting for an answer, and what every pane queued and has not sent.
#[derive(Default)]
struct QueueState {
    /// The writes sent and not yet answered, from every pane.
    waiting: usize,
    /// What waits to be sent, oldest first.
    queued: VecDeque<QueuedWrite>,
    /// How many writes were sent, which numbers each one.
    sent_count: u64,
}

/// One write waiting to be sent, and the pane that typed it.
struct QueuedWrite {
    pane: Arc<Pane>,
    write: PaneWrite,
}

/// What a pane queued: a run of typed keys, or one part of a paste as it was cut.
enum PaneWrite {
    Keys(String),
    PastePart {
        data: String,
        paste_id: ClientUuid,
        is_last_part: bool,
    },
}

/// One pane's handle as its queued writes and the answers to its sent ones reach it.
struct Pane {
    output_subscription_id: SubscriptionId,
    notices: mpsc::Sender<WriteNotice>,
    answers: Mutex<PaneAnswers>,
}

/// Where the answers told to a pane stand.
struct PaneAnswers {
    /// The number of the newest write whose answer was read.
    newest: u64,
    /// Whether the pane has had no write taken since it opened or since its last refusal.
    awaits_taken: bool,
}

impl ShellInput {
    /// A pane's input to `target` over `client`, on the queue every handle to that shell over the
    /// same client shares, and the receiver of what the pane is told of its writes. Must be called
    /// inside a tokio runtime: every write's answer is awaited on that runtime, so a write needs
    /// it running, while [`ShellInput::type_keys`] and [`ShellInput::paste`] may be called from
    /// any thread.
    pub fn open(
        client: &JsonRpcClient,
        target: ShellTarget,
    ) -> (Self, mpsc::Receiver<WriteNotice>) {
        // A pane that stops reading what it is told loses each notice past this many, with a log
        // line.
        let (notices, receiver) = mpsc::channel(TERMINAL_WRITES_WAITING_LIMIT);
        let queue = client
            .shell_queues()
            .queue_for(client, (target.session_id, target.terminal_id));
        let pane = Arc::new(Pane {
            output_subscription_id: target.output_subscription_id,
            notices,
            answers: Mutex::new(PaneAnswers {
                newest: 0,
                awaits_taken: true,
            }),
        });
        (Self { queue, pane }, receiver)
    }

    /// Types `keys`: sent now while the window has room, otherwise joined with this pane's keys
    /// before them and sent in order as answers return.
    pub fn type_keys(&self, keys: &str) {
        if keys.is_empty() {
            return;
        }
        let mut state = self.queue.lock();
        if let Some(typed) = state
            .queued
            .back_mut()
            .and_then(|queued| queued.keys_of(&self.pane))
        {
            typed.push_str(keys);
        } else {
            state.queued.push_back(QueuedWrite {
                pane: Arc::clone(&self.pane),
                write: PaneWrite::Keys(keys.to_owned()),
            });
        }
        self.queue.send_what_fits(&mut state);
    }

    /// Pastes `text` as one paste: parts of at most `TERMINAL_WRITE_MAX_BYTES`, cut at character
    /// boundaries, all naming one paste id minted here, each sent whole and in order with every
    /// write before and after it.
    pub fn paste(&self, text: &str) {
        if text.is_empty() {
            return;
        }
        let paste_id = mint_paste_id();
        let mut state = self.queue.lock();
        let mut rest = text;
        while !rest.is_empty() {
            let (part, later) = rest.split_at(rest.floor_char_boundary(TERMINAL_WRITE_MAX_BYTES));
            state.queued.push_back(QueuedWrite {
                pane: Arc::clone(&self.pane),
                write: PaneWrite::PastePart {
                    data: part.to_owned(),
                    paste_id: paste_id.clone(),
                    is_last_part: later.is_empty(),
                },
            });
            rest = later;
        }
        self.queue.send_what_fits(&mut state);
    }
}

impl Drop for ShellInput {
    fn drop(&mut self) {
        let mut state = self.queue.lock();
        state
            .queued
            .retain(|queued| !Arc::ptr_eq(&queued.pane, &self.pane));
    }
}

impl ShellQueues {
    /// The queue for `key` over `client`, made when none is held.
    fn queue_for(&self, client: &JsonRpcClient, key: ShellKey) -> Arc<ShellQueue> {
        let mut queues = lock(&self.queues);
        if let Some(queue) = queues.get(&key).and_then(Weak::upgrade) {
            return queue;
        }
        let queue = Arc::new(ShellQueue {
            client: client.clone(),
            key: key.clone(),
            runtime: Handle::current(),
            state: Mutex::default(),
        });
        queues.insert(key, Arc::downgrade(&queue));
        queue
    }
}

impl ShellQueue {
    /// Sends queued writes in order while the window has room: through the last run of keys
    /// carrying a signal key while fewer than the daemon's limit wait, the rest while fewer than
    /// the client's own figure wait. A run of keys goes in writes of at most
    /// `TERMINAL_WRITE_MAX_BYTES`, cut at a character boundary; a paste's part goes as it was cut.
    fn send_what_fits(self: &Arc<Self>, state: &mut QueueState) {
        loop {
            let urgent = state
                .queued
                .iter()
                .rposition(QueuedWrite::carries_signal_key);
            let room = if urgent.is_some() {
                TERMINAL_WRITES_WAITING_LIMIT
            } else {
                TERMINAL_WRITES_WAITING_PER_SHELL
            };
            if state.waiting >= room {
                return;
            }
            let Some(mut next) = state.queued.pop_front() else {
                return;
            };
            if let PaneWrite::Keys(typed) = &mut next.write {
                // Every signal key is one byte, so the byte after the last ends the urgent keys.
                let end = if urgent == Some(0) {
                    typed
                        .rfind(SIGNAL_KEYS)
                        .map_or(typed.len(), |index| index + 1)
                } else {
                    typed.len()
                };
                let cut = typed.floor_char_boundary(end.min(TERMINAL_WRITE_MAX_BYTES));
                if cut < typed.len() {
                    let rest = typed.split_off(cut);
                    state.queued.push_front(QueuedWrite {
                        pane: Arc::clone(&next.pane),
                        write: PaneWrite::Keys(rest),
                    });
                }
            }
            state.waiting += 1;
            state.sent_count += 1;
            self.send(next, state.sent_count);
        }
    }

    /// Sends one write now, so writes leave in the order they were cut, and awaits its answer on
    /// its own task; the answer is told to the pane that typed it while that pane's handle is
    /// open.
    fn send(self: &Arc<Self>, next: QueuedWrite, sequence: u64) {
        let session_id = self.key.0;
        let terminal_id = self.key.1.clone();
        let output_subscription_id = next.pane.output_subscription_id;
        let request = match next.write {
            PaneWrite::Keys(data) => TerminalWriteRequest::Keys {
                session_id,
                terminal_id,
                output_subscription_id,
                data,
            },
            PaneWrite::PastePart {
                data,
                paste_id,
                is_last_part,
            } => TerminalWriteRequest::Paste {
                session_id,
                terminal_id,
                output_subscription_id,
                data,
                paste_id,
                is_last_part,
            },
        };
        let answer = self.client.call::<TerminalWrite>(&request);
        let queue = Arc::clone(self);
        let pane = Arc::downgrade(&next.pane);
        self.runtime.spawn(async move {
            let failure = answer.await.err();
            {
                let mut state = queue.lock();
                state.waiting -= 1;
                queue.send_what_fits(&mut state);
            }
            // A pane whose handle was closed has no one left to tell.
            if let Some(pane) = pane.upgrade() {
                pane.tell(sequence, failure);
            }
        });
    }

    fn lock(&self) -> MutexGuard<'_, QueueState> {
        lock(&self.state)
    }
}

impl Drop for ShellQueue {
    fn drop(&mut self) {
        let mut queues = lock(&self.client.shell_queues().queues);
        // A queue made for the shell since this one's last holder went keeps its place.
        if queues
            .get(&self.key)
            .is_some_and(|held| held.strong_count() == 0)
        {
            queues.remove(&self.key);
        }
    }
}

impl QueuedWrite {
    /// The keys of a run `pane` typed, which its next keys join.
    fn keys_of(&mut self, pane: &Arc<Pane>) -> Option<&mut String> {
        match &mut self.write {
            PaneWrite::Keys(typed) if Arc::ptr_eq(&self.pane, pane) => Some(typed),
            PaneWrite::Keys(_) | PaneWrite::PastePart { .. } => None,
        }
    }

    /// Whether this is a run of keys holding an interrupt, quit or suspend key; a paste's text is
    /// never sent as a signal.
    fn carries_signal_key(&self) -> bool {
        matches!(&self.write, PaneWrite::Keys(typed) if typed.contains(SIGNAL_KEYS))
    }
}

impl Pane {
    /// Tells the pane of the answer to its write numbered `sequence`: each refusal, and a take it
    /// awaits. An answer older than one already read changes nothing, since the newer one stands.
    fn tell(&self, sequence: u64, failure: Option<ClientError>) {
        let notice = {
            let mut answers = lock(&self.answers);
            if sequence < answers.newest {
                return;
            }
            answers.newest = sequence;
            match failure {
                Some(failure) => {
                    answers.awaits_taken = true;
                    WriteNotice::Refused(failure)
                }
                None if answers.awaits_taken => {
                    answers.awaits_taken = false;
                    WriteNotice::Taken
                }
                None => return,
            }
        };
        let Err(
            mpsc::error::TrySendError::Full(notice) | mpsc::error::TrySendError::Closed(notice),
        ) = self.notices.try_send(notice)
        else {
            return;
        };
        match notice {
            WriteNotice::Refused(failure) => tracing::warn!(
                error = &failure as &(dyn Error + 'static),
                "A refused write to a shell went untold: its pane is not reading its answers"
            ),
            WriteNotice::Taken => tracing::warn!(
                "A write to a shell taken after a refusal went untold: its pane is not reading its \
                 answers"
            ),
        }
    }
}

/// A paste's id, minted once where the paste is cut into parts.
fn mint_paste_id() -> ClientUuid {
    #[expect(
        clippy::disallowed_methods,
        reason = "a paste id is an ephemeral token no row or event stores"
    )]
    let id = Uuid::now_v7();
    ClientUuid::new(id.to_string()).expect("a version 7 UUID is a client UUID")
}

/// The mutex's guard, a poisoned one included: each holder leaves the state whole.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
