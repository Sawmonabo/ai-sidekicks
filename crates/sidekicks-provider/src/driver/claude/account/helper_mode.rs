//! Claude Code's account legs a helper mode runs, with no daemon serving and no database pool: the
//! names of a home's sign-in, and the home's sign-out through the one the running daemon's legs
//! run.

use futures::FutureExt;
use futures::future::BoxFuture;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_platforms::KeychainSignIn;

use crate::driver::claude::account::ClaudeAccountProcessSources;
use crate::driver::claude::account::sign_in_move::claude_keychain_sign_in;
use crate::driver::claude::account::sign_out::sign_out_claude_home;
use crate::driver::claude::spawn::environment::{ClaudeAccountFolders, ClaudeProcessHome};
use crate::driver::contract::account::HelperModeAccountLegs;
use crate::driver::contract::error::DriverError;
use crate::driver::{HelperModeServices, ProviderAccountFolders};

/// Claude Code's helper-mode account legs, over the sources a session's process on an account's
/// home starts from, so each name they answer is the one a Claude Code process on that home files
/// under, and its sign-out runs the build such a process runs.
pub(crate) struct ClaudeHelperModeLegs {
    sources: ClaudeAccountProcessSources,
}

impl ClaudeHelperModeLegs {
    /// The legs over `services`; they hold handles and do no I/O.
    pub(crate) fn new(services: &HelperModeServices) -> Self {
        Self {
            sources: ClaudeAccountProcessSources::new(services),
        }
    }
}

impl HelperModeAccountLegs for ClaudeHelperModeLegs {
    // Claude Code keeps each account's sign-in in the login keychain, in the item its process on
    // the account's home names.
    fn keychain_sign_in(
        &self,
        folders: &ProviderAccountFolders,
    ) -> Result<Option<KeychainSignIn>, DriverError> {
        let claude_folders = ClaudeAccountFolders::from(folders);
        let environment = self.sources.compose_environment_on(
            ClaudeProcessHome::Account {
                folders: &claude_folders,
            },
            &[],
        )?;
        Ok(Some(claude_keychain_sign_in(&environment, folders)))
    }

    fn sign_out_home(
        &self,
        _provider_account_id: ProviderAccountId,
        folders: ProviderAccountFolders,
    ) -> BoxFuture<'_, Result<(), DriverError>> {
        sign_out_claude_home(&self.sources, folders).boxed()
    }
}
