//! The text a provider streams while it writes a reply, a reasoning summary or a plan, handed on as
//! stored pieces of one message: the deltas of each message are joined and sent as one piece per
//! interval, and its final text sends only what the pieces have not yet carried, so every piece
//! of a message, joined in order, is the provider's final text.
//!
//! This is a state machine with no clock, task or lock of its own: the driver's loop for the
//! session arms one timer on the earliest deadline it reports, asks for the pieces due when it
//! fires, and writes each piece it is given in order.

use std::borrow::Borrow;
use std::time::Duration;

use tokio::time::Instant;

/// The longest a streamed delta waits before it goes out as a piece. A reply of about 1,000 tokens
/// written over 10 s, which a provider may send as about 1,000 deltas, becomes at most 100 stored
/// pieces.
pub(crate) const STREAMED_TEXT_PIECE_INTERVAL: Duration = Duration::from_millis(100);

/// One piece of a message, to be stored as one row of the message `key`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StreamedTextPiece<K = String> {
    /// The provider's key for the message.
    pub(crate) key: K,
    /// The text the piece carries.
    pub(crate) text: String,
}

/// How a message ended once its final text arrived.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum StreamedTextCompletion {
    /// The streamed text is a prefix of the final text; the last piece carries the rest.
    Completed {
        /// The message's last piece, `None` when nothing was left to send.
        last_piece: Option<String>,
    },
    /// The streamed text is no prefix of the final text: the pieces sent stand, only what was
    /// waiting goes out, and the caller reports it.
    Diverged {
        /// What was waiting, `None` when nothing was.
        last_piece: Option<String>,
    },
}

// One message the provider is streaming.
struct StreamedMessage<K> {
    key: K,
    // The turn the message belongs to, whose end sends what is still waiting.
    turn_id: String,
    // Everything already handed out as pieces.
    sent: String,
    // Deltas that arrived since the last piece.
    waiting: String,
    // When `waiting` goes out as a piece; `None` while nothing waits.
    due_at: Option<Instant>,
}

impl<K> StreamedMessage<K> {
    // Hands out what is waiting as one piece; `None` when nothing waits.
    fn take_piece(&mut self) -> Option<String> {
        self.due_at = None;
        if self.waiting.is_empty() {
            return None;
        }
        let piece = std::mem::take(&mut self.waiting);
        self.sent.push_str(&piece);
        Some(piece)
    }
}

/// The messages a provider is streaming on one session, in the order they opened, each under the
/// provider's key for it.
pub(crate) struct StreamedText<K = String> {
    /// The open messages, oldest first; a session streams only a few at once.
    messages: Vec<StreamedMessage<K>>,
}

impl<K> Default for StreamedText<K> {
    fn default() -> Self {
        Self {
            messages: Vec::new(),
        }
    }
}

impl<K: Eq + Clone> StreamedText<K> {
    /// Adds `delta` to the message `key` of `turn_id`, opening it, at `now`. Returns the deadline
    /// the delta goes out by when this delta armed it, `None` when one was already armed.
    pub(crate) fn append<Q>(
        &mut self,
        key: &Q,
        turn_id: &str,
        delta: &str,
        now: Instant,
    ) -> Option<Instant>
    where
        K: Borrow<Q>,
        Q: Eq + ToOwned<Owned = K> + ?Sized,
    {
        if delta.is_empty() {
            return None;
        }
        let index = if let Some(index) = self.position(key) {
            index
        } else {
            self.messages.push(StreamedMessage {
                key: key.to_owned(),
                turn_id: turn_id.to_owned(),
                sent: String::new(),
                waiting: String::new(),
                due_at: None,
            });
            self.messages.len() - 1
        };
        let message = &mut self.messages[index];
        message.waiting.push_str(delta);
        if message.due_at.is_some() {
            return None;
        }
        let due_at = now + STREAMED_TEXT_PIECE_INTERVAL;
        message.due_at = Some(due_at);
        Some(due_at)
    }

    /// The earliest deadline still armed, for the driver's one timer.
    pub(crate) fn next_deadline(&self) -> Option<Instant> {
        self.messages
            .iter()
            .filter_map(|message| message.due_at)
            .min()
    }

    /// The pieces whose interval has passed by `now`, in the order their messages opened.
    pub(crate) fn due(&mut self, now: Instant) -> Vec<StreamedTextPiece<K>> {
        self.messages
            .iter_mut()
            .filter(|message| message.due_at.is_some_and(|due_at| due_at <= now))
            .filter_map(|message| {
                message.take_piece().map(|text| StreamedTextPiece {
                    key: message.key.clone(),
                    text,
                })
            })
            .collect()
    }

    /// Ends the message `key` with the provider's `final_text`: what streamed and the rest of the
    /// final text go out as the last piece, or the whole text as the only one when nothing
    /// streamed.
    pub(crate) fn complete<Q>(&mut self, key: &Q, final_text: &str) -> StreamedTextCompletion
    where
        K: Borrow<Q>,
        Q: Eq + ?Sized,
    {
        let Some(index) = self.position(key) else {
            return StreamedTextCompletion::Completed {
                last_piece: (!final_text.is_empty()).then(|| final_text.to_owned()),
            };
        };
        let mut message = self.messages.remove(index);
        let rest = final_text
            .strip_prefix(message.sent.as_str())
            .and_then(|after_sent| after_sent.strip_prefix(message.waiting.as_str()));
        let Some(rest) = rest else {
            return StreamedTextCompletion::Diverged {
                last_piece: message.take_piece(),
            };
        };
        message.waiting.push_str(rest);
        StreamedTextCompletion::Completed {
            last_piece: message.take_piece(),
        }
    }

    /// Drops the message `key` and what still waits on it, which the provider says it will never
    /// finish. Returns whether pieces of it were already handed out, which stay.
    pub(crate) fn discard<Q>(&mut self, key: &Q) -> bool
    where
        K: Borrow<Q>,
        Q: Eq + ?Sized,
    {
        self.position(key)
            .is_some_and(|index| !self.messages.remove(index).sent.is_empty())
    }

    /// Ends every message of `turn_id`, which ended without finishing them, and returns what still
    /// waited on each.
    pub(crate) fn end_turn(&mut self, turn_id: &str) -> Vec<StreamedTextPiece<K>> {
        let (ended, open) = std::mem::take(&mut self.messages)
            .into_iter()
            .partition(|message| message.turn_id == turn_id);
        self.messages = open;
        last_pieces(ended)
    }

    /// Ends every message, once the session's stream ends, and returns what still waited on each.
    pub(crate) fn end_all(&mut self) -> Vec<StreamedTextPiece<K>> {
        last_pieces(std::mem::take(&mut self.messages))
    }

    fn position<Q>(&self, key: &Q) -> Option<usize>
    where
        K: Borrow<Q>,
        Q: Eq + ?Sized,
    {
        self.messages
            .iter()
            .position(|message| message.key.borrow() == key)
    }
}

fn last_pieces<K>(messages: Vec<StreamedMessage<K>>) -> Vec<StreamedTextPiece<K>> {
    messages
        .into_iter()
        .filter_map(|mut message| {
            message.take_piece().map(|text| StreamedTextPiece {
                key: message.key,
                text,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use tokio::time::Instant;

    use super::{STREAMED_TEXT_PIECE_INTERVAL, StreamedText, StreamedTextCompletion};

    #[rstest]
    #[case::streamed_across_an_interval(&["Good ", "day "], &["to"], &["Good day ", "to you"])]
    #[case::nothing_streamed(&[], &[], &["Good day to you"])]
    fn pieces_joined_in_order_are_the_final_text(
        #[case] before_interval: &[&str],
        #[case] after_interval: &[&str],
        #[case] expected_pieces: &[&str],
    ) {
        let final_text = "Good day to you";
        let start = Instant::now();
        let mut streamed: StreamedText = StreamedText::default();
        let mut pieces = Vec::new();

        for delta in before_interval {
            streamed.append("message", "turn", delta, start);
        }
        let interval_end = start + STREAMED_TEXT_PIECE_INTERVAL;
        assert_eq!(
            streamed.due(interval_end - STREAMED_TEXT_PIECE_INTERVAL / 2),
            Vec::new()
        );
        pieces.extend(
            streamed
                .due(interval_end)
                .into_iter()
                .map(|piece| piece.text),
        );
        for delta in after_interval {
            streamed.append("message", "turn", delta, interval_end);
        }
        match streamed.complete("message", final_text) {
            StreamedTextCompletion::Completed { last_piece } => pieces.extend(last_piece),
            StreamedTextCompletion::Diverged { .. } => panic!("the streamed text is a prefix"),
        }

        assert_eq!(pieces, expected_pieces);
        assert_eq!(pieces.concat(), final_text);
    }
}
