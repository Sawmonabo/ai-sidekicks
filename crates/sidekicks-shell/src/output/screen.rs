//! A shell's output on the daemon's side: the listener on the daemon's own copy of its screen,
//! which answers the questions a program asks its terminal once, here, as a multiplexer does, so no
//! pane answers and a shell no pane shows still gets its answer: the cursor's place, a mode's state
//! and the text area's size in characters from the screen itself, the device's attributes as
//! xterm.js gives them, the version from the daemon, and the colors and cell size from the
//! appearance last reported, with no answer before one is. It also keeps the title the program sets
//! (OSC 0 or OSC 2), cut to the wire's bound, and reads whether the program asked for pasted text
//! to be marked as pasted (mode 2004).

use std::collections::VecDeque;
use std::sync::{Arc, Mutex, MutexGuard};

use alacritty_terminal::event::{Event, EventListener};
use alacritty_terminal::term::TermMode;
use bytes::Bytes;
use sidekicks_contracts::color::HexColor;
use sidekicks_contracts::terminal::{
    SHELL_TITLE_MAX_LEN, TERMINAL_PALETTE_LENGTH, TerminalCellSize, TerminalColors,
};
use sidekicks_terminal::{ScreenListener, TerminalScreen};
use unicode_segmentation::UnicodeSegmentation;
use vte::ansi::NamedColor;
use vte::{Params, Parser, Perform};

use crate::resize::ShellSize;
use sidekicks_std::text_cut::cut_to_code_points;

/// The primary device attributes the screen copy's terminal gives.
const SCREEN_PRIMARY_ATTRIBUTES: &str = "\x1b[?6c";
/// The primary device attributes xterm.js gives, which every answer matches.
const PRIMARY_ATTRIBUTES: &str = "\x1b[?1;2c";
/// The start and end of the secondary device attributes the screen copy's terminal gives, its
/// version between them.
const SCREEN_SECONDARY_ATTRIBUTES: (&str, &str) = ("\x1b[>0;", ";1c");
/// The secondary device attributes xterm.js gives.
const SECONDARY_ATTRIBUTES: &str = "\x1b[>0;276;0c";
/// The color index past the 256-color table a foreground question names.
const FOREGROUND_INDEX: usize = NamedColor::Foreground as usize;
/// The color index a background question names.
const BACKGROUND_INDEX: usize = NamedColor::Background as usize;
/// The color index a cursor color question names.
const CURSOR_INDEX: usize = NamedColor::Cursor as usize;
/// The first index of xterm's 6×6×6 color cube, past the sixteen ANSI colors.
const CUBE_FIRST_INDEX: usize = TERMINAL_PALETTE_LENGTH;
/// The first of xterm's 24 grays, past the cube.
const GRAY_FIRST_INDEX: usize = 232;
/// The last index of xterm's 256-color table.
const LAST_COLOR_INDEX: usize = 255;
/// The six levels each channel of the color cube takes.
const CUBE_LEVELS: [u8; 6] = [0, 95, 135, 175, 215, 255];
/// The window report answered with one cell's size in pixels.
const CELL_PIXELS_REPORT: u16 = 16;

/// What a shell's terminal looks like to a program that asks: its colors and its cell size, each
/// absent until reported.
#[derive(Clone, Debug, Default)]
pub(crate) struct ShellScreenAppearance {
    /// The colors a color question is answered from.
    pub(crate) colors: Option<Arc<TerminalColors>>,
    /// The cell size a cell or text-area pixel question is answered from.
    pub(crate) cell_size: Option<TerminalCellSize>,
}

/// What a shell's screen listener calls out to. Each runs under the screen's lock while output is
/// drawn, so none may block or take the screen's lock; none runs under the listener's own lock.
pub(crate) struct ShellScreenHooks {
    /// What the terminal answers XTVERSION with: its name and version.
    pub(crate) terminal_version: String,
    /// Reads the appearance the colors and cell size are answered from, at each question.
    pub(crate) read_appearance: Box<dyn Fn() -> ShellScreenAppearance + Send + Sync>,
    /// Takes an answer bound for the program, as input to the shell.
    pub(crate) answer: Box<dyn Fn(Bytes) + Send + Sync>,
    /// Called when the title the program set changes.
    pub(crate) report_title_change: Box<dyn Fn() + Send + Sync>,
}

/// The listener on one shell's screen copy: it answers what the screen copy's terminal asks of it
/// and what the screen copy leaves unanswered, and keeps the program's title. Its clones share one
/// state, so the screen's own copy and the terminal's copy are one listener.
#[derive(Clone)]
pub(crate) struct ShellScreenListener {
    shared: Arc<ListenerShared>,
}

/// What every clone of a listener shares.
struct ListenerShared {
    hooks: ShellScreenHooks,
    state: Mutex<ListenerState>,
}

/// A listener's state, taken only for its own reads and writes, never while a hook runs.
struct ListenerState {
    /// The parser that finds the questions the screen copy leaves, kept across chunks so a
    /// question split across two ends in the second.
    parser: Parser,
    /// The questions found and not yet answered, oldest first.
    questions: VecDeque<Question>,
    /// The title the program set, cut to the wire's bound, or none.
    title: Option<String>,
    /// The size the screen was last drawn at, which the text area's pixel size is counted from.
    size: ShellSize,
}

/// A question the screen copy's terminal leaves unanswered.
#[derive(Clone, Copy, Debug)]
enum Question {
    /// XTVERSION, `CSI > q`: the terminal's name and version.
    Version,
    /// `CSI 16 t`: one cell's size in pixels.
    CellSize,
}

impl ShellScreenListener {
    /// A listener calling out through `hooks`, for a screen drawn at `size`.
    pub(crate) fn new(hooks: ShellScreenHooks, size: ShellSize) -> Self {
        Self {
            shared: Arc::new(ListenerShared {
                hooks,
                state: Mutex::new(ListenerState {
                    parser: Parser::new(),
                    questions: VecDeque::new(),
                    title: None,
                    size,
                }),
            }),
        }
    }

    /// Records the size the screen is drawn at, which the screen copy's own resize does not report;
    /// the shell table calls it with each size it gives the terminal.
    pub(crate) fn record_size(&self, size: ShellSize) {
        self.lock_state().size = size;
    }

    /// The title the program set for itself, cut to [`SHELL_TITLE_MAX_LEN`] code points on a
    /// grapheme boundary, or none until it sets one or after it clears it.
    pub(crate) fn title(&self) -> Option<String> {
        self.lock_state().title.clone()
    }

    fn lock_state(&self) -> MutexGuard<'_, ListenerState> {
        self.shared
            .state
            .lock()
            .expect("no panic holds a screen listener's lock, since a panic ends the daemon")
    }

    fn answer(&self, answer: String) {
        (self.shared.hooks.answer)(Bytes::from(answer));
    }

    /// Keeps `title` cut to the wire's bound, none when empty, and reports a change.
    fn set_title(&self, title: Option<&str>) {
        let next = title.map(cut_title).filter(|kept| !kept.is_empty());
        let has_changed = {
            let mut state = self.lock_state();
            if state.title.as_deref() == next {
                false
            } else {
                state.title = next.map(str::to_owned);
                true
            }
        };
        if has_changed {
            (self.shared.hooks.report_title_change)();
        }
    }
}

impl EventListener for ShellScreenListener {
    fn send_event(&self, event: Event) {
        match event {
            Event::PtyWrite(text) => {
                if text == SCREEN_PRIMARY_ATTRIBUTES {
                    self.answer(PRIMARY_ATTRIBUTES.to_owned());
                } else if is_screen_secondary_attributes(&text) {
                    self.answer(SECONDARY_ATTRIBUTES.to_owned());
                } else {
                    self.answer(text);
                }
            }
            // The answer is built here rather than through the event's own format, which ends it
            // with the question's terminator where xterm.js always ends it with `ESC \`.
            Event::ColorRequest(index, _) => {
                let ShellScreenAppearance { colors, .. } = (self.shared.hooks.read_appearance)();
                if let Some(answer) = colors.and_then(|colors| color_answer(&colors, index)) {
                    self.answer(answer);
                }
            }
            // Counted here rather than through the event's own format, whose 16-bit product of the
            // rows and the cell height overflows on a tall screen.
            Event::TextAreaSizeRequest(_) => {
                let ShellScreenAppearance { cell_size, .. } = (self.shared.hooks.read_appearance)();
                if let Some(cell_size) = cell_size {
                    let size = self.lock_state().size;
                    let height = u128::from(cell_size.height.get()) * u128::from(size.rows);
                    let width = u128::from(cell_size.width.get()) * u128::from(size.columns);
                    self.answer(format!("\x1b[4;{height};{width}t"));
                }
            }
            Event::Title(title) => self.set_title(Some(&title)),
            Event::ResetTitle => self.set_title(None),
            Event::MouseCursorDirty
            | Event::ClipboardStore(..)
            | Event::ClipboardLoad(..)
            | Event::CursorBlinkingChange
            | Event::Wakeup
            | Event::Bell
            | Event::Exit
            | Event::ChildExit(_) => {}
        }
    }
}

impl ScreenListener for ShellScreenListener {
    fn find_questions(&mut self, output: &[u8], ends: &mut Vec<usize>) {
        let mut state = self.lock_state();
        let ListenerState {
            parser, questions, ..
        } = &mut *state;
        let mut finder = QuestionFinder { question: None };
        let mut read = 0;
        while read < output.len() {
            // The parser stops just past each question's final byte, so `read` is its end.
            read += parser.advance_until_terminated(&mut finder, &output[read..]);
            if let Some(question) = finder.question.take() {
                questions.push_back(question);
                ends.push(read);
            }
        }
    }

    fn answer_question(&mut self) {
        let Some(question) = self.lock_state().questions.pop_front() else {
            return;
        };
        match question {
            Question::Version => {
                let version = &self.shared.hooks.terminal_version;
                self.answer(format!("\x1bP>|{version}\x1b\\"));
            }
            Question::CellSize => {
                let ShellScreenAppearance { cell_size, .. } = (self.shared.hooks.read_appearance)();
                if let Some(cell_size) = cell_size {
                    let (height, width) = (cell_size.height.get(), cell_size.width.get());
                    self.answer(format!("\x1b[6;{height};{width}t"));
                }
            }
        }
    }
}

/// Whether the program in the shell asked for pasted text to be marked as pasted, as of the output
/// the screen copy has drawn.
pub(crate) fn is_bracketed_paste_requested(screen: &TerminalScreen<ShellScreenListener>) -> bool {
    screen.term().mode().contains(TermMode::BRACKETED_PASTE)
}

/// The `vte` performer that stops the parser at each question the screen copy leaves unanswered.
struct QuestionFinder {
    question: Option<Question>,
}

impl Perform for QuestionFinder {
    fn csi_dispatch(&mut self, params: &Params, intermediates: &[u8], ignore: bool, action: char) {
        if ignore {
            return;
        }
        let first_param = params
            .iter()
            .next()
            .and_then(|param| param.first().copied());
        self.question = match (action, intermediates) {
            ('q', [b'>']) => Some(Question::Version),
            ('t', []) if first_param == Some(CELL_PIXELS_REPORT) => Some(Question::CellSize),
            _ => None,
        };
    }

    fn terminated(&self) -> bool {
        self.question.is_some()
    }
}

/// Whether `text` is the screen copy's terminal's secondary device attributes, whatever version
/// it names.
fn is_screen_secondary_attributes(text: &str) -> bool {
    let (start, end) = SCREEN_SECONDARY_ATTRIBUTES;
    text.strip_prefix(start)
        .and_then(|rest| rest.strip_suffix(end))
        .is_some_and(|version| {
            !version.is_empty() && version.bytes().all(|byte| byte.is_ascii_digit())
        })
}

/// The answer to a question for the color at `index`, as xterm.js gives it: OSC 4 with the index
/// for the 256-color table, OSC 10, 11 or 12 for the foreground, background and cursor, the color
/// as an X11 spec of four hex digits a channel, ended by `ESC \`; none for an index past them.
fn color_answer(colors: &TerminalColors, index: usize) -> Option<String> {
    let (prefix, [red, green, blue]) = match index {
        FOREGROUND_INDEX => ("10".to_owned(), channels(&colors.foreground)),
        BACKGROUND_INDEX => ("11".to_owned(), channels(&colors.background)),
        CURSOR_INDEX => ("12".to_owned(), channels(&colors.cursor)),
        _ => (format!("4;{index}"), palette_color(colors, index)?),
    };
    Some(format!(
        "\x1b]{prefix};rgb:{red:02x}{red:02x}/{green:02x}{green:02x}/{blue:02x}{blue:02x}\x1b\\"
    ))
}

/// The color at `index` of xterm's 256-color table: the reported palette, then the fixed cube and
/// gray ramp every xterm-compatible terminal shares.
fn palette_color(colors: &TerminalColors, index: usize) -> Option<[u8; 3]> {
    match index {
        0..CUBE_FIRST_INDEX => colors.palette.as_slice().get(index).map(channels),
        CUBE_FIRST_INDEX..GRAY_FIRST_INDEX => {
            let cube = index - CUBE_FIRST_INDEX;
            Some([
                CUBE_LEVELS[cube / 36],
                CUBE_LEVELS[cube / 6 % 6],
                CUBE_LEVELS[cube % 6],
            ])
        }
        GRAY_FIRST_INDEX..=LAST_COLOR_INDEX => {
            let level = u8::try_from(8 + (index - GRAY_FIRST_INDEX) * 10)
                .expect("the gray ramp's brightest level is 238");
            Some([level; 3])
        }
        _ => None,
    }
}

/// The red, green and blue of a `#rrggbb` color.
fn channels(color: &HexColor) -> [u8; 3] {
    let text = color.as_str();
    [1, 3, 5].map(|start| {
        u8::from_str_radix(&text[start..start + 2], 16).expect("a checked color is #rrggbb")
    })
}

/// `title` cut after its last whole grapheme within the wire's bound in code points, so an emoji
/// or an accented letter is never split; cut at the bound itself only when its first grapheme
/// alone is longer.
pub(crate) fn cut_title(title: &str) -> &str {
    let mut code_points = 0;
    let mut end = 0;
    for grapheme in title.graphemes(true) {
        code_points += grapheme.chars().count();
        if code_points > SHELL_TITLE_MAX_LEN {
            return if end == 0 {
                cut_to_code_points(title, SHELL_TITLE_MAX_LEN)
            } else {
                &title[..end]
            };
        }
        end += grapheme.len();
    }
    title
}
