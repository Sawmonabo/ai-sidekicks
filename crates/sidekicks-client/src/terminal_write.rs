//! The writes to a shell over one client, in one queue per shell that every pane typing into it
//! shares. At most `TERMINAL_WRITES_WAITING_PER_SHELL` of them wait for an answer; a pane's keys
//! typed past that are joined into later writes of at most `TERMINAL_WRITE_MAX_BYTES`, never with
//! another pane's, and every pane's writes leave in the order they were typed. An interrupt, quit
//! or suspend key goes at once, with every write queued before it, while fewer than
//! `TERMINAL_WRITES_WAITING_LIMIT` wait, so order holds and the daemon decides whether the key is
//! a signal. A paste waits as its one text and goes in parts of at most the byte cap, each cut as
//! the one before leaves, whole and never joined with keys. What the daemon answers a write is
//! told to the pane that typed it. A pane's handle closed hands back, once each write it sent is
//! answered, those the daemon refused because the pane's subscription had ended and then what it
//! had not sent, for the pane to send again on its next handle; a handle finished sends it all,
//! and is done once each write it sent is answered.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::error::Error;
use std::future::Future;
use std::mem;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};

use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::jsonrpc::streaming::SubscriptionId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::terminal::{
    TERMINAL_WRITE_MAX_BYTES, TERMINAL_WRITES_WAITING_LIMIT, TERMINAL_WRITES_WAITING_PER_SHELL,
    TerminalId, TerminalWrite, TerminalWriteRequest,
};
use sidekicks_contracts::wire::id::ClientUuid;
use tokio::runtime::Handle;
use tokio::sync::{mpsc, watch};
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
/// [`ShellInput::close`] stops what it queued and hands it back with what its subscription's end
/// kept from the daemon; [`ShellInput::finish`], or dropping it, lets everything it queued leave
/// in order.
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
    /// Changes after each answer is counted, for a closing or finishing pane to look again.
    answered: watch::Sender<()>,
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

/// What waits to be sent, and the pane that typed it.
struct QueuedWrite {
    pane: Arc<Pane>,
    text: QueuedText,
}

/// A run of typed keys, or a paste's text held once, its next part cut from `sent` as the one
/// before leaves.
enum QueuedText {
    Keys(String),
    Paste {
        text: String,
        /// Where the parts sent so far end, a character boundary.
        sent: usize,
        paste_id: ClientUuid,
        /// Whether `text` runs to the paste's end.
        is_end: bool,
    },
}

/// A pane's write, as it is sent and as a closed handle hands it back: a run of typed keys, or
/// paste text with its paste's id, which goes again as part of that one paste.
#[derive(Debug, PartialEq, Eq)]
pub enum PaneWrite {
    /// Typed keys, joined with the pane's keys beside them.
    Keys(String),
    /// Text of one paste: a part as it was sent, at most `TERMINAL_WRITE_MAX_BYTES`, or the
    /// rest of the paste not yet sent, of any length, cut into parts again as it goes.
    PastePart {
        /// The text.
        data: String,
        /// The paste the text belongs to.
        paste_id: ClientUuid,
        /// Whether the text runs to the paste's end.
        is_last_part: bool,
    },
}

/// One pane's handle as its queued writes and the answers to its sent ones reach it.
struct Pane {
    output_subscription_id: SubscriptionId,
    notices: mpsc::Sender<WriteNotice>,
    answers: Mutex<PaneAnswers>,
    /// Taken after its queue's lock wherever both are held.
    sent: Mutex<PaneSent>,
}

/// A pane's writes sent and not yet answered, and those the daemon refused because the pane's
/// subscription had ended, each by its number.
#[derive(Default)]
struct PaneSent {
    unanswered: BTreeMap<u64, PaneWrite>,
    refused: BTreeMap<u64, PaneWrite>,
    /// Whether the handle was finished, so no close will hand back what is refused.
    is_finished: bool,
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
            sent: Mutex::default(),
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
        self.push(&mut state, QueuedText::Keys(keys.to_owned()));
        self.queue.send_what_fits(&mut state);
    }

    /// Pastes `text` as one paste under one paste id minted here, in order with every write
    /// before and after it: held as this one text, and sent in parts of at most
    /// `TERMINAL_WRITE_MAX_BYTES` cut at character boundaries as the window has room.
    pub fn paste(&self, text: String) {
        if text.is_empty() {
            return;
        }
        let mut state = self.queue.lock();
        self.push(
            &mut state,
            QueuedText::Paste {
                text,
                sent: 0,
                paste_id: mint_paste_id(),
                is_end: true,
            },
        );
        self.queue.send_what_fits(&mut state);
    }

    /// Queues what another handle of the pane handed back at its close, ahead of anything typed
    /// into this one after, each write as it was: keys join this pane's keys before them, and
    /// paste text goes with its paste's id, so the daemon continues that paste.
    pub fn resubmit(&self, unsent: Vec<PaneWrite>) {
        let mut state = self.queue.lock();
        for write in unsent {
            self.push(&mut state, QueuedText::from(write));
        }
        self.queue.send_what_fits(&mut state);
    }

    /// Closes the handle for its subscription's end: what it queued is sent no more, and once
    /// each write it sent is answered the returned future hands back, oldest first, the writes
    /// the daemon refused because the subscription had ended, then what it had not sent, each
    /// paste's text with its paste's id. A write the daemon took is never handed back. Its notices
    /// end with it.
    pub fn close(self) -> impl Future<Output = Vec<PaneWrite>> + Send + 'static {
        let Self { queue, pane } = self;
        let unsent = queue.take_unsent(&pane);
        async move {
            let mut answered = queue.answered.subscribe();
            loop {
                {
                    let mut sent = lock(&pane.sent);
                    if sent.unanswered.is_empty() {
                        let mut handed_back: Vec<PaneWrite> =
                            mem::take(&mut sent.refused).into_values().collect();
                        handed_back.extend(unsent);
                        return handed_back;
                    }
                }
                answered
                    .changed()
                    .await
                    .expect("the queue held here keeps its sender");
            }
        }
    }

    /// Ends the handle and lets everything it queued leave, in order and each paste whole, on the
    /// pane's output subscription, which the caller keeps open until the returned future ends:
    /// once every write of the pane is answered, as a shell or connection gone answers each.
    pub fn finish(self) -> impl Future<Output = ()> + Send + 'static {
        let Self { queue, pane } = self;
        lock(&pane.sent).is_finished = true;
        let mut answered = queue.answered.subscribe();
        async move {
            while queue.holds_writes_of(&pane) {
                answered
                    .changed()
                    .await
                    .expect("the queue held here keeps its sender");
            }
        }
    }

    /// Queues `text` behind everything queued, keys joining this pane's last run of keys.
    fn push(&self, state: &mut QueueState, text: QueuedText) {
        if let QueuedText::Keys(keys) = &text
            && let Some(typed) = state
                .queued
                .back_mut()
                .and_then(|queued| queued.keys_of(&self.pane))
        {
            typed.push_str(keys);
            return;
        }
        state.queued.push_back(QueuedWrite {
            pane: Arc::clone(&self.pane),
            text,
        });
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
            answered: watch::channel(()).0,
        });
        queues.insert(key, Arc::downgrade(&queue));
        queue
    }
}

impl ShellQueue {
    /// Sends queued writes in order while the window has room: through the last run of keys
    /// carrying a signal key while fewer than the daemon's limit wait, the rest while fewer than
    /// the client's own figure wait. Each write is cut off the front of what waits: keys and a
    /// paste's next part at most `TERMINAL_WRITE_MAX_BYTES`, at a character boundary.
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
            let Some(next) = state.queued.front_mut() else {
                return;
            };
            let pane = Arc::clone(&next.pane);
            let (write, is_done) = next.text.cut_next(urgent == Some(0));
            if is_done {
                state.queued.pop_front();
            }
            state.waiting += 1;
            state.sent_count += 1;
            self.send(&pane, write, state.sent_count);
        }
    }

    /// Sends one write now, so writes leave in the order they were cut, keeps it with its pane
    /// until answered, and awaits its answer on its own task; the answer is told to the pane that
    /// typed it, but a refusal for the pane's ended subscription, which keeps the write for the
    /// close to hand back.
    fn send(self: &Arc<Self>, pane: &Arc<Pane>, write: PaneWrite, sequence: u64) {
        let session_id = self.key.0;
        let terminal_id = self.key.1.clone();
        let output_subscription_id = pane.output_subscription_id;
        let request = match write {
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
        // The call writes its request at once, so the text moves back to wait for the answer.
        let answer = self.client.call::<TerminalWrite>(&request);
        let sent = match request {
            TerminalWriteRequest::Keys { data, .. } => PaneWrite::Keys(data),
            TerminalWriteRequest::Paste {
                data,
                paste_id,
                is_last_part,
                ..
            } => PaneWrite::PastePart {
                data,
                paste_id,
                is_last_part,
            },
        };
        lock(&pane.sent).unanswered.insert(sequence, sent);
        let queue = Arc::clone(self);
        let pane = Arc::downgrade(pane);
        self.runtime.spawn(async move {
            let failure = answer.await.err();
            let pane = pane.upgrade();
            let is_kept = {
                let mut state = queue.lock();
                state.waiting -= 1;
                let is_kept = pane
                    .as_ref()
                    .is_some_and(|pane| pane.note_answer(sequence, failure.as_ref()));
                queue.send_what_fits(&mut state);
                is_kept
            };
            queue.answered.send_replace(());
            if is_kept {
                return;
            }
            match pane {
                Some(pane) => pane.tell(sequence, failure),
                None => {
                    if let Some(failure) = failure {
                        tracing::warn!(
                            error = &failure as &(dyn Error + 'static),
                            "A write to a shell was refused after its pane's handle was dropped"
                        );
                    }
                }
            }
        });
    }

    /// Takes `pane`'s writes out of the queue, oldest first, leaving every other pane's.
    fn take_unsent(&self, pane: &Arc<Pane>) -> Vec<PaneWrite> {
        let mut state = self.lock();
        let (unsent, others): (VecDeque<_>, VecDeque<_>) = mem::take(&mut state.queued)
            .into_iter()
            .partition(|queued| Arc::ptr_eq(&queued.pane, pane));
        state.queued = others;
        unsent
            .into_iter()
            .map(|queued| queued.text.into_unsent())
            .collect()
    }

    /// Whether a write of `pane` is queued or waits for its answer.
    fn holds_writes_of(&self, pane: &Arc<Pane>) -> bool {
        let state = self.lock();
        !lock(&pane.sent).unanswered.is_empty()
            || state
                .queued
                .iter()
                .any(|queued| Arc::ptr_eq(&queued.pane, pane))
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
        match &mut self.text {
            QueuedText::Keys(typed) if Arc::ptr_eq(&self.pane, pane) => Some(typed),
            QueuedText::Keys(_) | QueuedText::Paste { .. } => None,
        }
    }

    /// Whether this is a run of keys holding an interrupt, quit or suspend key; a paste's text is
    /// never sent as a signal.
    fn carries_signal_key(&self) -> bool {
        matches!(&self.text, QueuedText::Keys(typed) if typed.contains(SIGNAL_KEYS))
    }
}

impl QueuedText {
    /// Cuts the next write off the front, at most the byte cap at a character boundary: keys up
    /// to and through their last signal key when `is_urgent`, otherwise as many as fit, or a
    /// paste's next part. Answers the write and whether nothing is left.
    fn cut_next(&mut self, is_urgent: bool) -> (PaneWrite, bool) {
        match self {
            Self::Keys(typed) => {
                // Every signal key is one byte, so the byte after the last ends the urgent keys.
                let end = if is_urgent {
                    typed
                        .rfind(SIGNAL_KEYS)
                        .map_or(typed.len(), |index| index + 1)
                } else {
                    typed.len()
                };
                let cut = typed.floor_char_boundary(end.min(TERMINAL_WRITE_MAX_BYTES));
                let rest = typed.split_off(cut);
                let is_done = rest.is_empty();
                (PaneWrite::Keys(mem::replace(typed, rest)), is_done)
            }
            Self::Paste {
                text,
                sent,
                paste_id,
                is_end,
            } => {
                let from = *sent;
                *sent = text.floor_char_boundary(from + TERMINAL_WRITE_MAX_BYTES);
                let is_done = *sent == text.len();
                let part = PaneWrite::PastePart {
                    data: text[from..*sent].to_owned(),
                    paste_id: paste_id.clone(),
                    is_last_part: *is_end && is_done,
                };
                (part, is_done)
            }
        }
    }

    /// What was not sent, as a closed handle hands it back.
    fn into_unsent(self) -> PaneWrite {
        match self {
            Self::Keys(typed) => PaneWrite::Keys(typed),
            Self::Paste {
                mut text,
                sent,
                paste_id,
                is_end,
            } => {
                // In place, so a paste cut late is never held twice.
                text.replace_range(..sent, "");
                PaneWrite::PastePart {
                    data: text,
                    paste_id,
                    is_last_part: is_end,
                }
            }
        }
    }
}

impl From<PaneWrite> for QueuedText {
    fn from(write: PaneWrite) -> Self {
        match write {
            PaneWrite::Keys(typed) => Self::Keys(typed),
            PaneWrite::PastePart {
                data,
                paste_id,
                is_last_part,
            } => Self::Paste {
                text: data,
                sent: 0,
                paste_id,
                is_end: is_last_part,
            },
        }
    }
}

impl Pane {
    /// Notes the answer to the sent write numbered `sequence`, and answers whether the write is
    /// kept for the close to hand back, untold: a refusal because its subscription had ended,
    /// unless the handle was finished and no close will.
    fn note_answer(&self, sequence: u64, failure: Option<&ClientError>) -> bool {
        let mut sent = lock(&self.sent);
        let write = sent
            .unanswered
            .remove(&sequence)
            .expect("each sent write is answered once");
        let is_kept = !sent.is_finished
            && matches!(
                failure,
                Some(ClientError::Remote(refusal))
                    if refusal.is_refusal(RefusalCode::TerminalOutputSubscriptionNotFound)
            );
        if is_kept {
            sent.refused.insert(sequence, write);
        }
        is_kept
    }

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
