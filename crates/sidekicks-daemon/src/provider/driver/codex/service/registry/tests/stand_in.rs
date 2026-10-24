//! What the registry's tests on real processes run as Codex: this test program as a stand-in
//! service that listens as Codex does, the folders and dependencies each test's services share,
//! and the former daemon's planned restart a later daemon meets.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use futures::future::BoxFuture;
use interprocess::local_socket::traits::tokio::Listener as _;
use sidekicks_contracts::run::control::ProcessExit;
use sidekicks_platforms::{
    ExistingSocket, LeftoverSweep, bind_socket_listener, pin_running_process,
    replace_file_atomically, replace_socket_link,
};
use tokio::sync::mpsc;

use crate::provider::driver::codex::service::home::{CodexHomeKind, CodexServiceHome};
use crate::provider::driver::codex::service::record::LastingServiceRecordFile;
use crate::provider::driver::codex::service::registry::OneHome;
use crate::provider::driver::codex::service::registry::{CodexServiceRegistry, home_socket_path};
use crate::provider::driver::codex::service::supervisor::events::{
    CodexServiceEvents, CodexServiceRecoveryCause,
};
use crate::provider::driver::codex::service::supervisor::test_service::{
    TestCodexProgram, UnheardEvents, answer_as_codex_service, test_codex_service_dependencies,
};
use crate::provider::driver::codex::service::supervisor::{
    CodexProgramResolver, CodexService, CodexServiceDependencies,
};
use crate::provider::driver::codex::session::errors::CodexError;
use crate::provider::driver::contract::DriverError;
use crate::provider::driver::daemon_stop::DaemonStopIntent;
use crate::provider::spawned_version::ResolvedProviderExecutable;

/// The stand-in Codex service: this test program, run by the script the registry's services
/// start as Codex.
const APP_SERVER_STAND_IN: &str =
    "provider::driver::codex::service::registry::tests::stand_in::an_app_server_stand_in";

/// The address the stand-in listens on, as its `--listen` names it; only its script sets it.
const LISTEN_ADDRESS_NAME: &str = "SIDEKICKS_TEST_LISTEN_ADDRESS";

/// Set for a stand-in that ignores the hang-up, as a service still finishing its replies does;
/// only a test's program sets it.
pub(super) const HANG_UP_IGNORED_NAME: &str = "SIDEKICKS_TEST_HANG_UP_IGNORED";

/// The Codex home the stand-in serves, as Codex reads it.
const CODEX_HOME_NAME: &str = "CODEX_HOME";

/// How long a test waits on a crash, a recovery or a process's end to be heard.
pub(super) const CRASH_WAIT: Duration = Duration::from_secs(10);

// Listens as Codex does: on a real socket of its own, with the path it was given made a link to
// it, answering the daemon's start. Skips unless a test's script started it.
#[tokio::test]
#[ignore = "run only as a registry test's Codex service"]
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
    while let Ok(stream) = listener.accept().await {
        tokio::spawn(answer_as_codex_service(stream));
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

    fn crash_loop(&self, _service: &Arc<CodexService>, _start_failure: Option<Arc<CodexError>>) {}

    fn rate_limits_observed(&self, _service: &Arc<CodexService>) {}

    fn planned_restart_requested(&self, _service: &Arc<CodexService>) {}
}

/// The file the stand-in's script keeps its last launch's arguments in, one to a line.
const LAUNCH_ARGUMENTS_FILE: &str = "codex-arguments";

// The script the services start as Codex: it keeps its arguments, hands the stand-in the address
// its `--listen` names, and has it ignore the hang-up where the test's program asks.
fn write_stand_in_script(folder: &Path) -> PathBuf {
    let program = std::env::current_exe().expect("the test program names itself");
    let script = folder.join("codex");
    let body = format!(
        "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\n\
         while [ \"$#\" -gt 0 ]; do\n  if [ \"$1\" = --listen ]; then \
         {LISTEN_ADDRESS_NAME}=\"$2\"; export {LISTEN_ADDRESS_NAME}; fi\n  shift\ndone\n\
         if [ -n \"${HANG_UP_IGNORED_NAME}\" ]; then trap '' HUP; fi\n\
         exec '{}' --exact {APP_SERVER_STAND_IN} --include-ignored >/dev/null 2>&1\n",
        folder.join(LAUNCH_ARGUMENTS_FILE).display(),
        program.display()
    );
    replace_file_atomically(&script, body.as_bytes(), 0o755, LeftoverSweep::Unswept)
        .expect("the script is written");
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

/// What the services of one test run on: the stand-in as Codex, resolved through `program` when
/// one is given, its exits and recoveries told on the two receivers.
pub(super) struct StandInServices {
    /// The folder the data, logs and home sit in.
    pub(super) folder: PathBuf,
    /// The person's own Codex folder.
    pub(super) home: CodexServiceHome,
    /// What the test's daemon runs its services on.
    pub(super) dependencies: Arc<CodexServiceDependencies>,
    /// One message per process that ended on its own.
    pub(super) exits: mpsc::UnboundedReceiver<()>,
    /// One message per service back after a crash.
    pub(super) recoveries: mpsc::UnboundedReceiver<()>,
}

/// The services of one test under `folder`, the stand-in resolved through what `program` makes
/// of it.
pub(super) fn stand_in_services(
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
        folder: folder.to_owned(),
        home,
        dependencies,
        exits,
        recoveries,
    }
}

/// A registry of another daemon on the same folders and program, with drains of its own, so its
/// shutdown calls off none of the test's daemon's.
pub(super) fn another_daemon(services: &StandInServices) -> CodexServiceRegistry {
    CodexServiceRegistry::new(
        Arc::new(OneHome(services.home.clone())),
        test_codex_service_dependencies(
            &services.folder,
            Arc::clone(&services.dependencies.program),
            Arc::new(UnheardEvents),
        ),
    )
}

/// The test's daemon: a registry on the test's own dependencies.
pub(super) fn this_daemon(services: &StandInServices) -> CodexServiceRegistry {
    CodexServiceRegistry::new(
        Arc::new(OneHome(services.home.clone())),
        Arc::clone(&services.dependencies),
    )
}

/// The arguments the stand-in's last launch under `services` ran with.
pub(super) fn last_launch_arguments(services: &StandInServices) -> Vec<String> {
    std::fs::read_to_string(services.folder.join(LAUNCH_ARGUMENTS_FILE))
        .expect("the launch's arguments were kept")
        .lines()
        .map(str::to_owned)
        .collect()
}

/// Whether the process `process_id` still runs.
pub(super) fn is_running(process_id: u32) -> bool {
    pin_running_process(process_id)
        .expect("the process table reads")
        .is_some()
}

/// Sends `signal`, `/bin/kill`'s spelling of it, to the process `process_id`; answers whether it
/// was sent.
pub(super) fn send_signal(process_id: u32, signal: &str) -> bool {
    std::process::Command::new("/bin/kill")
        .args([signal, &process_id.to_string()])
        .status()
        .expect("kill runs")
        .success()
}

/// Answers once the process `process_id` ended, or `false` once [`CRASH_WAIT`] passed first.
pub(super) async fn wait_until_gone(process_id: u32) -> bool {
    wait_for_end_within(process_id, CRASH_WAIT).await
}

// Answers once the process `process_id` ended, waiting on the system's exit notice, or `false`
// once `bound` passed first; a process already gone has ended.
async fn wait_for_end_within(process_id: u32, bound: Duration) -> bool {
    let Some(process) = pin_running_process(process_id).expect("the process table reads") else {
        return true;
    };
    tokio::time::timeout(bound, process.wait_for_end())
        .await
        .is_ok_and(|ended| {
            ended.expect("the process's end is watched");
            true
        })
}

/// The record file of the service on the home's own socket.
pub(super) fn home_record_file(services: &StandInServices) -> LastingServiceRecordFile {
    LastingServiceRecordFile::of_socket(
        &services.dependencies.data_folder,
        &services.home.codex_home,
        &home_socket_path(&services.home.codex_home),
    )
    .expect("the record file is named")
}

/// Answers once the process `process_id` ended and the record kept on the home's own socket is
/// gone, or `false` once `bound` passed first.
pub(super) async fn wait_for_end_and_record_removal(
    process_id: u32,
    services: &StandInServices,
    bound: Duration,
) -> bool {
    let started_at = tokio::time::Instant::now();
    if !wait_for_end_within(process_id, bound).await {
        return false;
    }
    let record_file = home_record_file(services);
    // The drain removes the record on a task of its own once the end is out, and nothing tells
    // that removal, so the record is read again until it is gone.
    let removed = async {
        while record_file
            .lock()
            .and_then(|locked| locked.read())
            .expect("the record reads")
            .is_some()
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    };
    tokio::time::timeout(bound.saturating_sub(started_at.elapsed()), removed)
        .await
        .is_ok()
}

/// Marks every record kept for the folder draining, as a former daemon's start does once its ask
/// to drain was delivered; answers how many it marked.
pub(super) fn mark_kept_records_draining(services: &StandInServices) -> usize {
    let home_record = home_record_file(services).lock().expect("the records lock");
    let others = home_record.others().expect("the other records list");
    let mut marked = 0;
    for locked in std::iter::once(&home_record).chain(&others) {
        if let Some(mut record) = locked.read().expect("the record reads") {
            record.is_draining = true;
            locked
                .write(&record)
                .expect("the record is marked draining");
            marked += 1;
        }
    }
    marked
}

/// A Codex program that resolves on its first call only, so a second service's start fails.
pub(super) struct FirstResolveOnly {
    /// The program the first call resolves.
    pub(super) program: TestCodexProgram,
    /// How many calls came.
    pub(super) calls: AtomicUsize,
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

/// A former daemon's planned restart cut short by its own restart: both services left running,
/// answered with the first's and the second's processes and the first's socket.
pub(super) async fn cut_short_planned_restart(
    services: &StandInServices,
) -> (u32, u32, Option<PathBuf>) {
    let former_daemon = another_daemon(services);
    let first = former_daemon
        .service_for(None)
        .await
        .expect("the home resolves");
    first
        .ensure_started(services.dependencies.startup_timeout)
        .await
        .expect("the first service starts");
    let second = former_daemon
        .replace(&first)
        .await
        .expect("the second starts");
    let first_process = first.process_id().expect("the first runs a process");
    let second_process = second.process_id().expect("the second runs a process");
    former_daemon.shutdown(DaemonStopIntent::Restart).await;
    (first_process, second_process, first.physical_socket())
}
