//! The live sessions list `session.subscribe` streams: every session's entry held in memory while
//! a subscription is open, read once from the `sessions` rows and then kept current one session
//! at a time, never by a rescan.
//!
//! - The first subscription reads the rows a page per pool read, so no read holds a connection for
//!   the whole list; one opening meanwhile waits for that read and takes its list. The follower of
//!   every session's events collects the sessions they name from before the first page, and those
//!   are read again once the list is held, so a row that changed behind the paged read is not lost.
//! - Each committed event's session, and each session a service names through
//!   [`SessionListFeed::refresh`] after a write that changes a list fact without an event, is read
//!   again by one task, every waiting session in one read however many events named it. A session
//!   whose row is gone leaves the list, which only a purge does; a project session whose project
//!   was forgotten keeps what it showed.
//! - The list holds a place per subscriber, never a queue: a subscriber holds the sessions that
//!   changed since it last sent them, each once, and reads each one's entry at send time.
//! - While a session's activity is `running` or `waiting`, it is sent again every renewal
//!   interval, and at once when the computer wakes, since the runtime's clock stops while it
//!   sleeps; the timer runs only while such a session and a subscriber exist. Every emission
//!   stamps its send as the activity's renewal.

pub(crate) mod rows;
pub(crate) mod subscriber;
#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet};
use std::error::Error;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

use sidekicks_contracts::event::envelope::DAEMON_SCOPE_SENTINEL_SESSION_ID;
use sidekicks_contracts::session::directory::{
    SESSION_ACTIVITY_RENEW_INTERVAL_MS, SessionActivity, SessionListEntry,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::methods::SessionState;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::{Notify, broadcast};
use tokio_util::task::AbortOnDropHandle;

use crate::directory::list_feed::rows::{ListRowSql, OPENING_READ_PAGE_ROWS, SessionListRow};
use crate::directory::list_feed::subscriber::{ListEnd, SessionListSubscriber, SubscriberChanges};
use crate::plan_holds::PlanHolds;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::scheduler::{Scheduler, WakeSignal};
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::events::session::followers::{FollowerAttachment, SessionEventFollowers};
use sidekicks_store::events::session::pending::PendingSessions;
use sidekicks_workspace::managed::service::SessionListRefresh;

// The sessions one read of changed rows takes at most, so a burst of changes reads in short reads.
const CHANGED_READ_SESSIONS: usize = 64;

const RENEW_INTERVAL: Duration =
    Duration::from_millis(SESSION_ACTIVITY_RENEW_INTERVAL_MS.unsigned_abs());

/// Why the opening list could not be read.
#[derive(Debug, thiserror::Error)]
pub(crate) enum SessionListReadError {
    /// SQLite refused the read, or a stored column does not read as its type.
    #[error("a read of the sessions list failed")]
    Database(#[from] rusqlite::Error),
    /// The read pool is closed, a connection did not open, or the read's task did not finish.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
}

impl From<SessionListReadError> for HandlerError {
    /// A list that cannot be read is a fault in the daemon.
    fn from(error: SessionListReadError) -> Self {
        Self::Internal(Box::new(error))
    }
}

/// A subscription's list stopped being current: a changed session's row could not be read, as
/// the service log names.
#[derive(Debug, thiserror::Error)]
#[error("the sessions list stopped being current")]
pub(crate) struct SessionListNotCurrent;

/// The list as one subscription opens it: the first page, the chats count, whether the list is
/// whole, and the feed of every later page and change.
pub(crate) struct SessionListOpening {
    /// The first page of entries.
    pub(crate) sessions: Vec<SessionListEntry>,
    /// The chats the live list counts.
    pub(crate) chat_count: SafeInt<0>,
    /// Whether the first page is the whole list.
    pub(crate) is_complete: bool,
    /// The rest of the list, then each change.
    pub(crate) subscriber: SessionListSubscriber,
}

/// The daemon's one live sessions list: built when the first subscription opens and dropped when
/// the last one closes.
pub(crate) struct SessionListFeed {
    reads: Arc<DatabaseReadPool>,
    row_sql: Arc<ListRowSql>,
    scheduler: Arc<Scheduler>,
    pending: Arc<PendingSessions>,
    // Set from the opening read's start until the list is dropped, so sessions are collected only
    // while a list is read or held.
    is_listening: Arc<AtomicBool>,
    // Held across an opening read, so an open meanwhile waits for it and takes its list.
    opening: tokio::sync::Mutex<()>,
    open_list: Mutex<Option<OpenList>>,
    _following: FollowerAttachment,
    /// Holds an opening once its rows are read, before the list is held.
    #[cfg(test)]
    pub(crate) opening_read_pause: sidekicks_std::pause_point::PausePoint,
}

// The held list and the tasks that keep it current, which end when it drops.
struct OpenList {
    list: Arc<SharedList>,
    _tasks: [AbortOnDropHandle<()>; 2],
}

impl SessionListFeed {
    /// The list read through `reads`, kept current from `followers`' committed events and renewed
    /// on `scheduler`'s wakes, a session reading waiting while `plan_holds` has a plan of its
    /// waiting.
    pub(crate) fn new(
        reads: Arc<DatabaseReadPool>,
        followers: &Arc<SessionEventFollowers>,
        scheduler: Arc<Scheduler>,
        plan_holds: &dyn PlanHolds,
    ) -> Self {
        let pending = Arc::new(PendingSessions::default());
        let is_listening = Arc::new(AtomicBool::new(false));
        let following = {
            let pending = Arc::clone(&pending);
            let is_listening = Arc::clone(&is_listening);
            followers.follow_all(move |event| {
                let session_id = event.envelope.session_id();
                // The machine's own scope has no row.
                if is_listening.load(Ordering::Acquire)
                    && session_id != *DAEMON_SCOPE_SENTINEL_SESSION_ID
                {
                    pending.add(session_id);
                }
                Ok(())
            })
        };
        Self {
            reads,
            row_sql: Arc::new(ListRowSql::new(plan_holds)),
            scheduler,
            pending,
            is_listening,
            opening: tokio::sync::Mutex::new(()),
            open_list: Mutex::new(None),
            _following: following,
            #[cfg(test)]
            opening_read_pause: sidekicks_std::pause_point::PausePoint::default(),
        }
    }

    /// The list on `database`, kept current from `followers`, with a scheduler that hears no wake
    /// and no plan holds.
    #[cfg(test)]
    pub(crate) fn for_test(
        database: &sidekicks_store::database::writer::test_file::TestDatabase,
        followers: &Arc<SessionEventFollowers>,
    ) -> Arc<Self> {
        let reads = Arc::new(DatabaseReadPool::new(
            database.path(),
            rows::SESSION_LIST_ROWS_STATEMENT_CAPACITY,
        ));
        let scheduler = Arc::new(Scheduler::start(
            Arc::new(sidekicks_platforms::WallClockTimer::new().expect("the timer is made")),
            None,
            tokio::sync::watch::channel(0).1,
        ));
        Arc::new(Self::new(
            reads,
            followers,
            scheduler,
            &crate::plan_holds::NoPlanHolds,
        ))
    }

    /// Opens the list for one subscription: its first page now and the rest through its feed.
    /// Fails with the opening read's failure, with nothing opened.
    pub(crate) async fn open(self: &Arc<Self>) -> Result<SessionListOpening, SessionListReadError> {
        let _opening = self.opening.lock().await;
        if let Some(opening) = self.join_open_list() {
            return Ok(opening);
        }
        self.is_listening.store(true, Ordering::Release);
        let rows = match read_opening_list(&self.reads, &self.row_sql).await {
            Ok(rows) => rows,
            Err(error) => {
                self.is_listening.store(false, Ordering::Release);
                return Err(error);
            }
        };
        #[cfg(test)]
        self.opening_read_pause.pass().await;
        let list = Arc::new(SharedList::new(rows));
        let tasks = [
            AbortOnDropHandle::new(tokio::spawn(read_changed(
                Arc::clone(&self.reads),
                Arc::clone(&self.row_sql),
                Arc::clone(&self.pending),
                Arc::downgrade(self),
                Arc::clone(&list),
            ))),
            AbortOnDropHandle::new(tokio::spawn(renew(
                Arc::clone(&list),
                self.scheduler.on_wake(),
            ))),
        ];
        *self.lock_open_list() = Some(OpenList {
            list,
            _tasks: tasks,
        });
        Ok(self.join_open_list().expect("the list just stored is open"))
    }

    /// Reads those sessions' rows again and sends each that changed to every subscriber, or its
    /// removal when its row is gone. For a list fact a service writes without an event, called
    /// after the write commits; nothing is read while no subscription is open.
    pub(crate) fn refresh(&self, session_ids: impl IntoIterator<Item = SessionId>) {
        if !self.is_listening.load(Ordering::Acquire) {
            return;
        }
        for session_id in session_ids {
            self.pending.add(session_id);
        }
    }

    // A subscriber of the held list, checked and joined under the lock its last leaver drops it
    // under, so no subscriber joins a list being dropped.
    fn join_open_list(self: &Arc<Self>) -> Option<SessionListOpening> {
        let open_list = self.lock_open_list();
        let list = Arc::clone(&open_list.as_ref()?.list);
        let changes = Arc::new(SubscriberChanges::default());
        let (opening, chat_count) = list.join(&changes);
        drop(open_list);
        let mut subscriber =
            SessionListSubscriber::new(Arc::clone(self), Arc::clone(&list), changes, opening);
        let page = subscriber.take_page();
        Some(SessionListOpening {
            sessions: page.sessions,
            chat_count,
            is_complete: page.is_complete,
            subscriber,
        })
    }

    // A subscriber leaves; the last one drops the list, so the next opening reads the rows again.
    fn leave(&self, list: &Arc<SharedList>, changes: &Arc<SubscriberChanges>) {
        let mut open_list = self.lock_open_list();
        let is_last = list.remove_subscriber(changes);
        if is_last
            && open_list
                .as_ref()
                .is_some_and(|open| Arc::ptr_eq(&open.list, list))
        {
            self.close(&mut open_list);
        }
    }

    // Drops the list `ended` names, once it can no longer be kept current.
    fn drop_ended(&self, ended: &Arc<SharedList>) {
        let mut open_list = self.lock_open_list();
        if open_list
            .as_ref()
            .is_some_and(|open| Arc::ptr_eq(&open.list, ended))
        {
            self.close(&mut open_list);
        }
    }

    fn close(&self, open_list: &mut MutexGuard<'_, Option<OpenList>>) {
        self.is_listening.store(false, Ordering::Release);
        // Its tasks end as it drops; this may run inside the reading task, which then ends here.
        let closed = open_list.take();
        drop(closed);
    }

    fn lock_open_list(&self) -> MutexGuard<'_, Option<OpenList>> {
        // The slot holds no invariant a panicking holder could break.
        lock(&self.open_list)
    }
}

impl SessionListRefresh for SessionListFeed {
    fn refresh_session(&self, session_id: SessionId) {
        self.refresh([session_id]);
    }
}

/// The held list: every entry, the chats count, the sessions renewed, and the subscribers'
/// changes.
pub(crate) struct SharedList {
    state: Mutex<ListState>,
    // Raised when the first session to renew joins.
    renewed_joined: Notify,
}

struct ListState {
    entries: HashMap<SessionId, Arc<SessionListEntry>>,
    chat_count: u64,
    renewed: HashSet<SessionId>,
    subscribers: Vec<Weak<SubscriberChanges>>,
}

impl SharedList {
    fn new(rows: Vec<SessionListRow>) -> Self {
        let mut state = ListState {
            entries: HashMap::with_capacity(rows.len()),
            chat_count: 0,
            renewed: HashSet::new(),
            subscribers: Vec::new(),
        };
        for row in rows {
            if let Some(entry) = row.entry {
                state.put(row.session_id, entry);
            }
        }
        Self {
            state: Mutex::new(state),
            renewed_joined: Notify::new(),
        }
    }

    /// The chats the live list counts.
    fn chat_count(&self) -> SafeInt<0> {
        safe_count(self.lock().chat_count)
    }

    /// Each held entry's newest form, stamped now, beside its session while the list still holds
    /// it; one the list no longer holds is answered as held.
    fn newest_of(
        &self,
        held: &[Arc<SessionListEntry>],
    ) -> (Vec<SessionListEntry>, Vec<Option<SessionId>>) {
        let state = self.lock();
        let renewed_at = WireInstant::now();
        held.iter()
            .map(|held| {
                let session_id = session_id_of(held);
                match state.entries.get(&session_id) {
                    Some(current) => (stamped(current, &renewed_at), Some(session_id)),
                    None => (stamped(held, &renewed_at), None),
                }
            })
            .unzip()
    }

    /// The session's entry as it stands, stamped now, and the chats count; `None` once it left.
    fn current_of(&self, session_id: &SessionId) -> (Option<SessionListEntry>, SafeInt<0>) {
        let state = self.lock();
        let entry = state
            .entries
            .get(session_id)
            .map(|entry| stamped(entry, &WireInstant::now()));
        (entry, safe_count(state.chat_count))
    }

    // Adds a subscriber and answers the list as it now stands for its opening.
    fn join(&self, changes: &Arc<SubscriberChanges>) -> (Vec<Arc<SessionListEntry>>, SafeInt<0>) {
        let mut state = self.lock();
        state.subscribers.push(Arc::downgrade(changes));
        (
            state.entries.values().cloned().collect(),
            safe_count(state.chat_count),
        )
    }

    // Removes a subscriber; answers whether none is left.
    fn remove_subscriber(&self, changes: &Arc<SubscriberChanges>) -> bool {
        let mut state = self.lock();
        let left = Arc::downgrade(changes);
        state
            .subscribers
            .retain(|subscriber| subscriber.strong_count() > 0 && !subscriber.ptr_eq(&left));
        state.subscribers.is_empty()
    }

    // Applies the rows read for `session_ids`, telling every subscriber of each that changed.
    fn apply(&self, session_ids: &[SessionId], rows: Vec<SessionListRow>) {
        let mut rows_by_id: HashMap<SessionId, SessionListRow> =
            rows.into_iter().map(|row| (row.session_id, row)).collect();
        let mut state = self.lock();
        let had_renewed = !state.renewed.is_empty();
        let mut changed = Vec::new();
        for session_id in session_ids {
            let held = state.entries.get(session_id).cloned();
            match rows_by_id.remove(session_id) {
                None => {
                    if let Some(held) = held {
                        state.take(&held);
                        changed.push(*session_id);
                    }
                }
                // A project session whose project was forgotten keeps what it showed.
                Some(SessionListRow { entry: None, .. }) => {}
                Some(SessionListRow {
                    entry: Some(entry), ..
                }) => {
                    if held
                        .as_deref()
                        .is_some_and(|held| is_same_entry(held, &entry))
                    {
                        continue;
                    }
                    if let Some(held) = held {
                        state.take(&held);
                    }
                    state.put(*session_id, entry);
                    changed.push(*session_id);
                }
            }
        }
        state.tell(&changed);
        if !had_renewed && !state.renewed.is_empty() {
            self.renewed_joined.notify_one();
        }
    }

    // Tells every subscriber of each renewed session.
    fn renew(&self) {
        let mut state = self.lock();
        let renewed: Vec<SessionId> = state.renewed.iter().copied().collect();
        state.tell(&renewed);
    }

    // Waits until a session to renew is held.
    async fn wait_for_renewed(&self) {
        loop {
            if !self.lock().renewed.is_empty() {
                return;
            }
            self.renewed_joined.notified().await;
        }
    }

    // Ends every subscriber's stream.
    fn end(&self, end: ListEnd) {
        for subscriber in &self.lock().subscribers {
            if let Some(changes) = subscriber.upgrade() {
                changes.end(end);
            }
        }
    }

    fn lock(&self) -> MutexGuard<'_, ListState> {
        // The counts are kept beside the entries under one hold, so no holder leaves them apart.
        lock(&self.state)
    }
}

impl ListState {
    fn put(&mut self, session_id: SessionId, entry: SessionListEntry) {
        self.chat_count += counts_as_chat(&entry);
        if is_renewed(&entry) {
            self.renewed.insert(session_id);
        }
        self.entries.insert(session_id, Arc::new(entry));
    }

    fn take(&mut self, held: &SessionListEntry) {
        let session_id = session_id_of(held);
        self.chat_count -= counts_as_chat(held);
        self.renewed.remove(&session_id);
        self.entries.remove(&session_id);
    }

    fn tell(&mut self, session_ids: &[SessionId]) {
        if session_ids.is_empty() {
            return;
        }
        self.subscribers
            .retain(|subscriber| match subscriber.upgrade() {
                Some(changes) => {
                    for session_id in session_ids {
                        changes.add(*session_id);
                    }
                    true
                }
                None => false,
            });
    }
}

// Every row, a page per pool read.
async fn read_opening_list(
    reads: &DatabaseReadPool,
    row_sql: &Arc<ListRowSql>,
) -> Result<Vec<SessionListRow>, SessionListReadError> {
    let mut rows = Vec::new();
    // A table's rowids start at 1.
    let mut after_position = 0;
    loop {
        let row_sql = Arc::clone(row_sql);
        let page = reads
            .read(ReadLength::Long, move |connection| {
                row_sql
                    .read_list_page(connection, after_position)
                    .map_err(SessionListReadError::from)
            })
            .await?;
        let page_length = page.len();
        if let Some(last) = page.last() {
            after_position = last.row_position;
        }
        rows.extend(page);
        if page_length < OPENING_READ_PAGE_ROWS {
            return Ok(rows);
        }
    }
}

// Reads the waiting sessions' rows again until the list drops. A failed read ends every
// subscriber's stream and drops the list, so the next opening reads the rows again; the read pool
// closing under the daemon's stop finishes them.
async fn read_changed(
    reads: Arc<DatabaseReadPool>,
    row_sql: Arc<ListRowSql>,
    pending: Arc<PendingSessions>,
    feed: Weak<SessionListFeed>,
    list: Arc<SharedList>,
) {
    loop {
        let session_ids: Vec<SessionId> = pending.take().await.into_iter().collect();
        for chunk in session_ids.chunks(CHANGED_READ_SESSIONS) {
            let chunk = chunk.to_vec();
            let read_ids = chunk.clone();
            let row_sql = Arc::clone(&row_sql);
            let read = reads
                .read(ReadLength::Short, move |connection| {
                    row_sql
                        .read_list_rows(connection, &read_ids)
                        .map_err(SessionListReadError::from)
                })
                .await;
            match read {
                Ok(rows) => list.apply(&chunk, rows),
                Err(error) => {
                    let end = if matches!(
                        error,
                        SessionListReadError::Pool(DatabaseReadError::Closed)
                    ) {
                        ListEnd::Finished
                    } else {
                        tracing::error!(
                            error = &error as &(dyn Error + 'static),
                            "reading a changed session's list row failed, so every sessions list \
                             subscription was ended"
                        );
                        ListEnd::Failed
                    };
                    list.end(end);
                    if let Some(feed) = feed.upgrade() {
                        feed.drop_ended(&list);
                    }
                    return;
                }
            }
        }
    }
}

// Sends every renewed session again each interval while one is held, and at once on a wake.
async fn renew(list: Arc<SharedList>, mut wakes: broadcast::Receiver<WakeSignal>) {
    let mut hears_wakes = true;
    loop {
        list.wait_for_renewed().await;
        let woke = async {
            if hears_wakes {
                wakes.recv().await
            } else {
                std::future::pending().await
            }
        };
        tokio::select! {
            () = tokio::time::sleep(RENEW_INTERVAL) => {}
            received = woke => {
                // A closed receiver hears no wake again; a lagged one has heard at least one.
                if let Err(RecvError::Closed) = received {
                    hears_wakes = false;
                    continue;
                }
            }
        }
        list.renew();
    }
}

fn session_id_of(entry: &SessionListEntry) -> SessionId {
    match entry {
        SessionListEntry::Project(project) => project.session_id,
        SessionListEntry::Chat(chat) => chat.session_id,
    }
}

fn state_of(entry: &SessionListEntry) -> SessionState {
    match entry {
        SessionListEntry::Project(project) => project.state,
        SessionListEntry::Chat(chat) => chat.state,
    }
}

fn activity_of(entry: &SessionListEntry) -> SessionActivity {
    match entry {
        SessionListEntry::Project(project) => project.activity,
        SessionListEntry::Chat(chat) => chat.activity,
    }
}

// The entry with `renewed_at` as its renewal stamp.
fn stamped(entry: &SessionListEntry, renewed_at: &WireInstant) -> SessionListEntry {
    let mut stamped = entry.clone();
    match &mut stamped {
        SessionListEntry::Project(project) => project.activity_renewed_at = renewed_at.clone(),
        SessionListEntry::Chat(chat) => chat.activity_renewed_at = renewed_at.clone(),
    }
    stamped
}

// Whether two entries say the same thing; a new renewal stamp alone is no change.
fn is_same_entry(held: &SessionListEntry, entry: &SessionListEntry) -> bool {
    let renewed_at = match held {
        SessionListEntry::Project(project) => &project.activity_renewed_at,
        SessionListEntry::Chat(chat) => &chat.activity_renewed_at,
    };
    *held == stamped(entry, renewed_at)
}

fn is_renewed(entry: &SessionListEntry) -> bool {
    matches!(
        activity_of(entry),
        SessionActivity::Running | SessionActivity::Waiting
    )
}

// 1 for a chat the Chats header counts, else 0: an archived, closed or purging chat is not live.
fn counts_as_chat(entry: &SessionListEntry) -> u64 {
    let is_live = !matches!(
        state_of(entry),
        SessionState::Archived | SessionState::Closed | SessionState::PurgeRequested
    );
    u64::from(matches!(entry, SessionListEntry::Chat(_)) && is_live)
}

fn safe_count(count: u64) -> SafeInt<0> {
    SafeInt::new(count).expect("the chats count is at most the sessions held")
}
