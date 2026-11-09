use std::collections::BTreeMap;
use std::sync::Arc;

use rstest::rstest;
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_contracts::workflow::definition::document::{
    WorkflowContentHash, WorkflowDefinitionId, WorkflowNode, WorkflowNodeId, WorkflowVersionId,
};
use sidekicks_contracts::workflow::kind::WorkflowNodeKindSpec;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::snapshot::WorkflowRunEpoch;
use sidekicks_contracts::workflow::run::status::{
    WorkflowRunStatus, WorkflowStepStatus, WorkflowWaitCause,
};
use sidekicks_contracts::workflow::run::step::events::{
    WorkflowPhaseCancellationReason, WorkflowReadiedStep, WorkflowReusedStep,
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
use crate::engine::tick::run_status::{RunPersonWait, RunStepCounts};
use crate::engine::tick::walk::{ReusedStepRecord, WalkReady, WalkSkip, WalkSkipReason};
use crate::engine::tick::{StepReport, StepReportKind, StepSettlement};
use crate::kinds::step_context::StepRunVariable;
use crate::runs::gate_resolution::RunEventKeys;
use crate::secrets::redaction::RunRedaction;
use crate::test_rows::{
    TEST_NODE_ID, TEST_SESSION_ID, TestStep, insert_run, insert_step, insert_workflow_version,
};

pub(super) const DEFINITION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e80";
pub(super) const VERSION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e81";
const RUN_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e82";
const EARLIER_RUN_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e83";
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

    /// An empty turn of the harness's run with two steps running, so a turn that settles one
    /// leaves the run running, writing through its payload store.
    pub(super) fn commit(&self) -> RunTurnCommit {
        self.commit_with(
            RunStepCounts {
                has_admitted_step: true,
                running: 2,
                ..RunStepCounts::default()
            },
            RunPersonWait::default(),
        )
    }

    /// An empty turn of the harness's run with `counts` and `person_wait`, writing through its
    /// payload store.
    pub(super) fn commit_with(
        &self,
        counts: RunStepCounts,
        person_wait: RunPersonWait,
    ) -> RunTurnCommit {
        RunTurnCommit::new(
            RunEventKeys {
                session_id: SessionId::new(TEST_SESSION_ID).expect("the test's session id"),
                definition_id: WorkflowDefinitionId::new(DEFINITION_ID)
                    .expect("the test's definition id"),
                workflow_version_id: WorkflowVersionId::new(VERSION_ID)
                    .expect("the test's version id"),
            },
            run_id(),
            WorkflowRunEpoch(SafeInt::ZERO),
            counts,
            person_wait,
            Arc::clone(&self.payloads) as Arc<dyn StepPayloadArtifacts>,
        )
    }

    /// The harness's node as the tick knows a running step of it, readied by
    /// `readying_sequence`, its hold last reported at `last_hold_report_at`, with no input.
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
            status: WorkflowStepStatus::Running,
            wait_cause: None,
        }
    }

    /// The harness's node as the tick knows a step of it waiting on `cause`, with no input.
    pub(super) fn reported_waiting(&self, cause: WorkflowWaitCause) -> ReportedStep<'_> {
        ReportedStep {
            status: WorkflowStepStatus::Waiting,
            wait_cause: Some(cause),
            ..self.reported(sequence(0), None)
        }
    }

    /// Commits `commit` with no step left live beside what it readied.
    pub(super) async fn append(&self, commit: RunTurnCommit) -> RunTurnCommitted {
        commit
            .append(&self.appender, &self.record, [])
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

/// A started step records the hash of the pin it gave on its row and as `pinHash` on its
/// `workflow.step.started`, and a step that gave no pin records neither. Mutation: drop `pin_hash`
/// from `record_step_start`'s statement.
#[rstest]
#[case::pinned(Some("b3:pin"))]
#[case::unpinned(None)]
#[tokio::test]
async fn a_started_step_records_the_hash_of_its_pin(#[case] pin_hash: Option<&str>) {
    let harness = TurnHarness::new().await;
    let step = harness.store_step(1, WorkflowStepStatus::Running);
    let started = StepReportKind::Started {
        input_ref: empty_payload(),
        permission_level: None,
        pin_hash: pin_hash.map(|hash| {
            WorkflowContentHash(NonEmptyText::new(hash.to_owned()).expect("the test's hash"))
        }),
    };

    let mut commit = harness.commit();
    commit
        .report(
            report(&step, "2026-10-02T00:03:00.000Z", started),
            harness.reported(sequence(0), None),
        )
        .await
        .expect("a start writes no payload");
    harness.append(commit).await;

    let row_hash: Option<String> = harness
        .rows
        .query_row(
            "SELECT pin_hash FROM workflow_steps WHERE execution_index = 1",
            [],
            |row| row.get(0),
        )
        .expect("the step's row reads");
    assert_eq!(row_hash.as_deref(), pin_hash);
    let events = harness.events();
    let (_, _, _, started_payload) = events
        .iter()
        .find(|(_, event_type, _, _)| event_type == "workflow.step.started")
        .expect("the start is recorded");
    assert_eq!(
        started_payload.get("pinHash").and_then(Value::as_str),
        pin_hash
    );
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
        reason: WalkSkipReason::Disabled,
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
        pin_hash: None,
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
            counts: RunStepCounts {
                has_admitted_step: true,
                running: 2,
                pending: 1,
                ..RunStepCounts::default()
            },
            person_wait: RunPersonWait::default(),
            dropped_kept_artifact_ids: Vec::new(),
            ending_event_id: None,
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
        .append(&harness.appender, &harness.record, [])
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

/// A reused skip records the step it reused and that step's pin hash on its row and event and
/// passes the reused output on, and a refused write of it answers its own input's artifact but
/// never the reused output's, which the earlier run's record names. Mutations: drop
/// `reused_from_json` from `insert_skipped_step`'s statement; keep the reused output's artifact
/// among the turn's.
#[tokio::test]
async fn a_reused_skip_names_its_source_and_never_drops_its_output() {
    let harness = TurnHarness::new().await;
    let from = WorkflowReusedStep {
        step: WorkflowStepKey {
            workflow_run_id: WorkflowRunId::new(EARLIER_RUN_ID).expect("the earlier run's id"),
            ..step_key(TEST_NODE_ID, 2)
        },
        workflow_version_id: WorkflowVersionId::new(VERSION_ID).expect("the test's version id"),
    };
    let reused_output = artifact_payload(artifact_id());
    let pin_hash = WorkflowContentHash(NonEmptyText::new("b3:pin".to_owned()).expect("a hash"));
    let skip = WalkSkip {
        step: step_key(TEST_NODE_ID, 1),
        run_index: 0,
        reason: WalkSkipReason::Reused(ReusedStepRecord {
            from: from.clone(),
            output_ref: reused_output.clone(),
            pin_hash: Some(pin_hash),
        }),
        sources: vec![None],
        output_lengths: vec![3],
    };
    let input_artifact = artifact_id();
    let input_ref = artifact_payload(input_artifact);
    let at = instant("2026-10-02T00:04:00.000Z");

    let mut commit = harness.commit();
    commit.skipped(&skip, &input_ref, &reused_output, at.clone());
    harness.append(commit).await;

    let from_wire = serde_json::to_value(&from).expect("a reused step writes");
    let row: (String, Option<String>) = harness
        .rows
        .query_row(
            "SELECT reused_from_json, pin_hash FROM workflow_steps WHERE execution_index = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("the skipped step's row reads");
    let row_from: Value = serde_json::from_str(&row.0).expect("the stored reused step is JSON");
    assert_eq!(
        (row_from, row.1.as_deref()),
        (from_wire.clone(), Some("b3:pin"))
    );
    let events = harness.events();
    let (_, _, _, skipped_payload) = events
        .iter()
        .find(|(_, event_type, _, _)| event_type == "workflow.step.skipped")
        .expect("the skip is recorded");
    assert_eq!(skipped_payload["reusedFrom"], from_wire);
    assert_eq!(skipped_payload["pinHash"], json!("b3:pin"));
    assert_eq!(
        skipped_payload["outputRef"],
        serde_json::to_value(&reused_output).expect("a payload ref writes")
    );

    let mut refused = harness.commit();
    refused.skipped(&skip, &input_ref, &reused_output, at);
    let failure = refused
        .append(&harness.appender, &harness.record, [])
        .await
        .expect_err("a second row for one step refuses the write");
    assert_eq!(failure.artifact_ids, [input_artifact]);
}

// Killed by a sibling-failure marker on a step a merge canceled, and by a cancel that drops the
// hold it cut.
#[rstest]
#[case::held_by_a_sibling_failure(
    WorkflowStepStatus::WaitingMemory,
    Some("2026-10-02T00:03:00.000Z"),
    Some(WorkflowPhaseCancellationReason::SiblingFailure),
    &["workflow.phase.failed", "workflow.step.canceled"],
    10_000
)]
#[case::running_and_canceled_by_a_merge(
    WorkflowStepStatus::Running,
    None,
    None,
    &["workflow.step.canceled"],
    0
)]
#[tokio::test]
async fn a_canceled_held_step_adds_its_cut_hold(
    #[case] status: WorkflowStepStatus,
    #[case] hold_started_at: Option<&str>,
    #[case] cancellation_reason: Option<WorkflowPhaseCancellationReason>,
    #[case] event_types: &[&str],
    #[case] pool_wait_ms: i64,
) {
    let harness = TurnHarness::new().await;
    let step = harness.store_step(1, status);
    let canceled = StepReportKind::Settled(StepSettlement::Canceled {
        hold_started_at: hold_started_at.map(instant),
        cancellation_reason,
    });
    let mut commit = harness.commit();
    let answer = commit
        .report(
            report(&step, "2026-10-02T00:03:10.000Z", canceled),
            harness.reported(sequence(0), None),
        )
        .await
        .expect("a cancel writes no payload");
    let readying_event = usize::from(cancellation_reason.is_some());
    assert!(matches!(
        answer,
        Some(SettlementAnswer::Canceled { readying_event: index }) if index == readying_event
    ));
    harness.append(commit).await;

    assert_eq!(harness.step_row(1), ("canceled".to_owned(), pool_wait_ms));
    let events = harness.events();
    let written: Vec<_> = events
        .iter()
        .map(|(_, event_type, _, _)| event_type.as_str())
        .collect();
    assert_eq!(written, event_types);
    if cancellation_reason.is_some() {
        assert_eq!(events[0].3["cancellationReason"], json!("siblingFailure"));
    }
}

/// How a turn that replaces a kept value is written.
#[derive(Clone, Copy, PartialEq, Eq)]
enum KeptWrite {
    /// Alone, and committed.
    Alone,
    /// Alone, and refused.
    Refused,
    /// Committed beside an earlier turn of the session whose statements come first.
    Joined,
}

/// A step that keeps a value above the cap under a name holding an artifact answers that artifact
/// once its write commits, alone or beside another turn; a refused write answers it nowhere, not
/// even among the failure's artifacts, which the tick deletes, and neither deletes it. Mutations:
/// the replaced artifact removed before the commit; the read's index not kept on the turn, or
/// read off the wrong result; a joined turn's reads dropped or read from its session's first
/// statement; the replaced artifact handed to the failed write's cleanup.
#[rstest]
#[case::committed(KeptWrite::Alone)]
#[case::refused(KeptWrite::Refused)]
#[case::joined(KeptWrite::Joined)]
#[tokio::test]
async fn a_replaced_kept_artifact_is_answered_once_its_write_commits(#[case] write: KeptWrite) {
    let is_refused = write == KeptWrite::Refused;
    let harness = TurnHarness::new().await;
    // A step with no row refuses the write that settles it.
    let step = if is_refused {
        step_key(TEST_NODE_ID, 1)
    } else {
        harness.store_step(1, WorkflowStepStatus::Running)
    };
    let replaced = artifact_id();
    harness
        .rows
        .execute(
            "INSERT INTO workflow_node_state
               (definition_id, node_id, key, value_json, artifact_id, kept_by_run_id, updated_at)
             VALUES (?1, '', 'report', ?2, ?3, ?4, ?5)",
            params![
                DEFINITION_ID,
                serde_json::to_string(&artifact_payload(replaced))
                    .expect("a payload ref writes as JSON"),
                replaced.to_string(),
                RUN_ID,
                RUN_STARTED_AT,
            ],
        )
        .expect("the test keeps a value");
    let completed = StepReportKind::Settled(StepSettlement::Completed {
        outputs: vec![Vec::new()],
        cost: None,
        log_lines: Vec::new(),
        run_variables: BTreeMap::from([(
            "report".to_owned(),
            StepRunVariable {
                value: json!("y".repeat(70 * 1024)),
                is_kept: true,
            },
        )]),
    });
    let mut commit = harness.commit();
    commit
        .report(
            report(&step, "2026-10-02T00:05:00.000Z", completed),
            harness.reported(sequence(0), None),
        )
        .await
        .expect("the kept value's artifact writes");
    let kept: Vec<ArtifactId> = harness
        .payloads
        .writes()
        .iter()
        .map(|write| write.artifact_id)
        .collect();
    assert_eq!(kept.len(), 1, "only the kept value is above the cap");

    let written = if write == KeptWrite::Joined {
        let mut before = harness.commit();
        let skip = WalkSkip {
            step: step_key("skipped", 2),
            run_index: 0,
            reason: WalkSkipReason::Disabled,
            sources: vec![None],
            output_lengths: vec![0],
        };
        before.skipped(
            &skip,
            &empty_payload(),
            &empty_payload(),
            instant("2026-10-02T00:04:00.000Z"),
        );
        let writes = vec![
            (before, Vec::new(), None),
            (commit, Vec::new(), Some(&harness.record)),
        ];
        RunTurnCommit::append_together(writes, &harness.appender)
            .await
            .map(|mut committed| committed.remove(1))
    } else {
        commit.append(&harness.appender, &harness.record, []).await
    };
    match written {
        Ok(committed) => {
            assert!(!is_refused, "a step with no row refuses the write");
            assert_eq!(committed.dropped_kept_artifact_ids, [replaced]);
        }
        Err(failure) => {
            assert!(is_refused, "{:?}", failure.error);
            assert_eq!(failure.artifact_ids, kept);
        }
    }
    assert_eq!(harness.payloads.deletes(), []);
}
