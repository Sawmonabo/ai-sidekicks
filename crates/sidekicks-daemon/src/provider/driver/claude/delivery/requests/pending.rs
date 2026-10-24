//! The requests each session holds pending: recorded before they are attributed, so a withdrawal
//! that comes first finds them, marked once handed on to their service, and closed by an answer or
//! a withdrawal, the last close telling every waiter on the session's open asks.

use std::collections::HashMap;

use sidekicks_contracts::session::id::SessionId;
use tokio::sync::oneshot;

use super::{ClaudeHeldAsk, ClaudeHeldQuestion};

/// What a pending request holds the person's answer for.
#[derive(Clone, Debug)]
pub(super) enum HeldRequest {
    /// A tool ask.
    Ask(ClaudeHeldAsk),
    /// A question.
    Question(ClaudeHeldQuestion),
}

impl HeldRequest {
    /// The kind a failed hand-off is recorded under.
    pub(super) fn kind(&self) -> &'static str {
        match self {
            Self::Ask(_) => "permissionAsk",
            Self::Question(_) => "question",
        }
    }
}

/// A request recorded before it is attributed; `admission` tells this recording from a later one
/// under the same id, and `is_handed_on` says its service has it, so a withdrawal is handed on too.
pub(super) struct PendingRequest {
    /// What it holds the answer for.
    pub(super) held: HeldRequest,
    admission: u64,
    /// Whether its service has it.
    pub(super) is_handed_on: bool,
}

// One session's pending requests, and the waiters told when the last one closes.
#[derive(Default)]
struct SessionRequests {
    pending: HashMap<String, PendingRequest>,
    on_closed: Vec<oneshot::Sender<()>>,
}

/// Every session's pending requests.
#[derive(Default)]
pub(super) struct RequestTables {
    by_session: HashMap<SessionId, SessionRequests>,
    next_admission: u64,
}

impl RequestTables {
    /// Records `held` pending under `request_id`, replacing any earlier recording under that id,
    /// and answers this recording's admission.
    pub(super) fn record(
        &mut self,
        session_id: SessionId,
        request_id: &str,
        held: HeldRequest,
    ) -> u64 {
        self.next_admission += 1;
        let admission = self.next_admission;
        self.by_session
            .entry(session_id)
            .or_default()
            .pending
            .insert(
                request_id.to_owned(),
                PendingRequest {
                    held,
                    admission,
                    is_handed_on: false,
                },
            );
        admission
    }

    /// Marks the recording `admission` handed on; `false` when it was closed or recorded again.
    pub(super) fn mark_handed_on(
        &mut self,
        session_id: SessionId,
        request_id: &str,
        admission: u64,
    ) -> bool {
        let Some(pending) = self
            .by_session
            .get_mut(&session_id)
            .and_then(|requests| requests.pending.get_mut(request_id))
            .filter(|pending| pending.admission == admission)
        else {
            return false;
        };
        pending.is_handed_on = true;
        true
    }

    /// Whether the recording `admission` is still pending.
    pub(super) fn is_pending(
        &self,
        session_id: SessionId,
        request_id: &str,
        admission: u64,
    ) -> bool {
        self.held(session_id, request_id)
            .is_some_and(|pending| pending.admission == admission)
    }

    /// The pending request under `request_id`.
    pub(super) fn held(&self, session_id: SessionId, request_id: &str) -> Option<&PendingRequest> {
        self.by_session
            .get(&session_id)
            .and_then(|requests| requests.pending.get(request_id))
    }

    /// Takes a request out of the session's open asks, telling every waiter once the last closes.
    pub(super) fn close(
        &mut self,
        session_id: SessionId,
        request_id: &str,
    ) -> Option<PendingRequest> {
        let requests = self.by_session.get_mut(&session_id)?;
        let closed = requests.pending.remove(request_id)?;
        if requests.pending.is_empty() {
            for waiter in requests.on_closed.drain(..) {
                // A waiter that stopped waiting needs no word.
                waiter.send(()).unwrap_or(());
            }
        }
        Some(closed)
    }

    /// A receiver told once the session's last open ask closes; `None` when none is open.
    pub(super) fn wait_closed(&mut self, session_id: SessionId) -> Option<oneshot::Receiver<()>> {
        let requests = self.by_session.get_mut(&session_id)?;
        if requests.pending.is_empty() {
            return None;
        }
        let (sender, receiver) = oneshot::channel();
        requests.on_closed.push(sender);
        Some(receiver)
    }

    /// Takes every request the session holds, letting its waiters go unanswered.
    pub(super) fn take_session(
        &mut self,
        session_id: SessionId,
    ) -> HashMap<String, PendingRequest> {
        self.by_session
            .remove(&session_id)
            .map(|requests| requests.pending)
            .unwrap_or_default()
    }
}
