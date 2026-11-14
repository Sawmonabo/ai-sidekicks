//! The sign-in to one MCP server through Claude Code's own client. The server's entry is copied
//! into a folder of the daemon's own, made for this sign-in alone, which one process that keeps
//! nothing runs on as its config and credential folder, loading that server: a person's entry
//! re-read from their config or a plugin's file, or an organization's as the account's managed
//! settings declare it. Beside an administrator's MCP file the folder's file declares no server and
//! the process is handed none, since Claude Code then loads only the file's and the organization's
//! servers and exits at start when handed others: an organization's entry, the file's ahead of the
//! managed settings', is read only to match its address, and a person's own server is not signed in
//! to there. `mcp_authenticate` answers the authorization address the caller opens; where the
//! authorization server took the daemon's redirect address, the browser's return is handed back
//! with `mcp_oauth_callback_url`, whose answer comes once the sign-in is saved, and where it
//! refused that address Claude Code's own loopback listener takes the return, the saved sign-in
//! then waited for. What the process writes is read for its whole life: a frame reporting an error
//! ends the sign-in with that error, a request it waits on is answered as one no one watches, and
//! its end ends the sign-in. The sign-in is read back from the folder's credentials file, else the
//! keychain item Claude Code files for the folder, which is removed once read; the process is
//! closed and the folder removed whatever the outcome, a dropped sign-in's included. The folder
//! records the keychain account the item is filed under before the process starts, so a later
//! start removes the item of a folder a stopped daemon left. The person's own folders are only
//! read: for the entry, and for the secret of a client its owner issued, which the folder's
//! credentials file holds for the process before it starts, as the person's own credentials hold
//! it for their Claude Code.

pub(crate) mod address;
pub(crate) mod owner_client_secret;
pub(crate) mod saved_credentials;

use std::error::Error;
use std::future;
use std::path::{Path, PathBuf};
use std::time::Duration;

use notify::{RecursiveMode, Watcher as _};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::mcp::server::config::McpServerAddress;
use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerName};
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_ipc::redaction::sanitize_failure_reason;
use sidekicks_platforms::PathRules;
use sidekicks_std::missing_entry::MissingEntry as _;
use tokio::sync::{mpsc, oneshot, watch};
use tokio::time::{Interval, MissedTickBehavior};
use url::Url;

use self::owner_client_secret::write_claude_owner_client_secret;
use self::saved_credentials::{complete_client, holds_sign_in_for, read_saved_sign_in};
use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::account::credentials::{
    ClaudeCredentialReadError, ClaudeSignInReader, KEYCHAIN_ACCOUNT_VARIABLE,
    claude_keychain_account, read_claude_credential_file,
};
use crate::driver::claude::mcp::ClaudeMcpProcess;
use crate::driver::claude::mcp::config::{
    ClaudeDeclaredEntry, ClaudeOAuthMember, ClaudePersonConfigFiles, ClaudeServerEntryReader,
    MCP_SERVERS_MEMBER, OAUTH_MEMBER, URL_MEMBER,
};
use crate::driver::claude::mcp::machine_probe::variables::{
    ClaudePluginPlaceholders, expand_remote_address, fill_entry_plugin_placeholders,
};
use crate::driver::claude::mcp::organization::read_managed_entry;
use crate::driver::claude::session::account_servers::{
    ClaudeAccountReadAsk, ClaudeAccountServerReads,
};
use crate::driver::claude::session::errors::ClaudeSessionError;
use crate::driver::claude::session::process::ClaudeStreamFrame;
use crate::driver::claude::session::transport::channel::ClaudeProcessChannel;
use crate::driver::claude::session::transport::control::ClaudeControlRequest;
use crate::driver::claude::session::transport::inbound::ClaudeInboundRequestEvent;
use crate::driver::claude::session::transport::user_message::ClaudeWriteAttempt;
use crate::driver::claude::spawn::launch::control_only::ClaudeShortProcessArrival;
use crate::driver::claude::spawn::launch::installed_build::ClaudeProcessStarts;
use crate::driver::claude::spawn::launch::one_turn::compose_unwatched_answer;
use crate::driver::contract::error::DriverError;
use crate::driver::contract::sign_in::{
    NoPersonServerEntry, ProviderSignInFailure, ProviderSignInReturn, ProviderSignInTakeover,
    ProviderSignInTakeoverRequest,
};
use crate::driver::error_causes::provider_failure_refusal;
use crate::driver::mcp_server::address::names_server_at;
use crate::driver::mcp_server::sign_in_folder::SignInFolder;
use crate::driver::mcp_server::status::FAILURE_TEXT_MAX_CODE_POINTS;
use crate::spawn_environment::remove_environment_names;

/// The data folder's folder each sign-in makes its own folder in.
const CLAUDE_MCP_SIGN_IN_FOLDER: [&str; 2] = ["claude", "mcp-sign-in"];

/// The random bytes in one sign-in's folder name.
const SIGN_IN_FOLDER_NAME_BYTES: usize = 8;

/// The file in the sign-in's folder that declares its one server, which the process loads.
const SIGN_IN_SERVERS_FILE: &str = "sign-in-servers.json";

/// The file in the sign-in's folder recording the keychain account its process files the sign-in
/// under, which an environment row can set through `USER`.
pub(crate) const SIGN_IN_KEYCHAIN_ACCOUNT_FILE: &str = "keychain-account";

/// The `redirectScheme` Claude Code answers when the authorization server took the redirect
/// address it was sent, so the browser's return comes to the daemon.
const CUSTOM_REDIRECT_SCHEME: &str = "custom";

/// How often the loopback wait reads the keychain item, which no watch reports a write to.
const KEYCHAIN_CHECK_INTERVAL: Duration = Duration::from_secs(2);

/// Why a sign-in through Claude Code's own client did not answer credentials. No case carries a
/// credential value.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ClaudeSignInError {
    /// The sign-in's own folder, its server file or its keychain account's record could not be
    /// made.
    #[error("the folder Claude Code's MCP sign-in runs in could not be made")]
    FolderUnmade(#[source] Box<dyn Error + Send + Sync>),
    /// The caller stopped waiting before the browser opened or returned.
    #[error("the MCP sign-in's caller was gone before the browser returned")]
    CallerGone,
    /// The caller named no daemon receiver for the browser's return, which Claude Code's flow
    /// hands its authorization server.
    #[error("Claude Code's MCP sign-in was given no daemon receiver for the browser's return")]
    NoDaemonReceiver,
    /// The browser did not return, or the saved sign-in did not appear, within the lifetime.
    #[error("the MCP sign-in through Claude Code did not finish in time")]
    Unfinished,
    /// The watch of the sign-in's folder could not be set up or ended.
    #[error("the folder of Claude Code's MCP sign-in could not be watched")]
    WatchFailed(#[source] Box<dyn Error + Send + Sync>),
    /// The stored credentials could not be read, or did not read as Claude Code writes them.
    #[error("Claude Code's saved MCP sign-ins could not be read")]
    CredentialsUnreadable(#[source] ClaudeCredentialReadError),
    /// Neither the folder's credentials file nor the keychain item named for the folder holds a
    /// sign-in for the server.
    #[error("Claude Code saved no sign-in for the MCP server")]
    NoSavedSignIn,
    /// The saved sign-in was not read, and the keychain item it may sit in was not removed.
    #[error("{read}; the keychain item of the MCP sign-in was not removed")]
    KeychainItemLeft {
        /// Why the sign-in was not read.
        read: Box<ClaudeSignInError>,
        /// Why the item was not removed.
        #[source]
        removal: ClaudeCredentialReadError,
    },
    /// The saved sign-in names no client, and the server's entry names none either.
    #[error("Claude Code's saved MCP sign-in names no client")]
    NoClient,
    /// The sign-in's process wrote a frame reporting an error.
    #[error("Claude Code's MCP sign-in process reported an error")]
    ProcessReported(#[source] ClaudeReportedError),
    /// The sign-in's process ended before the sign-in did.
    #[error("Claude Code's MCP sign-in process ended before the sign-in finished")]
    ProcessEnded,
    /// The answer to the sign-in's request, or the authorization address in it, did not read as
    /// Claude Code writes them.
    #[error("Claude Code's answer to the MCP sign-in request could not be read")]
    ReplyUnreadable(#[source] Box<dyn Error + Send + Sync>),
}

/// The error text a Claude Code process reported in a frame, sanitized and cut to a bound.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub(crate) struct ClaudeReportedError(String);

impl From<ClaudeSignInError> for DriverError {
    /// A sign-in that ran out of time, an answer that does not read, or a sign-in Claude Code did
    /// not save whole is the sign-in's failure of that kind; a process that ended, or reported an
    /// error, before the sign-in finished answers `provider.unavailable` with its words bounded as
    /// `providerFailureDetail`; every other failure is the daemon's own.
    fn from(error: ClaudeSignInError) -> Self {
        match error {
            ClaudeSignInError::Unfinished => {
                Self::SignInFailed(ProviderSignInFailure::DidNotFinishInTime)
            }
            ClaudeSignInError::ReplyUnreadable(_cause) => {
                Self::SignInFailed(ProviderSignInFailure::ReplyUnreadable)
            }
            ClaudeSignInError::NoSavedSignIn | ClaudeSignInError::NoClient => {
                Self::SignInFailed(ProviderSignInFailure::SignInNotSaved)
            }
            ended @ (ClaudeSignInError::ProcessReported(_) | ClaudeSignInError::ProcessEnded) => {
                Self::from(provider_failure_refusal(
                    &DESCRIPTOR.provider_id(),
                    "Claude Code's MCP sign-in process failed before the sign-in finished",
                    RefusalCode::ProviderUnavailable,
                    ended,
                ))
            }
            other @ (ClaudeSignInError::FolderUnmade(_)
            | ClaudeSignInError::CallerGone
            | ClaudeSignInError::NoDaemonReceiver
            | ClaudeSignInError::WatchFailed(_)
            | ClaudeSignInError::CredentialsUnreadable(_)
            | ClaudeSignInError::KeychainItemLeft { .. }) => Self::Internal(Box::new(other)),
        }
    }
}

/// What starts the one process of a sign-in: its environment, the account it runs for, the
/// sign-in's own folder it runs in, and the file declaring the server it loads, where it is handed
/// one.
pub(crate) struct ClaudeMcpSignInStart {
    /// The process's whole environment, its config and credential folders the sign-in's own.
    pub(crate) environment: Vec<(String, String)>,
    /// The account the process runs for.
    pub(crate) provider_account_id: ProviderAccountId,
    /// The sign-in's own folder, where the process starts.
    pub(crate) folder: PathBuf,
    /// The file declaring the server, which the process loads alone (`--mcp-config` with
    /// `--strict-mcp-config`); `None` beside an administrator's MCP file, under which Claude Code
    /// exits at start on either flag and loads the file's and the organization's servers itself.
    pub(crate) servers_file: Option<PathBuf>,
}

/// Where a sign-in reads the server's entry and the saved sign-in, and makes its own folder.
pub(crate) struct ClaudeMcpSignInSources<'sources> {
    /// The person's own config files, as their environment places them.
    pub(crate) person: ClaudePersonConfigFiles,
    /// The daemon's plugin home for Claude Code.
    pub(crate) plugin_home: PathBuf,
    /// The servers of the administrator's MCP file Claude Code reads, `None` where none is
    /// deployed.
    pub(crate) managed_mcp_servers: Option<Map<String, Value>>,
    /// The system's managed settings folder, whose files are the administrator's own on this
    /// computer; `None` where the system has none.
    pub(crate) administrator_settings_folder: Option<PathBuf>,
    /// The daemon's data folder.
    pub(crate) data_folder: &'sources Path,
    /// Each account's read of its organization's servers.
    pub(crate) account_servers: &'sources ClaudeAccountServerReads,
    /// Reads Claude Code's stored credentials and removes the sign-in's keychain item.
    pub(crate) credentials: &'sources ClaudeSignInReader,
}

/// Signs in to `request`'s server through Claude Code's own client, in one process `starts`
/// brings up with the environment `environment_on` composes for the sign-in's own folder, the
/// entry's address read with its variables filled from that environment. Beside an administrator's
/// MCP file a user, local, project or plugin server fails with
/// [`DriverError::NoPersonServerEntry`] before its entry is read, a folder made or a process
/// started, since Claude Code loads none of them there, and an organization's server is signed in
/// to with no servers file, the process loading the file's and the organization's servers itself.
/// Fails with [`DriverError::NoPersonServerEntry`] for a connector or a binding whose entry is gone
/// or declares another address, as the entry's read, the environment, the start or a control
/// request fails, and with [`ClaudeSignInError`] for every other failure; the process is closed and
/// the folder removed either way.
pub(crate) async fn sign_in_with_claude_client(
    starts: &dyn ClaudeProcessStarts,
    sources: ClaudeMcpSignInSources<'_>,
    environment_on: impl FnOnce(&Path) -> Result<Vec<(String, String)>, DriverError>,
    request: ProviderSignInTakeoverRequest,
) -> Result<ProviderSignInTakeover, DriverError> {
    let (redirect_url, browser_return) = match request.browser_return {
        ProviderSignInReturn::ThroughDaemonReceiver {
            redirect_url,
            browser_return,
        } => (redirect_url, browser_return),
        ProviderSignInReturn::OwnListener => return Err(ClaudeSignInError::NoDaemonReceiver.into()),
    };
    let is_beside_managed_file = sources.managed_mcp_servers.is_some();
    // Claude Code loads no server of a person's own beside the administrator's file, a plugin's
    // included; whether a server can be loaded is asked here, the address read answering what its
    // entry declares.
    if is_beside_managed_file
        && matches!(
            request.binding,
            McpServerBindingRef::User { .. }
                | McpServerBindingRef::Local { .. }
                | McpServerBindingRef::Project { .. }
                | McpServerBindingRef::Plugin { .. }
        )
    {
        return Err(DriverError::from(NoPersonServerEntry {
            binding: request.binding,
        }));
    }
    let name = request.binding.server_name().clone();
    let entry = read_sign_in_entry(
        &sources,
        &mut ClaudeServerEntryReader::new(&sources.person, &sources.plugin_home),
        &request.binding,
        Some(&request.provider_account_id),
    )
    .await?;
    let configured_client_id = entry
        .get(OAUTH_MEMBER)
        .and_then(|oauth| ClaudeOAuthMember::deserialize(oauth).ok())
        .and_then(|oauth| oauth.read_sign_in().0.client_id);
    // A `url` naming no variable reads the same in any environment, so an entry at another server
    // is turned away here, before a folder is made or an environment composed for it.
    if !entry
        .get(URL_MEMBER)
        .and_then(Value::as_str)
        .is_some_and(|url| url.contains("${"))
        && !declares_server_at(&entry, &request.server_address, &[])
    {
        return Err(DriverError::from(NoPersonServerEntry {
            binding: request.binding,
        }));
    }
    // The entry goes to the folder as declared, since Claude Code fills its variables itself; none
    // goes beside the administrator's file, so no entry's values reach disk for a file not handed
    // to the process.
    let servers: Map<String, Value> = if is_beside_managed_file {
        Map::new()
    } else {
        std::iter::once((name.as_str().to_owned(), Value::Object(entry.clone()))).collect()
    };
    let folder = SignInFolder::make(
        &sign_in_parent(sources.data_folder),
        SIGN_IN_FOLDER_NAME_BYTES,
        SIGN_IN_SERVERS_FILE,
        json!({ MCP_SERVERS_MEMBER: servers }).to_string(),
    )
    .await
    .map_err(ClaudeSignInError::FolderUnmade)?;
    let signed_in = async {
        let environment = environment_on(folder.path())?;
        if !declares_server_at(&entry, &request.server_address, &environment) {
            return Err(DriverError::from(NoPersonServerEntry {
                binding: request.binding.clone(),
            }));
        }
        // Recorded before the process starts, so no item is filed that a later sweep cannot name.
        tokio::fs::write(
            folder.path().join(SIGN_IN_KEYCHAIN_ACCOUNT_FILE),
            claude_keychain_account(&environment),
        )
        .await
        .map_err(|error| ClaudeSignInError::FolderUnmade(Box::new(error)))?;
        if let Some(client_secret) = &request.owner_client_secret {
            write_claude_owner_client_secret(&name, &entry, &environment, client_secret)
                .await
                .map_err(ClaudeSignInError::FolderUnmade)?;
        }
        let mut keychain_item = KeychainItemRemoval {
            credentials: sources.credentials.clone(),
            environment: environment.clone(),
            is_armed: true,
        };
        let ClaudeMcpProcess {
            channel,
            mut arrivals,
        } = starts
            .start_mcp_sign_in(ClaudeMcpSignInStart {
                environment: environment.clone(),
                provider_account_id: request.provider_account_id.clone(),
                folder: folder.path().to_owned(),
                servers_file: (!is_beside_managed_file)
                    .then(|| folder.path().join(SIGN_IN_SERVERS_FILE)),
            })
            .await?;
        let exchanged = tokio::select! {
            // A report the process wrote before an answer it sent ends the sign-in first.
            biased;
            ended = read_sign_in_arrivals(&*channel, &mut arrivals) => Err(ended),
            exchanged = run_sign_in(
                &*channel,
                SavedSignInPlaces {
                    credentials: sources.credentials,
                    environment: &environment,
                    folder: folder.path(),
                },
                &name,
                request.lifetime,
                SignInBrowser {
                    authorization_url: request.authorization_url,
                    redirect_url: &redirect_url,
                    browser_return,
                },
            ) => exchanged,
        };
        channel.close().await;
        // What the process wrote after the exchange ended, read so none of it is dropped unread.
        while let Ok(arrival) = arrivals.try_recv() {
            if let ClaudeShortProcessArrival::Frame(frame) = arrival {
                tracing::debug!(
                    frame_kind = %frame.observation.frame_kind,
                    "Claude Code's MCP sign-in process wrote a frame as it closed"
                );
            }
        }
        exchanged?;
        let saved = read_saved_sign_in(
            sources.credentials,
            &environment,
            &name,
            &request.server_address,
        )
        .await;
        // The read removed the keychain item wherever it read one.
        keychain_item.is_armed = false;
        Ok::<_, DriverError>(complete_client(saved?, configured_client_id)?)
    }
    .await;
    match (signed_in, folder.remove().await) {
        (signed_in, Ok(())) => signed_in,
        (Ok(_takeover), Err(removal)) => Err(DriverError::Internal(Box::new(removal))),
        (Err(failure), Err(removal)) => {
            // The sign-in's own failure is the one the caller acts on.
            tracing::warn!(
                error = &removal as &(dyn Error + 'static),
                "the folder of a Claude Code MCP sign-in was not removed"
            );
            Err(failure)
        }
    }
}

/// Removes the folders of Claude Code MCP sign-ins a stopped daemon left under `data_folder`,
/// each one's keychain item first, removed through `credentials`: its service named by the
/// environment `environment_on` composes for the folder, and its account by the record the
/// sign-in kept there. An item not removed, a folder without its record included, is logged.
/// Fails as the folders' removal fails.
pub(crate) async fn remove_left_claude_sign_ins(
    credentials: &ClaudeSignInReader,
    data_folder: &Path,
    environment_on: impl Fn(&Path) -> Result<Vec<(String, String)>, DriverError>,
) -> Result<(), DriverError> {
    let parent = sign_in_parent(data_folder);
    if credentials.has_keychain() {
        for folder in list_left_folders(&parent).await? {
            let removed = remove_left_keychain_item(credentials, &folder, &environment_on).await;
            if let Err(error) = removed {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    "the keychain item of an MCP sign-in a previous run left was not removed"
                );
            }
        }
    }
    sidekicks_std::file::remove_tree_awaited(&parent)
        .await
        .map_err(|error| DriverError::Internal(Box::new(error)))
}

// Removes the keychain item of the sign-in that left `folder`, its account read from the folder's
// record over the environment `environment_on` composes for it. Fails as the record cannot be
// read, absent included, as the environment fails, and as the keychain refuses.
async fn remove_left_keychain_item(
    credentials: &ClaudeSignInReader,
    folder: &Path,
    environment_on: impl Fn(&Path) -> Result<Vec<(String, String)>, DriverError>,
) -> Result<(), DriverError> {
    let internal = |error: Box<dyn Error + Send + Sync>| DriverError::Internal(error);
    let account = tokio::fs::read_to_string(folder.join(SIGN_IN_KEYCHAIN_ACCOUNT_FILE))
        .await
        .map_err(|error| internal(Box::new(error)))?;
    let mut environment = environment_on(folder)?;
    remove_environment_names(
        &mut environment,
        &[KEYCHAIN_ACCOUNT_VARIABLE],
        PathRules::NATIVE,
    );
    environment.push((KEYCHAIN_ACCOUNT_VARIABLE.to_owned(), account));
    credentials
        .remove_keychain_record(&environment)
        .await
        .map(drop)
        .map_err(|error| internal(Box::new(error)))
}

// Every folder a stopped daemon left under `parent`; none where `parent` is absent.
async fn list_left_folders(parent: &Path) -> Result<Vec<PathBuf>, DriverError> {
    let internal = |error: std::io::Error| DriverError::Internal(Box::new(error));
    let Some(mut entries) = tokio::fs::read_dir(parent)
        .await
        .none_if_missing()
        .map_err(internal)?
    else {
        return Ok(Vec::new());
    };
    let mut folders = Vec::new();
    while let Some(entry) = entries.next_entry().await.map_err(internal)? {
        folders.push(entry.path());
    }
    Ok(folders)
}

// The folder each sign-in makes its own folder in, under `data_folder`.
fn sign_in_parent(data_folder: &Path) -> PathBuf {
    CLAUDE_MCP_SIGN_IN_FOLDER
        .iter()
        .fold(data_folder.to_path_buf(), |folder, part| folder.join(part))
}

// The entry `binding`'s server declares: the person's own, re-read with its values through
// `entries`, for a user, local, project or plugin server, a plugin's placeholders filled, since Claude Code fills them
// only in the plugin's own files; and for an organization's server the administrator's MCP file's
// entry of its name, else the one `account`'s managed settings declare, since Claude Code takes
// the file's entry where both define a name. Fails with `NoPersonServerEntry` for a connector,
// whose sign-in is the account's own, for an organization's server the file does not declare and
// no `account` is read for, and where no entry declares the server, so another provider's flow is
// asked.
async fn read_sign_in_entry(
    sources: &ClaudeMcpSignInSources<'_>,
    entries: &mut ClaudeServerEntryReader<'_>,
    binding: &McpServerBindingRef,
    account: Option<&ProviderAccountId>,
) -> Result<Map<String, Value>, DriverError> {
    let internal = |error: Box<dyn Error + Send + Sync>| DriverError::Internal(error);
    let no_entry = || {
        DriverError::from(NoPersonServerEntry {
            binding: binding.clone(),
        })
    };
    let entry = match binding {
        McpServerBindingRef::Connector { .. } => return Err(no_entry()),
        McpServerBindingRef::Managed { server_name, .. } => {
            let organization_entry = async {
                let Some(account) = account else {
                    return Err(no_entry());
                };
                Ok(sources
                    .account_servers
                    .read(account, ClaudeAccountReadAsk::List)
                    .await
                    .map_err(|error| internal(Box::new(error)))?
                    .organization_entries
                    .get(server_name)
                    .cloned())
            };
            read_managed_entry(
                sources.managed_mcp_servers.as_ref(),
                server_name,
                organization_entry,
            )
            .await?
            .map(Value::Object)
        }
        McpServerBindingRef::User { .. }
        | McpServerBindingRef::Local { .. }
        | McpServerBindingRef::Project { .. }
        | McpServerBindingRef::Plugin { .. } => entries
            .read(binding)
            .await
            .map_err(|error| internal(Box::new(error)))?
            .map(
                |ClaudeDeclaredEntry {
                     entry,
                     plugin_folders,
                 }| match plugin_folders {
                    Some(folders) => fill_entry_plugin_placeholders(
                        entry,
                        &ClaudePluginPlaceholders::new(&folders, None),
                    ),
                    None => entry,
                },
            ),
    };
    match entry {
        Some(Value::Object(entry)) => Ok(entry),
        Some(
            Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) | Value::Array(_),
        )
        | None => Err(no_entry()),
    }
}

// Whether `entry` declares its server at `address`, its `url` read with its variables filled from
// `environment`, the sign-in process's own, as Claude Code fills them before it connects.
fn declares_server_at(
    entry: &Map<String, Value>,
    address: &McpServerAddress,
    environment: &[(String, String)],
) -> bool {
    entry
        .get(URL_MEMBER)
        .and_then(Value::as_str)
        .is_some_and(|url| names_server_at(&expand_remote_address(url, environment), address))
}

// Removes, when dropped armed, the keychain item named for the sign-in's credential folder on a
// task of its own, so a sign-in dropped or failed before its read leaves no token in the keychain.
struct KeychainItemRemoval {
    credentials: ClaudeSignInReader,
    environment: Vec<(String, String)>,
    is_armed: bool,
}

impl Drop for KeychainItemRemoval {
    fn drop(&mut self) {
        if !self.is_armed || !self.credentials.has_keychain() {
            return;
        }
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            tracing::warn!(
                "the keychain item of a dropped MCP sign-in was not removed: no runtime"
            );
            return;
        };
        let credentials = self.credentials.clone();
        let environment = std::mem::take(&mut self.environment);
        runtime.spawn(async move {
            if let Err(error) = credentials.remove_keychain_record(&environment).await {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    "the keychain item of a dropped MCP sign-in was not removed"
                );
            }
        });
    }
}

// Where a sign-in's saved credentials appear: the folder's file, which the folder's watch
// reports, and the keychain item named for the folder, which `credentials` reads.
struct SavedSignInPlaces<'places> {
    credentials: &'places ClaudeSignInReader,
    environment: &'places [(String, String)],
    folder: &'places Path,
}

// The members of `mcp_authenticate`'s answer the sign-in reads.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthenticateReply {
    #[serde(default)]
    auth_url: Option<String>,
    #[serde(default)]
    redirect_scheme: Option<String>,
}

// The browser's legs of one sign-in: where its authorization address goes out, and the daemon's
// receiver the browser comes back to.
struct SignInBrowser<'redirect> {
    authorization_url: oneshot::Sender<Url>,
    redirect_url: &'redirect Url,
    browser_return: oneshot::Receiver<Url>,
}

// Runs the sign-in on `channel`: the authorization address handed out through `browser`, then
// the browser's return handed back where the daemon's receiver took it, else the saved sign-in
// waited for in `places`, each within `lifetime`. An answer with no address needs no person, and
// the saved sign-in is read as it stands; an answer or an address that does not read is the
// sign-in's failure.
async fn run_sign_in(
    channel: &dyn ClaudeProcessChannel,
    places: SavedSignInPlaces<'_>,
    name: &McpServerName,
    lifetime: Duration,
    browser: SignInBrowser<'_>,
) -> Result<(), DriverError> {
    let answer = channel
        .send_control_request(ClaudeControlRequest::McpAuthenticate {
            server_name: name.as_str().to_owned(),
            redirect_uri: browser.redirect_url.as_str().to_owned(),
        })
        .await?;
    let Some(reply) = answer.response else {
        return Ok(());
    };
    let reply: AuthenticateReply =
        serde_json::from_str(reply.get()).map_err(|error| reply_unreadable(Box::new(error)))?;
    let Some(authorization_url) = reply.auth_url else {
        return Ok(());
    };
    let authorization_url =
        Url::parse(&authorization_url).map_err(|error| reply_unreadable(Box::new(error)))?;
    let is_own_listener = reply.redirect_scheme.as_deref() != Some(CUSTOM_REDIRECT_SCHEME);
    let browser_return = if is_own_listener {
        // Claude Code's own loopback listener takes the browser's return, so it is given up before
        // the address goes out and the caller's listener closes as soon as the start settles.
        drop(browser.browser_return);
        None
    } else {
        Some(browser.browser_return)
    };
    browser
        .authorization_url
        .send(authorization_url)
        .map_err(|_unsent| ClaudeSignInError::CallerGone)?;
    let Some(browser_return) = browser_return else {
        return Ok(wait_for_saved_sign_in(places, name, lifetime).await?);
    };
    let returned = tokio::time::timeout(lifetime, browser_return)
        .await
        .map_err(|_elapsed| ClaudeSignInError::Unfinished)?
        .map_err(|_dropped| ClaudeSignInError::CallerGone)?;
    channel
        .send_control_request(ClaudeControlRequest::McpOauthCallbackUrl {
            server_name: name.as_str().to_owned(),
            callback_url: returned.into(),
        })
        .await?;
    Ok(())
}

// The failure of an answer to the sign-in's request that does not read, logged with its cause
// where it is raised.
fn reply_unreadable(cause: Box<dyn Error + Send + Sync>) -> ClaudeSignInError {
    tracing::warn!(
        error = &*cause as &(dyn Error + 'static),
        "Claude Code's answer to an MCP sign-in did not read"
    );
    ClaudeSignInError::ReplyUnreadable(cause)
}

// Reads what the sign-in's process writes until a frame reports an error, which it answers as the
// sign-in's failure, or the process ends: a request it waits on is answered as one no one watches
// answers it, and every other frame is noted at debug. Waits for ever once nothing more can
// arrive, the sign-in's own waits then deciding its end; fails as an answer cannot be written.
async fn read_sign_in_arrivals(
    channel: &dyn ClaudeProcessChannel,
    arrivals: &mut mpsc::UnboundedReceiver<ClaudeShortProcessArrival>,
) -> DriverError {
    loop {
        match arrivals.recv().await {
            Some(ClaudeShortProcessArrival::Frame(frame)) => {
                if let Some(text) = read_reported_error(&frame) {
                    return ClaudeSignInError::ProcessReported(ClaudeReportedError(text)).into();
                }
                tracing::debug!(
                    frame_kind = %frame.observation.frame_kind,
                    "Claude Code's MCP sign-in process wrote a frame"
                );
            }
            Some(ClaudeShortProcessArrival::Request(ClaudeInboundRequestEvent::Request(asked))) => {
                let answer =
                    serde_json::value::to_raw_value(&compose_unwatched_answer(&asked.body))
                        .expect("an answer the daemon composes always serializes");
                if let ClaudeWriteAttempt::Failed { cause, .. } = channel
                    .answer_inbound_request(asked.request_id, answer)
                    .await
                {
                    return ClaudeSessionError::InputUnwritable(cause).into();
                }
            }
            Some(ClaudeShortProcessArrival::Request(ClaudeInboundRequestEvent::Cancel {
                ..
            })) => {}
            Some(ClaudeShortProcessArrival::Exit) => return ClaudeSignInError::ProcessEnded.into(),
            None => return future::pending().await,
        }
    }
}

// The members of a frame that say it reports an error.
#[derive(Deserialize)]
struct ReportedErrorFrame {
    #[serde(default)]
    error: Option<Value>,
    #[serde(default)]
    is_error: Option<bool>,
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    errors: Vec<Value>,
}

// The error text `frame` reports, sanitized and cut to a bound: its `error`, as text or as an
// object's `message`, else, for a frame marked `is_error`, its `result` text, its `errors` joined,
// or its kind. `None` for a frame that reports no error.
fn read_reported_error(frame: &ClaudeStreamFrame) -> Option<String> {
    let read: ReportedErrorFrame = serde_json::from_str(&frame.text).ok()?;
    let text = if let Some(error) = read.error.filter(|error| !error.is_null()) {
        match error {
            Value::String(text) => text,
            other @ (Value::Null
            | Value::Bool(_)
            | Value::Number(_)
            | Value::Array(_)
            | Value::Object(_)) => other
                .get("message")
                .and_then(Value::as_str)
                .map_or_else(|| other.to_string(), str::to_owned),
        }
    } else if read.is_error == Some(true) {
        let errors: Vec<&str> = read.errors.iter().filter_map(Value::as_str).collect();
        match read.result.as_ref().and_then(Value::as_str) {
            Some(result) if !result.is_empty() => result.to_owned(),
            Some(_) | None if !errors.is_empty() => errors.join("; "),
            Some(_) | None => frame.observation.frame_kind.clone(),
        }
    } else {
        return None;
    };
    Some(sanitize_failure_reason(&text, FAILURE_TEXT_MAX_CODE_POINTS))
}

// Waits, within `lifetime`, until `places` hold a sign-in for `name`: the folder's file read again
// at each change in the folder, a file caught mid-write reading at the next change, and the
// keychain item read every `KEYCHAIN_CHECK_INTERVAL`, since a keychain has no watch, until a read
// of it fails.
async fn wait_for_saved_sign_in(
    places: SavedSignInPlaces<'_>,
    name: &McpServerName,
    lifetime: Duration,
) -> Result<(), ClaudeSignInError> {
    let watch_failed = |error: notify::Error| ClaudeSignInError::WatchFailed(Box::new(error));
    let (changed, mut changes) = watch::channel(0_u64);
    let mut watcher = notify::recommended_watcher(move |_event: notify::Result<notify::Event>| {
        changed.send_modify(|count| *count += 1);
    })
    .map_err(watch_failed)?;
    watcher
        .watch(places.folder, RecursiveMode::NonRecursive)
        .map_err(watch_failed)?;
    let mut keychain_checks = places.credentials.has_keychain().then(|| {
        let mut checks = tokio::time::interval(KEYCHAIN_CHECK_INTERVAL);
        checks.set_missed_tick_behavior(MissedTickBehavior::Delay);
        checks
    });
    tokio::time::timeout(lifetime, async {
        loop {
            if let Ok(Some(stored)) = read_claude_credential_file(places.environment).await
                && holds_sign_in_for(&stored, name)
            {
                return Ok(());
            }
            tokio::select! {
                changed = changes.changed() => {
                    changed.map_err(|error| ClaudeSignInError::WatchFailed(Box::new(error)))?;
                }
                () = next_check(keychain_checks.as_mut()) => {
                    match places.credentials.read_keychain_record(places.environment).await {
                        Ok(Some(stored)) if holds_sign_in_for(&stored, name) => return Ok(()),
                        Ok(_) => {}
                        Err(error) => {
                            tracing::debug!(
                                error = &error as &(dyn Error + 'static),
                                "an MCP sign-in's keychain item could not be read; only its \
                                 folder is watched from now on"
                            );
                            keychain_checks = None;
                        }
                    }
                }
            }
        }
    })
    .await
    .map_err(|_elapsed| ClaudeSignInError::Unfinished)?
}

// The next tick of `checks`, or never where there is none.
async fn next_check(checks: Option<&mut Interval>) {
    match checks {
        Some(checks) => {
            checks.tick().await;
        }
        None => future::pending().await,
    }
}

#[cfg(test)]
mod tests;
