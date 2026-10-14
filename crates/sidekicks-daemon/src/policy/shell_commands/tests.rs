use proptest::prelude::*;
use rstest::rstest;

use super::*;

// A limit small enough that the cap and the bound are reached by short lines.
const LIMIT: usize = 64;

fn command(program: &str, argument_words: &[&str], wrappers: &[&str]) -> ShellCommand {
    ShellCommand {
        program: program.to_owned(),
        argument_words: argument_words.iter().map(|&word| word.to_owned()).collect(),
        wrappers: wrappers.iter().map(|&wrapper| wrapper.to_owned()).collect(),
    }
}

fn unread() -> ShellLineReading {
    ShellLineReading {
        commands: Vec::new(),
        is_whole: false,
    }
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
#[case::env_unset("env -u HOME git push", vec![command("git", &["push"], &["env"])], true)]
#[case::sudo_user(
    "sudo -u root rm -rf /tmp/x",
    vec![command("rm", &["-rf", "/tmp/x"], &["sudo"])],
    true
)]
#[case::timeout_duration(
    "timeout 5 git fetch",
    vec![command("git", &["fetch"], &["timeout"])],
    true
)]
#[case::env_split_string(
    "env -S 'git push -f'",
    vec![command("git", &["push", "-f"], &["env"])],
    true
)]
#[case::assignments_only("FOO=1 BAR=2", vec![], true)]
#[case::shell_command_string(
    "bash -lc 'git status'",
    vec![command("bash", &["-lc", "git status"], &[])],
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
#[case::quoted_program_part(r#""gi"t push -f"#, vec![command("git", &["push", "-f"], &[])], true)]
#[case::time_keyword("time npm run build", vec![command("npm", &["run", "build"], &[])], true)]
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
    #[case] expected: Vec<ShellCommand>,
    #[case] is_whole: bool,
) {
    let reading = ShellLineReader::new(LIMIT).read(line);

    assert_eq!(reading.is_whole, is_whole);
    if is_whole {
        assert_eq!(reading.commands, expected);
    } else {
        // Past a syntax error, what the parser recovers is its own; what it read before is ours.
        assert!(
            reading.commands.starts_with(&expected),
            "{:?}",
            reading.commands
        );
    }
}

#[test]
fn a_line_at_the_limit_is_read_and_one_byte_past_it_is_not() {
    let at_limit = format!("echo {}", "a".repeat(LIMIT - "echo ".len()));

    let reading = ShellLineReader::new(LIMIT).read(&at_limit);
    assert!(reading.is_whole);
    assert_eq!(reading.commands.len(), 1);

    let past_limit = format!("{at_limit}a");
    assert_eq!(*ShellLineReader::new(LIMIT).read(&past_limit), unread());
}

#[test]
fn a_reader_reads_at_most_twice_its_limit() {
    let mut reader = ShellLineReader::new(LIMIT);
    let first = format!("echo {}", "a".repeat(LIMIT - "echo ".len()));
    let second = format!("echo {}", "b".repeat(LIMIT - "echo ".len()));

    assert!(reader.read(&first).is_whole);
    assert!(reader.read(&second).is_whole);
    assert_eq!(*reader.read("true"), unread());
}

#[test]
fn a_string_read_again_costs_nothing_and_reads_the_same() {
    let mut reader = ShellLineReader::new(LIMIT);
    let line = "bash -c 'git push --force origin main'";
    let line_reading = reader.read(line);
    let inner = read_command_string(&line_reading.commands[0]).expect("`bash -c` runs a string");
    let inner_reading = reader.read(&inner);
    // A string spending what is left of the bound.
    let filler = "x".repeat(2 * LIMIT - line.len() - inner.len());
    assert!(reader.read(&filler).is_whole);

    let reread = reader.read(&inner);

    assert_eq!(reread, inner_reading);
    assert_eq!(
        reread.commands,
        vec![command("git", &["push", "--force", "origin", "main"], &[])]
    );
    assert_eq!(*reader.read("true"), unread());
}

#[rstest]
#[case::provider_wrapper(
    r#"/bin/zsh -lc "rm -rf 'my build' && echo done""#,
    "rm -rf 'my build' && echo done"
)]
#[case::operator_outside_the_argv("bash -lc 'x' && y", "bash -lc 'x' && y")]
#[case::wrapper_before_the_shell("env bash -lc 'x'", "env bash -lc 'x'")]
#[case::wrapper_before_a_joined_argv("env bash -lc 'x y'", "env bash -lc 'x y'")]
fn unwraps_only_a_shell_handed_its_whole_line(#[case] line: &str, #[case] expected: &str) {
    assert_eq!(unwrap_shell_command_line(line), expected);
}

// Words the parser or the reader reads as more than a program's name.
const RESERVED_NAMES: &[&str] = &[
    "if", "then", "else", "elif", "fi", "case", "esac", "for", "select", "in", "while", "until",
    "do", "done", "function", "declare", "typeset", "export", "readonly", "local", "unset",
    "unsetenv", "time", "coproc", "env", "exec", "command", "nohup", "timeout", "nice", "sudo",
    "xargs",
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

        prop_assert!(reading.is_whole, "{line:?}");
        prop_assert_eq!(
            &reading.commands,
            &vec![ShellCommand { program, argument_words, wrappers: Vec::new() }]
        );
    }
}
