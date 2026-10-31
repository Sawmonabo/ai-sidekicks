//! A Codex turn's readings for the working line: the tokens it received, summed from each metered
//! round's output, and its task list, which each plan Codex sends reseeds whole and an interrupted
//! end empties.

use std::collections::HashMap;

use serde_json::{Map, Value};
use sidekicks_contracts::turn::{ProviderTurnId, TurnTask, TurnTaskState, TurnTasksUpdate};
use sidekicks_contracts::wire::text::NonEmptyText;

use crate::driver::codex::delivery::frames::{CodexFrameDispatch, find_turn_run_id};
use crate::driver::codex::lifecycle::CodexDriver;
use crate::driver::codex::session::state::CodexSessionRecord;
use crate::driver::task_list::{ListedTask, TaskListChange, TaskListFold, ToolCallRecord};
use crate::record_readers::read_non_empty_string;

/// Codex's plan tool, whose call carries the whole plan as its input.
const CODEX_PLAN_TOOL_NAME: &str = "update_plan";

/// The readings of each live turn of a session's own conversation, by turn id; each leaves with
/// its turn's end.
#[derive(Debug, Default)]
pub(crate) struct CodexTurnReadings {
    by_turn_id: HashMap<String, CodexTurnReading>,
}

/// One turn's readings.
#[derive(Debug, Default)]
struct CodexTurnReading {
    tokens_received: u64,
    tasks: TaskListFold,
}

impl CodexTurnReadings {
    /// Adds `output_tokens`, one metered round's output delta, to the turn `turn_id`, answering
    /// the turn's tokens so far. A resent reading meters to a zero delta, so it adds nothing.
    pub(crate) fn add_output_tokens(&mut self, turn_id: &str, output_tokens: u64) -> u64 {
        let reading = self.by_turn_id.entry(turn_id.to_owned()).or_default();
        reading.tokens_received = reading.tokens_received.saturating_add(output_tokens);
        reading.tokens_received
    }

    /// Folds `change` into the turn `turn_id`'s task list, answering the whole list when it
    /// changed.
    pub(crate) fn fold_tasks(
        &mut self,
        turn_id: &str,
        change: TaskListChange,
    ) -> Option<Vec<TurnTask>> {
        let reading = self.by_turn_id.entry(turn_id.to_owned()).or_default();
        reading.tasks.apply(change).then(|| reading.tasks.tasks())
    }

    /// Forgets the turn `turn_id`, answering whether it held a task list, which an interrupted
    /// end empties.
    pub(crate) fn end_turn(&mut self, turn_id: &str) -> bool {
        self.by_turn_id
            .remove(turn_id)
            .is_some_and(|reading| !reading.tasks.tasks().is_empty())
    }
}

impl CodexDriver {
    /// What one Codex tool call does to the agent's task list: every row of an `update_plan` call
    /// reseeds the list from the plan its input carries, a failed call or one with no readable
    /// plan changing nothing; `None` for any other tool.
    #[expect(
        clippy::unused_self,
        reason = "the driver interface asks the driver, which reads the call alone"
    )]
    pub(crate) fn task_list_change(&self, call: &ToolCallRecord<'_>) -> Option<TaskListChange> {
        read_codex_task_list_change(call)
    }
}

// The change a tool call makes to the task list, as `CodexDriver::task_list_change` answers it.
fn read_codex_task_list_change(call: &ToolCallRecord<'_>) -> Option<TaskListChange> {
    if call.tool_name != CODEX_PLAN_TOOL_NAME {
        return None;
    }
    let is_failed = call.result.is_some() && !call.is_success;
    let plan = call.input.and_then(|input| input.get("plan"));
    Some(
        plan.filter(|_| !is_failed)
            .and_then(read_codex_plan)
            .map_or(TaskListChange::Nothing, TaskListChange::Reseeded),
    )
}

/// Folds a `turn/plan/updated` of a live turn of the session's own conversation into the turn's
/// task list, handing the whole list on in `dispatch` when it changed.
pub(crate) fn deliver_codex_plan_update(
    record: &mut CodexSessionRecord,
    members: &Map<String, Value>,
    dispatch: &mut CodexFrameDispatch,
) {
    if read_non_empty_string(members, "threadId") != Some(record.thread_id.as_str()) {
        return;
    }
    let Some(turn_id) = read_non_empty_string(members, "turnId") else {
        return;
    };
    let Some(tasks) = members.get("plan").and_then(read_codex_plan) else {
        return;
    };
    // A plan after its turn ended would hold a list no end clears.
    if record.is_turn_settled(turn_id) {
        return;
    }
    let Some((run_id, _ending)) = find_turn_run_id(record, turn_id) else {
        return;
    };
    let Ok(provider_turn_id) = ProviderTurnId::new(turn_id.to_owned()) else {
        return;
    };
    let changed = record
        .delivery
        .turn_readings
        .fold_tasks(turn_id, TaskListChange::Reseeded(tasks));
    if let Some(tasks) = changed {
        dispatch.turn_tasks.push(TurnTasksUpdate {
            run_id,
            turn_id: provider_turn_id,
            tasks,
        });
    }
}

// A plan as Codex sends it, `[{step, status}]`, read as the whole list it sets; an entry with no
// words or a status Codex does not send is left out. `None` for a plan that is no list.
fn read_codex_plan(plan: &Value) -> Option<Vec<ListedTask>> {
    let entries = plan.as_array()?;
    Some(
        entries
            .iter()
            .filter_map(|entry| {
                let text = NonEmptyText::new(entry.get("step")?.as_str()?.to_owned())?;
                let state = match entry.get("status")?.as_str()? {
                    "pending" => TurnTaskState::NotStarted,
                    // The tool's input spells it in snake case, the app-server's frame in camel.
                    "in_progress" | "inProgress" => TurnTaskState::InProgress,
                    "completed" => TurnTaskState::Done,
                    _ => return None,
                };
                Some(ListedTask {
                    task_id: None,
                    task: TurnTask { text, state },
                })
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::{Value, json};
    use sidekicks_contracts::turn::TurnTaskState;

    use super::{CodexTurnReadings, read_codex_task_list_change};
    use crate::driver::codex::DESCRIPTOR;
    use crate::driver::task_list::{TaskListChange, ToolCallRecord};
    use crate::usage_delta_accountant::{
        CumulativeUsageReading, ThreadBaseEstablishment, UsageAxisCounts, UsageDeltaAccountant,
    };

    const THREAD: &str = "thread-1";

    // Codex's cumulative reading of the thread, as one `thread/tokenUsage/updated` names it.
    fn reading(turn_id: &str, output: u64) -> CumulativeUsageReading {
        CumulativeUsageReading {
            thread_id: THREAD.to_owned(),
            named_turn_id: Some(turn_id.to_owned()),
            cumulative: UsageAxisCounts {
                input: Some(100),
                output: Some(output),
                ..UsageAxisCounts::default()
            },
            declared_per_turn: None,
        }
    }

    // One row of an `update_plan` call.
    fn plan_call<'call>(
        input: &'call Value,
        result: Option<&'call Value>,
        is_success: bool,
    ) -> ToolCallRecord<'call> {
        ToolCallRecord {
            tool_name: "update_plan",
            input: Some(input),
            result,
            is_success,
        }
    }

    // Each turn's tokens are its rounds' output summed: a second round adds its own output, a
    // resent reading adds nothing, and the next turn counts from its own first round.
    #[test]
    fn sums_each_turns_rounds_and_adds_nothing_for_a_resent_reading() {
        let mut accountant = UsageDeltaAccountant::new(DESCRIPTOR.provider_id());
        accountant.establish_thread(THREAD.to_owned(), ThreadBaseEstablishment::Fresh);
        let mut readings = CodexTurnReadings::default();
        let mut received = Vec::new();
        for (turn_id, cumulative_output) in [
            ("turn-1", 40),
            ("turn-1", 100),
            ("turn-1", 100),
            ("turn-2", 130),
        ] {
            let delta = accountant
                .meter_reading(reading(turn_id, cumulative_output))
                .expect("the thread is established");
            let turn_id = delta
                .attributed_turn_id
                .expect("the reading names its turn");
            let output = delta
                .axis_deltas
                .output
                .expect("the reading carries output");
            received.push(readings.add_output_tokens(&turn_id, output));
        }
        assert_eq!(received, [40, 100, 100, 30]);
    }

    // Each row of an `update_plan` call reseeds the list from its input, which replaces the list
    // held; a failed call changes nothing, an interrupted turn's end reports the list it clears,
    // and any other tool is no task-list call.
    #[rstest]
    #[case::opening(None, false)]
    #[case::ending(Some(json!("Plan updated")), true)]
    fn reseeds_on_both_rows_of_a_plan_call_and_clears_at_the_end(
        #[case] result: Option<Value>,
        #[case] is_success: bool,
    ) {
        let first = json!({ "plan": [
            { "step": "Read the code", "status": "completed" },
            { "step": "Write the fix", "status": "in_progress" },
            { "step": "Run the tests", "status": "pending" },
        ]});
        let second = json!({ "plan": [{ "step": "Ship it", "status": "pending" }] });
        let mut readings = CodexTurnReadings::default();

        let change = read_codex_task_list_change(&plan_call(&first, result.as_ref(), is_success))
            .expect("a plan call");
        let tasks = readings
            .fold_tasks("turn-1", change)
            .expect("the list changed");
        let states: Vec<_> = tasks.iter().map(|task| task.state).collect();
        assert_eq!(
            states,
            [
                TurnTaskState::Done,
                TurnTaskState::InProgress,
                TurnTaskState::NotStarted
            ]
        );
        let change = read_codex_task_list_change(&plan_call(&second, result.as_ref(), is_success))
            .expect("a plan call");
        let tasks = readings
            .fold_tasks("turn-1", change)
            .expect("the list changed");
        assert_eq!(tasks.len(), 1, "a plan replaces the list, never appends");
        assert_eq!(tasks[0].text.as_str(), "Ship it");

        let failed = ToolCallRecord {
            tool_name: "update_plan",
            input: Some(&first),
            result: Some(&json!("bad plan")),
            is_success: false,
        };
        assert_eq!(
            read_codex_task_list_change(&failed),
            Some(TaskListChange::Nothing)
        );
        let other = ToolCallRecord {
            tool_name: "shell",
            input: Some(&first),
            result: None,
            is_success: false,
        };
        assert_eq!(read_codex_task_list_change(&other), None);

        assert!(readings.end_turn("turn-1"), "the ended turn held a list");
        assert!(!readings.end_turn("turn-1"), "the list left with its turn");
    }
}
