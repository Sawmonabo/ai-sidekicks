//! The rollout files a launch's next pass past a stop's end reads on: those of the threads the
//! exports named and of the sessions a turn settled on since the last pass, or every file.

use std::collections::HashSet;

use sidekicks_contracts::session::id::SessionId;

use super::{CodexFollowedRollout, CodexRolloutPlacement, ROLLOUTS_KEPT};

/// The files the next pass past a stop's end reads on, as the exports and settled turns since the
/// last pass named them: every file at a stop's end, which the stop's own passes may have left
/// unread, and once more threads and sessions are named than a launch follows files.
#[derive(Default)]
pub(super) struct CodexNamedThreads {
    is_every: bool,
    // The threads an export's records named.
    exported: HashSet<String>,
    // The sessions a turn settled on, which name every file placed on them.
    settled: HashSet<SessionId>,
}

impl CodexNamedThreads {
    // Whether nothing is named.
    pub(super) fn is_empty(&self) -> bool {
        !self.is_every && self.exported.is_empty() && self.settled.is_empty()
    }

    // Every file is named.
    pub(super) fn name_every(&mut self) {
        *self = Self {
            is_every: true,
            ..Self::default()
        };
    }

    // Names `threads`, an export's records'.
    pub(super) fn name_exported(&mut self, threads: impl IntoIterator<Item = String>) {
        if !self.is_every {
            self.exported.extend(threads);
            self.name_every_past_kept();
        }
    }

    // Names `sessions`, which a turn settled on.
    pub(super) fn name_settled(&mut self, sessions: impl IntoIterator<Item = SessionId>) {
        if !self.is_every {
            self.settled.extend(sessions);
            self.name_every_past_kept();
        }
    }

    // Names every file once more are named than a launch follows files.
    fn name_every_past_kept(&mut self) {
        if self.exported.len() + self.settled.len() > ROLLOUTS_KEPT {
            self.name_every();
        }
    }

    // Whether `followed` is named: by its own thread or, for a file below a session thread, that
    // thread an export named, or by the session it is placed on, which a turn settled on.
    pub(super) fn is_named(&self, followed: &CodexFollowedRollout) -> bool {
        self.is_every
            || followed
                .file
                .thread()
                .is_some_and(|thread| self.exported.contains(&thread.thread_id))
            || matches!(
                &followed.placement,
                CodexRolloutPlacement::Below { session_thread, .. }
                    if self.exported.contains(session_thread)
            )
            || self.settled_session_of(followed).is_some()
    }

    // The session a turn settled on that `followed` is placed on: the session streaming its
    // thread, or the one holding the thread it sits below.
    pub(super) fn settled_session_of(&self, followed: &CodexFollowedRollout) -> Option<SessionId> {
        let session_id = match &followed.placement {
            CodexRolloutPlacement::Streamed { session_id }
            | CodexRolloutPlacement::Below { session_id, .. } => *session_id,
            CodexRolloutPlacement::Unplaced { .. } | CodexRolloutPlacement::Passed => return None,
        };
        self.settled.contains(&session_id).then_some(session_id)
    }
}
