//! The searches whose later pages are still to be read, each held as its first page opened it, so
//! a write between pages neither repeats nor drops a hit. A search holds a view of the index, which
//! keeps the index version it opened on, its files and the totals it scores with, so holding is
//! bounded: a search not paged for a while is let go, so is one held too long however often it is
//! paged, and past a count the least recently paged goes first. A cursor of a search let go is
//! refused, and the search starts again. Each held search's view has a lock of its own, taken for
//! one page, so pages of different searches, and two pages of one search, read at once; the lock
//! over the held set is taken only to find, hold or let go of a search, never across a page.

use std::mem;
use std::num::NonZeroUsize;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime};

use lru::LruCache;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_search::index::HeldSearch;
use sidekicks_std::mutex_lock::lock;

use crate::search::query::ParsedSearchQuery;

/// One held search: the parsed query it answers, so a cursor sent with another query continues
/// nothing, its view of the index behind the lock one page takes, and where the rowid floor log
/// stood for that view. Dropping its last holder lets go of the view.
pub(crate) struct SearchSnapshot {
    /// The query the search answers.
    pub(crate) query: ParsedSearchQuery,
    /// The search's view of the index, locked for one page at a time.
    pub(crate) view: Mutex<HeldSearch>,
    /// Where the rowid floor log stood for the view.
    pub(crate) floor_position: i64,
}

impl SearchSnapshot {
    /// The view, locked for one page.
    pub(crate) fn lock_view(&self) -> MutexGuard<'_, HeldSearch> {
        // A page that panicked left the view as a read leaves it; the next page reads it again.
        lock(&self.view)
    }
}

/// The bounds on held searches.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct SearchSnapshotLimits {
    /// The most searches held at once; past it the least recently paged is let go.
    pub(crate) max_held: NonZeroUsize,
    /// How long a search may go unpaged before it is let go.
    pub(crate) idle: Duration,
    /// How long a search is held at most from its first page, however often it is paged.
    pub(crate) lifetime: Duration,
}

/// The daemon's bounds. Sixteen searches: a person typing opens one per keystroke and an agent
/// pages a few at once, while each view keeps an index version's files and totals alive. Five
/// minutes unpaged: a person reading one page and scrolling on still continues it, and a search
/// left behind gives its view back soon after. Thirty minutes in all: a search paged on and on
/// still lets go of its index version, so merged files are not kept on disk behind it.
pub(crate) const DEFAULT_SEARCH_SNAPSHOT_LIMITS: SearchSnapshotLimits = SearchSnapshotLimits {
    max_held: NonZeroUsize::new(16).expect("sixteen is not zero"),
    idle: Duration::from_mins(5),
    lifetime: Duration::from_mins(30),
};

// A held search and when it was held and last paged, by the wall clock.
struct HeldSnapshot {
    snapshot: Arc<SearchSnapshot>,
    held_at: SystemTime,
    last_paged_at: SystemTime,
}

/// Holds searches between their pages, inside [`SearchSnapshotLimits`]; shared by every search,
/// its lock held only while a search is found, held or let go. It runs no timer: its owner reads
/// [`SearchSnapshots::next_expiry`] after each call that changes what is held, and a timer it arms
/// for that instant calls [`SearchSnapshots::let_go_expired`] and arms again.
pub(crate) struct SearchSnapshots {
    /// The bounds it holds searches within.
    limits: SearchSnapshotLimits,
    /// The held searches by id, in paging order, bounded to `limits.max_held`.
    held: Mutex<LruCache<String, HeldSnapshot>>,
}

impl SearchSnapshots {
    /// Holds no search yet, within `limits`.
    pub(crate) fn new(limits: SearchSnapshotLimits) -> Self {
        Self {
            limits,
            held: Mutex::new(LruCache::new(limits.max_held)),
        }
    }

    /// Holds a search, paged at `now`, and answers the id its cursors name.
    pub(crate) fn hold(&self, snapshot: Arc<SearchSnapshot>, now: SystemTime) -> String {
        let snapshot_id = mint_uuid_v7().to_string();
        let held = HeldSnapshot {
            snapshot,
            held_at: now,
            last_paged_at: now,
        };
        // Past the count the least recently paged search comes back here and drops, which lets
        // go of its view; a fresh id never replaces a held one.
        let let_go = self.lock_held().push(snapshot_id.clone(), held);
        // Dropped once the lock is let go, so letting go of a view never holds the set.
        drop(let_go);
        snapshot_id
    }

    /// The held search with this id, marked as paged at `now`; `None` once it is let go. A search
    /// let go while a page reads it stays whole until that page ends.
    pub(crate) fn find(&self, snapshot_id: &str, now: SystemTime) -> Option<Arc<SearchSnapshot>> {
        let mut held = self.lock_held();
        let expired = let_go_expired_from(&mut held, self.limits, now);
        let found = held.get_mut(snapshot_id).map(|held| {
            held.last_paged_at = now;
            Arc::clone(&held.snapshot)
        });
        drop(held);
        drop(expired);
        found
    }

    /// The lowest place in the rowid floor log a held search still reads from; `None` while none
    /// is held.
    pub(crate) fn oldest_floor_position(&self) -> Option<i64> {
        self.lock_held()
            .iter()
            .map(|(_, held)| held.snapshot.floor_position)
            .min()
    }

    /// When the first held search expires, by the wall clock; `None` while none is held.
    pub(crate) fn next_expiry(&self) -> Option<SystemTime> {
        self.lock_held()
            .iter()
            .map(|(_, held)| expiry_within(self.limits, held))
            .min()
    }

    /// Lets go of every search that has gone unpaged too long or been held too long by `now`.
    pub(crate) fn let_go_expired(&self, now: SystemTime) {
        let mut held = self.lock_held();
        let expired = let_go_expired_from(&mut held, self.limits, now);
        drop(held);
        drop(expired);
    }

    /// Lets go of every held search, as the index closes.
    pub(crate) fn let_go_of_all(&self) {
        // Taken out under the lock and dropped after it, so letting go of the views never holds it.
        let let_go = mem::replace(&mut *self.lock_held(), LruCache::new(self.limits.max_held));
        drop(let_go);
    }

    fn lock_held(&self) -> MutexGuard<'_, LruCache<String, HeldSnapshot>> {
        // The cache holds no invariant a panicking holder could break.
        lock(&self.held)
    }
}

// Takes out of `held` every search expired by `now`, for the caller to drop once its lock is let
// go.
fn let_go_expired_from(
    held: &mut LruCache<String, HeldSnapshot>,
    limits: SearchSnapshotLimits,
    now: SystemTime,
) -> Vec<HeldSnapshot> {
    let expired_ids: Vec<String> = held
        .iter()
        .filter(|(_, snapshot)| now >= expiry_within(limits, snapshot))
        .map(|(snapshot_id, _)| snapshot_id.clone())
        .collect();
    expired_ids
        .iter()
        .filter_map(|snapshot_id| held.pop(snapshot_id))
        .collect()
}

// When a held search expires: once idle too long since its last page, or held too long in all.
fn expiry_within(limits: SearchSnapshotLimits, held: &HeldSnapshot) -> SystemTime {
    (held.last_paged_at + limits.idle).min(held.held_at + limits.lifetime)
}
