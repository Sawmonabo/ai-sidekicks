//! Moving a Codex conversation onto a changed config: a level's config keys and the window reach a
//! conversation only through a start, resume or fork, so a change is taken at once and forks the
//! whole conversation with its new config, at once while the session is idle and once its running
//! turn settles otherwise. Several changes before that make one fork. A turn never starts while
//! the fork is owed: it waits for the session to go idle and for the fork, then starts on the fork.
//! The fork claims the session's slot, then runs on the session's task, where the record is.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use futures::FutureExt as _;
use futures::future::{BoxFuture, Shared};
use sidekicks_contracts::session::id::SessionId;
use tokio::sync::oneshot;
use tokio_util::task::TaskTracker;

use crate::provider::driver::codex::notification_routing::CodexRoutedFrames;
use crate::provider::driver::codex::session::calls::CodexSessionTask;
use crate::provider::driver::codex::session::errors::CodexError;
use crate::provider::driver::codex::session::fork::{CodexForkDependencies, establish_codex_fork};
use crate::provider::driver::codex::session::inbound::{
    CodexSessionCall, CodexSessionInbound, CodexSessionInboundSender,
};
use crate::provider::driver::codex::session::slots::CodexSessionSlots;
use crate::provider::driver::codex::session::state::CodexSessionRecord;
use crate::provider::driver::codex::transport::diagnostics::CodexTransportDiagnostic;

/// A config fork in flight, shared by every caller waiting on it: `true` once the session moved
/// onto the fork, `false` when it owed none by the time the fork ran.
pub(crate) type CodexConfigFork = Shared<BoxFuture<'static, Result<bool, Arc<CodexError>>>>;

/// The forks each session's conversation owes onto the config its record holds once that changed,
/// never run while a turn runs, starts or is still ending on it.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the Codex driver builds the config forks its sessions share"
    )
)]
pub(crate) struct CodexConfigForks {
    slots: Arc<CodexSessionSlots>,
    tasks: TaskTracker,
    /// The fork in flight on each session; never held across an await.
    running: Mutex<HashMap<SessionId, (u64, CodexConfigFork)>>,
    next_fork: Mutex<u64>,
}

impl CodexConfigForks {
    /// The config forks, claiming each session's slot through `slots` and running a fork no
    /// caller waits on as a task of `tasks`.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the Codex driver builds the config forks its sessions share"
        )
    )]
    pub(crate) fn new(slots: Arc<CodexSessionSlots>, tasks: TaskTracker) -> Self {
        Self {
            slots,
            tasks,
            running: Mutex::new(HashMap::new()),
            next_fork: Mutex::new(0),
        }
    }

    /// Owes the session `record` holds a fork onto the config it holds now; an idle session forks
    /// at once. Called on the session's task.
    #[expect(
        dead_code,
        reason = "the Codex session's level and window moves owe the fork they need"
    )]
    pub(crate) fn owe(self: &Arc<Self>, record: &mut CodexSessionRecord) {
        record.is_config_fork_owed = true;
        self.note_turn_settled(record);
    }

    /// Runs the fork `record`'s session owes once nothing runs, starts or ends on it, as a task no
    /// caller waits on; called on the session's task whenever a turn of the session settled.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the Codex session's frame intake notes each turn's end"
        )
    )]
    pub(crate) fn note_turn_settled(self: &Arc<Self>, record: &CodexSessionRecord) {
        if !record.is_config_fork_owed || record.is_turn_in_flight(None) {
            return;
        }
        let fork = self.fork(record.session_id, &record.inbound);
        self.tasks.spawn(fork);
    }

    /// The fork the session owes, joined when one is in flight: it claims the session's slot, then
    /// runs on the session's task if the session still owes it and is idle there. Fails as the
    /// fork fails, and with `CodexError::SessionClosed` once the session closed before its turn.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the Codex run start forks before its turn")
    )]
    pub(crate) fn fork(
        self: &Arc<Self>,
        session_id: SessionId,
        inbound: &CodexSessionInboundSender,
    ) -> CodexConfigFork {
        let mut running = self.lock_running();
        if let Some((_, in_flight)) = running.get(&session_id) {
            return in_flight.clone();
        }
        let fork_number = {
            let mut next = self
                .next_fork
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            *next += 1;
            *next
        };
        let forks = Arc::clone(self);
        let inbound = inbound.clone();
        let fork = async move {
            let forked = forks.run_fork(session_id, &inbound).await;
            let mut running = forks.lock_running();
            if running
                .get(&session_id)
                .is_some_and(|(number, _)| *number == fork_number)
            {
                running.remove(&session_id);
            }
            forked
        }
        .boxed()
        .shared();
        running.insert(session_id, (fork_number, fork.clone()));
        fork
    }

    /// Waits for the forks in flight on the session to end, a fork started meanwhile among them;
    /// how each ended is the fork's caller's to read.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the Codex run start, goals and controls wait for a fork in flight"
        )
    )]
    pub(crate) async fn join(&self, session_id: SessionId) {
        loop {
            let in_flight = self
                .lock_running()
                .get(&session_id)
                .map(|(_, fork)| fork.clone());
            let Some(in_flight) = in_flight else {
                return;
            };
            // Its caller reads how it ended; a joiner only waits for it.
            let _ended = in_flight.await;
        }
    }

    async fn run_fork(
        &self,
        session_id: SessionId,
        inbound: &CodexSessionInboundSender,
    ) -> Result<bool, Arc<CodexError>> {
        let claim = self
            .slots
            .claim_establishing(session_id)
            .await
            .map_err(Arc::new)?;
        let (reply, replied) = oneshot::channel();
        // A session whose task ended owes nothing now.
        if !inbound.push(CodexSessionInbound::Call(CodexSessionCall::ConfigFork {
            reply,
        })) {
            return Ok(false);
        }
        let forked = replied.await.unwrap_or(Ok(false));
        drop(claim);
        forked.map_err(Arc::new)
    }

    fn lock_running(&self) -> MutexGuard<'_, HashMap<SessionId, (u64, CodexConfigFork)>> {
        self.running.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Runs the config fork the session owes on its task, the caller holding the session's slot:
/// answers `false` with nothing done when the session owes none or a turn runs, starts or still
/// ends on it, since that turn's end runs it. A failed fork is reported and the session still
/// owes it, so its next turn forks again first and fails with the fork's error.
pub(crate) async fn run_codex_config_fork(
    task: &mut CodexSessionTask<'_>,
    dependencies: &CodexForkDependencies,
) -> Result<(bool, CodexRoutedFrames), CodexError> {
    if !task.record.is_config_fork_owed || task.record.is_turn_in_flight(None) {
        return Ok((false, CodexRoutedFrames::default()));
    }
    let binding_id = task.record.binding_id.clone();
    let thread_id = task.record.thread_id.clone();
    match establish_codex_fork(task, dependencies, None, binding_id).await {
        Ok(routed) => Ok((true, routed)),
        Err(error) => {
            CodexTransportDiagnostic::ConversationForkFailed {
                thread_id,
                error: error.to_string().into(),
            }
            .report();
            Err(error)
        }
    }
}
