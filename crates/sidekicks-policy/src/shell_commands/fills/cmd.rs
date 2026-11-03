//! cmd.exe's own reading of a filled line: the `^` it reads as an escape before a fill, and the
//! text its delayed expansion would change, which the launch escapes so the command gets the text
//! as written. cmd.exe first removes each `^` outside double quotes, keeping the character after it
//! as text; delayed expansion then reads again each piece of a command holding a `!`, the command
//! name, the arguments as one piece and each redirection's target, quotes or not, removing each `^`
//! and pairing each `!`.

use std::ops::Range;

/// Whether the byte before `at` in `text` is a `^` cmd.exe reads as an escape: one outside double
/// quotes and not itself escaped. Inside `"…"` cmd.exe reads `^` as plain text, so a regex anchor
/// such as `grep "^{{ x }}"` stands.
pub(super) fn follows_a_cmd_escape(text: &str, at: usize) -> bool {
    let mut is_quoted = false;
    let mut is_escaping = false;
    for &byte in &text.as_bytes()[..at] {
        if std::mem::take(&mut is_escaping) {
            continue;
        }
        match byte {
            b'"' => is_quoted = !is_quoted,
            b'^' if !is_quoted => is_escaping = true,
            _ => {}
        }
    }
    is_escaping
}

/// How cmd.exe's first reading takes one character of the line.
#[derive(Clone, Copy, PartialEq, Eq)]
enum CharacterReading {
    /// A fill's own reference, written as it stands.
    Reference,
    /// A `^` outside double quotes that escapes the next character, which the first reading
    /// removes.
    EscapeCaret,
    /// The character an escape caret quotes.
    Escaped,
    /// A character inside double quotes, or the quote that opens or closes them.
    Quoted,
    /// Any other character outside double quotes.
    Unquoted,
}

/// Where in a command the scan stands.
#[derive(Clone, Copy, PartialEq, Eq)]
enum CommandPlace {
    /// Before the command name.
    BeforeName,
    /// In the command name.
    Name,
    /// Past the command name.
    Arguments,
    /// After a redirection's operator, before its target.
    BeforeTarget,
    /// In a redirection's target.
    Target,
}

/// `line` with the author's `^` and `!` written so cmd.exe's delayed expansion hands the command
/// the text the first reading leaves, in each piece of a command that holds a `!` and so is read
/// again; a piece without one is left as written, since delayed expansion skips it. The ranges in
/// `references`, the fills' `!V!` references in line order, stay as they are. In a piece read
/// again the author's `%NAME%` is written `!NAME!` when `is_defined` answers that the launch's
/// environment defines `NAME`, so delayed expansion hands its value over unscanned.
pub(super) fn keep_through_delayed_expansion(
    line: &str,
    references: &[Range<usize>],
    is_defined: &dyn Fn(&str) -> bool,
) -> String {
    let characters: Vec<(usize, char)> = line.char_indices().collect();
    let mut readings = Vec::with_capacity(characters.len());
    let mut pieces: Vec<bool> = Vec::new();
    let mut is_quoted = false;
    let mut is_escaping = false;
    let mut place = CommandPlace::BeforeName;
    let mut has_name = false;
    let mut is_operator_end = false;
    let mut name_piece = new_piece(&mut pieces);
    let mut arguments_piece = new_piece(&mut pieces);
    let mut target_piece = name_piece;
    for &(at, character) in &characters {
        let is_reference = references.iter().any(|reference| reference.contains(&at));
        let after_operator = std::mem::take(&mut is_operator_end);
        let reading = if is_reference {
            CharacterReading::Reference
        } else if std::mem::take(&mut is_escaping) {
            CharacterReading::Escaped
        } else if is_quoted {
            CharacterReading::Quoted
        } else if character == '^' {
            CharacterReading::EscapeCaret
        } else {
            CharacterReading::Unquoted
        };
        let mut is_text = true;
        match (reading, character) {
            (CharacterReading::Quoted | CharacterReading::Reference, '"') if is_quoted => {
                is_quoted = false;
            }
            (CharacterReading::EscapeCaret, _) => is_escaping = true,
            (CharacterReading::Reference | CharacterReading::Unquoted, '"') => is_quoted = true,
            (CharacterReading::Unquoted, '&') if after_operator => is_text = false,
            (CharacterReading::Unquoted, '&' | '|' | '\n' | '\r') => {
                place = CommandPlace::BeforeName;
                has_name = false;
                name_piece = new_piece(&mut pieces);
                arguments_piece = new_piece(&mut pieces);
                is_text = false;
            }
            (CharacterReading::Unquoted, '<' | '>') => {
                if place != CommandPlace::BeforeTarget {
                    target_piece = new_piece(&mut pieces);
                }
                place = CommandPlace::BeforeTarget;
                is_operator_end = true;
                is_text = false;
            }
            // The name runs on through `/` and `+`, as in `dir/w`: cmd.exe splits them from it only
            // when it runs the command, after delayed expansion has read the name whole.
            (CharacterReading::Unquoted, ' ' | '\t' | ';' | ',' | '=' | '\u{b}' | '\u{c}') => {
                place = match place {
                    CommandPlace::Name => CommandPlace::Arguments,
                    CommandPlace::Target if has_name => CommandPlace::Arguments,
                    CommandPlace::Target => CommandPlace::BeforeName,
                    CommandPlace::BeforeName
                    | CommandPlace::Arguments
                    | CommandPlace::BeforeTarget => place,
                };
                is_text = false;
            }
            (
                CharacterReading::Reference
                | CharacterReading::Escaped
                | CharacterReading::Quoted
                | CharacterReading::Unquoted,
                _,
            ) => {}
        }
        // A character of text starts the name or a target where none has begun.
        if is_text {
            place = match place {
                CommandPlace::BeforeName => {
                    has_name = true;
                    CommandPlace::Name
                }
                CommandPlace::BeforeTarget => CommandPlace::Target,
                CommandPlace::Name | CommandPlace::Arguments | CommandPlace::Target => place,
            };
        }
        let piece = match place {
            CommandPlace::Name => Some(name_piece),
            CommandPlace::Arguments => Some(arguments_piece),
            CommandPlace::Target => Some(target_piece),
            CommandPlace::BeforeName | CommandPlace::BeforeTarget => None,
        };
        if let Some(piece) = piece
            && character == '!'
        {
            pieces[piece] = true;
        }
        readings.push((reading, piece));
    }
    let mut variables = defined_variables(line, is_defined).into_iter().peekable();
    let mut kept = String::with_capacity(line.len());
    let mut kept_to = 0;
    for (&(at, character), &(reading, piece)) in characters.iter().zip(&readings) {
        if at < kept_to {
            continue;
        }
        let is_read_again = piece.is_some_and(|piece| pieces[piece]);
        let variable = variables.next_if(|variable| variable.start == at);
        // The first reading sets `%NAME%`'s value in as text, whose `^` and `!` delayed expansion
        // would then remove; `!NAME!` sets it in after that scan.
        if let Some(variable) = variable
            && is_read_again
        {
            kept.push('!');
            kept.push_str(&line[variable.start + 1..variable.end - 1]);
            kept.push('!');
            kept_to = variable.end;
            continue;
        }
        if is_read_again {
            kept.push_str(match (reading, character) {
                // Inside quotes the first reading keeps `^^` and `^!`, which delayed expansion
                // reads as the `^` or `!` alone.
                (CharacterReading::Quoted, '^' | '!') => "^",
                // Outside them it turns `^^^^` and `^^!` into `^^` and `^!`, which delayed
                // expansion reads the same way.
                (CharacterReading::Escaped, '^' | '!') | (CharacterReading::Unquoted, '!') => "^^",
                (
                    CharacterReading::Reference
                    | CharacterReading::EscapeCaret
                    | CharacterReading::Escaped
                    | CharacterReading::Quoted
                    | CharacterReading::Unquoted,
                    _,
                ) => "",
            });
        }
        kept.push(character);
    }
    kept
}

/// The `%NAME%` references in `line` whose value cmd.exe's first reading sets in, in line order:
/// those whose name `is_defined` answers for. An undefined one stays as written and the scan goes
/// on from the character after its first `%`; a defined `%NAME:…%` form is passed over whole.
fn defined_variables(line: &str, is_defined: &dyn Fn(&str) -> bool) -> Vec<Range<usize>> {
    let mut variables = Vec::new();
    let mut from = 0;
    while let Some(offset) = line[from..].find('%') {
        let start = from + offset;
        let name_start = start + 1;
        from = name_start;
        let Some(name_end) = line[name_start..]
            .find(['%', ':'])
            .map(|end| name_start + end)
        else {
            continue;
        };
        if !is_defined(&line[name_start..name_end]) {
            continue;
        }
        if line[name_end..].starts_with('%') {
            variables.push(start..name_end + 1);
            from = name_end + 1;
        } else if let Some(form_end) = line[name_end..].find('%') {
            from = name_end + form_end + 1;
        }
    }
    variables
}

/// A new piece of a command, holding no `!` yet; its index.
fn new_piece(pieces: &mut Vec<bool>) -> usize {
    pieces.push(false);
    pieces.len() - 1
}
