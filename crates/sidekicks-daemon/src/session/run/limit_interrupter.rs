//! The seam through which the run engine hands its own stop of a run at a limit to the
//! interventions service, the one path every interrupt takes.

use std::error::Error;

use futures::future::BoxFuture;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::RunLimit;

/// Carries out the daemon's own interrupt of a run the engine stopped at a limit: records the
/// interrupt, holds or withdraws the run's waiting messages, has the run's driver cut its turn and
/// ends the run with the limit through [`RunEngine::end_run_for_interrupt`].
///
/// [`RunEngine::end_run_for_interrupt`]: crate::session::run::engine::RunEngine::end_run_for_interrupt
pub(crate) trait LimitInterrupter: Send + Sync {
    /// Interrupts `run_id` because it reached `limit`. Fails with the interrupt's failure, what it
    /// recorded before the failure kept.
    fn interrupt_for_limit(
        &self,
        run_id: RunId,
        limit: RunLimit,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>>;
}
