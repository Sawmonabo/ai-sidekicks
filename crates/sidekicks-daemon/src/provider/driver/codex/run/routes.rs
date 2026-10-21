//! The run routes of the Codex driver: which session each run's live turns are on, the runtime
//! binding, agent and step bound each run's deliveries are attributed with, and the level a run
//! alone was asked to run at, until the run ends.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, PoisonError};

use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;
use tokio::sync::oneshot;

use crate::provider::driver::codex::session::state::CodexSessionRecord;

/// The binding a run's deliveries go on, the agent whose run it is, and the bound on the steps
/// one of its turns may take.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodexRunBinding {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The binding.
    pub(crate) binding_id: RuntimeBindingId,
    /// The agent.
    pub(crate) agent_id: AgentId,
    /// The session's `Max steps per turn` as the run started, `None` where none is set.
    pub(crate) step_bound: Option<SafeInt<1>>,
}

/// The run routes of one Codex driver, shared by its sessions.
#[derive(Default)]
pub(crate) struct CodexRunRoutes {
    routes: Mutex<Routes>,
}

#[derive(Default)]
struct Routes {
    session_id_by_run_id: HashMap<RunId, SessionId>,
    binding_by_run_id: HashMap<RunId, CodexRunBinding>,
    output_speed_for_turn_by_run_id: HashMap<RunId, String>,
    turn_start_waiters: HashMap<RunId, oneshot::Sender<String>>,
}

impl CodexRunRoutes {
    /// Routes a run to the session whose turn `turn_id` just started, answering a wait for it.
    pub(crate) fn bind_run(&self, run_id: RunId, session_id: SessionId, turn_id: &str) {
        let waiter = {
            let mut routes = self.lock();
            routes.session_id_by_run_id.insert(run_id, session_id);
            routes.turn_start_waiters.remove(&run_id)
        };
        if let Some(waiter) = waiter {
            // A wait dropped by its caller has stopped waiting, which is no fault.
            let _stopped_waiting = waiter.send(turn_id.to_owned());
        }
    }

    /// Answers with the turn once `run_id` is routed to one, for a turn Codex starts on its own
    /// after a request whose reply names no turn. Dropping the receiver stops waiting.
    #[expect(
        dead_code,
        reason = "the Codex run's start waits for the turn a reply named no id of"
    )]
    pub(crate) fn await_turn_start(&self, run_id: RunId) -> oneshot::Receiver<String> {
        let (waiter, turn_started) = oneshot::channel();
        self.lock().turn_start_waiters.insert(run_id, waiter);
        turn_started
    }

    /// Records the binding a run's deliveries go on, before its first turn is sent; it stays
    /// until the run ends, through every turn the run takes.
    #[expect(
        dead_code,
        reason = "the Codex run's start binds each run before its first turn"
    )]
    pub(crate) fn bind_run_delivery(&self, run_id: RunId, binding: CodexRunBinding) {
        self.lock().binding_by_run_id.insert(run_id, binding);
    }

    /// The binding a run's deliveries go on, or `None` once the run ended.
    pub(crate) fn binding_for(&self, run_id: RunId) -> Option<CodexRunBinding> {
        self.lock().binding_by_run_id.get(&run_id).cloned()
    }

    /// Keeps the output speed a run alone was asked to run at, for every turn it takes.
    #[expect(
        dead_code,
        reason = "the Codex run's start keeps the level a run alone runs at"
    )]
    pub(crate) fn keep_output_speed_for_turn(&self, run_id: RunId, output_speed_for_turn: String) {
        self.lock()
            .output_speed_for_turn_by_run_id
            .insert(run_id, output_speed_for_turn);
    }

    /// The output speed a run alone was asked to run at; `None` when it runs at the session's.
    #[expect(
        dead_code,
        reason = "the Codex run's control sends each later turn at its run's own level"
    )]
    pub(crate) fn output_speed_for_turn_of(&self, run_id: RunId) -> Option<String> {
        self.lock()
            .output_speed_for_turn_by_run_id
            .get(&run_id)
            .cloned()
    }

    /// Forgets a run that ended, so nothing more is delivered for it.
    pub(crate) fn forget_run(&self, run_id: RunId) {
        let mut routes = self.lock();
        routes.binding_by_run_id.remove(&run_id);
        routes.output_speed_for_turn_by_run_id.remove(&run_id);
        routes.turn_start_waiters.remove(&run_id);
    }

    /// The session a run is routed to, or `None` once its last route is retired.
    #[expect(
        dead_code,
        reason = "the Codex run's control finds the session of a run it steers or interrupts"
    )]
    pub(crate) fn session_id_for(&self, run_id: RunId) -> Option<SessionId> {
        self.lock().session_id_by_run_id.get(&run_id).copied()
    }

    /// Retires one turn's route, and the run's session route only when that turn was the run's
    /// last: dropping it earlier would strand the steer and interrupt paths of the run's other
    /// live turn.
    #[expect(
        dead_code,
        reason = "the Codex run's control retires a turn an interrupt took from its run"
    )]
    pub(crate) fn retire_turn_route(&self, record: &mut CodexSessionRecord, turn_id: &str) {
        let Some(run_id) = record.remove_active_turn(turn_id) else {
            return;
        };
        if record.newest_active_turn_for_run(run_id).is_none() {
            self.lock().session_id_by_run_id.remove(&run_id);
        }
    }

    /// Drops every run route and binding of a session, scanning by value: the record that could
    /// enumerate them is gone or replaced by the time a sweep is owed.
    #[expect(
        dead_code,
        reason = "the Codex session's close sweeps the routes of its runs"
    )]
    pub(crate) fn forget_run_routes(&self, session_id: SessionId) {
        let mut routes = self.lock();
        let Routes {
            session_id_by_run_id,
            binding_by_run_id,
            output_speed_for_turn_by_run_id,
            turn_start_waiters,
        } = &mut *routes;
        session_id_by_run_id.retain(|_, bound_session_id| *bound_session_id != session_id);
        binding_by_run_id.retain(|run_id, binding| {
            let is_kept = binding.session_id != session_id;
            if !is_kept {
                output_speed_for_turn_by_run_id.remove(run_id);
                turn_start_waiters.remove(run_id);
            }
            is_kept
        });
    }

    fn lock(&self) -> MutexGuard<'_, Routes> {
        self.routes.lock().unwrap_or_else(PoisonError::into_inner)
    }
}
