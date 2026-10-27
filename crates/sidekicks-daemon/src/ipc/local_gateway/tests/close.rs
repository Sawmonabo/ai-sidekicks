//! Every way a connection closes: both cleanups, every call canceled, the feeds released and one
//! disconnect; and the stop, which sends what lane 0 holds before it cuts the connection.

use bytes::{BufMut as _, Bytes, BytesMut};
use futures::StreamExt as _;
use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::jsonrpc::framing::MAX_MESSAGE_BYTES;
use sidekicks_contracts::jsonrpc::framing::frame::{Frame, LaneId};
use sidekicks_contracts::jsonrpc::negotiation::CURRENT_PROTOCOL_VERSION;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_platforms::this_process;
use tokio::io::AsyncWriteExt as _;
use tokio_util::sync::CancellationToken;

use super::super::{CONNECTION_CLOSE_WAIT, SupervisionDisconnectReason};
use super::{
    Harness, HookCall, assert_refusal, call, channel_feed, harness, settle, subscribe, within,
};
use sidekicks_ipc::call_fixtures::{context, request};
use sidekicks_ipc::registry::{Dispatch as _, DispatchError, HandlerContext, Reply, TransportId};

/// How the test ends the connection.
#[derive(Clone, Copy, Debug)]
enum Ending {
    ClientClose,
    MalformedFrame,
    UnadmittedLane,
    ReadError,
    OversizedMessage,
    OversizedReply,
    Stop,
}

/// The refusal the negotiation gate answers a read on `transport` with, the gate's view of what
/// the negotiator holds for it.
async fn gate_refusal(harness: &Harness, transport: TransportId) -> RefusalCode {
    let gate = harness.negotiator.gate(
        harness.services.dispatch.clone(),
        harness.services.registry.clone(),
    );
    match gate
        .dispatch(request("test.read", Some(&json!({}))), context(transport.0))
        .await
    {
        Err(DispatchError::Refused(refusal)) => refusal.code,
        Err(error) => panic!("expected a refusal, got {error:?}"),
        Ok(Reply::Result(_) | Reply::Subscription { .. }) => panic!("expected a refusal"),
    }
}

#[rstest]
#[case::client_close(Ending::ClientClose, SupervisionDisconnectReason::ClientClose, 0)]
#[case::malformed_frame(Ending::MalformedFrame, SupervisionDisconnectReason::MalformedFrame, 1)]
#[case::unadmitted_lane(Ending::UnadmittedLane, SupervisionDisconnectReason::MalformedFrame, 1)]
#[case::read_error(Ending::ReadError, SupervisionDisconnectReason::TransportError, 1)]
#[case::oversized_message(
    Ending::OversizedMessage,
    SupervisionDisconnectReason::OversizedBody,
    1
)]
#[case::oversized_reply(Ending::OversizedReply, SupervisionDisconnectReason::ServerClose, 1)]
#[case::stop(Ending::Stop, SupervisionDisconnectReason::ServerClose, 0)]
#[tokio::test(start_paused = true)]
async fn every_close_cleans_up_cancels_every_call_and_disconnects_once(
    #[case] ending: Ending,
    #[case] reason: SupervisionDisconnectReason,
    #[case] errors: usize,
) {
    let harness = harness();
    let mut connection = harness.connect_with(1 << 20, matches!(ending, Ending::ReadError));
    let transport = connection.transport;

    // A handshake with a wrong token latches the connection refused in the negotiator.
    let handshake = request(
        "connection.initialize",
        Some(&json!({ "protocolVersion": CURRENT_PROTOCOL_VERSION, "sessionToken": "wrong" })),
    );
    assert!(
        harness
            .services
            .registry
            .dispatch(
                handshake,
                HandlerContext {
                    caller_process: Some(this_process()),
                    ..context(transport.0)
                },
            )
            .await
            .is_err()
    );
    assert_eq!(
        gate_refusal(&harness, transport).await,
        RefusalCode::AuthTokenInvalid
    );
    // An open subscription and a call in flight.
    let (values, _taken, feed) = channel_feed();
    harness.script.prepare(feed);
    connection.client.send(&subscribe(1)).await;
    connection.client.answer().await;
    connection
        .client
        .send(&call(2, "test.wait", &json!({})))
        .await;
    settle().await;
    let waiting = harness.script.dispatched("test.wait");

    match ending {
        Ending::ClientClose | Ending::ReadError => {
            within(connection.client.frames.get_mut().shutdown())
                .await
                .expect("the client's end shuts");
        }
        Ending::MalformedFrame => {
            // Kind 0x04 is no frame kind.
            connection
                .client
                .write_raw(&[0x04, 0, 0, 0, 0, 1, 0, 0, 0, 0])
                .await;
        }
        Ending::UnadmittedLane => {
            // The daemon admits no lane but lane 0.
            connection
                .client
                .send_frame(Frame::Data {
                    lane: LaneId::new(1),
                    is_end: false,
                    closes_lane: false,
                    body: Bytes::new(),
                })
                .await;
        }
        Ending::OversizedMessage => {
            let mut prefix = BytesMut::new();
            prefix.put_u32(u32::try_from(MAX_MESSAGE_BYTES + 1).expect("fits"));
            connection
                .client
                .send_frame(Frame::Data {
                    lane: LaneId::CONTROL,
                    is_end: false,
                    closes_lane: false,
                    body: prefix.freeze(),
                })
                .await;
            // The daemon closes after its answer, so no credit goes back.
            connection.client.grants_credit = false;
            let refusal = connection.client.answer().await;
            let fields = json!({ "limit": MAX_MESSAGE_BYTES, "observed": MAX_MESSAGE_BYTES + 1 });
            assert_refusal(
                &refusal,
                &Value::Null,
                -32600,
                "connection.message.tooLarge",
                "resourceExhausted",
                Some(&fields),
            );
        }
        Ending::OversizedReply => {
            connection
                .client
                .send(&call(3, "test.huge", &json!({})))
                .await;
        }
        Ending::Stop => connection.stop.cancel(),
    }
    within(&mut connection.serving)
        .await
        .expect("the connection's task ends");
    // The subscription's own task drops it once the cleanup has canceled it.
    settle().await;

    let mut expected: Vec<HookCall> = (0..errors).map(|_| HookCall::Error(transport)).collect();
    expected.push(HookCall::Disconnect(transport, reason));
    assert_eq!(harness.hooks.of(transport), expected);
    assert!(values.is_closed(), "the subscription's feed was released");
    assert!(
        waiting.iter().all(CancellationToken::is_cancelled),
        "every call in flight was canceled"
    );
    assert_eq!(
        gate_refusal(&harness, transport).await,
        RefusalCode::ConnectionHandshakeRequired,
        "the negotiator dropped the connection"
    );
}

#[tokio::test(start_paused = true)]
async fn a_stop_sends_what_lane_0_holds_and_cuts_a_client_that_stopped_reading() {
    let harness = harness();

    // The answer whose first piece is on the wire as the stop comes still arrives whole.
    let mut connection = harness.connect(1024);
    connection
        .client
        .send(&call(1, "test.big", &json!({})))
        .await;
    while !connection
        .client
        .seen
        .iter()
        .any(|frame| frame.lane.is_control())
    {
        within(connection.client.read_frame()).await;
    }
    // The daemon closes after the answer, so no credit goes back.
    connection.client.grants_credit = false;
    connection.stop.cancel();
    let answer = connection.client.answer().await;
    assert_eq!(answer["id"], json!(1));
    assert_eq!(
        answer["result"]["text"].as_str().map(str::len),
        Some(70_000)
    );
    assert!(
        within(connection.client.frames.next()).await.is_none(),
        "the connection ends after it"
    );
    within(&mut connection.serving)
        .await
        .expect("the connection's task ends");

    // A client that never reads is cut once the wait has passed.
    let mut stalled = harness.connect(1024);
    stalled.client.send(&call(1, "test.big", &json!({}))).await;
    settle().await;
    let stopped_at = tokio::time::Instant::now();
    stalled.stop.cancel();
    within(&mut stalled.serving)
        .await
        .expect("the connection's task ends");
    assert!(stopped_at.elapsed() >= CONNECTION_CLOSE_WAIT);
}
