//! Starts that make no run: refused before anything is made, or held on their chain, and what a
//! held start does when it cannot clean up.

use std::path::PathBuf;

use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::daemon::config::WorkflowChainAskAfterRuns;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::project::ProjectId;
use sidekicks_contracts::workflow::definition::document::WorkflowVersionId;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::trigger::WorkflowRunChainPlace;
use sidekicks_workspace::execution_root::test_fixture::MOUNT_ID;

use super::{
    Fixture, ROOT_RUN_ID, TestSession, UNKNOWN_VERSION_ID, body, git_node, item, joins_root,
    refusal, runs_folders, shell_node, start,
};
use crate::engine::ports::REFUSED_PORT_CALL;
use crate::engine::start::{WorkflowRunStartError, WorkflowStartArrival, WorkflowStartOutcome};

/// How a start that writes nothing ends.
#[derive(Clone, Copy, Debug)]
enum NothingWritten {
    UnknownSession,
    UnknownVersion,
    ProjectOnProjectSession,
    BindingRefused,
    InputLeftOut,
    RepositoryRequired,
    ProviderRequired,
    NodeKindUnavailable,
    HandleUndeclared,
    HeldOnChain,
}

/// Mutations: a refusal checked after the write (a run row or an event is kept); a wrong code; a
/// project named beside a project session let through; a project session's run written before its
/// binding, or its binding's failure dropped (the run starts); the inputs left unchecked (the run
/// starts); a step that needs a repository started in a session
/// with no project's repository, or refused with a wrong detail; a step that runs in a sandbox
/// started with no provider, refused with a wrong detail, or a disabled one counted; a version
/// whose graph does not build started; one code answered for both errors; an unlisted kind or an
/// undeclared handle refused with only the first node, or with a wrong node or handle; the count's
/// refusal read as an error; a held start's own folder, or its emptied runs folder, left behind; a
/// held start's stored input, above the inline cap, left undeleted.
#[rstest]
#[case::unknown_session(NothingWritten::UnknownSession)]
#[case::unknown_version(NothingWritten::UnknownVersion)]
#[case::project_on_project_session(NothingWritten::ProjectOnProjectSession)]
#[case::binding_refused(NothingWritten::BindingRefused)]
#[case::input_left_out(NothingWritten::InputLeftOut)]
#[case::repository_required(NothingWritten::RepositoryRequired)]
#[case::provider_required(NothingWritten::ProviderRequired)]
#[case::node_kind_unavailable(NothingWritten::NodeKindUnavailable)]
#[case::handle_undeclared(NothingWritten::HandleUndeclared)]
#[case::held_on_chain(NothingWritten::HeldOnChain)]
#[tokio::test]
async fn a_refused_or_held_start_writes_nothing(#[case] case: NothingWritten) {
    let declared = json!([{ "type": "string", "name": "ticket", "required": true, "default": "" }]);
    let session = match case {
        NothingWritten::UnknownSession => TestSession::Unknown,
        // A project session whose workspace is not bound yet, so its binding finds none.
        NothingWritten::ProjectOnProjectSession | NothingWritten::BindingRefused => {
            TestSession::ProjectWithoutWorkspace
        }
        NothingWritten::UnknownVersion
        | NothingWritten::InputLeftOut
        | NothingWritten::RepositoryRequired
        | NothingWritten::ProviderRequired
        | NothingWritten::NodeKindUnavailable
        | NothingWritten::HandleUndeclared
        | NothingWritten::HeldOnChain => TestSession::WithoutFolder,
    };
    let nodes = match case {
        NothingWritten::RepositoryRequired => json!([git_node()]),
        NothingWritten::ProviderRequired => {
            json!([shell_node("shell", false), shell_node("shell-off", true)])
        }
        // A kind the table does not list, and a listed kind at a version it does not, disabled.
        NothingWritten::NodeKindUnavailable => json!([
            {
                "id": "gone", "kind": "test.gone", "kindVersion": 1, "name": "Gone", "order": 0,
                "params": {}
            },
            {
                "id": "shell-later", "kind": "developer.shell", "kindVersion": 2,
                "name": "Later", "order": 0, "disabled": true, "params": {}
            },
        ]),
        // Disabled, so neither needs a provider, though both stay in the graph.
        NothingWritten::HandleUndeclared => {
            json!([shell_node("shell-a", true), shell_node("shell-b", true)])
        }
        NothingWritten::UnknownSession
        | NothingWritten::UnknownVersion
        | NothingWritten::ProjectOnProjectSession
        | NothingWritten::BindingRefused
        | NothingWritten::InputLeftOut
        | NothingWritten::HeldOnChain => json!([]),
    };
    let mut version_body = body(Some(declared), &nodes);
    // One edge leaves an output the command kind does not declare, the other enters an input it
    // does not declare.
    if let NothingWritten::HandleUndeclared = case {
        version_body["edges"] = json!([
            {
                "id": "from-undeclared", "source": "shell-a", "sourceHandle": "outputs/main/4",
                "target": "shell-b", "targetHandle": "inputs/main/0"
            },
            {
                "id": "into-undeclared", "source": "shell-a", "sourceHandle": "outputs/main/0",
                "target": "shell-b", "targetHandle": "inputs/main/1"
            },
        ]);
    }
    let fixture = Fixture::new(&version_body, session, WorkflowChainAskAfterRuns::new(25)).await;
    let input = match case {
        NothingWritten::InputLeftOut => Vec::new(),
        NothingWritten::UnknownSession
        | NothingWritten::UnknownVersion
        | NothingWritten::ProjectOnProjectSession
        | NothingWritten::BindingRefused
        | NothingWritten::RepositoryRequired
        | NothingWritten::ProviderRequired
        | NothingWritten::NodeKindUnavailable
        | NothingWritten::HandleUndeclared => vec![item(json!({ "ticket": "T-1" }))],
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
    if let NothingWritten::ProjectOnProjectSession = case {
        request.project_id = Some(ProjectId::new(MOUNT_ID).expect("the project's id"));
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
        NothingWritten::ProjectOnProjectSession => {
            let refusal = refusal(outcome.expect_err("the start is refused"));
            assert_eq!(
                refusal.code,
                RefusalCode::WorkflowRunProjectOnProjectSession
            );
        }
        NothingWritten::BindingRefused => {
            assert!(matches!(outcome, Err(WorkflowRunStartError::Binding(_))));
        }
        NothingWritten::InputLeftOut => {
            let refusal = refusal(outcome.expect_err("the start is refused"));
            assert_eq!(refusal.code, RefusalCode::WorkflowRunInputRequired);
            assert_eq!(
                refusal.detail.map(|detail| detail["inputNames"].clone()),
                Some(json!(["ticket"]))
            );
        }
        NothingWritten::RepositoryRequired => {
            let refusal = refusal(outcome.expect_err("the start is refused"));
            assert_eq!(refusal.code, RefusalCode::WorkflowRunRepositoryRequired);
            assert_eq!(
                refusal.detail.map(|detail| detail["nodeIds"].clone()),
                Some(json!(["git"]))
            );
        }
        NothingWritten::ProviderRequired => {
            let refusal = refusal(outcome.expect_err("the start is refused"));
            assert_eq!(refusal.code, RefusalCode::WorkflowRunProviderRequired);
            assert_eq!(
                refusal.detail.map(|detail| detail["nodeIds"].clone()),
                Some(json!(["shell"]))
            );
        }
        NothingWritten::NodeKindUnavailable => {
            let refusal = refusal(outcome.expect_err("the start is refused"));
            assert_eq!(refusal.code, RefusalCode::WorkflowRunNodeKindUnavailable);
            assert_eq!(
                refusal.detail.map(|detail| Value::Object(*detail)),
                Some(json!({ "nodeIds": ["gone", "shell-later"] }))
            );
        }
        NothingWritten::HandleUndeclared => {
            let refusal = refusal(outcome.expect_err("the start is refused"));
            assert_eq!(refusal.code, RefusalCode::WorkflowRunHandleUndeclared);
            assert_eq!(
                refusal.detail.map(|detail| Value::Object(*detail)),
                Some(json!({
                    "nodeIds": ["shell-a", "shell-b"],
                    "handles": ["outputs/main/4", "inputs/main/1"]
                }))
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
        &body(Some(declared), &json!([])),
        TestSession::WithoutFolder,
        WorkflowChainAskAfterRuns::new(25),
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
    assert!(!fixture.starter.recorder.has_sequence(held_run_id));
}
