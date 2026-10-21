//! Waiting on a session's turns: an undo, a faster-model retry, a start, a goal set or clear and
//! `Allow once` wait, after the daemon sent `turn/interrupt`, which Codex answers on acceptance,
//! for the turn's `turn/completed`; `Allow once` also waits for a turn still starting to run, and
//! a fork onto a changed config for the session to go idle.
//! The waits live beside the record on the session's task, which settles them after each frame;
//! each is bound by a deadline, so a turn that never ends or starts cannot hold anything forever.
//! A turn its service dropped ends the wait as not ended, and a session's close refuses it.

use std::sync::OnceLock;
use std::time::Duration;

use sidekicks_contracts::session::id::SessionId;
use tokio::sync::oneshot;
use tokio::time::Instant;

use crate::provider::driver::codex::session::errors::CodexError;
use crate::provider::driver::codex::session::state::CodexSessionRecord;
use crate::provider::driver::codex::transport::connection::CODEX_REQUEST_TIMEOUT;

/// What one wait waits for on a session's record.
#[derive(Clone, Debug, PartialEq, Eq)]
#[expect(
    dead_code,
    reason = "the Codex start, retry, undo, goal and `Allow once` name what they wait for"
)]
pub(crate) enum CodexTurnWait {
    /// The turn `turn_id` to end: neither live, nor stopped by the daemon and still ending, nor
    /// started by Codex with no run.
    End {
        /// The turn.
        turn_id: String,
    },
    /// No turn the daemon is stopping still ending, and none Codex started running with no run.
    StoppedTurns,
    /// A turn to run.
    LiveTurn,
    /// A turn to run, start or open its run.
    TurnInFlight,
    /// No turn to run, start, still end or open its run, so the session is idle.
    Idle,
}

impl CodexTurnWait {
    // Whether the wait still waits on `record`.
    fn is_owed(&self, record: &CodexSessionRecord) -> bool {
        match self {
            Self::End { turn_id } => {
                record.active_turn_run(turn_id).is_some()
                    || record.ending_turn_ids().contains(&turn_id.as_str())
                    || record.delivery.unowned_turn_ids.contains(turn_id)
            }
            Self::StoppedTurns => {
                !record.ending_turn_ids().is_empty() || !record.delivery.unowned_turn_ids.is_empty()
            }
            Self::LiveTurn => record.active_turns.is_empty(),
            Self::TurnInFlight => !record.is_turn_in_flight(None),
            Self::Idle => record.is_turn_in_flight(None),
        }
    }
}

/// How a record stopped being its session's: the session closed, or it goes on without the record.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[expect(
    dead_code,
    reason = "the Codex session's close, dispose and process exit say how its record ended"
)]
pub(crate) enum CodexRecordExit {
    /// The session closed.
    SessionClosed,
    /// The session goes on: the record was replaced, let go, or its service is gone.
    SessionContinues,
}

/// A wait's answer: `true` once what it waits for happened, `false` when it was dropped unended.
pub(crate) type CodexTurnWaitAnswer = Result<bool, CodexError>;

/// The waits on one session's turns, kept on its task beside its record.
#[derive(Default)]
pub(crate) struct CodexTurnEndWaiters {
    waiters: Vec<(CodexTurnWait, oneshot::Sender<CodexTurnWaitAnswer>)>,
}

impl CodexTurnEndWaiters {
    /// Registers `wait` on `record`, answered at once when nothing is owed; the caller awaits the
    /// answer under a [`CodexTurnEndDeadline`].
    #[expect(
        dead_code,
        reason = "the Codex session's task registers each wait a start, retry, undo or goal makes"
    )]
    pub(crate) fn wait(
        &mut self,
        record: &CodexSessionRecord,
        wait: CodexTurnWait,
    ) -> oneshot::Receiver<CodexTurnWaitAnswer> {
        let (answer, answered) = oneshot::channel();
        if wait.is_owed(record) {
            self.waiters.push((wait, answer));
        } else {
            // A caller that stopped waiting needs no answer.
            let _unheard = answer.send(Ok(true));
        }
        answered
    }

    /// Answers every wait no longer owed on `record`, and drops those whose caller stopped waiting.
    #[expect(
        dead_code,
        reason = "the Codex session's task settles the waits after each frame it delivers"
    )]
    pub(crate) fn settle(&mut self, record: &CodexSessionRecord) {
        let mut owed = Vec::with_capacity(self.waiters.len());
        for (wait, answer) in self.waiters.drain(..) {
            if answer.is_closed() {
                continue;
            }
            if wait.is_owed(record) {
                owed.push((wait, answer));
            } else {
                let _unheard = answer.send(Ok(true));
            }
        }
        self.waiters = owed;
    }

    /// Ends every wait on the session's turns, which were dropped unended: refused with
    /// `CodexError::SessionClosed` when the session closed, else answered as not ended.
    #[expect(
        dead_code,
        reason = "the Codex session's close, dispose and process exit end its waits"
    )]
    pub(crate) fn abandon(&mut self, session_id: SessionId, exit: CodexRecordExit) {
        for (_, answer) in self.waiters.drain(..) {
            let _unheard = answer.send(match exit {
                CodexRecordExit::SessionClosed => Err(CodexError::SessionClosed { session_id }),
                CodexRecordExit::SessionContinues => Ok(false),
            });
        }
    }
}

/// One bound on every wait of one act: its clock starts at the first wait that has something to
/// wait for, so the bounds of several waits never add up.
pub(crate) struct CodexTurnEndDeadline {
    timeout: Duration,
    at: OnceLock<Instant>,
}

impl CodexTurnEndDeadline {
    /// A deadline of `timeout`.
    #[expect(
        dead_code,
        reason = "the Codex undo, retry and `Allow once` bound their waits with one deadline"
    )]
    pub(crate) fn new(timeout: Duration) -> Self {
        Self {
            timeout,
            at: OnceLock::new(),
        }
    }

    /// A deadline of the request deadline, for a wait with no act of its own to share one.
    #[expect(
        dead_code,
        reason = "the Codex run start bounds its wait for a stopping turn with it"
    )]
    pub(crate) fn for_request() -> Self {
        Self::new(CODEX_REQUEST_TIMEOUT)
    }

    /// Awaits `answered` until the deadline: `false` once it passed, or when the session's task
    /// dropped the wait. Fails as the wait does, with `CodexError::SessionClosed` on a close.
    #[expect(
        dead_code,
        reason = "the Codex undo, retry and `Allow once` await their waits through it"
    )]
    pub(crate) async fn bound(
        &self,
        mut answered: oneshot::Receiver<CodexTurnWaitAnswer>,
    ) -> CodexTurnWaitAnswer {
        // An answer already there starts no clock.
        if let Ok(answer) = answered.try_recv() {
            return answer;
        }
        let at = *self.at.get_or_init(|| Instant::now() + self.timeout);
        match tokio::time::timeout_at(at, answered).await {
            Ok(Ok(answer)) => answer,
            Ok(Err(_)) | Err(_) => Ok(false),
        }
    }
}
