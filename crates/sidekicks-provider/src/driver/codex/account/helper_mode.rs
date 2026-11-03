//! Codex's account legs a helper mode runs, with no daemon serving and no database pool: no
//! sign-in to move, and a home's sign-out by a short-lived `codex logout` in place of the running
//! daemon's request on the home's service.

use std::path::PathBuf;
use std::sync::Arc;

use futures::FutureExt;
use futures::future::BoxFuture;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_platforms::{KeychainSignIn, Spawner};

use crate::driver::codex::account::sign_out::run_codex_sign_out;
use crate::driver::codex::service::program::CodexInstalledProgram;
use crate::driver::contract::account::HelperModeAccountLegs;
use crate::driver::contract::error::DriverError;
use crate::driver::{HelperModeServices, ProviderAccountFolders};

/// Codex's helper-mode account legs, over the installed build every Codex process of a home runs
/// and what starts it.
pub(crate) struct CodexHelperModeLegs {
    program: CodexInstalledProgram,
    spawner: Spawner,
    data_folder: PathBuf,
}

impl CodexHelperModeLegs {
    /// The legs over `services`; they hold handles and do no I/O.
    pub(crate) fn new(services: &HelperModeServices) -> Self {
        Self {
            program: CodexInstalledProgram::new(
                Arc::clone(&services.command_search),
                services.home_folder.clone(),
                Arc::clone(&services.base_environment),
                Arc::clone(&services.reserved_names),
            ),
            spawner: services.spawner.clone(),
            data_folder: services.data_folder.clone(),
        }
    }
}

impl HelperModeAccountLegs for CodexHelperModeLegs {
    // Every Codex process of an account home runs with its sign-in kept in that home's `auth.json`,
    // so no keychain item holds it and nothing moves.
    fn keychain_sign_in(
        &self,
        _folders: &ProviderAccountFolders,
    ) -> Result<Option<KeychainSignIn>, DriverError> {
        Ok(None)
    }

    fn sign_out_home(
        &self,
        provider_account_id: ProviderAccountId,
        folders: ProviderAccountFolders,
    ) -> BoxFuture<'_, Result<(), DriverError>> {
        run_codex_sign_out(
            &self.program,
            &self.spawner,
            &self.data_folder,
            provider_account_id,
            folders,
        )
        .boxed()
    }
}
