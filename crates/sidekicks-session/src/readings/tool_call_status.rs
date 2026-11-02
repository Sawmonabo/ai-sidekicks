//! The status line under each running tool call, as its driver publishes it: the provider's own
//! words for the call's progress, live and keyed per call, never stored. A subscriber follows a
//! whole session and reads each held line at once, then each call's newest after a change, at
//! most one a second per call; a closed call's line is cleared with a `null`, and a session's
//! lines go once the session closes, one published after that dropped.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use sidekicks_contracts::provider::tool_call::ToolCallId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::tool_call_status::{TOOL_CALL_STATUS_MAX_LEN, ToolCallStatusUpdate};
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_ipc::stream::latest_value::{
    KeyedLatestValueOutlet, KeyedLatestValueOutlets, LatestValueOutletId,
};
use sidekicks_provider::port::tool_call_status_publisher::ToolCallStatusPublisher;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::connection::read_pool::{DatabaseReadPool, ReadLength};
use sidekicks_store::events::session::followers::{FollowerAttachment, SessionEventFollowers};
use tokio::runtime::Handle;
use tokio::time::Instant;
use tokio_util::task::AbortOnDropHandle;

use super::{ClosedSessions, ReadingFollowError, follow_closed_sessions, refuse_unknown_session};

// A provider can report several times a second, and the line needs at most one update a second.
const STATUS_SEND_INTERVAL: Duration = Duration::from_secs(1);

type ToolCallStatus = FreeFormText<TOOL_CALL_STATUS_MAX_LEN>;

/// Each running tool call's newest status line and each session's subscribers: the status lines'
/// intake that the daemon registers for the drivers.
pub struct ToolCallStatuses {
    pool: Arc<DatabaseReadPool>,
    held: Arc<HeldStatuses>,
    closed: Arc<ClosedSessions>,
    // Lets a closed session's lines and subscribers go; dropped with the statuses.
    _session_closes: FollowerAttachment,
}

// The held sessions behind one lock, and the runtime a held-back line's send is timed on.
struct HeldStatuses {
    runtime: Handle,
    sessions: Mutex<HeldSessions>,
}

// Each session's entry, every entry and armed send stamped from one counter, so a detach or a
// send that outlived what it was armed for never reaches what is held after it.
struct HeldSessions {
    next_stamp: u64,
    by_session: HashMap<SessionId, SessionStatuses>,
}

// One session's lines and subscribers; kept while it holds either.
struct SessionStatuses {
    stamp: u64,
    by_call: HashMap<ToolCallId, HeldStatus>,
    outlets: KeyedLatestValueOutlets<ToolCallId, ToolCallStatusUpdate>,
}

// One call's newest line, when a line was last sent, and the send held back to the second's end.
struct HeldStatus {
    newest: ToolCallStatus,
    last_sent: Instant,
    held_back_send: Option<HeldBackSend>,
}

// A send armed for the end of the current second; dropping it aborts the send.
struct HeldBackSend {
    stamp: u64,
    task: AbortOnDropHandle<()>,
}

impl ToolCallStatuses {
    /// Statuses that hold none until a driver publishes one, reading sessions on `pool`, and
    /// letting a session's lines go once `followers` hears the session closed. It times a held-back
    /// send on the runtime it is built in, so it is built inside the daemon's runtime.
    pub fn new(pool: Arc<DatabaseReadPool>, followers: &Arc<SessionEventFollowers>) -> Self {
        let held = Arc::new(HeldStatuses {
            runtime: Handle::current(),
            sessions: Mutex::new(HeldSessions {
                next_stamp: 0,
                by_session: HashMap::new(),
            }),
        });
        let closed = Arc::new(ClosedSessions::default());
        let released = Arc::clone(&held);
        let session_closes = follow_closed_sessions(followers, &closed, move |session_id| {
            released.release(session_id);
        });
        Self {
            pool,
            held,
            closed,
            _session_closes: session_closes,
        }
    }

    /// Forgets `session_id`, which was purged, as closed.
    pub fn forget_purged_session(&self, session_id: SessionId) {
        self.closed.forget_purged(session_id);
    }

    /// Sends each held line of `session_id`'s tool calls through `outlet` at once, then each call's
    /// newer line and its clear, until the answered detach runs or the session closes. Refused
    /// `session.notFound` for a session this daemon holds no row for, following nothing; fails
    /// when the session cannot be read.
    pub async fn follow(
        &self,
        session_id: SessionId,
        outlet: KeyedLatestValueOutlet<ToolCallId, ToolCallStatusUpdate>,
    ) -> Result<impl FnOnce() + Send + use<>, ReadingFollowError> {
        self.pool
            .read(ReadLength::Short, move |reader| {
                refuse_unknown_session(reader, &session_id)
            })
            .await?;
        // A session whose close was heard drops the outlet, which ends the stream at once.
        let mut attached = None;
        self.closed.publish_unless_closed(session_id, || {
            attached = Some(self.held.attach(session_id, outlet));
        });
        let held = Arc::downgrade(&self.held);
        Ok(move || {
            if let (Some((stamp, id)), Some(held)) = (attached, held.upgrade()) {
                held.detach(session_id, stamp, id);
            }
        })
    }
}

impl ToolCallStatusPublisher for ToolCallStatuses {
    fn publish_tool_call_status(
        &self,
        session_id: SessionId,
        tool_call_id: ToolCallId,
        status: ToolCallStatus,
    ) {
        self.closed.publish_unless_closed(session_id, || {
            self.held.publish(session_id, tool_call_id, status);
        });
    }

    fn clear_tool_call_status(&self, session_id: SessionId, tool_call_id: ToolCallId) {
        self.held.clear(session_id, &tool_call_id);
    }
}

impl HeldStatuses {
    // Holds `status` as the call's newest line: sent at once when the call sent none in the last
    // second, otherwise sent by one send armed for that second's end.
    fn publish(
        self: &Arc<Self>,
        session_id: SessionId,
        tool_call_id: ToolCallId,
        status: ToolCallStatus,
    ) {
        let now = Instant::now();
        let mut sessions = self.lock();
        let HeldSessions {
            next_stamp,
            by_session,
        } = &mut *sessions;
        let session = by_session
            .entry(session_id)
            .or_insert_with(|| SessionStatuses::new(take_stamp(next_stamp)));
        let Some(held) = session.by_call.get_mut(&tool_call_id) else {
            session
                .outlets
                .send(&tool_call_id, &update(&tool_call_id, Some(&status)));
            session.by_call.insert(
                tool_call_id,
                HeldStatus {
                    newest: status,
                    last_sent: now,
                    held_back_send: None,
                },
            );
            return;
        };
        held.newest = status;
        let send_at = held.last_sent + STATUS_SEND_INTERVAL;
        if now >= send_at {
            // A send armed for this instant would be a second send in one second.
            held.held_back_send = None;
            held.last_sent = now;
            session
                .outlets
                .send(&tool_call_id, &update(&tool_call_id, Some(&held.newest)));
        } else if held.held_back_send.is_none() {
            let stamp = take_stamp(next_stamp);
            let statuses = Arc::downgrade(self);
            let task = self.runtime.spawn(async move {
                tokio::time::sleep_until(send_at).await;
                if let Some(statuses) = statuses.upgrade() {
                    statuses.send_held_back(session_id, &tool_call_id, stamp);
                }
            });
            held.held_back_send = Some(HeldBackSend {
                stamp,
                task: AbortOnDropHandle::new(task),
            });
        }
    }

    // Sends the call's newest line, when the held-back send armed with `stamp` is still the one
    // its call holds; a cleared call or a send replaced since sends nothing.
    fn send_held_back(&self, session_id: SessionId, tool_call_id: &ToolCallId, stamp: u64) {
        let mut sessions = self.lock();
        let Some(session) = sessions.by_session.get_mut(&session_id) else {
            return;
        };
        let Some(held) = session.by_call.get_mut(tool_call_id) else {
            return;
        };
        if held
            .held_back_send
            .as_ref()
            .is_none_or(|send| send.stamp != stamp)
        {
            return;
        }
        if let Some(send) = held.held_back_send.take() {
            // This very task runs the send, so it is let go rather than aborted.
            drop(send.task.detach());
        }
        held.last_sent = Instant::now();
        session
            .outlets
            .send(tool_call_id, &update(tool_call_id, Some(&held.newest)));
    }

    // Removes the call's line, which aborts its held-back send, and sends its clear at once; a
    // call holding no line changes nothing.
    fn clear(&self, session_id: SessionId, tool_call_id: &ToolCallId) {
        let released = {
            let mut sessions = self.lock();
            let Some(session) = sessions.by_session.get_mut(&session_id) else {
                return;
            };
            let Some(held) = session.by_call.remove(tool_call_id) else {
                return;
            };
            session
                .outlets
                .send(tool_call_id, &update(tool_call_id, None));
            let emptied = session
                .is_empty()
                .then(|| sessions.by_session.remove(&session_id));
            (held, emptied)
        };
        drop(released);
    }

    // Attaches `outlet` to `session_id`'s entry, made if absent, after sending it each held line,
    // and answers the entry's stamp and the outlet's id its detach takes.
    fn attach(
        &self,
        session_id: SessionId,
        outlet: KeyedLatestValueOutlet<ToolCallId, ToolCallStatusUpdate>,
    ) -> (u64, LatestValueOutletId) {
        let mut sessions = self.lock();
        let HeldSessions {
            next_stamp,
            by_session,
        } = &mut *sessions;
        let session = by_session
            .entry(session_id)
            .or_insert_with(|| SessionStatuses::new(take_stamp(next_stamp)));
        for (tool_call_id, held) in &session.by_call {
            outlet.send(
                tool_call_id.clone(),
                update(tool_call_id, Some(&held.newest)),
            );
        }
        (session.stamp, session.outlets.attach(outlet))
    }

    // Removes the subscriber `id` of `session_id`'s entry stamped `stamp`, and the entry once it
    // holds neither a line nor a subscriber.
    fn detach(&self, session_id: SessionId, stamp: u64, id: LatestValueOutletId) {
        let released = {
            let mut sessions = self.lock();
            let Some(session) = sessions.by_session.get_mut(&session_id) else {
                return;
            };
            if session.stamp != stamp {
                return;
            }
            session.outlets.detach(id);
            session
                .is_empty()
                .then(|| sessions.by_session.remove(&session_id))
        };
        drop(released);
    }

    // Drops `session_id`'s lines, held-back sends and subscribers, whose streams then finish.
    fn release(&self, session_id: SessionId) {
        let released = self.lock().by_session.remove(&session_id);
        // Outside the lock: each dropped outlet wakes its feed.
        drop(released);
    }

    fn lock(&self) -> MutexGuard<'_, HeldSessions> {
        // Every change keeps the held sessions whole.
        lock(&self.sessions)
    }
}

impl SessionStatuses {
    fn new(stamp: u64) -> Self {
        Self {
            stamp,
            by_call: HashMap::new(),
            outlets: KeyedLatestValueOutlets::default(),
        }
    }

    fn is_empty(&self) -> bool {
        self.by_call.is_empty() && self.outlets.is_empty()
    }
}

fn take_stamp(next_stamp: &mut u64) -> u64 {
    let stamp = *next_stamp;
    *next_stamp += 1;
    stamp
}

fn update(tool_call_id: &ToolCallId, status: Option<&ToolCallStatus>) -> ToolCallStatusUpdate {
    ToolCallStatusUpdate {
        tool_call_id: tool_call_id.clone(),
        status: status.cloned(),
    }
}

#[cfg(test)]
mod tests {
    use sidekicks_ipc::registry::HandlerError;
    use sidekicks_ipc::stream::latest_value::KeyedLatestValueFeed;
    use sidekicks_store::database::schema::session_directory::insert_session_row;
    use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};
    use sidekicks_store::events::log_service::test_fixture::{TestLog, open_log};
    use tokio::time::timeout;

    use super::*;
    use crate::questions::schema::schema_parts;
    use crate::readings::READINGS_STATEMENT_CAPACITY;

    type StatusFeed = KeyedLatestValueFeed<ToolCallId, ToolCallStatusUpdate, BoxedDetach>;
    type BoxedDetach = Box<dyn FnOnce() + Send>;

    struct Fixture {
        statuses: Arc<ToolCallStatuses>,
        session_id: SessionId,
        // Keeps the database and its log open for the test.
        _database: TestDatabase,
        _log: TestLog,
    }

    async fn fixture() -> Fixture {
        let database = TestDatabase::new(schema_parts());
        let session_id = test_session_id();
        insert_session_row(&database.reader(), session_id.text().as_str(), None, None);
        let log = open_log(&database, None).await;
        let pool = Arc::new(DatabaseReadPool::new(
            database.path(),
            READINGS_STATEMENT_CAPACITY,
        ));
        Fixture {
            statuses: Arc::new(ToolCallStatuses::new(pool, &log.followers)),
            session_id,
            _database: database,
            _log: log,
        }
    }

    async fn open_feed(statuses: &Arc<ToolCallStatuses>, session_id: SessionId) -> StatusFeed {
        let statuses = Arc::clone(statuses);
        KeyedLatestValueFeed::open(|outlet| async move {
            let detach: BoxedDetach = Box::new(
                statuses
                    .follow(session_id, outlet)
                    .await
                    .map_err(HandlerError::from)?,
            );
            Ok(detach)
        })
        .await
        .expect("the follow opens")
    }

    async fn read(feed: &mut StatusFeed) -> ToolCallStatusUpdate {
        timeout(Duration::from_secs(5), feed.recv())
            .await
            .expect("a status arrives")
            .expect("the feed never fails")
            .expect("the feed stays open")
    }

    fn call(id: &str) -> ToolCallId {
        ToolCallId::new(id.to_owned()).expect("a short id")
    }

    fn line(text: &str) -> ToolCallStatus {
        FreeFormText::new(text.to_owned()).expect("a short line")
    }

    fn sent(id: &str, text: Option<&str>) -> ToolCallStatusUpdate {
        ToolCallStatusUpdate {
            tool_call_id: call(id),
            status: text.map(line),
        }
    }

    // Catches a clear that sends nothing, a clear that keeps the key, and a follow that sends
    // nothing held.
    #[tokio::test(start_paused = true)]
    async fn a_cleared_call_sends_null_and_a_later_subscriber_never_reads_it() {
        let fixture = fixture().await;
        let (statuses, session_id) = (&fixture.statuses, fixture.session_id);
        let mut first = open_feed(statuses, session_id).await;
        statuses.publish_tool_call_status(session_id, call("k1"), line("a"));
        assert_eq!(read(&mut first).await, sent("k1", Some("a")));

        statuses.clear_tool_call_status(session_id, call("k1"));
        assert_eq!(read(&mut first).await, sent("k1", None));

        statuses.publish_tool_call_status(session_id, call("k2"), line("b"));
        assert_eq!(read(&mut first).await, sent("k2", Some("b")));

        let mut second = open_feed(statuses, session_id).await;
        assert_eq!(read(&mut second).await, sent("k2", Some("b")));
        assert!(
            timeout(Duration::from_secs(5), second.recv())
                .await
                .is_err(),
            "the cleared call sends nothing to a later subscriber"
        );
    }

    // Catches no throttle, no trailing send, the first waiting line sent instead of the newest, a
    // clear held back by the second, and a held-back send that outlives its call's clear.
    #[tokio::test(start_paused = true)]
    async fn a_call_sends_at_most_one_line_a_second_and_its_clear_at_once() {
        let fixture = fixture().await;
        let (statuses, session_id) = (&fixture.statuses, fixture.session_id);
        let mut feed = open_feed(statuses, session_id).await;
        let start = Instant::now();
        statuses.publish_tool_call_status(session_id, call("k1"), line("a"));
        assert_eq!(read(&mut feed).await, sent("k1", Some("a")));
        assert_eq!(Instant::now(), start);

        statuses.publish_tool_call_status(session_id, call("k1"), line("b"));
        tokio::time::advance(Duration::from_millis(200)).await;
        statuses.publish_tool_call_status(session_id, call("k1"), line("c"));
        assert_eq!(read(&mut feed).await, sent("k1", Some("c")));
        assert_eq!(Instant::now(), start + Duration::from_secs(1));

        tokio::time::advance(Duration::from_millis(100)).await;
        statuses.publish_tool_call_status(session_id, call("k1"), line("d"));
        statuses.clear_tool_call_status(session_id, call("k1"));
        assert_eq!(read(&mut feed).await, sent("k1", None));
        assert_eq!(Instant::now(), start + Duration::from_millis(1_100));

        tokio::time::sleep(Duration::from_secs(2)).await;
        statuses.publish_tool_call_status(session_id, call("k2"), line("e"));
        assert_eq!(read(&mut feed).await, sent("k2", Some("e")));
    }
}
