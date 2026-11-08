//! The tool calls a session's helpers start, which carry no row of the session's: each call's
//! tool name and arguments kept until its result, for its trace. A tool server's call Claude Code
//! runs in the background is held by its task until the task's notification, so its stand-in
//! result closes nothing. A helper's calls still awaiting a result are dropped when it ends, and a
//! held call when Claude Code's list of background tasks leaves its task out.

use std::collections::{HashMap, HashSet};

use serde_json::value::RawValue;
use sidekicks_contracts::session::id::SessionId;

use super::{
    ClaudeKeptTrace, ClaudeMessageFrame, is_tool_call_block, read_raw_value, take_raw_value,
};
use crate::driver::claude::delivery::commands::{CLAUDE_TOOL_SERVER_TASK_TYPE, ClaudeTaskFrame};
use crate::tool_call_arguments::{KeptToolCallArguments, ToolCallArgumentStore};

/// One call a helper started: the helper, the call, its tool's name and its arguments as Claude
/// Code sent them.
pub(crate) struct ClaudeHelperToolCall {
    helper_id: String,
    call_id: String,
    tool_name: String,
    arguments: KeptToolCallArguments,
}

impl ClaudeHelperToolCall {
    /// The call's `tool_use_id`.
    pub(crate) fn call_id(&self) -> &str {
        &self.call_id
    }

    /// The call's trace on `session_id`, with `result` as its result body.
    pub(crate) fn into_trace(
        self,
        session_id: SessionId,
        result: Box<RawValue>,
    ) -> ClaudeKeptTrace {
        ClaudeKeptTrace {
            session_id,
            call_id: self.call_id,
            tool_name: self.tool_name,
            arguments: self.arguments,
            result,
        }
    }
}

/// The tool calls the session's helpers started and have not answered, by `tool_use_id`, and the
/// tool servers' background calls they hold, by task id.
#[derive(Default)]
pub(crate) struct ClaudeHelperToolCalls {
    open: HashMap<String, ClaudeHelperToolCall>,
    held: HashMap<String, ClaudeHelperToolCall>,
}

impl ClaudeHelperToolCalls {
    /// Keeps each call the helper `helper_id`'s `assistant` frame starts, its arguments moved off
    /// the frame into `arguments`.
    pub(crate) fn observe_calls(
        &mut self,
        frame: &mut ClaudeMessageFrame,
        arguments: &ToolCallArgumentStore,
        helper_id: &str,
    ) {
        for block in frame.blocks_mut() {
            if !is_tool_call_block(block) {
                continue;
            }
            let (Some(call_id), Some(tool_name)) = (
                block.id.as_ref().filter(|id| !id.is_empty()),
                block.name.as_ref(),
            ) else {
                continue;
            };
            let call = ClaudeHelperToolCall {
                helper_id: helper_id.to_owned(),
                call_id: call_id.clone(),
                tool_name: tool_name.clone(),
                arguments: arguments.keep(take_raw_value(&mut block.input)),
            };
            // A call id already kept is replaced by its newer call.
            self.open.insert(call_id.clone(), call);
        }
    }

    /// Closes each open call a helper's `user` frame answers, tracing it on `session_id` with the
    /// result's content as Claude Code sent it while `is_tracing`. A held call's stand-in result
    /// closes nothing.
    pub(crate) fn read_traces(
        &mut self,
        frame: &ClaudeMessageFrame,
        session_id: SessionId,
        is_tracing: bool,
    ) -> Vec<ClaudeKeptTrace> {
        let mut traces = Vec::new();
        for block in frame.blocks() {
            if block.block_type.as_deref() != Some("tool_result") {
                continue;
            }
            let Some(call) = block
                .tool_use_id
                .as_ref()
                .and_then(|call_id| self.open.remove(call_id))
            else {
                continue;
            };
            if is_tracing {
                traces.push(call.into_trace(session_id, read_raw_value(block.content.as_deref())));
            }
        }
        traces
    }

    /// Holds the open call a tool server's task `frame` starts, by its task, until the task's
    /// notification; a frame of any other task, or naming no open call, is left.
    pub(crate) fn observe_start(&mut self, frame: &ClaudeTaskFrame) {
        if frame.task_type() != Some(CLAUDE_TOOL_SERVER_TASK_TYPE) {
            return;
        }
        let (Some(task_id), Some(tool_use_id)) = (frame.task_id(), frame.tool_use_id()) else {
            return;
        };
        if let Some(call) = self.open.remove(tool_use_id) {
            self.held.insert(task_id.to_owned(), call);
        }
    }

    /// Takes out the held call whose task the notification `frame` ends; `None` for a task no
    /// helper call is held by.
    pub(crate) fn release(&mut self, frame: &ClaudeTaskFrame) -> Option<ClaudeHelperToolCall> {
        self.held.remove(frame.task_id()?)
    }

    /// Drops each held call whose task the background list `frame` leaves out: Claude Code sends a
    /// task's notification before the list that drops it, so none of those comes; a frame that
    /// carries no list drops nothing.
    pub(crate) fn drop_unlisted(&mut self, frame: &ClaudeTaskFrame) {
        let Some(listed) = frame.listed_task_ids() else {
            return;
        };
        let listed: HashSet<&str> = listed.collect();
        self.held
            .retain(|task_id, _| listed.contains(task_id.as_str()));
    }

    /// Drops each open call of the helper `helper_id`, which ended, so none outlives it; its
    /// background calls stay held until their tasks end.
    pub(crate) fn end_helper(&mut self, helper_id: &str) {
        self.open.retain(|_, call| call.helper_id != helper_id);
    }

    /// Takes out every held call, each by its task, and drops the open ones: the session's process
    /// is gone.
    pub(crate) fn take_held(&mut self) -> Vec<(String, ClaudeHelperToolCall)> {
        self.open.clear();
        self.held.drain().collect()
    }
}
