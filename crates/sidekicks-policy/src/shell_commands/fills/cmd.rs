//! cmd.exe's own reading of a filled line: the `^` it reads as an escape before a fill, a
//! `%NAME:…%` reference's substring or substitution form, whose text its first phase reads as text,
//! and the text its delayed expansion would change, which the launch escapes so the command gets
//! the text as written. cmd.exe's first phase sets each defined `%…%` reference's value in its
//! place; the second then removes each `^` outside double quotes, keeping the character after it as
//! text, and reads a value's characters as the line's own; delayed expansion then reads again each
//! piece of a command holding a `!`, the command name, the arguments as one piece and each
//! redirection's target, quotes or not, removing each `^` and pairing each `!`. Of an `if` it reads
//! only each compared value and of a `for` only its set, and the command an `if` or a `for` runs is
//! a command of its own.

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

/// Whether the fill at `placeholder` in `line` sits in the modifier text of a `%NAME:…%`
/// reference that writes a `~` substring or `=` substitution form: cmd.exe's first phase reads it
/// as the form's own text, so the value never reaches the command. Any `%` may open such a
/// reference, since only the launch knows which names are defined; a name holding `=` is no
/// variable, and modifier text writing neither form stays as written.
pub(super) fn is_in_reference_modifier(line: &str, placeholder: &Range<usize>) -> bool {
    line[..placeholder.start]
        .match_indices('%')
        .any(|(start, _)| {
            reference_at(line, start).is_some_and(|reference| {
                let name = &line[reference.name];
                !name.is_empty()
                    && !name.contains('=')
                    && reference.modifier.is_some_and(|modifier| {
                        modifier.contains(&placeholder.start)
                            && modifier_form(&line[modifier]).is_some()
                    })
            })
        })
}

/// How cmd.exe's second phase takes one character of the line.
#[derive(Clone, Copy, PartialEq, Eq)]
enum CharacterReading {
    /// A fill's own reference, written as it stands.
    Reference,
    /// A `^` outside double quotes that escapes the next character, which the second phase
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

/// The characters that end a command name, a target or an `if`'s word outside double quotes.
const SEPARATORS: [char; 7] = [' ', '\t', ';', ',', '=', '\u{b}', '\u{c}'];

/// One character of the line as cmd.exe's second phase reads it.
struct ReadCharacter {
    character: char,
    reading: CharacterReading,
    /// The piece of its command it stands in, where delayed expansion reads one.
    piece: Option<usize>,
    /// Whether the second phase reads it as text that changes nothing: no quote, escape caret,
    /// operator or separator.
    is_plain: bool,
}

/// The line as cmd.exe's second phase reads it, and whether each piece of a command holds a `!`,
/// so that delayed expansion reads it again.
struct LineReading {
    characters: Vec<ReadCharacter>,
    pieces: Vec<bool>,
}

impl LineReading {
    /// Whether delayed expansion reads again the piece `read` stands in.
    fn is_read_again(&self, read: &ReadCharacter) -> bool {
        read.piece.is_some_and(|piece| self.pieces[piece])
    }
}

/// A run of the line as cmd.exe's first phase reads it.
enum Segment<'line> {
    /// The author's text, which the first phase leaves, and where it starts in the line.
    Written { start: usize, text: &'line str },
    /// An author's `%…%` reference to a defined variable, and the value the first phase sets in
    /// its place.
    Variable { written: &'line str, value: String },
}

/// A `%…%` reference cmd.exe's first phase reads where its name is defined, in bytes of the line.
struct ReferenceText {
    /// The name, between the opening `%` and the first `%` or `:` after it.
    name: Range<usize>,
    /// The modifier text between the name's `:` and the next `%`, if a `:` ends the name.
    modifier: Option<Range<usize>>,
    /// Just past the closing `%`.
    end: usize,
}

/// `line` with the author's `^` and `!` written so cmd.exe's delayed expansion hands the command
/// the text the second phase leaves, in each piece of a command that holds a `!` and so is read
/// again, counting the `!` a defined variable's value puts in; a piece without one is left as
/// written, since delayed expansion skips it. The ranges in `references`, the fills' `!V!`
/// references in line order, stay as they are. An author's `%…%` reference to a variable
/// `environment` defines, its `~` substring and `=` substitution forms included, is read as the
/// value the first phase sets in, and written so the command gets the value the author's line
/// gives it.
pub(super) fn keep_through_delayed_expansion(
    line: &str,
    references: &[Range<usize>],
    environment: &[(&str, &str)],
) -> String {
    let segments = first_phase(line, environment);
    let mut expanded = String::with_capacity(line.len());
    // Where each character of `expanded` stands in `line`, `None` for a value's.
    let mut written_at = Vec::with_capacity(line.len());
    for segment in &segments {
        match segment {
            Segment::Written { start, text } => {
                expanded.push_str(text);
                written_at.extend(text.char_indices().map(|(offset, _)| Some(start + offset)));
            }
            Segment::Variable { value, .. } => {
                expanded.push_str(value);
                written_at.extend(value.chars().map(|_| None));
            }
        }
    }
    let reading = read_line(&expanded, |index| {
        written_at[index]
            .is_some_and(|at| references.iter().any(|reference| reference.contains(&at)))
    });
    let mut kept = String::with_capacity(line.len());
    let mut characters = reading.characters.iter();
    for segment in &segments {
        match segment {
            Segment::Written { text, .. } => {
                for read in characters.by_ref().take(text.chars().count()) {
                    push_kept(&mut kept, read, &reading);
                }
            }
            Segment::Variable { written, value } => {
                let value: Vec<&ReadCharacter> =
                    characters.by_ref().take(value.chars().count()).collect();
                push_variable(&mut kept, written, &value, &reading);
            }
        }
    }
    kept
}

/// How cmd.exe's second phase reads `expanded`, the line as the first phase leaves it, in which
/// `is_reference` tells, by its index, each character of a fill's reference.
fn read_line(expanded: &str, is_reference: impl Fn(usize) -> bool) -> LineReading {
    let mut characters = Vec::with_capacity(expanded.len());
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
    // The command name as the second phase leaves it, to tell an `if` or a `for`.
    let mut name_text = String::new();
    for (index, (at, character)) in expanded.char_indices().enumerate() {
        let after_operator = std::mem::take(&mut is_operator_end);
        let reading = if is_reference(index) {
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
        let place_before = place;
        let is_plain = match (reading, character) {
            (CharacterReading::Quoted | CharacterReading::Reference, '"') if is_quoted => {
                is_quoted = false;
                false
            }
            (CharacterReading::EscapeCaret, _) => {
                is_escaping = true;
                false
            }
            (CharacterReading::Reference | CharacterReading::Unquoted, '"') => {
                is_quoted = true;
                false
            }
            (CharacterReading::Unquoted, '&') if after_operator => {
                is_text = false;
                false
            }
            (CharacterReading::Unquoted, '&' | '|' | '\n' | '\r') => {
                place = CommandPlace::BeforeName;
                is_text = false;
                false
            }
            (CharacterReading::Unquoted, '<' | '>') => {
                if place != CommandPlace::BeforeTarget {
                    target_piece = new_piece(&mut pieces);
                }
                place = CommandPlace::BeforeTarget;
                is_operator_end = true;
                is_text = false;
                false
            }
            (CharacterReading::Unquoted, '(') if place == CommandPlace::ForHead => {
                place = CommandPlace::ForSet;
                value_piece = new_piece(&mut pieces);
                is_text = false;
                false
            }
            (CharacterReading::Unquoted, ')') if place == CommandPlace::ForSet => {
                place = CommandPlace::ForTail;
                is_text = false;
                false
            }
            // The name runs on through `/` and `+`, as in `dir/w`: cmd.exe splits them from it only
            // when it runs the command, after delayed expansion has read the name whole.
            (CharacterReading::Unquoted, separator) if SEPARATORS.contains(&separator) => {
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
                false
            }
            (
                CharacterReading::Reference
                | CharacterReading::Escaped
                | CharacterReading::Quoted
                | CharacterReading::Unquoted,
                _,
            ) => true,
        };
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
                    let next = word_at(expanded, at);
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
                CommandPlace::ForTail if word_at(expanded, at).eq_ignore_ascii_case("do") => {
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
            && character == '!'
        {
            pieces[piece] = true;
        }
        characters.push(ReadCharacter {
            character,
            reading,
            piece,
            is_plain,
        });
    }
    LineReading { characters, pieces }
}

/// Pushes `read`'s character to `kept`, behind the carets that keep it through delayed
/// expansion where that reads its piece again.
fn push_kept(kept: &mut String, read: &ReadCharacter, reading: &LineReading) {
    if reading.is_read_again(read) {
        kept.push_str(delayed_escape(read));
    }
    kept.push(read.character);
}

/// The carets that keep `read`'s character, in a piece delayed expansion reads again, as the
/// second phase leaves it.
fn delayed_escape(read: &ReadCharacter) -> &'static str {
    match (read.reading, read.character) {
        // Inside quotes the second phase keeps `^^` and `^!`, which delayed expansion reads as the
        // `^` or `!` alone.
        (CharacterReading::Quoted, '^' | '!') => "^",
        // Outside them it turns `^^^^` and `^^!` into `^^` and `^!`, which delayed expansion
        // reads the same way.
        (CharacterReading::Escaped, '^' | '!') | (CharacterReading::Unquoted, '!') => "^^",
        (
            CharacterReading::Reference
            | CharacterReading::EscapeCaret
            | CharacterReading::Escaped
            | CharacterReading::Quoted
            | CharacterReading::Unquoted,
            _,
        ) => "",
    }
}

/// Pushes `written`, an author's reference to a defined variable whose value the second phase
/// reads as `value`, so the command gets the value the author's line gives it: as written where
/// delayed expansion removes no `^` and pairs no `!` of the value; else in its delayed form `!…!`
/// where the value reads as plain text in one piece, which delayed expansion hands over
/// unscanned; else as the value itself, behind the carets that keep it through delayed
/// expansion. A value holding a `%` or a line break, which the first phase would read again,
/// stays as written.
fn push_variable(
    kept: &mut String,
    written: &str,
    value: &[&ReadCharacter],
    reading: &LineReading,
) {
    if value
        .iter()
        .all(|read| !reading.is_read_again(read) || delayed_escape(read).is_empty())
    {
        kept.push_str(written);
        return;
    }
    let piece = value.first().and_then(|read| read.piece);
    let is_quoted = value
        .first()
        .is_some_and(|read| read.reading == CharacterReading::Quoted);
    if value
        .iter()
        .all(|read| read.is_plain && read.piece == piece)
        && let Some(delayed) = delayed_form(written, is_quoted)
    {
        kept.push_str(&delayed);
    } else if value
        .iter()
        .any(|read| matches!(read.character, '%' | '\n' | '\r'))
    {
        kept.push_str(written);
    } else {
        for read in value {
            push_kept(kept, read, reading);
        }
    }
}

/// `line` in runs as cmd.exe's first phase reads it: a `%…%` reference to a name `environment`
/// defines, then `%`, or `:` and a `~` substring or `=` substitution form, is set in as its value;
/// an undefined name or a form that does not expand stays as written, and the scan goes on from
/// the character after its first `%`.
fn first_phase<'line>(line: &'line str, environment: &[(&str, &str)]) -> Vec<Segment<'line>> {
    let mut segments = Vec::new();
    let mut written_from = 0;
    let mut from = 0;
    while let Some(offset) = line[from..].find('%') {
        let start = from + offset;
        from = start + 1;
        let Some(reference) = reference_at(line, start) else {
            continue;
        };
        let Some(value) = variable_value(environment, &line[reference.name]) else {
            continue;
        };
        let value = match reference.modifier {
            None => value.to_owned(),
            Some(modifier) => {
                let Some(value) = form_value(value, &line[modifier]) else {
                    continue;
                };
                value
            }
        };
        segments.push(Segment::Written {
            start: written_from,
            text: &line[written_from..start],
        });
        segments.push(Segment::Variable {
            written: &line[start..reference.end],
            value,
        });
        written_from = reference.end;
        from = reference.end;
    }
    segments.push(Segment::Written {
        start: written_from,
        text: &line[written_from..],
    });
    segments
}

/// The reference cmd.exe's first phase reads from the `%` at `start` in `line` where its name is
/// defined; `None` where no later `%` closes it.
fn reference_at(line: &str, start: usize) -> Option<ReferenceText> {
    let name_start = start + 1;
    let name_end = name_start + line[name_start..].find(['%', ':'])?;
    if line[name_end..].starts_with('%') {
        return Some(ReferenceText {
            name: name_start..name_end,
            modifier: None,
            end: name_end + 1,
        });
    }
    let modifier_start = name_end + 1;
    let modifier_end = modifier_start + line[modifier_start..].find('%')?;
    Some(ReferenceText {
        name: name_start..name_end,
        modifier: Some(modifier_start..modifier_end),
        end: modifier_end + 1,
    })
}

/// The value `environment` holds for `name`, names compared as Windows compares them, ignoring
/// case.
fn variable_value<'value>(environment: &[(&str, &'value str)], name: &str) -> Option<&'value str> {
    environment
        .iter()
        .find(|(defined, _)| is_same_ignoring_case(defined, name))
        .map(|&(_, value)| value)
}

/// Whether `left` and `right` are the same text ignoring case, as Windows compares names.
fn is_same_ignoring_case(left: &str, right: &str) -> bool {
    left.chars()
        .flat_map(char::to_uppercase)
        .eq(right.chars().flat_map(char::to_uppercase))
}

/// A form cmd.exe's first phase expands in a `%NAME:…%` reference's modifier text.
enum ModifierForm<'text> {
    /// A substring `~[offset][,[length]]`, with the text after its `~`.
    Substring { bounds: &'text str },
    /// A substitution `[*]search=[replace]` whose search is not empty; with `is_through_first`,
    /// written with the leading `*`.
    Substitution {
        search: &'text str,
        replace: &'text str,
        is_through_first: bool,
    },
}

/// The form `text`, the text between a reference's name's `:` and the next `%`, writes: a
/// substring after a leading `~`, else a substitution where an `=` follows a search that is not
/// empty, after an optional leading `*`. `None` for text writing neither, which the first phase
/// leaves as written.
fn modifier_form(text: &str) -> Option<ModifierForm<'_>> {
    if let Some(bounds) = text.strip_prefix('~') {
        return Some(ModifierForm::Substring { bounds });
    }
    let (is_through_first, text) = match text.strip_prefix('*') {
        Some(text) => (true, text),
        None => (false, text),
    };
    let (search, replace) = text
        .split_once('=')
        .filter(|(search, _)| !search.is_empty())?;
    Some(ModifierForm::Substitution {
        search,
        replace,
        is_through_first,
    })
}

/// The text cmd.exe's first phase sets in for a defined variable holding `value`, given `form`,
/// the text between the name's `:` and the next `%`: a substring, counted in UTF-16 units as
/// Windows counts them, or a substitution, its search compared ignoring case. `None` for text
/// the first phase does not expand, a substring whose bounds are not integers among it.
fn form_value(value: &str, form: &str) -> Option<String> {
    let bounds = match modifier_form(form)? {
        ModifierForm::Substring { bounds } => bounds,
        ModifierForm::Substitution {
            search,
            replace,
            is_through_first,
        } => return Some(substituted(value, search, replace, is_through_first)),
    };
    let (offset, length) = match bounds.split_once(',') {
        Some((offset, length)) => (offset, Some(length)),
        None => (bounds, None),
    };
    let units: Vec<u16> = value.encode_utf16().collect();
    let count = units.len();
    // An empty offset starts at the first unit, and an empty length runs to the end.
    let start = match offset {
        "" => 0,
        offset => match substring_bound(offset)? {
            (true, size) => count.saturating_sub(size),
            (false, size) => size.min(count),
        },
    };
    let end = match length.filter(|length| !length.is_empty()) {
        None => count,
        Some(length) => match substring_bound(length)? {
            (true, size) => count.saturating_sub(size).max(start),
            (false, size) => start.saturating_add(size).min(count),
        },
    };
    Some(String::from_utf16_lossy(&units[start..end]))
}

/// A substring form's offset or length, a decimal integer with an optional `-`: whether it counts
/// back from the end, and its size. `None` for any other text.
fn substring_bound(text: &str) -> Option<(bool, usize)> {
    let digits = text.strip_prefix('-').unwrap_or(text);
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    // A size past `usize` reaches past every value all the same.
    let size = digits.parse().unwrap_or(usize::MAX);
    Some((size != 0 && digits.len() < text.len(), size))
}

/// `value` with each match of `search`, compared ignoring case, replaced by `replace`; with
/// `is_through_first`, the text up to and through the first match replaced instead.
fn substituted(value: &str, search: &str, replace: &str, is_through_first: bool) -> String {
    let search_length = search.chars().count();
    let mut result = String::with_capacity(value.len());
    let mut rest = value;
    loop {
        let window_end = rest
            .char_indices()
            .nth(search_length)
            .map_or(rest.len(), |(end, _)| end);
        if is_same_ignoring_case(&rest[..window_end], search) {
            if is_through_first {
                return format!("{replace}{}", &rest[window_end..]);
            }
            result.push_str(replace);
            rest = &rest[window_end..];
            continue;
        }
        let mut characters = rest.chars();
        let Some(character) = characters.next() else {
            return result;
        };
        result.push(character);
        rest = characters.as_str();
    }
}

/// `written`, an author's `%…%` reference, in its delayed form `!…!`, which cmd.exe's second
/// phase reads before delayed expansion: inside double quotes as it stands, outside them with each
/// `^`, `&`, `|`, `<`, `>`, `"` and separator behind a `^`, so the second phase keeps it one word.
/// `None` where no delayed form can hold it: text with a `!` or a line break, or a `"` inside
/// double quotes.
fn delayed_form(written: &str, is_quoted: bool) -> Option<String> {
    let inner = &written[1..written.len() - 1];
    if inner.contains(['!', '\n', '\r']) || (is_quoted && inner.contains('"')) {
        return None;
    }
    let mut delayed = String::with_capacity(written.len() * 2);
    delayed.push('!');
    for character in inner.chars() {
        if !is_quoted
            && (SEPARATORS.contains(&character)
                || matches!(character, '^' | '&' | '|' | '<' | '>' | '"'))
        {
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
        .find(|character: char| {
            SEPARATORS.contains(&character)
                || matches!(character, '&' | '|' | '<' | '>' | '(' | ')' | '\n' | '\r')
        })
        .unwrap_or(rest.len());
    &rest[..end]
}

/// A new piece of a command, holding no `!` yet; its index.
fn new_piece(pieces: &mut Vec<bool>) -> usize {
    pieces.push(false);
    pieces.len() - 1
}
