//! Codex's account legs a helper mode runs, with no daemon serving and no database pool.

use sidekicks_platforms::KeychainSignIn;

use crate::driver::ProviderAccountFolders;
use crate::driver::contract::account::HelperModeAccountLegs;
use crate::driver::contract::error::DriverError;

/// Codex's helper-mode account legs, which hold nothing.
pub(crate) struct CodexHelperModeLegs;

impl HelperModeAccountLegs for CodexHelperModeLegs {
    // Every Codex process of an account home runs with its sign-in kept in that home's `auth.json`,
    // so no keychain item holds it and nothing moves.
    fn keychain_sign_in(
        &self,
        _folders: &ProviderAccountFolders,
    ) -> Result<Option<KeychainSignIn>, DriverError> {
        Ok(None)
    }
}
