//! A shell's output on the daemon's side: the daemon's own copy of its screen, which answers the
//! questions a program asks its terminal, and the one feed each watcher reads the output through.

pub(crate) mod screen;
pub mod stream;

#[cfg(test)]
mod tests {
    use std::mem;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    use bytes::Bytes;
    use rstest::rstest;
    use sidekicks_contracts::color::HexColor;
    use sidekicks_contracts::terminal::{TerminalCellSize, TerminalColors};
    use sidekicks_contracts::wire::integer::SafeInt;
    use sidekicks_contracts::wire::list::BoundedVec;
    use sidekicks_terminal::TerminalScreen;
    use vte::ansi::Processor;

    use super::screen::{
        ShellScreenAppearance, ShellScreenHooks, ShellScreenListener, is_bracketed_paste_requested,
    };
    use crate::resize::ShellSize;

    const TERMINAL_VERSION: &str = "sidekicks(0.1.0)";
    const SIZE: ShellSize = ShellSize {
        columns: 80,
        rows: 24,
    };

    /// A screen copy with no shell behind it, what its listener answered and how often the title
    /// changed, and the appearance its questions are answered from.
    struct AskedScreen {
        screen: TerminalScreen<ShellScreenListener>,
        listener: ShellScreenListener,
        processor: Processor,
        answers: Arc<Mutex<Vec<u8>>>,
        title_changes: Arc<AtomicUsize>,
        appearance: Arc<Mutex<ShellScreenAppearance>>,
    }

    impl AskedScreen {
        fn new() -> Self {
            let answers = Arc::new(Mutex::new(Vec::new()));
            let title_changes = Arc::new(AtomicUsize::new(0));
            let appearance = Arc::new(Mutex::new(ShellScreenAppearance::default()));
            let listener = ShellScreenListener::new(
                ShellScreenHooks {
                    terminal_version: TERMINAL_VERSION.to_owned(),
                    read_appearance: Box::new({
                        let appearance = Arc::clone(&appearance);
                        move || {
                            appearance
                                .lock()
                                .expect("no test panics holding it")
                                .clone()
                        }
                    }),
                    answer: Box::new({
                        let answers = Arc::clone(&answers);
                        move |answer: Bytes| {
                            answers
                                .lock()
                                .expect("no test panics holding it")
                                .extend_from_slice(&answer);
                        }
                    }),
                    report_title_change: Box::new({
                        let title_changes = Arc::clone(&title_changes);
                        move || {
                            title_changes.fetch_add(1, Ordering::SeqCst);
                        }
                    }),
                },
                SIZE,
            );
            Self {
                screen: TerminalScreen::without_shell(SIZE.rows, SIZE.columns, listener.clone()),
                listener,
                processor: Processor::new(),
                answers,
                title_changes,
                appearance,
            }
        }

        /// Draws `output` and hands back every answer it brought.
        fn ask(&mut self, output: &[u8]) -> String {
            self.screen.draw_output(&mut self.processor, output);
            let answers = mem::take(&mut *self.answers.lock().expect("no test panics"));
            String::from_utf8(answers).expect("every answer is text")
        }
    }

    fn colors(background: &str) -> Arc<TerminalColors> {
        let color = |text: &str| HexColor::new(text.to_owned()).expect("a test color is #rrggbb");
        let palette = (0..16)
            .map(|index| color(&format!("#0000{index:02x}")))
            .collect();
        Arc::new(TerminalColors {
            foreground: color("#d0d0d0"),
            background: color(background),
            cursor: color("#ffcc00"),
            palette: BoundedVec::new(palette).expect("a palette of sixteen"),
        })
    }

    fn cell_size(width: u64, height: u64) -> TerminalCellSize {
        TerminalCellSize {
            width: SafeInt::new(width).expect("a positive width"),
            height: SafeInt::new(height).expect("a positive height"),
        }
    }

    #[test]
    fn answers_every_question_as_xterm_js_does_in_the_order_asked() {
        let mut asked = AskedScreen::new();
        let color_and_cell = b"\x1b]11;?\x07\x1b]4;1;?\x1b\\\x1b[16t\x1b[14t";

        assert_eq!(
            asked.ask(b"abc\x1b[6n\x1b[>q"),
            format!("\x1b[1;4R\x1bP>|{TERMINAL_VERSION}\x1b\\")
        );
        assert_eq!(
            asked.ask(b"\x1b[c\x1b[>c\x1b[5n"),
            "\x1b[?1;2c\x1b[>0;276;0c\x1b[0n"
        );
        // A device-attributes question after another in one chunk is answered last.
        assert_eq!(
            asked.ask(b"\x1b[>0q\x1b[c"),
            format!("\x1bP>|{TERMINAL_VERSION}\x1b\\\x1b[?1;2c")
        );
        // A question split across two chunks is answered once the second completes it.
        assert_eq!(asked.ask(b"\x1b[>"), "");
        assert_eq!(asked.ask(b"q"), format!("\x1bP>|{TERMINAL_VERSION}\x1b\\"));
        // Before any report a color or cell question goes unanswered.
        assert_eq!(asked.ask(color_and_cell), "");

        asked.appearance.lock().expect("no test panics").colors = Some(colors("#101820"));
        assert_eq!(
            asked.ask(color_and_cell),
            "\x1b]11;rgb:1010/1818/2020\x1b\\\x1b]4;1;rgb:0000/0000/0101\x1b\\"
        );
        assert_eq!(
            asked.ask(b"\x1b]10;?;?;?\x07\x1b]4;196;?;244;?\x07"),
            "\x1b]10;rgb:d0d0/d0d0/d0d0\x1b\\\x1b]11;rgb:1010/1818/2020\x1b\\\
             \x1b]12;rgb:ffff/cccc/0000\x1b\\\x1b]4;196;rgb:ffff/0000/0000\x1b\\\
             \x1b]4;244;rgb:8080/8080/8080\x1b\\"
        );

        *asked.appearance.lock().expect("no test panics") = ShellScreenAppearance {
            colors: Some(colors("#fafafa")),
            cell_size: Some(cell_size(9, 18)),
        };
        assert_eq!(
            asked.ask(color_and_cell),
            "\x1b]11;rgb:fafa/fafa/fafa\x1b\\\x1b]4;1;rgb:0000/0000/0101\x1b\\\
             \x1b[6;18;9t\x1b[4;432;720t"
        );

        assert!(!is_bracketed_paste_requested(&asked.screen));
        asked.ask(b"\x1b[?2004h");
        assert!(is_bracketed_paste_requested(&asked.screen));
    }

    #[rstest]
    #[case::fits_whole("a".repeat(256), "a".repeat(256))]
    #[case::cluster_across_the_bound_left_out(
        format!("{}e\u{301}z", "a".repeat(255)),
        "a".repeat(255)
    )]
    #[case::one_cluster_past_the_bound(
        format!("e{}", "\u{301}".repeat(300)),
        format!("e{}", "\u{301}".repeat(255))
    )]
    fn cuts_the_title_on_a_grapheme_read_across_a_split(
        #[case] title: String,
        #[case] kept: String,
    ) {
        let mut asked = AskedScreen::new();
        let set_title = format!("\x1b]2;{title}\x07\x1b[>q");
        let (first, second) = set_title.as_bytes().split_at(set_title.len() / 2);

        asked.ask(first);
        // The question after the title is still read.
        assert_eq!(
            asked.ask(second),
            format!("\x1bP>|{TERMINAL_VERSION}\x1b\\")
        );
        asked.ask(format!("\x1b]0;{title}\x07").as_bytes());

        assert_eq!(asked.listener.title(), Some(kept));
        assert_eq!(asked.title_changes.load(Ordering::SeqCst), 1);
        asked.ask(b"\x1b]2;\x07");
        assert_eq!(asked.listener.title(), None);
    }
}
