//! Which tool calls stand as no row: a call the session's driver reads as a change to the agent's
//! task list, which the transcript and the live stream both leave out.

use serde_json::Value;
use sidekicks_contracts::event::envelope::EventEnvelope;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_provider::driver::contract::ProviderDriver;
use sidekicks_provider::driver::task_list::ToolCallRecord;

/// Whether `event` is a row of a tool call `driver` reads as a change to the agent's task list,
/// which the transcript and the live stream show as no row. The row is asked alone, so a call's
/// opening and its end are answered alike wherever a page cuts them: the opening with its input,
/// the end with its result, each from `body`, the row's body where it was loaded.
pub fn is_task_list_call(
    driver: &dyn ProviderDriver,
    event: &EventEnvelope,
    body: Option<&str>,
) -> bool {
    let event_type = event.event_type.as_str();
    let is_opening = event_type == SessionEventType::AgentToolCallInvoked.as_str();
    let is_success = event_type == SessionEventType::AgentToolCallCompleted.as_str();
    if !is_opening && !is_success && event_type != SessionEventType::AgentToolCallFailed.as_str() {
        return false;
    }
    let Some(tool_name) = event.payload.get("toolName").and_then(Value::as_str) else {
        return false;
    };
    let body = body.map(body_value_of);
    let call = ToolCallRecord {
        tool_name,
        input: body.as_ref().filter(|_| is_opening),
        result: body.as_ref().filter(|_| !is_opening),
        is_success,
    };
    driver.task_list_change(&call).is_some()
}

// A tool row's body as a value: the JSON it holds, else its text, since a provider may send a
// result as plain text.
fn body_value_of(body: &str) -> Value {
    serde_json::from_str(body).unwrap_or_else(|_| Value::String(body.to_owned()))
}
