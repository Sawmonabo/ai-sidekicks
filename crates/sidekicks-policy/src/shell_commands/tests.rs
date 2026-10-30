use std::path::Path;

use proptest::prelude::*;
use rstest::rstest;

use super::*;

// A limit small enough that the cap and the bound are reached by short lines.
const LIMIT: usize = 64;

// A command as text, so a table compares what the reader read.
#[derive(Debug, PartialEq, Eq)]
struct ReadCommand {
    program: String,
    argument_words: Vec<String>,
    wrapper_words: Vec<String>,
}

impl From<ShellCommand<'_>> for ReadCommand {
    fn from(command: ShellCommand<'_>) -> Self {
        Self {
            program: command.program().to_string(),
            argument_words: command
                .argument_words()
                .map(|word| word.to_string())
                .collect(),
            wrapper_words: command
                .wrapper_words()
                .map(|word| word.to_string())
                .collect(),
        }
    }
}

fn command(program: &str, argument_words: &[&str], wrapper_words: &[&str]) -> ReadCommand {
    ReadCommand {
        program: program.to_owned(),
        argument_words: argument_words.iter().map(|&word| word.to_owned()).collect(),
        wrapper_words: wrapper_words.iter().map(|&word| word.to_owned()).collect(),
    }
}

fn commands_of(reading: &ShellLineReading) -> Vec<ReadCommand> {
    reading.commands().map(ReadCommand::from).collect()
}

fn assert_unread(reading: &ShellLineReading) {
    assert!(!reading.is_whole());
    assert_eq!(reading.commands().len(), 0);
}

#[rstest]
#[case::pipeline(
    "git status | grep main",
    vec![command("git", &["status"], &[]), command("grep", &["main"], &[])],
    true
)]
#[case::chain(
    "cd repo && npm test || echo failed",
    vec![
        command("cd", &["repo"], &[]),
        command("npm", &["test"], &[]),
        command("echo", &["failed"], &[]),
    ],
    true
)]
#[case::substitution(
    r#"echo "$(git rev-parse HEAD)""#,
    vec![
        command("echo", &["$(git rev-parse HEAD)"], &[]),
        command("git", &["rev-parse", "HEAD"], &[]),
    ],
    true
)]
#[case::env_unset(
    "env -u HOME git push",
    vec![command("git", &["push"], &["env", "-u", "HOME"])],
    true
)]
#[case::sudo_user(
    "sudo -u root rm -rf /tmp/x",
    vec![command("rm", &["-rf", "/tmp/x"], &["sudo", "-u", "root"])],
    true
)]
#[case::timeout_duration(
    "timeout 5 git fetch",
    vec![command("git", &["fetch"], &["timeout", "5"])],
    true
)]
#[case::env_split_string(
    "env -S 'git push -f'",
    vec![command("git", &["push", "-f"], &["env", "-S", "git push -f"])],
    true
)]
#[case::env_split_string_keeps_a_substitution_whole(
    r#"env -S "git $(echo push) -f""#,
    vec![
        command("git", &["$(echo push)", "-f"], &["env", "-S", "git $(echo push) -f"]),
        command("echo", &["push"], &[]),
    ],
    true
)]
#[case::env_split_string_drops_every_blank_run(
    "env -S '  git  push -f  '",
    vec![command("git", &["push", "-f"], &["env", "-S", "  git  push -f  "])],
    true
)]
#[case::env_assignment_before_the_program(
    "env FOO=1 git push --force",
    vec![command("git", &["push", "--force"], &["env", "FOO=1"])],
    true
)]
#[case::env_name_starting_with_a_digit_is_the_program(
    "env 1FOO=1 x",
    vec![command("1FOO=1", &["x"], &["env"])],
    true
)]
#[case::env_name_holding_a_dash_is_the_program(
    "env FOO-BAR=1 x",
    vec![command("FOO-BAR=1", &["x"], &["env"])],
    true
)]
// A word only the run decides where a wrapper reads an option that may take a value, or env a
// string it refuses, leaves the wrapper the program.
#[case::undecided_option_of_a_wrapper(
    "sudo -$o root git push --force",
    vec![command("sudo", &["-$o", "root", "git", "push", "--force"], &[])],
    true
)]
#[case::undecided_program_of_a_split_string(
    "env -S'${P} push -f'",
    vec![command("env", &["${P}", "push", "-f"], &[])],
    true
)]
#[case::split_string_env_refuses(
    "env -S'$P push' git push -f",
    vec![command("env", &["git", "push", "-f"], &[])],
    true
)]
// A line break outside quotes parts GNU env's words but not macOS env's.
#[case::split_string_line_break(
    "env -S'A=1\nx git push --force'",
    vec![command("env", &[], &[])],
    true
)]
// Splits nested in splits read no more bytes in all than the line holds.
#[case::split_strings_past_the_line("env -S-S-S-Sx", vec![command("env", &[], &[])], true)]
// A split string's assignments come before its program, which here only the run decides.
#[case::undecided_program_after_a_split_assignment(
    "env -S'A=1 ${P} push'",
    vec![command("env", &["${P}", "push"], &[])],
    true
)]
#[case::assignments_only("FOO=1 BAR=2", vec![], true)]
#[case::shell_command_string(
    "bash -lc 'git status'",
    vec![command("bash", &["-lc", "git status"], &[]), command("git", &["status"], &[])],
    true
)]
#[case::shell_options_before_c(
    "bash -x -o errexit -c 'git status'",
    vec![
        command("bash", &["-x", "-o", "errexit", "-c", "git status"], &[]),
        command("git", &["status"], &[]),
    ],
    true
)]
#[case::shell_c_last_in_a_cluster(
    "bash -xc 'git status'",
    vec![command("bash", &["-xc", "git status"], &[]), command("git", &["status"], &[])],
    true
)]
#[case::shell_c_first_in_a_quoted_cluster(
    "bash -'c'x 'git status'",
    vec![command("bash", &["-cx", "git status"], &[]), command("git", &["status"], &[])],
    true
)]
#[case::shell_cluster_without_c_runs_a_file(
    "/usr/local/bin/bash -x 'git status'",
    vec![command("bash", &["-x", "git status"], &[])],
    true
)]
#[case::shell_long_option_holding_c_runs_a_file(
    "bash --norc 'git status'",
    vec![command("bash", &["--norc", "git status"], &[])],
    true
)]
#[case::shell_c_with_no_string_after_its_options_end(
    "bash -c -",
    vec![command("bash", &["-c", "-"], &[])],
    true
)]
#[case::program_path_slash_first("/git push", vec![command("git", &["push"], &[])], true)]
#[case::program_path_slash_inside(
    "./bin/git push",
    vec![command("git", &["push"], &[])],
    true
)]
#[case::program_path_slash_last("git/ push", vec![command("", &["push"], &[])], true)]
#[case::ansi_c_program_path(
    r"$'./bin/'git push",
    vec![command("git", &["push"], &[])],
    true
)]
#[case::unterminated_quote(
    r#"git push --force origin main && echo "unterminated"#,
    vec![command("git", &["push", "--force", "origin", "main"], &[])],
    false
)]
#[case::coproc_keyword(
    "coproc git push --force origin main",
    vec![command("git", &["push", "--force", "origin", "main"], &[])],
    true
)]
#[case::escaped_program(r"g\it push -f", vec![command("git", &["push", "-f"], &[])], true)]
#[case::ansi_c_program(r"$'\147it' push -f", vec![command("git", &["push", "-f"], &[])], true)]
#[case::quoted_program_part(
    r#""gi"t push -f"#,
    vec![command("git", &["push", "-f"], &[])],
    true
)]
#[case::time_keyword("time npm run build", vec![command("npm", &["run", "build"], &[])], true)]
// Bash in POSIX mode runs the `time` program with an option the keyword does not take.
#[case::time_program_option(
    "time -o f npm run build",
    vec![command("npm", &["run", "build"], &["time", "-o", "f"])],
    true
)]
#[case::export_assignment("export FOO=1", vec![command("export", &[], &[])], true)]
#[case::export_name(
    "export FOO=1 BAR",
    vec![command("export", &["BAR"], &[])],
    true
)]
#[case::single_bracket_test(
    "[ -f x ] && rm -rf b",
    vec![command("[", &["-f", "x", "]"], &[]), command("rm", &["-rf", "b"], &[])],
    true
)]
#[case::before_a_syntax_error(
    "git push -f origin main\nif true; then echo b",
    vec![command("git", &["push", "-f", "origin", "main"], &[])],
    false
)]
fn reads_the_commands_of_a_line(
    #[case] line: &str,
    #[case] expected: Vec<ReadCommand>,
    #[case] is_whole: bool,
) {
    let mut reader = ShellLineReader::new(LIMIT);
    let reading = reader.read(line);

    assert_eq!(reading.is_whole(), is_whole);
    // Each command is followed by those of the line it hands a shell, as a caller reads them.
    let mut commands = Vec::new();
    for command in reading.commands() {
        commands.push(ReadCommand::from(command));
        for command_string in reader.read_command_strings(command) {
            commands.extend(commands_of(&command_string));
        }
    }
    if is_whole {
        assert_eq!(commands, expected);
    } else {
        // Past a syntax error, what the parser recovers is its own; what it read before is ours.
        assert!(commands.starts_with(&expected), "{commands:?}");
    }
}

// A line of nested levels built to the test's limit, read on a thread with the stack of
// tokio's blocking threads; the line's memory and time must grow with its length alone.
#[rstest]
#[case::an_escape_at_every_level(r#""\$x$("#, r#")""#)]
#[case::env_split_strings(r#"env -S "$("#, r#")""#)]
#[case::evals("eval $(", ")")]
#[case::substitutions("$(", ")")]
fn reads_a_line_nested_to_the_limit(#[case] open: &str, #[case] close: &str) {
    const NEST_LIMIT: usize = 1 << 20;
    let levels = (NEST_LIMIT - 1) / (open.len() + close.len());
    let line = format!("{}x{}", open.repeat(levels), close.repeat(levels));

    let reading = std::thread::Builder::new()
        .stack_size(2 << 20)
        .spawn(move || ShellLineReader::new(NEST_LIMIT).read(&line))
        .expect("the reading thread starts")
        .join()
        .expect("the read ends without a panic");

    assert!(reading.is_whole());
    assert_eq!(reading.commands().len(), levels + 1);
    let innermost = reading.commands().last().expect("the line runs commands");
    assert_eq!(ReadCommand::from(innermost), command("x", &[], &[]));
}

#[test]
fn a_line_at_the_limit_is_read_and_one_byte_past_it_is_not() {
    let at_limit = format!("echo {}", "a".repeat(LIMIT - "echo ".len()));

    let reading = ShellLineReader::new(LIMIT).read(&at_limit);
    assert!(reading.is_whole());
    assert_eq!(reading.commands().len(), 1);

    let past_limit = format!("{at_limit}a");
    assert_unread(&ShellLineReader::new(LIMIT).read(&past_limit));
}

// The grammar's scanner once read ahead to the line's end at each `)` of a run, so the run took
// minutes; the fix reads it in well under a second, even unoptimized.
#[test]
fn reads_a_run_of_closing_parentheses_in_linear_time() {
    const RUN_LENGTH: usize = 128 << 10;
    let (reading_sender, reading_receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let reading = ShellLineReader::new(RUN_LENGTH).read(&")".repeat(RUN_LENGTH));
        reading_sender
            .send(reading.is_whole())
            .expect("the test waits for the reading");
    });

    let is_whole = reading_receiver
        .recv_timeout(std::time::Duration::from_secs(10))
        .expect("the run is read within 10 s");

    assert!(!is_whole);
}

#[test]
fn a_reader_reads_at_most_twice_its_limit() {
    let mut reader = ShellLineReader::new(LIMIT);
    let first = format!("echo {}", "a".repeat(LIMIT - "echo ".len()));
    let second = format!("echo {}", "b".repeat(LIMIT - "echo ".len()));

    assert!(reader.read(&first).is_whole());
    assert!(reader.read(&second).is_whole());
    assert_unread(&reader.read("true"));
}

#[test]
fn a_string_read_again_costs_nothing_and_reads_the_same() {
    let mut reader = ShellLineReader::new(LIMIT);
    let line = "bash -c 'git push --force origin main'";
    let inner = "git push --force origin main";
    let line_reading = reader.read(line);
    let shell = line_reading
        .commands()
        .next()
        .expect("the line runs `bash`");
    let inner_reading = reader
        .read_command_strings(shell)
        .pop()
        .expect("`bash -c` runs a string");
    // A string spending what is left of the bound.
    let filler = "x".repeat(2 * LIMIT - line.len() - inner.len());
    assert!(reader.read(&filler).is_whole());

    let reread = reader
        .read_command_strings(shell)
        .pop()
        .expect("`bash -c` runs a string");

    assert!(Arc::ptr_eq(&reread, &inner_reading));
    assert_eq!(
        commands_of(&reread),
        vec![command("git", &["push", "--force", "origin", "main"], &[])]
    );
    assert_unread(&reader.read("true"));
}

#[rstest]
#[case::provider_wrapper(
    r#"/bin/zsh -lc "rm -rf 'my build' && echo done""#,
    &[],
    "rm -rf 'my build' && echo done"
)]
#[case::operator_outside_the_argv("bash -lc 'x' && y", &[], "bash -lc 'x' && y")]
#[case::wrapper_before_the_shell("env bash -lc 'x'", &[], "env bash -lc 'x'")]
#[case::wrapper_before_a_joined_argv("env bash -lc 'x y'", &[], "env bash -lc 'x y'")]
// A shell outside `/bin` and `/usr/bin` is the provider's only when it is one it starts lines with.
#[case::provider_shell_path(
    "/opt/homebrew/bin/zsh -lc 'ls -la'",
    &["/opt/homebrew/bin/zsh"],
    "ls -la"
)]
#[case::shell_of_another_kind_the_provider_runs(
    "/opt/homebrew/bin/bash -lc 'ls -la'",
    &["/opt/homebrew/bin/zsh", "/opt/homebrew/bin/bash"],
    "ls -la"
)]
#[case::other_shell_path(
    "/opt/homebrew/bin/zsh -lc 'ls -la'",
    &[],
    "/opt/homebrew/bin/zsh -lc 'ls -la'"
)]
#[case::shell_path_not_the_providers(
    "/tmp/x/zsh -lc 'ls -la'",
    &["/opt/homebrew/bin/zsh"],
    "/tmp/x/zsh -lc 'ls -la'"
)]
// A provider's shell whose kind is no line shell is never unwrapped.
#[case::provider_shell_of_another_kind(
    "fish -lc 'ls -la'",
    &["/opt/homebrew/bin/fish"],
    "fish -lc 'ls -la'"
)]
fn unwraps_only_a_shell_handed_its_whole_line(
    #[case] line: &str,
    #[case] provider_shells: &[&str],
    #[case] expected: &str,
) {
    let provider_shells: Vec<&Path> = provider_shells.iter().map(Path::new).collect();

    assert_eq!(unwrap_shell_command_line(line, &provider_shells), expected);
}

// Words the parser or the reader reads as more than a program's name.
const RESERVED_NAMES: &[&str] = &[
    "if",
    "then",
    "else",
    "elif",
    "fi",
    "case",
    "esac",
    "for",
    "select",
    "in",
    "while",
    "until",
    "do",
    "done",
    "function",
    "declare",
    "typeset",
    "export",
    "readonly",
    "local",
    "unset",
    "unsetenv",
    "time",
    "coproc",
    "env",
    "exec",
    "command",
    "nohup",
    "timeout",
    "gtimeout",
    "nice",
    "gnice",
    "sudo",
    "doas",
    "xargs",
    "stdbuf",
    "setsid",
    "ionice",
    "chrt",
    "taskset",
    "caffeinate",
    "arch",
];

proptest! {
    #[test]
    fn a_joined_argv_reads_back_as_its_one_command(
        program in "[a-z][a-z0-9_]{0,11}"
            .prop_filter("a plain program name", |name| !RESERVED_NAMES.contains(&name.as_str())),
        argument_words in proptest::collection::vec("[^\\x00]{0,12}", 0..6),
    ) {
        let line = shlex::try_join(
            std::iter::once(program.as_str()).chain(argument_words.iter().map(String::as_str)),
        )
        .expect("no word holds a NUL");

        let reading = ShellLineReader::new(1 << 20).read(&line);

        prop_assert!(reading.is_whole(), "{line:?}");
        prop_assert_eq!(
            commands_of(&reading),
            vec![ReadCommand { program, argument_words, wrapper_words: Vec::new() }]
        );
    }
}
