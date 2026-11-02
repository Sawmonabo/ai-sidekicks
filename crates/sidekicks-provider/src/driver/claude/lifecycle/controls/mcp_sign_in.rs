//! The sign-in to an MCP server through Claude Code's own client, in a folder the daemon makes
//! for the sign-in, and the removal of the folders a stopped daemon's sign-ins left.

use std::path::Path;

use sidekicks_store::data_folder::plugin_home;

use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::lifecycle::ClaudeDriver;
use crate::driver::claude::mcp::config::ClaudePersonConfigFiles;
use crate::driver::claude::mcp::sign_in::{
    ClaudeSignInSources, remove_left_claude_sign_ins, sign_in_with_claude_client,
};
use crate::driver::claude::spawn::environment::ClaudeProcessHome;
use crate::driver::contract::error::DriverError;
use crate::driver::contract::sign_in::{ProviderSignInTakeover, ProviderSignInTakeoverRequest};

impl ClaudeDriver {
    /// Signs in to `request`'s server through Claude Code's own client, in a process whose config
    /// and credential folders are one the daemon makes for the sign-in and deletes after. Fails as
    /// the sign-in through Claude Code fails.
    pub(crate) async fn sign_in_with_own_client(
        &self,
        request: ProviderSignInTakeoverRequest,
    ) -> Result<ProviderSignInTakeover, DriverError> {
        let plugin_home = plugin_home(&self.sources.home_folder, &DESCRIPTOR.provider_id());
        let managed_settings_folder = DESCRIPTOR.managed_settings_folder();
        let person = ClaudePersonConfigFiles::resolve(
            &self.sources.base_environment,
            &self.sources.home_folder,
        )
        .await;
        sign_in_with_claude_client(
            &*self.starts,
            ClaudeSignInSources {
                person: &person,
                plugin_home: &plugin_home,
                managed_settings_folder: managed_settings_folder.as_deref(),
                data_folder: &self.sources.data_folder,
                account_servers: &self.account_servers,
                credentials: &self.credentials,
            },
            |folder| self.sign_in_environment(folder),
            request,
        )
        .await
    }

    /// Removes the folders, and their keychain items, of MCP sign-ins a stopped daemon left.
    /// Fails as the folders' removal fails.
    pub(crate) async fn remove_left_sign_in_folders(&self) -> Result<(), DriverError> {
        remove_left_claude_sign_ins(&self.credentials, &self.sources.data_folder, |folder| {
            self.sign_in_environment(folder)
        })
        .await
    }

    // The environment of an MCP sign-in's process on its own `folder`, which also names the
    // keychain item the process files the sign-in under.
    fn sign_in_environment(&self, folder: &Path) -> Result<Vec<(String, String)>, DriverError> {
        self.sources
            .process_environment(ClaudeProcessHome::Throwaway { folder }, &[], &[])
    }
}
