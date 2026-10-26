//! How a child process ended, as the wire carries it: its exit code or the name of the signal that
//! ended it, and the tail of what it printed, the last stretch of its output decoded across chunks
//! and cut on a grapheme boundary, read from its pipe chunk by chunk.

use std::error::Error;
use std::io;
use std::mem;

use sidekicks_contracts::command::ExitCode;
use sidekicks_contracts::provider::driver::length_limits::PROVIDER_FAILURE_DETAIL_MAX_LEN;
use sidekicks_contracts::run::control::{ProcessExit, ProcessExitWithCode, ProcessExitWithSignal};
use sidekicks_contracts::wire::text::{FreeFormText, is_ecmascript_whitespace};
use sidekicks_platforms::ChildExit;
use tokio::io::{AsyncRead, AsyncReadExt as _};
use unicode_segmentation::GraphemeCursor;

use crate::utf8_stream::Utf8StreamDecoder;

/// The most of a child's output read from its pipe at once.
const OUTPUT_CHUNK_BYTES: usize = 8 * 1024;

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
    decoder: Utf8StreamDecoder,
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
            decoder: Utf8StreamDecoder::default(),
        }
    }

    /// Adds one chunk of output.
    pub(crate) fn push(&mut self, chunk: &[u8]) {
        let mut decoder = mem::take(&mut self.decoder);
        decoder.push(chunk, |text| self.push_text(text));
        self.decoder = decoder;
    }

    /// The tail as the wire carries it: the last `CAP` code points, moved forward to the next
    /// grapheme boundary so no character is split from its marks, each NUL read as U+FFFD, and
    /// `(no output)` for output that was empty or only whitespace.
    pub(crate) fn into_text(mut self) -> String {
        mem::take(&mut self.decoder).finish(|text| self.push_text(text));
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

/// The exit a process crosses the wire with: the name of the signal that ended it, or that the
/// daemon asked, where there is one, else its exit code, with its output tail.
pub(crate) fn compose_process_exit<const CAP: usize>(
    exit: ChildExit,
    output_tail: OutputTail<CAP>,
) -> ProcessExit {
    let output_tail = FreeFormText::<PROVIDER_FAILURE_DETAIL_MAX_LEN>::new(output_tail.into_text())
        .expect("a tail is never blank, holds no NUL and is within the failure-detail cap");
    match exit.signal_name {
        Some(signal) => ProcessExit::Signal(ProcessExitWithSignal {
            signal: FreeFormText::new(signal).expect("a signal's name is a short, non-blank word"),
            exit_code: None,
            output_tail,
        }),
        None => ProcessExit::Code(ProcessExitWithCode {
            exit_code: ExitCode::new(exit.exit_code)
                .expect("an unsigned 32-bit code is a safe integer"),
            signal: None,
            output_tail,
        }),
    }
}

/// Reads `reader`, a child's output, to its end, handing each chunk of at most 8 KiB to
/// `take_chunk` as it arrives. A read that is interrupted is tried again; one that fails otherwise
/// is logged as `what`, the output's name, and ends the reading where it stands.
pub(crate) async fn read_output_chunks(
    mut reader: impl AsyncRead + Unpin,
    what: &str,
    mut take_chunk: impl FnMut(&[u8]),
) {
    let mut chunk = vec![0; OUTPUT_CHUNK_BYTES];
    loop {
        match reader.read(&mut chunk).await {
            Ok(0) => return,
            Ok(read) => take_chunk(&chunk[..read]),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    "{what} could not be read to its end"
                );
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use sidekicks_contracts::run::control::ProcessExit;
    use sidekicks_platforms::ChildExit;

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
    #[case::a_split_character(tail_of::<10>(&[&b"na\xC3"[..], &b"\xAFve"[..]]), "naïve")]
    // A sequence left unfinished at the end reads as one U+FFFD.
    #[case::an_unfinished_character(tail_of::<10>(&[b"ok\xE2\x82".as_slice()]), "ok\u{FFFD}")]
    // The last three code points start inside `e` with its accent, so the cut moves past both.
    #[case::a_grapheme_boundary(tail_of::<3>(&[b"abe\xCC\x81cd".as_slice()]), "cd")]
    // Long output trimmed while it streams keeps exactly the last code points.
    #[case::the_last_code_points(tail_of::<4>(&[&b"0123456789"[..], &b"abcdef"[..]]), "cdef")]
    #[case::blank_output(tail_of::<10>(&[b" \n\t".as_slice()]), "(no output)")]
    #[case::no_output(tail_of::<10>(&[]), "(no output)")]
    fn keeps_the_tail(#[case] tail: String, #[case] expected: &str) {
        assert_eq!(tail, expected);
    }

    #[test]
    fn a_tail_holding_nul_still_builds_an_exit() {
        let mut tail = OutputTail::<32>::new();
        tail.push(b"failed\0here");

        let exit = ChildExit {
            exit_code: 3_221_225_477,
            signal_number: None,
            signal_name: None,
        };

        let ProcessExit::Code(exit) = compose_process_exit(exit, tail) else {
            panic!("an exit with no signal carries its code");
        };

        assert_eq!(exit.output_tail.as_str(), "failed\u{FFFD}here");
    }
}
