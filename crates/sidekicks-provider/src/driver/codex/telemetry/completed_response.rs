//! A completed response, as one resource's records in Codex's log export state it.

use opentelemetry_proto::tonic::common::v1::KeyValue;
use opentelemetry_proto::tonic::common::v1::any_value::Value;
use opentelemetry_proto::tonic::logs::v1::{LogRecord, ResourceLogs};
use serde_json::{Map, json};
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::wire::integer::MAX_SAFE_INTEGER;
use sidekicks_contracts::wire::text::{BoundedText, FreeFormText};

use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::pricing::compose_codex_request_facts;
use crate::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, emit_driver_diagnostic,
};
use crate::record_readers::is_digits;
use crate::usage_delta_accountant::{MeteredUsageDelta, UsageAxisCounts, meter_from_zero};

#[cfg(test)]
pub(crate) mod tests;

/// The name every server-sent event Codex logs carries, its completed responses among them.
pub(crate) const SSE_EVENT_NAME: &str = "codex.sse_event";

/// The event kind of a completed response.
const RESPONSE_COMPLETED_KIND: &str = "response.completed";

const EVENT_NAME_KEY: &str = "event.name";
const EVENT_KIND_KEY: &str = "event.kind";
const ERROR_MESSAGE_KEY: &str = "error.message";
const CONVERSATION_KEY: &str = "conversation.id";
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
                refusal.report(provider_account_id);
                None
            }
        })
        .collect()
}

/// Why a record of Codex's export was refused, by the attribute that failed: a completed
/// response's own, or its resource's launch tag.
pub(crate) struct RecordRefusal {
    /// The attribute's name, the one thing the report carries from the record.
    pub(crate) field: &'static str,
    /// Why it failed, completing "because".
    pub(crate) reason: &'static str,
}

impl RecordRefusal {
    /// Reports the refusal once under `provider_account_id`, naming the attribute, never its
    /// value.
    pub(crate) fn report(&self, provider_account_id: Option<&ProviderAccountId>) {
        let mut details = Map::new();
        details.insert("field".to_owned(), json!(self.field));
        emit_driver_diagnostic(&DriverDiagnosticRecord {
            provider: DESCRIPTOR.provider_id(),
            provider_account_id: provider_account_id.cloned(),
            kind: DriverDiagnosticKind::TelemetryRecordRefused,
            raw_wire_type: Some(SSE_EVENT_NAME.to_owned()),
            disposition_reason: format!(
                "A record in Codex's export was refused whole because {}.",
                self.reason
            ),
            details,
        });
    }
}

// `record` as a completed response; `None` for a record of another kind, the count-free twin or a
// failed response.
fn read_completed_response(
    record: &LogRecord,
) -> Result<Option<CodexCompletedResponse>, RecordRefusal> {
    let is_completed_response = is_text(record, EVENT_NAME_KEY, SSE_EVENT_NAME)
        && is_text(record, EVENT_KIND_KEY, RESPONSE_COMPLETED_KIND)
        && find_attribute(&record.attributes, ERROR_MESSAGE_KEY).is_none()
        && (find_attribute(&record.attributes, INPUT_KEY).is_some()
            || find_attribute(&record.attributes, OUTPUT_KEY).is_some());
    if !is_completed_response {
        return Ok(None);
    }
    let conversation_id = read_text(record, CONVERSATION_KEY)?
        .filter(|conversation_id| !conversation_id.is_empty())
        .ok_or(RecordRefusal {
            field: CONVERSATION_KEY,
            reason: "it names no conversation",
        })?;
    let model_id = read_text(record, MODEL_KEY)?
        .and_then(|model| FreeFormText::new(model.to_owned()).ok())
        .ok_or(RecordRefusal {
            field: MODEL_KEY,
            reason: "it names no model the reader can hold",
        })?;
    let service_tier = read_text(record, SERVICE_TIER_KEY)?
        .map(|tier| {
            BoundedText::new(tier.to_owned()).ok_or(RecordRefusal {
                field: SERVICE_TIER_KEY,
                reason: "its tier word is past its bound",
            })
        })
        .transpose()?;
    let counts = UsageAxisCounts {
        input: read_token_count(record, INPUT_KEY)?,
        cached_input: read_token_count(record, CACHED_INPUT_KEY)?,
        cache_write_input: read_token_count(record, CACHE_WRITE_INPUT_KEY)?,
        output: read_token_count(record, OUTPUT_KEY)?,
        reasoning_output: read_token_count(record, REASONING_OUTPUT_KEY)?,
        total: read_token_count(record, TOTAL_KEY)?,
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

/// The value of the attribute `key` among `attributes`, a record's or a resource's; `None` where
/// it is absent or carries no value.
pub(super) fn find_attribute<'attributes>(
    attributes: &'attributes [KeyValue],
    key: &str,
) -> Option<&'attributes Value> {
    attributes
        .iter()
        .find(|attribute| attribute.key == key)
        .and_then(|attribute| attribute.value.as_ref())
        .and_then(|value| value.value.as_ref())
}

// Whether `record`'s attribute `key` is the string `expected`.
fn is_text(record: &LogRecord, key: &str, expected: &str) -> bool {
    matches!(
        find_attribute(&record.attributes, key),
        Some(Value::StringValue(text)) if text == expected
    )
}

// `record`'s attribute `key` as a string, `None` where it is absent; refused in any other form.
fn read_text<'record>(
    record: &'record LogRecord,
    key: &'static str,
) -> Result<Option<&'record str>, RecordRefusal> {
    match find_attribute(&record.attributes, key) {
        None => Ok(None),
        Some(Value::StringValue(text)) => Ok(Some(text)),
        Some(
            Value::BoolValue(_)
            | Value::IntValue(_)
            | Value::DoubleValue(_)
            | Value::ArrayValue(_)
            | Value::KvlistValue(_)
            | Value::BytesValue(_)
            | Value::StringValueStrindex(_),
        ) => Err(RecordRefusal {
            field: key,
            reason: "a word it names is not a string",
        }),
    }
}

// `record`'s count `key`, `None` where it is absent: an integer from 0, or a string of ASCII digits
// alone, at most the wire's integer bound; refused in any other form.
fn read_token_count(record: &LogRecord, key: &'static str) -> Result<Option<u64>, RecordRefusal> {
    let count = match find_attribute(&record.attributes, key) {
        None => return Ok(None),
        Some(Value::IntValue(count)) => u64::try_from(*count).ok(),
        Some(Value::StringValue(digits)) => {
            is_digits(digits).then(|| digits.parse().ok()).flatten()
        }
        Some(
            Value::BoolValue(_)
            | Value::DoubleValue(_)
            | Value::ArrayValue(_)
            | Value::KvlistValue(_)
            | Value::BytesValue(_)
            | Value::StringValueStrindex(_),
        ) => None,
    };
    count
        .filter(|count| *count <= MAX_SAFE_INTEGER)
        .map(Some)
        .ok_or(RecordRefusal {
            field: key,
            reason: "a count is not a whole number the wire can carry",
        })
}
