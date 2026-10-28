//! The helpers running in each session's foreground: an interrupt moves each to the background
//! first, by the tool call that started it, so the interrupt spares it as it spares every
//! background helper. A helper counts from a `task_started` of a main-thread `local_agent` running
//! in the foreground until it moves to the background or ends.

use std::collections::HashMap;

use serde::Deserialize;
use sidekicks_contracts::session::id::SessionId;

use crate::driver::claude::delivery::commands::CLAUDE_HELPER_TASK_TYPE;
use crate::lenient_json::{lenient_object, read_lenient};

#[derive(Default, Deserialize)]
struct TaskFrame {
    #[serde(default, deserialize_with = "read_lenient")]
    task_id: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    tool_use_id: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    task_type: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    is_backgrounded: Option<bool>,
    #[serde(default, deserialize_with = "read_lenient")]
    parent_task_id: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    patch: Option<TaskPatch>,
}

#[derive(Default, Deserialize)]
struct TaskPatch {
    #[serde(default, deserialize_with = "read_lenient")]
    is_backgrounded: Option<bool>,
}

lenient_object!(TaskFrame, TaskPatch);

/// Each session's foreground helpers, by task id, with the tool call that started each.
#[derive(Default)]
pub(crate) struct ClaudeForegroundHelpers {
    by_session: HashMap<SessionId, HashMap<String, String>>,
}

impl ClaudeForegroundHelpers {
    /// Reads one frame of the session's process for a helper's start, move to the background or
    /// end.
    pub(crate) fn observe_frame(&mut self, session_id: SessionId, frame_kind: &str, text: &str) {
        let is_task_frame = matches!(
            frame_kind,
            "system/task_started" | "system/task_updated" | "system/task_notification"
        );
        if !is_task_frame {
            return;
        }
        let frame = serde_json::from_str::<TaskFrame>(text).unwrap_or_default();
        let Some(task_id) = frame.task_id.filter(|id| !id.is_empty()) else {
            return;
        };
        match frame_kind {
            "system/task_started" => {
                let is_foreground_helper = frame.task_type.as_deref()
                    == Some(CLAUDE_HELPER_TASK_TYPE)
                    && frame.is_backgrounded == Some(false)
                    && frame.parent_task_id.is_none_or(|parent| parent.is_empty());
                let tool_use_id = frame.tool_use_id.filter(|id| !id.is_empty());
                if let (true, Some(tool_use_id)) = (is_foreground_helper, tool_use_id) {
                    self.by_session
                        .entry(session_id)
                        .or_default()
                        .insert(task_id, tool_use_id);
                }
            }
            "system/task_updated" => {
                if frame.patch.and_then(|patch| patch.is_backgrounded) == Some(true) {
                    self.forget_task(session_id, &task_id);
                }
            }
            _ => self.forget_task(session_id, &task_id),
        }
    }

    /// The tool calls that started the session's foreground helpers.
    pub(crate) fn tool_use_ids(&self, session_id: SessionId) -> Vec<String> {
        self.by_session
            .get(&session_id)
            .map(|helpers| helpers.values().cloned().collect())
            .unwrap_or_default()
    }

    /// Forgets a session whose process is gone.
    pub(crate) fn forget_session(&mut self, session_id: SessionId) {
        self.by_session.remove(&session_id);
    }

    fn forget_task(&mut self, session_id: SessionId, task_id: &str) {
        if let Some(helpers) = self.by_session.get_mut(&session_id) {
            helpers.remove(task_id);
        }
    }
}
