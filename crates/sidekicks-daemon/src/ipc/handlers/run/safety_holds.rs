//! The live intake of a provider's safety holds on a turn, which the session's history never
//! records: each hold waits with every run state stream open on its session until that stream's
//! next read, and a hold with no stream open on its session goes nowhere.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};

use sidekicks_contracts::session::controls::events::RunSafetyBufferingUpdatedPayload;
use sidekicks_contracts::session::id::SessionId;
use tokio::sync::watch;

use crate::provider::port::run_state_publisher::RunStatePublisher;

/// The run state streams open on each session, each with the holds waiting for it; implements the
/// run state stream's live intake.
#[derive(Default)]
pub(crate) struct RunSafetyHolds {
    streams: Mutex<OpenStreams>,
}

/// Each session's open streams by follow id; a session with none holds no entry.
#[derive(Default)]
struct OpenStreams {
    next_id: u64,
    by_session: HashMap<SessionId, HashMap<u64, Arc<WaitingHolds>>>,
}

/// The holds waiting for one stream, the newest of each turn's only, so a stream that reads
/// nothing for a while holds one per turn at most, and ends on each turn's newest; and the stream's
/// change count, raised on each hold.
struct WaitingHolds {
    holds: Mutex<Vec<RunSafetyBufferingUpdatedPayload>>,
    change_count: watch::Sender<u64>,
}

impl WaitingHolds {
    fn lock(&self) -> MutexGuard<'_, Vec<RunSafetyBufferingUpdatedPayload>> {
        // The list holds no invariant a panicking holder could break.
        self.holds.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn add(&self, hold: RunSafetyBufferingUpdatedPayload) {
        {
            let mut holds = self.lock();
            let same_turn = holds
                .iter_mut()
                .find(|waiting| waiting.run_id == hold.run_id && waiting.turn_id == hold.turn_id);
            match same_turn {
                Some(waiting) => *waiting = hold,
                None => holds.push(hold),
            }
        }
        self.change_count.send_modify(|count| *count += 1);
    }
}

impl RunSafetyHolds {
    /// An intake with no stream open.
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Follows `session_id`'s holds for one stream, raising `change_count` on each, until the
    /// returned follow drops.
    pub(crate) fn follow(
        self: &Arc<Self>,
        session_id: SessionId,
        change_count: watch::Sender<u64>,
    ) -> SafetyHoldsFollow {
        let waiting = Arc::new(WaitingHolds {
            holds: Mutex::new(Vec::new()),
            change_count,
        });
        let mut streams = self.lock();
        let id = streams.next_id;
        streams.next_id += 1;
        streams
            .by_session
            .entry(session_id)
            .or_default()
            .insert(id, Arc::clone(&waiting));
        SafetyHoldsFollow {
            holds: Arc::downgrade(self),
            session_id,
            id,
            waiting,
        }
    }

    fn lock(&self) -> MutexGuard<'_, OpenStreams> {
        // The maps hold no invariant a panicking holder could break.
        self.streams.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl RunStatePublisher for RunSafetyHolds {
    fn publish(&self, hold: RunSafetyBufferingUpdatedPayload) {
        let waiting: Vec<Arc<WaitingHolds>> = self
            .lock()
            .by_session
            .get(&hold.session_id)
            .map(|streams| streams.values().cloned().collect())
            .unwrap_or_default();
        for stream in waiting {
            stream.add(hold.clone());
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
    /// Takes at most `max` of the waiting holds, oldest first.
    pub(crate) fn take(&self, max: usize) -> Vec<RunSafetyBufferingUpdatedPayload> {
        let mut holds = self.waiting.lock();
        let taken = holds.len().min(max);
        holds.drain(..taken).collect()
    }
}

impl Drop for SafetyHoldsFollow {
    fn drop(&mut self) {
        let Some(holds) = self.holds.upgrade() else {
            return;
        };
        let mut streams = holds.lock();
        if let Some(session_streams) = streams.by_session.get_mut(&self.session_id) {
            session_streams.remove(&self.id);
            if session_streams.is_empty() {
                streams.by_session.remove(&self.session_id);
            }
        }
    }
}
