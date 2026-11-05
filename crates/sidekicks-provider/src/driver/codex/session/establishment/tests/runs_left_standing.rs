//! The lead runs an adoption by handle leaves as they stand, continuing no turn: a cut turn listed
//! over or stopped, a lead pausing, held on the person or for a helper, and a joined service's.

use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::run::subagent::SubagentId;

use super::adoption::{AdoptionScript, CONTINUATION_TURN, CUT_TURN, adopt, lead_run, turn_ends};
use crate::driver::codex::service::supervisor::test_service::{
    start_scripted_codex_service, start_scripted_joined_service,
};
use crate::driver::codex::session::test_fixture::TestCodexSession;
use crate::driver::session_control::{LiveRunResume, ProviderTurnAnswer};
use crate::driver::test_registry::new_run_id;

// No turn continues a run the rows leave as it stands: a cut turn listed over, one stopped with its
// end time, a lead pausing, a lead waiting on the person, a lead held for a helper at any depth
// beneath it, a paused lead with no open turn, and the same listing on a service the daemon only
// joined, where Codex continues its own. No end is written; a lead held on the person answers
// `Waiting` and a cut pausing lead `Gone`, both with the cut turn unbound, as is every held helper
// `Waiting`; the rest answer as Codex's listing has it. Every lead keeps its deliveries' binding.
// Killed by the held arm dropped (`Waiting` reads `EndedByProvider`), by the pausing arm dropped
// (`Gone` reads `EndedByProvider`), by the cut turn bound for a held or pausing lead, by the
// binding kept only with a bound turn (the turnless cases), by the direct-child helper read kept
// (the grandchild case sends a `turn/start`), and by a held helper answered `Gone`.
#[rstest]
#[case::listed_completed(
    json!([{"id": CUT_TURN, "items": [], "status": "completed", "completedAt": 1_767_000_000}]),
    RunState::Running,
    true,
    vec![],
    false,
    ProviderTurnAnswer::EndedByProvider,
    true
)]
#[case::interrupted_with_its_end_time(
    json!([{"id": CUT_TURN, "items": [], "status": "interrupted", "completedAt": 1_767_000_000}]),
    RunState::Running,
    true,
    vec![],
    false,
    ProviderTurnAnswer::EndedByProvider,
    true
)]
#[case::pausing(
    json!([{"id": CUT_TURN, "items": [], "status": "interrupted"}]),
    RunState::Pausing,
    true,
    vec![],
    false,
    ProviderTurnAnswer::Gone,
    false
)]
#[case::waiting_for_approval(
    json!([{"id": CUT_TURN, "items": [], "status": "interrupted"}]),
    RunState::WaitingForApproval,
    true,
    vec![],
    false,
    ProviderTurnAnswer::Waiting,
    false
)]
#[case::helper_paused(
    json!([{"id": CUT_TURN, "items": [], "status": "interrupted"}]),
    RunState::Running,
    true,
    vec![RunState::Paused],
    false,
    ProviderTurnAnswer::Waiting,
    false
)]
#[case::helper_waiting_beneath_a_running_helper(
    json!([{"id": CUT_TURN, "items": [], "status": "interrupted"}]),
    RunState::Running,
    true,
    vec![RunState::Running, RunState::WaitingForInput],
    false,
    ProviderTurnAnswer::Waiting,
    false
)]
#[case::paused_with_no_open_turn(
    json!([]),
    RunState::Paused,
    false,
    vec![],
    false,
    ProviderTurnAnswer::Gone,
    false
)]
#[case::joined_service(
    json!([{"id": CUT_TURN, "items": [], "status": "interrupted"}]),
    RunState::Running,
    true,
    vec![],
    true,
    ProviderTurnAnswer::EndedByProvider,
    true
)]
#[tokio::test(start_paused = true)]
async fn no_turn_continues_a_run_the_rows_leave_as_it_stands(
    #[case] listed_turns: Value,
    #[case] lead_state: RunState,
    #[case] is_turn_open: bool,
    #[case] helper_states: Vec<RunState>,
    #[case] is_joined: bool,
    #[case] lead_answer: ProviderTurnAnswer,
    #[case] is_cut_turn_bound: bool,
) {
    let scripted = if is_joined {
        start_scripted_joined_service()
    } else {
        start_scripted_codex_service()
    };
    let mut session = TestCodexSession::start_on(scripted).await;
    let run_id = new_run_id();
    let mut lead = lead_run(run_id, lead_state);
    if !is_turn_open {
        lead.open_turns.clear();
    }
    let mut live_runs = vec![lead];
    // Each helper beneath the one before, the first beneath the lead.
    let mut helper_run_ids = Vec::new();
    for (depth, helper_state) in helper_states.into_iter().enumerate() {
        let helper_run_id = new_run_id();
        live_runs.push(LiveRunResume {
            run_id: helper_run_id,
            parent_run_id: Some(helper_run_ids.last().copied().unwrap_or(run_id)),
            open_turns: Vec::new(),
            subagent_id: Some(
                SubagentId::new(format!("thread-helper-{depth}")).expect("a helper id"),
            ),
            is_stopping: false,
            run_state: helper_state,
        });
        helper_run_ids.push(helper_run_id);
    }

    let adoption = adopt(
        &mut session,
        live_runs,
        AdoptionScript::unloaded(
            listed_turns,
            json!({"turn": {"id": CONTINUATION_TURN, "items": [], "status": "inProgress"}}),
        ),
    )
    .await;

    assert_eq!(adoption.turn_starts, Vec::<Value>::new());
    assert_eq!(adoption.answer_of(run_id), lead_answer);
    for helper_run_id in &helper_run_ids {
        assert_eq!(
            adoption.answer_of(*helper_run_id),
            ProviderTurnAnswer::Waiting
        );
    }
    assert_eq!(turn_ends(&session.engine.calls()), (Vec::new(), Vec::new()));
    let established = adoption.established.expect("the session is established");
    assert_eq!(
        established.record.active_turn_run(CUT_TURN),
        is_cut_turn_bound.then_some(run_id)
    );
    assert!(session.task.run_routes.binding_for(run_id).is_some());
}
