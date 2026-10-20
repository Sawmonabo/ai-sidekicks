//! The control requests a Claude Code process has not answered yet, keyed by the id each is written
//! under. Ids count up per process, so an answer for an id already retired is told apart from one
//! the process never got. A request waits at most its deadline, then is withdrawn; every one fails
//! at once when the process exits, and a later one is refused before it is written, so nothing
//! waits on a process that will never answer. The table's lock is never held across a wait.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use tokio::sync::oneshot;

use crate::provider::driver::claude::session::errors::{
    ClaudeSessionError, ClaudeSessionUnavailableReason, ClaudeUnansweredCause,
};
use crate::provider::driver::claude::session::transport::control::ClaudeControlSubtype;
use crate::provider::driver::claude::session::transport::inbound::{
    ClaudeControlAnswer, ClaudeControlOutcome,
};
use crate::provider::driver::claude::session::transport::user_message::{
    ClaudeWriteAttempt, ClaudeWriteDelivery,
};

/// Queues `control_cancel_request {request_id}` on the process's input without waiting, so a
/// request withdrawn on a deadline or from a dropped caller never blocks.
pub(crate) type ClaudeRequestWithdrawal = Arc<dyn Fn(&str) + Send + Sync>;

/// What became of an answer the process sent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ClaudeControlSettlement {
    /// It settled a pending request.
    Settled,
    /// Its id was issued and is no longer pending: the request was withdrawn or its process's
    /// table closed before the answer came. Logged, never a fault.
    Late,
    /// Its id was never issued by this process, or is no id at all: the process is broken.
    NeverIssued,
}

/// The pending control requests of one process.
#[derive(Clone)]
pub(crate) struct ClaudeControlRequests {
    table: Arc<Mutex<RequestTable>>,
    withdraw: ClaudeRequestWithdrawal,
}

struct RequestTable {
    pending: HashMap<u64, oneshot::Sender<ClaudeControlOutcome>>,
    next_id: u64,
    // Why the table closed: the process exited, with the exit's words.
    exit_detail: Option<String>,
}

impl ClaudeControlRequests {
    /// An empty table for one process, withdrawing a request through `withdraw`.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the Claude Code process opens its control table with its input writer"
        )
    )]
    pub(crate) fn new(withdraw: ClaudeRequestWithdrawal) -> Self {
        Self {
            table: Arc::new(Mutex::new(RequestTable {
                pending: HashMap::new(),
                next_id: 0,
                exit_detail: None,
            })),
            withdraw,
        }
    }

    /// Opens a request under a fresh id, before it is written, so an answer arriving at once finds
    /// it. Fails with `Unavailable` once the process exited, since nothing would answer.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the Claude Code process opens each control request with it"
        )
    )]
    pub(crate) fn open(
        &self,
        subtype: ClaudeControlSubtype,
    ) -> Result<PendingControlRequest, ClaudeSessionError> {
        let mut table = lock(&self.table);
        if let Some(detail) = &table.exit_detail {
            return Err(process_exited(detail.clone()));
        }
        let id = table.next_id;
        table.next_id += 1;
        let (sender, receiver) = oneshot::channel();
        table.pending.insert(id, sender);
        Ok(PendingControlRequest {
            id,
            subtype,
            receiver,
            requests: self.clone(),
        })
    }

    /// Settles the request an answer names by its `request_id`, as sent.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the Claude Code process reader settles each control answer with it"
        )
    )]
    pub(crate) fn settle(
        &self,
        request_id: &str,
        outcome: ClaudeControlOutcome,
    ) -> ClaudeControlSettlement {
        // Matched as text, so an id written back in another spelling is never mistaken for ours.
        let Some(id) = request_id
            .parse::<u64>()
            .ok()
            .filter(|id| id.to_string() == request_id)
        else {
            return ClaudeControlSettlement::NeverIssued;
        };
        let mut table = lock(&self.table);
        match table.pending.remove(&id) {
            Some(sender) => {
                drop(table);
                match sender.send(outcome) {
                    Ok(()) => ClaudeControlSettlement::Settled,
                    // The caller stopped waiting between the answer's arrival and its delivery.
                    Err(_unread) => late(id),
                }
            }
            None if id < table.next_id => late(id),
            None => ClaudeControlSettlement::NeverIssued,
        }
    }

    /// Fails every pending request at once, and refuses every later one, because the process
    /// exited with `detail`.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the Claude Code process closes its table when it exits"
        )
    )]
    pub(crate) fn close_on_exit(&self, detail: String) {
        let mut table = lock(&self.table);
        table.exit_detail = Some(detail);
        // Dropping each sender wakes its waiter with no answer.
        table.pending.clear();
    }

    // Takes the slot back, answering whether it was still pending.
    fn retire(&self, id: u64) -> bool {
        lock(&self.table).pending.remove(&id).is_some()
    }
}

/// One opened request: the id it is written under, and its wait for the answer. Dropped while its
/// answer is still pending, it takes its slot back and withdraws the request.
pub(crate) struct PendingControlRequest {
    id: u64,
    subtype: ClaudeControlSubtype,
    receiver: oneshot::Receiver<ClaudeControlOutcome>,
    requests: ClaudeControlRequests,
}

impl PendingControlRequest {
    /// The id the request is written under.
    pub(crate) fn request_id(&self) -> String {
        self.id.to_string()
    }

    /// Settles the request once its write settled as `written`, waiting at most `deadline` for its
    /// answer. Fails with `InputUnwritable` when no byte was written; with `Unanswered` when some
    /// were and no answer came: the write was cut short, the deadline passed (the request is then
    /// withdrawn) or the process exited; and with `ControlRequestRefused` when Claude Code refused.
    pub(crate) async fn answer_within(
        mut self,
        written: ClaudeWriteAttempt,
        deadline: Duration,
    ) -> Result<ClaudeControlAnswer, ClaudeSessionError> {
        match written {
            ClaudeWriteAttempt::Written => {}
            ClaudeWriteAttempt::Failed {
                delivery: ClaudeWriteDelivery::Unsent,
                cause,
            } => {
                self.requests.retire(self.id);
                return Err(ClaudeSessionError::InputUnwritable(cause));
            }
            ClaudeWriteAttempt::Failed {
                delivery: ClaudeWriteDelivery::Indeterminate,
                cause: _,
            } => {
                self.requests.retire(self.id);
                return Err(self.unanswered(ClaudeUnansweredCause::WriteCut));
            }
        }
        match tokio::time::timeout(deadline, &mut self.receiver).await {
            Ok(Ok(ClaudeControlOutcome::Success(answer))) => Ok(answer),
            Ok(Ok(ClaudeControlOutcome::Refused { error })) => {
                Err(ClaudeSessionError::ControlRequestRefused {
                    subtype: self.subtype,
                    provider_error: error,
                })
            }
            Ok(Err(_closed)) => Err(self.unanswered(ClaudeUnansweredCause::ProcessExited)),
            Err(_elapsed) => {
                if self.requests.retire(self.id) {
                    (self.requests.withdraw)(&self.request_id());
                }
                Err(self.unanswered(ClaudeUnansweredCause::Deadline))
            }
        }
    }

    fn unanswered(&self, cause: ClaudeUnansweredCause) -> ClaudeSessionError {
        ClaudeSessionError::Unanswered {
            subtype: self.subtype,
            cause,
        }
    }
}

impl Drop for PendingControlRequest {
    fn drop(&mut self) {
        if self.requests.retire(self.id) {
            (self.requests.withdraw)(&self.request_id());
        }
    }
}

fn lock(table: &Mutex<RequestTable>) -> MutexGuard<'_, RequestTable> {
    table
        .lock()
        .expect("the control table's lock is never held across a panic")
}

fn late(id: u64) -> ClaudeControlSettlement {
    tracing::debug!(
        request_id = id,
        "a control answer arrived after its request retired"
    );
    ClaudeControlSettlement::Late
}

fn process_exited(detail: String) -> ClaudeSessionError {
    ClaudeSessionError::Unavailable {
        reason: ClaudeSessionUnavailableReason::ProcessExited,
        detail: Some(detail),
        session_id: None,
        run_id: None,
    }
}

#[cfg(test)]
mod tests {
    use std::io;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use super::{ClaudeControlRequests, ClaudeControlSettlement};
    use crate::provider::driver::claude::session::errors::{
        ClaudeSessionError, ClaudeSessionUnavailableReason, ClaudeUnansweredCause,
    };
    use crate::provider::driver::claude::session::transport::CLAUDE_REQUEST_DEADLINE;
    use crate::provider::driver::claude::session::transport::control::ClaudeControlSubtype;
    use crate::provider::driver::claude::session::transport::inbound::{
        ClaudeControlAnswer, ClaudeControlOutcome,
    };
    use crate::provider::driver::claude::session::transport::user_message::{
        ClaudeWriteAttempt, ClaudeWriteDelivery,
    };

    // A table whose withdrawals are kept for the test to read.
    fn table() -> (ClaudeControlRequests, Arc<Mutex<Vec<String>>>) {
        let withdrawn = Arc::new(Mutex::new(Vec::new()));
        let kept = Arc::clone(&withdrawn);
        let requests = ClaudeControlRequests::new(Arc::new(move |request_id: &str| {
            kept.lock()
                .expect("the test's lock")
                .push(request_id.to_owned());
        }));
        (requests, withdrawn)
    }

    fn cause_of(result: Result<ClaudeControlAnswer, ClaudeSessionError>) -> ClaudeUnansweredCause {
        match result {
            Err(ClaudeSessionError::Unanswered { cause, .. }) => cause,
            other => panic!("expected no answer, got {other:?}"),
        }
    }

    // Killed by answering a deadline as anything but `Unanswered` past the deadline, or by not
    // withdrawing the request.
    #[tokio::test(start_paused = true)]
    async fn a_deadline_after_the_write_is_unanswered_and_withdraws_the_request() {
        let (requests, withdrawn) = table();
        let pending = requests
            .open(ClaudeControlSubtype::GetSettings)
            .expect("the table is open");
        let request_id = pending.request_id();

        let result = pending
            .answer_within(ClaudeWriteAttempt::Written, CLAUDE_REQUEST_DEADLINE)
            .await;

        assert_eq!(cause_of(result), ClaudeUnansweredCause::Deadline);
        assert_eq!(*withdrawn.lock().expect("the test's lock"), [request_id]);
    }

    // Killed by a table with no closed cause: a pending request would wait out its deadline, and a
    // later one would be written to a process that is gone.
    #[tokio::test(start_paused = true)]
    async fn an_exit_fails_every_pending_request_and_refuses_later_ones() {
        let (requests, withdrawn) = table();
        let pending = requests
            .open(ClaudeControlSubtype::Interrupt)
            .expect("the table is open");
        let waiting = tokio::spawn(
            pending.answer_within(ClaudeWriteAttempt::Written, Duration::from_secs(3600)),
        );
        tokio::task::yield_now().await;

        requests.close_on_exit("exited with code 1".to_owned());

        let result = waiting.await.expect("the wait ends");
        assert_eq!(cause_of(result), ClaudeUnansweredCause::ProcessExited);
        assert!(matches!(
            requests.open(ClaudeControlSubtype::Interrupt),
            Err(ClaudeSessionError::Unavailable {
                reason: ClaudeSessionUnavailableReason::ProcessExited,
                ..
            })
        ));
        assert!(withdrawn.lock().expect("the test's lock").is_empty());
    }

    // Killed by merging a retired id with one never issued, either way.
    #[test]
    fn a_late_answer_is_told_apart_from_one_never_issued() {
        let (requests, withdrawn) = table();
        let retired = requests
            .open(ClaudeControlSubtype::GetSettings)
            .expect("the table is open");
        let retired_id = retired.request_id();
        drop(retired);

        let answer = || ClaudeControlOutcome::Success(ClaudeControlAnswer::default());
        assert_eq!(
            requests.settle(&retired_id, answer()),
            ClaudeControlSettlement::Late
        );
        assert_eq!(
            requests.settle("1", answer()),
            ClaudeControlSettlement::NeverIssued
        );
        assert_eq!(
            requests.settle("00", answer()),
            ClaudeControlSettlement::NeverIssued
        );
        // A dropped caller took its slot back and withdrew its request.
        assert_eq!(*withdrawn.lock().expect("the test's lock"), [retired_id]);
    }

    // Killed by treating a write cut after some bytes as one that wrote nothing, or the reverse.
    #[tokio::test]
    async fn a_failed_write_answers_by_how_far_it_got() {
        let (requests, withdrawn) = table();
        let failed = |delivery| ClaudeWriteAttempt::Failed {
            delivery,
            cause: io::Error::from(io::ErrorKind::BrokenPipe),
        };

        let cut = requests
            .open(ClaudeControlSubtype::Initialize)
            .expect("the table is open")
            .answer_within(
                failed(ClaudeWriteDelivery::Indeterminate),
                CLAUDE_REQUEST_DEADLINE,
            )
            .await;
        let unsent = requests
            .open(ClaudeControlSubtype::Initialize)
            .expect("the table is open")
            .answer_within(failed(ClaudeWriteDelivery::Unsent), CLAUDE_REQUEST_DEADLINE)
            .await;

        assert_eq!(cause_of(cut), ClaudeUnansweredCause::WriteCut);
        assert!(matches!(
            unsent,
            Err(ClaudeSessionError::InputUnwritable(_))
        ));
        assert!(withdrawn.lock().expect("the test's lock").is_empty());
    }
}
