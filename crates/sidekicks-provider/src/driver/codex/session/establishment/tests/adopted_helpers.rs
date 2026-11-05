//! The helpers an adopted conversation holds, reopened parents first and answered from their
//! newest turn, a turn Codex listed over ending its helper's child run as the session opens.

use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::run::subagent::SubagentId;

use super::adoption::{
    ADOPTED_THREAD, Adoption, AdoptionScript, CUT_TURN, HelperScript, ROOT_TURN, adopt, lead_run,
    page_turn,
};
use crate::driver::codex::session::test_fixture::TestCodexSession;
use crate::driver::session_control::{LiveRunResume, ProviderTurnAnswer};
use crate::driver::test_registry::new_run_id;
use crate::run::delivery::LateAppendableRow;
use crate::run::state_entry::RunStateEntry;
use crate::usage_delta_accountant::UsageAxisCounts;

/// The helpers' newest turn.
pub(super) const HELPER_TURN: &str = "turn-helper";

// A running helper on its conversation `thread_id`, started beneath `parent_run_id`.
pub(super) fn helper_run(run_id: RunId, parent_run_id: RunId, thread_id: &str) -> LiveRunResume {
    LiveRunResume {
        run_id,
        parent_run_id: Some(parent_run_id),
        open_turns: Vec::new(),
        subagent_id: Some(SubagentId::new(thread_id.to_owned()).expect("a helper id")),
        is_stopping: false,
        run_state: RunState::Running,
    }
}

// The helper `thread_id` held loaded, its resume's page holding its newest turn at `status`.
pub(super) fn loaded(thread_id: &'static str, status: &str) -> HelperScript {
    HelperScript {
        thread_id,
        is_loaded: true,
        resume_page: json!([page_turn(HELPER_TURN, status, HELPER_TURN)]),
        listed_turns: json!([]),
    }
}

// The helper `thread_id` held unloaded, its newest listed turn at `status`.
pub(super) fn unloaded(thread_id: &'static str, status: &str) -> HelperScript {
    HelperScript {
        thread_id,
        is_loaded: false,
        resume_page: json!([]),
        listed_turns: json!([page_turn(HELPER_TURN, status, HELPER_TURN)]),
    }
}

// The helper `thread_id` held loaded and running its newest turn, its resume refused as Codex
// refuses a helper whose parent is not loaded.
fn refused(thread_id: &'static str) -> HelperScript {
    HelperScript {
        thread_id,
        is_loaded: true,
        resume_page: json!({"error": {
            "code": -32600,
            "message": "cannot resume multi-agent v2 child: parent is not loaded; resume the \
                        parent first",
        }}),
        listed_turns: json!([page_turn(HELPER_TURN, "inProgress", HELPER_TURN)]),
    }
}

// Adopts the conversation with its lead running its turn on the loaded conversation, `helpers`
// named in `live_runs` after it, the service answering for each as `scripts` says.
pub(super) async fn adopt_with_helpers(
    session: &mut TestCodexSession,
    live_runs: Vec<LiveRunResume>,
    scripts: Vec<HelperScript>,
) -> Adoption {
    let mut script = AdoptionScript::loaded_active(
        json!([page_turn(CUT_TURN, "inProgress", ROOT_TURN)]),
        page_turn(CUT_TURN, "inProgress", ROOT_TURN),
    );
    script.helpers = scripts;
    adopt(session, live_runs, script).await
}

// Each helper beneath a running lead is answered from its newest turn: a loaded one is reopened
// after the lead with no turns and the newest-turn page, an unloaded one only listed. A loaded
// helper whose turn runs still runs, with its run routed to its conversation; one whose turn is
// over ended, and so does an unloaded one, each child run ending completed with its
// `subagent.completed` row as the session opens; an unloaded one whose turn reads running is
// gone, as is one whose reopen Codex refuses, whose running turn is interrupted and which leaves
// the next helper reopened. Killed by no reopen (no helper resume), by every loaded helper read
// running (the loaded completed case), by the unloaded read skipped (the unloaded completed case
// reads gone), by no route bound, by the owed end not routed (no end at the open) or read as the
// daemon's interrupt, by a refusal that stops the reads, and by a refused helper left running (no
// interrupt).
#[rstest]
#[case::loaded_running(vec![
    (loaded("thread-helper-a", "inProgress"), ProviderTurnAnswer::StillRunning),
])]
#[case::loaded_completed(vec![
    (loaded("thread-helper-a", "completed"), ProviderTurnAnswer::EndedByProvider),
])]
#[case::unloaded_completed(vec![
    (unloaded("thread-helper-a", "completed"), ProviderTurnAnswer::EndedByProvider),
])]
#[case::unloaded_in_progress(vec![
    (unloaded("thread-helper-a", "inProgress"), ProviderTurnAnswer::Gone),
])]
#[case::resume_refused(vec![
    (refused("thread-helper-a"), ProviderTurnAnswer::Gone),
    (loaded("thread-helper-b", "inProgress"), ProviderTurnAnswer::StillRunning),
])]
#[tokio::test(start_paused = true)]
async fn an_adopted_helper_is_answered_from_its_newest_turn(
    #[case] helpers: Vec<(HelperScript, ProviderTurnAnswer)>,
) {
    let mut session = TestCodexSession::start().await;
    let lead_run_id = new_run_id();
    let mut live_runs = vec![lead_run(lead_run_id, RunState::Running)];
    let mut expected = Vec::new();
    let mut scripts = Vec::new();
    let mut expected_resumes = vec![json!(ADOPTED_THREAD)];
    let mut expected_interrupts = Vec::new();
    for (script, answer) in helpers {
        let run_id = new_run_id();
        live_runs.push(helper_run(run_id, lead_run_id, script.thread_id));
        if script.is_loaded {
            expected_resumes.push(json!(script.thread_id));
        }
        if script.resume_page.get("error").is_some() {
            expected_interrupts.push(json!({
                "threadId": script.thread_id,
                "turnId": HELPER_TURN,
            }));
        }
        expected.push((run_id, answer));
        scripts.push(script);
    }

    let adoption = adopt_with_helpers(&mut session, live_runs, scripts).await;

    let resumed_threads: Vec<Value> = adoption
        .resumes
        .iter()
        .map(|resume| resume["params"]["threadId"].clone())
        .collect();
    assert_eq!(resumed_threads, expected_resumes);
    let interrupts: Vec<Value> = adoption
        .interrupts
        .iter()
        .map(|interrupt| interrupt["params"].clone())
        .collect();
    assert_eq!(interrupts, expected_interrupts);
    for resume in &adoption.resumes[1..] {
        assert_eq!(resume["params"]["excludeTurns"], true);
        assert_eq!(
            resume["params"]["initialTurnsPage"],
            json!({"limit": 1, "sortDirection": "desc", "itemsView": "notLoaded"})
        );
    }
    let run_routes = &session.task.run_routes;
    for (run_id, answer) in &expected {
        assert_eq!(adoption.answer_of(*run_id), *answer);
        assert_eq!(
            run_routes.has_helper_route(*run_id),
            *answer != ProviderTurnAnswer::Gone,
            "the helper's run is routed exactly when it is bound again"
        );
    }

    let folder = tempfile::tempdir().expect("the test makes a folder");
    let established = adoption.established.expect("the session is established");
    session
        .establishment(folder.path())
        .open(established, UsageAxisCounts::default())
        .await;

    let deliveries = session.engine.deliveries();
    for (run_id, answer) in &expected {
        let completed_rows = deliveries
            .iter()
            .filter(|delivery| {
                matches!(
                    &delivery.row,
                    Some(LateAppendableRow::AgentSubagentCompleted(row))
                        if row.child_run_id == Some(*run_id)
                )
            })
            .count();
        if *answer == ProviderTurnAnswer::EndedByProvider {
            assert_eq!(
                session.engine.moves_of_run(*run_id),
                vec![RunStateEntry::Completed {
                    intended_close: None
                }]
            );
            assert_eq!(completed_rows, 1);
            assert_eq!(
                session.engine.daemon_interrupt_ends_of_run(*run_id),
                [false]
            );
        } else {
            assert_eq!(session.engine.moves_of_run(*run_id), Vec::new());
            assert_eq!(completed_rows, 0);
        }
    }
}

// Codex reopens a helper only once its parent is loaded, so a helper beneath another is reopened
// after it even when the log names it first. Killed by the helpers reopened in the order the log
// names them.
#[tokio::test(start_paused = true)]
async fn adopted_helpers_reopen_parents_first() {
    let mut session = TestCodexSession::start().await;
    let lead_run_id = new_run_id();
    let parent_run_id = new_run_id();
    let child_run_id = new_run_id();
    let live_runs = vec![
        lead_run(lead_run_id, RunState::Running),
        helper_run(child_run_id, parent_run_id, "thread-helper-b"),
        helper_run(parent_run_id, lead_run_id, "thread-helper-a"),
    ];

    let adoption = adopt_with_helpers(
        &mut session,
        live_runs,
        vec![
            loaded("thread-helper-b", "inProgress"),
            loaded("thread-helper-a", "inProgress"),
        ],
    )
    .await;

    let resumed_threads: Vec<Value> = adoption
        .resumes
        .iter()
        .map(|resume| resume["params"]["threadId"].clone())
        .collect();
    assert_eq!(
        resumed_threads,
        vec![
            json!(ADOPTED_THREAD),
            json!("thread-helper-a"),
            json!("thread-helper-b")
        ]
    );
}
