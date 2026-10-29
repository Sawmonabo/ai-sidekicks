//! The attention change counts: one for the whole machine and one per followed session, each raised
//! after a commit that bumped its row of `attention_versions`, so a follower re-reads only when its
//! scope may read differently. Every attention write bumps the machine's row with the session's, so
//! a commit that left the machine's row alone changed no session's and costs one lookup. No copy of
//! the projection is held: each count holds only the version it last saw.
//!
//! Beside the counts, a watch of the builds recorded in the record of each provider's builds,
//! raised once each such write committed, which the provider build retirement's timer follows, so
//! no other attention change reads the record.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use rusqlite::{Connection, OptionalExtension as _};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::writer::CommitRead;
use tokio::sync::watch;

// A scope's version; no row reads as 0.
const SCOPE_VERSION_SQL: &str = "SELECT version FROM attention_versions WHERE scope_key = ?1";

// The machine-wide row's key.
const MACHINE_SCOPE_KEY: &str = "";

/// The read the database writer runs after each commit to raise the attention change counts, and
/// the counts it raises.
pub fn attention_changes_after_commits() -> (CommitRead, AttentionChanges) {
    let changes = AttentionChanges {
        counts: Arc::new(ChangeCounts {
            machine: watch::Sender::new(0),
            sessions: Mutex::new(HashMap::new()),
            recorded_builds: watch::Sender::new(0),
        }),
    };
    let counts = Arc::clone(&changes.counts);
    let read = CommitRead::new("the attention change counts", move |connection| {
        counts.raise_moved(connection)
    });
    (read, changes)
}

/// The attention change counts a follower of the projection waits on.
#[derive(Clone)]
pub struct AttentionChanges {
    counts: Arc<ChangeCounts>,
}

impl AttentionChanges {
    /// The count of `session_id`'s attention, or the whole machine's for `None`, raised after each
    /// commit that may make it read differently. The follower reads the projection after
    /// subscribing and whenever the count moves. A session's count is made at its first follow
    /// and starts at 0, so its first raise may come from a commit that left the session alone,
    /// which costs one more read. Each call first drops every count no receiver reads any more.
    pub fn follow(&self, session_id: Option<SessionId>) -> watch::Receiver<u64> {
        let Some(session_id) = session_id else {
            return self.counts.machine.subscribe();
        };
        let mut sessions = self.counts.lock_sessions();
        sessions.retain(|_, count| count.receiver_count() > 0);
        sessions
            .entry(session_id)
            .or_insert_with(|| watch::Sender::new(0))
            .subscribe()
    }

    /// The count of the builds recorded in the record of each provider's builds, raised once each
    /// recording write committed.
    pub(crate) fn follow_recorded_builds(&self) -> watch::Receiver<u64> {
        self.counts.recorded_builds.subscribe()
    }

    /// Raises the count of recorded builds, once a write that recorded one committed.
    pub(crate) fn raise_recorded_builds(&self) {
        self.counts
            .recorded_builds
            .send_modify(|count| *count = count.wrapping_add(1));
    }
}

/// Each count holds the version of its `attention_versions` row it last saw.
struct ChangeCounts {
    machine: watch::Sender<u64>,
    // Only sessions someone followed at the last `follow` or raise have an entry.
    sessions: Mutex<HashMap<SessionId, watch::Sender<u64>>>,
    // Raised by the record's port, never by a commit read.
    recorded_builds: watch::Sender<u64>,
}

impl ChangeCounts {
    // Raises the machine's count when its row moved, and then each followed session's whose row
    // moved. Every version is read before any count is raised, so a failed read raises nothing and
    // the next commit reads again.
    fn raise_moved(&self, connection: &Connection) -> rusqlite::Result<()> {
        let machine_version = scope_version(connection, MACHINE_SCOPE_KEY)?;
        if *self.machine.borrow() == machine_version {
            return Ok(());
        }
        let followed: Vec<SessionId> = {
            let mut sessions = self.lock_sessions();
            sessions.retain(|_, count| count.receiver_count() > 0);
            sessions.keys().copied().collect()
        };
        let session_versions = followed
            .into_iter()
            .map(|session_id| {
                Ok((
                    session_id,
                    scope_version(connection, &session_id.to_string())?,
                ))
            })
            .collect::<rusqlite::Result<Vec<_>>>()?;
        {
            let sessions = self.lock_sessions();
            for (session_id, version) in session_versions {
                if let Some(count) = sessions.get(&session_id) {
                    raise_to(count, version);
                }
            }
        }
        raise_to(&self.machine, machine_version);
        Ok(())
    }

    fn lock_sessions(&self) -> MutexGuard<'_, HashMap<SessionId, watch::Sender<u64>>> {
        // The map holds no invariant a panicking holder could break.
        lock(&self.sessions)
    }
}

// Sets `count` to `version`, waking its receivers only when it moved.
fn raise_to(count: &watch::Sender<u64>, version: u64) {
    count.send_if_modified(|seen| {
        let is_moved = *seen != version;
        *seen = version;
        is_moved
    });
}

fn scope_version(connection: &Connection, scope_key: &str) -> rusqlite::Result<u64> {
    let version: Option<i64> = connection
        .prepare_cached(SCOPE_VERSION_SQL)?
        .query_row([scope_key], |row| row.get(0))
        .optional()?;
    Ok(version.map_or(0, |version| {
        u64::try_from(version).expect("the table keeps every version at 1 or more")
    }))
}

#[cfg(test)]
mod tests;
