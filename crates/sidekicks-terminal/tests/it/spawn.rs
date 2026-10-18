//! A shell started through the terminals is confirmed to its `shell` mode where the system asks
//! for that, and delivers its output, then the exit the system reported.

use sidekicks_platforms::ShellStartConfirmation;
use sidekicks_terminal::TerminalExit;

use crate::helpers::{KeepAllOutput, no_listener, read_to_exit, request, terminals};

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

#[tokio::test(flavor = "multi_thread")]
async fn a_shell_s_start_is_confirmed_with_its_own_process_id_where_the_system_asks() {
    let terminals = terminals();
    let program = sidekicks_platforms::start_confirmation_reader();
    let mut spawned = terminals
        .spawn(request(program), no_listener, KeepAllOutput)
        .await
        .expect("the shell starts");

    let (text, _exit) = read_to_exit(&mut spawned.output).await;

    let does_system_confirm = ShellStartConfirmation::new()
        .expect("a confirmation opens")
        .environment_entry()
        .is_some();
    let expected = match spawned.process_id {
        Some(process_id) if does_system_confirm => {
            format!("confirmed {process_id} started {process_id}")
        }
        _ => "unconfirmed".to_owned(),
    };
    assert!(
        text.contains(&expected),
        "expected {expected:?} in {text:?}"
    );
}
