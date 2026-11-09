//! An answer to a run's gate as its append-only row stores it: the statement that appends the row,
//! numbered per run inside the statement itself, and the `workflow.gate.resolved` event written
//! with it. An approval step's answer names its node; a chain's question names none. The approval
//! card's own answer rides beside it, so the card, the row and the step's resume land in one write.

use std::borrow::Cow;

use sidekicks_contracts::approval::{ApprovalDecision, ApprovalRequestId};
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::record::JsonRecord;
use sidekicks_contracts::workflow::definition::document::{
    WorkflowDefinitionId, WorkflowNodeId, WorkflowVersionId,
};
use sidekicks_contracts::workflow::run::gate_resolution::{
    WorkflowGateApprovalCategory, WorkflowGateKind, WorkflowGateResolutionId,
};
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::step::events::WorkflowGateResolvedPayload;
use sidekicks_store::database::statement::{
    StatementBindings, WriteStatement, nullable_text_binding, text_binding,
};

/// One answer to a gate of a run, as the approval side hands it over: every member of its row but
/// the sequence, which the row's statement counts.
#[derive(Clone, Debug, PartialEq)]
pub struct WorkflowGateAnswer {
    /// The answer's id, its row's and its `workflow.gate.resolved` event's.
    pub gate_resolution_id: WorkflowGateResolutionId,
    /// The run whose gate it answered: the approval step's run, or the chain's first run.
    pub workflow_run_id: WorkflowRunId,
    /// Which kind of gate it answered.
    pub gate: WorkflowGateKind,
    /// The approval step answered; `None` for a chain's question, which the row's check holds.
    pub node_id: Option<WorkflowNodeId>,
    /// The approval request's category, where the request carries one.
    pub approval_category: Option<WorkflowGateApprovalCategory>,
    /// The approval request answered.
    pub approval_request_id: ApprovalRequestId,
    /// The answer.
    pub outcome: ApprovalDecision,
    /// The device that answered.
    pub device_id: DeviceId,
    /// When, in the stored form.
    pub resolved_at: WireInstant,
    /// What the answer was given about: its scope, the resource and the reason text.
    pub decision_context: JsonRecord,
}

/// The approval card's own answer to a gate, written in the step's write ahead of the gate's row:
/// the statements that settle the card, refused unless it is still pending, and its
/// `approval.approved` or `approval.rejected` event.
#[derive(Clone, Debug)]
pub struct ApprovalCardAnswer {
    /// The card's settle and its resolution row.
    pub statements: Vec<WriteStatement>,
    /// The card's answer event.
    pub event: SessionEvent,
}

/// The keys every run event names besides the run: its session, its definition and the version it
/// pins.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the approval side's gate answers and Keep going")
)]
#[expect(
    clippy::struct_field_names,
    reason = "each field keeps the name the run event's member carries"
)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct RunEventKeys {
    /// The session the run lives in.
    pub(crate) session_id: SessionId,
    /// The definition it came from.
    pub(crate) definition_id: WorkflowDefinitionId,
    /// The version it pins.
    pub(crate) workflow_version_id: WorkflowVersionId,
}

// The run's next sequence is counted inside the insert; the one writer runs it alone, and
// `UNIQUE(workflow_run_id, sequence)` refuses a second row at the same place.
const INSERT_GATE_RESOLUTION_SQL: &str = "INSERT INTO workflow_gate_resolutions (
    id, workflow_run_id, sequence, node_id, gate_kind, approval_category, approval_request_id,
    outcome, device_id, resolved_at, decision_context
  ) VALUES (
    @id, @workflow_run_id,
    (SELECT COALESCE(MAX(sequence), 0) + 1 FROM workflow_gate_resolutions
      WHERE workflow_run_id = @workflow_run_id),
    @node_id, @gate_kind, @approval_category, @approval_request_id, @outcome, @device_id,
    @resolved_at, @decision_context
  )";

/// The statement that appends `answer`'s row as its run's next answer, counted from 1; it expects
/// one row, and the row's check refuses an approval answer without its node or a chain's with one.
pub fn gate_resolution_statement(answer: &WorkflowGateAnswer) -> WriteStatement {
    let decision_context =
        serde_json::to_string(&answer.decision_context).expect("a JSON record writes as JSON");
    WriteStatement {
        sql: Cow::Borrowed(INSERT_GATE_RESOLUTION_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@id", answer.gate_resolution_id.text().as_str()),
            text_binding("@workflow_run_id", answer.workflow_run_id.text().as_str()),
            nullable_text_binding(
                "@node_id",
                answer.node_id.as_ref().map(WorkflowNodeId::as_str),
            ),
            text_binding("@gate_kind", <&'static str>::from(answer.gate)),
            nullable_text_binding(
                "@approval_category",
                answer.approval_category.map(<&'static str>::from),
            ),
            text_binding(
                "@approval_request_id",
                answer.approval_request_id.text().as_str(),
            ),
            text_binding("@outcome", <&'static str>::from(answer.outcome)),
            text_binding("@device_id", answer.device_id.as_str()),
            text_binding("@resolved_at", answer.resolved_at.as_str()),
            text_binding("@decision_context", &decision_context),
        ]),
        expected_row_count: Some(1),
    }
}

/// The `workflow.gate.resolved` event of `answer` in the run `keys` names, written in the same
/// write as the answer's row.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the approval side's gate answers and Keep going")
)]
pub(crate) fn gate_resolved_payload(
    answer: &WorkflowGateAnswer,
    keys: RunEventKeys,
) -> WorkflowGateResolvedPayload {
    WorkflowGateResolvedPayload {
        session_id: keys.session_id,
        workflow_run_id: answer.workflow_run_id,
        definition_id: keys.definition_id,
        workflow_version_id: keys.workflow_version_id,
        node_id: answer.node_id.clone(),
        outcome: answer.outcome,
        gate_resolution_id: answer.gate_resolution_id,
        device_id: answer.device_id.clone(),
    }
}

/// The gate answers' tests, and the answer other modules' tests write.
#[cfg(test)]
pub(crate) mod tests {
    use rusqlite::Connection;
    use sidekicks_contracts::approval::events::ApprovalResolvedPayload;
    use sidekicks_contracts::approval::holder::ApprovalHolder;
    use sidekicks_contracts::approval::{
        ApprovalCategory, ApprovalDecision, ApprovalRequestId, ApprovalScope,
    };
    use sidekicks_contracts::event::session::SessionEvent;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::trust_statement::DeviceId;
    use sidekicks_contracts::wire::id::{ClientUuid, UuidTextForm, mint_uuid_v7};
    use sidekicks_contracts::wire::instant::WireInstant;
    use sidekicks_contracts::wire::record::JsonRecord;
    use sidekicks_contracts::workflow::definition::document::WorkflowNodeId;
    use sidekicks_contracts::workflow::run::gate_resolution::{
        WorkflowGateApprovalCategory, WorkflowGateKind, WorkflowGateResolutionId,
    };
    use sidekicks_contracts::workflow::run::id::WorkflowRunId;
    use sidekicks_contracts::workflow::run::status::WorkflowRunStatus;
    use sidekicks_store::database::writer::test_file::TestDatabase;
    use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions};

    use super::{ApprovalCardAnswer, WorkflowGateAnswer, gate_resolution_statement};
    use crate::schema::schema_parts;
    use crate::test_rows::{TEST_NODE_ID, insert_run, insert_workflow_version};

    const DEFINITION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e70";
    const VERSION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e71";
    const RUN_R: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e72";
    const RUN_S: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e73";

    /// An answer `outcome` to `gate` in run `run_id` from the test device, its id ending in
    /// `id_suffix`; an approval answer names the test node and a chain's names none.
    pub(crate) fn gate_answer(
        run_id: &str,
        id_suffix: u8,
        gate: WorkflowGateKind,
        outcome: ApprovalDecision,
    ) -> WorkflowGateAnswer {
        let node_id = match gate {
            WorkflowGateKind::HumanApproval => {
                Some(WorkflowNodeId::new(TEST_NODE_ID.to_owned()).expect("the test's node id"))
            }
            WorkflowGateKind::Chain => None,
        };
        WorkflowGateAnswer {
            gate_resolution_id: WorkflowGateResolutionId::new(&format!(
                "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4f{id_suffix:02x}"
            ))
            .expect("the test's answer id"),
            workflow_run_id: WorkflowRunId::new(run_id).expect("the test's run id"),
            gate,
            node_id,
            approval_category: Some(WorkflowGateApprovalCategory::Gate),
            approval_request_id: ApprovalRequestId::new(&format!(
                "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e{id_suffix:02x}"
            ))
            .expect("the test's approval request id"),
            outcome,
            device_id: DeviceId::new("test-device".to_owned()).expect("the test's device id"),
            resolved_at: WireInstant::try_from("2026-10-02T00:05:00.000Z".to_owned())
                .expect("an instant"),
            decision_context: JsonRecord::default(),
        }
    }

    /// `gate` beside its approval card's answer in the session `session_id`: the card's
    /// `approval.approved` or `approval.rejected` event, held by a workflow wait, and no statement,
    /// since the approval tables are not the workflow's.
    pub(crate) fn with_card_answer(
        gate: WorkflowGateAnswer,
        session_id: SessionId,
    ) -> (WorkflowGateAnswer, ApprovalCardAnswer) {
        let scope = ApprovalScope::new(session_id.text().as_str().to_owned())
            .expect("a session id is a scope");
        let payload = ApprovalResolvedPayload {
            session_id,
            holder: ApprovalHolder::Wait {
                workflow_run_id: gate.workflow_run_id,
                wait_id: UuidTextForm::from(mint_uuid_v7()),
                node_id: gate.node_id.clone(),
            },
            approval_request_id: gate.approval_request_id,
            category: ApprovalCategory::Gate,
            scope: scope.clone(),
            effective_scope: scope,
            device_id: gate.device_id.clone(),
            client_resolution_id: ClientUuid::new(mint_uuid_v7().to_string())
                .expect("a minted UUID is a client's"),
            remembered_scope: None,
            decline_reason: None,
            edited_action: None,
        };
        let event = match gate.outcome {
            ApprovalDecision::Approved => SessionEvent::ApprovalApproved(payload),
            ApprovalDecision::Rejected => SessionEvent::ApprovalRejected(payload),
        };
        let card = ApprovalCardAnswer {
            statements: Vec::new(),
            event,
        };
        (gate, card)
    }

    // Each stored answer's run and sequence, in the order the rows were written.
    fn sequences(connection: &Connection) -> Vec<(String, i64)> {
        connection
            .prepare(
                "SELECT workflow_run_id, sequence FROM workflow_gate_resolutions ORDER BY rowid",
            )
            .expect("the test reads the answers")
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .expect("the test reads the answers")
            .collect::<rusqlite::Result<_>>()
            .expect("the answers read")
    }

    /// Mutation: count the sequence across every run, or bind it from the answer, so S's first
    /// answer takes 3 or two answers in R share one place.
    #[tokio::test]
    async fn gate_answers_are_numbered_per_run() {
        let database = TestDatabase::new(schema_parts());
        let writer = DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
            .await
            .expect("the writer opens the test database");
        let rows = database.reader();
        insert_workflow_version(&rows, DEFINITION_ID, VERSION_ID, "Review");
        for run_id in [RUN_R, RUN_S] {
            insert_run(
                &rows,
                run_id,
                VERSION_ID,
                WorkflowRunStatus::Waiting,
                "2026-10-02T00:00:00.000Z",
                None,
            );
        }

        let answers = [
            gate_answer(
                RUN_R,
                1,
                WorkflowGateKind::HumanApproval,
                ApprovalDecision::Approved,
            ),
            gate_answer(
                RUN_R,
                2,
                WorkflowGateKind::Chain,
                ApprovalDecision::Rejected,
            ),
            gate_answer(
                RUN_S,
                3,
                WorkflowGateKind::HumanApproval,
                ApprovalDecision::Rejected,
            ),
        ];
        for answer in &answers {
            writer
                .write(vec![gate_resolution_statement(answer)])
                .await
                .expect("an answer's row is appended");
        }

        assert_eq!(
            sequences(&rows),
            vec![
                (RUN_R.to_owned(), 1),
                (RUN_R.to_owned(), 2),
                (RUN_S.to_owned(), 1),
            ]
        );
    }
}
