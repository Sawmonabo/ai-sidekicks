//! The commands of a session's process apart from its own, such as a staged review's, as rows of
//! the session's running commands under that process's one run. Its frames are read as the
//! session's own are, but a whole background list and the process's end touch only its own rows,
//! since the session's own process keeps its rows in the same set.

use std::sync::{Arc, Mutex};

use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::mutex_lock::lock;

use super::{ClaudeCommandFact, ClaudeCommandTasks, ClaudeTaskFrame};
use crate::command::running_set::RunningCommandSets;
use crate::driver::claude::delivery::messages::ClaudeMessageFrame;
use crate::driver::claude::event_normalizer::ClaudeWireFrameKind;
use crate::port::running_command_publisher::{ProviderCommandEnd, RunningCommandPublisher};

/// How a command of the process ends when its task leaves the background list or outlives the
/// process: stopped by Claude Code, as a task of a process that ended is.
const STOPPED_BY_PROVIDER: ProviderCommandEnd = ProviderCommandEnd {
    exit_code: None,
    is_stopped_by_provider: true,
    summary: None,
};

/// One apart process's command tasks, each a row under `run_id` in its session's running
/// commands.
pub(crate) struct ClaudeApartRunCommands {
    session_id: SessionId,
    run_id: RunId,
    sets: Arc<RunningCommandSets>,
    tasks: Mutex<ClaudeCommandTasks>,
}

impl ClaudeApartRunCommands {
    /// The commands of a process of `session_id` that runs only `run_id`, reported to `sets`,
    /// which leave them alone at the session's own process's whole list and end.
    pub(super) fn new(session_id: SessionId, run_id: RunId, sets: Arc<RunningCommandSets>) -> Self {
        sets.apart_run_started(session_id, run_id);
        Self {
            session_id,
            run_id,
            sets,
            tasks: Mutex::default(),
        }
    }

    /// Reads one frame of `frame_kind` the process wrote, its lead's or a helper's: a Bash or
    /// Monitor call's line, and a task's start, move to the background or end.
    pub(crate) fn read_frame(&self, frame_kind: &str, text: &str) {
        let Some(kind) = ClaudeWireFrameKind::read(frame_kind) else {
            return;
        };
        let mut tasks = lock(&self.tasks);
        if kind == ClaudeWireFrameKind::Assistant {
            if let Ok(message) = serde_json::from_str::<ClaudeMessageFrame>(text) {
                tasks.observe_calls(&message);
            }
            return;
        }
        if !kind.is_task() {
            return;
        }
        let Some(frame) = ClaudeTaskFrame::read(text) else {
            return;
        };
        let held_in_background: Vec<_> = tasks
            .tasks
            .iter()
            .filter(|(_, task)| task.start.is_backgrounded)
            .map(|(task_id, task)| (task_id.clone(), task.start.command_id.clone()))
            .collect();
        match tasks.read_frame(&kind, &frame, self.session_id, Some(self.run_id)) {
            // The set's own reseed would end the session process's background rows too, so the
            // list's changes are told row by row.
            Some(ClaudeCommandFact::Listed { listed, .. }) => {
                for (task_id, command_id) in held_in_background {
                    if !tasks.tasks.contains_key(&task_id) {
                        self.sets
                            .command_ended(self.session_id, command_id, STOPPED_BY_PROVIDER);
                    }
                }
                for start in listed {
                    self.sets.command_moved_to_background(start);
                }
            }
            Some(fact) => fact.publish(&*self.sets),
            None => {}
        }
    }

    /// Ends every row still open, once the process ended and its tasks with it.
    pub(crate) fn end(&self) {
        let tasks = std::mem::take(&mut *lock(&self.tasks));
        for task in tasks.tasks.into_values() {
            self.sets
                .command_ended(self.session_id, task.start.command_id, STOPPED_BY_PROVIDER);
        }
        self.sets.apart_run_ended(self.session_id, self.run_id);
    }
}
