//! What the engine holds per live run, under one lock never held across an await: the runs no
//! driver has yet, the runs being continued, the terminal writes in flight, and what a live run's
//! turn carries; and the guards that settle each entry on every exit path.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use sidekicks_contracts::agent::definition::binding::ProviderToken;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::RunLimit;
use sidekicks_contracts::wire::integer::SafeInt;
use tokio::sync::{SetOnce, SetOnceError};

use crate::session::run::engine::turns::StepCount;

/// A run no driver has yet, from `starting` until the driver has it or the run ends. It is
/// claimable while its setup gates run and after a start that left it live without a driver, and
/// settling from the gates' end until its start settles, when an interrupt waits for `settled`. The
/// flags are atomics because the start and every call routed around it share the entry, which
/// stays theirs after it leaves the map.
pub(super) struct StartingRun {
    /// Set from the entry's insert until the gates end, and again once a start leaves the run
    /// live without a driver.
    pub(super) is_claimable: AtomicBool,
    /// Whether an interrupt claimed the run.
    pub(super) is_interrupted: AtomicBool,
    /// Set by the run's end while the entry is in the map.
    pub(super) has_ended: AtomicBool,
    /// Whether the driver has the run, once the start has settled and its `running` write landed.
    pub(super) settled: SetOnce<bool>,
}

impl StartingRun {
    /// Whether an interrupt may claim the run at once.
    pub(super) fn is_claimable(&self) -> bool {
        self.is_claimable.load(Ordering::Acquire)
    }

    /// Whether the run ended while no driver had it.
    pub(super) fn has_ended(&self) -> bool {
        self.has_ended.load(Ordering::Acquire)
    }
}

/// An interrupted run being continued, until its `running` write landed or its continue failed.
pub(super) struct ContinuingRun {
    /// Whether its next turn has started: once the driver started it, or at once when the provider
    /// started it.
    pub(super) is_turn_started: AtomicBool,
    /// Set once the continue has settled.
    pub(super) settled: SetOnce<()>,
}

/// One terminal write of a run, in flight until it lands or is refused, linked to the one before it
/// that was still in flight when it began, so a waiter reads every end written before it.
pub(super) struct EndingWrite {
    /// The write before it still in flight when it began.
    pub(super) previous: Option<Arc<EndingWrite>>,
    /// Set once the write has landed or been refused.
    pub(super) landed: SetOnce<()>,
}

/// A limit stop's cut of a turn: the limit, and the run version the stop read before it wrote.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct LimitCut {
    /// The limit that cut the turn.
    pub(super) limit: RunLimit,
    /// The run version the stop read.
    pub(super) run_version: i64,
}

/// Every map is bounded by the live runs: an entry leaves when its run, its start, its continue,
/// its write or its turn ends, on every exit path. The cuts are bounded by one cut per open cut
/// turn, each leaving when its own turn's end is written, so it can outlive its run's end until
/// then; a provider process's exit and a restart's settle end every open turn of the run.
#[derive(Default)]
pub(super) struct LiveRuns {
    /// The runs no driver has yet.
    pub(super) starting: HashMap<RunId, Arc<StartingRun>>,
    /// The interrupted runs being continued.
    pub(super) continuing: HashMap<RunId, Arc<ContinuingRun>>,
    /// The newest terminal write in flight of each run.
    pub(super) ending: HashMap<RunId, Arc<EndingWrite>>,
    /// The fast output level each started run carried, until its settled state is reported or it
    /// ends.
    pub(super) carried_output_speeds: HashMap<RunId, ProviderToken>,
    /// The open turn's steps on a run whose provider does not bound them.
    pub(super) step_counts: HashMap<RunId, StepCount>,
    /// Each turn a limit stop cut, by run and turn number, from before its reached event is
    /// written until that turn's end is written.
    pub(super) cut_turns: HashMap<(RunId, SafeInt<1>), LimitCut>,
    /// Each run's limits whose reached event is being written or landed while their interrupt is
    /// not yet handed to the interventions service, so a stop retried at that limit sends the
    /// interrupt alone; one leaves when its interrupt is handed, its write is refused or its run
    /// ends, the step limit's also with its turn.
    pub(super) reached_limits: HashSet<(RunId, RunLimit)>,
}

impl LiveRuns {
    /// Removes `own` from `map` only while it is still the entry for `run_id`: a start, continue
    /// or write that settled leaves its own entry only, so a newer one for the same run is never
    /// removed by an older one.
    pub(super) fn remove_own<Entry>(
        map: &mut HashMap<RunId, Arc<Entry>>,
        run_id: &RunId,
        own: &Arc<Entry>,
    ) {
        if map
            .get(run_id)
            .is_some_and(|current| Arc::ptr_eq(current, own))
        {
            map.remove(run_id);
        }
    }

    /// The newest turn of `run_id` that `limit` cut, by a stop that read the run at or before
    /// `run_version`, whose end is not yet written.
    pub(super) fn newest_cut_turn(
        &self,
        run_id: &RunId,
        limit: RunLimit,
        run_version: i64,
    ) -> Option<SafeInt<1>> {
        self.cut_turns
            .iter()
            .filter(|((cut_run_id, _), cut)| {
                cut_run_id == run_id && cut.limit == limit && cut.run_version <= run_version
            })
            .map(|((_, turn_number), _)| *turn_number)
            .max()
    }

    /// Puts `earlier` back as the cut of `turn_number` on `run_id` only while the key still holds
    /// `own`, so a stop that cut nothing never undoes a later stop's cut or one its turn's end
    /// removed.
    pub(super) fn restore_cut(
        &mut self,
        key: (RunId, SafeInt<1>),
        own: LimitCut,
        earlier: Option<LimitCut>,
    ) {
        if self.cut_turns.get(&key) != Some(&own) {
            return;
        }
        match earlier {
            Some(earlier) => {
                self.cut_turns.insert(key, earlier);
            }
            None => {
                self.cut_turns.remove(&key);
            }
        }
    }

    /// Marks a run that ended while no driver has it: an entry still settling learns it ended; a
    /// claimable one has nothing left to claim.
    pub(super) fn mark_starting_run_ended(&mut self, run_id: &RunId) {
        if let Some(starting) = self.starting.get(run_id) {
            starting.has_ended.store(true, Ordering::Release);
            if starting.is_claimable() {
                self.starting.remove(run_id);
            }
        }
    }
}

/// Settles a start's entry on every exit path of the start, its future dropped included: the entry
/// leaves once the driver has the run or the run ended, and stays claimable otherwise.
pub(super) struct StartingGuard<'engine> {
    /// The engine's live runs.
    pub(super) live: &'engine Mutex<LiveRuns>,
    /// The run being started.
    pub(super) run_id: RunId,
    /// The start's entry.
    pub(super) entry: Arc<StartingRun>,
    /// Whether the driver has the run.
    pub(super) has_driver_run: bool,
}

impl Drop for StartingGuard<'_> {
    fn drop(&mut self) {
        {
            let mut live = lock(self.live);
            if self.has_driver_run || self.entry.has_ended() {
                LiveRuns::remove_own(&mut live.starting, &self.run_id, &self.entry);
            } else {
                // A run left live without a driver stays for an interrupt to claim, until its end.
                self.entry.is_claimable.store(true, Ordering::Release);
            }
        }
        settle(&self.entry.settled, self.has_driver_run);
    }
}

/// Settles a continue's entry on every exit path of the continue.
pub(super) struct ContinuingGuard<'engine> {
    /// The engine's live runs.
    pub(super) live: &'engine Mutex<LiveRuns>,
    /// The run being continued.
    pub(super) run_id: RunId,
    /// The continue's entry.
    pub(super) entry: Arc<ContinuingRun>,
}

impl Drop for ContinuingGuard<'_> {
    fn drop(&mut self) {
        LiveRuns::remove_own(&mut lock(self.live).continuing, &self.run_id, &self.entry);
        settle(&self.entry.settled, ());
    }
}

/// Lands a terminal write's link on every exit path of the write, its future dropped included,
/// since a write once queued is not withdrawn.
pub(super) struct EndingGuard<'engine> {
    /// The engine's live runs.
    pub(super) live: &'engine Mutex<LiveRuns>,
    /// The run being ended.
    pub(super) run_id: RunId,
    /// The write's link.
    pub(super) entry: Arc<EndingWrite>,
}

impl EndingGuard<'_> {
    // Lands the write and steps the run's entry back, under the held lock `live`, so a newer
    // write's guard walking back never puts this one back once this guard has run.
    fn land(&self, live: &mut LiveRuns) {
        settle(&self.entry.landed, ());
        if live
            .ending
            .get(&self.run_id)
            .is_some_and(|current| Arc::ptr_eq(current, &self.entry))
        {
            // An older write still in flight stays for a waiter: the newest that has not landed
            // takes this one's place, and its own guard clears it once it lands.
            let mut pending = self.entry.previous.clone();
            while let Some(write) = pending.clone().filter(|write| write.landed.initialized()) {
                pending = write.previous.clone();
            }
            match pending {
                Some(write) => {
                    live.ending.insert(self.run_id, write);
                }
                None => {
                    live.ending.remove(&self.run_id);
                }
            }
        }
    }
}

impl Drop for EndingGuard<'_> {
    fn drop(&mut self) {
        self.land(&mut lock(self.live));
    }
}

// Sets an entry's settlement from its guard. Each entry has one guard and a guard drops once, so
// the settlement is empty here; were it set, the first settlement would stand and `value` is
// dropped.
fn settle<Value>(settlement: &SetOnce<Value>, value: Value) {
    if let Err(SetOnceError(later)) = settlement.set(value) {
        drop(later);
    }
}

/// Locks the live runs. The map holds whole entries only, so a panic elsewhere leaves nothing half
/// written, and a poisoned lock is taken as it is.
pub(super) fn lock(live: &Mutex<LiveRuns>) -> MutexGuard<'_, LiveRuns> {
    live.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::Duration;

    use sidekicks_contracts::run::id::RunId;
    use tokio::sync::SetOnce;

    use super::{EndingGuard, EndingWrite, LiveRuns, lock};
    use crate::uuid_v7::mint_uuid_v7;

    // How long the live lock is held after the guard begins to drop, long enough for a guard that
    // lands its write before taking the lock to have landed it.
    const LOCK_HOLD: Duration = Duration::from_millis(200);

    // Killed by the guard landing its write before it holds the live lock, which lets a newer
    // write's guard walk past it while its map step is still to come.
    #[test]
    fn an_ending_write_lands_only_once_its_guard_holds_the_live_lock() {
        let live = Mutex::new(LiveRuns::default());
        let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
        let entry = Arc::new(EndingWrite {
            previous: None,
            landed: SetOnce::new(),
        });
        lock(&live).ending.insert(run_id, Arc::clone(&entry));
        let guard = EndingGuard {
            live: &live,
            run_id,
            entry: Arc::clone(&entry),
        };

        thread::scope(|scope| {
            let held = lock(&live);
            let (dropping, drop_begun) = mpsc::channel();
            let dropped = scope.spawn(move || {
                dropping.send(()).expect("the test waits for the drop");
                drop(guard);
            });
            drop_begun.recv().expect("the guard begins to drop");
            thread::sleep(LOCK_HOLD);
            assert!(
                !entry.landed.initialized(),
                "the write landed while another held the live lock"
            );
            drop(held);
            dropped.join().expect("the guard drops");
        });

        assert!(entry.landed.initialized());
        assert!(lock(&live).ending.is_empty());
    }
}
