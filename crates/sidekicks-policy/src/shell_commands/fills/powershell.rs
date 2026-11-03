//! The PowerShell reading of a command line's fills: tree-sitter-powershell's tree of the line,
//! its typographic quotes read as the plain ones PowerShell takes them for, and each fill placed by
//! the token or string holding its placeholder.

use std::borrow::Cow;
use std::ops::Range;

use tree_sitter::{Node, Parser};

use super::{CommandLineFills, FillPlace, FillPlacing, FillRefusal, follows_a_dollar, is_escaped};
use crate::shell_commands::ShellLineReader;
use crate::shell_commands::words::node_text;

/// Each fill's place under PowerShell's grammar, in line order; every fill is refused on a line
/// past the reader's limit or one the parser cannot read whole.
pub(super) fn place_fills(
    reader: &mut ShellLineReader,
    fills: &CommandLineFills,
) -> Vec<FillPlacing> {
    let line = fills.line();
    if line.len() > reader.limit {
        return fills.refuse_all(&FillRefusal::NotWhole);
    }
    let text = with_plain_quotes(line);
    let parser = reader.powershell_parser.get_or_insert_with(|| {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_powershell::LANGUAGE.into())
            .expect("the PowerShell grammar's ABI, fixed at build, is one this tree-sitter reads");
        parser
    });
    let tree = parser
        .parse(text.as_ref(), None)
        .expect("a parser with its language set and no cancellation always returns a tree");
    let root = tree.root_node();
    if root.has_error() {
        return fills.refuse_all(&FillRefusal::NotWhole);
    }
    let Some(placeholders) = fills.placeholders_in(&text) else {
        return fills.refuse_all(&FillRefusal::UnreadPlace);
    };
    // A fill inside the string an earlier fill opens takes the string's form.
    let mut string_end = 0;
    placeholders
        .into_iter()
        .map(|placeholder| {
            let placing = place_fill(root, &text, placeholder.clone());
            match placing {
                Ok(FillPlace::Bare) if placeholder.start < string_end => Ok(FillPlace::InString),
                Ok(FillPlace::OpensString { rest_length }) => {
                    string_end = placeholder.end + rest_length;
                    placing
                }
                Ok(FillPlace::Bare | FillPlace::InString | FillPlace::CommandName) | Err(_) => {
                    placing
                }
            }
        })
        .collect()
}

/// `line` with PowerShell's typographic single quotes as `'` and its typographic double quotes as
/// `"`, which the grammar does not know but PowerShell reads as the plain ones.
fn with_plain_quotes(line: &str) -> Cow<'_, str> {
    if !line.contains(['‘', '’', '‚', '‛', '“', '”', '„']) {
        return Cow::Borrowed(line);
    }
    Cow::Owned(
        line.chars()
            .map(|character| match character {
                '‘' | '’' | '‚' | '‛' => '\'',
                '“' | '”' | '„' => '"',
                other => other,
            })
            .collect(),
    )
}

/// The place of the fill whose placeholder lies at `placeholder` in `text`, by the named node
/// holding it.
fn place_fill(root: Node<'_>, text: &str, placeholder: Range<usize>) -> FillPlacing {
    if is_escaped(text, placeholder.start, b'`') {
        return Err(FillRefusal::Escaped);
    }
    let holder = root
        .named_descendant_for_byte_range(placeholder.start, placeholder.end)
        .ok_or(FillRefusal::UnreadPlace)?;
    let mut ancestor = Some(holder);
    while let Some(node) = ancestor {
        if matches!(node.kind(), "verbatim_command_argument" | "stop_parsing") {
            return Err(FillRefusal::StopParsing);
        }
        ancestor = node.parent();
    }
    match holder.kind() {
        "generic_token" | "command_parameter" => {
            let offset = placeholder.start - holder.start_byte();
            place_in_token(node_text(holder, text), offset..offset + placeholder.len())
        }
        "command_name" if node_text(holder, text) == &text[placeholder.start..placeholder.end] => {
            // After `&` or `.` the name is already called through the operator.
            if is_after_a_call_operator(holder) {
                Ok(FillPlace::Bare)
            } else {
                Ok(FillPlace::CommandName)
            }
        }
        "expandable_string_literal" | "expandable_here_string_literal" => {
            if follows_a_dollar(text, placeholder.start) {
                Err(FillRefusal::UnreadPlace)
            } else {
                Ok(FillPlace::InString)
            }
        }
        "verbatim_string_characters" | "verbatim_here_string_characters" => {
            Err(FillRefusal::NotExpanding)
        }
        "comment" => Err(FillRefusal::Comment),
        "braced_variable" => Err(FillRefusal::BracedVariable),
        _ => Err(FillRefusal::UnreadPlace),
    }
}

/// Whether the command whose name is `name` runs it through `&` or `.`.
fn is_after_a_call_operator(name: Node<'_>) -> bool {
    let mut ancestor = name.parent();
    while let Some(node) = ancestor {
        if node.kind() == "command" {
            return node
                .child(0)
                .is_some_and(|first| first.kind() == "command_invokation_operator");
        }
        ancestor = node.parent();
    }
    false
}

/// The place of a fill at `placeholder` in a bare argument's `token`, which PowerShell reads with
/// its own quotes: inside `"…"` the in-string form, inside `'…'` none, and outside both the bare
/// form. A fill that starts a token going on past it opens a string holding the rest, since
/// PowerShell reads a quoted start followed by text as a member access or two arguments; a rest
/// holding a quote, a backquote or a `$`, which a string reads otherwise, is refused.
fn place_in_token(token: &str, placeholder: Range<usize>) -> FillPlacing {
    let offset = placeholder.start;
    let mut quote = None;
    let mut bytes = token.as_bytes()[..offset].iter();
    while let Some(&byte) = bytes.next() {
        match (quote, byte) {
            (None | Some(b'"'), b'`') => {
                bytes.next();
            }
            (None, b'"' | b'\'') => quote = Some(byte),
            (Some(open), _) if byte == open => quote = None,
            _ => {}
        }
    }
    if follows_a_dollar(token, offset) {
        return Err(FillRefusal::UnreadPlace);
    }
    let rest = &token[placeholder.end..];
    match quote {
        None if offset == 0 && !rest.is_empty() => {
            if rest.contains(['"', '\'', '`', '$']) {
                Err(FillRefusal::UnreadPlace)
            } else {
                Ok(FillPlace::OpensString {
                    rest_length: rest.len(),
                })
            }
        }
        None => Ok(FillPlace::Bare),
        Some(b'"') => Ok(FillPlace::InString),
        Some(_) => Err(FillRefusal::NotExpanding),
    }
}
