#[cfg(unix)]
mod one_shot;
mod rest;
#[cfg(unix)]
mod spent_deadline;

use rstest::rstest;
use serde_json::{Value, json};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use super::{CODEX_NAMING_DEADLINE, TitleRequest, draw_title};
use crate::provider::driver::codex::session::detached_conversation::CodexDetachedFrames;
use crate::provider::driver::codex::session::errors::CodexError;
use crate::provider::driver::codex::transport::connection::CodexConnectionHandlers;
use crate::provider::driver::codex::transport::connection::scripted_service::{
    ScriptedService, connect_scripted_service,
};

/// The largest message the scripted connection takes, far above any a test sends.
const MESSAGE_LIMIT: usize = 1 << 20;

/// The session's folder, which the title conversation is read and started under.
const FOLDER: &str = "/work/repository";

/// The title conversation the scripted service starts.
const TITLE_THREAD: &str = "title-thread";

/// The title conversation's turn.
const TITLE_TURN: &str = "title-turn";

/// The session's own model.
const SESSION_MODEL: &str = "gpt-5";

// A title pass over a scripted connection, run on its own task until `cancel` fires, and the
// script.
fn start_pass(
    cancel: CancellationToken,
) -> (
    tokio::task::JoinHandle<Result<Option<String>, CodexError>>,
    ScriptedService,
) {
    let (events, mut frames) = CodexDetachedFrames::new();
    let (connection, script) = connect_scripted_service(
        MESSAGE_LIMIT,
        CodexConnectionHandlers {
            events,
            responder: None,
        },
    );
    let pass = tokio::spawn(async move {
        draw_title(
            &connection,
            &mut frames,
            &TitleRequest {
                thread_id: "thread-1",
                is_joined: false,
                working_directory: FOLDER,
                session_model: SESSION_MODEL,
                prompt: "Name this.",
            },
            &cancel,
            Instant::now() + CODEX_NAMING_DEADLINE,
        )
        .await
    });
    (pass, script)
}

// The `config/read` the pass sends first, answered with two MCP servers, one named with a dot.
async fn answer_config_read(script: &mut ScriptedService) {
    let read = script.next_sent().await;
    assert_eq!(read["method"], "config/read");
    assert_eq!(
        read["params"],
        json!({"cwd": FOLDER, "includeLayers": false})
    );
    script.answer(
        &read,
        &json!({
            "config": {
                "model": "gpt-5",
                "mcp_servers": {"docs": {"command": "docs"}, "team.search": {"url": "http://x"}},
            },
            "origins": {},
        }),
    );
}

// The catalog read the pass sends next, answered with `models`.
async fn answer_model_list(script: &mut ScriptedService, models: &[&str]) {
    let listed = script.next_sent().await;
    assert_eq!(listed["method"], "model/list");
    let rows: Vec<Value> = models
        .iter()
        .map(|id| json!({"id": id, "displayName": id, "hidden": false}))
        .collect();
    script.answer(&listed, &json!({"data": rows, "nextCursor": null}));
}

// The start of the title conversation answered as running under `sandbox_type`, and the start
// as sent.
async fn answer_thread_start(script: &mut ScriptedService, sandbox_type: &str) -> Value {
    let started = script.next_sent().await;
    assert_eq!(started["method"], "thread/start");
    script.answer(
        &started,
        &json!({
            "thread": {"id": TITLE_THREAD, "sessionId": "codex-session"},
            "sandbox": {"type": sandbox_type, "networkAccess": false},
        }),
    );
    started
}

// The `turn/start` the pass sends on the title conversation, unanswered.
async fn next_turn_start(script: &mut ScriptedService) -> Value {
    let turn = script.next_sent().await;
    assert_eq!(turn["method"], "turn/start");
    assert_eq!(turn["params"]["threadId"], TITLE_THREAD);
    turn
}

fn turn_reply() -> Value {
    json!({"turn": {"id": TITLE_TURN, "items": [], "status": "inProgress"}})
}

// Every config key Codex's own terminal sets on a throwaway structured conversation, with the two
// servers the config read named disabled.
fn locked_down_config() -> Value {
    json!({
        "features.apps": false,
        "features.code_mode": false,
        "features.code_mode_only": false,
        "features.context_management": false,
        "features.current_time_reminder": false,
        "features.deferred_executor": false,
        "features.enable_fanout": false,
        "features.goals": false,
        "features.hooks": false,
        "features.image_generation": false,
        "features.memories": false,
        "features.multi_agent": false,
        "features.multi_agent_v2": false,
        "features.plugins": false,
        "features.request_permissions_tool": false,
        "features.shell_snapshot": false,
        "features.shell_tool": false,
        "features.standalone_web_search": false,
        "features.token_budget": false,
        "features.tool_suggest": false,
        "features.unified_exec": false,
        "features.view_image": false,
        "cloud.skills.enabled": false,
        "skills.include_instructions": false,
        "tools.experimental_request_user_input.enabled": false,
        "tools.update_plan.enabled": false,
        "web_search": "disabled",
        "default_permissions": ":read-only",
        "mcp_servers": {"docs": {"enabled": false}, "team.search": {"enabled": false}},
    })
}

// Killed by dropping any one key of the title conversation's config or any one field of its
// start, by starting it before the config read, by dropping the answer's 8 KiB cap (the long
// answer would name the session), and by dropping the fallback to the session's model or the small
// model where the catalog offers it.
#[rstest]
#[case::a_short_answer_on_the_offered_title_model(
    "A short title".to_owned(),
    &["gpt-5", "gpt-5.6-luna"],
    "gpt-5.6-luna",
    Some("low"),
    Some("A short title")
)]
#[case::an_answer_past_the_cap_on_the_session_model(
    "x".repeat(9 * 1024),
    &["gpt-5"],
    SESSION_MODEL,
    None,
    None
)]
#[tokio::test(start_paused = true)]
async fn a_title_pass_reads_the_config_then_starts_locked_down_and_reads_a_capped_answer(
    #[case] title: String,
    #[case] catalog: &[&str],
    #[case] model: &str,
    #[case] effort: Option<&str>,
    #[case] named: Option<&str>,
) {
    let (pass, mut script) = start_pass(CancellationToken::new());
    answer_config_read(&mut script).await;
    answer_model_list(&mut script, catalog).await;

    let started = answer_thread_start(&mut script, "readOnly").await;
    let params = &started["params"];
    assert_eq!(params["config"], locked_down_config());
    assert_eq!(params["model"], model);
    assert_eq!(params["cwd"], FOLDER);
    assert_eq!(params["ephemeral"], true);
    assert_eq!(params["sandbox"], "read-only");
    assert_eq!(params["approvalPolicy"], "never");
    assert_eq!(params["threadSource"], "thread_title");
    for empty in [
        "runtimeWorkspaceRoots",
        "environments",
        "dynamicTools",
        "selectedCapabilityRoots",
    ] {
        assert_eq!(params[empty], json!([]), "{empty} is sent empty");
    }
    let turn = next_turn_start(&mut script).await;
    assert_eq!(turn["params"].get("effort").and_then(Value::as_str), effort);
    script.answer(&turn, &turn_reply());
    let answer = json!({"title": title}).to_string();
    script.send(&json!({
        "jsonrpc": "2.0",
        "method": "item/completed",
        "params": {
            "threadId": TITLE_THREAD,
            "turnId": TITLE_TURN,
            "item": {"type": "agentMessage", "id": "item-1", "text": answer},
        },
    }));
    script.send(&json!({
        "jsonrpc": "2.0",
        "method": "turn/completed",
        "params": {
            "threadId": TITLE_THREAD,
            "turn": {"id": TITLE_TURN, "items": [], "status": "completed"},
        },
    }));

    let drawn = pass.await.expect("the pass's task ends");
    assert_eq!(drawn.expect("the pass ran").as_deref(), named);
}

/// How a title pass's start is refused before any turn runs.
enum Refusal {
    /// The config naming the MCP servers could not be read.
    UnreadConfig,
    /// The conversation started under another sandbox.
    WritableSandbox,
}

// Killed by reading past a failed `config/read`, and by dropping the check of the start's sandbox:
// either would start a turn on a conversation not known to be locked down.
#[rstest]
#[case::an_unread_config(Refusal::UnreadConfig)]
#[case::a_writable_sandbox(Refusal::WritableSandbox)]
#[tokio::test(start_paused = true)]
async fn a_title_pass_that_cannot_name_its_servers_or_runs_writable_starts_no_turn(
    #[case] refusal: Refusal,
) {
    let (pass, mut script) = start_pass(CancellationToken::new());
    match refusal {
        Refusal::UnreadConfig => {
            let read = script.next_sent().await;
            assert_eq!(read["method"], "config/read");
            script.send(&json!({
                "jsonrpc": "2.0",
                "id": read["id"],
                "error": {"code": -32603, "message": "the config could not be loaded"},
            }));
        }
        Refusal::WritableSandbox => {
            answer_config_read(&mut script).await;
            answer_model_list(&mut script, &[SESSION_MODEL]).await;
            answer_thread_start(&mut script, "workspaceWrite").await;
        }
    }

    assert!(pass.await.expect("the pass's task ends").is_err());
    assert!(
        script.sent.try_recv().is_err(),
        "the pass sent nothing more"
    );
}

// Killed by dropping the interrupt, and by not waiting for the start's answer to name the turn:
// the pass would end with its turn still running. Its deadline stops the turn the same way, which
// the spent-deadline test proves.
#[tokio::test(start_paused = true)]
async fn a_title_pass_canceled_during_its_turns_start_interrupts_the_turn() {
    let cancel = CancellationToken::new();
    let (pass, mut script) = start_pass(cancel.clone());
    answer_config_read(&mut script).await;
    answer_model_list(&mut script, &[SESSION_MODEL]).await;
    answer_thread_start(&mut script, "readOnly").await;
    let turn = next_turn_start(&mut script).await;
    cancel.cancel();
    // The pass takes the cancel while the start still waits for its answer.
    tokio::task::yield_now().await;
    script.answer(&turn, &turn_reply());

    let interrupt = script.next_sent().await;
    assert_eq!(interrupt["method"], "turn/interrupt");
    assert_eq!(
        interrupt["params"],
        json!({"threadId": TITLE_THREAD, "turnId": TITLE_TURN})
    );
    script.answer(&interrupt, &json!({}));
    let drawn = pass.await.expect("the pass's task ends");
    assert_eq!(drawn.expect("the pass ran"), None);
}
