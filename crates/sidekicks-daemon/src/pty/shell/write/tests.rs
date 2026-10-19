use std::sync::{Arc, OnceLock};
use std::time::Duration;

use alacritty_terminal::event::{Event, EventListener};
use bytes::Bytes;
use futures::FutureExt as _;
use serde_json::json;
use sidekicks_contracts::jsonrpc::streaming::SubscriptionId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::terminal::{TERMINAL_WRITE_MAX_BYTES, TerminalId};
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_platforms::Spawner;
use sidekicks_terminal::{
    CommandLine, OutputFilter, ScreenListener, ShellCommand, SpawnRequest, TerminalAnswers,
    TerminalError, TerminalEvent, TerminalHandle, TerminalOutput, TerminalWriteError, Terminals,
};
use tokio::runtime::Handle;

use super::{ShellInput, ShellInputHooks};
use crate::ipc::call_fixtures::{context, request};
use crate::ipc::handlers::terminal::{ShellInputLookup, register_terminal_write};
use crate::ipc::registry::{Dispatch, MethodRegistryBuilder, Request, TransportId};
use crate::pty::control_lease::{ShellConnection, ShellControlLease, ShellLeaseCaller};

const SESSION: &str = "0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c9d0e";
const FIRST_PANE: &str = "0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c0001";
const SECOND_PANE: &str = "0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c0002";
const PASTE: &str = "0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c0003";
/// How long the program may take to show each line the test waits for.
const OUTPUT_BOUND: Duration = Duration::from_secs(30);

/// Keeps every byte of the output.
struct KeepAllOutput;

impl OutputFilter for KeepAllOutput {
    fn filter(&mut self, chunk: &[u8], kept: &mut Vec<u8>) {
        kept.extend_from_slice(chunk);
    }

    fn finish(&mut self, _kept: &mut Vec<u8>) {}
}

/// Hands the screen copy's answers to the shell's input, as the shell's own listener does.
#[derive(Clone)]
struct AnswerThroughInput(Arc<ShellInput>);

impl EventListener for AnswerThroughInput {
    fn send_event(&self, event: Event) {
        if let Event::PtyWrite(answer) = event {
            self.0.answer(Bytes::from(answer));
        }
    }
}

impl ScreenListener for AnswerThroughInput {
    fn find_questions(&mut self, _output: &[u8], _ends: &mut Vec<usize>) {}

    fn answer_question(&mut self) {}
}

/// One write's params through `pane`.
fn write(pane: &str, data: &str, paste: Option<bool>) -> Request {
    let mut params = json!({
        "kind": "keys",
        "sessionId": SESSION,
        "terminalId": "terminal-1",
        "outputSubscriptionId": pane,
        "data": data,
    });
    if let Some(is_last_part) = paste {
        params["kind"] = json!("paste");
        params["pasteId"] = json!(PASTE);
        params["isLastPart"] = json!(is_last_part);
    }
    request("terminal.write", Some(&params))
}

/// Reads the output until it holds `marker`, answering everything read so far.
async fn read_until(output: &mut TerminalOutput, text: &mut String, marker: &str) {
    tokio::time::timeout(OUTPUT_BOUND, async {
        while !text.contains(marker) {
            let event = output.next().await;
            let Some(TerminalEvent::Output(chunk)) = &event else {
                return Err(format!("the output ended before {marker:?}: {event:?}"));
            };
            text.push_str(&String::from_utf8_lossy(chunk));
        }
        Ok(())
    })
    .await
    .expect("the marker arrives in time")
    .expect("the output holds the marker");
}

/// The `shell` mode's stand-in's test, which the test shell starts through.
const SHELL_MODE_STAND_IN: &str =
    "pty::shell::write::tests::the_shell_mode_stand_in_starts_the_launched_shell";

#[test]
#[ignore = "run only as the shell mode's stand-in, in a test shell's terminal"]
fn the_shell_mode_stand_in_starts_the_launched_shell() {
    let error = sidekicks_platforms::run_shell_start_stand_in();
    panic!("the stand-in did not start the launched shell: {error:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn writes_from_two_connections_and_the_screen_s_answers_reach_the_program_in_admission_order()
{
    let folder = tempfile::tempdir().expect("a scratch folder");
    let recorded = folder.path().join("input");
    let terminals = Arc::new(Terminals::new(
        Spawner::new(Handle::current()).expect("the spawner starts"),
        CommandLine {
            program: "console-helper".to_owned(),
            arguments: Vec::new(),
        },
    ));
    let handle: Arc<OnceLock<TerminalHandle>> = Arc::default();
    let answers: Arc<OnceLock<TerminalAnswers>> = Arc::default();
    let terminal_id = TerminalId::new("terminal-1".to_owned()).expect("a terminal id");
    let lease = Arc::new(ShellControlLease::new(
        SessionId::new(SESSION).expect("a session id"),
        terminal_id.clone(),
        DeviceId::new("device-machine".to_owned()).expect("a device id"),
        Arc::new(|_change| async { Ok(()) }.boxed()),
        Arc::new(|_caller: &ShellLeaseCaller| Ok(())),
    ));
    let input = ShellInput::new(
        terminal_id,
        Arc::clone(&lease),
        ShellInputHooks {
            queue_write: Box::new({
                let terminals = Arc::clone(&terminals);
                let handle = Arc::clone(&handle);
                move |bytes| {
                    let handle = *handle.get().expect("writes come after the spawn");
                    match terminals.queue_write(handle, bytes) {
                        Ok(write) => write.taken().boxed(),
                        Err(TerminalError::Write(error)) => async { Err(error) }.boxed(),
                        Err(_unknown) => async { Err(TerminalWriteError::Closed) }.boxed(),
                    }
                }
            }),
            queue_answer: Box::new({
                let answers = Arc::clone(&answers);
                move |answer| {
                    answers
                        .get()
                        .expect("the answers are set before the screen draws")
                        .queue(answer);
                }
            }),
            is_bracketed_paste_requested: Box::new(|| false),
        },
        Handle::current(),
    );

    let paste: Vec<String> = (b'a'..=b'd')
        .map(|letter| char::from(letter).to_string().repeat(51_200))
        .collect();
    let byte_count = "\x1b[?6c".len() + "one".len() + "two".len() + 4 * 51_200 + "three".len();
    let start = sidekicks_platforms::pass_through_start(SHELL_MODE_STAND_IN);
    let program = sidekicks_platforms::input_recorder(&recorded, byte_count);
    let shell = ShellCommand {
        program: program.program,
        arguments: program.arguments,
        environment: vec![("TERM".to_owned(), "xterm-256color".to_owned())],
        folder: folder.path().to_owned(),
        raw_command_tail: None,
    };
    let mut spawned = terminals
        .spawn(
            SpawnRequest {
                fallback: ShellCommand {
                    program: sidekicks_platforms::default_shell()
                        .to_string_lossy()
                        .into_owned(),
                    arguments: Vec::new(),
                    ..shell.clone()
                },
                shell,
                working_directory: folder.path().to_owned(),
                rows: 24,
                columns: 80,
                shell_start: CommandLine {
                    program: start.program,
                    arguments: start.arguments,
                },
            },
            {
                let answers = Arc::clone(&answers);
                let input = Arc::clone(&input);
                move |terminal_answers| {
                    assert!(answers.set(terminal_answers).is_ok(), "one spawn");
                    AnswerThroughInput(input)
                }
            },
            KeepAllOutput,
        )
        .await
        .expect("the shell starts");
    assert!(handle.set(spawned.handle).is_ok(), "one spawn");
    let mut text = String::new();
    // The question comes before `ready`, so its answer is in line before any write.
    read_until(&mut spawned.output, &mut text, "ready").await;

    let lookup: ShellInputLookup = Arc::new(move |_session, _terminal| Ok(Arc::clone(&input)));
    let mut builder = MethodRegistryBuilder::new();
    register_terminal_write(&mut builder, lookup).expect("terminal.write registers");
    let registry = builder.freeze();
    // Both connections of the device hold the shell, each through its own pane.
    for (transport, pane) in [(1, FIRST_PANE), (2, SECOND_PANE)] {
        let caller = ShellLeaseCaller {
            connection: ShellConnection {
                device_id: DeviceId::new("device".to_owned()).expect("a device id"),
                transport_id: TransportId(transport),
            },
            output_subscription_id: SubscriptionId::new(pane).expect("a subscription id"),
        };
        lease
            .take(&caller, false)
            .await
            .expect("the device takes the shell");
    }
    const {
        assert!(
            TERMINAL_WRITE_MAX_BYTES > 51_200 + 2,
            "each paste part fits one write"
        );
    }

    let mut calls = vec![
        registry.dispatch(write(FIRST_PANE, "one", None), context(1)),
        registry.dispatch(write(SECOND_PANE, "two", None), context(2)),
    ];
    for (index, part) in paste.iter().enumerate() {
        calls.push(registry.dispatch(write(FIRST_PANE, part, Some(index == 3)), context(1)));
    }
    calls.push(registry.dispatch(write(SECOND_PANE, "three", None), context(2)));
    // Awaited last to first, so the order can only come from each call's dispatch, never its poll.
    for call in calls.into_iter().rev() {
        tokio::time::timeout(OUTPUT_BOUND, call)
            .await
            .expect("each write is taken in time")
            .expect("each write is answered");
    }
    read_until(&mut spawned.output, &mut text, "done").await;

    let mut expected = b"\x1b[?6cone".to_vec();
    expected.extend_from_slice(b"two");
    for part in &paste {
        expected.extend_from_slice(part.as_bytes());
    }
    expected.extend_from_slice(b"three");
    let written = std::fs::read(&recorded).expect("the program recorded its input");
    assert_eq!(written.len(), expected.len());
    assert!(
        written == expected,
        "the input arrived in admission order, the paste whole"
    );
}
