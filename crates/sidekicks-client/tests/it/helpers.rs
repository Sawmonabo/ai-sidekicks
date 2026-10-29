//! A scripted daemon over the frame codec, which a test drives step by step: it reads the client's
//! messages, returning lane 0's credit as it takes each as the daemon does, records every CREDIT
//! frame the client sends, and writes answers, refusals and subscription frames.

use std::time::Duration;

use futures::{SinkExt as _, StreamExt as _};
use serde_json::{Value, json};
use sidekicks_client::transport::json_rpc::{JsonRpcClient, RawRequest};
use sidekicks_client::transport::link::Link;
use sidekicks_contracts::jsonrpc::framing::frame::{Frame, FrameCodec, LaneId};
use sidekicks_contracts::jsonrpc::framing::incoming::IncomingLanes;
use sidekicks_contracts::jsonrpc::framing::outgoing::OutgoingLanes;
use sidekicks_contracts::jsonrpc::framing::{MAX_CHUNK_BYTES, MessageBody};
use sidekicks_contracts::jsonrpc::negotiation::{
    CONNECTION_INITIALIZE_METHOD, CURRENT_PROTOCOL_VERSION, ConnectionInitializeRequest,
    ProtocolVersion,
};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::jsonrpc::streaming::{
    SUBSCRIPTION_END_METHOD, SUBSCRIPTION_NOTIFY_METHOD,
};
use sidekicks_contracts::method::MethodDescriptor;
use tokio::io::{AsyncRead, AsyncWrite, DuplexStream, ReadHalf, WriteHalf};
use tokio_util::codec::{FramedRead, FramedWrite};

/// The daemon side of one connection, generic over its stream.
pub(crate) struct ScriptedDaemon<S> {
    reader: FramedRead<ReadHalf<S>, FrameCodec>,
    writer: FramedWrite<WriteHalf<S>, FrameCodec>,
    incoming: IncomingLanes,
    outgoing: OutgoingLanes,
    /// Whole messages read and not yet asked for.
    messages: Vec<Value>,
    /// Every CREDIT frame the client sent, in order.
    credits: Vec<(LaneId, u32)>,
}

impl<S: AsyncRead + AsyncWrite> ScriptedDaemon<S> {
    /// The daemon side over `stream`.
    pub(crate) fn new(stream: S) -> Self {
        let (read_half, write_half) = tokio::io::split(stream);
        Self {
            reader: FramedRead::new(read_half, FrameCodec),
            writer: FramedWrite::new(write_half, FrameCodec),
            incoming: IncomingLanes::default(),
            outgoing: OutgoingLanes::default(),
            messages: Vec::new(),
            credits: Vec::new(),
        }
    }

    /// Reads one frame: a CREDIT is recorded and granted; a message it completes is taken, its
    /// credit returned at once, and kept for `next_message`.
    async fn read_frame(&mut self) {
        let frame = self
            .reader
            .next()
            .await
            .expect("the client keeps the connection open")
            .expect("the client's frames decode");
        if let Frame::Credit { lane, granted } = frame {
            self.credits.push((lane, granted));
            self.outgoing.grant(lane, granted);
            return;
        }
        let completed = self
            .incoming
            .receive(frame)
            .expect("the client keeps to its credit");
        let mut owed = self.incoming.release_owed();
        if let Some(message) = completed {
            owed.extend(self.incoming.take(message.lane, message.credit_due));
            self.messages
                .push(serde_json::from_slice(&message.body.json).expect("the client writes JSON"));
        }
        for credit in owed {
            self.write(credit.into()).await;
        }
    }

    /// The client's next whole message.
    pub(crate) async fn next_message(&mut self) -> Value {
        while self.messages.is_empty() {
            self.read_frame().await;
        }
        self.messages.remove(0)
    }

    /// Reads frames for `duration` of the paused clock, keeping what arrives.
    pub(crate) async fn read_for(&mut self, duration: Duration) {
        let reading = async {
            loop {
                self.read_frame().await;
            }
        };
        let outcome = tokio::time::timeout(duration, reading).await;
        assert!(outcome.is_err(), "reading frames only ends with the time");
    }

    /// Asserts that no message arrives within `duration` of the paused clock.
    pub(crate) async fn assert_no_message_within(&mut self, duration: Duration) {
        self.read_for(duration).await;
        assert!(
            self.messages.is_empty(),
            "no message was due, but {:?} arrived",
            self.messages
        );
    }

    /// Asserts that the client closes the connection within 10 s of the paused clock, reading
    /// whatever it still sends first.
    pub(crate) async fn assert_closed(&mut self) {
        let closing = async {
            while let Some(frame) = self.reader.next().await {
                frame.expect("the client's frames decode");
            }
        };
        tokio::time::timeout(Duration::from_secs(10), closing)
            .await
            .expect("the client closes the connection");
    }

    /// The CREDIT the client sent on `lane`, frame by frame.
    pub(crate) fn credits_on(&self, lane: LaneId) -> Vec<u32> {
        self.credits
            .iter()
            .filter(|(credited, _)| *credited == lane)
            .map(|(_, granted)| *granted)
            .collect()
    }

    /// Answers the call `id` with `result`.
    pub(crate) async fn answer(&mut self, id: &Value, result: Value) {
        let message = json!({ "jsonrpc": "2.0", "id": id, "result": result });
        self.write_message(LaneId::CONTROL, &message, false).await;
    }

    /// Refuses the call `id` with `code`, as `-31000` with its code and category.
    pub(crate) async fn refuse(&mut self, id: &Value, code: RefusalCode) {
        self.refuse_as(id, code, code.category().as_str()).await;
    }

    /// Refuses the call `id` with `code` under the category text `category`.
    pub(crate) async fn refuse_as(&mut self, id: &Value, code: RefusalCode, category: &str) {
        let data = json!({ "type": code.as_str(), "category": category });
        self.refuse_with_data(id, code, data).await;
    }

    /// Refuses the call `id` with `code`, its detail `fields`.
    pub(crate) async fn refuse_with_fields(
        &mut self,
        id: &Value,
        code: RefusalCode,
        fields: Value,
    ) {
        let data = json!({
            "type": code.as_str(),
            "category": code.category().as_str(),
            "fields": fields,
        });
        self.refuse_with_data(id, code, data).await;
    }

    async fn refuse_with_data(&mut self, id: &Value, code: RefusalCode, data: Value) {
        let message = json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": {
                "code": code.json_rpc_code().code(),
                "message": "Refused by the scripted daemon.",
                "data": data,
            },
        });
        self.write_message(LaneId::CONTROL, &message, false).await;
    }

    /// Reads `connection.initialize` and answers it compatibly.
    pub(crate) async fn answer_initialize(&mut self) {
        let request = self.next_message().await;
        self.answer_initialize_request(&request).await;
    }

    /// Reads `connection.initialize`, checks that it presents `token`, and answers it compatibly.
    pub(crate) async fn answer_initialize_with_token(&mut self, token: &str) {
        let request = self.next_message().await;
        assert_eq!(request["params"]["sessionToken"], token);
        self.answer_initialize_request(&request).await;
    }

    async fn answer_initialize_request(&mut self, request: &Value) {
        assert_eq!(request["method"], CONNECTION_INITIALIZE_METHOD);
        assert!(
            request.get("protocolVersion").is_none(),
            "the handshake carries no envelope protocolVersion"
        );
        let result = json!({
            "compatible": true,
            "protocolVersion": CURRENT_PROTOCOL_VERSION,
            "deviceId": "scripted-daemon",
        });
        self.answer(&request["id"], result).await;
    }

    /// Opens the next subscription lane.
    pub(crate) fn open_lane(&mut self) -> LaneId {
        self.outgoing.open().expect("a test opens few lanes")
    }

    /// Writes one `$/subscription/notify` of `value` on `lane`; answers its bytes, the credit the
    /// client returns once it takes the value.
    pub(crate) async fn notify(
        &mut self,
        lane: LaneId,
        subscription_id: &str,
        value: Value,
    ) -> u32 {
        let message = json!({
            "jsonrpc": "2.0",
            "method": SUBSCRIPTION_NOTIFY_METHOD,
            "params": { "subscriptionId": subscription_id, "value": value },
        });
        self.write_message(lane, &message, false).await
    }

    /// Ends the subscription on `lane` as completed, closing the lane.
    pub(crate) async fn complete(&mut self, lane: LaneId, subscription_id: &str) {
        let message = json!({
            "jsonrpc": "2.0",
            "method": SUBSCRIPTION_END_METHOD,
            "params": { "reason": "completed", "subscriptionId": subscription_id },
        });
        self.write_message(lane, &message, true).await;
    }

    /// Writes `message` on `lane` within the client's credit; answers its encoded bytes.
    async fn write_message(&mut self, lane: LaneId, message: &Value, closes_lane: bool) -> u32 {
        let json = serde_json::to_vec(message).expect("a test message is JSON");
        let encoded = MessageBody {
            json: json.into(),
            attachments: Vec::new(),
        }
        .encode()
        .expect("a test message is within its caps");
        let length = u32::try_from(encoded.len()).expect("a test message fits a u32");
        for frame in Frame::data_chunks(lane, encoded, MAX_CHUNK_BYTES, closes_lane) {
            if let Frame::Data { body, .. } = &frame {
                let length = u32::try_from(body.len()).expect("a chunk fits a u32");
                assert!(
                    self.outgoing.spend(lane, length),
                    "the test keeps to the client's credit"
                );
            }
            self.write(frame).await;
        }
        if closes_lane {
            self.outgoing.close(lane);
        }
        length
    }

    async fn write(&mut self, frame: Frame) {
        self.writer
            .send(frame)
            .await
            .expect("the client reads its socket");
    }
}

/// The handshake a test client sends.
pub(crate) fn initialize_request() -> ConnectionInitializeRequest {
    ConnectionInitializeRequest {
        protocol_version: ProtocolVersion::new(CURRENT_PROTOCOL_VERSION.to_owned())
            .expect("this build's version is a protocol version"),
        supported_protocols: None,
        client_id: None,
        session_token: None,
        capabilities: None,
    }
}

/// Opens a link of `client` over an in-memory stream and answers its `connection.initialize`.
pub(crate) async fn open_link(client: &JsonRpcClient) -> (Link, ScriptedDaemon<DuplexStream>) {
    let (client_side, daemon_side) = tokio::io::duplex(1 << 20);
    let mut daemon = ScriptedDaemon::new(daemon_side);
    let request = initialize_request();
    let (opened, ()) = tokio::join!(
        client.open_link(client_side, &request),
        daemon.answer_initialize()
    );
    let (_answer, link) = opened.expect("the link opens");
    (link, daemon)
}

/// An untyped request of the method `descriptor` declares, with `params`.
pub(crate) fn raw_request(descriptor: &'static MethodDescriptor, params: &Value) -> RawRequest {
    RawRequest {
        descriptor,
        params: Some(serde_json::value::to_raw_value(params).expect("test params are JSON")),
        attachments: Vec::new(),
    }
}
