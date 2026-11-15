//! Text a program printed for a terminal, read as the terminal shows it.

/// The text of `output` as a terminal shows it: its printed characters, line breaks and tabs, with
/// every other control character, control sequence and operating-system command (a link wrapper or
/// a color among them) left out. A sequence `output` ends inside shows nothing.
pub fn strip_terminal_controls(output: &[u8]) -> String {
    let mut shown = ShownText(String::with_capacity(output.len()));
    vte::Parser::new().advance(&mut shown, output);
    shown.0
}

// The characters a terminal shows, gathered as the parser hands them over.
struct ShownText(String);

impl vte::Perform for ShownText {
    fn print(&mut self, character: char) {
        // The parser hands DEL over as printed, though a terminal draws nothing for it.
        if character != '\u{7f}' {
            self.0.push(character);
        }
    }

    fn execute(&mut self, byte: u8) {
        if matches!(byte, b'\n' | b'\r' | b'\t') {
            self.0.push(char::from(byte));
        }
    }
}
