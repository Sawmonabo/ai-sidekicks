//! What the terminal tests share: the terminals, a request for a test program, and the output
//! read through to the exit.

use std::time::Duration;

use alacritty_terminal::event::EventListener;
use sidekicks_platforms::{Spawner, TestProgram};
use sidekicks_terminal::{
    CommandLine, OutputFilter, ScreenListener, SpawnRequest, TerminalAnswers, TerminalEvent,
    TerminalExit, TerminalOutput, Terminals,
};

/// The bound on every wait for a test shell's output or exit, so a stalled loop fails the test.
pub(crate) const OUTPUT_BOUND: Duration = Duration::from_secs(30);

/// Keeps every byte of the output.
pub(crate) struct KeepAllOutput;

impl OutputFilter for KeepAllOutput {
    fn filter(&mut self, chunk: &[u8], kept: &mut Vec<u8>) {
        kept.extend_from_slice(chunk);
    }

    fn finish(&mut self, _kept: &mut Vec<u8>) {}
}

/// A screen-copy listener that hears nothing and answers nothing.
#[derive(Clone)]
pub(crate) struct NoListener;

impl EventListener for NoListener {}

impl ScreenListener for NoListener {
    fn find_questions(&mut self, _output: &[u8], _ends: &mut Vec<usize>) {}

    fn answer_question(&mut self) {}
}

/// Makes the listener that hears nothing, leaving the shell's answers unused.
pub(crate) fn no_listener(_answers: TerminalAnswers) -> NoListener {
    NoListener
}

/// Terminals on a spawner thread of their own; no test here stops a shell through the console,
/// so the console helper is never run.
pub(crate) fn terminals() -> Terminals {
    let spawner = Spawner::new(tokio::runtime::Handle::current()).expect("the spawner starts");
    Terminals::new(
        spawner,
        CommandLine {
            program: "console-helper".to_owned(),
            arguments: Vec::new(),
        },
    )
}

/// A 24 by 80 terminal running `program` in the test's folder, through the platform's
/// pass-through start.
pub(crate) fn request(program: TestProgram) -> SpawnRequest {
    let start = sidekicks_platforms::pass_through_start();
    SpawnRequest {
        program: program.program,
        arguments: program.arguments,
        environment: vec![("TERM".to_owned(), "xterm-256color".to_owned())],
        working_directory: std::env::current_dir().expect("the test runs in a folder"),
        rows: 24,
        columns: 80,
        shell_start: CommandLine {
            program: start.program,
            arguments: start.arguments,
        },
    }
}

/// Reads the output through the exit, answering the text and the exit; fails the test when the
/// output ends with no exit or takes past [`OUTPUT_BOUND`].
pub(crate) async fn read_to_exit(output: &mut TerminalOutput) -> (String, TerminalExit) {
    tokio::time::timeout(OUTPUT_BOUND, async {
        let mut text = String::new();
        loop {
            let event = output
                .next()
                .await
                .ok_or_else(|| format!("the output ended with no exit, after {text:?}"))
                .expect("the shell's output ends with its exit");
            match event {
                TerminalEvent::Output(chunk) => text.push_str(&String::from_utf8_lossy(&chunk)),
                TerminalEvent::Exit(exit) => return (text, exit),
            }
        }
    })
    .await
    .expect("the shell exits in time")
}
