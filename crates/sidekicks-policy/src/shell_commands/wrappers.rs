//! The programs that run the command after their own options and operands, such as `env -i`,
//! `sudo -u` or `timeout 5`, and how each reads its own words before the command's.

use std::collections::VecDeque;

use super::words::{ShellWord, Word, WordBuilder, WordText};

/// How a program that runs the command after it reads its own words first: its options that take
/// the next word as their value, those that split their value into the command's words, the
/// plain words it takes before the command, and the option letters with which it only describes
/// the command, running nothing.
#[derive(Clone, Copy)]
pub(super) struct CommandWrapper {
    options_with_value: &'static [&'static str],
    split_string_options: &'static [&'static str],
    leading_operands: usize,
    describing_letters: &'static str,
}

impl CommandWrapper {
    const fn new(options_with_value: &'static [&'static str]) -> Self {
        Self {
            options_with_value,
            split_string_options: &[],
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
}

// The programs that run the command after them, so the program is the word past their own.
const COMMAND_WRAPPERS: &[(&str, CommandWrapper)] = &[
    (
        "env",
        CommandWrapper {
            // `env -S` splits its value into the words the command starts with.
            split_string_options: &["-S", "--split-string"],
            ..CommandWrapper::new(&["-u", "--unset", "-C", "--chdir"])
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
        CommandWrapper::new(&[
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
        ]),
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
/// leading operands; `env -S` puts the words its value splits into in their place.
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
        let splits_value = wrapper
            .split_string_options
            .iter()
            .any(|option| view.is(option));
        let takes_value = wrapper
            .options_with_value
            .iter()
            .any(|option| view.is(option));
        pending.pop_front();
        if splits_value {
            if let Some(value) = pending.pop_front() {
                for split_word in builder.split_on_whitespace(value).into_iter().rev() {
                    pending.push_front(split_word);
                }
            }
            return;
        }
        if takes_value {
            pending.pop_front();
        }
    }
    for _ in 0..wrapper.leading_operands {
        pending.pop_front();
    }
}
