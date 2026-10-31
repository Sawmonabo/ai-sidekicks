//! How a program that runs the command after its own options and operands, such as `env -i`,
//! `sudo -u` or `timeout 5`, reads its own words before the command's. The programs themselves are
//! entries of the list in `listed_programs`.

use std::collections::VecDeque;

use super::command_string::LineOptions;
use super::is_variable_assignment;
use super::words::{ShellWord, Word, WordBuilder, WordText, long_option_named, short_option_named};

/// How a program that runs the command after it reads its own words first: its options that take
/// a value (the rest of the short option's cluster, after a long option's `=`, or the next word);
/// its long options that take none, named so a prefix of a longer one is not read as that one;
/// those that split their value into the command's words; those with which it runs no command;
/// those with which it hands a shell a line in place of a command; those whose value stands where
/// the leading operand would; the letters whose optional value is only the rest of their cluster;
/// whether it reads its short options in clusters and `-` alone as an option; the operand it takes
/// before the command; when, given no command, it runs a shell that reads its input; and whether a
/// `{` after its operand opens a list it runs in place of a command.
#[derive(Clone, Copy)]
pub(super) struct CommandWrapper {
    pub(super) options_with_value: &'static [&'static str],
    pub(super) flag_options: &'static [&'static str],
    pub(super) split_string_options: &'static [&'static str],
    pub(super) options_running_nothing: &'static [&'static str],
    pub(super) options_handing_a_line: &'static [&'static str],
    pub(super) options_replacing_operand: &'static [&'static str],
    pub(super) letters_with_attached_value: &'static str,
    pub(super) reads_clusters: bool,
    pub(super) is_lone_dash_an_option: bool,
    pub(super) leading_operand: LeadingOperand,
    pub(super) shell_with_no_command: ShellWithNoCommand,
}

/// The operand a wrapper takes after its options and before the command.
#[derive(Clone, Copy)]
pub(super) enum LeadingOperand {
    Absent,
    AnyWord,
    /// Any word, after which a `{` opens the list the wrapper runs in place of a command, as zsh's
    /// `repeat <count> { <list> }` reads one.
    AnyWordBeforeList,
    /// A word of digits alone, or one only the run decides; any other word is the command, as
    /// `chrt`'s optional priority is.
    Digits,
    /// The words up to and including the next `--`, as zsh's `zargs` reads its input list before
    /// its command; with no such word there is no command.
    WordsUpToTheirEnd,
}

/// When a wrapper given no command runs a shell that reads its input: never, always, as `chroot`
/// and `script` do, or with one of these options, as `sudo -s` does.
#[derive(Clone, Copy)]
pub(super) enum ShellWithNoCommand {
    Never,
    Always,
    WithOption(&'static [&'static str]),
}

// The word that ends zargs's input list before its command.
const INPUT_LIST_END: &str = "--";

// What a listed option does with the words after it.
#[derive(Clone, Copy)]
enum OptionKind {
    TakesValue,
    Flag,
    SplitsValue,
    RunsNothing,
    HandsALine,
    ReplacesOperand,
}

// What an option word holds, as getopt reads it.
enum OptionWord {
    // Options that take no value, or one only the rest of their cluster holds.
    Flags,
    // An option whose value starts at this byte offset in the word, or is the next word when
    // `None`, and whether the wrapper splits it into the command's words.
    Value {
        splits: bool,
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
}

/// Where a wrapper's own words leave the command it runs.
pub(super) enum WrapperRead {
    /// The command's program is the next word left, if any; with none left, the wrapper is the
    /// program, and runs a shell reading its input when `runs_a_shell_with_no_command` holds.
    CommandFollows { runs_a_shell_with_no_command: bool },
    /// The wrapper itself is the program and the words left are its arguments: one of its
    /// options runs no command or hands a shell a line in its place, a `{` after its operand opens
    /// the list it runs, env refuses its split string or only the run decides what env makes of
    /// it, or a word only the run decides stands where the wrapper reads an option that may take a
    /// value, or where a split string's word is read.
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

    /// The value the option word `word` takes, as the wrapper reads it: inside the word from this
    /// byte offset, or the next word when `None`, and whether the wrapper splits it into its own
    /// words, as `env -S` does; `None` for an option that takes no value of its own.
    pub(super) fn option_value(self, word: &str) -> Option<(Option<usize>, bool)> {
        match self.option_word(word) {
            OptionWord::Value {
                splits,
                attached_from,
            } => Some((attached_from, splits)),
            OptionWord::OperandValue { attached_from } => Some((attached_from, false)),
            OptionWord::Flags | OptionWord::RunsNothing | OptionWord::HandsALine => None,
        }
    }

    /// A wrapper whose options that take a value are `options_with_value`, with no other option
    /// listed, no operand and no shell of its own.
    pub(super) const fn new(options_with_value: &'static [&'static str]) -> Self {
        Self {
            options_with_value,
            flag_options: &[],
            split_string_options: &[],
            options_running_nothing: &[],
            options_handing_a_line: &[],
            options_replacing_operand: &[],
            letters_with_attached_value: "",
            reads_clusters: true,
            is_lone_dash_an_option: false,
            leading_operand: LeadingOperand::Absent,
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
    }

    /// Whether a `{` word after the wrapper's operand opens a list it runs, up to the matching `}`,
    /// in place of a command, as zsh's `repeat <count> { <list> }` does.
    pub(super) fn runs_a_brace_group(self) -> bool {
        matches!(self.leading_operand, LeadingOperand::AnyWordBeforeList)
    }

    // Whether an option word only the run decides can hide an option that takes a value, so the
    // word after it need not be the command.
    fn takes_values(self) -> bool {
        !self.options_with_value.is_empty()
            || !self.split_string_options.is_empty()
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
            // A value after `=` on an option that takes none is an error, which runs nothing.
            return long_option_named(word, shell.chain(other))
                .is_some_and(|(is_shell, attached_from)| is_shell && attached_from.is_none());
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
    fn option_word(self, word: impl WordText) -> OptionWord {
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
            Self::Flag => OptionWord::Flags,
            Self::SplitsValue => OptionWord::Value {
                splits: true,
                attached_from,
            },
            Self::RunsNothing => OptionWord::RunsNothing,
            Self::HandsALine => OptionWord::HandsALine,
            Self::ReplacesOperand => OptionWord::OperandValue { attached_from },
        }
    }
}

/// Takes a wrapper's own words off the front of `pending`: its options, an option's value and its
/// leading operand. `env -S` puts the words its value splits into in their place, whether the value
/// is the next word or attached, as in `-S'…'`, `-vS'…'` or `--split-string=…`, and reads them
/// again as its own arguments, assignments among them. Each word taken off is pushed on `taken`.
/// A word only the run decides where an option that may take a value is read, or where a split
/// string's word is, leaves the wrapper the program, as does a split string env refuses or only
/// the run decides.
pub(super) fn take_wrapper_words(
    builder: &mut WordBuilder<'_>,
    wrapper: CommandWrapper,
    pending: &mut VecDeque<Word>,
    taken: &mut Vec<Word>,
) -> WrapperRead {
    let mut words = WrapperWords {
        pending,
        split_words: 0,
        taken,
    };
    let mut have_options_ended = false;
    let mut is_operand_replaced = false;
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
        let (splits, attached_from) = match option_word {
            OptionWord::RunsNothing | OptionWord::HandsALine => {
                return WrapperRead::WrapperIsProgram;
            }
            OptionWord::Flags => {
                words.pop_front();
                continue;
            }
            OptionWord::OperandValue { attached_from } => {
                words.pop_front();
                is_operand_replaced = true;
                if attached_from.is_none() {
                    words.pop_front();
                }
                continue;
            }
            OptionWord::Value {
                splits,
                attached_from,
            } => (splits, attached_from),
        };
        words.pop_front();
        let value = match attached_from {
            Some(bytes) if splits => builder.word_after(word, bytes),
            Some(_) => continue,
            None => {
                let value = words.pop_front();
                value.filter(|_| splits)
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
        LeadingOperand::AnyWord | LeadingOperand::AnyWordBeforeList => 1,
        LeadingOperand::Digits => usize::from(words.front().is_some_and(|word| {
            let view = builder.view(word);
            !view.is_decided()
                || (view.len() > 0 && view.chars().all(|digit| digit.is_ascii_digit()))
        })),
        LeadingOperand::WordsUpToTheirEnd => words
            .pending
            .iter()
            .position(|&word| builder.view(word).is(INPUT_LIST_END))
            .map_or(words.pending.len(), |position| position + 1),
    };
    for _ in 0..operand_words {
        words.pop_front();
    }
    // A line option after the operand, as `flock <file> -c <line>` takes it, or a list in
    // braces, as `repeat <count> { <list> }` runs it.
    if let Some(word) = words.front() {
        let view = builder.view(word);
        if view.starts_with("-") && matches!(wrapper.option_word(view), OptionWord::HandsALine) {
            return WrapperRead::WrapperIsProgram;
        }
        if wrapper.runs_a_brace_group() && view.is("{") {
            return WrapperRead::WrapperIsProgram;
        }
    }
    WrapperRead::CommandFollows {
        runs_a_shell_with_no_command: match wrapper.shell_with_no_command {
            ShellWithNoCommand::Never => false,
            ShellWithNoCommand::Always => true,
            ShellWithNoCommand::WithOption(_) => runs_a_shell,
        },
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
