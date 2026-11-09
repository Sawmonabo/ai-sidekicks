//! What the daemon knows of the conversations a person typed in a terminal on one terminal
//! service between its reads of them: the ones its last listing named, each moved by the frames
//! of it since, so a listing while the service is away still names them, and the ones a seat of
//! the daemon's holds, so no conversation takes a second seat.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Deserialize;
use serde_json::value::RawValue;
use sidekicks_contracts::session::controls::methods::{
    TerminalProviderSession, TerminalProviderSessionState,
};
use sidekicks_std::mutex_lock::lock;

use super::TERMINAL_RECONNECT_WINDOW;
use crate::driver::codex::event_normalizer::CODEX_THREAD_STATUS_CHANGED_METHOD;
use crate::driver::codex::service::supervisor::routing::CODEX_THREAD_CLOSED_METHOD;
use crate::driver::codex::thread::view::CodexThreadStatus;
use crate::driver::codex::transport::connection::read_codex_object;

/// The terminal conversations one service listed last and the ones a seat holds, bounded by the
/// conversations the service holds loaded.
#[derive(Default)]
pub(crate) struct CodexTerminalConversations {
    seen: Mutex<SeenConversations>,
}

#[derive(Default)]
struct SeenConversations {
    // The last listing, each conversation's state moved by its frames since; `None` before the
    // first listing.
    listed: Option<Vec<TerminalProviderSession>>,
    // The conversations a seat of the daemon's holds.
    held: HashSet<String>,
}

// The member of `thread/status/changed` the memory reads.
#[derive(Deserialize)]
struct StatusChange {
    status: CodexThreadStatus,
}

impl CodexTerminalConversations {
    /// Remembers `listed` in place of everything remembered before, since a listing names every
    /// terminal conversation the service holds.
    pub(crate) fn remember(&self, listed: &[TerminalProviderSession]) {
        lock(&self.seen).listed = Some(listed.to_vec());
    }

    /// The conversations the last listing named, as a service away for `away` answers for them:
    /// each at its last state within the terminal's reconnect window, unreachable past it, when
    /// the terminal gave up on the service for good. `None` before any listing.
    pub(crate) fn recall(&self, away: Duration) -> Option<Vec<TerminalProviderSession>> {
        let mut recalled = lock(&self.seen).listed.clone()?;
        if away >= TERMINAL_RECONNECT_WINDOW {
            for session in &mut recalled {
                session.state = TerminalProviderSessionState::Unreachable;
            }
        }
        Some(recalled)
    }

    /// Moves a remembered conversation by one frame of it: a status change sets its state, and
    /// its unload or close forgets it. Any other frame, or one of a conversation not remembered,
    /// changes nothing.
    pub(crate) fn observe_frame(&self, method: &str, params: &RawValue, thread_id: &str) {
        let status = if method == CODEX_THREAD_CLOSED_METHOD {
            CodexThreadStatus::NotLoaded
        } else if method == CODEX_THREAD_STATUS_CHANGED_METHOD
            && let Some(change) = read_codex_object::<StatusChange>(params.get())
        {
            change.status
        } else {
            return;
        };
        let mut seen = lock(&self.seen);
        let Some(listed) = seen.listed.as_mut() else {
            return;
        };
        match read_terminal_session_state(status) {
            Some(state) => {
                for session in listed
                    .iter_mut()
                    .filter(|session| session.thread_id.as_str() == thread_id)
                {
                    session.state = state;
                }
            }
            None => listed.retain(|session| session.thread_id.as_str() != thread_id),
        }
    }

    /// Claims a seat on `thread_id` until the claim drops; `None` while another seat holds it.
    pub(crate) fn claim_seat(self: &Arc<Self>, thread_id: &str) -> Option<TerminalSeatClaim> {
        let is_claimed = lock(&self.seen).held.insert(thread_id.to_owned());
        is_claimed.then(|| TerminalSeatClaim {
            conversations: Arc::clone(self),
            thread_id: thread_id.to_owned(),
        })
    }
}

/// A seat's claim on one terminal conversation, let go as it drops.
pub(crate) struct TerminalSeatClaim {
    conversations: Arc<CodexTerminalConversations>,
    thread_id: String,
}

impl Drop for TerminalSeatClaim {
    fn drop(&mut self) {
        lock(&self.conversations.seen).held.remove(&self.thread_id);
    }
}

/// Where a terminal conversation stands for a thread `status`: working while a turn runs, idle
/// otherwise; `None` for one no longer loaded, which no terminal holds.
pub(crate) fn read_terminal_session_state(
    status: CodexThreadStatus,
) -> Option<TerminalProviderSessionState> {
    match status {
        CodexThreadStatus::NotLoaded => None,
        CodexThreadStatus::Active => Some(TerminalProviderSessionState::Working),
        CodexThreadStatus::Idle | CodexThreadStatus::SystemError => {
            Some(TerminalProviderSessionState::Idle)
        }
    }
}
