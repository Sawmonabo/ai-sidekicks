//! Starts that make no run: refused before anything is made, or held on their chain, and what a
//! held start does when it cannot clean up.

use std::io;
use std::path::PathBuf;
use std::sync::Arc;

use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::daemon::config::WorkflowChainAskAfterRuns;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::workflow::definition::document::WorkflowVersionId;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::trigger::WorkflowRunChainPlace;

use super::{
    Fixture, ROOT_RUN_ID, TestSession, UNKNOWN_VERSION_ID, body, item, joins_root, refusal,
    runs_folders, start, test_provider,
};
use crate::engine::event_record::EngineFault;
use crate::engine::ports::REFUSED_PORT_CALL;
use crate::engine::start::{WorkflowStartArrival, WorkflowStartOutcome};
use crate::secrets::redaction::RunRedaction;

/// How a start that writes nothing ends.
#[derive(Clone, Copy, Debug)]
enum NothingWritten {
    UnknownSession,
    UnknownVersion,
    InputLeftOut,
    HeldOnChain,
}

/// Mutations: a refusal checked after the write (a run row or an event is kept); a wrong code; the
/// inputs left unchecked (the run starts); the count's refusal read as an error; a held start's
/// own folder, or its emptied runs folder, left behind; a held start's stored input, above the
/// inline cap, left undeleted.
#[rstest]
#[case::unknown_session(NothingWritten::UnknownSession)]
#[case::unknown_version(NothingWritten::UnknownVersion)]
#[case::input_left_out(NothingWritten::InputLeftOut)]
#[case::held_on_chain(NothingWritten::HeldOnChain)]
#[tokio::test]
async fn a_refused_or_held_start_writes_nothing(#[case] case: NothingWritten) {
    let declared = json!([{ "type": "string", "name": "ticket", "required": true, "default": "" }]);
    let session = match case {
        NothingWritten::UnknownSession => TestSession::Unknown,
        NothingWritten::UnknownVersion
        | NothingWritten::InputLeftOut
        | NothingWritten::HeldOnChain => TestSession::WithoutFolder,
    };
    let fixture = Fixture::new(
        &body(Some(declared)),
        session,
        WorkflowChainAskAfterRuns::new(25),
        Some(test_provider()),
    )
    .await;
    let input = match case {
        NothingWritten::InputLeftOut => Vec::new(),
        NothingWritten::UnknownSession | NothingWritten::UnknownVersion => {
            vec![item(json!({ "ticket": "T-1" }))]
        }
        NothingWritten::HeldOnChain => vec![item(json!({ "ticket": "x".repeat(70 * 1024) }))],
    };
    let mut request = start(
        WorkflowStartArrival::Person,
        WorkflowRunChainPlace::Starts {},
        input,
    );
    if let NothingWritten::UnknownVersion = case {
        request.workflow_version_id =
            WorkflowVersionId::new(UNKNOWN_VERSION_ID).expect("a version id");
    }
    if let NothingWritten::HeldOnChain = case {
        fixture.store_chain_root(25);
        request.chain = joins_root();
    }
    let stored_runs = fixture.count("SELECT COUNT(*) FROM workflow_runs");

    let outcome = fixture.starter.start(request).await;

    match case {
        NothingWritten::HeldOnChain => {
            let held_on = match outcome.expect("a held start is no failure") {
                WorkflowStartOutcome::HeldOnChain { chain_root_run_id } => Some(chain_root_run_id),
                WorkflowStartOutcome::Started(_) => None,
            };
            assert_eq!(
                held_on,
                Some(WorkflowRunId::new(ROOT_RUN_ID).expect("the root's id"))
            );
            assert_eq!(
                fixture.count(&format!(
                    "SELECT chain_run_count FROM workflow_runs WHERE id = '{ROOT_RUN_ID}'"
                )),
                25
            );
        }
        NothingWritten::UnknownSession => {
            let refusal = refusal(outcome.expect_err("the start is refused"));
            assert_eq!(refusal.code, RefusalCode::SessionNotFound);
        }
        NothingWritten::UnknownVersion => {
            let refusal = refusal(outcome.expect_err("the start is refused"));
            assert_eq!(refusal.code, RefusalCode::WorkflowVersionNotFound);
        }
        NothingWritten::InputLeftOut => {
            let refusal = refusal(outcome.expect_err("the start is refused"));
            assert_eq!(refusal.code, RefusalCode::WorkflowRunInputRequired);
            assert_eq!(
                refusal.detail.map(|detail| detail["inputNames"].clone()),
                Some(json!(["ticket"]))
            );
        }
    }
    assert_eq!(
        fixture.count("SELECT COUNT(*) FROM workflow_runs"),
        stored_runs
    );
    assert_eq!(fixture.count("SELECT COUNT(*) FROM session_events"), 0);
    assert_eq!(runs_folders(&fixture.data_folder()), Vec::<PathBuf>::new());
    let written: Vec<ArtifactId> = fixture
        .payloads
        .writes()
        .iter()
        .map(|kept| kept.artifact_id)
        .collect();
    let stored_count = usize::from(matches!(case, NothingWritten::HeldOnChain));
    assert_eq!(written.len(), stored_count);
    assert_eq!(fixture.payloads.deletes(), written);
}

/// A start held on its chain whose stored input cannot be deleted is still answered held, the
/// failed deletion goes to the engine's record with its cause, and that run's record is ended, so
/// the recorder keeps no sequence for it. Mutations: answer the hold inside an error; drop the
/// failure unrecorded; leave the run's record open.
#[tokio::test]
async fn a_held_start_that_cannot_clean_up_is_still_held() {
    let declared = json!([{ "type": "string", "name": "ticket", "required": true, "default": "" }]);
    let fixture = Fixture::new(
        &body(Some(declared)),
        TestSession::WithoutFolder,
        WorkflowChainAskAfterRuns::new(25),
        Some(test_provider()),
    )
    .await;
    fixture.store_chain_root(25);
    fixture.payloads.refuse_deletes();
    let request = start(
        WorkflowStartArrival::Person,
        joins_root(),
        vec![item(json!({ "ticket": "x".repeat(70 * 1024) }))],
    );

    let outcome = fixture.starter.start(request).await;

    assert!(matches!(
        outcome,
        Ok(WorkflowStartOutcome::HeldOnChain { .. })
    ));
    let faults: Vec<(Value, Value)> = fixture
        .records
        .lines()
        .iter()
        .map(|line| (line["record"].clone(), line["error"].clone()))
        .collect();
    assert_eq!(
        faults,
        vec![(json!("heldStartLeftBehind"), json!(REFUSED_PORT_CALL))]
    );
    assert_eq!(runs_folders(&fixture.data_folder()), Vec::<PathBuf>::new());
    let held_run_id: WorkflowRunId =
        serde_json::from_value(fixture.records.lines()[0]["workflowRunId"].clone())
            .expect("the fault names the held start's run");
    fixture
        .starter
        .recorder
        .for_run(held_run_id, Arc::new(RunRedaction::new(&[])))
        .fault(
            None,
            EngineFault::HeldStartLeftBehind,
            &io::Error::other("a later line"),
        )
        .await;
    assert_eq!(fixture.records.lines()[1]["sequence"], json!(1));
}
