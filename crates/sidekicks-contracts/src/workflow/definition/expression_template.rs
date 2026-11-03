//! A parameter's text read as a template: text starting with `=` holds literal text around one or
//! more `{{ e }}` parts, each `e` an expression evaluated at launch. The cut is lexical: it finds
//! where each part closes without parsing the expression, so the parameter check, the save check
//! and the evaluator read the same parts.

use thiserror::Error;

/// What opens a part.
const PART_OPEN: &str = "{{";

/// What closes a part, at brace depth 0.
const PART_CLOSE: &str = "}}";

/// The keyword operators after which a `/` opens a regex literal.
const KEYWORD_OPERATORS: [&str; 3] = ["and", "or", "in"];

/// A parameter's text as the launch reads it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TemplateText<'text> {
    /// Text used as it stands, never evaluated: text not starting with `=`, or the text after an
    /// `=` that opens no part.
    Literal(&'text str),
    /// An `=` template holding one or more parts.
    Expression(ExpressionTemplate<'text>),
}

/// An `=` template cut into its parts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExpressionTemplate<'text> {
    parts: Vec<TemplatePart<'text>>,
    shape: TemplateShape,
}

impl<'text> ExpressionTemplate<'text> {
    /// The parts in text order, the `=` left out; no text part is empty.
    pub fn parts(&self) -> &[TemplatePart<'text>] {
        &self.parts
    }

    /// Whether the template's value is its one expression's or the parts joined into a string.
    pub fn shape(&self) -> TemplateShape {
        self.shape
    }
}

/// One piece of a template.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TemplatePart<'text> {
    /// Literal text between parts, kept as written.
    Text(&'text str),
    /// The text between a part's `{{` and `}}` with leading and trailing whitespace trimmed
    /// (`str::trim`), the text the evaluator parses.
    Expression(&'text str),
}

/// What a template's value is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TemplateShape {
    /// One expression and nothing else, so the value keeps the expression's JSON type.
    Whole,
    /// Text around one or more expressions, or several expressions, so the value is a string of
    /// the parts joined.
    Joined,
}

/// Why a template could not be cut.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Error)]
pub enum TemplateError {
    /// A part's `{{` has no `}}` closing it at depth 0, a string, name, comment or regex literal
    /// left open inside it included.
    #[error("the part opened at byte {at} is never closed")]
    Unclosed {
        /// The byte offset of the unclosed `{{` in the whole text, the `=` counted.
        at: usize,
    },
}

/// Reads a parameter's text as a literal or a template cut into its parts. A string skipped whole
/// inside a part (a quoted string, a backtick name, a `/* … */` comment, a regex literal) never
/// closes it, and `}}` closes a part only outside every `{`. Returns `TemplateError::Unclosed`
/// when a part never closes.
pub fn read_template(text: &str) -> Result<TemplateText<'_>, TemplateError> {
    let Some(body) = text.strip_prefix('=') else {
        return Ok(TemplateText::Literal(text));
    };
    if !body.contains(PART_OPEN) {
        return Ok(TemplateText::Literal(body));
    }
    let mut parts = Vec::new();
    let mut position = 1;
    while let Some(found) = text[position..].find(PART_OPEN) {
        let open = position + found;
        if open > position {
            parts.push(TemplatePart::Text(&text[position..open]));
        }
        let start = open + PART_OPEN.len();
        let close = find_part_close(text, start).ok_or(TemplateError::Unclosed { at: open })?;
        parts.push(TemplatePart::Expression(text[start..close].trim()));
        position = close + PART_CLOSE.len();
    }
    if position < text.len() {
        parts.push(TemplatePart::Text(&text[position..]));
    }
    let shape = if matches!(parts.as_slice(), [TemplatePart::Expression(_)]) {
        TemplateShape::Whole
    } else {
        TemplateShape::Joined
    };
    Ok(TemplateText::Expression(ExpressionTemplate {
        parts,
        shape,
    }))
}

// The byte offset of the `}}` that closes the part whose expression starts at `start`, or `None`
// when the text ends first. `expects_operand` follows the tokens read so far, so a `/` opens a
// regex literal only where an operand stands and is division after a value; whitespace and
// comments leave it as it was.
fn find_part_close(text: &str, start: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut depth = 0_usize;
    let mut expects_operand = true;
    let mut index = start;
    while let Some(&byte) = bytes.get(index) {
        match byte {
            b'}' if depth == 0 => {
                if bytes.get(index + 1) == Some(&b'}') {
                    return Some(index);
                }
                // A lone `}` stays in the expression, for the parse to refuse.
                expects_operand = false;
                index += 1;
            }
            b'}' => {
                depth -= 1;
                expects_operand = false;
                index += 1;
            }
            b'{' => {
                depth += 1;
                expects_operand = true;
                index += 1;
            }
            b'\'' | b'"' => {
                index = skip_quoted(bytes, index)?;
                expects_operand = false;
            }
            b'`' => {
                index = skip_past(bytes, index + 1, b"`")?;
                expects_operand = false;
            }
            b'/' if bytes.get(index + 1) == Some(&b'*') => {
                index = skip_past(bytes, index + 2, b"*/")?;
            }
            b'/' if expects_operand => {
                index = skip_regex(bytes, index)?;
                expects_operand = false;
            }
            // The symbol operators, division among them, and the punctuation an operand follows.
            b'(' | b'[' | b',' | b':' | b';' | b'?' | b'=' | b'!' | b'<' | b'>' | b'+' | b'-'
            | b'&' | b'/' => {
                expects_operand = true;
                index += 1;
            }
            // `~` only opens `~>`, whose `>` sets the expectation; `*` and `%` read as division's
            // left side after them, since the engine reads a `/` there as division whether they
            // are a path's wildcard and parent or multiplication and remainder.
            b')' | b']' | b'.' | b'|' | b'^' | b'@' | b'#' | b'~' | b'*' | b'%' => {
                expects_operand = false;
                index += 1;
            }
            _ => {
                let character = text[index..].chars().next()?;
                if character.is_whitespace() {
                    index += character.len_utf8();
                } else {
                    let end = word_end(text, index);
                    expects_operand = KEYWORD_OPERATORS.contains(&&text[index..end]);
                    index = end;
                }
            }
        }
    }
    None
}

// The offset just past the quoted string opening at `open`, a backslash escaping the byte after.
fn skip_quoted(bytes: &[u8], open: usize) -> Option<usize> {
    let quote = *bytes.get(open)?;
    let mut index = open + 1;
    loop {
        match *bytes.get(index)? {
            b'\\' => index += 2,
            byte if byte == quote => return Some(index + 1),
            _ => index += 1,
        }
    }
}

// The offset just past the first `closing` at or after `from`.
fn skip_past(bytes: &[u8], from: usize, closing: &[u8]) -> Option<usize> {
    let found = bytes
        .get(from..)?
        .windows(closing.len())
        .position(|window| window == closing)?;
    Some(from + found + closing.len())
}

// The offset just past the regex literal opening at `open` and its flags: the pattern ends at the
// first `/` no backslash escapes, and the flags are the letters after it.
fn skip_regex(bytes: &[u8], open: usize) -> Option<usize> {
    let mut index = skip_quoted(bytes, open)?;
    while bytes.get(index).is_some_and(u8::is_ascii_alphabetic) {
        index += 1;
    }
    Some(index)
}

// The offset where the word starting at `start` ends: a name, a number or a `$` variable, up to
// whitespace or a byte that is punctuation in an expression.
fn word_end(text: &str, start: usize) -> usize {
    text[start..]
        .char_indices()
        .find(|&(_, character)| {
            character.is_whitespace()
                || (character.is_ascii_punctuation() && !matches!(character, '$' | '_' | '\\'))
        })
        .map_or(text.len(), |(offset, _)| start + offset)
}

#[cfg(test)]
mod tests {
    use rstest::rstest;

    use super::{
        ExpressionTemplate, TemplateError, TemplatePart, TemplateShape, TemplateText, read_template,
    };

    fn whole(expression: &str) -> TemplateText<'_> {
        TemplateText::Expression(ExpressionTemplate {
            parts: vec![TemplatePart::Expression(expression)],
            shape: TemplateShape::Whole,
        })
    }

    // Each case names the rule it proves; the cut the rule's removal would give is in the comment.
    #[rstest]
    // Text not starting with `=` is never a template, wherever its braces stand.
    #[case::plain_text_is_literal("plain", Ok(TemplateText::Literal("plain")))]
    #[case::an_inner_equals_is_literal("x={{ y }}", Ok(TemplateText::Literal("x={{ y }}")))]
    // One part and nothing else keeps its JSON type; read as joined, it would become a string.
    #[case::one_part_alone_is_whole("={{ a }}", Ok(whole("a")))]
    // Text around parts is a string of the parts in order.
    #[case::text_around_parts_is_joined(
        "=a {{ b }} c {{ d }}",
        Ok(TemplateText::Expression(ExpressionTemplate {
            parts: vec![
                TemplatePart::Text("a "),
                TemplatePart::Expression("b"),
                TemplatePart::Text(" c "),
                TemplatePart::Expression("d"),
            ],
            shape: TemplateShape::Joined,
        })),
    )]
    // `=` opening no part is the text after it; kept whole, the `=` would reach the value.
    #[case::an_equals_with_no_part_is_the_text_after_it("=text", Ok(TemplateText::Literal("text")))]
    // A `}}` skipped whole inside a string, a name, a comment or a regex literal; without the
    // skip each closes the part early and leaves text after it.
    #[case::a_close_in_a_double_quoted_string("={{ \"}}\" }}", Ok(whole("\"}}\"")))]
    #[case::a_close_in_a_single_quoted_string("={{ '}}' }}", Ok(whole("'}}'")))]
    #[case::an_escaped_quote_keeps_the_string_open("={{ \"\\\"}}\" }}", Ok(whole("\"\\\"}}\"")))]
    #[case::a_close_in_a_comment_before_an_operand("={{ /* }} */ 1 }}", Ok(whole("/* }} */ 1")))]
    #[case::a_close_in_a_comment_after_a_value("={{ $a /* }} */ }}", Ok(whole("$a /* }} */")))]
    #[case::a_close_in_a_regex_literal("={{ /}}/i }}", Ok(whole("/}}/i")))]
    #[case::a_close_in_a_backtick_name("={{ `a}}b` }}", Ok(whole("`a}}b`")))]
    // Braces count depth, so an object's closing braces never close the part; without the count
    // the part ends after `$json.x`.
    #[case::an_object_inside_a_part(
        "={{ {\"body\": {\"text\": $json.x}} }}",
        Ok(whole("{\"body\": {\"text\": $json.x}}"))
    )]
    // A lone `}` at depth 0 stays in the expression for the parse to refuse.
    #[case::a_lone_close_brace_stays_in_the_part("={{ a } b }}", Ok(whole("a } b")))]
    // A `/` after a value is division; read as a regex it would swallow the close.
    #[case::a_slash_after_a_value_is_division("={{ 4 / 2 }}", Ok(whole("4 / 2")))]
    // A `/` after a wildcard or a parent step is division, as the engine reads it; read as a regex
    // it would swallow the close.
    #[case::a_slash_after_a_wildcard_is_division("={{ $json.* / 2 }}", Ok(whole("$json.* / 2")))]
    #[case::a_slash_after_a_parent_is_division("={{ a.% / 2 }}", Ok(whole("a.% / 2")))]
    // A `/` after `~>` opens a regex; read as division the `}}` inside it would close the part.
    #[case::a_slash_after_a_chain_opens_a_regex("={{ $x ~> /}}/ }}", Ok(whole("$x ~> /}}/")))]
    // A keyword operator expects an operand, a name that only contains one does not.
    #[case::a_slash_after_a_keyword_opens_a_regex("={{ a and /}}/ }}", Ok(whole("a and /}}/")))]
    #[case::a_slash_after_a_variable_named_like_a_keyword_is_division(
        "={{ $in / 2 }}",
        Ok(whole("$in / 2"))
    )]
    // A part that never closes names where it opened.
    #[case::an_unclosed_part("={{ a", Err(TemplateError::Unclosed { at: 1 }))]
    #[case::a_part_closed_only_inside_its_open_string(
        "=x {{ \"}} }}",
        Err(TemplateError::Unclosed { at: 3 }),
    )]
    fn a_template_is_cut_into_its_parts(
        #[case] text: &str,
        #[case] expected: Result<TemplateText<'_>, TemplateError>,
    ) {
        assert_eq!(read_template(text), expected);
    }
}
