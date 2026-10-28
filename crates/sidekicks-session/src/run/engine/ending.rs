//! A run's end and what it lets go: the terminal write kept in flight for whoever waits on it, the
//! engine's own hold of the run forgotten, the run queue's holds of the interrupts it settled let
//! go and the terminal hooks run.

use std::sync::{Arc, Mutex};

use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::events::session::append_lock::SessionAppendHold;
use sidekicks_workspace::run_setup_gates::RunTerminalContext;
use tokio::sync::SetOnce;

use crate::run::engine::live::{EndingWrite, LiveRuns, settle};
use crate::run::engine::{RunEngine, RunEngineError, settled};
use crate::run::read::RunRead;
use crate::run::state_change::{RunStateChange, RunStateChangeCompanions};

impl RunEngine {
    /// Writes `change`, under `hold` where the caller holds the run's session. A terminal is kept
    /// in flight for a continue to wait on and carries the settle of every intervention left with
    /// no outcome on the run; once it has committed, the run queue's holds of the interrupts it
    /// settled go and the terminal hooks run, every failure returned after all have run, with the
    /// end kept. A move to `running` and an end, once written, wake whoever waits for the run to
    /// read `running` again.
    pub(super) async fn change(
        &self,
        change: RunStateChange,
        companions: RunStateChangeCompanions,
        hold: Option<&SessionAppendHold>,
    ) -> Result<RunRead, RunEngineError> {
        let run_id = change.run_id;
        let to_state = RunState::from(change.entry.state());
        if !to_state.is_terminal() {
            let written = self.changes.write(change, companions, hold).await?;
            if to_state == RunState::Running {
                self.wake_running_waiters(&run_id);
            }
            return Ok(written);
        }
        // In flight before the settle reads the rows, so a dispatch that answers nothing after
        // that read waits for this end and settles its own row.
        let ending = self.track_ending(run_id);
        let written = self.write_run_end(change, companions, hold).await;
        drop(ending);
        let (run, released_choices) = written?;
        self.forget_ended_run(&run_id);
        self.wake_running_waiters(&run_id);
        let released = self.release_interrupt_holds(run_id, released_choices).await;
        let hooks = self
            .gates
            .release_for_terminal(
                &RunTerminalContext {
                    run_id,
                    session_id: run.session_id,
                    terminal_state: run.state,
                    run_version: run.version,
                },
                hold,
            )
            .await
            .map_err(RunEngineError::from);
        settled(
            vec![released, hooks],
            "ending a run and letting go what it held",
        )?;
        Ok(run)
    }

    /// Waits until every terminal write of `run_id` in flight now has landed or been refused.
    pub(super) async fn wait_for_ending_writes(&self, run_id: &RunId) {
        let mut next = lock(&self.live).ending.get(run_id).cloned();
        while let Some(write) = next.take() {
            write.landed.wait().await;
            next.clone_from(&write.previous);
        }
    }

    // Keeps a terminal write of `run_id` in flight, after any before it, until the guard drops.
    fn track_ending(&self, run_id: RunId) -> EndingGuard<'_> {
        let mut live = lock(&self.live);
        let entry = Arc::new(EndingWrite {
            previous: live.ending.get(&run_id).cloned(),
            landed: SetOnce::new(),
        });
        live.ending.insert(run_id, Arc::clone(&entry));
        EndingGuard {
            live: &self.live,
            run_id,
            entry,
        }
    }

    // What the engine held for a run that has ended. A cut stays until its turn's end is written,
    // which its provider can report after the run's end.
    fn forget_ended_run(&self, run_id: &RunId) {
        let mut live = lock(&self.live);
        live.carried_output_speeds.remove(run_id);
        live.step_counts.remove(run_id);
        live.reached_limits
            .retain(|(reached_run_id, _)| reached_run_id != run_id);
        live.mark_starting_run_ended(run_id);
    }
}

// Lands a terminal write's link on every exit path of the write, its future dropped included,
// since a write once queued is not withdrawn.
struct EndingGuard<'engine> {
    // The engine's live runs.
    live: &'engine Mutex<LiveRuns>,
    // The run being ended.
    run_id: RunId,
    // The write's link.
    entry: Arc<EndingWrite>,
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
                pending.clone_from(&write.previous);
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

#[cfg(test)]
mod tests {
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::Duration;

    use sidekicks_contracts::run::id::RunId;
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use sidekicks_std::mutex_lock::lock;
    use tokio::sync::SetOnce;

    use super::EndingGuard;
    use crate::run::engine::live::{EndingWrite, LiveRuns};

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
