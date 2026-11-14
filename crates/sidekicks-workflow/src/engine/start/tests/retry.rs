//! A retry from a named step: the steps it reuses from its source run, the run it records as
//! retried, and the refusals that make no run.

use rstest::rstest;
use rusqlite::params;
use serde_json::{Value, json};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::workflow::definition::document::WorkflowNodeId;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::status::{WorkflowRunStatus, WorkflowStepStatus};
use sidekicks_contracts::workflow::run::trigger::{WorkflowRunMode, WorkflowStartedBy};

use super::{DEFINITION_ID, Fixture, ROOT_STARTED_AT, TestSession, VERSION_ID, refusal};
use crate::engine::start::retry::WorkflowRunRetry;
use crate::test_rows::{
    TEST_SESSION_ID, TestSettledStep, assert_rebuild_rewrites_session_rows, insert_run,
    insert_settled_step,
};

const SOURCE_RUN_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e80";
const FIRST_RUN_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e81";
const LATER_RUN_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e82";
const UNKNOWN_RUN_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e83";
const FINISHED_AT: &str = "2026-10-02T00:00:05.000Z";
const LATER_FINISHED_AT: &str = "2026-10-03T00:00:05.000Z";

/// The version's body: its trigger `start` feeding `A`, `A` feeding `B` and `D`, and `B` feeding
/// `C`.
fn chain_body() -> Value {
    let node = |id: &str, order: u32| {
        json!({
            "id": id, "kind": "human.approval", "kindVersion": 1, "name": id, "order": order,
            "params": {}
        })
    };
    let edge = |source: &str, target: &str| {
        json!({
            "id": format!("{source}-{target}"),
            "source": source, "sourceHandle": "outputs/main/0",
            "target": target, "targetHandle": "inputs/main/0",
        })
    };
    json!({
        "name": "Nightly",
        "trigger": {
            "id": "start", "kind": "trigger.manual", "kindVersion": 1, "name": "Start",
            "order": 0, "params": {}
        },
        "nodes": [node("A", 1), node("B", 2), node("C", 3), node("D", 4)],
        "edges": [edge("start", "A"), edge("A", "B"), edge("B", "C"), edge("A", "D")],
    })
}

/// Stores run `run_id` at `status`, started by hand on the trigger `start`, ended where it is
/// not going.
fn store_run(fixture: &Fixture, run_id: &str, status: WorkflowRunStatus) {
    let is_going = matches!(
        status,
        WorkflowRunStatus::New | WorkflowRunStatus::Running | WorkflowRunStatus::Waiting
    );
    insert_run(
        &fixture.rows,
        run_id,
        VERSION_ID,
        status,
        ROOT_STARTED_AT,
        (!is_going).then_some(ROOT_STARTED_AT),
    );
    fixture
        .rows
        .execute(
            "UPDATE workflow_runs SET trigger_json = '{\"kind\":\"trigger.manual\",\
             \"nodeId\":\"start\"}' WHERE id = ?1",
            [run_id],
        )
        .expect("the test names the run's trigger");
}

/// A step a test stores: its node, attempt, execution index, status and the `(node, execution
/// index)` of each step that fed it.
type StoredStep<'step> = (
    &'step str,
    u32,
    u32,
    WorkflowStepStatus,
    &'step [(&'step str, u32)],
);

/// Stores `steps` in run `run_id`.
fn store_steps(fixture: &Fixture, run_id: &str, finished_at: &str, steps: &[StoredStep<'_>]) {
    for &(node_id, attempt, execution_index, status, sources) in steps {
        insert_settled_step(
            &fixture.rows,
            run_id,
            &TestSettledStep {
                node_id,
                attempt,
                execution_index,
                status,
                finished_at,
                sources,
                output_item_counts: &[0],
                pin_hash: None,
                reused_from: None,
            },
        );
    }
}

fn retry_of(run_id: &str, node_id: &str) -> WorkflowRunRetry {
    WorkflowRunRetry {
        source_run_id: WorkflowRunId::new(run_id).expect("the test's run id"),
        from_node_id: WorkflowNodeId::new(node_id.to_owned()).expect("a node id"),
        started_by: WorkflowStartedBy::User {
            device_id: DeviceId::new("device-1".to_owned()).expect("a device id"),
        },
    }
}

/// How the source run was started.
#[derive(Clone, Copy, Debug)]
enum SourceStart {
    /// By hand.
    Manual,
    /// As a retry of a chat's run.
    RetryOfAChatRun,
}

/// A retry from `B`, whose step failed in `start → A → B → C` before `A`'s other branch `D` was
/// reached, records `start` and `A` as reused from the source run's own steps, never from the later
/// run that also settled them, covers every node, `D` among them, writes no trigger row, and
/// records the source run as the run it retries, with the mode of the first run of its retries that
/// is not a retry, and honors the pins on `C` its source run's start event stores, never the pins
/// on `D` its workflow holds now.
/// Mutations: leave a node the source run never reached out of the plan, which leaves `D`
/// uncovered; read the nodes' newest settled steps across the workflow's runs
/// (`read_settled_steps`) in place of the source run's, which names the later run; seed nothing
/// (`plan.reused` dropped), which leaves `reused` empty; write the trigger's row though the trigger
/// is reused; copy the source run's own mode as `first_mode`, which reads `retry` for a retry of a
/// chat's run; leave `retried_run_id` off the creation, which the row's check refuses; leave it off
/// the rebuild's start, which the same check refuses on a rebuild; hash the workflow's pins in
/// place of the start event's, which names `D`.
#[rstest]
#[case::of_a_manual_run(SourceStart::Manual, WorkflowRunMode::Manual)]
#[case::of_a_retry_of_a_chat_run(SourceStart::RetryOfAChatRun, WorkflowRunMode::Chat)]
#[tokio::test]
async fn a_retry_reuses_the_source_runs_steps_before_the_failed_one(
    #[case] source_start: SourceStart,
    #[case] first_mode: WorkflowRunMode,
) {
    let fixture = Fixture::new(&chain_body(), TestSession::WithoutFolder, None).await;
    store_run(&fixture, SOURCE_RUN_ID, WorkflowRunStatus::Failed);
    if let SourceStart::RetryOfAChatRun = source_start {
        store_run(&fixture, FIRST_RUN_ID, WorkflowRunStatus::Failed);
        fixture
            .rows
            .execute_batch(&format!(
                "UPDATE workflow_runs SET mode = 'chat' WHERE id = '{FIRST_RUN_ID}'; \
                 UPDATE workflow_runs SET mode = 'retry', retried_run_id = '{FIRST_RUN_ID}' \
                 WHERE id = '{SOURCE_RUN_ID}';"
            ))
            .expect("the source run retries a chat's run");
    }
    store_steps(
        &fixture,
        SOURCE_RUN_ID,
        FINISHED_AT,
        &[
            ("start", 1, 0, WorkflowStepStatus::Succeeded, &[]),
            ("A", 1, 1, WorkflowStepStatus::Succeeded, &[("start", 0)]),
            ("B", 1, 2, WorkflowStepStatus::Failed, &[("A", 1)]),
        ],
    );
    let mut started = json!({ "workflowRunId": SOURCE_RUN_ID });
    if let SourceStart::Manual = source_start {
        started["pinData"] = json!({ "C": [{ "json": {} }] });
    }
    fixture
        .rows
        .execute(
            "INSERT INTO session_events
               (id, session_id, sequence, occurred_at, monotonic_ns, category, type, payload)
             SELECT ?1, ?2, coalesce(max(sequence), 0) + 1, ?3, 0, 'workflowLifecycle',
                    'workflow.run.started', ?4
               FROM session_events WHERE session_id = ?2",
            params![
                "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e90",
                TEST_SESSION_ID,
                ROOT_STARTED_AT,
                started.to_string()
            ],
        )
        .expect("the source run's start event is stored");
    store_run(&fixture, LATER_RUN_ID, WorkflowRunStatus::Failed);
    fixture
        .rows
        .execute(
            "UPDATE workflow_definitions SET pin_data_json = ?1 WHERE id = ?2",
            params![json!({ "D": [{ "json": {} }] }).to_string(), DEFINITION_ID],
        )
        .expect("the test pins D on the workflow");
    store_steps(
        &fixture,
        LATER_RUN_ID,
        LATER_FINISHED_AT,
        &[
            ("start", 1, 0, WorkflowStepStatus::Succeeded, &[]),
            ("A", 1, 1, WorkflowStepStatus::Succeeded, &[("start", 0)]),
        ],
    );

    let retry = fixture
        .starter
        .retry(retry_of(SOURCE_RUN_ID, "B"))
        .await
        .expect("the retry starts");
    // The source's start event is a stand-in holding only what the retry reads, so it leaves
    // before the log is counted and rebuilt.
    fixture
        .rows
        .execute(
            "DELETE FROM session_events WHERE id = '0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e90'",
            [],
        )
        .expect("the stand-in start event is deleted");

    let node_run = retry
        .node_run
        .as_ref()
        .expect("a retry replays its source run's steps");
    let reused: Vec<(String, String, u64, Vec<usize>)> = node_run
        .reused
        .iter()
        .map(|step| {
            let from = &step.seed.record.from.step;
            (
                step.seed.node_id.as_str().to_owned(),
                from.workflow_run_id.text().as_str().to_owned(),
                from.execution_index.get(),
                step.seed.output_lengths.clone(),
            )
        })
        .collect();
    assert_eq!(
        reused,
        vec![
            ("start".to_owned(), SOURCE_RUN_ID.to_owned(), 0, vec![0]),
            ("A".to_owned(), SOURCE_RUN_ID.to_owned(), 1, vec![0]),
        ]
    );
    assert!(
        node_run
            .reused
            .iter()
            .all(|step| step.seed.record.outputs == vec![Vec::new()]
                && step.session_id.text().as_str() == TEST_SESSION_ID)
    );
    assert_eq!(retry.graph.node_count(), 5);
    assert!(node_run.covered.iter().all(|&is_covered| is_covered));
    assert!(retry.trigger.is_none());
    assert_eq!(retry.scope.mode, WorkflowRunMode::Retry);
    assert_eq!(retry.scope.retried_mode, Some(first_mode));
    let pinned: Vec<&str> = retry
        .scope
        .pins
        .keys()
        .map(WorkflowNodeId::as_str)
        .collect();
    let honored: &[&str] = if first_mode == WorkflowRunMode::Manual {
        &["C"]
    } else {
        &[]
    };
    assert_eq!(pinned, honored);
    let run_id = retry.scope.run_id;
    let (mode, retried_run_id): (String, String) = fixture
        .rows
        .query_row(
            "SELECT mode, retried_run_id FROM workflow_runs WHERE id = ?1",
            [run_id.text().as_str()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("the retry's run is stored");
    assert_eq!(
        (mode.as_str(), retried_run_id.as_str()),
        ("retry", SOURCE_RUN_ID)
    );
    let new_steps: i64 = fixture
        .rows
        .query_row(
            "SELECT COUNT(*) FROM workflow_steps WHERE workflow_run_id = ?1",
            params![run_id.text().as_str()],
            |row| row.get(0),
        )
        .expect("the test counts the retry's steps");
    assert_eq!(new_steps, 0);
    let started_sequence: i64 = fixture
        .rows
        .query_row(
            "SELECT sequence FROM session_events WHERE type = 'workflow.run.started'",
            [],
            |row| row.get(0),
        )
        .expect("the started event is stored");
    assert_eq!(i64::from(retry.started_sequence), started_sequence);
    let (payload, _, _) = fixture.started_record(run_id);
    assert_eq!(payload["retriedWorkflowRunId"], json!(SOURCE_RUN_ID));
    assert_eq!(payload.get("inputRef"), None);
    assert_rebuild_rewrites_session_rows(&fixture.rows, TEST_SESSION_ID);
}

/// A retry that cannot be made is refused with its reason and makes no run: a source run no row
/// answers to, one still going, a node it holds no step of, a node whose step succeeded, and a
/// node whose first attempt failed but whose latest one succeeded. Mutations: drop the going
/// check, which starts the retry of the running run; accept any latest status, which starts the
/// retries of `A` and `B`; read the node's earliest execution first, which reads `B` as failed.
#[rstest]
#[case::unknown_run(
    UNKNOWN_RUN_ID,
    WorkflowRunStatus::Failed,
    "B",
    RefusalCode::WorkflowRunNotFound
)]
#[case::still_going(
    SOURCE_RUN_ID,
    WorkflowRunStatus::Running,
    "B",
    RefusalCode::WorkflowRunStillRunning
)]
#[case::a_node_never_reached(
    SOURCE_RUN_ID,
    WorkflowRunStatus::Failed,
    "C",
    RefusalCode::WorkflowStepNotFound
)]
#[case::a_step_that_succeeded(
    SOURCE_RUN_ID,
    WorkflowRunStatus::Failed,
    "A",
    RefusalCode::WorkflowInvalidTransition
)]
#[case::a_failed_attempt_retried_to_success(
    SOURCE_RUN_ID,
    WorkflowRunStatus::Failed,
    "B",
    RefusalCode::WorkflowInvalidTransition
)]
#[tokio::test]
async fn a_refused_retry_names_its_reason_and_makes_no_run(
    #[case] retried_run_id: &str,
    #[case] status: WorkflowRunStatus,
    #[case] node_id: &str,
    #[case] code: RefusalCode,
) {
    let fixture = Fixture::new(&chain_body(), TestSession::WithoutFolder, None).await;
    store_run(&fixture, SOURCE_RUN_ID, status);
    store_steps(
        &fixture,
        SOURCE_RUN_ID,
        FINISHED_AT,
        &[
            ("start", 1, 0, WorkflowStepStatus::Succeeded, &[]),
            ("A", 1, 1, WorkflowStepStatus::Succeeded, &[("start", 0)]),
            ("B", 1, 2, WorkflowStepStatus::Failed, &[("A", 1)]),
        ],
    );
    // The failed `B` the other cases retry; in the last its second attempt succeeded.
    if code == RefusalCode::WorkflowInvalidTransition && node_id == "B" {
        store_steps(
            &fixture,
            SOURCE_RUN_ID,
            FINISHED_AT,
            &[("B", 2, 3, WorkflowStepStatus::Succeeded, &[("A", 1)])],
        );
    }

    let refused = refusal(
        fixture
            .starter
            .retry(retry_of(retried_run_id, node_id))
            .await
            .expect_err("the retry is refused"),
    );

    assert_eq!(refused.code, code);
    if code == RefusalCode::WorkflowRunStillRunning {
        assert_eq!(
            refused.detail.map(|detail| Value::Object(*detail)),
            Some(json!({ "reason": "sourceRunning" }))
        );
    }
    assert_eq!(fixture.count("SELECT COUNT(*) FROM workflow_runs"), 1);
    assert_eq!(fixture.count("SELECT COUNT(*) FROM session_events"), 0);
}
