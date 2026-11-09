//! The sign-in to an MCP server through Claude Code's own client, in a folder the daemon makes
//! for the sign-in, the read of the whole address a server's entry declares, and the removal of
//! the folders a stopped daemon's sign-ins left.

use std::path::Path;

use serde_json::{Map, Value};
use sidekicks_contracts::machine::settings::EnvironmentRow;
use sidekicks_store::data_folder::plugin_home;

use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::lifecycle::ClaudeDriver;
use crate::driver::claude::mcp::config::ClaudePersonConfigFiles;
use crate::driver::claude::mcp::organization::read_managed_mcp_servers;
use crate::driver::claude::mcp::sign_in::address::read_claude_server_addresses;
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
    /// and credential folders are one the daemon makes for the sign-in and deletes after, started
    /// with `request`'s environment rows as a session's process is. Fails as the sign-in through
    /// Claude Code fails.
    pub(crate) async fn sign_in_with_own_client(
        &self,
        mut request: ProviderSignInTakeoverRequest,
    ) -> Result<ProviderSignInTakeover, DriverError> {
        let every_project_rows = std::mem::take(&mut request.every_project_rows);
        let project_rows = std::mem::take(&mut request.project_rows);
        sign_in_with_claude_client(
            &*self.starts,
            self.sign_in_sources().await,
            |folder| self.sign_in_environment(folder, &every_project_rows, &project_rows),
            request,
        )
        .await
    }

    /// Reads the whole address each of `requests`' server entries declares, in their order, its
    /// variables filled as a Claude Code process fills them: from the base environment with its
    /// request's environment rows over it, the names that process withholds withheld, and no home
    /// of the daemon's set; the administrator's MCP file and each of the person's files are read
    /// once for the batch. Each reading fails as its environment's composition or its entry's read
    /// fails.
    pub(crate) async fn read_mcp_server_addresses(
        &self,
        requests: Vec<McpServerAddressRead>,
    ) -> Vec<Result<McpServerAddressReading, DriverError>> {
        let sources = self.sign_in_sources().await;
        read_claude_server_addresses(&sources, requests, |request| {
            self.sources
                .environment_without_home(&request.every_project_rows, &request.project_rows)
        })
        .await
    }

    /// Removes the folders, and their keychain items, of MCP sign-ins a stopped daemon left, each
    /// item's account read from the folder's record. Fails as the folders' removal fails.
    pub(crate) async fn remove_left_sign_in_folders(&self) -> Result<(), DriverError> {
        remove_left_claude_sign_ins(&self.credentials, &self.sources.data_folder, |folder| {
            self.sign_in_environment(folder, &[], &[])
        })
        .await
    }

    // Where an MCP sign-in reads its server's entry and saved sign-in, the administrator's MCP file
    // read from the system's managed settings folder.
    async fn sign_in_sources(&self) -> ClaudeMcpSignInSources<'_> {
        let managed_mcp_servers =
            read_managed_mcp_servers(DESCRIPTOR.managed_settings_folder().as_deref()).await;
        self.sign_in_sources_for(managed_mcp_servers).await
    }

    /// Where an MCP sign-in reads its server's entry and saved sign-in: the person's files as the
    /// base environment places them, the plugin home, and `managed_mcp_servers`, the servers of
    /// the administrator's MCP file, `None` where none is deployed.
    pub(crate) async fn sign_in_sources_for(
        &self,
        managed_mcp_servers: Option<Map<String, Value>>,
    ) -> ClaudeMcpSignInSources<'_> {
        ClaudeMcpSignInSources {
            person: ClaudePersonConfigFiles::resolve(
                &self.sources.base_environment,
                &self.sources.home_folder,
            )
            .await,
            plugin_home: plugin_home(&self.sources.home_folder, &DESCRIPTOR.provider_id()),
            managed_mcp_servers,
            data_folder: &self.sources.data_folder,
            account_servers: &self.account_servers,
            credentials: &self.credentials,
        }
    }

    /// The environment of an MCP sign-in's process on its own `folder`, with the environment rows
    /// given, which also names the keychain item the process files the sign-in under. Fails as
    /// the environment's composition fails.
    pub(crate) fn sign_in_environment(
        &self,
        folder: &Path,
        every_project_rows: &[EnvironmentRow],
        project_rows: &[EnvironmentRow],
    ) -> Result<Vec<(String, String)>, DriverError> {
        self.sources.process_environment(
            ClaudeProcessHome::Throwaway { folder },
            every_project_rows,
            project_rows,
        )
    }
}
