//! Claude Code's account legs a helper mode runs, with no daemon serving and no database pool: the
//! names of a home's sign-in, and the home's sign-out through the one the running daemon's legs
//! run.

use std::path::PathBuf;
use std::sync::Arc;

use futures::FutureExt;
use futures::future::BoxFuture;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_platforms::{KeychainSignIn, Spawner};

use crate::command_search::ProviderCommandSearch;
use crate::driver::claude::account::compose_account_environment;
use crate::driver::claude::account::sign_in_move::claude_keychain_sign_in;
use crate::driver::claude::account::sign_out::{ClaudeSignOutSources, sign_out_claude_home};
use crate::driver::claude::spawn::environment::{ClaudeAccountFolders, ClaudeProcessHome};
use crate::driver::contract::account::HelperModeAccountLegs;
use crate::driver::contract::error::DriverError;
use crate::driver::{HelperModeServices, ProviderAccountFolders};
use crate::spawn_environment::ReservedEnvironmentNames;

/// Claude Code's helper-mode account legs, over what a session's process environment is composed
/// from, so each name they answer is the one a Claude Code process on that home files under, and
/// what the installed build is found and started by.
pub(crate) struct ClaudeHelperModeLegs {
    spawner: Spawner,
    command_search: Arc<ProviderCommandSearch>,
    home_folder: PathBuf,
    data_folder: PathBuf,
    base_environment: Arc<[(String, String)]>,
    reserved_names: Arc<ReservedEnvironmentNames>,
}

impl ClaudeHelperModeLegs {
    /// The legs over `services`; they hold handles and do no I/O.
    pub(crate) fn new(services: &HelperModeServices) -> Self {
        Self {
            spawner: services.spawner.clone(),
            command_search: Arc::clone(&services.command_search),
            home_folder: services.home_folder.clone(),
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

    fn sign_out_home(
        &self,
        _provider_account_id: ProviderAccountId,
        folders: ProviderAccountFolders,
    ) -> BoxFuture<'_, Result<(), DriverError>> {
        let sources = ClaudeSignOutSources {
            spawner: &self.spawner,
            command_search: &self.command_search,
            home_folder: &self.home_folder,
            data_folder: &self.data_folder,
            base_environment: &self.base_environment,
            reserved_names: &self.reserved_names,
        };
        sign_out_claude_home(sources, folders).boxed()
    }
}
