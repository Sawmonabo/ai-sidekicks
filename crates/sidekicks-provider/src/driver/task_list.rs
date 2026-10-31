//! The agent's own task list as a driver reads it from its provider's tool calls: what one call
//! does to the list, and the list folded from those changes. The transcript adds no row for a call
//! that reads as a task-list change, and the working line reads the folded list.

use serde_json::Value;
use sidekicks_contracts::turn::{TurnTask, TurnTaskState};
use sidekicks_contracts::wire::text::NonEmptyText;

/// One tool call as the transcript holds it: the tool's name, its input, and, once it ended, its
/// result and whether it succeeded.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ToolCallRecord<'call> {
    /// The tool's name, as the provider sent it.
    pub tool_name: &'call str,
    /// The call's input, where the record holds it.
    pub input: Option<&'call Value>,
    /// The call's result, `None` until the call ended.
    pub result: Option<&'call Value>,
    /// Whether the call ended and succeeded.
    pub is_success: bool,
}

/// One task as the provider lists it: its id where the provider gives one, and the task.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ListedTask {
    /// The provider's id of the task; `None` for a provider that lists tasks without ids.
    pub task_id: Option<String>,
    /// The task.
    pub task: TurnTask,
}

/// What one task-list call does to the list.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TaskListChange {
    /// The whole list, replacing the one held.
    Reseeded(Vec<ListedTask>),
    /// One task added at the end, with the id the provider gave it.
    Created(ListedTask),
    /// One task, found by its id, changed: each member present replaces the held one.
    Updated {
        /// The task's id.
        task_id: String,
        /// Its new words.
        text: Option<NonEmptyText>,
        /// Where it stands now.
        state: Option<TurnTaskState>,
    },
    /// One task, found by its id, removed.
    Deleted {
        /// The task's id.
        task_id: String,
    },
    /// A task-list call that changes nothing, such as a read of one task.
    Nothing,
}

/// A turn's task list, folded from its changes in the order the provider made them.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TaskListFold {
    tasks: Vec<ListedTask>,
}

impl TaskListFold {
    /// Applies `change`; answers whether the list changed. An update or delete naming no held
    /// task changes nothing.
    pub fn apply(&mut self, change: TaskListChange) -> bool {
        match change {
            TaskListChange::Reseeded(tasks) => {
                let is_changed = self.tasks != tasks;
                self.tasks = tasks;
                is_changed
            }
            TaskListChange::Created(task) => {
                self.tasks.push(task);
                true
            }
            TaskListChange::Updated {
                task_id,
                text,
                state,
            } => {
                let Some(held) = self.held_mut(&task_id) else {
                    return false;
                };
                let before = held.task.clone();
                if let Some(text) = text {
                    held.task.text = text;
                }
                if let Some(state) = state {
                    held.task.state = state;
                }
                held.task != before
            }
            TaskListChange::Deleted { task_id } => {
                let before = self.tasks.len();
                self.tasks
                    .retain(|held| held.task_id.as_deref() != Some(task_id.as_str()));
                self.tasks.len() != before
            }
            TaskListChange::Nothing => false,
        }
    }

    /// The list in the agent's order.
    pub fn tasks(&self) -> Vec<TurnTask> {
        self.tasks.iter().map(|held| held.task.clone()).collect()
    }

    fn held_mut(&mut self, task_id: &str) -> Option<&mut ListedTask> {
        self.tasks
            .iter_mut()
            .find(|held| held.task_id.as_deref() == Some(task_id))
    }
}
