//! The usage record's quota windows: each window a provider pushed or an account's own limits read
//! answered becomes one `usage.rateLimit.updated` row under the machine's sentinel session.

use sidekicks_contracts::event::usage::{UsageRateLimitUpdatedPayload, UsageRateLimitWindowKey};
use sidekicks_contracts::provider::account::record::{
    CredentialGeneration, PROVIDER_QUOTA_DEFAULT_LIMIT_ID, ProviderAccountId,
};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeSignedInt;
use sidekicks_contracts::wire::list::BoundedVec;
use sidekicks_contracts::wire::number::Number;
use sidekicks_contracts::wire::text::BoundedText;
use sidekicks_provider::port::usage_sink::ProviderQuotaWindow;
use sidekicks_provider::run::delivery::{InboundDelivery, MachineScopedRow};
use sidekicks_store::database::connection::read_pool::ReadLength;

use crate::usage_record::reads::{
    StoredQuotaWindow, read_credential_generation, read_stored_windows,
};
use crate::usage_record::{UsageRecord, UsageRecordError};

// The windows of an account's whole set, as each window's row carries them.
type UsageRateLimitWholeSet = BoundedVec<UsageRateLimitWindowKey, 1, { usize::MAX }>;

impl UsageRecord {
    // Files each window as one row under the machine's sentinel session, stamped with the
    // account's credential generation read now, each marked with every window of the set where
    // the set is the account's whole one. A whole set that says nothing the stored windows do not
    // files nothing, so a read every few minutes grows the log only when a figure moved.
    pub(super) async fn record_windows(
        &self,
        provider: ProviderId,
        provider_account_id: ProviderAccountId,
        windows: Vec<ProviderQuotaWindow>,
        is_whole_set: bool,
    ) -> Result<(), UsageRecordError> {
        if windows.is_empty() {
            return Ok(());
        }
        let whole_set = if is_whole_set {
            Some(whole_set_keys(&windows)?)
        } else {
            None
        };
        let read_account_id = provider_account_id.clone();
        let (credential_generation, stored) = self
            .pool
            .read(ReadLength::Short, move |reader| {
                let stored = if is_whole_set {
                    Some(read_stored_windows(reader, &read_account_id)?)
                } else {
                    None
                };
                Ok::<_, UsageRecordError>((
                    read_credential_generation(reader, read_account_id)?,
                    stored,
                ))
            })
            .await?;
        let rows = windows
            .into_iter()
            .map(|window| {
                quota_window_row(
                    window,
                    provider.clone(),
                    provider_account_id.clone(),
                    credential_generation,
                    whole_set.clone(),
                )
            })
            .collect::<Result<Vec<_>, _>>()?;
        if stored.is_some_and(|stored| is_stored_set(&rows, &stored)) {
            return Ok(());
        }
        for row in rows {
            self.dispatch
                .dispatch(InboundDelivery::MachineEvent {
                    row: MachineScopedRow::UsageRateLimitUpdated(row),
                })
                .await?;
        }
        Ok(())
    }
}

// Every window of a non-empty set, by its limit and length, as each of its rows names the set.
fn whole_set_keys(
    windows: &[ProviderQuotaWindow],
) -> Result<UsageRateLimitWholeSet, UsageRecordError> {
    let keys = windows
        .iter()
        .map(|window| {
            let unfit = || UsageRecordError::QuotaWindowUnfit {
                limit_id: window.limit_id.clone(),
            };
            Ok(UsageRateLimitWindowKey {
                limit_id: Some(BoundedText::new(window.limit_id.clone()).ok_or_else(unfit)?),
                window_mins: SafeSignedInt::new(window.window_mins).ok_or_else(unfit)?,
            })
        })
        .collect::<Result<Vec<_>, UsageRecordError>>()?;
    Ok(BoundedVec::new(keys).expect("the caller hands a set of at least one window"))
}

// Whether `rows`, an account's whole set, are the stored windows as they stand: the same windows,
// each with the same share used, reset and generation.
fn is_stored_set(rows: &[UsageRateLimitUpdatedPayload], stored: &[StoredQuotaWindow]) -> bool {
    rows.len() == stored.len()
        && rows.iter().all(|row| {
            let limit_id = row
                .limit_id
                .as_ref()
                .map_or(PROVIDER_QUOTA_DEFAULT_LIMIT_ID, BoundedText::as_str);
            stored.iter().any(|window| {
                window.limit_id == limit_id
                    && window.window_mins == row.window_mins.get()
                    && window.used_percent.to_bits() == row.used_percent.get().to_bits()
                    && window.resets_at.as_deref()
                        == row.resets_at.as_ref().map(WireInstant::as_str)
                    && window.credential_generation == row.credential_generation
            })
        })
}

// One window's `usage.rateLimit.updated` row.
fn quota_window_row(
    window: ProviderQuotaWindow,
    provider: ProviderId,
    provider_account_id: ProviderAccountId,
    credential_generation: CredentialGeneration,
    whole_set: Option<UsageRateLimitWholeSet>,
) -> Result<UsageRateLimitUpdatedPayload, UsageRecordError> {
    let ProviderQuotaWindow {
        limit_id,
        window_mins,
        used_percent,
        resets_at,
    } = window;
    let unfit = || UsageRecordError::QuotaWindowUnfit {
        limit_id: limit_id.clone(),
    };
    let resets_at = match resets_at {
        Some(resets_at) => Some(WireInstant::from_timestamp(resets_at).ok_or_else(unfit)?),
        None => None,
    };
    Ok(UsageRateLimitUpdatedPayload {
        provider,
        provider_account_id,
        credential_generation,
        window_mins: SafeSignedInt::new(window_mins).ok_or_else(unfit)?,
        used_percent: Number::new(used_percent).ok_or_else(unfit)?,
        resets_at,
        limit_id: Some(BoundedText::new(limit_id.clone()).ok_or_else(unfit)?),
        whole_set,
    })
}
