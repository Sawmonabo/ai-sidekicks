//! A paused shell's output waits in the terminal, and the resume delivers all of it in order.

use std::time::Duration;

use bytes::Bytes;
use sidekicks_terminal::{TerminalEvent, TerminalExit};
use tokio::time::timeout;

use crate::helpers::{KeepAllOutput, OUTPUT_BOUND, no_listener, read_to_exit, request, terminals};

/// How many numbered lines the program prints, far more than a terminal's buffer holds.
const LINE_COUNT: usize = 20_000;

#[tokio::test(flavor = "multi_thread")]
async fn a_paused_shell_leaves_its_output_waiting_and_the_resume_delivers_it_in_order() {
    let terminals = terminals();
    let program = sidekicks_platforms::waiting_printer(LINE_COUNT);
    let mut spawned = terminals
        .spawn(request(program), no_listener, KeepAllOutput)
        .await
        .expect("the shell starts");

    let mut before_input = String::new();
    timeout(OUTPUT_BOUND, async {
        while !before_input.contains("ready\r\n") {
            match spawned.output.next().await {
                Some(TerminalEvent::Output(chunk)) => {
                    before_input.push_str(&String::from_utf8_lossy(&chunk));
                }
                other => panic!("the output ended before `ready`: {other:?}"),
            }
        }
    })
    .await
    .expect("the program says it is ready");
    let after_ready = before_input
        .split_once("ready\r\n")
        .map(|(_, rest)| rest.to_owned())
        .expect("the marker was read");

    terminals.pause(spawned.handle).expect("the shell pauses");
    terminals
        .queue_write(spawned.handle, Bytes::from_static(b"go\r\n"))
        .expect("the input line is handed over")
        .taken()
        .await
        .expect("the input line is taken");
    assert!(
        timeout(Duration::from_millis(500), spawned.output.next())
            .await
            .is_err(),
        "output arrived while the shell was paused"
    );

    terminals.resume(spawned.handle).expect("the shell resumes");
    let (rest, exit) = read_to_exit(&mut spawned.output).await;
    let after_exit = timeout(OUTPUT_BOUND, spawned.output.next())
        .await
        .expect("the output ends after the exit");

    let text = after_ready + &rest;
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
