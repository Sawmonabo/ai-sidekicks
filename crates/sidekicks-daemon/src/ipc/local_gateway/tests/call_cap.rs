//! The call cap: at most `MAX_CALLS_IN_FLIGHT` calls per connection, a slot taken before any gate
//! and freed as its reply's last piece is cut, and the replies to slotless messages bounded too.

use bytes::Bytes;
use serde_json::{Value, json};
use sidekicks_contracts::jsonrpc::framing::frame::{Frame, LaneId};
use sidekicks_contracts::jsonrpc::framing::{INITIAL_LANE_CREDIT, MAX_CHUNK_BYTES, MessageBody};
use sidekicks_contracts::jsonrpc::negotiation::CURRENT_PROTOCOL_VERSION;

use super::{
    Connection, SESSION_TOKEN, assert_refusal, call, cancel_request, channel_feed, harness, settle,
    subscribe, subscription_id,
};

/// Asserts `answer` refuses call `id` for the cap.
fn assert_call_limit(answer: &Value, id: u64) {
    assert_refusal(
        answer,
        &json!(id),
        -31000,
        "connection.call.limitReached",
        "resourceExhausted",
        Some(&json!({ "limit": 100 })),
    );
}

/// Sends `test.wait` calls under `ids`, each holding its slot until canceled.
async fn hold_calls(connection: &mut Connection, ids: std::ops::RangeInclusive<u64>) -> usize {
    let calls: Vec<Value> = ids.map(|id| call(id, "test.wait", &json!({}))).collect();
    connection.client.send_all(&calls).await
}

#[tokio::test(start_paused = true)]
async fn a_call_past_the_cap_is_refused_before_any_gate_while_slotless_calls_go_through() {
    let harness = harness();
    let mut connection = harness.connect(1 << 20);
    hold_calls(&mut connection, 1..=100).await;

    // A handshake past the cap is refused for the cap and never reaches the negotiation gate.
    let handshake = json!({
        "jsonrpc": "2.0",
        "id": 101,
        "method": "connection.initialize",
        "params": { "protocolVersion": CURRENT_PROTOCOL_VERSION, "sessionToken": SESSION_TOKEN },
    });
    connection.client.send(&handshake).await;
    assert_call_limit(&connection.client.answer().await, 101);
    assert!(
        harness
            .script
            .dispatched("connection.initialize")
            .is_empty(),
        "the refused call was never dispatched"
    );

    let cancel = json!({ "subscriptionId": subscription_id(99) });
    connection
        .client
        .send(&call(102, "$/subscription/cancel", &cancel))
        .await;
    let answer = connection.client.answer().await;
    assert_eq!(answer["result"], json!({ "canceled": false }), "{answer}");
    connection
        .client
        .send(&call(103, "daemon.stop", &json!({})))
        .await;
    let answer = connection.client.answer().await;
    assert_eq!(
        answer["result"],
        json!({ "method": "daemon.stop" }),
        "{answer}"
    );
    assert_eq!(harness.script.dispatched("test.wait").len(), 100);
}

#[tokio::test(start_paused = true)]
async fn a_canceled_calls_slot_frees_only_once_its_answer_is_cut() {
    let harness = harness();
    let mut connection = harness.connect(1024);
    hold_calls(&mut connection, 1..=99).await;
    // The client stops reading while the first piece of this answer is written.
    connection
        .client
        .send(&call(100, "test.big", &json!({})))
        .await;
    settle().await;
    connection.client.send(&cancel_request(1)).await;
    settle().await;
    connection
        .client
        .send(&call(101, "test.read", &json!({})))
        .await;
    settle().await;

    assert_eq!(connection.client.answer().await["id"], json!(100));
    let canceled = connection.client.answer().await;
    assert_refusal(
        &canceled,
        &json!(1),
        -32800,
        "request.canceled",
        "canceled",
        None,
    );
    assert_call_limit(&connection.client.answer().await, 101);

    connection
        .client
        .send(&call(102, "test.read", &json!({})))
        .await;
    let answer = connection.client.answer().await;
    assert_eq!(
        answer["result"],
        json!({ "method": "test.read" }),
        "{answer}"
    );
}

#[tokio::test(start_paused = true)]
async fn a_refused_calls_credit_returns_so_a_cancel_is_still_read() {
    let harness = harness();
    let mut connection = harness.connect(1 << 20);
    let spent = hold_calls(&mut connection, 1..=100).await;

    // Call 101 spends the rest of lane 0's credit.
    let rest = usize::try_from(INITIAL_LANE_CREDIT).expect("fits") - spent;
    let unpadded = encoded_bytes(&call(101, "test.read", &json!({ "pad": "" })));
    let padded = call(
        101,
        "test.read",
        &json!({ "pad": "p".repeat(rest - unpadded) }),
    );
    connection.client.send(&padded).await;
    assert_eq!(connection.client.outgoing.available(LaneId::CONTROL), 0);

    assert_call_limit(&connection.client.answer().await, 101);
    assert_eq!(
        connection.client.outgoing.available(LaneId::CONTROL),
        INITIAL_LANE_CREDIT,
        "every message's credit came back, the refused call's too"
    );
    connection.client.send(&cancel_request(1)).await;
    assert_eq!(connection.client.answer().await["id"], json!(1));
}

#[tokio::test(start_paused = true)]
async fn a_subscribe_calls_slot_frees_with_its_acknowledgment() {
    let harness = harness();
    let mut connection = harness.connect(1 << 20);
    let (_values, _taken, feed) = channel_feed();
    harness.script.prepare(feed);
    hold_calls(&mut connection, 1..=99).await;

    connection.client.send(&subscribe(100)).await;
    let acknowledgment = connection.client.answer().await;
    assert_eq!(acknowledgment["id"], json!(100), "{acknowledgment}");
    connection
        .client
        .send(&call(101, "test.read", &json!({})))
        .await;
    let answer = connection.client.answer().await;
    assert_eq!(
        answer["result"],
        json!({ "method": "test.read" }),
        "{answer}"
    );
}

#[tokio::test(start_paused = true)]
async fn each_connection_holds_its_own_calls() {
    let harness = harness();
    let mut first = harness.connect(1 << 20);
    let mut second = harness.connect(1 << 20);
    hold_calls(&mut first, 1..=100).await;
    settle().await;
    hold_calls(&mut second, 1..=100).await;
    second
        .client
        .send(&call(101, "test.read", &json!({})))
        .await;

    assert_call_limit(&second.client.answer().await, 101);
    assert_eq!(harness.script.dispatched("test.wait").len(), 200);
}

#[tokio::test(start_paused = true)]
async fn slotless_messages_never_keep_the_reader_from_a_call_or_the_credit_that_drains_them() {
    let harness = harness();
    let Connection {
        mut client, outbox, ..
    } = harness.connect(1 << 20);
    client.grants_credit = false;

    // Slotless calls still running hold no reply place, only a running count, so a call after
    // them is taken.
    let writes: Vec<Value> = (1..=99_u64)
        .map(|id| call(id, "terminal.write", &json!({})))
        .collect();
    client.send_all(&writes).await;
    // Its answer passes lane 0's credit, which the client returns only below.
    client.send(&call(101, "test.large", &json!({}))).await;
    settle().await;
    assert_eq!(harness.script.dispatched("test.large").len(), 1);

    // A hundred refusals wait behind it, every reply place held; the next message waits untaken.
    let responses: Vec<Value> = (1001..=1101_u64)
        .map(|id| json!({ "jsonrpc": "2.0", "id": id, "result": {} }))
        .collect();
    client.send_all(&responses).await;
    settle().await;
    assert_eq!(outbox.held().control_lane, 101, "{:?}", outbox.held());

    // A message past the window while one waits gets no credit back, so nothing more is buffered.
    client.read_until_quiet().await;
    let window = usize::try_from(client.outgoing.available(LaneId::CONTROL)).expect("fits");
    let past_the_window = MessageBody {
        json: Bytes::from(
            serde_json::to_vec(&call(
                1200,
                "test.read",
                &json!({ "pad": "p".repeat(400_000) }),
            ))
            .expect("a test message writes"),
        ),
        attachments: Vec::new(),
    }
    .encode()
    .expect("a test message is within its caps");
    for chunk in past_the_window[..window].chunks(MAX_CHUNK_BYTES as usize) {
        let length = u32::try_from(chunk.len()).expect("a chunk fits a u32");
        assert!(client.outgoing.spend(LaneId::CONTROL, length));
        client
            .send_frame(Frame::Data {
                lane: LaneId::CONTROL,
                is_end: false,
                closes_lane: false,
                body: Bytes::copy_from_slice(chunk),
            })
            .await;
    }
    client.read_until_quiet().await;
    assert_eq!(client.outgoing.available(LaneId::CONTROL), 0);

    // The client's CREDIT frame is still read: every reply drains, then the owed credit follows.
    client
        .send_frame(Frame::Credit {
            lane: LaneId::CONTROL,
            granted: INITIAL_LANE_CREDIT,
        })
        .await;
    assert_eq!(client.answer().await["id"], json!(101));
    for id in 1001..=1101_u64 {
        assert_eq!(client.answer().await["id"], json!(id));
    }
    client.read_until_quiet().await;
    assert!(usize::try_from(client.outgoing.available(LaneId::CONTROL)).expect("fits") >= window);
}

#[tokio::test(start_paused = true)]
async fn at_most_a_hundred_slotless_calls_run_while_more_wait_untaken() {
    let harness = harness();
    let mut connection = harness.connect(1024);
    let (values, _taken, feed) = channel_feed();
    harness.script.prepare(feed);
    connection.client.send(&subscribe(1)).await;
    connection.client.answer().await;
    values.send(json!("ready")).expect("the feed is held");
    connection.client.notification().await;

    // The client stops reading under a large answer, so no ABORT reaches the socket and each
    // cancel of the subscription waits for its lane to close.
    connection
        .client
        .send(&call(2, "test.big", &json!({})))
        .await;
    let cancel = json!({ "subscriptionId": subscription_id(0) });
    let cancels: Vec<Value> = (3..=103_u64)
        .map(|id| call(id, "$/subscription/cancel", &cancel))
        .collect();
    connection.client.send_all(&cancels).await;
    settle().await;

    assert_eq!(
        harness.script.dispatched("$/subscription/cancel").len(),
        100
    );
}

/// The credit `json` spends as one message.
fn encoded_bytes(json: &Value) -> usize {
    MessageBody {
        json: Bytes::from(serde_json::to_vec(json).expect("a test message writes")),
        attachments: Vec::new(),
    }
    .encode()
    .expect("a test message is within its caps")
    .len()
}
