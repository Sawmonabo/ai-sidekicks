//! Reads Codex's account rate-limit readings into a usage-limit signal with the reset boundary the
//! provider reported.

use std::collections::BTreeMap;

use jiff::Timestamp;
use serde_json::{Map, Value};
use sidekicks_contracts::provider::driver::usage_limit::{
    ProviderUsageLimitCause, ProviderUsageLimitResetBoundary, ProviderUsageLimitSignal,
};
use sidekicks_contracts::wire::instant::WireInstant;

use crate::provider::record_readers::read_present_member;

/// The `account/rateLimits/read` method, the pull carrier of a rate-limit snapshot (a reply).
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

/// The limit id Codex itself gives a snapshot that names none.
const CODEX_DEFAULT_LIMIT_ID: &str = "codex";

/// One limit's windows as last read: the read's own, with each later push's present members laid
/// over them.
#[derive(Clone, Debug, Default, PartialEq)]
struct CodexLimitWindows {
    primary: Option<Value>,
    secondary: Option<Value>,
}

/// The account's one reached mark: the `rateLimitReachedType` last stated, and the limit whose
/// reading stated it.
#[derive(Clone, Debug, PartialEq)]
struct CodexRateLimitReached {
    reached_type: Value,
    limit_id: String,
}

/// What the account's rate-limit readings say so far: each limit's windows, kept per `limitId` and
/// never merged across limits, and the one reached mark. A complete read replaces it whole; a
/// push, which is sparse, is merged member by member into its own limit.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct CodexRateLimitObservation {
    windows_by_limit_id: BTreeMap<String, CodexLimitWindows>,
    reached: Option<CodexRateLimitReached>,
}

impl CodexRateLimitObservation {
    /// Each window read, with the limit it belongs to: a limit's primary window, then its
    /// secondary one, limits in id order.
    pub(crate) fn windows(&self) -> impl Iterator<Item = (&str, &Value)> {
        self.windows_by_limit_id
            .iter()
            .flat_map(|(limit_id, windows)| {
                [windows.primary.as_ref(), windows.secondary.as_ref()]
                    .into_iter()
                    .flatten()
                    .map(move |window| (limit_id.as_str(), window))
            })
    }
}

/// A snapshot's `limitId`, or Codex's own `codex` when it names none.
fn read_codex_limit_id(snapshot: &Map<String, Value>) -> String {
    read_present_member(snapshot, "limitId")
        .and_then(Value::as_str)
        .unwrap_or(CODEX_DEFAULT_LIMIT_ID)
        .to_owned()
}

/// Lays a snapshot over its limit's windows and the mark: a `null` or absent member leaves what
/// was there.
fn merge_codex_rate_limit_snapshot(
    observation: &mut CodexRateLimitObservation,
    limit_id: String,
    snapshot: &Map<String, Value>,
) {
    let windows = observation
        .windows_by_limit_id
        .entry(limit_id.clone())
        .or_default();
    if let Some(primary) = read_present_member(snapshot, "primary") {
        windows.primary = Some(primary.clone());
    }
    if let Some(secondary) = read_present_member(snapshot, "secondary") {
        windows.secondary = Some(secondary.clone());
    }
    if let Some(reached_type) = read_present_member(snapshot, "rateLimitReachedType") {
        observation.reached = Some(CodexRateLimitReached {
            reached_type: reached_type.clone(),
            limit_id,
        });
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
/// boundary would land decades early), cut to whole milliseconds, as the wire's instant holds them.
/// `None` outside the range a wire instant holds.
#[expect(
    clippy::cast_possible_truncation,
    reason = "the milliseconds are whole, and a value past i64 saturates to one jiff refuses"
)]
pub(crate) fn codex_epoch_seconds_to_wire_instant(epoch_seconds: f64) -> Option<WireInstant> {
    let epoch_milliseconds = (epoch_seconds * 1000.0).trunc() as i64;
    WireInstant::from_timestamp(Timestamp::from_millisecond(epoch_milliseconds).ok()?)
}

/// The observation an `account/rateLimits/read` reply gives: the whole set, read from
/// `rateLimitsByLimitId`, else from `rateLimits` under its own limit id. Nothing earlier survives
/// it, a reached mark included.
pub(crate) fn observe_codex_rate_limit_read(reply: &Value) -> CodexRateLimitObservation {
    let mut observation = CodexRateLimitObservation::default();
    if let Some(snapshots) = reply.get("rateLimitsByLimitId").and_then(Value::as_object) {
        for (limit_id, snapshot) in snapshots {
            if let Some(snapshot) = snapshot.as_object() {
                merge_codex_rate_limit_snapshot(&mut observation, limit_id.clone(), snapshot);
            }
        }
    } else if let Some(snapshot) = reply.get("rateLimits").and_then(Value::as_object) {
        merge_codex_rate_limit_snapshot(&mut observation, read_codex_limit_id(snapshot), snapshot);
    }
    observation
}

/// The observation after one more `account/rateLimits/updated` push: its present members merged
/// into its own limit's windows, and a present `rateLimitReachedType` moving the mark to that
/// limit.
pub(crate) fn observe_codex_rate_limit_update(
    mut observation: CodexRateLimitObservation,
    update: &Value,
) -> CodexRateLimitObservation {
    if let Some(snapshot) = update.get("rateLimits").and_then(Value::as_object) {
        merge_codex_rate_limit_snapshot(&mut observation, read_codex_limit_id(snapshot), snapshot);
    }
    observation
}

/// Classifies the account's rate-limit readings as a spent usage allowance, or `None`, which means
/// "not known to be limited". Only the `rateLimitReachedType` arm recognizes one, never prose,
/// `usedPercent` alone, or a turn error's own info, which carries no reset boundary; the boundary
/// is read from the limit the mark names alone.
pub(crate) fn classify_codex_usage_limit_signal(
    observation: &CodexRateLimitObservation,
) -> Option<ProviderUsageLimitSignal> {
    let reached = observation.reached.as_ref()?;
    // An arm the person can remedy, an unrecognized arm and an absent one all give nothing rather
    // than a default signal; `spendControlReached`, an administrative budget state, is not read.
    let reached_type = reached.reached_type.as_str()?;
    if !CODEX_PLAN_ALLOWANCE_REACHED_TYPES.contains(&reached_type) {
        return None;
    }
    let windows = observation.windows_by_limit_id.get(&reached.limit_id);
    // The latest spent window: the earliest would schedule a resume the other window refuses.
    let latest_spent_reset = windows
        .into_iter()
        .flat_map(|windows| [windows.primary.as_ref(), windows.secondary.as_ref()])
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

    use super::{
        classify_codex_usage_limit_signal, observe_codex_rate_limit_read,
        observe_codex_rate_limit_update,
    };

    #[rstest]
    #[case::the_latest_spent_window_wins(
        json!({"rateLimits": {
            "rateLimitReachedType": "rate_limit_reached",
            "primary": {"usedPercent": 100, "resetsAt": 1_700_000_000},
            "secondary": {"usedPercent": 100.0, "resetsAt": 1_700_100_000}
        }}),
        vec![],
        "2023-11-16T02:00:00.000Z"
    )]
    #[case::a_window_not_spent_is_passed_over(
        json!({"rateLimits": {"limitId": "codex"}, "rateLimitsByLimitId": {"codex": {
            "rateLimitReachedType": "rate_limit_reached",
            "primary": {"usedPercent": 100, "resetsAt": 1_700_000_000},
            "secondary": {"usedPercent": 99, "resetsAt": 1_700_100_000}
        }}}),
        vec![],
        "2023-11-14T22:13:20.000Z"
    )]
    #[case::a_null_in_the_update_falls_back_to_the_read(
        json!({"rateLimits": {
            "rateLimitReachedType": "workspace_member_usage_limit_reached",
            "primary": {"usedPercent": 100, "resetsAt": 1_700_000_000}
        }}),
        vec![json!({"rateLimits": {"rateLimitReachedType": null, "primary": null}})],
        "2023-11-14T22:13:20.000Z"
    )]
    #[case::another_limit_never_moves_the_reached_one(
        Value::Null,
        vec![
            json!({"rateLimits": {
                "limitId": "codex",
                "rateLimitReachedType": "rate_limit_reached",
                "primary": {"usedPercent": 100, "resetsAt": 1_700_000_000}
            }}),
            json!({"rateLimits": {
                "limitId": "codex_other",
                "primary": {"usedPercent": 100, "resetsAt": 1_700_100_000}
            }}),
        ],
        "2023-11-14T22:13:20.000Z"
    )]
    fn reads_the_reset_of_the_latest_spent_window_in_seconds(
        #[case] read: Value,
        #[case] updates: Vec<Value>,
        #[case] resets_at: &str,
    ) {
        let observation = updates.iter().fold(
            observe_codex_rate_limit_read(&read),
            observe_codex_rate_limit_update,
        );
        let signal = classify_codex_usage_limit_signal(&observation).unwrap();

        assert_eq!(
            signal
                .reset_boundary
                .map(|boundary| boundary.resets_at.as_str().to_owned()),
            Some(resets_at.to_owned())
        );
    }
}
