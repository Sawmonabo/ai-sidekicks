//! The join of a reviewer's request whose thread Codex's listing lacks: the review windows and
//! the session turns of one launch, live or recently ended, each with when it began and ended, and
//! the session and turn a request observed at a given time is joined to.

use std::collections::VecDeque;

use serde_json::{Map, Value};
use sidekicks_contracts::session::id::SessionId;

use crate::record_readers::read_non_empty_string;

/// How many review windows one launch keeps; past it the oldest is dropped.
const REVIEW_WINDOWS_KEPT: usize = 64;

/// How many ended turns one launch keeps beside its live ones; past it the oldest is let go.
pub(crate) const ENDED_TURNS_KEPT: usize = 64;

/// A review Codex ran for a session's turn, from its start to its completion; an unplaced
/// reviewer request is joined to the latest window open when it was observed.
pub(crate) struct CodexReviewWindow {
    review_id: String,
    session_id: SessionId,
    turn_id: String,
    started_at_ms: u64,
    completed_at_ms: Option<u64>,
}

impl CodexReviewWindow {
    /// The window a review's started or completed notification on `session_id` names, closed at
    /// the completion's time where it carries one; `None` where it names no review or turn, or a
    /// start before 1970.
    pub(crate) fn read(session_id: SessionId, members: &Map<String, Value>) -> Option<Self> {
        Some(Self {
            review_id: read_non_empty_string(members, "reviewId")?.to_owned(),
            session_id,
            turn_id: read_non_empty_string(members, "turnId")?.to_owned(),
            started_at_ms: u64::try_from(members.get("startedAtMs")?.as_i64()?).ok()?,
            completed_at_ms: members
                .get("completedAtMs")
                .and_then(Value::as_i64)
                .and_then(|completed_at_ms| u64::try_from(completed_at_ms).ok()),
        })
    }

    // Whether the window was open at `at_ms`.
    fn covers(&self, at_ms: u64) -> bool {
        self.started_at_ms <= at_ms
            && self
                .completed_at_ms
                .is_none_or(|completed_at_ms| at_ms <= completed_at_ms)
    }
}

// A session's own turn, when it began and, once it settled or went, when it ended, in Unix
// milliseconds.
struct CodexSessionTurn {
    session_id: SessionId,
    turn_id: String,
    started_at_ms: u64,
    ended_at_ms: Option<u64>,
}

impl CodexSessionTurn {
    // Whether the turn was live at `at_ms`.
    fn covers(&self, at_ms: u64) -> bool {
        self.started_at_ms <= at_ms
            && self
                .ended_at_ms
                .is_none_or(|ended_at_ms| at_ms <= ended_at_ms)
    }
}

/// One launch's review windows and its sessions' turns, which an unlisted thread's requests are
/// joined to.
#[derive(Default)]
pub(crate) struct CodexJoinTargets {
    // Oldest first, each review once.
    windows: VecDeque<CodexReviewWindow>,
    // Each session's live turn, at most one each, and the ended ones, oldest first.
    turns: VecDeque<CodexSessionTurn>,
}

impl CodexJoinTargets {
    /// Opens `window`, or closes its review's open window where `window` carries the close; the
    /// oldest is dropped past the bound.
    pub(crate) fn review_window(&mut self, window: CodexReviewWindow) {
        if let Some(open) = self
            .windows
            .iter_mut()
            .find(|open| open.review_id == window.review_id)
        {
            if window.completed_at_ms.is_some() {
                open.completed_at_ms = window.completed_at_ms;
            }
            return;
        }
        if self.windows.len() >= REVIEW_WINDOWS_KEPT {
            self.windows.pop_front();
        }
        self.windows.push_back(window);
    }

    /// `session_id`'s own turn `turn_id` began at `started_at_ms`, ending at that time any turn of
    /// the session's that never settled; a start repeated for the live turn changes nothing.
    pub(crate) fn turn_started(
        &mut self,
        session_id: SessionId,
        turn_id: &str,
        started_at_ms: u64,
    ) {
        if self.turns.iter().any(|turn| {
            turn.session_id == session_id && turn.turn_id == turn_id && turn.ended_at_ms.is_none()
        }) {
            return;
        }
        self.end_turns(started_at_ms, |turn| turn.session_id == session_id);
        self.turns.push_back(CodexSessionTurn {
            session_id,
            turn_id: turn_id.to_owned(),
            started_at_ms,
            ended_at_ms: None,
        });
    }

    /// `session_id`'s turn `turn_id` settled or went at `ended_at_ms`; any other turn changes
    /// nothing.
    pub(crate) fn turn_ended(&mut self, session_id: SessionId, turn_id: &str, ended_at_ms: u64) {
        self.end_turns(ended_at_ms, |turn| {
            turn.session_id == session_id && turn.turn_id == turn_id
        });
    }

    // Ends at `ended_at_ms` each live turn `is_ended` picks, then lets the oldest ended turns go
    // past the bound.
    fn end_turns(&mut self, ended_at_ms: u64, is_ended: impl Fn(&CodexSessionTurn) -> bool) {
        for turn in &mut self.turns {
            if turn.ended_at_ms.is_none() && is_ended(turn) {
                turn.ended_at_ms = Some(ended_at_ms);
            }
        }
        let mut ended = self
            .turns
            .iter()
            .filter(|turn| turn.ended_at_ms.is_some())
            .count();
        while ended > ENDED_TURNS_KEPT {
            let Some(index) = self
                .turns
                .iter()
                .position(|turn| turn.ended_at_ms.is_some())
            else {
                break;
            };
            if let Some(let_go) = self.turns.remove(index) {
                tracing::debug!(
                    turn_id = let_go.turn_id.as_str(),
                    "a codex launch keeps too many ended turns; the oldest is let go"
                );
            }
            ended -= 1;
        }
    }

    /// The session and turn a request first observed at `observed_at_ms` joins: the review window
    /// open then that opened last, else the turn live then that began last.
    pub(crate) fn target(&self, observed_at_ms: u64) -> Option<(SessionId, String)> {
        let window = self
            .windows
            .iter()
            .filter(|window| window.covers(observed_at_ms))
            .max_by_key(|window| window.started_at_ms)
            .map(|window| (window.session_id, window.turn_id.clone()));
        window.or_else(|| {
            self.turns
                .iter()
                .filter(|turn| turn.covers(observed_at_ms))
                .max_by_key(|turn| turn.started_at_ms)
                .map(|turn| (turn.session_id, turn.turn_id.clone()))
        })
    }
}
