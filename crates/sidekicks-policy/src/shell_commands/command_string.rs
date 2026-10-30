//! The lines a command hands a shell: an `eval`'s words, the string a shell runs with `-c`, the
//! command `su` hands the target user's shell, or an alias's value; the commands that read their
//! line from somewhere other than their words; and the line a provider's `<shell> -lc '…'` wrapper
//! hands its shell.

use std::borrow::Cow;
use std::path::Path;

use super::words::{PositionedByte, ShellWord, WordText, long_option_named, short_option_named};

/// The shells a provider hands a command line in its own form, `<shell> -c '…'` or
/// `<shell> -lc '…'`, by file name.
pub const PROVIDER_LINE_SHELLS: [&str; 3] = ["zsh", "bash", "sh"];

// The folders a provider's shell is named from, beside its bare name.
const PROVIDER_SHELL_FOLDERS: [&str; 2] = ["/bin/", "/usr/bin/"];

/// The command line `line` runs when it is a provider's argv joined by `shlex`: one of
/// `PROVIDER_LINE_SHELLS`, named alone or from `/bin` or `/usr/bin`, or one of `provider_shells`,
/// the exact paths the provider may start a line's shell at, handed its whole line with `-c`,
/// `-lc`, `-cl` or `-l -c`, as a provider wraps a command in `/bin/zsh -lc '…'`. Any other line is
/// returned as it is: one with an operator outside the quotes, one with words after the string,
/// one whose shell another folder names, and one whose shell takes any other option, which can run
/// or write a file first. No tree is built for the outer line, so no cap applies to it.
pub fn unwrap_shell_command_line<'l>(
    line: &'l str,
    provider_shells: &[impl AsRef<Path>],
) -> Cow<'l, str> {
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
    let is_providers_shell = provider_shells.iter().any(|provider_shell| {
        let provider_shell = provider_shell.as_ref();
        provider_shell.to_str() == Some(shell.as_str())
            && provider_shell
                .file_name()
                .and_then(|file_name| file_name.to_str())
                .is_some_and(|file_name| PROVIDER_LINE_SHELLS.contains(&file_name))
    });
    if !PROVIDER_LINE_SHELLS.contains(&name) && !is_providers_shell {
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

/// Whether `program` hands a shell a line: `eval`, `su`, `alias`, or a shell that runs a `-c`
/// string, whether or not this command's words hand it one, since a rule on the program covers its
/// every line.
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
/// none: `su` hands its own command and the target shell's `-c` string both, and `alias` the value
/// after the `=` of each of its words that defines one.
pub(super) fn command_string_words<W: WordText>(
    program: W,
    argument_words: impl Iterator<Item = W> + Clone,
) -> Vec<CommandStringWords> {
    match shell_line_program(program) {
        None => Vec::new(),
        Some(ShellLineProgram::Eval) => vec![CommandStringWords::Every],
        Some(ShellLineProgram::Su) => su_command_strings(&argument_words),
        Some(ShellLineProgram::Alias) => alias_values(argument_words),
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

/// Whether `program` reads the line it runs from somewhere other than its words, which only the
/// run decides: a shell handed neither a `-c` string nor a script it names with a decided regular
/// path, so it reads its standard input, a here-string, a here-document or a pipe; or `source` or
/// `.` given anything but a decided regular path.
pub(super) fn reads_its_line_from_input<'r>(
    program: ShellWord<'r>,
    mut argument_words: impl Iterator<Item = ShellWord<'r>> + Clone,
) -> bool {
    if program.is("source") || program.is(".") {
        let mut words = argument_words.skip_while(|word| word.is("--"));
        return !words.next().is_some_and(is_regular_script_path);
    }
    let Some(ShellLineProgram::Shell(options_with_value)) = shell_line_program(program) else {
        return false;
    };
    match shell_operand(argument_words.clone(), options_with_value) {
        ShellOperand::CommandString(_) | ShellOperand::MissingCommandString => false,
        ShellOperand::Script(index) => !argument_words
            .nth(index)
            .is_some_and(is_regular_script_path),
        ShellOperand::Input => true,
    }
}

// Whether `word` is a path the run cannot change that names a regular file, as a script is: never
// one of the system's device or process folders, through which a file reads a stream.
fn is_regular_script_path(word: ShellWord<'_>) -> bool {
    word.is_decided() && !word.starts_with("/dev/") && !word.starts_with("/proc/")
}

// A program that hands a shell a line, and how its words make it.
#[derive(Clone, Copy)]
enum ShellLineProgram {
    Eval,
    Su,
    Alias,
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
    if program.is("alias") {
        return Some(ShellLineProgram::Alias);
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
    match shell_operand(argument_words, options_with_value) {
        ShellOperand::CommandString(index) => Some(index),
        ShellOperand::MissingCommandString | ShellOperand::Script(_) | ShellOperand::Input => None,
    }
}

// Where a shell takes the line it runs from.
enum ShellOperand {
    // The `-c` string, the word at this index.
    CommandString(usize),
    // `-c` with no string after the options, which the shell refuses, running nothing.
    MissingCommandString,
    // The script the word at this index names.
    Script(usize),
    // Its standard input: no operand follows the options, or `-s` is among them.
    Input,
}

// The first word after a shell's options, read as `-c` and `-s` among its short options make it.
fn shell_operand<W: WordText>(
    argument_words: impl Iterator<Item = W>,
    options_with_value: &[&str],
) -> ShellOperand {
    let mut reads_command_string = false;
    let mut reads_input = false;
    let mut words = argument_words.enumerate();
    let operand = loop {
        let Some((index, word)) = words.next() else {
            break None;
        };
        if word.is("--") || word.is("-") {
            break words.next().map(|(index, _)| index);
        }
        if SHELL_OPTIONS_WITH_VALUE
            .iter()
            .chain(options_with_value)
            .any(|option| word.is(option))
        {
            words.next();
        } else if is_shell_option(word) {
            let is_short_cluster = !word.starts_with("--") && word.starts_with("-");
            reads_command_string |= is_short_cluster && word.contains(PositionedByte::LetterC);
            reads_input |= is_short_cluster && word.chars().skip(1).any(|letter| letter == 's');
        } else {
            break Some(index);
        }
    };
    match operand {
        Some(index) if reads_command_string => ShellOperand::CommandString(index),
        None if reads_command_string => ShellOperand::MissingCommandString,
        Some(index) if !reads_input => ShellOperand::Script(index),
        Some(_) | None => ShellOperand::Input,
    }
}

// A `-` or `+` followed by any character but a line break, as a shell option is spelled.
fn is_shell_option(word: impl WordText) -> bool {
    let mut characters = word.chars();
    matches!(characters.next(), Some('-' | '+'))
        && characters
            .next()
            .is_some_and(|character| !matches!(character, '\n' | '\r' | '\u{2028}' | '\u{2029}'))
}

// The value after the `=` of each word of `alias` that defines one, a line the shell reads where
// the alias is used.
fn alias_values<W: WordText>(argument_words: impl Iterator<Item = W>) -> Vec<CommandStringWords> {
    argument_words
        .enumerate()
        .filter_map(|(index, word)| {
            let mut skipped_bytes = 0;
            for character in word.chars() {
                skipped_bytes += character.len_utf8();
                if character == '=' {
                    return Some(CommandStringWords::One {
                        index,
                        skipped_bytes,
                    });
                }
            }
            None
        })
        .collect()
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
    argument_words: &(impl Iterator<Item = W> + Clone),
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
