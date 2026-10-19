//! What the terminal tests share: the terminals, a request for a test program, and the output
//! read through to the exit.

use std::time::Duration;

use alacritty_terminal::event::EventListener;
use sidekicks_platforms::{Spawner, TestProgram};
use sidekicks_terminal::{
    CommandLine, OutputFilter, ScreenListener, ShellCommand, SpawnRequest, TerminalAnswers,
    TerminalEvent, TerminalExit, TerminalOutput, Terminals,
};

/// The `shell` mode's stand-in's test, which every test shell starts through.
const SHELL_MODE_STAND_IN: &str = "helpers::the_shell_mode_stand_in_starts_the_launched_shell";

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

/// Terminals on a spawner thread of their own, their console helper a program that does not
/// exist: no test here stops a shell through the console, and on Windows a console reading the
/// answers ask for fails to start it, logged, which leaves the answers flowing.
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

/// A 24 by 80 terminal running `program` in the test's folder, through the `shell` mode's
/// stand-in, the platform's default shell its fallback.
pub(crate) fn request(program: TestProgram) -> SpawnRequest {
    let start = sidekicks_platforms::pass_through_start(SHELL_MODE_STAND_IN);
    let folder = std::env::current_dir().expect("the test runs in a folder");
    let environment = vec![("TERM".to_owned(), "xterm-256color".to_owned())];
    SpawnRequest {
        shell: ShellCommand {
            program: program.program,
            arguments: program.arguments,
            environment: environment.clone(),
            folder: folder.clone(),
            raw_command_tail: None,
        },
        fallback: ShellCommand {
            program: sidekicks_platforms::default_shell()
                .to_string_lossy()
                .into_owned(),
            arguments: Vec::new(),
            environment,
            folder: folder.clone(),
            raw_command_tail: None,
        },
        working_directory: folder,
        rows: 24,
        columns: 80,
        shell_start: CommandLine {
            program: start.program,
            arguments: start.arguments,
        },
    }
}

#[test]
#[ignore = "run only as the shell mode's stand-in, in a test shell's terminal"]
fn the_shell_mode_stand_in_starts_the_launched_shell() {
    let error = sidekicks_platforms::run_shell_start_stand_in();
    Err::<(), _>(error).expect("the stand-in starts the launched shell");
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

/// Reads the output until it holds `marker` on a line of its own, answering what came after it;
/// fails the test when the output ends first or takes past [`OUTPUT_BOUND`].
pub(crate) async fn read_past_line(output: &mut TerminalOutput, marker: &str) -> String {
    let line = format!("{marker}\r\n");
    tokio::time::timeout(OUTPUT_BOUND, async {
        let mut text = String::new();
        loop {
            if let Some((_, rest)) = text.split_once(&line) {
                return Ok(rest.to_owned());
            }
            let event = output.next().await;
            let Some(TerminalEvent::Output(chunk)) = &event else {
                return Err(format!("the output ended before {marker:?}: {event:?}"));
            };
            text.push_str(&String::from_utf8_lossy(chunk));
        }
    })
    .await
    .expect("the marker arrives in time")
    .expect("the output holds the marker")
}
