//! Subscription credit: the client returns a value's credit only as the consumer takes it, so an
//! unread stream holds the daemon on its lane, and every value arrives in order.

use std::time::Duration;

use futures::StreamExt as _;
use serde_json::{Value, json};
use sidekicks_client::transport::json_rpc::JsonRpcClient;

use crate::helpers::{open_link, raw_request};

const SUBSCRIPTION_ID: &str = "0199f0a4-5c2e-7a3b-8c1d-2e3f4a5b6c7d";
const WHILE: Duration = Duration::from_secs(5);

#[tokio::test(start_paused = true)]
async fn a_value_returns_its_credit_only_once_taken() {
    let client = JsonRpcClient::new();
    let (_link, mut daemon) = open_link(&client).await;
    let opening = client.subscribe_raw(raw_request("session.event.subscribe", &json!({})));
    let request = daemon.next_message().await;
    daemon
        .answer(&request["id"], json!({ "subscriptionId": SUBSCRIPTION_ID }))
        .await;
    let (acknowledgment, mut stream) = opening.await.expect("the subscription opens");
    assert_eq!(stream.subscription_id().to_string(), SUBSCRIPTION_ID);
    drop(acknowledgment);

    let lane = daemon.open_lane();
    let mut sizes = Vec::new();
    for value in 0..4 {
        sizes.push(
            daemon
                .notify(lane, SUBSCRIPTION_ID, json!({ "value": value }))
                .await,
        );
    }
    daemon.read_for(WHILE).await;
    assert!(
        daemon.credits_on(lane).is_empty(),
        "an unread stream returns no credit"
    );

    let first = stream.next().await.expect("a value").expect("it reads");
    assert_eq!(
        serde_json::from_str::<Value>(first.json.get()).expect("JSON"),
        json!({ "value": 0 })
    );
    daemon.read_for(WHILE).await;
    assert_eq!(
        daemon.credits_on(lane),
        sizes[..1],
        "taking one value returns its bytes"
    );

    daemon.complete(lane, SUBSCRIPTION_ID).await;
    let mut rest = Vec::new();
    while let Some(value) = stream.next().await {
        let value = value.expect("it reads");
        rest.push(serde_json::from_str::<Value>(value.json.get()).expect("JSON"));
    }
    assert_eq!(
        rest,
        [1, 2, 3].map(|value| json!({ "value": value })),
        "every value arrives in order, then the stream ends"
    );
}
