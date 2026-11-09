//! Claude Code's stored credentials, read where Claude Code takes them from: the token its
//! environment hands it, else `.credentials.json` in a process's credential folder, else, on
//! macOS, the keychain item Claude Code files for that folder. They hold an account's claude.ai
//! sign-in (`claudeAiOauth`) and the MCP sign-ins Claude Code saved (`mcpOAuth`). This is the one
//! place the driver reads that record, through one parse and one keychain call path: the
//! keychain tool Claude Code itself reads and writes the item with, which the item trusts, so no
//! prompt asks for the daemon, each call in the turn every keychain call takes. Also here is the
//! person's approval of an API key the environment sets, which Claude Code keeps in its config
//! file; only an MCP sign-in's own folder's item is ever removed. Nothing here logs a value; the
//! claude.ai read logs its reason where no record is read.

use std::borrow::Cow;
use std::collections::BTreeMap;
use std::fmt;
use std::path::PathBuf;

use secrecy::{ExposeSecret, SecretString};
use serde::Deserialize;
use sha2::Digest;
use sidekicks_contracts::wire::text::is_ecmascript_whitespace;
use sidekicks_platforms::{KeychainItemRefusal, PathRules, SignInMove, Spawner};
use sidekicks_std::keyed_lock::HeldWorkEnd;
use sidekicks_std::missing_entry::MissingEntry as _;
use sidekicks_store::credential_store::os::KeychainTurn;
use unicode_normalization::UnicodeNormalization;
use zeroize::Zeroizing;

use crate::driver::claude::mcp::config::ClaudePersonConfigFiles;
use crate::driver::claude::mcp::sign_in::saved_credentials::ClaudeSavedSignIn;
use crate::driver::claude::spawn::environment::{claude_config_folder, claude_text_variable};
use crate::inbound_json::decode_inbound_json;

/// The file in the credential folder Claude Code keeps a sign-in in where the keychain is not used.
pub(crate) const CLAUDE_CREDENTIALS_FILE: &str = ".credentials.json";

/// The name Claude Code files its keychain item under, before the folder's suffix.
const CLAUDE_KEYCHAIN_SERVICE: &str = "Claude Code-credentials";

/// The account Claude Code files its keychain item under when the user's name is unusable.
const CLAUDE_KEYCHAIN_FALLBACK_ACCOUNT: &str = "claude-code-user";

/// The variable Claude Code names its keychain account by.
pub(crate) const KEYCHAIN_ACCOUNT_VARIABLE: &str = "USER";

/// The variable that moves Claude Code's config home, the folder of its settings, its config file
/// and, unless the secure-storage folder is named, its sign-in.
pub(crate) const CONFIG_FOLDER_VARIABLE: &str = "CLAUDE_CONFIG_DIR";

/// The variable naming the folder Claude Code keeps its sign-in in, apart from its config home,
/// which its keychain item is named for.
pub(crate) const SECURE_STORAGE_FOLDER_VARIABLE: &str = "CLAUDE_SECURESTORAGE_CONFIG_DIR";

/// The variable that moves Claude Code's sign-in, and the API host it reads the connector list
/// from, to a custom host.
pub(crate) const CUSTOM_SIGN_IN_HOST_VARIABLE: &str = "CLAUDE_CODE_CUSTOM_OAUTH_URL";

/// The hosts Claude Code accepts in [`CUSTOM_SIGN_IN_HOST_VARIABLE`], refusing any other.
const APPROVED_CUSTOM_BASES: [&str; 3] = [
    "https://beacon.claude-ai.staging.ant.dev",
    "https://claude.fedstart.com",
    "https://claude-staging.fedstart.com",
];

/// What an environment says of a custom sign-in host, read as Claude Code reads it.
pub(crate) enum ClaudeCustomSignInBase {
    /// It names none.
    Unset,
    /// It names one Claude Code accepts, given here without its trailing `/`.
    Approved(&'static str),
    /// It names one Claude Code refuses.
    Refused,
}

/// Reads [`CUSTOM_SIGN_IN_HOST_VARIABLE`] in `environment`, a trailing `/` dropped, against the
/// hosts Claude Code accepts. Never fails.
pub(crate) fn read_custom_sign_in_base(environment: &[(String, String)]) -> ClaudeCustomSignInBase {
    let Some(custom) =
        PathRules::NATIVE.environment_value(environment, CUSTOM_SIGN_IN_HOST_VARIABLE)
    else {
        return ClaudeCustomSignInBase::Unset;
    };
    let custom = custom.strip_suffix('/').unwrap_or(custom);
    APPROVED_CUSTOM_BASES
        .into_iter()
        .find(|approved| *approved == custom)
        .map_or(
            ClaudeCustomSignInBase::Refused,
            ClaudeCustomSignInBase::Approved,
        )
}

/// The variable whose token Claude Code signs in with ahead of its stored sign-in.
pub(crate) const OAUTH_TOKEN_VARIABLE: &str = "CLAUDE_CODE_OAUTH_TOKEN";

/// The variable whose API key Claude Code calls the API with.
pub(crate) const API_KEY_VARIABLE: &str = "ANTHROPIC_API_KEY";

/// The variable whose refresh token `claude auth login` signs in with, skipping its own flow.
const OAUTH_REFRESH_TOKEN_VARIABLE: &str = "CLAUDE_CODE_OAUTH_REFRESH_TOKEN";

/// The variables that would sign a process in ahead of its home's own sign-in, which a sign-in and
/// its status read remove so they act on the home alone.
pub(crate) const SIGN_IN_OVERRIDE_VARIABLES: [&str; 3] = [
    OAUTH_TOKEN_VARIABLE,
    API_KEY_VARIABLE,
    OAUTH_REFRESH_TOKEN_VARIABLE,
];

/// How many UTF-16 units at the trimmed key's end Claude Code files its approval under.
const API_KEY_APPROVAL_UNITS: usize = 20;

/// The variable listing the scopes Claude Code gives a token its environment hands it, separated
/// by white space.
const OAUTH_SCOPES_VARIABLE: &str = "CLAUDE_CODE_OAUTH_SCOPES";

/// The scopes Claude Code gives the environment's token where the scopes variable names none.
const ENVIRONMENT_TOKEN_SCOPES: [&str; 1] = ["user:inference"];

/// Reads an account's claude.ai sign-in from its file, else from its keychain item, which this
/// reader reaches through the keychain tool.
#[derive(Clone)]
pub(crate) struct ClaudeSignInReader {
    keychain: Option<ClaudeKeychainItems>,
}

// The keychain items Claude Code files, each call one run of the keychain tool on the spawner,
// in the turn every keychain call takes and within its time from that turn.
#[derive(Clone)]
struct ClaudeKeychainItems {
    tool: SignInMove,
    spawner: Spawner,
    turn: KeychainTurn,
}

impl ClaudeSignInReader {
    /// The reader of the file, then of the keychain item through `tool`, the keychain tool where
    /// the system has one (macOS), started on `spawner`, each call taking `turn`.
    pub(crate) fn new(tool: Option<SignInMove>, spawner: &Spawner, turn: &KeychainTurn) -> Self {
        Self {
            keychain: tool.map(|tool| ClaudeKeychainItems {
                tool,
                spawner: spawner.clone(),
                turn: turn.clone(),
            }),
        }
    }

    /// A reader of the file alone, for a test whose reads never reach a keychain.
    #[cfg(test)]
    pub(crate) fn without_keychain() -> Self {
        Self { keychain: None }
    }

    /// The sign-in of the Claude Code process `environment` starts: the environment's own token,
    /// else `handed_token`, the token account's sealed token the daemon hands that process on a
    /// file descriptor, each with the scopes Claude Code gives a handed token, else the record in
    /// its credential folder's file, else the keychain item named for that folder. The
    /// descriptor's variable itself is never read: the daemon withholds it from every environment
    /// it composes and sets it only as it starts a process, on a pipe that process alone reads.
    /// Where none holds a record with an access token it is absent, unless a store that may hold
    /// one could not be read; each reason is logged at debug.
    pub(crate) async fn read(
        &self,
        environment: &[(String, String)],
        handed_token: Option<&SecretString>,
    ) -> ClaudeSignInReading {
        let handed = claude_text_variable(environment, OAUTH_TOKEN_VARIABLE)
            .or_else(|| handed_token.map(ExposeSecret::expose_secret));
        if let Some(token) = handed {
            return ClaudeSignInReading::Read(ClaudeAiSignIn {
                access_token: Zeroizing::new(token.to_owned()),
                scopes: read_handed_token_scopes(environment),
                refresh_token: None,
                expires_at: None,
                client_id: None,
            });
        }
        if claude_credential_folder(environment).is_none() {
            tracing::debug!("no claude.ai sign-in read: the account names no Claude Code home");
            return ClaudeSignInReading::Unreadable;
        }
        let mut is_file_unread = false;
        match read_claude_credential_file(environment).await {
            Ok(Some(stored)) => {
                if let Some(sign_in) = read_sign_in_record(stored, "the credential file") {
                    return ClaudeSignInReading::Read(sign_in);
                }
            }
            Ok(None) => {}
            Err(error) => {
                is_file_unread = matches!(error, ClaudeCredentialReadError::File(_));
                tracing::debug!(
                    error = &error as &(dyn std::error::Error + 'static),
                    "the claude.ai credential file could not be read"
                );
            }
        }
        let absent = || {
            if is_file_unread {
                ClaudeSignInReading::Unreadable
            } else {
                ClaudeSignInReading::Absent
            }
        };
        if !self.has_keychain() {
            tracing::debug!(
                "no claude.ai sign-in read from the credential file, and no keychain backs it"
            );
            return absent();
        }
        match self.read_keychain_record(environment).await {
            Ok(Some(stored)) => read_sign_in_record(stored, "the keychain item")
                .map_or_else(absent, ClaudeSignInReading::Read),
            Ok(None) => {
                tracing::debug!(
                    "no claude.ai sign-in read: the keychain holds none, nor does the file"
                );
                absent()
            }
            Err(error @ ClaudeCredentialReadError::Unparsable { .. }) => {
                tracing::debug!(
                    error = &error as &(dyn std::error::Error + 'static),
                    "no claude.ai sign-in read: the keychain item is not readable"
                );
                absent()
            }
            Err(
                error @ (ClaudeCredentialReadError::File(_)
                | ClaudeCredentialReadError::KeychainRefused(_)
                | ClaudeCredentialReadError::KeychainStopped(_)
                | ClaudeCredentialReadError::KeychainUnanswered),
            ) => {
                tracing::debug!(
                    error = &error as &(dyn std::error::Error + 'static),
                    "no claude.ai sign-in read: the keychain item could not be read"
                );
                ClaudeSignInReading::Unreadable
            }
        }
    }

    /// Whether this reader reaches a keychain, which only macOS has.
    pub(crate) fn has_keychain(&self) -> bool {
        self.keychain.is_some()
    }

    /// The credentials in the keychain item Claude Code started in `environment` files for its
    /// credential folder; `None` where there is no keychain or no item. Fails as the keychain
    /// refuses or does not answer in time, or the item is not Claude Code's credentials.
    pub(crate) async fn read_keychain_record(
        &self,
        environment: &[(String, String)],
    ) -> Result<Option<ClaudeStoredCredentials>, ClaudeCredentialReadError> {
        let Some(keychain) = &self.keychain else {
            return Ok(None);
        };
        let read = keychain
            .call(environment, |items, service, account| async move {
                let bound = items.turn.call_timeout();
                items
                    .tool
                    .read_item(&items.spawner, &service, &account, bound)
                    .await
            })
            .await?;
        let Some(value) = read else {
            return Ok(None);
        };
        parse_stored_credentials(&value).map(Some)
    }

    /// Removes the keychain item Claude Code started in `environment` files for its credential
    /// folder, answering whether one was there; `false` where there is no keychain. Fails as the
    /// keychain refuses or does not answer in time.
    pub(crate) async fn remove_keychain_record(
        &self,
        environment: &[(String, String)],
    ) -> Result<bool, ClaudeCredentialReadError> {
        let Some(keychain) = &self.keychain else {
            return Ok(false);
        };
        keychain
            .call(environment, |items, service, account| async move {
                let bound = items.turn.call_timeout();
                items
                    .tool
                    .delete_item(&items.spawner, &service, &account, bound)
                    .await
            })
            .await
    }
}

impl ClaudeKeychainItems {
    // Runs the tool call `call` makes on the item named for `environment`'s credential folder in
    // the keychain's turn, waiting for it the call time from that turn.
    async fn call<Answer, Call>(
        &self,
        environment: &[(String, String)],
        call: impl FnOnce(Self, String, String) -> Call,
    ) -> Result<Answer, ClaudeCredentialReadError>
    where
        Answer: Send + 'static,
        Call: Future<Output = Result<Answer, KeychainItemRefusal>> + Send + 'static,
    {
        let service = claude_keychain_service(environment);
        let account = claude_keychain_account(environment);
        let work = call(self.clone(), service.clone(), account);
        match self.turn.run(&service, work, Result::is_ok).await {
            Ok(Ok(answer)) => Ok(answer),
            Ok(Err(refusal)) => Err(ClaudeCredentialReadError::KeychainRefused(refusal)),
            Err(HeldWorkEnd::Interrupted(error)) => {
                Err(ClaudeCredentialReadError::KeychainStopped(error))
            }
            Err(HeldWorkEnd::Unanswered) => Err(ClaudeCredentialReadError::KeychainUnanswered),
        }
    }
}

/// The credentials in the file Claude Code started in `environment` keeps in its credential
/// folder; `None` where it names no folder or the file is absent. Fails as the file cannot be read
/// or is not Claude Code's credentials.
pub(crate) async fn read_claude_credential_file(
    environment: &[(String, String)],
) -> Result<Option<ClaudeStoredCredentials>, ClaudeCredentialReadError> {
    let Some(folder) = claude_credential_folder(environment) else {
        return Ok(None);
    };
    let Some(bytes) = tokio::fs::read(folder.join(CLAUDE_CREDENTIALS_FILE))
        .await
        .map(Zeroizing::new)
        .none_if_missing()
        .map_err(ClaudeCredentialReadError::File)?
    else {
        return Ok(None);
    };
    parse_stored_credentials(&bytes).map(Some)
}

/// Claude Code's stored credentials as the one parse reads them: the claude.ai record and every
/// MCP sign-in Claude Code saved. It derives no `Debug`, since it holds tokens.
#[derive(Deserialize)]
pub(crate) struct ClaudeStoredCredentials {
    #[serde(rename = "claudeAiOauth", default)]
    claude_ai_oauth: Option<StoredSignIn>,
    /// Every MCP sign-in Claude Code saved, by a key of its own.
    #[serde(rename = "mcpOAuth", default)]
    pub(crate) mcp_oauth: BTreeMap<String, ClaudeSavedSignIn>,
}

/// Why Claude Code's stored credentials could not be read. No case carries a stored value.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ClaudeCredentialReadError {
    /// The credential file could not be read.
    #[error("Claude Code's credential file could not be read")]
    File(#[source] std::io::Error),
    /// The stored text is not Claude Code's credentials. Only the parse error's kind and place
    /// are kept, since its message can quote the value.
    #[error("Claude Code's stored credentials do not parse ({category:?} at {line}:{column})")]
    Unparsable {
        /// What kind of parse error it was.
        category: serde_json::error::Category,
        /// Its line.
        line: usize,
        /// Its column.
        column: usize,
    },
    /// The keychain refused the call, or its tool could not be run or gave no answer in time.
    #[error("the keychain refused the call on Claude Code's item")]
    KeychainRefused(#[source] KeychainItemRefusal),
    /// The keychain call's thread stopped.
    #[error("the keychain call on Claude Code's item stopped")]
    KeychainStopped(#[source] tokio::task::JoinError),
    /// The keychain did not answer within the call time.
    #[error("the keychain did not answer in time for Claude Code's item")]
    KeychainUnanswered,
}

/// Whether the person approved the API key `environment` sets, as Claude Code reads it: the key's
/// last 20 UTF-16 units, trimmed, listed under `customApiKeyResponses.approved` in the config file
/// a process started in `environment` reads. Not approved where no key is set, or the file or the
/// list is absent or unreadable, the reason logged at debug.
pub(crate) async fn is_claude_api_key_approved(environment: &[(String, String)]) -> bool {
    let Some(key) = claude_text_variable(environment, API_KEY_VARIABLE) else {
        return false;
    };
    let Some(home) = environment_home(environment) else {
        tracing::debug!("the API key's approval is not read: the account names no home");
        return false;
    };
    let file = ClaudePersonConfigFiles::resolve(environment, &home)
        .await
        .person_config;
    let bytes = match tokio::fs::read(&file).await {
        Ok(bytes) => bytes,
        Err(error) => {
            tracing::debug!(
                error = &error as &(dyn std::error::Error + 'static),
                file = %file.display(),
                "the API key's approval is not read: the config file could not be read"
            );
            return false;
        }
    };
    let stored: StoredApiKeyResponses = match serde_json::from_slice(&bytes) {
        Ok(stored) => stored,
        Err(error) => {
            tracing::debug!(
                category = ?error.classify(),
                line = error.line(),
                column = error.column(),
                "the API key's approval is not read: the config file is not readable"
            );
            return false;
        }
    };
    let suffix = api_key_approval_suffix(key);
    stored
        .custom_api_key_responses
        .and_then(|responses| responses.approved)
        .is_some_and(|approved| approved.iter().any(|entry| entry.as_str() == Some(suffix)))
}

// The members of Claude Code's config file the approval read takes; the file keeps much else.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredApiKeyResponses {
    #[serde(default)]
    custom_api_key_responses: Option<ApiKeyResponses>,
}

// The keys' approvals as stored; an entry that is no text matches no key, as Claude Code skips it.
#[derive(Deserialize)]
struct ApiKeyResponses {
    #[serde(default)]
    approved: Option<Vec<serde_json::Value>>,
}

// The end of `key` Claude Code files its approval under: its last 20 UTF-16 units, a character
// past the BMP that straddles the cut left out, since JSON cannot store the half JavaScript keeps.
fn api_key_approval_suffix(key: &str) -> &str {
    let mut units = 0;
    let mut start = key.len();
    for (index, character) in key.char_indices().rev() {
        units += character.len_utf16();
        if units > API_KEY_APPROVAL_UNITS {
            break;
        }
        start = index;
    }
    &key[start..]
}

/// What the read of an account's claude.ai sign-in found.
pub(crate) enum ClaudeSignInReading {
    /// No store holds a record with an access token.
    Absent,
    /// A store that may hold one could not be read: the file where no keychain answered for it,
    /// or the keychain, which refused, stopped or did not answer in time.
    Unreadable,
    /// The sign-in.
    Read(ClaudeAiSignIn),
}

/// An account's claude.ai sign-in: its access token, wiped when dropped, and the scopes it was
/// granted. Its `Debug` prints the scopes alone.
pub(crate) struct ClaudeAiSignIn {
    /// The access token.
    pub(crate) access_token: Zeroizing<String>,
    /// The scopes the token was granted.
    pub(crate) scopes: Vec<String>,
    /// The token that renews the access token.
    #[expect(
        dead_code,
        reason = "dictation renews the access token through this reader under Claude Code's own \
                  refresh lock"
    )]
    pub(crate) refresh_token: Option<Zeroizing<String>>,
    /// When the access token expires, in milliseconds since the epoch; `None` where it never does.
    #[expect(
        dead_code,
        reason = "dictation renews the access token through this reader under Claude Code's own \
                  refresh lock"
    )]
    pub(crate) expires_at: Option<i64>,
    /// The sign-in client the token was issued to, where the record names one.
    #[expect(
        dead_code,
        reason = "dictation renews the access token through this reader under Claude Code's own \
                  refresh lock"
    )]
    pub(crate) client_id: Option<String>,
}

impl fmt::Debug for ClaudeAiSignIn {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ClaudeAiSignIn")
            .field("scopes", &self.scopes)
            .finish_non_exhaustive()
    }
}

// The claude.ai record as stored; every member the read leaves out is skipped.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredSignIn {
    #[serde(default)]
    access_token: Option<String>,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_at: Option<i64>,
    #[serde(default)]
    scopes: Option<Vec<String>>,
    #[serde(default)]
    client_id: Option<String>,
}

// `bytes` read as Claude Code's stored credentials, their lone surrogate escapes repaired, the
// repaired copy wiped when dropped.
fn parse_stored_credentials(
    bytes: &[u8],
) -> Result<ClaudeStoredCredentials, ClaudeCredentialReadError> {
    let parsed = match decode_inbound_json(bytes) {
        Cow::Borrowed(text) => serde_json::from_str(text),
        Cow::Owned(text) => serde_json::from_str(&Zeroizing::new(text)),
    };
    parsed.map_err(|error| ClaudeCredentialReadError::Unparsable {
        category: error.classify(),
        line: error.line(),
        column: error.column(),
    })
}

// The claude.ai sign-in `stored` holds, read from `source`; `None`, logged, where it holds no
// record or the record no access token.
fn read_sign_in_record(
    stored: ClaudeStoredCredentials,
    source: &'static str,
) -> Option<ClaudeAiSignIn> {
    let Some(record) = stored.claude_ai_oauth else {
        tracing::debug!("{source} holds no claude.ai sign-in");
        return None;
    };
    let refresh_token = record.refresh_token.map(Zeroizing::new);
    let Some(access_token) = record.access_token.map(Zeroizing::new) else {
        tracing::debug!("the claude.ai sign-in in {source} holds no access token");
        return None;
    };
    Some(ClaudeAiSignIn {
        access_token,
        scopes: record.scopes.unwrap_or_default(),
        refresh_token,
        expires_at: record.expires_at,
        client_id: record.client_id,
    })
}

// The scopes Claude Code gives the token `environment` hands it: those its scopes variable lists,
// else inference alone.
fn read_handed_token_scopes(environment: &[(String, String)]) -> Vec<String> {
    let listed: Vec<String> = claude_text_variable(environment, OAUTH_SCOPES_VARIABLE)
        .into_iter()
        .flat_map(|scopes| scopes.split(is_ecmascript_whitespace))
        .filter(|scope| !scope.is_empty())
        .map(str::to_owned)
        .collect();
    if listed.is_empty() {
        ENVIRONMENT_TOKEN_SCOPES
            .iter()
            .map(|scope| (*scope).to_owned())
            .collect()
    } else {
        listed
    }
}

// The folder Claude Code started in `environment` keeps its sign-in in: the secure-storage folder
// where named, the default home where it is named empty, else the config home, in NFC. `None`
// where no home is known at all.
fn claude_credential_folder(environment: &[(String, String)]) -> Option<PathBuf> {
    let rules = PathRules::NATIVE;
    let folder = match rules.environment_value(environment, SECURE_STORAGE_FOLDER_VARIABLE) {
        Some("") => default_claude_home(environment)?,
        Some(folder) => PathBuf::from(folder),
        None => claude_config_folder(environment, rules)?,
    };
    Some(PathBuf::from(
        folder.to_string_lossy().nfc().collect::<String>(),
    ))
}

// `.claude` in `environment`'s home, else in the daemon's own.
fn default_claude_home(environment: &[(String, String)]) -> Option<PathBuf> {
    Some(environment_home(environment)?.join(".claude"))
}

// The home `environment` names, else the daemon's own.
fn environment_home(environment: &[(String, String)]) -> Option<PathBuf> {
    let rules = PathRules::NATIVE;
    rules
        .environment_value(environment, rules.home_environment_name())
        .map(PathBuf::from)
        .or_else(std::env::home_dir)
}

/// The keychain service Claude Code started in `environment` files its sign-in under: the base
/// name, with the first eight hex digits of the SHA-256 of the folder it salts with, in NFC, the
/// secure-storage folder where named and not empty, else the config home where one is named.
pub(crate) fn claude_keychain_service(environment: &[(String, String)]) -> String {
    let rules = PathRules::NATIVE;
    let salt = match rules.environment_value(environment, SECURE_STORAGE_FOLDER_VARIABLE) {
        Some("") => None,
        Some(folder) => Some(folder.nfc().collect::<String>()),
        None => rules
            .environment_value(environment, CONFIG_FOLDER_VARIABLE)
            .filter(|folder| !folder.is_empty())
            .map(|folder| folder.nfc().collect::<String>()),
    };
    match salt {
        Some(salt) => {
            let digest = sha2::Sha256::digest(salt.as_bytes());
            let hex = base16ct::lower::encode_string(&digest);
            format!("{CLAUDE_KEYCHAIN_SERVICE}-{}", &hex[..8])
        }
        None => CLAUDE_KEYCHAIN_SERVICE.to_owned(),
    }
}

/// The keychain account Claude Code started in `environment` files its sign-in under: `USER`,
/// else the user database's name, and the fixed name where that is missing or holds a character
/// outside letters, digits, `.`, `_` and `-`.
pub(crate) fn claude_keychain_account(environment: &[(String, String)]) -> String {
    let name = PathRules::NATIVE
        .environment_value(environment, KEYCHAIN_ACCOUNT_VARIABLE)
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .or_else(sidekicks_platforms::current_user_name);
    match name {
        Some(name)
            if !name.is_empty()
                && name
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')) =>
        {
            name
        }
        _ => CLAUDE_KEYCHAIN_FALLBACK_ACCOUNT.to_owned(),
    }
}

#[cfg(test)]
mod tests;
