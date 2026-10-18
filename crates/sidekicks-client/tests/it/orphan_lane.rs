//! A lane the client holds no stream for: when a subscription's acknowledgment does not read, the
//! client still admits the lane the daemon opens, and its first message cancels the subscription
//! it names, so the link stays open.

use serde_json::json;
use sidekicks_client::error::ClientError;
use sidekicks_client::transport::json_rpc::JsonRpcClient;
use sidekicks_contracts::method::Method;
use sidekicks_contracts::session::directory::SessionEventSubscribe;
use sidekicks_contracts::session::methods::SessionRead;
use tokio_util::sync::CancellationToken;

use crate::helpers::{open_link, raw_request};

const SUBSCRIPTION_ID: &str = "0199f0a4-5c2e-7a3b-8c1d-2e3f4a5b6c7d";

#[tokio::test(start_paused = true)]
async fn a_lane_whose_acknowledgment_did_not_read_cancels_its_subscription() {
    let client = JsonRpcClient::new();
    let (_link, mut daemon) = open_link(&client).await;
    let opening = client.subscribe_raw(raw_request(&SessionEventSubscribe::DESCRIPTOR, &json!({})));
    let request = daemon.next_message().await;
    daemon.answer(&request["id"], json!({})).await;
    assert!(
        matches!(opening.await, Err(ClientError::Reply { .. })),
        "an acknowledgment with no subscription id does not read"
    );

    let lane = daemon.open_lane();
    daemon
        .notify(lane, SUBSCRIPTION_ID, json!({ "value": 0 }))
        .await;
    let cancel = daemon.next_message().await;
    assert_eq!(cancel["method"], "$/subscription/cancel");
    assert_eq!(cancel["params"]["subscriptionId"], SUBSCRIPTION_ID);

    let never = CancellationToken::new();
    let _next = client.call_raw(raw_request(&SessionRead::DESCRIPTOR, &json!({})), &never);
    assert_eq!(
        daemon.next_message().await["method"],
        "session.read",
        "the link still carries calls"
    );
}
