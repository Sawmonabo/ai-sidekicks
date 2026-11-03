//! Claude Code's account legs a helper mode runs, with no daemon serving and no database pool.

use std::path::PathBuf;
use std::sync::Arc;

use sidekicks_platforms::KeychainSignIn;

use crate::driver::claude::account::compose_account_environment;
use crate::driver::claude::account::sign_in_move::claude_keychain_sign_in;
use crate::driver::claude::spawn::environment::{ClaudeAccountFolders, ClaudeProcessHome};
use crate::driver::contract::account::HelperModeAccountLegs;
use crate::driver::contract::error::DriverError;
use crate::driver::{HelperModeServices, ProviderAccountFolders};
use crate::spawn_environment::ReservedEnvironmentNames;

/// Claude Code's helper-mode account legs, over what a session's process environment is composed
/// from, so each name they answer is the one a Claude Code process on that home files under.
pub(crate) struct ClaudeHelperModeLegs {
    data_folder: PathBuf,
    base_environment: Arc<[(String, String)]>,
    reserved_names: Arc<ReservedEnvironmentNames>,
}

impl ClaudeHelperModeLegs {
    /// The legs over `services`; they hold handles and do no I/O.
    pub(crate) fn new(services: &HelperModeServices) -> Self {
        Self {
            data_folder: services.data_folder.clone(),
            base_environment: Arc::clone(&services.base_environment),
            reserved_names: Arc::clone(&services.reserved_names),
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
        let environment = compose_account_environment(
            &self.data_folder,
            &self.base_environment,
            &self.reserved_names,
            ClaudeProcessHome::Account {
                folders: &claude_folders,
            },
            &[],
        )?;
        Ok(Some(claude_keychain_sign_in(&environment, folders)))
    }
}
