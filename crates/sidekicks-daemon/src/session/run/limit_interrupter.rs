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
/// [`RunEngine::end_run_for_interrupt`]: super::engine::RunEngine::end_run_for_interrupt
pub(crate) trait LimitInterrupter: Send + Sync {
    /// Interrupts `run_id` because it reached `limit`, its row naming the turn of `cut`, the stop's
    /// cut, and answers within its own bound, since the stop's task runs until it answers. A step
    /// hand in flight meanwhile stands for every step stop of the run: a resend, and a later
    /// turn's reach, whose cut is withdrawn, are left to it; a spend or token hand stands for no
    /// other stop. A row this returns `Ok` for ends `applied` or `degraded`; a failure, a hand it
    /// cannot finish among them, says whether the row is pending, or the hand is still running
    /// past the bound and records its own outcome ([`LimitInterruptFailure::RowPending`]), or
    /// none is left ([`LimitInterruptFailure::NoRow`]), since that row alone marks the cut.
    fn interrupt_for_limit(
        &self,
        run_id: RunId,
        limit: RunLimit,
        cut: Option<StopCut>,
    ) -> BoxFuture<'_, Result<(), LimitInterruptFailure>>;
}

/// A limit stop's cut of one turn as its hand carries it: the turn its row names, and the stop's
/// own identity, by which a hand that fails late withdraws that stop's cut and no other.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct StopCut {
    /// The turn the stop cut.
    pub(crate) turn_number: SafeInt<1>,
    /// The stop that made the cut.
    pub(crate) stop_id: u64,
}

/// Why the interventions service did not carry out a limit's interrupt, by what it left of the
/// interrupt's row.
#[derive(Debug, thiserror::Error)]
pub(crate) enum LimitInterruptFailure {
    /// Nothing of this interrupt is left `requested` or `accepted`, so the stop cut no turn.
    #[error("the limit's interrupt failed and left no pending row")]
    NoRow {
        /// The service's failure.
        #[source]
        source: Box<dyn Error + Send + Sync>,
    },
    /// The interrupt failed while the row is pending, or the hand is still running past the bound
    /// and records its own outcome, so the stop's cut stays for the row that marks it.
    #[error("the limit's interrupt failed and its row is still pending")]
    RowPending {
        /// The service's failure.
        #[source]
        source: Box<dyn Error + Send + Sync>,
    },
}
