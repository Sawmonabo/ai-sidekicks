//! Where a provider's metered usage and its account's quota windows go, and the sums the daemon
//! already reported for a thread a resumed session meters on from. The usage service registers it
//! once it runs; until then a reading meters against a zero base and its delta goes nowhere.

use std::error::Error;

use jiff::Timestamp;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::id::SessionId;

use crate::provider::usage_delta_accountant::{MeteredUsageDelta, UsageAxisCounts};

/// One quota window a provider reported for an account: the provider's own name for the limit, the
/// window's length in minutes, the share of it used in percent, and when it resets where said.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ProviderQuotaWindow {
    /// The provider's own name for the limit.
    pub(crate) limit_id: String,
    /// The window's length in minutes.
    pub(crate) window_mins: i64,
    /// The share of the window used, in percent.
    pub(crate) used_percent: f64,
    /// When the window resets, where the provider said.
    pub(crate) resets_at: Option<Timestamp>,
}

/// The daemon's usage record as the drivers reach it, registered through a `PortRegistration`.
pub(crate) trait UsageSink: Send + Sync {
    /// Takes one metered per-turn delta of `session_id`.
    fn record_metered(&self, session_id: SessionId, delta: MeteredUsageDelta);

    /// Takes the quota windows `provider` reported for `provider_account_id`'s account, `None` on
    /// the person's own sign-in. The set is sparse: it names the windows that moved, no others.
    fn record_quota_windows(
        &self,
        provider: ProviderId,
        provider_account_id: Option<ProviderAccountId>,
        windows: Vec<ProviderQuotaWindow>,
    );

    /// The sums the daemon already reported under `thread_id` on `session_id`, the base a resumed
    /// thread meters from; empty counts when it reported none. Fails when the record is
    /// unreadable.
    fn read_prior_emitted(
        &self,
        session_id: SessionId,
        thread_id: &str,
    ) -> Result<UsageAxisCounts, Box<dyn Error + Send + Sync>>;
}
