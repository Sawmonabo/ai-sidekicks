//! Which session each conversation on one Codex service belongs to. Every frame and server request
//! a service sends names its thread, so this is where a shared service's traffic is told apart: a
//! session's own thread, and every child thread a helper opened beneath it. A frame can name a
//! thread before it is registered: a start's or a fork's ahead of its reply, a spawned helper's
//! ahead of the spawn item. Such frames are held, within a frame count, a byte bound and a
//! timeout, until it is; a held frame no registration took is reported at its deadline. A
//! released thread is remembered with the session it ran for, so its last exported records still
//! reach that session.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::value::RawValue;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::mutex_lock::lock;
use tokio::sync::watch;
use tokio::time::Instant;

use crate::driver::codex::event_normalizer::CODEX_THREAD_STARTED_METHOD;
use crate::driver::codex::service::supervisor::routing::CODEX_THREAD_CLOSED_METHOD;

/// Lifecycle broadcasts every connection sees for every conversation on the service, the person's
/// own and a throwaway title conversation among them; held only while a claim is open, and never a
/// fault when no session holds the conversation.
const CODEX_UNHELD_THREAD_BROADCASTS: [&str; 2] =
    [CODEX_THREAD_STARTED_METHOD, CODEX_THREAD_CLOSED_METHOD];

/// How many released threads one service remembers; past it the oldest is forgotten and logged.
/// A thread's last exported record follows its release within one log batch interval.
const RELEASED_THREADS_KEPT: usize = 64;

/// The most the hold keeps of its frames' params, in bytes, the oldest pushed out past it: one
/// `item/completed` can carry a command's whole output.
pub(crate) const CODEX_HELD_FRAME_MAX_BYTES: usize = 4 * 1024 * 1024;

/// A frame the service sent naming a thread no session has registered yet.
#[derive(Clone, Debug)]
pub(crate) struct CodexHeldThreadFrame {
    /// The frame's method.
    pub(crate) method: String,
    /// The frame's params, as the service sent them.
    pub(crate) params: Box<RawValue>,
    /// The thread the frame names.
    pub(crate) thread_id: String,
}

impl PartialEq for CodexHeldThreadFrame {
    fn eq(&self, other: &Self) -> bool {
        self.method == other.method
            && self.params.get() == other.params.get()
            && self.thread_id == other.thread_id
    }
}

// A thread the service released and the session it was bound to.
struct CodexReleasedThread {
    thread: String,
    session: SessionId,
}

/// Where a frame naming a thread goes, settled under one lock of the index.
pub(crate) enum CodexThreadFrameRoute {
    /// The thread is registered: the frame goes to this session.
    Session(SessionId, CodexHeldThreadFrame),
    /// The frame is held, and the bounds pushed out these older frames, oldest first.
    Held(Vec<CodexHeldThreadFrame>),
}

/// Where the held frames no registration took within the timeout go: the supervisor reports each
/// as unrouted. It is called only with a non-empty list, and never under the index's lock.
pub(crate) type UnclaimedThreadFrameReport = Arc<dyn Fn(Vec<CodexHeldThreadFrame>) + Send + Sync>;

/// The thread-to-session index of one service, and the bounded, timed hold for frames that name a
/// thread not registered yet: a start's or a fork's in flight, whose `thread/started` can come
/// before its reply, or a spawned helper's, whose frames can come before the spawn item. It keeps
/// no lock of its own: the supervisor owns the `Mutex` around it.
pub(crate) struct CodexServiceThreads {
    max_held_frames: usize,
    max_held_bytes: usize,
    held_frame_timeout: Duration,
    report_unclaimed: UnclaimedThreadFrameReport,
    session_by_thread: BTreeMap<String, SessionId>,
    side_question_threads: BTreeSet<String>,
    /// The threads this service released, oldest first, each once.
    released: VecDeque<CodexReleasedThread>,
    /// The held frames in arrival order, each with when it arrived.
    held_frames: VecDeque<(Instant, CodexHeldThreadFrame)>,
    /// The bytes of the held frames' params.
    held_bytes: usize,
    claims_in_flight: usize,
    /// When the oldest held frame falls due, `None` while nothing is held or a claim is open.
    expiry: watch::Sender<Option<Instant>>,
    /// Bumped at every registration, so a reader waiting on a thread's owner wakes to look again.
    registrations: watch::Sender<u64>,
}

impl CodexServiceThreads {
    /// An empty index whose hold keeps at most `max_held_frames` and `max_held_bytes` of params,
    /// the oldest pushed out past either, each for `held_frame_timeout` while no claim is open,
    /// and reports the frames it let expire through `report_unclaimed`.
    pub(crate) fn new(
        max_held_frames: usize,
        max_held_bytes: usize,
        held_frame_timeout: Duration,
        report_unclaimed: UnclaimedThreadFrameReport,
    ) -> Self {
        Self {
            max_held_frames,
            max_held_bytes,
            held_frame_timeout,
            report_unclaimed,
            session_by_thread: BTreeMap::new(),
            side_question_threads: BTreeSet::new(),
            released: VecDeque::new(),
            held_frames: VecDeque::new(),
            held_bytes: 0,
            claims_in_flight: 0,
            expiry: watch::Sender::new(None),
            registrations: watch::Sender::new(0),
        }
    }

    /// When the oldest held frame falls due, as it changes: the timer that reports it watches this,
    /// so a held frame is reported at its deadline, never later.
    pub(crate) fn watch_expiry(&self) -> watch::Receiver<Option<Instant>> {
        self.expiry.subscribe()
    }

    /// Changes at every registration, for a reader waiting on a thread no session holds yet.
    pub(crate) fn watch_registrations(&self) -> watch::Receiver<u64> {
        self.registrations.subscribe()
    }

    // Sets when the oldest held frame falls due; none falls due while a claim is open.
    fn rearm_expiry(&self) {
        let deadline = self
            .held_frames
            .front()
            .filter(|_| self.claims_in_flight == 0)
            .map(|(arrived_at, _)| *arrived_at + self.held_frame_timeout);
        self.expiry.send_if_modified(|due| {
            let is_changed = *due != deadline;
            *due = deadline;
            is_changed
        });
    }

    /// The session a thread belongs to, or `None` for one no session on this service holds.
    pub(crate) fn session_for(&self, thread_id: &str) -> Option<&SessionId> {
        self.session_by_thread.get(thread_id)
    }

    /// Whether `thread_id` is a side question's read-only copy, which asks the person nothing.
    pub(crate) fn is_side_question(&self, thread_id: &str) -> bool {
        self.side_question_threads.contains(thread_id)
    }

    /// Marks the registered `thread_id` as a side question's copy until it is released.
    pub(crate) fn mark_side_question(&mut self, thread_id: String) {
        self.side_question_threads.insert(thread_id);
    }

    /// Every session holding a conversation on this service, each once.
    pub(crate) fn sessions(&self) -> Vec<SessionId> {
        self.session_by_thread
            .values()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .copied()
            .collect()
    }

    /// Every thread one session holds here: its own and its helpers'.
    pub(crate) fn threads_of(&self, session_id: &SessionId) -> Vec<String> {
        self.session_by_thread
            .iter()
            .filter(|(_, owner)| *owner == session_id)
            .map(|(thread_id, _)| thread_id.clone())
            .collect()
    }

    /// Records a thread as the session's, and returns the frames held for it, in arrival order,
    /// for the caller to deliver now.
    pub(crate) fn register(
        &mut self,
        thread_id: String,
        session_id: SessionId,
    ) -> Vec<CodexHeldThreadFrame> {
        let mut released = Vec::new();
        for (arrived_at, frame) in std::mem::take(&mut self.held_frames) {
            if frame.thread_id == thread_id {
                self.held_bytes -= frame.params.get().len();
                released.push(frame);
            } else {
                self.held_frames.push_back((arrived_at, frame));
            }
        }
        self.released.retain(|former| former.thread != thread_id);
        self.session_by_thread.insert(thread_id, session_id);
        self.registrations
            .send_modify(|count| *count = count.wrapping_add(1));
        if !released.is_empty() {
            self.rearm_expiry();
        }
        released
    }

    /// Forgets one thread, remembering the session it was bound to until it is registered again;
    /// past the bound the oldest is forgotten and logged. Answers that session where the thread
    /// was a side question's copy.
    pub(crate) fn release(&mut self, thread_id: &str) -> Option<SessionId> {
        let was_side_question = self.side_question_threads.remove(thread_id);
        let session_id = self.session_by_thread.remove(thread_id)?;
        self.released.retain(|former| former.thread != thread_id);
        if self.released.len() >= RELEASED_THREADS_KEPT
            && let Some(forgotten) = self.released.pop_front()
        {
            tracing::info!(
                conversation_id = forgotten.thread.as_str(),
                "a codex service keeps too many released threads; the oldest is forgotten"
            );
        }
        self.released.push_back(CodexReleasedThread {
            thread: thread_id.to_owned(),
            session: session_id,
        });
        was_side_question.then_some(session_id)
    }

    /// The session `thread_id` was bound to when this service released it, `None` for a thread
    /// this service holds now, never held or forgot.
    pub(crate) fn former_session_for(&self, thread_id: &str) -> Option<SessionId> {
        self.released
            .iter()
            .find(|former| former.thread == thread_id)
            .map(|former| former.session)
    }

    /// Opens a claim for a start or fork whose thread is not known yet; while any claim is open no
    /// held frame expires. The claim closes when it is dropped, however its caller ends; the last
    /// one to close reports the frames held past the timeout and keeps the younger. It locks
    /// `threads` to open and to close, so it is never dropped under that lock.
    pub(crate) fn begin_claim(threads: &Arc<Mutex<Self>>) -> ThreadClaim {
        let report_unclaimed = {
            let mut index = lock(threads);
            index.claims_in_flight += 1;
            index.rearm_expiry();
            Arc::clone(&index.report_unclaimed)
        };
        ThreadClaim {
            threads: Arc::clone(threads),
            report_unclaimed,
        }
    }

    /// Answers the session that registered the frame's thread, or holds the frame as arriving at
    /// `now`, so no registration can fall between the lookup and the hold.
    pub(crate) fn route_or_hold(
        &mut self,
        frame: CodexHeldThreadFrame,
        now: Instant,
    ) -> CodexThreadFrameRoute {
        match self.session_by_thread.get(&frame.thread_id) {
            Some(session_id) => CodexThreadFrameRoute::Session(*session_id, frame),
            None => CodexThreadFrameRoute::Held(self.hold(frame, now)),
        }
    }

    // Holds a frame for an unregistered thread, as arriving at `now`; a lifecycle broadcast is
    // dropped instead while no claim is open. Answers the oldest held frames the bounds pushed
    // out, oldest first, the frame itself among them when its params alone pass the byte bound.
    fn hold(&mut self, frame: CodexHeldThreadFrame, now: Instant) -> Vec<CodexHeldThreadFrame> {
        if self.claims_in_flight == 0
            && CODEX_UNHELD_THREAD_BROADCASTS.contains(&frame.method.as_str())
        {
            return Vec::new();
        }
        self.held_bytes += frame.params.get().len();
        self.held_frames.push_back((now, frame));
        let mut pushed_out = Vec::new();
        while self.held_frames.len() > self.max_held_frames || self.held_bytes > self.max_held_bytes
        {
            let Some((_, oldest)) = self.held_frames.pop_front() else {
                break;
            };
            self.held_bytes -= oldest.params.get().len();
            pushed_out.push(oldest);
        }
        self.rearm_expiry();
        pushed_out
    }

    /// Reports the frames held past the timeout at `now`, unless a claim is open; the service's
    /// runner calls it when [`Self::watch_expiry`]'s deadline falls due. It locks `threads`, and
    /// reports once that lock is let go.
    pub(crate) fn report_expired(threads: &Arc<Mutex<Self>>, now: Instant) {
        let (expired, report_unclaimed) = {
            let mut index = lock(threads);
            if index.claims_in_flight > 0 {
                return;
            }
            (index.take_expired(now), Arc::clone(&index.report_unclaimed))
        };
        if !expired.is_empty() {
            report_unclaimed(expired);
        }
    }

    // Takes out the frames held for the timeout or longer at `now`: they arrived in order, so they
    // are the oldest.
    fn take_expired(&mut self, now: Instant) -> Vec<CodexHeldThreadFrame> {
        let timeout = self.held_frame_timeout;
        let mut expired = Vec::new();
        while let Some((_, frame)) = self
            .held_frames
            .pop_front_if(|(arrived_at, _)| now.saturating_duration_since(*arrived_at) >= timeout)
        {
            self.held_bytes -= frame.params.get().len();
            expired.push(frame);
        }
        self.rearm_expiry();
        expired
    }
}

/// An open claim on one service's thread index, closed when dropped. Dropping the last open claim
/// reports the frames held past the timeout; it locks the index, so it is never dropped while
/// that lock is held.
#[must_use = "the claim closes as soon as it is dropped"]
pub(crate) struct ThreadClaim {
    threads: Arc<Mutex<CodexServiceThreads>>,
    report_unclaimed: UnclaimedThreadFrameReport,
}

impl Drop for ThreadClaim {
    fn drop(&mut self) {
        let expired = {
            let mut index = lock(&self.threads);
            index.claims_in_flight -= 1;
            if index.claims_in_flight > 0 {
                return;
            }
            // Takes the expired frames and arms the younger ones' deadline.
            index.take_expired(Instant::now())
        };
        // Called after the lock is let go, since the report may reach the index again.
        if !expired.is_empty() {
            (self.report_unclaimed)(expired);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use serde_json::value::RawValue;
    use tokio::time::{Instant, advance};

    use super::{CodexHeldThreadFrame, CodexServiceThreads};
    use crate::driver::test_registry::new_session_id;

    const TIMEOUT: Duration = Duration::from_secs(5);

    type Reports = Arc<Mutex<Vec<Vec<CodexHeldThreadFrame>>>>;

    fn frame(method: &str, thread_id: &str) -> CodexHeldThreadFrame {
        CodexHeldThreadFrame {
            method: method.to_owned(),
            params: RawValue::from_string(format!(r#"{{"threadId":"{thread_id}"}}"#))
                .expect("the params are JSON"),
            thread_id: thread_id.to_owned(),
        }
    }

    // An index holding at most `max_held_frames` and `max_held_bytes` for `TIMEOUT`, and what it
    // reported.
    fn index_within(
        max_held_frames: usize,
        max_held_bytes: usize,
    ) -> (Arc<Mutex<CodexServiceThreads>>, Reports) {
        let reports: Reports = Arc::default();
        let recorded = Arc::clone(&reports);
        let threads = Arc::new(Mutex::new(CodexServiceThreads::new(
            max_held_frames,
            max_held_bytes,
            TIMEOUT,
            Arc::new(move |frames| recorded.lock().unwrap().push(frames)),
        )));
        (threads, reports)
    }

    // An index holding at most `max_held_frames` of any size for `TIMEOUT`.
    fn index(max_held_frames: usize) -> (Arc<Mutex<CodexServiceThreads>>, Reports) {
        index_within(max_held_frames, usize::MAX)
    }

    // Killed by a hold still gated on a claim (the helper's frame is never handed back) and by a
    // hold that never expires (nothing is reported).
    #[tokio::test(start_paused = true)]
    async fn with_no_claim_open_an_unregistered_threads_frame_is_held_until_its_timeout() {
        let (threads, reports) = index(8);

        let held = threads
            .lock()
            .unwrap()
            .hold(frame("turn/started", "helper-a"), Instant::now());
        assert_eq!(held, vec![]);
        assert_eq!(
            threads
                .lock()
                .unwrap()
                .register("helper-a".to_owned(), new_session_id()),
            vec![frame("turn/started", "helper-a")]
        );

        // A lifecycle broadcast is not held while no claim is open.
        let closed = threads
            .lock()
            .unwrap()
            .hold(frame("thread/closed", "person-thread"), Instant::now());
        assert_eq!(closed, vec![]);
        let stale = threads
            .lock()
            .unwrap()
            .hold(frame("turn/started", "helper-b"), Instant::now());
        assert_eq!(stale, vec![]);

        CodexServiceThreads::report_expired(&threads, Instant::now());
        assert!(reports.lock().unwrap().is_empty());
        advance(TIMEOUT).await;
        CodexServiceThreads::report_expired(&threads, Instant::now());
        CodexServiceThreads::report_expired(&threads, Instant::now());
        assert_eq!(
            *reports.lock().unwrap(),
            vec![vec![frame("turn/started", "helper-b")]]
        );
        assert_eq!(
            threads
                .lock()
                .unwrap()
                .register("helper-b".to_owned(), new_session_id()),
            vec![]
        );
        assert_eq!(
            threads
                .lock()
                .unwrap()
                .register("person-thread".to_owned(), new_session_id()),
            vec![]
        );
    }

    // Killed by a claim close that drains every held frame (the young one is reported, not handed
    // back) and by an expiry that runs under an open claim.
    #[tokio::test(start_paused = true)]
    async fn under_an_open_claim_nothing_expires_and_the_last_close_keeps_the_young_frames() {
        let (threads, reports) = index(2);
        let first_claim = CodexServiceThreads::begin_claim(&threads);
        let last_claim = CodexServiceThreads::begin_claim(&threads);
        let hold = |method: &str| {
            threads
                .lock()
                .unwrap()
                .hold(frame(method, "thread-unknown"), Instant::now())
        };

        assert_eq!(hold("item/started"), vec![]);
        assert_eq!(hold("item/completed"), vec![]);
        assert_eq!(
            hold("turn/started"),
            vec![frame("item/started", "thread-unknown")]
        );

        advance(TIMEOUT).await;
        CodexServiceThreads::report_expired(&threads, Instant::now());
        drop(first_claim);
        assert!(reports.lock().unwrap().is_empty());

        assert_eq!(
            hold("turn/completed"),
            vec![frame("item/completed", "thread-unknown")]
        );
        drop(last_claim);
        assert_eq!(
            *reports.lock().unwrap(),
            vec![vec![frame("turn/started", "thread-unknown")]]
        );
        assert_eq!(
            threads
                .lock()
                .unwrap()
                .register("thread-unknown".to_owned(), new_session_id()),
            vec![frame("turn/completed", "thread-unknown")]
        );

        // A last claim that closes with nothing held reports nothing.
        drop(CodexServiceThreads::begin_claim(&threads));
        assert_eq!(reports.lock().unwrap().len(), 1);
    }

    // A frame whose params pass the byte bound pushes out as many of the oldest as it takes, and
    // one larger than the bound alone pushes out itself. Killed by a bound on the count alone
    // (nothing pushed out) and by the bytes of a frame let go left counted (the third frame pushes
    // out the second as well).
    #[tokio::test(start_paused = true)]
    async fn the_hold_keeps_its_frames_within_its_byte_bound() {
        let one_frame = frame("turn/started", "helper-a").params.get().len();
        let (threads, _reports) = index_within(8, 2 * one_frame);
        let hold = |method: &str, thread_id: &str| {
            threads
                .lock()
                .unwrap()
                .hold(frame(method, thread_id), Instant::now())
        };

        assert_eq!(hold("turn/started", "helper-a"), vec![]);
        assert_eq!(hold("turn/started", "helper-b"), vec![]);
        assert_eq!(
            hold("turn/started", "helper-c"),
            vec![frame("turn/started", "helper-a")]
        );
        assert_eq!(
            threads
                .lock()
                .unwrap()
                .register("helper-b".to_owned(), new_session_id()),
            vec![frame("turn/started", "helper-b")]
        );
        assert_eq!(hold("turn/started", "helper-d"), vec![]);

        let mut oversized = frame("turn/started", "helper-e");
        oversized.params = RawValue::from_string(format!(
            r#"{{"threadId":"helper-e","pad":"{}"}}"#,
            "x".repeat(2 * one_frame)
        ))
        .expect("the params are JSON");
        let pushed_out = threads
            .lock()
            .unwrap()
            .hold(oversized.clone(), Instant::now());
        assert_eq!(
            pushed_out,
            vec![
                frame("turn/started", "helper-c"),
                frame("turn/started", "helper-d"),
                oversized
            ]
        );
    }

    // The deadline the service's timer waits on is the oldest held frame's, moved as the oldest
    // changes and cleared while a claim is open or nothing is held. Killed by a hold that arms no
    // deadline, by a release or an expiry that leaves the old one, and by a deadline kept under a
    // claim.
    #[tokio::test(start_paused = true)]
    async fn the_expiry_deadline_follows_the_oldest_held_frame() {
        let (threads, _reports) = index(8);
        let expiry = threads.lock().unwrap().watch_expiry();
        let first_at = Instant::now();
        let hold = |thread_id: &str| {
            threads
                .lock()
                .unwrap()
                .hold(frame("turn/started", thread_id), Instant::now())
        };
        assert_eq!(*expiry.borrow(), None);

        assert_eq!(hold("helper-a"), vec![]);
        assert_eq!(*expiry.borrow(), Some(first_at + TIMEOUT));
        advance(Duration::from_secs(1)).await;
        assert_eq!(hold("helper-b"), vec![]);
        assert_eq!(*expiry.borrow(), Some(first_at + TIMEOUT), "the oldest's");

        drop(
            threads
                .lock()
                .unwrap()
                .register("helper-a".to_owned(), new_session_id()),
        );
        let second_due = first_at + Duration::from_secs(1) + TIMEOUT;
        assert_eq!(*expiry.borrow(), Some(second_due));

        let claim = CodexServiceThreads::begin_claim(&threads);
        assert_eq!(*expiry.borrow(), None, "nothing expires under a claim");
        drop(claim);
        assert_eq!(*expiry.borrow(), Some(second_due));

        advance(TIMEOUT + Duration::from_secs(1)).await;
        CodexServiceThreads::report_expired(&threads, Instant::now());
        assert_eq!(*expiry.borrow(), None, "nothing is held");
    }
}
