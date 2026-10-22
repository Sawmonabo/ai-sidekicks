//! Reads Claude Code's `rate_limit_event` into the account's quota windows. Each event's
//! `rate_limit_info` names its windows in `unifiedWindows`, each a utilization share and a reset
//! time in seconds; a build without that member names one window by `rateLimitType`.

use jiff::Timestamp;
use serde_json::{Map, Value};

use crate::provider::port::usage_sink::ProviderQuotaWindow;

// The length in minutes of each window Claude Code names; a window of a length it does not name
// cannot be classified, so it is not read.
const CLAUDE_WINDOW_MINUTES: [(&str, i64); 5] = [
    ("five_hour", 300),
    ("seven_day", 10_080),
    ("seven_day_opus", 10_080),
    ("seven_day_sonnet", 10_080),
    ("seven_day_overage_included", 10_080),
];

/// The quota windows of one `rate_limit_event`'s members; a window with no utilization, or of a
/// length Claude Code does not name, is left out. `members` is untrusted provider output.
pub(crate) fn read_claude_quota_windows(members: &Map<String, Value>) -> Vec<ProviderQuotaWindow> {
    let Some(info) = members.get("rate_limit_info").and_then(Value::as_object) else {
        return Vec::new();
    };
    match info.get("unifiedWindows").and_then(Value::as_object) {
        Some(windows) => windows
            .iter()
            .filter_map(|(limit_id, window)| read_window(limit_id, window.as_object()?))
            .collect(),
        None => info
            .get("rateLimitType")
            .and_then(Value::as_str)
            .and_then(|limit_id| read_window(limit_id, info))
            .into_iter()
            .collect(),
    }
}

// One window from its `utilization` share and its `resetsAt` seconds.
fn read_window(limit_id: &str, window: &Map<String, Value>) -> Option<ProviderQuotaWindow> {
    let (_, window_mins) = CLAUDE_WINDOW_MINUTES
        .iter()
        .find(|(name, _)| *name == limit_id)?;
    let utilization = window
        .get("utilization")
        .and_then(Value::as_f64)
        .filter(|share| share.is_finite())?;
    Some(ProviderQuotaWindow {
        limit_id: limit_id.to_owned(),
        window_mins: *window_mins,
        used_percent: utilization * 100.0,
        resets_at: window
            .get("resetsAt")
            .and_then(Value::as_i64)
            .and_then(|seconds| Timestamp::from_second(seconds).ok()),
    })
}
