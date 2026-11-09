//! What the daemon knows of the conversations a person typed in a terminal on one terminal
//! service between its reads of them: the ones its last listing named, each moved by the frames
//! of it since, so a listing while the service is away still names them, and the ones a seat of
//! the daemon's holds, so no conversation takes a second seat and one a seat keeps for a running
//! command reads as working.

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
    // Held while one exchange resumes a conversation and writes its message.
    writing: tokio::sync::Mutex<()>,
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
    /// terminal conversation the service holds, and answers it with each conversation a seat
    /// holds reading as working: a seat outlives its turn only while a command of it runs.
    pub(crate) fn remember(
        &self,
        mut listed: Vec<TerminalProviderSession>,
    ) -> Vec<TerminalProviderSession> {
        let mut seen = lock(&self.seen);
        mark_held_working(&seen.held, &mut listed);
        seen.listed = Some(listed.clone());
        listed
    }

    /// Takes over `earlier`'s last listing, for a service that takes the home of the one `earlier`
    /// belongs to, so the terminals it named are still answered for while the new one is away.
    pub(crate) fn take_listing_from(&self, earlier: &Self) {
        let listed = lock(&earlier.seen).listed.clone();
        lock(&self.seen).listed = listed;
    }

    /// Whether the last listing named `thread_id`, a terminal's own conversation.
    pub(crate) fn remembers(&self, thread_id: &str) -> bool {
        lock(&self.seen).listed.as_ref().is_some_and(|listed| {
            listed
                .iter()
                .any(|session| session.thread_id.as_str() == thread_id)
        })
    }

    /// Forgets the last listing, once every terminal in it gave the service up.
    pub(crate) fn forget_listing(&self) {
        lock(&self.seen).listed = None;
    }

    /// The conversations the last listing named, as a service away for `away` answers for them:
    /// each at its last state within the terminal's reconnect window, working where a seat holds
    /// it, and unreachable past it, when the terminal gave up on the service for good. `None`
    /// before any listing.
    pub(crate) fn recall(&self, away: Duration) -> Option<Vec<TerminalProviderSession>> {
        let seen = lock(&self.seen);
        let mut recalled = seen.listed.clone()?;
        if away >= TERMINAL_RECONNECT_WINDOW {
            for session in &mut recalled {
                session.state = TerminalProviderSessionState::Unreachable;
            }
        } else {
            mark_held_working(&seen.held, &mut recalled);
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

    /// Waits for the service's exchanges to be free to resume a conversation and write a message,
    /// holding them until the guard drops; one exchange writes at a time.
    pub(crate) async fn write_turn(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.writing.lock().await
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

// Reads each of `sessions` a seat holds as working.
fn mark_held_working(held: &HashSet<String>, sessions: &mut [TerminalProviderSession]) {
    for session in sessions
        .iter_mut()
        .filter(|session| held.contains(session.thread_id.as_str()))
    {
        session.state = TerminalProviderSessionState::Working;
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
