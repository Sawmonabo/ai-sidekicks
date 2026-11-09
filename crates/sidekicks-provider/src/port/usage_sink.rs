//! Where a provider's metered usage, the price of each request it metered, and its account's quota
//! windows go, a turn's push and an account read's whole set alike, and the sums the daemon already
//! reported for a thread a resumed session meters on from. Recording a reading answers the event it
//! became, so a priced request can name its rows; a request read from a provider's own usage file
//! is checked against the rows already held. The usage service registers it once it runs; until
//! then a reading meters against a zero base and its delta goes nowhere.

use std::error::Error;

use futures::future::BoxFuture;
use jiff::Timestamp;
use sidekicks_contracts::event::usage::UsageCostSource;
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::subagent::SubagentId;
use sidekicks_contracts::session::cost::UsdMicros;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::FreeFormText;

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

/// Whose usage a metered delta is: the binding's run's own, a helper's the provider attributes it
/// to, which counts toward the helper's own run, or the session's own beside its runs, which is
/// charged to the binding's account and counts toward no run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MeteredUsageOwner {
    /// The binding's run.
    Run,
    /// The helper the provider attributes the reading to on the binding's run.
    Helper(SubagentId),
    /// The session's own spend beside its runs, counted toward no run: a throwaway copy of its
    /// conversation (a side question, or the summary a hand-over to another provider asks for), or
    /// a pass that names the session.
    Session,
}

/// One metered per-turn delta and where it came from: the session, the binding the reading came
/// on, whose run and account the record looks up, whose usage it is, and the account it ran on
/// where that is not the binding's.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MeteredUsage {
    /// The session.
    pub session_id: SessionId,
    /// The binding the reading came on.
    pub binding_id: RuntimeBindingId,
    /// Whose usage the reading is.
    pub owner: MeteredUsageOwner,
    /// The delta.
    pub delta: MeteredUsageDelta,
    /// The account the reading ran on, charged in place of the binding's; `None` for a reading
    /// charged to its binding's account.
    pub provider_account_id: Option<ProviderAccountId>,
}

/// A token row the record wrote, and the run, account and helper it charged it to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecordedUsage {
    /// The row's `usage.tokenCount.recorded` event.
    pub event_id: FreeFormText<EVENT_FIELD_MAX_LEN>,
    /// The run the row was counted toward, `None` for the session's own spend.
    pub run_id: Option<RunId>,
    /// The account the row was charged to.
    pub provider_account_id: ProviderAccountId,
    /// The helper the row was attributed to, where one was.
    pub subagent_id: Option<SubagentId>,
}

/// One request priced on a session: its model, where its figure came from, and each of its token
/// rows with that row's share.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PricedRequest {
    /// The session.
    pub session_id: SessionId,
    /// The model the request was priced at.
    pub model_id: FreeFormText<EVENT_FIELD_MAX_LEN>,
    /// Where the figure came from.
    pub cost_source: UsageCostSource,
    /// The request's token rows, each with its share of the price.
    pub rows: Vec<PricedUsageRow>,
}

/// One token row of a priced request and its share of the price.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PricedUsageRow {
    /// The row.
    pub row: RecordedUsage,
    /// Its share, in whole micro-dollars.
    pub cost_usd_micros: UsdMicros,
}

/// The daemon's usage record as the drivers reach it, registered through a `PortRegistration`.
pub trait UsageSink: Send + Sync {
    /// Records one metered per-turn delta, stamped with its account's credential generation as
    /// the accounts store holds it at the write, and answers the row's event and the run, account
    /// and helper it was charged to; `None` where the dispatch wrote nothing. Fails as the binding
    /// cannot be read or the row cannot be written.
    fn record_metered(
        &self,
        metered: MeteredUsage,
    ) -> BoxFuture<'_, Result<Option<RecordedUsage>, Box<dyn Error + Send + Sync>>>;

    /// Records one priced request: one `usage.cost.updated` per account its rows name, in the
    /// order the accounts first appear, each naming that account's rows and their sum, on the
    /// session with no binding, so a request priced after its run ended is still recorded. The
    /// request's events are written together or not at all. A request with no rows records
    /// nothing. Fails as a sum passes the wire's integer or the events cannot be written.
    fn record_cost(
        &self,
        request: PricedRequest,
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

    /// Records the whole set of quota windows the account's own limits read answered for
    /// `provider_account_id`'s account: each window is marked with the set, so a stored window the
    /// set does not name is gone. An empty set records nothing. Fails as the windows cannot be
    /// written.
    fn record_whole_quota_windows(
        &self,
        provider: ProviderId,
        provider_account_id: ProviderAccountId,
        windows: Vec<ProviderQuotaWindow>,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>>;

    /// The cumulative counts the daemon already reported under `thread_id` on `session_id`, each
    /// axis as the provider counted it, the base a resumed thread meters from; empty counts when
    /// it reported none. Fails when the record is unreadable.
    fn read_prior_emitted(
        &self,
        session_id: SessionId,
        thread_id: String,
    ) -> BoxFuture<'_, Result<UsageAxisCounts, Box<dyn Error + Send + Sync>>>;

    /// Whether `provider_account_id`'s account already holds a row of the request the provider
    /// keys `request_key`, so a request read a second time is not counted again. Fails when the
    /// record is unreadable.
    fn is_request_recorded(
        &self,
        provider_account_id: ProviderAccountId,
        request_key: String,
    ) -> BoxFuture<'_, Result<bool, Box<dyn Error + Send + Sync>>>;

    /// The thread tier of `session_id`'s latest row that carries one at or before `at`, the tier
    /// a helper's request made then is priced at; `None` where no such row carries one. Fails when
    /// the record is unreadable.
    fn read_thread_speed_at(
        &self,
        session_id: SessionId,
        at: WireInstant,
    ) -> BoxFuture<'_, Result<Option<String>, Box<dyn Error + Send + Sync>>>;
}
