//! The secret of the client a server's owner issued, read where Claude Code reads it for the entry
//! a sign-in through Claude Code copies: for an organization's server, the program its entry's
//! `oauth.clientSecretHelper` names, which overrides the entry's `oauth.clientSecret`, else that
//! member; else, for any server, the secret `claude mcp add --client-secret` kept in the person's
//! Claude Code credentials under the key Claude Code files the server's sign-in under. Each is
//! read only where the entry names `oauth.clientId`, and none is kept here or printed.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use secrecy::SecretString;
use serde::Deserialize;
use serde_json::{Map, Value};
use sha2::Digest as _;
use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerName};
use sidekicks_platforms::Spawner;
use tokio::io::{AsyncRead, AsyncReadExt as _};
use zeroize::Zeroizing;

use super::{ClaudeMcpSignInSources, read_sign_in_entry};
use crate::driver::claude::account::credentials::{
    ClaudeCredentialReadError, ClaudeSignInReader, ClaudeStoredCredentials, environment_home,
    read_claude_credential_file,
};
use crate::driver::claude::mcp::config::{ClaudeServerEntryReader, OAUTH_MEMBER, URL_MEMBER};
use crate::driver::claude::mcp::machine_probe::variables::expand_remote_address;
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
            let folder = environment_home(environment);
            return Ok(Some(
                run_client_secret_helper(spawner, Path::new(helper), environment, folder).await?,
            ));
        }
        if let Some(secret) = non_empty_text(oauth, CLIENT_SECRET_MEMBER) {
            return Ok(Some(SecretString::from(secret)));
        }
    }
    // The key of the entry as Claude Code connects to it, its variables filled, then as written,
    // which a server added from JSON keeps.
    let name = request.binding.server_name();
    let mut keys = vec![claude_server_key(name, &entry, Some(environment))];
    let as_written = claude_server_key(name, &entry, None);
    if !keys.contains(&as_written) {
        keys.push(as_written);
    }
    Ok(read_stored_client_secret(credentials, environment, &keys).await?)
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
    let secret_in = |mut stored: ClaudeStoredCredentials| {
        keys.iter()
            .find_map(|key| {
                stored
                    .mcp_oauth_client_config
                    .remove(key)
                    .and_then(|config| config.client_secret)
                    .filter(|secret| !secret.is_empty())
            })
            .map(SecretString::from)
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
    #[serde(rename = "clientSecret")]
    client_secret: String,
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
    if output.client_secret.is_empty() {
        return Err(ClaudeOwnerSecretError::HelperOutputUnreadable);
    }
    Ok(SecretString::from(output.client_secret))
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
