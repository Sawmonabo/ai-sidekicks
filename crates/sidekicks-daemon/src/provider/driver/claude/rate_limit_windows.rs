//! Reads Claude Code's `rate_limit_event` into the account's quota windows, named as the account's
//! limits are: `session` for the five-hour window, `weekly_all` for the weekly one, and
//! `weekly_scoped` with its model for the weekly window over one model. Each event's
//! `rate_limit_info` names its windows in `unifiedWindows`, each a utilization share and a reset
//! time in seconds; a build without that member names one window by `rateLimitType`.

use jiff::Timestamp;
use serde_json::{Map, Value};
use sidekicks_contracts::event::usage::compose_scoped_limit_id;

use crate::provider::port::usage_sink::ProviderQuotaWindow;

/// The five-hour window's length in minutes.
const SESSION_WINDOW_MINUTES: i64 = 300;

/// A weekly window's length in minutes.
const WEEKLY_WINDOW_MINUTES: i64 = 10_080;

/// The quota windows of one `rate_limit_event`'s members; a window with no utilization, or one
/// Claude Code names that is no account limit, is left out. The window over one model takes
/// `scoped_model`, the display name the account's latest limits read named, and is left out before
/// any read named one, since a guessed name would make a window no later read matches. `members`
/// is untrusted provider output.
pub(crate) fn read_claude_quota_windows(
    members: &Map<String, Value>,
    scoped_model: Option<&str>,
) -> Vec<ProviderQuotaWindow> {
    let Some(info) = members.get("rate_limit_info").and_then(Value::as_object) else {
        return Vec::new();
    };
    match info.get("unifiedWindows").and_then(Value::as_object) {
        Some(windows) => windows
            .iter()
            .filter_map(|(name, window)| read_window(name, window.as_object()?, scoped_model))
            .collect(),
        None => info
            .get("rateLimitType")
            .and_then(Value::as_str)
            .and_then(|name| read_window(name, info, scoped_model))
            .into_iter()
            .collect(),
    }
}

// One window from its `utilization` share and its `resetsAt` seconds. The per-model weekly keys
// and `overage` are no account limit: the limits read carries those.
fn read_window(
    name: &str,
    window: &Map<String, Value>,
    scoped_model: Option<&str>,
) -> Option<ProviderQuotaWindow> {
    let (limit_id, window_mins) = match name {
        "five_hour" => ("session".to_owned(), SESSION_WINDOW_MINUTES),
        "seven_day" => ("weekly_all".to_owned(), WEEKLY_WINDOW_MINUTES),
        "seven_day_overage_included" => (
            compose_scoped_limit_id("weekly_scoped", scoped_model?),
            WEEKLY_WINDOW_MINUTES,
        ),
        _ => return None,
    };
    let utilization = window
        .get("utilization")
        .and_then(Value::as_f64)
        .filter(|share| share.is_finite())?;
    Some(ProviderQuotaWindow {
        limit_id,
        window_mins,
        used_percent: utilization * 100.0,
        resets_at: window
            .get("resetsAt")
            .and_then(Value::as_i64)
            .and_then(|seconds| Timestamp::from_second(seconds).ok()),
    })
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::json;

    use super::read_claude_quota_windows;

    // Killed by a window keeping Claude Code's own name, by a wrong length, by a scoped window
    // named before any limits read named its model, and by reading a window that is no account
    // limit.
    #[rstest]
    #[case::five_hour("five_hour", None, Some(("session", 300)))]
    #[case::seven_day("seven_day", None, Some(("weekly_all", 10_080)))]
    #[case::scoped(
        "seven_day_overage_included",
        Some("Opus"),
        Some(("weekly_scoped:Opus", 10_080))
    )]
    #[case::scoped_before_any_read("seven_day_overage_included", None, None)]
    #[case::per_model_key("seven_day_opus", Some("Opus"), None)]
    #[case::overage("overage", Some("Opus"), None)]
    fn each_event_window_reads_as_its_account_limit(
        #[case] name: &str,
        #[case] scoped_model: Option<&str>,
        #[case] expected: Option<(&str, i64)>,
    ) {
        let members = json!({
            "rate_limit_info": {"unifiedWindows": {name: {"utilization": 0.5}}},
        });

        let windows = read_claude_quota_windows(
            members.as_object().expect("the members are an object"),
            scoped_model,
        );

        let read: Vec<(&str, i64)> = windows
            .iter()
            .map(|window| (window.limit_id.as_str(), window.window_mins))
            .collect();
        assert_eq!(read, Vec::from_iter(expected));
    }
}
