//! What every provider's reader reads off an export's records and spans: an attribute's value as a
//! word or a count, why a record was refused by the attribute that failed, and the wall clock the
//! records are stamped by.

use std::time::{SystemTime, UNIX_EPOCH};

use opentelemetry_proto::tonic::common::v1::KeyValue;
use opentelemetry_proto::tonic::common::v1::any_value::Value;
use serde_json::{Map, json};
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::wire::integer::MAX_SAFE_INTEGER;

use crate::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, emit_driver_diagnostic,
};
use crate::record_readers::is_digits;

/// Now in Unix milliseconds by the wall clock, the clock providers stamp their records by; zero for
/// a clock set before 1970.
pub(crate) fn read_unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|since| u64::try_from(since.as_millis()).ok())
        .unwrap_or(0)
}

/// Why a record or span of an export was refused, by the attribute that failed.
pub(crate) struct RecordRefusal {
    /// The attribute's name, the one thing the report carries from the record.
    pub(crate) field: &'static str,
    /// Why it failed, completing "because".
    pub(crate) reason: &'static str,
}

impl RecordRefusal {
    /// Reports the refusal once as `provider`'s, under `provider_account_id`, for a record of
    /// `wire_type` in the export `exporter` names, naming the attribute, never its value.
    pub(crate) fn report(
        &self,
        provider: ProviderId,
        provider_account_id: Option<&ProviderAccountId>,
        exporter: &str,
        wire_type: &str,
    ) {
        let mut details = Map::new();
        details.insert("field".to_owned(), json!(self.field));
        emit_driver_diagnostic(&DriverDiagnosticRecord {
            provider,
            provider_account_id: provider_account_id.cloned(),
            kind: DriverDiagnosticKind::TelemetryRecordRefused,
            raw_wire_type: Some(wire_type.to_owned()),
            disposition_reason: format!(
                "A record in {exporter}'s export was refused whole because {}.",
                self.reason
            ),
            details,
        });
    }
}

/// The value of the attribute `key` among `attributes`, a record's, a span's or a resource's;
/// `None` where it is absent or carries no value.
pub(crate) fn find_attribute<'attributes>(
    attributes: &'attributes [KeyValue],
    key: &str,
) -> Option<&'attributes Value> {
    attributes
        .iter()
        .find(|attribute| attribute.key == key)
        .and_then(|attribute| attribute.value.as_ref())
        .and_then(|value| value.value.as_ref())
}

/// Whether the attribute `key` among `attributes` is the string `expected`.
pub(crate) fn is_text(attributes: &[KeyValue], key: &str, expected: &str) -> bool {
    matches!(
        find_attribute(attributes, key),
        Some(Value::StringValue(text)) if text == expected
    )
}

/// The attribute `key` among `attributes` as a string, `None` where it is absent; refused in any
/// other form.
pub(crate) fn read_text<'attributes>(
    attributes: &'attributes [KeyValue],
    key: &'static str,
) -> Result<Option<&'attributes str>, RecordRefusal> {
    match find_attribute(attributes, key) {
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

/// The count `key` among `attributes`, `None` where it is absent: an integer from 0, or a string
/// of ASCII digits alone, at most the wire's integer bound; refused in any other form.
pub(crate) fn read_count(
    attributes: &[KeyValue],
    key: &'static str,
) -> Result<Option<u64>, RecordRefusal> {
    let count = match find_attribute(attributes, key) {
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
