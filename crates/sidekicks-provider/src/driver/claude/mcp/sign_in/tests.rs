use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};

use rstest::rstest;
use secrecy::ExposeSecret;
use serde_json::{Map, Value, json};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::machine::settings::EnvironmentRow;
use sidekicks_contracts::mcp::server::config::McpServerAddress;
use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerName};
use sidekicks_contracts::plugin::PluginToken;
use sidekicks_platforms::PathRules;
use sidekicks_store::data_folder::plugin_home;
use tokio::sync::oneshot;
use url::Url;

use super::saved_credentials::read_claude_saved_sign_in;
use super::{CLAUDE_MCP_SIGN_IN_FOLDER, SIGN_IN_KEYCHAIN_ACCOUNT_FILE, sign_in_with_claude_client};
use crate::driver::DriverServices;
use crate::driver::claude::account::credentials::{
    CLAUDE_CREDENTIALS_FILE, SECURE_STORAGE_FOLDER_VARIABLE, claude_keychain_account,
    claude_keychain_service,
};
use crate::driver::claude::session::scripted::channel::{ScriptedAnswer, ScriptedChannel};
use crate::driver::claude::session::scripted::driver::{ScriptedDriver, sandbox_cannot_run};
use crate::driver::claude::session::scripted::starts::{
    ScriptedProcessWrite, ScriptedSignInPlace, ScriptedStarts,
};
use crate::driver::claude::{ClaudeDriver, DESCRIPTOR};
use crate::driver::contract::error::DriverError;
use crate::driver::contract::sign_in::{
    ProviderSignInFailure, ProviderSignInReturn, ProviderSignInTakeover,
    ProviderSignInTakeoverRequest,
};
use crate::port::inbound_dispatch::InboundDispatch;
use crate::port::run_host::RunHost;
use crate::port::run_host::test_host::RecordingRunEngine;
use crate::runtime_binding::test_store::test_provider_account_id;

/// The server signed in to.
pub(super) const SERVER_NAME: &str = "docs";

/// Its address as the binding keeps it.
const SERVER_ADDRESS: &str = "https://docs.example.test/mcp";

/// An expiry in milliseconds since the epoch, as Claude Code keeps it.
const EXPIRY_MILLISECONDS: u64 = 1_767_225_600_000;

/// The person's own saved sign-ins, planted in their default Claude Code folder.
const PERSON_SIGN_INS: &str = concat!(
    r#"{"mcpOAuth":{"docs|person":{"serverName":"docs","#,
    r#""serverUrl":"https://docs.example.test/mcp","accessToken":"access-of-the-person","#,
    r#""expiresAt":1}}}"#,
);

/// The person's own Claude Code config, declaring the server.
pub(super) const PERSON_CONFIG: &str =
    r#"{"mcpServers":{"docs":{"type":"http","url":"https://docs.example.test/mcp"}}}"#;

/// Where the daemon's receiver takes the browser back, and where the browser came back.
const REDIRECT_URL: &str = "https://receiver.example.test/callback";
const RETURNED_URL: &str = "https://receiver.example.test/callback?code=one";

pub(super) fn name() -> McpServerName {
    McpServerName::new(SERVER_NAME.to_owned()).expect("a test server name is a name")
}

fn address() -> McpServerAddress {
    McpServerAddress::new(SERVER_ADDRESS).expect("a test address is a web address")
}

/// The environment rows of `entries`, each a name and its value.
pub(super) fn user_binding() -> McpServerBindingRef {
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

// A request for `binding`'s sign-in, with the browser's legs the test drives.
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
        every_project_rows: Vec::new(),
        project_rows: Vec::new(),
        owner_client_secret: None,
        lifetime: Duration::from_secs(30),
        authorization_url,
        browser_return: ProviderSignInReturn::ThroughDaemonReceiver {
            redirect_url: Url::parse(REDIRECT_URL).expect("an address"),
            browser_return,
        },
    };
    (request, opened, returned)
}

// A driver on `services`, whose base environment a test sets, over a fixture's starts and engine.
pub(super) fn driver_on_environment(
    services: &DriverServices,
    starts: &Arc<ScriptedStarts>,
    engine: &Arc<RecordingRunEngine>,
) -> ClaudeDriver {
    let host: Arc<dyn RunHost> = engine.clone();
    let dispatch: Arc<dyn InboundDispatch> = engine.clone();
    ClaudeDriver::with_engine(
        services,
        starts.clone(),
        starts.keychain.sign_in_move(),
        &host,
        &dispatch,
        sandbox_cannot_run,
    )
    .expect("the session pieces compose")
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
        &[],
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
    assert_eq!(
        takeover
            .client_secret
            .as_ref()
            .map(ExposeSecret::expose_secret),
        Some("secret-one")
    );
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
        Vec::new(),
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
        "https://receiver.example.test/callback?code=one"
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
    // Only a system whose providers keep their sign-in in a keychain item reads one.
    if scripted.starts.keychain.sign_in_move().is_none() {
        return;
    }
    std::fs::create_dir_all(&scripted.home).expect("the person's home is made");
    std::fs::write(scripted.home.join(".claude.json"), PERSON_CONFIG)
        .expect("the person's config is written");
    scripted.starts.script_mcp_sign_in(
        custom_scheme_channel(),
        json!({"mcpOAuth": {"docs|key": saved(SERVER_NAME, SERVER_ADDRESS, "access-one")}}),
        ScriptedSignInPlace::Keychain,
        Vec::new(),
    );

    let (_opened, signed_in) = sign_in(&scripted, user_binding()).await;
    let signed_in = signed_in.expect("the keychain's sign-in reads back");

    assert_eq!(signed_in.access_token, "access-one");
    assert_eq!(
        signed_in
            .client_secret
            .as_ref()
            .map(ExposeSecret::expose_secret),
        Some("secret-one")
    );
    let [start] = scripted
        .starts
        .take_sign_in_starts()
        .try_into()
        .ok()
        .expect("one");
    let item = scripted.starts.keychain.item(
        &claude_keychain_service(&start.environment),
        &claude_keychain_account(&start.environment),
    );
    assert!(item.is_none(), "the sign-in's keychain item is removed");
}

// A plugin's server signs in with the entry its plugin's file declares, handed to the process with
// the plugin's placeholders filled; a connector, which has no entry of the person's, answers the
// typed arm before any process starts. Killed by a plugin binding read as having no entry, by its
// placeholders left as written, and by a connector read as any other failure.
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
    let entry = json!({
        "type": "http",
        "url": SERVER_ADDRESS,
        "headers": {"X-Plugin": "${CLAUDE_PLUGIN_ROOT}/key", "X-Data": "${CLAUDE_PLUGIN_DATA}"},
        "oauth": {"clientId": "client-one"},
    });
    std::fs::write(
        plugin_root.join(".mcp.json"),
        json!({"mcpServers": {SERVER_NAME: entry}}).to_string(),
    )
    .expect("the plugin's servers are written");
    scripted.starts.script_mcp_sign_in(
        custom_scheme_channel(),
        json!({"mcpOAuth": {"docs|key": saved(SERVER_NAME, SERVER_ADDRESS, "access-one")}}),
        ScriptedSignInPlace::File,
        Vec::new(),
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
    let filled = json!({
        "type": "http",
        "url": SERVER_ADDRESS,
        "headers": {
            "X-Plugin": format!("{}/key", plugin_root.display()),
            "X-Data": plugins
                .join("plugins")
                .join("data")
                .join("tools-market")
                .display()
                .to_string(),
        },
        "oauth": {"clientId": "client-one"},
    });
    assert_eq!(
        start.servers,
        Some(json!({"mcpServers": {SERVER_NAME: filled}}))
    );

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

// Beside an administrator's MCP file that declares the server, a sign-in for its organization
// binding starts one process handed no servers file, and one for the person's own binding of the
// same name starts none and makes no folder, since Claude Code loads no server of a person's
// there. Killed by `--mcp-config` passed beside the file, and by a person's server started where
// Claude Code cannot load it.
#[rstest]
#[case::managed(
    McpServerBindingRef::Managed { provider: DESCRIPTOR.provider_id(), server_name: name() },
    true
)]
#[case::person(user_binding(), false)]
#[tokio::test]
async fn a_sign_in_beside_a_managed_file_passes_no_servers_file(
    #[case] binding: McpServerBindingRef,
    #[case] is_signed_in: bool,
) {
    let scripted = ScriptedDriver::new();
    std::fs::create_dir_all(&scripted.home).expect("the person's home is made");
    std::fs::write(scripted.home.join(".claude.json"), PERSON_CONFIG)
        .expect("the person's config is written");
    scripted.starts.script_mcp_sign_in(
        custom_scheme_channel(),
        json!({"mcpOAuth": {"docs|key": saved(SERVER_NAME, SERVER_ADDRESS, "access-one")}}),
        ScriptedSignInPlace::File,
        Vec::new(),
    );
    let servers: Map<String, Value> =
        serde_json::from_value(json!({SERVER_NAME: {"type": "http", "url": SERVER_ADDRESS}}))
            .expect("the file's servers are an object");
    let (request, opened, returned) = request(binding.clone());
    let driver = Arc::clone(&scripted.driver);
    let signing_in = tokio::spawn(async move {
        sign_in_with_claude_client(
            &*driver.starts,
            driver.sign_in_sources_for(Some(servers)).await,
            |folder| driver.sign_in_environment(folder, &[], &[]),
            request,
        )
        .await
    });
    if is_signed_in {
        opened
            .await
            .expect("the authorization address is handed out");
        returned
            .send(Url::parse(RETURNED_URL).expect("an address"))
            .expect("the sign-in waits for the browser");
    }

    let signed_in = signing_in.await.expect("the sign-in runs");

    let starts = scripted.starts.take_sign_in_starts();
    if is_signed_in {
        assert_eq!(
            signed_in.expect("the sign-in reads back").access_token,
            "access-one"
        );
        let [start] = starts.try_into().ok().expect("one");
        assert_eq!(start.servers, None);
    } else {
        assert!(
            matches!(
                &signed_in,
                Err(DriverError::NoPersonServerEntry(no_entry)) if no_entry.binding == binding
            ),
            "a person's server reads the no-entry arm, not {signed_in:?}"
        );
        assert!(starts.is_empty());
        assert!(!sign_ins_folder(&scripted).exists());
    }
}

// A binding whose server the person's config no longer declares, or declares at another address,
// reads the no-entry arm before any process starts or any sign-in folder is made, so the launch
// asks the next provider. Killed by a missing entry answered as the driver's own failure, by an
// entry matched by its name alone, which signs in to the other address, and by a plain address at
// another server judged only once a folder is made for it.
#[rstest]
#[case::no_entry(json!({"mcpServers": {}}))]
#[case::another_address(
    json!({"mcpServers": {SERVER_NAME: {"type": "http", "url": "https://other.example.test/mcp"}}})
)]
#[tokio::test]
async fn a_binding_with_no_entry_at_its_address_reads_the_no_entry_arm(#[case] config: Value) {
    let scripted = ScriptedDriver::new();
    std::fs::create_dir_all(&scripted.home).expect("the person's home is made");
    std::fs::write(scripted.home.join(".claude.json"), config.to_string())
        .expect("the person's config is written");
    let (request, _opened, _returned) = request(user_binding());

    let refused = scripted.driver.sign_in_with_own_client(request).await;

    assert!(
        matches!(
            &refused,
            Err(DriverError::NoPersonServerEntry(no_entry)) if no_entry.binding == user_binding()
        ),
        "a binding with no entry at its address reads the no-entry arm, not {refused:?}"
    );
    assert!(scripted.starts.take_sign_in_starts().is_empty());
    assert!(!sign_ins_folder(&scripted).exists());
}

// A person whose environment sets `CLAUDE_CONFIG_DIR` keeps their servers in that folder's
// `.claude.json`, and the sign-in reads the entry there, not the one in the home. Killed by a read
// that resolves the person's files with no environment.
#[tokio::test]
async fn a_user_entry_is_read_from_the_config_folder_the_persons_environment_names() {
    let scripted = ScriptedDriver::new();
    let config_folder = scripted.folder.path().join("person-config");
    std::fs::create_dir_all(&config_folder).expect("the person's config folder is made");
    std::fs::create_dir_all(&scripted.home).expect("the person's home is made");
    std::fs::write(config_folder.join(".claude.json"), PERSON_CONFIG)
        .expect("the person's config is written");
    std::fs::write(
        scripted.home.join(".claude.json"),
        json!({"mcpServers": {SERVER_NAME: {"type": "http", "url": "https://home.example.test"}}})
            .to_string(),
    )
    .expect("a config the person's environment does not read is written");
    let driver = driver_on_environment(
        &DriverServices {
            base_environment: Arc::from([
                ("HOME".to_owned(), scripted.home.display().to_string()),
                (
                    "CLAUDE_CONFIG_DIR".to_owned(),
                    config_folder.display().to_string(),
                ),
            ]),
            ..scripted.services
        },
        &scripted.starts,
        &scripted.engine,
    );
    scripted.starts.script_mcp_sign_in(
        custom_scheme_channel(),
        json!({"mcpOAuth": {"docs|key": saved(SERVER_NAME, SERVER_ADDRESS, "access-one")}}),
        ScriptedSignInPlace::File,
        Vec::new(),
    );
    let (request, opened, returned) = request(user_binding());
    let signing_in = tokio::spawn(async move { driver.sign_in_with_own_client(request).await });
    opened
        .await
        .expect("the authorization address is handed out");
    returned
        .send(Url::parse(RETURNED_URL).expect("an address"))
        .expect("the sign-in waits for the browser");

    signing_in
        .await
        .expect("the sign-in runs")
        .expect("the sign-in reads back");

    let [start] = scripted
        .starts
        .take_sign_in_starts()
        .try_into()
        .ok()
        .expect("one");
    assert_eq!(
        start.servers,
        Some(json!({"mcpServers": {SERVER_NAME: {"type": "http", "url": SERVER_ADDRESS}}}))
    );
}

// An entry whose `url` names variables matches the request at the address Claude Code connects
// to, each variable filled from the sign-in process's own environment: a default where the
// variable is unset, the variable's value where it is set, a row's value where only the request's
// rows set it, and a covered credential name read as empty though set. The process takes every
// row, `USER` included, and its folder records the keychain account that environment files the
// sign-in under while the process runs. The entry still goes to the process as declared, and its
// saved sign-in reads back whether Claude Code saved the address filled or as declared. Killed by
// matching the `url` as written, which names no server, by filling it from no environment, by the
// rows not handed to the process's environment (the row case reads the no-entry arm), by no
// record kept or one written after the start, by expanding a covered credential name, and by
// matching the saved address only as written.
#[rstest]
#[case::a_default_where_unset(
    &[],
    &[],
    "${API_BASE_URL:-https://docs.example.test}/mcp",
    SERVER_ADDRESS,
    SERVER_ADDRESS
)]
#[case::the_value_where_set(
    &[("API_BASE_URL", "https://set.example.test")],
    &[],
    "${API_BASE_URL:-https://docs.example.test}/mcp",
    "https://set.example.test/mcp",
    "https://set.example.test/mcp"
)]
#[case::a_rows_value_and_user(
    &[],
    &[("API_BASE_URL", "https://row.example.test"), ("USER", "row-user")],
    "${API_BASE_URL:-https://docs.example.test}/mcp",
    "https://row.example.test/mcp",
    "https://row.example.test/mcp"
)]
#[case::a_credential_read_empty(
    &[("NPM_TOKEN", "/npm-secret")],
    &[],
    "https://docs.example.test${NPM_TOKEN}/mcp",
    SERVER_ADDRESS,
    SERVER_ADDRESS
)]
#[case::a_saved_address_as_declared(
    &[("API_BASE_URL", "https://set.example.test")],
    &[],
    "${API_BASE_URL:-https://docs.example.test}/mcp",
    "https://set.example.test/mcp",
    "${API_BASE_URL:-https://docs.example.test}/mcp"
)]
#[tokio::test]
async fn an_entry_address_with_variables_matches_as_the_sign_in_process_fills_it(
    #[case] variables: &[(&str, &str)],
    #[case] rows: &[(&str, &str)],
    #[case] declared_url: &str,
    #[case] requested_address: &str,
    #[case] saved_address: &str,
) {
    let scripted = ScriptedDriver::new();
    std::fs::create_dir_all(&scripted.home).expect("the person's home is made");
    let declared = json!({"type": "http", "url": declared_url});
    std::fs::write(
        scripted.home.join(".claude.json"),
        json!({"mcpServers": {SERVER_NAME: declared}}).to_string(),
    )
    .expect("the person's config is written");
    let base_environment: Vec<(String, String)> =
        std::iter::once(("HOME".to_owned(), scripted.home.display().to_string()))
            .chain(
                variables
                    .iter()
                    .map(|(variable, value)| ((*variable).to_owned(), (*value).to_owned())),
            )
            .collect();
    let driver = driver_on_environment(
        &DriverServices {
            base_environment: Arc::from(base_environment),
            ..scripted.services
        },
        &scripted.starts,
        &scripted.engine,
    );
    scripted.starts.script_mcp_sign_in(
        custom_scheme_channel(),
        json!({"mcpOAuth": {"docs|key": saved(SERVER_NAME, saved_address, "access-one")}}),
        ScriptedSignInPlace::File,
        Vec::new(),
    );
    let (mut request, opened, returned) = request(user_binding());
    request.server_address =
        McpServerAddress::new(requested_address).expect("a test address is a web address");
    request.project_rows = EnvironmentRow::test_rows(rows);
    let signing_in = tokio::spawn(async move { driver.sign_in_with_own_client(request).await });
    opened
        .await
        .expect("the authorization address is handed out");
    returned
        .send(Url::parse(RETURNED_URL).expect("an address"))
        .expect("the sign-in waits for the browser");

    let signed_in = signing_in
        .await
        .expect("the sign-in runs")
        .expect("the entry matches and the sign-in reads back");

    assert_eq!(signed_in.access_token, "access-one");
    let [start] = scripted
        .starts
        .take_sign_in_starts()
        .try_into()
        .ok()
        .expect("one");
    assert_eq!(
        start.servers,
        Some(json!({"mcpServers": {SERVER_NAME: declared}}))
    );
    for (name, value) in rows {
        assert_eq!(
            PathRules::NATIVE.environment_value(&start.environment, name),
            Some(*value)
        );
    }
    assert_eq!(
        start.keychain_account_record,
        Some(claude_keychain_account(&start.environment))
    );
}

// A sign-in's process that writes a frame reporting an error, or exits, before its sign-in ends
// it as the provider being unavailable, the reported text or the end as the provider's failure
// detail, its folder still removed. Killed by a sign-in that leaves the process's writes unread,
// which waits for a browser that never returns, and by either end answered as the daemon's own
// fault.
#[rstest]
#[case::an_error_reported(
    ScriptedProcessWrite::Frame(json!({
        "type": "system",
        "subtype": "api_error",
        "error": "the authorization server refused the client",
    })),
    "the authorization server refused the client"
)]
#[case::an_exit(
    ScriptedProcessWrite::Exit,
    "process ended before the sign-in finished"
)]
#[tokio::test]
async fn a_sign_in_process_that_fails_first_reads_as_the_provider_unavailable(
    #[case] write: ScriptedProcessWrite,
    #[case] detail: &str,
) {
    let scripted = ScriptedDriver::new();
    std::fs::create_dir_all(&scripted.home).expect("the person's home is made");
    std::fs::write(scripted.home.join(".claude.json"), PERSON_CONFIG)
        .expect("the person's config is written");
    scripted.starts.script_mcp_sign_in(
        custom_scheme_channel(),
        json!({}),
        ScriptedSignInPlace::File,
        vec![write],
    );
    let (request, _opened, _returned) = request(user_binding());

    let refused = scripted.driver.sign_in_with_own_client(request).await;

    let Err(DriverError::Refused(refusal)) = refused else {
        panic!("the sign-in is refused as the provider's failure, not {refused:?}");
    };
    assert_eq!(refusal.code, RefusalCode::ProviderUnavailable);
    let failure_detail = refusal
        .detail
        .as_ref()
        .and_then(|fields| fields.get("providerFailureDetail"))
        .and_then(Value::as_str)
        .expect("the refusal carries the provider's failure detail");
    assert!(
        failure_detail.contains(detail),
        "the failure detail names the end: {failure_detail}"
    );
    let left = std::fs::read_dir(sign_ins_folder(&scripted))
        .expect("the sign-ins' folder reads")
        .count();
    assert_eq!(left, 0, "the sign-in's own folder is removed");
}

// An answer to `mcp_authenticate` that does not read, or whose authorization address does not,
// ends the sign-in as the unread kind though a saved sign-in is there to read, and a browser that
// does not come back within the lifetime ends it as the lifetime kind. Killed by an answer read as
// having no address, which reads the saved sign-in back as a success, and by the kinds swapped or
// left the driver's own failure.
#[rstest]
#[case::reply_unreadable(
    ScriptedAnswer::Reply(json!({"authUrl": 5})),
    ProviderSignInFailure::ReplyUnreadable
)]
#[case::address_unreadable(
    ScriptedAnswer::Reply(json!({"authUrl": "not an address"})),
    ProviderSignInFailure::ReplyUnreadable
)]
#[case::browser_not_back_in_time(
    ScriptedAnswer::Reply(json!({
        "authUrl": "https://auth.example.test/authorize",
        "redirectScheme": "custom",
    })),
    ProviderSignInFailure::DidNotFinishInTime
)]
#[tokio::test]
async fn a_sign_in_that_ends_without_a_sign_in_reads_as_its_kind(
    #[case] answer: ScriptedAnswer,
    #[case] expected: ProviderSignInFailure,
) {
    let scripted = ScriptedDriver::new();
    std::fs::create_dir_all(&scripted.home).expect("the person's home is made");
    std::fs::write(scripted.home.join(".claude.json"), PERSON_CONFIG)
        .expect("the person's config is written");
    let channel = Arc::new(ScriptedChannel::default());
    channel.answer("mcp_authenticate", answer);
    scripted.starts.script_mcp_sign_in(
        channel,
        json!({"mcpOAuth": {"docs|key": saved(SERVER_NAME, SERVER_ADDRESS, "access-one")}}),
        ScriptedSignInPlace::File,
        Vec::new(),
    );
    let (mut request, _opened, _returned) = request(user_binding());
    request.lifetime = Duration::from_millis(200);

    let refused = scripted.driver.sign_in_with_own_client(request).await;

    assert!(
        matches!(&refused, Err(DriverError::SignInFailed(failure)) if *failure == expected),
        "the sign-in fails as {expected:?}, not {refused:?}"
    );
}

// A sign-in dropped while it waits for the browser leaves no folder, and the start's sweep removes
// a folder a stopped daemon left, with the keychain item named for it by its folder and the
// account its record names, one a row set. Killed by a folder with no drop guard, by a start that
// sweeps nothing, by a sweep that leaves the keychain item, and by one that names the account from
// an environment composed without the rows, which names the base's item.
#[tokio::test]
async fn a_dropped_sign_in_leaves_no_folder_and_the_sweep_removes_a_left_one() {
    let scripted = ScriptedDriver::new();
    std::fs::create_dir_all(&scripted.home).expect("the person's home is made");
    std::fs::write(scripted.home.join(".claude.json"), PERSON_CONFIG)
        .expect("the person's config is written");
    scripted.starts.script_mcp_sign_in(
        custom_scheme_channel(),
        json!({}),
        ScriptedSignInPlace::File,
        Vec::new(),
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
    std::fs::write(leftover.join(SIGN_IN_KEYCHAIN_ACCOUNT_FILE), "row-user")
        .expect("its record is planted");
    let leftover_environment = [
        (
            SECURE_STORAGE_FOLDER_VARIABLE.to_owned(),
            leftover.to_string_lossy().into_owned(),
        ),
        ("USER".to_owned(), "row-user".to_owned()),
    ];
    let keychain = &scripted.starts.keychain;
    let (service, account) = (
        claude_keychain_service(&leftover_environment),
        claude_keychain_account(&leftover_environment),
    );
    keychain.put_item(&service, &account, b"{}");

    scripted
        .driver
        .remove_left_sign_in_folders()
        .await
        .expect("the sweep removes the leftovers");

    assert!(!sign_ins.exists(), "the left folder is removed");
    // Only a system whose providers keep their sign-in in a keychain item has one to remove.
    assert_eq!(
        keychain.item(&service, &account).is_none(),
        keychain.sign_in_move().is_some(),
        "the left folder's keychain item is removed"
    );
}
