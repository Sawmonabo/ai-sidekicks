//! The seam between a Claude session and the live process that runs it: what the session's modules
//! write to the process and how each write settles. The process side owns the input writer, the
//! control table and the output reader, and hands each request the process sends to the session's
//! task by value.

use futures::future::BoxFuture;
use serde_json::value::RawValue;

use crate::provider::driver::claude::session::errors::ClaudeSessionError;
use crate::provider::driver::claude::session::transport::control::ClaudeControlRequest;
use crate::provider::driver::claude::session::transport::inbound::ClaudeControlAnswer;
use crate::provider::driver::claude::session::transport::user_message::{
    ClaudeUserFrame, ClaudeWriteAttempt,
};

/// One live Claude Code process, past its `initialize` exchange, as a session writes to it.
#[cfg_attr(test, mockall::automock)]
pub(crate) trait ClaudeProcessChannel: Send + Sync {
    /// Sends one control request and settles on its answer. A request that passes its deadline,
    /// or whose caller stops waiting, is also withdrawn with `control_cancel_request`, queued on
    /// the input writer without waiting. Fails with `Unavailable` when the process had already
    /// exited, `InputUnwritable` when the write failed before its first byte, `Unanswered` once
    /// anything was written and no answer came (its deadline, the process's exit, a write cut
    /// short), and `ControlRequestRefused` when Claude Code refused it.
    fn send_control_request(
        &self,
        request: ClaudeControlRequest,
    ) -> BoxFuture<'_, Result<ClaudeControlAnswer, ClaudeSessionError>>;

    /// Answers one request the process sent, under its own id, with `answer` as the response's
    /// payload, reporting how far the write got.
    fn answer_inbound_request(
        &self,
        request_id: String,
        answer: Box<RawValue>,
    ) -> BoxFuture<'_, ClaudeWriteAttempt>;

    /// Writes one user message line, reporting how far the write got.
    fn write_user_frame(&self, frame: ClaudeUserFrame) -> BoxFuture<'_, ClaudeWriteAttempt>;

    /// Stops the process as the system stops a child, ending a running turn without answering
    /// what is queued, and settles once it exited.
    fn terminate(&self) -> BoxFuture<'_, ()>;
}
