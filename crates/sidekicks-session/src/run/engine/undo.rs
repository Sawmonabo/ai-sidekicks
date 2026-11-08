//! The run side of an undo's conversation cut: the check, read before the provider cuts, of every
//! condition the rollback's write refuses on; the forward `agent.run.rolledBack` of each run a cut
//! the provider confirmed reaches, all in one write, each advancing its run's version, opening a
//! new execution epoch, and moving the run through no state; and the mark that holds a turn
//! opening on the session back while that write is in progress.

#[cfg(test)]
mod tests;

use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use sidekicks_contracts::event::envelope::SourcePosition;
use sidekicks_contracts::run::control::AgentRunRolledBackEvent;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::events::session::append_lock::SessionAppendHold;
use tokio::sync::SetOnce;

use crate::run::engine::RunEngine;
use crate::run::engine::errors::RunEngineError;
use crate::run::engine::live::{LiveRuns, UndoWrite, settle};
use crate::run::read::{RunRead, RunStateReader};
use crate::run::state_change::{RunWriteCompanions, rolled_back_event};

/// One run a conversation cut reaches, and the run position its conversation lands at: every one
/// of the person's messages the run took past that position leaves the conversation, with what
/// followed it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RunCut {
    /// The run.
    pub run_id: RunId,
    /// The last run position kept.
    pub target_position: SourcePosition,
}

/// Reads, before the provider cuts, whether a statement of a rollback's companions would refuse its
/// write, answering [`RollbackCheckError::CompanionRefused`] for the first that would.
pub type RollbackCompanionCheck =
    Arc<dyn Fn(&Connection) -> Result<(), RollbackCheckError> + Send + Sync>;

/// What commits with an undo's rollback, held with the check of every condition its statements
/// refuse on, so no companion reaches the write unchecked. The default holds none and checks
/// nothing.
#[derive(Clone)]
pub struct RollbackCompanions {
    /// Committed in the rollback's write.
    pub write: RunWriteCompanions,
    /// Reads every condition a statement of `write` refuses on.
    pub check: RollbackCompanionCheck,
}

impl Default for RollbackCompanions {
    fn default() -> Self {
        Self {
            write: RunWriteCompanions::default(),
            check: Arc::new(|_| Ok(())),
        }
    }
}

/// Why the check before a conversation cut refused it; the provider was not asked.
#[derive(Debug, thiserror::Error)]
pub enum RollbackCheckError {
    /// A run the cut reaches holds a turn with no end, which must end before the cut.
    #[error("run {run_id} holds a turn with no end, so its conversation is not cut")]
    TurnOpen {
        /// The run.
        run_id: RunId,
    },
    /// A companion statement would refuse the rollback's write.
    #[error("companion statement {companion_index} of the rollback would refuse it")]
    CompanionRefused {
        /// The statement's position among the companions.
        companion_index: usize,
    },
    /// SQLite refused a read, or a stored column does not read as its type.
    #[error("the rollback's check could not read")]
    Database(#[from] rusqlite::Error),
}

/// Reads, before the provider is asked to cut, every condition the rollback of `cuts` in
/// `session_id` refuses on: a run it reaches holding a turn with no end, then the companions'
/// `check`. The write reads each run's version again and retries while a run moves, so no
/// version read here binds it. Called under the undo's hold; fails as [`RollbackCheckError`] says.
pub fn check_rollback(
    reader: &Connection,
    session_id: &SessionId,
    cuts: &[RunCut],
    check: &RollbackCompanionCheck,
) -> Result<(), RollbackCheckError> {
    let reached = |run_id: &RunId| cuts.iter().any(|cut| cut.run_id == *run_id);
    let runs = RunStateReader::new(reader);
    let live_open = runs
        .list_live_run_resumes(session_id)?
        .into_iter()
        .find(|run| reached(&run.run_id) && !run.open_turns.is_empty())
        .map(|run| run.run_id);
    let ended_open = runs
        .list_ended_runs_with_open_turns(Some(session_id))?
        .into_iter()
        .find(|run| reached(&run.run_id))
        .map(|run| run.run_id);
    if let Some(run_id) = live_open.or(ended_open) {
        return Err(RollbackCheckError::TurnOpen { run_id });
    }
    check(reader)
}

/// A rollback written: its event and the run as it left it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunRollback {
    /// The `agent.run.rolledBack` written.
    pub event: AgentRunRolledBackEvent,
    /// The run after the rollback, at its new version and in the state it was in.
    pub run: RunRead,
}

/// An undo's rollback write in progress on one session, from [`RunEngine::mark_undo_write`]: while
/// it is held, a turn opening on the session that meets it waits for it to drop and then opens,
/// never refused and never waiting on the provider's session task. Dropping it ends the write's
/// hold on every path, a failed write and a dropped future included.
#[must_use = "a turn opening waits for the write only while the mark is held"]
pub struct UndoWriteMark<'engine> {
    live: &'engine Mutex<LiveRuns>,
    session_id: SessionId,
    write: Arc<UndoWrite>,
}

impl Drop for UndoWriteMark<'_> {
    fn drop(&mut self) {
        {
            let mut live = lock(self.live);
            if let Some(writes) = live.undo_writes.get_mut(&self.session_id) {
                writes.retain(|write| !Arc::ptr_eq(write, &self.write));
                if writes.is_empty() {
                    live.undo_writes.remove(&self.session_id);
                }
            }
        }
        settle(&self.write.ended, ());
    }
}

impl RunEngine {
    /// Marks an undo's rollback write in progress on `session_id`, taken once the provider
    /// confirmed the cut and dropped once the write has ended, so a turn opening on the session
    /// that meets the mark opens after the rollback and cannot refuse it.
    pub fn mark_undo_write(&self, session_id: SessionId) -> UndoWriteMark<'_> {
        let write = Arc::new(UndoWrite {
            ended: SetOnce::new(),
        });
        lock(&self.live)
            .undo_writes
            .entry(session_id)
            .or_default()
            .push(Arc::clone(&write));
        UndoWriteMark {
            live: &self.live,
            session_id,
            write,
        }
    }

    /// Waits until the oldest undo's rollback write in progress on `session_id` has ended,
    /// answering whether there was one, so the caller reads its run again and waits out the next.
    pub(super) async fn wait_out_undo_write(&self, session_id: &SessionId) -> bool {
        let write = lock(&self.live)
            .undo_writes
            .get(session_id)
            .and_then(|writes| writes.first())
            .cloned();
        let Some(write) = write else {
            return false;
        };
        write.ended.wait().await;
        true
    }

    /// Records a cut the provider confirmed on the conversation as a forward
    /// `agent.run.rolledBack` of `cut`'s run and of each of `later_cuts`, the runs after it oldest
    /// first, in one write under `hold`, the session's append lock: each run's version advances by
    /// one whatever state it is in, and `companions` commit in the same write, their events before
    /// the rollbacks. A run that moved after it was read is read again and the write retried. The
    /// caller fences the cut once this returns (`RunBindingCursors::fence_cut`). Answers the
    /// rollbacks in the order the cuts were given. Fails with [`NotFound`] for an unknown run,
    /// [`VersionStale`] for one that kept moving, [`TurnOpen`] for one holding a turn with no end
    /// and [`CompanionRefused`] for a refusing companion statement; each refusal writes nothing.
    ///
    /// [`NotFound`]: crate::run::refusals::RunRefusal::NotFound
    /// [`VersionStale`]: crate::run::refusals::RunRefusal::VersionStale
    /// [`TurnOpen`]: crate::run::state_change::RunWriteError::TurnOpen
    /// [`CompanionRefused`]: crate::run::state_change::RunWriteError::CompanionRefused
    pub async fn roll_back(
        &self,
        cut: RunCut,
        later_cuts: Vec<RunCut>,
        companions: RunWriteCompanions,
        hold: &SessionAppendHold,
    ) -> Result<Vec<RunRollback>, RunEngineError> {
        let mut cuts = Vec::with_capacity(later_cuts.len() + 1);
        cuts.push(cut);
        cuts.extend(later_cuts);
        let runs = self
            .changes
            .roll_back(cuts.clone(), companions, hold)
            .await?;
        Ok(cuts
            .into_iter()
            .zip(runs)
            .map(|(cut, run)| RunRollback {
                event: rolled_back_event(cut.run_id, &run, cut.target_position),
                run,
            })
            .collect())
    }
}
