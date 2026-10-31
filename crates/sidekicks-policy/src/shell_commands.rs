//! Reads a shell line into the simple commands it runs, each as its program and the words after
//! it, past the programs that run the command after their own options, such as `env -i`,
//! `sudo -u` or `timeout 5`, for the daemon's own answers to a command ask and for the subject a
//! rule on one names; and takes the line a shell is handed off a provider's `<shell> -lc '…'`
//! wrapper. A reading also keeps whether every form of the line is one a line that only reads may
//! hold, and of each command, whether a folder named its program. The parser reads the line the
//! way a POSIX shell would and keeps what it read before a syntax error; nothing here guesses at
//! what it could not read. A reading owns its line once and holds its words as pieces of it, so its
//! memory and each query's time grow with the line alone.

mod command_string;
mod listed_programs;
pub mod reading_bound;
mod reading_forms;
mod unread_words;
mod words;
mod wrappers;

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

use tree_sitter::{Node, Parser};

use self::command_string::{
    CommandStringWords, command_string_words, reads_its_line_from_input, runs_its_words_as_a_line,
};
pub use self::command_string::{PROVIDER_LINE_SHELLS, unwrap_shell_command_line};
pub use self::listed_programs::StandingRule;
use self::listed_programs::{FIND_COMMAND_PRIMARIES, command_wrapper, standing_rule_of};
use self::reading_forms::ReadingForms;
use self::words::{
    BytePositions, JoinedWords, Piece, PieceTexts, ShellText, Word, WordBuilder, node_text, offset,
};
pub use self::words::{PositionedByte, ShellWord, WordText, is_option};
use self::wrappers::{WrapperRead, take_wrapper_words};

/// The simple commands of one line, nested ones included, in the order they appear, outer ones
/// before those nested in them; `is_whole` is false when the parser could not read some of the
/// line, the line was past the reader's bound, or an `env -S` split was past the bound on what
/// the splits read, and what was not read is not among them.
pub struct ShellLineReading {
    line: Arc<str>,
    decoded: Box<str>,
    positions: BytePositions,
    pieces: Box<[Piece]>,
    // Each command's wrapper words, program and arguments, in that order.
    words: Box<[Word]>,
    commands: Box<[CommandEntry]>,
    assignments: Box<[Word]>,
    holds_only_reading_forms: bool,
    requoted_line: Option<Box<str>>,
    is_whole: bool,
}

// A command's words in the reading, by index: each wrapper's name and its own words from `first`
// to `program`, then the program, then its arguments up to `end`; the program's word as the text
// writes it, its folder included; the word of the line it reads from its input on its own
// statement, a here-document's body or a here-string; whether a folder named the program or a
// wrapper; whether the text leaves the program's name to the run; and whether assignments come
// before it.
#[derive(Clone, Copy)]
struct CommandEntry {
    first: u32,
    program: u32,
    end: u32,
    written_program: u32,
    input_line: Option<u32>,
    is_named_by_path: bool,
    is_program_undecided: bool,
    has_leading_assignments: bool,
}

impl ShellLineReading {
    /// The commands read.
    pub fn commands(&self) -> impl ExactSizeIterator<Item = ShellCommand<'_>> {
        self.commands.iter().map(|&entry| ShellCommand {
            reading: self,
            entry,
        })
    }

    /// Whether the parser read every part of the line.
    pub fn is_whole(&self) -> bool {
        self.is_whole
    }

    /// Every assignment the line makes as its own word, `NAME=value`: before a command, alone, or
    /// in a declaration such as `export`, but not one a wrapper such as env takes as its word.
    pub fn assignment_words(&self) -> impl ExactSizeIterator<Item = ShellWord<'_>> {
        self.assignments
            .iter()
            .map(|&word| ShellWord::new(self.texts(), &self.pieces, word))
    }

    /// Whether every form of the line read is one a line that only reads may hold: no redirect
    /// writes a file (`/dev/null` and a duplication onto a descriptor number write none), every
    /// redirect has a command, nothing sets a variable or evaluates arithmetic, and every
    /// substitution, expansion and here-document is one whose commands the reading holds.
    pub(crate) fn holds_only_reading_forms(&self) -> bool {
        self.holds_only_reading_forms
    }

    /// The line with every here-document start the parser misreads put in single quotes, which
    /// the shell reads the same way, so the line's forms are judged on that line's reading; `None`
    /// when no start needs it.
    pub(crate) fn requoted_line(&self) -> Option<&str> {
        self.requoted_line.as_deref()
    }

    fn unread() -> Self {
        Self {
            line: Arc::from(""),
            decoded: Box::default(),
            positions: BytePositions::default(),
            pieces: Box::default(),
            words: Box::default(),
            commands: Box::default(),
            assignments: Box::default(),
            holds_only_reading_forms: false,
            requoted_line: None,
            is_whole: false,
        }
    }

    fn parse(parser: &mut Parser, line: Arc<str>) -> Self {
        let tree = parser
            .parse(&*line, None)
            .expect("a parser with its language set and no cancellation always returns a tree");
        let root = tree.root_node();
        let has_error = root.has_error();
        let mut builder = WordBuilder::new(&line);
        let (words, commands, assignments, forms) = commands_in(root, &mut builder);
        // The tree goes before the arrays shrink to their length, so the two never meet.
        drop(tree);
        let (decoded, pieces, positions, is_split_past_bound) = builder.finish();
        let requoted_line = forms.requote_delimiters(&line);
        Self {
            line,
            decoded,
            positions,
            pieces,
            words: words.into_boxed_slice(),
            commands: commands.into_boxed_slice(),
            assignments: assignments.into_boxed_slice(),
            holds_only_reading_forms: forms.is_reading(),
            requoted_line,
            is_whole: !has_error && !is_split_past_bound,
        }
    }

    fn texts(&self) -> PieceTexts<'_> {
        PieceTexts::new(&self.line, &self.decoded, &self.positions)
    }

    fn word(&self, index: u32) -> ShellWord<'_> {
        ShellWord::new(self.texts(), &self.pieces, self.words[index as usize])
    }
}

/// One simple command of a reading: its program's own name, with any folder taken off, the words
/// after it, dequoted as the shell would pass them, and the programs it was run through, such as
/// `sudo` or `env`, outermost first, each with its own words.
#[derive(Clone, Copy)]
pub struct ShellCommand<'r> {
    reading: &'r ShellLineReading,
    entry: CommandEntry,
}

impl<'r> ShellCommand<'r> {
    /// The program's name, without its folder.
    pub fn program(self) -> ShellWord<'r> {
        self.reading.word(self.entry.program)
    }

    /// The program as the text writes it, its folder included, as `./cargo` is.
    pub fn written_program(self) -> ShellWord<'r> {
        self.reading.word(self.entry.written_program)
    }

    /// Whether the text leaves the program's name to the run: its word holds an expansion, a
    /// substitution or a pattern, or its folder a `$` expansion outside double quotes that the
    /// shell can split into another program and its words.
    pub fn is_program_undecided(self) -> bool {
        self.entry.is_program_undecided
    }

    /// Whether the shell's own assignments come before the command, as in `PAGER=less git log`.
    pub fn has_leading_assignments(self) -> bool {
        self.entry.has_leading_assignments
    }

    /// What a standing rule on this command may name, as the list's entry for its program gives
    /// it; a program off the list takes its name and its first subcommand word.
    pub fn standing_rule(self) -> StandingRule {
        standing_rule_of(self.program(), self.argument_words())
    }

    /// The words after the program.
    pub fn argument_words(self) -> impl ExactSizeIterator<Item = ShellWord<'r>> + Clone {
        (self.entry.program + 1..self.entry.end).map(move |index| self.reading.word(index))
    }

    /// The words before the program: each program that ran this command after its own options,
    /// outermost first, followed by the options, values, operands and assignments it took.
    pub fn wrapper_words(self) -> impl ExactSizeIterator<Item = ShellWord<'r>> {
        (self.entry.first..self.entry.program).map(move |index| self.reading.word(index))
    }

    /// Whether the program, or a wrapper it ran through, was named with a folder, as `./cat` or
    /// `/usr/bin/env` name one, so it need not be the system program its name is.
    pub(crate) fn is_named_by_path(self) -> bool {
        self.entry.is_named_by_path
    }

    // The words this command hands a shell as each of its lines: an `eval`'s words, the string a
    // shell runs with `-c`, a command `su` hands one, or the line it reads from its input.
    fn command_strings(self) -> impl Iterator<Item = JoinedWords<'r>> {
        let reading = self.reading;
        let arguments = &reading.words[self.entry.program as usize + 1..self.entry.end as usize];
        let input_line = self
            .entry
            .input_line
            .map(|index| (&reading.words[index as usize..=index as usize], 0));
        command_string_words(self.program(), self.argument_words())
            .into_iter()
            .map(move |string| match string {
                CommandStringWords::Joined { from, end } => (&arguments[from..end], 0),
                CommandStringWords::One {
                    index,
                    skipped_bytes,
                } => (&arguments[index..=index], skipped_bytes),
            })
            .chain(input_line)
            .map(move |(words, skipped_bytes)| {
                JoinedWords::new(reading.texts(), &reading.pieces, words, skipped_bytes)
            })
    }
}

/// Reads the shell lines of one ask: its line, at most one reading of it with its here-document
/// starts requoted, and every `-c` or `eval` string a check rereads from it. A string longer than
/// `limit` bytes, a bound no argument a program starts with reaches, is not parsed; in all the
/// reader parses at most twice `limit`, each distinct string once, and hands a repeat its kept
/// reading, so a string past what is left reads not whole with no command.
/// Reading blocks the thread for the parse, so every ask reads through `ShellLineReadingBound`.
pub struct ShellLineReader {
    parser: Parser,
    limit: usize,
    bytes_left: usize,
    // Every reading made, by its line's length; each keeps its own line.
    readings: HashMap<usize, Vec<Arc<ShellLineReading>>>,
    unread: Arc<ShellLineReading>,
}

impl ShellLineReader {
    /// A reader for one ask, with `limit` the byte length past which a string is not read: a
    /// system's argument bound, far below the 4 GiB a reading's offsets count to.
    pub fn new(limit: usize) -> Self {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_bash::LANGUAGE.into())
            .expect("the bash grammar's ABI, fixed at build, is one this tree-sitter reads");
        Self {
            parser,
            limit,
            bytes_left: limit.saturating_mul(2),
            readings: HashMap::new(),
            unread: Arc::new(ShellLineReading::unread()),
        }
    }

    /// Reads `line` into its simple commands, those in a pipeline, a chain, a substitution or a
    /// string a substitution runs included. A line past the limit or past what the reader has left
    /// reads not whole with no command; a line read before reads as it did then, at no cost.
    pub fn read(&mut self, line: &str) -> Arc<ShellLineReading> {
        self.read_text(line)
    }

    /// Reads each line `command` hands a shell, an `eval`'s words joined by spaces, the string a
    /// shell runs with `-c`, a command `su` hands one, or the here-document or here-string a shell
    /// reads as its input on the command's own statement, as `read` reads a line; none when the
    /// command hands a shell none.
    pub fn read_command_strings(
        &mut self,
        command: ShellCommand<'_>,
    ) -> Vec<Arc<ShellLineReading>> {
        command
            .command_strings()
            .map(|text| self.read_text(text))
            .collect()
    }

    /// Reads each line a listed shell or `eval` in `run`, a run of a line's words not read whole,
    /// hands a shell: the shell's `-c` string or its own grammar's line, or `eval`'s words joined
    /// by spaces, as `read` reads a line.
    pub fn read_run_strings(&mut self, run: &[String]) -> Vec<Arc<ShellLineReading>> {
        let mut lines = Vec::new();
        for (index, word) in run.iter().enumerate() {
            let program = word.rsplit('/').next().unwrap_or(word);
            if !runs_its_words_as_a_line(program) {
                continue;
            }
            let arguments = &run[index + 1..];
            for string in command_string_words(program, arguments.iter().map(String::as_str)) {
                let line = match string {
                    CommandStringWords::Joined { from, end } => arguments[from..end].join(" "),
                    CommandStringWords::One {
                        index,
                        skipped_bytes,
                    } => arguments[index][skipped_bytes..].to_owned(),
                };
                lines.push(self.read_text(line.as_str()));
            }
        }
        lines
    }

    // The length is read first, so a repeat or a string past what is left builds nothing.
    fn read_text(&mut self, text: impl ShellText) -> Arc<ShellLineReading> {
        let length = text.len();
        let kept = self
            .readings
            .get(&length)
            .and_then(|readings| readings.iter().find(|reading| text.is(&reading.line)));
        if let Some(reading) = kept {
            return Arc::clone(reading);
        }
        if length > self.limit || length > self.bytes_left {
            return Arc::clone(&self.unread);
        }
        self.bytes_left -= length;
        let reading = Arc::new(ShellLineReading::parse(&mut self.parser, text.to_line()));
        self.readings
            .entry(length)
            .or_default()
            .push(Arc::clone(&reading));
        reading
    }
}

// Every simple command in the tree, nested ones included: those in a pipeline, a chain, a subshell
// or a loop, those a substitution runs, inside double quotes, an assignment or a here-document
// too, those a `find` runs, and those the parser read before a syntax error; every assignment the
// tree holds; and whether every form of the line is one a reading line may hold, as the forms
// noted. A here-document body the shell passes as text is not read. The cursor keeps its own
// stack, so no nesting depth reaches this thread's.
fn commands_in(
    root: Node<'_>,
    builder: &mut WordBuilder<'_>,
) -> (Vec<Word>, Vec<CommandEntry>, Vec<Word>, ReadingForms) {
    let mut words = Vec::new();
    let mut commands = Vec::new();
    let mut assignments = Vec::new();
    let mut forms = ReadingForms::new();
    let mut pending = VecDeque::new();
    let mut read_body = None;
    let mut previous_sibling = None;
    let mut cursor = root.walk();
    loop {
        let node = cursor.node();
        let reads_inside = forms.note(node, previous_sibling, builder);
        if node.kind() == "variable_assignment" {
            assignments.push(builder.push_assignment(node));
        }
        let mut statement = StatementFacts::default();
        if push_command_words(node, builder, &mut pending, &mut read_body, &mut statement)
            && let Some((mut command, reads_its_input)) =
                resolve_command(builder, &mut pending, &mut words)
        {
            command.has_leading_assignments = statement.has_leading_assignments;
            if reads_its_input && let Some(input) = statement.input {
                command.input_line = Some(offset(words.len()));
                words.push(input.push_word(builder));
            }
            push_find_commands(builder, &mut words, command, &mut commands);
        }
        if reads_inside && cursor.goto_first_child() {
            previous_sibling = None;
            continue;
        }
        loop {
            let left = cursor.node();
            if cursor.goto_next_sibling() {
                previous_sibling = Some(left);
                break;
            }
            if !cursor.goto_parent() {
                return (words, commands, assignments, forms);
            }
        }
    }
}

// Calls `visit` on each word a redirect's grammar takes past its own: a file redirect's
// destinations after the first, a close's word, and a here-document's words after its start with
// those of the redirects it holds. A redirect takes one word, so the shell passes each of these
// to the command as an argument.
fn visit_redirect_arguments<'t>(redirect: Node<'t>, visit: &mut impl FnMut(Node<'t>)) {
    let mut cursor = redirect.walk();
    if !cursor.goto_first_child() {
        return;
    }
    let mut destination_count = 0_usize;
    let mut is_close = false;
    loop {
        let child = cursor.node();
        match cursor.field_name() {
            Some("destination") => {
                destination_count += 1;
                if destination_count > 1 || is_close {
                    visit(child);
                }
            }
            Some("argument") => visit(child),
            Some("redirect") => visit_redirect_arguments(child, visit),
            Some(_) | None => is_close |= matches!(child.kind(), "<&-" | ">&-"),
        }
        if !cursor.goto_next_sibling() {
            return;
        }
    }
}

// What a statement gives the command it runs beside its words: the line a redirect of its input
// hands it, and whether the shell's own assignments come before it.
#[derive(Clone, Copy, Default)]
struct StatementFacts<'t> {
    input: Option<InputText<'t>>,
    has_leading_assignments: bool,
}

// The text a redirect hands a command as its input: a here-string's word, or a here-document's
// body.
#[derive(Clone, Copy)]
enum InputText<'t> {
    HereString(Node<'t>),
    HereDocument(Node<'t>),
}

impl InputText<'_> {
    // The input as one word of the reading: a here-string as the shell passes its word, a
    // here-document's body as its text.
    fn push_word(self, builder: &mut WordBuilder<'_>) -> Word {
        match self {
            Self::HereString(word) => builder.push_word(word),
            Self::HereDocument(body) => builder.push_text(body.byte_range()),
        }
    }

    // The input `redirect` hands its command, when it is a here-string or a here-document on the
    // command's input, descriptor 0.
    fn of_redirect<'t>(redirect: Node<'t>, line: &str) -> Option<InputText<'t>> {
        let is_on_input = redirect
            .child_by_field_name("descriptor")
            .is_none_or(|descriptor| node_text(descriptor, line) == "0");
        if !is_on_input {
            return None;
        }
        let mut cursor = redirect.walk();
        let mut children = redirect.named_children(&mut cursor);
        match redirect.kind() {
            "herestring_redirect" => children
                .find(|child| child.kind() != "file_descriptor")
                .map(InputText::HereString),
            "heredoc_redirect" => children
                .find(|child| child.kind() == "heredoc_body")
                .map(InputText::HereDocument),
            _ => None,
        }
    }
}

// Puts the words of a node that runs a command, its program first, in `pending`, and what its
// statement gives it in `statement`; false for any other node. A redirected simple command is read
// at its statement, with the words its redirects' grammar takes past their own as its arguments
// and the last here-string or here-document on its input, and `read_body` keeps it from a second
// read.
fn push_command_words<'t>(
    node: Node<'t>,
    builder: &mut WordBuilder<'_>,
    pending: &mut VecDeque<Word>,
    read_body: &mut Option<usize>,
    statement: &mut StatementFacts<'t>,
) -> bool {
    match node.kind() {
        "redirected_statement" => {
            let Some(command) = node
                .child_by_field_name("body")
                .filter(|body| body.kind() == "command")
            else {
                return false;
            };
            *read_body = Some(command.id());
            push_simple_command_words(command, builder, pending, statement);
            if !pending.is_empty() {
                let mut cursor = node.walk();
                for redirect in node.children_by_field_name("redirect", &mut cursor) {
                    visit_redirect_arguments(redirect, &mut |word| {
                        pending.push_back(builder.push_word(word));
                    });
                }
                let mut cursor = node.walk();
                for redirect in node.named_children(&mut cursor) {
                    if let Some(input) = InputText::of_redirect(redirect, builder.line()) {
                        statement.input = Some(input);
                    }
                }
            }
        }
        "command" if *read_body == Some(node.id()) => return false,
        "command" => push_simple_command_words(node, builder, pending, statement),
        // `export`, `declare`, `unset` and their kin are commands named by their keyword.
        "declaration_command" | "unset_command" => {
            push_keyword_command_words(node, builder, pending);
        }
        // A single-bracket test runs the command `[`; a `[[ … ]]` test runs none.
        "test_command" if node.child(0).is_some_and(|bracket| bracket.kind() == "[") => {
            push_test_command_words(node, builder, pending);
        }
        _ => return false,
    }
    true
}

// A simple command's name and argument words, without its leading assignments and redirects, and
// without a bare `time [-p] [--]` or `coproc` before it, which the shell reads as keywords. A
// `time` followed by any other option is kept as the `time` program: bash in POSIX mode runs that
// program with the option, and its default mode would run the option as a command, which fails.
// A `time` with no command after it is kept too, as the command the line runs. `statement` takes
// whether assignments come before its name and the last here-string on its input.
fn push_simple_command_words<'t>(
    command: Node<'t>,
    builder: &mut WordBuilder<'_>,
    pending: &mut VecDeque<Word>,
    statement: &mut StatementFacts<'t>,
) {
    let mut keyword = None;
    let mut cursor = command.walk();
    if cursor.goto_first_child() {
        let mut is_first_child = true;
        loop {
            let child = cursor.node();
            match cursor.field_name() {
                Some("name") => {
                    let Some(literal) = child.named_child(0).filter(|name| !name.is_missing())
                    else {
                        // A name the parser supplied for a missing token names no program.
                        pending.clear();
                        return;
                    };
                    if is_first_child && literal.kind() == "word" {
                        keyword = Some(node_text(literal, builder.line()));
                    }
                    pending.push_back(builder.push_word(literal));
                }
                Some("argument") => pending.push_back(builder.push_word(child)),
                Some("redirect") => {
                    if let Some(input) = InputText::of_redirect(child, builder.line()) {
                        statement.input = Some(input);
                    }
                }
                Some(_) | None => {
                    statement.has_leading_assignments |=
                        pending.is_empty() && child.kind() == "variable_assignment";
                }
            }
            is_first_child = false;
            if !cursor.goto_next_sibling() {
                break;
            }
        }
    }
    match keyword {
        Some("time") => {
            let mut keyword_words = 1;
            let mut ends_options = false;
            for option in ["-p", "--"] {
                if pending
                    .get(keyword_words)
                    .is_some_and(|&word| builder.view(word).is(option))
                {
                    keyword_words += 1;
                    ends_options = option == "--";
                }
            }
            let takes_other_option = !ends_options
                && pending.get(keyword_words).is_some_and(|&word| {
                    let word = builder.view(word);
                    word.starts_with("-") && !word.is("-")
                });
            if !takes_other_option && pending.len() > keyword_words {
                pending.drain(..keyword_words);
            }
        }
        Some("coproc") => {
            pending.pop_front();
        }
        Some(_) | None => {}
    }
}

// A declaration or `unset` command's keyword and words: its names, never its assignments.
fn push_keyword_command_words(
    command: Node<'_>,
    builder: &mut WordBuilder<'_>,
    pending: &mut VecDeque<Word>,
) {
    let mut cursor = command.walk();
    if !cursor.goto_first_child() {
        return;
    }
    loop {
        let child = cursor.node();
        // The keyword and each name read as their text, a literal as its value.
        match child.kind() {
            "variable_assignment" | "comment" => {}
            _ => pending.push_back(builder.push_word(child)),
        }
        if !cursor.goto_next_sibling() {
            return;
        }
    }
}

// A single-bracket test's words, `[` and `]` included: each literal read as a word and each
// operator as its text, through any nesting of test expressions.
fn push_test_command_words(
    test: Node<'_>,
    builder: &mut WordBuilder<'_>,
    pending: &mut VecDeque<Word>,
) {
    let mut cursor = test.walk();
    if !cursor.goto_first_child() {
        return;
    }
    loop {
        let node = cursor.node();
        let descends = if node.is_missing() || node.kind() == "comment" {
            false
        } else if is_test_word(node) {
            pending.push_back(builder.push_word(node));
            false
        } else {
            true
        };
        if descends && cursor.goto_first_child() {
            continue;
        }
        while !cursor.goto_next_sibling() {
            if !cursor.goto_parent() {
                return;
            }
        }
    }
}

// A node a test reads as one word: a literal, or a token with nothing inside it.
fn is_test_word(node: Node<'_>) -> bool {
    node.child_count() == 0
        || matches!(
            node.kind(),
            "word"
                | "string"
                | "raw_string"
                | "ansi_c_string"
                | "translated_string"
                | "concatenation"
                | "number"
                | "simple_expansion"
                | "expansion"
                | "command_substitution"
                | "process_substitution"
                | "arithmetic_expansion"
                | "brace_expression"
                | "regex"
                | "extglob_pattern"
        )
}

// The command `pending` runs, its words moved to `words`, and whether it reads the line it runs
// from its input: the program is the first word that is neither an assignment nor a wrapper that
// runs the command after its own options and operands, each wrapper's name followed by the words
// it took and the assignments after them; a wrapper whose read of its own words leaves it the
// program, or leaves no command after them, is the program; a command of assignments alone runs
// none.
fn resolve_command(
    builder: &mut WordBuilder<'_>,
    pending: &mut VecDeque<Word>,
    words: &mut Vec<Word>,
) -> Option<(CommandEntry, bool)> {
    let first_word = words.len();
    let piece_mark = builder.piece_count();
    let mut is_named_by_path = false;
    let mut can_folder_split = false;
    let mut last_wrapper = None;
    let mut runs_a_shell_with_no_command = false;
    // A wrapper that reads the statement's input itself, as xargs does, hands the command none.
    let mut is_input_consumed = false;
    loop {
        while let Some(assignment) =
            pending.pop_front_if(|word| is_variable_assignment(builder.view(*word)))
        {
            // One after a wrapper is the wrapper's own, as env reads it; one before is the shell's.
            if last_wrapper.is_some() {
                words.push(assignment);
            }
        }
        let Some(name) = pending.pop_front() else {
            // A wrapper whose own words use up the command is its program, as `sudo -s` is, which
            // runs a shell reading its input.
            let Some((program, written_name)) = last_wrapper else {
                builder.truncate(piece_mark);
                return None;
            };
            words.truncate(program + 1);
            let entry = CommandEntry {
                first: offset(first_word),
                program: offset(program),
                end: offset(program + 1),
                written_program: push_written_name(words, written_name, program),
                input_line: None,
                is_named_by_path,
                is_program_undecided: can_folder_split
                    || !builder.view(words[program]).is_decided(),
                has_leading_assignments: false,
            };
            return Some((entry, runs_a_shell_with_no_command && !is_input_consumed));
        };
        let basename = builder.basename(name);
        is_named_by_path |= basename.is_some();
        can_folder_split = basename.is_some_and(|(_, can_this_folder_split)| can_this_folder_split);
        let written_name = basename.is_some().then_some(name);
        let program = basename.map_or(name, |(without_folder, _)| without_folder);
        let wrapper = command_wrapper(builder.view(program));
        words.push(program);
        let name_index = words.len() - 1;
        let is_program = match wrapper {
            Some(wrapper) => match take_wrapper_words(builder, wrapper, pending, words) {
                WrapperRead::WrapperIsProgram => true,
                WrapperRead::CommandFollows {
                    runs_a_shell_with_no_command: runs_a_shell,
                } => {
                    runs_a_shell_with_no_command = runs_a_shell;
                    false
                }
            },
            None => true,
        };
        if let Some(wrapper) = wrapper {
            is_input_consumed |= wrapper.consumes_its_input;
        }
        if is_program {
            words.truncate(name_index + 1);
            words.extend(pending.drain(..));
            let end = words.len();
            let reads_its_input = !is_input_consumed && {
                let program = builder.view(words[name_index]);
                let argument_words = words[name_index + 1..]
                    .iter()
                    .map(|&word| builder.view(word));
                reads_its_line_from_input(program, argument_words)
            };
            let is_program_undecided =
                can_folder_split || !builder.view(words[name_index]).is_decided();
            let entry = CommandEntry {
                first: offset(first_word),
                program: offset(name_index),
                end: offset(end),
                written_program: push_written_name(words, written_name, name_index),
                input_line: None,
                is_named_by_path,
                is_program_undecided,
                has_leading_assignments: false,
            };
            return Some((entry, reads_its_input));
        }
        last_wrapper = Some((name_index, written_name));
    }
}

// The index of the program's word as the text writes it: `written_name`, the word that named it with
// its folder, pushed past the command's words, or the program's own word at `program`.
fn push_written_name(words: &mut Vec<Word>, written_name: Option<Word>, program: usize) -> u32 {
    match written_name {
        Some(name) => {
            words.push(name);
            offset(words.len() - 1)
        }
        None => offset(program),
    }
}

// Pushes `command` and every command a `find` among them runs: the words after each of its
// `-exec`, `-execdir`, `-ok` and `-okdir` up to a `;`, or a `+` right after `{}`, read as a
// command of its own, each word holding `{}` one only the run decides, since find puts a path
// there.
fn push_find_commands(
    builder: &mut WordBuilder<'_>,
    words: &mut Vec<Word>,
    command: CommandEntry,
    commands: &mut Vec<CommandEntry>,
) {
    let mut unread = vec![command];
    while let Some(command) = unread.pop() {
        commands.push(command);
        let program = command.program as usize;
        if !builder.view(words[program]).is("find") {
            continue;
        }
        let mut segments = Vec::new();
        let mut segment_start = None;
        for index in program + 1..command.end as usize {
            let word = builder.view(words[index]);
            match segment_start {
                None if FIND_COMMAND_PRIMARIES
                    .iter()
                    .any(|primary| word.is(primary)) =>
                {
                    segment_start = Some(index + 1);
                }
                None => {}
                Some(start) => {
                    let ends_after_path =
                        word.is("+") && index > start && builder.view(words[index - 1]).is("{}");
                    if word.is(";") || ends_after_path {
                        segments.push(start..index);
                        segment_start = None;
                    }
                }
            }
        }
        for segment in segments {
            let mut pending: VecDeque<Word> = segment
                .map(|index| {
                    let word = words[index];
                    if builder.view(word).to_string().contains("{}") {
                        builder.push_undecided_copy(word)
                    } else {
                        word
                    }
                })
                .collect();
            if let Some((run, _)) = resolve_command(builder, &mut pending, words) {
                unread.push(run);
            }
        }
    }
}

// `NAME=…`, a name of letters, digits and underscores not starting with a digit: the name's
// characters are read from the start up to the first other one, which must be `=`.
fn is_variable_assignment(word: ShellWord<'_>) -> bool {
    let mut characters = word.chars();
    if !characters.next().is_some_and(starts_variable_name) {
        return false;
    }
    characters.find(|&character| !continues_variable_name(character)) == Some('=')
}

fn starts_variable_name(character: char) -> bool {
    character.is_ascii_alphabetic() || character == '_'
}

fn continues_variable_name(character: char) -> bool {
    character.is_ascii_alphanumeric() || character == '_'
}

#[cfg(test)]
mod tests;
