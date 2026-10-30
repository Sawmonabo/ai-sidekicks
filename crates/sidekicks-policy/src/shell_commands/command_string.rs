//! The lines a command hands a shell: an `eval`'s words, the string a shell runs with `-c`, the
//! command `su` hands the target user's shell, an alias's value, a trap's line, the line an
//! option of `compgen`, `mapfile`, `script` or `flock` names, zsh's `emulate … -c` string, and the
//! words `watch` joins; the commands that read their line from somewhere other than their words;
//! and the line a provider's `<shell> -lc '…'` wrapper hands its shell.

use std::borrow::Cow;
use std::path::Path;

use super::words::{PositionedByte, ShellWord, WordText, long_option_named, short_option_named};
use super::wrappers::{CommandWrapper, command_wrapper};

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

/// Whether `program` hands a shell a line: `eval`, `su`, `alias`, `trap`, `emulate`, `watch`, a
/// program one of whose options names a line, or a shell that runs a `-c` string, whether or not
/// this command's words hand it one, since a rule on the program covers its every line.
pub fn hands_a_shell_a_line(program: impl WordText) -> bool {
    shell_line_program(program).is_some()
}

/// Which of a command's argument words make a line it hands a shell.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum CommandStringWords {
    /// The words from the one at `from` on, joined by spaces, as `eval` and `watch` join them.
    Joined { from: usize },
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
    let whole = |index| CommandStringWords::One {
        index,
        skipped_bytes: 0,
    };
    match shell_line_program(program) {
        None => Vec::new(),
        Some(ShellLineProgram::Eval) => vec![CommandStringWords::Joined { from: 0 }],
        Some(ShellLineProgram::Su) => su_command_strings(&argument_words),
        Some(ShellLineProgram::Alias) => alias_values(argument_words),
        Some(ShellLineProgram::Trap) => first_operand(argument_words, &NO_OPTIONS)
            .map(whole)
            .into_iter()
            .collect(),
        Some(ShellLineProgram::Watch) => first_operand(argument_words, &WATCH_OPTIONS)
            .map(|from| CommandStringWords::Joined { from })
            .into_iter()
            .collect(),
        Some(ShellLineProgram::Emulate) => emulate_command_string(argument_words)
            .map(whole)
            .into_iter()
            .collect(),
        Some(ShellLineProgram::OptionLine(options)) => {
            let reads_past_operands = options.reads_past_operands;
            last_line_option(argument_words, options, |_, word| {
                reads_past_operands && !word.is("--")
            })
            .into_iter()
            .collect()
        }
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

/// Whether `program` reads the line it runs from its input rather than its words: a shell handed
/// neither a `-c` string nor a script it names with a decided regular path, so it reads its
/// standard input, a here-string, a here-document or a pipe; `su` handed no command, whose target
/// shell reads the same; or `source` or `.` given anything but a decided regular path.
pub(super) fn reads_its_line_from_input<'r>(
    program: ShellWord<'r>,
    mut argument_words: impl Iterator<Item = ShellWord<'r>> + Clone,
) -> bool {
    if program.is("source") || program.is(".") {
        let mut words = argument_words.skip_while(|word| word.is("--"));
        return !words.next().is_some_and(is_regular_script_path);
    }
    let options_with_value = match shell_line_program(program) {
        Some(ShellLineProgram::Shell(options_with_value)) => options_with_value,
        Some(ShellLineProgram::Su) => return su_command_strings(&argument_words).is_empty(),
        Some(_) | None => return false,
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
    word.is_decided() && !names_a_stream_folder(&word.to_string())
}

// Whether `path`, its `.` and `..` segments and repeated slashes folded lexically, is under `/dev`
// or `/proc`: from the root, or from a relative path whose `..` climb past its start, which the
// root's folders are as far up as the run's folder may be.
fn names_a_stream_folder(path: &str) -> bool {
    let is_absolute = path.starts_with('/');
    let mut climbs_past_start = false;
    let mut segments: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                if segments.pop().is_none() && !is_absolute {
                    climbs_past_start = true;
                }
            }
            other => segments.push(other),
        }
    }
    (is_absolute || climbs_past_start) && matches!(segments.first(), Some(&("dev" | "proc")))
}

// A program that hands a shell a line, and how its words make it.
#[derive(Clone, Copy)]
enum ShellLineProgram {
    Eval,
    Su,
    Alias,
    // A trap's line, its first operand.
    Trap,
    // `watch`'s words after its options, which it joins into a line for `sh -c`.
    Watch,
    // zsh's `emulate <shell> -c <line>`.
    Emulate,
    // A program one of whose options names the line, as `compgen -C <line>` does.
    OptionLine(LineOptions),
    // A shell with the options of its own that take the next word as their value.
    Shell(&'static [&'static str]),
}

/// How a program's options name the line it hands a shell: the options whose value is the line,
/// those whose value is anything else, the letters whose optional value is only the rest of their
/// cluster, and whether options may follow its operands, as GNU's getopt reads them.
#[derive(Clone, Copy)]
pub(super) struct LineOptions {
    pub(super) options_naming_the_line: &'static [&'static str],
    pub(super) options_with_value: &'static [&'static str],
    pub(super) letters_with_attached_value: &'static str,
    pub(super) reads_past_operands: bool,
}

const NO_OPTIONS: LineOptions = LineOptions {
    options_naming_the_line: &[],
    options_with_value: &[],
    letters_with_attached_value: "",
    reads_past_operands: false,
};

const WATCH_OPTIONS: LineOptions = LineOptions {
    options_with_value: &["-n", "--interval", "-q", "--equexit", "-s", "--shotsdir"],
    letters_with_attached_value: "d",
    ..NO_OPTIONS
};

// The programs whose option names a line, each with how its options read, beside the wrappers
// one of whose options hands a shell a line in place of their command.
const OPTION_LINE_PROGRAMS: &[(&str, LineOptions)] = &[
    (
        "compgen",
        LineOptions {
            options_naming_the_line: &["-C"],
            options_with_value: &["-A", "-G", "-W", "-F", "-X", "-P", "-S", "-o", "-V"],
            ..NO_OPTIONS
        },
    ),
    ("mapfile", MAPFILE_OPTIONS),
    ("readarray", MAPFILE_OPTIONS),
];

const MAPFILE_OPTIONS: LineOptions = LineOptions {
    options_naming_the_line: &["-C"],
    options_with_value: &["-d", "-n", "-O", "-s", "-u", "-c"],
    ..NO_OPTIONS
};

fn shell_line_program(program: impl WordText) -> Option<ShellLineProgram> {
    let named = [
        ("eval", ShellLineProgram::Eval),
        ("su", ShellLineProgram::Su),
        ("alias", ShellLineProgram::Alias),
        ("trap", ShellLineProgram::Trap),
        ("watch", ShellLineProgram::Watch),
        ("emulate", ShellLineProgram::Emulate),
    ];
    if let Some(&(_, line_program)) = named.iter().find(|(name, _)| program.is(name)) {
        return Some(line_program);
    }
    if let Some(&(_, options)) = OPTION_LINE_PROGRAMS
        .iter()
        .find(|(name, _)| program.is(name))
    {
        return Some(ShellLineProgram::OptionLine(options));
    }
    if let Some(options) = command_wrapper(program).and_then(CommandWrapper::line_options) {
        return Some(ShellLineProgram::OptionLine(options));
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
// alone as a cluster reads them; GNU's su reads options past its user.
const SU_OPTIONS: LineOptions = LineOptions {
    options_naming_the_line: &["-c", "--command", "--session-command"],
    options_with_value: &[
        "-g",
        "--group",
        "-G",
        "--supp-group",
        "-s",
        "--shell",
        "-w",
        "--whitelist-environment",
    ],
    letters_with_attached_value: "",
    reads_past_operands: true,
};

// The value of the last of `options`' line options, as getopt reads a program's options: a long
// one by its name or a prefix of one, a short cluster up to the letter that takes a value, which
// is the rest of the cluster or the next word. Each word that is no option, `-` alone and `--`
// among them, goes to `on_operand` with its index, which answers whether options may follow it.
fn last_line_option<W: WordText>(
    argument_words: impl Iterator<Item = W>,
    options: LineOptions,
    mut on_operand: impl FnMut(usize, W) -> bool,
) -> Option<CommandStringWords> {
    let named = || {
        let lines = options
            .options_naming_the_line
            .iter()
            .map(|&option| (option, true));
        let valued = options
            .options_with_value
            .iter()
            .map(|&option| (option, false));
        lines.chain(valued)
    };
    let mut line = None;
    let mut words = argument_words.enumerate();
    while let Some((index, word)) = words.next() {
        if !word.starts_with("-") || word.is("-") || word.is("--") {
            if on_operand(index, word) {
                continue;
            }
            break;
        }
        let read = if word.starts_with("--") {
            long_option_named(word, named())
        } else {
            short_option_named(word, &named(), options.letters_with_attached_value)
        };
        let Some((is_line, attached_from)) = read else {
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
        if is_line {
            line = value;
        }
    }
    line
}

// The index of the first operand after a program's options, read as `last_line_option` reads
// them, past a `--` that ends them.
fn first_operand<W: WordText>(
    argument_words: impl Iterator<Item = W>,
    options: &LineOptions,
) -> Option<usize> {
    let mut first = None;
    last_line_option(argument_words, *options, |index, word| {
        first = Some(if word.is("--") { index + 1 } else { index });
        false
    });
    first
}

// zsh's `emulate` runs the word after a short cluster holding `c`, `-c`, `-xc` or `-cx` alike, as
// the string of its `-c`.
fn emulate_command_string<W: WordText>(argument_words: impl Iterator<Item = W>) -> Option<usize> {
    let mut words = argument_words.enumerate();
    words.find(|(_, word)| {
        word.starts_with("-") && !word.starts_with("--") && word.contains(PositionedByte::LetterC)
    })?;
    words.next().map(|(index, _)| index)
}

// The lines `su` hands the target user's shell: the value of its last `-c`, `--command` or
// `--session-command`, read as `getopt_long` reads su's options up to `--`; and the `-c` string
// the shell itself finds in the words su hands it, those after the user, as macOS's su hands them
// all, or after `--`.
fn su_command_strings<W: WordText>(
    argument_words: &(impl Iterator<Item = W> + Clone),
) -> Vec<CommandStringWords> {
    // Where the words su hands the shell may start.
    let mut shell_words_from = Vec::new();
    let mut has_user = false;
    let command = last_line_option(argument_words.clone(), SU_OPTIONS, |index, word| {
        if word.is("--") {
            // A user not yet named is the word after `--`.
            shell_words_from.push(index + if has_user { 1 } else { 2 });
            return false;
        }
        if !word.is("-") && !has_user {
            has_user = true;
            shell_words_from.push(index + 1);
        }
        true
    });
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
