//! The threads whose rollout files a launch's next pass past a stop's end reads on: those the
//! exports and settled turns named since the last pass, or every file.

use std::collections::HashSet;

use super::{CodexFollowedRollout, CodexRolloutPlacement, ROLLOUTS_KEPT};

/// The threads whose files the next pass past a stop's end reads on, as the exports and settled
/// turns since the last pass named them: every file at a stop's end, which the stop's own passes
/// may have left unread, and once more threads are named than a launch follows files.
#[derive(Default)]
pub(super) struct CodexNamedThreads {
    is_every: bool,
    // The threads an export's records named.
    exported: HashSet<String>,
    // The session threads a turn settled on.
    settled: HashSet<String>,
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

    // Names `threads`, an export's or a settled turn's as `is_settled` says.
    pub(super) fn name(&mut self, threads: impl IntoIterator<Item = String>, is_settled: bool) {
        if self.is_every {
            return;
        }
        let named = if is_settled {
            &mut self.settled
        } else {
            &mut self.exported
        };
        named.extend(threads);
        if self.exported.len() + self.settled.len() > ROLLOUTS_KEPT {
            self.name_every();
        }
    }

    // Whether `followed` is named: by its own thread, or for a file below a session thread, by
    // that thread.
    pub(super) fn is_named(&self, followed: &CodexFollowedRollout) -> bool {
        let is_thread_named =
            |thread: &str| self.exported.contains(thread) || self.settled.contains(thread);
        self.is_every
            || followed
                .file
                .thread()
                .is_some_and(|thread| is_thread_named(&thread.thread_id))
            || matches!(
                &followed.placement,
                CodexRolloutPlacement::Below { session_thread, .. }
                    if is_thread_named(session_thread)
            )
    }

    // The settled thread that names `followed`, its own or the session thread it sits below.
    pub(super) fn settled_thread_of(&self, followed: &CodexFollowedRollout) -> Option<String> {
        let own = followed
            .file
            .thread()
            .map(|thread| thread.thread_id.as_str());
        let below = match &followed.placement {
            CodexRolloutPlacement::Below { session_thread, .. } => Some(session_thread.as_str()),
            CodexRolloutPlacement::Unplaced { .. }
            | CodexRolloutPlacement::Streamed { .. }
            | CodexRolloutPlacement::Passed => None,
        };
        [own, below]
            .into_iter()
            .flatten()
            .find(|thread| self.settled.contains(*thread))
            .map(str::to_owned)
    }
}
