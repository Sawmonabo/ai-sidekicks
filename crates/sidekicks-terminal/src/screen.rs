//! A shell's screen copy: the terminal state its output draws, and the byte history window beside
//! it.

use std::io;

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

/// A shell's screen copy and its scrollback window, held under one lock. The caller's
/// `EventListener::send_event` runs under this lock while output is drawn, so it must not block
/// and must not call back into the terminal synchronously.
pub struct TerminalScreen<L: EventListener> {
    term: Term<L>,
    /// The listener's own copy, which hears that a synchronized update's held output was drawn.
    listener: L,
    scrollback: ScrollbackWindow,
    /// How many bytes of output the screen has taken since the shell started.
    output_offset: u64,
}

impl<L: EventListener + Clone> TerminalScreen<L> {
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

    /// Adds `output` to the scrollback window and draws it on the screen through `processor`.
    pub(crate) fn take_output(&mut self, processor: &mut Processor, output: Bytes) {
        self.output_offset +=
            u64::try_from(output.len()).expect("a chunk's length fits in 64 bits");
        processor.advance(&mut self.term, &output);
        self.scrollback.append(output);
    }

    /// Draws what a synchronized update held back, once its deadline has passed, and tells the
    /// listener the screen changed.
    pub(crate) fn stop_sync(&mut self, processor: &mut Processor) {
        processor.stop_sync(&mut self.term);
        self.listener.send_event(Event::Wakeup);
    }

    /// Resizes the screen to `rows` by `columns` cells.
    pub(crate) fn resize(&mut self, rows: u16, columns: u16) {
        self.term.resize(TerminalSize { rows, columns });
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
