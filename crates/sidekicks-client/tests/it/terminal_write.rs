//! Writes to a shell over one client: past the shell's window a pane's keys join into its next
//! write, sent as an answer returns, and an interrupt goes at once with the writes queued before
//! it; every pane typing into the shell shares that window and the order of writes; a paste goes
//! in whole parts never joined with keys; a refusal reaches only the pane that typed the write; a
//! closed pane hands back the writes its ended stream refused and then what it had not sent,
//! which its next handle sends in order, a paste cut by the stream's end going on as one paste; a
//! finished pane sends all it queued and is done once each write is answered; and keys may be
//! typed from a thread outside the runtime, as the desktop's JavaScript thread types them.

use std::time::Duration;

use serde_json::{Value, json};
use sidekicks_client::error::ClientError;
use sidekicks_client::terminal_write::{PaneWrite, ShellInput, ShellTarget, WriteNotice};
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
const REOPENED_PANE: &str = "0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c0003";

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
    input.paste(format!("{whole_part}tail"));
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
            json!({
                "kind": "paste", "data": whole_part, "pasteId": paste_id, "isLastPart": false
            }),
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
async fn a_closed_pane_hands_back_its_unsent_writes_whole_and_in_order() {
    let client = JsonRpcClient::new();
    let (_link, mut daemon) = open_link(&client).await;
    let (first, mut first_notices) = ShellInput::open(&client, target(FIRST_PANE));
    let (second, _second_notices) = ShellInput::open(&client, target(SECOND_PANE));

    let mut waiting = fill_the_window(&first, &mut daemon).await;
    daemon.answer(&waiting.remove(0), json!(null)).await;
    first.type_keys(&"k".repeat(TERMINAL_WRITE_MAX_BYTES + 3));
    let sent_in_part = daemon.next_message().await;
    assert_eq!(
        sent_in_part["params"]["data"].as_str().map(str::len),
        Some(TERMINAL_WRITE_MAX_BYTES),
        "a run past the byte cap goes in part while the window has room"
    );
    waiting.push(sent_in_part["id"].clone());
    let notice = tokio::time::timeout(PATIENCE, first_notices.recv()).await;
    assert!(
        matches!(notice, Ok(Some(WriteNotice::Taken))),
        "the pane hears its first write taken, not {notice:?}"
    );
    let first_part = "p".repeat(TERMINAL_WRITE_MAX_BYTES);
    let second_part = "q".repeat(TERMINAL_WRITE_MAX_BYTES);
    first.paste(format!("{first_part}{second_part}tail"));
    first.type_keys("z");
    second.type_keys("kept");
    let mut left = Vec::new();
    for _ in 0..3 {
        daemon.answer(&waiting.remove(0), json!(null)).await;
        left.push(daemon.next_message().await);
    }
    assert_eq!(
        left.iter()
            .map(|write| (&write["params"]["data"], &write["params"]["isLastPart"]))
            .collect::<Vec<_>>(),
        [
            (&json!("kkk"), &Value::Null),
            (&json!(first_part), &json!(false)),
            (&json!(second_part), &json!(false)),
        ],
        "the rest of the run and the paste's first two parts leave before the stream ends"
    );

    let closing = tokio::spawn(first.close());
    daemon.answer(&waiting.remove(0), json!(null)).await;
    let kept = daemon.next_message().await;
    assert_eq!(
        (
            &kept["params"]["data"],
            &kept["params"]["outputSubscriptionId"]
        ),
        (&json!("kept"), &json!(SECOND_PANE)),
        "the closed pane's writes still counted, and none of its unsent ones went"
    );
    daemon.assert_no_message_within(QUIET).await;
    // The stream ended under the paste's second part: the daemon took what left before it.
    daemon
        .refuse(
            &left[2]["id"],
            RefusalCode::TerminalOutputSubscriptionNotFound,
        )
        .await;
    for id in waiting
        .drain(..)
        .chain([left[0]["id"].clone(), left[1]["id"].clone()])
    {
        daemon.answer(&id, json!(null)).await;
    }
    let unsent = tokio::time::timeout(PATIENCE, closing)
        .await
        .expect("the close hands back once its sent writes are answered")
        .expect("closing does not panic");
    let Some(PaneWrite::PastePart { paste_id, .. }) = unsent.first() else {
        panic!("the paste's refused part is handed back first, not {unsent:?}");
    };
    let paste_id = paste_id.clone();
    assert_eq!(
        unsent,
        [
            PaneWrite::PastePart {
                data: second_part.clone(),
                paste_id: paste_id.clone(),
                is_last_part: false,
            },
            PaneWrite::PastePart {
                data: "tail".to_owned(),
                paste_id: paste_id.clone(),
                is_last_part: true,
            },
            PaneWrite::Keys("z".to_owned()),
        ],
        "the write the ended stream refused comes back ahead of what had not left, the paste's \
         rest under its id, and none of what the daemon took"
    );
    assert!(
        tokio::time::timeout(PATIENCE, first_notices.recv())
            .await
            .expect("the closed pane's notices end")
            .is_none(),
        "the closed pane is told nothing of the writes it handed back"
    );

    let (reopened, _reopened_notices) = ShellInput::open(&client, target(REOPENED_PANE));
    reopened.resubmit(unsent);
    reopened.type_keys("after");
    let mut resent = Vec::new();
    for _ in 0..4 {
        resent.push(daemon.next_message().await["params"].clone());
    }
    assert_eq!(
        resent,
        [
            json!({
                "kind": "paste", "data": second_part, "pasteId": paste_id, "isLastPart": false
            }),
            json!({ "kind": "paste", "data": "tail", "pasteId": paste_id, "isLastPart": true }),
            json!({ "kind": "keys", "data": "z" }),
            json!({ "kind": "keys", "data": "after" }),
        ]
        .map(|mut expected| {
            expected["sessionId"] = json!("0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c1001");
            expected["terminalId"] = json!("shell-1");
            expected["outputSubscriptionId"] = json!(REOPENED_PANE);
            expected
        }),
        "the pane's next handle continues the cut paste under its id from the part the daemon \
         refused, its first part never sent again"
    );
    daemon.assert_no_message_within(QUIET).await;
}

#[tokio::test(start_paused = true)]
async fn a_finished_pane_sends_the_rest_of_its_paste_in_order_and_is_done_once_answered() {
    let client = JsonRpcClient::new();
    let (_link, mut daemon) = open_link(&client).await;
    let (first, _first_notices) = ShellInput::open(&client, target(FIRST_PANE));

    let mut waiting = fill_the_window(&first, &mut daemon).await;
    let whole_part = "p".repeat(TERMINAL_WRITE_MAX_BYTES);
    first.paste(format!("{whole_part}tail"));
    first.type_keys("z");
    daemon.answer(&waiting.remove(0), json!(null)).await;
    let first_part = daemon.next_message().await;
    assert_eq!(
        first_part["params"]["isLastPart"], false,
        "the paste is half sent"
    );
    waiting.push(first_part["id"].clone());

    let mut finished = tokio::spawn(first.finish());
    let mut sent = Vec::new();
    for _ in 0..2 {
        daemon.answer(&waiting.remove(0), json!(null)).await;
        let write = daemon.next_message().await;
        sent.push(write["params"].clone());
        waiting.push(write["id"].clone());
    }
    let paste_id = &first_part["params"]["pasteId"];
    assert_eq!(
        sent,
        [
            json!({ "kind": "paste", "data": "tail", "pasteId": paste_id, "isLastPart": true }),
            json!({ "kind": "keys", "data": "z" }),
        ]
        .map(|mut expected| {
            expected["sessionId"] = json!("0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c1001");
            expected["terminalId"] = json!("shell-1");
            expected["outputSubscriptionId"] = json!(FIRST_PANE);
            expected
        }),
        "the rest goes in order on the pane's own subscription, the paste's last part under its id"
    );

    while let Some(id) = waiting.pop() {
        assert!(
            tokio::time::timeout(QUIET, &mut finished).await.is_err(),
            "the pane is not done while a write of it waits for its answer"
        );
        daemon.answer(&id, json!(null)).await;
    }
    tokio::time::timeout(PATIENCE, finished)
        .await
        .expect("the pane is done once its writes are answered")
        .expect("finishing does not panic");
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
