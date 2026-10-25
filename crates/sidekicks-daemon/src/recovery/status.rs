//! The daemon's recovery state as the status read serves it: `rebuilding` while the restart's pass
//! runs, `blocked` once the local store has failed, and `degraded` while a session's history is
//! damaged. The whole daemon refuses writes until the pass has listed what it must rebuild, and a
//! call that names no session until the pass ends; from then a session the pass listed refuses
//! every call that names it until it is rebuilt and its runs settled, and every event until the
//! pass comes to settle those runs. A damaged session, open at its last good point or unreadable,
//! refuses its writes.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Mutex, MutexGuard, PoisonError};

use sidekicks_contracts::daemon::recovery::{
    DaemonRecoverySession, DaemonRecoverySessionState, DaemonRecoveryState, DaemonRecoveryStatus,
    DaemonWriteRefusedRecovery,
};
use sidekicks_contracts::run::control::RunFailureCategory;
use sidekicks_contracts::session::event_cursor::START_OF_LOG_POSITION;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::recovery::{
    SessionHistoryDamagedDetails, SessionHistoryDamagedRecovery, SessionRebuildingDetails,
};
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;

/// A session's last good point: the last event it opens at, and the first one that is damaged.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct LastGoodPoint {
    /// The last event the session opens at.
    pub(crate) last_sequence: SafeInt<0>,
    /// When the event at `last_sequence` happened.
    pub(crate) last_occurred_at: WireInstant,
    /// The first damaged event.
    pub(crate) damaged_from_sequence: SafeInt<0>,
}

/// Why a session takes no write, with the details its refusal carries.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum SessionWriteRefusal {
    /// The restart's pass has yet to rebuild the session.
    Rebuilding(SessionRebuildingDetails),
    /// The session's history is damaged.
    HistoryDamaged(SessionHistoryDamagedDetails),
}

// Where a session the pass listed stands: rebuilding refuses every event, and settling takes the
// events of the runs the pass settles while it still refuses the calls that name it.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ListedSessionStage {
    Rebuilding,
    Settling,
}

// Where one damaged session stands, with what each state carries.
enum SessionRecovery {
    Degraded(LastGoodPoint),
    Damaged,
}

impl SessionRecovery {
    fn history_damage(&self) -> SessionHistoryDamagedRecovery {
        match self {
            Self::Degraded(_) => SessionHistoryDamagedRecovery::Degraded,
            Self::Damaged => SessionHistoryDamagedRecovery::Damaged,
        }
    }
}

/// Holds the daemon's recovery state as the restart's pass and the person's repairs move it.
pub(crate) struct RecoveryStatusTracker {
    state: Mutex<TrackerState>,
}

struct TrackerState {
    // Nothing is trusted until the first pass ends, so a status read before it says rebuilding.
    is_pass_running: bool,
    // No write is taken until the pass knows which sessions it must rebuild.
    is_pass_listing: bool,
    has_store_failed: bool,
    // The damaged sessions, in id order, which is the order they were created in.
    sessions: BTreeMap<SessionId, SessionRecovery>,
    // The sessions the pass has yet to rebuild and settle, kept apart from the damaged ones: after
    // a repair of the file that is every session, too many for each status read to carry.
    rebuilding_sessions: HashMap<SessionId, ListedSessionStage>,
}

impl RecoveryStatusTracker {
    /// A tracker for a start whose pass has yet to list the sessions it must rebuild.
    pub(crate) fn new() -> Self {
        Self {
            state: Mutex::new(TrackerState {
                is_pass_running: true,
                is_pass_listing: true,
                has_store_failed: false,
                sessions: BTreeMap::new(),
                rebuilding_sessions: HashMap::new(),
            }),
        }
    }

    /// Marks the pass's sessions listed, each one it must rebuild marked rebuilding: the daemon
    /// then takes writes, but for those sessions'.
    pub(crate) fn mark_pass_listed(&self) {
        self.lock().is_pass_listing = false;
    }

    /// Marks the pass ended; the daemon then reads as its store and its sessions stand.
    pub(crate) fn mark_pass_ended(&self) {
        let mut state = self.lock();
        state.is_pass_listing = false;
        state.is_pass_running = false;
    }

    /// Marks the local store failed: the daemon reads blocked from then on.
    pub(crate) fn mark_store_failed(&self) {
        self.lock().has_store_failed = true;
    }

    /// Marks a session the pass must rebuild before it takes a write.
    pub(crate) fn mark_session_rebuilding(&self, session_id: &SessionId) {
        self.lock()
            .rebuilding_sessions
            .insert(*session_id, ListedSessionStage::Rebuilding);
    }

    /// Marks a listed session whose runs the pass settles next: it takes their events and still
    /// refuses the calls that name it. A session the pass no longer lists is left as it stands.
    pub(crate) fn mark_session_settling(&self, session_id: &SessionId) {
        if let Some(stage) = self.lock().rebuilding_sessions.get_mut(session_id) {
            *stage = ListedSessionStage::Settling;
        }
    }

    /// Marks a damaged session the person continues from its last good point: it is no longer
    /// damaged, takes the events its continue writes and refuses the calls that name it until the
    /// continue has settled its runs.
    pub(crate) fn mark_session_continuing(&self, session_id: &SessionId) {
        let mut state = self.lock();
        state.sessions.remove(session_id);
        state
            .rebuilding_sessions
            .insert(*session_id, ListedSessionStage::Settling);
    }

    /// Marks a session's projections current, or the session deleted, so it is no longer listed.
    pub(crate) fn mark_session_healthy(&self, session_id: &SessionId) {
        let mut state = self.lock();
        state.rebuilding_sessions.remove(session_id);
        state.sessions.remove(session_id);
    }

    /// Marks a session whose history is damaged after `point`, which it opens at read-only.
    pub(crate) fn mark_session_at_last_good_point(
        &self,
        session_id: &SessionId,
        point: LastGoodPoint,
    ) {
        self.mark_session_damaged(session_id, SessionRecovery::Degraded(point));
    }

    /// Marks a session none of whose events can be read.
    pub(crate) fn mark_session_unreadable(&self, session_id: &SessionId) {
        self.mark_session_damaged(session_id, SessionRecovery::Damaged);
    }

    /// How far the session's history is damaged, which makes it take no write; `None` when it
    /// takes writes.
    pub(crate) fn read_session_write_refusal(
        &self,
        session_id: &SessionId,
    ) -> Option<SessionHistoryDamagedRecovery> {
        self.lock()
            .sessions
            .get(session_id)
            .map(SessionRecovery::history_damage)
    }

    /// Why the session takes no appended event: its history is damaged, or the pass is still
    /// rebuilding it and has yet to settle its runs; `None` when it takes the event.
    pub(crate) fn read_session_append_refusal(
        &self,
        session_id: &SessionId,
    ) -> Option<SessionWriteRefusal> {
        let state = self.lock();
        if state.rebuilding_sessions.get(session_id) == Some(&ListedSessionStage::Rebuilding) {
            return Some(rebuilding(session_id));
        }
        state.history_damaged(session_id)
    }

    /// Why the session takes no call that names it: the pass is still rebuilding it, or its
    /// history is damaged; `None` when it takes them.
    pub(crate) fn read_session_call_refusal(
        &self,
        session_id: &SessionId,
    ) -> Option<SessionWriteRefusal> {
        let state = self.lock();
        if state.rebuilding_sessions.contains_key(session_id) {
            return Some(rebuilding(session_id));
        }
        state.history_damaged(session_id)
    }

    /// The session's last good point while it opens read-only at one, `None` otherwise.
    pub(crate) fn read_last_good_point(&self, session_id: &SessionId) -> Option<LastGoodPoint> {
        match self.lock().sessions.get(session_id)? {
            SessionRecovery::Degraded(point) => Some(point.clone()),
            SessionRecovery::Damaged => None,
        }
    }

    /// The sequence a read of the session stops before while its history is damaged: its first
    /// damaged event, or the start of its log when none can be read; `None` when it reads whole.
    pub(crate) fn read_damaged_from_sequence(&self, session_id: &SessionId) -> Option<i64> {
        match self.lock().sessions.get(session_id)? {
            SessionRecovery::Degraded(point) => Some(i64::from(point.damaged_from_sequence)),
            SessionRecovery::Damaged => Some(START_OF_LOG_POSITION),
        }
    }

    /// Why the whole daemon takes no write of a call: its store has failed, its pass has not yet
    /// listed the sessions it must rebuild, or the call names no session while the pass runs,
    /// since it may reach any session; `None` when it takes the write.
    pub(crate) fn read_daemon_write_refusal(
        &self,
        names_session: bool,
    ) -> Option<DaemonWriteRefusedRecovery> {
        let state = self.lock();
        if state.has_store_failed {
            Some(DaemonWriteRefusedRecovery::Blocked)
        } else if state.is_pass_listing || (state.is_pass_running && !names_session) {
            Some(DaemonWriteRefusedRecovery::Rebuilding)
        } else {
            None
        }
    }

    /// The daemon's overall state: the most severe of its own and every damaged session's.
    pub(crate) fn read_overall(&self) -> DaemonRecoveryState {
        self.lock().overall()
    }

    /// The `recovery` member of the status read: the overall state and every damaged session. The
    /// sessions the pass has yet to rebuild are left out; the daemon reads rebuilding while it
    /// runs.
    pub(crate) fn read(&self) -> DaemonRecoveryStatus {
        let state = self.lock();
        DaemonRecoveryStatus {
            overall: state.overall(),
            sessions: state
                .sessions
                .iter()
                .map(|(session_id, session)| describe_session(*session_id, session))
                .collect(),
        }
    }

    fn mark_session_damaged(&self, session_id: &SessionId, recovery: SessionRecovery) {
        let mut state = self.lock();
        state.rebuilding_sessions.remove(session_id);
        state.sessions.insert(*session_id, recovery);
    }

    // A panic while the lock was held leaves the state as whole as each mark leaves it, so a
    // poisoned lock is taken as it stands.
    fn lock(&self) -> MutexGuard<'_, TrackerState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl TrackerState {
    fn history_damaged(&self, session_id: &SessionId) -> Option<SessionWriteRefusal> {
        let session = self.sessions.get(session_id)?;
        Some(SessionWriteRefusal::HistoryDamaged(
            SessionHistoryDamagedDetails {
                session_id: *session_id,
                recovery: session.history_damage(),
            },
        ))
    }

    fn overall(&self) -> DaemonRecoveryState {
        let own = if self.has_store_failed {
            DaemonRecoveryState::Blocked
        } else if self.is_pass_running {
            DaemonRecoveryState::Rebuilding
        } else {
            DaemonRecoveryState::Healthy
        };
        // A damaged session, open at its last good point or unreadable, reads degraded.
        let sessions = if self.sessions.is_empty() {
            DaemonRecoveryState::Healthy
        } else {
            DaemonRecoveryState::Degraded
        };
        own.max(sessions)
    }
}

fn rebuilding(session_id: &SessionId) -> SessionWriteRefusal {
    SessionWriteRefusal::Rebuilding(SessionRebuildingDetails {
        session_id: *session_id,
    })
}

fn describe_session(session_id: SessionId, session: &SessionRecovery) -> DaemonRecoverySession {
    let (state, point) = match session {
        SessionRecovery::Degraded(point) => (DaemonRecoverySessionState::Degraded, Some(point)),
        SessionRecovery::Damaged => (DaemonRecoverySessionState::Damaged, None),
    };
    DaemonRecoverySession {
        session_id,
        state,
        last_applied_sequence: point.map(|point| point.last_sequence),
        last_applied_at: point.map(|point| point.last_occurred_at.clone()),
        damaged_from_sequence: point.map(|point| point.damaged_from_sequence),
        failure_category: Some(RunFailureCategory::ProjectionFailure),
        recovery_condition: None,
        halted_runs: None,
    }
}
