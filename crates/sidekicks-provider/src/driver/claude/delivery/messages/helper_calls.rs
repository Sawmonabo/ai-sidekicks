//! The tool calls a session's helpers start, which carry no row of the session's: each call's
//! tool name and arguments kept until its result, for its trace.

use std::num::NonZeroUsize;

use lru::LruCache;
use serde_json::value::RawValue;
use sidekicks_contracts::session::id::SessionId;

use super::{
    ClaudeMessageFrame, claude_tool_trace, is_tool_call_block, read_raw_value, take_raw_value,
};
use crate::port::tool_traces::ToolTrace;

/// The most calls a session's helpers keep awaiting their results; past it the oldest is forgotten.
const CLAUDE_HELPER_TOOL_CALLS_MAX: NonZeroUsize = NonZeroUsize::new(256).expect("256 is not zero");

/// The tool calls the session's helpers started and have not answered, by `tool_use_id`, each
/// with its tool's name and its arguments as Claude Code sent them, kept until its result; past
/// the cap the oldest is forgotten.
pub(crate) struct ClaudeHelperToolCalls(LruCache<String, (String, Box<RawValue>)>);

impl Default for ClaudeHelperToolCalls {
    fn default() -> Self {
        Self(LruCache::new(CLAUDE_HELPER_TOOL_CALLS_MAX))
    }
}

impl ClaudeHelperToolCalls {
    /// Keeps each call a helper's `assistant` frame starts, its arguments moved off the frame.
    pub(crate) fn observe_calls(&mut self, frame: &mut ClaudeMessageFrame) {
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
            let arguments = take_raw_value(&mut block.input);
            self.0.push(call_id.clone(), (tool_name.clone(), arguments));
        }
    }

    /// Closes each kept call a helper's `user` frame answers, tracing it on `session_id` with the
    /// result's content as Claude Code sent it while `is_tracing`.
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
            let Some((tool_name, arguments)) = self.0.pop(call_id) else {
                continue;
            };
            if is_tracing {
                let result = read_raw_value(block.content.as_deref());
                traces.push(claude_tool_trace(
                    session_id, call_id, &tool_name, arguments, result,
                ));
            }
        }
        traces
    }

    /// Forgets every kept call: the session's process is gone.
    pub(crate) fn forget(&mut self) {
        self.0.clear();
    }
}
