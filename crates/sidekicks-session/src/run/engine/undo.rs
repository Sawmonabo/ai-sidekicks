//! The run side of an undo's conversation cut: the forward `agent.run.rolledBack` a cut the
//! provider confirmed is recorded as, which advances the run's version, opening a new execution
//! epoch, and moves the run through no state.

#[cfg(test)]
mod tests;

use sidekicks_contracts::run::control::AgentRunRolledBackEvent;
use sidekicks_contracts::run::id::RunId;
use sidekicks_store::events::session::append_lock::SessionAppendHold;

use crate::run::engine::RunEngine;
use crate::run::engine::errors::RunEngineError;
use crate::run::epochs::ConfirmedCut;
use crate::run::read::RunRead;
use crate::run::state_change::{RunStateChangeCompanions, RunWrite, rolled_back_event};

/// A rollback written: its event and the run as it left it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunRollback {
    /// The `agent.run.rolledBack` written.
    pub event: AgentRunRolledBackEvent,
    /// The run after the rollback, at its new version and in the state it was in.
    pub run: RunRead,
}

impl RunEngine {
    /// Records `cut`, which the provider confirmed on `run_id`'s conversation, as a forward
    /// `agent.run.rolledBack` landing at the cut's point, under `hold`, the session's append lock:
    /// the run's version advances by one whatever state it is in, and `companions` commit in the
    /// same write, their events before the rollback. A run that moved after it was read is read
    /// again and the rollback retried. The caller fences the cut once this returns
    /// (`RunBindingCursors::fence_cut`). Fails with [`RunRefusal::NotFound`] for an unknown run,
    /// [`RunRefusal::VersionStale`] for one that kept moving and
    /// [`RunStateChangeError::CompanionRefused`] for a refusing companion statement; each refusal
    /// writes nothing.
    ///
    /// [`RunRefusal::NotFound`]: crate::run::refusals::RunRefusal::NotFound
    /// [`RunRefusal::VersionStale`]: crate::run::refusals::RunRefusal::VersionStale
    /// [`RunStateChangeError::CompanionRefused`]:
    ///     crate::run::state_change::RunStateChangeError::CompanionRefused
    pub async fn roll_back(
        &self,
        run_id: RunId,
        cut: &ConfirmedCut,
        companions: RunStateChangeCompanions,
        hold: &SessionAppendHold,
    ) -> Result<RunRollback, RunEngineError> {
        let target_position = cut.point();
        let run = self
            .changes
            .write(
                RunWrite::Rollback {
                    run_id,
                    target_position,
                },
                companions,
                Some(hold),
            )
            .await?;
        Ok(RunRollback {
            event: rolled_back_event(run_id, &run, target_position),
            run,
        })
    }
}
