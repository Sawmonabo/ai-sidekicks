//! The approval rows a rebuild writes from the log against the rows the live writes wrote.

use std::sync::Arc;

use rstest::rstest;
use rusqlite::Connection;
use rusqlite::types::Value;
use serde_json::json;
use sidekicks_approval::projection::rebuild::ApprovalsProjection;
use sidekicks_approval::request_create::ApprovalResourceDescriptor;
use sidekicks_approval::store::{
    ApprovalSettlement, InsertedApprovalRequest, InsertedApprovalResolution,
    insert_request_statement, insert_resolution_statement, remembered_scope_statement,
    settle_pending_statement,
};
use sidekicks_contracts::approval::ApprovalDecision;
use sidekicks_contracts::approval::events::ApprovalResolvedPayload;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::workflow::run::gate_resolution::WorkflowGateKind;
use sidekicks_store::database::schema::recovery::ProjectionCursorState;
use sidekicks_store::database::statement::WriteStatement;
use sidekicks_store::database::writer::test_file::{test_envelope, test_session_id};
use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions};
use sidekicks_store::events::session::insert::{SessionEventRow, monotonic_ns_now};

use super::{cursor, rebuild_database, rebuild_whole, table_rows};

// The statements the live service writes with each event, from the event as it is stored.
fn live_statements(event: &SessionEvent, occurred_at: &WireInstant) -> Vec<WriteStatement> {
    let answer = |resolved: &ApprovalResolvedPayload, decision| {
        vec![
            settle_pending_statement(
                &resolved.approval_request_id,
                ApprovalSettlement::Decided(decision),
                occurred_at,
            ),
            insert_resolution_statement(&InsertedApprovalResolution {
                approval_request_id: resolved.approval_request_id,
                device_id: resolved.device_id.clone(),
                client_resolution_id: resolved.client_resolution_id.clone(),
                decision,
                effective_scope: resolved.effective_scope.clone(),
                asked_scope: resolved.remembered_scope.clone(),
                edited_action: resolved.edited_action.clone(),
                decline_reason: resolved.decline_reason.clone(),
                resolved_at: occurred_at.clone(),
            }),
        ]
    };
    if let SessionEvent::ApprovalRequested(requested) = event {
        let resource_descriptor =
            ApprovalResourceDescriptor::try_from(&requested.resource_descriptor)
                .expect("the test's descriptor reads");
        vec![insert_request_statement(&InsertedApprovalRequest {
            approval_request_id: requested.approval_request_id,
            session_id: requested.session_id,
            run_id: requested.run_id,
            requested_by: requested.requested_by.clone(),
            category: requested.category,
            scope: requested.scope.clone(),
            resource_descriptor,
            ask_id: requested.ask_id.clone(),
            tool_call_id: requested.tool_call_id.clone(),
            created_at: occurred_at.clone(),
        })]
    } else if let SessionEvent::ApprovalApproved(resolved) = event {
        answer(resolved, ApprovalDecision::Approved)
    } else if let SessionEvent::ApprovalRejected(resolved) = event {
        answer(resolved, ApprovalDecision::Rejected)
    } else if let SessionEvent::ApprovalCanceled(canceled) = event {
        vec![settle_pending_statement(
            &canceled.approval_request_id,
            ApprovalSettlement::Canceled,
            occurred_at,
        )]
    } else if let SessionEvent::ApprovalRuleRemembered(remembered) = event {
        vec![remembered_scope_statement(
            &remembered.approval_request_id,
            &remembered.remembered_scope,
        )]
    } else if let SessionEvent::SessionDamagedEventsSkipped(_) = event {
        // A skipped range writes no approval row.
        Vec::new()
    } else {
        panic!("the test writes no {:?}", event.event_type())
    }
}

// One ask's events: its request and what became of it.
struct Ask {
    id: String,
    run_id: String,
}

impl Ask {
    fn new() -> Self {
        Self {
            id: mint_uuid_v7().to_string(),
            run_id: mint_uuid_v7().to_string(),
        }
    }

    fn event(
        &self,
        session_id: SessionId,
        event_type: &str,
        extra: &serde_json::Value,
    ) -> SessionEvent {
        let mut payload = json!({
            "sessionId": session_id,
            "runId": self.run_id,
            "approvalRequestId": self.id,
            "category": "toolExecution",
            "scope": "npm run build",
        });
        let members = payload.as_object_mut().expect("the payload is an object");
        for (name, value) in extra.as_object().expect("the extra members are an object") {
            members.insert(name.clone(), value.clone());
        }
        serde_json::from_value(json!({ "type": event_type, "payload": payload }))
            .expect("the test writes a valid approval event")
    }
}

// Appends `event` with the live statements in one write, as the live service does, and
// answers its sequence and stored instant.
async fn append_live(
    writer: &DatabaseWriter,
    session_id: SessionId,
    event: &SessionEvent,
) -> (i64, WireInstant) {
    let envelope = test_envelope(session_id, event);
    let occurred_at = WireInstant::try_from(envelope.occurred_at.as_str().to_owned())
        .expect("the stored instant reads");
    let row = SessionEventRow {
        payload: serde_json::to_string(envelope.payload()).expect("a JSON object serializes"),
        envelope: Arc::new(envelope),
        monotonic_ns: monotonic_ns_now(),
        content_payload: None,
    };
    let sequences = writer
        .append_events(vec![row], live_statements(event, &occurred_at))
        .await
        .expect("the live write is kept");
    (i64::from(sequences[0]), occurred_at)
}

fn approval_rows(connection: &Connection) -> (Vec<Vec<Value>>, Vec<Vec<Value>>) {
    (
        table_rows(connection, "SELECT * FROM approval_requests ORDER BY id"),
        table_rows(
            connection,
            "SELECT * FROM approval_resolutions ORDER BY request_id",
        ),
    )
}

// The gate-named ask's events the session skipped as damaged.
#[derive(Clone, Copy, Debug)]
enum GateNamedSkip {
    Nothing,
    AnswerAndRule,
    Rule,
}

// The rows the live writes wrote are the rows a rebuild writes: an approval with its
// correction, a decline with its words, a cancellation, and an ask a workflow gate's answer
// names, with the rule it asked for and made, which the clear keeps with its answer. Rebuilt
// whole, the gate-named ask's answer is written over the kept one; where the session skipped
// that answer as damaged, the ask settles as the gate's row says; where it skipped only the
// rule, the answer is written without the rule made and with the rule asked for, which its own
// event carries. Every rebuild leaves the cursor current at the log's head. A clear that drops
// the gate-named ask breaks the gate's reference, one that drops its answer or a missing settle
// leaves it pending or unanswered, a plain insert of its answer collides with the kept one, a
// rewrite that keeps the kept answer's rule made keeps one the log no longer holds, and one
// that clears the rule asked for drops one the answer's event holds, each failing a case.
#[rstest]
#[case::rebuilt_whole(GateNamedSkip::Nothing)]
#[case::skipping_the_gate_named_answer(GateNamedSkip::AnswerAndRule)]
#[case::skipping_the_gate_named_rule(GateNamedSkip::Rule)]
#[tokio::test]
async fn a_rebuild_writes_the_rows_the_live_writes_wrote(#[case] skip: GateNamedSkip) {
    let database = rebuild_database();
    let writer = Arc::new(
        DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
            .await
            .expect("the writer opens its database"),
    );
    let session_id = test_session_id();
    let approved = Ask::new();
    let rejected = Ask::new();
    let canceled = Ask::new();
    let gate_named = Ask::new();
    let requested = |ask: &Ask, ask_id: Option<&str>| {
        let mut descriptor = json!({
            "subject": "npm run",
            "standingAllowOffered": true,
            "projectScopeOffered": true,
            "editable": true,
            "toolName": "Bash",
            "prompt": "Allow npm run build?",
        });
        if ask_id.is_none() {
            descriptor = json!({
                "subject": "plan",
                "standingAllowOffered": false,
                "projectScopeOffered": false,
                "editable": false,
            });
        }
        let mut extra = json!({ "requestedBy": "agent-1", "resourceDescriptor": descriptor });
        if let Some(ask_id) = ask_id {
            extra["askId"] = json!(ask_id);
        }
        ask.event(session_id, "approval.requested", &extra)
    };
    // `said` is what the person added to the answer: a correction, or a decline's words.
    let answer = |ask: &Ask, event_type: &str, said: Option<(&str, &str)>| {
        let mut extra = json!({
            "effectiveScope": "npm run build",
            "deviceId": "device-1",
            "clientResolutionId": mint_uuid_v7().to_string(),
        });
        if let Some((field, text)) = said {
            extra[field] = json!(text);
        }
        if ask.id == gate_named.id {
            extra["rememberedScope"] = json!({
                "kind": "session",
                "pattern": "npm run",
                "sense": "allow",
            });
        }
        ask.event(session_id, event_type, &extra)
    };
    let remembered = |ask: &Ask| {
        ask.event(
            session_id,
            "approval.rule.remembered",
            &json!({
                "machineId": "machine-1",
                "ruleId": mint_uuid_v7().to_string(),
                "rememberedScope": {
                    "kind": "session",
                    "pattern": "npm run",
                    "sense": "allow",
                },
            }),
        )
    };
    let events = [
        requested(&approved, Some("ask-1")),
        answer(
            &approved,
            "approval.approved",
            Some(("editedAction", "npm run build -- --watch")),
        ),
        requested(&rejected, Some("ask-2")),
        answer(
            &rejected,
            "approval.rejected",
            Some(("declineReason", "not on the build machine")),
        ),
        requested(&canceled, None),
        canceled.event(session_id, "approval.canceled", &json!({})),
        requested(&gate_named, Some("ask-3")),
        answer(&gate_named, "approval.approved", None),
        remembered(&gate_named),
    ];
    let mut appended = Vec::with_capacity(events.len());
    for event in &events {
        appended.push(append_live(&writer, session_id, event).await);
    }
    let [
        ..,
        (gate_answer_sequence, gate_answered_at),
        (gate_rule_sequence, _),
    ] = appended.as_slice()
    else {
        panic!("the test appends the gate-named ask's answer and rule last");
    };
    let mut head_sequence = *gate_rule_sequence;
    let skipped_range = match skip {
        GateNamedSkip::Nothing => None,
        GateNamedSkip::AnswerAndRule => Some((*gate_answer_sequence, *gate_rule_sequence)),
        GateNamedSkip::Rule => Some((*gate_rule_sequence, *gate_rule_sequence)),
    };
    if let Some((from_sequence, to_sequence)) = skipped_range {
        let skipped: SessionEvent = serde_json::from_value(json!({
            "type": "session.damagedEvents.skipped",
            "payload": {
                "sessionId": session_id,
                "fromSequence": from_sequence,
                "toSequence": to_sequence,
            },
        }))
        .expect("the test writes a valid skipped range");
        (head_sequence, _) = append_live(&writer, session_id, &skipped).await;
    }
    // The gate's row as the workflow engine writes it beside its answer; its run's rows are no
    // part of what a rebuild reads.
    let reader = database.reader();
    reader
        .execute_batch("PRAGMA foreign_keys = OFF")
        .expect("the test's connection takes the gate's row alone");
    reader
        .execute(
            "INSERT INTO workflow_gate_resolutions (id, workflow_run_id, sequence, node_id,
               gate_kind, approval_category, approval_request_id, outcome, device_id,
               resolved_at)
             VALUES (?1, ?2, 1, 'approve', ?3, NULL, ?4, ?5, 'device-1', ?6)",
            (
                mint_uuid_v7().to_string(),
                mint_uuid_v7().to_string(),
                <&str>::from(WorkflowGateKind::HumanApproval),
                gate_named.id.as_str(),
                <&str>::from(ApprovalDecision::Approved),
                gate_answered_at.as_str(),
            ),
        )
        .expect("the gate's row is written");
    let (live_requests, mut live_resolutions) = approval_rows(&reader);
    if let GateNamedSkip::Rule = skip {
        // A rebuild that never reads the gate-named ask's rule writes its answer without the
        // rule made, and keeps the rule asked for, which the answer's own event carries.
        let columns = reader
            .prepare("SELECT * FROM approval_resolutions")
            .expect("the read prepares");
        let column_names = columns.column_names();
        let at = |name: &str| {
            column_names
                .iter()
                .position(|column| *column == name)
                .expect("the answers' table holds the column")
        };
        for row in &mut live_resolutions {
            if row[at("request_id")] == Value::Text(gate_named.id.clone()) {
                row[at("remembered_scope_kind")] = Value::Null;
                row[at("remembered_scope_pattern")] = Value::Null;
            }
        }
    }
    rebuild_whole(&database, writer, Box::new(ApprovalsProjection), session_id).await;

    assert_eq!(approval_rows(&reader), (live_requests, live_resolutions));
    assert_eq!(
        cursor(&reader, session_id),
        (
            <&str>::from(ProjectionCursorState::Current).to_owned(),
            head_sequence
        )
    );
}
