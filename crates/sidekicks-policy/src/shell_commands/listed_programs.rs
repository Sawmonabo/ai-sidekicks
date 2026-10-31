//! The one list of programs that run their words: the shells, the programs that hand a shell a
//! line, the programs that run the command after their own words, the interpreters, `find`, `git`,
//! `rm` and the package-script runners. Each entry says what of its words a reading reads, and so
//! what a standing rule on a command of it may name; a program off the list is read as plain words.

use super::command_string::{LineOptions, ShellGrammar, ShellLineProgram};
use super::words::WordText;
use super::wrappers::{CommandWrapper, LeadingOperand, ShellWithNoCommand};

/// What a listed program is, and so what of its words a reading reads.
#[derive(Clone, Copy)]
pub(super) enum ListedProgram {
    /// A shell: the line its options name, or the line it reads from its input on its own
    /// statement.
    Shell(ShellGrammar),
    /// A program that hands a shell a line its words make.
    LineProgram(ShellLineProgram),
    /// A program that runs the command after its own options and operands.
    Wrapper(CommandWrapper),
    /// `find`, whose command primaries run a command each and whose actions write or delete.
    Find,
    /// An interpreter, none of whose words is read: its code is its own language's.
    Interpreter,
    /// `git`, whose own forms are read as the destructive-git reader reads them.
    Git,
    /// `rm`, which runs no words and deletes whatever its words name.
    FileRemover,
    /// A package-script runner, whose `run` runs a script its project's file holds.
    ScriptRunner,
}

/// What a standing rule on one command may name, as the list's entry for its program gives it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StandingRule {
    /// None: the program is a shell, hands a shell a line, runs the command after it, runs code
    /// or a file no rule can see, deletes what its words name, is `find` with a command primary
    /// or an action, or is a runner with an option before its script word.
    Withheld,
    /// The program, with its first word where that reads as a subcommand.
    Program,
    /// `git` with the subcommand past its own options; `git` alone takes none.
    GitSubcommand,
    /// A runner, its script word (`run`, or npm's `run-script`, `rum` or `urn`) and the script it
    /// names, as `npm run build`; the runner and its script word alone take none.
    RunnerScript,
}

/// The primaries of `find` that run the words after them as a command.
pub(super) const FIND_COMMAND_PRIMARIES: &[&str] = &["-exec", "-execdir", "-ok", "-okdir"];

// The primaries of `find` that delete or write files, or read the paths it walks from a file.
const FIND_FILE_ACTIONS: &[&str] = &["-delete", "-rm", "-fprint", "-files0-from"];

// The words of a package-script runner that run a script: `run`, and npm's own aliases of it.
const RUNNER_SCRIPT_WORDS: &[&str] = &["run", "run-script", "rum", "urn"];

/// The entry `program` names, by its whole name; an interpreter's versioned name is read only by
/// [`standing_rule_of`].
pub(super) fn listed_program(program: impl WordText) -> Option<ListedProgram> {
    LISTED_PROGRAMS
        .iter()
        .find(|(name, _)| program.is(name))
        .map(|&(_, listed)| listed)
}

/// The wrapper `program` names, if it is one.
pub(super) fn command_wrapper(program: impl WordText) -> Option<CommandWrapper> {
    match listed_program(program)? {
        ListedProgram::Wrapper(wrapper) => Some(wrapper),
        ListedProgram::Shell(_)
        | ListedProgram::LineProgram(_)
        | ListedProgram::Find
        | ListedProgram::Interpreter
        | ListedProgram::Git
        | ListedProgram::FileRemover
        | ListedProgram::ScriptRunner => None,
    }
}

/// What a standing rule on a command of `program` with `argument_words` may name. An
/// interpreter's name with a version after its stem, as `python3.12` or `perl5.34`, is that
/// interpreter's.
pub(super) fn standing_rule_of<W: WordText>(
    program: W,
    mut argument_words: impl Iterator<Item = W>,
) -> StandingRule {
    let Some(listed) = listed_program(program) else {
        return if is_versioned_interpreter(&program.chars().collect::<String>()) {
            StandingRule::Withheld
        } else {
            StandingRule::Program
        };
    };
    match listed {
        ListedProgram::Shell(_)
        | ListedProgram::LineProgram(_)
        | ListedProgram::Wrapper(_)
        | ListedProgram::Interpreter
        | ListedProgram::FileRemover => StandingRule::Withheld,
        ListedProgram::Git => StandingRule::GitSubcommand,
        ListedProgram::Find => {
            let acts = argument_words.any(|word| {
                FIND_COMMAND_PRIMARIES
                    .iter()
                    .chain(FIND_FILE_ACTIONS)
                    .any(|primary| word.is(primary))
            });
            if acts {
                StandingRule::Withheld
            } else {
                StandingRule::Program
            }
        }
        ListedProgram::ScriptRunner => {
            // An option before the script word may take a value, so where the script word stands
            // past one is not read.
            let mut follows_an_option = false;
            for (index, word) in argument_words.enumerate() {
                if RUNNER_SCRIPT_WORDS
                    .iter()
                    .any(|script_word| word.is(script_word))
                {
                    return match (index, follows_an_option) {
                        (0, _) => StandingRule::RunnerScript,
                        (_, true) => StandingRule::Withheld,
                        (_, false) => StandingRule::Program,
                    };
                }
                follows_an_option |= word.starts_with("-");
            }
            StandingRule::Program
        }
    }
}

// Whether `name` is an interpreter's stem followed by a version of digits and dots, as
// `python3.12` is `python`'s.
fn is_versioned_interpreter(name: &str) -> bool {
    let stem =
        name.trim_end_matches(|character: char| character.is_ascii_digit() || character == '.');
    stem.len() < name.len() && matches!(listed_program(stem), Some(ListedProgram::Interpreter))
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

const POSIX_SHELL: ShellGrammar = ShellGrammar::Posix(&[]);

const MAPFILE_OPTIONS: LineOptions = LineOptions {
    options_naming_the_line: &["-C"],
    options_with_value: &["-d", "-n", "-O", "-s", "-u", "-c"],
    letters_with_attached_value: "",
    reads_past_operands: false,
};

// The list, by each name its program runs under.
const LISTED_PROGRAMS: &[(&str, ListedProgram)] = &[
    ("sh", ListedProgram::Shell(POSIX_SHELL)),
    ("bash", ListedProgram::Shell(POSIX_SHELL)),
    // zsh's `--emulate <shell>` takes the shell it emulates.
    (
        "zsh",
        ListedProgram::Shell(ShellGrammar::Posix(&["--emulate"])),
    ),
    ("dash", ListedProgram::Shell(POSIX_SHELL)),
    ("ksh", ListedProgram::Shell(ShellGrammar::Posix(&["-R"]))),
    ("fish", ListedProgram::Shell(ShellGrammar::Fish)),
    ("tcsh", ListedProgram::Shell(ShellGrammar::Csh)),
    ("csh", ListedProgram::Shell(ShellGrammar::Csh)),
    ("cmd", ListedProgram::Shell(ShellGrammar::Cmd)),
    ("cmd.exe", ListedProgram::Shell(ShellGrammar::Cmd)),
    ("powershell", ListedProgram::Shell(ShellGrammar::PowerShell)),
    (
        "powershell.exe",
        ListedProgram::Shell(ShellGrammar::PowerShell),
    ),
    ("pwsh", ListedProgram::Shell(ShellGrammar::PowerShell)),
    ("eval", ListedProgram::LineProgram(ShellLineProgram::Eval)),
    ("trap", ListedProgram::LineProgram(ShellLineProgram::Trap)),
    ("alias", ListedProgram::LineProgram(ShellLineProgram::Alias)),
    (
        "emulate",
        ListedProgram::LineProgram(ShellLineProgram::Emulate),
    ),
    (
        "compgen",
        ListedProgram::LineProgram(ShellLineProgram::OptionLine(LineOptions {
            options_naming_the_line: &["-C"],
            options_with_value: &["-A", "-G", "-W", "-F", "-X", "-P", "-S", "-o", "-V"],
            letters_with_attached_value: "",
            reads_past_operands: false,
        })),
    ),
    (
        "mapfile",
        ListedProgram::LineProgram(ShellLineProgram::OptionLine(MAPFILE_OPTIONS)),
    ),
    (
        "readarray",
        ListedProgram::LineProgram(ShellLineProgram::OptionLine(MAPFILE_OPTIONS)),
    ),
    (
        "source",
        ListedProgram::LineProgram(ShellLineProgram::Source),
    ),
    (".", ListedProgram::LineProgram(ShellLineProgram::Source)),
    ("su", ListedProgram::LineProgram(ShellLineProgram::Su)),
    // `watch` joins its words after its options into a line for `sh -c`.
    (
        "watch",
        ListedProgram::LineProgram(ShellLineProgram::Watch(LineOptions {
            options_naming_the_line: &[],
            options_with_value: &["-n", "--interval", "-q", "--equexit", "-s", "--shotsdir"],
            letters_with_attached_value: "d",
            reads_past_operands: false,
        })),
    ),
    ("timeout", ListedProgram::Wrapper(TIMEOUT)),
    ("gtimeout", ListedProgram::Wrapper(TIMEOUT)),
    (
        "time",
        ListedProgram::Wrapper(CommandWrapper::new(&["-o", "--output", "-f", "--format"])),
    ),
    ("nice", ListedProgram::Wrapper(NICE)),
    ("gnice", ListedProgram::Wrapper(NICE)),
    ("nohup", ListedProgram::Wrapper(NO_VALUE_WRAPPER)),
    (
        "stdbuf",
        ListedProgram::Wrapper(CommandWrapper::new(&[
            "-i", "--input", "-o", "--output", "-e", "--error",
        ])),
    ),
    (
        "command",
        ListedProgram::Wrapper(CommandWrapper {
            // `command -v` and `-V` print how the shell finds the command.
            options_running_nothing: &["-v", "-V"],
            ..CommandWrapper::new(&[])
        }),
    ),
    ("builtin", ListedProgram::Wrapper(NO_VALUE_WRAPPER)),
    ("noglob", ListedProgram::Wrapper(NO_VALUE_WRAPPER)),
    (
        "xargs",
        ListedProgram::Wrapper(CommandWrapper {
            // GNU's `-i`, `-e` and `-l` take an optional value inside their own word.
            letters_with_attached_value: "eil",
            // xargs reads the words it appends from its input.
            consumes_its_input: true,
            ..CommandWrapper::new(&[
                "-I",
                "-J",
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
        }),
    ),
    (
        "env",
        ListedProgram::Wrapper(CommandWrapper {
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
        }),
    ),
    (
        "sudo",
        ListedProgram::Wrapper(CommandWrapper {
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
        }),
    ),
    (
        "doas",
        ListedProgram::Wrapper(CommandWrapper {
            shell_with_no_command: ShellWithNoCommand::WithOption(&["-s"]),
            ..CommandWrapper::new(&["-a", "-C", "-u"])
        }),
    ),
    ("exec", ListedProgram::Wrapper(CommandWrapper::new(&["-a"]))),
    ("nocorrect", ListedProgram::Wrapper(NO_VALUE_WRAPPER)),
    ("-", ListedProgram::Wrapper(NO_VALUE_WRAPPER)),
    // zsh's `repeat <count> <command>` and `repeat <count> { <list> }`.
    (
        "repeat",
        ListedProgram::Wrapper(CommandWrapper {
            leading_operand: LeadingOperand::AnyWordBeforeList,
            ..CommandWrapper::new(&[])
        }),
    ),
    (
        "zargs",
        ListedProgram::Wrapper(CommandWrapper {
            // zsh's `zargs [options --] [input …] [-- command …]`: the command follows the `--`
            // that ends its input list.
            letters_with_attached_value: "eil",
            leading_operand: LeadingOperand::WordsUpToTheirEnd,
            ..CommandWrapper::new(&[
                "-I",
                "-n",
                "--max-args",
                "-s",
                "--max-chars",
                "-L",
                "-P",
                "--max-procs",
            ])
        }),
    ),
    (
        "chroot",
        ListedProgram::Wrapper(CommandWrapper {
            // The new root comes before the command; with none after it, a shell runs there.
            leading_operand: LeadingOperand::AnyWord,
            shell_with_no_command: ShellWithNoCommand::Always,
            ..CommandWrapper::new(&["-G", "-g", "-u", "--groups", "--userspec"])
        }),
    ),
    (
        "sandbox-exec",
        ListedProgram::Wrapper(CommandWrapper::new(&["-f", "-n", "-p", "-D"])),
    ),
    (
        "script",
        ListedProgram::Wrapper(CommandWrapper {
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
        }),
    ),
    (
        "chrt",
        ListedProgram::Wrapper(CommandWrapper {
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
        }),
    ),
    (
        "taskset",
        ListedProgram::Wrapper(CommandWrapper {
            // `taskset -p` sets an existing process's affinity; the mask comes before the command.
            options_running_nothing: &["-p", "--pid"],
            leading_operand: LeadingOperand::AnyWord,
            ..CommandWrapper::new(&[])
        }),
    ),
    (
        "caffeinate",
        ListedProgram::Wrapper(CommandWrapper::new(&["-t", "-w"])),
    ),
    (
        "arch",
        ListedProgram::Wrapper(CommandWrapper {
            // Each option is its own word, `-arm64` an architecture's name, never a cluster.
            reads_clusters: false,
            ..CommandWrapper::new(&["-arch", "-d", "-e"])
        }),
    ),
    ("setsid", ListedProgram::Wrapper(NO_VALUE_WRAPPER)),
    (
        "ionice",
        ListedProgram::Wrapper(CommandWrapper::new(&[
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
        ])),
    ),
    (
        "flock",
        ListedProgram::Wrapper(CommandWrapper {
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
        }),
    ),
    ("find", ListedProgram::Find),
    ("python", ListedProgram::Interpreter),
    ("python3", ListedProgram::Interpreter),
    ("pythonw", ListedProgram::Interpreter),
    ("py", ListedProgram::Interpreter),
    ("pyw", ListedProgram::Interpreter),
    ("pypy", ListedProgram::Interpreter),
    ("pypy3", ListedProgram::Interpreter),
    ("node", ListedProgram::Interpreter),
    ("nodejs", ListedProgram::Interpreter),
    ("perl", ListedProgram::Interpreter),
    ("ruby", ListedProgram::Interpreter),
    ("php", ListedProgram::Interpreter),
    ("lua", ListedProgram::Interpreter),
    ("julia", ListedProgram::Interpreter),
    ("Rscript", ListedProgram::Interpreter),
    ("deno", ListedProgram::Interpreter),
    ("bun", ListedProgram::Interpreter),
    ("osascript", ListedProgram::Interpreter),
    ("awk", ListedProgram::Interpreter),
    ("gawk", ListedProgram::Interpreter),
    ("mawk", ListedProgram::Interpreter),
    ("nawk", ListedProgram::Interpreter),
    ("git", ListedProgram::Git),
    ("rm", ListedProgram::FileRemover),
    ("npm", ListedProgram::ScriptRunner),
    ("pnpm", ListedProgram::ScriptRunner),
    ("yarn", ListedProgram::ScriptRunner),
];
