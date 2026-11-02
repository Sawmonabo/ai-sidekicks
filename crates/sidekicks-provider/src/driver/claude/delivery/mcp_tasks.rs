//! A tool server's call Claude Code runs in the background: its result in the turn is a stand-in,
//! so the call stays open, on the run that started it, until the task's notification closes it
//! with Claude Code's summary and the files the call returned by reference. A call that ends
//! failed or stopped is kept settled until the process ends, so a later ending of its task still
//! closes it again. Such a task is no running command.

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "an exit, a close, a resume and the start read a held call's kept files"
    )
)]
mod restore;

use std::collections::{HashMap, HashSet};
use std::num::NonZeroUsize;

use lru::LruCache;
use serde::Deserialize;
use serde_json::value::RawValue;
use sidekicks_contracts::event::declared_variants::ToolCallEndCause;

use crate::driver::claude::delivery::commands::{CLAUDE_TOOL_SERVER_TASK_TYPE, ClaudeTaskFrame};
use crate::driver::claude::delivery::messages::{ClaudeOpenToolCall, ClaudeToolCallOutcome};
use crate::lenient_json::{LenientElement, lenient_object, read_lenient};

/// The most files a finished call names, as Claude Code caps them.
const CLAUDE_RESOURCE_LINKS_MAX: usize = 50;

/// The most bytes the files' lines take, as Claude Code caps the links' serialized size.
const CLAUDE_RESOURCE_LINKS_MAX_BYTES: usize = 64 * 1024;

/// The most settled calls a session keeps for a later ending; past it the oldest is forgotten.
const CLAUDE_SETTLED_CALLS_MAX: NonZeroUsize = NonZeroUsize::new(1024).expect("1024 is not zero");

// One file a finished call returned by reference.
#[derive(Deserialize)]
struct ClaudeResourceLink {
    #[serde(default, deserialize_with = "read_lenient")]
    uri: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    name: Option<String>,
}

lenient_object!(ClaudeResourceLink);

/// How a held call closes: its opening, which names its run, how it ended, and its body.
pub(crate) struct ClaudeHeldCallEnd {
    /// The call.
    pub(crate) tool_use_id: String,
    /// Its opening, on the run that started it.
    pub(crate) opened: ClaudeOpenToolCall,
    /// How it ended.
    pub(crate) outcome: ClaudeToolCallOutcome,
    /// Claude Code's summary, then a line per file the call returned; none for a stopped call,
    /// whose summary is only the task's name.
    pub(crate) text: Option<String>,
}

// One held or settled call, by its task, with the newest task run a frame of it named.
#[derive(Clone)]
struct ClaudeHeldCall {
    tool_use_id: String,
    opened: ClaudeOpenToolCall,
    newest_run_id: Option<String>,
}

impl ClaudeHeldCall {
    // Takes a frame of the call's task naming `run_id`: false when the frame is late, its run
    // sorting in plain string order before the newest one seen, which it otherwise becomes. A
    // frame naming no run is never late.
    fn take_run(&mut self, run_id: Option<&str>) -> bool {
        let Some(run_id) = run_id else {
            return true;
        };
        match self.newest_run_id.as_deref() {
            Some(newest) if run_id < newest => false,
            Some(newest) if run_id == newest => true,
            Some(_) | None => {
                self.newest_run_id = Some(run_id.to_owned());
                true
            }
        }
    }
}

/// One session's tool-server calls running in the background, held open until their tasks end,
/// and the calls settled failed or stopped, kept until the process ends.
pub(crate) struct ClaudeToolServerTasks {
    held: HashMap<String, ClaudeHeldCall>,
    held_call_ids: HashSet<String>,
    settled: LruCache<String, ClaudeHeldCall>,
}

impl Default for ClaudeToolServerTasks {
    fn default() -> Self {
        Self {
            held: HashMap::new(),
            held_call_ids: HashSet::new(),
            settled: LruCache::new(CLAUDE_SETTLED_CALLS_MAX),
        }
    }
}

impl ClaudeToolServerTasks {
    /// Holds the call a tool server's task `frame` starts, moving its opening out of
    /// `open_tool_calls`; a call not open is not held. A task already held takes the frame's newer
    /// run, and a settled one is held again; a frame of an earlier task run, or of any other task,
    /// is left.
    pub(crate) fn observe_start(
        &mut self,
        frame: &ClaudeTaskFrame,
        open_tool_calls: &mut HashMap<String, ClaudeOpenToolCall>,
    ) {
        if frame.task_type() != Some(CLAUDE_TOOL_SERVER_TASK_TYPE) {
            return;
        }
        let (Some(task_id), Some(tool_use_id)) = (frame.task_id(), frame.tool_use_id()) else {
            return;
        };
        let run_id = frame.run_id();
        if let Some(held) = self.held.get_mut(task_id) {
            held.take_run(run_id);
            return;
        }
        let call = if let Some(settled) = self.settled.peek_mut(task_id) {
            if !settled.take_run(run_id) {
                return;
            }
            self.settled
                .pop(task_id)
                .expect("the settled call was just found")
        } else {
            let Some(opened) = open_tool_calls.remove(tool_use_id) else {
                return;
            };
            ClaudeHeldCall {
                tool_use_id: tool_use_id.to_owned(),
                opened,
                newest_run_id: run_id.map(str::to_owned),
            }
        };
        self.held_call_ids.insert(call.tool_use_id.clone());
        self.held.insert(task_id.to_owned(), call);
    }

    /// The calls held open, whose stand-in results close nothing.
    pub(crate) fn held_call_ids(&self) -> &HashSet<String> {
        &self.held_call_ids
    }

    /// The end of the held or settled call whose task the notification `frame` ends: `completed`
    /// with the summary and the files, `stopped` failed with no body, and any other status
    /// failed with the summary and the files. A completed call is released; a failed or stopped
    /// one is settled. `None` for a frame of an earlier task run, or of any other task.
    pub(crate) fn release(&mut self, frame: &ClaudeTaskFrame) -> Option<ClaudeHeldCallEnd> {
        let task_id = frame.task_id()?;
        let run_id = frame.run_id();
        let call = if let Some(held) = self.held.get_mut(task_id) {
            if !held.take_run(run_id) {
                return None;
            }
            let held = self.held.remove(task_id)?;
            self.held_call_ids.remove(&held.tool_use_id);
            held
        } else {
            if !self.settled.peek_mut(task_id)?.take_run(run_id) {
                return None;
            }
            self.settled.pop(task_id)?
        };
        let (outcome, text) = match frame.status() {
            Some("completed") => (ClaudeToolCallOutcome::Completed, Some(end_text(frame))),
            Some("stopped") => (
                ClaudeToolCallOutcome::Failed {
                    end_cause: Some(ToolCallEndCause::Stopped),
                },
                None,
            ),
            Some(_) | None => (
                ClaudeToolCallOutcome::Failed { end_cause: None },
                Some(end_text(frame)),
            ),
        };
        if outcome == ClaudeToolCallOutcome::Completed {
            return Some(ClaudeHeldCallEnd {
                tool_use_id: call.tool_use_id,
                opened: call.opened,
                outcome,
                text,
            });
        }
        Some(self.settle(task_id.to_owned(), call, outcome, text))
    }

    /// The ends of the held calls a background list `frame` leaves out, each failed as stopped
    /// with no body and settled; none for a frame that carries no list.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the stream hands each background list to the store"
        )
    )]
    pub(crate) fn settle_unlisted(&mut self, frame: &ClaudeTaskFrame) -> Vec<ClaudeHeldCallEnd> {
        let Some(listed) = frame.listed_task_ids() else {
            return Vec::new();
        };
        let listed: HashSet<&str> = listed.collect();
        let unlisted: Vec<String> = self
            .held
            .keys()
            .filter(|task_id| !listed.contains(task_id.as_str()))
            .cloned()
            .collect();
        unlisted
            .into_iter()
            .filter_map(|task_id| {
                let call = self.held.remove(&task_id)?;
                self.held_call_ids.remove(&call.tool_use_id);
                let outcome = ClaudeToolCallOutcome::Failed {
                    end_cause: Some(ToolCallEndCause::Stopped),
                };
                Some(self.settle(task_id, call, outcome, None))
            })
            .collect()
    }

    /// Forgets every held and settled call: the session's process is gone.
    pub(crate) fn forget(&mut self) {
        self.held.clear();
        self.held_call_ids.clear();
        self.settled.clear();
    }

    // Keeps `call` settled under its task, the oldest settled call forgotten past the cap, and
    // answers its end.
    fn settle(
        &mut self,
        task_id: String,
        call: ClaudeHeldCall,
        outcome: ClaudeToolCallOutcome,
        text: Option<String>,
    ) -> ClaudeHeldCallEnd {
        let end = ClaudeHeldCallEnd {
            tool_use_id: call.tool_use_id.clone(),
            opened: call.opened.clone(),
            outcome,
            text,
        };
        self.settled.push(task_id, call);
        end
    }
}

// A finished task's body: Claude Code's summary, then a line per file the call returned.
fn end_text(frame: &ClaudeTaskFrame) -> String {
    let mut text = frame.summary().unwrap_or_default().to_owned();
    for line in resource_link_lines(frame.resource_links()) {
        text.push('\n');
        text.push_str(&line);
    }
    text
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
mod tests;
