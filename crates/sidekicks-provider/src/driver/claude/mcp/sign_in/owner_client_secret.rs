//! The secret of the client a server's owner issued, read where Claude Code reads it for the entry
//! a sign-in through Claude Code copies: for an organization's server, the program its entry's
//! `oauth.clientSecretHelper` names, which overrides the entry's `oauth.clientSecret`, else that
//! member; else, for any server, the secret `claude mcp add --client-secret` kept in the person's
//! Claude Code credentials under the key Claude Code files the server's sign-in under. Each is
//! read only where the entry names `oauth.clientId`, and none is kept here or printed. A helper is
//! run only where the administrator's own files on this computer name it for the entry: the MCP
//! file's entry, or a `managedMcpServers` entry of the managed settings files with the same helper.
//! Any other `managedMcpServers` entry can come from the organization's remote settings, whose
//! helpers need the person's consent, Claude Code records no consent to an MCP entry's helper, and
//! its merged settings do not say which source an entry came from. A sign-in through Claude Code's
//! own client finds the secret under the same keys in its own folder's credentials file.

use std::collections::BTreeMap;
use std::error::Error;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use secrecy::{ExposeSecret as _, SecretString};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::Digest as _;
use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerName};
use sidekicks_platforms::{LeftoverSweep, Spawner, replace_file_atomically};
use tokio::io::{AsyncRead, AsyncReadExt as _};
use zeroize::Zeroizing;

use super::{ClaudeMcpSignInSources, read_sign_in_entry};
use crate::driver::claude::account::credentials::{
    CLAUDE_CREDENTIALS_FILE, ClaudeCredentialReadError, ClaudeSignInReader,
    ClaudeStoredClientSecrets, claude_credential_folder, environment_home,
    read_claude_credential_file, read_secret,
};
use crate::driver::claude::mcp::config::{ClaudeServerEntryReader, OAUTH_MEMBER, URL_MEMBER};
use crate::driver::claude::mcp::machine_probe::variables::expand_remote_address;
use crate::driver::claude::mcp::organization::MANAGED_MCP_SERVERS_SETTING;
use crate::driver::claude::session::settings_file::{
    find_claude_setting, read_claude_managed_settings,
};
use crate::driver::contract::error::DriverError;
use crate::driver::contract::sign_in::McpServerAddressRead;

/// The member of an entry's `oauth` naming the client its owner issued.
const CLIENT_ID_MEMBER: &str = "clientId";
/// The member of an entry's `oauth` holding the client's secret.
const CLIENT_SECRET_MEMBER: &str = "clientSecret";
/// The member of an entry's `oauth` naming the program that prints the client's secret.
const CLIENT_SECRET_HELPER_MEMBER: &str = "clientSecretHelper";
/// The member of a server entry naming its transport, which Claude Code's key hashes.
const TYPE_MEMBER: &str = "type";
/// The member of a server entry holding its headers, which Claude Code's key hashes.
const HEADERS_MEMBER: &str = "headers";
/// The hex digits of the entry's hash Claude Code's key keeps.
const KEY_HASH_DIGITS: usize = 16;
/// How long the helper may run before its secret counts as unreadable, as Claude Code bounds it.
const HELPER_TIME_LIMIT: Duration = Duration::from_secs(30);
/// How much the helper may write to its two outputs together, as Claude Code bounds it.
const HELPER_OUTPUT_LIMIT: u64 = 64 * 1024;

/// Why the owner's client secret could not be read. No case carries the secret or the helper's
/// output.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ClaudeOwnerSecretError {
    /// The person's Claude Code credentials could not be read.
    #[error("the person's Claude Code credentials could not be read for the client secret")]
    Credentials(#[source] ClaudeCredentialReadError),
    /// The helper's path is not an absolute one, which Claude Code requires.
    #[error("the client secret helper is not named by an absolute path")]
    HelperPathNotAbsolute,
    /// The helper could not be started or read.
    #[error("the client secret helper could not be run")]
    HelperUnrun(#[source] std::io::Error),
    /// The helper did not end within its time.
    #[error("the client secret helper did not end in time")]
    HelperUnfinished,
    /// The helper wrote more than its outputs may hold together.
    #[error("the client secret helper wrote more than its outputs may hold")]
    HelperOutputTooLong,
    /// The helper ended with an exit code other than 0, or by a signal.
    #[error("the client secret helper did not end successfully")]
    HelperFailed,
    /// The helper's output is not exactly one object holding a non-empty `clientSecret`.
    #[error("the client secret helper printed no client secret")]
    HelperOutputUnreadable,
    /// The helper is named by a `managedMcpServers` entry no file of the administrator's on this
    /// computer names it for, which remote settings may deliver, and no record shows the person
    /// consented to running it, so it is never started.
    #[error("the client secret helper may come from remote settings and has no recorded consent")]
    HelperWithoutConsent,
}

impl From<ClaudeOwnerSecretError> for DriverError {
    fn from(error: ClaudeOwnerSecretError) -> Self {
        Self::Internal(Box::new(error))
    }
}

/// Reads the secret of the client the server's owner issued for `request`'s entry, the entry read
/// as a sign-in reads it from `sources`, with `environment` the person's own as a Claude Code
/// process fills an entry from: an organization's helper is run there with `spawner` in the
/// environment's home, else the daemon's, and the credentials are read from the folder it names,
/// else the keychain item `credentials` reads for it. `None` where the entry names no client id or
/// no secret is kept for it. Fails as the entry's read does, as the credentials cannot be read and
/// as the helper fails.
pub(crate) async fn read_claude_owner_client_secret(
    sources: &ClaudeMcpSignInSources<'_>,
    credentials: &ClaudeSignInReader,
    spawner: &Spawner,
    request: &McpServerAddressRead,
    environment: &[(String, String)],
) -> Result<Option<SecretString>, DriverError> {
    let mut entries = ClaudeServerEntryReader::new(&sources.person, &sources.plugin_home);
    let entry = read_sign_in_entry(
        sources,
        &mut entries,
        &request.binding,
        request.provider_account_id.as_ref(),
    )
    .await?;
    let Some(oauth) = entry.get(OAUTH_MEMBER).and_then(Value::as_object) else {
        return Ok(None);
    };
    if non_empty_text(oauth, CLIENT_ID_MEMBER).is_none() {
        return Ok(None);
    }
    // Only the organization's managed entries carry a secret or its helper; a person's file that
    // names either is never run or sent, as Claude Code's own schema for it holds neither.
    if matches!(request.binding, McpServerBindingRef::Managed { .. }) {
        if let Some(helper) = non_empty_text(oauth, CLIENT_SECRET_HELPER_MEMBER) {
            if !is_administrators_helper(sources, &request.binding, helper).await {
                return Err(ClaudeOwnerSecretError::HelperWithoutConsent.into());
            }
            let folder = environment_home(environment);
            return Ok(Some(
                run_client_secret_helper(spawner, Path::new(helper), environment, folder).await?,
            ));
        }
        if let Some(secret) = non_empty_text(oauth, CLIENT_SECRET_MEMBER) {
            return Ok(Some(SecretString::from(secret)));
        }
    }
    let keys = claude_server_keys(request.binding.server_name(), &entry, environment);
    Ok(read_stored_client_secret(credentials, environment, &keys).await?)
}

/// Writes `client_secret` into the credentials file of the Claude Code process started in
/// `environment`, under each key Claude Code files the server `name` declared by `entry` under, so
/// that process's own client signs in as the client the server's owner issued, as the person's
/// Claude Code reads it from their own credentials. The file is readable by the person alone;
/// Claude Code moves it into the keychain item it saves the sign-in to, where it keeps one. Fails
/// as the file cannot be written.
pub(crate) async fn write_claude_owner_client_secret(
    name: &McpServerName,
    entry: &Map<String, Value>,
    environment: &[(String, String)],
    client_secret: &SecretString,
) -> Result<(), Box<dyn Error + Send + Sync>> {
    let file = claude_credential_folder(environment)
        .expect("a sign-in's environment names its own config folder")
        .join(CLAUDE_CREDENTIALS_FILE);
    let keys = claude_server_keys(name, entry, environment);
    let stored = WrittenClientSecrets {
        mcp_oauth_client_config: keys
            .iter()
            .map(|key| {
                let secret = WrittenClientSecret {
                    client_secret: client_secret.expose_secret(),
                };
                (key.as_str(), secret)
            })
            .collect(),
    };
    let contents = Zeroizing::new(serde_json::to_vec(&stored)?);
    tokio::task::spawn_blocking(move || {
        replace_file_atomically(&file, &contents, 0o600, LeftoverSweep::Unswept)
    })
    .await??;
    Ok(())
}

// The client secrets a sign-in's credentials file holds, in Claude Code's spelling. It derives no
// `Debug`, since it holds secrets.
#[derive(Serialize)]
struct WrittenClientSecrets<'secret> {
    #[serde(rename = "mcpOAuthClientConfig")]
    mcp_oauth_client_config: BTreeMap<&'secret str, WrittenClientSecret<'secret>>,
}

#[derive(Serialize)]
struct WrittenClientSecret<'secret> {
    #[serde(rename = "clientSecret")]
    client_secret: &'secret str,
}

// The keys Claude Code may file the server `name` declared by `entry` under: the entry as Claude
// Code connects to it, its variables filled from `environment`, then as written, which a server
// added from JSON keeps.
fn claude_server_keys(
    name: &McpServerName,
    entry: &Map<String, Value>,
    environment: &[(String, String)],
) -> Vec<String> {
    let mut keys = vec![claude_server_key(name, entry, Some(environment))];
    let as_written = claude_server_key(name, entry, None);
    if !keys.contains(&as_written) {
        keys.push(as_written);
    }
    keys
}

// Whether `helper`, named by `binding`'s entry, is the administrator's own: the entry is the one the
// administrator's MCP file on this computer declares, or a `managedMcpServers` entry of one of the
// administrator's managed settings files there names the same helper, which no remote delivery
// writes. A managed settings file that cannot be read names none.
async fn is_administrators_helper(
    sources: &ClaudeMcpSignInSources<'_>,
    binding: &McpServerBindingRef,
    helper: &str,
) -> bool {
    if is_in_administrator_file(sources, binding) {
        return true;
    }
    let Some(folder) = &sources.administrator_settings_folder else {
        return false;
    };
    let helper_path = [
        MANAGED_MCP_SERVERS_SETTING,
        binding.server_name().as_str(),
        OAUTH_MEMBER,
        CLIENT_SECRET_HELPER_MEMBER,
    ];
    read_claude_managed_settings(folder)
        .await
        .files
        .iter()
        .any(|(_file, settings)| {
            find_claude_setting(settings, &helper_path).and_then(Value::as_str) == Some(helper)
        })
}

// Whether `binding`'s entry is the one the administrator's MCP file on this computer declares,
// as the entry's read takes it before any `managedMcpServers` entry.
fn is_in_administrator_file(
    sources: &ClaudeMcpSignInSources<'_>,
    binding: &McpServerBindingRef,
) -> bool {
    sources
        .managed_mcp_servers
        .as_ref()
        .and_then(|servers| servers.get(binding.server_name().as_str()))
        .is_some_and(Value::is_object)
}

// The key Claude Code files a server's sign-in and its kept client secret under:
// `<name>|<the first 16 hex digits of the SHA-256 of the entry's type, url and headers>`, the
// three written as one compact JSON object in that order, the headers `{}` where the entry has
// none, and the url and each header filled from `environment`, where one is given, as Claude Code
// fills them before it connects.
fn claude_server_key(
    name: &McpServerName,
    entry: &Map<String, Value>,
    environment: Option<&[(String, String)]>,
) -> String {
    let fill = |value: &Value| {
        if let (Some(text), Some(environment)) = (value.as_str(), environment) {
            Value::String(expand_remote_address(text, environment))
        } else {
            value.clone()
        }
    };
    let mut hashed = Map::new();
    // An absent member is left out, as a JSON text of an undefined member is.
    if let Some(transport) = entry.get(TYPE_MEMBER) {
        hashed.insert(TYPE_MEMBER.to_owned(), transport.clone());
    }
    if let Some(url) = entry.get(URL_MEMBER) {
        hashed.insert(URL_MEMBER.to_owned(), fill(url));
    }
    let headers = match entry.get(HEADERS_MEMBER) {
        Some(Value::Object(headers)) => Value::Object(
            headers
                .iter()
                .map(|(header, value)| (header.clone(), fill(value)))
                .collect(),
        ),
        Some(other) if !other.is_null() => other.clone(),
        Some(_) | None => Value::Object(Map::new()),
    };
    hashed.insert(HEADERS_MEMBER.to_owned(), headers);
    let digest = sha2::Sha256::digest(Value::Object(hashed).to_string().as_bytes());
    let hex = base16ct::lower::encode_string(&digest);
    format!("{}|{}", name.as_str(), &hex[..KEY_HASH_DIGITS])
}

// The secret kept under the first of `keys` the credentials `environment` names hold one for:
// its folder's file, else the keychain item named for that folder, as the sign-in reads Claude
// Code's saved sign-ins.
async fn read_stored_client_secret(
    credentials: &ClaudeSignInReader,
    environment: &[(String, String)],
    keys: &[String],
) -> Result<Option<SecretString>, ClaudeOwnerSecretError> {
    let secret_in = |mut stored: ClaudeStoredClientSecrets| {
        keys.iter().find_map(|key| {
            stored
                .mcp_oauth_client_config
                .remove(key)
                .and_then(|config| config.client_secret)
                .filter(|secret| !secret.expose_secret().is_empty())
        })
    };
    if let Some(secret) = read_claude_credential_file(environment)
        .await
        .map_err(ClaudeOwnerSecretError::Credentials)?
        .and_then(secret_in)
    {
        return Ok(Some(secret));
    }
    Ok(credentials
        .read_keychain_record(environment)
        .await
        .map_err(ClaudeOwnerSecretError::Credentials)?
        .and_then(secret_in))
}

// What the helper prints: one object with a `clientSecret` alone. It derives no `Debug`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HelperOutput {
    #[serde(rename = "clientSecret", deserialize_with = "read_secret")]
    client_secret: Option<SecretString>,
}

// Runs the helper at `program` with no arguments, its environment `environment` alone, in
// `folder` where one is given, and reads the secret it prints, as Claude Code runs it: within 30
// s, its outputs together under 64 KiB, an exit code of 0 and exactly one object holding a
// non-empty `clientSecret` on its standard output. What it writes to standard error is dropped.
async fn run_client_secret_helper(
    spawner: &Spawner,
    program: &Path,
    environment: &[(String, String)],
    folder: Option<PathBuf>,
) -> Result<SecretString, ClaudeOwnerSecretError> {
    if !program.is_absolute() {
        return Err(ClaudeOwnerSecretError::HelperPathNotAbsolute);
    }
    let mut command = tokio::process::Command::new(program);
    command
        .env_clear()
        .envs(environment.iter().map(|(name, value)| (name, value)))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(folder) = folder {
        command.current_dir(folder);
    }
    let mut child = spawner
        .run(move || command.spawn())
        .await
        .and_then(|spawned| spawned)
        .map_err(ClaudeOwnerSecretError::HelperUnrun)?;
    let stdout = child.stdout.take().expect("the helper's output is piped");
    let stderr = child
        .stderr
        .take()
        .expect("the helper's error output is piped");
    let run = async {
        let (printed, written) = tokio::try_join!(read_bounded(stdout), read_bounded(stderr))?;
        let status = child.wait().await?;
        Ok::<_, std::io::Error>((printed, written.len(), status))
    };
    let (printed, written, status) = tokio::time::timeout(HELPER_TIME_LIMIT, run)
        .await
        .map_err(|_elapsed| ClaudeOwnerSecretError::HelperUnfinished)?
        .map_err(ClaudeOwnerSecretError::HelperUnrun)?;
    if u64::try_from(printed.len() + written).unwrap_or(u64::MAX) >= HELPER_OUTPUT_LIMIT {
        return Err(ClaudeOwnerSecretError::HelperOutputTooLong);
    }
    if !status.success() {
        return Err(ClaudeOwnerSecretError::HelperFailed);
    }
    let output: HelperOutput = serde_json::from_slice(&printed)
        .map_err(|_unreadable| ClaudeOwnerSecretError::HelperOutputUnreadable)?;
    output
        .client_secret
        .filter(|secret| !secret.expose_secret().is_empty())
        .ok_or(ClaudeOwnerSecretError::HelperOutputUnreadable)
}

// What `output` writes, up to the outputs' limit, so a longer output is seen as too long without
// being held whole; the rest is drained so the helper never blocks on it.
async fn read_bounded(
    mut output: impl AsyncRead + Unpin,
) -> Result<Zeroizing<Vec<u8>>, std::io::Error> {
    let mut read = Zeroizing::new(Vec::new());
    (&mut output)
        .take(HELPER_OUTPUT_LIMIT)
        .read_to_end(&mut read)
        .await?;
    tokio::io::copy(&mut output, &mut tokio::io::sink()).await?;
    Ok(read)
}

// The non-empty text `oauth` holds at `member`.
fn non_empty_text<'oauth>(oauth: &'oauth Map<String, Value>, member: &str) -> Option<&'oauth str> {
    oauth
        .get(member)
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};
    use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerName};

    use super::{ClaudeOwnerSecretError, read_claude_owner_client_secret};
    use crate::driver::claude::DESCRIPTOR;
    use crate::driver::claude::session::scripted::driver::ScriptedDriver;
    use crate::driver::contract::error::DriverError;
    use crate::driver::contract::sign_in::McpServerAddressRead;
    use crate::runtime_binding::test_store::test_provider_account_id;

    // A helper an account's `managedMcpServers` entry names, which remote settings can deliver, is
    // never started with no consent recorded, and the sign-in fails rather than reading no secret;
    // the same helper named for the entry in the administrator's own managed settings file is run.
    // Killed by running the first, or refusing the second: `true` prints no secret, so a run reads
    // as an unreadable output and a refusal as no consent.
    #[tokio::test]
    async fn a_remotely_delivered_helper_with_no_consent_is_never_started() {
        let entry = json!({
            "type": "http",
            "url": "https://org-signed.example.com/mcp",
            "oauth": { "clientId": "client", "clientSecretHelper": "/usr/bin/true" }
        });
        let administrator_folder = tempfile::tempdir().expect("a managed settings folder");
        std::fs::write(
            administrator_folder.path().join("managed-settings.json"),
            json!({ "managedMcpServers": { "org-signed": entry } }).to_string(),
        )
        .expect("the administrator's settings file is written");

        for (administrator_settings, is_started) in
            [(None, false), (Some(administrator_folder.path()), true)]
        {
            let error = read_owner_secret_error(&entry, administrator_settings).await;
            let error = error.downcast_ref::<ClaudeOwnerSecretError>();
            if is_started {
                assert!(
                    matches!(error, Some(ClaudeOwnerSecretError::HelperOutputUnreadable)),
                    "the administrator's own helper is run, not {error:?}"
                );
            } else {
                assert!(
                    matches!(error, Some(ClaudeOwnerSecretError::HelperWithoutConsent)),
                    "the helper is refused unstarted, not {error:?}"
                );
            }
        }
    }

    // The failure of reading the owner's secret for an account's `managedMcpServers` entry
    // `entry`, with `administrator_settings` the managed settings folder, where there is one.
    async fn read_owner_secret_error(
        entry: &Value,
        administrator_settings: Option<&std::path::Path>,
    ) -> Box<dyn std::error::Error + Send + Sync> {
        let fixture = ScriptedDriver::new();
        std::fs::create_dir_all(&fixture.driver.sources.home_folder)
            .expect("the home folder is made");
        fixture.starts.script_account_servers(
            json!({ "mcpServers": [] }),
            json!({ "effective": { "managedMcpServers": { "org-signed": entry } } }),
        );
        let request = McpServerAddressRead {
            binding: McpServerBindingRef::Managed {
                provider: DESCRIPTOR.provider_id(),
                server_name: McpServerName::new("org-signed".to_owned()).expect("a server name"),
            },
            provider_account_id: Some(test_provider_account_id()),
            root_folder: None,
            every_project_rows: Vec::new(),
            project_rows: Vec::new(),
        };
        let mut sources = fixture.driver.sign_in_sources_for(None).await;
        sources.administrator_settings_folder = administrator_settings.map(ToOwned::to_owned);
        let environment = fixture
            .driver
            .sources
            .environment_without_home(&[], &[])
            .expect("the environment is composed");

        let read = read_claude_owner_client_secret(
            &sources,
            &fixture.driver.credentials,
            &fixture.driver.sources.spawner,
            &request,
            &environment,
        )
        .await;

        match read {
            Err(DriverError::Internal(error)) => error,
            other => panic!("the read fails, not {other:?}"),
        }
    }
}
