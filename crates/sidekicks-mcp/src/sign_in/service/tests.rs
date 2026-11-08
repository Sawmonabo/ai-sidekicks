use std::sync::atomic::Ordering;
use std::time::Duration;

use reqwest::Url;
use rstest::rstest;
use sidekicks_contracts::mcp::server::McpServerBindingRef;
use sidekicks_contracts::mcp::server::config::McpServerAddress;
use sidekicks_contracts::provider::account::record::ProviderAccountId;

use super::{ATTEMPT_LIFETIME, ProviderAccounts, SignInServer, SignInTarget};
use crate::errors::{McpRefusal, SignInLaunchError};
use crate::sign_in::test_service::{
    FakeServerAnswers, Harness, addressed_target, harness, launch_to_browser, provider,
    serve_authorization_server, server_name,
};

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
            .read(address)
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
            .read(&address)
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
    assert!(super::lock(&harness.service.attempts).by_address.is_empty());
    // An attempt that ran out appends nothing.
    assert_eq!(harness.completions(), Vec::<serde_json::Value>::new());

    let next_port = receiver_port(&launch_to_browser(&harness, &target).await);

    assert!(is_listening(next_port).await);
    assert_eq!(
        harness
            .admitted_clients
            .read(&address)
            .await
            .expect("the admitted client reads"),
        None
    );
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
    assert!(super::lock(&harness.service.attempts).by_address.is_empty());
}
