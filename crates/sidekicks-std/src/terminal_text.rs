//! Text a program printed for a terminal, read as the terminal shows it.

/// The most bytes a string a program opened and never closed, or any other stretch that shows
/// nothing, is read for before the rest of its line is dropped, so the parser holds a bounded
/// string however long the stretch runs.
const OPEN_STRING_MAX_BYTES: usize = 8 * 1024;

/// The text of `output` as a terminal shows it: its printed characters, line breaks and tabs, with
/// every other control character, control sequence and operating-system command (a link wrapper or
/// a color among them) left out, and each line redrawn in place reading as its last drawing. A
/// carriage return starts its line over once a printed character follows it on the same line, so
/// `\r\n` is one line break and a line ending in `\r` keeps what it shows. Unlike a terminal, a
/// string opened and never closed ends at the next line break, and one that runs 8 KiB with no line
/// break drops the rest of its line, so no later line is swallowed. A sequence `output` ends inside
/// shows nothing.
pub fn strip_terminal_controls(output: &[u8]) -> String {
    let mut shown = String::with_capacity(output.len());
    TerminalTextReader::new().push(output, &mut shown);
    shown
}

/// What a terminal shows of text, as the reader hands it over.
pub(crate) trait ShownText {
    /// A printed character, a tab among them.
    fn push_char(&mut self, character: char);
    /// A line break.
    fn break_line(&mut self);
    /// Starts the current line over.
    fn clear_line(&mut self);
}

impl ShownText for String {
    fn push_char(&mut self, character: char) {
        self.push(character);
    }

    fn break_line(&mut self) {
        self.push('\n');
    }

    fn clear_line(&mut self) {
        let line_start = self.rfind('\n').map_or(0, |at| at + 1);
        self.truncate(line_start);
    }
}

/// Reads a program's output as a terminal shows it, piece by piece as it arrives, as
/// [`strip_terminal_controls`] reads it whole: a sequence cut between two pieces is read whole.
pub(crate) struct TerminalTextReader {
    parser: vte::Parser,
    // A carriage return no printed character has followed on its line yet.
    is_return_pending: bool,
    // Bytes read since the parser last acted, in the pieces that showed nothing.
    quiet_bytes: usize,
    // Whether the rest of the current line is dropped, an open string having run too long.
    is_dropping_line: bool,
}

impl TerminalTextReader {
    /// A reader at the start of its output.
    pub(crate) fn new() -> Self {
        Self {
            parser: vte::Parser::new(),
            is_return_pending: false,
            quiet_bytes: 0,
            is_dropping_line: false,
        }
    }

    /// Reads `bytes`, the next piece of the output, handing what it shows to `shown`. The parser
    /// reads at most 8 KiB at once and each line apart, so a line break the parser took inside an
    /// open string ends it.
    pub(crate) fn push(&mut self, mut bytes: &[u8], shown: &mut impl ShownText) {
        while !bytes.is_empty() {
            if self.is_dropping_line {
                let Some(at) = bytes.iter().position(|byte| *byte == b'\n') else {
                    return;
                };
                bytes = &bytes[at + 1..];
                self.is_dropping_line = false;
                self.end_line(shown);
                continue;
            }
            let window = &bytes[..bytes.len().min(OPEN_STRING_MAX_BYTES)];
            let piece_len = (window.iter())
                .position(|byte| *byte == b'\n')
                .map_or(window.len(), |at| at + 1);
            let (piece, rest) = bytes.split_at(piece_len);
            bytes = rest;
            let mut performer = ShownPerformer {
                shown: &mut *shown,
                is_return_pending: &mut self.is_return_pending,
                has_acted: false,
                has_broken_line: false,
            };
            self.parser.advance(&mut performer, piece);
            let (has_acted, has_broken_line) = (performer.has_acted, performer.has_broken_line);
            if piece.last() == Some(&b'\n') && !has_broken_line {
                // The parser took the line break inside an open string, which ends there.
                self.parser = vte::Parser::new();
                self.end_line(shown);
            } else if has_acted {
                self.quiet_bytes = 0;
            } else {
                self.quiet_bytes += piece.len();
                if self.quiet_bytes >= OPEN_STRING_MAX_BYTES {
                    self.parser = vte::Parser::new();
                    self.is_dropping_line = true;
                }
            }
        }
    }

    // Breaks the line where an open string ended, with nothing held from the one it ends.
    fn end_line(&mut self, shown: &mut impl ShownText) {
        self.is_return_pending = false;
        self.quiet_bytes = 0;
        shown.break_line();
    }
}

// The parser's actions on one piece, handed to the text they show.
struct ShownPerformer<'piece, Shown: ShownText> {
    shown: &'piece mut Shown,
    is_return_pending: &'piece mut bool,
    // Whether the parser printed, executed or ended a sequence in the piece.
    has_acted: bool,
    // Whether the parser took a line break as one.
    has_broken_line: bool,
}

impl<Shown: ShownText> ShownPerformer<'_, Shown> {
    // Shows `character` on the line, which a pending carriage return starts over first.
    fn show(&mut self, character: char) {
        if std::mem::take(self.is_return_pending) {
            self.shown.clear_line();
        }
        self.shown.push_char(character);
    }
}

impl<Shown: ShownText> vte::Perform for ShownPerformer<'_, Shown> {
    fn print(&mut self, character: char) {
        self.has_acted = true;
        // The parser hands DEL over as printed, though a terminal draws nothing for it.
        if character != '\u{7f}' {
            self.show(character);
        }
    }

    fn execute(&mut self, byte: u8) {
        self.has_acted = true;
        match byte {
            b'\n' => {
                *self.is_return_pending = false;
                self.has_broken_line = true;
                self.shown.break_line();
            }
            b'\r' => *self.is_return_pending = true,
            b'\t' => self.show('\t'),
            _ => {}
        }
    }

    fn csi_dispatch(&mut self, _: &vte::Params, _: &[u8], _: bool, _: char) {
        self.has_acted = true;
    }

    fn esc_dispatch(&mut self, _: &[u8], _: bool, _: u8) {
        self.has_acted = true;
    }

    fn osc_dispatch(&mut self, _: &[&[u8]], _: bool) {
        self.has_acted = true;
    }
}
