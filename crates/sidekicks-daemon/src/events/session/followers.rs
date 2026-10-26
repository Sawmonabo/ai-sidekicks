//! Who hears of a committed event, and when. The log service publishes each committed write's
//! events from the writer's commit hook, on the writer's pump, once per write and in commit
//! order, so every session's events go out in sequence order with none skipped.
//!
//! - A follower of every session is called with each event. It runs on the pump, so it does only
//!   quick work and hands anything longer to its own task. One that fails is logged and stays
//!   attached; followers never cost each other an event.
//! - A session's subscriber is never pushed its events: it reads the log by cursor and waits on
//!   the session's change count, raised here once the change can be read.

use std::collections::{BTreeMap, HashMap};
use std::error::Error;
use std::sync::{Arc, Mutex, MutexGuard, Weak};

use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;
use tokio::sync::watch;

use crate::events::session::appender::UnsequencedEventEnvelope;
use crate::mutex_lock::lock;

/// A committed event as its followers hear it: the envelope its row was written from, shared
/// with that row, and the sequence its write committed it at.
#[derive(Clone, Debug)]
pub(crate) struct CommittedEvent {
    /// The event as stored.
    pub(crate) envelope: Arc<UnsequencedEventEnvelope>,
    /// Its sequence in its session's log.
    pub(crate) sequence: SafeInt<0>,
}

/// A follower of every session: called with each committed event, on the writer's pump. An error
/// is logged and the follower stays attached.
type AllSessionsFollower =
    dyn Fn(&CommittedEvent) -> Result<(), Box<dyn Error + Send + Sync>> + Send + Sync;

// The followers of every session, keyed by attach order, so they are called in that order.
#[derive(Default)]
struct AttachedFollowers {
    next_id: u64,
    by_id: BTreeMap<u64, Arc<AllSessionsFollower>>,
}

/// Publishes committed events to the followers of every session and raises each session's change
/// count. Shared by `Arc`; no lock inside is held across an await or a follower's call.
#[derive(Default)]
pub(crate) struct SessionEventFollowers {
    followers: Mutex<AttachedFollowers>,
    // Only sessions someone counted at the last `change_count` have an entry.
    change_counts: Mutex<HashMap<SessionId, watch::Sender<u64>>>,
}

impl SessionEventFollowers {
    /// Attaches `follower` to every session's committed events from now on. Dropping the returned
    /// attachment detaches it; one function attached twice is detached once per attachment.
    pub(crate) fn follow_all(
        self: &Arc<Self>,
        follower: impl Fn(&CommittedEvent) -> Result<(), Box<dyn Error + Send + Sync>>
        + Send
        + Sync
        + 'static,
    ) -> FollowerAttachment {
        let mut followers = self.lock_followers();
        let id = followers.next_id;
        followers.next_id += 1;
        followers.by_id.insert(id, Arc::new(follower));
        FollowerAttachment {
            followers: Arc::downgrade(self),
            id,
        }
    }

    /// The change count of `session_id`: the number of its events committed since the first
    /// receiver subscribed, raised once they can be read. The count starts at 0. Each call first
    /// drops every session's count no receiver reads any more.
    pub(crate) fn change_count(&self, session_id: &SessionId) -> watch::Receiver<u64> {
        let mut change_counts = self.lock_change_counts();
        change_counts.retain(|_, sender| sender.receiver_count() > 0);
        change_counts
            .entry(*session_id)
            .or_insert_with(|| watch::Sender::new(0))
            .subscribe()
    }

    /// Publishes one committed write's `events`, in sequence order: calls every follower of every
    /// session with each event, then raises each session's change count by its events. Called once
    /// per committed write, in commit order.
    pub(crate) fn publish(&self, events: &[CommittedEvent]) {
        // A snapshot, so a follower may attach or detach from inside its call.
        let followers: Vec<Arc<AllSessionsFollower>> =
            self.lock_followers().by_id.values().cloned().collect();
        for event in events {
            for follower in &followers {
                if let Err(error) = follower(event) {
                    tracing::error!(
                        session_id = %event.envelope.session_id(),
                        sequence = event.sequence.get(),
                        error = &*error as &(dyn Error + 'static),
                        "a follower of every session failed on a committed event; it stays attached"
                    );
                }
            }
        }

        let mut committed_by_session: HashMap<SessionId, u64> = HashMap::new();
        for event in events {
            *committed_by_session
                .entry(event.envelope.session_id())
                .or_default() += 1;
        }
        let change_counts = self.lock_change_counts();
        for (session_id, committed) in committed_by_session {
            if let Some(change_count) = change_counts.get(&session_id) {
                change_count.send_modify(|count| *count += committed);
            }
        }
    }

    fn lock_followers(&self) -> MutexGuard<'_, AttachedFollowers> {
        // The map holds no invariant a panicking holder could break.
        lock(&self.followers)
    }

    fn lock_change_counts(&self) -> MutexGuard<'_, HashMap<SessionId, watch::Sender<u64>>> {
        // The map holds no invariant a panicking holder could break.
        lock(&self.change_counts)
    }
}

/// One attachment of a follower of every session; dropping it detaches that follower.
#[must_use = "dropping the attachment detaches the follower"]
pub(crate) struct FollowerAttachment {
    // Weak, so an attachment a follower keeps never holds the followers alive.
    followers: Weak<SessionEventFollowers>,
    id: u64,
}

impl Drop for FollowerAttachment {
    fn drop(&mut self) {
        if let Some(followers) = self.followers.upgrade() {
            // Dropped after the lock is let go: the follower may own an attachment of its own.
            let detached = followers.lock_followers().by_id.remove(&self.id);
            drop(detached);
        }
    }
}
