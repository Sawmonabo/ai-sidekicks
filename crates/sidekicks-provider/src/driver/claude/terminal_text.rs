//! Text a Claude Code command printed for a terminal, read as the terminal shows it.

/// The text of `line` as a terminal shows it: its printed characters, every control sequence and
/// operating-system command (a link wrapper or a color among them) left out, then trimmed.
pub(crate) fn strip_terminal_controls(line: &[u8]) -> String {
    let mut shown = ShownText(String::with_capacity(line.len()));
    vte::Parser::new().advance(&mut shown, line);
    shown.0.trim().to_owned()
}

/// The characters a terminal prints, gathered as the parser hands them over.
struct ShownText(String);

impl vte::Perform for ShownText {
    fn print(&mut self, character: char) {
        self.0.push(character);
    }
}
