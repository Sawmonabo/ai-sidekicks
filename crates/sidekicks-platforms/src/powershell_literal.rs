//! Text written as a PowerShell single-quoted string, which PowerShell reads as that text exactly.

/// The characters PowerShell reads as a single quote, each doubled inside a single-quoted string.
const POWERSHELL_SINGLE_QUOTES: [char; 5] = ['\'', '\u{2018}', '\u{2019}', '\u{201A}', '\u{201B}'];

/// `text` as a PowerShell single-quoted string: every character PowerShell reads as a single quote
/// doubled, so none ends the string.
pub fn quote_powershell_literal(text: &str) -> String {
    let mut quoted = String::with_capacity(text.len() + 2);
    quoted.push('\'');
    for character in text.chars() {
        if POWERSHELL_SINGLE_QUOTES.contains(&character) {
            quoted.push(character);
        }
        quoted.push(character);
    }
    quoted.push('\'');
    quoted
}
