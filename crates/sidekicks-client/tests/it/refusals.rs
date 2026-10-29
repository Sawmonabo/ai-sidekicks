//! A refusal under a category this build does not know is read as a refusal keeping its text,
//! never as a fault that ends the link.

use serde_json::json;
use sidekicks_client::error::ClientError;
use sidekicks_client::transport::json_rpc::JsonRpcClient;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::jsonrpc::refusal::category::RefusalCategory;
use sidekicks_contracts::method::Method;
use sidekicks_contracts::session::methods::SessionRead;
use tokio_util::sync::CancellationToken;

use crate::helpers::{open_link, raw_request};

#[tokio::test(start_paused = true)]
async fn an_unknown_category_settles_the_call_and_the_link_stays_open() {
    let client = JsonRpcClient::new();
    let (_link, mut daemon) = open_link(&client).await;
    let never = CancellationToken::new();
    let refused = client.call_raw(raw_request(&SessionRead::DESCRIPTOR, &json!({})), &never);
    let request = daemon.next_message().await;
    daemon
        .refuse_as(
            &request["id"],
            RefusalCode::SessionNotFound,
            "newerCategory",
        )
        .await;
    let refusal = refused.await;
    assert!(
        matches!(&refusal, Err(ClientError::Remote(remote)) if remote.data.as_ref().is_some_and(
            |data| data.category == RefusalCategory::Unknown("newerCategory".to_owned())
        )),
        "{refusal:?}"
    );

    let answered = client.call_raw(raw_request(&SessionRead::DESCRIPTOR, &json!({})), &never);
    let request = daemon.next_message().await;
    daemon.answer(&request["id"], json!({ "read": true })).await;
    assert!(answered.await.is_ok(), "the link carries the next call");
}
