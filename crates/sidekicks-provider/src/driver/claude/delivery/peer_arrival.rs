//! A message another session sent, as a hosted session's stream shows it: Claude Code replays each
//! message it takes in from its inbox as a `user` frame whose `origin.kind` is `peer`, under the
//! `uuid` its writer sent, the daemon's own id for a message it sent. Several queued messages from
//! one sender drain into one turn as one frame under the last one's `uuid` and the first one's
//! `msg_id`, so an arrival is keyed by the frame's `uuid`, never the sender's id.

use std::sync::Arc;

use serde::Deserialize;
use serde_json::Value;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::port_registration::PortRegistration;

use crate::driver::claude::delivery::messages::ClaudeMessageFrame;
use crate::lenient_json::{LenientList, lenient_object, read_lenient};
use crate::port::session_message_reading_publisher::{
    SessionMessageArrival, SessionMessageReading, SessionMessageReadingPublisher,
};

/// The `origin` kind of a message another session sent.
const PEER_ORIGIN_KIND: &str = "peer";

/// Where a `user` frame's message came from, each member read leniently.
#[derive(Deserialize)]
pub(crate) struct ClaudeMessageOrigin {
    #[serde(default, deserialize_with = "read_lenient")]
    kind: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    from: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    msg_id: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    name: Option<String>,
    #[serde(rename = "fromSession", default, deserialize_with = "read_lenient")]
    from_session: Option<String>,
    #[serde(rename = "hopChain", default, deserialize_with = "read_lenient")]
    hop_chain: Option<LenientList<String>>,
    // Read as any value, so a number out of range or of another type reads as absent.
    #[serde(rename = "verifiedPeerPid", default)]
    verified_peer_pid: Option<Value>,
    #[serde(default, deserialize_with = "read_lenient")]
    body: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    members: Option<LenientList<ClaudeOriginMember>>,
}

// One message a merged frame drains.
#[derive(Deserialize)]
struct ClaudeOriginMember {
    #[serde(default, deserialize_with = "read_lenient")]
    body: Option<String>,
}

lenient_object!(ClaudeMessageOrigin, ClaudeOriginMember);

/// The arrival `frame` tells on `session_id` under `run_id`, the run holding the turn: only a
/// peer message with a sender and the frame's `uuid`, `None` for any other frame. Its body is the
/// origin's own, else a merged frame's last message's, the one its `uuid` names.
pub(crate) fn read_peer_arrival(
    frame: &ClaudeMessageFrame,
    session_id: SessionId,
    run_id: Option<RunId>,
    is_turn_start: bool,
) -> Option<SessionMessageArrival> {
    let origin = frame.origin()?;
    if origin.kind.as_deref() != Some(PEER_ORIGIN_KIND) {
        return None;
    }
    let from = origin.from.clone().filter(|from| !from.is_empty())?;
    let message_id = frame.uuid()?.to_owned();
    let body = origin.body.clone().or_else(|| {
        origin
            .members
            .as_ref()
            .and_then(|LenientList(members)| members.last())
            .and_then(|member| member.body.clone())
    });
    Some(SessionMessageArrival {
        session_id,
        run_id,
        message_id,
        sender_message_id: origin.msg_id.clone(),
        from,
        from_session: origin.from_session.clone(),
        from_name: origin.name.clone(),
        hop_chain: origin
            .hop_chain
            .as_ref()
            .map(|LenientList(hops)| hops.clone())
            .unwrap_or_default(),
        sender_process_id: origin
            .verified_peer_pid
            .as_ref()
            .and_then(Value::as_u64)
            .and_then(|process_id| u32::try_from(process_id).ok()),
        body,
        is_turn_start,
    })
}

/// Publishes `arrival`, where there is one, to `readings` once registered; one read before then
/// is dropped.
pub(crate) fn publish_peer_arrival(
    readings: &PortRegistration<Arc<dyn SessionMessageReadingPublisher>>,
    arrival: Option<SessionMessageArrival>,
) {
    if let (Some(arrival), Some(publisher)) = (arrival, readings.port()) {
        publisher.publish(SessionMessageReading::Arrived(arrival));
    }
}
