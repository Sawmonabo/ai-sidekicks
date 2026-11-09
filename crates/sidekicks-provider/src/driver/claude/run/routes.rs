//! Which Claude session each dispatched run is bound to, and the runtime binding its deliveries
//! are attributed on. A session's turn has one holder at a time, a run or a command Claude Code
//! runs as a turn of its own, so no second turn starts while one is in flight. A run's binding
//! outlives its turn's hold, since a paused run takes its next turn on the same binding, and goes
//! when the run ends; a run whose turn ended with a steer Claude Code has yet to take carries its
//! hold through that turn's settlement, into the turn Claude Code starts with it. A helper Claude
//! Code started is a child run, routed by the provider's own agent id, which its frames and hook
//! callbacks carry. A run apart from the session's process, such as a review of the staged
//! changes, holds no turn there and is routed only to how it is stopped.

use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use tokio::pin;
use tokio::sync::{Notify, watch};

/// Where a helper's child run lives: its session, the agent id its frames and hook callbacks
/// carry, the run it was started beneath, the binding the lead's process is attributed on, and
/// whether the daemon refused the run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ClaudeChildRunRoute {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The helper's agent id, as Claude Code gave it.
    pub(crate) agent_id: String,
    /// The run it was started beneath: its launching helper's, else the lead's.
    pub(crate) parent_run_id: RunId,
    /// The binding the lead's process is attributed on.
    pub(crate) binding_id: RuntimeBindingId,
    /// Whether the daemon refused the run, which ended at its setup and only absorbs the helper's
    /// frames, so no helper it launches is started beneath it.
    pub(crate) is_refused: bool,
}

/// A run and the runtime binding its deliveries are attributed on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ClaudeBoundRun {
    /// The run.
    pub(crate) run_id: RunId,
    /// Its binding.
    pub(crate) binding_id: RuntimeBindingId,
}

/// Where a run is routed: a lead run on its session's process, a helper's child run, or a run
/// apart from the process.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ClaudeRunRoute {
    /// A lead run, bound until it ends, whether or not it holds the turn now.
    Lead {
        /// Its session.
        session_id: SessionId,
        /// Its binding.
        binding_id: RuntimeBindingId,
    },
    /// A helper's child run.
    Child(ClaudeChildRunRoute),
    /// A run apart from its session's process.
    Apart,
}

/// The session's turn is held by another run or a command.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct TurnHeld;

/// Why a run could not take its session's turn again.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum HoldAgainRefusal {
    /// The routes hold no binding for the run.
    NoBinding,
    /// Another run or a command holds the turn.
    TurnHeld,
}

/// Stops a run apart from its session's process; `is_end_written` is `true` when the daemon writes
/// the run's end itself, so the run must not end it again.
pub(crate) type ClaudeApartRunStop = Box<dyn FnOnce(bool) + Send>;

/// What holds a session's turn.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TurnHolder {
    /// A run, which keeps the turn through its settlement when it carries it over.
    Run { run_id: RunId, is_carried: bool },
    /// A command Claude Code runs as a turn of its own.
    Command,
}

/// A session's turn: its holder, and how many times its holder changed or a run's end was written
/// on it, so a waiter wakes on any of those since its mark, even when a new hold follows a release
/// at once.
#[derive(Debug, Default)]
struct TurnState {
    holder: Option<TurnHolder>,
    changes: u64,
}

#[derive(Default)]
struct RouteTables {
    turns: HashMap<SessionId, watch::Sender<TurnState>>,
    bindings: HashMap<RunId, (SessionId, RuntimeBindingId)>,
    children: HashMap<RunId, ClaudeChildRunRoute>,
    apart_stops: HashMap<RunId, ClaudeApartRunStop>,
}

impl RouteTables {
    // Changes the session's turn where `change` says it did, counting the change, and answers what
    // `change` answers; a session whose turn is not kept answers as a free turn would, and its turn
    // is kept only once something changes it, so a session gets no entry from a change that does
    // nothing.
    fn change_turn<T>(
        &mut self,
        session_id: SessionId,
        change: impl FnOnce(&mut TurnState) -> (bool, T),
    ) -> T {
        match self.turns.entry(session_id) {
            Entry::Occupied(turn) => {
                let mut answer = None;
                turn.get().send_if_modified(|state| {
                    let (is_changed, outcome) = change(state);
                    answer = Some(outcome);
                    if is_changed {
                        state.changes += 1;
                    }
                    is_changed
                });
                answer.expect("send_if_modified calls its closure once")
            }
            Entry::Vacant(turn) => {
                let mut state = TurnState::default();
                let (is_changed, outcome) = change(&mut state);
                if is_changed {
                    state.changes += 1;
                    turn.insert(watch::Sender::new(state));
                }
                outcome
            }
        }
    }

    // Releases the session's turn where `run_id` holds it.
    fn release_run(&mut self, session_id: SessionId, run_id: RunId) {
        self.change_turn(session_id, |state| match state.holder {
            Some(TurnHolder::Run { run_id: held, .. }) if held == run_id => {
                state.holder = None;
                (true, ())
            }
            Some(TurnHolder::Run { .. } | TurnHolder::Command) | None => (false, ()),
        });
    }
}

/// The run-to-session routes of the Claude driver's sessions. Its lock is never held across an
/// await.
#[derive(Default)]
pub(crate) struct ClaudeRunRoutes {
    tables: Mutex<RouteTables>,
    // Woken each time a helper's child run is bound.
    child_bound: Notify,
}

impl ClaudeRunRoutes {
    /// How many times the session's turn has changed hands or seen a run's end written, the mark
    /// [`Self::when_turn_changed_after`] waits past; 0 for a session whose turn is not kept.
    pub(crate) fn turn_mark(&self, session_id: SessionId) -> u64 {
        self.lock()
            .turns
            .get(&session_id)
            .map_or(0, |turn| turn.borrow().changes)
    }

    /// Answers `true` once the session's turn has changed hands or seen a run's end written since
    /// `mark` was taken, at once when it already has, when the session's turn is not kept, or once
    /// it is closed with its session; `false` when `deadline` passes first. A release followed at
    /// once by a new hold still answers `true`, so the caller's next try may be refused again.
    pub(crate) async fn when_turn_changed_after(
        &self,
        session_id: SessionId,
        mark: u64,
        deadline: Duration,
    ) -> bool {
        let Some(mut receiver) = self
            .lock()
            .turns
            .get(&session_id)
            .map(watch::Sender::subscribe)
        else {
            return true;
        };
        // Any count but the mark is a change: one past it, or a turn forgotten with its session
        // and begun again from 0.
        let changed = receiver.wait_for(|state| state.changes != mark);
        match tokio::time::timeout(deadline, changed).await {
            // A closed turn is a session gone, which holds nothing.
            Ok(Ok(_) | Err(_)) => true,
            Err(_elapsed) => false,
        }
    }

    /// Counts a run's end written on the session, which frees its turn for the run engine though
    /// the routes' holder does not change; a session whose turn is not kept has no waiter to wake.
    pub(crate) fn note_run_end_written(&self, session_id: SessionId) {
        if let Some(turn) = self.lock().turns.get(&session_id) {
            turn.send_modify(|state| state.changes += 1);
        }
    }

    /// Whether a run or a command holds the session's turn, so no other turn may start.
    pub(crate) fn is_turn_held(&self, session_id: SessionId) -> bool {
        self.lock()
            .turns
            .get(&session_id)
            .is_some_and(|turn| turn.borrow().holder.is_some())
    }

    /// Binds a run to the session its opening frame goes to and the binding its deliveries are
    /// attributed on, and gives it the session's turn; a run that holds the turn already takes the
    /// new binding. Fails with [`TurnHeld`] when another run or a command holds the turn.
    pub(crate) fn hold_turn(
        &self,
        run_id: RunId,
        session_id: SessionId,
        binding_id: RuntimeBindingId,
    ) -> Result<(), TurnHeld> {
        let mut tables = self.lock();
        tables.change_turn(session_id, |state| match state.holder {
            None => {
                state.holder = Some(TurnHolder::Run {
                    run_id,
                    is_carried: false,
                });
                (true, Ok(()))
            }
            Some(TurnHolder::Run { run_id: held, .. }) if held == run_id => (false, Ok(())),
            Some(TurnHolder::Run { .. } | TurnHolder::Command) => (false, Err(TurnHeld)),
        })?;
        // A rebind onto another session leaves the turn it held there.
        if let Some((bound_session, _)) = tables.bindings.insert(run_id, (session_id, binding_id))
            && bound_session != session_id
        {
            tables.release_run(bound_session, run_id);
        }
        Ok(())
    }

    /// Gives a run the session's turn again on the binding it already holds, as a paused run's
    /// next turn does. Fails with [`HoldAgainRefusal::NoBinding`] for a run the routes hold no
    /// binding for, and [`HoldAgainRefusal::TurnHeld`] when another run or a command holds it.
    pub(crate) fn hold_turn_again(&self, run_id: RunId) -> Result<(), HoldAgainRefusal> {
        let mut tables = self.lock();
        let Some(&(session_id, _)) = tables.bindings.get(&run_id) else {
            return Err(HoldAgainRefusal::NoBinding);
        };
        tables.change_turn(session_id, |state| match state.holder {
            None => {
                state.holder = Some(TurnHolder::Run {
                    run_id,
                    is_carried: false,
                });
                (true, Ok(()))
            }
            Some(TurnHolder::Run { run_id: held, .. }) if held == run_id => (false, Ok(())),
            Some(TurnHolder::Run { .. } | TurnHolder::Command) => {
                (false, Err(HoldAgainRefusal::TurnHeld))
            }
        })
    }

    /// Holds the session's turn for a command Claude Code runs as a turn of its own; the turn's
    /// settlement releases it. Fails with [`TurnHeld`] when a run holds it.
    pub(crate) fn hold_turn_for_command(&self, session_id: SessionId) -> Result<(), TurnHeld> {
        self.lock()
            .change_turn(session_id, |state| match state.holder {
                None => {
                    state.holder = Some(TurnHolder::Command);
                    (true, Ok(()))
                }
                Some(TurnHolder::Command) => (false, Ok(())),
                Some(TurnHolder::Run { .. }) => (false, Err(TurnHeld)),
            })
    }

    /// Releases a command's hold whose text never reached Claude Code.
    pub(crate) fn release_command_turn(&self, session_id: SessionId) {
        self.lock()
            .change_turn(session_id, |state| match state.holder {
                Some(TurnHolder::Command) => {
                    state.holder = None;
                    (true, ())
                }
                Some(TurnHolder::Run { .. }) | None => (false, ()),
            });
    }

    /// Keeps a run holding its session's turn through the turn's settlement, into the next turn;
    /// a run that holds no turn is left as it is.
    pub(crate) fn carry_turn_over(&self, run_id: RunId) {
        let mut tables = self.lock();
        let Some(&(session_id, _)) = tables.bindings.get(&run_id) else {
            return;
        };
        tables.change_turn(session_id, |state| match &mut state.holder {
            Some(TurnHolder::Run {
                run_id: held,
                is_carried,
            }) if *held == run_id => {
                *is_carried = true;
                (false, ())
            }
            Some(TurnHolder::Run { .. } | TurnHolder::Command) | None => (false, ()),
        });
    }

    /// Drops one run's turn hold, its carry with it; its binding stays until the run ends.
    pub(crate) fn unbind_run(&self, run_id: RunId) {
        let mut tables = self.lock();
        if let Some(&(session_id, _)) = tables.bindings.get(&run_id) {
            tables.release_run(session_id, run_id);
        }
    }

    /// Forgets an ended run: its turn hold and its binding.
    pub(crate) fn forget_run(&self, run_id: RunId) {
        let mut tables = self.lock();
        if let Some((session_id, _)) = tables.bindings.remove(&run_id) {
            tables.release_run(session_id, run_id);
        }
    }

    /// The run holding this session's turn with its binding, or `None` when none holds it.
    pub(crate) fn lead_run_on(&self, session_id: SessionId) -> Option<ClaudeBoundRun> {
        let tables = self.lock();
        let holder = tables.turns.get(&session_id)?.borrow().holder;
        let Some(TurnHolder::Run { run_id, .. }) = holder else {
            return None;
        };
        let (_, binding_id) = tables.bindings.get(&run_id)?;
        Some(ClaudeBoundRun {
            run_id,
            binding_id: binding_id.clone(),
        })
    }

    /// Every lead run bound to the session, with its binding, whether or not it holds the turn.
    pub(crate) fn bound_runs_on(&self, session_id: SessionId) -> Vec<ClaudeBoundRun> {
        self.lock()
            .bindings
            .iter()
            .filter(|(_, (bound, _))| *bound == session_id)
            .map(|(run_id, (_, binding_id))| ClaudeBoundRun {
                run_id: *run_id,
                binding_id: binding_id.clone(),
            })
            .collect()
    }

    /// Where `run_id` is routed, or `None` for a run the routes do not hold.
    pub(crate) fn route_of(&self, run_id: RunId) -> Option<ClaudeRunRoute> {
        let tables = self.lock();
        if let Some((session_id, binding_id)) = tables.bindings.get(&run_id) {
            return Some(ClaudeRunRoute::Lead {
                session_id: *session_id,
                binding_id: binding_id.clone(),
            });
        }
        if let Some(child) = tables.children.get(&run_id) {
            return Some(ClaudeRunRoute::Child(child.clone()));
        }
        tables
            .apart_stops
            .contains_key(&run_id)
            .then_some(ClaudeRunRoute::Apart)
    }

    /// Drops the session's turn hold as its turn settles, a command's included, but a run's that
    /// carries over into the next turn, which keeps it uncarried; bindings stay.
    pub(crate) fn settle_turn_holds(&self, session_id: SessionId) {
        self.lock()
            .change_turn(session_id, |state| match &mut state.holder {
                Some(TurnHolder::Run { is_carried, .. }) if *is_carried => {
                    *is_carried = false;
                    (false, ())
                }
                Some(TurnHolder::Run { .. } | TurnHolder::Command) => {
                    state.holder = None;
                    (true, ())
                }
                None => (false, ()),
            });
    }

    /// Drops the session's turn hold, a command's and a carried run's included; bindings stay.
    pub(crate) fn retire_run_routes(&self, session_id: SessionId) {
        self.lock()
            .change_turn(session_id, |state| match state.holder {
                Some(_) => {
                    state.holder = None;
                    (true, ())
                }
                None => (false, ()),
            });
    }

    /// Forgets every run binding on a closed session, whose runs can deliver nothing more, and its
    /// turn where nothing holds it; a turn still held is left to its release.
    pub(crate) fn forget_session_bindings(&self, session_id: SessionId) {
        let mut tables = self.lock();
        tables.bindings.retain(|_, (bound, _)| *bound != session_id);
        if let Entry::Occupied(turn) = tables.turns.entry(session_id)
            && turn.get().borrow().holder.is_none()
        {
            turn.remove();
        }
    }

    /// Binds a helper's child run to its session and the agent id Claude Code gave it.
    pub(crate) fn bind_child_run(&self, run_id: RunId, route: ClaudeChildRunRoute) {
        self.lock().children.insert(run_id, route);
        self.child_bound.notify_waiters();
    }

    /// The child run of the helper Claude Code named `agent_id` on a session, waiting for its
    /// binding when the helper's frames came ahead of it; dropping the future ends the wait.
    pub(crate) async fn bound_child_run_for(&self, session_id: SessionId, agent_id: &str) -> RunId {
        loop {
            let bound = self.child_bound.notified();
            pin!(bound);
            // Registered before the read, so a binding between the two still wakes it.
            bound.as_mut().enable();
            if let Some(run_id) = self.child_run_for(session_id, agent_id) {
                return run_id;
            }
            bound.await;
        }
    }

    /// Drops a child run's route once its helper ended.
    pub(crate) fn retire_child_run(&self, run_id: RunId) {
        self.lock().children.remove(&run_id);
    }

    /// The child run of the helper Claude Code named `agent_id` on a session, if one is bound.
    pub(crate) fn child_run_for(&self, session_id: SessionId, agent_id: &str) -> Option<RunId> {
        self.lock()
            .children
            .iter()
            .find(|(_, route)| route.session_id == session_id && route.agent_id == agent_id)
            .map(|(run_id, _)| *run_id)
    }

    /// The child run of the helper Claude Code named `agent_id` on a session and its route, if one
    /// is bound.
    pub(crate) fn child_route_for(
        &self,
        session_id: SessionId,
        agent_id: &str,
    ) -> Option<(RunId, ClaudeChildRunRoute)> {
        self.lock()
            .children
            .iter()
            .find(|(_, route)| route.session_id == session_id && route.agent_id == agent_id)
            .map(|(run_id, route)| (*run_id, route.clone()))
    }

    /// Whether a helper of the session still has its child run bound, so it has not ended.
    pub(crate) fn has_child_run_on(&self, session_id: SessionId) -> bool {
        self.lock()
            .children
            .values()
            .any(|route| route.session_id == session_id)
    }

    /// Every helper's child run bound on the session, with the binding it is attributed on.
    pub(crate) fn child_runs_on(&self, session_id: SessionId) -> Vec<ClaudeBoundRun> {
        self.lock()
            .children
            .iter()
            .filter(|(_, route)| route.session_id == session_id)
            .map(|(run_id, route)| ClaudeBoundRun {
                run_id: *run_id,
                binding_id: route.binding_id.clone(),
            })
            .collect()
    }

    /// Drops every child route on a session whose process is gone; its helpers went with it.
    pub(crate) fn retire_child_routes(&self, session_id: SessionId) {
        self.lock()
            .children
            .retain(|_, route| route.session_id != session_id);
    }

    /// Binds a run apart from its session's process to how it is stopped, until its turn ends.
    pub(crate) fn bind_apart_run(&self, run_id: RunId, stop: ClaudeApartRunStop) {
        self.lock().apart_stops.insert(run_id, stop);
    }

    /// Drops an apart run's route once its turn ended.
    pub(crate) fn forget_apart_run(&self, run_id: RunId) {
        self.lock().apart_stops.remove(&run_id);
    }

    /// Stops a run bound apart from its session's process, answering `false` for any other run;
    /// `is_end_written` as [`ClaudeApartRunStop`] takes it.
    pub(crate) fn stop_apart_run(&self, run_id: RunId, is_end_written: bool) -> bool {
        // Taken out under the lock and called after it, so the stop may reach the routes again.
        let stop = self.lock().apart_stops.remove(&run_id);
        stop.map(|stop| stop(is_end_written)).is_some()
    }

    fn lock(&self) -> MutexGuard<'_, RouteTables> {
        self.tables
            .lock()
            .expect("the run routes' lock is never held across a panic")
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
    use sidekicks_contracts::run::id::RunId;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::wire::id::mint_uuid_v7;

    use super::{ClaudeRunRoutes, TurnHeld};

    fn binding() -> RuntimeBindingId {
        RuntimeBindingId::new("binding".to_owned()).expect("a binding id")
    }

    fn run() -> RunId {
        RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id")
    }

    fn session() -> SessionId {
        SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id")
    }

    // Killed by a carry that lasts past one settlement, by `unbind_run` keeping the carry, and by a
    // second run taking a held turn.
    #[test]
    fn a_carried_run_keeps_the_turn_through_one_settlement_only() {
        let routes = ClaudeRunRoutes::default();
        let session = session();
        let (lead, other) = (run(), run());
        routes
            .hold_turn(lead, session, binding())
            .expect("the turn is free");
        assert_eq!(routes.hold_turn(other, session, binding()), Err(TurnHeld));

        routes.carry_turn_over(lead);
        routes.settle_turn_holds(session);
        assert_eq!(routes.hold_turn(other, session, binding()), Err(TurnHeld));
        routes.settle_turn_holds(session);
        assert_eq!(routes.hold_turn(other, session, binding()), Ok(()));

        routes.carry_turn_over(other);
        routes.unbind_run(other);
        routes
            .hold_turn(lead, session, binding())
            .expect("the unbound run's carry went with its hold");
        routes.settle_turn_holds(session);
        assert_eq!(routes.hold_turn(other, session, binding()), Ok(()));
    }

    const DEADLINE: Duration = Duration::from_secs(60);

    // Killed by an end-written note that counts nothing, by a waiter that reads the count when it
    // starts to wait instead of its mark, by a waiter that reads only the holder (a release a new
    // hold follows at once would leave it waiting), and by a waiter that never gives up at its
    // deadline.
    #[tokio::test(start_paused = true)]
    async fn a_change_waiter_wakes_on_a_change_after_its_mark_and_gives_up_at_its_deadline() {
        let routes = ClaudeRunRoutes::default();
        let session = session();
        let (first, second) = (run(), run());
        routes
            .hold_turn(first, session, binding())
            .expect("the turn is free");
        let before = routes.turn_mark(session);
        routes.note_run_end_written(session);
        assert!(
            routes
                .when_turn_changed_after(session, before, DEADLINE)
                .await,
            "the note is a change after the mark"
        );

        let after = routes.turn_mark(session);
        assert!(
            !routes
                .when_turn_changed_after(session, after, DEADLINE)
                .await,
            "nothing changed after the second mark"
        );
        let changed = routes.when_turn_changed_after(session, after, DEADLINE);
        let hand_over = async {
            tokio::task::yield_now().await;
            routes.unbind_run(first);
            routes
                .hold_turn(second, session, binding())
                .expect("the turn was released");
        };
        let (is_changed, ()) = tokio::join!(changed, hand_over);
        assert!(is_changed, "a release a new hold follows is a change");
    }

    // One turn entry per session whose turn was held, and none once the session is forgotten,
    // whatever reads or releases its turn after. Killed by a mark, a wait or a release that keeps
    // an entry for a forgotten session, and by a wait on a forgotten session that sleeps to its
    // deadline instead of answering at once.
    #[tokio::test(start_paused = true)]
    async fn a_forgotten_session_keeps_no_turn_entry() {
        let routes = ClaudeRunRoutes::default();
        let (session, other) = (session(), session());
        let lead = run();
        routes
            .hold_turn(lead, session, binding())
            .expect("the turn is free");
        routes
            .hold_turn(run(), other, binding())
            .expect("the other session's turn is free");
        assert_eq!(routes.lock().turns.len(), 2);

        routes.unbind_run(lead);
        routes.forget_session_bindings(session);
        let mark = routes.turn_mark(session);
        assert!(
            routes
                .when_turn_changed_after(session, mark, DEADLINE)
                .await
        );
        routes.note_run_end_written(session);
        routes.settle_turn_holds(session);
        routes.retire_run_routes(session);

        assert_eq!(mark, 0);
        assert_eq!(routes.lock().turns.len(), 1);
        assert!(!routes.lock().turns.contains_key(&session));
    }
}
