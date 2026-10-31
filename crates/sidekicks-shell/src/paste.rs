//! A shell's pastes on their way in, each sent in parts. Whether a paste is marked as pasted is
//! fixed at its first part, by whether the program in the shell asked for bracketed paste then. A
//! shell has at most one paste open, which belongs to the pane output subscription its newest part
//! came through: a paste another part starts closes the open one first, so two panes' pastes never
//! interleave and the program is never left inside a paste. An answer to the program that comes
//! while a marked paste is open waits for its end mark, so it never lands inside the pasted text.

use std::mem;

use bytes::Bytes;
use memchr::{memchr, memrchr};
use sidekicks_contracts::jsonrpc::streaming::SubscriptionId;
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_terminal::ANSWER_BYTES_LIMIT;

/// The mark before a bracketed paste.
const PASTE_START: &[u8] = b"\x1b[200~";
/// The mark after a bracketed paste.
const PASTE_END: &[u8] = b"\x1b[201~";
/// The last byte of the end mark, the only byte that can complete one.
const PASTE_END_LAST_BYTE: u8 = b'~';

/// Bytes a paste puts on the shell's input, and the answers to the program that waited for them,
/// which go after them: the table queues `bytes` as a write, then each answer as an answer.
#[derive(Debug)]
pub(crate) struct PasteInput {
    /// The bytes for the shell's input, the marks included where they fall.
    pub(crate) bytes: Bytes,
    /// The answers held while the paste was open, oldest first.
    pub(crate) held_answers: Vec<Bytes>,
}

/// One part of a paste, as a write frame carries it.
pub struct ShellPastePart {
    /// The paste the part belongs to, minted by the client.
    pub paste_id: ClientUuid,
    /// The pane output subscription the part came through.
    pub output_subscription_id: SubscriptionId,
    /// The part's text.
    pub data: String,
    /// Whether this is the paste's last part.
    pub is_last_part: bool,
}

/// One paste across the parts it was sent in. A marked paste is opened once before its first part
/// and closed once after its last, with every end mark inside it removed first, even one split
/// across two parts or one that removing another would form, so the pasted text cannot close the
/// marks early.
struct ShellPaste {
    is_bracketed: bool,
    has_started: bool,
    /// The end of the last part that may still become end marks, held until the next part shows.
    held_text: Vec<u8>,
    /// The answers to the program that came while the paste was open, written after its end mark.
    held_answers: Vec<Bytes>,
    /// The bytes of `held_answers`, which stay within the terminal's bound on waiting answers.
    held_answer_bytes: usize,
    /// Whether a dropped answer was logged since the paste opened.
    has_logged_drop: bool,
}

impl ShellPaste {
    fn new(is_bracketed: bool) -> Self {
        Self {
            is_bracketed,
            has_started: false,
            held_text: Vec::new(),
            held_answers: Vec::new(),
            held_answer_bytes: 0,
            has_logged_drop: false,
        }
    }

    /// The bytes one part puts on the shell's input, the marks included where they fall; the last
    /// part carries the answers that waited for the end mark.
    fn encode_part(&mut self, data: String, is_last_part: bool) -> PasteInput {
        if !self.is_bracketed {
            return PasteInput {
                bytes: Bytes::from(data),
                held_answers: Vec::new(),
            };
        }
        let mut input = Vec::with_capacity(
            PASTE_START.len() + self.held_text.len() + data.len() + PASTE_END.len(),
        );
        if !self.has_started {
            input.extend_from_slice(PASTE_START);
            self.has_started = true;
        }
        let pasted_from = input.len();
        input.append(&mut self.held_text);
        append_without_end_marks(&mut input, pasted_from, data.as_bytes());
        if is_last_part {
            input.extend_from_slice(PASTE_END);
            return PasteInput {
                bytes: Bytes::from(input),
                held_answers: self.take_held_answers(),
            };
        }
        let held_length = pending_end_marks_length(&input[pasted_from..]);
        self.held_text = input.split_off(input.len() - held_length);
        PasteInput {
            bytes: Bytes::from(input),
            held_answers: Vec::new(),
        }
    }

    /// The bytes that close a paste whose last part never came: what it held, its end mark and
    /// the answers that waited for it; none for a paste with no marks.
    fn close(mut self) -> Option<PasteInput> {
        if !self.is_bracketed {
            return None;
        }
        let mut closing = mem::take(&mut self.held_text);
        closing.extend_from_slice(PASTE_END);
        Some(PasteInput {
            bytes: Bytes::from(closing),
            held_answers: self.take_held_answers(),
        })
    }

    /// Holds `answer` until the end mark when the paste is marked, dropping it once the held
    /// answers would pass the terminal's bound; hands it back when the paste holds none.
    fn hold_answer(&mut self, answer: Bytes) -> Option<Bytes> {
        if !self.is_bracketed {
            return Some(answer);
        }
        if self.held_answer_bytes + answer.len() > ANSWER_BYTES_LIMIT {
            if !mem::replace(&mut self.has_logged_drop, true) {
                tracing::warn!(
                    limit = ANSWER_BYTES_LIMIT,
                    "a program asked its terminal more than it read while a paste was open, so \
                     later answers are dropped"
                );
            }
            return None;
        }
        self.held_answer_bytes += answer.len();
        self.held_answers.push(answer);
        None
    }

    fn take_held_answers(&mut self) -> Vec<Bytes> {
        self.held_answer_bytes = 0;
        self.has_logged_drop = false;
        mem::take(&mut self.held_answers)
    }
}

/// Appends `text` to `input`, removing every end mark that forms in `input` from `pasted_from` on,
/// nested ones included, in one pass: an end mark ends in `~`, so each `~` appended is checked for
/// one completed at the tail. `input` holds none from `pasted_from` on when called.
fn append_without_end_marks(input: &mut Vec<u8>, pasted_from: usize, text: &[u8]) {
    let mut rest = text;
    while let Some(at) = memchr(PASTE_END_LAST_BYTE, rest) {
        input.extend_from_slice(&rest[..=at]);
        if input.len() - pasted_from >= PASTE_END.len() && input.ends_with(PASTE_END) {
            input.truncate(input.len() - PASTE_END.len());
        }
        rest = &rest[at + 1..];
    }
    input.extend_from_slice(rest);
}

/// The longest end of `pasted` a later part could still turn into end marks: a run of unfinished
/// end marks, each a proper prefix of one beginning at its escape, since a later part that
/// finishes the innermost removes it and joins the one before it to what follows.
fn pending_end_marks_length(pasted: &[u8]) -> usize {
    let mut held_from = pasted.len();
    while let Some(start) = memrchr(PASTE_END[0], &pasted[..held_from]) {
        let unfinished = &pasted[start..held_from];
        if unfinished.len() < PASTE_END.len() && PASTE_END.starts_with(unfinished) {
            held_from = start;
        } else {
            break;
        }
    }
    pasted.len() - held_from
}

/// The paste a shell has open and the pane it belongs to.
struct OpenPaste {
    paste_id: ClientUuid,
    owner: SubscriptionId,
    paste: ShellPaste,
}

/// A shell's pastes, at most one of them open at a time.
#[derive(Default)]
pub(crate) struct ShellPastes {
    open: Option<OpenPaste>,
}

impl ShellPastes {
    /// What one part puts on the shell's input, in order: the close of the open paste when this
    /// part starts another, then the part itself. `is_bracketed`, whether the program asked for
    /// bracketed paste, is read only for a first part; the caller reads it from the screen before
    /// it takes the lock it keeps these pastes under, since the screen's answers reach
    /// [`Self::hold_answer`] under the screen's lock.
    pub(crate) fn encode_part(
        &mut self,
        part: ShellPastePart,
        is_bracketed: bool,
    ) -> Vec<PasteInput> {
        let mut inputs = Vec::with_capacity(2);
        let open = match self.open.take() {
            Some(open) if open.paste_id == part.paste_id => Some(open),
            displaced => {
                inputs.extend(displaced.and_then(|displaced| displaced.paste.close()));
                None
            }
        };
        let mut paste = open.map_or_else(|| ShellPaste::new(is_bracketed), |open| open.paste);
        inputs.push(paste.encode_part(part.data, part.is_last_part));
        if !part.is_last_part {
            self.open = Some(OpenPaste {
                paste_id: part.paste_id,
                owner: part.output_subscription_id,
                paste,
            });
        }
        inputs
    }

    /// What closes the paste open through the pane `output_subscription_id`, which closes; none
    /// when that pane has none open.
    pub(crate) fn close_for(
        &mut self,
        output_subscription_id: SubscriptionId,
    ) -> Option<PasteInput> {
        if self
            .open
            .as_ref()
            .is_some_and(|open| open.owner == output_subscription_id)
        {
            self.close_all()
        } else {
            None
        }
    }

    /// What closes the open paste, whichever pane it came through; none when none is open or it
    /// has no marks.
    pub(crate) fn close_all(&mut self) -> Option<PasteInput> {
        self.open.take().and_then(|open| open.paste.close())
    }

    /// Holds an answer to the program until the open paste's end mark when that paste is marked
    /// as pasted, the close carrying it after the mark, and drops one past the terminal's bound on
    /// waiting answers; hands `answer` back for the caller to queue when no marked paste is open.
    pub(crate) fn hold_answer(&mut self, answer: Bytes) -> Option<Bytes> {
        match &mut self.open {
            Some(open) => open.paste.hold_answer(answer),
            None => Some(answer),
        }
    }

    /// Forgets the open paste and the answers it held, for a shell that takes no more input.
    pub(crate) fn clear(&mut self) {
        self.open = None;
    }
}

#[cfg(test)]
mod tests {
    use bytes::Bytes;
    use rstest::rstest;
    use sidekicks_contracts::jsonrpc::streaming::SubscriptionId;
    use sidekicks_contracts::wire::id::ClientUuid;
    use sidekicks_terminal::ANSWER_BYTES_LIMIT;

    use super::{PasteInput, ShellPastePart, ShellPastes};

    const PASTE_ID: &str = "0192f3a4-5b6c-7d8e-9f01-23456789abcd";
    const PANE: &str = "0192f3a4-5b6c-7d8e-8f01-23456789abce";

    fn part(data: &str, is_last_part: bool) -> ShellPastePart {
        ShellPastePart {
            paste_id: ClientUuid::new(PASTE_ID.to_owned()).expect("the paste id is a UUID"),
            output_subscription_id: SubscriptionId::new(PANE).expect("the pane is a UUID"),
            data: data.to_owned(),
            is_last_part,
        }
    }

    /// Every input's bytes, then its held answers, in the order the table queues them.
    fn queued(inputs: Vec<PasteInput>) -> Vec<u8> {
        inputs
            .into_iter()
            .flat_map(|input| [input.bytes].into_iter().chain(input.held_answers))
            .flat_map(|bytes| bytes.to_vec())
            .collect()
    }

    #[rstest]
    #[case::end_mark_in_the_text(&["a\x1b[201~b"], "ab")]
    #[case::end_mark_split_across_parts(&["a\x1b[2", "01~b"], "ab")]
    #[case::end_mark_formed_by_a_removal(&["\x1b[20\x1b[201~1~c"], "c")]
    #[case::formed_by_a_removal_across_parts(&["x\x1b[20\x1b[2", "01~1~", "\x1b[201~y"], "xy")]
    #[case::a_held_prefix_that_ends_no_mark(&["a\x1b[20", "x"], "a\x1b[20x")]
    fn removes_every_end_mark_inside_a_marked_paste(#[case] parts: &[&str], #[case] pasted: &str) {
        let mut pastes = ShellPastes::default();
        let mut written = Vec::new();
        for (index, data) in parts.iter().enumerate() {
            let is_last_part = index + 1 == parts.len();
            written.extend(queued(pastes.encode_part(part(data, is_last_part), true)));
        }
        assert_eq!(written, format!("\x1b[200~{pasted}\x1b[201~").as_bytes());
    }

    #[test]
    fn writes_answers_held_by_an_open_marked_paste_after_its_end_mark() {
        let mut pastes = ShellPastes::default();
        let answer = Bytes::from_static(b"\x1b[1;1R");
        assert_eq!(pastes.hold_answer(answer.clone()), Some(answer.clone()));

        let first = queued(pastes.encode_part(part("a", false), true));
        assert_eq!(pastes.hold_answer(answer.clone()), None);
        let last = queued(pastes.encode_part(part("b", true), true));

        assert_eq!(first, b"\x1b[200~a");
        assert_eq!(last, b"b\x1b[201~\x1b[1;1R");
        assert_eq!(pastes.hold_answer(answer.clone()), Some(answer));
    }

    #[test]
    fn drops_held_answers_past_the_terminals_bound() {
        let mut pastes = ShellPastes::default();
        let answer = Bytes::from_static(b"\x1b[?1;2c");
        let fitting = ANSWER_BYTES_LIMIT / answer.len();
        pastes.encode_part(part("a", false), true);

        for _ in 0..fitting + 10 {
            assert_eq!(pastes.hold_answer(answer.clone()), None);
        }
        let closing = pastes
            .close_all()
            .expect("a marked paste closes with its end mark");

        assert_eq!(closing.bytes, Bytes::from_static(b"\x1b[201~"));
        assert_eq!(closing.held_answers.len(), fitting);
    }
}
