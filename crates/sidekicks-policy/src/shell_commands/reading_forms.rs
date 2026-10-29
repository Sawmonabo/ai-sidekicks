//! Which forms of a shell line a line that only reads may hold: a closed list of the parser's
//! nodes, each with the check its own text needs, so any form the list does not name refuses the
//! line. The walk that reads a line's commands notes each node here as it passes it.

use tree_sitter::Node;

use super::words::{WordBuilder, WordText, node_text};
use super::{continues_variable_name, starts_variable_name, visit_redirect_arguments};

/// The verdict on a line's forms as the walk notes its nodes, with what one node tells the notes
/// of the nodes inside it.
pub(super) struct ReadingForms {
    is_reading: bool,
    // The redirects whose words past their own a simple command takes as its arguments.
    command_redirects: Vec<usize>,
    // The here-document bodies the shell passes as text, whose parts run nothing.
    literal_bodies: Vec<usize>,
}

impl ReadingForms {
    /// Notes of a line with no node noted yet.
    pub(super) fn new() -> Self {
        Self {
            is_reading: true,
            command_redirects: Vec::new(),
            literal_bodies: Vec::new(),
        }
    }

    /// Whether every node noted is a form a reading line may hold.
    pub(super) fn is_reading(&self) -> bool {
        self.is_reading
    }

    /// Notes `node`, and answers whether the walk reads the nodes inside it: false only for a
    /// here-document body the shell passes as text.
    pub(super) fn note(&mut self, node: Node<'_>, builder: &mut WordBuilder<'_>) -> bool {
        if node.kind() == "heredoc_body" {
            return !self.literal_bodies.contains(&node.id());
        }
        let is_reading = self.is_reading_form(node, builder);
        self.is_reading &= is_reading;
        true
    }

    fn is_reading_form(&mut self, node: Node<'_>, builder: &mut WordBuilder<'_>) -> bool {
        // A token's meaning is its parent's to judge.
        if !node.is_named() {
            return true;
        }
        let line = builder.line();
        match node.kind() {
            // bash refuses a subshell after a command's name; zsh runs `=(…)` into a file it
            // writes.
            "command" => !node
                .children(&mut node.walk())
                .any(|child| child.kind() == "subshell"),
            "program"
            | "comment"
            | "command_name"
            | "pipeline"
            | "list"
            | "negated_command"
            | "subshell"
            | "if_statement"
            | "elif_clause"
            | "else_clause"
            | "case_statement"
            | "case_item"
            | "function_definition"
            | "parenthesized_expression"
            | "string"
            | "string_content"
            | "raw_string"
            | "ansi_c_string"
            | "number"
            | "brace_expression"
            | "extglob_pattern"
            | "variable_name"
            | "special_variable_name"
            | "test_operator"
            | "file_descriptor"
            | "herestring_redirect"
            | "heredoc_start"
            | "heredoc_content"
            | "heredoc_end" => true,
            "word" | "concatenation" => !is_descriptor_name(node, line),
            "redirected_statement" => self.note_redirected_statement(node),
            "file_redirect" => {
                self.takes_its_arguments(node) && !redirect_writes_file(node, builder)
            }
            "heredoc_redirect" => {
                self.takes_its_arguments(node) && self.note_here_document(node, line)
            }
            // `(( … ))` is arithmetic, which can set a variable and run a `$(…)` in a subscript.
            "compound_statement" => node.child(0).is_none_or(|open| open.kind() != "(("),
            // A single-bracket test runs the program `[`, which the command list judges.
            "test_command" => {
                node.child(0).is_none_or(|open| open.kind() != "[[")
                    || !is_arithmetic_test(node, line)
            }
            "binary_expression" => node
                .child_by_field_name("operator")
                .is_some_and(|operator| is_test_operator(operator, line)),
            "unary_expression" => node
                .child_by_field_name("operator")
                .is_some_and(|operator| {
                    node_text(operator, line) == "!" || operator.kind() == "test_operator"
                }),
            "simple_expansion" => !is_zsh_subscript(node, line),
            "expansion" => is_reading_expansion(node, line),
            "command_substitution" => is_reading_substitution(node, line),
            // `>(…)` hands its command the line's output to write anywhere.
            "process_substitution" => node.child(0).is_some_and(|open| open.kind() == "<("),
            "regex" => !node_text(node, line).contains(['$', '`', '(']),
            // An assignment, a declaration, a loop, arithmetic, a subscript, an array, a
            // translated string and every form not named above.
            _ => false,
        }
    }

    // A redirect alone runs zsh's `$NULLCMD` or `$READNULLCMD`, a command the person sets; the
    // words past a redirect's own are a simple command's arguments.
    fn note_redirected_statement(&mut self, statement: Node<'_>) -> bool {
        let Some(body) = statement.child_by_field_name("body") else {
            return false;
        };
        if body.kind() == "command" {
            let mut cursor = statement.walk();
            for redirect in statement.children_by_field_name("redirect", &mut cursor) {
                self.command_redirects.push(redirect.id());
                let mut inner = redirect.walk();
                self.command_redirects.extend(
                    redirect
                        .children_by_field_name("redirect", &mut inner)
                        .map(|held| held.id()),
                );
            }
        }
        true
    }

    // Whether a simple command takes the redirect's words past its own, or it has none.
    fn takes_its_arguments(&self, redirect: Node<'_>) -> bool {
        let mut has_arguments = false;
        visit_redirect_arguments(redirect, &mut |_| has_arguments = true);
        !has_arguments || self.command_redirects.contains(&redirect.id())
    }

    // A here-document whose delimiter the parser read as the shell reads it. A quoted delimiter
    // makes the body text; an unquoted one expands it, so the body holds no backquote, backslash
    // or arithmetic, which the parser does not read in a body.
    fn note_here_document(&mut self, redirect: Node<'_>, line: &str) -> bool {
        let mut start = None;
        let mut body = None;
        let mut strips_tabs = false;
        let mut cursor = redirect.walk();
        for child in redirect.children(&mut cursor) {
            match child.kind() {
                "heredoc_start" => start = Some(child),
                "heredoc_body" => body = Some(child),
                "<<-" => strips_tabs = true,
                _ => {}
            }
        }
        let (Some(start), Some(body)) = (start, body) else {
            return false;
        };
        let start_text = node_text(start, line);
        // The parser ends the delimiter at a blank only, the shell at `;`, `|` or `)` too.
        if shell_word_end(line, start.start_byte()) != start.end_byte() {
            return false;
        }
        if !start_text.contains(['\'', '"', '\\']) {
            let text = node_text(body, line);
            return !(text.contains(['`', '\\']) || text.contains("$((") || text.contains("$["));
        }
        let delimiter = shell_delimiter(start_text);
        let is_read_as_the_shell_reads = delimiter == parser_delimiter(start_text)
            || ends_on_the_last_line(line, body, redirect, &delimiter, strips_tabs);
        if is_read_as_the_shell_reads {
            self.literal_bodies.push(body.id());
        }
        is_read_as_the_shell_reads
    }
}

// Where the shell word that starts at `start` ends: at a blank, a newline or a metacharacter
// outside quotes.
fn shell_word_end(line: &str, start: usize) -> usize {
    let bytes = line.as_bytes();
    let mut position = start;
    let mut quote = None;
    while let Some(&byte) = bytes.get(position) {
        match quote {
            Some(open) if byte == open => quote = None,
            Some(b'"') if byte == b'\\' => position += 1,
            Some(_) => {}
            None => match byte {
                b'\'' | b'"' => quote = Some(byte),
                b'\\' => position += 1,
                b' ' | b'\t' | b'\n' | b';' | b'&' | b'|' | b'<' | b'>' | b'(' | b')' => break,
                _ => {}
            },
        }
        position += 1;
    }
    position.min(bytes.len())
}

// A here-document's delimiter as the shell reads its word: quotes removed and backslash escapes
// undone.
fn shell_delimiter(word: &str) -> String {
    let mut delimiter = String::new();
    let mut characters = word.chars();
    let mut quote = None;
    while let Some(character) = characters.next() {
        match (quote, character) {
            (Some(open), _) if character == open => quote = None,
            (None, '\'' | '"') => quote = Some(character),
            (None, '\\') => delimiter.extend(characters.next()),
            (Some('"'), '\\') => match characters.next() {
                Some(escaped @ ('$' | '`' | '"' | '\\')) => delimiter.push(escaped),
                Some(escaped) => {
                    delimiter.push('\\');
                    delimiter.push(escaped);
                }
                None => delimiter.push('\\'),
            },
            (_, character) => delimiter.push(character),
        }
    }
    delimiter
}

// A here-document's delimiter as the parser reads its start: a leading quote's text up to its
// close, or else the text up to a blank, each backslash taking the character after it.
fn parser_delimiter(word: &str) -> String {
    let mut characters = word.chars().peekable();
    let quote = characters.next_if(|&first| matches!(first, '\'' | '"'));
    let mut delimiter = String::new();
    while let Some(character) = characters.next() {
        let ends = match quote {
            Some(open) => character == open || matches!(character, '\r' | '\n'),
            None => character.is_whitespace(),
        };
        if ends {
            break;
        }
        if character == '\\' {
            delimiter.extend(characters.next());
        } else {
            delimiter.push(character);
        }
    }
    delimiter
}

// Whether the shell's delimiter ends the here-document on the line's last line, which the
// parser's body runs to: the parser, reading its own delimiter, found no end, so nothing past the
// body was read as text.
fn ends_on_the_last_line(
    line: &str,
    body: Node<'_>,
    redirect: Node<'_>,
    delimiter: &str,
    strips_tabs: bool,
) -> bool {
    let body_line_start = line[..body.start_byte()].rfind('\n').map_or(0, |at| at + 1);
    let mut position = body_line_start;
    for body_line in line[body_line_start..].split('\n') {
        let end = position + body_line.len();
        let text = if strips_tabs {
            body_line.trim_start_matches('\t')
        } else {
            body_line
        };
        if text == delimiter {
            return matches!(&line[end..], "" | "\n") && redirect.end_byte() >= end;
        }
        position = end + 1;
    }
    false
}

// The operators a `[[ … ]]` test compares strings or files with, beside its test operators.
const TEST_OPERATORS: &[&str] = &["==", "!=", "=", "=~", "<", ">", "&&", "||"];

fn is_test_operator(operator: Node<'_>, line: &str) -> bool {
    operator.kind() == "test_operator" || TEST_OPERATORS.contains(&node_text(operator, line))
}

// A substitution whose command the walk reads: backquotes holding no backslash, since inside them
// `` \` ``, `\$` and `\\` open what the parser reads as text, and a `$(…)` holding only a redirect
// that reads, as `$(<file)` does; any other redirect alone runs zsh's `$NULLCMD`.
fn is_reading_substitution(substitution: Node<'_>, line: &str) -> bool {
    let is_backquoted = substitution
        .child(0)
        .is_some_and(|open| matches!(open.kind(), "`" | "$`"));
    if is_backquoted && node_text(substitution, line).contains('\\') {
        return false;
    }
    substitution
        .child_by_field_name("redirect")
        .is_none_or(|redirect| {
            redirect.child_by_field_name("descriptor").is_none()
                && redirect
                    .children(&mut redirect.walk())
                    .any(|child| child.kind() == "<")
        })
}

// zsh reads `[…]` right after `$name` as its subscript, and `$#name[…]` as the length of a
// subscripted name, which the parser reads as `$#` and then a separate name; a subscript is
// arithmetic.
fn is_zsh_subscript(node: Node<'_>, line: &str) -> bool {
    let is_length = node_text(node, line) == "$#";
    node.next_sibling().is_some_and(|next| {
        next.start_byte() == node.end_byte()
            && (node_text(next, line).starts_with('[') || (is_length && next.is_named()))
    })
}

// The `[[ … ]]` operators whose operands bash evaluates as arithmetic.
const ARITHMETIC_TEST_OPERATORS: &[&str] = &["-eq", "-ne", "-lt", "-le", "-gt", "-ge", "-v"];

// Whether a `[[ … ]]` test holds an operator whose operands bash evaluates as arithmetic. The walk
// stays inside the test's own expressions.
fn is_arithmetic_test(test: Node<'_>, line: &str) -> bool {
    let mut cursor = test.walk();
    if !cursor.goto_first_child() {
        return false;
    }
    loop {
        let node = cursor.node();
        if node.kind() == "test_operator"
            && ARITHMETIC_TEST_OPERATORS.contains(&node_text(node, line))
        {
            return true;
        }
        let descends = matches!(
            node.kind(),
            "binary_expression" | "unary_expression" | "parenthesized_expression"
        );
        if descends && cursor.goto_first_child() {
            continue;
        }
        while !cursor.goto_next_sibling() {
            if !cursor.goto_parent() {
                return false;
            }
        }
    }
}

// Whether a file redirect writes a file: any but a read, a close, a duplication onto a descriptor
// number, or one to the null device. Only its first destination is its own.
fn redirect_writes_file(redirect: Node<'_>, builder: &mut WordBuilder<'_>) -> bool {
    let line = builder.line();
    let mut operator = "";
    let mut destination = None;
    let mut cursor = redirect.walk();
    if cursor.goto_first_child() {
        loop {
            let child = cursor.node();
            match cursor.field_name() {
                Some("destination") => {
                    destination.get_or_insert(child);
                }
                None if !child.is_named() => operator = node_text(child, line),
                Some(_) | None => {}
            }
            if !cursor.goto_next_sibling() {
                break;
            }
        }
    }
    match operator {
        "<" | "<&" | "<&-" | ">&-" => false,
        _ => !destination
            .is_some_and(|destination| writes_no_file(builder, destination, operator == ">&")),
    }
}

// The one device a redirect writes no file through.
const NULL_DEVICE: &str = "/dev/null";

// Whether a redirect's destination, as the shell passes it, is the null device, or a descriptor
// number after `>&`. Its word is built to be read and dropped.
fn writes_no_file(
    builder: &mut WordBuilder<'_>,
    destination: Node<'_>,
    is_duplication: bool,
) -> bool {
    let mark = builder.piece_count();
    let word = builder.push_word(destination);
    let view = builder.view(word);
    let writes_none = view.is_decided()
        && (view.is(NULL_DEVICE)
            || (is_duplication
                && view.len() > 0
                && view.chars().all(|character| character.is_ascii_digit())));
    builder.truncate(mark);
    writes_none
}

// The `${…}` operators that only test, cut, replace in or change the case of the value, and `:`
// before an offset or a length. Never `=` or `:=`, which assign, `!`, which reads the variable a
// value names, or an `@` transform, whose `P` runs the value as a prompt.
const READING_EXPANSION_OPERATORS: &[&str] = &[
    "-", ":-", "+", ":+", "?", ":?", "#", "##", "%", "%%", "/", "//", "/#", "/%", "^", "^^", ",",
    ",,", ":",
];

// The nodes a reading `${…}` holds beside its operators: its braces, its name, and an operand whose
// own commands and expansions the walk reads.
const READING_EXPANSION_PARTS: &[&str] = &[
    "${",
    "}",
    "variable_name",
    "special_variable_name",
    "word",
    "concatenation",
    "string",
    "raw_string",
    "ansi_c_string",
    "simple_expansion",
    "expansion",
    "command_substitution",
    "regex",
];

// Whether a `${…}` expansion only reads its variable: a name right after `${`, since bash 5.3 runs
// `${ command; }` and `${|command; }` in the shell; its operators listed, each `:` offset or length
// digits alone, its other parts listed, and no `$`, backquote or `(` in a pattern or word token,
// which holds an expansion or a process substitution the tree does not show.
fn is_reading_expansion(expansion: Node<'_>, line: &str) -> bool {
    let opens_a_command = node_text(expansion, line)
        .strip_prefix("${")
        .is_some_and(|body| {
            body.starts_with(|character: char| character.is_whitespace() || character == '|')
        });
    if opens_a_command {
        return false;
    }
    let mut cursor = expansion.walk();
    if !cursor.goto_first_child() {
        return true;
    }
    let mut is_offset = false;
    loop {
        let node = cursor.node();
        let text = node_text(node, line);
        let is_reading = if cursor.field_name() == Some("operator") {
            is_offset = text == ":";
            READING_EXPANSION_OPERATORS.contains(&text)
        } else if std::mem::take(&mut is_offset) {
            node.kind() == "number" && text.bytes().all(|byte| byte.is_ascii_digit())
        } else {
            READING_EXPANSION_PARTS.contains(&node.kind())
                && !(matches!(node.kind(), "regex" | "word") && text.contains(['$', '`', '(']))
        };
        if !is_reading {
            return false;
        }
        if !cursor.goto_next_sibling() {
            return true;
        }
    }
}

// Whether a word is `{name}` or `{name[…]}`, which before a redirect assigns the descriptor it
// opens to `name` or to an array element, whose subscript bash evaluates as arithmetic.
fn is_descriptor_name(word: Node<'_>, line: &str) -> bool {
    node_text(word, line)
        .strip_prefix('{')
        .and_then(|rest| rest.strip_suffix('}'))
        .is_some_and(|name| {
            let subscript = name.trim_start_matches(continues_variable_name);
            name.chars().next().is_some_and(starts_variable_name)
                && (subscript.is_empty()
                    || (subscript.starts_with('[') && subscript.ends_with(']')))
        })
}
