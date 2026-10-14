//! Reads Codex's account rate-limit readings into a usage-limit signal with the reset boundary the
//! provider reported.

use jiff::Timestamp;
use serde_json::{Map, Value};
use sidekicks_contracts::provider::driver::usage_limit::{
    ProviderUsageLimitCause, ProviderUsageLimitResetBoundary, ProviderUsageLimitSignal,
};
use sidekicks_contracts::wire::instant::WireInstant;

use crate::provider::record_readers::read_present_member;

/// The `account/rateLimits/read` method, the pull carrier of a rate-limit snapshot (a reply).
#[expect(
    dead_code,
    reason = "the Codex driver's account rate-limit read sends it to feed the quota snapshot"
)]
pub(crate) const CODEX_ACCOUNT_RATE_LIMITS_READ_METHOD: &str = "account/rateLimits/read";

/// The `account/rateLimits/updated` method, the push carrier of a rate-limit snapshot.
pub(crate) const CODEX_ACCOUNT_RATE_LIMITS_UPDATED_METHOD: &str = "account/rateLimits/updated";

/// The `rateLimitReachedType` arms meaning a rolling allowance is spent, which clears when its
/// window turns over. The credits-depleted arms give no signal on purpose: a purchase restores
/// credits, not a window turning over, so there is no reset instant to park a run against.
const CODEX_PLAN_ALLOWANCE_REACHED_TYPES: [&str; 3] = [
    "rate_limit_reached",
    "workspace_owner_usage_limit_reached",
    "workspace_member_usage_limit_reached",
];

/// The two readings a usage-limit classification is made from. The push is a sparse update whose
/// absent members do not clear earlier values, so both are needed; a present `rolling_update`
/// member always wins, so a caller that reads `latest_read` again sets `rolling_update` back to
/// `Value::Null`.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct CodexRateLimitObservation {
    /// The `account/rateLimits/read` reply body, or `Value::Null` before one lands.
    pub(crate) latest_read: Value,
    /// The `account/rateLimits/updated` notification params, or `Value::Null`.
    pub(crate) rolling_update: Value,
}

/// The members a classification reads, each from the sparse update where it is present, else
/// from the last full read.
struct CodexMergedRateLimitReading<'reading> {
    rate_limit_reached_type: Option<&'reading Value>,
    primary: Option<&'reading Value>,
    secondary: Option<&'reading Value>,
}

/// The snapshot a reading carries in `rateLimits`, when it is an object.
fn read_codex_rate_limit_snapshot(carrier: &Value) -> Option<&Map<String, Value>> {
    carrier.get("rateLimits")?.as_object()
}

/// Codex's own merge: a member present in the sparse update wins, else the last full read's. A
/// `null` member counts as absent.
fn merge_codex_rate_limit_reading(
    observation: &CodexRateLimitObservation,
) -> CodexMergedRateLimitReading<'_> {
    let latest_read = read_codex_rate_limit_snapshot(&observation.latest_read);
    let rolling_update = read_codex_rate_limit_snapshot(&observation.rolling_update);
    let member = |key: &str| {
        rolling_update
            .and_then(|update| read_present_member(update, key))
            .or_else(|| latest_read.and_then(|read| read_present_member(read, key)))
    };
    CodexMergedRateLimitReading {
        rate_limit_reached_type: member("rateLimitReachedType"),
        primary: member("primary"),
        secondary: member("secondary"),
    }
}

/// The window's reset instant in seconds since the epoch, only when the provider marks the window
/// spent (`usedPercent` at least 100). Any number is read, since `usedPercent` is a float in one
/// of Codex's types and an integer in another.
fn read_codex_spent_window_reset_epoch_seconds(window: Option<&Value>) -> Option<f64> {
    let window = window?.as_object()?;
    let used_percent = window.get("usedPercent")?.as_f64()?;
    if used_percent < 100.0 {
        return None;
    }
    window.get("resetsAt")?.as_f64()
}

/// `resetsAt` read as seconds since the epoch, as Codex documents it (read as milliseconds, every
/// boundary would land decades early), cut to whole milliseconds as a JavaScript `Date` cuts them.
/// `None` outside the range a wire instant holds.
#[expect(
    clippy::cast_possible_truncation,
    reason = "the milliseconds are whole, and a value past i64 saturates to one jiff refuses"
)]
fn codex_epoch_seconds_to_wire_instant(epoch_seconds: f64) -> Option<WireInstant> {
    let epoch_milliseconds = (epoch_seconds * 1000.0).trunc() as i64;
    WireInstant::from_timestamp(Timestamp::from_millisecond(epoch_milliseconds).ok()?)
}

/// The observation after one more `account/rateLimits/updated` push: the readings so far, merged
/// Codex's way, become the base the new sparse push is read over.
pub(crate) fn observe_codex_rate_limit_update(
    previous: &CodexRateLimitObservation,
    update: Value,
) -> CodexRateLimitObservation {
    let merged = merge_codex_rate_limit_reading(previous);
    // Members are copied one by one, so no other key the provider chose lands in the base.
    let mut snapshot = Map::new();
    for (key, member) in [
        ("rateLimitReachedType", merged.rate_limit_reached_type),
        ("primary", merged.primary),
        ("secondary", merged.secondary),
    ] {
        if let Some(member) = member {
            snapshot.insert(key.to_owned(), member.clone());
        }
    }
    let mut latest_read = Map::new();
    latest_read.insert("rateLimits".to_owned(), Value::Object(snapshot));
    CodexRateLimitObservation {
        latest_read: Value::Object(latest_read),
        rolling_update: update,
    }
}

/// Classifies the account's rate-limit readings as a spent usage allowance, or `None`, which means
/// "not known to be limited". Only the `rateLimitReachedType` arm recognizes one, never prose,
/// `usedPercent` alone, or a turn error's own info, which carries no reset boundary.
pub(crate) fn classify_codex_usage_limit_signal(
    observation: &CodexRateLimitObservation,
) -> Option<ProviderUsageLimitSignal> {
    let reading = merge_codex_rate_limit_reading(observation);
    // An arm the person can remedy, an unrecognized arm and an absent one all give nothing rather
    // than a default signal; `spendControlReached`, an administrative budget state, is not read.
    let reached_type = reading.rate_limit_reached_type?.as_str()?;
    if !CODEX_PLAN_ALLOWANCE_REACHED_TYPES.contains(&reached_type) {
        return None;
    }
    // The latest spent window: the earliest would schedule a resume the other window refuses.
    let latest_spent_reset = [reading.primary, reading.secondary]
        .into_iter()
        .filter_map(read_codex_spent_window_reset_epoch_seconds)
        .reduce(f64::max);
    Some(ProviderUsageLimitSignal {
        cause: ProviderUsageLimitCause::PlanAllowanceExhausted,
        reset_boundary: latest_spent_reset
            .and_then(codex_epoch_seconds_to_wire_instant)
            .map(|resets_at| ProviderUsageLimitResetBoundary { resets_at }),
    })
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::{Value, json};

    use super::{CodexRateLimitObservation, classify_codex_usage_limit_signal};

    #[rstest]
    #[case::the_latest_spent_window_wins(
        Value::Null,
        json!({"rateLimits": {
            "rateLimitReachedType": "rate_limit_reached",
            "primary": {"usedPercent": 100, "resetsAt": 1_700_000_000},
            "secondary": {"usedPercent": 100.0, "resetsAt": 1_700_100_000}
        }}),
        "2023-11-16T02:00:00.000Z"
    )]
    #[case::a_window_not_spent_is_passed_over(
        Value::Null,
        json!({"rateLimits": {
            "rateLimitReachedType": "rate_limit_reached",
            "primary": {"usedPercent": 100, "resetsAt": 1_700_000_000},
            "secondary": {"usedPercent": 99, "resetsAt": 1_700_100_000}
        }}),
        "2023-11-14T22:13:20.000Z"
    )]
    #[case::a_null_in_the_update_falls_back_to_the_read(
        json!({"rateLimits": {
            "rateLimitReachedType": "workspace_member_usage_limit_reached",
            "primary": {"usedPercent": 100, "resetsAt": 1_700_000_000}
        }}),
        json!({"rateLimits": {"rateLimitReachedType": null, "primary": null}}),
        "2023-11-14T22:13:20.000Z"
    )]
    fn reads_the_reset_of_the_latest_spent_window_in_seconds(
        #[case] latest_read: Value,
        #[case] rolling_update: Value,
        #[case] resets_at: &str,
    ) {
        let signal = classify_codex_usage_limit_signal(&CodexRateLimitObservation {
            latest_read,
            rolling_update,
        })
        .unwrap();

        assert_eq!(
            signal
                .reset_boundary
                .map(|boundary| boundary.resets_at.as_str().to_owned()),
            Some(resets_at.to_owned())
        );
    }
}
