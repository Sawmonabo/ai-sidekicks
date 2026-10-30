//! The programs that run the command after their own options and operands, such as `env -i`,
//! `sudo -u` or `timeout 5`, how each reads its own words before the command's, and what those
//! words leave for the run to decide about the command.

use std::collections::VecDeque;

use super::command_string::{CommandStringWords, command_string_words};
use super::is_variable_assignment;
use super::words::{
    ShellWord, SplitString, Word, WordBuilder, WordText, long_option_named, short_option_named,
};

/// How a program that runs the command after it reads its own words first: its options that take
/// a value (the rest of the short option's cluster, after a long option's `=`, or the next word);
/// those that split their value into the command's words; those whose value, or optional value
/// inside their own word, is a string the program replaces with its input's words; those with
/// which it runs no command; the letters whose optional value is only the rest of their cluster;
/// whether it reads its short options in clusters and `-` alone as an option; the operand it takes
/// before the command; and whether it appends its input's words to the command.
#[derive(Clone, Copy)]
pub(super) struct CommandWrapper {
    options_with_value: &'static [&'static str],
    split_string_options: &'static [&'static str],
    replacement_options: &'static [&'static str],
    optional_replacement_options: &'static [&'static str],
    options_running_nothing: &'static [&'static str],
    letters_with_attached_value: &'static str,
    reads_clusters: bool,
    is_lone_dash_an_option: bool,
    leading_operand: LeadingOperand,
    appends_input_words: bool,
}

/// What the words before a command's program leave for the run to decide: whether the program
/// itself, and the strings a wrapper replaces with its input's words, if one does.
#[derive(Default)]
pub(super) struct WrapperRegion {
    /// Whether a word before the program, or the program word, lets only the run decide which
    /// program runs.
    pub(super) is_program_undecided: bool,
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
}

// What a listed option does with the words after it.
#[derive(Clone, Copy)]
enum OptionKind {
    TakesValue,
    SplitsValue,
    Replaces,
    ReplacesOptionally,
    RunsNothing,
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
}

/// Where a wrapper's own words leave the command it runs.
pub(super) enum WrapperRead {
    /// The command's program is the next word left, if any.
    CommandFollows,
    /// The wrapper itself is the program and the words left are its arguments: one of its
    /// options runs no command, env refuses its split string or only the run decides what env
    /// makes of it, or a word only the run decides stands where the wrapper reads an option that
    /// may take a value, or where a split string's word is read.
    WrapperIsProgram,
}

impl CommandWrapper {
    const fn new(options_with_value: &'static [&'static str]) -> Self {
        Self {
            options_with_value,
            split_string_options: &[],
            replacement_options: &[],
            optional_replacement_options: &[],
            options_running_nothing: &[],
            letters_with_attached_value: "",
            reads_clusters: true,
            is_lone_dash_an_option: false,
            leading_operand: LeadingOperand::Absent,
            appends_input_words: false,
        }
    }

    fn options(self) -> impl Iterator<Item = (&'static str, OptionKind)> + Clone {
        let with_kind = |options: &'static [&'static str], kind| {
            options.iter().map(move |&option| (option, kind))
        };
        with_kind(self.split_string_options, OptionKind::SplitsValue)
            .chain(with_kind(self.options_with_value, OptionKind::TakesValue))
            .chain(with_kind(self.replacement_options, OptionKind::Replaces))
            .chain(with_kind(
                self.optional_replacement_options,
                OptionKind::ReplacesOptionally,
            ))
            .chain(with_kind(
                self.options_running_nothing,
                OptionKind::RunsNothing,
            ))
    }

    // Whether an option word only the run decides can hide an option that takes a value, so the
    // word after it need not be the command.
    fn takes_values(self) -> bool {
        !self.options_with_value.is_empty()
            || !self.split_string_options.is_empty()
            || !self.replacement_options.is_empty()
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
            Self::SplitsValue => value(ValueRole::Splits),
            Self::Replaces => value(ValueRole::Replaces),
            Self::ReplacesOptionally => OptionWord::OptionalReplacement { attached_from },
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
/// The program stays decided only while each word taken is a decided literal, an assignment or an
/// option's value whose only undecided parts are double-quoted, or a decided option with such a
/// value attached; any other word only the run decides, a leading operand quoted or not among them,
/// sets `region.is_program_undecided`, and so does a split string only the run decides.
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
    while let Some(word) = words.front() {
        let view = builder.view(word);
        // env reads a split string's assignments before its program, and no option after one.
        if words.is_front_split() && is_variable_assignment(view) {
            region.is_program_undecided |= view.holds_unquoted_expansion();
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
                    if view.is_decided_through(bytes)
            );
        if !view.is_decided() && !is_option_with_quoted_value {
            // Any other word is an assignment, the leading operand or the program, each of which
            // its own reading marks.
            region.is_program_undecided |= is_option || words.is_front_split();
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
        if matches!(option_word, OptionWord::RunsNothing) {
            return WrapperRead::WrapperIsProgram;
        }
        words.pop_front();
        let (role, attached_from) = match option_word {
            OptionWord::RunsNothing | OptionWord::Flags => continue,
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
                region.is_program_undecided |= value_view.holds_unquoted_expansion();
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
            SplitString::Words(split_words) => words.push_split(split_words),
            SplitString::Refused => return WrapperRead::WrapperIsProgram,
            SplitString::Undecided => {
                region.is_program_undecided = true;
                return WrapperRead::WrapperIsProgram;
            }
        }
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
        region.is_program_undecided |= !builder.view(operand).is_decided();
    }
    region.appends_input_words |= wrapper.appends_input_words;
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
    /// string, and the words it appends are one more such word. The program is then undecided
    /// when the run decides its word, or a line it hands a shell holds the input's words.
    pub(super) fn read_input_words(
        &mut self,
        builder: &mut WordBuilder<'_>,
        words: &mut Vec<Word>,
        program: usize,
    ) {
        if !self.takes_input_words() {
            return;
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
        self.is_program_undecided |= !program.is_decided()
            || command_string_words(program, argument_words())
                .into_iter()
                .any(|string| match string {
                    CommandStringWords::Every => argument_words().any(|word| !word.is_decided()),
                    CommandStringWords::One { index, .. } => {
                        !builder.view(arguments[index]).is_decided()
                    }
                });
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
