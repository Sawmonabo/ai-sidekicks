use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::turn::{ProviderTurnId, TurnTask, TurnTaskState};
use sidekicks_contracts::wire::text::NonEmptyText;

use super::{ClaudeTurnReadings, read_claude_task_list_change};
use crate::driver::task_list::{ListedTask, TaskListChange, ToolCallRecord};

fn delta(event: &Value) -> String {
    json!({"type": "stream_event", "event": event}).to_string()
}

fn task(task_id: &str, text: &str, state: TurnTaskState) -> ListedTask {
    ListedTask {
        task_id: Some(task_id.to_owned()),
        task: TurnTask {
            text: NonEmptyText::new(text.to_owned()).expect("a task's words"),
            state,
        },
    }
}

// Fails when every `message_delta` is added, rather than the last of each message, or a message's
// count is dropped when the next one starts. Mutations: in `observe_stream_event`, sum each delta's
// count; key every count by one message.
#[test]
fn two_rounds_sum_the_last_message_delta_of_each_message() {
    let mut readings = ClaudeTurnReadings::default();
    readings.open(
        RunId::new("0190a5d2-7c1e-7d3a-9b2f-4c8e6a1f3b5e").expect("a valid run id"),
        Some(ProviderTurnId::new("turn-1".to_owned()).expect("a turn id")),
    );
    let mut received = Vec::new();
    for (message_id, counts) in [("msg-1", [5, 12]), ("msg-2", [3, 7])] {
        readings.observe_stream_event(&delta(
            &json!({"type": "message_start", "message": {"id": message_id}}),
        ));
        for count in counts {
            let update = readings.observe_stream_event(&delta(
                &json!({"type": "message_delta", "usage": {"output_tokens": count}}),
            ));
            received.push(update.map(|update| update.tokens_received.get()));
        }
    }

    assert_eq!(received, [Some(5), Some(12), Some(15), Some(19)]);
}

// Fails when a task-list call's opening, a failed update or a read of one task changes the list,
// when a list read does not replace it whole, or when another tool is read as a task-list call.
// Mutations: in `read_claude_task_list_change`, the `is_success` check dropped; `TaskList` read as
// `Nothing`; the tool-name check answering `Some` for every tool.
#[rstest]
#[case::an_opening_row(
    "TaskUpdate",
    json!({"taskId": "1", "status": "completed"}),
    None,
    false,
    Some(TaskListChange::Nothing)
)]
#[case::a_failed_update(
    "TaskUpdate",
    json!({"taskId": "1", "status": "completed"}),
    Some(json!({"success": false})),
    false,
    Some(TaskListChange::Nothing)
)]
#[case::an_update(
    "TaskUpdate",
    json!({"taskId": "1", "status": "in_progress"}),
    Some(json!({"success": true, "taskId": "1"})),
    true,
    Some(TaskListChange::Updated {
        task_id: "1".to_owned(),
        text: None,
        state: Some(TurnTaskState::InProgress),
    })
)]
#[case::a_list_read(
    "TaskList",
    json!({}),
    Some(json!({"tasks": [
        {"id": "1", "subject": "Write the parser", "status": "completed"},
        {"id": "2", "subject": "Test it", "status": "pending"},
    ]})),
    true,
    Some(TaskListChange::Reseeded(vec![
        task("1", "Write the parser", TurnTaskState::Done),
        task("2", "Test it", TurnTaskState::NotStarted),
    ]))
)]
#[case::a_read_of_one_task(
    "TaskGet",
    json!({"taskId": "1"}),
    Some(json!({"task": {"id": "1"}})),
    true,
    Some(TaskListChange::Nothing)
)]
#[case::another_tool("Bash", json!({"command": "ls"}), Some(json!({})), true, None)]
fn each_task_list_call_reads_as_its_change(
    #[case] tool_name: &str,
    #[case] input: Value,
    #[case] result: Option<Value>,
    #[case] is_success: bool,
    #[case] expected: Option<TaskListChange>,
) {
    let change = read_claude_task_list_change(&ToolCallRecord {
        tool_name,
        input: Some(&input),
        result: result.as_ref(),
        is_success,
    });

    assert_eq!(change, expected);
}
