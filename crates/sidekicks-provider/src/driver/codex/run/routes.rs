//! The run routes of the Codex driver: which session each run's live turns are on, the runtime
//! binding, agent and step bound each run's deliveries are attributed with, the level a run
//! alone was asked to run at, until the run ends, the conversation each helper's child run
//! runs on, until the helper ends, the run each session's next turn Codex starts by itself is
//! claimed for, until that turn starts or the claim is taken back, each goal's run whose claim was
//! taken back, until it ended, and each session whose goal the driver is replacing, until the
//! update of the goal a replace's set or put-back answered arrives, or the put-back fails.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use serde_json::Value;
use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_std::mutex_lock::lock;
use tokio::sync::watch;

use crate::driver::codex::session::state::CodexSessionRecord;

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

/// The conversation a helper's child run runs on, and whether the daemon interrupted it, so the
/// helper's end can say it is that interrupt's.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodexHelperRoute {
    /// The session the helper runs in.
    pub(crate) session_id: SessionId,
    /// The helper's own conversation, which its turns run on.
    pub(crate) thread_id: String,
    /// Whether the daemon's interrupt is stopping the helper's turn.
    pub(crate) is_interrupted_by_daemon: bool,
}

/// A replace of a session's goal the driver is making: the clear that goes first draws no row, nor
/// does an update of a goal whose objective is one of `absorbed_objectives`; the update carrying
/// `awaited_goal`, the goal the replace's set or put-back answered, ends the replace and draws its
/// row only when `is_drawn`. An update of any other goal draws its row as any does.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct CodexGoalReplace {
    /// The objectives whose updates draw no row, trimmed as Codex keeps them.
    pub(crate) absorbed_objectives: Vec<String>,
    /// The goal the set or the put-back answered, once it answered; Codex's update carries the
    /// same value.
    pub(crate) awaited_goal: Option<Value>,
    /// Whether the awaited goal's update draws its row: the new goal's does, while the old goal's
    /// after a refused replace does not, since the goal did not change.
    pub(crate) is_drawn: bool,
}

/// Ends a session's goal run's ending once dropped: as the run's start returned, or as the goal's
/// set was dropped before it did.
pub(crate) struct CodexGoalRunEndGuard {
    run_routes: Arc<CodexRunRoutes>,
    session_id: SessionId,
}

impl CodexGoalRunEndGuard {
    /// The guard of `session_id`'s goal run's ending on `run_routes`.
    pub(crate) fn new(run_routes: Arc<CodexRunRoutes>, session_id: SessionId) -> Self {
        Self {
            run_routes,
            session_id,
        }
    }
}

impl Drop for CodexGoalRunEndGuard {
    fn drop(&mut self) {
        self.run_routes.end_goal_run_ending(self.session_id);
    }
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
    helpers: HashMap<RunId, CodexHelperRoute>,
    // By session.
    goal_turn_claims: HashMap<SessionId, RunId>,
    // A goal's run ending once its claim was taken back; the sender drops as it ended.
    goal_runs_ending: HashMap<SessionId, watch::Sender<()>>,
    goal_replaces: HashMap<SessionId, CodexGoalReplace>,
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

    /// Routes a helper's child run to the helper's own conversation `thread_id`, until the helper
    /// ends.
    pub(crate) fn bind_helper_run(&self, run_id: RunId, session_id: SessionId, thread_id: &str) {
        self.lock().helpers.insert(
            run_id,
            CodexHelperRoute {
                session_id,
                thread_id: thread_id.to_owned(),
                is_interrupted_by_daemon: false,
            },
        );
    }

    /// Marks a helper's child run interrupted by the daemon and answers its route, in one step so
    /// the helper's end cannot be read ahead of the mark; `None` for a run with no helper route.
    pub(crate) fn begin_helper_interrupt(&self, run_id: RunId) -> Option<CodexHelperRoute> {
        let mut routes = self.lock();
        let route = routes.helpers.get_mut(&run_id)?;
        route.is_interrupted_by_daemon = true;
        Some(route.clone())
    }

    /// Clears the daemon's interrupt mark of a helper's child run whose interrupt failed, so its
    /// own end reads as its own; the route stays.
    pub(crate) fn end_helper_interrupt(&self, run_id: RunId) {
        if let Some(route) = self.lock().helpers.get_mut(&run_id) {
            route.is_interrupted_by_daemon = false;
        }
    }

    /// Whether a helper's child run is routed to its conversation, as an adoption that reopened
    /// the helper routes it.
    pub(crate) fn has_helper_route(&self, run_id: RunId) -> bool {
        self.lock().helpers.contains_key(&run_id)
    }

    /// Removes and answers the route of a helper's child run that ended.
    pub(crate) fn retire_helper_run(&self, run_id: RunId) -> Option<CodexHelperRoute> {
        self.lock().helpers.remove(&run_id)
    }

    /// Claims the next turn Codex starts by itself on `session_id` for `run_id`, a goal's run
    /// whose turn Codex starts on its own once it took the goal.
    pub(crate) fn claim_goal_turn(&self, session_id: SessionId, run_id: RunId) {
        self.lock().goal_turn_claims.insert(session_id, run_id);
    }

    /// Removes and answers the run `session_id`'s next turn Codex starts by itself is claimed
    /// for: the turn's start takes it, and the goal's run takes it back once no turn came.
    pub(crate) fn take_goal_turn_claim(&self, session_id: SessionId) -> Option<RunId> {
        self.lock().goal_turn_claims.remove(&session_id)
    }

    /// Marks `session_id`'s goal's run, whose turn claim was taken back, as ending: a turn Codex
    /// starts by itself meanwhile waits for that end before its own run opens, since the engine
    /// takes no second lead run while the goal's is live.
    pub(crate) fn begin_goal_run_ending(&self, session_id: SessionId) {
        self.lock()
            .goal_runs_ending
            .insert(session_id, watch::channel(()).0);
    }

    /// The end of `session_id`'s goal's run that is ending, which closes as it ended, or `None`
    /// when none is.
    pub(crate) fn goal_run_ending(&self, session_id: SessionId) -> Option<watch::Receiver<()>> {
        self.lock()
            .goal_runs_ending
            .get(&session_id)
            .map(watch::Sender::subscribe)
    }

    /// Ends `session_id`'s goal's run's ending: the run ended, so a turn waiting on it goes on.
    pub(crate) fn end_goal_run_ending(&self, session_id: SessionId) {
        self.lock().goal_runs_ending.remove(&session_id);
    }

    /// Marks `session_id`'s goal as being replaced, as `replace` says, in place of any replace
    /// marked before.
    pub(crate) fn begin_goal_replace(&self, session_id: SessionId, replace: CodexGoalReplace) {
        self.lock().goal_replaces.insert(session_id, replace);
    }

    /// Records `goal`, the goal a replace's set or put-back answered, as the update that ends
    /// `session_id`'s replace.
    pub(crate) fn await_goal_replace_update(&self, session_id: SessionId, goal: Value) {
        if let Some(replace) = self.lock().goal_replaces.get_mut(&session_id) {
            replace.awaited_goal = Some(goal);
        }
    }

    /// The replace of `session_id`'s goal the driver is making, if any.
    pub(crate) fn goal_replace(&self, session_id: SessionId) -> Option<CodexGoalReplace> {
        self.lock().goal_replaces.get(&session_id).cloned()
    }

    /// Ends `session_id`'s goal replace: the awaited goal reported its update, or the replace could
    /// wait for none.
    pub(crate) fn end_goal_replace(&self, session_id: SessionId) {
        self.lock().goal_replaces.remove(&session_id);
    }

    /// Drops every run route, helper route, binding, turn claim, goal run ending and goal replace
    /// of a session, scanning by value: the record that could enumerate them is gone or replaced
    /// by the time a sweep is owed.
    pub(crate) fn forget_run_routes(&self, session_id: SessionId) {
        let mut routes = self.lock();
        let Routes {
            sessions,
            bindings,
            output_speeds_for_turn,
            helpers,
            goal_turn_claims,
            goal_runs_ending,
            goal_replaces,
        } = &mut *routes;
        goal_turn_claims.remove(&session_id);
        goal_runs_ending.remove(&session_id);
        goal_replaces.remove(&session_id);
        sessions.retain(|_, bound_session_id| *bound_session_id != session_id);
        helpers.retain(|_, helper| helper.session_id != session_id);
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
