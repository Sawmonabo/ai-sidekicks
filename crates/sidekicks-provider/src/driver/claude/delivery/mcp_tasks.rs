//! A tool server's call Claude Code runs in the background: its result in the turn is a stand-in,
//! so the call stays open, on the run that started it, until the task's notification closes it
//! with Claude Code's summary and the files the call returned by reference. A call that ends
//! failed or stopped is kept settled until the process ends, so a later ending of its task still
//! closes it again. Such a task is no running command.

pub(crate) mod restore;
pub(crate) mod restored_calls;

use std::collections::{HashMap, HashSet};
use std::num::NonZeroUsize;

use lru::LruCache;
use serde::Deserialize;
use serde_json::value::RawValue;
use sidekicks_contracts::event::declared_variants::ToolCallEndCause;

use crate::driver::claude::delivery::commands::{CLAUDE_TOOL_SERVER_TASK_TYPE, ClaudeTaskFrame};
use crate::driver::claude::delivery::mcp_tasks::restored_calls::ClaudeRestoredCalls;
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
    /// The task notification or saved ending that ended the call, as Claude Code wrote it, kept
    /// for the call's trace while `Record traces` is on; none for an end with neither.
    pub(crate) notification: Option<Box<RawValue>>,
}

/// One held or settled call, kept by its task, with the newest task run a frame of it named.
pub(crate) struct ClaudeHeldCall {
    /// The call.
    pub(crate) tool_use_id: String,
    /// Its opening, on the run that started it.
    pub(crate) opened: ClaudeOpenToolCall,
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

// A call whose task an undo is stopping, until the stop answers: still running, from the held or
// the settled calls, or ended meanwhile as its task's notification ended it.
enum ClaudeStoppingCall {
    Running {
        call: ClaudeHeldCall,
        is_settled: bool,
    },
    Ended {
        end: ClaudeHeldCallEnd,
        is_settled: bool,
    },
}

/// What became of a call whose task an undo stopped, once the stop answered.
pub(crate) enum ClaudeStopOutcome {
    /// The call closes with this end: Claude Code took the stop, or the task ended meanwhile.
    Ended(ClaudeHeldCallEnd),
    /// The stop was not taken and the task still runs, so the call is held again for its ending.
    HeldAgain,
    /// The stream began no stop of the task: it neither held nor kept the call.
    NotBegun,
}

/// One session's tool-server calls running in the background, held open until their tasks end,
/// the calls settled failed or stopped, kept until the process ends, and the calls whose tasks an
/// undo is stopping.
pub(crate) struct ClaudeToolServerTasks {
    held: HashMap<String, ClaudeHeldCall>,
    settled: LruCache<String, ClaudeHeldCall>,
    stopping: HashMap<String, ClaudeStoppingCall>,
}

impl Default for ClaudeToolServerTasks {
    fn default() -> Self {
        Self {
            held: HashMap::new(),
            settled: LruCache::new(CLAUDE_SETTLED_CALLS_MAX),
            stopping: HashMap::new(),
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
        self.held.insert(task_id.to_owned(), call);
    }

    /// Whether the call `tool_use_id` is held open, so its stand-in result closes nothing.
    pub(crate) fn holds_call(&self, tool_use_id: &str) -> bool {
        self.held
            .values()
            .any(|held| held.tool_use_id == tool_use_id)
    }

    /// How many calls are held open.
    pub(crate) fn held_count(&self) -> usize {
        self.held.len()
    }

    /// The task the held call `tool_use_id` runs as, and the call's opening; `None` for a call not
    /// held.
    pub(crate) fn held_call(&self, tool_use_id: &str) -> Option<(&str, &ClaudeOpenToolCall)> {
        self.held
            .iter()
            .find(|(_, held)| held.tool_use_id == tool_use_id)
            .map(|(task_id, held)| (task_id.as_str(), &held.opened))
    }

    /// Takes every held call out, each by its task, as the process ends with them still running,
    /// with each call an undo's stop of its task left open, whether its task still ran or ended
    /// while the stop waited; the settled calls are left.
    pub(crate) fn take_held(&mut self) -> Vec<(String, ClaudeHeldCall)> {
        let stopping = self
            .stopping
            .drain()
            .filter_map(|(task_id, stopping)| match stopping {
                ClaudeStoppingCall::Running {
                    call,
                    is_settled: false,
                } => Some((task_id, call)),
                ClaudeStoppingCall::Ended {
                    end,
                    is_settled: false,
                } => Some((
                    task_id,
                    ClaudeHeldCall {
                        tool_use_id: end.tool_use_id,
                        opened: end.opened,
                        newest_run_id: None,
                    },
                )),
                // A settled call's close is already in the log.
                ClaudeStoppingCall::Running {
                    is_settled: true, ..
                }
                | ClaudeStoppingCall::Ended {
                    is_settled: true, ..
                } => None,
            });
        self.held.drain().chain(stopping).collect()
    }

    /// Moves the call the tool server's task `task_id` runs, held or settled, among the calls an
    /// undo is stopping, so an ending of its task before the stop answers is kept for that answer
    /// and closes nothing; a task neither holds is left.
    pub(crate) fn begin_stop(&mut self, task_id: &str) {
        let (call, is_settled) = match self.held.remove(task_id) {
            Some(call) => (call, false),
            None => match self.settled.pop(task_id) {
                Some(call) => (call, true),
                None => return,
            },
        };
        self.stopping.insert(
            task_id.to_owned(),
            ClaudeStoppingCall::Running { call, is_settled },
        );
    }

    /// Ends the stop of task `task_id` that `begin_stop` began, `is_stopped` saying whether Claude
    /// Code took it: the call ends stopped with no body when it did, as its task's ending ended it
    /// when that came first, and is held or kept settled again otherwise, so a later ending of its
    /// task still closes it.
    pub(crate) fn finish_stop(&mut self, task_id: &str, is_stopped: bool) -> ClaudeStopOutcome {
        match self.stopping.remove(task_id) {
            None => ClaudeStopOutcome::NotBegun,
            Some(ClaudeStoppingCall::Ended { end, .. }) => ClaudeStopOutcome::Ended(end),
            Some(ClaudeStoppingCall::Running { call, .. }) if is_stopped => {
                ClaudeStopOutcome::Ended(ClaudeHeldCallEnd {
                    tool_use_id: call.tool_use_id,
                    opened: call.opened,
                    outcome: ClaudeToolCallOutcome::Failed {
                        end_cause: Some(ToolCallEndCause::Stopped),
                    },
                    text: None,
                    notification: None,
                })
            }
            Some(ClaudeStoppingCall::Running { call, is_settled }) => {
                if is_settled {
                    self.settled.push(task_id.to_owned(), call);
                } else {
                    self.held.insert(task_id.to_owned(), call);
                }
                ClaudeStopOutcome::HeldAgain
            }
        }
    }

    /// Each held call's task id and call id.
    pub(crate) fn held_tasks(&self) -> impl Iterator<Item = (&str, &str)> {
        self.held
            .iter()
            .map(|(task_id, held)| (task_id.as_str(), held.tool_use_id.as_str()))
    }

    /// Whether the call the tool server's task `task_id` runs is held open.
    pub(crate) fn holds_task(&self, task_id: &str) -> bool {
        self.held.contains_key(task_id)
    }

    /// The end of the held or settled call whose task the notification `frame` ends: `completed`
    /// with the summary and the files, `stopped` failed with no body, and any other status
    /// failed with the summary and the files. A completed call is released; a failed or stopped
    /// one is settled. `None` for a frame of an earlier task run, or of any other task, and for a
    /// call whose task an undo is stopping, which keeps the end for the stop's answer.
    pub(crate) fn release(&mut self, frame: &ClaudeTaskFrame) -> Option<ClaudeHeldCallEnd> {
        let task_id = frame.task_id()?;
        let run_id = frame.run_id();
        if let Some(stopping) = self.stopping.get_mut(task_id) {
            let is_ending = match stopping {
                ClaudeStoppingCall::Running { call, .. } => call.take_run(run_id),
                ClaudeStoppingCall::Ended { .. } => false,
            };
            if is_ending
                && let Some(ClaudeStoppingCall::Running { call, is_settled }) =
                    self.stopping.remove(task_id)
            {
                let (outcome, text) = read_end_outcome(frame);
                let end = ClaudeHeldCallEnd {
                    tool_use_id: call.tool_use_id,
                    opened: call.opened,
                    outcome,
                    text,
                    notification: None,
                };
                self.stopping.insert(
                    task_id.to_owned(),
                    ClaudeStoppingCall::Ended { end, is_settled },
                );
            }
            return None;
        }
        let call = if let Some(held) = self.held.get_mut(task_id) {
            if !held.take_run(run_id) {
                return None;
            }
            self.held.remove(task_id)?
        } else {
            if !self.settled.peek_mut(task_id)?.take_run(run_id) {
                return None;
            }
            self.settled.pop(task_id)?
        };
        let (outcome, text) = read_end_outcome(frame);
        if outcome == ClaudeToolCallOutcome::Completed {
            return Some(ClaudeHeldCallEnd {
                tool_use_id: call.tool_use_id,
                opened: call.opened,
                outcome,
                text,
                notification: None,
            });
        }
        Some(self.settle(task_id.to_owned(), call, outcome, text))
    }

    /// The ends of the held calls a background list `frame` leaves out, each failed as stopped
    /// with no body and settled; none for a frame that carries no list. A call `restored` still
    /// awaits the restore of is kept: only its restored start or the first finished reply decides
    /// it.
    pub(crate) fn settle_unlisted(
        &mut self,
        frame: &ClaudeTaskFrame,
        restored: &ClaudeRestoredCalls,
    ) -> Vec<ClaudeHeldCallEnd> {
        let Some(listed) = frame.listed_task_ids() else {
            return Vec::new();
        };
        let listed: HashSet<&str> = listed.collect();
        let unlisted: Vec<String> = self
            .held
            .keys()
            .filter(|task_id| {
                !listed.contains(task_id.as_str()) && !restored.is_awaiting(task_id.as_str())
            })
            .cloned()
            .collect();
        unlisted
            .into_iter()
            .filter_map(|task_id| {
                let call = self.held.remove(&task_id)?;
                let outcome = ClaudeToolCallOutcome::Failed {
                    end_cause: Some(ToolCallEndCause::Stopped),
                };
                Some(self.settle(task_id, call, outcome, None))
            })
            .collect()
    }

    /// The held call a progress `frame` of its task reports on, by its `tool_use_id`, with the
    /// frame's summary; `None` for a frame of an earlier task run, of a task not held, or with no
    /// summary.
    pub(crate) fn progress_call(&mut self, frame: &ClaudeTaskFrame) -> Option<(String, String)> {
        let held = self.held.get_mut(frame.task_id()?)?;
        if !held.take_run(frame.run_id()) {
            return None;
        }
        Some((held.tool_use_id.clone(), frame.summary()?.to_owned()))
    }

    /// Forgets every held, settled and stopping call: the session's process is gone.
    pub(crate) fn forget(&mut self) {
        self.held.clear();
        self.settled.clear();
        self.stopping.clear();
    }

    // Keeps `call` settled under its task, the oldest settled call forgotten past the cap, and
    // answers its end, which takes the call's arguments, so a later ending traces it no more.
    fn settle(
        &mut self,
        task_id: String,
        call: ClaudeHeldCall,
        outcome: ClaudeToolCallOutcome,
        text: Option<String>,
    ) -> ClaudeHeldCallEnd {
        let settled = ClaudeHeldCall {
            tool_use_id: call.tool_use_id.clone(),
            opened: call.opened.without_arguments(),
            newest_run_id: call.newest_run_id,
        };
        self.settled.push(task_id, settled);
        ClaudeHeldCallEnd {
            tool_use_id: call.tool_use_id,
            opened: call.opened,
            outcome,
            text,
            notification: None,
        }
    }
}

// How the notification `frame` ends its task's call, and the call's body: `completed` with the
// summary and the files, `stopped` failed with no body, any other status failed with the summary
// and the files.
fn read_end_outcome(frame: &ClaudeTaskFrame) -> (ClaudeToolCallOutcome, Option<String>) {
    match frame.status() {
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
