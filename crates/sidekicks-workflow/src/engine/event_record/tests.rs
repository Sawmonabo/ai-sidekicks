use std::sync::Arc;

use secrecy::SecretString;
use serde_json::{Map, Value, json};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::UuidTextForm;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::status::WorkflowWaitCause;
use sidekicks_contracts::workflow::run::step::record::WorkflowStepKey;
use sidekicks_std::mutex_lock::lock;

use super::{
    EngineDecision, EngineIntent, EngineOutcome, EngineRecorder, RunEngineRecord, StepEnding,
    StepTransition,
};
use crate::engine::ports::{EngineRecordSink, KeptEngineRecords};
use crate::kinds::{StepFailure, coded_step_error};
use crate::secrets::redaction::RunRedaction;

/// The run of `uuid`'s text.
fn run_id(uuid: &str) -> WorkflowRunId {
    WorkflowRunId::new(uuid).expect("the test's run id is a UUID")
}

/// The first execution of node `node_id` in the run of `run_uuid`.
fn step(run_uuid: &str, node_id: &str) -> WorkflowStepKey {
    serde_json::from_value(json!({
        "workflowRunId": run_uuid, "nodeId": node_id, "attempt": 1, "executionIndex": 0,
    }))
    .expect("the test's step key reads")
}

/// A run's record on `recorder` with no secrets.
fn record(recorder: &EngineRecorder, run_uuid: &str) -> RunEngineRecord {
    recorder.for_run(run_id(run_uuid), Arc::new(RunRedaction::new(&[])))
}

/// Two runs interleaved on one recorder each number their lines from 1, a record made again
/// for a run carries on from its last line, an outcome names its intent's sequence, one life id
/// marks every line, a run's end drops its counter, and a second recorder starts a new life at
/// 1. Mutations: one counter for every run; a fresh counter per record; an outcome without its
/// intent's sequence; a run's counter kept past its end; the life id dropped or shared between
/// recorders.
#[tokio::test]
async fn each_run_numbers_its_lines_from_one_and_an_outcome_names_its_intent() {
    const RUN_A: &str = "0190a2b4-7c3d-7e5f-8a1b-2c3d4e5f6a7a";
    const RUN_B: &str = "0190a2b4-7c3d-7e5f-8a1b-2c3d4e5f6a7b";
    let sink = Arc::new(KeptEngineRecords::default());
    let recorder = EngineRecorder::new(Arc::clone(&sink) as Arc<dyn EngineRecordSink>);
    let run_a = record(&recorder, RUN_A);
    let run_b = record(&recorder, RUN_B);
    let step_a = step(RUN_A, "build");
    let wait_id = UuidTextForm::new("0190a2b4-7c3d-7e5f-8a1b-2c3d4e5f6a7e")
        .expect("the test's wait id is a UUID");

    let dispatch = run_a
        .intent(Some(&step_a), EngineIntent::DispatchingStep)
        .await;
    let question = run_b
        .intent(None, EngineIntent::OpeningQuestion { wait_id })
        .await;
    run_a
        .decision(
            Some(&step_a),
            EngineDecision::StepReported(StepTransition::Started),
        )
        .await;
    run_b
        .outcome(
            question,
            EngineOutcome::Failed {
                code: Some(RefusalCode::WorkflowStepNotWaiting),
            },
        )
        .await;
    run_a.outcome(dispatch, EngineOutcome::Done).await;
    drop(run_a);
    record(&recorder, RUN_A)
        .decision(
            None,
            EngineDecision::Refused(RefusalCode::WorkflowRunNotCancelable),
        )
        .await;

    let lines = sink.lines();
    let of_run = |run: &str| -> Vec<&Map<String, Value>> {
        lines
            .iter()
            .filter(|line| line["workflowRunId"] == json!(run))
            .collect()
    };
    let sequences = |run: &str| -> Vec<Value> {
        of_run(run)
            .iter()
            .map(|line| line["sequence"].clone())
            .collect()
    };
    assert_eq!(sequences(RUN_A), [json!(1), json!(2), json!(3), json!(4)]);
    assert_eq!(sequences(RUN_B), [json!(1), json!(2)]);
    recorder.end_run(run_id(RUN_B));
    assert_eq!(
        lock(&recorder.sequences)
            .keys()
            .copied()
            .collect::<Vec<_>>(),
        [run_id(RUN_A)]
    );
    assert_eq!(of_run(RUN_A)[2]["intentSequence"], json!(1));
    assert_eq!(of_run(RUN_B)[1]["intentSequence"], json!(1));
    assert_eq!(of_run(RUN_A)[0]["nodeId"], json!("build"));
    let life_id = lines[0]["lifeId"].clone();
    assert!(life_id.is_string(), "every line carries the life id");
    assert!(lines.iter().all(|line| line["lifeId"] == life_id));

    let next_sink = Arc::new(KeptEngineRecords::default());
    let next_life = EngineRecorder::new(Arc::clone(&next_sink) as Arc<dyn EngineRecordSink>);
    record(&next_life, RUN_A)
        .decision(
            None,
            EngineDecision::WaitOpened {
                cause: WorkflowWaitCause::Approval,
                deadline_at: Some(WireInstant::now()),
            },
        )
        .await;
    let next_lines = next_sink.lines();
    assert_eq!(next_lines[0]["sequence"], json!(1));
    assert!(next_lines[0]["lifeId"].is_string());
    assert_ne!(next_lines[0]["lifeId"], life_id);
}

/// A failed step's line carries its code and none of its message, and the run's secret, here
/// inside the step's node id, reaches no line. Mutations: the message recorded; the scrub
/// skipped.
#[tokio::test]
async fn a_line_carries_no_secret_and_no_step_text() {
    const RUN: &str = "0190a2b4-7c3d-7e5f-8a1b-2c3d4e5f6a7c";
    const SECRET: &str = "correct-horse-battery-staple";
    let sink = Arc::new(KeptEngineRecords::default());
    let recorder = EngineRecorder::new(Arc::clone(&sink) as Arc<dyn EngineRecordSink>);
    let run = recorder.for_run(
        run_id(RUN),
        Arc::new(RunRedaction::new(&[SecretString::from(SECRET)])),
    );
    let node_id = format!("deploy-{SECRET}");
    let step = step(RUN, &node_id);
    let failure = StepFailure::Failed(Box::new(coded_step_error(
        RefusalCode::WorkflowStepTimedOut,
        format!("the call with token {SECRET} timed out"),
        json!({}),
        None,
    )));

    run.decision(
        Some(&step),
        EngineDecision::StepReported(StepTransition::Settled(StepEnding::Failed(&failure))),
    )
    .await;
    run.decision(
        Some(&step),
        EngineDecision::Refused(RefusalCode::WorkflowRunNotCancelable),
    )
    .await;
    let resume = run
        .intent(
            Some(&step),
            EngineIntent::DispatchingResume {
                session_id: SessionId::new("0190a2b4-7c3d-7e5f-8a1b-2c3d4e5f6a7d")
                    .expect("the test's session id is a UUID"),
            },
        )
        .await;
    run.outcome(resume, EngineOutcome::Done).await;

    let lines = sink.lines();
    assert_eq!(lines.len(), 4);
    assert_eq!(lines[0]["settlement"], json!("failed"));
    assert_eq!(lines[0]["failure"], json!("workflow.step.timedOut"));
    assert_eq!(lines[1]["code"], json!("workflow.run.notCancelable"));
    for line in &lines {
        let text = Value::Object(line.clone()).to_string();
        assert!(!text.contains(SECRET), "a line carries the secret: {text}");
        assert!(
            !text.contains("timed out"),
            "a line carries the message: {text}"
        );
    }
    let recorded_node = lines[0]["nodeId"].as_str().expect("the node id is text");
    assert!(recorded_node.starts_with("deploy-") && recorded_node != node_id);
}
