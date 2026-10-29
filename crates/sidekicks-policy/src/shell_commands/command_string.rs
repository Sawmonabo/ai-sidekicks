//! The line a command hands a shell: an `eval`'s words, the string a shell runs with `-c`, or the
//! command `su` hands the target user's shell; and the line a provider's `<shell> -lc '…'` wrapper
//! hands its shell.

use std::borrow::Cow;

use super::words::{PositionedByte, WordText, long_option_named, short_option_named};

/// The command line `line` runs when it is a provider's argv joined by `shlex`, one `sh`, `bash`,
/// `zsh`, `dash`, `ksh` or `eval` handing a shell its whole line, as a provider wraps a command in
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
    // `su` runs its command as another user, so it is never a provider's wrapper.
    match shell_line_words(program, rest.iter().map(String::as_str)) {
        Some(CommandStringWords::Every) => Cow::Owned(rest.join(" ")),
        Some(CommandStringWords::One {
            index,
            skipped_bytes,
        }) => Cow::Owned(rest[index][skipped_bytes..].to_owned()),
        None => Cow::Borrowed(line),
    }
}

/// Which of a command's argument words make the line it hands a shell.
pub(super) enum CommandStringWords {
    /// An `eval`'s words, joined by spaces.
    Every,
    /// The word at `index` past its first `skipped_bytes` bytes: a shell's `-c` string whole, or
    /// the value of `su`'s command option, which may follow the option's name in its own word.
    One { index: usize, skipped_bytes: usize },
}

/// The words of `program`'s arguments that make the line it hands a shell, if it hands one.
pub(super) fn command_string_words<W: WordText>(
    program: W,
    argument_words: impl Iterator<Item = W>,
) -> Option<CommandStringWords> {
    if program.is("su") {
        return su_command_string(argument_words);
    }
    shell_line_words(program, argument_words)
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

fn shell_line_words<W: WordText>(
    program: W,
    argument_words: impl Iterator<Item = W>,
) -> Option<CommandStringWords> {
    if program.is("eval") {
        return Some(CommandStringWords::Every);
    }
    let &(_, options_with_value) = COMMAND_STRING_SHELLS
        .iter()
        .find(|(shell, _)| program.is(shell))?;
    shell_command_string_index(argument_words, options_with_value).map(|index| {
        CommandStringWords::One {
            index,
            skipped_bytes: 0,
        }
    })
}

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

// The command `su` hands the target user's shell: the value of its last `-c`, `--command` or
// `--session-command`, read as `getopt_long` reads su's options. Words that are no option, `-` and
// the user among them, are passed over, since such an option after the user is su's own, or is
// handed to the shell, which runs it as its own `-c`.
fn su_command_string<W: WordText>(
    argument_words: impl Iterator<Item = W>,
) -> Option<CommandStringWords> {
    let options = || {
        let commands = SU_COMMAND_OPTIONS.iter().map(|&option| (option, true));
        let valued = SU_OPTIONS_WITH_VALUE.iter().map(|&option| (option, false));
        commands.chain(valued)
    };
    let mut command = None;
    let mut words = argument_words.enumerate();
    while let Some((index, word)) = words.next() {
        if !word.starts_with("-") || word.is("-") || word.is("--") {
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
    command
}
