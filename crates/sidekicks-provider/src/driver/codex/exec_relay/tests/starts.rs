//! A command's start through the relay: wrapped where a session's wrapper runs it, unwrapped with
//! no way to ask for a side question's copy, and its row ended at its process's end once its
//! service started again.

use std::path::Path;
use std::sync::Arc;

use serde_json::{Map, Value, json};
use sidekicks_contracts::command::CommandId;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_workspace::git::process::environment::NO_PROMPT_ENVIRONMENT;

use super::{
    CALL, COPY_THREAD, EXECUTOR_PROCESS, THREAD, command_id, exited, initialized_executor,
    relay_reporting_to, session_threads, wait_until,
};
use crate::command::running_set::unbound_running_command_sets;
use crate::driver::codex::exec_relay::RelayedThread;
use crate::driver::codex::exec_relay::start_rewrite::{WrappedStart, wrap_start};
use crate::driver::test_registry::{new_run_id, new_session_id};
use crate::port::running_command_publisher::{CommandStart, RunningCommandPublisher as _};

// A start the wrapper runs names the wrapper, the channel, the executor's process, the command's
// own name and its terminal ahead of its words, runs a login shell's line in a non-login shell,
// sends no name of its own on, and sends its git and ssh prompts to the askpass. Killed by a
// login shell left to run the person's profile over the composed environment.
#[test]
fn wraps_a_start_with_its_name_and_terminal() {
    let mut params: Map<String, Value> = serde_json::from_value(json!({
        "argv": ["/bin/zsh", "-lc", "git status"],
        "arg0": "zsh",
        "tty": true,
        "env": { "KEPT": "1" },
    }))
    .expect("params");
    let channel_environment = [("SIDEKICKS_CHANNEL".to_owned(), "/channel".to_owned())];

    wrap_start(
        &mut params,
        &WrappedStart {
            wrapper_program: Path::new("/wrapper"),
            askpass_program: Path::new("/askpass"),
            channel_folder: Path::new("/channel"),
            channel_environment: &channel_environment,
            executor_process_id: EXECUTOR_PROCESS,
        },
    );

    assert_eq!(
        params["argv"],
        json!([
            "/wrapper",
            "--conversation",
            "/channel",
            "--process",
            EXECUTOR_PROCESS,
            "--arg0",
            "zsh",
            "--tty",
            "--",
            "/bin/zsh",
            "-c",
            "git status"
        ])
    );
    assert_eq!(params["arg0"], Value::Null);
    assert_eq!(
        params["env"],
        json!({
            "KEPT": "1",
            "SIDEKICKS_CHANNEL": "/channel",
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_ASKPASS": "/askpass",
            "SSH_ASKPASS": "/askpass",
            "SSH_ASKPASS_REQUIRE": "force",
        })
    );
}

// A session's start runs under the wrapper even where it asks the executor for its own snapshot,
// which it then no longer asks for; a side question's copy's start runs unwrapped with the whole
// no-prompt environment and no askpass; a start the executor refuses is not kept. Killed by
// skipping the wrapper for a start that carries `shellSnapshot`, by wrapping a copy's start or
// giving it the askpass, by setting only git's terminal prompt off, and by keeping a refused start.
#[tokio::test]
async fn wraps_a_sessions_start_and_gives_a_copy_s_start_no_way_to_ask() {
    let folder = tempfile::tempdir().expect("a test folder");
    let session_id = new_session_id();
    let relay = relay_reporting_to(
        folder.path(),
        Some(unbound_running_command_sets()),
        session_threads(session_id),
    );
    let (executor, mut fake) = initialized_executor().await;
    relay.take_executor(Arc::clone(&executor));
    let start = |id: u64, thread: &str, call: &str, process: &str| {
        json!({ "id": id, "method": "process/start", "params": {
            "processId": process,
            "argv": ["/usr/bin/git", "fetch"],
            "cwd": "file:///tmp",
            "env": { "KEPT": "1" },
            "tty": false,
            "arg0": null,
            "shellSnapshot": {
                "scopeId": "scope-1",
                "shell": { "name": "bash", "path": "/bin/bash" },
            },
            "metadata": { "threadId": thread, "toolCallId": call },
        }})
        .to_string()
    };

    let session_start = tokio::spawn(Arc::clone(&relay).forward_process_start(
        Arc::clone(&executor),
        start(1, THREAD, CALL, EXECUTOR_PROCESS),
        EXECUTOR_PROCESS.to_owned(),
        true,
    ));
    let wrapped = fake.next_sent().await;
    let copy_start = tokio::spawn(Arc::clone(&relay).forward_process_start(
        Arc::clone(&executor),
        start(2, COPY_THREAD, "call-copy", "8-copy"),
        "8-copy".to_owned(),
        true,
    ));
    let unwrapped = fake.next_sent().await;
    fake.write(&json!({
        "id": unwrapped["id"],
        "error": { "code": -32603, "message": "spawn failed" },
    }))
    .await;
    copy_start.await.expect("the copy's start is passed on");

    let params = &wrapped["params"];
    assert_eq!(params["argv"][0], json!(folder.path().join("wrapper")));
    assert_eq!(params["argv"][4], EXECUTOR_PROCESS);
    assert!(params.get("shellSnapshot").is_none(), "{params}");
    assert_eq!(
        params["env"]["GIT_ASKPASS"],
        json!(folder.path().join("askpass"))
    );
    let params = &unwrapped["params"];
    assert_eq!(params["argv"], json!(["/usr/bin/git", "fetch"]));
    let environment = params["env"].as_object().expect("an environment");
    for (name, value) in NO_PROMPT_ENVIRONMENT {
        assert_eq!(environment[name], value, "{name}");
    }
    assert!(!environment.contains_key("SSH_ASKPASS"), "{environment:?}");
    let copy_call = CommandId::new("call-copy".to_owned()).expect("a call id");
    assert_eq!(relay.relayed_command(session_id, &copy_call), None);
    assert!(relay.relayed_command(session_id, &command_id()).is_some());
    session_start.abort();
}

// A command whose service was started again while it ran ends its row at its process's end,
// whether it ended before the new start or after it; one of the current start waits for its item.
// Killed by leaving every row to its item's end, or by forgetting a command that ended before the
// new start.
#[tokio::test]
async fn ends_the_row_of_a_former_service_starts_command_at_its_process_end() {
    let folder = tempfile::tempdir().expect("a test folder");
    // One session per command, so each one's rows read apart; each a side question's copy, whose
    // starts run unwrapped.
    let sessions = [new_session_id(), new_session_id(), new_session_id()];
    let sets = unbound_running_command_sets();
    let relay = relay_reporting_to(
        folder.path(),
        Some(Arc::clone(&sets)),
        Arc::new(move |thread_id: &str| {
            let index: usize = thread_id.strip_prefix("thread-")?.parse().ok()?;
            Some(RelayedThread {
                session_id: *sessions.get(index)?,
                is_side_question: true,
            })
        }),
    );
    let (executor, mut fake) = initialized_executor().await;
    relay.take_executor(Arc::clone(&executor));
    let run_id = new_run_id();
    let mut starts = Vec::new();
    for (index, call) in ["call-early", "call-late", "call-current"]
        .into_iter()
        .enumerate()
    {
        if index == 2 {
            relay
                .start(tokio::process::Command::new("false"))
                .await
                .expect("the relay starts again over its running executor");
        }
        let process = format!("{index}-process");
        let session_id = sessions[index];
        sets.command_started(CommandStart {
            session_id,
            command_id: call_id(call),
            run_id,
            tool_call_id: None,
            binding_id: RuntimeBindingId::new(mint_uuid_v7().to_string()).expect("a binding id"),
            name: NonEmptyText::new("sleep 60".to_owned()).expect("a name"),
            started_at: WireInstant::now(),
            line: None,
            process_id: Some(process.clone()),
            is_backgrounded: false,
            can_move_to_background: false,
            accepts_input: false,
        });
        let line = json!({ "id": index, "method": "process/start", "params": {
            "processId": process,
            "argv": ["/bin/sleep", "60"],
            "cwd": "file:///tmp",
            "env": {},
            "tty": false,
            "arg0": null,
            "metadata": { "threadId": format!("thread-{index}"), "toolCallId": call },
        }});
        starts.push(tokio::spawn(Arc::clone(&relay).forward_process_start(
            Arc::clone(&executor),
            line.to_string(),
            process.clone(),
            true,
        )));
        let sent = fake.next_sent().await;
        fake.write(&json!({ "id": sent["id"], "result": {} })).await;
        if index == 0 {
            fake.write(&exited(&process)).await;
            wait_until(|| relay.relayed_command(session_id, &call_id(call)).is_none()).await;
        }
    }
    for process in ["1-process", "2-process"] {
        fake.write(&exited(process)).await;
    }

    for start in starts {
        start.await.expect("each start's watch ends");
    }
    assert!(
        !sets.has_running_commands(sessions[0]),
        "ended before the new start"
    );
    assert!(
        !sets.has_running_commands(sessions[1]),
        "ended after the new start"
    );
    assert!(sets.has_running_commands(sessions[2]), "waits for its item");
}

fn call_id(call: &str) -> CommandId {
    CommandId::new(call.to_owned()).expect("a call id")
}
