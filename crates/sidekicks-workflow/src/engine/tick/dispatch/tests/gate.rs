//! The memory gate: a weighed step's entry line, its hold and admission, and a cancel at either.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::jsonrpc::byte_length::json_utf8_byte_length;
use sidekicks_contracts::workflow::run::trigger::WorkflowRunMode;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::writer::test_file::TestDatabase;
use tokio::time::timeout;

use super::{
    ExecutorProbe, QUIET, Script, WAIT, completed, failed, named_item, next_report, pin_data_json,
    pinned_settlement, run_step, scripted_kind, started, test_node,
};
use crate::engine::ports::{
    ScriptedGate, StepAdmission, StepAdmissionOutcome, StepAdmissionWork, StepScriptRuntime,
    WorkflowNodeKey,
};
use crate::engine::start::hash_run_pins;
use crate::engine::tick::dispatch::{test_dispatch, test_ready_step, test_run_snapshot};
use crate::engine::tick::test_run_scope;
use crate::kinds::{StepAdmissionNeed, StepAdmissionShape};
use crate::schema::schema_parts;

/// A step the memory gate weighs gets nothing in the dispatch's answer: it enters the gate with
/// what it runs, a quick step's input measured, reports its hold where the gate holds it, then its
/// admission, and launches holding its ticket, which is dropped once it settles. A node pinned in a
/// manual run starts with its pin's hash and settles with its pinned items in the dispatch's
/// answer, without entering the gate, resolving a secret or running its executor. Mutations: run
/// the executor before the admission; answer `Admitted` at dispatch for a gate step; launch without
/// the ticket; leave the input unmeasured or zero; run a pinned node in a manual run, resolve its
/// secrets, send it into the gate or settle it from a task; start it with `pin_hash: None` on the
/// dispatch's pinned path.
#[rstest]
#[case::quick_code_held(
    StepAdmissionShape::QuickCode { budget_bytes: 1024, output_max_bytes: 2048 },
    None,
    false
)]
#[case::script_admitted(
    StepAdmissionShape::Script { runtime: StepScriptRuntime::Bun },
    Some(StepAdmissionOutcome::Admitted),
    false
)]
#[case::pinned_manual(
    StepAdmissionShape::Script { runtime: StepScriptRuntime::Bun },
    None,
    true
)]
#[tokio::test]
async fn a_gate_step_waits_for_its_admission_before_it_launches(
    #[case] shape: StepAdmissionShape,
    #[case] initial: Option<StepAdmissionOutcome>,
    #[case] is_pinned: bool,
) {
    let probe = Arc::new(ExecutorProbe::default());
    // A pinned node's secret is missing, so resolving it would fail the step.
    let node = test_node(&if is_pinned {
        json!({ "params": { "token": "secret://shared/missing" } })
    } else {
        json!({})
    });
    let mut scope = test_run_scope(WorkflowRunMode::Manual, vec![node.clone()]);
    if is_pinned {
        scope.pins = hash_run_pins(Some(&pin_data_json()), WorkflowRunMode::Manual)
            .expect("the test's pins hash");
    }
    let inputs: Vec<Value> = ["Ada", "Bob"]
        .iter()
        .map(|name| json!({ "name": name }))
        .collect();
    let input_bytes =
        json_utf8_byte_length(&test_ready_step(&scope, &node, vec![inputs.clone()]).inputs)
            .expect("the test's inputs measure");
    assert_ne!(input_bytes, 0);
    let node_key = WorkflowNodeKey::new(scope.workflow_id, &node.id);
    let gate = Arc::new(ScriptedGate::new(initial));

    let (answered, sent) = run_step(
        scope,
        &node,
        scripted_kind(
            Script::Progress,
            StepAdmissionNeed::Gate(shape),
            &probe,
            false,
        ),
        inputs,
        &probe,
        Some(&gate),
    )
    .await;

    if is_pinned {
        assert_eq!(answered, pinned_settlement());
        assert_eq!(sent, Vec::<Value>::new());
        assert_eq!(gate.enqueued(), Vec::new());
        assert!(lock(&probe.seen).is_empty());
        return;
    }
    assert_eq!(answered, Vec::<Value>::new());
    let mut expected_sent = if initial.is_none() {
        let hold = sent[0]["waitingOnMemory"].clone();
        assert!(
            hold.is_string(),
            "the first report is not a hold: {}",
            sent[0]
        );
        vec![
            json!({ "waitingOnMemory": hold }),
            json!({ "admitted": hold }),
        ]
    } else {
        vec![json!({ "admitted": null })]
    };
    expected_sent.extend([
        started(),
        json!("progressed"),
        completed(
            &json!([[named_item("Ada", 0), named_item("Bob", 1)]]),
            &json!({ "answer": { "value": 42, "isKept": false } }),
        ),
    ]);
    assert_eq!(sent, expected_sent);
    let expected_work = match shape {
        StepAdmissionShape::QuickCode { .. } => StepAdmissionWork::QuickCode {
            budget_bytes: 1024,
            input_bytes: u64::try_from(input_bytes).expect("the test's length fits"),
            output_max_bytes: 2048,
            node_key,
        },
        StepAdmissionShape::Script { .. } => StepAdmissionWork::Script {
            runtime: StepScriptRuntime::Bun,
            node_key,
        },
    };
    assert_eq!(gate.enqueued(), vec![expected_work]);
    assert!(probe.is_admitted.load(Ordering::SeqCst));
    assert_eq!(gate.dropped_tickets(), 1);
}

/// Where a gate step is when its cancel comes.
#[derive(Clone, Copy)]
enum CancelPoint {
    /// Waiting for its turn in the entry line.
    InLine,
    /// Held at the gate.
    AtGate,
}

/// A gate step enters the gate only once every turn taken before its own is dropped, and a cancel
/// ends it in the line, before it enters, or at the gate, carrying its hold and dropping its
/// ticket. Mutations: enter without waiting for the turn; ignore a cancel in the line; drop the
/// hold's instant from the cancel; keep the ticket after the cancel.
#[rstest]
#[case::in_line(CancelPoint::InLine)]
#[case::at_gate(CancelPoint::AtGate)]
#[tokio::test]
async fn a_gate_step_enters_in_its_turn_and_a_cancel_ends_it(#[case] point: CancelPoint) {
    let probe = Arc::new(ExecutorProbe::default());
    let node = test_node(&json!({}));
    let database = TestDatabase::new(schema_parts());
    let need = StepAdmissionNeed::Gate(StepAdmissionShape::QuickCode {
        budget_bytes: 1024,
        output_max_bytes: 2048,
    });
    let (mut dispatch, mut received) = test_dispatch(
        &database,
        vec![scripted_kind(Script::Progress, need, &probe, false)],
    );
    let gate = Arc::new(ScriptedGate::new(None));
    dispatch.ports.admission = Arc::clone(&gate) as Arc<dyn StepAdmission>;
    let scope = Arc::new(test_run_scope(WorkflowRunMode::Manual, vec![node.clone()]));
    let ready = test_ready_step(&scope, &node, vec![vec![json!({ "name": "Ada" })]]);
    let step = ready.step.clone();
    let earlier_turn = dispatch.gate_entries.take_turn();
    let dispatched = dispatch
        .dispatch(&scope, &test_run_snapshot(&node), vec![ready])
        .remove(0);
    drop(dispatch);
    assert!(dispatched.reports.is_empty());

    tokio::time::sleep(QUIET).await;
    assert_eq!(
        gate.enqueued(),
        Vec::new(),
        "the step entered before its turn"
    );
    assert!(
        received.try_recv().is_err(),
        "the step reported before its turn"
    );

    let hold = match point {
        CancelPoint::InLine => {
            dispatched.cancel.cancel();
            Value::Null
        }
        CancelPoint::AtGate => {
            drop(earlier_turn);
            timeout(WAIT, gate.wait_for_entry())
                .await
                .expect("the step enters once the earlier turn is dropped");
            let held = next_report(&mut received, &step)
                .await
                .expect("the hold is reported");
            let hold = held["waitingOnMemory"].clone();
            assert!(hold.is_string(), "the first report is not a hold: {held}");
            dispatched.cancel.cancel();
            hold
        }
    };
    assert_eq!(
        next_report(&mut received, &step).await,
        Some(json!({ "canceled": { "holdStartedAt": hold, "cancellationReason": null } }))
    );
    assert_eq!(next_report(&mut received, &step).await, None);
    let entry_count = usize::from(matches!(point, CancelPoint::AtGate));
    assert_eq!(gate.enqueued().len(), entry_count);
    assert_eq!(gate.dropped_tickets(), entry_count);
    assert!(lock(&probe.seen).is_empty());
}

/// A gate step evaluates its params before it takes its turn in the entry line, so one whose
/// template never closes fails while a turn taken before it is still held, never entering the
/// gate. Mutation: take the turn before the launch.
#[tokio::test]
async fn a_gate_step_whose_params_do_not_evaluate_fails_before_its_turn() {
    let probe = Arc::new(ExecutorProbe::default());
    let node = test_node(&json!({ "params": { "bad": "={{ a" } }));
    let database = TestDatabase::new(schema_parts());
    let need = StepAdmissionNeed::Gate(StepAdmissionShape::Script {
        runtime: StepScriptRuntime::Bun,
    });
    let (mut dispatch, mut received) = test_dispatch(
        &database,
        vec![scripted_kind(Script::Progress, need, &probe, false)],
    );
    let gate = Arc::new(ScriptedGate::new(None));
    dispatch.ports.admission = Arc::clone(&gate) as Arc<dyn StepAdmission>;
    let scope = Arc::new(test_run_scope(WorkflowRunMode::Manual, vec![node.clone()]));
    let ready = test_ready_step(&scope, &node, vec![vec![json!({ "name": "Ada" })]]);
    let step = ready.step.clone();
    let earlier_turn = dispatch.gate_entries.take_turn();
    dispatch.dispatch(&scope, &test_run_snapshot(&node), vec![ready]);
    drop(dispatch);

    assert_eq!(
        next_report(&mut received, &step).await,
        Some(failed(&json!({
            "message": "the template at bad is never closed", "nodeId": "step",
        })))
    );
    assert_eq!(next_report(&mut received, &step).await, None);
    assert_eq!(gate.enqueued(), Vec::new());
    drop(earlier_turn);
}
