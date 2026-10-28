//! Where a provider's metered usage and its account's quota windows go, and the sums the daemon
//! already reported for a thread a resumed session meters on from. The usage service registers it
//! once it runs; until then a reading meters against a zero base and its delta goes nowhere.

use std::error::Error;

use futures::future::BoxFuture;
use jiff::Timestamp;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::subagent::SubagentId;
use sidekicks_contracts::session::id::SessionId;

use crate::usage_delta_accountant::{MeteredUsageDelta, UsageAxisCounts};

/// One quota window a provider reported for an account: the provider's own name for the limit, the
/// window's length in minutes, the share of it used in percent, and when it resets where said.
#[derive(Clone, Debug, PartialEq)]
pub struct ProviderQuotaWindow {
    /// The provider's own name for the limit.
    pub limit_id: String,
    /// The window's length in minutes.
    pub window_mins: i64,
    /// The share of the window used, in percent.
    pub used_percent: f64,
    /// When the window resets, where the provider said.
    pub resets_at: Option<Timestamp>,
}

/// One metered per-turn delta and where it came from: the session, the binding the reading came
/// on, whose run and account the record looks up, and the helper the provider attributes it to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MeteredUsage {
    /// The session.
    pub session_id: SessionId,
    /// The binding the reading came on.
    pub binding_id: RuntimeBindingId,
    /// The helper the provider attributes the reading to on the binding's run; `None` for the
    /// run's own.
    pub subagent_id: Option<SubagentId>,
    /// The delta.
    pub delta: MeteredUsageDelta,
}

/// The daemon's usage record as the drivers reach it, registered through a `PortRegistration`.
pub trait UsageSink: Send + Sync {
    /// Records one metered per-turn delta, stamped with its account's credential generation as
    /// the accounts store holds it at the write. Fails as the binding cannot be read or the row
    /// cannot be written.
    fn record_metered(
        &self,
        metered: MeteredUsage,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>>;

    /// Records the quota windows `provider` reported for `provider_account_id`'s account. The set
    /// is sparse: it names the windows that moved, no others. Fails as the windows cannot be
    /// written.
    fn record_quota_windows(
        &self,
        provider: ProviderId,
        provider_account_id: ProviderAccountId,
        windows: Vec<ProviderQuotaWindow>,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>>;

    /// The sums the daemon already reported under `thread_id` on `session_id`, the base a resumed
    /// thread meters from; empty counts when it reported none. Fails when the record is
    /// unreadable.
    fn read_prior_emitted(
        &self,
        session_id: SessionId,
        thread_id: &str,
    ) -> Result<UsageAxisCounts, Box<dyn Error + Send + Sync>>;
}
