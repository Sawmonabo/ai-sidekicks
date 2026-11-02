use std::sync::Arc;
use std::time::Duration;

use sidekicks_platforms::{CAN_BIND_A_SOCKET_LISTENER, CAN_LINK_A_SOCKET, short_socket_folder};
use sidekicks_std::port_registration::PortRegistration;

use super::CodexAccountLegs;
use crate::driver::child_records::UnrecordedChildren;
use crate::driver::codex::rate_limits::CodexRateLimitFiling;
use crate::driver::codex::service::home::{CodexHomeKind, CodexServiceHome};
use crate::driver::codex::service::registry::{CodexServiceRegistry, OneHome};
use crate::driver::codex::service::supervisor::test_service::{
    CODEX_HOME_NAME, HANG_UP_IGNORED_NAME, StandInLaunches, TestCodexProgram, UnheardEvents,
    serve_as_codex_service_stand_in, test_codex_service_dependencies, write_codex_service_script,
};
use crate::driver::test_registry::NothingServed;
use crate::runtime_binding::test_store::test_provider_account_id;

/// The stand-in Codex service: this test program, run by the script the short-lived service
/// starts as Codex.
const APP_SERVER_STAND_IN: &str = "driver::codex::account::tests::an_app_server_stand_in";

/// How long the test lets the act run: past a start and past the grace a stop gives before its
/// kill, so a service stopped by a signal has ended and its act answered within it.
const ACT_WAIT: Duration = Duration::from_secs(8);

// Listens as Codex does, answering the daemon's start. Skips unless a test's script started it.
#[tokio::test]
#[ignore = "run only as a short-lived service's Codex"]
async fn an_app_server_stand_in() {
    serve_as_codex_service_stand_in().await;
}

// A short-lived service started for one act is ended by Codex's own drain and waited for: the
// stand-in ignores the hang-up, as a service finishing a write does, so the act keeps waiting and
// the service keeps running. Killed by a stop that signals the service to end and kills it once
// the grace runs out, which lets the act answer.
#[tokio::test(flavor = "multi_thread")]
async fn a_short_lived_service_ends_by_codexs_own_drain_and_is_waited_for() {
    if !CAN_LINK_A_SOCKET || !CAN_BIND_A_SOCKET_LISTENER {
        return;
    }
    let folder = short_socket_folder().expect("a scratch folder is made");
    let codex_home = folder.path().join("account");
    std::fs::create_dir_all(&codex_home).expect("the home is made");
    let script = write_codex_service_script(folder.path(), APP_SERVER_STAND_IN, None);
    let dependencies = test_codex_service_dependencies(
        folder.path(),
        Arc::new(TestCodexProgram {
            program: script.path().to_owned(),
            environment: vec![
                (CODEX_HOME_NAME.to_owned(), codex_home.display().to_string()),
                (HANG_UP_IGNORED_NAME.to_owned(), "1".to_owned()),
            ],
        }),
        Arc::new(UnheardEvents),
        Arc::new(UnrecordedChildren),
    );
    let registry = Arc::new(CodexServiceRegistry::new(
        Arc::new(OneHome(CodexServiceHome {
            codex_home: folder.path().join("unpinned"),
            kind: CodexHomeKind::Account(test_provider_account_id()),
        })),
        Arc::clone(&dependencies),
    ));
    let legs = CodexAccountLegs::new(
        registry,
        Arc::clone(&dependencies),
        CodexRateLimitFiling::new(Arc::new(PortRegistration::new("usage"))),
        Arc::new(PortRegistration::new("provider account registry")),
        Arc::new(NothingServed),
    );
    let startup_timeout = dependencies.startup_timeout;

    let acted = tokio::time::timeout(
        ACT_WAIT,
        legs.act_on_home_service(
            test_provider_account_id(),
            codex_home.clone(),
            async |service| service.ensure_started(startup_timeout).await.is_ok(),
        ),
    )
    .await;

    assert!(acted.is_err(), "the act waits on the service's drain");
    // Read through a guard of its own, which ends the launch it still finds running at the test's
    // end, as the script's does.
    let stand_ins = StandInLaunches::in_folder(folder.path());
    let launches = stand_ins.read().expect("the launches read");
    let launch = launches
        .iter()
        .find(|launch| launch.codex_home == codex_home)
        .expect("the short-lived service was launched");
    assert!(
        launch
            .process
            .pin()
            .expect("the process table reads")
            .is_some(),
        "the service drains on, never killed"
    );
}
