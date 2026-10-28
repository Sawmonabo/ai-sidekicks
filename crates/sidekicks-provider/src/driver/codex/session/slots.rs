//! The Codex sessions' slots: which session holds a live record, by the queue its task drains, and
//! the one transition in flight on each, an establishment or a close, taken as a per-session claim
//! that the next waits behind. A session whose service came back is owed its resume, by each
//! recovery of it, from then until that recovery claims its slot, and reads as being established
//! meanwhile. The record itself stays on its session's task; a close lets it go there, routes and
//! waits first, so nothing reaches it after.

use std::collections::{HashMap, HashSet};
use std::pin::pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::keyed_lock::{KeyHold, KeyedLock};
use sidekicks_std::mutex_lock::lock;
use tokio::sync::Notify;

use crate::compaction_wait::PendingCompactionRegistry;
use crate::driver::codex::app_server_protocol::ThreadUnsubscribeParams;
use crate::driver::codex::commands::CodexProviderCommandCache;
use crate::driver::codex::delivery::frames::turns::codex_compaction_wait_key;
use crate::driver::codex::run::routes::CodexRunRoutes;
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::session::background_terminals::end_codex_running_commands;
use crate::driver::codex::session::conversation_release::CodexConversationRelease;
use crate::driver::codex::session::errors::{CodexError, CodexSessionSlotState};
use crate::driver::codex::session::inbound::CodexSessionInboundSender;
use crate::driver::codex::session::state::CodexSessionRecord;
use crate::driver::codex::transport::diagnostics::{CodexTeardownStep, CodexTransportDiagnostic};

/// The request that lets a conversation go from a connection.
pub(crate) const THREAD_UNSUBSCRIBE_METHOD: &str = "thread/unsubscribe";

/// How long a close's interrupts and its `thread/unsubscribe` each wait; short, so a wedged service
/// cannot hold a close.
pub(crate) const CODEX_LET_GO_TIMEOUT: Duration = Duration::from_secs(5);

/// One recovery of a Codex service, minted at each time it came back, which keys the resumes it
/// owes its sessions: a later recovery's marks outlive an earlier one's end.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) struct CodexRecoveryGeneration(pub(crate) u64);

/// One session's slot: its live record's queue, the claims published on it, oldest first, how
/// many closes it has seen, and the recoveries of its service that owe it a resume not yet claimed.
#[derive(Default)]
struct SessionSlot {
    live: Option<CodexSessionInboundSender>,
    claims: Vec<(u64, CodexSessionSlotState)>,
    closes: u64,
    owed_resumes: HashSet<CodexRecoveryGeneration>,
}

impl SessionSlot {
    // The state holding the slot: the newest claim in flight's, else `Establishing` while its
    // resume is owed, else `Live` for a live record.
    fn holder(&self) -> Option<CodexSessionSlotState> {
        self.claims
            .last()
            .map(|claim| claim.1)
            .or_else(|| {
                (!self.owed_resumes.is_empty()).then_some(CodexSessionSlotState::Establishing)
            })
            .or_else(|| self.live.as_ref().map(|_| CodexSessionSlotState::Live))
    }
}

/// Every Codex session's slot.
pub(crate) struct CodexSessionSlots {
    /// One transition at a time per session, in the order they were claimed.
    transitions: KeyedLock<SessionId>,
    /// Never held across an await.
    slots: Mutex<HashMap<SessionId, SessionSlot>>,
    next_claim_id: AtomicU64,
    /// Set once the daemon's stop began, after which no establishment is claimed.
    is_establishing_refused: AtomicBool,
    /// Wakes the waits for an owed resume once one is claimed or its slot goes.
    resumes_settled: Notify,
}

/// One transition's hold on its session's slot, ended when dropped.
pub(crate) struct CodexSessionClaim<'slots> {
    slots: &'slots CodexSessionSlots,
    session_id: SessionId,
    claim_id: u64,
    _turn: KeyHold<'slots, SessionId>,
}

/// What a session's let-go releases besides its conversation.
pub(crate) struct CodexSessionLetGo<'deps> {
    /// The driver's run routes.
    pub(crate) run_routes: &'deps CodexRunRoutes,
    /// The conversations the session moved off, held while their commands run.
    pub(crate) release: &'deps CodexConversationRelease,
    /// The compaction waits, whose wait on the conversation ends as its binding lost.
    pub(crate) pending_compactions: &'deps PendingCompactionRegistry,
    /// The provider command lists.
    pub(crate) provider_commands: &'deps CodexProviderCommandCache,
}

impl CodexSessionSlots {
    /// Slots with no session in them.
    pub(crate) fn new() -> Self {
        Self {
            transitions: KeyedLock::new(),
            slots: Mutex::new(HashMap::new()),
            next_claim_id: AtomicU64::new(1),
            is_establishing_refused: AtomicBool::new(false),
            resumes_settled: Notify::new(),
        }
    }

    /// Every session that holds a live record or a claim now.
    pub(crate) fn held_sessions(&self) -> Vec<SessionId> {
        self.lock().keys().copied().collect()
    }

    /// Refuses every establishment from now on, as the daemon's stop begins, so no record is
    /// installed after the stop let the records go; one that already took its turn goes on.
    pub(crate) fn refuse_establishing(&self) {
        self.is_establishing_refused.store(true, Ordering::Release);
    }

    /// Fails with `CodexError::SessionAlreadyLive`, naming the state the slot is held in, when a
    /// live record or a transition holds `session_id`'s slot; a create checks it before it claims.
    pub(crate) fn check_free(&self, session_id: SessionId) -> Result<(), CodexError> {
        match self.describe_holder(session_id) {
            Some(holder_state) => Err(CodexError::SessionAlreadyLive {
                session_id,
                holder_state,
            }),
            None => Ok(()),
        }
    }

    /// The queue of `session_id`'s live record, while no transition is in flight or owed on it.
    /// Fails with `CodexError::Transport` while it is being established again or torn down, or has
    /// none.
    pub(crate) fn require_live(
        &self,
        session_id: SessionId,
    ) -> Result<CodexSessionInboundSender, CodexError> {
        let slots = self.lock();
        let slot = slots.get(&session_id);
        let detail = match slot.and_then(SessionSlot::holder) {
            Some(CodexSessionSlotState::Closing) => {
                return Err(closing_session_refusal(session_id));
            }
            Some(CodexSessionSlotState::Establishing) => format!(
                "Codex session \"{session_id}\" is being re-established; the conversation it \
                 runs on is about to change."
            ),
            Some(CodexSessionSlotState::Live) | None => {
                match slot.and_then(|slot| slot.live.clone()) {
                    Some(live) => return Ok(live),
                    None => return Err(no_live_session_refusal(session_id)),
                }
            }
        };
        Err(CodexError::Transport {
            detail,
            cause: None,
        })
    }

    /// Waits until `session_id` is owed no resume and no establishment is in flight on it, as one
    /// that brings its conversation back after its service returned or onto a fork.
    pub(crate) async fn settle(&self, session_id: SessionId) {
        loop {
            let mut resumed = pin!(self.resumes_settled.notified());
            // Armed before the read, so a resume claimed between the two is never missed.
            resumed.as_mut().enable();
            let (is_owed, holder) = {
                let slots = self.lock();
                slots.get(&session_id).map_or((false, None), |slot| {
                    (!slot.owed_resumes.is_empty(), slot.holder())
                })
            };
            if is_owed {
                resumed.await;
            } else if holder == Some(CodexSessionSlotState::Establishing) {
                // Taken once every transition claimed before it ended, and let go at once.
                drop(self.transitions.acquire(session_id).await);
            } else {
                return;
            }
        }
    }

    /// The queue of `session_id`'s live record once it settled, with its transition turn held, so
    /// no establishment or close begins until the caller's act on the record ends and drops it.
    /// Fails with `CodexError::Transport` when the session holds no live record.
    pub(crate) async fn require_live_settled(
        &self,
        session_id: SessionId,
    ) -> Result<(CodexSessionInboundSender, KeyHold<'_, SessionId>), CodexError> {
        loop {
            self.settle(session_id).await;
            let turn = self.transitions.acquire(session_id).await;
            // An establishment claimed or owed while this waited goes first; a claim made after
            // the turn was taken waits behind it, so only the live record is read.
            let (holder, live) = {
                let slots = self.lock();
                slots
                    .get(&session_id)
                    .map_or((None, None), |slot| (slot.holder(), slot.live.clone()))
            };
            if holder == Some(CodexSessionSlotState::Establishing) {
                continue;
            }
            return match live {
                Some(live) => Ok((live, turn)),
                None => Err(no_live_session_refusal(session_id)),
            };
        }
    }

    /// Marks `session_id`'s live record owed its resume by `generation`, as its service came
    /// back: it reads as being established until every recovery owing it settled.
    pub(crate) fn owe_resume(&self, session_id: SessionId, generation: CodexRecoveryGeneration) {
        if let Some(slot) = self.lock().get_mut(&session_id)
            && slot.live.is_some()
        {
            slot.owed_resumes.insert(generation);
        }
    }

    /// Ends the resume `generation` owed `session_id`, once that recovery claimed its slot or let
    /// it be, and wakes whoever waits for it.
    pub(crate) fn settle_resume(&self, session_id: SessionId, generation: CodexRecoveryGeneration) {
        if let Some(slot) = self.lock().get_mut(&session_id) {
            slot.owed_resumes.remove(&generation);
        }
        self.resumes_settled.notify_waiters();
    }

    /// Claims `session_id`'s slot for an establishment, a create, a resume or a fork, once every
    /// transition claimed before it ended. Fails with `CodexError::SessionClosed` when a close of
    /// the session ended while it waited, and once the daemon's stop began.
    pub(crate) async fn claim_establishing(
        &self,
        session_id: SessionId,
    ) -> Result<CodexSessionClaim<'_>, CodexError> {
        let (claim_id, closes_seen) = self.publish(session_id, CodexSessionSlotState::Establishing);
        let claim = self.take_turn(session_id, claim_id).await;
        let has_closed = self.is_establishing_refused.load(Ordering::Acquire)
            || self
                .lock()
                .get(&session_id)
                .is_some_and(|slot| slot.closes > closes_seen);
        if has_closed {
            return Err(CodexError::SessionClosed { session_id });
        }
        Ok(claim)
    }

    /// Claims `session_id`'s slot for its close, once every transition claimed before it ended.
    pub(crate) async fn claim_closing(&self, session_id: SessionId) -> CodexSessionClaim<'_> {
        let (claim_id, _) = self.publish(session_id, CodexSessionSlotState::Closing);
        self.take_turn(session_id, claim_id).await
    }

    // Publishes the claim before any await, so two claims made together both see each other.
    fn publish(&self, session_id: SessionId, state: CodexSessionSlotState) -> (u64, u64) {
        let claim_id = self.next_claim_id.fetch_add(1, Ordering::Relaxed);
        let mut slots = self.lock();
        let slot = slots.entry(session_id).or_default();
        slot.claims.push((claim_id, state));
        (claim_id, slot.closes)
    }

    async fn take_turn(&self, session_id: SessionId, claim_id: u64) -> CodexSessionClaim<'_> {
        // Built before the wait, so a claim dropped while it waits still leaves the slot.
        let mut claim = PendingClaim {
            slots: self,
            session_id,
            claim_id,
            is_taken: false,
        };
        let turn = self.transitions.acquire(session_id).await;
        claim.is_taken = true;
        CodexSessionClaim {
            slots: self,
            session_id,
            claim_id,
            _turn: turn,
        }
    }

    /// The state holding `session_id`'s slot: the newest claim in flight's, else `Establishing`
    /// while its resume is owed, else `Live` for a live record; `None` for a free slot.
    pub(crate) fn describe_holder(&self, session_id: SessionId) -> Option<CodexSessionSlotState> {
        self.lock().get(&session_id).and_then(SessionSlot::holder)
    }

    fn leave(&self, session_id: SessionId, claim_id: u64) {
        let mut slots = self.lock();
        let Some(slot) = slots.get_mut(&session_id) else {
            return;
        };
        slot.claims.retain(|claim| claim.0 != claim_id);
        if slot.claims.is_empty() && slot.live.is_none() {
            let is_resume_owed = !slot.owed_resumes.is_empty();
            slots.remove(&session_id);
            drop(slots);
            if is_resume_owed {
                self.resumes_settled.notify_waiters();
            }
        }
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<SessionId, SessionSlot>> {
        lock(&self.slots)
    }
}

// A claim waiting for its turn, which leaves the slot when it is dropped before it got it.
struct PendingClaim<'slots> {
    slots: &'slots CodexSessionSlots,
    session_id: SessionId,
    claim_id: u64,
    is_taken: bool,
}

impl Drop for PendingClaim<'_> {
    fn drop(&mut self) {
        if !self.is_taken {
            self.slots.leave(self.session_id, self.claim_id);
        }
    }
}

impl CodexSessionClaim<'_> {
    /// Installs `live` as the session's record queue, replacing the one before.
    pub(crate) fn install(&self, live: CodexSessionInboundSender) {
        self.slots.lock().entry(self.session_id).or_default().live = Some(live);
    }

    /// The queue of the session's live record, while it has one; a transition holding the slot
    /// reaches the record through it.
    pub(crate) fn live(&self) -> Option<CodexSessionInboundSender> {
        self.slots
            .lock()
            .get(&self.session_id)
            .and_then(|slot| slot.live.clone())
    }

    /// Records the session closed: its record leaves the slot, and an establishment that waited
    /// behind this close is refused.
    pub(crate) fn close(&self) {
        let mut slots = self.slots.lock();
        let slot = slots.entry(self.session_id).or_default();
        slot.live = None;
        slot.closes += 1;
    }

    /// Takes the session's record queue out of the slot once its record was let go with the
    /// session going on, so no call reaches a task that holds no record.
    pub(crate) fn vacate(&self) {
        if let Some(slot) = self.slots.lock().get_mut(&self.session_id) {
            slot.live = None;
        }
    }
}

impl Drop for CodexSessionClaim<'_> {
    fn drop(&mut self) {
        self.slots.leave(self.session_id, self.claim_id);
    }
}

// The refusal of a call on a session that holds no live record.
fn no_live_session_refusal(session_id: SessionId) -> CodexError {
    CodexError::Transport {
        detail: format!("No live Codex session for \"{session_id}\"."),
        cause: None,
    }
}

/// The refusal of run control on `session_id` once its close began: a `CodexError::Transport`
/// saying the session is being torn down.
pub(crate) fn closing_session_refusal(session_id: SessionId) -> CodexError {
    CodexError::Transport {
        detail: format!("Codex session \"{session_id}\" is being torn down."),
        cause: None,
    }
}

/// Lets go of `record`'s conversation on its session's task: its routes and waits first,
/// so nothing reaches it after; then, on a running service, its commands end and it is forgotten
/// and unsubscribed, a failed unsubscribe reported; then its threads, compaction wait and command
/// list are released.
pub(crate) async fn let_go_codex_session(
    record: &CodexSessionRecord,
    deps: &CodexSessionLetGo<'_>,
) {
    let session_id = record.session_id;
    deps.run_routes.forget_run_routes(session_id);
    if let Ok(connection) = record.service.connection() {
        end_codex_running_commands(&connection, &record.thread_id, true).await;
    }
    let_go_codex_thread(&record.service, &record.thread_id).await;
    // A conversation the session moved off stays routed until the command it runs ends.
    deps.release
        .release_session_threads(&record.service, &session_id, |_| true);
    deps.pending_compactions
        .release_binding(&codex_compaction_wait_key(record, &record.thread_id));
    deps.provider_commands.discard_listing(session_id);
}

/// Forgets `thread_id` on `service` and unsubscribes from it while the service runs, within a
/// short bound so a wedged service cannot hold the caller; a refused unsubscribe is reported,
/// since the conversation unloads with the service anyway.
pub(crate) async fn let_go_codex_thread(service: &CodexService, thread_id: &str) {
    service.release_thread(thread_id);
    let Ok(connection) = service.connection() else {
        return;
    };
    let unsubscribed = connection
        .request_within(
            THREAD_UNSUBSCRIBE_METHOD,
            &ThreadUnsubscribeParams {
                thread_id: thread_id.to_owned(),
            },
            CODEX_LET_GO_TIMEOUT,
        )
        .await;
    if let Err(error) = unsubscribed {
        CodexTransportDiagnostic::TeardownStepFailed {
            step: CodexTeardownStep::ThreadUnsubscribe,
            error: Box::new(error),
        }
        .report();
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::{CodexRecoveryGeneration, CodexSessionSlots};
    use crate::driver::codex::session::errors::{CodexError, CodexSessionSlotState};
    use crate::driver::codex::session::inbound::codex_session_inbound;
    use crate::driver::test_registry::new_session_id;

    // Killed by an owed resume that reads live or lets a move through before recovery claimed the
    // slot, and by a move that lets the transition turn go before its act, so an establishment
    // claimed meanwhile runs under it.
    #[tokio::test(start_paused = true)]
    async fn a_move_settled_past_an_owed_resume_holds_off_the_next_establishment() {
        let session_id = new_session_id();
        let slots = Arc::new(CodexSessionSlots::new());
        let (sender, _receiver) = codex_session_inbound(session_id);
        slots
            .claim_establishing(session_id)
            .await
            .expect("a free slot is claimed")
            .install(sender);
        slots.owe_resume(session_id, CodexRecoveryGeneration(1));
        assert_eq!(
            slots.describe_holder(session_id),
            Some(CodexSessionSlotState::Establishing)
        );

        let (moved_sender, mut moved) = tokio::sync::oneshot::channel();
        let (done_sender, done) = tokio::sync::oneshot::channel::<()>();
        let moving = tokio::spawn({
            let slots = Arc::clone(&slots);
            async move {
                let (_live, _turn) = slots
                    .require_live_settled(session_id)
                    .await
                    .expect("the session is live");
                moved_sender.send(()).expect("the test waits for the move");
                done.await.expect("the test ends the move");
            }
        });
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        assert!(
            moved.try_recv().is_err(),
            "the move waits for the owed resume"
        );

        slots.settle_resume(session_id, CodexRecoveryGeneration(1));
        moved
            .await
            .expect("the move goes once the resume is no longer owed");
        let establishing = tokio::spawn({
            let slots = Arc::clone(&slots);
            async move { slots.claim_establishing(session_id).await.map(|_claim| ()) }
        });
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        assert!(
            !establishing.is_finished(),
            "the establishment waits for the move's act"
        );
        done_sender.send(()).expect("the move waits");
        moving.await.expect("the move's task ends");
        assert!(
            establishing
                .await
                .expect("the establishment's task ends")
                .is_ok()
        );
    }

    // Killed by removing the free check a create makes, and by removing the check an
    // establishment makes once it got the slot after a close.
    #[tokio::test(start_paused = true)]
    async fn a_live_slot_refuses_a_second_create_and_a_resume_behind_a_close_answers_closed() {
        let session_id = new_session_id();
        let slots = Arc::new(CodexSessionSlots::new());
        let (sender, _receiver) = codex_session_inbound(session_id);
        let created = slots
            .claim_establishing(session_id)
            .await
            .expect("a free slot is claimed");
        created.install(sender);
        drop(created);

        assert!(matches!(
            slots.check_free(session_id),
            Err(CodexError::SessionAlreadyLive {
                holder_state: CodexSessionSlotState::Live,
                ..
            })
        ));

        let closing = slots.claim_closing(session_id).await;
        let resume = tokio::spawn({
            let slots = Arc::clone(&slots);
            async move { slots.claim_establishing(session_id).await.map(|_claim| ()) }
        });
        tokio::task::yield_now().await;
        assert!(!resume.is_finished(), "the resume waits behind the close");
        closing.close();
        drop(closing);

        assert!(matches!(
            resume.await.expect("the resume's task ends"),
            Err(CodexError::SessionClosed { .. })
        ));
        assert!(slots.check_free(session_id).is_ok());
    }
}
