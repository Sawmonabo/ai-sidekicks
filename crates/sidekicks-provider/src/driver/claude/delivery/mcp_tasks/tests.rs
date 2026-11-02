use std::collections::{HashMap, HashSet};

use jiff::Timestamp;
use rstest::rstest;
use serde_json::json;
use sidekicks_contracts::event::declared_variants::ToolCallEndCause;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::wire::text::FreeFormText;

use super::ClaudeToolServerTasks;
use crate::driver::claude::delivery::commands::ClaudeTaskFrame;
use crate::driver::claude::delivery::messages::{ClaudeOpenToolCall, ClaudeToolCallOutcome};
use crate::driver::claude::run::routes::ClaudeBoundRun;

const STOPPED: ClaudeToolCallOutcome = ClaudeToolCallOutcome::Failed {
    end_cause: Some(ToolCallEndCause::Stopped),
};

fn frame(value: &serde_json::Value) -> ClaudeTaskFrame {
    ClaudeTaskFrame::read(&value.to_string()).expect("a task frame")
}

fn bound_run() -> ClaudeBoundRun {
    ClaudeBoundRun {
        run_id: RunId::new("0190a5d2-7c1e-7d3a-9b2f-4c8e6a1f3b5e").expect("a valid run id"),
        binding_id: RuntimeBindingId::new("binding".to_owned()).expect("a valid binding id"),
    }
}

// The lead's open calls `call_ids`, each a tool server's call on `run`.
fn openings(run: &ClaudeBoundRun, call_ids: &[&str]) -> HashMap<String, ClaudeOpenToolCall> {
    call_ids
        .iter()
        .map(|call_id| {
            let tool_name = FreeFormText::new("mcp__files__export".to_owned()).expect("a name");
            let opened = ClaudeOpenToolCall::new(tool_name, run.clone(), Timestamp::now());
            ((*call_id).to_owned(), opened)
        })
        .collect()
}

// A tool server's task `task_id` starting for `call_id`, on the task run `run_id` where given.
fn start(task_id: &str, call_id: &str, run_id: Option<&str>) -> ClaudeTaskFrame {
    let mut value = json!({"task_id": task_id, "task_type": "mcp_task", "tool_use_id": call_id});
    if let Some(run_id) = run_id {
        value["run_id"] = json!(run_id);
    }
    frame(&value)
}

// The notification ending `task_id` with `status` and `summary`, on `run_id` where given.
fn notification(
    task_id: &str,
    status: &str,
    summary: &str,
    run_id: Option<&str>,
) -> ClaudeTaskFrame {
    let mut value = json!({"task_id": task_id, "status": status, "summary": summary});
    if let Some(run_id) = run_id {
        value["run_id"] = json!(run_id);
    }
    frame(&value)
}

// Fails when a tool server's finished task closes its held call without the notification's
// files, or with more than the cap; whether the stand-in result leaves the call open is the
// stream's test. Mutations: `release` leaving the links out; the cap's `take` removed.
#[test]
fn a_tool_server_tasks_end_lists_its_files_up_to_the_cap() {
    let mut tasks = ClaudeToolServerTasks::default();
    let run = bound_run();
    tasks.observe_start(
        &start("task-1", "call-1", None),
        &mut openings(&run, &["call-1"]),
    );

    let links: Vec<_> = (0..60)
        .map(|index| json!({"uri": format!("file:///out/{index}.txt"), "name": "out"}))
        .collect();
    let end = tasks
        .release(&frame(&json!({
            "task_id": "task-1",
            "status": "completed",
            "summary": "Exported",
            "resource_links": links,
        })))
        .expect("the held call ends");

    assert_eq!(end.tool_use_id, "call-1");
    assert_eq!(end.opened.run(), &run);
    assert_eq!(end.outcome, ClaudeToolCallOutcome::Completed);
    let text = end.text.expect("a completed call has a body");
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines.first(), Some(&"Exported"));
    assert_eq!(lines.get(1), Some(&"- out: file:///out/0.txt"));
    assert_eq!(lines.len(), 51);
}

// Fails when a background list that leaves a held call out does not settle it stopped, when the
// settled call is not kept for its later ending, when a listed call is settled, or when the
// opening stays among the open calls. Mutations: `settle_unlisted` returning nothing; its
// `settle` not keeping the call; its filter inverted; `observe_start` cloning the opening.
#[test]
fn a_level_that_omits_a_held_call_settles_it_stopped_and_its_later_ending_appends() {
    let mut tasks = ClaudeToolServerTasks::default();
    let run = bound_run();
    let mut open_tool_calls = openings(&run, &["call-1", "call-2"]);
    tasks.observe_start(&start("task-1", "call-1", None), &mut open_tool_calls);
    tasks.observe_start(&start("task-2", "call-2", None), &mut open_tool_calls);

    assert!(open_tool_calls.is_empty());
    let held: HashSet<String> = ["call-1".to_owned(), "call-2".to_owned()].into();
    assert_eq!(tasks.held_call_ids(), &held);

    let level = frame(&json!({"tasks": [{"task_id": "task-2", "task_type": "mcp_task"}]}));
    let ends = tasks.settle_unlisted(&level);
    assert_eq!(ends.len(), 1);
    let end = ends.first().expect("one held call is settled");
    assert_eq!(end.tool_use_id, "call-1");
    assert_eq!(end.outcome, STOPPED);
    assert_eq!(end.text, None);
    assert_eq!(end.opened.run(), &run);
    assert!(tasks.settle_unlisted(&level).is_empty());

    let end = tasks
        .release(&notification("task-1", "completed", "Exported", None))
        .expect("the settled call ends again");
    assert_eq!(end.tool_use_id, "call-1");
    assert_eq!(end.outcome, ClaudeToolCallOutcome::Completed);
    assert_eq!(end.text.as_deref(), Some("Exported"));
}

// Fails when a stopped call's body is its task's name, when a failed or stopped call is not kept
// for a later ending, or when a stopped call reads as plainly failed. Mutations: `release`
// writing the summary on `stopped`; its failed arm not settling; the `stopped` arm removed.
#[rstest]
#[case::failed(
    "failed",
    "server lost the job",
    ClaudeToolCallOutcome::Failed { end_cause: None },
    Some("server lost the job"),
)]
#[case::stopped("stopped", "files/export", STOPPED, None)]
fn a_failed_or_stopped_notification_closes_its_call_and_a_later_completion_appends(
    #[case] status: &str,
    #[case] summary: &str,
    #[case] outcome: ClaudeToolCallOutcome,
    #[case] text: Option<&str>,
) {
    let mut tasks = ClaudeToolServerTasks::default();
    let run = bound_run();
    tasks.observe_start(
        &start("task-1", "call-1", None),
        &mut openings(&run, &["call-1"]),
    );

    let end = tasks
        .release(&notification("task-1", status, summary, None))
        .expect("the held call ends");
    assert_eq!(end.tool_use_id, "call-1");
    assert_eq!(end.outcome, outcome);
    assert_eq!(end.text.as_deref(), text);
    assert!(tasks.held_call_ids().is_empty());

    let end = tasks
        .release(&notification("task-1", "completed", "Exported", None))
        .expect("the settled call ends again");
    assert_eq!(end.outcome, ClaudeToolCallOutcome::Completed);
    assert_eq!(end.text.as_deref(), Some("Exported"));
}

// Fails when a frame of an earlier task run ends a held call, when one of the newest run does
// not, or when a frame naming no run reads as late. Mutations: the late check removed, reversed
// or made `<=`; a missing run read as late.
#[test]
fn a_frame_of_an_earlier_task_run_is_ignored() {
    let mut tasks = ClaudeToolServerTasks::default();
    let run = bound_run();
    let mut open_tool_calls = openings(&run, &["call-1", "call-2"]);
    tasks.observe_start(
        &start("task-1", "call-1", Some("0002")),
        &mut open_tool_calls,
    );
    tasks.observe_start(
        &start("task-2", "call-2", Some("0002")),
        &mut open_tool_calls,
    );

    assert!(
        tasks
            .release(&notification(
                "task-1",
                "completed",
                "Exported",
                Some("0001")
            ))
            .is_none()
    );
    assert!(tasks.held_call_ids().contains("call-1"));
    let end = tasks
        .release(&notification(
            "task-1",
            "completed",
            "Exported",
            Some("0002"),
        ))
        .expect("the newest run's frame ends the call");
    assert_eq!(end.tool_use_id, "call-1");

    let end = tasks
        .release(&notification("task-2", "completed", "Exported", None))
        .expect("a frame naming no run is never late");
    assert_eq!(end.tool_use_id, "call-2");
}
