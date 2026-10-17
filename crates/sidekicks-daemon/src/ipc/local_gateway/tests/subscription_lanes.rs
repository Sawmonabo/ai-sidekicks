//! Subscriptions' lanes: the acknowledgment first, lane numbers in the order lanes first send, a
//! cancel's ABORT before its answer, lanes taking turns, and the writer's bounds with a client that
//! grants no credit or stops reading.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use rstest::rstest;
use serde_json::json;
use sidekicks_contracts::jsonrpc::framing::INITIAL_LANE_CREDIT;

use super::{Event, RepeatingFeed, call, channel_feed, harness, settle, subscribe, within};

#[tokio::test(start_paused = true)]
async fn a_subscriptions_first_frame_follows_its_acknowledgments_end() {
    let harness = harness();
    let mut connection = harness.connect(64 * 1024);
    let (values, _taken, feed) = channel_feed();
    values.send(json!("ready")).expect("the feed is held");
    harness.script.prepare(feed);

    connection.client.send(&subscribe(1)).await;
    assert_eq!(connection.client.answer().await["id"], json!(1));
    let (_lane, notify) = connection.client.notification().await;
    assert_eq!(notify["params"]["value"], json!("ready"), "{notify}");

    let seen = &connection.client.seen;
    let acknowledgment_end = seen
        .iter()
        .position(|frame| frame.lane.is_control() && frame.is_end)
        .expect("the acknowledgment ended");
    let first_on_the_lane = seen
        .iter()
        .position(|frame| !frame.lane.is_control())
        .expect("the value came");
    assert!(acknowledgment_end < first_on_the_lane, "{seen:?}");
}

#[tokio::test(start_paused = true)]
async fn a_lane_takes_its_number_as_its_first_frame_is_written() {
    let harness = harness();
    let mut connection = harness.connect(64 * 1024);
    let (first_values, _taken, feed) = channel_feed();
    harness.script.prepare(feed);
    let (second_values, _taken, feed) = channel_feed();
    harness.script.prepare(feed);
    connection.client.send(&subscribe(1)).await;
    connection.client.answer().await;
    connection.client.send(&subscribe(2)).await;
    connection.client.answer().await;

    // The second subscription sends first; the client's lanes accept a lower number after it.
    second_values
        .send(json!("second"))
        .expect("the feed is held");
    let (second_lane, _notify) = connection.client.notification().await;
    first_values.send(json!("first")).expect("the feed is held");
    let (first_lane, _notify) = connection.client.notification().await;
    assert!(second_lane < first_lane);
}

#[rstest]
#[case::numbered_lane(true)]
#[case::lane_never_numbered(false)]
#[tokio::test(start_paused = true)]
async fn a_cancel_closes_the_lane_before_it_answers(#[case] has_sent: bool) {
    let harness = harness();
    let mut connection = harness.connect(64 * 1024);
    let (values, _taken, feed) = channel_feed();
    harness.script.prepare(feed);
    connection.client.send(&subscribe(1)).await;
    let subscription = connection.client.answer().await["result"]["subscriptionId"].clone();
    let numbered = if has_sent {
        values.send(json!("value")).expect("the feed is held");
        Some(connection.client.notification().await.0)
    } else {
        None
    };

    let cancel = json!({ "subscriptionId": subscription });
    connection
        .client
        .send(&call(2, "$/subscription/cancel", &cancel))
        .await;
    if let Some(lane) = numbered {
        assert!(
            matches!(connection.client.next_event().await, Event::Abort(aborted) if aborted == lane)
        );
    }
    let answer = connection.client.answer().await;
    assert_eq!(answer["result"], json!({ "canceled": true }), "{answer}");
    assert!(values.is_closed(), "the feed was released");
}

#[tokio::test(start_paused = true)]
async fn a_stream_that_ended_first_closes_its_lane_then_its_cancel_answers_false() {
    let harness = harness();
    let mut connection = harness.connect(64 * 1024);
    let (values, _taken, feed) = channel_feed();
    harness.script.prepare(feed);
    connection.client.send(&subscribe(1)).await;
    let subscription = connection.client.answer().await["result"]["subscriptionId"].clone();
    drop(values);
    settle().await;

    let cancel = json!({ "subscriptionId": subscription });
    connection
        .client
        .send(&call(2, "$/subscription/cancel", &cancel))
        .await;
    let Event::Message {
        lane,
        json: end,
        closes_lane,
    } = connection.client.next_event().await
    else {
        panic!("the end frame comes first");
    };
    assert!(!lane.is_control() && closes_lane);
    assert_eq!(end["method"], json!("$/subscription/end"));
    assert_eq!(end["params"]["reason"], json!("completed"));
    let answer = connection.client.answer().await;
    assert_eq!(answer["result"], json!({ "canceled": false }), "{answer}");
}

#[tokio::test(start_paused = true)]
async fn a_small_message_goes_out_between_the_pieces_of_a_large_one() {
    let harness = harness();
    let mut connection = harness.connect(4096);
    let (large_values, _taken, feed) = channel_feed();
    harness.script.prepare(feed);
    let (small_values, small_taken, feed) = channel_feed();
    harness.script.prepare(feed);
    connection.client.send(&subscribe(1)).await;
    connection.client.answer().await;
    connection.client.send(&subscribe(2)).await;
    connection.client.answer().await;

    large_values
        .send(json!("l".repeat(1 << 20)))
        .expect("the feed is held");
    settle().await;
    small_values.send(json!("s")).expect("the feed is held");
    settle().await;

    // Read frame by frame, noting how many frames were read when the small message was handed over.
    connection.client.seen.clear();
    let mut handed_over_at = None;
    let mut notifications = Vec::new();
    while notifications.len() < 2 {
        let read = within(connection.client.read_frame()).await;
        if let Some(Event::Message { lane, json, .. }) = read {
            notifications.push((lane, json));
        }
        settle().await;
        if handed_over_at.is_none() && small_taken.load(Ordering::SeqCst) == 1 {
            handed_over_at = Some(connection.client.seen.len());
        }
    }
    let (small_lane, small) = &notifications[0];
    assert_eq!(
        small["params"]["value"],
        json!("s"),
        "the small message ends first"
    );
    let seen = &connection.client.seen;
    let handed_over_at = handed_over_at.expect("the small message was handed over");
    let small_end = seen
        .iter()
        .position(|frame| frame.lane == *small_lane && frame.is_end)
        .expect("the small message ended");
    // The piece on the wire as it was handed over may be whole; at most one 16 KiB piece follows.
    let large_pieces: Vec<usize> = seen[handed_over_at..small_end]
        .iter()
        .filter(|frame| frame.lane != *small_lane && !frame.lane.is_control())
        .filter_map(|frame| frame.bytes)
        .collect();
    assert!(large_pieces.len() <= 2, "{large_pieces:?}");
    assert!(
        large_pieces.iter().skip(1).all(|bytes| *bytes <= 16_384),
        "{large_pieces:?}"
    );

    // The large stream's feed waits on a value that never comes; the small one's values still pass.
    small_values.send(json!("s2")).expect("the feed is held");
    small_values.send(json!("s3")).expect("the feed is held");
    for expected in ["s2", "s3"] {
        let (lane, notify) = connection.client.notification().await;
        assert_eq!(lane, *small_lane);
        assert_eq!(notify["params"]["value"], json!(expected), "{notify}");
    }
}

#[tokio::test(start_paused = true)]
async fn a_subscriptions_value_goes_out_between_the_pieces_of_lane_0s_replies() {
    let harness = harness();
    let mut connection = harness.connect(4096);
    let (values, taken, feed) = channel_feed();
    harness.script.prepare(feed);
    connection.client.send(&subscribe(1)).await;
    connection.client.answer().await;

    // Three large replies keep lane 0 busy.
    let big_calls: Vec<_> = (2..=4).map(|id| call(id, "test.big", &json!({}))).collect();
    connection.client.send_all(&big_calls).await;
    settle().await;
    values.send(json!("v")).expect("the feed is held");
    settle().await;

    connection.client.seen.clear();
    let mut handed_over_at = None;
    let mut answered = 0;
    let notification_lane = loop {
        let read = within(connection.client.read_frame()).await;
        match read {
            Some(Event::Message { lane, json, .. }) if !lane.is_control() => {
                assert_eq!(json["params"]["value"], json!("v"), "{json}");
                break lane;
            }
            Some(Event::Message { .. }) => answered += 1,
            Some(Event::Abort(_)) | None => {}
        }
        settle().await;
        if handed_over_at.is_none() && taken.load(Ordering::SeqCst) == 1 {
            handed_over_at = Some(connection.client.seen.len());
        }
    };
    let seen = &connection.client.seen;
    let handed_over_at = handed_over_at.expect("the value was handed over");
    let value_end = seen
        .iter()
        .position(|frame| frame.lane == notification_lane && frame.is_end)
        .expect("the value ended");
    // The piece on the wire as it was handed over may be whole; at most one 16 KiB piece follows.
    let control_pieces: Vec<usize> = seen[handed_over_at..value_end]
        .iter()
        .filter(|frame| frame.lane.is_control())
        .filter_map(|frame| frame.bytes)
        .collect();
    assert!(control_pieces.len() <= 2, "{control_pieces:?}");
    assert!(
        control_pieces.iter().skip(1).all(|bytes| *bytes <= 16_384),
        "{control_pieces:?}"
    );
    for _ in answered..3 {
        let answer = connection.client.answer().await;
        assert_eq!(
            answer["result"]["text"].as_str().map(str::len),
            Some(70_000)
        );
    }
}

#[tokio::test(start_paused = true)]
async fn a_client_granting_no_credit_or_reading_nothing_holds_one_piece_and_one_message_a_lane() {
    const VALUE_BYTES: usize = 40_000;
    let harness = harness();

    // No credit comes back: each feed is read only while its lane has credit.
    let mut connection = harness.connect(1 << 20);
    connection.client.grants_credit = false;
    let mut taken = Vec::new();
    for id in 1..=3 {
        let counter = Arc::new(AtomicUsize::new(0));
        harness.script.prepare(Box::new(RepeatingFeed {
            bytes: VALUE_BYTES,
            taken: Arc::clone(&counter),
        }));
        taken.push(counter);
        connection.client.send(&subscribe(id)).await;
    }
    connection.client.read_until_quiet().await;
    let within_credit = usize::try_from(INITIAL_LANE_CREDIT).expect("fits") / VALUE_BYTES + 1;
    for counter in &taken {
        assert!(counter.load(Ordering::SeqCst) <= within_credit);
    }
    let held = connection.outbox.held();
    assert!(held.largest_subscription_lane <= 1, "{held:?}");
    assert!(held.pieces_in_hand <= 1, "{held:?}");

    // The client stops reading the socket.
    let mut stalled = harness.connect(4096);
    for id in 1..=3 {
        harness.script.prepare(Box::new(RepeatingFeed {
            bytes: VALUE_BYTES,
            taken: Arc::new(AtomicUsize::new(0)),
        }));
        stalled.client.send(&subscribe(id)).await;
    }
    let mut acknowledged = 0;
    while acknowledged < 3 {
        if let Event::Message { lane, .. } = stalled.client.next_event().await {
            acknowledged += usize::from(lane.is_control());
        }
    }
    settle().await;
    let held = stalled.outbox.held();
    assert!(held.largest_subscription_lane <= 1, "{held:?}");
    assert!(held.pieces_in_hand <= 1, "{held:?}");
}
