//! The programs that run the command after their own options and operands, such as `env -i`,
//! `sudo -u` or `timeout 5`, and how each reads its own words before the command's.

use std::collections::VecDeque;

use super::is_variable_assignment;
use super::words::{ShellWord, Word, WordBuilder, WordText, long_option_named, short_option_named};

/// How a program that runs the command after it reads its own words first: its options that take
/// a value (the rest of the short option's cluster, after a long option's `=`, or the next word);
/// those that split their value into the command's words; those with which it runs no command; the
/// letters whose optional value is only the rest of their cluster; whether it reads its short
/// options in clusters and `-` alone as an option; and the operand it takes before the command.
#[derive(Clone, Copy)]
pub(super) struct CommandWrapper {
    options_with_value: &'static [&'static str],
    split_string_options: &'static [&'static str],
    options_running_nothing: &'static [&'static str],
    letters_with_attached_value: &'static str,
    reads_clusters: bool,
    is_lone_dash_an_option: bool,
    leading_operand: LeadingOperand,
}

// The operand a wrapper takes after its options and before the command.
#[derive(Clone, Copy)]
enum LeadingOperand {
    Absent,
    AnyWord,
    // A word of digits alone, or one only the run decides; any other word is the command, as
    // `chrt`'s optional priority is.
    Digits,
}

// What a listed option does with the words after it.
#[derive(Clone, Copy)]
enum OptionKind {
    TakesValue,
    SplitsValue,
    RunsNothing,
}

// What an option word holds, as getopt reads it.
enum OptionWord {
    // Options that take no value, or one only the rest of their cluster holds.
    Flags,
    // An option whose value starts at this byte offset in the word, or is the next word when
    // `None`, and whether the value splits into the command's words.
    Value {
        splits: bool,
        attached_from: Option<usize>,
    },
    // An option with which the wrapper runs no command.
    RunsNothing,
}

/// Where a wrapper's own words leave the command it runs.
pub(super) enum WrapperRead {
    /// The command's program is the next word left, if any.
    CommandFollows,
    /// The wrapper itself is the program and the words left are its arguments: one of its
    /// options runs no command, env refuses its split string or has split as much as the line
    /// holds, or a word only the run decides stands where the wrapper reads an option that may
    /// take a value, or where a split string's word is read.
    WrapperIsProgram,
}

impl CommandWrapper {
    const fn new(options_with_value: &'static [&'static str]) -> Self {
        Self {
            options_with_value,
            split_string_options: &[],
            options_running_nothing: &[],
            letters_with_attached_value: "",
            reads_clusters: true,
            is_lone_dash_an_option: false,
            leading_operand: LeadingOperand::Absent,
        }
    }

    fn options(self) -> impl Iterator<Item = (&'static str, OptionKind)> + Clone {
        let with_kind = |options: &'static [&'static str], kind| {
            options.iter().map(move |&option| (option, kind))
        };
        with_kind(self.split_string_options, OptionKind::SplitsValue)
            .chain(with_kind(self.options_with_value, OptionKind::TakesValue))
            .chain(with_kind(
                self.options_running_nothing,
                OptionKind::RunsNothing,
            ))
    }

    // Whether an option word only the run decides can hide an option that takes a value, so the
    // word after it need not be the command.
    fn takes_values(self) -> bool {
        !self.options_with_value.is_empty() || !self.split_string_options.is_empty()
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
        match self {
            Self::TakesValue => OptionWord::Value {
                splits: false,
                attached_from,
            },
            Self::SplitsValue => OptionWord::Value {
                splits: true,
                attached_from,
            },
            Self::RunsNothing => OptionWord::RunsNothing,
        }
    }
}

// The duration comes before the command.
const TIMEOUT: CommandWrapper = CommandWrapper {
    leading_operand: LeadingOperand::AnyWord,
    ..CommandWrapper::new(&["-s", "--signal", "-k", "--kill-after"])
};

const NICE: CommandWrapper = CommandWrapper::new(&["-n", "--adjustment"]);

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
    ("nohup", CommandWrapper::new(&[])),
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
        CommandWrapper::new(&[
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
        ]),
    ),
    ("doas", CommandWrapper::new(&["-a", "-C", "-u"])),
    (
        "xargs",
        CommandWrapper {
            // GNU's `-i`, `-e` and `-l` take an optional value inside their own word.
            letters_with_attached_value: "iel",
            ..CommandWrapper::new(&[
                "-I",
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
                "-J",
                "-R",
                "-S",
            ])
        },
    ),
    (
        "stdbuf",
        CommandWrapper::new(&["-i", "--input", "-o", "--output", "-e", "--error"]),
    ),
    ("setsid", CommandWrapper::new(&[])),
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
];

/// The wrapper `program` names, if it is one.
pub(super) fn command_wrapper(program: ShellWord<'_>) -> Option<CommandWrapper> {
    COMMAND_WRAPPERS
        .iter()
        .find(|(name, _)| program.is(name))
        .map(|&(_, wrapper)| wrapper)
}

/// Takes a wrapper's own words off the front of `pending`: its options, an option's value and its
/// leading operand. `env -S` puts the words its value splits into in their place, whether the value
/// is the next word or attached, as in `-S'…'`, `-vS'…'` or `--split-string=…`, and reads them
/// again as its own arguments, assignments among them. Each word taken off is pushed on `taken`.
/// `is_program_undecided` is set when a word only the run decides may move which word is the
/// program: an undecided option word, a value or operand the shell can split, or a split string's
/// undecided program or assignment.
pub(super) fn take_wrapper_words(
    builder: &mut WordBuilder<'_>,
    wrapper: CommandWrapper,
    pending: &mut VecDeque<Word>,
    taken: &mut Vec<Word>,
    is_program_undecided: &mut bool,
) -> WrapperRead {
    let mut words = WrapperWords {
        pending,
        split_words: 0,
        taken,
    };
    let mut have_options_ended = false;
    while let Some(word) = words.front() {
        let view = builder.view(word);
        // env reads a split string's assignments before its program, and no option after one.
        if words.is_front_split() && is_variable_assignment(view) {
            *is_program_undecided |= !view.is_decided();
            words.pop_front();
            have_options_ended = true;
            continue;
        }
        let is_option = !have_options_ended
            && view.starts_with("-")
            && (!view.is("-") || wrapper.is_lone_dash_an_option);
        // A split string attached to its decided option, as in `-S"git $X"`, is split as env
        // splits it, its expansions left to the run.
        let splits_an_attached_value = !view.is_decided()
            && is_option
            && !words.is_front_split()
            && matches!(
                wrapper.option_word(view),
                OptionWord::Value { splits: true, attached_from: Some(bytes) }
                    if view.is_decided_through(bytes)
            );
        if !view.is_decided() && !splits_an_attached_value {
            // An option word's letters decide which later word is the program, and a split
            // string's program word is the program.
            *is_program_undecided |= is_option || words.is_front_split();
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
        let (splits, attached_from) = match wrapper.option_word(view) {
            OptionWord::RunsNothing => return WrapperRead::WrapperIsProgram,
            OptionWord::Flags => {
                words.pop_front();
                continue;
            }
            OptionWord::Value {
                splits,
                attached_from,
            } => (splits, attached_from),
        };
        words.pop_front();
        if !splits {
            if attached_from.is_none()
                && let Some(value) = words.pop_front()
            {
                *is_program_undecided |= builder.view(value).holds_unquoted_expansion();
            }
            continue;
        }
        let value = match attached_from {
            Some(bytes) => builder.word_after(word, bytes),
            None => words.pop_front(),
        };
        let Some(value) = value else {
            continue;
        };
        let Some(split_words) = builder.split_string(value) else {
            return WrapperRead::WrapperIsProgram;
        };
        words.push_split(split_words);
    }
    let takes_operand = match wrapper.leading_operand {
        LeadingOperand::Absent => false,
        LeadingOperand::AnyWord => true,
        LeadingOperand::Digits => words.front().is_some_and(|word| {
            let view = builder.view(word);
            !view.is_decided()
                || (view.len() > 0 && view.chars().all(|digit| digit.is_ascii_digit()))
        }),
    };
    if takes_operand && let Some(operand) = words.pop_front() {
        *is_program_undecided |= builder.view(operand).holds_unquoted_expansion();
    }
    WrapperRead::CommandFollows
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
