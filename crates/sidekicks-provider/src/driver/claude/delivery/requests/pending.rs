//! The requests each session holds pending: recorded before they are attributed, so a withdrawal
//! that comes first finds them, marked once handed on to their service, and closed by an answer or
//! a withdrawal, the last close telling every waiter on the session's open asks. Each one closed or
//! recorded over is let go, which a question's take reads as its asker leaving. A held plan's take
//! is marked while it runs, so a withdrawal meanwhile is reported once by the take itself.

use std::collections::HashMap;

use sidekicks_contracts::plan::PlanId;
use sidekicks_contracts::session::id::SessionId;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use super::{ClaudeHeldAsk, ClaudeHeldQuestion};

/// What a pending request holds the person's answer for.
#[derive(Clone, Debug)]
pub(super) enum HeldRequest {
    /// A tool ask.
    Ask(ClaudeHeldAsk),
    /// A question.
    Question(ClaudeHeldQuestion),
    /// A plan, held for its verdict under the id its record is written under.
    Plan {
        /// The plan's id.
        plan_id: PlanId,
    },
}

impl HeldRequest {
    /// The kind a failed hand-off is recorded under.
    pub(super) fn kind(&self) -> &'static str {
        match self {
            Self::Ask(_) => "permissionAsk",
            Self::Question(_) => "question",
            Self::Plan { .. } => "plan",
        }
    }
}

/// A request recorded before it is attributed; `admission` tells this recording from a later one
/// under the same id, and `is_handed_on` says its service has it, so a withdrawal is handed on too.
pub(super) struct PendingRequest {
    /// What it holds the answer for.
    pub(super) held: HeldRequest,
    /// Its recording's number, so a close finds this recording and not a later one under the id.
    pub(super) admission: u64,
    /// Whether its service has it: an ask or a question once admitted, a plan once its take
    /// recorded it.
    pub(super) is_handed_on: bool,
    /// Canceled once it is closed or recorded over, so a question's take still writing its record
    /// withdraws it once the record lands.
    let_go: CancellationToken,
}

// Where a held plan's take stands while it runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PlanTake {
    Running,
    // Claude Code withdrew the request meanwhile, which the take reports once it recorded the plan.
    Withdrawn,
}

// One session's pending requests, the waiters told when the last one closes, and the plan takes
// still running, by their recording's admission.
#[derive(Default)]
struct SessionRequests {
    pending: HashMap<String, PendingRequest>,
    on_closed: Vec<oneshot::Sender<()>>,
    plan_takes: HashMap<u64, PlanTake>,
}

/// Every session's pending requests.
#[derive(Default)]
pub(super) struct RequestTables {
    by_session: HashMap<SessionId, SessionRequests>,
    next_admission: u64,
}

impl RequestTables {
    /// Records `held` pending under `request_id`, replacing any earlier recording under that id,
    /// and answers this recording's admission.
    pub(super) fn record(
        &mut self,
        session_id: SessionId,
        request_id: &str,
        held: HeldRequest,
    ) -> u64 {
        self.next_admission += 1;
        let admission = self.next_admission;
        let recorded_over = self
            .by_session
            .entry(session_id)
            .or_default()
            .pending
            .insert(
                request_id.to_owned(),
                PendingRequest {
                    held,
                    admission,
                    is_handed_on: false,
                    let_go: CancellationToken::new(),
                },
            );
        // A request recorded again is a new request under the same id; a question's take, let go,
        // withdraws whichever question the card holds under that id, the new one perhaps.
        if let Some(recorded_over) = recorded_over {
            recorded_over.let_go.cancel();
        }
        admission
    }

    /// Marks the recording `admission` handed on and answers its letting go, which a question's
    /// take waits on; `None` when it was closed or recorded again. A plan is marked as its take
    /// starting instead, since its service has it only once the take recorded it.
    pub(super) fn mark_handed_on(
        &mut self,
        session_id: SessionId,
        request_id: &str,
        admission: u64,
    ) -> Option<CancellationToken> {
        let requests = self.by_session.get_mut(&session_id)?;
        let pending = requests
            .pending
            .get_mut(request_id)
            .filter(|pending| pending.admission == admission)?;
        match pending.held {
            HeldRequest::Ask(_) | HeldRequest::Question(_) => pending.is_handed_on = true,
            HeldRequest::Plan { .. } => {
                requests.plan_takes.insert(admission, PlanTake::Running);
            }
        }
        Some(pending.let_go.clone())
    }

    /// Ends the take of the plan recorded as `admission`: one `is_recorded` and still pending is
    /// marked handed on. Answers whether Claude Code withdrew it while the take ran, said once.
    pub(super) fn end_plan_take(
        &mut self,
        session_id: SessionId,
        request_id: &str,
        admission: u64,
        is_recorded: bool,
    ) -> bool {
        let Some(requests) = self.by_session.get_mut(&session_id) else {
            return false;
        };
        let take = requests.plan_takes.remove(&admission);
        if is_recorded
            && let Some(pending) = requests
                .pending
                .get_mut(request_id)
                .filter(|pending| pending.admission == admission)
        {
            pending.is_handed_on = true;
        }
        take == Some(PlanTake::Withdrawn)
    }

    /// The id of the request held for the plan `plan_id`.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the plan verdict answers the request it finds here"
        )
    )]
    pub(super) fn held_plan(&self, session_id: SessionId, plan_id: PlanId) -> Option<&str> {
        self.by_session
            .get(&session_id)?
            .pending
            .iter()
            .find(|(_, pending)| {
                matches!(pending.held, HeldRequest::Plan { plan_id: held } if held == plan_id)
            })
            .map(|(request_id, _)| request_id.as_str())
    }

    /// Whether the recording `admission` is still pending.
    pub(super) fn is_pending(
        &self,
        session_id: SessionId,
        request_id: &str,
        admission: u64,
    ) -> bool {
        self.held(session_id, request_id)
            .is_some_and(|pending| pending.admission == admission)
    }

    /// The pending request under `request_id`.
    pub(super) fn held(&self, session_id: SessionId, request_id: &str) -> Option<&PendingRequest> {
        self.by_session
            .get(&session_id)
            .and_then(|requests| requests.pending.get(request_id))
    }

    /// Takes a request out of the session's open asks and lets it go, telling every waiter once
    /// the last closes.
    pub(super) fn close(
        &mut self,
        session_id: SessionId,
        request_id: &str,
    ) -> Option<PendingRequest> {
        let requests = self.by_session.get_mut(&session_id)?;
        let closed = requests.pending.remove(request_id)?;
        closed.let_go.cancel();
        if requests.pending.is_empty() {
            for waiter in requests.on_closed.drain(..) {
                // A waiter that stopped waiting needs no word.
                waiter.send(()).unwrap_or(());
            }
        }
        Some(closed)
    }

    /// Closes a request Claude Code withdrew, as [`Self::close`] does; a plan whose take still runs
    /// is marked withdrawn, so its take reports it.
    pub(super) fn withdraw(
        &mut self,
        session_id: SessionId,
        request_id: &str,
    ) -> Option<PendingRequest> {
        let withdrawn = self.close(session_id, request_id)?;
        if let HeldRequest::Plan { .. } = withdrawn.held
            && let Some(take) = self
                .by_session
                .get_mut(&session_id)
                .and_then(|requests| requests.plan_takes.get_mut(&withdrawn.admission))
        {
            *take = PlanTake::Withdrawn;
        }
        Some(withdrawn)
    }

    /// How many of the session's requests are open.
    pub(super) fn open_count(&self, session_id: SessionId) -> usize {
        self.by_session
            .get(&session_id)
            .map_or(0, |requests| requests.pending.len())
    }

    /// A receiver told once the session's last open ask closes; `None` when none is open.
    pub(super) fn wait_closed(&mut self, session_id: SessionId) -> Option<oneshot::Receiver<()>> {
        let requests = self.by_session.get_mut(&session_id)?;
        if requests.pending.is_empty() {
            return None;
        }
        let (sender, receiver) = oneshot::channel();
        requests.on_closed.push(sender);
        Some(receiver)
    }

    /// Takes every request the session holds and lets each go, letting its waiters go unanswered;
    /// a plan take still running then reports nothing.
    pub(super) fn take_session(
        &mut self,
        session_id: SessionId,
    ) -> HashMap<String, PendingRequest> {
        let pending = self
            .by_session
            .remove(&session_id)
            .map(|requests| requests.pending)
            .unwrap_or_default();
        for request in pending.values() {
            request.let_go.cancel();
        }
        pending
    }
}
