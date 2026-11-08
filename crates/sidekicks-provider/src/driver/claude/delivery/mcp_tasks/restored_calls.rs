//! The tasks of the calls a resume held again from the session's log, awaiting the resumed
//! process's restore of them.

use std::collections::HashSet;

/// The tasks of the calls a resume held again from the log, awaiting their restored start: the
/// resumed process's first background list ends those it leaves out, and its first finished reply
/// ends every one left.
#[derive(Default)]
pub(crate) struct ClaudeRestoredCalls {
    awaiting: HashSet<String>,
    is_first_list_taken: bool,
}

impl ClaudeRestoredCalls {
    /// Awaits the restored start of the task `task_id`.
    pub(crate) fn await_restore(&mut self, task_id: String) {
        self.awaiting.insert(task_id);
    }

    /// Stops awaiting the task `task_id`'s restore: its restored start arrived and its call is held
    /// as any other, or an undo's cut took the call.
    pub(crate) fn confirm(&mut self, task_id: &str) {
        self.awaiting.remove(task_id);
    }

    /// Whether the task `task_id` still awaits its restore.
    pub(crate) fn is_awaiting(&self, task_id: &str) -> bool {
        self.awaiting.contains(task_id)
    }

    /// Takes the tasks the resumed process's first background list leaves out of `listed`; nothing
    /// at any later list.
    pub(crate) fn take_unlisted<'a>(
        &mut self,
        listed: impl Iterator<Item = &'a str>,
    ) -> Vec<String> {
        if self.is_first_list_taken {
            return Vec::new();
        }
        self.is_first_list_taken = true;
        let listed: HashSet<&str> = listed.collect();
        let unlisted: Vec<String> = self
            .awaiting
            .iter()
            .filter(|task_id| !listed.contains(task_id.as_str()))
            .cloned()
            .collect();
        for task_id in &unlisted {
            self.awaiting.remove(task_id);
        }
        unlisted
    }

    /// Takes every task still awaiting its restore, at the resumed process's first finished reply.
    pub(crate) fn take_all(&mut self) -> Vec<String> {
        self.awaiting.drain().collect()
    }
}
