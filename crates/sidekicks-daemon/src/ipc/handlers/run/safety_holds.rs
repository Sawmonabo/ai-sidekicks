//! The live intake of a provider's safety holds on a turn, which the session's history never
//! records: it keeps each session's holds that are on, so a stream that opens during a held turn
//! starts with them, and each hold waits with every run state stream open on its session until that
//! stream's next read.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, Weak};

use sidekicks_contracts::session::controls::events::RunSafetyBufferingUpdatedPayload;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_provider::port::run_state_publisher::RunStatePublisher;
use sidekicks_std::mutex_lock::lock;
use tokio::sync::watch;

/// Each session's holds that are on, and the run state streams open on it, each with the holds
/// waiting for it; implements the run state stream's live intake.
pub(crate) struct RunSafetyHolds {
    sessions: Mutex<Sessions>,
}

/// Each session's live holds and open streams; a session with neither holds no entry.
#[derive(Default)]
struct Sessions {
    next_follow_id: u64,
    by_session: HashMap<SessionId, SessionHolds>,
}

/// One session's holds that are on, one per run, and its open streams by follow id.
#[derive(Default)]
struct SessionHolds {
    active: RunHolds,
    streams: HashMap<u64, Arc<WaitingHolds>>,
}

impl SessionHolds {
    fn is_empty(&self) -> bool {
        self.active.0.is_empty() && self.streams.is_empty()
    }
}

/// Holds kept one per run, the newest only, in the order their runs first came: a run's next turn
/// starts only once its last ended, so a run never holds two turns at once.
#[derive(Clone, Default)]
struct RunHolds(Vec<RunSafetyBufferingUpdatedPayload>);

impl RunHolds {
    /// Keeps `hold` in place of its run's.
    fn keep(&mut self, hold: RunSafetyBufferingUpdatedPayload) {
        match self.0.iter_mut().find(|kept| kept.run_id == hold.run_id) {
            Some(kept) => *kept = hold,
            None => self.0.push(hold),
        }
    }

    /// Drops the hold of `hold`'s run.
    fn drop_run(&mut self, hold: &RunSafetyBufferingUpdatedPayload) {
        self.0.retain(|kept| kept.run_id != hold.run_id);
    }
}

/// The holds waiting for one stream, the newest of each run's only, so a stream that reads nothing
/// for a while holds one per live run at most; and the count raised on each hold.
struct WaitingHolds {
    holds: Mutex<RunHolds>,
    change_count: watch::Sender<u64>,
}

impl WaitingHolds {
    fn lock(&self) -> MutexGuard<'_, RunHolds> {
        // The list holds no invariant a panicking holder could break.
        lock(&self.holds)
    }

    fn add(&self, hold: RunSafetyBufferingUpdatedPayload) {
        self.lock().keep(hold);
        self.change_count.send_modify(|count| *count += 1);
    }
}

impl RunSafetyHolds {
    /// An intake with no hold on and no stream open.
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self {
            sessions: Mutex::new(Sessions::default()),
        })
    }

    /// Follows `session_id`'s holds for one stream, starting with those on now, until the returned
    /// follow drops.
    pub(crate) fn follow(self: &Arc<Self>, session_id: SessionId) -> SafetyHoldsFollow {
        let mut sessions = self.lock();
        let id = sessions.next_follow_id;
        sessions.next_follow_id += 1;
        let session = sessions.by_session.entry(session_id).or_default();
        let waiting = Arc::new(WaitingHolds {
            holds: Mutex::new(session.active.clone()),
            change_count: watch::Sender::new(0),
        });
        session.streams.insert(id, Arc::clone(&waiting));
        SafetyHoldsFollow {
            holds: Arc::downgrade(self),
            session_id,
            id,
            waiting,
        }
    }

    fn lock(&self) -> MutexGuard<'_, Sessions> {
        // The maps hold no invariant a panicking holder could break.
        lock(&self.sessions)
    }

    /// How many streams follow `session_id`'s holds.
    #[cfg(test)]
    pub(crate) fn follow_count(&self, session_id: &SessionId) -> usize {
        self.lock()
            .by_session
            .get(session_id)
            .map_or(0, |session| session.streams.len())
    }
}

impl RunStatePublisher for RunSafetyHolds {
    fn publish(&self, hold: RunSafetyBufferingUpdatedPayload) {
        let mut sessions = self.lock();
        let session = sessions.by_session.entry(hold.session_id).or_default();
        if hold.active {
            session.active.keep(hold.clone());
        } else {
            session.active.drop_run(&hold);
        }
        for stream in session.streams.values() {
            stream.add(hold.clone());
        }
        if session.is_empty() {
            sessions.by_session.remove(&hold.session_id);
        }
    }
}

/// One stream's follow of its session's holds; dropping it stops the follow and drops the holds
/// still waiting.
pub(crate) struct SafetyHoldsFollow {
    // Weak, so a follow never keeps the intake alive.
    holds: Weak<RunSafetyHolds>,
    session_id: SessionId,
    id: u64,
    waiting: Arc<WaitingHolds>,
}

impl SafetyHoldsFollow {
    /// Takes at most `max` of the waiting holds, oldest run first.
    pub(crate) fn take(&self, max: usize) -> Vec<RunSafetyBufferingUpdatedPayload> {
        let mut holds = self.waiting.lock();
        let taken = holds.0.len().min(max);
        holds.0.drain(..taken).collect()
    }

    /// The count raised on each hold that comes to this follow.
    pub(crate) fn change_count(&self) -> watch::Receiver<u64> {
        self.waiting.change_count.subscribe()
    }
}

impl Drop for SafetyHoldsFollow {
    fn drop(&mut self) {
        let Some(holds) = self.holds.upgrade() else {
            return;
        };
        let mut sessions = holds.lock();
        if let Some(session) = sessions.by_session.get_mut(&self.session_id) {
            session.streams.remove(&self.id);
            if session.is_empty() {
                sessions.by_session.remove(&self.session_id);
            }
        }
    }
}
