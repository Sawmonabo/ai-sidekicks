//! A dropped link: an unkeyed call in flight settles unavailable at once, and a keyed one is sent
//! once more on the next link, under a new id, before the calls held meanwhile; a keyed call lost
//! a second time settles unavailable.

use std::pin::pin;

use serde_json::json;
use sidekicks_client::error::ClientError;
use sidekicks_client::transport::json_rpc::JsonRpcClient;
use sidekicks_contracts::method::Method;
use sidekicks_contracts::session::directory::SessionCreate;
use sidekicks_contracts::session::methods::SessionRead;
use tokio_util::sync::CancellationToken;

use crate::helpers::{open_link, raw_request};

#[tokio::test(start_paused = true)]
async fn a_keyed_call_in_flight_at_a_drop_is_sent_again_on_the_next_link() {
    let client = JsonRpcClient::new();
    let (_first_link, mut daemon) = open_link(&client).await;
    let never = CancellationToken::new();
    let keyed_params = json!({ "clientIdempotencyKey": "key-1", "title": "kept" });
    let mut keyed = pin!(client.call_raw(
        raw_request(&SessionCreate::DESCRIPTOR, &keyed_params),
        &never
    ));
    let unkeyed = client.call_raw(
        raw_request(&SessionRead::DESCRIPTOR, &json!({ "sessionId": "s" })),
        &never,
    );
    let first_send = daemon.next_message().await;
    assert_eq!(first_send["params"], keyed_params);
    assert_eq!(daemon.next_message().await["method"], "session.read");

    drop(daemon);
    assert!(
        matches!(unkeyed.await, Err(ClientError::Unavailable { .. })),
        "an unkeyed call settles at the drop"
    );
    assert!(
        futures::poll!(&mut keyed).is_pending(),
        "a keyed call waits for the next link"
    );

    let held = client.call_raw(
        raw_request(&SessionRead::DESCRIPTOR, &json!({ "held": true })),
        &never,
    );
    let (_second_link, mut daemon) = open_link(&client).await;
    let resent = daemon.next_message().await;
    assert_eq!(resent["method"], "session.create");
    assert_eq!(
        resent["params"], keyed_params,
        "the resend carries the same params"
    );
    assert_ne!(resent["id"], first_send["id"], "the resend takes a new id");
    assert_eq!(
        daemon.next_message().await["params"],
        json!({ "held": true }),
        "the call held during the drop goes after the resend"
    );

    daemon
        .answer(&resent["id"], json!({ "answeredBy": "the second link" }))
        .await;
    let reply = keyed.await.expect("the resent call is answered");
    assert_eq!(reply.json.get(), r#"{"answeredBy":"the second link"}"#);
    drop(held);
}

#[tokio::test(start_paused = true)]
async fn a_keyed_call_lost_a_second_time_settles_unavailable() {
    let client = JsonRpcClient::new();
    let (_first_link, mut daemon) = open_link(&client).await;
    let never = CancellationToken::new();
    let keyed_params = json!({ "clientIdempotencyKey": "key-2" });
    let mut keyed = pin!(client.call_raw(
        raw_request(&SessionCreate::DESCRIPTOR, &keyed_params),
        &never
    ));
    assert_eq!(daemon.next_message().await["params"], keyed_params);

    drop(daemon);
    let (_second_link, mut daemon) = open_link(&client).await;
    assert_eq!(
        daemon.next_message().await["params"],
        keyed_params,
        "the first loss sends it again"
    );
    assert!(futures::poll!(&mut keyed).is_pending());

    drop(daemon);
    assert!(
        matches!(keyed.await, Err(ClientError::Unavailable { .. })),
        "the second loss settles it"
    );
    let (_third_link, mut daemon) = open_link(&client).await;
    daemon
        .assert_no_message_within(std::time::Duration::from_secs(5))
        .await;
}
