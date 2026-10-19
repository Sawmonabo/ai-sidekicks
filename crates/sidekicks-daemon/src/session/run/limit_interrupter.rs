//! The seam through which the run engine hands its own stop of a run at a limit to the
//! interventions service, the one path every interrupt takes.

use std::error::Error;

use futures::future::BoxFuture;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::RunLimit;
use sidekicks_contracts::wire::integer::SafeInt;

/// Carries out the daemon's own interrupt of a run the engine stopped at a limit: records the
/// interrupt with the turn the stop cut, holds or withdraws the run's waiting messages, has the
/// run's driver cut its turn and ends the run with the limit and that turn through
/// [`RunEngine::end_run_for_interrupt`]. The service holds the engine, and the engine holds it
/// weakly.
///
/// [`RunEngine::end_run_for_interrupt`]: crate::session::run::engine::RunEngine::end_run_for_interrupt
pub(crate) trait LimitInterrupter: Send + Sync {
    /// Interrupts `run_id` because it reached `limit`, its row naming `cut_turn`, the turn the
    /// stop cut, and answers within its own bound, since the stop's task runs until it answers and
    /// holds the run's step resends meanwhile. A row this returns `Ok` for ends `applied` or
    /// `degraded`; a failure, a hand it cannot finish among them, says whether the row is still
    /// `requested` or `accepted`, since that row alone marks the cut.
    fn interrupt_for_limit(
        &self,
        run_id: RunId,
        limit: RunLimit,
        cut_turn: Option<SafeInt<1>>,
    ) -> BoxFuture<'_, Result<(), LimitInterruptFailure>>;
}

/// Why the interventions service did not carry out a limit's interrupt, by what it left of the
/// interrupt's row.
#[derive(Debug, thiserror::Error)]
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the interventions service's interrupt at a limit")
)]
pub(crate) enum LimitInterruptFailure {
    /// Nothing of this interrupt is left `requested` or `accepted`, so the stop cut no turn.
    #[error("the limit's interrupt failed and left no pending row")]
    NoRow {
        /// The service's failure.
        #[source]
        source: Box<dyn Error + Send + Sync>,
    },
    /// The interrupt failed while its row stays `requested` or `accepted`, its move to an outcome
    /// refused or not tried, so the row still marks the stop's cut.
    #[error("the limit's interrupt failed and its row is still pending")]
    RowPending {
        /// The service's failure.
        #[source]
        source: Box<dyn Error + Send + Sync>,
    },
}
