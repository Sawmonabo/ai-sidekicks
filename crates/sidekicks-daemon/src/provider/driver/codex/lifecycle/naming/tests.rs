use std::sync::Arc;

use rstest::rstest;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::{TitleConnectionEvents, TitleRequest, draw_title};
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

// A title pass over a scripted connection, run on its own task, and the script.
fn start_pass() -> (
    tokio::task::JoinHandle<Result<Option<String>, CodexError>>,
    ScriptedService,
) {
    let (sender, mut frames) = mpsc::unbounded_channel();
    let (connection, script) = connect_scripted_service(
        MESSAGE_LIMIT,
        CodexConnectionHandlers {
            events: Arc::new(TitleConnectionEvents { frames: sender }),
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
                prompt: "Name this.",
            },
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
// start, by starting it before the config read, and by dropping the answer's 8 KiB cap: the long
// answer would name the session.
#[rstest]
#[case::a_short_answer("A short title".to_owned(), Some("A short title"))]
#[case::an_answer_past_the_cap("x".repeat(9 * 1024), None)]
#[tokio::test(start_paused = true)]
async fn a_title_pass_reads_the_config_then_starts_locked_down_and_reads_a_capped_answer(
    #[case] title: String,
    #[case] named: Option<&str>,
) {
    let (pass, mut script) = start_pass();
    answer_config_read(&mut script).await;

    let started = script.next_sent().await;
    assert_eq!(started["method"], "thread/start");
    let params = &started["params"];
    assert_eq!(params["config"], locked_down_config());
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
    script.answer(
        &started,
        &json!({
            "thread": {"id": TITLE_THREAD, "sessionId": "codex-session"},
            "sandbox": {"type": "readOnly", "networkAccess": false},
        }),
    );
    let turn = script.next_sent().await;
    assert_eq!(turn["method"], "turn/start");
    assert_eq!(turn["params"]["threadId"], TITLE_THREAD);
    script.answer(
        &turn,
        &json!({"turn": {"id": "title-turn", "items": [], "status": "inProgress"}}),
    );
    let answer = json!({"title": title}).to_string();
    script.send(&json!({
        "jsonrpc": "2.0",
        "method": "item/completed",
        "params": {
            "threadId": TITLE_THREAD,
            "turnId": "title-turn",
            "item": {"type": "agentMessage", "id": "item-1", "text": answer},
        },
    }));
    script.send(&json!({
        "jsonrpc": "2.0",
        "method": "turn/completed",
        "params": {
            "threadId": TITLE_THREAD,
            "turn": {"id": "title-turn", "items": [], "status": "completed"},
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
    let (pass, mut script) = start_pass();
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
            let started = script.next_sent().await;
            assert_eq!(started["method"], "thread/start");
            script.answer(
                &started,
                &json!({
                    "thread": {"id": TITLE_THREAD, "sessionId": "codex-session"},
                    "sandbox": {"type": "workspaceWrite", "networkAccess": false},
                }),
            );
        }
    }

    assert!(pass.await.expect("the pass's task ends").is_err());
    assert!(
        script.sent.try_recv().is_err(),
        "the pass sent nothing more"
    );
}
