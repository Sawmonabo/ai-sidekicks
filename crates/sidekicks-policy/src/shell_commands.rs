//! Reads a shell line into the simple commands it runs, each as its program and the words after
//! it, past the programs that run the command after their own options, such as `env -i`,
//! `sudo -u` or `timeout 5`, for the daemon's own answers to a command ask and for the subject a
//! rule on one names; and takes the line a shell is handed off a provider's `<shell> -lc '…'`
//! wrapper. A reading also keeps what the line does beside its commands: whether a redirect writes
//! a file and whether it can set a shell variable; and of each command, whether a folder named its
//! program. The parser reads the line the way a POSIX shell would and keeps what it read before a
//! syntax error; nothing here guesses at what it could not read. A reading owns its line once and
//! holds its words as pieces of it, so its memory and each query's time grow with the line alone.

pub mod reading_bound;
mod words;
mod wrappers;

use std::borrow::Cow;
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

use tree_sitter::{Node, Parser};

use self::words::{
    BytePositions, JoinedWords, Piece, PieceTexts, ShellText, Word, WordBuilder, node_text, offset,
};
pub use self::words::{PositionedByte, ShellWord, WordText, is_option};
use self::wrappers::{command_wrapper, take_wrapper_words};

/// The simple commands of one line, nested ones included, in the order they appear, outer ones
/// before those nested in them; `is_whole` is false when the parser could not read some of the
/// line, or the line was past the reader's bound, and what it could not read is not among them.
pub struct ShellLineReading {
    line: Arc<str>,
    decoded: Box<str>,
    positions: BytePositions,
    pieces: Box<[Piece]>,
    // Each command's wrappers, program and arguments, in that order.
    words: Box<[Word]>,
    commands: Box<[CommandEntry]>,
    effects: LineEffects,
    is_whole: bool,
}

// What a line does beside the commands it runs, which its command list does not show.
#[derive(Clone, Copy, Default)]
struct LineEffects {
    has_file_writing_redirect: bool,
    can_set_variable: bool,
}

// A command's words in the reading, by index: wrappers from `first` to `program`, then the
// program, then its arguments up to `end`; and whether a folder named the program or a wrapper.
#[derive(Clone, Copy)]
struct CommandEntry {
    first: u32,
    program: u32,
    end: u32,
    is_named_by_path: bool,
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

    /// Whether a redirect anywhere in the line read writes a file: `>`, `>>`, `>|`, `&>`, `&>>` or
    /// `>&` to a name. A descriptor duplication such as `2>&1`, a read, and `/dev/null` as the
    /// shell passes the name write none; `/dev/stdout` and `/dev/stderr` reopen the file behind
    /// their descriptor, so a write to either counts.
    pub(crate) fn has_file_writing_redirect(&self) -> bool {
        self.effects.has_file_writing_redirect
    }

    /// Whether the line read can set a shell variable or run text as code: an assignment, alone,
    /// before a command or in a declaration, a loop's variable, a `${…}` expansion that is not a
    /// plain read, an array subscript, zsh's `$name[…]` or `$#name[…]`, a `{name}` or `{name[…]}`
    /// word, which names a redirect's descriptor, a `[[ … ]]` test that compares numbers or asks
    /// `-v`, or any other arithmetic.
    pub(crate) fn can_set_variable(&self) -> bool {
        self.effects.can_set_variable
    }

    fn unread() -> Self {
        Self {
            line: Arc::from(""),
            decoded: Box::default(),
            positions: BytePositions::default(),
            pieces: Box::default(),
            words: Box::default(),
            commands: Box::default(),
            effects: LineEffects::default(),
            is_whole: false,
        }
    }

    fn parse(parser: &mut Parser, line: Arc<str>) -> Self {
        let tree = parser
            .parse(&*line, None)
            .expect("a parser with its language set and no cancellation always returns a tree");
        let root = tree.root_node();
        let is_whole = !root.has_error();
        let mut builder = WordBuilder::new(&line);
        let (words, commands, effects) = commands_in(root, &mut builder);
        // The tree goes before the arrays shrink to their length, so the two never meet.
        drop(tree);
        let (decoded, pieces, positions) = builder.finish();
        Self {
            line,
            decoded,
            positions,
            pieces,
            words: words.into_boxed_slice(),
            commands: commands.into_boxed_slice(),
            effects,
            is_whole,
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
/// `sudo` or `env`, outermost first.
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

    /// The words after the program.
    pub fn argument_words(self) -> impl ExactSizeIterator<Item = ShellWord<'r>> {
        (self.entry.program + 1..self.entry.end).map(move |index| self.reading.word(index))
    }

    /// The programs that ran this command after their own options, outermost first.
    pub fn wrappers(self) -> impl ExactSizeIterator<Item = ShellWord<'r>> {
        (self.entry.first..self.entry.program).map(move |index| self.reading.word(index))
    }

    /// Whether the program is a wrapper's name, as it is when the wrapper's options only describe
    /// the command after it, as `command -v` does, or leave no command after them, as `sudo -s`
    /// does, which runs a shell.
    pub fn is_program_a_wrapper(self) -> bool {
        command_wrapper(self.program()).is_some()
    }

    /// Whether the program, or a wrapper it ran through, was named with a folder, as `./cat` or
    /// `/usr/bin/env` name one, so it need not be the system program its name is.
    pub(crate) fn is_named_by_path(self) -> bool {
        self.entry.is_named_by_path
    }

    // The words this command hands a shell as its line: an `eval`'s words, or the string a shell
    // runs with `-c`.
    fn command_string(self) -> Option<JoinedWords<'r>> {
        let reading = self.reading;
        let arguments = &reading.words[self.entry.program as usize + 1..self.entry.end as usize];
        let words = match command_string_words(self.program(), self.argument_words())? {
            CommandStringWords::Every => arguments,
            CommandStringWords::One(index) => &arguments[index..=index],
        };
        Some(JoinedWords::new(reading.texts(), &reading.pieces, words))
    }
}

/// Reads the shell lines of one ask: its line and every `-c` or `eval` string a check rereads from
/// it. A string longer than `limit` bytes, a bound no argument a program starts with reaches, is
/// not parsed; in all the reader parses at most twice `limit`, each distinct string once, and
/// hands a repeat its kept reading, so a string past what is left reads not whole with no command.
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

    /// Reads the line `command` hands a shell, an `eval`'s words joined by spaces or the string a
    /// shell runs with `-c`, as `read` reads a line; `None` when the command hands a shell none.
    pub fn read_command_string(
        &mut self,
        command: ShellCommand<'_>,
    ) -> Option<Arc<ShellLineReading>> {
        command.command_string().map(|text| self.read_text(text))
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

/// The command line `line` runs when it is a provider's argv joined by `shlex`, one `sh`, `bash`,
/// `zsh` or `eval` handing a shell its whole line, as a provider wraps a command in
/// `/bin/zsh -lc '…'`; any other line, one with an operator outside the quotes among them, is
/// returned as it is. No tree is built for the outer line, so no cap applies to it.
pub fn unwrap_shell_command_line(line: &str) -> Cow<'_, str> {
    let Some(words) = shlex::split(line) else {
        return Cow::Borrowed(line);
    };
    // Only a line `shlex` gives back exactly is one argv, so no operator in it is cut at.
    if shlex::try_join(words.iter().map(String::as_str))
        .ok()
        .as_deref()
        != Some(line)
    {
        return Cow::Borrowed(line);
    }
    let Some((first, rest)) = words.split_first() else {
        return Cow::Borrowed(line);
    };
    let program = first
        .rsplit_once('/')
        .map_or(first.as_str(), |(_, name)| name);
    match command_string_words(program, rest.iter().map(String::as_str)) {
        Some(CommandStringWords::Every) => Cow::Owned(rest.join(" ")),
        Some(CommandStringWords::One(index)) => Cow::Owned(rest[index].clone()),
        None => Cow::Borrowed(line),
    }
}

// Shells whose `-c`, alone or in a cluster such as `-lc`, runs the first word after the options as
// a command line, and the options of theirs that take the next word as their value.
const COMMAND_STRING_SHELLS: &[&str] = &["sh", "bash", "zsh"];
const SHELL_OPTIONS_WITH_VALUE: &[&str] = &["-o", "+o", "-O", "+O", "--rcfile", "--init-file"];

// Which of a command's argument words make the line it hands a shell.
enum CommandStringWords {
    // An `eval`'s words, joined by spaces.
    Every,
    // A shell's `-c` string, at this index.
    One(usize),
}

fn command_string_words<W: WordText>(
    program: W,
    argument_words: impl Iterator<Item = W>,
) -> Option<CommandStringWords> {
    if program.is("eval") {
        return Some(CommandStringWords::Every);
    }
    if COMMAND_STRING_SHELLS.iter().any(|shell| program.is(shell)) {
        return shell_command_string_index(argument_words).map(CommandStringWords::One);
    }
    None
}

// The command line a shell runs: with `-c` among its short options, the first word after the
// options; the words after it are the line's own `$0` and arguments.
fn shell_command_string_index<W: WordText>(
    argument_words: impl Iterator<Item = W>,
) -> Option<usize> {
    let mut reads_command_string = false;
    let mut words = argument_words.enumerate();
    while let Some((index, word)) = words.next() {
        if word.is("--") || word.is("-") {
            return words
                .next()
                .filter(|_| reads_command_string)
                .map(|(index, _)| index);
        }
        if SHELL_OPTIONS_WITH_VALUE
            .iter()
            .any(|option| word.is(option))
        {
            words.next();
        } else if is_shell_option(word) {
            reads_command_string |= !word.starts_with("--")
                && word.starts_with("-")
                && word.contains(PositionedByte::LetterC);
        } else {
            return reads_command_string.then_some(index);
        }
    }
    None
}

// A `-` or `+` followed by any character but a line break, as a shell option is spelled.
fn is_shell_option(word: impl WordText) -> bool {
    let mut characters = word.chars();
    matches!(characters.next(), Some('-' | '+'))
        && characters
            .next()
            .is_some_and(|character| !matches!(character, '\n' | '\r' | '\u{2028}' | '\u{2029}'))
}

// Every simple command in the tree, nested ones included: those in a pipeline, a chain, a subshell
// or a loop, those a substitution runs, inside double quotes, an assignment or a here-document
// too, and those the parser read before a syntax error; and what the line does beside them. The
// cursor keeps its own stack, so no nesting depth reaches this thread's.
fn commands_in(
    root: Node<'_>,
    builder: &mut WordBuilder<'_>,
) -> (Vec<Word>, Vec<CommandEntry>, LineEffects) {
    let mut words = Vec::new();
    let mut commands = Vec::new();
    let mut effects = LineEffects::default();
    let mut pending = VecDeque::new();
    let mut cursor = root.walk();
    loop {
        note_line_effects(cursor.node(), builder, &mut effects);
        if push_command_words(cursor.node(), builder, &mut pending)
            && let Some(command) = resolve_command(builder, &mut pending, &mut words)
        {
            commands.push(command);
        }
        if cursor.goto_first_child() {
            continue;
        }
        while !cursor.goto_next_sibling() {
            if !cursor.goto_parent() {
                return (words, commands, effects);
            }
        }
    }
}

// Notes what `node` does beside running a command: a redirect that writes a file, or a node that
// can set a variable or run text as code. Arithmetic counts whole, since telling its assignments
// from its reads gains nothing a reading program needs. The shell evaluates as arithmetic, running
// any `$(…)` in it even when quoted: an array subscript, zsh's `$name[…]` in a word, a string or a
// here-document, the operands of a `[[ … ]]` number comparison or `-v`, and a `${…}` offset or
// length. A `${…}` expansion beyond a plain read can also assign, read the variable a value names
// or run a value as a prompt, and a `{name}` word before a redirect assigns a descriptor to `name`.
fn note_line_effects(node: Node<'_>, builder: &mut WordBuilder<'_>, effects: &mut LineEffects) {
    let line = builder.line();
    match node.kind() {
        "file_redirect" => effects.has_file_writing_redirect |= redirect_writes_file(node, builder),
        "variable_assignment"
        | "for_statement"
        | "c_style_for_statement"
        | "arithmetic_expansion"
        | "subscript" => {
            effects.can_set_variable = true;
        }
        // `(( … ))`, an arithmetic command.
        "compound_statement" if node.child(0).is_some_and(|open| open.kind() == "((") => {
            effects.can_set_variable = true;
        }
        "test_command" if node.child(0).is_some_and(|open| open.kind() == "[[") => {
            effects.can_set_variable |= is_arithmetic_test(node, line);
        }
        "expansion" => effects.can_set_variable |= !is_reading_expansion(node, line),
        // zsh reads `[…]` right after `$name` as its subscript, and `$#name[…]` as the length of
        // a subscripted name, which the parser reads as `$#` and then a separate name.
        "simple_expansion" => {
            let is_length = node_text(node, line) == "$#";
            effects.can_set_variable |= node.next_sibling().is_some_and(|next| {
                next.start_byte() == node.end_byte()
                    && (node_text(next, line).starts_with('[') || (is_length && next.is_named()))
            });
        }
        "concatenation" | "word" => effects.can_set_variable |= is_descriptor_name(node, line),
        _ => {}
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
// number, or one to a standard device alone.
fn redirect_writes_file(redirect: Node<'_>, builder: &mut WordBuilder<'_>) -> bool {
    let line = builder.line();
    let mut operator = "";
    let mut destination = None;
    let mut destination_count = 0_usize;
    let mut cursor = redirect.walk();
    if cursor.goto_first_child() {
        loop {
            let child = cursor.node();
            match cursor.field_name() {
                Some("destination") => {
                    destination_count += 1;
                    destination = Some(child);
                }
                None if !child.is_named() => operator = node_text(child, line),
                Some(_) | None => {}
            }
            if !cursor.goto_next_sibling() {
                break;
            }
        }
    }
    let destination = destination.filter(|_| destination_count == 1);
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

// Whether a `${…}` expansion only reads its variable: its operators listed, each `:` offset or
// length digits alone, its other parts listed, and no `$`, backquote or `(` in a pattern or word
// token, which holds an expansion or a process substitution the tree does not show.
fn is_reading_expansion(expansion: Node<'_>, line: &str) -> bool {
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

// Puts the words of a node that runs a command, its program first, in `pending`; false for any
// other node.
fn push_command_words(
    node: Node<'_>,
    builder: &mut WordBuilder<'_>,
    pending: &mut VecDeque<Word>,
) -> bool {
    match node.kind() {
        "command" => push_simple_command_words(node, builder, pending),
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
fn push_simple_command_words(
    command: Node<'_>,
    builder: &mut WordBuilder<'_>,
    pending: &mut VecDeque<Word>,
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
                Some(_) | None => {}
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
            if !takes_other_option {
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

// The command `pending` runs, its words moved to `words`: the program is the first word that is
// neither an assignment nor a wrapper that runs the command after its own options and operands;
// a wrapper that only describes the command, or whose own words leave none after them, is the
// program; a command of assignments alone runs none.
fn resolve_command(
    builder: &mut WordBuilder<'_>,
    pending: &mut VecDeque<Word>,
    words: &mut Vec<Word>,
) -> Option<CommandEntry> {
    let first_word = words.len();
    let piece_mark = builder.piece_count();
    let mut is_named_by_path = false;
    loop {
        while pending
            .front()
            .is_some_and(|&word| is_variable_assignment(builder.view(word)))
        {
            pending.pop_front();
        }
        let Some(name) = pending.pop_front() else {
            // A wrapper whose own words use up the command is its program, as `sudo -s` is.
            if words.len() > first_word {
                return Some(CommandEntry {
                    first: offset(first_word),
                    program: offset(words.len() - 1),
                    end: offset(words.len()),
                    is_named_by_path,
                });
            }
            builder.truncate(piece_mark);
            return None;
        };
        let without_folder = builder.basename(name);
        is_named_by_path |= without_folder.is_some();
        let program = without_folder.unwrap_or(name);
        let wrapper = command_wrapper(builder.view(program))
            .filter(|wrapper| !wrapper.only_describes(builder, pending));
        words.push(program);
        let Some(wrapper) = wrapper else {
            let program = offset(words.len() - 1);
            words.extend(pending.drain(..));
            return Some(CommandEntry {
                first: offset(first_word),
                program,
                end: offset(words.len()),
                is_named_by_path,
            });
        };
        take_wrapper_words(builder, wrapper, pending);
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
