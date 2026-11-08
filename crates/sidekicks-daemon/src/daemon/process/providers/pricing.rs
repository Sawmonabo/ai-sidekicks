//! The pricing at the daemon's start: the held price list and the repricing of held requests,
//! opened and registered on the drivers' ports once the owners behind them stand, and their tasks
//! started once the recovery pass has run, each ending with the work's stop: the list's fetch,
//! the repricing, and the follow of the account notices that wake the repricing.

use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;

use reqwest::Url;
use sidekicks_contracts::provider::account::record::ProviderAccountNotification;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_platforms::WallClock;
use sidekicks_provider::pricing::held::{HeldRequestRepricing, HeldRequestRepricingDependencies};
use sidekicks_provider::pricing::store::{HeldPriceList, PriceListConfig};
use sidekicks_std::scheduler::Scheduler;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::DatabaseWriter;
use tokio::sync::broadcast;
use tokio::sync::broadcast::error::RecvError;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::daemon::process::method_inputs::error::MethodInputsError;
use crate::daemon::process::providers::Providers;
use crate::price_list_seed::price_list_seed;

/// The public model price list, read from its main branch: the one list requests are priced from.
const PRICE_LIST_URL: &str =
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/// The held list's folder in the data folder.
const PRICE_LIST_FOLDER_NAME: &str = "price-list";

/// What the pricing's build takes from the steps before it.
pub(crate) struct PricingStart<'a> {
    /// The drivers, whose pricers the repricing calls, and the ports the pricing registers on.
    pub(crate) providers: &'a Providers,
    /// The one read pool.
    pub(crate) reads: Arc<DatabaseReadPool>,
    /// The one database writer.
    pub(crate) writer: Arc<DatabaseWriter>,
    /// The program's one scheduler, whose timer arms each next fetch.
    pub(crate) scheduler: Arc<Scheduler>,
    /// The wall clock the scheduler runs on.
    pub(crate) clock: Arc<dyn WallClock>,
    /// The daemon's data folder, which holds the list's folder.
    pub(crate) data_folder: &'a Path,
    /// The daemon's start in the stored form, as the live projection writes it on each row.
    pub(crate) daemon_started_at: WireInstant,
    /// The account notices, subscribed before the repricing's start pass so no change during the
    /// pass is missed.
    pub(crate) account_notices: broadcast::Receiver<ProviderAccountNotification>,
}

/// The held price list and the repricing, registered on the drivers' ports and not yet started.
pub(crate) struct Pricing {
    price_list: Arc<HeldPriceList>,
    repricing: Arc<HeldRequestRepricing>,
    account_notices: broadcast::Receiver<ProviderAccountNotification>,
}

/// The pricing's running tasks, which the work's stop ends and the daemon's stop waits out.
pub(crate) struct PricingTasks {
    fetch: JoinHandle<()>,
    repricing: JoinHandle<()>,
    account_notices: JoinHandle<()>,
}

/// Opens the held price list with no model in use yet, which the repricing's start pass, the
/// drivers' marks and the model list fill, builds the repricing over every registered driver's
/// pricer, and registers both on the drivers' ports. Fails when the accounts reader or the usage
/// record is not registered yet, or when either port is registered already.
pub(crate) async fn build_pricing(start: PricingStart<'_>) -> Result<Pricing, MethodInputsError> {
    let PricingStart {
        providers,
        reads,
        writer,
        scheduler,
        clock,
        data_folder,
        daemon_started_at,
        account_notices,
    } = start;
    let ports = &providers.ports;
    let provider_accounts = Arc::clone(ports.provider_accounts.require_port()?);
    let usage = Arc::clone(ports.usage.require_port()?);
    let price_list = HeldPriceList::open(
        PriceListConfig {
            folder: data_folder.join(PRICE_LIST_FOLDER_NAME),
            url: Url::parse(PRICE_LIST_URL).expect("the price list's address parses"),
            seed: price_list_seed,
        },
        scheduler,
        clock,
        HashSet::new(),
    )
    .await;
    let pricers = providers
        .registry
        .drivers()
        .filter_map(|(provider, driver)| {
            driver
                .request_pricer()
                .map(|pricer| (provider.clone(), pricer))
        })
        .collect();
    let repricing = HeldRequestRepricing::new(HeldRequestRepricingDependencies {
        reads,
        writer,
        price_list: Arc::clone(&price_list),
        provider_accounts,
        usage,
        pricers,
        daemon_started_at,
    });
    ports.price_list.register(Arc::clone(&price_list))?;
    ports.request_held.register(Arc::clone(&repricing) as _)?;
    Ok(Pricing {
        price_list,
        repricing,
        account_notices,
    })
}

impl Pricing {
    /// Starts the list's fetch task, which fetches at once, the repricing's task, which runs its
    /// start pass first, and the follow of the account notices; each ends with `stop`.
    pub(crate) fn start(self, stop: &CancellationToken) -> PricingTasks {
        PricingTasks {
            fetch: self.price_list.start(stop.clone()),
            repricing: self.repricing.start(stop.clone()),
            account_notices: tokio::spawn(follow_account_notices(
                self.repricing,
                self.account_notices,
                stop.clone(),
            )),
        }
    }
}

impl PricingTasks {
    /// Each task by name, for the stop to wait out once the work's stop ends them.
    pub(crate) fn named_tasks(self) -> [(&'static str, JoinHandle<()>); 3] {
        [
            ("price list fetch", self.fetch),
            ("held requests' repricing", self.repricing),
            ("repricing's account notices", self.account_notices),
        ]
    }
}

// Wakes the repricing for each account a notice changed or removed, and for every held account
// when notices were missed, until the broadcast closes or `stop`.
async fn follow_account_notices(
    repricing: Arc<HeldRequestRepricing>,
    mut notices: broadcast::Receiver<ProviderAccountNotification>,
    stop: CancellationToken,
) {
    loop {
        let Some(notice) = stop.run_until_cancelled(notices.recv()).await else {
            return;
        };
        match notice {
            Ok(ProviderAccountNotification::AccountChanged { account }) => {
                repricing.account_changed(account.account_id());
            }
            Ok(ProviderAccountNotification::AccountRemoved { account_id }) => {
                repricing.account_changed(&account_id);
            }
            Ok(
                ProviderAccountNotification::SignInCodeRequested { .. }
                | ProviderAccountNotification::SignInCompleted { .. }
                | ProviderAccountNotification::UsageWindowUpdated { .. },
            ) => {}
            Err(RecvError::Lagged(_)) => repricing.recheck_held_accounts(),
            Err(RecvError::Closed) => return,
        }
    }
}
