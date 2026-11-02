//! The run side of an undo's conversation cut: the forward `agent.run.rolledBack` of each run a cut
//! the provider confirmed reaches, all in one write, each advancing its run's version, opening a new
//! execution epoch, and moving the run through no state.

#[cfg(test)]
mod tests;

use sidekicks_contracts::event::envelope::SourcePosition;
use sidekicks_contracts::run::control::AgentRunRolledBackEvent;
use sidekicks_contracts::run::id::RunId;
use sidekicks_store::events::session::append_lock::SessionAppendHold;

use crate::run::engine::RunEngine;
use crate::run::engine::errors::RunEngineError;
use crate::run::read::RunRead;
use crate::run::state_change::{RunStateChangeCompanions, rolled_back_event};

/// One run a conversation cut reaches, and the turn boundary its conversation lands at: every turn
/// of the run past that position leaves the conversation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RunCut {
    /// The run.
    pub run_id: RunId,
    /// The last turn position kept.
    pub target_position: SourcePosition,
}

/// A rollback written: its event and the run as it left it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunRollback {
    /// The `agent.run.rolledBack` written.
    pub event: AgentRunRolledBackEvent,
    /// The run after the rollback, at its new version and in the state it was in.
    pub run: RunRead,
}

impl RunEngine {
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
    /// [`TurnOpen`]: crate::run::state_change::RunStateChangeError::TurnOpen
    /// [`CompanionRefused`]: crate::run::state_change::RunStateChangeError::CompanionRefused
    pub async fn roll_back(
        &self,
        cut: RunCut,
        later_cuts: Vec<RunCut>,
        companions: RunStateChangeCompanions,
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
