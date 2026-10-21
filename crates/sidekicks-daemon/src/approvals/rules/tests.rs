use std::sync::Arc;

use serde_json::json;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::session::id::SessionId;

use super::{SELECT_RULES_IN_FORCE_SQL, provider_rule_of, query_rule_rows, rule_over};
use crate::database::writer::test_file::{TestDatabase, test_envelope, test_session_id};
use crate::database::writer::{DatabaseWriter, DatabaseWriterOptions};
use crate::events::session::insert::{SessionEventRow, monotonic_ns_now};
use crate::provider::port::permission_ask::ProviderAskActionKind;
use sidekicks_contracts::wire::id::mint_uuid_v7;

// Appends the event `event` describes to the session's log and answers its sequence.
async fn append(writer: &DatabaseWriter, session_id: SessionId, event: serde_json::Value) -> i64 {
    let event: SessionEvent =
        serde_json::from_value(event).expect("the test writes a valid session event");
    let envelope = test_envelope(session_id, &event);
    let row = SessionEventRow {
        payload: serde_json::to_string(envelope.payload()).expect("a JSON object serializes"),
        envelope: Arc::new(envelope),
        monotonic_ns: monotonic_ns_now(),
        content_payload: None,
    };
    let sequences = writer
        .append_events(vec![row], Vec::new())
        .await
        .expect("the event is kept");
    i64::from(sequences[0])
}

// A rule whose event lies in a range the session continued past as damaged is neither in force
// nor listed, while one outside it still is; a read of the rule events that keeps the skipped
// range applies the skipped rule and fails.
#[tokio::test]
async fn a_rule_remembered_in_a_skipped_range_is_not_in_force() {
    let database = TestDatabase::new();
    let writer = DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
        .await
        .expect("the writer opens its database");
    let session_id = test_session_id();
    let reader = database.reader();
    let mut rule_sequences = Vec::new();
    for subject in ["npm run", "cargo test"] {
        let ask_id = mint_uuid_v7().to_string();
        let run_id = mint_uuid_v7().to_string();
        // The ask's row as its request wrote it, naming the action whose kind the rule takes.
        let descriptor = json!({
            "subject": subject,
            "standingAllowOffered": true,
            "projectScopeOffered": true,
            "editable": true,
            "action": { "kind": "command", "command": format!("{subject} build") },
        });
        reader
            .execute(
                "INSERT INTO approval_requests (id, session_id, run_id, requested_by, category,
                   scope, resource_descriptor, created_at, updated_at)
                 VALUES (?1, ?2, ?3, 'agent-1', 'toolExecution', ?4, ?5,
                   '2026-10-19T09:00:00.000Z', '2026-10-19T09:00:00.000Z')",
                (
                    ask_id.as_str(),
                    session_id.text().as_str(),
                    run_id.as_str(),
                    format!("{subject} build"),
                    descriptor.to_string(),
                ),
            )
            .expect("the ask's row is written");
        let remembered = json!({
            "type": "approval.rule.remembered",
            "payload": {
                "sessionId": session_id,
                "runId": run_id,
                "approvalRequestId": ask_id,
                "category": "toolExecution",
                "scope": format!("{subject} build"),
                "machineId": "machine-1",
                "ruleId": ask_id,
                "rememberedScope": { "kind": "session", "pattern": subject, "sense": "allow" },
            },
        });
        rule_sequences.push(append(&writer, session_id, remembered).await);
    }
    let skipped = json!({
        "type": "session.damagedEvents.skipped",
        "payload": {
            "sessionId": session_id,
            "fromSequence": rule_sequences[0],
            "toSequence": rule_sequences[0],
        },
    });
    append(&writer, session_id, skipped).await;

    let in_force = query_rule_rows(&reader, &SELECT_RULES_IN_FORCE_SQL, session_id)
        .expect("the rules in force read");

    assert!(rule_over(&in_force, ProviderAskActionKind::Command, "npm run").is_none());
    assert_eq!(
        in_force
            .iter()
            .map(|row| provider_rule_of(row).subject)
            .collect::<Vec<_>>(),
        vec!["cargo test".to_owned()]
    );
}
