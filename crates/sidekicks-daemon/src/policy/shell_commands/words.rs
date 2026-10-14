//! A shell word's value as the shell passes it to a program: quotes removed, backslash escapes
//! undone and ANSI-C strings decoded, with every expansion and substitution kept as its text.

use tree_sitter::Node;

/// The source text `node` spans.
pub(super) fn node_text<'s>(node: Node<'_>, source: &'s str) -> &'s str {
    source
        .get(node.byte_range())
        .expect("the parser ends a node only between characters of the line it read")
}

/// The value of the literal `node`: a concatenation joins its parts' values, and every kind no
/// quoting or escape changes reads as its text.
pub(super) fn word_value(node: Node<'_>, source: &str) -> String {
    if node.kind() != "concatenation" {
        return part_value(node, source);
    }
    let mut value = String::new();
    let mut cursor = node.walk();
    if cursor.goto_first_child() {
        loop {
            value.push_str(&part_value(cursor.node(), source));
            if !cursor.goto_next_sibling() {
                break;
            }
        }
    }
    value
}

fn part_value(node: Node<'_>, source: &str) -> String {
    // A node the parser supplied for a missing token spans nothing.
    if node.is_missing() {
        return String::new();
    }
    let text = node_text(node, source);
    match node.kind() {
        "word" => unescape_bare(text),
        "raw_string" => text
            .strip_prefix('\'')
            .and_then(|quoted| quoted.strip_suffix('\''))
            .unwrap_or(text)
            .to_owned(),
        "ansi_c_string" => decode_ansi_c(text.strip_prefix("$'").unwrap_or(text)),
        "string" => double_quoted_value(node, source),
        // `$"…"` is a double-quoted string translated by the locale, which is not applied here.
        "translated_string" => node
            .named_child(0)
            .map_or_else(|| text.to_owned(), |string| part_value(string, source)),
        _ => text.to_owned(),
    }
}

// An unquoted word: each backslash keeps the character after it, a backslash and a line break go
// together, and a backslash ending the word stays.
fn unescape_bare(text: &str) -> String {
    let mut value = String::with_capacity(text.len());
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
    value
}

// A double-quoted string: its text between the quotes with the escapes double quotes undo, and its
// expansions and substitutions as their text. The text is read from the line, since a line break
// inside the quotes is no token of the string's own.
fn double_quoted_value(string: Node<'_>, source: &str) -> String {
    let mut value = String::new();
    let mut position = string.start_byte() + 1;
    let mut end = string.end_byte();
    let mut cursor = string.walk();
    if cursor.goto_first_child() {
        loop {
            let child = cursor.node();
            match child.kind() {
                "expansion"
                | "simple_expansion"
                | "command_substitution"
                | "arithmetic_expansion" => {
                    push_double_quoted(&mut value, &source[position..child.start_byte()]);
                    value.push_str(node_text(child, source));
                    position = child.end_byte();
                }
                "\"" if child.start_byte() > string.start_byte() => end = child.start_byte(),
                _ => {}
            }
            if !cursor.goto_next_sibling() {
                break;
            }
        }
    }
    push_double_quoted(&mut value, &source[position..end.max(position)]);
    value
}

// Text inside double quotes: a backslash before `$`, `` ` ``, `"` or another backslash keeps that
// character, a backslash and a line break go together, any other backslash stays, and one ending
// the text is dropped.
fn push_double_quoted(value: &mut String, text: &str) {
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

// An ANSI-C quoted string's body, `$'` already taken off, decoded as bash decodes it up to its
// closing quote.
fn decode_ansi_c(body: &str) -> String {
    let characters: Vec<char> = body.chars().collect();
    let limit = characters.len();
    let mut value = String::new();
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
            'c' => position = decode_control(&characters, position, &mut value),
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
                value.push(char::from(byte));
            }
            _ => {
                value.push('\\');
                value.push(escaped);
            }
        }
    }
    value
}

// `\c` and its operand from `position`: the control character the operand names, `\c` as written
// when the closing quote or the end follows. Returns the position past what it read.
fn decode_control(characters: &[char], mut position: usize, value: &mut String) -> usize {
    let limit = characters.len();
    let Some(&operand) = characters.get(position).filter(|&&operand| operand != '\'') else {
        value.push_str("\\c");
        return position;
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
        return position;
    }
    let code = if operand == '?' {
        0x7F
    } else {
        u32::from(operand) & 0x1F
    };
    value.push(char::from_u32(code).expect("a code below 0x80 is a character"));
    position
}
