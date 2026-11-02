use std::sync::Arc;

use serde_json::json;
use serde_json::value::RawValue;
use sidekicks_contracts::run::subagent::SubagentId;
use sidekicks_contracts::wire::text::FreeFormText;
use tokio_util::sync::CancellationToken;

use super::ChildRunLookup;
use crate::driver::codex::delivery::rows::test_row_run;
use crate::driver::codex::hooks::server::{
    CodexHookAnswer, CodexHookAnswerer, CodexHookEvent, CodexHookInput,
};
use crate::driver::codex::service::supervisor::routing::CodexHelperNames;
use crate::driver::codex::session::inbound::CodexSessionInbound;
use crate::driver::codex::session::test_fixture::{TEST_THREAD, TestCodexSession};
use crate::driver::run_control::HelperStopReason;
use crate::run::delivery::{ChildRunSubagent, RunSetupRefusal};

/// A helper's own conversation, which is its id.
const HELPER_THREAD: &str = "helper-thread";

/// The turn the helper is running as its run is refused.
const HELPER_TURN: &str = "helper-turn";

// A helper whose run the daemon refused stays bound to that ended run, has the turn it is running
// interrupted on its own conversation, and has its next tool call denied with the refusal's
// sentence. Killed by a refusal that stops nothing, by one that leaves the helper with no run, so
// its rows have no owner, and by a stop that drops the refusal's reason.
#[tokio::test]
async fn a_refused_helpers_running_turn_is_interrupted() {
    let mut session = TestCodexSession::start().await;
    let delivery = Arc::clone(&session.task.calls.forks.delivery);
    let refusal = RunSetupRefusal {
        cause: "the test's gate refuses the run".to_owned(),
        is_posture_rejection: true,
    };
    let refused = session.engine.refuse_next_child_run(refusal.clone());
    let mut lead = test_row_run();
    lead.session_id = session.task.record.session_id;
    session
        .task
        .record
        .note_spawn_call(TEST_THREAD, "call-1", &lead);

    delivery
        .start_child(
            &mut session.task.record,
            HELPER_THREAD,
            TEST_THREAD,
            HELPER_THREAD,
            CodexHelperNames {
                name: None,
                role: None,
                provider_path: None,
            },
        )
        .await;

    let list = session.scripted.script.next_sent().await;
    assert_eq!(list["method"], "thread/turns/list");
    assert_eq!(list["params"]["threadId"], HELPER_THREAD);
    session.scripted.script.send(&json!({
        "jsonrpc": "2.0",
        "id": list["id"],
        "result": {"data": [{"id": HELPER_TURN, "status": "inProgress"}]},
    }));
    let interrupt = session.scripted.script.next_sent().await;
    assert_eq!(interrupt["method"], "turn/interrupt");
    assert_eq!(
        interrupt["params"],
        json!({"threadId": HELPER_THREAD, "turnId": HELPER_TURN})
    );
    session.scripted.script.answer(&interrupt, &json!({}));
    let ChildRunLookup::Bound { run, .. } = session.task.record.child_run_on(HELPER_THREAD) else {
        panic!("the refused helper keeps its ended run");
    };
    assert_eq!(run.run_id, refused);
    let helper_call = CodexHookInput {
        event: CodexHookEvent::PreToolUse,
        thread_id: HELPER_THREAD.to_owned(),
        session_id: None,
        turn_id: None,
        tool_name: None,
        tool_use_id: None,
        tool_input: None,
        tool_response: None,
        cwd: None,
    };
    let answer = delivery
        .dependencies
        .stopped_helpers
        .answer(&helper_call, &CancellationToken::new())
        .await
        .expect("the stopped helpers never fail");
    assert_eq!(
        answer,
        Some(CodexHookAnswer::Deny {
            reason: HelperStopReason::SetupRefused { refusal }.sentence(),
        })
    );
}

// A spawned helper's `thread/started` starts its child run beneath the run whose spawn call
// started it, with the name, role and path Codex gives it, while a compaction conversation
// announced first starts none and leaves the spawn call to the helper. Killed by a helper kind
// read from a member the thread does not carry (no child run), by every `subAgent` arm counted a
// helper (the compaction's child run takes the spawn call), by names dropped or swapped, and by a
// path read from any member but the spawn's `agent_path`.
#[tokio::test]
async fn a_spawned_helper_starts_its_child_run_as_codex_names_it() {
    let mut session = TestCodexSession::start().await;
    let mut lead = test_row_run();
    lead.session_id = session.task.record.session_id;
    session
        .task
        .record
        .note_spawn_call(TEST_THREAD, "call-1", &lead);
    let spawned = json!({"thread": {
        "id": HELPER_THREAD,
        "parentThreadId": TEST_THREAD,
        "source": {"subAgent": {"thread_spawn": {
            "parent_thread_id": TEST_THREAD,
            "depth": 1,
            "agent_path": "/root/scout",
            "agent_nickname": "Scout",
            "agent_role": "explorer",
        }}},
        "agentNickname": "Scout",
        "agentRole": "explorer",
    }});
    let compaction = json!({"thread": {
        "id": "compact-thread",
        "parentThreadId": TEST_THREAD,
        "source": {"subAgent": "compact"},
    }});

    for params in [compaction, spawned] {
        session
            .task
            .handle(CodexSessionInbound::Frame {
                method: "thread/started".to_owned(),
                params: RawValue::from_string(params.to_string()).expect("the params are JSON"),
            })
            .await;
    }

    let child_runs: Vec<_> = session
        .engine
        .deliveries()
        .into_iter()
        .filter(|delivery| delivery.kind == "childRun")
        .collect();
    assert_eq!(
        child_runs.len(),
        1,
        "only the spawned helper starts a child run"
    );
    assert_eq!(child_runs[0].parent_run_id, Some(lead.run_id));
    let handle = |text: &str| Some(FreeFormText::new(text.to_owned()).expect("a test name fits"));
    assert_eq!(
        child_runs[0].subagent,
        Some(ChildRunSubagent {
            subagent_id: SubagentId::new(HELPER_THREAD.to_owned()).expect("a helper id"),
            parent_subagent_id: None,
            name: handle("Scout"),
            role: handle("explorer"),
            provider_path: handle("/root/scout"),
            start_call_id: None,
        })
    );
}
