//! Where a provider's metered usage goes, and the sums the daemon already reported for a thread a
//! resumed session meters on from. The usage service registers it once it runs; until then a
//! reading meters against a zero base and its delta goes nowhere.

use std::error::Error;

use sidekicks_contracts::session::id::SessionId;

use crate::provider::usage_delta_accountant::{MeteredUsageDelta, UsageAxisCounts};

/// The daemon's usage record as the drivers reach it, registered through a `PortRegistration`.
pub(crate) trait UsageSink: Send + Sync {
    /// Takes one metered per-turn delta of `session_id`.
    fn record_metered(&self, session_id: SessionId, delta: MeteredUsageDelta);

    /// The sums the daemon already reported under `thread_id` on `session_id`, the base a resumed
    /// thread meters from; empty counts when it reported none. Fails when the record is
    /// unreadable.
    fn read_prior_emitted(
        &self,
        session_id: SessionId,
        thread_id: &str,
    ) -> Result<UsageAxisCounts, Box<dyn Error + Send + Sync>>;
}
