//! The csh scan of a command line's fills: no grammar crate reads csh, so its quotes, comments and
//! here-documents are followed byte by byte, and each fill is placed by the quote around it.

use std::ops::Range;

use super::{CommandLineFills, FillPlace, FillPlacing, FillRefusal, follows_a_dollar, is_escaped};
use crate::shell_commands::ShellLineReader;

/// The quote the scan is inside.
#[derive(Clone, Copy, PartialEq, Eq)]
enum CshQuote {
    None,
    Single,
    Double,
    Backquote,
    BackquoteInDouble,
}

/// Each fill's place under csh, in line order: in double quotes the in-string form, outside any
/// quote the bare form, and refused in single quotes, backquotes, a comment, a here-document's
/// body or a line a quote is left open on. Every fill is refused on a line past the reader's limit.
pub(super) fn place_fills(reader: &ShellLineReader, fills: &CommandLineFills) -> Vec<FillPlacing> {
    let line = fills.line();
    if line.len() > reader.limit {
        return fills.refuse_all(&FillRefusal::NotWhole);
    }
    let Some(placeholders) = fills.placeholders_in(line) else {
        return fills.refuse_all(&FillRefusal::UnreadPlace);
    };
    CshScan::new(line, &placeholders).run()
}

/// The scan's state: where it is, the quote it is in, each fill's answer so far, the first fill of
/// the logical line it is on, and the here-document words that line started.
struct CshScan<'s> {
    line: &'s str,
    placeholders: &'s [Range<usize>],
    placings: Vec<Option<FillPlacing>>,
    next_fill: usize,
    position: usize,
    quote: CshQuote,
    line_first_fill: usize,
    here_document_words: Vec<&'s str>,
}

impl<'s> CshScan<'s> {
    fn new(line: &'s str, placeholders: &'s [Range<usize>]) -> Self {
        Self {
            line,
            placeholders,
            placings: vec![None; placeholders.len()],
            next_fill: 0,
            position: 0,
            quote: CshQuote::None,
            line_first_fill: 0,
            here_document_words: Vec::new(),
        }
    }

    fn run(mut self) -> Vec<FillPlacing> {
        let bytes = self.line.as_bytes();
        while self.position < bytes.len() {
            if let Some(placeholder) = self.placeholder_at(self.position) {
                let placing = self.place(placeholder.start);
                self.answer(placing);
                self.position = placeholder.end;
                continue;
            }
            let byte = bytes[self.position];
            self.position += 1;
            match (self.quote, byte) {
                (CshQuote::None | CshQuote::Backquote | CshQuote::Double, b'\\')
                    if self.is_quoted_by_backslash() =>
                {
                    self.position += 1;
                }
                (CshQuote::None, b'\'') => self.quote = CshQuote::Single,
                (CshQuote::None, b'"') | (CshQuote::BackquoteInDouble, b'`') => {
                    self.quote = CshQuote::Double;
                }
                (CshQuote::None, b'`') => self.quote = CshQuote::Backquote,
                (CshQuote::Double, b'`') => self.quote = CshQuote::BackquoteInDouble,
                (CshQuote::Single, b'\'')
                | (CshQuote::Double, b'"')
                | (CshQuote::Backquote, b'`') => {
                    self.quote = CshQuote::None;
                }
                (CshQuote::None, b'#') if self.starts_a_word(self.position - 1) => {
                    self.skip_comment();
                }
                (CshQuote::None, b'<') if bytes.get(self.position) == Some(&b'<') => {
                    self.position += 1;
                    self.read_here_document_word();
                }
                (CshQuote::None, b'\n') => self.end_logical_line(),
                (_, b'\n') => {
                    // csh refuses a quote left open at a line's end, and runs nothing of it.
                    self.refuse_line_from(self.line_first_fill, &FillRefusal::NotWhole);
                    self.quote = CshQuote::None;
                    self.end_logical_line();
                }
                _ => {}
            }
        }
        if self.quote != CshQuote::None {
            self.refuse_line_from(self.line_first_fill, &FillRefusal::NotWhole);
        }
        self.placings
            .into_iter()
            .map(|placing| placing.unwrap_or(Err(FillRefusal::UnreadPlace)))
            .collect()
    }

    /// Whether the backslash just passed quotes the byte after it: any byte but a placeholder's
    /// first, which is refused at its place, and in double quotes only a newline, which continues
    /// the line.
    fn is_quoted_by_backslash(&self) -> bool {
        if self.quote == CshQuote::Double {
            self.line.as_bytes().get(self.position) == Some(&b'\n')
        } else {
            self.placeholder_at(self.position).is_none()
        }
    }

    /// The next fill's placeholder when it starts at `at`.
    fn placeholder_at(&self, at: usize) -> Option<Range<usize>> {
        self.placeholders
            .get(self.next_fill)
            .filter(|placeholder| placeholder.start == at)
            .cloned()
    }

    /// Answers the next fill.
    fn answer(&mut self, placing: FillPlacing) {
        self.placings[self.next_fill] = Some(placing);
        self.next_fill += 1;
    }

    /// The place of a fill starting at `at`, by the quote it is in.
    fn place(&self, at: usize) -> FillPlacing {
        if self.quote != CshQuote::Single && is_escaped(self.line, at, b'\\') {
            return Err(FillRefusal::Escaped);
        }
        match self.quote {
            CshQuote::Single => Err(FillRefusal::NotExpanding),
            CshQuote::Backquote | CshQuote::BackquoteInDouble => Err(FillRefusal::Backquoted),
            CshQuote::None | CshQuote::Double if follows_a_dollar(self.line, at) => {
                Err(FillRefusal::UnreadPlace)
            }
            CshQuote::None => Ok(FillPlace::Bare),
            CshQuote::Double => Ok(FillPlace::InString),
        }
    }

    /// Whether the byte at `at` starts a word: the line's start or a blank or `;`, `&`, `|`, `(`
    /// or `)` before it.
    fn starts_a_word(&self, at: usize) -> bool {
        at == 0
            || matches!(
                self.line.as_bytes()[at - 1],
                b' ' | b'\t' | b'\n' | b';' | b'&' | b'|' | b'(' | b')'
            )
    }

    /// Skips a comment to its line's end, refusing every fill in it.
    fn skip_comment(&mut self) {
        let end = self.line[self.position..]
            .find('\n')
            .map_or(self.line.len(), |offset| self.position + offset);
        self.refuse_until(end, &FillRefusal::Comment);
        self.position = end;
    }

    /// Reads a here-document's word as written, after any blanks, and queues its body for the
    /// logical line's end; a fill in the word is refused.
    fn read_here_document_word(&mut self) {
        let bytes = self.line.as_bytes();
        while matches!(bytes.get(self.position), Some(b' ' | b'\t')) {
            self.position += 1;
        }
        let start = self.position;
        while let Some(&byte) = bytes.get(self.position)
            && !matches!(
                byte,
                b' ' | b'\t' | b'\n' | b';' | b'&' | b'|' | b'<' | b'>' | b'(' | b')'
            )
        {
            self.position += 1;
        }
        self.refuse_until(self.position, &FillRefusal::UnreadPlace);
        self.here_document_words
            .push(&self.line[start..self.position]);
    }

    /// Ends a logical line at the newline just passed: each here-document it started takes the
    /// lines after it up to the one that is exactly its word, every fill in them refused.
    fn end_logical_line(&mut self) {
        for word in std::mem::take(&mut self.here_document_words) {
            let mut end = self.line.len();
            let mut line_start = self.position;
            while line_start < self.line.len() {
                let line_end = self.line[line_start..]
                    .find('\n')
                    .map_or(self.line.len(), |offset| line_start + offset);
                if &self.line[line_start..line_end] == word {
                    end = (line_end + 1).min(self.line.len());
                    break;
                }
                line_start = line_end + 1;
            }
            self.refuse_until(end, &FillRefusal::CshHereDocumentBody);
            self.position = end;
        }
        self.line_first_fill = self.next_fill;
    }

    /// Refuses, for `refusal`, every fill not yet answered whose placeholder starts before `end`.
    fn refuse_until(&mut self, end: usize, refusal: &FillRefusal) {
        while self
            .placeholders
            .get(self.next_fill)
            .is_some_and(|placeholder| placeholder.start < end)
        {
            self.answer(Err(refusal.clone()));
        }
    }

    /// Refuses, for `refusal`, every fill of the logical line from fill `first` on, answered or not,
    /// up to the scan's position.
    fn refuse_line_from(&mut self, first: usize, refusal: &FillRefusal) {
        for (placeholder, placing) in self.placeholders.iter().zip(&mut self.placings).skip(first) {
            if placeholder.start >= self.position {
                break;
            }
            *placing = Some(Err(refusal.clone()));
        }
    }
}
