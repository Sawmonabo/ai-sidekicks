//! cmd.exe's own reading of a filled line: the `^` it reads as an escape before a fill, and the
//! text its delayed expansion would change, which the launch escapes so the command gets the text
//! as written. cmd.exe first removes each `^` outside double quotes, keeping the character after it
//! as text; delayed expansion then reads again each piece of a command holding a `!`, the command
//! name, the arguments as one piece and each redirection's target, quotes or not, removing each `^`
//! and pairing each `!`. Of an `if` it reads only each compared value and of a `for` only its set,
//! and the command an `if` or a `for` runs is a command of its own.

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
    /// A character of an author's `%…%` reference to a defined variable, which the first reading
    /// replaces whole, and whether it stands inside double quotes.
    Variable { is_quoted: bool },
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
    /// Before an `if`'s next word, and which word that is.
    IfBefore(IfWord),
    /// In an `if`'s option, `not`, keyword or operator word, and which word comes after it.
    IfKeyword(IfWord),
    /// In a value an `if` compares, and whether the `if`'s command comes after it.
    IfValue { is_last: bool },
    /// In a `for`'s options and variable, before its set.
    ForHead,
    /// In a `for`'s parenthesized set.
    ForSet,
    /// Between the words after a `for`'s set.
    ForTail,
    /// In a word after a `for`'s set other than `do`.
    ForTailWord,
    /// In a `for`'s `do`, which its command follows.
    ForDo,
}

/// Which word of an `if`'s condition comes next.
#[derive(Clone, Copy, PartialEq, Eq)]
enum IfWord {
    /// `/i`, `not`, a keyword, or the first of two compared values.
    Opening,
    /// The one value a keyword such as `exist` reads.
    KeywordValue,
    /// A comparison's operator word such as `equ`, or its second value after `==`.
    Operator,
    /// A comparison's second value.
    SecondValue,
}

/// The keywords that read one value in an `if`'s condition.
const IF_KEYWORDS: &[&str] = &["exist", "defined", "errorlevel", "cmdextversion"];

/// An `if`'s comparison operator words; `==` is read as delimiters between its values.
const IF_OPERATORS: &[&str] = &["equ", "neq", "lss", "leq", "gtr", "geq"];

/// `line` with the author's `^` and `!` written so cmd.exe's delayed expansion hands the command
/// the text the first reading leaves, in each piece of a command that holds a `!` and so is read
/// again, counting the `!` a defined variable's value puts in; a piece without one is left as
/// written, since delayed expansion skips it. The ranges in
/// `references`, the fills' `!V!` references in line order, stay as they are. In a piece read
/// again an author's `%…%` reference to a variable `environment` defines, its `~` substring and
/// `=` substitution forms included, is written in its delayed form `!…!`, so delayed expansion
/// hands its value over unscanned.
pub(super) fn keep_through_delayed_expansion(
    line: &str,
    references: &[Range<usize>],
    environment: &[(&str, &str)],
) -> String {
    let characters: Vec<(usize, char)> = line.char_indices().collect();
    let variables = defined_variables(line, environment);
    // Each reference reads as the delayed form a piece read again gets, one run of plain text.
    let mut variables_ahead = variables.iter().peekable();
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
    let mut value_piece = name_piece;
    // The command name as the first reading leaves it, to tell an `if` or a `for`.
    let mut name_text = String::new();
    for &(at, character) in &characters {
        let is_reference = references.iter().any(|reference| reference.contains(&at));
        let after_operator = std::mem::take(&mut is_operator_end);
        while variables_ahead
            .next_if(|variable| variable.range.end <= at)
            .is_some()
        {}
        let variable = variables_ahead
            .peek()
            .filter(|variable| variable.range.contains(&at));
        let is_in_variable = variable.is_some();
        // The first reading puts a value's `!` into the piece before delayed expansion reads it.
        let puts_in_a_mark =
            variable.is_some_and(|variable| variable.range.start == at && variable.is_value_marked);
        let reading = if is_reference {
            CharacterReading::Reference
        } else if is_in_variable {
            // An escape caret before the reference quotes the delayed form's opening `!`.
            is_escaping = false;
            CharacterReading::Variable { is_quoted }
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
        let place_before = place;
        match (reading, character) {
            (CharacterReading::Quoted | CharacterReading::Reference, '"') if is_quoted => {
                is_quoted = false;
            }
            (CharacterReading::EscapeCaret, _) => is_escaping = true,
            (CharacterReading::Reference | CharacterReading::Unquoted, '"') => is_quoted = true,
            (CharacterReading::Unquoted, '&') if after_operator => is_text = false,
            (CharacterReading::Unquoted, '&' | '|' | '\n' | '\r') => {
                place = CommandPlace::BeforeName;
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
            (CharacterReading::Unquoted, '(') if place == CommandPlace::ForHead => {
                place = CommandPlace::ForSet;
                value_piece = new_piece(&mut pieces);
                is_text = false;
            }
            (CharacterReading::Unquoted, ')') if place == CommandPlace::ForSet => {
                place = CommandPlace::ForTail;
                is_text = false;
            }
            // The name runs on through `/` and `+`, as in `dir/w`: cmd.exe splits them from it only
            // when it runs the command, after delayed expansion has read the name whole.
            (CharacterReading::Unquoted, ' ' | '\t' | ';' | ',' | '=' | '\u{b}' | '\u{c}') => {
                place = match place {
                    CommandPlace::Name if name_text.eq_ignore_ascii_case("if") => {
                        CommandPlace::IfBefore(IfWord::Opening)
                    }
                    CommandPlace::Name if name_text.eq_ignore_ascii_case("for") => {
                        CommandPlace::ForHead
                    }
                    CommandPlace::Name => CommandPlace::Arguments,
                    CommandPlace::Target if has_name => CommandPlace::Arguments,
                    CommandPlace::Target
                    | CommandPlace::IfValue { is_last: true }
                    | CommandPlace::ForDo => CommandPlace::BeforeName,
                    CommandPlace::IfKeyword(word) => CommandPlace::IfBefore(word),
                    CommandPlace::IfValue { is_last: false } => {
                        CommandPlace::IfBefore(IfWord::Operator)
                    }
                    CommandPlace::ForTailWord => CommandPlace::ForTail,
                    CommandPlace::BeforeName
                    | CommandPlace::Arguments
                    | CommandPlace::BeforeTarget
                    | CommandPlace::IfBefore(_)
                    | CommandPlace::ForHead
                    | CommandPlace::ForSet
                    | CommandPlace::ForTail => place,
                };
                is_text = false;
            }
            (
                CharacterReading::Reference
                | CharacterReading::Escaped
                | CharacterReading::Quoted
                | CharacterReading::Unquoted
                | CharacterReading::Variable { .. },
                _,
            ) => {}
        }
        // A command starts with new pieces, its name not begun.
        if place == CommandPlace::BeforeName && place_before != CommandPlace::BeforeName {
            has_name = false;
            name_text.clear();
            name_piece = new_piece(&mut pieces);
            arguments_piece = new_piece(&mut pieces);
        }
        // A character of text starts the name, a target or a word where none has begun.
        if is_text {
            place = match place {
                CommandPlace::BeforeName => {
                    has_name = true;
                    CommandPlace::Name
                }
                CommandPlace::BeforeTarget => CommandPlace::Target,
                CommandPlace::IfBefore(word) => {
                    let next = word_at(line, at);
                    let is_one_of =
                        |words: &[&str]| words.iter().any(|known| next.eq_ignore_ascii_case(known));
                    match word {
                        IfWord::Opening if is_one_of(&["/i", "not"]) => {
                            CommandPlace::IfKeyword(IfWord::Opening)
                        }
                        IfWord::Opening if is_one_of(IF_KEYWORDS) => {
                            CommandPlace::IfKeyword(IfWord::KeywordValue)
                        }
                        IfWord::Operator if is_one_of(IF_OPERATORS) => {
                            CommandPlace::IfKeyword(IfWord::SecondValue)
                        }
                        IfWord::Opening
                        | IfWord::KeywordValue
                        | IfWord::Operator
                        | IfWord::SecondValue => {
                            value_piece = new_piece(&mut pieces);
                            CommandPlace::IfValue {
                                is_last: word != IfWord::Opening,
                            }
                        }
                    }
                }
                CommandPlace::ForTail if word_at(line, at).eq_ignore_ascii_case("do") => {
                    CommandPlace::ForDo
                }
                CommandPlace::ForTail => CommandPlace::ForTailWord,
                CommandPlace::Name
                | CommandPlace::Arguments
                | CommandPlace::Target
                | CommandPlace::IfKeyword(_)
                | CommandPlace::IfValue { .. }
                | CommandPlace::ForHead
                | CommandPlace::ForSet
                | CommandPlace::ForTailWord
                | CommandPlace::ForDo => place,
            };
            if place == CommandPlace::Name && reading != CharacterReading::EscapeCaret {
                name_text.push(character);
            }
        }
        let piece = match place {
            CommandPlace::Name => Some(name_piece),
            CommandPlace::Arguments => Some(arguments_piece),
            CommandPlace::Target => Some(target_piece),
            CommandPlace::IfValue { .. } | CommandPlace::ForSet => Some(value_piece),
            CommandPlace::BeforeName
            | CommandPlace::BeforeTarget
            | CommandPlace::IfBefore(_)
            | CommandPlace::IfKeyword(_)
            | CommandPlace::ForHead
            | CommandPlace::ForTail
            | CommandPlace::ForTailWord
            | CommandPlace::ForDo => None,
        };
        if let Some(piece) = piece
            && (character == '!' || puts_in_a_mark)
        {
            pieces[piece] = true;
        }
        readings.push((reading, piece));
    }
    let mut variables = variables.into_iter().peekable();
    let mut kept = String::with_capacity(line.len());
    let mut kept_to = 0;
    for (&(at, character), &(reading, piece)) in characters.iter().zip(&readings) {
        if at < kept_to {
            continue;
        }
        let is_read_again = piece.is_some_and(|piece| pieces[piece]);
        // The first reading sets a reference's value in as text, whose `^` and `!` delayed
        // expansion would then remove; the delayed form sets it in after that scan.
        if let CharacterReading::Variable { is_quoted } = reading
            && let Some(variable) = variables.next_if(|variable| variable.range.start == at)
        {
            let written = &line[variable.range.clone()];
            match delayed_form(written, is_quoted) {
                Some(delayed) if is_read_again => kept.push_str(&delayed),
                Some(_) | None => kept.push_str(written),
            }
            kept_to = variable.range.end;
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
                    | CharacterReading::Unquoted
                    | CharacterReading::Variable { .. },
                    _,
                ) => "",
            });
        }
        kept.push(character);
    }
    kept
}

/// The author's `%…%` references in `line` that cmd.exe's first reading expands, in line order:
/// a name `environment` defines, then `%`, or `:` and a `~` substring or `=` substitution form. An
/// undefined name or a form that does not expand stays as written, and the scan goes on from the
/// character after its first `%`.
fn defined_variables(line: &str, environment: &[(&str, &str)]) -> Vec<DefinedVariable> {
    let mut variables = Vec::new();
    let mut from = 0;
    while let Some(offset) = line[from..].find('%') {
        let start = from + offset;
        from = start + 1;
        let Some(name_end) = line[from..].find(['%', ':']).map(|end| from + end) else {
            continue;
        };
        let Some(value) = variable_value(environment, &line[from..name_end]) else {
            continue;
        };
        let end = if line[name_end..].starts_with('%') {
            name_end + 1
        } else {
            let form_start = name_end + 1;
            let Some(form_end) = line[form_start..].find('%').map(|end| form_start + end) else {
                continue;
            };
            if !is_expanding_form(&line[form_start..form_end]) {
                continue;
            }
            form_end + 1
        };
        variables.push(DefinedVariable {
            range: start..end,
            is_value_marked: value.contains('!'),
        });
        from = end;
    }
    variables
}

/// An author's `%…%` reference that cmd.exe's first reading expands.
struct DefinedVariable {
    /// Where it stands in the line, its `%`s included.
    range: Range<usize>,
    /// Whether the variable's value holds a `!`, which the expansion puts into the piece.
    is_value_marked: bool,
}

/// The value `environment` holds for `name`, names compared as Windows compares them, ignoring
/// case.
fn variable_value<'value>(environment: &[(&str, &'value str)], name: &str) -> Option<&'value str> {
    let folded = |text: &str| {
        text.chars()
            .flat_map(char::to_uppercase)
            .collect::<String>()
    };
    let name = folded(name);
    environment
        .iter()
        .find(|(defined, _)| folded(defined) == name)
        .map(|&(_, value)| value)
}

/// Whether cmd.exe's first reading expands `form`, the text between a defined name's `:` and the
/// next `%`: a substring `~[integer][,[integer]]`, or a substitution `[*]search=[replace]` whose
/// search is not empty.
fn is_expanding_form(form: &str) -> bool {
    let is_integer_or_empty = |text: &str| {
        let digits = text.strip_prefix('-').unwrap_or(text);
        text.is_empty() || (!digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit()))
    };
    match form.strip_prefix('~') {
        Some(bounds) => match bounds.split_once(',') {
            Some((offset, length)) => is_integer_or_empty(offset) && is_integer_or_empty(length),
            None => is_integer_or_empty(bounds),
        },
        None => form
            .strip_prefix('*')
            .unwrap_or(form)
            .split_once('=')
            .is_some_and(|(search, _)| !search.is_empty()),
    }
}

/// `written`, an author's `%…%` reference, in its delayed form `!…!`, which cmd.exe's second
/// phase reads before delayed expansion: inside double quotes as it stands, outside them with each
/// `^`, `&`, `|`, `<`, `>` and `"` behind a `^`. `None` where no delayed form can hold it: text
/// with a `!` or a line break, or a `"` inside double quotes.
fn delayed_form(written: &str, is_quoted: bool) -> Option<String> {
    let inner = &written[1..written.len() - 1];
    if inner.contains(['!', '\n', '\r']) || (is_quoted && inner.contains('"')) {
        return None;
    }
    let mut delayed = String::with_capacity(written.len() * 2);
    delayed.push('!');
    for character in inner.chars() {
        if !is_quoted && matches!(character, '^' | '&' | '|' | '<' | '>' | '"') {
            delayed.push('^');
        }
        delayed.push(character);
    }
    delayed.push('!');
    Some(delayed)
}

/// The word of `line` that starts at `at`, up to the next character that ends a word unquoted.
fn word_at(line: &str, at: usize) -> &str {
    let rest = &line[at..];
    let end = rest
        .find([
            ' ', '\t', ';', ',', '=', '\u{b}', '\u{c}', '&', '|', '<', '>', '(', ')', '\n', '\r',
        ])
        .unwrap_or(rest.len());
    &rest[..end]
}

/// A new piece of a command, holding no `!` yet; its index.
fn new_piece(pieces: &mut Vec<bool>) -> usize {
    pieces.push(false);
    pieces.len() - 1
}
