//! Writes to a shell over one client: past the shell's window a pane's keys join into its next
//! write, sent as an answer returns, and an interrupt goes at once with the writes queued before
//! it; every pane typing into the shell shares that window and the order of writes; a paste goes
//! in whole parts never joined with keys; a refusal reaches only the pane that typed the write; a
//! closed pane's unsent keys go with it; and keys may be typed from a thread outside the runtime,
//! as the desktop's JavaScript thread types them.

use std::time::Duration;

use serde_json::{Value, json};
use sidekicks_client::error::ClientError;
use sidekicks_client::terminal_write::{ShellInput, ShellTarget, WriteNotice};
use sidekicks_client::transport::json_rpc::JsonRpcClient;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::jsonrpc::streaming::SubscriptionId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::terminal::{
    TERMINAL_WRITE_MAX_BYTES, TERMINAL_WRITES_WAITING_PER_SHELL, TerminalId,
};
use tokio::io::DuplexStream;

use crate::helpers::{PATIENCE, ScriptedDaemon, open_link};

const QUIET: Duration = Duration::from_secs(5);

const FIRST_PANE: &str = "0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c0001";
const SECOND_PANE: &str = "0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c0002";

/// The shell every case types into, through the pane whose output subscription is `pane`.
fn target(pane: &str) -> ShellTarget {
    ShellTarget {
        session_id: SessionId::new("0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c1001").expect("a session id"),
        terminal_id: TerminalId::new("shell-1".to_owned()).expect("a terminal id"),
        output_subscription_id: SubscriptionId::new(pane).expect("a subscription id"),
    }
}

/// Types one key at a time from `input` until the shell's window is full, answering the ids of
/// the writes waiting.
async fn fill_the_window(
    input: &ShellInput,
    daemon: &mut ScriptedDaemon<DuplexStream>,
) -> Vec<Value> {
    let mut waiting = Vec::new();
    for key in 0..TERMINAL_WRITES_WAITING_PER_SHELL {
        input.type_keys(&key.to_string());
        let write = daemon.next_message().await;
        assert_eq!(write["params"]["data"], key.to_string());
        waiting.push(write["id"].clone());
    }
    waiting
}

#[tokio::test(start_paused = true)]
async fn keys_past_the_window_join_and_an_interrupt_goes_at_once() {
    let client = JsonRpcClient::new();
    let (_link, mut daemon) = open_link(&client).await;
    let (input, _notices) = ShellInput::open(&client, target(FIRST_PANE));

    let mut waiting = fill_the_window(&input, &mut daemon).await;
    input.type_keys("a");
    input.type_keys("b");
    daemon.assert_no_message_within(QUIET).await;

    daemon.answer(&waiting.remove(0), json!(null)).await;
    let joined = daemon.next_message().await;
    assert_eq!(
        joined["params"]["data"], "ab",
        "the keys typed past the window join"
    );

    input.type_keys("c");
    input.type_keys("\u{3}");
    let interrupt = daemon.next_message().await;
    assert_eq!(
        interrupt["params"]["data"], "c\u{3}",
        "an interrupt goes at once, after the keys typed before it"
    );
}

#[tokio::test(start_paused = true)]
async fn two_panes_on_one_shell_share_the_window_and_keep_their_order() {
    let client = JsonRpcClient::new();
    let (_link, mut daemon) = open_link(&client).await;
    let (first, _first_notices) = ShellInput::open(&client, target(FIRST_PANE));
    let (second, _second_notices) = ShellInput::open(&client, target(SECOND_PANE));

    let mut waiting = Vec::new();
    for key in 0..TERMINAL_WRITES_WAITING_PER_SHELL {
        let pane = if key % 2 == 0 { &first } else { &second };
        pane.type_keys(&key.to_string());
        waiting.push(daemon.next_message().await["id"].clone());
    }
    first.type_keys("a");
    second.type_keys("b");
    first.type_keys("c");
    daemon.assert_no_message_within(QUIET).await;

    let mut sent = Vec::new();
    for _ in 0..3 {
        daemon.answer(&waiting.remove(0), json!(null)).await;
        let write = daemon.next_message().await;
        sent.push((
            write["params"]["data"].clone(),
            write["params"]["outputSubscriptionId"].clone(),
        ));
        daemon.assert_no_message_within(QUIET).await;
    }
    assert_eq!(
        sent,
        [
            (json!("a"), json!(FIRST_PANE)),
            (json!("b"), json!(SECOND_PANE)),
            (json!("c"), json!(FIRST_PANE)),
        ],
        "both panes wait behind one window, in the order they typed, each key under its own pane"
    );
}

#[tokio::test(start_paused = true)]
async fn a_paste_s_parts_leave_whole_and_unjoined_with_keys() {
    let client = JsonRpcClient::new();
    let (_link, mut daemon) = open_link(&client).await;
    let (input, _notices) = ShellInput::open(&client, target(FIRST_PANE));

    let mut waiting = fill_the_window(&input, &mut daemon).await;
    let whole_part = "é".repeat(TERMINAL_WRITE_MAX_BYTES / 2);
    input.type_keys("x");
    input.paste(&format!("{whole_part}tail"));
    input.type_keys("y");

    let mut sent = Vec::new();
    for _ in 0..4 {
        daemon.answer(&waiting.remove(0), json!(null)).await;
        sent.push(daemon.next_message().await["params"].clone());
    }
    let paste_id = &sent[1]["pasteId"];
    assert!(paste_id.is_string(), "the paste names its id");
    assert_eq!(
        sent,
        [
            json!({ "kind": "keys", "data": "x" }),
            json!({ "kind": "paste", "data": whole_part, "pasteId": paste_id, "isLastPart": false }),
            json!({ "kind": "paste", "data": "tail", "pasteId": paste_id, "isLastPart": true }),
            json!({ "kind": "keys", "data": "y" }),
        ]
        .map(|mut expected| {
            expected["sessionId"] = json!("0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c1001");
            expected["terminalId"] = json!("shell-1");
            expected["outputSubscriptionId"] = json!(FIRST_PANE);
            expected
        }),
        "each part goes as it was cut, and the keys around it stay their own writes"
    );
}

#[tokio::test(start_paused = true)]
async fn a_refused_write_reaches_only_the_pane_that_typed_it() {
    let client = JsonRpcClient::new();
    let (_link, mut daemon) = open_link(&client).await;
    let (first, mut first_notices) = ShellInput::open(&client, target(FIRST_PANE));
    let (second, mut second_notices) = ShellInput::open(&client, target(SECOND_PANE));

    first.type_keys("a");
    let refused = daemon.next_message().await;
    second.type_keys("b");
    let taken = daemon.next_message().await;
    daemon
        .refuse(&refused["id"], RefusalCode::TerminalWriteLimitReached)
        .await;
    daemon.answer(&taken["id"], json!(null)).await;

    let notice = tokio::time::timeout(PATIENCE, first_notices.recv()).await;
    assert!(
        matches!(
            notice,
            Ok(Some(WriteNotice::Refused(ClientError::Remote(ref refusal))))
                if refusal.is_refusal(RefusalCode::TerminalWriteLimitReached)
        ),
        "the pane that typed the write hears its refusal, not {notice:?}"
    );
    let notice = tokio::time::timeout(PATIENCE, second_notices.recv()).await;
    assert!(
        matches!(notice, Ok(Some(WriteNotice::Taken))),
        "the other pane hears only its own write taken, not {notice:?}"
    );
    tokio::time::sleep(QUIET).await;
    assert!(first_notices.try_recv().is_err() && second_notices.try_recv().is_err());

    first.type_keys("c");
    let again = daemon.next_message().await;
    daemon.answer(&again["id"], json!(null)).await;
    let notice = tokio::time::timeout(PATIENCE, first_notices.recv()).await;
    assert!(
        matches!(notice, Ok(Some(WriteNotice::Taken))),
        "the pane's next write taken clears its refusal, not {notice:?}"
    );
}

#[tokio::test(start_paused = true)]
async fn a_closed_pane_s_unsent_keys_are_dropped() {
    let client = JsonRpcClient::new();
    let (_link, mut daemon) = open_link(&client).await;
    let (first, mut first_notices) = ShellInput::open(&client, target(FIRST_PANE));
    let (second, _second_notices) = ShellInput::open(&client, target(SECOND_PANE));

    let mut waiting = fill_the_window(&first, &mut daemon).await;
    first.type_keys("lost");
    second.type_keys("kept");
    drop(first);
    daemon.assert_no_message_within(QUIET).await;
    assert!(
        tokio::time::timeout(PATIENCE, first_notices.recv())
            .await
            .expect("the closed pane's notices end")
            .is_none(),
        "the closed pane is told nothing more"
    );

    daemon.answer(&waiting.remove(0), json!(null)).await;
    let write = daemon.next_message().await;
    assert_eq!(
        (
            &write["params"]["data"],
            &write["params"]["outputSubscriptionId"]
        ),
        (&json!("kept"), &json!(SECOND_PANE)),
        "the closed pane's writes still counted, and its unsent keys went with it"
    );
    daemon.assert_no_message_within(QUIET).await;
}

#[tokio::test]
async fn keys_typed_from_a_thread_outside_the_runtime_are_written() {
    let client = JsonRpcClient::new();
    let (_link, mut daemon) = open_link(&client).await;
    let (input, _notices) = ShellInput::open(&client, target(FIRST_PANE));

    let typing = std::thread::spawn(move || {
        input.type_keys("x");
        input
    });
    let _input = typing
        .join()
        .expect("typing outside the runtime does not panic");
    let write = daemon.next_message().await;
    assert_eq!(write["params"]["data"], "x");
}
