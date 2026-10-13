//! The text a provider streams while it writes a reply, a reasoning summary or a plan, handed on as
//! stored pieces of one message: the deltas of each message are joined and sent as one piece per
//! interval, and its final text sends only what the pieces have not yet carried, so every piece
//! of a message, joined in order, is the provider's final text.

use std::mem;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use tokio::task::JoinHandle;

/// The longest a streamed delta waits before it goes out as a piece. A reply of about 1,000 tokens
/// written over 10 s, which a provider may send as about 1,000 deltas, becomes at most 100 stored
/// pieces.
const STREAMED_TEXT_PIECE_INTERVAL: Duration = Duration::from_millis(100);

/// Where one message's pieces go, each as one stored row. It must not call back into the
/// [`StreamedText`] that sends to it: an interval's piece is sent while its messages are locked.
pub(crate) type StreamedTextSink = Box<dyn Fn(String) + Send + Sync>;

/// The pending send of a message's waiting deltas, one per message at a time.
struct PieceTimer {
    /// Tells this timer from a later one on a message reopened under the same key.
    generation: u64,
    /// The task that sends when the interval passes.
    task: JoinHandle<()>,
}

/// One message the provider is streaming.
struct StreamedMessage {
    /// The provider's key for the message.
    key: String,
    /// The turn the message belongs to, whose end sends what is still waiting.
    turn_id: String,
    /// Where the message's pieces go.
    sink: StreamedTextSink,
    /// Everything already sent as pieces.
    sent: String,
    /// Deltas that arrived since the last piece.
    waiting: String,
    /// The pending send of `waiting`, if one is armed.
    timer: Option<PieceTimer>,
}

impl StreamedMessage {
    /// Sends what is waiting as one piece, disarming the pending send; nothing when none waits.
    fn send(&mut self) {
        if let Some(timer) = self.timer.take() {
            timer.task.abort();
        }
        if self.waiting.is_empty() {
            return;
        }
        let piece = mem::take(&mut self.waiting);
        self.sent.push_str(&piece);
        (self.sink)(piece);
    }
}

/// The open messages, in the order they opened, and the next timer's generation.
#[derive(Default)]
struct OpenMessages {
    /// The open messages, oldest first; a session streams only a few at once.
    messages: Vec<StreamedMessage>,
    /// The generation the next armed timer takes.
    next_timer_generation: u64,
}

impl OpenMessages {
    /// Takes the message `key` out of the open set, if it is open.
    fn remove(&mut self, key: &str) -> Option<StreamedMessage> {
        let index = self
            .messages
            .iter()
            .position(|message| message.key == key)?;
        Some(self.messages.remove(index))
    }
}

/// The messages a provider is streaming on one session, by the provider's message key.
#[derive(Default)]
pub(crate) struct StreamedText {
    /// The open messages, shared with each message's pending send.
    open: Arc<Mutex<OpenMessages>>,
}

impl StreamedText {
    /// Adds `delta` to the message `key`, opening it on `sink`; the delta goes out within the
    /// interval. Must run inside a tokio runtime, which runs the interval's send.
    pub(crate) fn append(&self, key: &str, turn_id: &str, delta: &str, sink: StreamedTextSink) {
        if delta.is_empty() {
            return;
        }
        let mut open = self.open.lock().unwrap_or_else(PoisonError::into_inner);
        let generation = open.next_timer_generation;
        let index = if let Some(index) = open.messages.iter().position(|message| message.key == key)
        {
            index
        } else {
            open.messages.push(StreamedMessage {
                key: key.to_owned(),
                turn_id: turn_id.to_owned(),
                sink,
                sent: String::new(),
                waiting: String::new(),
                timer: None,
            });
            open.messages.len() - 1
        };
        let message = &mut open.messages[index];
        message.waiting.push_str(delta);
        if message.timer.is_none() {
            message.timer = Some(PieceTimer {
                generation,
                task: tokio::spawn(send_after_interval(
                    Arc::clone(&self.open),
                    key.to_owned(),
                    generation,
                )),
            });
            open.next_timer_generation += 1;
        }
    }

    /// Ends the message `key` with the provider's `final_text`: what streamed and the rest of the
    /// final text go out as the last piece, or the whole text through `sink` as the only one when
    /// nothing streamed. `false` when the streamed text is no prefix of the final text: the pieces
    /// sent stand, only what was waiting goes out, and the caller reports it.
    pub(crate) fn complete(&self, key: &str, final_text: &str, sink: impl FnOnce(String)) -> bool {
        let removed = self
            .open
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(key);
        let Some(mut message) = removed else {
            if !final_text.is_empty() {
                sink(final_text.to_owned());
            }
            return true;
        };
        let rest = final_text
            .strip_prefix(message.sent.as_str())
            .and_then(|after_sent| after_sent.strip_prefix(message.waiting.as_str()));
        let Some(rest) = rest else {
            message.send();
            return false;
        };
        message.waiting.push_str(rest);
        message.send();
        true
    }

    /// Drops the message `key` and what still waits on it, which the provider says it will never
    /// finish. Returns whether pieces of it were already sent, which stay.
    pub(crate) fn discard(&self, key: &str) -> bool {
        let removed = self
            .open
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(key);
        let Some(mut message) = removed else {
            return false;
        };
        if let Some(timer) = message.timer.take() {
            timer.task.abort();
        }
        !message.sent.is_empty()
    }

    /// Sends what still waits on every message of `turn_id`, which ended without finishing them.
    pub(crate) fn end_turn(&self, turn_id: &str) {
        let ended: Vec<StreamedMessage> = {
            let mut open = self.open.lock().unwrap_or_else(PoisonError::into_inner);
            let (ended, kept) = mem::take(&mut open.messages)
                .into_iter()
                .partition(|message| message.turn_id == turn_id);
            open.messages = kept;
            ended
        };
        for mut message in ended {
            message.send();
        }
    }

    /// Sends what still waits on every message, once the session's stream ends.
    pub(crate) fn end_all(&self) {
        let ended = mem::take(
            &mut self
                .open
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .messages,
        );
        for mut message in ended {
            message.send();
        }
    }
}

/// Sends what waits on the message `key` once the interval passes, unless the message has ended,
/// sent already, or been replaced since this timer was armed as `generation`. The sink runs with
/// the messages locked, so this piece cannot overtake a later one a `complete` sends.
async fn send_after_interval(open: Arc<Mutex<OpenMessages>>, key: String, generation: u64) {
    tokio::time::sleep(STREAMED_TEXT_PIECE_INTERVAL).await;
    let mut open = open.lock().unwrap_or_else(PoisonError::into_inner);
    let Some(message) = open.messages.iter_mut().find(|message| message.key == key) else {
        return;
    };
    if message
        .timer
        .as_ref()
        .is_some_and(|timer| timer.generation == generation)
    {
        // This task's own handle: dropping it detaches, so the send below never aborts it.
        message.timer = None;
        message.send();
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use rstest::rstest;

    use super::{STREAMED_TEXT_PIECE_INTERVAL, StreamedText, StreamedTextSink};

    #[rstest]
    #[case::streamed_across_an_interval(&["Hel", "lo "], &["wor"], &["Hello ", "world"])]
    #[case::nothing_streamed(&[], &[], &["Hello world"])]
    #[tokio::test]
    async fn pieces_joined_in_order_are_the_final_text(
        #[case] before_interval: &[&str],
        #[case] after_interval: &[&str],
        #[case] expected_pieces: &[&str],
    ) {
        let final_text = "Hello world";
        let pieces = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = || -> StreamedTextSink {
            let pieces = Arc::clone(&pieces);
            Box::new(move |piece| pieces.lock().expect("no test thread panics").push(piece))
        };
        let streamed = StreamedText::default();

        for delta in before_interval {
            streamed.append("message", "turn", delta, sink());
        }
        tokio::time::sleep(STREAMED_TEXT_PIECE_INTERVAL * 3).await;
        for delta in after_interval {
            streamed.append("message", "turn", delta, sink());
        }

        assert!(streamed.complete("message", final_text, sink()));
        let pieces = pieces.lock().expect("no test thread panics").clone();
        assert_eq!(pieces, expected_pieces);
        assert_eq!(pieces.concat(), final_text);
    }
}
