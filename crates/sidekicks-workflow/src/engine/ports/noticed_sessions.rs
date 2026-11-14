//! A session binder for a test whose runs bind nothing, keeping each session its notices named.

use std::path::PathBuf;
use std::sync::Mutex;

use futures::future::BoxFuture;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::keyed_lock::KeyHold;
use sidekicks_std::mutex_lock::lock;
use sidekicks_workspace::run_setup_gates::RunSetupGateError;
use sidekicks_workspace::run_setup_gates::execution_root::context::{
    RunContextBinding, SessionRunBinder,
};

use super::REFUSED_PORT_CALL;

/// Refuses every binding and keeps, in order, the session each context notice named.
#[derive(Default)]
pub(crate) struct NoticedSessions(Mutex<Vec<SessionId>>);

impl NoticedSessions {
    /// The sessions the notices named so far.
    pub(crate) fn sessions(&self) -> Vec<SessionId> {
        lock(&self.0).clone()
    }
}

impl SessionRunBinder for NoticedSessions {
    fn bind_session_run<'a>(
        &'a self,
        _session_id: SessionId,
        _run_id: &'a str,
        _opening_words: &'a str,
    ) -> BoxFuture<'a, Result<RunContextBinding, RunSetupGateError>> {
        Box::pin(async { Err(RunSetupGateError::Failed(REFUSED_PORT_CALL.into())) })
    }

    fn hold_checkout<'a>(
        &'a self,
        _binding: &'a RunContextBinding,
    ) -> BoxFuture<'a, KeyHold<'a, PathBuf>> {
        panic!("{REFUSED_PORT_CALL}")
    }

    fn note_context_changed(&self, session_id: SessionId) {
        lock(&self.0).push(session_id);
    }
}
