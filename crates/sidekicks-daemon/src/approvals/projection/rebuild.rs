//! The approval tables as a rebuild writes them from the session's log: each ask from its
//! `approval.requested`, with the daemon's own ask id that routes its answer back to the provider
//! ask it was raised for; each answer from its `approval.approved` or `approval.rejected`; each
//! cancellation from its `approval.canceled`; and the rule an answer made from its
//! `approval.rule.remembered`. Every row is written at the event's own instant with the columns its
//! live write wrote, through the live write's own guards, so the rows a rebuild writes are the rows
//! the live writes wrote. The category's other events write no approval row: a rule's revocation
//! and a reviewer's block live with the provider and in their own table.
//!
//! An ask a workflow gate's answer names keeps its row and its answer through the clear, since the
//! gate's row references the ask and no rebuild writes the gate's rows; the fold writes both over
//! as it reaches them. Such an ask whose answer the fold never reaches, its answer in a range the
//! session skipped as damaged, settles as the gate's row says, the later fact.

use std::borrow::Cow;
use std::sync::LazyLock;

use rusqlite::types::Value;
use sidekicks_contracts::approval::events::ApprovalResolvedPayload;
use sidekicks_contracts::approval::{ApprovalDecision, ApprovalState};
use sidekicks_contracts::event::envelope::EventEnvelope;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;

use crate::approvals::request_create::ApprovalResourceDescriptor;
use crate::approvals::store::{
    ApprovalSettlement, InsertedApprovalRequest, InsertedApprovalResolution,
    remembered_scope_statement, rewrite_request_statement, rewrite_resolution_statement,
    settle_pending_statement,
};
use crate::database::statement::{StatementBindings, WriteStatement};
use crate::recovery::projection_rebuild::{
    ProjectionContradiction, SessionProjection, SessionProjectionFold,
};

// The asks a workflow gate's answer names, which outlive the clear.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's start, which registers the projection with the rebuild"
    )
)]
const GATE_NAMED_ASKS_SQL: &str = "SELECT approval_request_id FROM workflow_gate_resolutions";

// The session's answers, but those of the asks the clear keeps.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's start, which registers the projection with the rebuild"
    )
)]
static CLEAR_RESOLUTIONS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "DELETE FROM approval_resolutions
  WHERE request_id IN (SELECT id FROM approval_requests
                        WHERE session_id = ? AND id NOT IN ({GATE_NAMED_ASKS_SQL}))"
    )
});

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's start, which registers the projection with the rebuild"
    )
)]
static CLEAR_REQUESTS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "DELETE FROM approval_requests
  WHERE session_id = ? AND id NOT IN ({GATE_NAMED_ASKS_SQL})"
    )
});

// Each of the session's asks a gate's answer names that the fold left pending takes the newest
// gate answer's outcome and instant, the words a decision and an ask's state share.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's start, which registers the projection with the rebuild"
    )
)]
static SETTLE_AS_GATES_ANSWERED_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE approval_requests
  SET (state, updated_at) = (SELECT gate.outcome, gate.resolved_at
                               FROM workflow_gate_resolutions AS gate
                              WHERE gate.approval_request_id = approval_requests.id
                              ORDER BY gate.resolved_at DESC, gate.sequence DESC
                              LIMIT 1)
  WHERE session_id = ? AND state = '{}' AND id IN ({GATE_NAMED_ASKS_SQL})",
        <&str>::from(ApprovalState::Pending)
    )
});

// Every type the fold reads: an ask, its answer either way, its cancellation and its rule.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's start, which registers the projection with the rebuild"
    )
)]
const APPROVALS_EVENT_TYPES: [SessionEventType; 5] = [
    SessionEventType::ApprovalRequested,
    SessionEventType::ApprovalApproved,
    SessionEventType::ApprovalRejected,
    SessionEventType::ApprovalCanceled,
    SessionEventType::ApprovalRuleRemembered,
];

/// The `approval_requests` and `approval_resolutions` rows as a rebuild replaces them. Its fold
/// keeps no state, so the projection is its own fold.
#[derive(Clone, Copy, Debug)]
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's start, which registers the projection with the rebuild"
    )
)]
pub(crate) struct ApprovalsProjection;

impl SessionProjection for ApprovalsProjection {
    fn name(&self) -> &'static str {
        "approvals"
    }

    fn event_types(&self) -> &[SessionEventType] {
        &APPROVALS_EVENT_TYPES
    }

    fn clear_statements(&self, session_id: &SessionId) -> Vec<WriteStatement> {
        vec![
            session_statement(&CLEAR_RESOLUTIONS_SQL, session_id),
            session_statement(&CLEAR_REQUESTS_SQL, session_id),
        ]
    }

    fn closing_statements(&self, session_id: &SessionId) -> Vec<WriteStatement> {
        vec![session_statement(&SETTLE_AS_GATES_ANSWERED_SQL, session_id)]
    }

    fn fold(&self, _session_id: &SessionId) -> Box<dyn SessionProjectionFold> {
        Box::new(*self)
    }
}

impl SessionProjectionFold for ApprovalsProjection {
    fn apply(
        &mut self,
        envelope: &EventEnvelope,
        event: &SessionEvent,
        statements: &mut Vec<WriteStatement>,
    ) -> Result<(), ProjectionContradiction> {
        let occurred_at =
            WireInstant::try_from(envelope.occurred_at.as_str().to_owned()).map_err(|refusal| {
                ProjectionContradiction(format!("the event's instant does not read: {refusal}"))
            })?;
        if let SessionEvent::ApprovalRequested(requested) = event {
            let resource_descriptor = ApprovalResourceDescriptor::try_from(
                &requested.resource_descriptor,
            )
            .map_err(|refusal| {
                ProjectionContradiction(format!(
                    "the ask's resource descriptor does not read: {refusal}"
                ))
            })?;
            statements.push(rewrite_request_statement(&InsertedApprovalRequest {
                approval_request_id: requested.approval_request_id,
                session_id: requested.session_id,
                run_id: requested.run_id,
                requested_by: requested.requested_by.clone(),
                category: requested.category,
                scope: requested.scope.clone(),
                resource_descriptor,
                ask_id: requested.ask_id.clone(),
                created_at: occurred_at,
            }));
        } else if let SessionEvent::ApprovalApproved(resolved) = event {
            push_answer(
                resolved,
                ApprovalDecision::Approved,
                occurred_at,
                statements,
            );
        } else if let SessionEvent::ApprovalRejected(resolved) = event {
            push_answer(
                resolved,
                ApprovalDecision::Rejected,
                occurred_at,
                statements,
            );
        } else if let SessionEvent::ApprovalCanceled(canceled) = event {
            statements.push(settle_pending_statement(
                &canceled.approval_request_id,
                ApprovalSettlement::Canceled,
                &occurred_at,
            ));
        } else if let SessionEvent::ApprovalRuleRemembered(remembered) = event {
            statements.push(remembered_scope_statement(
                &remembered.approval_request_id,
                &remembered.remembered_scope,
            ));
        }
        Ok(())
    }
}

// An answer settles its pending ask and records itself, over the answer a gate-named ask kept.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's start, which registers the projection with the rebuild"
    )
)]
fn push_answer(
    resolved: &ApprovalResolvedPayload,
    decision: ApprovalDecision,
    resolved_at: WireInstant,
    statements: &mut Vec<WriteStatement>,
) {
    statements.push(settle_pending_statement(
        &resolved.approval_request_id,
        ApprovalSettlement::Decided(decision),
        &resolved_at,
    ));
    statements.push(rewrite_resolution_statement(&InsertedApprovalResolution {
        approval_request_id: resolved.approval_request_id,
        device_id: resolved.device_id.clone(),
        client_resolution_id: resolved.client_resolution_id.clone(),
        decision,
        effective_scope: resolved.effective_scope.clone(),
        asked_scope: resolved.remembered_scope.clone(),
        edited_action: resolved.edited_action.clone(),
        decline_reason: resolved.decline_reason.clone(),
        resolved_at,
    }));
}

// A statement over the session's rows, which any number of them may match.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's start, which registers the projection with the rebuild"
    )
)]
fn session_statement(sql: &'static LazyLock<String>, session_id: &SessionId) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(sql.as_str()),
        bindings: StatementBindings::Positional(vec![Value::Text(
            session_id.text().as_str().to_owned(),
        )]),
        expected_row_count: None,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use rstest::rstest;
    use rusqlite::Connection;
    use rusqlite::types::Value;
    use serde_json::json;
    use sidekicks_contracts::approval::ApprovalDecision;
    use sidekicks_contracts::approval::events::ApprovalResolvedPayload;
    use sidekicks_contracts::event::session::SessionEvent;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::wire::instant::WireInstant;
    use sidekicks_contracts::workflow::run::gate_resolution::WorkflowGateKind;

    use super::ApprovalsProjection;
    use crate::approvals::request_create::ApprovalResourceDescriptor;
    use crate::approvals::store::{
        ApprovalSettlement, InsertedApprovalRequest, InsertedApprovalResolution,
        insert_request_statement, insert_resolution_statement, remembered_scope_statement,
        settle_pending_statement,
    };
    use crate::database::connection::read_pool::DatabaseReadPool;
    use crate::database::schema::recovery::ProjectionCursorState;
    use crate::database::statement::WriteStatement;
    use crate::database::writer::test_file::{TestDatabase, test_envelope, test_session_id};
    use crate::database::writer::{DatabaseWriter, DatabaseWriterOptions};
    use crate::events::session::insert::{SessionEventRow, monotonic_ns_now};
    use crate::events::session::read::DamagedFromSequenceReader;
    use crate::recovery::database_file::damage::DatabaseDamageWatch;
    use crate::recovery::projection_rebuild::{
        PROJECTION_REBUILD_STATEMENT_CAPACITY, ProjectionRebuildRequest, ProjectionRebuildService,
    };
    use crate::session::service::{SESSION_SERVICE_STATEMENT_CAPACITY, SessionService};
    use sidekicks_contracts::wire::id::mint_uuid_v7;

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

    fn table_rows(connection: &Connection, sql: &str) -> Vec<Vec<Value>> {
        let mut statement = connection.prepare(sql).expect("the read prepares");
        let columns = statement.column_count();
        statement
            .query_map([], |row| {
                (0..columns)
                    .map(|index| row.get::<_, Value>(index))
                    .collect::<rusqlite::Result<Vec<_>>>()
            })
            .expect("the rows read")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("every row reads")
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
        let database = TestDatabase::new();
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
        let pool = Arc::new(DatabaseReadPool::new(
            database.path(),
            PROJECTION_REBUILD_STATEMENT_CAPACITY + SESSION_SERVICE_STATEMENT_CAPACITY,
        ));
        let reads_whole: Arc<DamagedFromSequenceReader> =
            Arc::new(|_session_id: &SessionId| -> Option<i64> { None });
        let service = ProjectionRebuildService::new(
            Arc::clone(&pool),
            writer,
            Arc::new(SessionService::new(pool, reads_whole)),
            Arc::new(DatabaseDamageWatch::new()),
            vec![Box::new(ApprovalsProjection)],
        );

        service
            .rebuild(
                ProjectionRebuildRequest {
                    session_id,
                    is_forced: true,
                    before_sequence: None,
                    stop: None,
                },
                None,
            )
            .await
            .expect("the session's approvals are rebuilt");

        assert_eq!(approval_rows(&reader), (live_requests, live_resolutions));
        let cursor: (String, i64) = reader
            .query_row(
                "SELECT state, last_sequence FROM projection_cursors WHERE session_id = ?",
                [session_id.text().as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("the session's cursor reads");
        assert_eq!(
            cursor,
            (
                <&str>::from(ProjectionCursorState::Current).to_owned(),
                head_sequence
            )
        );
    }
}
