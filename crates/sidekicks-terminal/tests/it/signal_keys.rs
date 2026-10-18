//! A key the terminal's settings turn into a signal reaches a program whose input is full.

use bytes::Bytes;
use sidekicks_terminal::TerminalExit;

use crate::helpers::{
    KeepAllOutput, no_listener, read_past_line, read_to_exit, request, terminals,
};

/// More input than a terminal holds unread, so the write never finishes.
const FILLING_INPUT_BYTES: usize = 128 * 1024;

#[tokio::test(flavor = "multi_thread")]
async fn an_interrupt_key_ends_a_program_that_reads_none_of_its_full_input() {
    let terminals = terminals();
    let sleeper = sidekicks_platforms::interruptible_sleeper();
    let mut spawned = terminals
        .spawn(request(sleeper.program), no_listener, KeepAllOutput)
        .await
        .expect("the shell starts");
    read_past_line(&mut spawned.output, "ready").await;

    terminals
        .queue_write(spawned.handle, Bytes::from(vec![b'a'; FILLING_INPUT_BYTES]))
        .expect("the filling input is handed over")
        .taken()
        .await
        .expect("the filling input is taken");
    terminals
        .queue_write(spawned.handle, Bytes::from_static(b"\x03"))
        .expect("the interrupt key is handed over")
        .taken()
        .await
        .expect("the interrupt key is taken");

    let (_text, exit) = read_to_exit(&mut spawned.output).await;
    assert_eq!(
        exit,
        TerminalExit {
            exit_code: sleeper.exit_code,
            signal_code: sleeper.signal_code
        }
    );
}
