//! The tail of what a child process printed by its exit: its output decoded across chunks and read
//! as a terminal shows it as the chunks arrive, its last stretch cut on a grapheme boundary, read
//! from its pipe chunk by chunk.

use std::error::Error;
use std::io;

use sidekicks_contracts::wire::text::is_ecmascript_whitespace;
use tokio::io::{AsyncRead, AsyncReadExt as _};
use unicode_segmentation::GraphemeCursor;

use crate::terminal_text::{ShownText, TerminalTextReader};
use crate::utf8_stream::Utf8StreamDecoder;

/// The most of a child's output one read of its pipe takes, so the buffer each reader holds stays
/// small however much the child prints.
pub const OUTPUT_CHUNK_BYTES: usize = 8 * 1024;

// What a tail reads when the process printed nothing but whitespace, since the wire refuses blank.
const NO_OUTPUT: &str = "(no output)";

/// The last `CAP` code points of what a child's output shows on a terminal, fed chunk by chunk:
/// bytes are held until they make a whole UTF-8 sequence and each invalid one reads as U+FFFD once,
/// then read as a terminal shows them as they arrive, so the cap counts shown characters and no cut
/// leaves a piece of a sequence. It holds at most twice the cap's shown code points, the parser's
/// one open string of at most 16 KiB and three undecoded bytes, however much the child prints.
pub struct OutputTail<const CAP: usize> {
    shown: ShownTail<CAP>,
    reader: TerminalTextReader,
    decoder: Utf8StreamDecoder,
}

impl<const CAP: usize> Default for OutputTail<CAP> {
    fn default() -> Self {
        Self::new()
    }
}

impl<const CAP: usize> OutputTail<CAP> {
    /// An empty tail.
    pub fn new() -> Self {
        Self {
            shown: ShownTail::default(),
            reader: TerminalTextReader::new(),
            decoder: Utf8StreamDecoder::default(),
        }
    }

    /// Adds one chunk of output.
    pub fn push(&mut self, chunk: &[u8]) {
        let Self {
            shown,
            reader,
            decoder,
        } = self;
        decoder.push(chunk, |text| reader.push(text.as_bytes(), shown));
    }

    /// The tail as text: what the output shows on a terminal, its printed characters, line breaks
    /// and tabs with every other control left out and each line redrawn in place read as its last
    /// drawing, cut to its last `CAP` code points moved forward to the next grapheme boundary so no
    /// character is split from its marks, and `(no output)` for output that shows nothing but
    /// whitespace. A sequence the output ends inside shows nothing.
    pub fn into_text(self) -> String {
        let Self {
            mut shown,
            mut reader,
            decoder,
        } = self;
        decoder.finish(|text| reader.push(text.as_bytes(), &mut shown));
        let mut shown = shown.text;
        let cut = CAP.checked_sub(1).map_or(shown.len(), |back| {
            shown
                .char_indices()
                .rev()
                .nth(back)
                .map_or(0, |(offset, _)| offset)
        });
        let start = if cut == 0 {
            0
        } else {
            let mut cursor = GraphemeCursor::new(cut, shown.len(), true);
            match cursor.is_boundary(&shown, 0) {
                Ok(true) => cut,
                _ => cursor
                    .next_boundary(&shown, 0)
                    .ok()
                    .flatten()
                    .unwrap_or(shown.len()),
            }
        };
        shown.drain(..start);
        if shown.chars().all(is_ecmascript_whitespace) {
            NO_OUTPUT.to_owned()
        } else {
            shown
        }
    }
}

// The shown text a tail keeps, trimmed from the front past twice the cap to half again the cap, so
// trimming is rare and the cut at the end still sees the characters before it.
#[derive(Default)]
struct ShownTail<const CAP: usize> {
    text: String,
    // Code points in `text`.
    text_len: usize,
    // Where the current line starts in `text`, in bytes and in code points.
    line_start: usize,
    line_start_len: usize,
}

impl<const CAP: usize> ShownTail<CAP> {
    // Drops the oldest text past twice the cap, the current line's start moved with it.
    fn trim(&mut self) {
        if self.text_len <= CAP.saturating_mul(2) {
            return;
        }
        let dropped = self.text_len - (CAP + CAP / 2);
        let offset = (self.text.char_indices())
            .nth(dropped)
            .map_or(self.text.len(), |(offset, _)| offset);
        self.text.drain(..offset);
        self.text_len -= dropped;
        self.line_start = self.line_start.saturating_sub(offset);
        self.line_start_len = self.line_start_len.saturating_sub(dropped);
    }
}

impl<const CAP: usize> ShownText for ShownTail<CAP> {
    fn push_char(&mut self, character: char) {
        self.text.push(character);
        self.text_len += 1;
        self.trim();
    }

    fn break_line(&mut self) {
        self.text.push('\n');
        self.text_len += 1;
        self.line_start = self.text.len();
        self.line_start_len = self.text_len;
        self.trim();
    }

    fn clear_line(&mut self) {
        self.text.truncate(self.line_start);
        self.text_len = self.line_start_len;
    }
}

/// Reads `reader`, a child's output, to its end, handing each chunk of at most 8 KiB to
/// `take_chunk` as it arrives. A read that is interrupted is tried again; one that fails otherwise
/// is logged as `what`, the output's name, and ends the reading where it stands.
pub async fn read_output_chunks(
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

    use super::OutputTail;

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
    // Colored letters count as the letters, a sequence split across chunks is read whole, and the
    // cut leaves no piece of a color sequence.
    #[case::mostly_sequences(
        tail_of::<4>(&[
            b"\x1b[31ma\x1b[0m\x1b[31mb\x1b[0m\x1b[3".as_slice(),
            b"1mc\x1b[0m\x1b[31md\x1b[0m\x1b[31me\x1b[0m",
        ]),
        "bcde"
    )]
    // A progress line redrawn in place reads as its last drawing.
    #[case::a_redrawn_line(
        tail_of::<20>(&[b"step 1\n10%\r50%\r100%".as_slice()]),
        "step 1\n100%"
    )]
    // A return no printed character follows blanks nothing.
    #[case::returns_before_a_break(
        tail_of::<20>(&[b"text\r\r\nnext".as_slice()]),
        "text\nnext"
    )]
    #[case::a_return_at_the_end(tail_of::<20>(&[b"100%\r".as_slice()]), "100%")]
    // A return ending one chunk and a line break opening the next are one line break.
    #[case::a_break_across_chunks(tail_of::<20>(&[b"a\r".as_slice(), b"\nb"]), "a\nb")]
    // A title string never closed ends at its line break, so the next line still shows.
    #[case::an_open_string(
        tail_of::<20>(&[b"before\x1b]0;title\nafter".as_slice()]),
        "before\nafter"
    )]
    #[case::blank_output(tail_of::<10>(&[b" \n\t".as_slice()]), "(no output)")]
    #[case::no_output(tail_of::<10>(&[]), "(no output)")]
    fn keeps_the_tail(#[case] tail: String, #[case] expected: &str) {
        assert_eq!(tail, expected);
    }
}
