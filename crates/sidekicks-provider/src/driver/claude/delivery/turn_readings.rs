//! What the working line reads about the lead's running turn, from frames Claude Code already
//! sends: the tokens received, the last `message_delta` count of each message summed over the
//! turn, and the agent's task list, folded from its `TodoWrite` and `Task*` calls.

use std::collections::HashMap;

use serde::Deserialize;
use serde_json::Value;
use serde_json::value::RawValue;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::turn::{
    ProviderTurnId, TurnTask, TurnTaskState, TurnTasksUpdate, TurnUsageUpdate,
};
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::NonEmptyText;

use crate::driver::claude::delivery::messages::ClaudeMessageFrame;
use crate::driver::task_list::{ListedTask, TaskListChange, TaskListFold, ToolCallRecord};
use crate::lenient_json::{Lenient, lenient_object, read_lenient};

#[derive(Deserialize)]
struct ClaudeStreamEventFrame {
    #[serde(default, deserialize_with = "read_lenient")]
    event: Option<ClaudeStreamEvent>,
}

#[derive(Deserialize)]
struct ClaudeStreamEvent {
    #[serde(rename = "type", default, deserialize_with = "read_lenient")]
    event_type: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    message: Option<ClaudeStreamMessage>,
    #[serde(default, deserialize_with = "read_lenient")]
    usage: Option<ClaudeStreamUsage>,
}

#[derive(Deserialize)]
struct ClaudeStreamMessage {
    #[serde(default, deserialize_with = "read_lenient")]
    id: Option<String>,
}

#[derive(Deserialize)]
struct ClaudeStreamUsage {
    #[serde(default)]
    output_tokens: Option<Box<RawValue>>,
}

lenient_object!(
    ClaudeStreamEventFrame,
    ClaudeStreamEvent,
    ClaudeStreamMessage,
    ClaudeStreamUsage
);

/// What one task-list call of Claude Code does to the agent's list: `None` for any other tool, and
/// `Nothing` for a call that changes nothing, a call's opening, whose change needs its result, a
/// failed call and a read of one task among them.
pub(crate) fn read_claude_task_list_change(call: &ToolCallRecord<'_>) -> Option<TaskListChange> {
    if !matches!(
        call.tool_name,
        "TodoWrite" | "TaskCreate" | "TaskUpdate" | "TaskList" | "TaskGet"
    ) {
        return None;
    }
    if !call.is_success {
        return Some(TaskListChange::Nothing);
    }
    let result = call.result;
    let change = match call.tool_name {
        "TodoWrite" => call
            .input
            .and_then(|input| input.get("todos"))
            .and_then(Value::as_array)
            .map(|todos| {
                TaskListChange::Reseeded(
                    todos
                        .iter()
                        .filter_map(|todo| listed_task(None, todo, "content"))
                        .collect(),
                )
            }),
        "TaskCreate" => result
            .and_then(|result| result.get("task"))
            .and_then(|task| {
                let task_id = task.get("id").and_then(Value::as_str)?.to_owned();
                listed_task(Some(task_id), task, "subject").map(TaskListChange::Created)
            }),
        "TaskUpdate" => call.input.and_then(|input| {
            let task_id = input.get("taskId").and_then(Value::as_str)?.to_owned();
            let status = input.get("status").and_then(Value::as_str);
            if status == Some("deleted") {
                return Some(TaskListChange::Deleted { task_id });
            }
            Some(TaskListChange::Updated {
                task_id,
                text: input
                    .get("subject")
                    .and_then(Value::as_str)
                    .and_then(|subject| NonEmptyText::new(subject.to_owned())),
                state: status.and_then(task_state),
            })
        }),
        "TaskList" => result
            .and_then(|result| result.get("tasks"))
            .and_then(Value::as_array)
            .map(|tasks| {
                TaskListChange::Reseeded(
                    tasks
                        .iter()
                        .filter_map(|task| {
                            let task_id = task.get("id").and_then(Value::as_str)?.to_owned();
                            listed_task(Some(task_id), task, "subject")
                        })
                        .collect(),
                )
            }),
        _ => None,
    };
    Some(change.unwrap_or(TaskListChange::Nothing))
}

/// The lead's running turn as the working line reads it: its tokens received and its task list.
#[derive(Default)]
pub(crate) struct ClaudeTurnReadings {
    turn: Option<(RunId, ProviderTurnId)>,
    open_message: Option<String>,
    output_tokens: HashMap<String, u64>,
    tasks: TaskListFold,
    task_calls: HashMap<String, (String, Option<Value>)>,
}

impl ClaudeTurnReadings {
    /// Starts reading the turn `run_id` just opened, which `turn_id` names; a turn Claude Code
    /// named nothing for gives no reading. The list a turn before it left carries over, since the
    /// agent's list outlives its turns.
    pub(crate) fn open(&mut self, run_id: RunId, turn_id: Option<ProviderTurnId>) {
        self.turn = turn_id.map(|turn_id| (run_id, turn_id));
        self.open_message = None;
        self.output_tokens.clear();
        self.task_calls.clear();
    }

    /// The tokens the turn received so far, where the streamed event `text` changes them.
    pub(crate) fn observe_stream_event(&mut self, text: &str) -> Option<TurnUsageUpdate> {
        let event = <ClaudeStreamEventFrame as Lenient>::read(
            &mut serde_json::Deserializer::from_str(text),
        )
        .ok()
        .flatten()?
        .event?;
        match event.event_type.as_deref() {
            Some("message_start") => {
                self.open_message = event.message.and_then(|message| message.id);
                None
            }
            Some("message_delta") => {
                let count = event
                    .usage
                    .and_then(|usage| usage.output_tokens)
                    .and_then(|count| serde_json::from_str::<u64>(count.get()).ok())?;
                let message_id = self.open_message.clone()?;
                // Each delta carries its message's count so far, so the last one counts.
                if self.output_tokens.insert(message_id, count) == Some(count) {
                    return None;
                }
                let (run_id, turn_id) = self.turn.clone()?;
                let received = self.output_tokens.values().sum::<u64>();
                Some(TurnUsageUpdate {
                    run_id,
                    turn_id,
                    tokens_received: SafeInt::new(received)?,
                })
            }
            Some(_) | None => None,
        }
    }

    /// The turn's task list, where a call the assistant `frame` starts changes it.
    pub(crate) fn observe_calls(&mut self, frame: &ClaudeMessageFrame) -> Option<TurnTasksUpdate> {
        let mut is_changed = false;
        for (call_id, tool_name, input) in frame.tool_uses() {
            let input = input.and_then(|input| serde_json::from_str::<Value>(input.get()).ok());
            let record = ToolCallRecord {
                tool_name,
                input: input.as_ref(),
                result: None,
                is_success: false,
            };
            let Some(change) = read_claude_task_list_change(&record) else {
                continue;
            };
            is_changed |= self.tasks.apply(change);
            self.task_calls
                .insert(call_id.to_owned(), (tool_name.to_owned(), input));
        }
        is_changed.then(|| self.tasks_update()).flatten()
    }

    /// The turn's task list, where a result the user `frame` carries changes it.
    pub(crate) fn observe_results(
        &mut self,
        frame: &ClaudeMessageFrame,
    ) -> Option<TurnTasksUpdate> {
        let structured = frame
            .tool_use_result()
            .and_then(|result| serde_json::from_str::<Value>(result.get()).ok());
        let mut is_changed = false;
        for (call_id, is_error) in frame.tool_results() {
            let Some((tool_name, input)) = self.task_calls.remove(call_id) else {
                continue;
            };
            let record = ToolCallRecord {
                tool_name: &tool_name,
                input: input.as_ref(),
                result: structured.as_ref(),
                is_success: !is_error,
            };
            if let Some(change) = read_claude_task_list_change(&record) {
                is_changed |= self.tasks.apply(change);
            }
        }
        is_changed.then(|| self.tasks_update()).flatten()
    }

    /// Empties the list of an interrupted turn, answering the empty list where it held any.
    pub(crate) fn interrupt(&mut self) -> Option<TurnTasksUpdate> {
        let is_changed = self.tasks.apply(TaskListChange::Reseeded(Vec::new()));
        is_changed.then(|| self.tasks_update()).flatten()
    }

    fn tasks_update(&self) -> Option<TurnTasksUpdate> {
        let (run_id, turn_id) = self.turn.clone()?;
        Some(TurnTasksUpdate {
            run_id,
            turn_id,
            tasks: self.tasks.tasks(),
        })
    }
}

// One listed task from `value`, its words under `text_member` and its state under `status`.
fn listed_task(task_id: Option<String>, value: &Value, text_member: &str) -> Option<ListedTask> {
    let text = value.get(text_member).and_then(Value::as_str)?;
    Some(ListedTask {
        task_id,
        task: TurnTask {
            text: NonEmptyText::new(text.to_owned())?,
            state: value
                .get("status")
                .and_then(Value::as_str)
                .and_then(task_state)
                .unwrap_or(TurnTaskState::NotStarted),
        },
    })
}

fn task_state(status: &str) -> Option<TurnTaskState> {
    match status {
        "pending" => Some(TurnTaskState::NotStarted),
        "in_progress" => Some(TurnTaskState::InProgress),
        "completed" => Some(TurnTaskState::Done),
        _ => None,
    }
}

#[cfg(test)]
mod tests;
