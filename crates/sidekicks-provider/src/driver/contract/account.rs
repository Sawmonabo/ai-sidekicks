//! The account legs every provider driver carries out for the account plane: each of a provider's
//! own acts on one account's home, named for the act, so the plane reads one object per provider
//! and never branches on which provider it is.

use futures::future::BoxFuture;
use sidekicks_contracts::provider::account::record::ProviderAccountId;

use crate::driver::ProviderAccountFolders;
use crate::driver::contract::error::DriverError;

/// A provider's own acts on one account's home, each run in the home the caller names and no
/// other.
pub trait ProviderAccountLegs: Send + Sync {
    /// Signs `provider_account_id`'s account out through the provider's own sign-out, run in
    /// `folders` and no other home; the folders stay, and emptying them is the caller's. Has no
    /// bound of its own, the caller bounds it. Fails with the driver's error when the sign-out
    /// could not run or the provider refused it.
    fn sign_out_home(
        &self,
        provider_account_id: ProviderAccountId,
        folders: ProviderAccountFolders,
    ) -> BoxFuture<'_, Result<(), DriverError>>;
}

/// What one limits read of an account's home answered, as the account plane stores it: each arm
/// names what the provider said, never which provider said it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProviderObservation {
    /// The provider answered with the account's limits.
    Figures,
    /// The provider refused or throttled the read in its answer, so its last figures stand.
    RefusedInBand,
    /// The provider refused the read in its answer after refusing the account's sign-in on the
    /// way to it, which cannot tell a sign-in revoked early from a throttle.
    SignInRefusedBeforeAnswer,
    /// The provider answered that the account's sign-in is gone.
    SignInGone,
    /// The answer is outside what this read judges for the account, as a pasted token's scope,
    /// which another read takes.
    OutOfScope,
    /// The provider answered with neither the account's limits nor a judgement of its sign-in, as
    /// a read it does not serve where it ran.
    Unanswered,
}

/// A provider's limits read of one account's home, the background observer's one read, run in the
/// home the caller names and no other.
pub trait ProviderObserveLegs: Send + Sync {
    /// Reads `provider_account_id`'s limits in `folders` and no other home, spending no model
    /// turn. Has no bound of its own, the caller bounds it. Fails with the driver's error when the
    /// read could not start or no answer came.
    fn observe(
        &self,
        provider_account_id: ProviderAccountId,
        folders: ProviderAccountFolders,
    ) -> BoxFuture<'_, Result<ProviderObservation, DriverError>>;

    /// Whether this provider's reads run one at a time across all its accounts, each starting a
    /// process of its own.
    fn reads_one_at_a_time(&self) -> bool;

    /// Whether a turn's end on an account is followed by a read of it, since the provider's turns
    /// bring no full reading of their own.
    fn reads_at_turn_end(&self) -> bool;
}
