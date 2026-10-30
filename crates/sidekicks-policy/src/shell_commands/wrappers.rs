//! The programs that run the command after their own options and operands, such as `env -i`,
//! `sudo -u` or `timeout 5`, how each reads its own words before the command's, and what those
//! words hand the command from the wrapper's input.

use std::collections::VecDeque;

use super::command_string::{CommandStringWords, LineOptions, command_string_words};
use super::is_variable_assignment;
use super::words::{ShellWord, Word, WordBuilder, WordText, long_option_named, short_option_named};

/// How a program that runs the command after it reads its own words first: its options that take
/// a value (the rest of the short option's cluster, after a long option's `=`, or the next word);
/// its long options that take none, named so a prefix of a longer one is not read as that one;
/// those that split their value into the command's words; those whose value, or optional value
/// inside their own word, is a string the program replaces with its input's words; those with
/// which it runs no command; those with which it hands a shell a line in place of a command; those
/// whose value stands where the leading operand would; those whose optional value inside their own
/// word ends its input in place of `--`; the letters whose optional value is only the rest of
/// their cluster; whether it reads its short options in clusters and `-` alone as an option; the
/// operand it takes before the command; whether it appends its input's words to the command; and
/// when, given no command, it runs a shell that reads its input.
#[derive(Clone, Copy)]
pub(super) struct CommandWrapper {
    options_with_value: &'static [&'static str],
    flag_options: &'static [&'static str],
    split_string_options: &'static [&'static str],
    replacement_options: &'static [&'static str],
    optional_replacement_options: &'static [&'static str],
    options_running_nothing: &'static [&'static str],
    options_handing_a_line: &'static [&'static str],
    options_replacing_operand: &'static [&'static str],
    input_end_options: &'static [&'static str],
    letters_with_attached_value: &'static str,
    reads_clusters: bool,
    is_lone_dash_an_option: bool,
    leading_operand: LeadingOperand,
    appends_input_words: bool,
    shell_with_no_command: ShellWithNoCommand,
}

/// What the words before a command's program hand it from a wrapper's input, and whether the last
/// wrapper read, left with no command, runs a shell that reads its input.
#[derive(Default)]
pub(super) struct WrapperRegion {
    /// Whether the last wrapper read runs a shell reading its input when no command follows it.
    pub(super) runs_a_shell_with_no_command: bool,
    // Whether a wrapper appends its input's words to the command.
    appends_input_words: bool,
    // The strings a wrapper replaces with its input's words; `None` for one the run decides.
    replacements: Vec<Option<String>>,
}

// The default string xargs replaces when its optional replacement option names none.
const DEFAULT_REPLACEMENT: &str = "{}";

// The operand a wrapper takes after its options and before the command.
#[derive(Clone, Copy)]
enum LeadingOperand {
    Absent,
    AnyWord,
    // A word of digits alone, or one only the run decides; any other word is the command, as
    // `chrt`'s optional priority is.
    Digits,
    // The input words up to and including the word that ends them, `--` unless an option names
    // another, as zsh's `zargs` reads them; with no such word there is no command.
    InputUpToItsEnd,
}

// When a wrapper given no command runs a shell that reads its input: never, always, as `chroot`
// and `script` do, or with one of these options, as `sudo -s` does.
#[derive(Clone, Copy)]
enum ShellWithNoCommand {
    Never,
    Always,
    WithOption(&'static [&'static str]),
}

// The word that ends a wrapper's input words before its command, as `zargs` reads it.
const DEFAULT_INPUT_END: &str = "--";

// What a listed option does with the words after it.
#[derive(Clone, Copy)]
enum OptionKind {
    TakesValue,
    Flag,
    SplitsValue,
    Replaces,
    ReplacesOptionally,
    RunsNothing,
    HandsALine,
    ReplacesOperand,
    EndsInput,
}

// What an option's value is to the wrapper.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ValueRole {
    Plain,
    // It splits into the command's words.
    Splits,
    // The wrapper replaces it with its input's words wherever the command holds it.
    Replaces,
}

// What an option word holds, as getopt reads it.
enum OptionWord {
    // Options that take no value, or one only the rest of their cluster holds.
    Flags,
    // An option whose value starts at this byte offset in the word, or is the next word when
    // `None`, and what the value is to the wrapper.
    Value {
        role: ValueRole,
        attached_from: Option<usize>,
    },
    // An option whose replacement string is the rest of its word from this byte offset, or the
    // default one when `None`.
    OptionalReplacement {
        attached_from: Option<usize>,
    },
    // An option with which the wrapper runs no command.
    RunsNothing,
    // An option with which the wrapper hands a shell a line in place of a command.
    HandsALine,
    // An option whose value, from this byte offset in the word or the next word when `None`,
    // stands where the leading operand would.
    OperandValue {
        attached_from: Option<usize>,
    },
    // An option naming the word that ends the input words, the rest of its word from this byte
    // offset, or no such word when `None`.
    InputEnd {
        attached_from: Option<usize>,
    },
}

/// Where a wrapper's own words leave the command it runs.
pub(super) enum WrapperRead {
    /// The command's program is the next word left, if any.
    CommandFollows,
    /// The wrapper itself is the program and the words left are its arguments: one of its
    /// options runs no command or hands a shell a line in its place, env refuses its split string
    /// or only the run decides what env makes of it, or a word only the run decides stands where
    /// the wrapper reads an option that may take a value, or where a split string's word is read.
    WrapperIsProgram,
}

impl CommandWrapper {
    /// How the wrapper's options name the line it hands a shell in place of its command, as
    /// `script -c <line>` does, read past its operands; `None` for a wrapper with no such option.
    pub(super) fn line_options(self) -> Option<LineOptions> {
        (!self.options_handing_a_line.is_empty()).then_some(LineOptions {
            options_naming_the_line: self.options_handing_a_line,
            options_with_value: self.options_with_value,
            letters_with_attached_value: self.letters_with_attached_value,
            reads_past_operands: true,
        })
    }

    const fn new(options_with_value: &'static [&'static str]) -> Self {
        Self {
            options_with_value,
            flag_options: &[],
            split_string_options: &[],
            replacement_options: &[],
            optional_replacement_options: &[],
            options_running_nothing: &[],
            options_handing_a_line: &[],
            options_replacing_operand: &[],
            input_end_options: &[],
            letters_with_attached_value: "",
            reads_clusters: true,
            is_lone_dash_an_option: false,
            leading_operand: LeadingOperand::Absent,
            appends_input_words: false,
            shell_with_no_command: ShellWithNoCommand::Never,
        }
    }

    fn options(self) -> impl Iterator<Item = (&'static str, OptionKind)> + Clone {
        let with_kind = |options: &'static [&'static str], kind| {
            options.iter().map(move |&option| (option, kind))
        };
        with_kind(self.split_string_options, OptionKind::SplitsValue)
            .chain(with_kind(self.options_with_value, OptionKind::TakesValue))
            .chain(with_kind(self.flag_options, OptionKind::Flag))
            .chain(with_kind(self.replacement_options, OptionKind::Replaces))
            .chain(with_kind(
                self.optional_replacement_options,
                OptionKind::ReplacesOptionally,
            ))
            .chain(with_kind(
                self.options_running_nothing,
                OptionKind::RunsNothing,
            ))
            .chain(with_kind(
                self.options_handing_a_line,
                OptionKind::HandsALine,
            ))
            .chain(with_kind(
                self.options_replacing_operand,
                OptionKind::ReplacesOperand,
            ))
            .chain(with_kind(self.input_end_options, OptionKind::EndsInput))
    }

    // Whether an option word only the run decides can hide an option that takes a value, so the
    // word after it need not be the command.
    fn takes_values(self) -> bool {
        !self.options_with_value.is_empty()
            || !self.split_string_options.is_empty()
            || !self.replacement_options.is_empty()
            || !self.options_replacing_operand.is_empty()
    }

    // Whether the option word `word` names one of the options with which the wrapper, given no
    // command, runs a shell: a long one by its name or a prefix of it alone, or a letter of a short
    // cluster before the first that takes a value.
    fn names_a_shell_option(self, word: ShellWord<'_>) -> bool {
        let ShellWithNoCommand::WithOption(shell_options) = self.shell_with_no_command else {
            return false;
        };
        if word.starts_with("--") {
            let shell = shell_options.iter().map(|&option| (option, true));
            let other = self
                .options()
                .filter(|(option, _)| !shell_options.contains(option))
                .map(|(option, _)| (option, false));
            return long_option_named(word, shell.chain(other))
                .is_some_and(|(is_shell, _)| is_shell);
        }
        let names_letter = |options: &[&str], letter: char| {
            options.iter().any(|option| {
                let mut characters = option.chars();
                characters.next() == Some('-')
                    && characters.next() == Some(letter)
                    && characters.next().is_none()
            })
        };
        for letter in word.chars().skip(1) {
            if names_letter(shell_options, letter) {
                return true;
            }
            let takes_value = self.letters_with_attached_value.contains(letter)
                || self.options().any(|(option, kind)| {
                    !matches!(kind, OptionKind::Flag) && names_letter(&[option], letter)
                });
            if takes_value {
                return false;
            }
        }
        false
    }

    // What the option word `word` holds, as getopt reads it: a long option by its whole name or by
    // a prefix of exactly one listed long option, and a short cluster up to the first letter that
    // takes a value or runs nothing; a wrapper that reads no clusters lists its options whole.
    fn option_word(self, word: ShellWord<'_>) -> OptionWord {
        if !self.reads_clusters {
            return self
                .options()
                .find(|&(option, _)| word.is(option))
                .map_or(OptionWord::Flags, |(_, kind)| kind.option_word(None));
        }
        if word.starts_with("--") {
            return long_option_named(word, self.options())
                .map_or(OptionWord::Flags, |(kind, attached_from)| {
                    kind.option_word(attached_from)
                });
        }
        short_option_named(word, &self.options(), self.letters_with_attached_value)
            .map_or(OptionWord::Flags, |(kind, attached_from)| {
                kind.option_word(attached_from)
            })
    }
}

impl OptionKind {
    fn option_word(self, attached_from: Option<usize>) -> OptionWord {
        let value = |role| OptionWord::Value {
            role,
            attached_from,
        };
        match self {
            Self::TakesValue => value(ValueRole::Plain),
            Self::Flag => OptionWord::Flags,
            Self::SplitsValue => value(ValueRole::Splits),
            Self::Replaces => value(ValueRole::Replaces),
            Self::ReplacesOptionally => OptionWord::OptionalReplacement { attached_from },
            Self::RunsNothing => OptionWord::RunsNothing,
            Self::HandsALine => OptionWord::HandsALine,
            Self::ReplacesOperand => OptionWord::OperandValue { attached_from },
            Self::EndsInput => OptionWord::InputEnd { attached_from },
        }
    }
}

// The duration comes before the command.
const TIMEOUT: CommandWrapper = CommandWrapper {
    leading_operand: LeadingOperand::AnyWord,
    ..CommandWrapper::new(&["-s", "--signal", "-k", "--kill-after"])
};

const NICE: CommandWrapper = CommandWrapper::new(&["-n", "--adjustment"]);

// A program that runs the command after it and reads no option of its own that takes a value:
// bash's and zsh's `builtin`, zsh's precommand modifiers, and `nohup` and `setsid`.
const NO_VALUE_WRAPPER: CommandWrapper = CommandWrapper::new(&[]);

// The programs that run the command after them, so the program is the word past their own.
const COMMAND_WRAPPERS: &[(&str, CommandWrapper)] = &[
    (
        "env",
        CommandWrapper {
            // `env -S` splits its value into words env reads as its own arguments, and `-` alone
            // empties the environment.
            split_string_options: &["-S", "--split-string"],
            is_lone_dash_an_option: true,
            ..CommandWrapper::new(&[
                "-u",
                "--unset",
                "-C",
                "--chdir",
                "-P",
                "-a",
                "--argv0",
                "--env0-from",
            ])
        },
    ),
    ("exec", CommandWrapper::new(&["-a"])),
    (
        "command",
        CommandWrapper {
            // `command -v` and `-V` print how the shell finds the command.
            options_running_nothing: &["-v", "-V"],
            ..CommandWrapper::new(&[])
        },
    ),
    ("nohup", NO_VALUE_WRAPPER),
    ("builtin", NO_VALUE_WRAPPER),
    ("noglob", NO_VALUE_WRAPPER),
    ("nocorrect", NO_VALUE_WRAPPER),
    ("-", NO_VALUE_WRAPPER),
    (
        "time",
        CommandWrapper::new(&["-o", "--output", "-f", "--format"]),
    ),
    ("timeout", TIMEOUT),
    ("gtimeout", TIMEOUT),
    ("nice", NICE),
    ("gnice", NICE),
    (
        "sudo",
        CommandWrapper {
            // `-s` and `-i` with no command run the target user's shell, which reads its input.
            shell_with_no_command: ShellWithNoCommand::WithOption(&[
                "-s", "--shell", "-i", "--login",
            ]),
            // The long options that take no value, so `--login` is not read as `--login-class`.
            flag_options: &[
                "--login",
                "--shell",
                "--preserve-env",
                "--background",
                "--non-interactive",
                "--stdin",
                "--validate",
                "--list",
                "--remove-timestamp",
                "--reset-timestamp",
                "--set-home",
                "--askpass",
                "--bell",
                "--edit",
                "--kill",
                "--version",
                "--help",
            ],
            ..CommandWrapper::new(&[
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
                "-a",
                "--auth-type",
                "-c",
                "--login-class",
            ])
        },
    ),
    (
        "doas",
        CommandWrapper {
            shell_with_no_command: ShellWithNoCommand::WithOption(&["-s"]),
            ..CommandWrapper::new(&["-a", "-C", "-u"])
        },
    ),
    (
        "xargs",
        CommandWrapper {
            // `-I` and BSD's `-J` name the string xargs replaces with its input's words, and so
            // do GNU's `-i` and `--replace`, `{}` when their own word names none; with neither,
            // xargs appends those words to the command.
            replacement_options: &["-I", "-J"],
            optional_replacement_options: &["-i", "--replace"],
            appends_input_words: true,
            // GNU's `-e` and `-l` take an optional value inside their own word.
            letters_with_attached_value: "el",
            ..CommandWrapper::new(&[
                "-L",
                "-n",
                "--max-args",
                "-P",
                "--max-procs",
                "--process-slot-var",
                "-s",
                "--max-chars",
                "-d",
                "--delimiter",
                "-E",
                "-a",
                "--arg-file",
                "-R",
                "-S",
            ])
        },
    ),
    (
        "stdbuf",
        CommandWrapper::new(&["-i", "--input", "-o", "--output", "-e", "--error"]),
    ),
    ("setsid", NO_VALUE_WRAPPER),
    (
        "ionice",
        CommandWrapper::new(&[
            "-c",
            "--class",
            "-n",
            "--classdata",
            "-p",
            "--pid",
            "-P",
            "--pgid",
            "-u",
            "--uid",
        ]),
    ),
    (
        "chrt",
        CommandWrapper {
            // `chrt -p` sets an existing process's policy; a priority may come before the command.
            options_running_nothing: &["-p", "--pid"],
            leading_operand: LeadingOperand::Digits,
            ..CommandWrapper::new(&[
                "-T",
                "--sched-runtime",
                "-P",
                "--sched-period",
                "-D",
                "--sched-deadline",
                "-U",
                "--clamp-min",
                "-X",
                "--clamp-max",
            ])
        },
    ),
    (
        "taskset",
        CommandWrapper {
            // `taskset -p` sets an existing process's affinity; the mask comes before the command.
            options_running_nothing: &["-p", "--pid"],
            leading_operand: LeadingOperand::AnyWord,
            ..CommandWrapper::new(&[])
        },
    ),
    ("caffeinate", CommandWrapper::new(&["-t", "-w"])),
    (
        "arch",
        CommandWrapper {
            // Each option is its own word, `-arm64` an architecture's name, never a cluster.
            reads_clusters: false,
            ..CommandWrapper::new(&["-arch", "-d", "-e"])
        },
    ),
    // zsh's `repeat <count> <command>`.
    (
        "repeat",
        CommandWrapper {
            leading_operand: LeadingOperand::AnyWord,
            ..CommandWrapper::new(&[])
        },
    ),
    (
        "zargs",
        CommandWrapper {
            // zsh's `zargs [options --] [input …] [-- command …]`: the command follows the word
            // that ends its input, which `-e<word>` or `--eof=<word>` names, and is handed the
            // input's words, at the end or where `-I` and `-i` name their string.
            replacement_options: &["-I"],
            optional_replacement_options: &["-i", "--replace"],
            input_end_options: &["-e", "--eof"],
            letters_with_attached_value: "l",
            leading_operand: LeadingOperand::InputUpToItsEnd,
            appends_input_words: true,
            ..CommandWrapper::new(&[
                "-n",
                "--max-args",
                "-s",
                "--max-chars",
                "-L",
                "-P",
                "--max-procs",
            ])
        },
    ),
    (
        "chroot",
        CommandWrapper {
            // The new root comes before the command; with none after it, a shell runs there.
            leading_operand: LeadingOperand::AnyWord,
            shell_with_no_command: ShellWithNoCommand::Always,
            ..CommandWrapper::new(&["-G", "-g", "-u", "--groups", "--userspec"])
        },
    ),
    (
        "sandbox-exec",
        CommandWrapper::new(&["-f", "-n", "-p", "-D"]),
    ),
    (
        "script",
        CommandWrapper {
            // macOS's `script [options] [file [command …]]` and `-p`'s playback, which runs
            // nothing; util-linux's `script -c <line> [file]`, which hands a shell the line.
            options_running_nothing: &["-p"],
            options_handing_a_line: &["-c", "--command"],
            leading_operand: LeadingOperand::AnyWord,
            // With no command or line, a shell runs under the recording.
            shell_with_no_command: ShellWithNoCommand::Always,
            ..CommandWrapper::new(&[
                "-t",
                "-T",
                "-B",
                "--log-io",
                "-E",
                "--echo",
                "-I",
                "--log-in",
                "-O",
                "--log-out",
                "--log-timing",
                "-m",
                "--logging-format",
                "-o",
                "--output-limit",
            ])
        },
    ),
    (
        "flock",
        CommandWrapper {
            // `flock <file> <command>`, `flock <file> -c <line>`, and `--fd <number>` in place
            // of the file.
            options_handing_a_line: &["-c", "--command"],
            options_replacing_operand: &["--fd"],
            leading_operand: LeadingOperand::AnyWord,
            ..CommandWrapper::new(&[
                "-w",
                "--wait",
                "--timeout",
                "-E",
                "--conflict-exit-code",
                "--start",
                "--length",
            ])
        },
    ),
];

/// The wrapper `program` names, if it is one.
pub(super) fn command_wrapper(program: impl WordText) -> Option<CommandWrapper> {
    COMMAND_WRAPPERS
        .iter()
        .find(|(name, _)| program.is(name))
        .map(|&(_, wrapper)| wrapper)
}

/// Takes a wrapper's own words off the front of `pending`: its options, an option's value and its
/// leading operand. `env -S` puts the words its value splits into in their place, whether the value
/// is the next word or attached, as in `-S'…'`, `-vS'…'` or `--split-string=…`, and reads them
/// again as its own arguments, assignments among them. Each word taken off is pushed on `taken`.
/// A word only the run decides where an option that may take a value is read, or where a split
/// string's word is, leaves the wrapper the program, as does a split string env refuses or only
/// the run decides. `region` keeps whether the wrapper, left with no command, runs a shell.
pub(super) fn take_wrapper_words(
    builder: &mut WordBuilder<'_>,
    wrapper: CommandWrapper,
    pending: &mut VecDeque<Word>,
    taken: &mut Vec<Word>,
    region: &mut WrapperRegion,
) -> WrapperRead {
    let mut words = WrapperWords {
        pending,
        split_words: 0,
        taken,
    };
    let mut have_options_ended = false;
    let mut is_operand_replaced = false;
    let mut input_end = Some(DEFAULT_INPUT_END.to_owned());
    let mut runs_a_shell = false;
    while let Some(word) = words.front() {
        let view = builder.view(word);
        // env reads a split string's assignments before its program, and no option after one.
        if words.is_front_split() && is_variable_assignment(view) {
            words.pop_front();
            have_options_ended = true;
            continue;
        }
        let is_option = !have_options_ended
            && view.starts_with("-")
            && (!view.is("-") || wrapper.is_lone_dash_an_option);
        // A decided option with its value attached that the shell passes as one word, as in
        // `-u"$U"` or `-S"git $X"`, whose value env splits as it splits any.
        let is_option_with_quoted_value = is_option
            && !view.holds_unquoted_expansion()
            && matches!(
                wrapper.option_word(view),
                OptionWord::Value { attached_from: Some(bytes), .. }
                    | OptionWord::OptionalReplacement { attached_from: Some(bytes) }
                    | OptionWord::OperandValue { attached_from: Some(bytes) }
                    if view.is_decided_through(bytes)
            );
        if !view.is_decided() && !is_option_with_quoted_value {
            // Any other word is an assignment, the leading operand or the program.
            if words.is_front_split() || (is_option && wrapper.takes_values()) {
                return WrapperRead::WrapperIsProgram;
            }
            if !is_option {
                break;
            }
            // A letter an expansion makes is no option of the wrapper's this read can name.
            words.pop_front();
            continue;
        }
        if !is_option {
            break;
        }
        if view.is("--") {
            words.pop_front();
            have_options_ended = true;
            continue;
        }
        let option_word = wrapper.option_word(view);
        runs_a_shell |= wrapper.names_a_shell_option(view);
        if matches!(
            option_word,
            OptionWord::RunsNothing | OptionWord::HandsALine
        ) {
            return WrapperRead::WrapperIsProgram;
        }
        words.pop_front();
        let (role, attached_from) = match option_word {
            OptionWord::RunsNothing | OptionWord::HandsALine | OptionWord::Flags => continue,
            OptionWord::OperandValue { attached_from } => {
                is_operand_replaced = true;
                if attached_from.is_none() {
                    words.pop_front();
                }
                continue;
            }
            OptionWord::InputEnd { attached_from } => {
                input_end = attached_from.map(|bytes| view.to_string().split_off(bytes));
                continue;
            }
            OptionWord::OptionalReplacement { attached_from } => {
                region
                    .replacements
                    .push(view.is_decided().then(|| match attached_from {
                        Some(bytes) => view.to_string().split_off(bytes),
                        None => DEFAULT_REPLACEMENT.to_owned(),
                    }));
                continue;
            }
            OptionWord::Value {
                role,
                attached_from,
            } => (role, attached_from),
        };
        let value = match attached_from {
            Some(bytes) if role == ValueRole::Splits => builder.word_after(word, bytes),
            Some(bytes) => {
                if role == ValueRole::Replaces {
                    let replacement = view.is_decided().then(|| view.to_string().split_off(bytes));
                    region.replacements.push(replacement);
                }
                continue;
            }
            None => {
                let Some(value) = words.pop_front() else {
                    continue;
                };
                let value_view = builder.view(value);
                if role == ValueRole::Replaces {
                    let replacement = value_view.is_decided().then(|| value_view.to_string());
                    region.replacements.push(replacement);
                }
                (role == ValueRole::Splits).then_some(value)
            }
        };
        let Some(value) = value else {
            continue;
        };
        match builder.split_string(value) {
            Some(split_words) => words.push_split(split_words),
            None => return WrapperRead::WrapperIsProgram,
        }
    }
    let operand_words = match wrapper.leading_operand {
        _ if is_operand_replaced => 0,
        LeadingOperand::Absent => 0,
        LeadingOperand::AnyWord => 1,
        LeadingOperand::Digits => usize::from(words.front().is_some_and(|word| {
            let view = builder.view(word);
            !view.is_decided()
                || (view.len() > 0 && view.chars().all(|digit| digit.is_ascii_digit()))
        })),
        LeadingOperand::InputUpToItsEnd => {
            let end = input_end.as_deref();
            words
                .pending
                .iter()
                .position(|&word| end.is_some_and(|end| builder.view(word).is(end)))
                .map_or(words.pending.len(), |position| position + 1)
        }
    };
    for _ in 0..operand_words {
        words.pop_front();
    }
    // A line option after the operand, as `flock <file> -c <line>` takes it.
    if let Some(word) = words.front() {
        let view = builder.view(word);
        if view.starts_with("-") && matches!(wrapper.option_word(view), OptionWord::HandsALine) {
            return WrapperRead::WrapperIsProgram;
        }
    }
    region.appends_input_words |= wrapper.appends_input_words;
    region.runs_a_shell_with_no_command = match wrapper.shell_with_no_command {
        ShellWithNoCommand::Never => false,
        ShellWithNoCommand::Always => true,
        ShellWithNoCommand::WithOption(_) => runs_a_shell,
    };
    WrapperRead::CommandFollows
}

impl WrapperRegion {
    /// Whether a wrapper read so far hands the command after it words from its input.
    pub(super) fn takes_input_words(&self) -> bool {
        self.appends_input_words || !self.replacements.is_empty()
    }

    /// Reads into the command whose program is `words[program]`, its arguments the words after
    /// it, what a wrapper before it takes from its input: each word holding a string the wrapper
    /// replaces becomes one only the run decides, as every word does when the run decides that
    /// string, and the words it appends are one more such word. Answers whether a line the
    /// command hands a shell holds the input's words.
    pub(super) fn read_input_words(
        &self,
        builder: &mut WordBuilder<'_>,
        words: &mut Vec<Word>,
        program: usize,
    ) -> bool {
        if !self.takes_input_words() {
            return false;
        }
        for word in &mut words[program..] {
            let text = builder.view(*word).to_string();
            let holds_replacement = self.replacements.iter().any(|replacement| {
                replacement
                    .as_deref()
                    .is_none_or(|replacement| text.contains(replacement))
            });
            if holds_replacement {
                *word = builder.push_undecided_copy(*word);
            }
        }
        if self.appends_input_words {
            words.push(builder.push_input_word());
        }
        let arguments = &words[program + 1..];
        let program = builder.view(words[program]);
        let argument_words = || arguments.iter().map(|&word| builder.view(word));
        command_string_words(program, argument_words())
            .into_iter()
            .any(|string| match string {
                CommandStringWords::Joined { from } => {
                    argument_words().skip(from).any(|word| !word.is_decided())
                }
                CommandStringWords::One { index, .. } => {
                    !builder.view(arguments[index]).is_decided()
                }
            })
    }
}

// The words left of a command, how many at their front a split string made, and the words taken
// off as the wrapper's own.
struct WrapperWords<'p> {
    pending: &'p mut VecDeque<Word>,
    split_words: usize,
    taken: &'p mut Vec<Word>,
}

impl WrapperWords<'_> {
    fn front(&self) -> Option<Word> {
        self.pending.front().copied()
    }

    // Takes off the front word as the wrapper's own.
    fn pop_front(&mut self) -> Option<Word> {
        self.split_words = self.split_words.saturating_sub(1);
        let word = self.pending.pop_front()?;
        self.taken.push(word);
        Some(word)
    }

    fn push_split(&mut self, split_words: Vec<Word>) {
        self.split_words += split_words.len();
        for word in split_words.into_iter().rev() {
            self.pending.push_front(word);
        }
    }

    fn is_front_split(&self) -> bool {
        self.split_words > 0
    }
}
