//! Reads Claude Code's `rate_limit_event` into the account's quota windows, named as the account's
//! limits are: `session` for the five-hour window, `weekly_all` for the weekly one, and
//! `weekly_scoped` with its model for the weekly window over one model. Each event's
//! `rate_limit_info` names its windows in `unifiedWindows`, each a utilization share and a reset
//! time in seconds; a build without that member names one window by `rateLimitType`.

use std::collections::HashMap;
use std::sync::Mutex;

use jiff::Timestamp;
use serde_json::{Map, Value};
use sidekicks_contracts::event::usage::compose_scoped_limit_id;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_std::mutex_lock::lock;

use crate::port::usage_sink::ProviderQuotaWindow;

/// The five-hour window's length in minutes.
const SESSION_WINDOW_MINUTES: i64 = 300;

/// A weekly window's length in minutes.
const WEEKLY_WINDOW_MINUTES: i64 = 10_080;

/// The model display name each account's latest limits read named for its weekly window over one
/// model, which every process on the account reads its events' windows by.
#[derive(Default)]
pub(crate) struct ClaudeUsageProbeModels(Mutex<HashMap<ProviderAccountId, String>>);

impl ClaudeUsageProbeModels {
    /// Keeps `display_name` as the model `account`'s latest limits read named.
    pub(crate) fn note(&self, account: ProviderAccountId, display_name: String) {
        lock(&self.0).insert(account, display_name);
    }

    fn model_of(&self, account: Option<&ProviderAccountId>) -> Option<String> {
        lock(&self.0).get(account?).cloned()
    }
}

/// The quota windows of one `rate_limit_event`'s members, sent on `account`; a window with no
/// utilization, or one Claude Code names that is no account limit, is left out. The window over one
/// model takes the display name `account`'s latest limits read named, and is left out before any
/// read named one, or on no account, since a guessed name would make a window no later read
/// matches. `members` is untrusted provider output.
pub(crate) fn read_claude_quota_windows(
    members: &Map<String, Value>,
    probe_models: &ClaudeUsageProbeModels,
    account: Option<&ProviderAccountId>,
) -> Vec<ProviderQuotaWindow> {
    let scoped_model = probe_models.model_of(account);
    let scoped_model = scoped_model.as_deref();
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
    use sidekicks_contracts::provider::account::record::ProviderAccountId;

    use super::{ClaudeUsageProbeModels, read_claude_quota_windows};

    // The account the test's events come on, and another one.
    const ACCOUNT: &str = "account-1";
    const OTHER_ACCOUNT: &str = "account-2";

    fn account(id: &str) -> ProviderAccountId {
        ProviderAccountId::new(id.to_owned()).expect("an account id")
    }

    // Killed by a window keeping Claude Code's own name, by a wrong length, by a scoped window
    // named before any limits read named its model, by one named for another account's read or on
    // a session with no account (the read keyed by anything but the session's account), and by
    // reading a window that is no account limit.
    #[rstest]
    #[case::five_hour("five_hour", None, Some(ACCOUNT), Some(("session", 300)))]
    #[case::seven_day("seven_day", None, Some(ACCOUNT), Some(("weekly_all", 10_080)))]
    #[case::scoped(
        "seven_day_overage_included",
        Some(ACCOUNT),
        Some(ACCOUNT),
        Some(("weekly_scoped:Opus", 10_080))
    )]
    #[case::scoped_before_any_read("seven_day_overage_included", None, Some(ACCOUNT), None)]
    #[case::scoped_read_on_another_account(
        "seven_day_overage_included",
        Some(OTHER_ACCOUNT),
        Some(ACCOUNT),
        None
    )]
    #[case::scoped_with_no_account("seven_day_overage_included", Some(ACCOUNT), None, None)]
    #[case::per_model_key("seven_day_opus", Some(ACCOUNT), Some(ACCOUNT), None)]
    #[case::overage("overage", Some(ACCOUNT), Some(ACCOUNT), None)]
    fn each_event_window_reads_as_its_account_limit(
        #[case] name: &str,
        #[case] probed_account: Option<&str>,
        #[case] session_account: Option<&str>,
        #[case] expected: Option<(&str, i64)>,
    ) {
        let members = json!({
            "rate_limit_info": {"unifiedWindows": {name: {"utilization": 0.5}}},
        });
        let probe_models = ClaudeUsageProbeModels::default();
        if let Some(probed_account) = probed_account {
            probe_models.note(account(probed_account), "Opus".to_owned());
        }

        let windows = read_claude_quota_windows(
            members.as_object().expect("the members are an object"),
            &probe_models,
            session_account.map(account).as_ref(),
        );

        let read: Vec<(&str, i64)> = windows
            .iter()
            .map(|window| (window.limit_id.as_str(), window.window_mins))
            .collect();
        assert_eq!(read, Vec::from_iter(expected));
    }
}
