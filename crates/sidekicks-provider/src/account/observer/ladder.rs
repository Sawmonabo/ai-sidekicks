//! The limits read's throttle ladder: a read the provider refuses holds the account for ten
//! minutes, then twenty, forty and an hour for each refusal in a row, and an answered read takes it
//! off. The place is read from the account's row at each decision and never kept in memory, so a
//! restart resumes a hold where it stood.

use std::time::{Duration, SystemTime};

use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::wire::instant::WireInstant;

use crate::account::errors::ProviderAccountRegistryError;
use crate::account::registry::{ProviderAccountRegistry, ReadHold};

// How long each rung holds, the last one for every rung past it.
const READ_HOLD_STEPS: [Duration; 4] = [
    Duration::from_mins(10),
    Duration::from_mins(20),
    Duration::from_mins(40),
    Duration::from_mins(60),
];

/// When `account_id`'s hold ends where one is in force at `now`, else `None`. Fails when the
/// account cannot be read.
pub(super) async fn hold_in_force(
    registry: &ProviderAccountRegistry,
    account_id: &ProviderAccountId,
    now: SystemTime,
) -> Result<Option<WireInstant>, ProviderAccountRegistryError> {
    let hold = registry.read_hold(account_id.clone()).await?;
    Ok(hold.held_until.filter(|until| {
        until
            .timestamp()
            .is_some_and(|until| until > timestamp(now))
    }))
}

/// Puts `account_id` one rung up, held from `now` for its new rung's step, and answers its new
/// place. Fails when the account cannot be written.
pub(super) async fn climb(
    registry: &ProviderAccountRegistry,
    account_id: &ProviderAccountId,
    now: SystemTime,
) -> Result<ReadHold, ProviderAccountRegistryError> {
    registry
        .climb_read_hold(
            account_id,
            &READ_HOLD_STEPS.map(|step| wire_instant(now + step)),
        )
        .await
}

/// `now` as the stored instant.
pub(super) fn wire_instant(now: SystemTime) -> WireInstant {
    WireInstant::from_timestamp(timestamp(now)).expect("the clock reads after year 0000")
}

/// `now` as a timestamp, the latest one for an instant past what a timestamp holds.
pub(super) fn timestamp(now: SystemTime) -> jiff::Timestamp {
    jiff::Timestamp::try_from(now).unwrap_or(jiff::Timestamp::MAX)
}
