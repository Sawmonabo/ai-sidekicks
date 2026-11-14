use std::sync::atomic::Ordering;
use std::time::Duration;

use reqwest::Url;
use rstest::rstest;
use sidekicks_contracts::mcp::server::McpServerBindingRef;
use sidekicks_contracts::mcp::server::config::McpServerAddress;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_provider::captured_logs::CapturedLogs;
use sidekicks_provider::driver::contract::sign_in::McpSignInCallback;
use sidekicks_std::mutex_lock::lock;

use super::{
    ATTEMPT_LIFETIME, AddressedServer, OwnerIssuedClient, ProviderAccounts, SignInServer,
    SignInTarget, named_metadata_scopes,
};
use crate::errors::{McpRefusal, SignInLaunchError, SignInUnsupportedReason};
use crate::sign_in::test_service::{
    FakeServerAnswers, Harness, NAMED_METADATA_PATH, addressed_target, harness, launch_to_browser,
    provider, serve_authorization_server, server_name,
};

/// The client id a test entry's owner issued.
const OWNER_CLIENT_ID: &str = "owner-client";

// The values of the browser address's parameter `name`, in order.
fn parameters(browser_url: &Url, name: &str) -> Vec<String> {
    browser_url
        .query_pairs()
        .filter(|(parameter, _value)| parameter == name)
        .map(|(_parameter, value)| value.into_owned())
        .collect()
}

// A user binding of the server at `base` whose entry gives `owner_client` and `oauth_resource`.
fn entry_target(
    base: &str,
    owner_client: Option<OwnerIssuedClient>,
    oauth_resource: Option<&str>,
) -> SignInTarget {
    SignInTarget {
        server: SignInServer::Address(Box::new(AddressedServer::new(
            McpServerAddress::new(base).expect("a server address"),
            owner_client,
            oauth_resource.map(str::to_owned),
            None,
            false,
        ))),
        ..addressed_target(base)
    }
}

// A loopback port free when asked, which an owner's callback names.
async fn free_port() -> u16 {
    tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("a local port")
        .local_addr()
        .expect("the port's address")
        .port()
}

// The loopback port the receiver of the attempt behind `browser_url` listens on.
fn receiver_port(browser_url: &Url) -> u16 {
    let redirect_uri = browser_url
        .query_pairs()
        .find_map(|(name, value)| (name == "redirect_uri").then(|| value.into_owned()))
        .expect("the address names its redirect");
    Url::parse(&redirect_uri)
        .expect("the redirect is a URL")
        .port()
        .expect("the redirect carries its port")
}

async fn is_listening(port: u16) -> bool {
    tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .is_ok()
}

// The waiting attempt's mark, once the database writer kept it, bounded on the real clock.
async fn is_marked_unfinished(harness: &Harness, address: &McpServerAddress) -> bool {
    for _ in 0..500 {
        let is_marked = harness
            .admitted_clients
            .read(&harness.service.custody.test_digest(address).await)
            .await
            .expect("the admitted client reads")
            .is_some_and(|admitted| admitted.is_own_client_unfinished);
        if is_marked {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    false
}

// Runs the waiting attempt's life out, so its timer ends it.
async fn run_out_the_attempt() {
    tokio::time::pause();
    // The attempt's timer arms its sleep on its task's first poll, which must come first.
    tokio::task::yield_now().await;
    tokio::time::advance(ATTEMPT_LIFETIME + Duration::from_secs(1)).await;
    // The mark is written on the database writer's own thread, so what follows runs on the
    // real clock.
    tokio::time::resume();
}

/// A second press while an attempt waits is the person trying the daemon's own client again:
/// the first attempt's listener closes, nothing is marked or appended, and the second press
/// opens the own client's browser again. Killed by marking the replaced attempt unfinished
/// (a row is written), and by keeping the first listener open.
#[tokio::test]
async fn a_second_launch_for_a_server_closes_the_first_attempt_and_marks_nothing() {
    let server = serve_authorization_server(FakeServerAnswers::default()).await;
    let harness = harness().await;
    let target = addressed_target(&server.base);
    let first_port = receiver_port(&launch_to_browser(&harness, &target).await);
    assert!(is_listening(first_port).await);

    let second_port = receiver_port(&launch_to_browser(&harness, &target).await);

    assert!(!is_listening(first_port).await);
    assert!(is_listening(second_port).await);
    let address = McpServerAddress::new(&server.base).expect("a server address");
    assert_eq!(
        harness
            .admitted_clients
            .read(&harness.service.custody.test_digest(&address).await)
            .await
            .expect("the admitted client reads"),
        None
    );
    // A replaced attempt appends nothing.
    assert_eq!(harness.completions(), Vec::<serde_json::Value>::new());
}

/// An attempt that runs out marks the own client unfinished, closes its listener and appends
/// nothing; at a server no provider's flow admits, the next press still reaches the daemon's
/// own client, the mark cleared with the row that held only it. Killed by an expiry that marks
/// nothing, and by a mark with no exit (the press after it is refused as unsupported).
#[tokio::test]
async fn a_press_after_an_attempt_ran_out_reaches_the_own_client_where_no_provider_admits() {
    let server = serve_authorization_server(FakeServerAnswers::default()).await;
    let harness = harness().await;
    let target = addressed_target(&server.base);
    let port = receiver_port(&launch_to_browser(&harness, &target).await);
    let address = McpServerAddress::new(&server.base).expect("a server address");

    run_out_the_attempt().await;

    assert!(is_marked_unfinished(&harness, &address).await);
    assert!(!is_listening(port).await);
    assert!(super::lock(&harness.service.attempts).by_server.is_empty());
    // An attempt that ran out appends nothing.
    assert_eq!(harness.completions(), Vec::<serde_json::Value>::new());

    let next_port = receiver_port(&launch_to_browser(&harness, &target).await);

    assert!(is_listening(next_port).await);
    assert_eq!(
        harness
            .admitted_clients
            .read(&harness.service.custody.test_digest(&address).await)
            .await
            .expect("the admitted client reads"),
        None
    );
}

/// The daemon's stop ends a waiting attempt: its port is free to bind again, the daemon's own
/// client is marked unfinished, nothing is appended, and a launch after it keeps no attempt.
/// Killed by a close that leaves the listener open (the bind fails), by a completion appended at
/// the close, and by a launch after the close that keeps its attempt.
#[tokio::test]
async fn a_closed_service_frees_its_attempts_port_and_opens_no_attempt_after() {
    let server = serve_authorization_server(FakeServerAnswers::default()).await;
    let harness = harness().await;
    let target = addressed_target(&server.base);
    let port = receiver_port(&launch_to_browser(&harness, &target).await);

    harness.service.close().await;

    drop(
        tokio::net::TcpListener::bind(("127.0.0.1", port))
            .await
            .expect("the attempt's port is free again"),
    );
    let address = McpServerAddress::new(&server.base).expect("a server address");
    assert!(is_marked_unfinished(&harness, &address).await);
    assert_eq!(harness.completions(), Vec::<serde_json::Value>::new());
    let refusal = harness
        .service
        .launch(&target, &[], &ProviderAccounts::new())
        .await;
    assert!(matches!(
        refusal,
        Err(SignInLaunchError::Refused(
            McpRefusal::ServerSignInFailed { .. }
        ))
    ));
    assert!(super::lock(&harness.service.attempts).by_server.is_empty());
}

#[rstest]
#[case::a_program_the_provider_starts(false)]
#[case::a_connector(true)]
#[tokio::test]
async fn a_binding_no_sign_in_reaches_is_refused_before_anything_is_sent(
    #[case] is_connector: bool,
) {
    let server = serve_authorization_server(FakeServerAnswers::default()).await;
    let harness = harness().await;
    let target = if is_connector {
        SignInTarget {
            binding: McpServerBindingRef::Connector {
                provider: provider(),
                scope_ref: ProviderAccountId::new("account-1".to_owned()).expect("an account id"),
                server_name: server_name(),
            },
            ..addressed_target(&server.base)
        }
    } else {
        SignInTarget {
            server: SignInServer::Stdio,
            ..addressed_target(&server.base)
        }
    };

    let refusal = harness
        .service
        .launch(&target, &[], &ProviderAccounts::new())
        .await;

    assert!(matches!(
        refusal,
        Err(SignInLaunchError::Refused(
            McpRefusal::ServerSignInUnsupported { .. }
        ))
    ));
    assert_eq!(server.requests.load(Ordering::SeqCst), 0);
    assert!(super::lock(&harness.service.attempts).by_server.is_empty());
}

/// An entry naming only its owner's client id signs in as that client with no registration: the
/// browser returns to the daemon's own loopback receiver on the server's own path, or, where the
/// provider's own client sends a callback of its own, to that callback whole, in its form for
/// whether the server returns `iss`. Killed by registering anyway (the fake refuses every
/// registration, which refuses the launch), by the shared path taken for a client id alone, by
/// the provider's callback given the server's id or not listened on, and by the form picked
/// against `iss`.
#[rstest]
#[case::own_address(false, false)]
#[case::provider_callback_without_issuer(true, false)]
#[case::provider_callback_with_issuer(true, true)]
#[tokio::test]
async fn a_client_id_alone_signs_in_as_that_client_with_no_registration(
    #[case] has_provider_callback: bool,
    #[case] is_issuer_in_response: bool,
) {
    let server = serve_authorization_server(FakeServerAnswers {
        is_registration_refused: true,
        is_issuer_in_response,
        ..FakeServerAnswers::default()
    })
    .await;
    let harness = harness().await;
    let callback = if has_provider_callback {
        let port = free_port().await;
        let form = |path: &str| {
            Url::parse(&format!("http://127.0.0.1:{port}{path}")).expect("a callback address")
        };
        Some(McpSignInCallback {
            with_issuer: form("/callback"),
            without_issuer: form("/callback/provider-id"),
        })
    } else {
        None
    };
    let target = entry_target(
        &server.base,
        Some(OwnerIssuedClient {
            client_id: Some(OWNER_CLIENT_ID.to_owned()),
            client_secret: None,
            callback: callback.clone(),
        }),
        None,
    );

    let browser_url = launch_to_browser(&harness, &target).await;

    assert_eq!(parameters(&browser_url, "client_id"), [OWNER_CLIENT_ID]);
    let redirect_uri =
        Url::parse(&parameters(&browser_url, "redirect_uri")[0]).expect("the redirect is a URL");
    if let Some(callback) = callback {
        let sent = if is_issuer_in_response {
            callback.with_issuer
        } else {
            callback.without_issuer
        };
        assert_eq!(redirect_uri, sent);
    } else {
        let segments: Vec<&str> = redirect_uri
            .path_segments()
            .expect("the redirect has a path")
            .collect();
        assert_eq!(segments[0], "callback");
        assert_eq!(segments.len(), 2, "the server's own path carries its id");
    }
    assert!(is_listening(receiver_port(&browser_url)).await);
}

/// An entry naming only its owner's callback is listened for at that callback's port and path,
/// and the daemon's own client is registered with it. Killed by the service's own loopback
/// address used in its place, and by the registration skipped.
#[tokio::test]
async fn a_callback_alone_is_listened_on_and_registered() {
    let server = serve_authorization_server(FakeServerAnswers::default()).await;
    let harness = harness().await;
    let port = free_port().await;
    let callback_url =
        Url::parse(&format!("http://127.0.0.1:{port}/owner/return")).expect("a callback address");
    let target = entry_target(
        &server.base,
        Some(OwnerIssuedClient {
            client_id: None,
            client_secret: None,
            callback: Some(McpSignInCallback {
                with_issuer: callback_url.clone(),
                without_issuer: callback_url.clone(),
            }),
        }),
        None,
    );

    let browser_url = launch_to_browser(&harness, &target).await;

    assert_eq!(
        parameters(&browser_url, "redirect_uri"),
        [callback_url.as_str()]
    );
    assert_eq!(parameters(&browser_url, "client_id"), ["registered-client"]);
    assert!(is_listening(port).await);
}

/// The resource the entry names reaches the authorization request beside the one rmcp names, and
/// an entry naming rmcp's own sends it once. Killed by the entry's resource dropped, and by the
/// same value appended twice.
#[tokio::test]
async fn the_resource_an_entry_names_reaches_the_authorization_request_once() {
    let server = serve_authorization_server(FakeServerAnswers::default()).await;
    let harness = harness().await;
    let rmcp_resources = parameters(
        &launch_to_browser(&harness, &addressed_target(&server.base)).await,
        "resource",
    );
    let [rmcp_resource] = rmcp_resources.as_slice() else {
        panic!("rmcp names one resource, not {rmcp_resources:?}");
    };
    let entry_resource = "https://api.example.test/";

    let beside = launch_to_browser(
        &harness,
        &entry_target(&server.base, None, Some(entry_resource)),
    )
    .await;
    let same = launch_to_browser(
        &harness,
        &entry_target(&server.base, None, Some(rmcp_resource)),
    )
    .await;

    assert_eq!(
        parameters(&beside, "resource"),
        [rmcp_resource.as_str(), entry_resource]
    );
    assert_eq!(parameters(&same, "resource"), [rmcp_resource.as_str()]);
}

/// A server whose metadata names an authorization page that is no web address is refused as
/// unsupported, and the receiver bound for the launch is closed at once, with no attempt kept.
/// Killed by the attempt kept, its receiver listening until its life runs out.
#[tokio::test]
async fn a_page_that_is_no_web_address_keeps_no_attempt() {
    let server = serve_authorization_server(FakeServerAnswers {
        authorization_endpoint: Some("ftp://files.example.test/authorize"),
        ..FakeServerAnswers::default()
    })
    .await;
    let harness = harness().await;
    let port = free_port().await;
    let callback_url =
        Url::parse(&format!("http://127.0.0.1:{port}/owner/return")).expect("a callback address");
    let target = entry_target(
        &server.base,
        Some(OwnerIssuedClient {
            client_id: None,
            client_secret: None,
            callback: Some(McpSignInCallback {
                with_issuer: callback_url.clone(),
                without_issuer: callback_url,
            }),
        }),
        None,
    );

    let refusal = harness
        .service
        .launch(&target, &[], &ProviderAccounts::new())
        .await;

    assert!(matches!(
        refusal,
        Err(SignInLaunchError::Refused(
            McpRefusal::ServerSignInUnsupported {
                reason: SignInUnsupportedReason::UnusableMetadata,
                ..
            }
        ))
    ));
    assert!(!is_listening(port).await);
    assert!(super::lock(&harness.service.attempts).by_server.is_empty());
}

// An entry naming its authorization server's metadata address signs in from the metadata read
// there, discovery refused, asking for its pinned scopes or, with none pinned, for the scopes the
// metadata lists. Killed by discovery kept (a well-known path is asked and the launch fails), by
// the configured read dropped, and by the scopes fallback dropped (`no_scopes` sends no scope).
#[rstest]
#[case::pinned_scopes(&["read"], "read")]
#[case::no_scopes(&[], "read write")]
#[tokio::test]
async fn an_entry_naming_its_metadata_address_signs_in_without_discovery(
    #[case] pinned_scopes: &[&str],
    #[case] expected_scope: &str,
) {
    let server = serve_authorization_server(FakeServerAnswers {
        is_discovery_refused: true,
        ..FakeServerAnswers::default()
    })
    .await;
    let harness = harness().await;
    let metadata_address =
        Url::parse(&format!("{}{NAMED_METADATA_PATH}", server.base)).expect("a URL");
    let target = SignInTarget {
        server: SignInServer::Address(Box::new(AddressedServer::new(
            McpServerAddress::new(&server.base).expect("a server address"),
            None,
            None,
            Some(metadata_address),
            true,
        ))),
        ..addressed_target(&server.base)
    };
    let scopes: Vec<String> = pinned_scopes
        .iter()
        .map(|scope| (*scope).to_owned())
        .collect();

    let browser_url = match harness
        .service
        .launch(&target, &scopes, &ProviderAccounts::new())
        .await
    {
        Ok(browser_url) => Url::parse(browser_url.as_str()).expect("a web address parses"),
        Err(refusal) => panic!("the launch was refused: {refusal}"),
    };

    assert_eq!(browser_url.path(), "/authorize");
    assert_eq!(
        browser_url.origin(),
        Url::parse(&server.base).expect("a URL").origin()
    );
    let paths = lock(&server.paths).clone();
    assert!(
        !paths.iter().any(|path| path.starts_with("/.well-known/")),
        "{paths:?}"
    );
    assert_eq!(parameters(&browser_url, "scope"), [expected_scope]);
}

// A named metadata address that does not read is logged by its origin alone, its query never,
// and the sign-in discovers the metadata. Killed by the network error logged with its address
// (`unreachable`) and by the refused address printed whole (`refused`).
#[rstest]
#[case::unreachable("http://127.0.0.1:9/metadata?key=metadata-secret")]
#[case::refused("http://169.254.169.254/metadata?key=metadata-secret")]
#[tokio::test]
async fn a_named_metadata_address_that_does_not_read_logs_no_query(#[case] named: &str) {
    let server = serve_authorization_server(FakeServerAnswers::default()).await;
    let harness = harness().await;
    let target = SignInTarget {
        server: SignInServer::Address(Box::new(AddressedServer::new(
            McpServerAddress::new(&server.base).expect("a server address"),
            None,
            None,
            Some(Url::parse(named).expect("a URL")),
            true,
        ))),
        ..addressed_target(&server.base)
    };
    let (logs, _capture) = CapturedLogs::start();

    let launched = harness
        .service
        .launch(&target, &[], &ProviderAccounts::new())
        .await;

    assert!(launched.is_ok(), "the sign-in discovers the metadata");
    let text = logs.text();
    assert!(text.contains("the sign-in discovers it"), "{text}");
    assert!(
        !text.contains("metadata-secret") && !text.contains("/metadata?"),
        "{text}"
    );
}

// A named metadata document's own `scope` comes first, then `default_scope`, then the scopes it
// lists. Killed by the first two swapped (`both_strings` reads `default`) and by either string
// skipped.
#[rstest]
#[case::both_strings(Some("own extra"), Some("default"), &["own", "extra"])]
#[case::default_alone(None, Some("default"), &["default"])]
#[case::neither(None, None, &["listed"])]
fn a_named_metadata_documents_own_scope_comes_before_its_default_and_its_list(
    #[case] scope: Option<&str>,
    #[case] default_scope: Option<&str>,
    #[case] expected: &[&str],
) {
    let mut document = serde_json::json!({
        "authorization_endpoint": "https://auth.example.test/authorize",
        "token_endpoint": "https://auth.example.test/token",
        "scopes_supported": ["listed"],
    });
    if let Some(scope) = scope {
        document["scope"] = scope.into();
    }
    if let Some(default_scope) = default_scope {
        document["default_scope"] = default_scope.into();
    }
    let metadata = serde_json::from_value(document).expect("metadata parses");

    assert_eq!(named_metadata_scopes(&metadata), expected);
}
