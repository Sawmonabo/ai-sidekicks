//! The shell word read as the shell reads one it expands nothing in, as a here-document's
//! delimiter is.

use memchr::memchr;

use super::quote_removal::unescape_bare;
use super::{PieceKind, Word, WordBuilder, word_from};

impl WordBuilder<'_> {
    /// Reads the shell word that starts at byte `start` of the line as the shell reads a word it
    /// expands nothing in, as a here-document's delimiter: up to a blank, a newline or a
    /// metacharacter outside quotes, its quotes removed, its escapes undone and its ANSI-C strings
    /// decoded. Returns the word and the byte its text ends at.
    pub(in crate::shell_commands) fn push_unexpanded_word(
        &mut self,
        start: usize,
    ) -> (Word, usize) {
        let line = self.line;
        let bytes = line.as_bytes();
        let first_piece = self.pieces.len();
        let mut position = start;
        while let Some(&byte) = bytes.get(position) {
            match byte {
                b'\'' => {
                    let close = memchr(b'\'', &bytes[position + 1..])
                        .map_or(bytes.len(), |offset| position + 1 + offset);
                    self.push_line(position + 1..close, PieceKind::Literal);
                    position = close + 1;
                }
                b'"' => {
                    let close = quoted_text_end(bytes, position + 1, b'"');
                    self.push_double_quoted_text(position + 1..close);
                    position = close + 1;
                }
                b'$' if bytes.get(position + 1) == Some(&b'\'') => {
                    let close = quoted_text_end(bytes, position + 2, b'\'');
                    self.push_ansi_c(position..(close + 1).min(bytes.len()));
                    position = close + 1;
                }
                byte if WORD_ENDING_BYTES.contains(&byte) => break,
                _ => {
                    let run_start = position;
                    while let Some(&byte) = bytes.get(position) {
                        let opens_ansi_c = byte == b'$' && bytes.get(position + 1) == Some(&b'\'');
                        if matches!(byte, b'\'' | b'"')
                            || opens_ansi_c
                            || WORD_ENDING_BYTES.contains(&byte)
                        {
                            break;
                        }
                        position += if byte == b'\\' { 2 } else { 1 };
                    }
                    position = position.min(bytes.len());
                    let text = &line[run_start..position];
                    if memchr(b'\\', text.as_bytes()).is_some() {
                        self.push_decoded(|value| unescape_bare(text, value));
                    } else {
                        self.push_line(run_start..position, PieceKind::Literal);
                    }
                }
            }
        }
        let end = position.min(bytes.len());
        (word_from(&self.pieces, first_piece), end)
    }
}

// The bytes that end an unquoted shell word: blanks, a newline and the metacharacters.
const WORD_ENDING_BYTES: &[u8] = b" \t\n;&|<>()";

// Where quoted text that starts at `from` ends: at its closing `quote`, each backslash taking the
// byte after it, or at the line's end when no quote closes it.
fn quoted_text_end(bytes: &[u8], from: usize, quote: u8) -> usize {
    let mut position = from;
    while let Some(&byte) = bytes.get(position) {
        if byte == quote {
            return position;
        }
        position += if byte == b'\\' { 2 } else { 1 };
    }
    bytes.len()
}
