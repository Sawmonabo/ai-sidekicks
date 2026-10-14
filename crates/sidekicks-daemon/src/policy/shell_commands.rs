//! Reads a shell line into the simple commands it runs, each as its program and the words after
//! it, past the programs that run the command after their own options, such as `env -i`,
//! `sudo -u` or `timeout 5`, for the daemon's own answers to a command ask and for the subject a
//! rule on one names; and takes the line a shell is handed off a provider's `<shell> -lc '…'`
//! wrapper. The parser reads the line the way a POSIX shell would and keeps what it read before a
//! syntax error; nothing here guesses at what it could not read.

mod words;

use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::Arc;

use sidekicks_contracts::wire::text::is_ecmascript_whitespace;
use tree_sitter::{Node, Parser};

use self::words::{node_text, word_value};

/// One simple command: its program's own name, with any folder taken off, the words after it, and
/// the programs it was run through, such as `sudo` or `env`, outermost first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ShellCommand {
    /// The program's name, without its folder.
    pub(crate) program: String,
    /// The words after the program, dequoted as the shell would pass them.
    pub(crate) argument_words: Vec<String>,
    /// The programs that ran this command after their own options, outermost first.
    pub(crate) wrappers: Vec<String>,
}

/// The simple commands of one line, nested ones included, in the order they appear; `is_whole` is
/// false when the parser could not read some of it, or the line was past the reader's bound, and
/// what it could not read is not among the commands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ShellLineReading {
    /// The commands read, outer ones before those nested in them.
    pub(crate) commands: Vec<ShellCommand>,
    /// Whether the parser read every part of the line.
    pub(crate) is_whole: bool,
}

/// Reads the shell lines of one ask: its line and every `-c` or `eval` string a check rereads from
/// it. A line longer than `limit` bytes, a bound no argument a program starts with reaches, is not
/// parsed; in all the reader parses at most twice `limit`, each distinct string once, and hands a
/// repeat its kept reading, so a string past what is left reads not whole with no command.
/// Reading blocks the thread for the parse, so async callers run it through `spawn_blocking`.
pub(crate) struct ShellLineReader {
    parser: Parser,
    limit: usize,
    bytes_left: usize,
    readings: HashMap<String, Arc<ShellLineReading>>,
}

impl ShellLineReader {
    /// A reader for one ask, with `limit` the byte length past which a line is not read.
    pub(crate) fn new(limit: usize) -> Self {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_bash::LANGUAGE.into())
            .expect("the bash grammar's ABI, fixed at build, is one this tree-sitter reads");
        Self {
            parser,
            limit,
            bytes_left: limit.saturating_mul(2),
            readings: HashMap::new(),
        }
    }

    /// Reads `line` into its simple commands, those in a pipeline, a chain, a substitution or a
    /// string a substitution runs included. A line past the limit or past what the reader has left
    /// reads not whole with no command; a line read before reads as it did then, at no cost.
    pub(crate) fn read(&mut self, line: &str) -> Arc<ShellLineReading> {
        if let Some(reading) = self.readings.get(line) {
            return Arc::clone(reading);
        }
        if line.len() > self.limit || line.len() > self.bytes_left {
            return Arc::new(ShellLineReading {
                commands: Vec::new(),
                is_whole: false,
            });
        }
        self.bytes_left -= line.len();
        let tree = self
            .parser
            .parse(line, None)
            .expect("a parser with its language set and no cancellation always returns a tree");
        let root = tree.root_node();
        let reading = Arc::new(ShellLineReading {
            commands: commands_in(root, line),
            is_whole: !root.has_error(),
        });
        self.readings.insert(line.to_owned(), Arc::clone(&reading));
        reading
    }
}

/// The command line `command` hands a shell to run: the string an `eval` runs, or the one an `sh`,
/// `bash` or `zsh` runs with `-c` among its short options; `None` for any other command.
pub(crate) fn read_command_string(command: &ShellCommand) -> Option<Cow<'_, str>> {
    command_string_of(&command.program, &command.argument_words)
}

/// The command line `line` runs when it is a provider's argv joined by `shlex`, one `sh`, `bash`,
/// `zsh` or `eval` handing a shell its whole line, as a provider wraps a command in
/// `/bin/zsh -lc '…'`; any other line, one with an operator outside the quotes among them, is
/// returned as it is. No tree is built for the outer line, so no cap applies to it.
pub(crate) fn unwrap_shell_command_line(line: &str) -> Cow<'_, str> {
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
    command_string_of(basename(first), rest)
        .map_or(Cow::Borrowed(line), |inner| Cow::Owned(inner.into_owned()))
}

// How a program that runs the command after it reads its own words first: its options that take
// the next word as their value, and the plain words it takes before the command.
#[derive(Clone, Copy)]
struct CommandWrapper {
    options_with_value: &'static [&'static str],
    leading_operands: usize,
}

// The programs that run the command after them, so the program is the word past their own.
fn command_wrapper(program: &str) -> Option<CommandWrapper> {
    let (options_with_value, leading_operands): (&'static [&'static str], usize) = match program {
        "env" => (&["-u", "--unset", "-C", "--chdir"], 0),
        "exec" => (&["-a"], 0),
        "command" | "nohup" => (&[], 0),
        "time" => (&["-o", "--output", "-f", "--format"], 0),
        // The duration comes before the command.
        "timeout" => (&["-s", "--signal", "-k", "--kill-after"], 1),
        "nice" => (&["-n", "--adjustment"], 0),
        "sudo" => (
            &[
                "-u",
                "--user",
                "-g",
                "--group",
                "-h",
                "--host",
                "-p",
                "--prompt",
                "-C",
                "--close-from",
                "-D",
                "--chdir",
                "-r",
                "--role",
                "-t",
                "--type",
                "-T",
                "--command-timeout",
                "-U",
                "--other-user",
                "-R",
                "--chroot",
            ],
            0,
        ),
        "xargs" => (
            &[
                "-I",
                "-L",
                "-n",
                "--max-args",
                "-P",
                "--max-procs",
                "-s",
                "--max-chars",
                "-d",
                "--delimiter",
                "-E",
                "-a",
                "--arg-file",
            ],
            0,
        ),
        _ => return None,
    };
    Some(CommandWrapper {
        options_with_value,
        leading_operands,
    })
}

// `env -S` splits its value into the words the command starts with.
const ENV_SPLIT_STRING_OPTIONS: &[&str] = &["-S", "--split-string"];

// Shells whose `-c`, alone or in a cluster such as `-lc`, runs the first word after the options as
// a command line, and the options of theirs that take the next word as their value.
const COMMAND_STRING_SHELLS: &[&str] = &["sh", "bash", "zsh"];
const SHELL_OPTIONS_WITH_VALUE: &[&str] = &["-o", "+o", "-O", "+O", "--rcfile", "--init-file"];

fn command_string_of<'a>(program: &str, argument_words: &'a [String]) -> Option<Cow<'a, str>> {
    if program == "eval" {
        return Some(Cow::Owned(argument_words.join(" ")));
    }
    if COMMAND_STRING_SHELLS.contains(&program) {
        return shell_command_string_of(argument_words).map(Cow::Borrowed);
    }
    None
}

// The command line a shell runs: with `-c` among its short options, the first word after the
// options; the words after it are the line's own `$0` and arguments.
fn shell_command_string_of(argument_words: &[String]) -> Option<&str> {
    let mut reads_command_string = false;
    let mut index = 0;
    while let Some(word) = argument_words.get(index) {
        if word == "--" || word == "-" {
            return argument_words
                .get(index + 1)
                .filter(|_| reads_command_string)
                .map(String::as_str);
        }
        if SHELL_OPTIONS_WITH_VALUE.contains(&word.as_str()) {
            index += 1;
        } else if is_shell_option(word) {
            reads_command_string |=
                !word.starts_with("--") && word.starts_with('-') && word.contains('c');
        } else {
            return reads_command_string.then_some(word.as_str());
        }
        index += 1;
    }
    None
}

// A `-` or `+` followed by any character but a line break, as a shell option is spelled.
fn is_shell_option(word: &str) -> bool {
    let mut characters = word.chars();
    matches!(characters.next(), Some('-' | '+'))
        && characters
            .next()
            .is_some_and(|character| !matches!(character, '\n' | '\r' | '\u{2028}' | '\u{2029}'))
}

// Every simple command in the tree, nested ones included: those in a pipeline, a chain, a subshell
// or a loop, those a substitution runs, inside double quotes, an assignment or a here-document
// too, and those the parser read before a syntax error. The cursor keeps its own stack, so no
// nesting depth reaches this thread's.
fn commands_in(root: Node<'_>, source: &str) -> Vec<ShellCommand> {
    let mut commands = Vec::new();
    let mut cursor = root.walk();
    loop {
        if let Some(command) = command_words(cursor.node(), source).and_then(read_command) {
            commands.push(command);
        }
        if cursor.goto_first_child() {
            continue;
        }
        while !cursor.goto_next_sibling() {
            if !cursor.goto_parent() {
                return commands;
            }
        }
    }
}

// The words of a node that runs a command, its program first; `None` for any other node.
fn command_words(node: Node<'_>, source: &str) -> Option<Vec<String>> {
    match node.kind() {
        "command" => Some(simple_command_words(node, source)),
        // `export`, `declare`, `unset` and their kin are commands named by their keyword.
        "declaration_command" | "unset_command" => Some(keyword_command_words(node, source)),
        // A single-bracket test runs the command `[`; a `[[ … ]]` test runs none.
        "test_command" => node
            .child(0)
            .filter(|bracket| bracket.kind() == "[")
            .map(|_| test_command_words(node, source)),
        _ => None,
    }
}

// A simple command's name and argument words, without its leading assignments and redirects, and
// without a bare `time [-p] [--]` or `coproc` before it, which the shell reads as keywords.
fn simple_command_words(command: Node<'_>, source: &str) -> Vec<String> {
    let mut words = Vec::new();
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
                        return Vec::new();
                    };
                    if is_first_child && literal.kind() == "word" {
                        keyword = Some(node_text(literal, source));
                    }
                    words.push(word_value(literal, source));
                }
                Some("argument") => words.push(word_value(child, source)),
                Some(_) | None => {}
            }
            is_first_child = false;
            if !cursor.goto_next_sibling() {
                break;
            }
        }
    }
    let keyword_words = match keyword {
        Some("time") => {
            let mut count = 1;
            if words.get(count).is_some_and(|word| word == "-p") {
                count += 1;
            }
            if words.get(count).is_some_and(|word| word == "--") {
                count += 1;
            }
            count
        }
        Some("coproc") => 1,
        Some(_) | None => 0,
    };
    words.split_off(keyword_words.min(words.len()))
}

// A declaration or `unset` command's keyword and words: its names, never its assignments.
fn keyword_command_words(command: Node<'_>, source: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut cursor = command.walk();
    if !cursor.goto_first_child() {
        return words;
    }
    loop {
        let child = cursor.node();
        // The keyword and each name read as their text, a literal as its value.
        match child.kind() {
            "variable_assignment" | "comment" => {}
            _ => words.push(word_value(child, source)),
        }
        if !cursor.goto_next_sibling() {
            return words;
        }
    }
}

// A single-bracket test's words, `[` and `]` included: each literal read as a word and each
// operator as its text, through any nesting of test expressions.
fn test_command_words(test: Node<'_>, source: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut cursor = test.walk();
    if !cursor.goto_first_child() {
        return words;
    }
    loop {
        let node = cursor.node();
        let descends = if node.is_missing() || node.kind() == "comment" {
            false
        } else if is_test_word(node) {
            words.push(word_value(node, source));
            false
        } else {
            true
        };
        if descends && cursor.goto_first_child() {
            continue;
        }
        while !cursor.goto_next_sibling() {
            if !cursor.goto_parent() {
                return words;
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

// The program is the first word that is neither an assignment nor a wrapper that runs the command
// after its own options and operands; a command of assignments alone runs none.
fn read_command(mut words: Vec<String>) -> Option<ShellCommand> {
    let mut wrappers = Vec::new();
    loop {
        let start = words
            .iter()
            .position(|word| !is_variable_assignment(word))?;
        let program = basename(&words[start]).to_owned();
        let Some(wrapper) = command_wrapper(&program) else {
            return Some(ShellCommand {
                program,
                argument_words: words.split_off(start + 1),
                wrappers,
            });
        };
        words = wrapped_words_of(&program, wrapper, words.split_off(start + 1));
        wrappers.push(program);
    }
}

// The words a wrapper runs: past its options, an option's value and its leading operands.
fn wrapped_words_of(program: &str, wrapper: CommandWrapper, mut words: Vec<String>) -> Vec<String> {
    let mut index = 0;
    while let Some(word) = words.get(index) {
        if word == "--" {
            index += 1;
            break;
        }
        if !word.starts_with('-') || word == "-" {
            break;
        }
        if program == "env" && ENV_SPLIT_STRING_OPTIONS.contains(&word.as_str()) {
            let split_words: Vec<String> = words
                .get(index + 1)
                .map(|value| {
                    value
                        .split(is_ecmascript_whitespace)
                        .filter(|part| !part.is_empty())
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            return split_words
                .into_iter()
                .chain(words.into_iter().skip(index + 2))
                .collect();
        }
        index += if wrapper.options_with_value.contains(&word.as_str()) {
            2
        } else {
            1
        };
    }
    words.split_off((index + wrapper.leading_operands).min(words.len()))
}

// `NAME=…`, a name of letters, digits and underscores not starting with a digit.
fn is_variable_assignment(word: &str) -> bool {
    let Some((name, _)) = word.split_once('=') else {
        return false;
    };
    let mut characters = name.chars();
    characters
        .next()
        .is_some_and(|character| character.is_ascii_alphabetic() || character == '_')
        && characters.all(|character| character.is_ascii_alphanumeric() || character == '_')
}

fn basename(program: &str) -> &str {
    program.rsplit_once('/').map_or(program, |(_, name)| name)
}

#[cfg(test)]
mod tests;
