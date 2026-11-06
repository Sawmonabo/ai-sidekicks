//! The stand-in for the queue's waiting messages the pause tests continue runs over.

use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_provider::driver::message_handing::MessageHanding;
use sidekicks_provider::driver::run_control::WaitingMessage;
use sidekicks_provider::port::run_pause::{
    ContinuedMessages, ContinuedMessagesError, ContinuedRead, SessionOpening,
};
use sidekicks_std::keyed_lock::{KeyHold, KeyedLock};

/// The waiting messages as the queue keeps them: read until taken, given back or kept, a kept one
/// read by no later resume, and nothing read while an undo holds the session.
pub(super) struct WaitingMessages {
    pub(super) waiting: Mutex<Vec<WaitingMessage>>,
    pub(super) kept: Mutex<Vec<WaitingMessage>>,
    pub(super) releases: AtomicUsize,
    pub(super) admissions: AtomicUsize,
    pub(super) openings: AtomicUsize,
    // Where each opening of the session leaves it.
    pub(super) opening: SessionOpening,
    // Whether an undo holds the session, so a read answers held.
    pub(super) is_held_for_undo: bool,
    // The helpers whose held lead's continue was handed over.
    pub(super) held_lead_continues: Mutex<Vec<RunId>>,
    // The kept messages a settle delivered with the run, those it gave back, and those it ended
    // not delivered.
    pub(super) settled_taken: Mutex<Vec<QueueItemId>>,
    pub(super) settled_given_back: Mutex<Vec<QueueItemId>>,
    pub(super) failed: Mutex<Vec<QueueItemId>>,
    pub(super) session_lock: KeyedLock<SessionId>,
}

impl Default for WaitingMessages {
    fn default() -> Self {
        Self {
            waiting: Mutex::default(),
            kept: Mutex::default(),
            releases: AtomicUsize::default(),
            admissions: AtomicUsize::default(),
            openings: AtomicUsize::default(),
            opening: SessionOpening::Opened,
            is_held_for_undo: false,
            held_lead_continues: Mutex::default(),
            settled_taken: Mutex::default(),
            settled_given_back: Mutex::default(),
            failed: Mutex::default(),
            session_lock: KeyedLock::new(),
        }
    }
}

impl WaitingMessages {
    pub(super) fn holding(message: WaitingMessage) -> Self {
        Self {
            waiting: Mutex::new(vec![message]),
            ..Self::default()
        }
    }

    pub(super) fn kept_messages(&self) -> Vec<WaitingMessage> {
        self.kept.lock().expect("the kept messages read").clone()
    }
}

impl ContinuedMessages for WaitingMessages {
    fn open_session(
        &self,
        _session_id: SessionId,
    ) -> BoxFuture<'_, Result<SessionOpening, ContinuedMessagesError>> {
        self.openings.fetch_add(1, Ordering::SeqCst);
        let opening = self.opening;
        async move { Ok(opening) }.boxed()
    }

    fn continue_held_lead(&self, _session_id: SessionId, helper_run_id: RunId) {
        self.held_lead_continues
            .lock()
            .expect("the continues read")
            .push(helper_run_id);
    }

    fn hold_session(&self, session_id: SessionId) -> BoxFuture<'_, KeyHold<'_, SessionId>> {
        self.session_lock.acquire(session_id).boxed()
    }

    fn read(
        &self,
        _hold: &KeyHold<'_, SessionId>,
        _run_id: RunId,
        _handing: MessageHanding,
    ) -> BoxFuture<'_, Result<ContinuedRead, ContinuedMessagesError>> {
        let read = if self.is_held_for_undo {
            ContinuedRead::HeldForUndo
        } else {
            ContinuedRead::Messages(self.waiting.lock().expect("the messages read").clone())
        };
        async move { Ok(read) }.boxed()
    }

    fn admit(
        &self,
        _hold: &KeyHold<'_, SessionId>,
        _run_id: RunId,
    ) -> BoxFuture<'_, Result<(), ContinuedMessagesError>> {
        self.waiting.lock().expect("the messages read").clear();
        self.admissions.fetch_add(1, Ordering::SeqCst);
        async { Ok(()) }.boxed()
    }

    fn release(
        &self,
        _hold: &KeyHold<'_, SessionId>,
        _run_id: RunId,
    ) -> BoxFuture<'_, Result<(), ContinuedMessagesError>> {
        self.releases.fetch_add(1, Ordering::SeqCst);
        async { Ok(()) }.boxed()
    }

    fn keep(&self, _hold: &KeyHold<'_, SessionId>, _run_id: RunId) {
        let mut waiting = self.waiting.lock().expect("the messages read");
        self.kept
            .lock()
            .expect("the kept messages read")
            .append(&mut waiting);
    }

    fn kept(&self, _hold: &KeyHold<'_, SessionId>, _run_id: RunId) -> Vec<QueueItemId> {
        self.kept_messages()
            .iter()
            .map(|message| message.id)
            .collect()
    }

    // The test's provider process keeps nothing past a run's end.
    fn kept_unheld(&self, hold: &KeyHold<'_, SessionId>, run_id: RunId) -> Vec<QueueItemId> {
        self.kept(hold, run_id)
    }

    fn settle_kept(
        &self,
        _hold: &KeyHold<'_, SessionId>,
        _run_id: RunId,
        settled: &[QueueItemId],
        taken: &[QueueItemId],
    ) -> BoxFuture<'_, Result<(), ContinuedMessagesError>> {
        let mut kept = self.kept.lock().expect("the kept messages read");
        let (settling, left): (Vec<_>, Vec<_>) = kept
            .drain(..)
            .partition(|message| settled.contains(&message.id));
        *kept = left;
        drop(kept);
        for message in settling {
            if taken.contains(&message.id) {
                self.settled_taken
                    .lock()
                    .expect("the settled messages read")
                    .push(message.id);
            } else {
                self.settled_given_back
                    .lock()
                    .expect("the settled messages read")
                    .push(message.id);
                self.waiting
                    .lock()
                    .expect("the messages read")
                    .push(message);
            }
        }
        async { Ok(()) }.boxed()
    }

    fn fail_kept(
        &self,
        _hold: &KeyHold<'_, SessionId>,
        _run_id: RunId,
        message_ids: &[QueueItemId],
    ) -> BoxFuture<'_, Result<(), ContinuedMessagesError>> {
        self.kept
            .lock()
            .expect("the kept messages read")
            .retain(|message| !message_ids.contains(&message.id));
        self.failed
            .lock()
            .expect("the failed messages read")
            .extend_from_slice(message_ids);
        async { Ok(()) }.boxed()
    }
}
