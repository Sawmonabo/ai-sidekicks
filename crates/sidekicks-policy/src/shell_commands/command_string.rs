//! The lines a listed program hands a shell: an `eval`'s words, a shell's `-c` string or the
//! line its own grammar names, the command `su` hands the target user's shell, an alias's value, a
//! trap's line, the line an option of `compgen`, `mapfile`, `script` or `flock` names, zsh's
//! `emulate … -c` string and `repeat`'s `{ … }` list, and the words `watch` joins; the commands
//! that read their line from their input; and the line a provider's `<shell> -lc '…'` wrapper
//! hands its shell.

use std::borrow::Cow;
use std::path::Path;

use super::listed_programs::{ListedProgram, listed_program};
use super::words::{PositionedByte, WordText, long_option_named, short_option_named};

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

/// Which of a command's argument words make a line it hands a shell.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum CommandStringWords {
    /// The words from the one at `from` up to the one at `end`, joined by spaces, as `eval` and
    /// `watch` join them.
    Joined { from: usize, end: usize },
    /// The word at `index` past its first `skipped_bytes` bytes: a shell's `-c` string whole, or
    /// the value of `su`'s command option, which may follow the option's name in its own word.
    One { index: usize, skipped_bytes: usize },
}

/// The words of `program`'s arguments that make each line it hands a shell, none when it hands
/// none: `su` hands its own command and the target shell's `-c` string both, `alias` the value
/// after the `=` of each of its words that defines one, and fish its `-c` and `-C` lines.
pub(super) fn command_string_words<W: WordText>(
    program: W,
    argument_words: impl Iterator<Item = W> + Clone,
) -> Vec<CommandStringWords> {
    let whole = |index| CommandStringWords::One {
        index,
        skipped_bytes: 0,
    };
    let end = argument_words.clone().count();
    match line_handing(program) {
        None | Some(LineHanding::Program(ShellLineProgram::Source)) => Vec::new(),
        Some(LineHanding::Program(ShellLineProgram::Eval)) => {
            vec![CommandStringWords::Joined { from: 0, end }]
        }
        Some(LineHanding::Program(ShellLineProgram::Su)) => su_command_strings(&argument_words),
        Some(LineHanding::Program(ShellLineProgram::Alias)) => alias_values(argument_words),
        Some(LineHanding::Program(ShellLineProgram::Trap)) => {
            first_operand(argument_words, &NO_OPTIONS)
                .map(whole)
                .into_iter()
                .collect()
        }
        Some(LineHanding::Program(ShellLineProgram::Watch(options))) => {
            first_operand(argument_words, &options)
                .map(|from| CommandStringWords::Joined { from, end })
                .into_iter()
                .collect()
        }
        Some(LineHanding::BraceGroup) => brace_group(argument_words).into_iter().collect(),
        Some(LineHanding::Program(ShellLineProgram::Emulate)) => {
            emulate_command_string(argument_words)
                .map(whole)
                .into_iter()
                .collect()
        }
        Some(LineHanding::Program(ShellLineProgram::OptionLine(options))) => {
            let reads_past_operands = options.reads_past_operands;
            line_option_values(argument_words, options, |_, word| {
                reads_past_operands && !word.is("--")
            })
            .pop()
            .into_iter()
            .collect()
        }
        Some(LineHanding::Shell(grammar)) => shell_strings(grammar, argument_words, end),
    }
}

/// Whether `program` reads the line it runs from its input rather than its words: a shell handed
/// no line of its words, with no operand or one naming the input, such as `/dev/stdin`; `su`
/// handed no command, whose target shell reads the same; or `source` or `.` with no operand or one
/// naming the input. An operand only the run decides reads as a script, never as the input.
pub(super) fn reads_its_line_from_input<W: WordText>(
    program: W,
    mut argument_words: impl Iterator<Item = W> + Clone,
) -> bool {
    match line_handing(program) {
        Some(LineHanding::Program(ShellLineProgram::Source)) => argument_words
            .find(|word| !word.is("--"))
            .is_none_or(names_the_input),
        Some(LineHanding::Program(ShellLineProgram::Su)) => {
            su_command_strings(&argument_words).is_empty()
        }
        Some(LineHanding::Shell(grammar)) => match grammar {
            ShellGrammar::Posix(options_with_value) => operand_reads_input(
                posix_shell_operand(argument_words.clone(), options_with_value),
                argument_words,
            ),
            ShellGrammar::Csh => {
                operand_reads_input(csh_operand(argument_words.clone()), argument_words)
            }
            ShellGrammar::Fish => {
                line_option_values(argument_words.clone(), FISH_OPTIONS, |_, _| false).is_empty()
                    && first_operand(argument_words.clone(), &FISH_OPTIONS)
                        .is_none_or(|index| argument_words.nth(index).is_some_and(names_the_input))
            }
            ShellGrammar::Cmd | ShellGrammar::PowerShell => false,
        },
        Some(LineHanding::Program(_) | LineHanding::BraceGroup) | None => false,
    }
}

/// Whether `program` is a listed shell or `eval`, whose line a scan of a line not read whole
/// reads again.
pub(super) fn runs_its_words_as_a_line(program: impl WordText) -> bool {
    matches!(
        line_handing(program),
        Some(LineHanding::Shell(_) | LineHanding::Program(ShellLineProgram::Eval))
    )
}

// Whether a shell reading `operand` reads its line from its input: no operand, `-s`, or a script
// operand that names the input.
fn operand_reads_input<W: WordText>(
    operand: ShellOperand,
    mut argument_words: impl Iterator<Item = W>,
) -> bool {
    match operand {
        ShellOperand::CommandString(_) | ShellOperand::Nothing => false,
        ShellOperand::Script(index) => argument_words.nth(index).is_some_and(names_the_input),
        ShellOperand::Input => true,
    }
}

// The paths that name a program's own input, as their segments read once `.`, `..` and repeated
// slashes are folded.
const INPUT_PATHS: &[&[&str]] = &[
    &["dev", "stdin"],
    &["dev", "fd", "0"],
    &["proc", "self", "fd", "0"],
];

// Whether `word` is a path the text spells that names the program's input, `/dev/stdin`,
// `/dev/fd/0` or `/proc/self/fd/0`, folded lexically: from the root, or from a relative path whose
// `..` climb past its start, which the root's folders are as far up as the run's folder may be.
fn names_the_input(word: impl WordText) -> bool {
    if !word.is_decided() {
        return false;
    }
    let path: String = word.chars().collect();
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
    (is_absolute || climbs_past_start) && INPUT_PATHS.contains(&segments.as_slice())
}

/// A listed program that hands a shell a line, and how its words make it.
#[derive(Clone, Copy)]
pub(super) enum ShellLineProgram {
    Eval,
    Su,
    Alias,
    /// A trap's line, its first operand.
    Trap,
    /// `watch`'s words after its options, which it joins into a line for `sh -c`.
    Watch(LineOptions),
    /// zsh's `emulate <shell> -c <line>`.
    Emulate,
    /// A program one of whose options names the line, as `compgen -C <line>` does.
    OptionLine(LineOptions),
    /// The shell's own runner of a file, `source` or `.`, whose file is not read.
    Source,
}

/// How a listed shell's words name the line it runs.
#[derive(Clone, Copy)]
pub(super) enum ShellGrammar {
    /// `-c` among its short options runs the first word after them; each `o` or `O` of a short
    /// cluster takes the next word, and so does each of these options.
    Posix(&'static [&'static str]),
    /// fish's `-c`/`--command` and `-C`/`--init-command` values.
    Fish,
    /// csh's and tcsh's `-c`, alone or in a cluster, runs the word after it; `-b` ends options.
    Csh,
    /// cmd's words after `/c`, `/k` or `/r`, joined.
    Cmd,
    /// PowerShell's words after `-Command` or `-c`, joined, or the value of `-Command:<line>`.
    PowerShell,
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

// fish's options: those whose value is a line, and those that take any other value.
const FISH_OPTIONS: LineOptions = LineOptions {
    options_naming_the_line: &["-c", "--command", "-C", "--init-command"],
    options_with_value: &[
        "-d",
        "--debug",
        "-o",
        "--debug-output",
        "-p",
        "--profile",
        "-f",
        "--features",
    ],
    ..NO_OPTIONS
};

// How a listed program's words make the lines it hands a shell.
#[derive(Clone, Copy)]
enum LineHanding {
    Program(ShellLineProgram),
    // A wrapper's `{ <list> }` after its operand, as zsh's `repeat <count> { <list> }` runs.
    BraceGroup,
    Shell(ShellGrammar),
}

fn line_handing(program: impl WordText) -> Option<LineHanding> {
    match listed_program(program)? {
        ListedProgram::Shell(grammar) => Some(LineHanding::Shell(grammar)),
        ListedProgram::LineProgram(line_program) => Some(LineHanding::Program(line_program)),
        ListedProgram::Wrapper(wrapper) => match wrapper.line_options() {
            Some(options) => Some(LineHanding::Program(ShellLineProgram::OptionLine(options))),
            None => wrapper
                .runs_a_brace_group()
                .then_some(LineHanding::BraceGroup),
        },
        ListedProgram::Find
        | ListedProgram::Interpreter
        | ListedProgram::Git
        | ListedProgram::FileRemover
        | ListedProgram::ScriptRunner => None,
    }
}

// The options every POSIX-style shell reads with the next word as their value.
const SHELL_OPTIONS_WITH_VALUE: &[&str] = &["--rcfile", "--init-file"];
// The options with which a shell prints and exits, reading no line.
const SHELL_OPTIONS_RUNNING_NOTHING: &[&str] = &["--version", "--help"];

// The lines a shell of `grammar` runs from its `end` argument words.
fn shell_strings<W: WordText>(
    grammar: ShellGrammar,
    argument_words: impl Iterator<Item = W> + Clone,
    end: usize,
) -> Vec<CommandStringWords> {
    let operand = match grammar {
        ShellGrammar::Posix(options_with_value) => {
            posix_shell_operand(argument_words, options_with_value)
        }
        ShellGrammar::Csh => csh_operand(argument_words),
        ShellGrammar::Fish => {
            return line_option_values(argument_words, FISH_OPTIONS, |_, _| false);
        }
        ShellGrammar::Cmd => {
            return argument_words
                .enumerate()
                .find(|&(_, word)| {
                    ["/c", "/k", "/r"]
                        .iter()
                        .any(|switch| is_ignoring_case(word, switch))
                })
                .map(|(index, _)| CommandStringWords::Joined {
                    from: index + 1,
                    end,
                })
                .into_iter()
                .collect();
        }
        ShellGrammar::PowerShell => {
            return powershell_line(argument_words, end).into_iter().collect();
        }
    };
    match operand {
        ShellOperand::CommandString(index) => vec![CommandStringWords::One {
            index,
            skipped_bytes: 0,
        }],
        ShellOperand::Nothing | ShellOperand::Script(_) | ShellOperand::Input => Vec::new(),
    }
}

// PowerShell's option that names its line in its own word, after the colon.
const POWERSHELL_ATTACHED_LINE_OPTION: &str = "-command:";

// PowerShell's line: the words after `-Command` or `-c`, joined, or the value `-Command:` holds in
// its own word; an encoded command or a file, named first, is not read.
fn powershell_line<W: WordText>(
    argument_words: impl Iterator<Item = W>,
    end: usize,
) -> Option<CommandStringWords> {
    for (index, word) in argument_words.enumerate() {
        if ["-command", "-c"]
            .iter()
            .any(|option| is_ignoring_case(word, option))
        {
            return Some(CommandStringWords::Joined {
                from: index + 1,
                end,
            });
        }
        if starts_with_ignoring_case(word, POWERSHELL_ATTACHED_LINE_OPTION) {
            return Some(CommandStringWords::One {
                index,
                skipped_bytes: POWERSHELL_ATTACHED_LINE_OPTION.len(),
            });
        }
        if ["-encodedcommand", "-e", "-ec", "-file", "-f"]
            .iter()
            .any(|option| is_ignoring_case(word, option))
        {
            return None;
        }
    }
    None
}

// Whether `word` is `text`, written in lower case, in any case.
fn is_ignoring_case(word: impl WordText, text: &str) -> bool {
    word.chars()
        .map(|character| character.to_ascii_lowercase())
        .eq(text.chars())
}

// Whether `word` starts with `prefix`, written in lower case, in any case.
fn starts_with_ignoring_case(word: impl WordText, prefix: &str) -> bool {
    let mut characters = word.chars().map(|character| character.to_ascii_lowercase());
    prefix
        .chars()
        .all(|expected| characters.next() == Some(expected))
}

// Where a shell takes the line it runs from.
#[derive(Clone, Copy)]
enum ShellOperand {
    // Its line option's string, the word at this index.
    CommandString(usize),
    // No line: a line option with no string after the options, which the shell refuses, or
    // `--version` or `--help`, with which it prints and exits.
    Nothing,
    // The script the word at this index names.
    Script(usize),
    // Its standard input: no operand follows the options, or `-s` is among them.
    Input,
}

// The first word after a POSIX-style shell's options, read as `-c` and `-s` among its short
// options make it, or none when an option runs nothing. Each `o` or `O` of a short cluster takes
// the next word as its value, as `-o posix` and `-co posix` do.
fn posix_shell_operand<W: WordText>(
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
        if SHELL_OPTIONS_RUNNING_NOTHING
            .iter()
            .any(|option| word.is(option))
        {
            return ShellOperand::Nothing;
        }
        if SHELL_OPTIONS_WITH_VALUE
            .iter()
            .chain(options_with_value)
            .any(|option| word.is(option))
        {
            words.next();
        } else if is_shell_option(word) {
            if word.starts_with("--") {
                continue;
            }
            let is_dash_cluster = word.starts_with("-");
            reads_command_string |= is_dash_cluster && word.contains(PositionedByte::LetterC);
            reads_input |= is_dash_cluster && word.chars().skip(1).any(|letter| letter == 's');
            let values = word
                .chars()
                .skip(1)
                .filter(|&letter| matches!(letter, 'o' | 'O'))
                .count();
            for _ in 0..values {
                words.next();
            }
        } else {
            break Some(index);
        }
    };
    match operand {
        Some(index) if reads_command_string => ShellOperand::CommandString(index),
        None if reads_command_string => ShellOperand::Nothing,
        Some(index) if !reads_input => ShellOperand::Script(index),
        Some(_) | None => ShellOperand::Input,
    }
}

// What csh and tcsh run: the word after a short cluster holding `c`, a script named after `-b` or
// the first word that is no option, or their input with no such word or with `-s`.
fn csh_operand<W: WordText>(argument_words: impl Iterator<Item = W>) -> ShellOperand {
    let mut reads_input = false;
    let mut words = argument_words.enumerate();
    while let Some((index, word)) = words.next() {
        if SHELL_OPTIONS_RUNNING_NOTHING
            .iter()
            .any(|option| word.is(option))
        {
            return ShellOperand::Nothing;
        }
        if word.is("-b") {
            return words.next().map_or(ShellOperand::Input, |(index, _)| {
                ShellOperand::Script(index)
            });
        }
        if !word.starts_with("-") || !is_shell_option(word) {
            return if reads_input {
                ShellOperand::Input
            } else {
                ShellOperand::Script(index)
            };
        }
        if word.contains(PositionedByte::LetterC) {
            return words.next().map_or(ShellOperand::Nothing, |(index, _)| {
                ShellOperand::CommandString(index)
            });
        }
        reads_input |= word.chars().skip(1).any(|letter| letter == 's');
    }
    ShellOperand::Input
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

// The values of `options`' line options in their order, as getopt reads a program's options: a
// long one by its name or a prefix of one, a short cluster up to the letter that takes a value,
// which is the rest of the cluster or the next word. Each word that is no option, `-` alone and
// `--` among them, goes to `on_operand` with its index, which answers whether options may follow
// it.
fn line_option_values<W: WordText>(
    argument_words: impl Iterator<Item = W>,
    options: LineOptions,
    mut on_operand: impl FnMut(usize, W) -> bool,
) -> Vec<CommandStringWords> {
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
    let mut lines = Vec::new();
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
            lines.extend(value);
        }
    }
    lines
}

// The index of the first operand after a program's options, read as `line_option_values` reads
// them, past a `--` that ends them.
fn first_operand<W: WordText>(
    argument_words: impl Iterator<Item = W>,
    options: &LineOptions,
) -> Option<usize> {
    let mut first = None;
    line_option_values(argument_words, *options, |index, word| {
        first = Some(if word.is("--") { index + 1 } else { index });
        false
    });
    first
}

// zsh's `emulate` runs, as the string of its `-c`, the first word after a short cluster holding
// `c` that is no option: past option words, each `-o` or `+o`, or a cluster holding `o`, with its
// value, and past one `-` or `--`, after which the next word is the string whatever it holds.
fn emulate_command_string<W: WordText>(argument_words: impl Iterator<Item = W>) -> Option<usize> {
    let mut words = argument_words.enumerate();
    let (_, cluster) = words.find(|(_, word)| {
        word.starts_with("-") && !word.starts_with("--") && word.contains(PositionedByte::LetterC)
    })?;
    let mut takes_value = names_emulate_option_with_value(cluster);
    for (index, word) in words.by_ref() {
        if std::mem::take(&mut takes_value) {
            continue;
        }
        if word.is("-") || word.is("--") {
            break;
        }
        if !is_shell_option(word) {
            return Some(index);
        }
        takes_value = names_emulate_option_with_value(word);
    }
    words.next().map(|(index, _)| index)
}

// Whether an option word of `emulate`, `-` or `+` and its letters, holds `o`, whose value, an
// option's name, is the next word.
fn names_emulate_option_with_value(word: impl WordText) -> bool {
    word.chars().skip(1).any(|letter| letter == 'o')
}

// The words of the list inside the first `{` word and its matching `}`, or the last word when no
// `}` closes it, as a line: zsh runs a wrapper's `{ <list> }` as the shell runs that list.
fn brace_group<W: WordText>(argument_words: impl Iterator<Item = W>) -> Option<CommandStringWords> {
    let mut words = argument_words.enumerate();
    let (open, _) = words.find(|(_, word)| word.is("{"))?;
    let mut depth = 0_usize;
    let mut end = open + 1;
    for (index, word) in words {
        end = index + 1;
        if word.is("{") {
            depth += 1;
        } else if word.is("}") {
            if depth == 0 {
                end = index;
                break;
            }
            depth -= 1;
        }
    }
    Some(CommandStringWords::Joined {
        from: open + 1,
        end,
    })
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
    let mut commands = line_option_values(argument_words.clone(), SU_OPTIONS, |index, word| {
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
    let mut strings: Vec<CommandStringWords> = commands.pop().into_iter().collect();
    for start in shell_words_from {
        let ShellOperand::CommandString(index) =
            posix_shell_operand(argument_words.clone().skip(start), &[])
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
