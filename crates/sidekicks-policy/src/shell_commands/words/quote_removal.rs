//! The shell's quote removal of a word's text: the escapes an unquoted word and double quotes
//! undo, and the ANSI-C strings bash and zsh decode alike.

/// Writes an unquoted word's value into `value`: each backslash keeps the character after it, a
/// backslash and a line break go together, and a backslash ending the word stays.
pub(super) fn unescape_bare(text: &str, value: &mut String) {
    let mut characters = text.chars();
    while let Some(character) = characters.next() {
        if character != '\\' {
            value.push(character);
            continue;
        }
        match characters.next() {
            None => value.push('\\'),
            Some('\n') => {}
            Some(escaped) => value.push(escaped),
        }
    }
}

/// Writes the value of text inside double quotes into `value`: a backslash before `$`, `` ` ``,
/// `"` or another backslash keeps that character, a backslash and a line break go together, any
/// other backslash stays, and one ending the text is dropped.
pub(super) fn unescape_double_quoted(text: &str, value: &mut String) {
    let mut characters = text.chars();
    while let Some(character) = characters.next() {
        if character != '\\' {
            value.push(character);
            continue;
        }
        match characters.next() {
            None | Some('\n') => {}
            Some(escaped @ ('$' | '`' | '"' | '\\')) => value.push(escaped),
            Some(escaped) => {
                value.push('\\');
                value.push(escaped);
            }
        }
    }
}

/// Writes an ANSI-C quoted string's body, `$'` already taken off, into `value`, decoded up to its
/// closing quote, and answers whether bash and zsh decode it alike: false, with `value` partly
/// written, when it holds any escape outside the ones they decode the same way (`\\ \' \" \? \a
/// \b \e \E \f \n \r \t \v`, octal, and `\x` with a hex digit), or one of those that decodes to
/// NUL, which ends bash's value of the string but stays in zsh's word.
pub(super) fn decode_ansi_c(body: &str, value: &mut String) -> bool {
    let characters: Vec<char> = body.chars().collect();
    let limit = characters.len();
    let mut position = 0;
    while position < limit && characters[position] != '\'' {
        let character = characters[position];
        position += 1;
        if character != '\\' {
            value.push(character);
            continue;
        }
        let Some(&escaped) = characters.get(position) else {
            return false;
        };
        position += 1;
        let decoded = match escaped {
            'a' => '\u{7}',
            'b' => '\u{8}',
            'e' | 'E' => '\u{1b}',
            'f' => '\u{c}',
            'n' => '\n',
            'r' => '\r',
            't' => '\t',
            'v' => '\u{b}',
            '\\' | '\'' | '"' | '?' => escaped,
            'x' | '0'..='7' => {
                // Up to two digits follow: hex ones after `x`, octal ones after the first.
                let (radix, mut code) = match escaped.to_digit(8) {
                    Some(digit) => (8, digit),
                    None => (16, 0),
                };
                let digits_start = position;
                while position < limit && position - digits_start < 2 {
                    let Some(digit) = characters[position].to_digit(radix) else {
                        break;
                    };
                    code = code * radix + digit;
                    position += 1;
                }
                let byte = code & 0xFF;
                if (radix == 16 && position == digits_start) || byte == 0 {
                    return false;
                }
                char::from(u8::try_from(byte).expect("a value masked to one byte"))
            }
            // `\u`, `\U`, `\c`, `\M-`, `\C-`, a line break and every unknown escape.
            _ => return false,
        };
        value.push(decoded);
    }
    true
}
