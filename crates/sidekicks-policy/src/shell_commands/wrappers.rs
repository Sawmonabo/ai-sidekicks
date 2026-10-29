//! The programs that run the command after their own options and operands, such as `env -i`,
//! `sudo -u` or `timeout 5`, and how each reads its own words before the command's.

use std::collections::VecDeque;

use super::words::{ShellWord, Word, WordBuilder, WordText};
use crate::destructive_git::is_option;

/// How a program that runs the command after it reads its own words first: its options that take
/// a value, the rest of a short option's cluster, after a long one's `=` or the next word; those
/// that split their value into the command's words; the letters whose optional value is only the
/// rest of their cluster; the plain words it takes before the command; and the option letters
/// with which it only describes the command, running nothing.
#[derive(Clone, Copy)]
pub(super) struct CommandWrapper {
    options_with_value: &'static [&'static str],
    split_string_options: &'static [&'static str],
    letters_with_attached_value: &'static str,
    leading_operands: usize,
    describing_letters: &'static str,
}

// Where an option word's value is: its byte offset in the word, or the next word.
struct OptionValue {
    splits: bool,
    attached_from: Option<usize>,
}

impl CommandWrapper {
    const fn new(options_with_value: &'static [&'static str]) -> Self {
        Self {
            options_with_value,
            split_string_options: &[],
            letters_with_attached_value: "",
            leading_operands: 0,
            describing_letters: "",
        }
    }

    /// Whether the options at the front of `pending` hold a letter with which the wrapper only
    /// describes the command, as `command -v` does, so it runs nothing.
    pub(super) fn only_describes(
        self,
        builder: &WordBuilder<'_>,
        pending: &VecDeque<Word>,
    ) -> bool {
        if self.describing_letters.is_empty() {
            return false;
        }
        pending
            .iter()
            .map(|&word| builder.view(word))
            .take_while(|word| word.starts_with("-") && !word.is("-") && !word.is("--"))
            .any(|word| {
                // A letter an expansion makes is only the run's to decide.
                word.is_decided()
                    && word
                        .chars()
                        .skip(1)
                        .any(|letter| self.describing_letters.contains(letter))
            })
    }

    // Where the value of the option `word` holds is, as getopt reads it: a long option's after its
    // `=` or in the next word, and a short cluster's past the first letter that takes one, or in
    // the next word when that letter ends it; `None` when the word holds no option with a value.
    fn option_value(self, word: ShellWord<'_>) -> Option<OptionValue> {
        let options = || {
            let splitting = self
                .split_string_options
                .iter()
                .map(|option| (option, true));
            let valued = self.options_with_value.iter().map(|option| (option, false));
            splitting.chain(valued)
        };
        if word.starts_with("--") {
            return options()
                .find(|(option, _)| option.starts_with("--") && is_option(word, option))
                .map(|(option, splits)| OptionValue {
                    splits,
                    attached_from: (!word.is(option)).then_some(option.len() + 1),
                });
        }
        let mut position = 1;
        for letter in word.chars().skip(1) {
            position += letter.len_utf8();
            if self.letters_with_attached_value.contains(letter) {
                return None;
            }
            let is_letter = |option: &str| {
                let mut characters = option.chars();
                characters.next() == Some('-')
                    && characters.next() == Some(letter)
                    && characters.next().is_none()
            };
            if let Some((_, splits)) = options().find(|(option, _)| is_letter(option)) {
                return Some(OptionValue {
                    splits,
                    attached_from: (position < word.len()).then_some(position),
                });
            }
        }
        None
    }
}

// The programs that run the command after them, so the program is the word past their own.
const COMMAND_WRAPPERS: &[(&str, CommandWrapper)] = &[
    (
        "env",
        CommandWrapper {
            // `env -S` splits its value into the words the command starts with.
            split_string_options: &["-S", "--split-string"],
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
            describing_letters: "vV",
            ..CommandWrapper::new(&[])
        },
    ),
    ("nohup", CommandWrapper::new(&[])),
    (
        "time",
        CommandWrapper::new(&["-o", "--output", "-f", "--format"]),
    ),
    (
        "timeout",
        CommandWrapper {
            // The duration comes before the command.
            leading_operands: 1,
            ..CommandWrapper::new(&["-s", "--signal", "-k", "--kill-after"])
        },
    ),
    ("nice", CommandWrapper::new(&["-n", "--adjustment"])),
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
        ]),
    ),
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
];

/// The wrapper `program` names, if it is one.
pub(super) fn command_wrapper(program: ShellWord<'_>) -> Option<CommandWrapper> {
    COMMAND_WRAPPERS
        .iter()
        .find(|(name, _)| program.is(name))
        .map(|&(_, wrapper)| wrapper)
}

/// Takes a wrapper's own words off the front of `pending`: its options, an option's value and its
/// leading operands; `env -S` puts the words its value splits into in their place, whether the
/// value is the next word or attached, as in `-S'…'`, `-vS'…'` or `--split-string=…`.
pub(super) fn take_wrapper_words(
    builder: &mut WordBuilder<'_>,
    wrapper: CommandWrapper,
    pending: &mut VecDeque<Word>,
) {
    while let Some(&word) = pending.front() {
        let view = builder.view(word);
        if view.is("--") {
            pending.pop_front();
            break;
        }
        if !view.starts_with("-") || view.is("-") {
            break;
        }
        let value = wrapper.option_value(view);
        pending.pop_front();
        let Some(value) = value else {
            continue;
        };
        if !value.splits {
            if value.attached_from.is_none() {
                pending.pop_front();
            }
            continue;
        }
        let split_value = match value.attached_from {
            Some(bytes) => builder.word_after(word, bytes),
            None => pending.pop_front(),
        };
        if let Some(split_value) = split_value {
            for split_word in builder.split_on_whitespace(split_value).into_iter().rev() {
                pending.push_front(split_word);
            }
        }
        return;
    }
    for _ in 0..wrapper.leading_operands {
        pending.pop_front();
    }
}
