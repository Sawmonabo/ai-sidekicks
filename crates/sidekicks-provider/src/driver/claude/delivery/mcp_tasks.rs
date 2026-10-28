//! A tool server's call Claude Code runs in the background: its result in the turn is a stand-in,
//! so the call stays open until the task's notification, which closes it with Claude Code's summary
//! and the files the call returned by reference. Such a task is no running command.

use std::collections::{HashMap, HashSet};

use serde::Deserialize;
use serde_json::value::RawValue;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;

use crate::driver::claude::delivery::commands::{CLAUDE_TOOL_SERVER_TASK_TYPE, ClaudeTaskFrame};
use crate::lenient_json::{LenientElement, lenient_object, read_lenient};

/// The most files a finished call names, as Claude Code caps them.
const CLAUDE_RESOURCE_LINKS_MAX: usize = 50;

/// The most bytes the files' lines take, as Claude Code caps the links' serialized size.
const CLAUDE_RESOURCE_LINKS_MAX_BYTES: usize = 64 * 1024;

// One file a finished call returned by reference.
#[derive(Deserialize)]
struct ClaudeResourceLink {
    #[serde(default, deserialize_with = "read_lenient")]
    uri: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    name: Option<String>,
}

lenient_object!(ClaudeResourceLink);

/// The run a held call is on, and its binding.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ClaudeHeldCallRun {
    /// The run.
    pub(crate) run_id: RunId,
    /// Its binding.
    pub(crate) binding_id: RuntimeBindingId,
}

/// How a held call closes once its task's notification arrives.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct ClaudeHeldCallEnd {
    /// The call.
    pub(crate) tool_use_id: String,
    /// The run it is on.
    pub(crate) run: ClaudeHeldCallRun,
    /// Whether it failed or was stopped.
    pub(crate) is_error: bool,
    /// Claude Code's summary, then a line per file the call returned.
    pub(crate) text: String,
}

// One held call, by its task.
struct ClaudeHeldCall {
    tool_use_id: String,
    run: ClaudeHeldCallRun,
}

/// One session's tool-server calls running in the background, held open until their tasks end.
#[derive(Default)]
pub(crate) struct ClaudeToolServerTasks {
    held: HashMap<String, ClaudeHeldCall>,
    held_call_ids: HashSet<String>,
}

impl ClaudeToolServerTasks {
    /// Holds the call a tool server's task `frame` starts open on `run`; any other task is left.
    pub(crate) fn observe_start(
        &mut self,
        frame: &ClaudeTaskFrame,
        run: Option<ClaudeHeldCallRun>,
    ) {
        if frame.task_type() != Some(CLAUDE_TOOL_SERVER_TASK_TYPE) {
            return;
        }
        let (Some(task_id), Some(tool_use_id), Some(run)) =
            (frame.task_id(), frame.tool_use_id(), run)
        else {
            return;
        };
        self.held_call_ids.insert(tool_use_id.to_owned());
        self.held.insert(
            task_id.to_owned(),
            ClaudeHeldCall {
                tool_use_id: tool_use_id.to_owned(),
                run,
            },
        );
    }

    /// The calls held open, whose stand-in results close nothing.
    pub(crate) fn held_call_ids(&self) -> &HashSet<String> {
        &self.held_call_ids
    }

    /// The end of the held call whose task the notification `frame` ends, releasing it; `None`
    /// for any other task.
    pub(crate) fn release(&mut self, frame: &ClaudeTaskFrame) -> Option<ClaudeHeldCallEnd> {
        let held = self.held.remove(frame.task_id()?)?;
        self.held_call_ids.remove(&held.tool_use_id);
        let mut text = frame.summary().unwrap_or_default().to_owned();
        for line in resource_link_lines(frame.resource_links()) {
            text.push('\n');
            text.push_str(&line);
        }
        Some(ClaudeHeldCallEnd {
            tool_use_id: held.tool_use_id,
            run: held.run,
            is_error: frame.status() != Some("completed"),
            text,
        })
    }

    /// Forgets every held call: the session's process is gone.
    pub(crate) fn forget(&mut self) {
        self.held.clear();
        self.held_call_ids.clear();
    }
}

// A line per file a finished call returned, within Claude Code's caps on their count and size.
fn resource_link_lines(links: Option<&RawValue>) -> Vec<String> {
    let Some(links) = links else {
        return Vec::new();
    };
    let Ok(links) = serde_json::from_str::<Vec<LenientElement<ClaudeResourceLink>>>(links.get())
    else {
        return Vec::new();
    };
    let mut lines = Vec::new();
    let mut bytes = 0;
    for link in links
        .into_iter()
        .filter_map(|link| link.0)
        .take(CLAUDE_RESOURCE_LINKS_MAX)
    {
        let Some(uri) = link.uri.filter(|uri| !uri.is_empty()) else {
            continue;
        };
        let line = match link.name.filter(|name| !name.is_empty()) {
            Some(name) => format!("- {name}: {uri}"),
            None => format!("- {uri}"),
        };
        bytes += line.len();
        if bytes > CLAUDE_RESOURCE_LINKS_MAX_BYTES {
            break;
        }
        lines.push(line);
    }
    lines
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
    use sidekicks_contracts::run::id::RunId;

    use super::{ClaudeHeldCallRun, ClaudeToolServerTasks};
    use crate::driver::claude::delivery::commands::ClaudeTaskFrame;

    fn frame(value: &serde_json::Value) -> ClaudeTaskFrame {
        ClaudeTaskFrame::read(&value.to_string()).expect("a task frame")
    }

    // Fails when a tool server's background call closes on its stand-in result rather than on its
    // task's notification, or the notification's files are dropped or kept past the cap. Mutations:
    // `observe_start` holding nothing; `release` leaving the links out; the cap's `take` removed.
    #[test]
    fn a_tool_server_task_holds_its_call_open_until_its_notification() {
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
        assert!(tasks.held_call_ids().contains("call-1"));

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
        assert!(tasks.held_call_ids().is_empty());
    }
}
