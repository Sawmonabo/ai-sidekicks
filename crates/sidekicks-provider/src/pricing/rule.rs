//! A provider's rule for which rates its requests take: the one pricer its driver hands over,
//! which its live pricing and the repricing of held requests both call, so shared code never
//! prices a request by a rule of its own.

use sidekicks_contracts::event::usage::UsageCostSource;
use sidekicks_contracts::provider::account::record::ProviderAuthMode;
use sidekicks_contracts::provider::driver::capabilities::ProviderModel;
use sidekicks_contracts::session::cost::UsdMicros;

use crate::account::usage_turns::unpriced::{UnpricedRequest, UnpricedUsageKey};
use crate::pricing::list::PriceTable;

/// A provider's rule for pricing its requests from the held price table.
pub trait RequestPricer: Send + Sync {
    /// Whether the rule reads the account's sign-in kind, so the repricing reads the kind only for
    /// a provider whose rule needs it.
    fn needs_sign_in_kind(&self) -> bool;

    /// Whether `table` holds every rate `key`'s requests take; a key it does not price stays
    /// held, its rows unread.
    fn prices_key(&self, table: &PriceTable, key: &UnpricedUsageKey) -> bool;

    /// Whether `table` prices `model`, as its provider lists it, at every speed the listing
    /// offers, so a speed the table lacks is fetched for before a request at it is held. A rule
    /// that reads no speed asks only for the model's row.
    fn prices_listed_model(&self, table: &PriceTable, model: &ProviderModel) -> bool {
        table.row(model.id.as_str()).is_some()
    }

    /// What `request`, one of `key`'s, costs at `table`'s rates, under the account's
    /// `sign_in_kind` where the rule reads one and the account's row names it.
    fn price(
        &self,
        table: &PriceTable,
        key: &UnpricedUsageKey,
        request: &UnpricedRequest,
        sign_in_kind: Option<ProviderAuthMode>,
    ) -> RequestPricing;
}

/// What a pricer made of one request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RequestPricing {
    /// The request's figure, split across its rows.
    Priced {
        /// Where the figure came from.
        cost_source: UsageCostSource,
        /// One share per row, in the request's row order, adding up to the request's figure.
        shares: Vec<UsdMicros>,
    },
    /// The table lacks a rate the request takes, so it waits for a list that carries it.
    HeldForPrice,
    /// The rule needs the account's sign-in kind and none is known yet, so it waits for one.
    HeldForSignInKind,
}
