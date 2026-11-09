//! What a Claude Code session hands the chat versions' intake: each `Write`, `Edit` and
//! `NotebookEdit` call, the lead's or a helper's, opened on its path and settled by its result, and
//! every call still open settled unread at the turn's end, the interrupt's answer and the
//! process's end, each settle recorded off the session's task.

use std::error::Error;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_std::mutex_lock::lock;
use tokio::sync::Semaphore;

use super::result;
use crate::driver::claude::session::scripted::held_calls::{helper_started, init};
use crate::driver::claude::session::scripted::{
    SCRIPTED_PROVIDER_SESSION_ID, ScriptedSession, settle,
};
use crate::port::file_tool_write::{
    FileToolWriteClaim, FileToolWriteOpened, FileToolWriteOutcome, FileToolWritePort,
    FileToolWriteSettled,
};

// What reached the intake, in order: each call opened on its path, then each settled.
#[derive(Default)]
struct KeptFileToolWrites {
    opened: Mutex<Vec<(String, PathBuf)>>,
    settled: Mutex<Vec<(String, FileToolWriteOutcome)>>,
    // Where set, each settle waits for one of its permits, as an intake still recording would.
    settle_gate: Option<Semaphore>,
}

impl FileToolWritePort for KeptFileToolWrites {
    fn open_file_tool_write(
        &self,
        opened: FileToolWriteOpened,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        lock(&self.opened).push((opened.call_id, opened.path));
        async { Ok(()) }.boxed()
    }

    fn settle_file_tool_write(
        &self,
        settled: FileToolWriteSettled,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        async move {
            if let Some(gate) = &self.settle_gate {
                gate.acquire()
                    .await
                    .expect("the gate is never closed")
                    .forget();
            }
            lock(&self.settled).push((settled.call_id, settled.outcome));
            Ok(())
        }
        .boxed()
    }
}

// `kept` registered on `session`'s driver, as the daemon's start registers the chat versions.
fn register_intake(session: &ScriptedSession, kept: KeptFileToolWrites) -> Arc<KeptFileToolWrites> {
    let kept = Arc::new(kept);
    session
        .driver
        .sources
        .ports
        .file_tool_writes
        .register(Arc::clone(&kept) as Arc<dyn FileToolWritePort>)
        .expect("the intake registers once");
    kept
}

// Waits until `is_reached` holds of what reached the intake.
async fn wait_until(is_reached: impl Fn() -> bool) {
    tokio::time::timeout(Duration::from_secs(10), async {
        while !is_reached() {
            settle().await;
        }
    })
    .await
    .expect("the intake is reached");
}

// An assistant frame calling `tool_name` under `call_id` with `input`, the helper `agent_id`'s or,
// with none, the lead's.
fn call(call_id: &str, tool_name: &str, input: &Value, agent_id: Option<&str>) -> Value {
    let mut frame = json!({
        "type": "assistant",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        "message": {
            "id": format!("message-{call_id}"),
            "role": "assistant",
            "content": [{"type": "tool_use", "id": call_id, "name": tool_name, "input": input}],
        },
    });
    if let Some(agent_id) = agent_id {
        frame["agent_id"] = json!(agent_id);
    }
    frame
}

// A user frame answering each of `call_ids`, an error where `is_error`, with Claude Code's
// structured result `tool_use_result` beside it where given.
fn answer(
    call_ids: &[&str],
    is_error: bool,
    tool_use_result: Option<Value>,
    agent_id: Option<&str>,
) -> Value {
    let content: Vec<Value> = call_ids
        .iter()
        .map(|call_id| {
            json!({"type": "tool_result", "tool_use_id": call_id, "content": "done",
                   "is_error": is_error})
        })
        .collect();
    let mut frame = json!({
        "type": "user",
        "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        "message": {"role": "user", "content": content},
    });
    if let Some(tool_use_result) = tool_use_result {
        frame["tool_use_result"] = tool_use_result;
    }
    if let Some(agent_id) = agent_id {
        frame["agent_id"] = json!(agent_id);
    }
    frame
}

fn claimed(text: &str) -> FileToolWriteOutcome {
    FileToolWriteOutcome::Claimed(FileToolWriteClaim::Text(text.to_owned()))
}

// Each file-tool call opens on its input's path and settles by its result: a `Write` with its
// content, an `Edit` with its original changed once or everywhere, a `NotebookEdit` with its
// updated file, and a helper's `Edit` the same; an error, a staged write and a failed notebook
// edit with no write; an edit with no original, results sharing one frame and a notebook edit
// whose updated file is empty unread. A `Read` opens nothing. Mutations: the helper's frames not
// read (no `h1`); a tool left out of the three (its open missing); `replaceAll` ignored (`e2`
// changed once); an empty `error` read as a failure (`n1` not written); an empty `updated_file`
// claimed (`n3` claims ""); `staged` ignored (`e3` claimed); results sharing a frame read as lone.
#[tokio::test(start_paused = true)]
async fn each_file_tool_call_opens_on_its_path_and_settles_by_its_result() {
    let session = ScriptedSession::new().await;
    session.hold_lead_turn("lead");
    let kept = register_intake(&session, KeptFileToolWrites::default());
    let edit_result = |original: Value, replace_all: bool, staged: bool| {
        json!({
            "filePath": "/chat/b.md",
            "oldString": "two",
            "newString": "2",
            "originalFile": original,
            "structuredPatch": [],
            "userModified": false,
            "replaceAll": replace_all,
            "staged": staged,
        })
    };
    let edit_input = json!({"file_path": "/chat/b.md", "old_string": "two", "new_string": "2"});
    let notebook_input = json!({"notebook_path": "/chat/c.ipynb", "new_source": "x = 1"});
    let notebook_result = |error: &str, updated_file: &str| {
        json!({
            "new_source": "x = 1",
            "cell_type": "code",
            "language": "python",
            "edit_mode": "replace",
            "error": error,
            "notebook_path": "/chat/c.ipynb",
            "original_file": "",
            "updated_file": updated_file,
        })
    };
    let write_input = |path: &str| json!({"file_path": path, "content": "one\n"});

    session.frame(&init());
    session.frame(&call("w1", "Write", &write_input("/chat/a.md"), None));
    session.frame(&answer(
        &["w1"],
        false,
        Some(
            json!({"type": "create", "filePath": "/chat/a.md", "content": "one\n",
                    "structuredPatch": [], "originalFile": null}),
        ),
        None,
    ));
    session.frame(&call("e1", "Edit", &edit_input, None));
    session.frame(&answer(
        &["e1"],
        false,
        Some(edit_result(json!("one two two\n"), false, false)),
        None,
    ));
    session.frame(&call("e2", "Edit", &edit_input, None));
    session.frame(&answer(
        &["e2"],
        false,
        Some(edit_result(json!("one two two\n"), true, false)),
        None,
    ));
    session.frame(&call("n1", "NotebookEdit", &notebook_input, None));
    session.frame(&answer(
        &["n1"],
        false,
        Some(notebook_result("", "{\"cells\": []}")),
        None,
    ));
    session.frame(&call("n2", "NotebookEdit", &notebook_input, None));
    session.frame(&answer(
        &["n2"],
        false,
        Some(notebook_result("Cell not found", "")),
        None,
    ));
    session.frame(&call("w2", "Write", &write_input("/chat/a.md"), None));
    session.frame(&answer(&["w2"], true, None, None));
    session.frame(&call("e3", "Edit", &edit_input, None));
    session.frame(&answer(
        &["e3"],
        false,
        Some(edit_result(json!("one two two\n"), false, true)),
        None,
    ));
    session.frame(&call("e4", "Edit", &edit_input, None));
    session.frame(&answer(
        &["e4"],
        false,
        Some(edit_result(Value::Null, false, false)),
        None,
    ));
    session.frame(&call("w3", "Write", &write_input("/chat/e.md"), None));
    session.frame(&call("w4", "Write", &write_input("/chat/f.md"), None));
    session.frame(&answer(&["w3", "w4"], false, None, None));
    session.frame(&call("n3", "NotebookEdit", &notebook_input, None));
    session.frame(&answer(&["n3"], false, Some(notebook_result("", "")), None));
    session.frame(&call(
        "r1",
        "Read",
        &json!({"file_path": "/chat/a.md"}),
        None,
    ));
    session.frame(&answer(&["r1"], false, Some(json!({"type": "text"})), None));
    session.frame(&helper_started("helper", "local_agent", "agent-call"));
    session.frame(&call("h1", "Edit", &edit_input, Some("helper")));
    session.frame(&answer(
        &["h1"],
        false,
        Some(edit_result(json!("two\n"), false, false)),
        Some("helper"),
    ));
    wait_until(|| lock(&kept.settled).len() == 12).await;

    let path = |path: &str| PathBuf::from(path);
    assert_eq!(
        *lock(&kept.opened),
        [
            ("w1".to_owned(), path("/chat/a.md")),
            ("e1".to_owned(), path("/chat/b.md")),
            ("e2".to_owned(), path("/chat/b.md")),
            ("n1".to_owned(), path("/chat/c.ipynb")),
            ("n2".to_owned(), path("/chat/c.ipynb")),
            ("w2".to_owned(), path("/chat/a.md")),
            ("e3".to_owned(), path("/chat/b.md")),
            ("e4".to_owned(), path("/chat/b.md")),
            ("w3".to_owned(), path("/chat/e.md")),
            ("w4".to_owned(), path("/chat/f.md")),
            ("n3".to_owned(), path("/chat/c.ipynb")),
            ("h1".to_owned(), path("/chat/b.md")),
        ]
    );
    assert_eq!(
        *lock(&kept.settled),
        [
            ("w1".to_owned(), claimed("one\n")),
            ("e1".to_owned(), claimed("one 2 two\n")),
            ("e2".to_owned(), claimed("one 2 2\n")),
            ("n1".to_owned(), claimed("{\"cells\": []}")),
            ("n2".to_owned(), FileToolWriteOutcome::NotWritten),
            ("w2".to_owned(), FileToolWriteOutcome::NotWritten),
            ("e3".to_owned(), FileToolWriteOutcome::NotWritten),
            ("e4".to_owned(), FileToolWriteOutcome::Unread),
            ("w3".to_owned(), FileToolWriteOutcome::Unread),
            ("w4".to_owned(), FileToolWriteOutcome::Unread),
            ("n3".to_owned(), FileToolWriteOutcome::Unread),
            ("h1".to_owned(), claimed("2\n")),
        ]
    );
}

// How a call's turn can end with no result for it.
#[derive(Clone, Copy, Debug)]
enum OpenCallEnd {
    TurnEnd,
    Interrupt,
    ProcessGone,
}

// A call still open settles unread when its turn ends, when Claude Code answers an interrupt with
// no turn end yet, and when the process ends, so its path's watch reports are recorded after it.
// Mutations: the settle left out of the turn's end, of the interrupt's answer or of the process's
// end (the call left open, the wait times out).
#[rstest]
#[case::turn_end(OpenCallEnd::TurnEnd)]
#[case::interrupt(OpenCallEnd::Interrupt)]
#[case::process_gone(OpenCallEnd::ProcessGone)]
#[tokio::test(start_paused = true)]
async fn every_open_file_tool_call_settles_unread_when_no_result_can_come(
    #[case] end: OpenCallEnd,
) {
    let session = ScriptedSession::new().await;
    let run_id = session.hold_lead_turn("lead");
    let kept = register_intake(&session, KeptFileToolWrites::default());
    if let OpenCallEnd::Interrupt = end {
        session.stream.hold_turn_end_for_interrupt(run_id);
    }

    session.frame(&init());
    session.frame(&call(
        "e1",
        "Edit",
        &json!({"file_path": "/chat/b.md", "old_string": "a", "new_string": "b"}),
        None,
    ));
    settle().await;
    assert!(lock(&kept.settled).is_empty(), "the call is open");
    match end {
        OpenCallEnd::TurnEnd => session.frame(&result(&json!({}))),
        OpenCallEnd::Interrupt => session.stream.interrupt_daemon_end(run_id),
        OpenCallEnd::ProcessGone => session.exit(),
    }
    wait_until(|| lock(&kept.settled).len() == 1).await;

    assert_eq!(
        *lock(&kept.settled),
        [("e1".to_owned(), FileToolWriteOutcome::Unread)]
    );
}

// A settle is recorded off the session's task: while the intake is still recording the first, the
// frames after it are read and their calls opened, and the settles then land after their opens in
// the order they were handed. Killed by the settle awaited on the session's task (the later calls
// never open while the first settle is held).
#[tokio::test(start_paused = true)]
async fn a_settle_is_recorded_off_the_sessions_task_after_its_open_in_order() {
    let session = ScriptedSession::new().await;
    session.hold_lead_turn("lead");
    let kept = register_intake(
        &session,
        KeptFileToolWrites {
            settle_gate: Some(Semaphore::new(0)),
            ..KeptFileToolWrites::default()
        },
    );
    let write = |call_id: &str, path: &str| {
        call(
            call_id,
            "Write",
            &json!({"file_path": path, "content": "one\n"}),
            None,
        )
    };
    let written = |call_id: &str, path: &str| {
        answer(
            &[call_id],
            false,
            Some(
                json!({"type": "create", "filePath": path, "content": "one\n",
                        "structuredPatch": [], "originalFile": null}),
            ),
            None,
        )
    };

    session.frame(&init());
    session.frame(&write("w1", "/chat/a.md"));
    session.frame(&written("w1", "/chat/a.md"));
    session.frame(&write("w2", "/chat/b.md"));
    session.frame(&written("w2", "/chat/b.md"));
    session.frame(&write("w3", "/chat/c.md"));
    wait_until(|| lock(&kept.opened).len() == 3).await;
    assert!(
        lock(&kept.settled).is_empty(),
        "the intake still records the first settle"
    );
    kept.settle_gate
        .as_ref()
        .expect("the intake is gated")
        .add_permits(2);
    wait_until(|| lock(&kept.settled).len() == 2).await;

    assert_eq!(
        *lock(&kept.settled),
        [
            ("w1".to_owned(), claimed("one\n")),
            ("w2".to_owned(), claimed("one\n")),
        ]
    );
}
