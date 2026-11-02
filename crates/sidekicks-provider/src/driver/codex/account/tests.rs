use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use sidekicks_platforms::{CAN_BIND_A_SOCKET_LISTENER, CAN_LINK_A_SOCKET, short_socket_folder};
use sidekicks_std::port_registration::PortRegistration;

use super::{CODEX_FILE_CREDENTIAL_STORE, CodexAccountLegs};
use crate::driver::child_records::UnrecordedChildren;
use crate::driver::codex::rate_limits::CodexRateLimitFiling;
use crate::driver::codex::service::home::{CodexHomeKind, CodexServiceHome};
use crate::driver::codex::service::registry::{CodexServiceRegistry, OneHome};
use crate::driver::codex::service::supervisor::test_service::{
    CODEX_HOME_NAME, CodexServiceScript, HANG_UP_IGNORED_NAME, LAUNCH_ARGUMENTS_FILE,
    StandInLaunches, TestCodexProgram, UnheardEvents, serve_as_codex_service_stand_in,
    test_codex_service_dependencies, write_codex_service_script,
};
use crate::driver::test_registry::NothingServed;
use crate::runtime_binding::test_store::test_provider_account_id;

/// The stand-in Codex service: this test program, run by the script the short-lived service
/// starts as Codex.
const APP_SERVER_STAND_IN: &str = "driver::codex::account::tests::an_app_server_stand_in";

/// How long the test lets the act run: past a start and past the grace a short-lived service's
/// drain gives before its kill, so a service killed at that bound has ended and its act answered
/// within it.
const ACT_WAIT: Duration = Duration::from_secs(8);

// Listens as Codex does, answering the daemon's start. Skips unless a test's script started it.
#[tokio::test]
#[ignore = "run only as a short-lived service's Codex"]
async fn an_app_server_stand_in() {
    serve_as_codex_service_stand_in().await;
}

// Legs whose short-lived services run this test program as Codex through a script in `folder`,
// on `codex_home` with `environment` added; answered with the script, whose drop ends what it
// launched.
fn stand_in_legs(
    folder: &Path,
    codex_home: &Path,
    environment: &[(&str, &str)],
) -> (Arc<CodexAccountLegs>, CodexServiceScript) {
    let script = write_codex_service_script(folder, APP_SERVER_STAND_IN, None);
    let dependencies = test_codex_service_dependencies(
        folder,
        Arc::new(TestCodexProgram {
            program: script.path().to_owned(),
            environment: std::iter::once((
                CODEX_HOME_NAME.to_owned(),
                codex_home.display().to_string(),
            ))
            .chain(
                environment
                    .iter()
                    .map(|(name, value)| ((*name).to_owned(), (*value).to_owned())),
            )
            .collect(),
        }),
        Arc::new(UnheardEvents),
        Arc::new(UnrecordedChildren),
    );
    let registry = Arc::new(CodexServiceRegistry::new(
        Arc::new(OneHome(CodexServiceHome {
            codex_home: folder.join("unpinned"),
            kind: CodexHomeKind::Account(test_provider_account_id()),
        })),
        Arc::clone(&dependencies),
    ));
    let legs = CodexAccountLegs::new(
        registry,
        dependencies,
        CodexRateLimitFiling::new(Arc::new(PortRegistration::new("usage"))),
        Arc::new(PortRegistration::new("provider account registry")),
        Arc::new(NothingServed),
        Arc::new(PortRegistration::new("account home lock")),
    );
    (legs, script)
}

// Fails when a short-lived service on an account home starts without the file store, where Codex
// may save the sign-in it takes outside the home's `auth.json`, or names the store twice, once
// from the services' shared switches and once from its home's.
#[tokio::test(flavor = "multi_thread")]
async fn a_short_lived_service_keeps_its_sign_in_in_the_home_s_file() {
    if !CAN_LINK_A_SOCKET || !CAN_BIND_A_SOCKET_LISTENER {
        return;
    }
    let folder = short_socket_folder().expect("a scratch folder is made");
    let codex_home = folder.path().join("account");
    std::fs::create_dir_all(&codex_home).expect("the home is made");
    let (legs, _script) = stand_in_legs(folder.path(), &codex_home, &[]);
    let startup_timeout = legs.dependencies.startup_timeout;

    let started = legs
        .act_on_home_service(test_provider_account_id(), codex_home, async |service| {
            service.ensure_started(startup_timeout).await.is_ok()
        })
        .await;

    assert!(started, "the short-lived service did not start");
    let arguments = std::fs::read_to_string(folder.path().join(LAUNCH_ARGUMENTS_FILE))
        .expect("the launch's arguments were kept");
    let file_stores = arguments
        .lines()
        .filter(|argument| *argument == CODEX_FILE_CREDENTIAL_STORE)
        .count();
    assert_eq!(file_stores, 1, "{arguments}");
}

// A short-lived service whose drain never ends, here a stand-in that ignores Codex's hang-up, is
// killed once the grace a stop gives passes, so the act answers and lets the account's home go.
// Killed by a drain waited on with no bound, which holds the act, and so the home, until the
// service exits by itself.
#[tokio::test(flavor = "multi_thread")]
async fn a_short_lived_service_that_never_drains_is_killed_at_the_grace() {
    if !CAN_LINK_A_SOCKET || !CAN_BIND_A_SOCKET_LISTENER {
        return;
    }
    let folder = short_socket_folder().expect("a scratch folder is made");
    let codex_home = folder.path().join("account");
    std::fs::create_dir_all(&codex_home).expect("the home is made");
    let (legs, _script) = stand_in_legs(folder.path(), &codex_home, &[(HANG_UP_IGNORED_NAME, "1")]);
    let startup_timeout = legs.dependencies.startup_timeout;

    let acted = tokio::time::timeout(
        ACT_WAIT,
        legs.act_on_home_service(
            test_provider_account_id(),
            codex_home.clone(),
            async |service| service.ensure_started(startup_timeout).await.is_ok(),
        ),
    )
    .await;

    assert_eq!(acted, Ok(true), "the act waited past the drain's bound");
    // Read through a guard of its own, which ends the launch it still finds running at the test's
    // end, as the script's does.
    let stand_ins = StandInLaunches::in_folder(folder.path());
    let launches = stand_ins.read().expect("the launches read");
    let launch = launches
        .iter()
        .find(|launch| launch.codex_home == codex_home)
        .expect("the short-lived service was launched");
    // The killed service leaves the process table once its exit is reaped.
    let gone = tokio::time::timeout(Duration::from_secs(5), async {
        while launch
            .process
            .pin()
            .expect("the process table reads")
            .is_some()
        {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    assert!(gone.is_ok(), "the service outlived its drain's bound");
}
