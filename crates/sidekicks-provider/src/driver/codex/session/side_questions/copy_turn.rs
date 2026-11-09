//! Reading a throwaway turn's frames: its reply, its usage metered against a base of its own at
//! the model it runs and the tier its start declared, and how the turn ended; and filing each
//! metered reading as the session's own, recorded and priced through the driver's live pricing.

use std::error::Error;
use std::path::Path;
use std::sync::Arc;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use serde::Deserialize;
use serde_json::Value;
use serde_json::value::RawValue;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::output_speed::ProviderOutputSpeedState;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::port_registration::PortRegistration;

use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::event_normalizer::{
    CODEX_ITEM_COMPLETED_METHOD, CODEX_THREAD_TOKEN_USAGE_METHOD, CODEX_TURN_COMPLETED_METHOD,
};
use crate::driver::codex::pricing::{CodexRecorderPricing, compose_codex_request_facts};
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::token_usage::read_codex_token_usage;
use crate::driver::codex::transport::connection::read_codex_object;
use crate::driver::codex::transport::diagnostics::{CodexDeliveryPort, CodexTransportDiagnostic};
use crate::driver::codex::turn_evidence::CodexTurnStatus;
use crate::port::usage_sink::{MeteredUsage, MeteredUsageOwner, UsageSink};
use crate::usage_delta_accountant::{
    CumulativeUsageReading, MeteredUsageDelta, ThreadBaseEstablishment, UsageAxisCounts,
    UsageDeltaAccountant, UsageRequestFacts,
};

/// The item type of an agent's reply, a copy's among them.
pub(crate) const CODEX_AGENT_MESSAGE_ITEM_TYPE: &str = "agentMessage";

/// Why a copy's turn gave no answer when Codex named no error.
const NO_ANSWER_DETAIL: &str = "The copy's turn ended with no answer.";

// The members of a copy's frame the copy reads.
#[derive(Deserialize)]
struct CopyFrame {
    item: Option<CopyItem>,
    turn: Option<CopyTurn>,
}

#[derive(Deserialize)]
struct CopyItem {
    #[serde(rename = "type")]
    item_type: Option<String>,
    text: Option<String>,
}

/// How a copy's turn ended, as its frame read.
#[derive(Deserialize)]
pub(crate) struct CopyTurn {
    status: Option<String>,
    /// Codex's error, where the turn failed with one.
    pub(crate) error: Option<Value>,
}

impl CopyTurn {
    /// Whether `turn` completed.
    pub(crate) fn is_completed(turn: Option<&Self>) -> bool {
        turn.is_some_and(|turn| {
            turn.status.as_deref().and_then(CodexTurnStatus::read)
                == Some(CodexTurnStatus::Completed)
        })
    }
}

/// What one frame of a copy's turn says.
pub(crate) enum CopyFrameReading {
    /// The copy's reply.
    Reply(String),
    /// A usage reading, metered against the copy's own base.
    Usage(Box<MeteredUsageDelta>),
    /// The turn ended, as the frame's turn reads where it carried one.
    Ended(Option<CopyTurn>),
    /// Nothing the copy reads.
    Other,
}

/// The meter of one throwaway turn's thread: its usage readings stamped with the facts of the
/// model it runs and the tier its start declared, and metered through an accountant of its own,
/// based at its first reading's total less that reading's own request, so a fork's restored
/// figures, which Codex seeds the copy's total with, are never counted as its spend.
pub(crate) struct CopyTurnMeter {
    /// The turn's thread.
    pub(crate) thread_id: String,
    request: UsageRequestFacts,
    accountant: UsageDeltaAccountant,
}

impl CopyTurnMeter {
    /// The meter of `thread_id`, its readings at `model`, none where no model is known, and the
    /// tier `declared_tier` declared.
    pub(crate) fn new(
        thread_id: String,
        model: Option<&str>,
        declared_tier: Option<&ProviderOutputSpeedState>,
    ) -> Self {
        let accountant = UsageDeltaAccountant::new(DESCRIPTOR.provider_id());
        // A blank model is no model id, so the facts name none where no model is known.
        let request = compose_codex_request_facts(
            model.unwrap_or_default(),
            declared_tier.map(|tier| tier.declared.as_str()),
        );
        Self {
            thread_id,
            request,
            accountant,
        }
    }

    /// Reads one frame of the turn, each usage reading metered on the turn's thread.
    pub(crate) fn read_frame(&mut self, method: &str, params: &RawValue) -> CopyFrameReading {
        match method {
            CODEX_ITEM_COMPLETED_METHOD => read_codex_object::<CopyFrame>(params.get())
                .and_then(|frame| frame.item)
                .filter(|item| item.item_type.as_deref() == Some(CODEX_AGENT_MESSAGE_ITEM_TYPE))
                .and_then(|item| item.text)
                .filter(|text| !text.is_empty())
                .map_or(CopyFrameReading::Other, CopyFrameReading::Reply),
            CODEX_THREAD_TOKEN_USAGE_METHOD => read_codex_token_usage(params)
                .and_then(|reading| self.meter_reading(reading))
                .map_or(CopyFrameReading::Other, |delta| {
                    CopyFrameReading::Usage(Box::new(delta))
                }),
            CODEX_TURN_COMPLETED_METHOD => CopyFrameReading::Ended(
                read_codex_object::<CopyFrame>(params.get()).and_then(|frame| frame.turn),
            ),
            _ => CopyFrameReading::Other,
        }
    }

    /// Meters `counts` as one cumulative reading on the turn's thread, naming no turn, stamped with
    /// the turn's facts; `None` for counts that have not grown.
    pub(crate) fn meter(&mut self, counts: UsageAxisCounts) -> Option<MeteredUsageDelta> {
        let reading = CumulativeUsageReading {
            thread_id: self.thread_id.clone(),
            named_turn_id: None,
            cumulative: counts,
            declared_per_turn: None,
            request: UsageRequestFacts::default(),
        };
        self.meter_reading(reading)
    }

    // Meters one cumulative reading stamped with the turn's facts, the first basing the thread;
    // `None` for a reading that has not grown, or one of another thread.
    fn meter_reading(&mut self, mut reading: CumulativeUsageReading) -> Option<MeteredUsageDelta> {
        if reading.thread_id == self.thread_id && !self.accountant.has_thread(&self.thread_id) {
            self.accountant
                .establish_thread(self.thread_id.clone(), first_reading_base(&reading));
        }
        reading.request = self.request.clone();
        self.accountant.meter_reading(reading)
    }
}

// The base a copy's first reading meters against: its total less the request it declares, the
// figures a fork restored; zero where it declares none, as a reading with no `last` restores none.
fn first_reading_base(reading: &CumulativeUsageReading) -> ThreadBaseEstablishment {
    let Some(declared) = &reading.declared_per_turn else {
        return ThreadBaseEstablishment::Fresh;
    };
    let total = &reading.cumulative;
    let restored = |total: Option<u64>, request: Option<u64>| {
        total
            .zip(request)
            .map(|(total, request)| total.saturating_sub(request))
    };
    ThreadBaseEstablishment::Resume {
        prior_emitted_cumulative: UsageAxisCounts {
            input: restored(total.input, declared.input),
            cached_input: restored(total.cached_input, declared.cached_input),
            cache_write_input: restored(total.cache_write_input, declared.cache_write_input),
            output: restored(total.output, declared.output),
            reasoning_output: restored(total.reasoning_output, declared.reasoning_output),
            total: restored(total.total, declared.total),
        },
    }
}

/// Where the session's own metered usage goes: the usage record, once registered, on the session's
/// binding under its account, each row priced through the driver's live pricing.
#[derive(Clone)]
pub(crate) struct SessionUsageFiling {
    /// The usage record.
    pub(crate) usage: Arc<PortRegistration<Arc<dyn UsageSink>>>,
    /// The session.
    pub(crate) session_id: SessionId,
    /// The binding the rows are recorded on.
    pub(crate) binding_id: RuntimeBindingId,
    /// The account the spend is charged to, which a refused record is reported under.
    pub(crate) provider_account_id: ProviderAccountId,
    /// What prices the rows, one region read per service.
    pub(crate) pricing: CodexRecorderPricing,
}

impl SessionUsageFiling {
    /// Records `delta` as the session's own, counted toward no run, and prices it, its region read
    /// on `service` for `folder`; a refused record or region read is reported under the account.
    /// A copy's thread's ledger on the service's launch takes it first, so its exported twin is
    /// passed over. With no usage record registered it goes nowhere and reads no region. Boxed,
    /// so a future that holds a filing does not nest the live pricing's whole type.
    pub(crate) fn file<'filing>(
        &'filing mut self,
        delta: MeteredUsageDelta,
        service: &'filing CodexService,
        folder: &'filing Path,
    ) -> BoxFuture<'filing, ()> {
        async move { self.file_now(delta, service, folder).await }.boxed()
    }

    async fn file_now(&mut self, delta: MeteredUsageDelta, service: &CodexService, folder: &Path) {
        let exports = &service.dependencies().exports;
        exports.copy_filed(service.id(), &delta.thread_id, delta.axis_deltas);
        let Some(sink) = self.usage.port() else {
            return;
        };
        let metered = MeteredUsage {
            session_id: self.session_id,
            binding_id: self.binding_id.clone(),
            owner: MeteredUsageOwner::Session,
            delta,
            provider_account_id: None,
        };
        let (provider_account_id, session_id) = (&self.provider_account_id, self.session_id);
        let report = |error: Box<dyn Error + Send + Sync>| {
            CodexTransportDiagnostic::PortDeliveryFailed {
                provider_account_id: Some(provider_account_id.clone()),
                port: CodexDeliveryPort::Usage,
                session_id: Some(session_id),
                error,
            }
            .report();
        };
        self.pricing
            .record(&**sink, vec![metered], service, folder, &report)
            .await;
    }
}

/// Codex's own words for a copy's turn that ended with no answer.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub(crate) struct CopyTurnFailure(String);

impl CopyTurnFailure {
    /// The words of Codex's `error` for the turn, else the copy's own.
    pub(crate) fn of(error: Option<&Value>) -> Self {
        let words = error
            .and_then(|error| error.get("message"))
            .and_then(Value::as_str)
            .filter(|words| !words.trim().is_empty());
        Self(words.unwrap_or(NO_ANSWER_DETAIL).to_owned())
    }
}
