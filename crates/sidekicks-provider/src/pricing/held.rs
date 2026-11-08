//! The repricing of held requests: the usage rows no figure names yet, priced exactly once, as
//! soon as a copy of the price list prices their key or their account's sign-in kind becomes
//! known, through each provider's own pricer.
//!
//! - **At start** only the distinct keys of the rows no figure names are read, never a row; their
//!   models join the list's models in use, then each key is passed over.
//! - **A pass over a key** reads its rows a page at a time only once its provider's pricer prices
//!   the key under the held copy and, where the rule needs it, under a sign-in kind the account is
//!   not already held for; a key it cannot price waits, its rows unread.
//! - **Triggers** queue keys or accounts and wake one task, which runs what is queued as one pass:
//!   a new copy passes over every key held for a price, an account's changed sign-in kind over its
//!   keys, and a request its driver or the observer handed over over its key. Nothing is polled; a
//!   start read that failed is tried again at the next trigger.
//! - **After a new copy** each model a held key still waits on is reported missing again, so the
//!   list fetches once more under the new tag.
//! - **A removed account** releases its keys, whether they waited on a price or on its kind.
//!
//! Memory holds keys and accounts only; which rows are priced lives in the store.

use std::collections::{HashMap, HashSet};
use std::error::Error;
use std::mem;
use std::num::NonZeroU32;
use std::sync::{Arc, Mutex};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::event::usage::UsageCostSource;
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::provider::account::record::{ProviderAccountId, ProviderAuthMode};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::cost::UsdMicros;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::connection::read_pool::{DatabaseReadPool, ReadLength};
use sidekicks_store::database::writer::DatabaseWriter;
use tokio::sync::Notify;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::account::errors::is_account_not_found;
use crate::account::usage_turns::sessionless_usage_cost_statement;
use crate::account::usage_turns::unpriced::{
    UnpricedPage, UnpricedPageCursor, UnpricedRequest, UnpricedUsageKey, held_mark_statement,
    read_unpriced_keys, read_unpriced_page,
};
use crate::driver::ProviderAccountReader;
use crate::driver::ports::{HeldRequest, RequestHeldListener};
use crate::port::usage_sink::{PricedRequest, PricedUsageRow, RecordedUsage, UsageSink};
use crate::pricing::BoxedError;
use crate::pricing::rule::{RequestPricer, RequestPricing};
use crate::pricing::store::HeldPriceList;

/// The statements the repricing keeps prepared on a read connection: the start's key read and the
/// four page reads.
pub const HELD_REQUEST_REPRICING_STATEMENT_CAPACITY: usize = 5;

/// The rows a page of a key's held requests takes before the rest of its last request.
const PAGE_ROWS: NonZeroU32 = NonZeroU32::new(500).expect("five hundred is not zero");

/// What the repricing is built over.
pub struct HeldRequestRepricingDependencies {
    /// The daemon's read connections, sized with
    /// [`HELD_REQUEST_REPRICING_STATEMENT_CAPACITY`] among the rest.
    pub reads: Arc<DatabaseReadPool>,
    /// The daemon's one writer, which takes the held marks and the sessionless rows' figures.
    pub writer: Arc<DatabaseWriter>,
    /// The held price list, whose new copies reprice the keys waiting on a price.
    pub price_list: Arc<HeldPriceList>,
    /// The accounts reader whose cached sign-in kind a pricer's rule reads.
    pub provider_accounts: Arc<dyn ProviderAccountReader>,
    /// The usage record that writes a session's priced request.
    pub usage: Arc<dyn UsageSink>,
    /// Each provider's pricer, as its driver hands it over; a provider without one prices nothing.
    pub pricers: HashMap<ProviderId, Arc<dyn RequestPricer>>,
    /// The daemon's start in the stored form, as the live projection writes it on each row: a row
    /// this start wrote is read only once its request was handed over.
    pub daemon_started_at: WireInstant,
}

/// The one task that prices held requests, and the intake of the triggers that wake it.
pub struct HeldRequestRepricing {
    reads: Arc<DatabaseReadPool>,
    writer: Arc<DatabaseWriter>,
    price_list: Arc<HeldPriceList>,
    provider_accounts: Arc<dyn ProviderAccountReader>,
    usage: Arc<dyn UsageSink>,
    pricers: HashMap<ProviderId, Arc<dyn RequestPricer>>,
    daemon_started_at: WireInstant,
    // Never held across an await; shared with a hand-off's own task.
    held_keys: Arc<Mutex<HeldKeys>>,
    // Told by a queued key or account; it only wakes the task.
    wake: Arc<Notify>,
}

// What waits, and the work queued since the task last ran.
#[derive(Default)]
struct HeldKeys {
    // Keys whose rows wait on a copy that prices them.
    price_held: HashSet<UnpricedUsageKey>,
    // Accounts whose rows wait on their sign-in kind.
    kind_held: HashMap<ProviderAccountId, KindHeldAccount>,
    // Keys no copy can price, each logged once.
    unpriceable: HashSet<UnpricedUsageKey>,
    queued_keys: HashSet<UnpricedUsageKey>,
    queued_accounts: HashSet<ProviderAccountId>,
    // The start's key read failed, so the next pass reads the keys again.
    are_start_keys_unread: bool,
}

// The sign-in kind an account's keys were held under, and those keys.
struct KindHeldAccount {
    sign_in_kind: Option<ProviderAuthMode>,
    keys: HashSet<UnpricedUsageKey>,
}

// Where a pass left a key.
#[derive(Clone, Copy)]
enum KeyOutcome {
    // Nothing of it waits: its rows are priced or gone, or no copy can price it.
    Released,
    HeldForPrice,
    HeldForSignInKind(Option<ProviderAuthMode>),
}

impl HeldRequestRepricing {
    /// The repricing over `dependencies`, not yet started.
    pub fn new(dependencies: HeldRequestRepricingDependencies) -> Arc<Self> {
        let HeldRequestRepricingDependencies {
            reads,
            writer,
            price_list,
            provider_accounts,
            usage,
            pricers,
            daemon_started_at,
        } = dependencies;
        Arc::new(Self {
            reads,
            writer,
            price_list,
            provider_accounts,
            usage,
            pricers,
            daemon_started_at,
            held_keys: Arc::default(),
            wake: Arc::default(),
        })
    }

    /// Starts the task, which runs the start's pass and then each queued pass until `stop`, which
    /// abandons a pass under way; a request it left unpriced stays held in the store.
    pub fn start(self: &Arc<Self>, stop: CancellationToken) -> JoinHandle<()> {
        tokio::spawn(Arc::clone(self).run(stop))
    }

    /// Tells that `account_id`'s account changed: an account with a key held when the task runs has
    /// its kind read again, its keys passed over where the kind it was held under differs and
    /// dropped where it is no longer registered; any other account reads nothing. Queued whether or
    /// not it is held now, so a change during a pass that holds it is not lost.
    pub fn account_changed(&self, account_id: &ProviderAccountId) {
        lock(&self.held_keys)
            .queued_accounts
            .insert(account_id.clone());
        self.wake.notify_one();
    }

    /// Reads every held account's sign-in kind again, as when account notices were missed.
    pub fn recheck_held_accounts(&self) {
        let mut held_keys = lock(&self.held_keys);
        if held_keys.kind_held.is_empty() {
            return;
        }
        let accounts: Vec<ProviderAccountId> = held_keys.kind_held.keys().cloned().collect();
        held_keys.queued_accounts.extend(accounts);
        drop(held_keys);
        self.wake.notify_one();
    }

    async fn run(self: Arc<Self>, stop: CancellationToken) {
        // Taken before the start's pass, so a copy taken during it passes the held keys again.
        let mut table_watch = self.price_list.subscribe();
        tokio::select! {
            () = stop.cancelled() => return,
            () = self.start_pass() => {}
        }
        loop {
            // `changed` marks the copy seen; a wake marks it only when it read a new one, so a
            // copy sent after that read is passed next.
            let is_table_new = tokio::select! {
                () = stop.cancelled() => return,
                Ok(()) = table_watch.changed() => true,
                () = self.wake.notified() => {
                    let is_table_new = table_watch.has_changed().unwrap_or(false);
                    if is_table_new {
                        table_watch.mark_unchanged();
                    }
                    is_table_new
                }
            };
            tokio::select! {
                () = stop.cancelled() => return,
                () = self.run_queued(is_table_new) => {}
            }
        }
    }

    // The start's keys, their models marked in use at once, then a pass over each.
    async fn start_pass(&self) {
        self.pass_over_start_keys().await;
        self.report_requests_held();
    }

    // The start's keys read and passed over; a failed read is flagged for the next pass.
    async fn pass_over_start_keys(&self) {
        let keys = self
            .reads
            .read(ReadLength::Long, |connection| -> Result<_, BoxedError> {
                Ok(read_unpriced_keys(connection)?)
            })
            .await;
        let keys = match keys {
            Ok(keys) => keys,
            Err(error) => {
                tracing::warn!(
                    error = &*error as &(dyn Error + 'static),
                    "the held requests' keys were not read, so they are read at the next trigger"
                );
                lock(&self.held_keys).are_start_keys_unread = true;
                return;
            }
        };
        let models: Vec<&str> = keys
            .iter()
            .filter(|key| self.pricers.contains_key(&key.provider))
            .filter_map(|key| key.model_id.as_ref().map(FreeFormText::as_str))
            .collect();
        self.price_list.mark_in_use(&models).await;
        for key in keys {
            self.pass_over_key(key).await;
        }
    }

    // One pass over what is queued, and every key held for a price when `is_table_new`, after the
    // start's keys when their read failed; then each model a key still waits on is reported.
    async fn run_queued(&self, is_table_new: bool) {
        let are_start_keys_unread = mem::take(&mut lock(&self.held_keys).are_start_keys_unread);
        if are_start_keys_unread {
            self.pass_over_start_keys().await;
        }
        // Accounts first, so a key a removal let go is not passed over again.
        let accounts = mem::take(&mut lock(&self.held_keys).queued_accounts);
        let mut keys = HashSet::new();
        for account_id in accounts {
            keys.extend(self.recheck_account(account_id).await);
        }
        {
            let mut held_keys = lock(&self.held_keys);
            keys.extend(mem::take(&mut held_keys.queued_keys));
            if is_table_new {
                keys.extend(held_keys.price_held.iter().cloned());
            }
        }
        for key in keys {
            self.pass_over_key(key).await;
        }
        if is_table_new {
            self.report_models_still_missing();
        }
        self.report_requests_held();
    }

    // Each model a key held for a price waits on that the copy just taken still lacks, so the list
    // fetches for it under the new tag.
    fn report_models_still_missing(&self) {
        let table = self.price_list.table();
        let models: HashSet<String> = lock(&self.held_keys)
            .price_held
            .iter()
            .filter_map(|key| key.model_id.as_ref())
            .filter(|model_id| table.row(model_id.as_str()).is_none())
            .map(|model_id| model_id.as_str().to_owned())
            .collect();
        for model_id in &models {
            self.price_list.report_missing(model_id);
        }
    }

    // The keys of `account_id`, let go when its sign-in kind now reads other than the one they
    // were held under. An account that holds no key reads nothing; one no longer registered, whose
    // rows its removal took, has every key it held for a price or its kind dropped.
    async fn recheck_account(&self, account_id: ProviderAccountId) -> HashSet<UnpricedUsageKey> {
        let (held_kind, is_price_held) = {
            let held_keys = lock(&self.held_keys);
            (
                held_keys
                    .kind_held
                    .get(&account_id)
                    .map(|account| account.sign_in_kind),
                held_keys
                    .price_held
                    .iter()
                    .any(|key| key.account_id == account_id),
            )
        };
        if held_kind.is_none() && !is_price_held {
            return HashSet::new();
        }
        match self
            .provider_accounts
            .read_observed_auth_mode(account_id.clone())
            .await
        {
            Ok(sign_in_kind) if held_kind.is_some_and(|held_kind| sign_in_kind != held_kind) => {
                lock(&self.held_keys)
                    .kind_held
                    .remove(&account_id)
                    .map(|account| account.keys)
                    .unwrap_or_default()
            }
            Ok(_) => HashSet::new(),
            Err(error) if is_account_not_found(&*error) => {
                let mut held_keys = lock(&self.held_keys);
                held_keys.kind_held.remove(&account_id);
                held_keys
                    .price_held
                    .retain(|key| key.account_id != account_id);
                HashSet::new()
            }
            Err(error) => {
                tracing::warn!(
                    error = &*error as &(dyn Error + 'static),
                    account_id = account_id.as_str(),
                    "a held account's sign-in kind was not read, so its requests stay held"
                );
                HashSet::new()
            }
        }
    }

    async fn pass_over_key(&self, key: UnpricedUsageKey) {
        let outcome = self.price_key(&key).await;
        self.settle_key(key, outcome);
    }

    // Prices what of `key`'s rows its pricer can, and says where the key is left.
    async fn price_key(&self, key: &UnpricedUsageKey) -> KeyOutcome {
        let (Some(model_id), Some(pricer)) = (&key.model_id, self.pricers.get(&key.provider))
        else {
            if lock(&self.held_keys).unpriceable.insert(key.clone()) {
                tracing::info!(
                    provider = key.provider.as_str(),
                    account_id = key.account_id.as_str(),
                    "held requests name no model or a provider with no pricer, so none is priced"
                );
            }
            return KeyOutcome::Released;
        };
        // Already in use for a key the start read, so this reads the copy only for a new model.
        self.price_list.mark_in_use(&[model_id.as_str()]).await;
        let table = self.price_list.table();
        if !pricer.prices_key(&table, key) {
            return KeyOutcome::HeldForPrice;
        }
        let sign_in_kind = if pricer.needs_sign_in_kind() {
            match self
                .provider_accounts
                .read_observed_auth_mode(key.account_id.clone())
                .await
            {
                Ok(sign_in_kind) => sign_in_kind,
                Err(error) if is_account_not_found(&*error) => return KeyOutcome::Released,
                Err(error) => {
                    log_held_key(key, &error, "the account's sign-in kind was not read");
                    return KeyOutcome::HeldForPrice;
                }
            }
        } else {
            None
        };
        let is_held_under_kind = pricer.needs_sign_in_kind()
            && lock(&self.held_keys)
                .kind_held
                .get(&key.account_id)
                .is_some_and(|account| account.sign_in_kind == sign_in_kind);
        if is_held_under_kind {
            return KeyOutcome::HeldForSignInKind(sign_in_kind);
        }
        let mut outcome = KeyOutcome::Released;
        let mut after = None;
        loop {
            let page = match self.read_page(key, after.take()).await {
                Ok(page) => page,
                Err(error) => {
                    log_held_key(key, &error, "a page of held requests was not read");
                    return KeyOutcome::HeldForPrice;
                }
            };
            for request in &page.requests {
                match pricer.price(&table, key, request, sign_in_kind) {
                    RequestPricing::Priced {
                        cost_source,
                        shares,
                    } => {
                        let recorded = self
                            .record_request(key, model_id, request, cost_source, &shares)
                            .await;
                        if let Err(error) = recorded {
                            log_held_key(key, &error, "a held request's figure was not written");
                            outcome = KeyOutcome::HeldForPrice;
                        }
                    }
                    RequestPricing::HeldForPrice => outcome = KeyOutcome::HeldForPrice,
                    RequestPricing::HeldForSignInKind => {
                        return KeyOutcome::HeldForSignInKind(sign_in_kind);
                    }
                }
            }
            match page.next {
                Some(next) => after = Some(next),
                None => return outcome,
            }
        }
    }

    async fn read_page(
        &self,
        key: &UnpricedUsageKey,
        after: Option<UnpricedPageCursor>,
    ) -> Result<UnpricedPage, BoxedError> {
        let key = key.clone();
        let daemon_started_at = self.daemon_started_at.clone();
        self.reads
            .read(
                ReadLength::Long,
                move |connection| -> Result<_, BoxedError> {
                    Ok(read_unpriced_page(
                        connection,
                        &key,
                        &daemon_started_at,
                        after.as_ref(),
                        PAGE_ROWS,
                    )?)
                },
            )
            .await
    }

    // Writes `request`'s figure: one cost record per session its rows name, and each sessionless
    // row's own figure directly.
    async fn record_request(
        &self,
        key: &UnpricedUsageKey,
        model_id: &FreeFormText<EVENT_FIELD_MAX_LEN>,
        request: &UnpricedRequest,
        cost_source: UsageCostSource,
        shares: &[UsdMicros],
    ) -> Result<(), BoxedError> {
        let mut priced_requests: Vec<PricedRequest> = Vec::new();
        let mut sessionless = Vec::new();
        for (row, &share) in request.rows.iter().zip(shares) {
            let Some(session_id) = row.session_id else {
                sessionless.push(sessionless_usage_cost_statement(
                    row.turn_id.as_str(),
                    share,
                    cost_source,
                ));
                continue;
            };
            let priced_row = PricedUsageRow {
                row: RecordedUsage {
                    event_id: row.turn_id.clone(),
                    run_id: row.run_id,
                    provider_account_id: key.account_id.clone(),
                    subagent_id: row.subagent_id.clone(),
                },
                cost_usd_micros: share,
            };
            match priced_requests
                .iter_mut()
                .find(|priced| priced.session_id == session_id)
            {
                Some(priced) => priced.rows.push(priced_row),
                None => priced_requests.push(PricedRequest {
                    session_id,
                    model_id: model_id.clone(),
                    cost_source,
                    rows: vec![priced_row],
                }),
            }
        }
        for priced in priced_requests {
            self.usage.record_cost(priced).await?;
        }
        if !sessionless.is_empty() {
            self.writer.write(sessionless).await?;
        }
        Ok(())
    }

    fn settle_key(&self, key: UnpricedUsageKey, outcome: KeyOutcome) {
        let mut held_keys = lock(&self.held_keys);
        held_keys.price_held.remove(&key);
        if let Some(account) = held_keys.kind_held.get_mut(&key.account_id) {
            account.keys.remove(&key);
            if account.keys.is_empty() {
                held_keys.kind_held.remove(&key.account_id);
            }
        }
        match outcome {
            KeyOutcome::Released => {}
            KeyOutcome::HeldForPrice => {
                held_keys.price_held.insert(key);
            }
            KeyOutcome::HeldForSignInKind(sign_in_kind) => {
                let account = held_keys
                    .kind_held
                    .entry(key.account_id.clone())
                    .or_insert_with(|| KindHeldAccount {
                        sign_in_kind,
                        keys: HashSet::new(),
                    });
                account.sign_in_kind = sign_in_kind;
                account.keys.insert(key);
            }
        }
    }

    // Only a key waiting on a price brings the list's next fetch to an hour.
    fn report_requests_held(&self) {
        let are_held = !lock(&self.held_keys).price_held.is_empty();
        self.price_list.set_requests_held(are_held);
    }
}

impl RequestHeldListener for HeldRequestRepricing {
    // The mark and the queuing run as one task of their own, so a caller that stops waiting
    // never leaves rows marked and their key unqueued.
    fn request_held(&self, held: HeldRequest) -> BoxFuture<'_, Result<(), BoxedError>> {
        let writer = Arc::clone(&self.writer);
        let held_keys = Arc::clone(&self.held_keys);
        let wake = Arc::clone(&self.wake);
        let hand_off = tokio::spawn(async move {
            if !held.row_ids.is_empty() {
                writer
                    .write(vec![held_mark_statement(&held.row_ids)])
                    .await?;
            }
            lock(&held_keys).queued_keys.insert(held.key);
            wake.notify_one();
            Ok::<(), BoxedError>(())
        });
        async move { hand_off.await? }.boxed()
    }
}

fn log_held_key(key: &UnpricedUsageKey, error: &BoxedError, message: &'static str) {
    tracing::warn!(
        error = &**error as &(dyn Error + 'static),
        provider = key.provider.as_str(),
        account_id = key.account_id.as_str(),
        model_id = key.model_id.as_ref().map(FreeFormText::as_str),
        "{message}, so its requests stay held until the next trigger"
    );
}

#[cfg(test)]
mod tests;
