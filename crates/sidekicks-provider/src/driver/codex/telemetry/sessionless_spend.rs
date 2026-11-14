//! The charge of the completed responses no session takes as their accounts' spend outside any
//! session: each handed to the repricing with its sighting, an export's, its rollout line's or its
//! stream frame's, which a session's later read of the same request is passed over by, and with
//! the hosted web searches it states. Each write runs on a task of the driver's export tasks, which
//! its shutdown waits for once its sessions' tasks have ended, so a charge a session, a launch's
//! end or the daemon's stop makes is written before the driver's shutdown ends. A launch charges
//! at its own region, read once at its first export, each response under the account its service
//! ran on at the response's time; a session charges at the region its pricing reads for its
//! folder. A search on an account a plan signs in owes nothing and writes nothing. A write that
//! fails, or that finds no repricing registered yet, waits, logged with its counts, and is carried
//! by the next charge's write; one whose account is being removed or is not registered is dropped.

use std::collections::VecDeque;
use std::error::Error;
use std::sync::{Arc, Mutex, OnceLock};

use sidekicks_contracts::event::usage::UsageSighting;
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::{BoundedText, FreeFormText};
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;
use tokio_util::task::TaskTracker;

use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::pricing::{drop_plan_searches, unknown_host_region};
use crate::driver::codex::service::supervisor::CodexAccountTimeline;
use crate::driver::codex::telemetry::completed_response::CodexCompletedResponse;
use crate::driver::codex::telemetry::exported_response::CodexExportedResponse;
use crate::driver::codex::telemetry::placement::{KEPT_RESPONSES, refuse_response};
use crate::driver::ports::{RequestHeldListener, SessionlessOutcome, SessionlessRequest};
use crate::pricing::live::LivePricing;
use crate::usage_delta_accountant::compose_one_turn_spend;

// The word a row carries for the region its request was processed in.
type CodexRegionWord = BoundedText<1, EVENT_FIELD_MAX_LEN>;

// One response's charge: the request handed to the repricing and the response it was read from.
type CodexSessionlessCharge = (SessionlessRequest, CodexCompletedResponse);

/// A completed response no session takes, with its sighting and the hosted web searches it states;
/// a response of counts states none.
pub(crate) struct CodexSightedResponse {
    /// The response, carrying the account it ran on.
    pub(crate) response: CodexCompletedResponse,
    /// Its sighting; `None` for a thread id too long for one.
    pub(crate) sighting: Option<UsageSighting>,
    /// The hosted web searches it states, on a response of no counts.
    pub(crate) web_searches: Option<u64>,
}

impl CodexSightedResponse {
    /// `response`, which an export stated, with its export sighting.
    pub(crate) fn exported(response: CodexCompletedResponse) -> Self {
        Self {
            sighting: response.export_sighting(),
            response,
            web_searches: None,
        }
    }
}

/// The driver's charge of the responses no session takes, shared by every launch and session.
pub(crate) struct CodexSessionlessSpend {
    request_held: Arc<PortRegistration<Arc<dyn RequestHeldListener>>>,
    // Read for the sign-in kind of a search's account.
    live: Arc<LivePricing>,
    tasks: TaskTracker,
    // The charges a write refused or no repricing took yet, oldest first.
    waiting: Mutex<VecDeque<CodexSessionlessCharge>>,
}

/// What one launch charges outside any session with: the driver's charge, the region of the
/// launch's service, read once at its first export, and the accounts its service ran on, which
/// each response's account is read from by its time, the service gone or not.
#[derive(Clone)]
pub(crate) struct CodexLaunchCharge {
    spend: Arc<CodexSessionlessSpend>,
    launch: Arc<CodexLaunchRegionAndAccounts>,
}

// A launch's region, unset until read, and its service's account timeline.
struct CodexLaunchRegionAndAccounts {
    region: OnceLock<Option<CodexRegionWord>>,
    accounts: CodexAccountTimeline,
}

impl CodexLaunchCharge {
    /// A launch's charge through `spend` for a service that runs on `accounts`, its region not
    /// read yet.
    pub(crate) fn new(spend: &Arc<CodexSessionlessSpend>, accounts: CodexAccountTimeline) -> Self {
        Self {
            spend: Arc::clone(spend),
            launch: Arc::new(CodexLaunchRegionAndAccounts {
                region: OnceLock::new(),
                accounts,
            }),
        }
    }

    /// Whether the launch's region was read.
    pub(crate) fn is_region_read(&self) -> bool {
        self.launch.region.get().is_some()
    }

    /// Keeps `region`, the launch's service's region as read; a region read already stays.
    pub(crate) fn keep_region(&self, region: Option<CodexRegionWord>) {
        self.launch.region.get_or_init(|| region);
    }

    /// The account the launch's service ran on at `at_ms`, in Unix milliseconds.
    pub(crate) fn account_at(&self, at_ms: u64) -> Option<ProviderAccountId> {
        self.launch.accounts.account_at(at_ms)
    }

    /// Charges each of `responses`, which an export stated, with its export sighting.
    pub(crate) fn charge(&self, responses: Vec<CodexCompletedResponse>) {
        self.charge_sighted(
            responses
                .into_iter()
                .map(CodexSightedResponse::exported)
                .collect(),
        );
    }

    /// Charges each of `exported`, a hand-over no session took, with its own sighting: an
    /// export's, or its rollout line's, which carries Codex's id of the response, or for a hosted
    /// web search its search's.
    pub(crate) fn charge_exported(&self, exported: Vec<CodexExportedResponse>) {
        self.charge_sighted(
            exported
                .into_iter()
                .map(CodexExportedResponse::into_sighted)
                .collect(),
        );
    }

    // Charges each of `sighted` at the launch's region, the unknown host's where its read failed.
    fn charge_sighted(&self, sighted: Vec<CodexSightedResponse>) {
        let region = self
            .launch
            .region
            .get()
            .cloned()
            .unwrap_or_else(unknown_host_region);
        self.spend.charge(sighted, region.as_ref());
    }
}

impl CodexSessionlessSpend {
    /// A charge that hands its requests to the repricing `request_held` registers, each write on a
    /// task of `tasks`, reading the sign-in kind of a search's account through `live`.
    pub(crate) fn new(
        request_held: Arc<PortRegistration<Arc<dyn RequestHeldListener>>>,
        live: Arc<LivePricing>,
        tasks: TaskTracker,
    ) -> Self {
        Self {
            request_held,
            live,
            tasks,
            waiting: Mutex::default(),
        }
    }

    /// The tasks each write runs on, which a test hands the driver's stop to wait for.
    #[cfg(test)]
    pub(crate) fn tasks(&self) -> &TaskTracker {
        &self.tasks
    }

    /// Charges each of `sighted` to the account it ran on, processed in `processing_region`, with
    /// its sighting and its searches, in one write on a task of its own, so a caller that stops
    /// waiting leaves none unwritten. A response naming no account, or a count past the wire's
    /// range, cannot be charged and is refused, naming its thread.
    pub(crate) fn charge(
        self: &Arc<Self>,
        sighted: Vec<CodexSightedResponse>,
        processing_region: Option<&CodexRegionWord>,
    ) {
        let mut charges = Vec::with_capacity(sighted.len());
        for CodexSightedResponse {
            response,
            sighting,
            web_searches,
        } in sighted
        {
            let Some(provider_account_id) = response.provider_account_id.clone() else {
                refuse_response(&response, "its launch names no account it ran on");
                continue;
            };
            let spend = compose_one_turn_spend(
                DESCRIPTOR.provider_id(),
                Some(response.model_id.clone()),
                response.service_tier.clone(),
                response.counts,
            );
            let web_search_requests = match web_searches {
                Some(searches) => SafeInt::new(searches).map(Some),
                None => Some(None),
            };
            let (Some(spend), Some(web_search_requests)) = (spend, web_search_requests) else {
                refuse_response(&response, "a count is past the wire's range");
                continue;
            };
            let request = SessionlessRequest {
                provider: DESCRIPTOR.provider_id(),
                provider_account_id,
                occurred_at: observed_instant(response.observed_at_ms),
                processing_region: processing_region.cloned(),
                spend,
                web_search_requests,
                sighting,
            };
            charges.push((request, response));
        }
        if charges.is_empty() {
            return;
        }
        let charge = Arc::clone(self);
        self.tasks.spawn(async move { charge.write(charges).await });
    }

    // Writes the waiting charges and `charges`, less each search a plan owes nothing for, in one
    // write; where it fails, or no repricing is registered yet, each waits for the next charge's
    // write, the oldest refused past the bound. A written charge is logged as read for price, and
    // one whose account is being removed or is no longer registered as dropped with it.
    async fn write(&self, charges: Vec<CodexSessionlessCharge>) {
        let charges = drop_plan_searches(&self.live, charges, |(request, _response)| {
            request
                .web_search_requests
                .is_some()
                .then(|| request.provider_account_id.clone())
        })
        .await;
        let charges: Vec<CodexSessionlessCharge> =
            lock(&self.waiting).drain(..).chain(charges).collect();
        if charges.is_empty() {
            return;
        }
        let written = match self.request_held.port() {
            Some(repricing) => {
                let requests = charges.iter().map(|(request, _)| request.clone()).collect();
                repricing.sessionless_requests_held(requests).await
            }
            None => Err("no repricing takes an account's spend yet".into()),
        };
        let outcomes = match written {
            Ok(outcomes) => outcomes,
            Err(error) => {
                tracing::warn!(
                    error = &*error as &(dyn Error + 'static),
                    "an account's spend outside any session could not be written; it waits for \
                     the next charge"
                );
                let mut waiting = lock(&self.waiting);
                for (request, response) in charges {
                    log_waiting(&request, &response);
                    if waiting.len() >= KEPT_RESPONSES
                        && let Some((_request, dropped)) = waiting.pop_front()
                    {
                        refuse_response(&dropped, "its account's spend could not be written");
                    }
                    waiting.push_back((request, response));
                }
                return;
            }
        };
        for ((request, response), outcome) in charges.iter().zip(outcomes) {
            match outcome {
                SessionlessOutcome::Written => response.log_read_for_price(),
                SessionlessOutcome::PassedOver => {}
                SessionlessOutcome::AccountGone => tracing::info!(
                    conversation_id = response.conversation_id.as_str(),
                    provider_account_id = request.provider_account_id.as_str(),
                    "a codex response's charge outside any session is dropped with its account's \
                     removal"
                ),
            }
        }
    }
}

// Logs `request`, read from `response`, as waiting to be written, with its counts.
fn log_waiting(request: &SessionlessRequest, response: &CodexCompletedResponse) {
    let spend = &request.spend;
    let count = |figure: Option<SafeInt<0>>| figure.map(SafeInt::get);
    tracing::warn!(
        conversation_id = response.conversation_id.as_str(),
        provider_account_id = request.provider_account_id.as_str(),
        model = spend.model_id.as_ref().map(FreeFormText::as_str),
        input_tokens = count(spend.input_tokens),
        output_tokens = count(spend.output_tokens),
        cache_read_tokens = count(spend.cache_read_tokens),
        cache_write_tokens = count(spend.cache_write_tokens),
        reasoning_tokens = count(spend.reasoning_tokens),
        web_search_requests = count(request.web_search_requests),
        "a codex response's charge outside any session waits to be written"
    );
}

// The instant `observed_at_ms`, in Unix milliseconds, names; now where it is zero, a record that
// carries no time.
fn observed_instant(observed_at_ms: u64) -> WireInstant {
    i64::try_from(observed_at_ms)
        .ok()
        .filter(|observed_at_ms| *observed_at_ms > 0)
        .and_then(|observed_at_ms| jiff::Timestamp::from_millisecond(observed_at_ms).ok())
        .and_then(WireInstant::from_timestamp)
        .unwrap_or_else(WireInstant::now)
}
