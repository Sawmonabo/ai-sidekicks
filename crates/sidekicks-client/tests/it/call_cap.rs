//! The call cap: past `MAX_CALLS_IN_FLIGHT` calls wait in order, the slotless methods (the link
//! watch's ping among them) pass them, a canceled waiting call sends nothing, and each answer sends
//! the next waiting call.

use std::time::Duration;

use serde_json::json;
use sidekicks_client::error::ClientError;
use sidekicks_client::transport::json_rpc::JsonRpcClient;
use sidekicks_contracts::daemon::lifecycle::{DaemonPing, DaemonStop};
use sidekicks_contracts::jsonrpc::message::MAX_CALLS_IN_FLIGHT;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::jsonrpc::streaming::{SUBSCRIPTION_CANCEL_METHOD, SubscriptionCancel};
use sidekicks_contracts::method::Method;
use sidekicks_contracts::method_descriptor::EmptyPayload;
use sidekicks_contracts::session::methods::SessionRead;
use sidekicks_contracts::terminal::TerminalWrite;
use tokio_util::sync::CancellationToken;

use crate::helpers::{open_link, raw_request};

const QUIET: Duration = Duration::from_secs(5);

#[tokio::test(start_paused = true)]
async fn calls_past_the_cap_wait_while_slotless_calls_pass_them() {
    let client = JsonRpcClient::new();
    let (_link, mut daemon) = open_link(&client).await;
    let never = CancellationToken::new();

    let mut in_flight = Vec::new();
    for call in 0..MAX_CALLS_IN_FLIGHT {
        in_flight.push(client.call_raw(
            raw_request(&SessionRead::DESCRIPTOR, &json!({ "call": call })),
            &never,
        ));
    }
    let mut ids = Vec::new();
    for call in 0..MAX_CALLS_IN_FLIGHT {
        let request = daemon.next_message().await;
        assert_eq!(
            request["params"]["call"], call,
            "calls go out in the order they were made"
        );
        ids.push(request["id"].clone());
    }

    let cancel = CancellationToken::new();
    let canceled = client.call_raw(
        raw_request(&SessionRead::DESCRIPTOR, &json!({ "call": "canceled" })),
        &cancel,
    );
    let waiting = client.call_raw(
        raw_request(&SessionRead::DESCRIPTOR, &json!({ "call": "waiting" })),
        &never,
    );
    daemon.assert_no_message_within(QUIET).await;

    let _stop = client.call::<DaemonStop>(&EmptyPayload {});
    let _ping = client.call::<DaemonPing>(&EmptyPayload {});
    let _write = client.call_raw(raw_request(&TerminalWrite::DESCRIPTOR, &json!({})), &never);
    let _subscription_cancel = client.call_raw(
        raw_request(
            &SubscriptionCancel::DESCRIPTOR,
            &json!({ "subscriptionId": "unknown" }),
        ),
        &never,
    );
    for method in [
        <DaemonStop as Method>::DESCRIPTOR.method,
        <DaemonPing as Method>::DESCRIPTOR.method,
        <TerminalWrite as Method>::DESCRIPTOR.method,
        SUBSCRIPTION_CANCEL_METHOD,
    ] {
        assert_eq!(
            daemon.next_message().await["method"],
            method,
            "a slotless call passes the cap"
        );
    }

    cancel.cancel();
    assert!(matches!(canceled.await, Err(ClientError::Canceled)));
    daemon.assert_no_message_within(QUIET).await;

    // A refusal is an answer too, so it frees its slot.
    daemon
        .refuse(&ids[0], RefusalCode::ConnectionCallLimitReached)
        .await;
    let next = daemon.next_message().await;
    assert_eq!(
        next["params"]["call"], "waiting",
        "the freed slot sends the next waiting call"
    );
    daemon.assert_no_message_within(QUIET).await;
    let refused = in_flight.remove(0).await;
    assert!(
        matches!(&refused, Err(ClientError::Remote(remote)) if remote.data.as_ref().is_some_and(
            |data| data.refusal == RefusalCode::ConnectionCallLimitReached.as_str()
        )),
        "{refused:?}"
    );

    daemon
        .answer(&next["id"], json!({ "answered": true }))
        .await;
    let answered = waiting.await.expect("the waiting call is answered");
    assert_eq!(answered.json.get(), r#"{"answered":true}"#);
}
