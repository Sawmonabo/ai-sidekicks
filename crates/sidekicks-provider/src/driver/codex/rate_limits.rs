//! The account's rate-limit readings as the daemon records them: a complete read at each start and
//! reconnect of a service, kept as the service's readings, and each window whose reading changed,
//! read or pushed, handed to the usage record as the account's quota windows, which stamps them
//! with the account's credential generation.

use std::collections::HashMap;
use std::mem;
use std::sync::{Arc, Mutex};

use serde_json::Value;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_std::keyed_lock::KeyedLock;
use sidekicks_std::mutex_lock::lock;

use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::app_server_protocol::GetAccountRateLimitsParams;
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::usage_limit_signal::{
    CODEX_ACCOUNT_RATE_LIMITS_READ_METHOD, CodexRateLimitObservation,
    observe_codex_rate_limit_read, read_codex_epoch_seconds,
};
use crate::port::usage_sink::{ProviderQuotaWindow, UsageSink};
use sidekicks_std::port_registration::PortRegistration;

/// Reads an account's rate-limit readings and records the windows that moved. A clone records
/// through the same memory of what was recorded, so a window one clone recorded is not recorded
/// again by another.
#[derive(Clone)]
pub(crate) struct CodexRateLimitFiling {
    /// The usage record, which takes each account's quota windows.
    usage: Arc<PortRegistration<Arc<dyn UsageSink>>>,
    /// What was last recorded, shared by every clone. Never held across an await.
    filed: Arc<Mutex<FiledRateLimits>>,
    /// Held per account through each recording, shared by every clone.
    filings: Arc<KeyedLock<ProviderAccountId>>,
}

// The windows last recorded for each account, and whether a reading with no account to record
// under was logged.
#[derive(Default)]
struct FiledRateLimits {
    windows_by_account: HashMap<ProviderAccountId, Vec<ProviderQuotaWindow>>,
    is_unfiled_reading_logged: bool,
}

impl CodexRateLimitFiling {
    /// A filing into the usage record `usage` registers, having recorded nothing yet.
    pub(crate) fn new(usage: Arc<PortRegistration<Arc<dyn UsageSink>>>) -> Self {
        Self {
            usage,
            filed: Arc::default(),
            filings: Arc::new(KeyedLock::new()),
        }
    }

    /// Reads the account's rate limits whole on `service`, keeps them as its readings and files
    /// them. Fails as the read fails, the readings then left as they were.
    pub(crate) async fn read(&self, service: &CodexService) -> Result<(), CodexError> {
        let reply = service
            .connection()?
            .request(
                CODEX_ACCOUNT_RATE_LIMITS_READ_METHOD,
                // The reset-credit details cost Codex a second lookup the rows never carry.
                &GetAccountRateLimitsParams {
                    exclude_reset_credit_details: Some(true),
                    supports_luna_reserve: None,
                },
            )
            .await?;
        let reply: Value =
            serde_json::from_str(reply.get()).map_err(|error| CodexError::Transport {
                detail: "The Codex app-server \"account/rateLimits/read\" response could not be \
                         read."
                    .to_owned(),
                cause: Some(Box::new(error)),
            })?;
        service.store_rate_limit_read(observe_codex_rate_limit_read(&reply));
        self.file(service).await;
        Ok(())
    }

    /// Records `service`'s readings as they stand: the windows whose reading changed since the
    /// account's last recording, in one sparse set; a set the record refused is recorded again
    /// with the next reading. A service no account owns, the terminal service on the person's own
    /// folder, names no account, which the record requires, so its readings stay unrecorded,
    /// logged once; so do readings that come before the usage record registers.
    pub(crate) async fn file(&self, service: &CodexService) {
        let Some(provider_account_id) = service.home().provider_account_id().cloned() else {
            if !mem::replace(&mut lock(&self.filed).is_unfiled_reading_logged, true) {
                tracing::debug!(
                    "the person's own folder's rate limits name no account, so no usage row is \
                     filed"
                );
            }
            return;
        };
        let Some(usage) = self.usage.port().map(Arc::clone) else {
            return;
        };
        // Held through the recording, so a reading one clone is recording is not recorded again
        // by another.
        let _filing = self.filings.acquire(provider_account_id.clone()).await;
        let windows = compose_codex_quota_windows(&service.rate_limit_observation());
        let changed = select_changed_codex_quota_windows(
            lock(&self.filed)
                .windows_by_account
                .get(&provider_account_id)
                .map_or(&[], Vec::as_slice),
            &windows,
        );
        if changed.is_empty() {
            return;
        }
        let recorded = usage
            .record_quota_windows(
                DESCRIPTOR.provider_id(),
                provider_account_id.clone(),
                changed,
            )
            .await;
        if let Err(error) = &recorded {
            tracing::warn!(
                error = &**error as &(dyn std::error::Error + 'static),
                "the codex account's rate limits could not be recorded"
            );
        }
        keep_recorded_codex_quota_windows(
            lock(&self.filed)
                .windows_by_account
                .entry(provider_account_id)
                .or_default(),
            windows,
            recorded.is_ok(),
        );
    }
}

// The windows of `windows` that `filed` does not hold as they are: a window whose reading is
// unchanged since it was recorded is not recorded again.
fn select_changed_codex_quota_windows(
    filed: &[ProviderQuotaWindow],
    windows: &[ProviderQuotaWindow],
) -> Vec<ProviderQuotaWindow> {
    windows
        .iter()
        .filter(|window| !filed.contains(window))
        .cloned()
        .collect()
}

// `filed` then holds each of `windows` it already held, and all of them once `is_recorded`, so a
// refused set reads as changed again.
fn keep_recorded_codex_quota_windows(
    filed: &mut Vec<ProviderQuotaWindow>,
    windows: Vec<ProviderQuotaWindow>,
    is_recorded: bool,
) {
    *filed = windows
        .into_iter()
        .filter(|window| is_recorded || filed.contains(window))
        .collect();
}

// One window per reading that names its length and its share used; `resetsAt` in seconds, as
// Codex sends it.
fn compose_codex_quota_windows(
    observation: &CodexRateLimitObservation,
) -> Vec<ProviderQuotaWindow> {
    observation
        .windows()
        .filter_map(|(limit_id, window)| {
            Some(ProviderQuotaWindow {
                limit_id: limit_id.to_owned(),
                window_mins: window.get("windowDurationMins").and_then(Value::as_i64)?,
                used_percent: window.get("usedPercent").and_then(Value::as_f64)?,
                resets_at: window
                    .get("resetsAt")
                    .and_then(Value::as_f64)
                    .and_then(read_codex_epoch_seconds),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        ProviderQuotaWindow, compose_codex_quota_windows, keep_recorded_codex_quota_windows,
        select_changed_codex_quota_windows,
    };
    use crate::driver::codex::usage_limit_signal::{
        observe_codex_rate_limit_read, observe_codex_rate_limit_update,
    };

    // Records the windows of `windows` that changed since `filed`, the record refusing them where
    // `is_refused`; answers the windows handed to the record.
    fn file(
        filed: &mut Vec<ProviderQuotaWindow>,
        windows: Vec<ProviderQuotaWindow>,
        is_refused: bool,
    ) -> Vec<ProviderQuotaWindow> {
        let changed = select_changed_codex_quota_windows(filed, &windows);
        keep_recorded_codex_quota_windows(filed, windows, !is_refused);
        changed
    }

    // Each reading is merged and composed as the service's are, then compared with what was
    // recorded. Killed by recording every window on each reading, and by keeping a set as recorded
    // before the record took it, so a refused set is not recorded again until its reading changes.
    #[test]
    fn only_windows_whose_reading_changed_or_were_refused_are_recorded_again() {
        let read = observe_codex_rate_limit_read(&json!({
            "rateLimits": {
                "limitId": "codex",
                "primary": {
                    "usedPercent": 10,
                    "windowDurationMins": 300,
                    "resetsAt": 1_800_000_000,
                },
                "secondary": {"usedPercent": 40, "windowDurationMins": 10_080},
            },
        }));
        let mut filed = Vec::new();

        let refused = file(&mut filed, compose_codex_quota_windows(&read), true);
        let after_refusal = file(&mut filed, compose_codex_quota_windows(&read), false);
        let repeated = file(&mut filed, compose_codex_quota_windows(&read), false);
        let pushed = observe_codex_rate_limit_update(
            read,
            &json!({
                "rateLimits": {
                    "limitId": "codex",
                    "secondary": {"usedPercent": 45, "windowDurationMins": 10_080},
                },
            }),
        );
        let after_push = file(&mut filed, compose_codex_quota_windows(&pushed), false);

        assert_eq!(refused.len(), 2);
        assert_eq!(after_refusal, refused, "the refused set is recorded again");
        assert!(repeated.is_empty(), "{repeated:?}");
        assert_eq!(
            after_push,
            compose_codex_quota_windows(&pushed)[1..],
            "only the secondary window is recorded"
        );
    }
}
