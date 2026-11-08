//! The sign-in to an MCP server through Claude Code's own client, in a folder the daemon makes
//! for the sign-in, the read of the whole address a server's entry declares, and the removal of
//! the folders a stopped daemon's sign-ins left.

use std::path::Path;

use sidekicks_store::data_folder::plugin_home;

use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::lifecycle::ClaudeDriver;
use crate::driver::claude::mcp::config::ClaudePersonConfigFiles;
use crate::driver::claude::mcp::organization::has_readable_managed_mcp_file;
use crate::driver::claude::mcp::sign_in::address::read_claude_server_address;
use crate::driver::claude::mcp::sign_in::{
    ClaudeMcpSignInSources, remove_left_claude_sign_ins, sign_in_with_claude_client,
};
use crate::driver::claude::spawn::environment::ClaudeProcessHome;
use crate::driver::contract::error::DriverError;
use crate::driver::contract::sign_in::{
    McpServerAddressRead, McpServerAddressReading, ProviderSignInTakeover,
    ProviderSignInTakeoverRequest,
};

impl ClaudeDriver {
    /// Signs in to `request`'s server through Claude Code's own client, in a process whose config
    /// and credential folders are one the daemon makes for the sign-in and deletes after. Fails as
    /// the sign-in through Claude Code fails.
    pub(crate) async fn sign_in_with_own_client(
        &self,
        request: ProviderSignInTakeoverRequest,
    ) -> Result<ProviderSignInTakeover, DriverError> {
        sign_in_with_claude_client(
            &*self.starts,
            self.sign_in_sources().await,
            |folder| self.sign_in_environment(folder),
            request,
        )
        .await
    }

    /// Reads the whole address `request`'s server entry declares, its variables filled from the
    /// base environment every Claude Code process starts from. Fails as
    /// `read_claude_server_address` does.
    pub(crate) async fn read_mcp_server_address(
        &self,
        request: McpServerAddressRead,
    ) -> Result<McpServerAddressReading, DriverError> {
        read_claude_server_address(
            &self.sign_in_sources().await,
            &self.sources.base_environment,
            &request,
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

    // Where an MCP sign-in reads its server's entry and saved sign-in: the person's files as the
    // base environment places them, the plugin home, and whether an administrator's MCP file is
    // deployed.
    async fn sign_in_sources(&self) -> ClaudeMcpSignInSources<'_> {
        let managed_settings_folder = DESCRIPTOR.managed_settings_folder();
        ClaudeMcpSignInSources {
            person: ClaudePersonConfigFiles::resolve(
                &self.sources.base_environment,
                &self.sources.home_folder,
            )
            .await,
            plugin_home: plugin_home(&self.sources.home_folder, &DESCRIPTOR.provider_id()),
            has_managed_mcp_file: has_readable_managed_mcp_file(managed_settings_folder.as_deref())
                .await,
            data_folder: &self.sources.data_folder,
            account_servers: &self.account_servers,
            credentials: &self.credentials,
        }
    }

    // The environment of an MCP sign-in's process on its own `folder`, which also names the
    // keychain item the process files the sign-in under.
    fn sign_in_environment(&self, folder: &Path) -> Result<Vec<(String, String)>, DriverError> {
        self.sources
            .process_environment(ClaudeProcessHome::Throwaway { folder }, &[], &[])
    }
}
