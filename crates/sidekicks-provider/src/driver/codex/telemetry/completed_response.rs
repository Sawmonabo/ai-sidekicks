//! A completed response, as one resource's records in Codex's log export state it.

use opentelemetry_proto::tonic::logs::v1::{LogRecord, ResourceLogs};
use serde_json::Map;
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::wire::text::{BoundedText, FreeFormText};

use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::pricing::compose_codex_request_facts;
use crate::pricing::receiver::records::{
    RecordRefusal, find_attribute, is_text, read_count, read_text,
};
use crate::usage_delta_accountant::{MeteredUsageDelta, UsageAxisCounts, meter_from_zero};

#[cfg(test)]
pub(crate) mod tests;

/// The name every server-sent event Codex logs carries, its completed responses among them.
pub(crate) const SSE_EVENT_NAME: &str = "codex.sse_event";

/// The name a refusal gives the export it read.
pub(crate) const CODEX_EXPORT: &str = "Codex's export";

/// The event kind of a completed response.
const RESPONSE_COMPLETED_KIND: &str = "response.completed";

const EVENT_NAME_KEY: &str = "event.name";
const EVENT_KIND_KEY: &str = "event.kind";
const ERROR_MESSAGE_KEY: &str = "error.message";
/// The attribute every Codex record names its thread under.
pub(crate) const CONVERSATION_KEY: &str = "conversation.id";
const MODEL_KEY: &str = "model";
const SERVICE_TIER_KEY: &str = "service_tier";
const INPUT_KEY: &str = "input_token_count";
const CACHED_INPUT_KEY: &str = "cached_token_count";
const CACHE_WRITE_INPUT_KEY: &str = "cache_write_token_count";
const OUTPUT_KEY: &str = "output_token_count";
const REASONING_OUTPUT_KEY: &str = "reasoning_token_count";
// Codex writes the usage's total under this name.
const TOTAL_KEY: &str = "tool_token_count";

/// One completed response, as Codex's log export states it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodexCompletedResponse {
    /// The request's own thread id.
    pub(crate) conversation_id: String,
    /// The model the request was sent at.
    pub(crate) model_id: FreeFormText<EVENT_FIELD_MAX_LEN>,
    /// The tier word the request was sent at, `None` where the record names none.
    pub(crate) service_tier: Option<BoundedText<1, EVENT_FIELD_MAX_LEN>>,
    /// The counts, input with its cached and written share inside it, as Codex's usage counts it.
    pub(crate) counts: UsageAxisCounts,
    /// When the SDK observed the record, in Unix milliseconds by the process's wall clock; zero
    /// where the record carries none.
    pub(crate) observed_at_ms: u64,
    /// The account the request ran on, which the reader stamps from its launch's service by the
    /// time it was observed; `None` where the service carries none.
    pub(crate) provider_account_id: Option<ProviderAccountId>,
}

impl CodexCompletedResponse {
    /// The response metered as one request with no key, from a zero base, its input normalized as
    /// a session's usage rows are.
    pub(crate) fn meter(&self) -> MeteredUsageDelta {
        meter_from_zero(
            DESCRIPTOR.provider_id(),
            self.conversation_id.clone(),
            self.counts,
            compose_codex_request_facts(
                self.model_id.as_str(),
                self.service_tier.as_ref().map(BoundedText::as_str),
            ),
        )
    }

    /// Logs the response's one line read for price, which carries only its thread, model, tier
    /// and counts.
    pub(crate) fn log_read_for_price(&self) {
        let counts = &self.counts;
        tracing::info!(
            conversation_id = self.conversation_id.as_str(),
            model = self.model_id.as_str(),
            service_tier = self.service_tier.as_ref().map(BoundedText::as_str),
            input_tokens = counts.input,
            cached_input_tokens = counts.cached_input,
            cache_write_input_tokens = counts.cache_write_input,
            output_tokens = counts.output,
            reasoning_output_tokens = counts.reasoning_output,
            total_tokens = counts.total,
            "codex completed response read for price"
        );
    }
}

/// The completed responses among `resource_logs`' records. A record of another kind, a response's
/// count-free twin and a failed response are passed over unlogged; a completed response that names
/// no conversation or model, or carries a count or word the reader cannot read, is refused whole
/// and logged under `provider_account_id` with the field's name, never its value.
pub(crate) fn read_codex_completed_responses(
    resource_logs: &ResourceLogs,
    provider_account_id: Option<&ProviderAccountId>,
) -> Vec<CodexCompletedResponse> {
    resource_logs
        .scope_logs
        .iter()
        .flat_map(|scope_logs| &scope_logs.log_records)
        .filter_map(|record| match read_completed_response(record) {
            Ok(response) => response,
            Err(refusal) => {
                refusal.report(
                    DESCRIPTOR.provider_id(),
                    provider_account_id,
                    CODEX_EXPORT,
                    SSE_EVENT_NAME,
                    Map::new(),
                );
                None
            }
        })
        .collect()
}

// `record` as a completed response; `None` for a record of another kind, the count-free twin or a
// failed response.
fn read_completed_response(
    record: &LogRecord,
) -> Result<Option<CodexCompletedResponse>, RecordRefusal> {
    let is_completed_response = is_text(&record.attributes, EVENT_NAME_KEY, SSE_EVENT_NAME)
        && is_text(&record.attributes, EVENT_KIND_KEY, RESPONSE_COMPLETED_KIND)
        && find_attribute(&record.attributes, ERROR_MESSAGE_KEY).is_none()
        && (find_attribute(&record.attributes, INPUT_KEY).is_some()
            || find_attribute(&record.attributes, OUTPUT_KEY).is_some());
    if !is_completed_response {
        return Ok(None);
    }
    let conversation_id = read_text(&record.attributes, CONVERSATION_KEY)?
        .filter(|conversation_id| !conversation_id.is_empty())
        .ok_or(RecordRefusal {
            field: CONVERSATION_KEY,
            reason: "it names no conversation",
        })?;
    let model_id = read_text(&record.attributes, MODEL_KEY)?
        .and_then(|model| FreeFormText::new(model.to_owned()).ok())
        .ok_or(RecordRefusal {
            field: MODEL_KEY,
            reason: "it names no model the reader can hold",
        })?;
    let service_tier = read_text(&record.attributes, SERVICE_TIER_KEY)?
        .map(|tier| {
            BoundedText::new(tier.to_owned()).ok_or(RecordRefusal {
                field: SERVICE_TIER_KEY,
                reason: "its tier word is past its bound",
            })
        })
        .transpose()?;
    let counts = UsageAxisCounts {
        input: read_count(&record.attributes, INPUT_KEY)?,
        cached_input: read_count(&record.attributes, CACHED_INPUT_KEY)?,
        cache_write_input: read_count(&record.attributes, CACHE_WRITE_INPUT_KEY)?,
        output: read_count(&record.attributes, OUTPUT_KEY)?,
        reasoning_output: read_count(&record.attributes, REASONING_OUTPUT_KEY)?,
        total: read_count(&record.attributes, TOTAL_KEY)?,
    };
    let unpaired = match (counts.input, counts.output) {
        (None, _) => Some(INPUT_KEY),
        (_, None) => Some(OUTPUT_KEY),
        (Some(_), Some(_)) => None,
    };
    if let Some(field) = unpaired {
        return Err(RecordRefusal {
            field,
            reason: "it carries one of its input and output counts without the other",
        });
    }
    Ok(Some(CodexCompletedResponse {
        conversation_id: conversation_id.to_owned(),
        model_id,
        service_tier,
        counts,
        observed_at_ms: record.observed_time_unix_nano / 1_000_000,
        provider_account_id: None,
    }))
}
