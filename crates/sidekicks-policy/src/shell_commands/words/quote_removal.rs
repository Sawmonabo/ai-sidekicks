//! The shell's quote removal of a word's text: the escapes an unquoted word and double quotes
//! undo, and the ANSI-C strings bash decodes.

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

/// Writes an ANSI-C quoted string's body, `$'` already taken off, into `value`, decoded as bash
/// decodes it up to its closing quote. A decoded NUL ends the string's value there, as it ends
/// bash's C string; the parts of a word after the string still join.
pub(super) fn decode_ansi_c(body: &str, value: &mut String) {
    let characters: Vec<char> = body.chars().collect();
    let limit = characters.len();
    let mut position = 0;
    while position < limit && characters[position] != '\'' {
        if characters[position] != '\\' || position + 1 >= limit {
            // A run of plain characters; a backslash at the end has nothing to escape.
            while position < limit {
                let character = characters[position];
                if character == '\'' || (character == '\\' && position + 1 < limit) {
                    break;
                }
                value.push(character);
                position += 1;
            }
            continue;
        }
        let escape_start = position;
        let escaped = characters[position + 1];
        position += 2;
        match escaped {
            'a' => value.push('\u{7}'),
            'b' => value.push('\u{8}'),
            'e' | 'E' => value.push('\u{1b}'),
            'f' => value.push('\u{c}'),
            'n' => value.push('\n'),
            'r' => value.push('\r'),
            't' => value.push('\t'),
            'v' => value.push('\u{b}'),
            '\\' | '\'' | '"' | '?' => value.push(escaped),
            '\n' => {}
            'c' => match decode_control(&characters, position, value) {
                Some(next) => position = next,
                None => return,
            },
            'x' | 'u' | 'U' => {
                let most_digits = match escaped {
                    'x' => 2,
                    'u' => 4,
                    _ => 8,
                };
                let digits_start = position;
                let mut code = 0_u32;
                while position < limit && position - digits_start < most_digits {
                    let Some(digit) = characters[position].to_digit(16) else {
                        break;
                    };
                    code = code * 16 + digit;
                    position += 1;
                }
                if position == digits_start {
                    value.push('\\');
                    value.push(escaped);
                } else if code == 0 {
                    return;
                } else if let Some(decoded) = char::from_u32(code) {
                    value.push(decoded);
                } else {
                    // A code no character has stays as it was written.
                    value.extend(&characters[escape_start..position]);
                }
            }
            '0'..='7' => {
                let mut code = escaped.to_digit(8).expect("an octal digit");
                while position < limit && position - escape_start - 1 < 3 {
                    let Some(digit) = characters[position].to_digit(8) else {
                        break;
                    };
                    code = code * 8 + digit;
                    position += 1;
                }
                let byte = u8::try_from(code & 0xFF).expect("a value masked to one byte");
                if byte == 0 {
                    return;
                }
                value.push(char::from(byte));
            }
            _ => {
                value.push('\\');
                value.push(escaped);
            }
        }
    }
}

// `\c` and its operand from `position`: the control character the operand names, `\c` as written
// when the closing quote or the end follows. Returns the position past what it read, or `None`
// when the operand names NUL, which ends the string's value.
fn decode_control(characters: &[char], mut position: usize, value: &mut String) -> Option<usize> {
    let limit = characters.len();
    let Some(&operand) = characters.get(position).filter(|&&operand| operand != '\'') else {
        value.push_str("\\c");
        return Some(position);
    };
    position += 1;
    if operand == '\\' {
        // Bash writes a backslash operand as the pair `\c\\`; a lone backslash still decodes and
        // leaves the character after it as written.
        let is_pair = characters.get(position) == Some(&'\\');
        value.push('\u{1c}');
        if is_pair {
            position += 1;
        } else if position < limit {
            value.push(characters[position]);
            position += 1;
        }
        return Some(position);
    }
    let code = if operand == '?' {
        0x7F
    } else {
        u32::from(operand) & 0x1F
    };
    if code == 0 {
        return None;
    }
    value.push(char::from_u32(code).expect("a code below 0x80 is a character"));
    Some(position)
}
