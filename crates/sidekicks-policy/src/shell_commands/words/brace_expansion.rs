//! The brace expansions the shell reads in a word's unquoted text: an unquoted comma between a
//! matching pair, or a sequence.

/// Whether `text` holds a brace expansion the shell expands into alternatives: an unescaped `{`
/// and its matching `}` with an unescaped comma between them outside any nested pair, or a
/// sequence, `{1..3}` or `{a..c}` with an optional step. `{}` and `{x}` are text.
pub(super) fn holds_brace_expansion(text: &str) -> bool {
    let bytes = text.as_bytes();
    let mut position = 0;
    while position < bytes.len() {
        match bytes[position] {
            b'\\' => position += 2,
            b'{' => {
                if let Some((has_comma, end)) = matching_brace(bytes, position)
                    && (has_comma || is_brace_sequence(&text[position + 1..end]))
                {
                    return true;
                }
                position += 1;
            }
            _ => position += 1,
        }
    }
    false
}

// The `}` matching the `{` at `open`, and whether an unescaped comma lies between them outside
// any nested pair; `None` when none matches.
fn matching_brace(bytes: &[u8], open: usize) -> Option<(bool, usize)> {
    let mut depth = 0_usize;
    let mut has_comma = false;
    let mut position = open + 1;
    while position < bytes.len() {
        match bytes[position] {
            b'\\' => position += 1,
            b'{' => depth += 1,
            b'}' if depth == 0 => return Some((has_comma, position)),
            b'}' => depth -= 1,
            b',' if depth == 0 => has_comma = true,
            _ => {}
        }
        position += 1;
    }
    None
}

// Whether `inside` is a brace sequence's body: two integers or two single characters joined by
// `..`, with an optional `..` and integer step.
fn is_brace_sequence(inside: &str) -> bool {
    let parts: Vec<&str> = inside.split("..").collect();
    let is_integer = |part: &str| {
        let digits = part.strip_prefix(['-', '+']).unwrap_or(part);
        !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())
    };
    let is_character = |part: &str| part.chars().count() == 1;
    match parts.as_slice() {
        [from, to] | [from, to, _] if parts.get(2).is_none_or(|step| is_integer(step)) => {
            (is_integer(from) && is_integer(to)) || (is_character(from) && is_character(to))
        }
        _ => false,
    }
}
