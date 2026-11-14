//! The charge of exported responses no session holds as their accounts' spend outside any
//! session: each handed to the repricing with its export's sighting, which a session's later read
//! of the same response from its thread's rollout file is passed over by, on a task of the
//! driver's export tasks, so a charge made as a launch ends or the daemon stops is written before
//! the driver's shutdown ends. A write that fails, or that finds no repricing registered yet,
//! waits, logged with its counts, and is carried by the next charge's write.

use std::collections::VecDeque;
use std::error::Error;
use std::sync::{Arc, Mutex};

use sidekicks_contracts::event::usage::UsageSightingSource;
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::{BoundedText, FreeFormText};
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;
use tokio_util::task::TaskTracker;

use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::telemetry::completed_response::CodexCompletedResponse;
use crate::driver::codex::telemetry::placement::{KEPT_RESPONSES, refuse_response};
use crate::driver::codex::telemetry::sighting::compose_codex_sighting;
use crate::driver::ports::{RequestHeldListener, SessionlessRequest};
use crate::usage_delta_accountant::compose_one_turn_spend;

// One response's charge: the request handed to the repricing and the response it was read from.
type CodexSessionlessCharge = (SessionlessRequest, CodexCompletedResponse);

/// The driver's charge of exported responses no session holds, shared by every launch.
pub(crate) struct CodexSessionlessSpend {
    request_held: Arc<PortRegistration<Arc<dyn RequestHeldListener>>>,
    tasks: TaskTracker,
    // The charges a write refused or no repricing took yet, oldest first.
    waiting: Mutex<VecDeque<CodexSessionlessCharge>>,
}

impl CodexSessionlessSpend {
    /// A charge that hands its requests to the repricing `request_held` registers, each write on a
    /// task of `tasks`.
    pub(crate) fn new(
        request_held: Arc<PortRegistration<Arc<dyn RequestHeldListener>>>,
        tasks: TaskTracker,
    ) -> Self {
        Self {
            request_held,
            tasks,
            waiting: Mutex::default(),
        }
    }

    /// Charges each of `responses` to the account it ran on, processed in `processing_region`, in
    /// one write on a task of its own, so a caller that stops waiting leaves none unwritten. A
    /// response naming no account, or a count past the wire's range, cannot be charged and is
    /// refused, naming its thread.
    pub(crate) fn charge(
        self: &Arc<Self>,
        responses: Vec<CodexCompletedResponse>,
        processing_region: Option<&BoundedText<1, EVENT_FIELD_MAX_LEN>>,
    ) {
        let mut charges = Vec::with_capacity(responses.len());
        for response in responses {
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
            let Some(spend) = spend else {
                refuse_response(&response, "a count is past the wire's range");
                continue;
            };
            let request = SessionlessRequest {
                provider: DESCRIPTOR.provider_id(),
                provider_account_id,
                occurred_at: observed_instant(response.observed_at_ms),
                processing_region: processing_region.cloned(),
                spend,
                sighting: compose_codex_sighting(
                    UsageSightingSource::Export,
                    &response.conversation_id,
                    &response.counts,
                    None,
                ),
            };
            charges.push((request, response));
        }
        if charges.is_empty() {
            return;
        }
        let charge = Arc::clone(self);
        self.tasks.spawn(async move { charge.write(charges).await });
    }

    // Writes the waiting charges and `charges` in one write; where it fails, or no repricing is
    // registered yet, each waits for the next charge's write, the oldest refused past the bound.
    async fn write(&self, charges: Vec<CodexSessionlessCharge>) {
        let charges: Vec<CodexSessionlessCharge> =
            lock(&self.waiting).drain(..).chain(charges).collect();
        let written = match self.request_held.port() {
            Some(repricing) => {
                let requests = charges.iter().map(|(request, _)| request.clone()).collect();
                repricing.sessionless_requests_held(requests).await
            }
            None => Err("no repricing takes an account's spend yet".into()),
        };
        if let Err(error) = written {
            tracing::warn!(
                error = &*error as &(dyn Error + 'static),
                "an account's spend outside any session could not be written; it waits for the \
                 next charge"
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
        for (_request, response) in &charges {
            response.log_read_for_price();
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
