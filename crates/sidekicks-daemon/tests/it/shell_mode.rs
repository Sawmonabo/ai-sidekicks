//! The daemon's `shell` mode, run as the daemon's own program: a shell that cannot start gives way
//! to the fallback shell with one line above its prompt, and a mode the daemon never confirmed
//! starts nothing.

use std::process::Stdio;
use std::time::Duration;

use alacritty_terminal::event::EventListener;
use sidekicks_platforms::{default_shell, run_test_as_own_root};
use sidekicks_terminal::{
    CommandLine, OutputFilter, ScreenListener, ShellCommand, SpawnRequest, TerminalEvent, Terminals,
};

use crate::helpers::{DAEMON_PROGRAM, spawner};

/// The bound on each wait, so a mode that hangs fails the test.
const WAIT_BOUND: Duration = Duration::from_secs(30);

/// Keeps every byte of the output.
struct KeepAllOutput;

impl OutputFilter for KeepAllOutput {
    fn filter(&mut self, chunk: &[u8], kept: &mut Vec<u8>) {
        kept.extend_from_slice(chunk);
    }

    fn finish(&mut self, _kept: &mut Vec<u8>) {}
}

/// A screen-copy listener that hears nothing and answers nothing.
#[derive(Clone)]
struct NoListener;

impl EventListener for NoListener {}

impl ScreenListener for NoListener {
    fn find_questions(&mut self, _output: &[u8], _ends: &mut Vec<usize>) {}

    fn answer_question(&mut self) {}
}

// The test's own name in the binary, which runs again as its own responsible process on macOS.
const FALLBACK_TEST: &str =
    "shell_mode::a_shell_that_cannot_start_gives_way_to_the_fallback_with_a_line_saying_so";

#[test]
fn a_shell_that_cannot_start_gives_way_to_the_fallback_with_a_line_saying_so() {
    // The `shell` mode starts a shell only for a parent that is its own responsible process, as
    // the daemon is.
    run_test_as_own_root(FALLBACK_TEST, || {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("the test's runtime builds");
        runtime.block_on(async {
            let scratch = tempfile::tempdir().expect("a scratch folder");
            let missing = scratch.path().join("missing-shell");
            let missing = missing.to_string_lossy().into_owned();
            let fallback = default_shell().to_string_lossy().into_owned();
            let environment: Vec<(String, String)> = std::env::vars().collect();
            let command = |program: &str| ShellCommand {
                program: program.to_owned(),
                arguments: Vec::new(),
                environment: environment.clone(),
                folder: scratch.path().to_path_buf(),
                raw_command_tail: None,
            };
            let request = SpawnRequest {
                shell: command(&missing),
                fallback: command(&fallback),
                working_directory: scratch.path().to_path_buf(),
                rows: 24,
                columns: 200,
                shell_start: CommandLine {
                    program: DAEMON_PROGRAM.to_owned(),
                    arguments: vec!["shell".to_owned(), std::process::id().to_string()],
                },
            };
            let terminals = Terminals::new(
                spawner(),
                CommandLine {
                    program: "console-helper".to_owned(),
                    arguments: Vec::new(),
                },
            );
            let mut spawned = terminals
                .spawn(request, |_answers| NoListener, KeepAllOutput)
                .await
                .expect("the shell mode starts");
            let notice =
                format!("Could not start {missing} (no such file), so this tab runs {fallback}.");
            let title = format!(
                "\x1b]2;{}\x07",
                std::path::Path::new(&fallback)
                    .file_name()
                    .expect("the fallback has a file name")
                    .to_string_lossy()
            );
            let text = tokio::time::timeout(WAIT_BOUND, async {
                let mut text = String::new();
                while !text.contains(&notice) {
                    match spawned.output.next().await {
                        Some(TerminalEvent::Output(chunk)) => {
                            text.push_str(&String::from_utf8_lossy(&chunk));
                        }
                        other => panic!("the output ended before the notice: {other:?} {text:?}"),
                    }
                }
                text
            })
            .await
            .expect("the notice arrives in time");
            assert!(text.starts_with(&title), "the title comes first: {text:?}");
            terminals
                .close(spawned.handle)
                .await
                .expect("the fallback shell closes");
        });
    });
}

#[tokio::test]
async fn a_shell_mode_the_daemon_never_confirmed_starts_nothing() {
    let mut mode = tokio::process::Command::new(DAEMON_PROGRAM);
    mode.args(["shell", &std::process::id().to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let output = tokio::time::timeout(WAIT_BOUND, mode.output())
        .await
        .expect("the mode ends in time")
        .expect("the mode runs");
    assert!(!output.status.success(), "{output:?}");
    assert!(output.stdout.is_empty(), "{output:?}");
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("the shell mode started no shell"),
        "{output:?}"
    );
}
