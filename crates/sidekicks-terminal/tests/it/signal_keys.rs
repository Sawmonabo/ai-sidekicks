//! A key the terminal's settings turn into a signal reaches a program whose input is full, and
//! keeps its place behind input the terminal takes.

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

#[tokio::test(flavor = "multi_thread")]
async fn an_interrupt_key_behind_a_line_the_terminal_takes_reaches_the_program_after_it() {
    let terminals = terminals();
    let program = sidekicks_platforms::echoing_line_reader();
    let mut spawned = terminals
        .spawn(request(program), no_listener, KeepAllOutput)
        .await
        .expect("the shell starts");
    read_past_line(&mut spawned.output, "ready").await;

    let line = terminals
        .queue_write(spawned.handle, Bytes::from_static(b"abc\r"))
        .expect("the line is handed over");
    let key = terminals
        .queue_write(spawned.handle, Bytes::from_static(b"\x03"))
        .expect("the key is handed over");
    // The closing line keeps the program reading until the key behind the first line is written.
    let closing = terminals
        .queue_write(spawned.handle, Bytes::from_static(b"end\r"))
        .expect("the closing line is handed over");
    line.taken().await.expect("the line is taken");
    key.taken().await.expect("the key is taken");
    closing.taken().await.expect("the closing line is taken");

    // The key reaches the program as input behind the line, which shows it as `^C`; sent as its
    // signal instead, it would show nothing.
    let (text, _exit) = read_to_exit(&mut spawned.output).await;
    assert!(
        text.contains("got:abc"),
        "the line reached the program: {text:?}"
    );
    let line_at = text.find("abc");
    let key_at = text.find("^C");
    assert!(
        line_at
            .zip(key_at)
            .is_some_and(|(line_at, key_at)| line_at < key_at),
        "the key came in line after the line: {text:?}"
    );
}
