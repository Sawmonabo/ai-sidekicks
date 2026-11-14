use serde_json::{Value, json};

use super::{AgentQueueItemCreateRequest, PlanMessageKind, UserMessageSentPayload};
use crate::wire::attachment::parse_received;

fn sent_row(plan_message: Option<Value>) -> Value {
    let mut row = json!({
        "sessionId": "0190f5a4-1c2b-7d3e-8f40-5a6b7c8d9e0f",
        "actor": "device-1",
        "message": "Build this plan.",
    });
    if let Some(plan_message) = plan_message {
        row["planMessage"] = plan_message;
    }
    row
}

// A person's message reads and writes without the plan marker, a plan message keeps it whole,
// and an explicit `null` is refused rather than read as a person's message.
#[test]
fn the_plan_marker_is_absent_or_whole_and_never_null() {
    let plain: UserMessageSentPayload =
        serde_json::from_value(sent_row(None)).expect("a person's message reads");
    assert_eq!(plain.plan_message, None);
    let written = serde_json::to_value(&plain).expect("a person's message writes");
    assert!(written.get("planMessage").is_none());

    let marker = json!({
        "planId": "0190f5a4-1c2b-7d3e-8f40-5a6b7c8d9e10",
        "kind": "seed",
        "sourceSessionId": "0190f5a4-1c2b-7d3e-8f40-5a6b7c8d9e11",
    });
    let seed: UserMessageSentPayload =
        serde_json::from_value(sent_row(Some(marker.clone()))).expect("a seed reads");
    assert_eq!(
        seed.plan_message
            .as_ref()
            .map(|plan_message| plan_message.kind),
        Some(PlanMessageKind::Seed)
    );
    let written = serde_json::to_value(&seed).expect("a seed writes");
    assert_eq!(written["planMessage"], marker);

    assert!(serde_json::from_value::<UserMessageSentPayload>(sent_row(Some(Value::Null))).is_err());
}

fn send(content: &str, attachments: Option<Value>) -> Vec<u8> {
    let mut request = json!({
        "sessionId": "0190f5a4-1c2b-7d3e-8f40-5a6b7c8d9e0f",
        "clientIdempotencyKey": "0190f2a0-0000-7000-8000-000000000002",
        "content": content,
    });
    if let Some(attachments) = attachments {
        request["attachments"] = attachments;
    }
    serde_json::to_vec(&request).expect("a send serializes")
}

// A send holds words or at least one file: blank words alone, or beside an empty file list, are
// refused, and blank words beside a file are taken. Killed by a rule that reads only the words,
// which refuses the file alone, and by one that reads only the list's presence, which takes the
// empty list.
#[test]
fn a_send_holds_words_or_at_least_one_file() {
    let file = json!(["0190f5a4-1c2b-7d3e-8f40-5a6b7c8d9e12"]);
    for refused in [send("", None), send(" \n", None), send("", Some(json!([])))] {
        assert!(parse_received::<AgentQueueItemCreateRequest>(&refused, Vec::new()).is_err());
    }
    for taken in [
        send("", Some(file.clone())),
        send("  ", Some(file)),
        send("Look.", None),
    ] {
        assert!(parse_received::<AgentQueueItemCreateRequest>(&taken, Vec::new()).is_ok());
    }
}
