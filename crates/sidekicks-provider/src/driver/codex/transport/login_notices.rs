//! The notices one Codex login waits on, on a connection of its own: each completion of a login
//! and the connection's close, handed to the login's wait and to nothing else.

use std::sync::Arc;
use std::time::Duration;

use serde_json::value::RawValue;
use tokio::sync::mpsc;

use crate::driver::codex::transport::connection::{CodexConnectionEvents, CodexForgottenRequest};

/// The notices one login's wait reads, a few at most.
const LOGIN_NOTICE_CAPACITY: usize = 8;

/// What one login's wait reads: a completion notice's params, or the connection's close.
pub(crate) enum LoginNotice {
    /// A login on the service ended, this one or another; the params say which.
    Completed(Box<RawValue>),
    /// The connection closed, in the transport's words.
    Closed(String),
}

/// Hands a login connection's completion notices, those sent under one method, and its close to
/// the login's wait.
pub(crate) struct LoginNotices {
    completed_method: &'static str,
    sender: mpsc::Sender<LoginNotice>,
}

impl LoginNotices {
    /// The events of a login whose completion Codex sends as `completed_method`, with the
    /// receiver its wait reads.
    pub(crate) fn open(completed_method: &'static str) -> (Arc<Self>, mpsc::Receiver<LoginNotice>) {
        let (sender, received) = mpsc::channel(LOGIN_NOTICE_CAPACITY);
        let notices = Self {
            completed_method,
            sender,
        };
        (Arc::new(notices), received)
    }

    fn forward(&self, notice: LoginNotice) {
        if self.sender.try_send(notice).is_err() {
            tracing::debug!("a Codex sign-in's notice came after its wait ended");
        }
    }
}

impl CodexConnectionEvents for LoginNotices {
    fn notification(&self, method: &str, params: Box<RawValue>) {
        if method == self.completed_method {
            self.forward(LoginNotice::Completed(params));
        }
    }

    fn dropped(&self, reason: &str) {
        self.forward(LoginNotice::Closed(reason.to_owned()));
    }

    // The connection holds no ask: it has no responder.
    fn held_requests_dropped(&self, _dropped: Vec<CodexForgottenRequest>) {}

    // A login's connection is let go once its login ends, before any drain matters to it.
    fn service_draining(&self, _message: &str) {}

    // The login's own request reports its deadline.
    fn request_timed_out(&self, _silent_for: Duration) {}

    fn answered_after_timeout(&self) {}
}
