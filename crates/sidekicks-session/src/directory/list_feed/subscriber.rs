//! One `session.subscribe` subscription's side of the list: the opening list it has not sent yet,
//! page by page, then each session that changed since, one emission per session however often it
//! changed, read from the shared list at send time so a slow reader ends on the newest entry.

use std::collections::{HashSet, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};

use futures::future::BoxFuture;
use sidekicks_contracts::jsonrpc::byte_length::json_utf8_byte_length;
use sidekicks_contracts::jsonrpc::page::{PAGE_MAX_BYTES, count_entries_fitting_one_frame};
use sidekicks_contracts::session::directory::{SessionListChange, SessionListEntry};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::list::BoundedVec;
use tokio::sync::Notify;

use crate::directory::list_feed::{SessionListFeed, SessionListNotCurrent, SharedList};
use sidekicks_ipc::registry::HandlerError;
use sidekicks_ipc::stream::feed::{Feed, SendGate};
use sidekicks_std::mutex_lock::lock;

// The opening list's entries one page is cut from at most, so a page never clones the whole list.
const PAGE_CANDIDATE_LIMIT: usize = 500;

/// How a subscription's list ended: the daemon stopped, or a changed row could not be read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ListEnd {
    /// The read pool closed under the daemon's stop; the stream finishes.
    Finished,
    /// A changed session's row could not be read, so the list is no longer current.
    Failed,
}

/// The sessions that changed since a subscriber last sent them, each held once, oldest first.
#[derive(Default)]
pub(super) struct SubscriberChanges {
    waiting: Mutex<WaitingChanges>,
    changed: Notify,
}

#[derive(Default)]
struct WaitingChanges {
    order: VecDeque<SessionId>,
    members: HashSet<SessionId>,
    end: Option<ListEnd>,
}

impl SubscriberChanges {
    /// Holds `session_id` for the subscriber's next emission; one already waiting keeps its place.
    pub(super) fn add(&self, session_id: SessionId) {
        let mut waiting = self.lock();
        if waiting.members.insert(session_id) {
            waiting.order.push_back(session_id);
        }
        drop(waiting);
        // One reader waits on it, and a wake with none waiting is kept for its next wait.
        self.changed.notify_one();
    }

    /// Ends the subscriber's stream at its next read.
    pub(super) fn end(&self, end: ListEnd) {
        self.lock().end.get_or_insert(end);
        self.changed.notify_one();
    }

    fn forget(&self, session_ids: impl IntoIterator<Item = SessionId>) {
        let mut waiting = self.lock();
        for session_id in session_ids {
            waiting.members.remove(&session_id);
        }
        let WaitingChanges { order, members, .. } = &mut *waiting;
        order.retain(|session_id| members.contains(session_id));
    }

    fn take_next(&self) -> Option<SessionId> {
        let mut waiting = self.lock();
        let session_id = waiting.order.pop_front()?;
        waiting.members.remove(&session_id);
        Some(session_id)
    }

    fn end_reached(&self) -> Option<ListEnd> {
        self.lock().end
    }

    fn has_waiting(&self) -> bool {
        !self.lock().order.is_empty()
    }

    fn lock(&self) -> MutexGuard<'_, WaitingChanges> {
        // The sets hold no invariant a panicking holder could break.
        lock(&self.waiting)
    }
}

/// One subscription's feed of the sessions list. Dropping it leaves the list; the last one to
/// leave drops it.
pub(crate) struct SessionListSubscriber {
    feed: Arc<SessionListFeed>,
    list: Arc<SharedList>,
    changes: Arc<SubscriberChanges>,
    // The opening list's entries not sent yet, as they stood when the subscription opened; a page
    // sends each one's newest entry, or this one when its session has left the list since.
    unsent: VecDeque<Arc<SessionListEntry>>,
}

/// A page of the opening list: its entries and whether the list is now whole.
pub(super) struct ListPage {
    pub(super) sessions: Vec<SessionListEntry>,
    pub(super) is_complete: bool,
}

impl SessionListSubscriber {
    /// A subscriber of `list` whose opening list is `opening`, its changes held in `changes`.
    pub(super) fn new(
        feed: Arc<SessionListFeed>,
        list: Arc<SharedList>,
        changes: Arc<SubscriberChanges>,
        opening: Vec<Arc<SessionListEntry>>,
    ) -> Self {
        Self {
            feed,
            list,
            changes,
            unsent: opening.into(),
        }
    }

    /// The next page of the opening list, read from the shared list now: each session's newest
    /// entry, so a change to a session not yet sent rides its page and adds no emission of its
    /// own, while one that has left the list is sent as it stood and its removal follows.
    pub(super) fn take_page(&mut self) -> ListPage {
        let held: Vec<Arc<SessionListEntry>> = self
            .unsent
            .drain(..self.unsent.len().min(PAGE_CANDIDATE_LIMIT))
            .collect();
        let (candidates, current_ids) = self.list.newest_of(&held);
        let count = count_entries_fitting_one_frame(
            &candidates,
            candidates.len(),
            PAGE_MAX_BYTES,
            json_utf8_byte_length,
        )
        .expect("a list entry writes as JSON");
        for unsent in held[count..].iter().rev() {
            self.unsent.push_front(Arc::clone(unsent));
        }
        // A sent session still in the list needs no later emission; one gone keeps its removal.
        self.changes
            .forget(current_ids.into_iter().take(count).flatten());
        let mut sessions = candidates;
        sessions.truncate(count);
        ListPage {
            sessions,
            is_complete: self.unsent.is_empty(),
        }
    }

    // The next emission once one is ready, before the gate is awaited, so the gate is never held
    // waiting for a change.
    async fn wait_for_emission(&self) -> Option<ListEnd> {
        loop {
            if let Some(end) = self.changes.end_reached() {
                return Some(end);
            }
            if !self.unsent.is_empty() || self.changes.has_waiting() {
                return None;
            }
            self.changes.changed.notified().await;
        }
    }
}

impl Feed for SessionListSubscriber {
    type Emission = SessionListChange;

    fn next<'a>(
        &'a mut self,
        gate: &'a dyn SendGate,
    ) -> BoxFuture<'a, Result<Option<SessionListChange>, HandlerError>> {
        Box::pin(async move {
            loop {
                match self.wait_for_emission().await {
                    Some(ListEnd::Finished) => return Ok(None),
                    Some(ListEnd::Failed) => {
                        return Err(HandlerError::Internal(Box::new(SessionListNotCurrent)));
                    }
                    None => {}
                }
                if gate.ready().await.is_err() {
                    return Ok(None);
                }
                if !self.unsent.is_empty() {
                    let page = self.take_page();
                    let sessions = BoundedVec::new(page.sessions)
                        .expect("a page cut from a non-empty opening list holds an entry");
                    return Ok(Some(SessionListChange::Page {
                        sessions,
                        chat_count: self.list.chat_count(),
                        is_complete: page.is_complete,
                    }));
                }
                let Some(session_id) = self.changes.take_next() else {
                    continue;
                };
                let (entry, chat_count) = self.list.current_of(&session_id);
                return Ok(Some(match entry {
                    Some(entry) => SessionListChange::Upsert {
                        entry: Box::new(entry),
                        chat_count,
                    },
                    None => SessionListChange::Remove {
                        session_id,
                        chat_count,
                    },
                }));
            }
        })
    }
}

impl Drop for SessionListSubscriber {
    fn drop(&mut self) {
        self.feed.leave(&self.list, &self.changes);
    }
}
