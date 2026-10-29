//! The sign-in to one MCP server through Claude Code's own client. The server's entry is copied
//! into a folder of the daemon's own, made for this sign-in alone, which one process that keeps
//! nothing runs on as its config and credential folder, loading that server: a person's entry
//! re-read from their config or a plugin's file, an organization's as the account's managed
//! settings declare it, or, for a server of an administrator's MCP file, none, the process then
//! loading that file itself. `mcp_authenticate` answers the authorization address the caller
//! opens; where the authorization server took the daemon's redirect address, the browser's return
//! is handed back with `mcp_oauth_callback_url`, whose answer comes once the sign-in is saved, and
//! where it refused that address Claude Code's own loopback listener takes the return, the saved
//! sign-in then waited for. The sign-in is read back from the folder's credentials file, else the
//! keychain item Claude Code files for the folder, which is removed once read; the process is
//! closed and the folder removed whatever the outcome, a dropped sign-in's included. The person's
//! own folders are only read, for the entry.

use std::error::Error;
use std::future;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};

use notify::{RecursiveMode, Watcher as _};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use sidekicks_contracts::mcp::server::config::McpServerAddress;
use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerName};
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use tokio::sync::watch;
use tokio::time::{Interval, MissedTickBehavior};
use url::Url;

use crate::driver::claude::account_credentials::{
    ClaudeCredentialReadError, ClaudeSignInReader, ClaudeStoredCredentials,
    SECURE_STORAGE_FOLDER_VARIABLE, read_claude_credential_file,
};
use crate::driver::claude::mcp::config::read_claude_mcp_server_entry;
use crate::driver::claude::mcp::organization::has_readable_managed_mcp_file;
use crate::driver::claude::session::account_servers::ClaudeAccountServerReads;
use crate::driver::claude::session::transport::channel::ClaudeProcessChannel;
use crate::driver::claude::session::transport::control::ClaudeControlRequest;
use crate::driver::claude::spawn::launch::installed_build::ClaudeProcessStarts;
use crate::driver::contract::DriverError;
use crate::driver::contract::sign_in::{
    BEARER_TOKEN_TYPE, NoPersonServerEntry, ProviderSignInBrowser, ProviderSignInTakeover,
    ProviderSignInTakeoverRequest,
};
use crate::driver::mcp_server::address::read_server_address;
use crate::driver::mcp_server::read::binding_server_name;
use crate::driver::mcp_server::sign_in_folder::{SignInFolder, remove_left_sign_in_folders};

/// The data folder's folder each sign-in makes its own folder in.
const CLAUDE_MCP_SIGN_IN_FOLDER: [&str; 2] = ["claude", "mcp-sign-in"];

/// The random bytes in one sign-in's folder name.
const SIGN_IN_FOLDER_NAME_BYTES: usize = 8;

/// The file in the sign-in's folder that declares its one server, which the process loads.
const SIGN_IN_SERVERS_FILE: &str = "sign-in-servers.json";

/// The member of a server file that lists servers by name.
const MCP_SERVERS_MEMBER: &str = "mcpServers";

/// The member of a server entry naming the client its owner issued, and that client's id.
const OAUTH_MEMBER: &str = "oauth";
const OAUTH_CLIENT_ID_MEMBER: &str = "clientId";

/// The `redirectScheme` Claude Code answers when the authorization server took the redirect
/// address it was sent, so the browser's return comes to the daemon.
const CUSTOM_REDIRECT_SCHEME: &str = "custom";

/// How often the loopback wait reads the keychain item, which no watch reports a write to.
const KEYCHAIN_CHECK_INTERVAL: Duration = Duration::from_secs(2);

/// Why a sign-in through Claude Code's own client did not answer credentials. No case carries a
/// credential value.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ClaudeSignInError {
    /// The binding's server is declared by no entry where its kind keeps one any more.
    #[error("no Claude Code config declares the MCP server named {name} any more")]
    ServerEntryGone {
        /// The server's name.
        name: String,
    },
    /// The sign-in's own folder or its server file could not be made.
    #[error("the folder Claude Code's MCP sign-in runs in could not be made")]
    FolderUnmade(#[source] Box<dyn Error + Send + Sync>),
    /// The caller stopped waiting before the browser opened or returned.
    #[error("the MCP sign-in's caller was gone before the browser returned")]
    CallerGone,
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
}

impl From<ClaudeSignInError> for DriverError {
    /// Every failure of the sign-in is the driver's own.
    fn from(error: ClaudeSignInError) -> Self {
        Self::Internal(Box::new(error))
    }
}

/// What starts the one process of a sign-in: its environment, the account it runs for, the
/// sign-in's own folder it runs in, and the file declaring the server it loads.
pub(crate) struct ClaudeMcpSignInStart {
    /// The process's whole environment, its config and credential folders the sign-in's own.
    pub(crate) environment: Vec<(String, String)>,
    /// The account the process runs for.
    pub(crate) provider_account_id: ProviderAccountId,
    /// The sign-in's own folder, where the process starts.
    pub(crate) folder: PathBuf,
    /// The file declaring the server, passed with `--mcp-config`.
    pub(crate) servers_file: PathBuf,
    /// Whether the process loads only the servers that file declares (`--strict-mcp-config`);
    /// never where an administrator's MCP file is deployed, under which Claude Code exits at start.
    pub(crate) loads_only_its_servers: bool,
}

/// The process `starts` brings up for a sign-in, as a channel the sign-in drives.
pub(crate) type ClaudeMcpSignInChannel = Arc<dyn ClaudeProcessChannel>;

/// Where a sign-in reads the server's entry and the saved sign-in, and makes its own folder.
pub(crate) struct ClaudeSignInSources<'sources> {
    /// The person's home folder, holding `.claude.json`.
    pub(crate) home_folder: &'sources Path,
    /// The daemon's plugin home for Claude Code.
    pub(crate) plugin_home: &'sources Path,
    /// The folder Claude Code reads its managed settings from; `None` where the system has none.
    pub(crate) managed_settings_folder: Option<&'sources Path>,
    /// The daemon's data folder.
    pub(crate) data_folder: &'sources Path,
    /// Each account's read of its organization's servers.
    pub(crate) account_servers: &'sources ClaudeAccountServerReads,
    /// Reads Claude Code's stored credentials and removes the sign-in's keychain item.
    pub(crate) credentials: &'sources ClaudeSignInReader,
}

/// Signs in to `request`'s server through Claude Code's own client, in one process `starts`
/// brings up with the environment `environment_on` composes for the sign-in's own folder. Fails
/// with [`DriverError::NoPersonServerEntry`] for a connector, as the entry's read, the
/// environment, the start or a control request fails, and with [`ClaudeSignInError`] for every
/// other failure; the process is closed and the folder removed either way.
pub(crate) async fn sign_in_with_claude_client(
    starts: &dyn ClaudeProcessStarts,
    sources: ClaudeSignInSources<'_>,
    environment_on: impl FnOnce(&Path) -> Result<Vec<(String, String)>, DriverError>,
    request: ProviderSignInTakeoverRequest,
) -> Result<ProviderSignInTakeover, DriverError> {
    let name = binding_server_name(&request.binding).clone();
    let has_managed_mcp_file = has_readable_managed_mcp_file(sources.managed_settings_folder).await;
    let entry = read_sign_in_entry(
        &sources,
        &request.binding,
        &request.provider_account_id,
        has_managed_mcp_file,
    )
    .await?;
    let configured_client_id = entry
        .as_ref()
        .and_then(|entry| entry.get(OAUTH_MEMBER))
        .and_then(|oauth| oauth.get(OAUTH_CLIENT_ID_MEMBER))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let servers: Map<String, Value> = entry
        .map(|entry| (name.as_str().to_owned(), Value::Object(entry)))
        .into_iter()
        .collect();
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
        let mut keychain_item = KeychainItemRemoval {
            credentials: sources.credentials.clone(),
            environment: environment.clone(),
            is_armed: true,
        };
        let channel = starts
            .start_mcp_sign_in(ClaudeMcpSignInStart {
                environment: environment.clone(),
                provider_account_id: request.provider_account_id.clone(),
                folder: folder.path().to_owned(),
                servers_file: folder.path().join(SIGN_IN_SERVERS_FILE),
                loads_only_its_servers: !has_managed_mcp_file,
            })
            .await?;
        let exchanged = run_sign_in(
            &*channel,
            SavedSignInPlaces {
                credentials: sources.credentials,
                environment: &environment,
                folder: folder.path(),
            },
            &name,
            &request.redirect_url,
            request.lifetime,
            request.browser,
        )
        .await;
        channel.close().await;
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
/// each one's keychain item first, read through `credentials`; an item not removed is logged.
/// Fails as the folders' removal fails.
pub(crate) async fn remove_left_claude_sign_ins(
    credentials: &ClaudeSignInReader,
    data_folder: &Path,
) -> Result<(), DriverError> {
    let parent = sign_in_parent(data_folder);
    if credentials.has_keychain() {
        for folder in list_left_folders(&parent).await? {
            let environment = [(
                SECURE_STORAGE_FOLDER_VARIABLE.to_owned(),
                folder.to_string_lossy().into_owned(),
            )];
            if let Err(error) = credentials.remove_keychain_record(&environment).await {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    "the keychain item of an MCP sign-in a previous run left was not removed"
                );
            }
        }
    }
    remove_left_sign_in_folders(&parent)
        .await
        .map_err(|error| DriverError::Internal(Box::new(error)))
}

// Every folder a stopped daemon left under `parent`; none where `parent` is absent.
async fn list_left_folders(parent: &Path) -> Result<Vec<PathBuf>, DriverError> {
    let internal = |error: std::io::Error| DriverError::Internal(Box::new(error));
    let mut entries = match tokio::fs::read_dir(parent).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(internal(error)),
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

// The entry the sign-in's servers file declares for `binding`'s server: the person's own, re-read
// with its values, for a user, local, project or plugin server; an organization's as `account`'s
// managed settings declare it; and none for a server of an administrator's MCP file, which the
// process then loads itself. Fails with `NoPersonServerEntry` for a connector, whose sign-in is
// the account's own, and with `ServerEntryGone` where the entry is gone.
async fn read_sign_in_entry(
    sources: &ClaudeSignInSources<'_>,
    binding: &McpServerBindingRef,
    account: &ProviderAccountId,
    has_managed_mcp_file: bool,
) -> Result<Option<Map<String, Value>>, DriverError> {
    let internal = |error: Box<dyn Error + Send + Sync>| DriverError::Internal(error);
    let entry = match binding {
        McpServerBindingRef::Connector { .. } => {
            return Err(DriverError::NoPersonServerEntry(NoPersonServerEntry {
                binding: binding.clone(),
            }));
        }
        McpServerBindingRef::Managed { server_name, .. } => {
            let servers = sources
                .account_servers
                .read(account, false)
                .await
                .map_err(|error| internal(Box::new(error)))?;
            match servers.organization_entries.get(server_name) {
                Some(entry) => {
                    Some(serde_json::to_value(entry).map_err(|error| internal(Box::new(error)))?)
                }
                None if has_managed_mcp_file => return Ok(None),
                None => None,
            }
        }
        McpServerBindingRef::User { .. }
        | McpServerBindingRef::Local { .. }
        | McpServerBindingRef::Project { .. }
        | McpServerBindingRef::Plugin { .. } => {
            read_claude_mcp_server_entry(sources.home_folder, sources.plugin_home, binding)
                .await
                .map_err(|error| internal(Box::new(error)))?
        }
    };
    match entry {
        Some(Value::Object(entry)) => Ok(Some(entry)),
        Some(
            Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) | Value::Array(_),
        )
        | None => Err(ClaudeSignInError::ServerEntryGone {
            name: binding_server_name(binding).as_str().to_owned(),
        }
        .into()),
    }
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
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthenticateReply {
    #[serde(default)]
    auth_url: Option<String>,
    #[serde(default)]
    redirect_scheme: Option<String>,
}

// Runs the sign-in on `channel`: the authorization address handed out through `browser`, then
// the browser's return handed back where the daemon's redirect address took it, else the saved
// sign-in waited for in `places`, each within `lifetime`. An answer with no address needs no
// person, and the saved sign-in is read as it stands.
async fn run_sign_in(
    channel: &dyn ClaudeProcessChannel,
    places: SavedSignInPlaces<'_>,
    name: &McpServerName,
    redirect_url: &Url,
    lifetime: Duration,
    browser: ProviderSignInBrowser,
) -> Result<(), DriverError> {
    let answer = channel
        .send_control_request(ClaudeControlRequest::McpAuthenticate {
            server_name: name.as_str().to_owned(),
            redirect_uri: redirect_url.as_str().to_owned(),
        })
        .await?;
    let reply: AuthenticateReply = answer
        .response
        .and_then(|reply| serde_json::from_str(reply.get()).ok())
        .unwrap_or_default();
    let Some(authorization_url) = reply.auth_url.and_then(|url| Url::parse(&url).ok()) else {
        return Ok(());
    };
    browser
        .authorization_url
        .send(authorization_url)
        .map_err(|_unsent| ClaudeSignInError::CallerGone)?;
    if reply.redirect_scheme.as_deref() != Some(CUSTOM_REDIRECT_SCHEME) {
        // Claude Code's own loopback listener takes the browser's return.
        drop(browser.browser_return);
        return Ok(wait_for_saved_sign_in(places, name, lifetime).await?);
    }
    let returned = tokio::time::timeout(lifetime, browser.browser_return)
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

// Whether `stored` holds a sign-in with an access token for `name`.
fn holds_sign_in_for(stored: &ClaudeStoredCredentials, name: &McpServerName) -> bool {
    stored.mcp_oauth.values().any(|sign_in| {
        sign_in.server_name.as_deref() == Some(name.as_str())
            && sign_in
                .access_token
                .as_deref()
                .is_some_and(|token| !token.is_empty())
    })
}

// Reads the sign-in Claude Code saved for `name` at `address` where it keeps it: the credential
// folder's file `environment` names, else the keychain item named for that folder, which is
// removed once read so no token outlives the sign-in. A removal that fails is logged where the
// read succeeded, and reported beside the read's failure where it did not.
async fn read_saved_sign_in(
    credentials: &ClaudeSignInReader,
    environment: &[(String, String)],
    name: &McpServerName,
    address: &McpServerAddress,
) -> Result<ClaudeSavedSignInReading, ClaudeSignInError> {
    let from_file = match read_claude_credential_file(environment).await {
        Ok(Some(stored)) => read_claude_saved_sign_in(stored, name, address),
        Ok(None) => Err(ClaudeSignInError::NoSavedSignIn),
        Err(error) => Err(ClaudeSignInError::CredentialsUnreadable(error)),
    };
    if from_file.is_ok() {
        return from_file;
    }
    let from_keychain = match credentials.read_keychain_record(environment).await {
        Ok(Some(stored)) => read_claude_saved_sign_in(stored, name, address),
        // Nothing in the keychain to read or remove: the file's outcome stands.
        Ok(None) => return from_file,
        Err(error) => Err(ClaudeSignInError::CredentialsUnreadable(error)),
    };
    match (
        from_keychain,
        credentials.remove_keychain_record(environment).await,
    ) {
        (from_keychain, Ok(_was_held)) => from_keychain,
        (Ok(reading), Err(removal)) => {
            tracing::warn!(
                error = &removal as &(dyn Error + 'static),
                "the keychain item of a read MCP sign-in was not removed"
            );
            Ok(reading)
        }
        (Err(read), Err(removal)) => Err(ClaudeSignInError::KeychainItemLeft {
            read: Box::new(read),
            removal,
        }),
    }
}

/// One saved MCP sign-in as Claude Code writes it in its stored credentials, each member read
/// leniently, since a stub for another server may lack any of them. It derives no `Debug`, since
/// it holds tokens.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClaudeSavedSignIn {
    #[serde(default)]
    server_name: Option<String>,
    #[serde(default)]
    server_url: Option<String>,
    #[serde(default)]
    access_token: Option<String>,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_at: Option<f64>,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    client_id: Option<String>,
    #[serde(default)]
    client_secret: Option<String>,
    #[serde(default)]
    issuer: Option<String>,
    #[serde(default)]
    discovery_state: Option<ClaudeDiscoveryState>,
}

// What Claude Code kept of the authorization server it found.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeDiscoveryState {
    #[serde(default)]
    authorization_server_url: Option<String>,
}

/// A saved sign-in read back, its client id where Claude Code kept one.
struct ClaudeSavedSignInReading {
    /// The credentials, their client id empty where Claude Code kept none.
    takeover: ProviderSignInTakeover,
    /// Whether the saved sign-in named its client.
    has_client_id: bool,
}

/// The sign-in `stored` holds for the server `name` at `address`, matched by the saved name and
/// address, never by Claude Code's key, whose hash Claude Code computes; the expiry Claude Code
/// keeps in milliseconds since the epoch, the scopes as one space-separated text. Fails with
/// `NoSavedSignIn` when none with an access token matches.
fn read_claude_saved_sign_in(
    stored: ClaudeStoredCredentials,
    name: &McpServerName,
    address: &McpServerAddress,
) -> Result<ClaudeSavedSignInReading, ClaudeSignInError> {
    let identity = read_server_address(address.as_str())
        .identity
        .ok_or(ClaudeSignInError::NoSavedSignIn)?;
    let sign_in = stored
        .mcp_oauth
        .into_values()
        .find(|sign_in| {
            sign_in.server_name.as_deref() == Some(name.as_str())
                && sign_in.server_url.as_deref().is_some_and(|url| {
                    read_server_address(url).identity.as_ref() == Some(&identity)
                })
                && sign_in
                    .access_token
                    .as_deref()
                    .is_some_and(|token| !token.is_empty())
        })
        .ok_or(ClaudeSignInError::NoSavedSignIn)?;
    let has_client_id = sign_in.client_id.is_some();
    Ok(ClaudeSavedSignInReading {
        takeover: ProviderSignInTakeover {
            access_token: sign_in.access_token.unwrap_or_default(),
            refresh_token: sign_in.refresh_token.filter(|token| !token.is_empty()),
            expires_at: sign_in
                .expires_at
                .filter(|milliseconds| milliseconds.is_finite() && *milliseconds >= 0.0)
                .map(|milliseconds| UNIX_EPOCH + Duration::from_secs_f64(milliseconds / 1000.0)),
            scopes: sign_in
                .scope
                .map(|scope| scope.split_whitespace().map(str::to_owned).collect())
                .unwrap_or_default(),
            token_type: BEARER_TOKEN_TYPE.to_owned(),
            client_id: sign_in.client_id.unwrap_or_default(),
            client_secret: sign_in.client_secret.filter(|secret| !secret.is_empty()),
            issuer: sign_in.issuer.or_else(|| {
                sign_in
                    .discovery_state
                    .and_then(|state| state.authorization_server_url)
            }),
        },
        has_client_id,
    })
}

// The saved sign-in with its client id, the one the server's owner issued where Claude Code
// kept none. Fails with `NoClient` where neither names one.
fn complete_client(
    saved: ClaudeSavedSignInReading,
    configured_client_id: Option<String>,
) -> Result<ProviderSignInTakeover, ClaudeSignInError> {
    let mut takeover = saved.takeover;
    if !saved.has_client_id {
        takeover.client_id = configured_client_id.ok_or(ClaudeSignInError::NoClient)?;
    }
    Ok(takeover)
}

#[cfg(test)]
mod tests;
