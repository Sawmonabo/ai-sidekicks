//! The tool calls a session's helpers start, which carry no row of the session's: each call's
//! tool name and arguments kept until its result, for its trace. A tool server's call Claude Code
//! runs in the background is held by its task until the task's notification, so its stand-in
//! result closes nothing. A helper's calls still awaiting a result are dropped when it ends, and
//! what is kept is bounded by count and by the arguments' bytes, the oldest forgotten first.

use std::num::NonZeroUsize;

use lru::LruCache;
use serde_json::value::RawValue;
use sidekicks_contracts::session::id::SessionId;

use super::{
    ClaudeMessageFrame, claude_tool_trace, is_tool_call_block, read_raw_value, take_raw_value,
};
use crate::driver::claude::delivery::commands::{CLAUDE_TOOL_SERVER_TASK_TYPE, ClaudeTaskFrame};
use crate::port::tool_traces::ToolTrace;

/// The most calls a session's helpers keep awaiting their results, and the most background calls
/// they hold; past either the oldest is forgotten, logged, and never traced.
const CLAUDE_HELPER_TOOL_CALLS_MAX: NonZeroUsize = NonZeroUsize::new(256).expect("256 is not zero");

/// The most bytes of arguments a session's helper calls keep, open and held together; past it the
/// oldest open call, then the oldest held one, is forgotten, logged, and never traced.
const CLAUDE_HELPER_TOOL_CALL_BYTES_MAX: usize = 16 * 1024 * 1024;

/// One call a helper started: the helper, the call, its tool's name and its arguments as Claude
/// Code sent them.
pub(crate) struct ClaudeHelperToolCall {
    helper_id: String,
    call_id: String,
    tool_name: String,
    arguments: Box<RawValue>,
}

impl ClaudeHelperToolCall {
    /// The call's `tool_use_id`.
    pub(crate) fn call_id(&self) -> &str {
        &self.call_id
    }

    /// The call's trace on `session_id`, with `result` as its result body.
    pub(crate) fn into_trace(self, session_id: SessionId, result: Box<RawValue>) -> ToolTrace {
        claude_tool_trace(
            session_id,
            &self.call_id,
            &self.tool_name,
            self.arguments,
            result,
        )
    }

    // The bytes the call's arguments take.
    fn kept_bytes(&self) -> usize {
        self.arguments.get().len()
    }
}

/// The tool calls the session's helpers started and have not answered, by `tool_use_id`, and the
/// tool servers' background calls they hold, by task id, with the bytes their arguments take.
pub(crate) struct ClaudeHelperToolCalls {
    open: LruCache<String, ClaudeHelperToolCall>,
    held: LruCache<String, ClaudeHelperToolCall>,
    kept_bytes: usize,
}

impl Default for ClaudeHelperToolCalls {
    fn default() -> Self {
        Self {
            open: LruCache::new(CLAUDE_HELPER_TOOL_CALLS_MAX),
            held: LruCache::new(CLAUDE_HELPER_TOOL_CALLS_MAX),
            kept_bytes: 0,
        }
    }
}

impl ClaudeHelperToolCalls {
    /// Keeps each call the helper `helper_id`'s `assistant` frame starts on `session_id`, its
    /// arguments moved off the frame.
    pub(crate) fn observe_calls(
        &mut self,
        frame: &mut ClaudeMessageFrame,
        session_id: SessionId,
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
                arguments: take_raw_value(&mut block.input),
            };
            self.kept_bytes += call.kept_bytes();
            // A pushed id already kept replaces its call; any other id pushed out is forgotten.
            if let Some((pushed_out, call)) = self.open.push(call_id.clone(), call) {
                self.kept_bytes -= call.kept_bytes();
                if pushed_out != *call_id {
                    log_forgotten(session_id, &call);
                }
            }
        }
        self.forget_past_bytes(session_id);
    }

    /// Closes each open call a helper's `user` frame answers, tracing it on `session_id` with the
    /// result's content as Claude Code sent it while `is_tracing`. A held call's stand-in result
    /// closes nothing.
    pub(crate) fn read_traces(
        &mut self,
        frame: &ClaudeMessageFrame,
        session_id: SessionId,
        is_tracing: bool,
    ) -> Vec<ToolTrace> {
        let mut traces = Vec::new();
        for block in frame.blocks() {
            if block.block_type.as_deref() != Some("tool_result") {
                continue;
            }
            let Some(call_id) = block.tool_use_id.as_ref() else {
                continue;
            };
            let Some(call) = self.open.pop(call_id) else {
                continue;
            };
            self.kept_bytes -= call.kept_bytes();
            if is_tracing {
                traces.push(call.into_trace(session_id, read_raw_value(block.content.as_deref())));
            }
        }
        traces
    }

    /// Holds the open call a tool server's task `frame` on `session_id` starts, by its task, until
    /// the task's notification; a frame of any other task, or naming no open call, is left.
    pub(crate) fn observe_start(&mut self, frame: &ClaudeTaskFrame, session_id: SessionId) {
        if frame.task_type() != Some(CLAUDE_TOOL_SERVER_TASK_TYPE) {
            return;
        }
        let (Some(task_id), Some(tool_use_id)) = (frame.task_id(), frame.tool_use_id()) else {
            return;
        };
        let Some(call) = self.open.pop(tool_use_id) else {
            return;
        };
        if let Some((pushed_out, call)) = self.held.push(task_id.to_owned(), call) {
            self.kept_bytes -= call.kept_bytes();
            if pushed_out != task_id {
                log_forgotten(session_id, &call);
            }
        }
    }

    /// Takes out the held call whose task the notification `frame` ends; `None` for a task no
    /// helper call is held by.
    pub(crate) fn release(&mut self, frame: &ClaudeTaskFrame) -> Option<ClaudeHelperToolCall> {
        let call = self.held.pop(frame.task_id()?)?;
        self.kept_bytes -= call.kept_bytes();
        Some(call)
    }

    /// Drops each open call of the helper `helper_id`, which ended, so none outlives it; its
    /// background calls stay held until their tasks end.
    pub(crate) fn end_helper(&mut self, helper_id: &str) {
        let ended: Vec<String> = self
            .open
            .iter()
            .filter(|(_, call)| call.helper_id == helper_id)
            .map(|(call_id, _)| call_id.clone())
            .collect();
        for call_id in ended {
            if let Some(call) = self.open.pop(&call_id) {
                self.kept_bytes -= call.kept_bytes();
            }
        }
    }

    /// Takes out every held call, each by its task, and forgets the open ones: the session's
    /// process is gone.
    pub(crate) fn take_held(&mut self) -> Vec<(String, ClaudeHelperToolCall)> {
        self.open.clear();
        self.kept_bytes = 0;
        std::iter::from_fn(|| self.held.pop_lru()).collect()
    }

    // Forgets the oldest open calls, then the oldest held ones, until the arguments kept fit the
    // byte bound.
    fn forget_past_bytes(&mut self, session_id: SessionId) {
        while self.kept_bytes > CLAUDE_HELPER_TOOL_CALL_BYTES_MAX {
            let Some((_, call)) = self.open.pop_lru().or_else(|| self.held.pop_lru()) else {
                return;
            };
            self.kept_bytes -= call.kept_bytes();
            log_forgotten(session_id, &call);
        }
    }
}

// Logs a helper's call forgotten past a bound on what is kept for results, so it is not traced.
fn log_forgotten(session_id: SessionId, call: &ClaudeHelperToolCall) {
    tracing::warn!(
        %session_id,
        helper_id = %call.helper_id,
        tool_use_id = %call.call_id,
        "a Claude Code helper's tool call was forgotten past the bound on calls kept for their \
         results, so it is not traced"
    );
}
