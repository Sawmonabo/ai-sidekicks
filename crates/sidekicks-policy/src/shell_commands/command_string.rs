//! The lines a command hands a shell: an `eval`'s words, the string a shell runs with `-c`, or the
//! command `su` hands the target user's shell; and the line a provider's `<shell> -lc '…'` wrapper
//! hands its shell.

use std::borrow::Cow;

use super::words::{PositionedByte, WordText, long_option_named, short_option_named};

/// The shells a provider hands a command line in its own form, `<shell> -c '…'` or
/// `<shell> -lc '…'`, by file name.
pub const PROVIDER_LINE_SHELLS: [&str; 3] = ["zsh", "bash", "sh"];

// The folders a provider's shell is named from, beside its bare name.
const PROVIDER_SHELL_FOLDERS: [&str; 2] = ["/bin/", "/usr/bin/"];

/// The command line `line` runs when it is a provider's argv joined by `shlex`: one of
/// `PROVIDER_LINE_SHELLS`, named alone or from `/bin` or `/usr/bin`, handed its whole line with
/// `-c`, `-lc`, `-cl` or `-l -c`, as a provider wraps a command in `/bin/zsh -lc '…'`. Any other
/// line is returned as it is: one with an operator outside the quotes, one with words after the
/// string, one whose shell another folder names, and one whose shell takes any other option, which
/// can run or write a file first. No tree is built for the outer line, so no cap applies to it.
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
    let Some((shell, rest)) = words.split_first() else {
        return Cow::Borrowed(line);
    };
    let name = PROVIDER_SHELL_FOLDERS
        .iter()
        .find_map(|folder| shell.strip_prefix(folder))
        .unwrap_or(shell);
    if !PROVIDER_LINE_SHELLS.contains(&name) {
        return Cow::Borrowed(line);
    }
    match rest.split_last() {
        Some((command_line, options)) if is_provider_line_form(options) => {
            Cow::Owned(command_line.clone())
        }
        Some(_) | None => Cow::Borrowed(line),
    }
}

// Whether a shell's words before its string are a provider's own: `-c`, `-lc`, `-cl` or `-l -c`.
fn is_provider_line_form(options: &[String]) -> bool {
    match options {
        [form] => matches!(form.as_str(), "-c" | "-lc" | "-cl"),
        [login, line] => login == "-l" && line == "-c",
        _ => false,
    }
}

/// Whether `program` hands a shell a line: `eval`, `su`, or a shell that runs a `-c` string,
/// whether or not this command's words hand it one, since a rule on the program covers its every
/// line.
pub fn hands_a_shell_a_line(program: impl WordText) -> bool {
    shell_line_program(program).is_some()
}

/// Which of a command's argument words make a line it hands a shell.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum CommandStringWords {
    /// An `eval`'s words, joined by spaces.
    Every,
    /// The word at `index` past its first `skipped_bytes` bytes: a shell's `-c` string whole, or
    /// the value of `su`'s command option, which may follow the option's name in its own word.
    One { index: usize, skipped_bytes: usize },
}

/// The words of `program`'s arguments that make each line it hands a shell, none when it hands
/// none: `su` hands its own command and the target shell's `-c` string both.
pub(super) fn command_string_words<W: WordText>(
    program: W,
    argument_words: impl Iterator<Item = W> + Clone,
) -> Vec<CommandStringWords> {
    match shell_line_program(program) {
        None => Vec::new(),
        Some(ShellLineProgram::Eval) => vec![CommandStringWords::Every],
        Some(ShellLineProgram::Su) => su_command_strings(argument_words),
        Some(ShellLineProgram::Shell(options_with_value)) => {
            shell_command_string_index(argument_words, options_with_value)
                .map(|index| CommandStringWords::One {
                    index,
                    skipped_bytes: 0,
                })
                .into_iter()
                .collect()
        }
    }
}

// A program that hands a shell a line, and how its words make it.
#[derive(Clone, Copy)]
enum ShellLineProgram {
    Eval,
    Su,
    // A shell with the options of its own that take the next word as their value.
    Shell(&'static [&'static str]),
}

fn shell_line_program(program: impl WordText) -> Option<ShellLineProgram> {
    if program.is("eval") {
        return Some(ShellLineProgram::Eval);
    }
    if program.is("su") {
        return Some(ShellLineProgram::Su);
    }
    COMMAND_STRING_SHELLS
        .iter()
        .find(|(shell, _)| program.is(shell))
        .map(|&(_, options_with_value)| ShellLineProgram::Shell(options_with_value))
}

// Shells whose `-c`, alone or in a cluster such as `-lc`, runs the first word after the options as
// a command line, each with its own options that take the next word as their value beside those
// every one of them is read with.
const COMMAND_STRING_SHELLS: &[(&str, &[&str])] = &[
    ("sh", &[]),
    ("bash", &[]),
    ("zsh", &[]),
    ("dash", &[]),
    ("ksh", &["-R"]),
];
const SHELL_OPTIONS_WITH_VALUE: &[&str] = &["-o", "+o", "-O", "+O", "--rcfile", "--init-file"];

// The command line a shell runs: with `-c` among its short options, the first word after the
// options; the words after it are the line's own `$0` and arguments.
fn shell_command_string_index<W: WordText>(
    argument_words: impl Iterator<Item = W>,
    options_with_value: &[&str],
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
            .chain(options_with_value)
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

// `su`'s options that hand the shell a command, and those that take any other value, the letters
// alone as a cluster reads them.
const SU_COMMAND_OPTIONS: &[&str] = &["-c", "--command", "--session-command"];
const SU_OPTIONS_WITH_VALUE: &[&str] = &[
    "-g",
    "--group",
    "-G",
    "--supp-group",
    "-s",
    "--shell",
    "-w",
    "--whitelist-environment",
];

// The lines `su` hands the target user's shell: the value of its last `-c`, `--command` or
// `--session-command`, read as `getopt_long` reads su's options up to `--`; and the `-c` string
// the shell itself finds in the words su hands it, those after the user, as macOS's su hands them
// all, or after `--`.
fn su_command_strings<W: WordText>(
    argument_words: impl Iterator<Item = W> + Clone,
) -> Vec<CommandStringWords> {
    let options = || {
        let commands = SU_COMMAND_OPTIONS.iter().map(|&option| (option, true));
        let valued = SU_OPTIONS_WITH_VALUE.iter().map(|&option| (option, false));
        commands.chain(valued)
    };
    let mut command = None;
    // Where the words su hands the shell may start.
    let mut shell_words_from = Vec::new();
    let mut has_user = false;
    let mut words = argument_words.clone().enumerate();
    while let Some((index, word)) = words.next() {
        if word.is("--") {
            // A user not yet named is the word after `--`.
            shell_words_from.push(index + if has_user { 1 } else { 2 });
            break;
        }
        if word.is("-") {
            continue;
        }
        if !word.starts_with("-") {
            if !has_user {
                has_user = true;
                shell_words_from.push(index + 1);
            }
            continue;
        }
        let read = if word.starts_with("--") {
            long_option_named(word, options())
        } else {
            short_option_named(word, &options(), "")
        };
        let Some((is_command, attached_from)) = read else {
            continue;
        };
        let value = match attached_from {
            Some(skipped_bytes) => Some(CommandStringWords::One {
                index,
                skipped_bytes,
            }),
            None => words.next().map(|(index, _)| CommandStringWords::One {
                index,
                skipped_bytes: 0,
            }),
        };
        if is_command {
            command = value;
        }
    }
    let mut strings: Vec<CommandStringWords> = command.into_iter().collect();
    for start in shell_words_from {
        let Some(index) = shell_command_string_index(argument_words.clone().skip(start), &[])
        else {
            continue;
        };
        let string = CommandStringWords::One {
            index: start + index,
            skipped_bytes: 0,
        };
        if !strings.contains(&string) {
            strings.push(string);
        }
    }
    strings
}
