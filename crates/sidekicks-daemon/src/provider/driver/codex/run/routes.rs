//! The run routes of the Codex driver: which session each run's live turns are on, the runtime
//! binding, agent and step bound each run's deliveries are attributed with, and the level a run
//! alone was asked to run at, until the run ends.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;

use crate::codex::session::state::CodexSessionRecord;
use sidekicks_std::mutex_lock::lock;

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

// Each by run.
#[derive(Default)]
struct Routes {
    sessions: HashMap<RunId, SessionId>,
    bindings: HashMap<RunId, CodexRunBinding>,
    output_speeds_for_turn: HashMap<RunId, String>,
}

impl CodexRunRoutes {
    /// Routes a run to the session one of its turns just started on.
    pub(crate) fn bind_run(&self, run_id: RunId, session_id: SessionId) {
        self.lock().sessions.insert(run_id, session_id);
    }

    /// Records the binding a run's deliveries go on, before its first turn is sent; it stays
    /// until the run ends, through every turn the run takes.
    pub(crate) fn bind_run_delivery(&self, run_id: RunId, binding: CodexRunBinding) {
        self.lock().bindings.insert(run_id, binding);
    }

    /// The binding a run's deliveries go on, or `None` once the run ended.
    pub(crate) fn binding_for(&self, run_id: RunId) -> Option<CodexRunBinding> {
        self.lock().bindings.get(&run_id).cloned()
    }

    /// Keeps the output speed a run alone was asked to run at, for every turn it takes.
    pub(crate) fn keep_output_speed_for_turn(&self, run_id: RunId, output_speed_for_turn: String) {
        self.lock()
            .output_speeds_for_turn
            .insert(run_id, output_speed_for_turn);
    }

    /// The output speed a run alone was asked to run at; `None` when it runs at the session's.
    pub(crate) fn output_speed_for_turn_of(&self, run_id: RunId) -> Option<String> {
        self.lock().output_speeds_for_turn.get(&run_id).cloned()
    }

    /// Forgets a run that ended, so nothing more is delivered for it.
    pub(crate) fn forget_run(&self, run_id: RunId) {
        let mut routes = self.lock();
        routes.bindings.remove(&run_id);
        routes.output_speeds_for_turn.remove(&run_id);
    }

    /// The session a run is routed to, or `None` once its last route is retired.
    pub(crate) fn session_id_for(&self, run_id: RunId) -> Option<SessionId> {
        self.lock().sessions.get(&run_id).copied()
    }

    /// Retires one turn's route, and the run's session route only when that turn was the run's
    /// last: dropping it earlier would strand the steer and interrupt paths of the run's other
    /// live turn.
    pub(crate) fn retire_turn_route(&self, record: &mut CodexSessionRecord, turn_id: &str) {
        let Some(run_id) = record.remove_active_turn(turn_id) else {
            return;
        };
        if record.newest_active_turn_for_run(run_id).is_none() {
            self.lock().sessions.remove(&run_id);
        }
    }

    /// Drops every run route and binding of a session, scanning by value: the record that could
    /// enumerate them is gone or replaced by the time a sweep is owed.
    pub(crate) fn forget_run_routes(&self, session_id: SessionId) {
        let mut routes = self.lock();
        let Routes {
            sessions,
            bindings,
            output_speeds_for_turn,
        } = &mut *routes;
        sessions.retain(|_, bound_session_id| *bound_session_id != session_id);
        bindings.retain(|run_id, binding| {
            let is_kept = binding.session_id != session_id;
            if !is_kept {
                output_speeds_for_turn.remove(run_id);
            }
            is_kept
        });
    }

    fn lock(&self) -> MutexGuard<'_, Routes> {
        lock(&self.routes)
    }
}
