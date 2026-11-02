use serde_json::json;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;

use super::{ClaudeHeldCallRun, ClaudeToolServerTasks};
use crate::driver::claude::delivery::commands::ClaudeTaskFrame;

fn frame(value: &serde_json::Value) -> ClaudeTaskFrame {
    ClaudeTaskFrame::read(&value.to_string()).expect("a task frame")
}

// Fails when a tool server's finished task closes its held call without the notification's
// files, or with more than the cap; whether the stand-in result leaves the call open is the
// stream's test. Mutations: `release` leaving the links out; the cap's `take` removed.
#[test]
fn a_tool_server_tasks_end_lists_its_files_up_to_the_cap() {
    let mut tasks = ClaudeToolServerTasks::default();
    let run = ClaudeHeldCallRun {
        run_id: RunId::new("0190a5d2-7c1e-7d3a-9b2f-4c8e6a1f3b5e").expect("a valid run id"),
        binding_id: RuntimeBindingId::new("binding".to_owned()).expect("a valid binding id"),
    };
    tasks.observe_start(
        &frame(&json!({
            "task_id": "task-1",
            "task_type": "mcp_task",
            "tool_use_id": "call-1",
        })),
        Some(run.clone()),
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
    assert_eq!(end.run, run);
    assert!(!end.is_error);
    let lines: Vec<&str> = end.text.lines().collect();
    assert_eq!(lines.first(), Some(&"Exported"));
    assert_eq!(lines.get(1), Some(&"- out: file:///out/0.txt"));
    assert_eq!(lines.len(), 51);
}
