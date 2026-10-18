//! A paused shell's output waits in the terminal, and the resume delivers all of it in order.

use std::time::Duration;

use bytes::Bytes;
use sidekicks_terminal::{TerminalEvent, TerminalExit, TerminalOutput};
use tokio::time::timeout;

use crate::helpers::{
    KeepAllOutput, OUTPUT_BOUND, no_listener, read_past_line, read_to_exit, request, terminals,
};

/// How many numbered lines the program prints, far more than the output's bound and a terminal's
/// buffers hold together.
const LINE_COUNT: usize = 100_000;

/// How long the output stays quiet before the pause counts as holding it.
const QUIET_PERIOD: Duration = Duration::from_millis(500);

/// Takes the output's chunks until it stays quiet for [`QUIET_PERIOD`], answering their text;
/// fails the test on the output's end or exit.
async fn read_until_quiet(output: &mut TerminalOutput) -> String {
    let mut text = String::new();
    while let Ok(event) = timeout(QUIET_PERIOD, output.next()).await {
        let chunk = match event {
            Some(TerminalEvent::Output(chunk)) => Ok(chunk),
            other => Err(format!("the output ended while paused: {other:?}")),
        }
        .expect("the output stays open while paused");
        text.push_str(&String::from_utf8_lossy(&chunk));
    }
    text
}

#[tokio::test(flavor = "multi_thread")]
async fn a_paused_shell_leaves_its_output_waiting_and_the_resume_delivers_it_in_order() {
    let terminals = terminals();
    let program = sidekicks_platforms::waiting_printer(LINE_COUNT);
    let mut spawned = terminals
        .spawn(request(program), no_listener, KeepAllOutput)
        .await
        .expect("the shell starts");
    let mut text = read_past_line(&mut spawned.output, "ready").await;

    // The program prints far more than the output's bound, so it is still printing when the
    // pause comes; the chunks already read arrive, then the output holds.
    terminals
        .queue_write(spawned.handle, Bytes::from_static(b"go\r\n"))
        .expect("the input line is handed over")
        .taken()
        .await
        .expect("the input line is taken");
    terminals.pause(spawned.handle).expect("the shell pauses");
    text += &read_until_quiet(&mut spawned.output).await;

    // A write while paused is taken. Where a paused read would hold the program's input back, the
    // loop reads on after it until the output is empty, so output arrives; elsewhere the pause
    // holds.
    terminals
        .queue_write(spawned.handle, Bytes::from_static(b"more\r\n"))
        .expect("a second line is handed over")
        .taken()
        .await
        .expect("the second line is taken");
    if sidekicks_platforms::DOES_PAUSED_READ_HOLD_INPUT {
        let event = timeout(OUTPUT_BOUND, spawned.output.next())
            .await
            .expect("output arrives after a write while paused");
        let Some(TerminalEvent::Output(chunk)) = event else {
            panic!("the output ended while paused: {event:?}");
        };
        text.push_str(&String::from_utf8_lossy(&chunk));
        text += &read_until_quiet(&mut spawned.output).await;
    } else {
        assert!(
            read_until_quiet(&mut spawned.output).await.is_empty(),
            "output arrived while the shell was paused"
        );
    }

    terminals.resume(spawned.handle).expect("the shell resumes");
    let (rest, exit) = read_to_exit(&mut spawned.output).await;
    let after_exit = timeout(OUTPUT_BOUND, spawned.output.next())
        .await
        .expect("the output ends after the exit");

    text += &rest;
    let numbers: Vec<usize> = text
        .split('\n')
        .map(|line| line.trim_end_matches('\r'))
        .filter(|line| !line.is_empty() && line.bytes().all(|byte| byte.is_ascii_digit()))
        .map(|line| line.parse().expect("a line of digits is a number"))
        .collect();
    assert_eq!(numbers, (0..LINE_COUNT).collect::<Vec<_>>());
    assert_eq!(
        exit,
        TerminalExit {
            exit_code: 0,
            signal_code: None
        }
    );
    assert_eq!(after_exit, None, "an event came after the exit");
}
