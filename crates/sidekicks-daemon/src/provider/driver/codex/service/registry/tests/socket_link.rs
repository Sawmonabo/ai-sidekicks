use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use futures::future::BoxFuture;
use interprocess::local_socket::traits::tokio::Listener as _;
use sidekicks_contracts::run::control::ProcessExit;
use sidekicks_platforms::{
    ExistingSocket, RunningProgramPath, bind_socket_listener, read_running_program_path,
    read_socket_link, replace_file_atomically, replace_socket_link,
};
use tokio::sync::mpsc;

use super::{OneHome, can_move_socket_links};
use crate::provider::driver::codex::service::command_line::compose_daemon_hook_commands;
use crate::provider::driver::codex::service::home::{CodexHomeKind, CodexServiceHome};
use crate::provider::driver::codex::service::registry::{CodexServiceRegistry, home_socket_path};
use crate::provider::driver::codex::service::supervisor::events::{
    CodexServiceEvents, CodexServiceRecoveryCause,
};
use crate::provider::driver::codex::service::supervisor::test_service::{
    TestCodexProgram, answer_as_codex_service, test_codex_service_dependencies,
};
use crate::provider::driver::codex::service::supervisor::{
    CodexProgramResolver, CodexService, CodexServiceDependencies,
};
use crate::provider::driver::contract::{DaemonStopIntent, DriverError};
use crate::provider::spawned_version::ResolvedProviderExecutable;

/// The stand-in Codex service: this test program, run by the script the registry's services
/// start as Codex.
const APP_SERVER_STAND_IN: &str =
    "provider::driver::codex::service::registry::tests::socket_link::an_app_server_stand_in";

/// The address the stand-in listens on, as its `--listen` names it; only its script sets it.
const LISTEN_ADDRESS_NAME: &str = "SIDEKICKS_TEST_LISTEN_ADDRESS";

/// The Codex home the stand-in serves, as Codex reads it.
const CODEX_HOME_NAME: &str = "CODEX_HOME";

/// How long the test waits on a crash or a recovery to be heard.
const CRASH_WAIT: Duration = Duration::from_secs(10);

// Listens as Codex does: on a real socket of its own, with the path it was given made a link to
// it, answering the daemon's start. Skips unless the planned-restart test's script started it.
#[tokio::test]
#[ignore = "run only as the planned-restart test's Codex service"]
async fn an_app_server_stand_in() {
    let Ok(address) = std::env::var(LISTEN_ADDRESS_NAME) else {
        return;
    };
    let codex_home = PathBuf::from(std::env::var(CODEX_HOME_NAME).expect("the home is named"));
    let link = match address.strip_prefix("unix://").expect("a socket address") {
        "" => home_socket_path(&codex_home),
        path => PathBuf::from(path),
    };
    std::fs::create_dir_all(link.parent().expect("the link has a folder"))
        .expect("the link's folder is made");
    let real_socket = codex_home.join(format!("real-{}.sock", std::process::id()));
    let listener = bind_socket_listener(&real_socket, ExistingSocket::Refuse)
        .expect("the real socket listens");
    replace_socket_link(&link, &real_socket).expect("the link names the real socket");
    let RunningProgramPath::OnDisk(program) =
        read_running_program_path().expect("the program reads")
    else {
        panic!("the test program was replaced");
    };
    let hooks = Arc::new(compose_daemon_hook_commands(&program).expect("the hooks compose"));
    while let Ok(stream) = listener.accept().await {
        tokio::spawn(answer_as_codex_service(stream, Arc::clone(&hooks)));
    }
}

// Tells the test each time a service's process ends on its own, and each time one is back.
struct ExitsHeard {
    exits: mpsc::UnboundedSender<()>,
    recoveries: mpsc::UnboundedSender<()>,
}

impl CodexServiceEvents for ExitsHeard {
    fn process_exited(&self, _service: &Arc<CodexService>, _exit: Option<&ProcessExit>) {
        let _heard = self.exits.send(());
    }

    fn recovered(&self, _service: &Arc<CodexService>, _cause: CodexServiceRecoveryCause) {
        let _heard = self.recoveries.send(());
    }

    fn crash_loop(&self, _service: &Arc<CodexService>) {}

    fn planned_restart_requested(&self, _service: &Arc<CodexService>) {}
}

// The script the services start as Codex: it hands the stand-in the address its `--listen` names.
fn write_stand_in_script(folder: &Path) -> PathBuf {
    let program = std::env::current_exe().expect("the test program names itself");
    let script = folder.join("codex");
    let body = format!(
        "#!/bin/sh\nwhile [ \"$#\" -gt 0 ]; do\n  if [ \"$1\" = --listen ]; then \
         {LISTEN_ADDRESS_NAME}=\"$2\"; export {LISTEN_ADDRESS_NAME}; fi\n  shift\ndone\n\
         exec '{}' --exact {APP_SERVER_STAND_IN} --include-ignored >/dev/null 2>&1\n",
        program.display()
    );
    replace_file_atomically(&script, body.as_bytes(), 0o755).expect("the script is written");
    script
}

// The home on the person's own Codex folder with terminal reach on, under `folder`.
fn terminal_home(folder: &Path) -> CodexServiceHome {
    let codex_home = folder.join("home");
    std::fs::create_dir_all(&codex_home).expect("the home is made");
    CodexServiceHome {
        codex_home,
        provider_account_id: None,
        kind: CodexHomeKind::PersonalFolder {
            is_terminal_reach_on: true,
        },
    }
}

// What the services of one test run on: the stand-in as Codex, resolved through `program` when
// one is given, its exits and recoveries told on the two receivers.
struct StandInServices {
    home: CodexServiceHome,
    dependencies: Arc<CodexServiceDependencies>,
    exits: mpsc::UnboundedReceiver<()>,
    recoveries: mpsc::UnboundedReceiver<()>,
}

fn stand_in_services(
    folder: &Path,
    program: impl FnOnce(TestCodexProgram) -> Arc<dyn CodexProgramResolver>,
) -> StandInServices {
    let home = terminal_home(folder);
    let (exits_sender, exits) = mpsc::unbounded_channel();
    let (recoveries_sender, recoveries) = mpsc::unbounded_channel();
    let dependencies = test_codex_service_dependencies(
        folder,
        program(TestCodexProgram {
            program: write_stand_in_script(folder),
            environment: vec![(
                CODEX_HOME_NAME.to_owned(),
                home.codex_home.display().to_string(),
            )],
        }),
        Arc::new(ExitsHeard {
            exits: exits_sender,
            recoveries: recoveries_sender,
        }),
    );
    StandInServices {
        home,
        dependencies,
        exits,
        recoveries,
    }
}

// Whether the process `process_id` still runs.
fn is_running(process_id: u32) -> bool {
    std::process::Command::new("/bin/kill")
        .args(["-0", &process_id.to_string()])
        .status()
        .expect("kill runs")
        .success()
}

fn kill(process_id: u32) -> bool {
    std::process::Command::new("/bin/kill")
        .args(["-KILL", &process_id.to_string()])
        .status()
        .expect("kill runs")
        .success()
}

// A Codex program that resolves on its first call only, so a second service's start fails.
struct FirstResolveOnly {
    program: TestCodexProgram,
    calls: AtomicUsize,
}

impl CodexProgramResolver for FirstResolveOnly {
    fn resolve<'call>(
        &'call self,
        home: &'call CodexServiceHome,
    ) -> BoxFuture<'call, Result<ResolvedProviderExecutable, DriverError>> {
        if self.calls.fetch_add(1, Ordering::Relaxed) == 0 {
            return self.program.resolve(home);
        }
        Box::pin(async { Err(DriverError::Internal("the second resolve fails".into())) })
    }
}

// Fails when a planned restart leaves the home's socket on the first service, when the first's
// stop clears the link the second now holds, when a crash leaves the link naming the socket its
// ended process listened on, or when the second's restart leaves the link off the restarted
// service.
#[tokio::test(flavor = "multi_thread")]
async fn the_home_socket_follows_the_service_that_holds_it() {
    if !can_move_socket_links() {
        return;
    }
    // The home's socket path must fit the system's bound on socket paths.
    let folder = tempfile::tempdir_in("/tmp").expect("a scratch folder is made");
    let mut services = stand_in_services(folder.path(), |program| Arc::new(program));
    let startup_timeout = services.dependencies.startup_timeout;
    let home_socket = home_socket_path(&services.home.codex_home);
    let registry = CodexServiceRegistry::new(
        Arc::new(OneHome(services.home.clone())),
        Arc::clone(&services.dependencies),
    );
    let first = registry.service_for(None).await.expect("the home resolves");
    first
        .ensure_started(startup_timeout)
        .await
        .expect("the first service starts");

    let second = registry.replace(&first).await.expect("the second starts");
    let first_socket = first.physical_socket();
    let second_socket = second.physical_socket();
    let after_restart = read_socket_link(&home_socket).expect("the link reads");
    registry.retire(&first).await;
    let after_retire = read_socket_link(&home_socket).expect("the link reads");
    let is_killed = kill(second.process_id().expect("the second runs a process"));
    let crash_heard = tokio::time::timeout(CRASH_WAIT, services.exits.recv()).await;
    let after_crash = read_socket_link(&home_socket).expect("the link reads");
    let recovery_heard = tokio::time::timeout(CRASH_WAIT, services.recoveries.recv()).await;
    let restarted_socket = second.physical_socket();
    let after_recovery = read_socket_link(&home_socket).expect("the link reads");
    registry.shutdown(DaemonStopIntent::Stop).await;

    assert!(second_socket.is_some());
    assert_ne!(second_socket, first_socket);
    assert_eq!(after_restart, second_socket);
    assert_eq!(after_retire, second_socket);
    assert!(is_killed);
    assert!(
        matches!(crash_heard, Ok(Some(()))),
        "the crash was not heard"
    );
    assert_ne!(
        after_crash, second_socket,
        "the link still names the ended process's socket"
    );
    assert!(
        matches!(recovery_heard, Ok(Some(()))),
        "the restart was not heard"
    );
    assert!(restarted_socket.is_some());
    assert_eq!(after_recovery, restarted_socket);
}

// Fails when a planned restart whose second service cannot start takes the home from the first,
// which leaves the home's sessions on a service that never came up.
#[tokio::test(flavor = "multi_thread")]
async fn a_second_service_that_fails_to_start_leaves_the_first_the_home_s() {
    if !can_move_socket_links() {
        return;
    }
    let folder = tempfile::tempdir_in("/tmp").expect("a scratch folder is made");
    let services = stand_in_services(folder.path(), |program| {
        Arc::new(FirstResolveOnly {
            program,
            calls: AtomicUsize::new(0),
        })
    });
    let home_socket = home_socket_path(&services.home.codex_home);
    let registry = CodexServiceRegistry::new(
        Arc::new(OneHome(services.home.clone())),
        Arc::clone(&services.dependencies),
    );
    let first = registry.service_for(None).await.expect("the home resolves");
    first
        .ensure_started(services.dependencies.startup_timeout)
        .await
        .expect("the first service starts");

    let replaced = registry.replace(&first).await;
    let registered = registry.services();
    let link = read_socket_link(&home_socket).expect("the link reads");
    registry.shutdown(DaemonStopIntent::Stop).await;

    assert!(replaced.is_err());
    assert!(
        registered.len() == 1 && Arc::ptr_eq(&registered[0], &first),
        "the first is no longer the home's service"
    );
    assert_eq!(link, first.physical_socket());
}

// Fails when a daemon restarted in the middle of a planned restart retires both services, which
// ends every terminal session inside them, or joins the one the home's link does not name.
#[tokio::test(flavor = "multi_thread")]
async fn a_restart_cut_short_joins_the_service_the_link_names_and_leaves_the_other_running() {
    if !can_move_socket_links() {
        return;
    }
    let folder = tempfile::tempdir_in("/tmp").expect("a scratch folder is made");
    let services = stand_in_services(folder.path(), |program| Arc::new(program));
    let startup_timeout = services.dependencies.startup_timeout;
    let former_daemon = CodexServiceRegistry::new(
        Arc::new(OneHome(services.home.clone())),
        Arc::clone(&services.dependencies),
    );
    let first = former_daemon
        .service_for(None)
        .await
        .expect("the home resolves");
    first
        .ensure_started(startup_timeout)
        .await
        .expect("the first service starts");
    let second = former_daemon
        .replace(&first)
        .await
        .expect("the second starts");
    let first_process = first.process_id().expect("the first runs a process");
    let second_process = second.process_id().expect("the second runs a process");
    former_daemon.shutdown(DaemonStopIntent::Restart).await;

    let daemon = CodexServiceRegistry::new(
        Arc::new(OneHome(services.home.clone())),
        Arc::clone(&services.dependencies),
    );
    let joined = daemon.service_for(None).await.expect("the home resolves");
    let started = joined.ensure_started(startup_timeout).await;
    let joined_process = joined.process_id();
    let is_first_running = is_running(first_process);
    daemon.shutdown(DaemonStopIntent::Stop).await;
    let is_first_killed = kill(first_process);

    assert!(started.is_ok(), "{started:?}");
    assert_eq!(joined_process, Some(second_process));
    assert!(is_first_running, "the service the link left was stopped");
    assert!(is_first_killed);
}
