//! Which forms of a shell line a line that only reads may hold: a closed list of the parser's
//! nodes, each with the check its own text needs, so any form the list does not name refuses the
//! line. The walk that reads a line's commands notes each node here as it passes it.

use std::collections::HashSet;

use tree_sitter::Node;

use super::words::{WordBuilder, WordText, node_text};
use super::{continues_variable_name, starts_variable_name, visit_redirect_arguments};

/// The verdict on a line's forms as the walk notes its nodes, with what one node tells the notes
/// of the nodes inside it.
pub(super) struct ReadingForms {
    is_reading: bool,
    // The redirects whose words past their own a simple command takes as its arguments.
    command_redirects: HashSet<usize>,
    // The here-document bodies the shell passes as text, whose parts run nothing.
    literal_bodies: HashSet<usize>,
    // Each quoted here-document start the parser reads otherwise than the shell, in the line's
    // order: its byte range and the shell's delimiter in single quotes, which the shell reads the
    // same way and the parser reads as the shell does.
    delimiter_requotes: Vec<(usize, usize, String)>,
    // Where the furthest body of the here-documents noted so far begins: a here-document that
    // starts before it shares a start's line with another.
    here_document_bodies_start: usize,
}

impl ReadingForms {
    /// Notes of a line with no node noted yet.
    pub(super) fn new() -> Self {
        Self {
            is_reading: true,
            command_redirects: HashSet::new(),
            literal_bodies: HashSet::new(),
            delimiter_requotes: Vec::new(),
            here_document_bodies_start: 0,
        }
    }

    /// Whether every node noted is a form a reading line may hold.
    pub(super) fn is_reading(&self) -> bool {
        self.is_reading
    }

    /// `line` with every here-document start the parser misreads put in single quotes, each start
    /// the shell reads the same way and the parser reads as the shell does, built in one pass from
    /// the line's own offsets; `None` when no start needs it.
    pub(super) fn requote_delimiters(&self, line: &str) -> Option<Box<str>> {
        if self.delimiter_requotes.is_empty() {
            return None;
        }
        let mut requoted = String::with_capacity(line.len() + 2 * self.delimiter_requotes.len());
        let mut kept_from = 0;
        for (start, end, quoted) in &self.delimiter_requotes {
            requoted.push_str(&line[kept_from..*start]);
            requoted.push_str(quoted);
            kept_from = *end;
        }
        requoted.push_str(&line[kept_from..]);
        Some(requoted.into_boxed_str())
    }

    /// Notes `node`, the walk's `previous_sibling` beside it, and answers whether the walk reads
    /// the nodes inside it: false only for a here-document body the shell passes as text.
    pub(super) fn note(
        &mut self,
        node: Node<'_>,
        previous_sibling: Option<Node<'_>>,
        builder: &mut WordBuilder<'_>,
    ) -> bool {
        if previous_sibling.is_some_and(|previous| is_zsh_subscript(previous, node, builder.line()))
        {
            self.is_reading = false;
        }
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
            | "simple_expansion"
            | "special_variable_name"
            | "test_operator"
            | "file_descriptor"
            | "herestring_redirect"
            | "heredoc_start"
            | "heredoc_content"
            | "heredoc_end" => true,
            "word" | "concatenation" => {
                // zsh reads `~[name]` as a named directory a function of the person's makes.
                !is_descriptor_name(node, line) && !node_text(node, line).starts_with("~[")
            }
            "redirected_statement" => self.note_redirected_statement(node),
            "file_redirect" => {
                self.takes_its_arguments(node) && !redirect_writes_file(node, builder)
            }
            "heredoc_redirect" => {
                self.takes_its_arguments(node) && self.note_here_document(node, builder)
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
                self.command_redirects.insert(redirect.id());
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

    // A here-document whose delimiter the parser read as the shell reads it, alone on its start's
    // line, since the parser reads two bodies from one line last first and the shell in order, and
    // whose body and end lie where the shell's do. A quoted delimiter makes the body text; an
    // unquoted one expands it, so the body holds no backquote, backslash, arithmetic or zsh
    // subscript, which the parser does not read in a body. A quoted start the parser reads
    // otherwise is noted to be requoted for a second read.
    fn note_here_document(&mut self, redirect: Node<'_>, builder: &mut WordBuilder<'_>) -> bool {
        let line = builder.line();
        let (mut start, mut body, mut end) = (None, None, None);
        let mut strips_tabs = false;
        let mut cursor = redirect.walk();
        for child in redirect.children(&mut cursor) {
            match child.kind() {
                "<<-" => strips_tabs = true,
                "heredoc_start" => start = Some(child),
                "heredoc_body" => body = Some(child),
                "heredoc_end" => end = Some(child),
                _ => {}
            }
        }
        let (Some(start), Some(body), Some(end)) = (start, body, end) else {
            return false;
        };
        let shares_a_line = start.start_byte() < self.here_document_bodies_start;
        self.here_document_bodies_start = self.here_document_bodies_start.max(body.start_byte());
        if shares_a_line {
            return false;
        }
        let mark = builder.piece_count();
        let (word, word_end) = builder.push_unexpanded_word(start.start_byte());
        let delimiter = builder.view(word).to_string();
        builder.truncate(mark);
        let word_text = &line[start.start_byte()..word_end];
        // The parser compares a delimiter's characters with the line's as single bytes, so one past
        // ASCII never ends its body; the shells take apart every other `$` form and backquotes in a
        // start, reading a quote inside one as nested or as the word's own.
        if !word_text.is_ascii()
            || word_text.contains('`')
            || !holds_only_plain_parameters(word_text)
        {
            return false;
        }
        // The parser ends a body at a line that only starts with the delimiter after blanks, and
        // reads a quote or a substitution in an expanded body across the line the shell ends at.
        let ends_as_the_shell_ends = || {
            shell_here_document_span(line, word_end, end.start_byte(), &delimiter, strips_tabs)
                .is_some_and(|shell| occupies_the_shells_span(line, body, end, &shell))
        };
        if !word_text.contains(['\'', '"', '\\']) {
            // The parser ends the delimiter at a blank only, the shell at `;`, `|` or `)` too.
            return word_end == start.end_byte()
                && ends_as_the_shell_ends()
                && is_reading_expanded_body(node_text(body, line));
        }
        // The parser reads a body as text only after a start that opens with a quote or `\`.
        let is_read_as_text = word_text.starts_with(['\'', '"', '\\'])
            && word_end == start.end_byte()
            && parser_delimiter(word_text) == delimiter;
        if !is_read_as_text {
            // A delimiter holding a quote or a newline has no single-quoted form.
            if !delimiter.contains(['\'', '\n']) {
                self.delimiter_requotes.push((
                    start.start_byte(),
                    word_end,
                    format!("'{delimiter}'"),
                ));
            }
            return false;
        }
        self.literal_bodies.insert(body.id());
        ends_as_the_shell_ends()
    }
}

// Where the shell reads a here-document's body and end, by text: the body from the line after the
// start's, which ends at the first newline past `start_end`, up to the first line that is the
// delimiter, after its leading tabs for `<<-`. Only the lines up to the one the parser ends the
// body on, which holds `parser_end`, are read: `None` when an earlier line is the delimiter or
// that line is not, since the parser's end then differs from the shell's.
fn shell_here_document_span(
    line: &str,
    start_end: usize,
    parser_end: usize,
    delimiter: &str,
    strips_tabs: bool,
) -> Option<ShellHereDocumentSpan> {
    let bytes = line.as_bytes();
    let body_start = start_end + memchr::memchr(b'\n', &bytes[start_end..])? + 1;
    let end_line_start =
        memchr::memrchr(b'\n', &bytes[..parser_end]).map_or(0, |offset| offset + 1);
    if end_line_start < body_start {
        return None;
    }
    let delimiter_text = |line_start: usize, line_end: usize| {
        let text = &line[line_start..line_end];
        if strips_tabs {
            text.trim_start_matches('\t')
        } else {
            text
        }
    };
    let mut line_start = body_start;
    while line_start < end_line_start {
        let line_end = line_start
            + memchr::memchr(b'\n', &bytes[line_start..end_line_start])
                .expect("a newline ends each line before the parser's end line");
        if delimiter_text(line_start, line_end) == delimiter {
            return None;
        }
        line_start = line_end + 1;
    }
    let line_end = memchr::memchr(b'\n', &bytes[end_line_start..])
        .map_or(bytes.len(), |offset| end_line_start + offset);
    let end_text = delimiter_text(end_line_start, line_end);
    (end_text == delimiter).then(|| ShellHereDocumentSpan {
        body_start,
        end: line_end - end_text.len()..line_end,
    })
}

// Where the shell reads a here-document's body to begin and its delimiter on the line that ends it.
struct ShellHereDocumentSpan {
    body_start: usize,
    end: std::ops::Range<usize>,
}

// Whether the parser's body and end lie where the shell's do: the end on the shell's delimiter,
// byte for byte, and the body between the shell's body start and that end, past only the blanks
// and newlines the parser skips at a line's start, which hold nothing to run.
fn occupies_the_shells_span(
    line: &str,
    body: Node<'_>,
    end: Node<'_>,
    shell: &ShellHereDocumentSpan,
) -> bool {
    let is_blank = |range: std::ops::Range<usize>| {
        line.as_bytes()[range]
            .iter()
            .all(|byte| matches!(byte, b' ' | b'\t' | b'\n'))
    };
    end.byte_range() == shell.end
        && shell.body_start <= body.start_byte()
        && body.end_byte() <= shell.end.start
        && is_blank(shell.body_start..body.start_byte())
        && is_blank(body.end_byte()..shell.end.start)
}

// Whether an expanded here-document body holds only what the parser reads in one: no backquote,
// backslash or arithmetic, and no zsh subscript after a parameter the parser leaves as text.
fn is_reading_expanded_body(text: &str) -> bool {
    !(text.contains(['`', '\\'])
        || text.contains("$((")
        || text.contains("$[")
        || has_parameter_subscript(text))
}

// Whether text holds `$`, then any run of `#` and zsh's flags `+`, `=`, `~` and `^`, then a name,
// digits or one special parameter, and then `[`: zsh's subscript, which is arithmetic. In a body
// and a string the parser leaves a `$` before `#`, a flag, a digit or a special parameter as text.
fn has_parameter_subscript(text: &str) -> bool {
    let bytes = text.as_bytes();
    memchr::memchr_iter(b'$', bytes).any(|dollar| {
        let mut position = dollar + 1;
        let flag_count = bytes[position..]
            .iter()
            .take_while(|byte| matches!(byte, b'#' | b'+' | b'=' | b'~' | b'^'))
            .count();
        position += flag_count;
        let parameter_start = position;
        match bytes.get(position) {
            Some(byte) if byte.is_ascii_digit() => {
                position += bytes[position..]
                    .iter()
                    .take_while(|byte| byte.is_ascii_digit())
                    .count();
            }
            Some(b'@' | b'*' | b'!' | b'$' | b'?' | b'-') => position += 1,
            Some(&byte) if starts_variable_name(char::from(byte)) => {
                position += bytes[position..]
                    .iter()
                    .take_while(|&&byte| continues_variable_name(char::from(byte)))
                    .count();
            }
            Some(_) | None => {}
        }
        (position > parameter_start || flag_count > 0) && bytes.get(position) == Some(&b'[')
    })
}

// Whether every `$` in a here-document's start is a plain parameter: `$` and a run of letters,
// digits and `_`, not followed by `[`. The three shells read every other `$` form in a start apart.
fn holds_only_plain_parameters(word: &str) -> bool {
    let bytes = word.as_bytes();
    memchr::memchr_iter(b'$', bytes).all(|dollar| {
        let name_length = bytes[dollar + 1..]
            .iter()
            .take_while(|byte| byte.is_ascii_alphanumeric() || **byte == b'_')
            .count();
        name_length > 0 && bytes.get(dollar + 1 + name_length) != Some(&b'[')
    })
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

// Whether `next`, the node right after `previous`, makes it a zsh subscript: zsh reads `[…]` right
// after `$name` as its subscript, and `$#name[…]` as the length of a subscripted name, which the
// parser reads as `$#` and then a separate name; inside double quotes it reads `$+name[…]` and its
// flag siblings as one too, which the parser reads as a lone `$` and then the string's text. A
// subscript is arithmetic.
fn is_zsh_subscript(previous: Node<'_>, next: Node<'_>, line: &str) -> bool {
    if next.start_byte() != previous.end_byte() {
        return false;
    }
    match previous.kind() {
        "simple_expansion" => {
            node_text(next, line).starts_with('[')
                || (node_text(previous, line) == "$#" && next.is_named())
        }
        "$" => {
            next.kind() == "string_content"
                && has_parameter_subscript(&line[previous.start_byte()..next.end_byte()])
        }
        _ => false,
    }
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
