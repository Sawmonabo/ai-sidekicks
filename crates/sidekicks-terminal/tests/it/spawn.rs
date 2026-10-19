//! A shell started through the terminals runs as its launch says, delivers its output, then the
//! exit the system reported, and outlives a quiet spell of the thread that started it.

use std::time::Duration;

use bytes::Bytes;
use sidekicks_terminal::TerminalExit;

use crate::helpers::{
    KeepAllOutput, no_listener, read_past_line, read_to_exit, request, terminals,
};

/// How long tokio keeps an idle blocking thread before it ends.
const BLOCKING_THREAD_IDLE_LIFE: Duration = Duration::from_secs(10);

#[tokio::test(flavor = "multi_thread")]
async fn a_shell_delivers_its_output_then_its_exit_code() {
    let terminals = terminals();
    let program = sidekicks_platforms::echo_program("hello");
    let mut spawned = terminals
        .spawn(request(program), no_listener, KeepAllOutput)
        .await
        .expect("the shell starts");

    let (text, exit) = read_to_exit(&mut spawned.output).await;

    assert!(text.contains("hello"), "the output was {text:?}");
    assert_eq!(
        exit,
        TerminalExit {
            exit_code: 0,
            signal_code: None
        }
    );
    terminals
        .close(spawned.handle)
        .await
        .expect("an exited shell closes");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_abnormal_end_reports_the_code_and_signal_the_system_gave() {
    let terminals = terminals();
    let abnormal = sidekicks_platforms::abnormal_exit();
    let mut spawned = terminals
        .spawn(request(abnormal.program), no_listener, KeepAllOutput)
        .await
        .expect("the shell starts");

    let (_text, exit) = read_to_exit(&mut spawned.output).await;

    assert_eq!(
        exit,
        TerminalExit {
            exit_code: abnormal.exit_code,
            signal_code: abnormal.signal_code
        }
    );
}

// The shell runs in the folder and with exactly the environment its launch carries, none of the
// mode's own variables among them: fails when the frame drops or adds an entry or the folder.
#[tokio::test(flavor = "multi_thread")]
async fn a_shell_starts_in_its_launch_s_folder_with_exactly_its_environment() {
    let terminals = terminals();
    let folder = tempfile::tempdir().expect("a scratch folder");
    let mut launch = request(sidekicks_platforms::launch_printer());
    launch.shell.folder = folder.path().to_path_buf();
    launch
        .shell
        .environment
        .push(("LAUNCH_CHECK".to_owned(), "a=b c".to_owned()));
    let mut spawned = terminals
        .spawn(launch, no_listener, KeepAllOutput)
        .await
        .expect("the shell starts");

    let (text, exit) = read_to_exit(&mut spawned.output).await;

    let folder = sidekicks_platforms::real_path(folder.path()).expect("the folder resolves");
    assert!(
        text.contains(&*folder.to_string_lossy()),
        "{folder:?} not in {text:?}"
    );
    assert!(text.contains("LAUNCH_CHECK=a=b c"), "{text:?}");
    assert!(
        !text.contains("SIDEKICKS_SHELL_START_CONFIRMATION"),
        "{text:?}"
    );
    assert_eq!(exit.exit_code, 0, "{text:?}");
}

// A shell outlives a quiet spell longer than tokio's blocking threads live, since the thread that
// started it, whose end Linux tells the shell as its parent's death, is the spawner's own.
#[tokio::test(flavor = "multi_thread")]
async fn a_shell_is_alive_after_the_spawner_has_idled_past_a_blocking_thread_s_life() {
    let terminals = terminals();
    let mut spawned = terminals
        .spawn(
            request(sidekicks_platforms::waiting_printer(1)),
            no_listener,
            KeepAllOutput,
        )
        .await
        .expect("the shell starts");
    read_past_line(&mut spawned.output, "ready").await;

    tokio::time::sleep(BLOCKING_THREAD_IDLE_LIFE + Duration::from_secs(5)).await;
    terminals
        .queue_write(spawned.handle, Bytes::from_static(b"go\r\n"))
        .expect("the input line is handed over")
        .taken()
        .await
        .expect("the input line is taken");
    let (text, exit) = read_to_exit(&mut spawned.output).await;

    assert!(text.contains('0'), "{text:?}");
    assert_eq!(exit.exit_code, 0, "{text:?}");
}
