use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};

use secrecy::SecretString;
use serde_json::{Value, json};
use sidekicks_contracts::mcp::server::config::McpServerAddress;
use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerName};
use sidekicks_contracts::plugin::PluginToken;
use sidekicks_store::data_folder::plugin_home;
use tokio::sync::oneshot;
use url::Url;

use super::{CLAUDE_MCP_SIGN_IN_FOLDER, read_claude_saved_sign_in};
use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::account_credentials::{
    CLAUDE_CREDENTIALS_FILE, SECURE_STORAGE_FOLDER_VARIABLE, claude_keychain_account,
    claude_keychain_service,
};
use crate::driver::claude::session::scripted::channel::{ScriptedAnswer, ScriptedChannel};
use crate::driver::claude::session::scripted::driver::ScriptedDriver;
use crate::driver::claude::session::scripted::starts::ScriptedSignInPlace;
use crate::driver::contract::DriverError;
use crate::driver::contract::sign_in::{
    ProviderSignInBrowser, ProviderSignInTakeover, ProviderSignInTakeoverRequest,
};
use crate::runtime_binding::test_store::test_provider_account_id;

/// The server signed in to.
const SERVER_NAME: &str = "docs";

/// Its address as the binding keeps it.
const SERVER_ADDRESS: &str = "https://docs.example.test/mcp";

/// An expiry in milliseconds since the epoch, as Claude Code keeps it.
const EXPIRY_MILLISECONDS: u64 = 1_767_225_600_000;

/// The person's own saved sign-ins, planted in their default Claude Code folder.
const PERSON_SIGN_INS: &str = r#"{"mcpOAuth":{"docs|person":{"serverName":"docs","serverUrl":"https://docs.example.test/mcp","accessToken":"access-of-the-person","expiresAt":1}}}"#;

/// The person's own Claude Code config, declaring the server.
const PERSON_CONFIG: &str =
    r#"{"mcpServers":{"docs":{"type":"http","url":"https://docs.example.test/mcp"}}}"#;

/// Where the daemon's relay takes the browser back, and where the browser came back.
const REDIRECT_URL: &str = "https://relay.example.test/callback";
const RETURNED_URL: &str = "https://relay.example.test/callback?code=one";

fn name() -> McpServerName {
    McpServerName::new(SERVER_NAME.to_owned()).expect("a test server name is a name")
}

fn address() -> McpServerAddress {
    McpServerAddress::new(SERVER_ADDRESS).expect("a test address is a web address")
}

fn user_binding() -> McpServerBindingRef {
    McpServerBindingRef::User {
        provider: DESCRIPTOR.provider_id(),
        server_name: name(),
    }
}

// One saved sign-in as Claude Code writes it.
fn saved(server_name: &str, server_url: &str, access_token: &str) -> Value {
    json!({
        "serverName": server_name,
        "serverUrl": server_url,
        "accessToken": access_token,
        "refreshToken": "refresh-one",
        "expiresAt": EXPIRY_MILLISECONDS,
        "scope": "read write",
        "clientId": "client-one",
        "clientSecret": "secret-one",
        "discoveryState": {"authorizationServerUrl": "https://auth.example.test"},
    })
}

// The folder each sign-in makes its own in, under the fixture's data folder.
fn sign_ins_folder(scripted: &ScriptedDriver) -> PathBuf {
    CLAUDE_MCP_SIGN_IN_FOLDER
        .iter()
        .fold(scripted.services.data_folder.clone(), |folder, part| {
            folder.join(part)
        })
}

// A channel whose `mcp_authenticate` answers an authorization address and takes the browser's
// return at the daemon's redirect address.
fn custom_scheme_channel() -> Arc<ScriptedChannel> {
    let channel = Arc::new(ScriptedChannel::default());
    channel.answer(
        "mcp_authenticate",
        ScriptedAnswer::Reply(json!({
            "authUrl": "https://auth.example.test/authorize",
            "requiresUserAction": true,
            "callbackExpected": true,
            "redirectScheme": "custom",
        })),
    );
    channel
}

// A request for `binding`'s sign-in, with the browser's two legs the test drives.
fn request(
    binding: McpServerBindingRef,
) -> (
    ProviderSignInTakeoverRequest,
    oneshot::Receiver<Url>,
    oneshot::Sender<Url>,
) {
    let (authorization_url, opened) = oneshot::channel();
    let (returned, browser_return) = oneshot::channel();
    let request = ProviderSignInTakeoverRequest {
        provider_account_id: test_provider_account_id(),
        binding,
        root_folder: None,
        server_address: address(),
        redirect_url: Url::parse(REDIRECT_URL).expect("an address"),
        lifetime: Duration::from_secs(30),
        browser: ProviderSignInBrowser {
            authorization_url,
            browser_return,
        },
    };
    (request, opened, returned)
}

// Runs `binding`'s sign-in on `scripted`'s driver to its end, the browser opened and returned.
async fn sign_in(
    scripted: &ScriptedDriver,
    binding: McpServerBindingRef,
) -> (Url, Result<ProviderSignInTakeover, DriverError>) {
    let (request, opened, returned) = request(binding);
    let driver = Arc::clone(&scripted.driver);
    let signing_in = tokio::spawn(async move { driver.sign_in_with_own_client(request).await });
    let opened = opened
        .await
        .expect("the authorization address is handed out");
    returned
        .send(Url::parse(RETURNED_URL).expect("an address"))
        .expect("the sign-in waits for the browser");
    (opened, signing_in.await.expect("the sign-in runs"))
}

// Killed by reading the expiry as seconds, by matching on the name alone or the address alone,
// by reading the scope as one scope, by dropping the issuer the discovery kept, and by dropping
// the client secret.
#[test]
fn a_saved_sign_in_matches_by_name_and_address_and_its_expiry_reads_in_milliseconds() {
    let file = json!({"mcpOAuth": {
        "a": saved(SERVER_NAME, "https://other.example.test/mcp", "access-of-another-address"),
        "b": saved("other", SERVER_ADDRESS, "access-of-another-name"),
        "c": saved(SERVER_NAME, "https://DOCS.example.test/mcp/", "access-of-the-server"),
    }});

    let read = read_claude_saved_sign_in(
        serde_json::from_value(file).expect("Claude Code's credentials parse"),
        &name(),
        &address(),
    )
    .expect("the server's sign-in reads");

    let takeover = read.takeover;
    assert_eq!(takeover.access_token, "access-of-the-server");
    assert_eq!(
        takeover.expires_at,
        Some(UNIX_EPOCH + Duration::from_millis(EXPIRY_MILLISECONDS))
    );
    assert_eq!(takeover.scopes, ["read", "write"]);
    assert_eq!(takeover.client_id, "client-one");
    assert_eq!(takeover.client_secret.as_deref(), Some("secret-one"));
    assert_eq!(
        takeover.issuer.as_deref(),
        Some("https://auth.example.test")
    );
}

// Killed by running the process on the account's or the person's own folders in place of
// one the daemon makes, by dropping the browser's return, and by leaving the folder behind.
#[tokio::test]
async fn a_claude_takeover_leaves_the_persons_saved_sign_ins_as_they_were() {
    let scripted = ScriptedDriver::new();
    let person_folder = scripted.home.join(".claude");
    std::fs::create_dir_all(&person_folder).expect("the person's folder is made");
    let planted = person_folder.join(CLAUDE_CREDENTIALS_FILE);
    std::fs::write(&planted, PERSON_SIGN_INS).expect("the person's sign-ins are planted");
    std::fs::write(scripted.home.join(".claude.json"), PERSON_CONFIG)
        .expect("the person's config is written");
    let channel = custom_scheme_channel();
    scripted.starts.script_mcp_sign_in(
        Arc::clone(&channel),
        json!({"mcpOAuth": {"docs|key": saved(SERVER_NAME, SERVER_ADDRESS, "access-one")}}),
        ScriptedSignInPlace::File,
    );

    let (opened, signed_in) = sign_in(&scripted, user_binding()).await;
    let signed_in = signed_in.expect("the sign-in reads back");

    assert_eq!(opened.as_str(), "https://auth.example.test/authorize");
    assert_eq!(signed_in.access_token, "access-one");
    let handed_back = channel
        .control_requests()
        .into_iter()
        .find(|request| request["subtype"] == "mcp_oauth_callback_url")
        .expect("the browser's return is handed back");
    assert_eq!(
        handed_back["callbackUrl"],
        "https://relay.example.test/callback?code=one"
    );
    assert_eq!(
        std::fs::read_to_string(&planted).expect("the person's sign-ins read"),
        PERSON_SIGN_INS
    );
    let sign_ins = sign_ins_folder(&scripted);
    let [start] = scripted
        .starts
        .take_sign_in_starts()
        .try_into()
        .ok()
        .expect("one");
    let config_folder = start
        .environment
        .iter()
        .find(|(variable, _value)| variable == "CLAUDE_CONFIG_DIR")
        .map(|(_variable, value)| std::path::PathBuf::from(value))
        .expect("the process names its config folder");
    assert_eq!(config_folder.parent(), Some(sign_ins.as_path()));
    let left = std::fs::read_dir(&sign_ins)
        .expect("the sign-ins' folder reads")
        .count();
    assert_eq!(left, 0, "the sign-in's own folder is removed");
}

// Where Claude Code keeps the sign-in in the keychain item named for the sign-in's own folder,
// the takeover reads it, client secret included, and removes the item. Killed by never reading
// the keychain, by leaving the item behind, and by dropping the client secret.
#[tokio::test]
async fn a_sign_in_saved_in_the_keychain_is_read_and_its_item_removed() {
    let scripted = ScriptedDriver::new();
    std::fs::write(scripted.home.join(".claude.json"), PERSON_CONFIG)
        .expect("the person's config is written");
    scripted.starts.script_mcp_sign_in(
        custom_scheme_channel(),
        json!({"mcpOAuth": {"docs|key": saved(SERVER_NAME, SERVER_ADDRESS, "access-one")}}),
        ScriptedSignInPlace::Keychain,
    );

    let (_opened, signed_in) = sign_in(&scripted, user_binding()).await;
    let signed_in = signed_in.expect("the keychain's sign-in reads back");

    assert_eq!(signed_in.access_token, "access-one");
    assert_eq!(signed_in.client_secret.as_deref(), Some("secret-one"));
    let [start] = scripted
        .starts
        .take_sign_in_starts()
        .try_into()
        .ok()
        .expect("one");
    let item = scripted
        .starts
        .keychain
        .read(
            &claude_keychain_service(&start.environment),
            &claude_keychain_account(&start.environment),
        )
        .expect("the keychain reads");
    assert!(item.is_none(), "the sign-in's keychain item is removed");
}

// A plugin's server signs in with the entry its plugin's file declares, handed to the process
// whole; a connector, which has no entry of the person's, answers the typed arm before any
// process starts. Killed by a plugin binding read as having no entry, and by a connector read as
// any other failure.
#[tokio::test]
async fn a_plugin_binding_signs_in_with_its_entry_and_a_connector_reads_the_no_entry_arm() {
    let scripted = ScriptedDriver::new();
    let plugins = plugin_home(&scripted.home, &DESCRIPTOR.provider_id());
    let plugin_root = scripted.folder.path().join("tools-plugin");
    std::fs::create_dir_all(plugins.join("plugins")).expect("the plugin home is made");
    std::fs::create_dir_all(&plugin_root).expect("the plugin's folder is made");
    std::fs::write(
        plugins.join("plugins").join("installed_plugins.json"),
        json!({"plugins": {"tools@market": [{"installPath": plugin_root}]}}).to_string(),
    )
    .expect("the install is recorded");
    let entry = json!({"type": "http", "url": SERVER_ADDRESS, "oauth": {"clientId": "client-one"}});
    std::fs::write(
        plugin_root.join(".mcp.json"),
        json!({"mcpServers": {SERVER_NAME: entry.clone()}}).to_string(),
    )
    .expect("the plugin's servers are written");
    scripted.starts.script_mcp_sign_in(
        custom_scheme_channel(),
        json!({"mcpOAuth": {"docs|key": saved(SERVER_NAME, SERVER_ADDRESS, "access-one")}}),
        ScriptedSignInPlace::File,
    );
    let plugin = McpServerBindingRef::Plugin {
        provider: DESCRIPTOR.provider_id(),
        scope_ref: PluginToken::new("tools".to_owned()).expect("a plugin name"),
        server_name: name(),
    };

    let (_opened, signed_in) = sign_in(&scripted, plugin).await;

    assert_eq!(
        signed_in
            .expect("the plugin's server signs in")
            .access_token,
        "access-one"
    );
    let [start] = scripted
        .starts
        .take_sign_in_starts()
        .try_into()
        .ok()
        .expect("one");
    assert_eq!(start.servers, json!({"mcpServers": {SERVER_NAME: entry}}));
    assert!(start.loads_only_its_servers);

    let connector = McpServerBindingRef::Connector {
        provider: DESCRIPTOR.provider_id(),
        scope_ref: test_provider_account_id(),
        server_name: name(),
    };
    let (request, _opened, _returned) = request(connector.clone());
    let refused = scripted.driver.sign_in_with_own_client(request).await;

    assert!(
        matches!(
            &refused,
            Err(DriverError::NoPersonServerEntry(no_entry)) if no_entry.binding == connector
        ),
        "a connector reads the no-entry arm, not {refused:?}"
    );
    assert!(scripted.starts.take_sign_in_starts().is_empty());
}

// A sign-in dropped while it waits for the browser leaves no folder, and the start's sweep removes
// a folder a stopped daemon left, with the keychain item named for it. Killed by a folder with no
// drop guard, by a start that sweeps nothing, and by a sweep that leaves the keychain item.
#[tokio::test]
async fn a_dropped_sign_in_leaves_no_folder_and_the_sweep_removes_a_left_one() {
    let scripted = ScriptedDriver::new();
    std::fs::write(scripted.home.join(".claude.json"), PERSON_CONFIG)
        .expect("the person's config is written");
    scripted.starts.script_mcp_sign_in(
        custom_scheme_channel(),
        json!({}),
        ScriptedSignInPlace::File,
    );
    let sign_ins = sign_ins_folder(&scripted);
    let (request, opened, _returned) = request(user_binding());
    let driver = Arc::clone(&scripted.driver);
    let signing_in = tokio::spawn(async move { driver.sign_in_with_own_client(request).await });
    opened
        .await
        .expect("the authorization address is handed out");
    let made = std::fs::read_dir(&sign_ins)
        .expect("the sign-ins' folder reads")
        .count();
    assert_eq!(made, 1, "the sign-in's own folder is made");

    signing_in.abort();
    let ended = signing_in.await;

    assert!(ended.is_err_and(|error| error.is_cancelled()));
    let left = std::fs::read_dir(&sign_ins)
        .expect("the sign-ins' folder reads")
        .count();
    assert_eq!(left, 0, "the dropped sign-in's folder is removed");

    let leftover = sign_ins.join("left-by-a-stopped-daemon");
    std::fs::create_dir_all(&leftover).expect("a leftover folder is planted");
    std::fs::write(leftover.join(CLAUDE_CREDENTIALS_FILE), "{}").expect("its file is planted");
    let leftover_environment = [(
        SECURE_STORAGE_FOLDER_VARIABLE.to_owned(),
        leftover.to_string_lossy().into_owned(),
    )];
    let keychain = &scripted.starts.keychain;
    let (service, account) = (
        claude_keychain_service(&leftover_environment),
        claude_keychain_account(&leftover_environment),
    );
    keychain
        .write(&service, &account, &SecretString::from("{}".to_owned()))
        .expect("its keychain item is planted");

    scripted
        .driver
        .remove_left_sign_in_folders()
        .await
        .expect("the sweep removes the leftovers");

    assert!(!sign_ins.exists(), "the left folder is removed");
    assert!(
        keychain
            .read(&service, &account)
            .expect("the keychain reads")
            .is_none(),
        "the left folder's keychain item is removed"
    );
}
