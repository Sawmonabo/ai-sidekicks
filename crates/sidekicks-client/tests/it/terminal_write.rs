//! A pane's writes to a shell: past the per-shell window keys join into the next write, sent as an
//! answer returns, an interrupt goes at once with the keys typed before it, and keys may be typed
//! from a thread outside the runtime, as the desktop's JavaScript thread types them.

use std::time::Duration;

use serde_json::{Value, json};
use sidekicks_client::terminal_write::{ShellInput, ShellTarget};
use sidekicks_client::transport::json_rpc::JsonRpcClient;
use sidekicks_contracts::jsonrpc::streaming::SubscriptionId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::terminal::{TERMINAL_WRITES_WAITING_PER_SHELL, TerminalId};

use crate::helpers::open_link;

const QUIET: Duration = Duration::from_secs(5);

fn target() -> ShellTarget {
    ShellTarget {
        session_id: SessionId::new("0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c1001").expect("a session id"),
        terminal_id: TerminalId::new("shell-1".to_owned()).expect("a terminal id"),
        output_subscription_id: SubscriptionId::new("0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c0001")
            .expect("a subscription id"),
    }
}

#[tokio::test(start_paused = true)]
async fn keys_past_the_window_join_and_an_interrupt_goes_at_once() {
    let client = JsonRpcClient::new();
    let (_link, mut daemon) = open_link(&client).await;
    let (input, _failures) = ShellInput::new(client.clone(), target());

    let mut waiting: Vec<Value> = Vec::new();
    for key in 0..TERMINAL_WRITES_WAITING_PER_SHELL {
        input.type_keys(&key.to_string());
        let write = daemon.next_message().await;
        assert_eq!(write["params"]["data"], key.to_string());
        waiting.push(write["id"].clone());
    }
    input.type_keys("a");
    input.type_keys("b");
    daemon.assert_no_message_within(QUIET).await;

    daemon.answer(&waiting.remove(0), json!({})).await;
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

#[tokio::test]
async fn keys_typed_from_a_thread_outside_the_runtime_are_written() {
    let client = JsonRpcClient::new();
    let (_link, mut daemon) = open_link(&client).await;
    let (input, _failures) = ShellInput::new(client.clone(), target());

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
