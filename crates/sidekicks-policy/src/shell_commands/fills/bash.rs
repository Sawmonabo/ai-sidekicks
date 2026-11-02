//! The bash reading of a command line's fills: tree-sitter-bash's tree of the line, read again with
//! each here-document start the parser misreads put in single quotes, and each fill placed by the
//! nodes around its placeholder. The reading places a fill for a POSIX shell and for cmd.exe.

use std::ops::Range;

use tree_sitter::{Node, Tree};

use super::{CommandLineFills, FillPlace, FillPlacing, FillRefusal, is_escaped};
use crate::shell_commands::reading_forms::{
    ARITHMETIC_TEST_OPERATORS, HereDocumentParts, is_reading_expanded_body,
};
use crate::shell_commands::words::{WordBuilder, node_text};
use crate::shell_commands::{ShellLineReader, commands_in};

/// The `${…}` operators whose word bash expands as a pattern, in a context of its own that no
/// enclosing double quotes reach.
const PATTERN_OPERATORS: &[&str] = &[
    "#", "##", "%", "%%", "/", "//", "/#", "/%", "^", "^^", ",", ",,",
];

/// A builtin that reads some of its words as variable names: its options that take a value, those
/// whose value is a name, and which operands are names.
struct NameWordBuiltin {
    names: &'static [&'static str],
    value_options: &'static str,
    name_options: &'static str,
    operand_names: OperandNames,
    // Whether an option is still read after an operand, as `test` reads its operators.
    reads_options_past_operands: bool,
}

/// Which of a builtin's operands are names.
#[derive(Clone, Copy)]
enum OperandNames {
    None,
    All,
    At(usize),
}

/// The builtins named by their command name whose words a name word can be.
const NAME_WORD_BUILTINS: &[NameWordBuiltin] = &[
    NameWordBuiltin {
        names: &["read"],
        value_options: "adinNptu",
        name_options: "a",
        operand_names: OperandNames::All,
        reads_options_past_operands: false,
    },
    NameWordBuiltin {
        names: &["printf"],
        value_options: "v",
        name_options: "v",
        operand_names: OperandNames::None,
        reads_options_past_operands: false,
    },
    NameWordBuiltin {
        names: &["mapfile", "readarray"],
        value_options: "dnOsuCc",
        name_options: "",
        operand_names: OperandNames::All,
        reads_options_past_operands: false,
    },
    NameWordBuiltin {
        names: &["getopts"],
        value_options: "",
        name_options: "",
        operand_names: OperandNames::At(1),
        reads_options_past_operands: false,
    },
    NameWordBuiltin {
        names: &["wait"],
        value_options: "p",
        name_options: "p",
        operand_names: OperandNames::None,
        reads_options_past_operands: false,
    },
    NameWordBuiltin {
        names: &["test"],
        value_options: "v",
        name_options: "v",
        operand_names: OperandNames::None,
        reads_options_past_operands: true,
    },
];

impl ShellLineReader {
    /// `text`'s tree from the reader's parser, its bytes taken from what the reader has left as
    /// `read` takes them; `None` for a string past the limit or past what is left.
    fn parse_tree(&mut self, text: &str) -> Option<Tree> {
        self.charge(text.len()).then(|| {
            self.parser
                .parse(text, None)
                .expect("a parser with its language set and no cancellation always returns a tree")
        })
    }
}

/// Each fill's place under bash's grammar, in line order. The line is parsed once as written and,
/// when a here-document start needs it, once more requoted; every fill is refused on a line either
/// parse cannot read whole or whose here-document does not end where bash ends it.
pub(super) fn place_fills(
    reader: &mut ShellLineReader,
    fills: &CommandLineFills,
) -> Vec<FillPlacing> {
    let line = fills.line();
    let Some(tree) = reader.parse_tree(line) else {
        return fills.refuse_all(&FillRefusal::NotWhole);
    };
    let requoted = {
        let mut builder = WordBuilder::new(line);
        let (_, _, _, forms) = commands_in(tree.root_node(), &mut builder);
        forms.requote_delimiters(line)
    };
    let (text, tree) = match requoted.as_deref() {
        Some(requoted) => {
            drop(tree);
            match reader.parse_tree(requoted) {
                Some(tree) => (requoted, tree),
                None => return fills.refuse_all(&FillRefusal::NotWhole),
            }
        }
        None => (line, tree),
    };
    let root = tree.root_node();
    if root.has_error() {
        return fills.refuse_all(&FillRefusal::NotWhole);
    }
    if let Err(refusal) = check_here_document_ends(root, text) {
        return fills.refuse_all(&refusal);
    }
    let Some(placeholders) = fills.placeholders_in(text) else {
        return fills.refuse_all(&FillRefusal::UnreadPlace);
    };
    placeholders
        .into_iter()
        .map(|placeholder| place_fill(root, text, placeholder))
        .collect()
}

/// Refuses a line holding a here-document whose body and end do not lie where bash reads them, or
/// two here-documents started on one line, which the parser reads last first and bash in order.
fn check_here_document_ends(root: Node<'_>, text: &str) -> Result<(), FillRefusal> {
    let mut builder = WordBuilder::new(text);
    let mut bodies_start = 0;
    let mut cursor = root.walk();
    loop {
        let node = cursor.node();
        if node.kind() == "heredoc_redirect" {
            let Some(parts) = HereDocumentParts::of(node) else {
                return Err(FillRefusal::NotWhole);
            };
            let (delimiter, word_end) = parts.read_delimiter(&mut builder);
            let shares_a_line = parts.start().start_byte() < bodies_start;
            bodies_start = bodies_start.max(parts.body().start_byte());
            if shares_a_line || !parts.lies_where_the_shell_reads_it(text, word_end, &delimiter) {
                return Err(FillRefusal::HereDocumentEnd { delimiter });
            }
        }
        if cursor.goto_first_child() {
            continue;
        }
        while !cursor.goto_next_sibling() {
            if !cursor.goto_parent() {
                return Ok(());
            }
        }
    }
}

/// The place of the fill whose placeholder lies at `placeholder` in `text`: the nodes around it,
/// from the nearest out, decide its form or refuse it, and it is then refused unless the node
/// holding it is a word, a string's or a body's text, or a pattern word. The walk goes first, so
/// arithmetic or a name word refuses the fill as such wherever the parser names the node.
fn place_fill(root: Node<'_>, text: &str, placeholder: Range<usize>) -> FillPlacing {
    if is_escaped(text, placeholder.start, b'\\') {
        return Err(FillRefusal::Escaped);
    }
    let holder = root
        .named_descendant_for_byte_range(placeholder.start, placeholder.end)
        .ok_or(FillRefusal::UnreadPlace)?;
    let mut walk = PlaceWalk {
        text,
        placeholder,
        place: None,
        is_in_backquotes: false,
        test_operator: None,
    };
    let (mut below, mut child, mut node) = (None, None, Some(holder));
    while let Some(current) = node {
        walk.pass(current, child, below)?;
        below = child;
        child = Some(current);
        node = current.parent();
    }
    match holder.kind() {
        "word" | "string_content" | "heredoc_content" | "heredoc_body" => {}
        "regex"
            if holder
                .parent()
                .is_some_and(|parent| parent.kind() == "expansion") => {}
        "raw_string" | "ansi_c_string" => return Err(FillRefusal::NotExpanding),
        "comment" => return Err(FillRefusal::Comment),
        _ => return Err(FillRefusal::UnreadPlace),
    }
    Ok(walk.place.unwrap_or(FillPlace::Bare))
}

/// The walk out from a placeholder's node: the place the nearest quoting decided, whether the
/// fill sits in backquotes whose quoting context is still to be seen, and an arithmetic or name
/// test operator waiting for its test.
struct PlaceWalk<'s> {
    text: &'s str,
    placeholder: Range<usize>,
    place: Option<FillPlace>,
    is_in_backquotes: bool,
    test_operator: Option<&'s str>,
}

impl<'s> PlaceWalk<'s> {
    /// Passes `current`, reached from its child `child`, itself reached from `below`: a quoting
    /// node or a substitution decides the place if nothing nearer did, and arithmetic or a name
    /// word refuses the fill at any depth, through substitutions too, since the shell evaluates
    /// whatever lands there.
    fn pass(
        &mut self,
        current: Node<'s>,
        child: Option<Node<'s>>,
        below: Option<Node<'s>>,
    ) -> Result<(), FillRefusal> {
        match current.kind() {
            "string" => self.enter_expanding_text()?,
            "heredoc_body" => {
                let start = current
                    .prev_sibling()
                    .filter(|sibling| sibling.kind() == "heredoc_start")
                    .or_else(|| heredoc_start_of(current));
                // Any quoted part of the start makes the body text, as bash reads it.
                if start.is_none_or(|start| node_text(start, self.text).contains(['\'', '"', '\\']))
                {
                    return Err(FillRefusal::NotExpanding);
                }
                if !is_reading_expanded_body(node_text(current, self.text)) {
                    return Err(FillRefusal::UnreadPlace);
                }
                self.enter_expanding_text()?;
            }
            "command_substitution" => {
                let is_backquoted = current
                    .child(0)
                    .is_some_and(|open| matches!(open.kind(), "`" | "$`"));
                // Backquotes undo a backslash before `` ` ``, `$` and `\`, which the parser does
                // not, so the place inside cannot be shown.
                if is_backquoted && node_text(current, self.text).contains('\\') {
                    return Err(FillRefusal::Backquoted);
                }
                self.decide(FillPlace::Bare);
                self.is_in_backquotes = is_backquoted;
            }
            "process_substitution" => {
                self.decide(FillPlace::Bare);
                self.is_in_backquotes = false;
            }
            "expansion" => self.pass_expansion(current, child)?,
            "arithmetic_expansion" | "subscript" => return Err(FillRefusal::Arithmetic),
            "compound_statement" if current.child(0).is_some_and(|open| open.kind() == "((") => {
                return Err(FillRefusal::Arithmetic);
            }
            "c_style_for_statement"
                if child.map(|child| child.id())
                    != current.child_by_field_name("body").map(|body| body.id()) =>
            {
                return Err(FillRefusal::Arithmetic);
            }
            "binary_expression" | "unary_expression" => {
                if let Some(operator) = current.child_by_field_name("operator")
                    && ARITHMETIC_TEST_OPERATORS.contains(&node_text(operator, self.text))
                {
                    self.test_operator = Some(node_text(operator, self.text));
                }
            }
            "test_command" => {
                let opens_double = current.child(0).is_some_and(|open| open.kind() == "[[");
                match self.test_operator.take() {
                    Some("-v") => return Err(FillRefusal::NameWord),
                    Some(_) if opens_double => return Err(FillRefusal::Arithmetic),
                    Some(_) | None => {}
                }
            }
            "unset_command" => return Err(FillRefusal::NameWord),
            "declaration_command" => {
                if let Some(child) = child {
                    self.pass_declaration(current, child, below)?;
                }
            }
            "command" => {
                if let Some(child) = child {
                    self.pass_command(current, child)?;
                }
            }
            _ => {}
        }
        Ok(())
    }

    /// The fill is in an expanding string or body: its place, unless a nearer quoting decided one,
    /// and a refusal for backquotes inside it.
    fn enter_expanding_text(&mut self) -> Result<(), FillRefusal> {
        if std::mem::take(&mut self.is_in_backquotes) {
            return Err(FillRefusal::Backquoted);
        }
        self.decide(FillPlace::InString);
        Ok(())
    }

    /// Keeps the nearest decision: a place is set only once.
    fn decide(&mut self, place: FillPlace) {
        self.place.get_or_insert(place);
    }

    /// A fill in a `${…}`: bash 5.3's command forms refuse it; an offset or a length is arithmetic;
    /// a pattern word is a context of its own, taking the bare form; a default's word lets the
    /// quoting around the expansion decide.
    fn pass_expansion(
        &mut self,
        expansion: Node<'s>,
        child: Option<Node<'s>>,
    ) -> Result<(), FillRefusal> {
        let runs_a_command = node_text(expansion, self.text)
            .strip_prefix("${")
            .is_some_and(|body| {
                body.starts_with(|character: char| character.is_whitespace() || character == '|')
            });
        if runs_a_command {
            return Err(FillRefusal::CommandInExpansion);
        }
        let Some(child) = child else {
            return Err(FillRefusal::UnreadPlace);
        };
        match operator_before(expansion, child, self.text) {
            Some(":") => Err(FillRefusal::Arithmetic),
            Some(operator) if PATTERN_OPERATORS.contains(&operator) => {
                self.decide(FillPlace::Bare);
                Ok(())
            }
            Some(_) => Ok(()),
            None => Err(FillRefusal::UnreadPlace),
        }
    }

    /// A fill in a declaration: under `-i` any word is arithmetic; a name before `=` is a name
    /// word, and so is a value under `-n` or a quoted `(…)` value under `-a` or `-A`.
    fn pass_declaration(
        &self,
        declaration: Node<'s>,
        child: Node<'s>,
        below: Option<Node<'s>>,
    ) -> Result<(), FillRefusal> {
        let keyword = declaration
            .child(0)
            .map_or("", |keyword| node_text(keyword, self.text));
        let mut flags = String::new();
        let mut cursor = declaration.walk();
        for word in declaration.children(&mut cursor) {
            let word_text = node_text(word, self.text);
            if word.kind() == "word"
                && let Some(letters) = word_text.strip_prefix('-')
            {
                flags.push_str(letters);
            }
        }
        if flags.contains('i') && matches!(keyword, "declare" | "typeset" | "local") {
            return Err(FillRefusal::Arithmetic);
        }
        let names_a_variable = flags.contains('n');
        let holds_an_array = flags.contains(['a', 'A']);
        let child_text = node_text(child, self.text);
        let is_name_word = if child.kind() == "variable_assignment" {
            let is_name = below.map(|below| below.id())
                == child.child_by_field_name("name").map(|name| name.id());
            let value = child.child_by_field_name("value");
            is_name
                || names_a_variable
                || (holds_an_array
                    && value.is_some_and(|value| {
                        matches!(value.kind(), "string" | "raw_string")
                            && node_text(value, self.text).contains('(')
                    }))
        } else if child_text.starts_with(['-', '+']) {
            true
        } else {
            let offset = self.placeholder.start - child.start_byte();
            match child_text.find('=') {
                Some(equals) if equals < offset => {
                    names_a_variable || (holds_an_array && child_text[equals..].contains('('))
                }
                Some(_) | None => true,
            }
        };
        if is_name_word {
            Err(FillRefusal::NameWord)
        } else {
            Ok(())
        }
    }

    /// A fill in a simple command's argument: any of `let`'s is arithmetic, and a name word of a
    /// builtin that reads one refuses it. A fill in the command's name is a named residual.
    fn pass_command(&self, command: Node<'s>, child: Node<'s>) -> Result<(), FillRefusal> {
        let Some(name) = command.child_by_field_name("name") else {
            return Ok(());
        };
        let mut cursor = command.walk();
        let arguments: Vec<Node<'s>> = command
            .children_by_field_name("argument", &mut cursor)
            .collect();
        let Some(index) = arguments
            .iter()
            .position(|argument| argument.id() == child.id())
        else {
            return Ok(());
        };
        let program = node_text(name, self.text);
        if program == "let" {
            return Err(FillRefusal::Arithmetic);
        }
        let Some(builtin) = NAME_WORD_BUILTINS
            .iter()
            .find(|builtin| builtin.names.contains(&program))
        else {
            return Ok(());
        };
        let words: Vec<&str> = arguments
            .iter()
            .map(|argument| node_text(*argument, self.text))
            .collect();
        if is_name_word(builtin, &words, index) {
            Err(FillRefusal::NameWord)
        } else {
            Ok(())
        }
    }
}

/// The `heredoc_start` of the redirect `body` belongs to.
fn heredoc_start_of(body: Node<'_>) -> Option<Node<'_>> {
    let redirect = body.parent()?;
    let mut cursor = redirect.walk();
    redirect
        .children(&mut cursor)
        .find(|child| child.kind() == "heredoc_start")
}

/// The text of the last operator of `expansion` before `child`: the one that says what `child`
/// is, or `None` when none comes before it.
fn operator_before<'s>(expansion: Node<'_>, child: Node<'_>, text: &'s str) -> Option<&'s str> {
    let mut cursor = expansion.walk();
    let mut operator = None;
    if !cursor.goto_first_child() {
        return None;
    }
    loop {
        let node = cursor.node();
        if node.id() == child.id() {
            return operator;
        }
        if cursor.field_name() == Some("operator") {
            operator = Some(node_text(node, text));
        }
        if !cursor.goto_next_sibling() {
            return operator;
        }
    }
}

/// Whether word `index` of a builtin's argument `words` is a name: an option's value the builtin
/// reads as a name, a cluster's rest after such an option, or an operand it reads as one.
fn is_name_word(builtin: &NameWordBuiltin, words: &[&str], index: usize) -> bool {
    let mut awaited_value = None;
    let mut are_options_over = false;
    let mut operand = 0;
    for (position, word) in words.iter().enumerate() {
        let is_target = position == index;
        if let Some(option) = awaited_value.take() {
            if is_target {
                return builtin.name_options.contains(option);
            }
            continue;
        }
        if !are_options_over && *word == "--" {
            if is_target {
                return false;
            }
            are_options_over = true;
            continue;
        }
        if !are_options_over && word.len() > 1 && word.starts_with('-') {
            for (at, letter) in word.char_indices().skip(1) {
                if builtin.value_options.contains(letter) {
                    if word.len() == at + letter.len_utf8() {
                        awaited_value = Some(letter);
                    } else if is_target {
                        return builtin.name_options.contains(letter);
                    }
                    break;
                }
            }
            if is_target {
                return false;
            }
            continue;
        }
        if !builtin.reads_options_past_operands {
            are_options_over = true;
        }
        if is_target {
            return match builtin.operand_names {
                OperandNames::None => false,
                OperandNames::All => true,
                OperandNames::At(name_index) => operand == name_index,
            };
        }
        operand += 1;
    }
    false
}
