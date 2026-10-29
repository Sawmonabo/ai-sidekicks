//! An account's claude.ai sign-in, read where Claude Code keeps it: the `claudeAiOauth` record of
//! `.credentials.json` in the account's credential folder, else, on macOS, the keychain item Claude
//! Code files for that folder. This is the one place the driver reads that record. The read never
//! writes, never logs a value, and answers `None` with a logged reason where no record is read.

use std::fmt;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use secrecy::ExposeSecret;
use serde::Deserialize;
use sha2::Digest;
use sidekicks_platforms::{CredentialStore, CredentialStoreError, PathRules, login_keychain};
use unicode_normalization::UnicodeNormalization;
use zeroize::Zeroizing;

use crate::driver::claude::spawn::environment::claude_config_folder;

/// The file in the credential folder Claude Code keeps a sign-in in where the keychain is not used.
const CLAUDE_CREDENTIALS_FILE: &str = ".credentials.json";

/// The name Claude Code files its keychain item under, before the folder's suffix.
const CLAUDE_KEYCHAIN_SERVICE: &str = "Claude Code-credentials";

/// The account Claude Code files its keychain item under when the user's name is unusable.
const CLAUDE_KEYCHAIN_FALLBACK_ACCOUNT: &str = "claude-code-user";

/// The variable naming the folder Claude Code keeps its sign-in in, apart from its config home.
const SECURE_STORAGE_FOLDER_VARIABLE: &str = "CLAUDE_SECURESTORAGE_CONFIG_DIR";

/// Opens the credential store a keychain item is read from, blocking while it does.
pub(crate) type ClaudeKeychainOpen =
    Arc<dyn Fn() -> Result<CredentialStore, CredentialStoreError> + Send + Sync>;

/// Reads an account's claude.ai sign-in from its file, else from the keychain this reader opens.
#[derive(Clone)]
pub(crate) struct ClaudeSignInReader {
    keychain: Option<ClaudeKeychainOpen>,
    keychain_timeout: Duration,
}

impl ClaudeSignInReader {
    /// The reader of this computer's stores: the file, then on macOS the login keychain, each
    /// keychain call answered within the daemon's keychain call time.
    pub(crate) fn system() -> Self {
        Self {
            keychain: login_keychain()
                .map(|opener| Arc::new(move || opener.open()) as ClaudeKeychainOpen),
            keychain_timeout: sidekicks_store::credential_store::os::KEYCHAIN_CALL_TIMEOUT,
        }
    }

    /// A reader whose keychain is `store`, a test's own, in place of the system's.
    #[cfg(test)]
    pub(crate) fn with_keychain(store: CredentialStore) -> Self {
        Self {
            keychain: Some(Arc::new(move || Ok(store.clone()))),
            keychain_timeout: Duration::from_secs(5),
        }
    }

    /// The sign-in of the Claude Code process `environment` starts: the record in its credential
    /// folder's file, else the keychain item named for that folder. `None`, with the reason logged
    /// at debug, where neither holds a record with an access token or the store cannot be read.
    pub(crate) async fn read(&self, environment: &[(String, String)]) -> Option<ClaudeAiSignIn> {
        let Some(folder) = claude_credential_folder(environment) else {
            tracing::debug!("no claude.ai sign-in read: the account names no Claude Code home");
            return None;
        };
        let file = folder.join(CLAUDE_CREDENTIALS_FILE);
        match tokio::fs::read(&file).await.map(Zeroizing::new) {
            Ok(bytes) => {
                if let Some(sign_in) = read_sign_in_record(&bytes, "the credential file") {
                    return Some(sign_in);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => tracing::debug!(
                error = &error as &(dyn std::error::Error + 'static),
                file = %file.display(),
                "the claude.ai credential file could not be read"
            ),
        }
        let Some(open) = &self.keychain else {
            tracing::debug!(
                file = %file.display(),
                "no claude.ai sign-in read: the credential file holds no record"
            );
            return None;
        };
        let service = claude_keychain_service(environment);
        let account = claude_keychain_account(environment);
        let open = Arc::clone(open);
        let call = tokio::task::spawn_blocking(move || open()?.read(&service, &account));
        let value = match tokio::time::timeout(self.keychain_timeout, call).await {
            Ok(Ok(Ok(Some(value)))) => value,
            Ok(Ok(Ok(None))) => {
                tracing::debug!(
                    "no claude.ai sign-in read: neither the file nor the keychain holds one"
                );
                return None;
            }
            Ok(Ok(Err(error))) => {
                tracing::debug!(
                    error = &error as &(dyn std::error::Error + 'static),
                    "no claude.ai sign-in read: the keychain refused the read"
                );
                return None;
            }
            Ok(Err(error)) => {
                tracing::debug!(
                    error = &error as &(dyn std::error::Error + 'static),
                    "no claude.ai sign-in read: the keychain read stopped"
                );
                return None;
            }
            Err(_elapsed) => {
                tracing::debug!("no claude.ai sign-in read: the keychain did not answer in time");
                return None;
            }
        };
        read_sign_in_record(value.expose_secret().as_bytes(), "the keychain item")
    }
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

// The stored form of Claude Code's credentials: the claude.ai record among its other members.
#[derive(Deserialize)]
struct StoredCredentials {
    #[serde(rename = "claudeAiOauth", default)]
    claude_ai_oauth: Option<StoredSignIn>,
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

// The sign-in `bytes` hold, read from `source`; `None`, logged, for text that is no record or
// holds no access token. A parse error is logged by its kind and place alone, since its message
// can quote the value.
fn read_sign_in_record(bytes: &[u8], source: &'static str) -> Option<ClaudeAiSignIn> {
    let stored: StoredCredentials = match serde_json::from_slice(bytes) {
        Ok(stored) => stored,
        Err(error) => {
            tracing::debug!(
                category = ?error.classify(),
                line = error.line(),
                column = error.column(),
                "the claude.ai sign-in in {source} is not readable"
            );
            return None;
        }
    };
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

// The folder Claude Code started in `environment` keeps its sign-in in: the secure-storage folder
// where named, the default home where it is named empty, else the config home, in NFC.
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
    let rules = PathRules::NATIVE;
    let home = rules
        .environment_value(environment, rules.home_environment_name())
        .map(PathBuf::from)
        .or_else(std::env::home_dir)?;
    Some(home.join(".claude"))
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
            .environment_value(environment, "CLAUDE_CONFIG_DIR")
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
        .environment_value(environment, "USER")
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
mod tests {
    use std::io::Write;
    use std::sync::{Arc, Mutex};

    use secrecy::SecretString;
    use sidekicks_platforms::CredentialStore;
    use tracing_subscriber::layer::SubscriberExt;

    use super::{ClaudeSignInReader, claude_keychain_account, claude_keychain_service};

    // A token no log line may hold.
    const PLANTED_TOKEN: &str = "planted-access-token-value";

    // Every line the test's subscriber writes, kept for the test to read.
    #[derive(Clone, Default)]
    struct CapturedLines(Arc<Mutex<Vec<u8>>>);

    impl Write for CapturedLines {
        fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
            self.0
                .lock()
                .expect("the capture is not poisoned")
                .extend_from_slice(buffer);
            Ok(buffer.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    // A credential file planted under a temporary folder is read, left byte for byte as it was,
    // and no log line of the read holds its token, through a reading, an unreadable file and a
    // keychain item alike. Killed by a write to the file, and by a log line carrying the token.
    #[tokio::test]
    async fn the_read_leaves_the_file_as_it_was_and_logs_no_token() {
        let folder = tempfile::tempdir().expect("a test folder");
        let credentials = folder.path().join(".credentials.json");
        let planted = format!(
            r#"{{"claudeAiOauth":{{"accessToken":"{PLANTED_TOKEN}","refreshToken":"{PLANTED_TOKEN}-r","expiresAt":1767225600000,"scopes":["user:inference","user:mcp_servers"],"subscriptionType":"max"}}}}"#
        );
        std::fs::write(&credentials, &planted).expect("the file is planted");
        let environment = vec![
            (
                "CLAUDE_CONFIG_DIR".to_owned(),
                folder.path().display().to_string(),
            ),
            (
                "CLAUDE_SECURESTORAGE_CONFIG_DIR".to_owned(),
                folder.path().display().to_string(),
            ),
            ("USER".to_owned(), "tester".to_owned()),
        ];
        let store = CredentialStore::in_memory();
        let reader = ClaudeSignInReader::with_keychain(store.clone());
        let lines = CapturedLines::default();
        let writer = lines.clone();
        let subscriber = tracing_subscriber::registry().with(
            tracing_subscriber::fmt::layer()
                .with_writer(move || writer.clone())
                .with_ansi(false),
        );
        let _default = tracing::subscriber::set_default(subscriber);

        let sign_in = reader.read(&environment).await.expect("the file's record");
        assert_eq!(sign_in.access_token.as_str(), PLANTED_TOKEN);
        assert_eq!(sign_in.scopes, ["user:inference", "user:mcp_servers"]);
        assert!(!format!("{sign_in:?}").contains(PLANTED_TOKEN));
        assert_eq!(
            std::fs::read(&credentials).expect("the file is still there"),
            planted.as_bytes()
        );

        // A file whose token sits where a number belongs is unreadable, and its parse error,
        // which quotes the value, reaches no log line.
        let unreadable = format!(r#"{{"claudeAiOauth":{{"expiresAt":"{PLANTED_TOKEN}"}}}}"#);
        std::fs::write(&credentials, &unreadable).expect("the file is planted");
        assert!(reader.read(&environment).await.is_none());
        assert_eq!(
            std::fs::read(&credentials).expect("the file is still there"),
            unreadable.as_bytes()
        );

        // With no file, the keychain item named for the folder is read.
        std::fs::remove_file(&credentials).expect("the file is removed");
        store
            .write(
                &claude_keychain_service(&environment),
                &claude_keychain_account(&environment),
                &SecretString::from(planted.clone()),
            )
            .expect("the item is planted");
        let sign_in = reader
            .read(&environment)
            .await
            .expect("the keychain item's record");
        assert_eq!(sign_in.access_token.as_str(), PLANTED_TOKEN);

        let logged = String::from_utf8(lines.0.lock().expect("not poisoned").clone())
            .expect("the log is text");
        assert!(!logged.is_empty(), "the unreadable file is logged");
        assert!(
            !logged.contains(PLANTED_TOKEN),
            "a log line holds the token: {logged}"
        );
    }

    // The keychain item's name: the base name where neither folder is named or the secure-storage
    // folder is named empty, else suffixed with the first eight hex digits of the SHA-256 of the
    // secure-storage folder where named, else of the config home, each in NFC. Killed by the salt
    // taken from the wrong variable, by the suffix dropped, and by a salt read without NFC.
    #[test]
    fn the_keychain_service_is_suffixed_by_the_folder_claude_code_salts_with() {
        let service = |variables: &[(&str, &str)]| {
            let environment: Vec<(String, String)> = variables
                .iter()
                .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
                .collect();
            claude_keychain_service(&environment)
        };
        let config_home = ("CLAUDE_CONFIG_DIR", "/accounts/work/.claude");

        assert_eq!(service(&[]), "Claude Code-credentials");
        assert_eq!(
            service(&[("CLAUDE_SECURESTORAGE_CONFIG_DIR", ""), config_home]),
            "Claude Code-credentials"
        );
        assert_eq!(service(&[config_home]), "Claude Code-credentials-22d54fbb");
        assert_eq!(
            service(&[
                ("CLAUDE_SECURESTORAGE_CONFIG_DIR", "/accounts/work/secure"),
                config_home
            ]),
            "Claude Code-credentials-c8d32363"
        );
        // A decomposed `é` salts as the composed one.
        assert_eq!(
            service(&[(
                "CLAUDE_SECURESTORAGE_CONFIG_DIR",
                "/accounts/re\u{301}sume\u{301}"
            )]),
            "Claude Code-credentials-bdce0c9c"
        );
        assert_eq!(
            service(&[("CLAUDE_CONFIG_DIR", "/accounts/re\u{301}sume\u{301}")]),
            "Claude Code-credentials-bdce0c9c"
        );
    }
}
