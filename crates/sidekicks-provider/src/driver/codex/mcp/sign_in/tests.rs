use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};

use futures::future::BoxFuture;
use futures::{SinkExt as _, StreamExt as _};
use interprocess::local_socket::tokio::Listener;
use interprocess::local_socket::traits::tokio::Listener as _;
use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::mcp::server::config::McpServerAddress;
use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerName};
use sidekicks_contracts::plugin::PluginToken;
use sidekicks_platforms::{
    CAN_BIND_A_SOCKET_LISTENER, LeftoverSweep, ProgramStart, bind_socket_listener,
    create_file_atomically, short_socket_folder,
};
use sidekicks_store::data_folder::plugin_home;
use tokio::sync::oneshot;
use tokio_tungstenite::tungstenite::Message;

use super::{
    CODEX_CREDENTIALS_FILE, OAUTH_LOGIN_COMPLETED_METHOD, OAUTH_LOGIN_METHOD,
    read_codex_saved_sign_in, read_codex_server_addresses, sign_in_with_codex_client,
};
use crate::driver::child_records::UnrecordedChildren;
use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::mcp::test_plugin::write_codex_plugin;
use crate::driver::codex::service::home::{CodexHomeKind, CodexServiceHome, CodexServiceKind};
use crate::driver::codex::service::registry::{CodexServiceRegistry, OneHome, home_socket_path};
use crate::driver::codex::service::supervisor::test_service::{
    STAND_IN_CODEX, UnheardEvents, script_codex_service, test_codex_service_dependencies,
};
use crate::driver::codex::service::supervisor::{CodexProgramResolver, CodexServiceSocket};
use crate::driver::codex::transport::connection::scripted_service::ScriptedService;
use crate::driver::contract::error::DriverError;
use crate::driver::contract::sign_in::{
    McpServerAddressRead, McpServerAddressReading, ProviderSignInReturn, ProviderSignInTakeover,
    ProviderSignInTakeoverRequest,
};
use crate::runtime_binding::test_store::test_provider_account_id;
use crate::spawned_version::ResolvedProviderExecutable;

/// The server signed in to.
const SERVER_NAME: &str = "docs";

/// Its address as the binding keeps it.
const SERVER_ADDRESS: &str = "https://docs.example.test/mcp";

/// An expiry in milliseconds since the epoch, as Codex keeps it.
const EXPIRY_MILLISECONDS: u64 = 1_767_225_600_000;

/// The access token the sign-in's own home gets.
const SIGNED_IN_ACCESS: &str = "access-of-the-sign-in";

/// The person's own saved sign-ins, planted outside the daemon's folders.
const PERSON_SIGN_INS: &str = concat!(
    r#"{"docs|person":{"server_name":"docs","server_url":"https://docs.example.test/mcp","#,
    r#""client_id":"person-client","access_token":"access-of-the-person","expires_at":1,"#,
    r#""scopes":[]}}"#,
);

fn name() -> McpServerName {
    McpServerName::new(SERVER_NAME.to_owned()).expect("a test server name is a name")
}

fn address() -> McpServerAddress {
    McpServerAddress::new(SERVER_ADDRESS).expect("a test address is a web address")
}

// One saved sign-in as Codex writes it.
fn saved(server_name: &str, server_url: &str, access_token: &str) -> Value {
    json!({
        "server_name": server_name,
        "server_url": server_url,
        "client_id": "client-one",
        "access_token": access_token,
        "expires_at": EXPIRY_MILLISECONDS,
        "refresh_token": "refresh-one",
        "scopes": ["read", "write"],
    })
}

// Killed by reading the expiry as seconds, by matching a saved sign-in on its name alone or
// its address alone, and by an address match that does not fold the host's case.
#[test]
fn a_saved_sign_in_matches_by_name_and_address_and_its_expiry_reads_in_milliseconds() {
    let file = json!({
        "a": saved(SERVER_NAME, "https://other.example.test/mcp", "access-of-another-address"),
        "b": saved("other", SERVER_ADDRESS, "access-of-another-name"),
        "c": saved(SERVER_NAME, "https://DOCS.example.test/mcp", "access-of-the-server"),
    });

    let read = read_codex_saved_sign_in(&file.to_string(), &name(), &address())
        .expect("the server's sign-in reads");

    assert_eq!(read.access_token, "access-of-the-server");
    assert_eq!(read.refresh_token.as_deref(), Some("refresh-one"));
    assert_eq!(
        read.expires_at,
        Some(UNIX_EPOCH + Duration::from_millis(EXPIRY_MILLISECONDS))
    );
    assert_eq!(read.scopes, ["read", "write"]);
    assert_eq!(read.client_id, "client-one");
}

/// How the stand-in answers a login on a throwaway service.
#[derive(Clone, Copy)]
enum StandInLogin {
    /// It saves a sign-in in the service's home and reports the login done.
    Completes,
    /// It answers the login's address, then closes its connection before the login ends.
    ClosesAfterItsAddress,
}

// The program each throwaway service resolves to, answering its logins as Codex would on its
// home: a login saves a sign-in in the home's own credentials file and reports itself done, or
// closes, as `login` says.
struct LoginAnsweringProgram {
    program: PathBuf,
    login: StandInLogin,
}

impl CodexProgramResolver for LoginAnsweringProgram {
    fn resolve<'call>(
        &'call self,
        home: &'call CodexServiceHome,
    ) -> BoxFuture<'call, Result<ResolvedProviderExecutable, DriverError>> {
        let socket = home_socket_path(&home.codex_home);
        std::fs::create_dir_all(socket.parent().expect("the socket has a folder"))
            .expect("the socket's folder is made");
        let listener = bind_socket_listener(&socket).expect("the stand-in listens");
        tokio::spawn(answer_logins(listener, home.codex_home.clone(), self.login));
        let resolved = ResolvedProviderExecutable {
            requested_command: "codex".to_owned(),
            resolved_executable_path: self.program.clone(),
            start: ProgramStart {
                program: self.program.clone(),
                leading_arguments: Vec::new(),
            },
            environment: vec![("PATH".to_owned(), "/usr/bin:/bin".to_owned())],
        };
        Box::pin(async move { Ok(resolved) })
    }
}

async fn answer_logins(listener: Listener, codex_home: PathBuf, login: StandInLogin) {
    while let Ok(stream) = listener.accept().await {
        let codex_home = codex_home.clone();
        tokio::spawn(async move {
            let Ok(mut socket) = tokio_tungstenite::accept_async(stream).await else {
                return;
            };
            while let Some(Ok(message)) = socket.next().await {
                let Message::Text(text) = message else {
                    continue;
                };
                let request: Value = serde_json::from_str(&text).expect("the daemon sends JSON");
                if request.get("id").is_none() {
                    continue;
                }
                let mut messages = Vec::new();
                let mut is_closing = false;
                let result = match request["method"].as_str() {
                    Some("initialize") => {
                        json!({"userAgent": "ai-sidekicks-daemon/0.130.0 (test)"})
                    }
                    Some(OAUTH_LOGIN_METHOD) => {
                        match login {
                            StandInLogin::Completes => {
                                let saved = json!({"docs|key": saved(
                                    request["params"]["name"].as_str().expect("a name"),
                                    SERVER_ADDRESS,
                                    SIGNED_IN_ACCESS,
                                )});
                                std::fs::write(
                                    codex_home.join(CODEX_CREDENTIALS_FILE),
                                    saved.to_string(),
                                )
                                .expect("the stand-in saves its sign-in");
                                messages.push(json!({"jsonrpc": "2.0",
                                    "method": OAUTH_LOGIN_COMPLETED_METHOD,
                                    "params": {"name": request["params"]["name"],
                                        "loginId": "login-one", "success": true}}));
                            }
                            StandInLogin::ClosesAfterItsAddress => is_closing = true,
                        }
                        json!({"authorizationUrl": "https://auth.example.test/authorize",
                            "loginId": "login-one"})
                    }
                    _ => json!({}),
                };
                let reply = json!({"id": request["id"], "result": result});
                for message in std::iter::once(reply).chain(messages) {
                    if socket
                        .send(Message::Text(message.to_string().into()))
                        .await
                        .is_err()
                    {
                        return;
                    }
                }
                if is_closing {
                    return;
                }
            }
        });
    }
}

/// A registry whose throwaway services `login` answers, beside a person's Codex folder holding
/// their own saved sign-ins, the scripted service on that folder, and where those sign-ins are.
struct CodexSignInFixture {
    folder: tempfile::TempDir,
    registry: Arc<CodexServiceRegistry>,
    script: ScriptedService,
    person_sign_ins: PathBuf,
}

fn codex_sign_in_fixture(login: StandInLogin) -> CodexSignInFixture {
    let folder = short_socket_folder().expect("a scratch folder is made");
    let program = folder.path().join("codex");
    create_file_atomically(
        &program,
        STAND_IN_CODEX.as_bytes(),
        0o755,
        LeftoverSweep::Unswept,
    )
    .expect("the stand-in is written");
    let dependencies = test_codex_service_dependencies(
        folder.path(),
        Arc::new(LoginAnsweringProgram { program, login }),
        Arc::new(UnheardEvents),
        Arc::new(UnrecordedChildren),
    );
    let person_home = CodexServiceHome {
        codex_home: folder.path().join("home"),
        kind: CodexHomeKind::PersonalFolder,
    };
    std::fs::create_dir_all(&person_home.codex_home).expect("the person's folder is made");
    let person_sign_ins = person_home.codex_home.join(CODEX_CREDENTIALS_FILE);
    std::fs::write(&person_sign_ins, PERSON_SIGN_INS).expect("the person's sign-ins are planted");
    let socket = home_socket_path(&person_home.codex_home);
    let (on_folder, script) = script_codex_service(
        person_home.clone(),
        CodexServiceSocket {
            path: socket.clone(),
            home_socket: socket,
        },
        CodexServiceKind::Terminal,
        Arc::clone(&dependencies),
    );
    let registry = CodexServiceRegistry::holding_service_on(
        &on_folder,
        Arc::clone(&dependencies),
        Arc::new(OneHome(person_home)),
    );
    CodexSignInFixture {
        folder,
        registry,
        script,
        person_sign_ins,
    }
}

/// Runs the user binding's sign-in on `fixture`'s registry, answering the config read with
/// `servers` as the person's `mcp_servers`; answers the address handed out, if one was, and how
/// the sign-in ended.
async fn sign_in_with_servers(
    fixture: &mut CodexSignInFixture,
    servers: Value,
) -> (
    Option<url::Url>,
    Result<ProviderSignInTakeover, DriverError>,
) {
    let (authorization_url, opened) = oneshot::channel();
    let request = ProviderSignInTakeoverRequest {
        provider_account_id: test_provider_account_id(),
        binding: McpServerBindingRef::User {
            provider: DESCRIPTOR.provider_id(),
            server_name: name(),
        },
        root_folder: None,
        server_address: address(),
        every_project_rows: Vec::new(),
        project_rows: Vec::new(),
        lifetime: Duration::from_secs(30),
        authorization_url,
        browser_return: ProviderSignInReturn::OwnListener,
    };
    let home_folder = person_home_folder(fixture);
    let signing_in = tokio::spawn({
        let registry = Arc::clone(&fixture.registry);
        async move { sign_in_with_codex_client(&registry, &home_folder, request).await }
    });
    answer_config_read(fixture, servers).await;
    let signed_in = signing_in.await.expect("the sign-in runs");
    (opened.await.ok(), signed_in)
}

// The person's home folder the reads take, under `fixture`'s scratch folder.
fn person_home_folder(fixture: &CodexSignInFixture) -> PathBuf {
    fixture.folder.path().join("person")
}

// Answers the next config read on the person's folder with `servers` as their `mcp_servers`.
async fn answer_config_read(fixture: &mut CodexSignInFixture, servers: Value) {
    let config_read = fixture.script.next_sent().await;
    assert_eq!(config_read["method"], "config/read", "{config_read}");
    fixture.script.answer(
        &config_read,
        &json!({"config": {"mcp_servers": servers}, "origins": {}}),
    );
}

/// The entry a whole-address read finds, and where.
enum DeclaredEntry {
    /// The person's own config declares it as these servers.
    Person(Value),
    /// A plugin installed in the daemon's plugin home declares it as these servers.
    Plugin(Value),
}

// Reads the address of the server the entry declares on `fixture`'s registry, a user binding for
// the person's entry and a plugin's binding for the plugin's.
async fn read_declared_address(
    fixture: &mut CodexSignInFixture,
    declared: DeclaredEntry,
) -> Result<McpServerAddressReading, DriverError> {
    let home_folder = person_home_folder(fixture);
    let (binding, servers) = match declared {
        DeclaredEntry::Person(servers) => (
            McpServerBindingRef::User {
                provider: DESCRIPTOR.provider_id(),
                server_name: name(),
            },
            Some(servers),
        ),
        DeclaredEntry::Plugin(servers) => {
            write_codex_plugin(
                &plugin_home(&home_folder, &DESCRIPTOR.provider_id()),
                "market",
                "tools",
                &servers,
            );
            let binding = McpServerBindingRef::Plugin {
                provider: DESCRIPTOR.provider_id(),
                scope_ref: PluginToken::new("tools".to_owned()).expect("a plugin name"),
                server_name: name(),
            };
            (binding, None)
        }
    };
    let request = McpServerAddressRead {
        binding,
        provider_account_id: Some(test_provider_account_id()),
        root_folder: None,
        every_project_rows: Vec::new(),
        project_rows: Vec::new(),
    };
    let reading = tokio::spawn({
        let registry = Arc::clone(&fixture.registry);
        async move {
            read_codex_server_addresses(&registry, &home_folder, vec![request])
                .await
                .pop()
                .expect("one reading answers one request")
        }
    });
    if let Some(servers) = servers {
        answer_config_read(fixture, servers).await;
    }
    reading.await.expect("the read runs")
}

// A person's entry is read whole, its user name and query kept; a plugin's entry answers the
// `url` its file declares; and a program's entry declares no address to sign in at. Killed by
// answering the stripped address (the user name or query lost), and by a read that filters the
// entry against any address before answering it.
#[rstest]
#[case::the_persons_entry_whole(
    DeclaredEntry::Person(json!({SERVER_NAME: {
        "url": "https://user@docs.example.test/mcp?key=k", "enabled": true,
    }})),
    Some("https://user@docs.example.test/mcp?key=k")
)]
#[case::a_plugins_entry(
    DeclaredEntry::Plugin(json!({SERVER_NAME: {"url": "https://plugin.example.test/mcp?team=t"}})),
    Some("https://plugin.example.test/mcp?team=t")
)]
#[case::a_program_entry(
    DeclaredEntry::Person(json!({SERVER_NAME: {"command": "docs-server", "enabled": true}})),
    None
)]
#[tokio::test(flavor = "multi_thread")]
async fn a_codex_entry_is_read_whole(
    #[case] declared: DeclaredEntry,
    #[case] expected: Option<&str>,
) {
    if !CAN_BIND_A_SOCKET_LISTENER {
        return;
    }
    let mut fixture = codex_sign_in_fixture(StandInLogin::Completes);

    let reading = read_declared_address(&mut fixture, declared).await;

    match (&reading, expected) {
        (Ok(McpServerAddressReading::Declared(address)), Some(expected)) => {
            assert_eq!(address.as_str(), expected);
        }
        (Err(DriverError::NoPersonServerEntry(_)), None) => {}
        (reading, expected) => panic!("expected {expected:?}, read {reading:?}"),
    }
}

// A connector's sign-in is the account's own, so it has no entry of the person's to read an
// address from, and no config is read for it. Killed by reading an entry for a connector.
#[tokio::test(flavor = "multi_thread")]
async fn a_connector_has_no_address_of_the_persons() {
    if !CAN_BIND_A_SOCKET_LISTENER {
        return;
    }
    let fixture = codex_sign_in_fixture(StandInLogin::Completes);
    let connector = McpServerBindingRef::Connector {
        provider: DESCRIPTOR.provider_id(),
        scope_ref: test_provider_account_id(),
        server_name: name(),
    };
    let request = McpServerAddressRead {
        binding: connector.clone(),
        provider_account_id: Some(test_provider_account_id()),
        root_folder: None,
        every_project_rows: Vec::new(),
        project_rows: Vec::new(),
    };

    let refused = read_codex_server_addresses(
        &fixture.registry,
        &person_home_folder(&fixture),
        vec![request],
    )
    .await
    .pop()
    .expect("one reading answers one request");

    assert!(
        matches!(
            &refused,
            Err(DriverError::NoPersonServerEntry(no_entry)) if no_entry.binding == connector
        ),
        "a connector reads the no-entry arm, not {refused:?}"
    );
}

// Killed by running the login on the person's own Codex folder, or on any folder but one the
// daemon makes for the sign-in, and by leaving that folder behind.
#[tokio::test(flavor = "multi_thread")]
async fn a_codex_takeover_leaves_the_persons_saved_sign_ins_as_they_were() {
    if !CAN_BIND_A_SOCKET_LISTENER {
        return;
    }
    let mut fixture = codex_sign_in_fixture(StandInLogin::Completes);

    let (opened, signed_in) = sign_in_with_servers(
        &mut fixture,
        json!({SERVER_NAME: {"url": SERVER_ADDRESS, "enabled": true}}),
    )
    .await;
    let signed_in = signed_in.expect("the sign-in reads back");

    assert_eq!(
        opened
            .expect("the authorization address is handed out")
            .as_str(),
        "https://auth.example.test/authorize"
    );
    assert_eq!(signed_in.access_token, SIGNED_IN_ACCESS);
    assert_eq!(
        std::fs::read_to_string(&fixture.person_sign_ins).expect("the person's sign-ins read"),
        PERSON_SIGN_INS
    );
    let left = std::fs::read_dir(fixture.registry.mcp_sign_in_folder())
        .expect("the sign-ins' folder reads")
        .count();
    assert_eq!(left, 0, "the sign-in's own folder is removed");
}

// A binding whose server the person's config no longer declares, or declares at another
// address, reads the no-entry arm before any service starts, so the launch asks the next
// provider. Killed by a missing entry answered as the driver's own failure, and by an entry
// matched by its name alone, which starts a login to the other address.
#[rstest]
#[case::no_entry(json!({}))]
#[case::another_address(
    json!({SERVER_NAME: {"url": "https://other.example.test/mcp", "enabled": true}})
)]
#[tokio::test(flavor = "multi_thread")]
async fn a_binding_with_no_entry_at_its_address_reads_the_no_entry_arm(#[case] servers: Value) {
    if !CAN_BIND_A_SOCKET_LISTENER {
        return;
    }
    let mut fixture = codex_sign_in_fixture(StandInLogin::Completes);

    let (opened, refused) = sign_in_with_servers(&mut fixture, servers).await;

    assert!(
        matches!(&refused, Err(DriverError::NoPersonServerEntry(_))),
        "a binding with no entry at its address reads the no-entry arm, not {refused:?}"
    );
    assert_eq!(opened, None, "no login started");
}

// A throwaway service that closes before the login it started ends answers the provider as
// unavailable, how it closed as the provider's failure detail, its folder still removed.
// Killed by the close answered as the daemon's own fault.
#[tokio::test(flavor = "multi_thread")]
async fn a_service_that_closes_before_the_login_ends_reads_as_the_provider_unavailable() {
    if !CAN_BIND_A_SOCKET_LISTENER {
        return;
    }
    let mut fixture = codex_sign_in_fixture(StandInLogin::ClosesAfterItsAddress);

    let (_opened, refused) = sign_in_with_servers(
        &mut fixture,
        json!({SERVER_NAME: {"url": SERVER_ADDRESS, "enabled": true}}),
    )
    .await;

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
        failure_detail.contains("the Codex service running the MCP sign-in closed"),
        "the failure detail names the close: {failure_detail}"
    );
    let left = std::fs::read_dir(fixture.registry.mcp_sign_in_folder())
        .expect("the sign-ins' folder reads")
        .count();
    assert_eq!(left, 0, "the sign-in's own folder is removed");
}
