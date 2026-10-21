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
use tokio::sync::watch;

/// Where a helper's child run lives: its session, the agent id its frames and hook callbacks
/// carry, the lead run it was started beneath, and the binding the lead's process is attributed
/// on.
#[derive(Clone, Debug, PartialEq, Eq)]
#[expect(
    clippy::struct_field_names,
    reason = "each field is an id, named as every id field in the daemon is"
)]
pub(crate) struct ClaudeChildRunRoute {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The helper's agent id, as Claude Code gave it.
    pub(crate) agent_id: String,
    /// The lead run it was started beneath.
    pub(crate) parent_run_id: RunId,
    /// The binding the lead's process is attributed on.
    pub(crate) binding_id: RuntimeBindingId,
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

/// A session's turn: its holder, and how many times it was released, so a waiter wakes on each
/// release even when a new hold follows at once.
#[derive(Debug, Default)]
struct TurnState {
    holder: Option<TurnHolder>,
    releases: u64,
}

impl TurnState {
    fn release(&mut self) {
        self.holder = None;
        self.releases += 1;
    }
}

#[derive(Default)]
struct RouteTables {
    turns: HashMap<SessionId, watch::Sender<TurnState>>,
    bindings: HashMap<RunId, (SessionId, RuntimeBindingId)>,
    children: HashMap<RunId, ClaudeChildRunRoute>,
    apart_stops: HashMap<RunId, ClaudeApartRunStop>,
}

impl RouteTables {
    fn turn(&mut self, session_id: SessionId) -> &watch::Sender<TurnState> {
        self.turns
            .entry(session_id)
            .or_insert_with(|| watch::Sender::new(TurnState::default()))
    }

    // Changes the session's turn where `change` says it did, answering what `change` answers; a
    // session never held answers as a free turn would.
    fn change_turn<T>(
        &mut self,
        session_id: SessionId,
        change: impl FnOnce(&mut TurnState) -> (bool, T),
    ) -> T {
        let mut answer = None;
        self.turn(session_id).send_if_modified(|state| {
            let (is_changed, outcome) = change(state);
            answer = Some(outcome);
            is_changed
        });
        answer.expect("send_if_modified calls its closure once")
    }

    // Releases the session's turn where `run_id` holds it.
    fn release_run(&mut self, session_id: SessionId, run_id: RunId) {
        self.change_turn(session_id, |state| match state.holder {
            Some(TurnHolder::Run { run_id: held, .. }) if held == run_id => {
                state.release();
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
}

impl ClaudeRunRoutes {
    /// Answers `true` once nothing holds the session's turn or it was released since the call, at
    /// once when nothing holds it, or `false` when `deadline` passes first. A release followed at
    /// once by a new hold still answers `true`; the caller's next hold may then be refused.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the Claude driver's run start waits on the turn through it"
        )
    )]
    pub(crate) async fn when_turn_released(
        &self,
        session_id: SessionId,
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
        let seen = receiver.borrow_and_update().releases;
        let released = receiver.wait_for(|state| state.holder.is_none() || state.releases > seen);
        match tokio::time::timeout(deadline, released).await {
            // A closed turn is a session gone, which holds nothing.
            Ok(Ok(_) | Err(_)) => true,
            Err(_elapsed) => false,
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
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the Claude driver's command dispatch holds the turn through it"
        )
    )]
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
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the Claude driver's command dispatch releases a failed write"
        )
    )]
    pub(crate) fn release_command_turn(&self, session_id: SessionId) {
        self.lock()
            .change_turn(session_id, |state| match state.holder {
                Some(TurnHolder::Command) => {
                    state.release();
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
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the Claude driver settles each turn's hold through it"
        )
    )]
    pub(crate) fn settle_turn_holds(&self, session_id: SessionId) {
        self.lock()
            .change_turn(session_id, |state| match &mut state.holder {
                Some(TurnHolder::Run { is_carried, .. }) if *is_carried => {
                    *is_carried = false;
                    (false, ())
                }
                Some(TurnHolder::Run { .. } | TurnHolder::Command) => {
                    state.release();
                    (true, ())
                }
                None => (false, ()),
            });
    }

    /// Drops the session's turn hold, a command's and a carried run's included; bindings stay.
    #[expect(
        dead_code,
        reason = "the Claude driver retires a superseded or closing session's turn through it"
    )]
    pub(crate) fn retire_run_routes(&self, session_id: SessionId) {
        self.lock()
            .change_turn(session_id, |state| match state.holder {
                Some(_) => {
                    state.release();
                    (true, ())
                }
                None => (false, ()),
            });
    }

    /// Forgets every run binding on a closed session, whose runs can deliver nothing more, and its
    /// turn where nothing holds it; a turn still held is left to its release.
    #[expect(
        dead_code,
        reason = "the Claude driver forgets a closed session's routes through it"
    )]
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

    /// Drops every child route on a session whose process is gone; its helpers went with it.
    #[expect(
        dead_code,
        reason = "the Claude driver drops an ended process's helpers through it"
    )]
    pub(crate) fn retire_child_routes(&self, session_id: SessionId) {
        self.lock()
            .children
            .retain(|_, route| route.session_id != session_id);
    }

    /// Binds a run apart from its session's process to how it is stopped, until its turn ends.
    #[expect(
        dead_code,
        reason = "the Claude driver's staged-changes review binds its run so"
    )]
    pub(crate) fn bind_apart_run(&self, run_id: RunId, stop: ClaudeApartRunStop) {
        self.lock().apart_stops.insert(run_id, stop);
    }

    /// Drops an apart run's route once its turn ended.
    #[expect(
        dead_code,
        reason = "the Claude driver's staged-changes review drops its run so"
    )]
    pub(crate) fn forget_apart_run(&self, run_id: RunId) {
        self.lock().apart_stops.remove(&run_id);
    }

    /// Stops a run bound apart from its session's process, answering `false` for any other run;
    /// `is_end_written` as [`ClaudeApartRunStop`] takes it.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the Claude driver's stop reaches an apart run through it"
        )
    )]
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

    use super::{ClaudeRunRoutes, TurnHeld};
    use sidekicks_contracts::wire::id::mint_uuid_v7;

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

    // Killed by a waiter that reads only the holder (a release a new hold follows at once would
    // leave it waiting), and by a waiter that never gives up at its deadline.
    #[tokio::test(start_paused = true)]
    async fn a_waiter_wakes_on_each_release_and_gives_up_at_its_deadline() {
        let routes = ClaudeRunRoutes::default();
        let session = session();
        let (first, second) = (run(), run());
        routes
            .hold_turn(first, session, binding())
            .expect("the turn is free");

        let released = routes.when_turn_released(session, Duration::from_secs(60));
        let hand_over = async {
            tokio::task::yield_now().await;
            routes.unbind_run(first);
            routes
                .hold_turn(second, session, binding())
                .expect("the turn was released");
        };
        let (is_released, ()) = tokio::join!(released, hand_over);
        assert!(is_released);

        assert!(
            !routes
                .when_turn_released(session, Duration::from_secs(60))
                .await
        );
    }
}
