//! A node run's start on its plan: the trigger reused or run by the items it was given, a node
//! the version lacks refused, and each reused output read back, split and kept in the run's
//! session.

use std::path::PathBuf;

use rstest::rstest;
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::workflow::definition::document::WorkflowNodeId;
use sidekicks_contracts::workflow::definition::item::WorkflowItem;
use sidekicks_contracts::workflow::run::control::WorkflowNodeExecuteScope;
use sidekicks_contracts::workflow::run::events::WorkflowNodeRun;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::status::{WorkflowRunStatus, WorkflowStepStatus};
use sidekicks_contracts::workflow::run::step::record::{WorkflowPayloadRef, WorkflowStepKey};
use sidekicks_contracts::workflow::run::trigger::WorkflowRunChainPlace;

use super::{
    Fixture, TestSession, VERSION_ID, item, refusal, runs_folders, session_id, start, started,
};
use crate::engine::start::node_run::NodeRunStartOutcome;
use crate::engine::start::{
    StartedRun, WorkflowRunStart, WorkflowRunStartError, WorkflowStartArrival,
};
use crate::runs::step_payload::write_step_payload;
use crate::runs::store::WorkflowRunStore;
use crate::test_rows::{
    TEST_SESSION_ID, TestSettledStep, assert_rebuild_rewrites_run_rows, insert_run,
    insert_settled_step, test_node_id,
};

/// The earlier run whose settled steps the node runs reuse.
const EARLIER_RUN_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e61";

/// A session other than the one the node runs start in.
const OTHER_SESSION_ID: &str = "0199c1a2-7b3e-7c4d-8e5f-0a1b2c3d4e62";

/// One step of the earlier run: its node, its execution index, the `(node, execution index)` of
/// the step feeding each slot, and its main outputs' items.
type EarlierStep = (
    &'static str,
    u32,
    &'static [(&'static str, u32)],
    Vec<Vec<WorkflowItem>>,
);

/// The version `start → A → B`, `A` of the two-output kind feeding `B` from its first output.
fn chain_body() -> Value {
    let edge = |source: &str, target: &str| {
        json!({
            "id": format!("{source}-{target}"), "source": source, "sourceHandle": "outputs/main/0",
            "target": target, "targetHandle": "inputs/main/0",
        })
    };
    let node = |id: &str, kind: &str, order: u32| json!({ "id": id, "kind": kind, "kindVersion": 1, "name": id, "order": order, "params": {} });
    json!({
        "name": "Nightly",
        "trigger": node("start", "trigger.manual", 0),
        "nodes": [node("A", "test.split", 1), node("B", "human.approval", 2)],
        "edges": [edge("start", "A"), edge("A", "B")],
    })
}

/// The earlier run's steps, the trigger started on `trigger_items`, which it passed on.
fn chain_steps(trigger_items: Vec<WorkflowItem>) -> Vec<EarlierStep> {
    vec![
        ("start", 0, &[], vec![trigger_items]),
        ("A", 1, &[("start", 0)], vec![vec![named("A")], Vec::new()]),
        ("B", 2, &[("A", 1)], vec![vec![named("B")]]),
    ]
}

/// An item naming `name`.
fn named(name: &str) -> WorkflowItem {
    item(json!({ "name": name }))
}

/// An item tagged `tag`, large enough that two of them are kept as an artifact.
fn large(tag: &str) -> WorkflowItem {
    item(json!({ "tag": tag, "note": "x".repeat(40 * 1024) }))
}

/// The key of the earlier run's first attempt of `node_id` at `execution_index`.
fn earlier_key(node_id: &str, execution_index: u64) -> WorkflowStepKey {
    WorkflowStepKey {
        workflow_run_id: WorkflowRunId::new(EARLIER_RUN_ID).expect("the earlier run's id"),
        node_id: test_node_id(node_id),
        attempt: SafeInt::new(1).expect("1 is a whole number from 1"),
        execution_index: SafeInt::new(execution_index).expect("a small execution index"),
    }
}

/// Stores the earlier run of the test's version, every step succeeded, its outputs inline.
fn store_earlier_run(rows: &Connection, steps: &[EarlierStep]) {
    insert_run(
        rows,
        EARLIER_RUN_ID,
        VERSION_ID,
        WorkflowRunStatus::Succeeded,
        "2026-10-02T00:00:00.000Z",
        Some("2026-10-02T01:00:00.000Z"),
    );
    for (node_id, execution_index, sources, outputs) in steps {
        let counts: Vec<u64> = outputs
            .iter()
            .map(|output| u64::try_from(output.len()).expect("a test output's length fits"))
            .collect();
        insert_settled_step(
            rows,
            EARLIER_RUN_ID,
            &TestSettledStep {
                node_id,
                attempt: 1,
                execution_index: *execution_index,
                status: WorkflowStepStatus::Succeeded,
                finished_at: "2026-10-02T00:30:00.000Z",
                sources,
                output_item_counts: &counts,
                pin_hash: None,
                reused_from: None,
            },
        );
        let output_ref = WorkflowPayloadRef::Inline {
            items: outputs.concat(),
        };
        set_payload_ref(rows, node_id, "output_ref", &output_ref);
    }
}

/// Points `column` of the earlier run's step of `node_id` at `payload_ref`.
fn set_payload_ref(
    rows: &Connection,
    node_id: &str,
    column: &str,
    payload_ref: &WorkflowPayloadRef,
) {
    rows.execute(
        &format!(
            "UPDATE workflow_steps SET {column} = ?1 WHERE workflow_run_id = ?2 AND node_id = ?3"
        ),
        params![
            serde_json::to_string(payload_ref).expect("a payload ref writes as JSON"),
            EARLIER_RUN_ID,
            node_id
        ],
    )
    .expect("the test stores the earlier step's payload");
}

/// A person's node run of the test's version, given `input`.
fn node_start(input: Option<Vec<WorkflowItem>>) -> WorkflowRunStart {
    WorkflowRunStart {
        input,
        ..start(
            WorkflowStartArrival::Person,
            WorkflowRunChainPlace::Starts {},
            Vec::new(),
        )
    }
}

/// The node run on `node_id` in `scope`.
fn node_run(node_id: &str, scope: WorkflowNodeExecuteScope) -> WorkflowNodeRun {
    WorkflowNodeRun {
        node_id: test_node_id(node_id),
        scope,
    }
}

/// The run a node run started, with the nodes its reply names as executed and as reused.
fn started_node_run(
    outcome: Result<NodeRunStartOutcome, WorkflowRunStartError>,
) -> (StartedRun, Vec<String>, Vec<String>) {
    let NodeRunStartOutcome {
        outcome,
        executed_node_ids,
        reused_node_ids,
    } = outcome.expect("the node run's start is not refused");
    let names = |node_ids: Vec<WorkflowNodeId>| {
        node_ids
            .iter()
            .map(|node_id| node_id.as_str().to_owned())
            .collect()
    };
    (
        started(Ok(outcome)),
        names(executed_node_ids),
        names(reused_node_ids),
    )
}

/// How many step rows run `run_id` holds.
fn step_rows(fixture: &Fixture, run_id: WorkflowRunId) -> i64 {
    fixture
        .rows
        .query_row(
            "SELECT COUNT(*) FROM workflow_steps WHERE workflow_run_id = ?1",
            [run_id.text().as_str()],
            |row| row.get(0),
        )
        .expect("the test counts the run's steps")
}

/// A run from `B` given no items reuses the clean trigger and `A`: its write holds no trigger row
/// and its started event no `inputRef` but the node run, which the run read answers too, and its
/// reply lists the plan's nodes; a rebuild from the log writes its row byte-identical. Mutations:
/// in `write`, store the trigger's input and row whatever the plan says (a trigger row and an
/// `inputRef` appear); the fold's start dropping the node run (the rebuilt `node_run_json` reads
/// NULL).
#[tokio::test]
async fn run_from_here_reuses_its_clean_trigger_and_names_the_node_run() {
    let fixture = Fixture::new(&chain_body(), TestSession::WithoutFolder, None).await;
    store_earlier_run(&fixture.rows, &chain_steps(vec![named("given")]));

    let (run, executed, reused) = started_node_run(
        fixture
            .starter
            .start_node_run(
                node_start(None),
                node_run("B", WorkflowNodeExecuteScope::FromHere),
            )
            .await,
    );

    assert_eq!(
        (executed, reused),
        (
            vec!["B".to_owned()],
            vec!["start".to_owned(), "A".to_owned()]
        )
    );
    let run_id = run.scope.run_id;
    assert!(run.trigger.is_none());
    assert_eq!(step_rows(&fixture, run_id), 0);
    let (payload, ..) = fixture.started_record(run_id);
    assert_eq!(payload.get("inputRef"), None);
    assert_eq!(
        payload["nodeRun"],
        json!({ "nodeId": "B", "scope": "fromHere" })
    );
    let read = WorkflowRunStore::new(&fixture.rows)
        .read(run_id)
        .expect("the node run reads back");
    assert_eq!(
        read.run.node_run,
        Some(node_run("B", WorkflowNodeExecuteScope::FromHere))
    );
    assert_rebuild_rewrites_run_rows(&fixture.rows, TEST_SESSION_ID, run_id.text().as_str());
}

/// How the items a node run is given stand against its trigger's earlier input.
#[derive(Clone, Copy, Debug)]
enum GivenItems {
    /// The same items, the earlier input kept inline.
    EqualInline,
    /// The same items, the earlier input kept as an artifact and read back.
    EqualStored,
    /// Other items.
    Changed,
}

/// Items equal to the trigger's earlier input reuse it, however that input is kept; other items
/// run the whole covered set from the trigger, whose row and `inputRef` the write then holds.
/// Mutations: compare the given items with the earlier input's ref rather than its items (the
/// stored case runs); skip the comparison (the changed case reuses).
#[rstest]
#[case::equal_inline(GivenItems::EqualInline)]
#[case::equal_stored(GivenItems::EqualStored)]
#[case::changed(GivenItems::Changed)]
#[tokio::test]
async fn given_items_reuse_an_equal_trigger_and_run_a_changed_one(#[case] given: GivenItems) {
    let fixture = Fixture::new(&chain_body(), TestSession::WithoutFolder, None).await;
    let earlier_items = match given {
        GivenItems::EqualInline | GivenItems::Changed => vec![named("given")],
        GivenItems::EqualStored => vec![large("given")],
    };
    store_earlier_run(&fixture.rows, &chain_steps(earlier_items.clone()));
    let earlier_ref = write_step_payload(
        fixture.payloads.as_ref(),
        session_id(),
        &earlier_key("start", 0),
        &earlier_items,
    )
    .await
    .expect("the earlier input is stored");
    set_payload_ref(&fixture.rows, "start", "input_ref", &earlier_ref);
    set_payload_ref(&fixture.rows, "start", "output_ref", &earlier_ref);
    let given_items = match given {
        GivenItems::EqualInline | GivenItems::EqualStored => earlier_items,
        GivenItems::Changed => vec![named("other")],
    };

    let (run, executed, reused) = started_node_run(
        fixture
            .starter
            .start_node_run(
                node_start(Some(given_items.clone())),
                node_run("B", WorkflowNodeExecuteScope::FromHere),
            )
            .await,
    );

    let run_id = run.scope.run_id;
    let (payload, ..) = fixture.started_record(run_id);
    match given {
        GivenItems::EqualInline | GivenItems::EqualStored => {
            assert_eq!(
                (executed, reused),
                (
                    vec!["B".to_owned()],
                    vec!["start".to_owned(), "A".to_owned()]
                )
            );
            assert!(run.trigger.is_none());
            assert_eq!(step_rows(&fixture, run_id), 0);
            assert_eq!(payload.get("inputRef"), None);
        }
        GivenItems::Changed => {
            assert_eq!(
                (executed, reused),
                (
                    vec!["start".to_owned(), "A".to_owned(), "B".to_owned()],
                    Vec::new()
                )
            );
            let trigger = run.trigger.expect("the changed trigger runs");
            assert_eq!(trigger.items, given_items);
            assert_eq!(
                payload["inputRef"],
                serde_json::to_value(&trigger.input_ref).expect("a payload ref writes as JSON")
            );
            assert_eq!(step_rows(&fixture, run_id), 1);
            let replayed = run.node_run.expect("a node run hands its seed on");
            assert!(replayed.reused.is_empty());
        }
    }
}

/// `A`'s two outputs, kept together as an artifact, are read back and split by their counts; one
/// kept in another session is stored again in the run's session, under the step that computed
/// it, and replayed from that copy, and one in the run's session is replayed as it is. Mutations:
/// hand `A` its items joined on one output; keep the other session's ref (no copy is written).
#[rstest]
#[case::another_session(false)]
#[case::the_run_session(true)]
#[tokio::test]
async fn a_reused_artifact_output_is_read_back_and_split(#[case] is_same_session: bool) {
    let fixture = Fixture::new(&chain_body(), TestSession::WithoutFolder, None).await;
    let outputs = vec![vec![large("kept")], vec![large("dropped")]];
    let mut steps = chain_steps(vec![named("given")]);
    steps[1].3 = outputs.clone();
    store_earlier_run(&fixture.rows, &steps);
    let earlier_session = if is_same_session {
        session_id()
    } else {
        SessionId::new(OTHER_SESSION_ID).expect("the other session's id")
    };
    fixture
        .rows
        .execute(
            "UPDATE workflow_runs SET session_id = ?1 WHERE id = ?2",
            params![earlier_session.text().as_str(), EARLIER_RUN_ID],
        )
        .expect("the test moves the earlier run to its session");
    let earlier_ref = write_step_payload(
        fixture.payloads.as_ref(),
        earlier_session,
        &earlier_key("A", 1),
        &outputs.concat(),
    )
    .await
    .expect("the earlier output is stored");
    set_payload_ref(&fixture.rows, "A", "output_ref", &earlier_ref);

    let (run, ..) = started_node_run(
        fixture
            .starter
            .start_node_run(
                node_start(None),
                node_run("B", WorkflowNodeExecuteScope::FromHere),
            )
            .await,
    );

    let replayed = run.node_run.expect("a node run hands its seed on");
    let a = replayed
        .reused
        .iter()
        .find(|step| step.seed.node_id.as_str() == "A")
        .expect("A is replayed");
    assert_eq!(a.outputs, outputs);
    assert_eq!(a.session_id, session_id());
    let writes = fixture.payloads.writes();
    if is_same_session {
        assert_eq!(writes.len(), 1);
        assert_eq!(a.seed.record.output_ref, earlier_ref);
    } else {
        assert_eq!(writes.len(), 2);
        let copy = &writes[1];
        assert_eq!(
            (copy.session_id, &copy.step, &copy.bytes),
            (session_id(), &earlier_key("A", 1), &writes[0].bytes)
        );
        let WorkflowPayloadRef::Artifact { artifact_id, .. } = a.seed.record.output_ref else {
            panic!("the copy is an artifact");
        };
        assert_eq!(artifact_id, copy.artifact_id);
    }
}

/// A reused output of another session that cannot be stored in the run's session fails the
/// start, which writes no run, no event and no folder. Mutation: in `store_in_session`, keep the
/// other session's ref when the copy fails (the run starts).
#[tokio::test]
async fn a_reused_output_not_stored_again_fails_the_start() {
    let fixture = Fixture::new(&chain_body(), TestSession::WithoutFolder, None).await;
    let outputs = vec![vec![large("kept")], vec![large("dropped")]];
    let mut steps = chain_steps(vec![named("given")]);
    steps[1].3 = outputs.clone();
    store_earlier_run(&fixture.rows, &steps);
    let other_session = SessionId::new(OTHER_SESSION_ID).expect("the other session's id");
    fixture
        .rows
        .execute(
            "UPDATE workflow_runs SET session_id = ?1 WHERE id = ?2",
            params![other_session.text().as_str(), EARLIER_RUN_ID],
        )
        .expect("the test moves the earlier run to its session");
    let earlier_ref = write_step_payload(
        fixture.payloads.as_ref(),
        other_session,
        &earlier_key("A", 1),
        &outputs.concat(),
    )
    .await
    .expect("the earlier output is stored");
    set_payload_ref(&fixture.rows, "A", "output_ref", &earlier_ref);
    fixture.payloads.refuse_writes_past(1);

    let outcome = fixture
        .starter
        .start_node_run(
            node_start(None),
            node_run("B", WorkflowNodeExecuteScope::FromHere),
        )
        .await;

    assert!(matches!(
        outcome,
        Err(WorkflowRunStartError::ReusedOutputStore(_))
    ));
    assert_eq!(fixture.count("SELECT COUNT(*) FROM workflow_runs"), 1);
    assert_eq!(fixture.count("SELECT COUNT(*) FROM session_events"), 0);
    assert_eq!(runs_folders(&fixture.data_folder()), Vec::<PathBuf>::new());
}

/// A node run on a node its version lacks is refused `workflow.node.notFound`, with no run, no
/// event and no folder. Mutation: drop the node check (the plan's read of the target panics).
#[tokio::test]
async fn a_node_the_version_lacks_is_refused_and_writes_no_run() {
    let fixture = Fixture::new(&chain_body(), TestSession::WithoutFolder, None).await;

    let outcome = fixture
        .starter
        .start_node_run(
            node_start(None),
            node_run("missing", WorkflowNodeExecuteScope::Node),
        )
        .await;

    let Err(error) = outcome else {
        panic!("the node run is refused");
    };
    assert_eq!(refusal(error).code, RefusalCode::WorkflowNodeNotFound);
    assert_eq!(fixture.count("SELECT COUNT(*) FROM workflow_runs"), 0);
    assert_eq!(fixture.count("SELECT COUNT(*) FROM session_events"), 0);
    assert_eq!(runs_folders(&fixture.data_folder()), Vec::<PathBuf>::new());
}
