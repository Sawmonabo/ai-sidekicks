//! The account's rate-limit readings as the daemon records them: a complete read at each start and
//! reconnect of a service, kept as the service's readings at its answer's place among the pushes,
//! and each window whose reading changed, read or pushed, handed to the usage record as the quota
//! windows of the account the service ran on as the reading arrived, in arrival order, which the
//! record stamps with the account's credential generation.

use std::collections::HashMap;
use std::mem;
use std::sync::{Arc, Mutex};

use serde_json::Value;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_std::keyed_lock::KeyedLock;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;

use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::app_server_protocol::GetAccountRateLimitsParams;
use crate::driver::codex::service::supervisor::{CodexService, CodexServiceId};
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::usage_limit_signal::{
    CODEX_ACCOUNT_RATE_LIMITS_READ_METHOD, CodexRateLimitObservation,
    observe_codex_rate_limit_read, read_codex_epoch_seconds,
};
use crate::port::usage_sink::{ProviderQuotaWindow, UsageSink};

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

// The windows last recorded for each account with the service and arrival of the reading they
// came from, and whether a reading with no account to record under was logged.
#[derive(Default)]
struct FiledRateLimits {
    windows_by_account: HashMap<ProviderAccountId, Vec<ProviderQuotaWindow>>,
    arrival_by_account: HashMap<ProviderAccountId, (CodexServiceId, u64)>,
    is_unfiled_reading_logged: bool,
}

/// What one whole read of an account's rate limits answered: every window it named, the plan its
/// reply named, and its reset credits.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct CodexRateLimitRead {
    /// Every window the reply named, the account's whole set.
    pub(crate) windows: Vec<ProviderQuotaWindow>,
    /// The plan the reply named, in Codex's own word.
    pub(crate) plan: Option<String>,
    /// The limit resets the account can redeem, `None` where the reply carried no count.
    pub(crate) reset_credits_available: Option<u32>,
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

    /// Reads the account's rate limits whole on `service`, keeps them as its readings at the
    /// answer's place among the service's frames, files the windows that moved and answers what
    /// the reply said. Fails as the read fails, the readings then left as they were.
    pub(crate) async fn read(
        &self,
        service: &CodexService,
    ) -> Result<CodexRateLimitRead, CodexError> {
        let read = self.request(service).await?;
        self.file_reading(service, Filing::Record).await;
        Ok(read)
    }

    /// Reads the account's rate limits whole on `service` for a caller that records the whole set
    /// itself: the readings are kept as [`Self::read`] keeps them and count as recorded, so no
    /// window of the read is recorded twice and a later push records only what moved since. Fails
    /// as the read fails, the readings then left as they were.
    pub(crate) async fn read_whole(
        &self,
        service: &CodexService,
    ) -> Result<CodexRateLimitRead, CodexError> {
        let read = self.request(service).await?;
        self.file_reading(service, Filing::RecordedByCaller).await;
        Ok(read)
    }

    // Sends the read on `service` and reads its reply, keeping its readings at the answer's place.
    async fn request(&self, service: &CodexService) -> Result<CodexRateLimitRead, CodexError> {
        let reply = service
            .connection()?
            .request_ordered(
                CODEX_ACCOUNT_RATE_LIMITS_READ_METHOD,
                // The reset-credit details cost Codex a second lookup the rows never carry.
                &GetAccountRateLimitsParams {
                    exclude_reset_credit_details: Some(true),
                    supports_luna_reserve: None,
                },
                service.rate_limit_read_hook(),
            )
            .await?;
        let reply: Value =
            serde_json::from_str(reply.get()).map_err(|error| CodexError::Transport {
                detail: "The Codex app-server \"account/rateLimits/read\" response could not be \
                         read."
                    .to_owned(),
                cause: Some(Box::new(error)),
            })?;
        let observation = observe_codex_rate_limit_read(&reply);
        let read = CodexRateLimitRead {
            windows: compose_codex_quota_windows(&observation),
            plan: reply
                .get("rateLimits")
                .and_then(|snapshot| snapshot.get("planType"))
                .and_then(Value::as_str)
                .map(str::to_owned),
            reset_credits_available: reply
                .get("rateLimitResetCredits")
                .and_then(|credits| credits.get("availableCount"))
                .and_then(Value::as_u64)
                .and_then(|count| u32::try_from(count).ok()),
        };
        Ok(read)
    }

    /// Records `service`'s readings as they stand under the account it ran on as they arrived, the
    /// switching service's the one it carried: the windows whose reading changed since the
    /// account's last recording, in one sparse set; a reading older in the service's arrival order
    /// than one already recorded is not recorded, so the newer set stands. A set the record
    /// refused is recorded again with the next reading. A service on no account, the terminal
    /// service on the person's own folder, names none, which the record requires, so its readings
    /// stay unrecorded, logged once; so do readings that come before the usage record registers.
    pub(crate) async fn file(&self, service: &CodexService) {
        self.file_reading(service, Filing::Record).await;
    }

    // Files `service`'s readings as `filing` says: recorded here, or counted as recorded by the
    // caller that records the whole set.
    async fn file_reading(&self, service: &CodexService, filing: Filing) {
        let reading = service.rate_limit_reading();
        let Some(provider_account_id) = reading.provider_account_id else {
            if !mem::replace(&mut lock(&self.filed).is_unfiled_reading_logged, true) {
                tracing::debug!(
                    "the codex service's rate limits name no account, so no usage row is filed"
                );
            }
            return;
        };
        let usage = match filing {
            Filing::Record => match self.usage.port() {
                Some(usage) => Some(Arc::clone(usage)),
                None => return,
            },
            Filing::RecordedByCaller => None,
        };
        // Held through the recording, so a reading one clone is recording is not recorded again
        // by another, and one taken earlier is not recorded after it.
        let _filing = self.filings.acquire(provider_account_id.clone()).await;
        let arrival = (service.id(), reading.arrival);
        let windows = compose_codex_quota_windows(&reading.observation);
        let changed = {
            let filed = lock(&self.filed);
            if filed
                .arrival_by_account
                .get(&provider_account_id)
                .is_some_and(|filed| is_not_newer(arrival, *filed))
            {
                return;
            }
            select_changed_codex_quota_windows(
                filed
                    .windows_by_account
                    .get(&provider_account_id)
                    .map_or(&[], Vec::as_slice),
                &windows,
            )
        };
        if changed.is_empty() {
            return;
        }
        let recorded = match usage {
            Some(usage) => {
                usage
                    .record_quota_windows(
                        DESCRIPTOR.provider_id(),
                        provider_account_id.clone(),
                        changed,
                    )
                    .await
            }
            None => Ok(()),
        };
        if let Err(error) = &recorded {
            tracing::warn!(
                error = &**error as &(dyn std::error::Error + 'static),
                "the codex account's rate limits could not be recorded"
            );
        }
        let mut filed = lock(&self.filed);
        if recorded.is_ok() {
            filed
                .arrival_by_account
                .insert(provider_account_id.clone(), arrival);
        }
        keep_recorded_codex_quota_windows(
            filed
                .windows_by_account
                .entry(provider_account_id)
                .or_default(),
            windows,
            recorded.is_ok(),
        );
    }
}

/// Who records a read's windows.
#[derive(Clone, Copy)]
enum Filing {
    /// The filing records the windows that moved.
    Record,
    /// The caller records the whole set, so the filing only counts them as recorded.
    RecordedByCaller,
}

// Whether a reading at `arrival` is no newer than the one recorded at `filed`: arrivals compare
// only within one service, so a reading from another service is always taken.
fn is_not_newer(arrival: (CodexServiceId, u64), filed: (CodexServiceId, u64)) -> bool {
    arrival.0 == filed.0 && arrival.1 <= filed.1
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

// The label Codex's own app draws a window by when the window names no length, by its slot.
const CODEX_PRIMARY_WINDOW_LABEL: &str = "Usage";
const CODEX_SECONDARY_WINDOW_LABEL: &str = "Secondary usage";

// One window per reading that names its share used; `resetsAt` in seconds, as Codex sends it. A
// window with no length is named by its slot's label instead, never given a length the plan
// suggests.
fn compose_codex_quota_windows(
    observation: &CodexRateLimitObservation,
) -> Vec<ProviderQuotaWindow> {
    observation
        .windows()
        .filter_map(|(limit_id, is_secondary, window)| {
            let window_mins = window.get("windowDurationMins").and_then(Value::as_i64);
            let label = match (window_mins, is_secondary) {
                (Some(_), _) => None,
                (None, false) => Some(CODEX_PRIMARY_WINDOW_LABEL.to_owned()),
                (None, true) => Some(CODEX_SECONDARY_WINDOW_LABEL.to_owned()),
            };
            Some(ProviderQuotaWindow {
                limit_id: limit_id.to_owned(),
                window_mins,
                label,
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
    use std::sync::Arc;
    use std::time::Duration;

    use serde_json::{Value, json};
    use sidekicks_std::port_registration::PortRegistration;

    use super::{
        CodexRateLimitFiling, ProviderQuotaWindow, compose_codex_quota_windows,
        keep_recorded_codex_quota_windows, select_changed_codex_quota_windows,
    };
    use crate::account::observer::window_store::tests::{
        Reading, append, file as file_reading, log_with_account, rows,
    };
    use crate::driver::codex::service::supervisor::test_service::start_scripted_codex_service;
    use crate::driver::codex::usage_limit_signal::{
        CODEX_ACCOUNT_RATE_LIMITS_READ_METHOD, CODEX_ACCOUNT_RATE_LIMITS_UPDATED_METHOD,
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

    // A limit's two windows swapped between its primary and secondary slots, read whole, leave
    // each stored window under its own length with its own figures, so no label moves with the
    // slot. Killed by a window keyed or named by its slot.
    #[test]
    fn windows_swapped_between_the_slots_keep_their_rows() {
        let log = log_with_account();
        let read = |second, primary: Value, secondary: Value| Reading {
            second,
            is_whole_set: true,
            windows: compose_codex_quota_windows(&observe_codex_rate_limit_read(&json!({
                "rateLimits": {"limitId": "codex", "primary": primary, "secondary": secondary},
            }))),
        };
        let five_hours = |used| json!({"usedPercent": used, "windowDurationMins": 300});
        let week = |used| json!({"usedPercent": used, "windowDurationMins": 10_080});

        append(&log, &file_reading(&read(0, five_hours(5), week(30))));
        append(&log, &file_reading(&read(1, week(40), five_hours(10))));

        let stored: Vec<(String, Option<i64>, f64)> = rows(&log)
            .into_iter()
            .map(|(limit_id, window_mins, _, used_percent, ..)| {
                (limit_id, window_mins, used_percent)
            })
            .collect();
        assert_eq!(
            stored,
            [
                ("codex".to_owned(), Some(300), 10.0),
                ("codex".to_owned(), Some(10_080), 40.0)
            ]
        );
    }

    // A secondary window Codex sends with no length is filed beside the primary under its slot's
    // label, and the rows the rest of the whole read writes keep it. Killed by dropping a window
    // with no length, by labeling it by the other slot, and by a whole read that matches its set by
    // length alone, whose next row's write removes the window the set named.
    #[test]
    fn a_window_with_no_length_is_filed_under_its_label() {
        let log = log_with_account();
        let read = Reading {
            second: 0,
            is_whole_set: true,
            windows: compose_codex_quota_windows(&observe_codex_rate_limit_read(&json!({
                "rateLimitsByLimitId": {
                    "codex": {
                        "limitId": "codex",
                        "primary": {"usedPercent": 5, "windowDurationMins": 300},
                        "secondary": {"usedPercent": 30, "resetsAt": 1_800_000_000},
                    },
                    "codex_other": {
                        "limitId": "codex_other",
                        "primary": {"usedPercent": 1, "windowDurationMins": 10_080},
                    },
                },
            }))),
        };

        append(&log, &file_reading(&read));

        let stored: Vec<_> = rows(&log)
            .into_iter()
            .map(
                |(limit_id, window_mins, label, used_percent, resets_at, ..)| {
                    (limit_id, window_mins, label, used_percent, resets_at)
                },
            )
            .collect();
        assert_eq!(
            stored,
            [
                (
                    "codex".to_owned(),
                    None,
                    Some("Secondary usage".to_owned()),
                    30.0,
                    Some("2027-01-15T08:00:00.000Z".to_owned())
                ),
                ("codex".to_owned(), Some(300), None, 5.0, None),
                ("codex_other".to_owned(), Some(10_080), None, 1.0, None),
            ]
        );
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

    // A push is newer than a complete read sent before it, whether it arrives before the read's
    // answer or after it, so the readings keep the push. Killed by storing the read's readings
    // once its request returns, which lands them over a push the reader merged meanwhile, and by
    // replacing the readings with the read's set at its answer, which undoes a push that arrived
    // while the read was out.
    #[rstest::rstest]
    #[case::the_push_after_the_answer(false)]
    #[case::the_push_while_the_read_is_out(true)]
    #[tokio::test]
    async fn a_push_after_a_read_was_sent_stays_over_the_read(#[case] is_pushed_first: bool) {
        let mut scripted = start_scripted_codex_service();
        let filing = CodexRateLimitFiling::new(Arc::new(PortRegistration::new("usage")));
        let five_hours = |used| json!({"usedPercent": used, "windowDurationMins": 300});
        let service = Arc::clone(&scripted.service);
        let script = &mut scripted.script;
        let push = json!({
            "jsonrpc": "2.0",
            "method": CODEX_ACCOUNT_RATE_LIMITS_UPDATED_METHOD,
            "params": {"rateLimits": {"limitId": "codex", "primary": five_hours(20)}},
        });
        let answer_and_push = async {
            let read = script.next_sent().await;
            assert_eq!(read["method"], CODEX_ACCOUNT_RATE_LIMITS_READ_METHOD);
            if is_pushed_first {
                script.send(&push);
            }
            script.answer(
                &read,
                &json!({"rateLimits": {"limitId": "codex", "primary": five_hours(10)}}),
            );
            if !is_pushed_first {
                script.send(&push);
            }
        };

        let (read, ()) = tokio::join!(filing.read(&service), answer_and_push);
        // The read's answer and the push are each one change of the readings.
        tokio::time::timeout(Duration::from_secs(5), async {
            while service.rate_limit_reading().arrival < 2 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the reader routes the push");
        let used = |windows: &[ProviderQuotaWindow]| {
            windows
                .iter()
                .map(|window| window.used_percent)
                .collect::<Vec<_>>()
        };
        let readings = compose_codex_quota_windows(&service.rate_limit_reading().observation);

        assert_eq!(used(&read.expect("the read is answered").windows), [10.0]);
        assert_eq!(used(&readings), [20.0]);
    }
}
