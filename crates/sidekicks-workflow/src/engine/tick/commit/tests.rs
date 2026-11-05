use std::sync::Arc;

use rstest::rstest;
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::workflow::definition::document::{
    WorkflowDefinitionId, WorkflowNode, WorkflowNodeId, WorkflowVersionId,
};
use sidekicks_contracts::workflow::kind::WorkflowNodeKindSpec;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::status::{WorkflowRunStatus, WorkflowStepStatus};
use sidekicks_contracts::workflow::run::step::events::{
    WorkflowReadiedStep, WorkflowStepSkipReason,
};
use sidekicks_contracts::workflow::run::step::record::{
    WorkflowPayloadRef, WorkflowStepKey, WorkflowStepSource,
};
use sidekicks_store::database::writer::DatabaseWriter;
use sidekicks_store::database::writer::test_file::TestDatabase;
use sidekicks_store::events::log_service::test_fixture::{TestLog, open_log};
use sidekicks_store::events::session::appender::{SessionEventAppender, SessionEventEmitError};
use sidekicks_store::events::session::version::SESSION_EVENT_VERSION;

use super::{ReportedStep, RunTurnCommit, RunTurnCommitted, SettlementAnswer};
use crate::engine::event_record::{EngineRecorder, RunEngineRecord};
use crate::engine::ports::kept_payloads::KeptPayloads;
use crate::engine::ports::{EngineRecordSink, KeptEngineRecords, StepPayloadArtifacts};
use crate::engine::tick::walk::{WalkReady, WalkSkip};
use crate::engine::tick::{StepReport, StepReportKind, StepSettlement};
use crate::runs::gate_resolution::RunEventKeys;
use crate::secrets::redaction::RunRedaction;
use crate::test_rows::{
    TEST_NODE_ID, TEST_SESSION_ID, TestStep, insert_run, insert_step, insert_workflow_version,
};

pub(super) const DEFINITION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e80";
const VERSION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e81";
const RUN_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e82";
const RUN_STARTED_AT: &str = "2026-10-02T00:00:00.000Z";

/// A running run's turn written through the test's event log, with the run's rows beside it and
/// the payload store its turns write through.
pub(super) struct TurnHarness {
    pub(super) database: TestDatabase,
    pub(super) appender: SessionEventAppender,
    pub(super) writer: Arc<DatabaseWriter>,
    pub(super) record: RunEngineRecord,
    pub(super) rows: Connection,
    pub(super) payloads: Arc<KeptPayloads>,
    /// The node every step of the harness runs, of the kind `spec`.
    pub(super) node: WorkflowNode,
    /// A kind with one main input and one main output.
    pub(super) spec: WorkflowNodeKindSpec,
}

impl TurnHarness {
    pub(super) async fn new() -> Self {
        let database = TestDatabase::new(crate::schema::schema_parts());
        let TestLog {
            service, writer, ..
        } = open_log(&database, None).await;
        let appender = SessionEventAppender::new(service, SESSION_EVENT_VERSION.clone());
        let records = Arc::new(KeptEngineRecords::default());
        let record = EngineRecorder::new(records as Arc<dyn EngineRecordSink>)
            .for_run(run_id(), Arc::new(RunRedaction::new(&[])));
        let rows = database.reader();
        insert_workflow_version(&rows, DEFINITION_ID, VERSION_ID, "Review");
        insert_run(
            &rows,
            RUN_ID,
            VERSION_ID,
            WorkflowRunStatus::Running,
            RUN_STARTED_AT,
            None,
        );
        Self {
            database,
            appender,
            writer,
            record,
            rows,
            payloads: Arc::new(KeptPayloads::default()),
            node: test_node(),
            spec: test_spec(),
        }
    }

    /// An empty turn of the harness's run, writing through its payload store.
    pub(super) fn commit(&self) -> RunTurnCommit {
        RunTurnCommit::new(
            RunEventKeys {
                session_id: SessionId::new(TEST_SESSION_ID).expect("the test's session id"),
                definition_id: WorkflowDefinitionId::new(DEFINITION_ID)
                    .expect("the test's definition id"),
                workflow_version_id: WorkflowVersionId::new(VERSION_ID)
                    .expect("the test's version id"),
            },
            Arc::clone(&self.payloads) as Arc<dyn StepPayloadArtifacts>,
        )
    }

    /// The harness's node as the tick knows a step of it, readied by `readying_sequence`, its
    /// hold last reported at `last_hold_report_at`, with no input.
    pub(super) fn reported<'tick>(
        &'tick self,
        readying_sequence: SafeInt<0>,
        last_hold_report_at: Option<&'tick WireInstant>,
    ) -> ReportedStep<'tick> {
        ReportedStep {
            readying_sequence,
            last_hold_report_at,
            node: &self.node,
            spec: &self.spec,
            inputs: &[],
        }
    }

    pub(super) async fn append(&self, commit: RunTurnCommit) -> RunTurnCommitted {
        commit
            .append(&self.appender, &self.record)
            .await
            .expect("the turn's write commits")
    }

    /// The test node's step at `execution_index`, stored at `status`.
    pub(super) fn store_step(
        &self,
        execution_index: u32,
        status: WorkflowStepStatus,
    ) -> WorkflowStepKey {
        insert_step(
            &self.rows,
            RUN_ID,
            &TestStep {
                execution_index,
                status,
                wait_cause: None,
                wait_account_id: None,
                resume_at: None,
            },
        );
        step_key(TEST_NODE_ID, execution_index)
    }

    /// The status and pool wait of the step at `execution_index`.
    pub(super) fn step_row(&self, execution_index: u32) -> (String, i64) {
        self.rows
            .query_row(
                "SELECT status, total_pool_wait_ms FROM workflow_steps WHERE execution_index = ?1",
                params![execution_index],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("the step's row reads")
    }

    /// Every stored event's sequence, type, instant and payload, in sequence order.
    pub(super) fn events(&self) -> Vec<(i64, String, String, Value)> {
        let reader = self.database.reader();
        let mut statement = reader
            .prepare(
                "SELECT sequence, type, occurred_at, payload FROM session_events \
                 ORDER BY sequence",
            )
            .expect("the test reads the events");
        statement
            .query_map([], |row| {
                let payload: String = row.get(3)?;
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    serde_json::from_str(&payload).expect("a stored payload is JSON"),
                ))
            })
            .expect("the test reads the events")
            .collect::<Result<_, _>>()
            .expect("each event reads")
    }
}

/// The test node, of the test kind, with no retry or `onError`.
pub(super) fn test_node() -> WorkflowNode {
    serde_json::from_value(json!({
        "id": TEST_NODE_ID, "kind": "test.step", "kindVersion": 1, "name": "Step", "order": 0,
        "params": {},
    }))
    .expect("the test's node reads")
}

/// A kind with one main input and one main output.
pub(super) fn test_spec() -> WorkflowNodeKindSpec {
    serde_json::from_value(json!({
        "kind": "test.step", "version": 1, "category": "developer",
        "displayName": "Test", "description": "A test kind.", "icon": "test",
        "params": [], "outputsDeriveFromParams": false,
        "inputs": [{ "type": "main", "id": "inputs/main/0", "label": "In" }],
        "outputs": [{ "type": "main", "id": "outputs/main/0", "label": "Out" }],
    }))
    .expect("the test's spec reads")
}

pub(super) fn run_id() -> WorkflowRunId {
    WorkflowRunId::new(RUN_ID).expect("the test's run id")
}

pub(super) fn step_key(node_id: &str, execution_index: u32) -> WorkflowStepKey {
    WorkflowStepKey {
        workflow_run_id: run_id(),
        node_id: WorkflowNodeId::new(node_id.to_owned()).expect("the test's node id"),
        attempt: SafeInt::new(1).expect("a first attempt"),
        execution_index: SafeInt::new(u64::from(execution_index)).expect("an execution index"),
    }
}

pub(super) fn instant(text: &str) -> WireInstant {
    WireInstant::try_from(text.to_owned()).expect("the test's instant")
}

pub(super) fn sequence(value: u64) -> SafeInt<0> {
    SafeInt::new(value).expect("a sequence")
}

pub(super) fn report(step: &WorkflowStepKey, at: &str, kind: StepReportKind) -> StepReport {
    StepReport {
        step: step.clone(),
        at: instant(at),
        kind,
    }
}

pub(super) fn empty_payload() -> WorkflowPayloadRef {
    WorkflowPayloadRef::Inline { items: Vec::new() }
}

fn artifact_id() -> ArtifactId {
    ArtifactId::try_from(mint_uuid_v7()).expect("a minted UUID is an artifact id")
}

fn artifact_payload(artifact_id: ArtifactId) -> WorkflowPayloadRef {
    WorkflowPayloadRef::Artifact {
        artifact_id,
        size_bytes: SafeInt::new(70_000).expect("a size"),
        item_count: SafeInt::new(3).expect("a count"),
    }
}

// Killed by a repeat re-entering the hold, a repeat adding nothing, the admission adding the whole
// hold again, and a hold report naming its own sequence rather than the readying one.
#[tokio::test]
async fn a_held_step_records_one_hold_and_its_pool_wait() {
    let harness = TurnHarness::new().await;
    let step = harness.store_step(1, WorkflowStepStatus::Pending);
    let readying = sequence(7);
    let t0 = "2026-10-02T00:01:00.000Z";
    let t30 = "2026-10-02T00:01:30.000Z";
    let t45 = "2026-10-02T00:01:45.000Z";
    let held = || StepReportKind::WaitingOnPool {
        hold_started_at: instant(t0),
    };

    let mut first = harness.commit();
    let answer = first
        .report(report(&step, t0, held()), harness.reported(readying, None))
        .await
        .expect("a hold writes no payload");
    assert!(answer.is_none());
    harness.append(first).await;
    assert_eq!(harness.step_row(1), ("waitingMemory".to_owned(), 0));

    let mut repeat = harness.commit();
    let t0_instant = instant(t0);
    repeat
        .report(
            report(&step, t30, held()),
            harness.reported(readying, Some(&t0_instant)),
        )
        .await
        .expect("a hold writes no payload");
    harness.append(repeat).await;
    assert_eq!(harness.step_row(1), ("waitingMemory".to_owned(), 30_000));

    let mut admitted = harness.commit();
    let t30_instant = instant(t30);
    admitted
        .report(
            report(
                &step,
                t45,
                StepReportKind::Admitted {
                    hold_started_at: Some(instant(t0)),
                },
            ),
            harness.reported(readying, Some(&t30_instant)),
        )
        .await
        .expect("an admission writes no payload");
    harness.append(admitted).await;
    assert_eq!(harness.step_row(1), ("running".to_owned(), 45_000));

    let events = harness.events();
    let held_events: Vec<_> = events
        .iter()
        .filter(|(_, event_type, _, _)| event_type == "workflow.phase.waitingOnPool")
        .map(|(_, _, at, payload)| (at.as_str(), payload["waitingSinceSeq"].clone()))
        .collect();
    assert_eq!(held_events, [(t0, json!(7)), (t30, json!(7))]);
}

// Killed by one append per report, a pending row written outside its readying event's write,
// sequences counted from the front, and a failed write that drops the turn's artifacts.
#[tokio::test]
async fn a_turn_is_one_write_in_report_order() {
    let harness = TurnHarness::new().await;
    let step = harness.store_step(1, WorkflowStepStatus::Pending);
    let source = Some(WorkflowStepSource {
        node_id: step.node_id.clone(),
        output_index: SafeInt::ZERO,
        execution_index: step.execution_index,
    });
    let skip = WalkSkip {
        step: step_key("skipped", 2),
        run_index: 0,
        reason: WorkflowStepSkipReason::Disabled,
        sources: vec![source],
        output_lengths: vec![0],
    };
    let ready = WalkReady {
        step: step_key("next", 3),
        run_index: 0,
        sources: vec![Some(WorkflowStepSource {
            node_id: skip.step.node_id.clone(),
            output_index: SafeInt::ZERO,
            execution_index: skip.step.execution_index,
        })],
    };
    let ready_input = artifact_payload(artifact_id());
    let (t1, t2, t3, t4) = (
        "2026-10-02T00:02:01.000Z",
        "2026-10-02T00:02:02.000Z",
        "2026-10-02T00:02:03.000Z",
        "2026-10-02T00:02:04.000Z",
    );

    let mut commit = harness.commit();
    let unheld = StepReportKind::Admitted {
        hold_started_at: None,
    };
    let started = StepReportKind::Started {
        input_ref: empty_payload(),
        permission_level: None,
    };
    for (at, kind) in [
        (t1, unheld),
        (t2, started),
        (t3, StepReportKind::Progressed),
    ] {
        commit
            .report(report(&step, at, kind), harness.reported(sequence(0), None))
            .await
            .expect("a report before the end writes no payload");
    }
    let skip_event = commit.skipped(&skip, &empty_payload(), &empty_payload(), instant(t4));
    commit.readied(&ready, ready_input.clone(), skip_event);
    let committed = harness.append(commit).await;

    assert_eq!(
        committed,
        RunTurnCommitted {
            event_sequences: (0..5).map(sequence).collect(),
            readied: vec![(ready.step.clone(), sequence(4))],
        }
    );
    let events = harness.events();
    let written: Vec<_> = events
        .iter()
        .map(|(sequence, event_type, at, _)| (*sequence, event_type.as_str(), at.as_str()))
        .collect();
    assert_eq!(
        written,
        [
            (0, "workflow.phase.admitted", t1),
            (1, "workflow.phase.started", t2),
            (2, "workflow.step.started", t2),
            (3, "workflow.phase.progressed", t3),
            (4, "workflow.step.skipped", t4),
        ]
    );
    let readied = WorkflowReadiedStep {
        node_id: ready.step.node_id.clone(),
        attempt: ready.step.attempt,
        execution_index: ready.step.execution_index,
        sources: ready.sources.clone(),
        input_ref: ready_input,
    };
    assert_eq!(
        events[4].3["readied"],
        json!([serde_json::to_value(&readied).expect("a readied step writes")])
    );
    let ready_row: (String, String) = harness
        .rows
        .query_row(
            "SELECT status, started_at FROM workflow_steps WHERE execution_index = 3",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("the readied step's row reads");
    assert_eq!(ready_row, ("pending".to_owned(), t4.to_owned()));

    let again = WalkSkip {
        step: step_key("skipped", 4),
        ..skip
    };
    let refused_artifact = artifact_id();
    let mut refused = harness.commit();
    let skip_event = refused.skipped(&again, &empty_payload(), &empty_payload(), instant(t4));
    refused.readied(&ready, artifact_payload(refused_artifact), skip_event);
    let failure = refused
        .append(&harness.appender, &harness.record)
        .await
        .expect_err("a second row for one step refuses the write");
    assert!(
        matches!(failure.error, SessionEventEmitError::Append(_)),
        "{:?}",
        failure.error
    );
    assert_eq!(failure.artifact_ids, [refused_artifact]);
    assert_eq!(harness.events().len(), 5);
    let skipped_rows: i64 = harness
        .rows
        .query_row(
            "SELECT count(*) FROM workflow_steps WHERE execution_index = 4",
            [],
            |row| row.get(0),
        )
        .expect("the test counts the rows");
    assert_eq!(skipped_rows, 0);
}

// Killed by a sibling-failure marker on a step a merge canceled, and by a cancel that drops the
// hold it cut.
#[rstest]
#[case::held_by_a_sibling_failure(
    WorkflowStepStatus::WaitingMemory,
    Some("2026-10-02T00:03:00.000Z"),
    true,
    &["workflow.phase.failed", "workflow.step.canceled"],
    10_000
)]
#[case::running_and_canceled_by_a_merge(
    WorkflowStepStatus::Running,
    None,
    false,
    &["workflow.step.canceled"],
    0
)]
#[tokio::test]
async fn a_canceled_held_step_adds_its_cut_hold(
    #[case] status: WorkflowStepStatus,
    #[case] hold_started_at: Option<&str>,
    #[case] is_sibling_failure: bool,
    #[case] event_types: &[&str],
    #[case] pool_wait_ms: i64,
) {
    let harness = TurnHarness::new().await;
    let step = harness.store_step(1, status);
    let canceled = StepReportKind::Settled(StepSettlement::Canceled {
        hold_started_at: hold_started_at.map(instant),
        is_sibling_failure,
    });
    let mut commit = harness.commit();
    let answer = commit
        .report(
            report(&step, "2026-10-02T00:03:10.000Z", canceled),
            harness.reported(sequence(0), None),
        )
        .await
        .expect("a cancel writes no payload");
    assert!(matches!(answer, Some(SettlementAnswer::Canceled)));
    harness.append(commit).await;

    assert_eq!(harness.step_row(1), ("canceled".to_owned(), pool_wait_ms));
    let events = harness.events();
    let written: Vec<_> = events
        .iter()
        .map(|(_, event_type, _, _)| event_type.as_str())
        .collect();
    assert_eq!(written, event_types);
    if is_sibling_failure {
        assert_eq!(events[0].3["cancellationReason"], json!("siblingFailure"));
    }
}
