//! The Claude Code driver's account legs: Claude Code's own acts on one account's home, each run
//! on the folders the caller names, and where its memory import reads and lands.

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the driver hands its account legs to the account plane once it is wired"
    )
)]
mod sign_out;

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the driver hands its account legs to the account plane once it is wired"
    )
)]
mod memory;

use std::io;
use std::path::PathBuf;
use std::sync::Arc;

use futures::FutureExt;
use futures::future::BoxFuture;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_platforms::Spawner;

use crate::account::credential_home::CredentialHome;
use crate::command_search::ProviderCommandSearch;
use crate::driver::contract::account::{
    MemoryImportStore, ProviderAccountLegs, ProviderMemoryImportLegs,
};
use crate::driver::contract::error::DriverError;
use crate::driver::{DriverServices, ProviderAccountFolders};
use crate::spawn_environment::ReservedEnvironmentNames;

/// What Claude Code's account legs start their processes from: the installed build, found as a
/// session's is, and the environment every Claude Code process is composed over.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the driver hands its account legs to the account plane once it is wired"
    )
)]
pub(crate) struct ClaudeAccountLegs {
    spawner: Spawner,
    command_search: Arc<ProviderCommandSearch>,
    home_folder: PathBuf,
    data_folder: PathBuf,
    base_environment: Arc<[(String, String)]>,
    reserved_names: Arc<ReservedEnvironmentNames>,
}

impl ClaudeAccountLegs {
    /// The legs over the shared services; they hold handles and do no I/O.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the driver hands its account legs to the account plane once it is wired"
        )
    )]
    pub(crate) fn new(services: &DriverServices) -> Self {
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

impl ProviderAccountLegs for ClaudeAccountLegs {
    fn sign_out_home(
        &self,
        provider_account_id: ProviderAccountId,
        folders: ProviderAccountFolders,
    ) -> BoxFuture<'_, Result<(), DriverError>> {
        sign_out::sign_out_claude_home(self, provider_account_id, folders).boxed()
    }
}

impl ProviderMemoryImportLegs for ClaudeAccountLegs {
    fn memory_import_stores(&self, home: &CredentialHome) -> io::Result<Vec<MemoryImportStore>> {
        memory::claude_memory_import_stores(self, home)
    }
}
