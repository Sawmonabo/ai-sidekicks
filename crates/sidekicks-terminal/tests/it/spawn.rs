//! A shell started through the terminals delivers its output and then its exit code.

use std::time::Duration;

use alacritty_terminal::event::VoidListener;
use sidekicks_terminal::{
    CommandLine, OutputFilter, SpawnRequest, TerminalEvent, TerminalExit, Terminals,
};

/// Keeps every byte of the output.
struct KeepAllOutput;

impl OutputFilter for KeepAllOutput {
    fn filter(&mut self, chunk: &[u8], kept: &mut Vec<u8>) {
        kept.extend_from_slice(chunk);
    }

    fn finish(&mut self, _kept: &mut Vec<u8>) {}
}

#[cfg(unix)]
const SHELL: (&str, &[&str]) = ("/bin/sh", &["-c", "echo hello; exit 0"]);
#[cfg(windows)]
const SHELL: (&str, &[&str]) = ("cmd.exe", &["/c", "echo hello"]);

#[tokio::test(flavor = "multi_thread")]
async fn a_shell_delivers_its_output_then_its_exit_code() {
    let terminals = Terminals::new(
        tokio::runtime::Handle::current(),
        CommandLine {
            program: "console-helper".to_owned(),
            arguments: Vec::new(),
        },
    );
    let (program, arguments) = SHELL;
    let request = SpawnRequest {
        program: program.to_owned(),
        arguments: arguments
            .iter()
            .map(|argument| (*argument).to_owned())
            .collect(),
        environment: vec![("TERM".to_owned(), "xterm-256color".to_owned())],
        working_directory: std::env::temp_dir(),
        rows: 24,
        columns: 80,
        shell_start: None,
    };
    let mut spawned = terminals
        .spawn(&request, VoidListener, KeepAllOutput)
        .expect("the shell starts");

    let mut output = Vec::new();
    let exit = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match spawned.output.next().await {
                Some(TerminalEvent::Output(chunk)) => output.extend_from_slice(&chunk),
                Some(TerminalEvent::Exit(exit)) => return Some(exit),
                None => return None,
            }
        }
    })
    .await
    .expect("the shell exits within 10 s");

    let text = String::from_utf8_lossy(&output);
    assert!(text.contains("hello"), "the output was {text:?}");
    assert_eq!(
        exit,
        Some(TerminalExit {
            exit_code: 0,
            signal_code: None
        })
    );
    assert_eq!(spawned.output.next().await.map(|_| "an event"), None);
    terminals
        .close(spawned.handle)
        .await
        .expect("an exited shell closes");
}
