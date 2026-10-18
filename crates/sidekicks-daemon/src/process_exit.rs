//! How a child process ended, as the wire carries it: its exit code or the name of the signal that
//! ended it, and the tail of what it printed, the last stretch of its output decoded across chunks
//! and cut on a grapheme boundary.

use std::mem;

use sidekicks_contracts::command::ExitCode;
use sidekicks_contracts::provider::driver::length_limits::PROVIDER_FAILURE_DETAIL_MAX_LEN;
use sidekicks_contracts::run::control::{ProcessExit, ProcessExitWithCode, ProcessExitWithSignal};
use sidekicks_contracts::wire::text::{FreeFormText, is_ecmascript_whitespace};
use unicode_segmentation::GraphemeCursor;

// What a tail reads when the process printed nothing but whitespace, since the wire refuses blank.
const NO_OUTPUT: &str = "(no output)";

/// The last `CAP` code points of a child's output, fed chunk by chunk: bytes are held until they
/// make a whole UTF-8 sequence and each invalid one reads as U+FFFD once, and at most about twice
/// the cap is kept in memory however much the child prints. `CAP` is at most the wire's
/// failure-detail cap, which the build checks.
pub(crate) struct OutputTail<const CAP: usize> {
    text: String,
    // Code points in `text`.
    text_len: usize,
    // The start of a UTF-8 sequence the last chunk cut off, at most three bytes.
    pending: Vec<u8>,
}

impl<const CAP: usize> OutputTail<CAP> {
    /// An empty tail.
    pub(crate) fn new() -> Self {
        const {
            assert!(
                CAP <= PROVIDER_FAILURE_DETAIL_MAX_LEN,
                "a tail's cap fits the failure-detail cap"
            );
        }
        Self {
            text: String::new(),
            text_len: 0,
            pending: Vec::new(),
        }
    }

    /// Adds one chunk of output.
    pub(crate) fn push(&mut self, chunk: &[u8]) {
        let mut bytes = mem::take(&mut self.pending);
        bytes.extend_from_slice(chunk);
        let mut rest = bytes.as_slice();
        loop {
            match std::str::from_utf8(rest) {
                Ok(text) => {
                    self.push_text(text);
                    break;
                }
                Err(error) => {
                    let (valid, after) = rest.split_at(error.valid_up_to());
                    self.push_text(
                        std::str::from_utf8(valid).expect("the bytes before the error are UTF-8"),
                    );
                    let Some(invalid_len) = error.error_len() else {
                        // A sequence the chunk cut off waits for the next chunk.
                        self.pending = after.to_vec();
                        break;
                    };
                    self.push_text("\u{FFFD}");
                    rest = &after[invalid_len..];
                }
            }
        }
    }

    /// The tail as the wire carries it: the last `CAP` code points, moved forward to the next
    /// grapheme boundary so no character is split from its marks, each NUL read as U+FFFD, and
    /// `(no output)` for output that was empty or only whitespace.
    pub(crate) fn into_text(mut self) -> String {
        if !self.pending.is_empty() {
            self.push_text("\u{FFFD}");
        }
        let cut = self
            .text
            .char_indices()
            .nth(self.text_len.saturating_sub(CAP))
            .map_or(self.text.len(), |(offset, _)| offset);
        let start = if cut == 0 {
            0
        } else {
            let mut cursor = GraphemeCursor::new(cut, self.text.len(), true);
            match cursor.is_boundary(&self.text, 0) {
                Ok(true) => cut,
                _ => cursor
                    .next_boundary(&self.text, 0)
                    .ok()
                    .flatten()
                    .unwrap_or(self.text.len()),
            }
        };
        let tail = self.text[start..].replace('\0', "\u{FFFD}");
        if tail.chars().all(is_ecmascript_whitespace) {
            NO_OUTPUT.to_owned()
        } else {
            tail
        }
    }

    fn push_text(&mut self, text: &str) {
        self.text.push_str(text);
        self.text_len += text.chars().count();
        // Trimmed past twice the cap to half again the cap, so trimming is rare and the cut at the
        // end still sees the characters before it.
        if self.text_len > CAP.saturating_mul(2) {
            let kept = CAP + CAP / 2;
            let dropped = self.text_len - kept;
            let offset = self
                .text
                .char_indices()
                .nth(dropped)
                .map_or(self.text.len(), |(offset, _)| offset);
            self.text.drain(..offset);
            self.text_len = kept;
        }
    }
}

/// The exit a process that ended on its own crosses the wire with: the name of the signal that
/// ended it where there is one, else its exit code (a Windows code read as its unsigned 32-bit
/// value, so a crash reads 3221225477, and a missing code 0), with its output tail.
pub(crate) fn compose_process_exit<const CAP: usize>(
    exit_code: Option<i32>,
    signal_name: Option<String>,
    output_tail: OutputTail<CAP>,
) -> ProcessExit {
    let output_tail = FreeFormText::<PROVIDER_FAILURE_DETAIL_MAX_LEN>::new(output_tail.into_text())
        .expect("a tail is never blank, holds no NUL and is within the failure-detail cap");
    match signal_name {
        Some(signal) => ProcessExit::Signal(ProcessExitWithSignal {
            signal: FreeFormText::new(signal).expect("a signal's name is a short, non-blank word"),
            exit_code: None,
            output_tail,
        }),
        None => ProcessExit::Code(ProcessExitWithCode {
            exit_code: ExitCode::new(exit_code.map_or(0, |code| i64::from(code.cast_unsigned())))
                .expect("an unsigned 32-bit code is a safe integer"),
            signal: None,
            output_tail,
        }),
    }
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use sidekicks_contracts::run::control::ProcessExit;

    use super::{OutputTail, compose_process_exit};

    fn tail_of<const CAP: usize>(chunks: &[&[u8]]) -> String {
        let mut tail = OutputTail::<CAP>::new();
        for chunk in chunks {
            tail.push(chunk);
        }
        tail.into_text()
    }

    #[rstest]
    // `ï` split across two chunks decodes once, as itself.
    #[case::a_split_character(tail_of::<10>(&[b"na\xC3".as_slice(), b"\xAFve".as_slice()]), "naïve")]
    // A sequence left unfinished at the end reads as one U+FFFD.
    #[case::an_unfinished_character(tail_of::<10>(&[b"ok\xE2\x82".as_slice()]), "ok\u{FFFD}")]
    // The last three code points start inside `e` with its accent, so the cut moves past both.
    #[case::a_grapheme_boundary(tail_of::<3>(&[b"abe\xCC\x81cd".as_slice()]), "cd")]
    // Long output trimmed while it streams keeps exactly the last code points.
    #[case::the_last_code_points(tail_of::<4>(&[b"0123456789".as_slice(), b"abcdef".as_slice()]), "cdef")]
    #[case::blank_output(tail_of::<10>(&[b" \n\t".as_slice()]), "(no output)")]
    #[case::no_output(tail_of::<10>(&[]), "(no output)")]
    fn keeps_the_tail(#[case] tail: String, #[case] expected: &str) {
        assert_eq!(tail, expected);
    }

    #[test]
    fn a_tail_holding_nul_still_builds_an_exit() {
        let mut tail = OutputTail::<32>::new();
        tail.push(b"failed\0here");

        let ProcessExit::Code(exit) = compose_process_exit(Some(-1_073_741_819), None, tail) else {
            panic!("an exit with no signal carries its code");
        };

        assert_eq!(exit.output_tail.as_str(), "failed\u{FFFD}here");
        assert_eq!(exit.exit_code.get(), 3_221_225_477);
    }
}
