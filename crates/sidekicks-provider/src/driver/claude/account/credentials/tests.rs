//! The reads of Claude Code's stored credentials: a handed token, the credential file and the
//! keychain item through the keychain tool, none logging a token.

use secrecy::SecretString;
use sidekicks_platforms::Spawner;
use sidekicks_store::credential_store::os::{KEYCHAIN_CALL_TIMEOUT, KeychainTurn};

use super::{
    ClaudeSignInReader, ClaudeSignInReading, SECURE_STORAGE_FOLDER_VARIABLE,
    claude_keychain_account, claude_keychain_service,
};
use crate::captured_logs::CapturedLogs;
use crate::driver::claude::session::scripted::starts::stand_in_keychain;

// A token no log line may hold.
const PLANTED_TOKEN: &str = "planted-access-token-value";

// Killed by a token account's sealed token left unread where the environment names no token,
// which reads the account as signed in to no one and lists none of its connectors.
#[tokio::test]
async fn a_token_account_s_sealed_token_is_its_sign_in() {
    let environment = vec![(
        "CLAUDE_CODE_OAUTH_SCOPES".to_owned(),
        "user:inference user:mcp_servers".to_owned(),
    )];
    let reader = ClaudeSignInReader::without_keychain();
    let sealed = SecretString::from(PLANTED_TOKEN);

    let ClaudeSignInReading::Read(sign_in) = reader.read(&environment, Some(&sealed)).await else {
        panic!("the sealed token is the sign-in");
    };

    assert_eq!(sign_in.access_token.as_str(), PLANTED_TOKEN);
    assert_eq!(sign_in.scopes, ["user:inference", "user:mcp_servers"]);
}

// A credential file planted under a temporary folder is read, left byte for byte as it was,
// and no log line of the read holds its token, through a reading and an unreadable file
// alike. Killed by a write to the file, and by a log line carrying the token.
#[tokio::test]
async fn the_read_leaves_the_file_as_it_was_and_logs_no_token() {
    let folder = tempfile::tempdir().expect("a test folder");
    let credentials = folder.path().join(".credentials.json");
    let planted = format!(
        concat!(
            r#"{{"claudeAiOauth":{{"accessToken":"{PLANTED_TOKEN}","#,
            r#""refreshToken":"{PLANTED_TOKEN}-r","expiresAt":1767225600000,"#,
            r#""scopes":["user:inference","user:mcp_servers"],"subscriptionType":"max"}}}}"#,
        ),
        PLANTED_TOKEN = PLANTED_TOKEN,
    );
    std::fs::write(&credentials, &planted).expect("the file is planted");
    let environment = vec![
        (
            "CLAUDE_CONFIG_DIR".to_owned(),
            folder.path().display().to_string(),
        ),
        (
            SECURE_STORAGE_FOLDER_VARIABLE.to_owned(),
            folder.path().display().to_string(),
        ),
        ("USER".to_owned(), "tester".to_owned()),
    ];
    let reader = ClaudeSignInReader::without_keychain();
    let (lines, _default) = CapturedLogs::start();

    let ClaudeSignInReading::Read(sign_in) = reader.read(&environment, None).await else {
        panic!("the file's record");
    };
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
    assert!(matches!(
        reader.read(&environment, None).await,
        ClaudeSignInReading::Absent
    ));
    assert_eq!(
        std::fs::read(&credentials).expect("the file is still there"),
        unreadable.as_bytes()
    );

    let logged = lines.text();
    assert!(!logged.is_empty(), "the unreadable file is logged");
    assert!(
        !logged.contains(PLANTED_TOKEN),
        "a log line holds the token: {logged}"
    );
}

// With no credential file, the keychain item named for the account's folder is read through
// the keychain tool, by its account and service, and its token reaches no log line. Killed by
// the item read in the daemon's own process, which never reaches the tool, and by a read
// naming another item.
#[tokio::test]
async fn the_keychain_item_is_read_through_the_keychain_tool() {
    let keychain = stand_in_keychain();
    // Only a system whose providers keep their sign-in in a keychain item has the tool.
    let Some(tool) = keychain.sign_in_move() else {
        return;
    };
    let folder = tempfile::tempdir().expect("a test folder");
    let environment = vec![
        (
            SECURE_STORAGE_FOLDER_VARIABLE.to_owned(),
            folder.path().display().to_string(),
        ),
        ("USER".to_owned(), "tester".to_owned()),
    ];
    let service = claude_keychain_service(&environment);
    let account = claude_keychain_account(&environment);
    let record = format!(
        r#"{{"claudeAiOauth":{{"accessToken":"{PLANTED_TOKEN}","scopes":["user:inference"]}}}}"#
    );
    keychain.put_item(&service, &account, record.as_bytes());
    let spawner = Spawner::new(tokio::runtime::Handle::current()).expect("the spawner starts");
    let turn = KeychainTurn::new(KEYCHAIN_CALL_TIMEOUT);
    let reader = ClaudeSignInReader::new(Some(tool), &spawner, &turn);
    let (lines, _default) = CapturedLogs::start();

    let ClaudeSignInReading::Read(sign_in) = reader.read(&environment, None).await else {
        panic!("the keychain item's record");
    };

    assert_eq!(sign_in.access_token.as_str(), PLANTED_TOKEN);
    assert_eq!(sign_in.scopes, ["user:inference"]);
    assert_eq!(
        keychain.calls(),
        [[
            "find-generic-password",
            "-a",
            account.as_str(),
            "-s",
            service.as_str(),
            "-w"
        ]]
    );
    let logged = lines.text();
    assert!(
        !logged.contains(PLANTED_TOKEN),
        "a log line holds the token: {logged}"
    );
}

// A token the environment hands Claude Code is its sign-in ahead of the stored record, with
// the scopes the scopes variable lists, else inference alone; a sign-in file descriptor, which
// never reaches the process, leaves the stored record its sign-in. Killed by the stored record
// read first, and by the descriptor read as a sign-in of its own.
#[tokio::test]
async fn a_token_the_environment_hands_claude_code_comes_ahead_of_the_stored_one() {
    let folder = tempfile::tempdir().expect("a test folder");
    std::fs::write(
        folder.path().join(".credentials.json"),
        r#"{"claudeAiOauth":{"accessToken":"stored","scopes":["user:mcp_servers"]}}"#,
    )
    .expect("the file is planted");
    let reader = ClaudeSignInReader::without_keychain();
    let read = |variables: &[(&str, &str)]| {
        let environment: Vec<(String, String)> = [("CLAUDE_CONFIG_DIR", folder.path())]
            .iter()
            .map(|(name, path)| ((*name).to_owned(), path.display().to_string()))
            .chain(
                variables
                    .iter()
                    .map(|(name, value)| ((*name).to_owned(), (*value).to_owned())),
            )
            .collect();
        let reader = reader.clone();
        async move { reader.read(&environment, None).await }
    };

    let ClaudeSignInReading::Read(sign_in) = read(&[("CLAUDE_CODE_OAUTH_TOKEN", " handed ")]).await
    else {
        panic!("the environment's token");
    };
    assert_eq!(sign_in.access_token.as_str(), "handed");
    assert_eq!(sign_in.scopes, ["user:inference"]);

    let ClaudeSignInReading::Read(sign_in) = read(&[
        ("CLAUDE_CODE_OAUTH_TOKEN", "handed"),
        (
            "CLAUDE_CODE_OAUTH_SCOPES",
            "user:inference\tuser:mcp_servers",
        ),
    ])
    .await
    else {
        panic!("the environment's token");
    };
    assert_eq!(sign_in.scopes, ["user:inference", "user:mcp_servers"]);

    let ClaudeSignInReading::Read(sign_in) =
        read(&[("CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR", "3")]).await
    else {
        panic!("the stored record past a descriptor");
    };
    assert_eq!(sign_in.access_token.as_str(), "stored");
    assert_eq!(sign_in.scopes, ["user:mcp_servers"]);

    let ClaudeSignInReading::Read(sign_in) = read(&[("CLAUDE_CODE_OAUTH_TOKEN", "  ")]).await
    else {
        panic!("the stored record");
    };
    assert_eq!(sign_in.access_token.as_str(), "stored");
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
        service(&[(SECURE_STORAGE_FOLDER_VARIABLE, ""), config_home]),
        "Claude Code-credentials"
    );
    assert_eq!(service(&[config_home]), "Claude Code-credentials-22d54fbb");
    assert_eq!(
        service(&[
            (SECURE_STORAGE_FOLDER_VARIABLE, "/accounts/work/secure"),
            config_home
        ]),
        "Claude Code-credentials-c8d32363"
    );
    // A decomposed `é` salts as the composed one.
    assert_eq!(
        service(&[(
            SECURE_STORAGE_FOLDER_VARIABLE,
            "/accounts/re\u{301}sume\u{301}"
        )]),
        "Claude Code-credentials-bdce0c9c"
    );
    assert_eq!(
        service(&[("CLAUDE_CONFIG_DIR", "/accounts/re\u{301}sume\u{301}")]),
        "Claude Code-credentials-bdce0c9c"
    );
}
