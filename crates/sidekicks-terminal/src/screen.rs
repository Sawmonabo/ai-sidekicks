//! A shell's screen copy: the terminal state its output draws, and the byte history window beside
//! it.

use alacritty_terminal::Term;
use alacritty_terminal::event::EventListener;
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::term::Config;
use vte::ansi::Processor;

use crate::scrollback::ScrollbackWindow;

/// A shell's screen copy and its scrollback window, held under one lock. The caller's
/// `EventListener::send_event` runs under this lock while output is drawn, so it must not block
/// and must not call back into the terminal synchronously.
pub struct TerminalScreen<L: EventListener> {
    term: Term<L>,
    scrollback: ScrollbackWindow,
    /// How many bytes of output the screen has taken since the shell started.
    output_offset: u64,
}

impl<L: EventListener> TerminalScreen<L> {
    /// A blank screen of `rows` by `columns` cells that keeps no history of its own, since the
    /// scrollback window holds it.
    pub(crate) fn new(rows: u16, columns: u16, listener: L) -> Self {
        let config = Config {
            scrolling_history: 0,
            ..Config::default()
        };
        Self {
            term: Term::new(config, &TerminalSize { rows, columns }, listener),
            scrollback: ScrollbackWindow::new(),
            output_offset: 0,
        }
    }

    /// The terminal state the shell's output has drawn.
    pub fn term(&self) -> &Term<L> {
        &self.term
    }

    /// The scrollback window's bytes and the output offset its last byte ends at: a caller that
    /// counts the output it has received can tell which of the chunks it receives after this read
    /// the window already holds.
    pub fn scrollback(&self) -> (Vec<u8>, u64) {
        (self.scrollback.read(), self.output_offset)
    }

    /// Adds `output` to the scrollback window and draws it on the screen through `processor`.
    pub(crate) fn take_output(&mut self, processor: &mut Processor, output: &[u8]) {
        self.scrollback.append(output);
        self.output_offset +=
            u64::try_from(output.len()).expect("a chunk's length fits in 64 bits");
        processor.advance(&mut self.term, output);
    }

    /// Draws what a synchronized update held back, once its deadline has passed.
    pub(crate) fn stop_sync(&mut self, processor: &mut Processor) {
        processor.stop_sync(&mut self.term);
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
