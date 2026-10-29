//! The account legs every provider driver carries out for the account plane: each of a provider's
//! own acts on one account's home, named for the act, so the plane reads one object per provider
//! and never branches on which provider it is.

use futures::future::BoxFuture;
use secrecy::SecretString;
use sidekicks_contracts::provider::account::record::{ProviderAccountId, ProviderAuthMode};

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

/// A provider's status read of a pasted token or API key: the registration-time invocation that
/// observes whether the provider accepts it, run once per registration and once per re-supply.
pub trait ProviderTokenStatusLegs: Send + Sync {
    /// The signed-in mode the provider's own status read reports for `token` on
    /// `provider_account_id`'s account, run in `folders` with the token handed to that one child on
    /// the provider's documented channel; `None` when it reports no signed-in mode. Has no bound of
    /// its own, the caller bounds it. Fails with the driver's error when the read could not run.
    fn read_token_status<'call>(
        &'call self,
        provider_account_id: &'call ProviderAccountId,
        folders: &'call ProviderAccountFolders,
        token: &'call SecretString,
    ) -> BoxFuture<'call, Result<Option<ProviderAuthMode>, DriverError>>;
}
