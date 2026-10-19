//! A shell's screen copy: the terminal state its output draws, the byte history window beside
//! it, and the listener that answers the questions a program asks its terminal.

use std::io;
use std::mem;

use alacritty_terminal::Term;
use alacritty_terminal::event::{Event, EventListener};
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::term::{Config, MIN_COLUMNS, MIN_SCREEN_LINES};
use bytes::Bytes;
use vte::ansi::Processor;

use crate::scrollback::ScrollbackWindow;

/// Refuses a screen size the terminal cannot take: rows below one or columns below two, or either
/// past `i16::MAX`, which Windows' console cannot hold. Fails with `InvalidInput`.
pub(crate) fn check_screen_size(rows: u16, columns: u16) -> io::Result<()> {
    let largest = i16::MAX.cast_unsigned();
    let is_valid_rows = (MIN_SCREEN_LINES..=usize::from(largest)).contains(&usize::from(rows));
    let is_valid_columns = (MIN_COLUMNS..=usize::from(largest)).contains(&usize::from(columns));
    if is_valid_rows && is_valid_columns {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("a terminal of {rows} rows by {columns} columns is out of range"),
        ))
    }
}

/// A read of the scrollback window: its bytes, and the output offset its last byte ends at, so a
/// caller that counts the output it receives can tell which later chunks the window already holds.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScrollbackRead {
    /// The window's bytes, oldest first.
    pub bytes: Vec<u8>,
    /// How many bytes of output the shell had produced when the window was read.
    pub output_offset: u64,
}

/// What hears a shell's screen copy: the screen's events, and the questions a program asks its
/// terminal that the screen copy leaves unanswered. Every call runs under the screen's lock while
/// output is drawn, so none may block or call back into the terminal synchronously.
pub trait ScreenListener: EventListener + Clone + Send + 'static {
    /// Reads `output`, the next bytes the screen copy draws, for the questions the screen copy
    /// leaves unanswered, appending to `ends` the offset just past each one in `output`, in order;
    /// a question split across chunks ends in the chunk that completes it.
    fn find_questions(&mut self, output: &[u8], ends: &mut Vec<usize>);

    /// Answers the oldest question [`Self::find_questions`] found and has not answered, once the
    /// screen copy has drawn every byte before its end, so its answer follows the screen copy's own
    /// answers to the questions asked before it.
    fn answer_question(&mut self);
}

/// A shell's screen copy and its scrollback window, held under one lock. The listener runs under
/// this lock while output is drawn, so it must not block and must not call back into the terminal
/// synchronously.
pub struct TerminalScreen<L: EventListener> {
    term: Term<L>,
    /// The listener's own copy, which finds and answers the questions the screen leaves.
    listener: L,
    scrollback: ScrollbackWindow,
    /// How many bytes of output the screen has taken since the shell started.
    output_offset: u64,
    /// The ends of the questions the listener found in the chunk being drawn, kept for its room.
    question_ends: Vec<usize>,
}

impl<L: ScreenListener> TerminalScreen<L> {
    /// A blank screen of `rows` by `columns` cells that keeps no history of its own, since the
    /// scrollback window holds it.
    pub(crate) fn new(rows: u16, columns: u16, listener: L) -> Self {
        let config = Config {
            scrolling_history: 0,
            ..Config::default()
        };
        Self {
            term: Term::new(config, &TerminalSize { rows, columns }, listener.clone()),
            listener,
            scrollback: ScrollbackWindow::new(),
            output_offset: 0,
            question_ends: Vec::new(),
        }
    }

    /// The terminal state the shell's output has drawn.
    pub fn term(&self) -> &Term<L> {
        &self.term
    }

    /// The scrollback window's bytes and the output offset its last byte ends at.
    pub fn scrollback(&self) -> ScrollbackRead {
        ScrollbackRead {
            bytes: self.scrollback.read(),
            output_offset: self.output_offset,
        }
    }

    /// At most `max` bytes of the output that came after `offset`, read from the scrollback window
    /// and copying only those bytes; `None` when the window no longer holds the byte at `offset`,
    /// or `offset` is past the output, so a reader at that cursor has missed output. Empty when
    /// `offset` is the end of the output.
    pub fn output_after(&self, offset: u64, max: usize) -> Option<Vec<u8>> {
        let window_bytes =
            u64::try_from(self.scrollback.byte_count()).expect("a window's length fits in 64 bits");
        let window_start = self.output_offset - window_bytes;
        if offset < window_start || offset > self.output_offset {
            return None;
        }
        let skip = usize::try_from(offset - window_start).expect("a skip within the window fits");
        Some(self.scrollback.read_range(skip, max))
    }

    /// Adds `output` to the scrollback window and draws it on the screen through `processor`, up
    /// to the end of each question the listener finds and then the answer to it, so every answer
    /// leaves in the order its question was asked.
    pub(crate) fn take_output(&mut self, processor: &mut Processor, output: Bytes) {
        self.output_offset +=
            u64::try_from(output.len()).expect("a chunk's length fits in 64 bits");
        let mut question_ends = mem::take(&mut self.question_ends);
        question_ends.clear();
        self.listener.find_questions(&output, &mut question_ends);
        let mut drawn = 0;
        for &end in &question_ends {
            self.draw(processor, &output[drawn..end]);
            self.listener.answer_question();
            drawn = end;
        }
        self.draw(processor, &output[drawn..]);
        self.question_ends = question_ends;
        self.scrollback.append(output);
    }

    /// Draws `output` through `processor`, and at once any synchronized update it holds back: the
    /// screen copy shows nothing, so holding it would only hold the screen's answers back, and a
    /// pane draws the update from the raw output itself.
    fn draw(&mut self, processor: &mut Processor, output: &[u8]) {
        processor.advance(&mut self.term, output);
        if processor.sync_timeout().sync_timeout().is_some() {
            processor.stop_sync(&mut self.term);
            self.listener.send_event(Event::Wakeup);
        }
    }

    /// Resizes the screen to `rows` by `columns` cells.
    pub(crate) fn resize(&mut self, rows: u16, columns: u16) {
        self.term.resize(TerminalSize { rows, columns });
    }
}

#[cfg(any(test, feature = "test-support"))]
impl<L: ScreenListener> TerminalScreen<L> {
    /// A screen copy of `rows` by `columns` cells with no shell behind it, for another crate's
    /// tests of its listener.
    pub fn without_shell(rows: u16, columns: u16, listener: L) -> Self {
        Self::new(rows, columns, listener)
    }

    /// Draws `output` through `processor` as a shell's read loop draws each chunk.
    pub fn draw_output(&mut self, processor: &mut Processor, output: &[u8]) {
        self.take_output(processor, Bytes::copy_from_slice(output));
    }
}

/// A screen's size in cells, with no lines beyond the visible ones.
pub(crate) struct TerminalSize {
    rows: u16,
    columns: u16,
}

impl Dimensions for TerminalSize {
    fn total_lines(&self) -> usize {
        self.screen_lines()
    }

    fn screen_lines(&self) -> usize {
        usize::from(self.rows)
    }

    fn columns(&self) -> usize {
        usize::from(self.columns)
    }
}
