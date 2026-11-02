//! A message another session sent, as a hosted session's stream shows it: Claude Code replays each
//! message it takes in from its inbox as a `user` frame whose `origin.kind` is `peer`, under the
//! `uuid` its writer sent, the daemon's own id for a message it sent. Several queued messages from
//! one sender drain into one turn as one frame under the last one's `uuid` and the first one's
//! `msg_id`, so an arrival is keyed by the frame's `uuid`, never the sender's id.

use std::sync::Arc;

use serde::{Deserialize, Deserializer};
use serde_json::Value;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::port_registration::PortRegistration;

use crate::driver::claude::delivery::messages::ClaudeMessageFrame;
use crate::lenient_json::{Lenient as _, LenientList, lenient_object, read_lenient};
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

/// A frame's `origin` member, read leniently and boxed; `None` for a value of another shape.
pub(crate) fn read_boxed_origin<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Box<ClaudeMessageOrigin>>, D::Error> {
    Ok(ClaudeMessageOrigin::read(deserializer)?.map(Box::new))
}

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

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};
    use sidekicks_contracts::run::id::RunId;
    use sidekicks_contracts::session::id::SessionId;

    use crate::driver::claude::session::scripted::{
        SCRIPTED_PROVIDER_SESSION_ID, ScriptedSession, settle,
    };
    use crate::port::session_message_reading_publisher::{
        SessionMessageArrival, SessionMessageReading,
    };

    const SENDER: &str = "uds:/tmp/cc-socks/4101.sock";

    // A peer message's replay frame under `uuid`, as Claude Code writes it.
    fn peer_frame(uuid: &str, origin: &Value) -> Value {
        json!({
            "type": "user",
            "session_id": SCRIPTED_PROVIDER_SESSION_ID,
            "uuid": uuid,
            "isReplay": true,
            "message": {"role": "user", "content": "a message from another session"},
            "origin": origin,
        })
    }

    // The arrival on `session_id` a frame from `SENDER` with no other sender member reads as.
    fn arrival(
        session_id: SessionId,
        message_id: &str,
        sender_message_id: &str,
        body: &str,
        run_id: Option<RunId>,
        is_turn_start: bool,
    ) -> SessionMessageArrival {
        SessionMessageArrival {
            session_id,
            run_id,
            message_id: message_id.to_owned(),
            sender_message_id: Some(sender_message_id.to_owned()),
            from: SENDER.to_owned(),
            from_session: None,
            from_name: None,
            hop_chain: Vec::new(),
            sender_process_id: None,
            body: Some(body.to_owned()),
            is_turn_start,
        }
    }

    // Killed by arrivals published only for the daemon's own ids (none of these is one), by the
    // frames replayed before any run holds the turn dropped, by keying an arrival by `msg_id` (the
    // merged frame would read as `u-4` again), by a merged frame's body read from its first
    // message, by `is_turn_start` held constant or not cleared at `system/init`, by a sender member
    // left unread, and by a `refused` lifecycle published only for a message the daemon wrote.
    #[tokio::test(start_paused = true)]
    async fn every_peer_frame_arrives_under_its_uuid_with_its_turn_start() {
        let session = ScriptedSession::new().await;

        // A merged drain's earlier messages, replayed before the turn's `system/init`.
        session.frame(&peer_frame(
            "u-4",
            &json!({"kind": "peer", "from": SENDER, "msg_id": "m-4", "body": "b4"}),
        ));
        session.frame(&peer_frame(
            "u-5",
            &json!({"kind": "peer", "from": SENDER, "msg_id": "m-5", "body": "b5"}),
        ));
        settle().await;
        let run_id = session.hold_lead_turn("lead");
        session.frame(&json!({"type": "system", "subtype": "init",
            "session_id": SCRIPTED_PROVIDER_SESSION_ID, "model": "opus"}));
        session.frame(&peer_frame(
            "u-6",
            &json!({"kind": "peer", "from": SENDER, "msg_id": "m-4",
                "members": [{"body": "b4"}, {"body": "b5"}, {"body": "b6"}]}),
        ));
        session.frame(&json!({
            "type": "assistant",
            "session_id": SCRIPTED_PROVIDER_SESSION_ID,
            "message": {"id": "message-1", "role": "assistant",
                "content": [{"type": "text", "text": "working"}]},
        }));
        // A message absorbed mid-turn, with every sender member Claude Code writes.
        session.frame(&peer_frame(
            "u-2",
            &json!({"kind": "peer", "from": SENDER, "msg_id": "m-2", "body": "b2",
                "name": "builder", "fromSession": "0123456789abcdef01234567",
                "hopChain": ["89abcdef0123456789abcdef"], "verifiedPeerPid": 4101}),
        ));
        session.frame(&json!({
            "type": "command_lifecycle",
            "session_id": SCRIPTED_PROVIDER_SESSION_ID,
            "command_uuid": "u-3",
            "state": "refused",
        }));
        settle().await;

        let session_id = session.session_id;
        let absorbed = SessionMessageArrival {
            from_session: Some("0123456789abcdef01234567".to_owned()),
            from_name: Some("builder".to_owned()),
            hop_chain: vec!["89abcdef0123456789abcdef".to_owned()],
            sender_process_id: Some(4101),
            ..arrival(session_id, "u-2", "m-2", "b2", Some(run_id), false)
        };
        assert_eq!(
            session.ports.message_readings(),
            [
                SessionMessageReading::Arrived(arrival(session_id, "u-4", "m-4", "b4", None, true)),
                SessionMessageReading::Arrived(arrival(session_id, "u-5", "m-5", "b5", None, true)),
                SessionMessageReading::Arrived(arrival(
                    session_id,
                    "u-6",
                    "m-4",
                    "b6",
                    Some(run_id),
                    true
                )),
                SessionMessageReading::Arrived(absorbed),
                SessionMessageReading::Refused {
                    message_id: "u-3".to_owned(),
                    reason: None,
                    drop_reason: None,
                },
            ]
        );
    }
}
