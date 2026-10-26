use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use sidekicks_platforms::{
    CredentialStore, DaemonRunFolder, LeftoverSweep, SocketPathRefused, askpass_socket_path,
    check_socket_path, create_missing_private_folders, process_identity, replace_file_atomically,
};
use tempfile::TempDir;
use tokio_util::sync::CancellationToken;

use super::{DaemonProcess, DaemonStartError, DaemonStartFailure};
use crate::credential_store::items::{SecretItems, SecretItemsStart};
use crate::credential_store::os::TestStoreAccess;
use crate::daemon::crash::monitor::{
    CRASH_DUMPS_FOLDER_NAME, CRASH_MONITOR_MODE, crash_monitor_socket_path, serve_crash_monitor,
};
use crate::daemon::data_folder::data_folder;
use crate::daemon::data_folder_lock::DataFolderLock;
use crate::daemon::process::start_options::{DaemonStartOptions, ProviderBaseEnvironment};
use crate::daemon::release_version::this_build_release_version;
use crate::daemon::service_log::open_service_log;
use crate::data_acts::erase::{DataErase, DataEraseDeps};
use crate::ipc::caller_process::system_reader::ProcessTableReader;
use crate::provider::driver::daemon_stop::DaemonStopIntent;
use crate::provider::driver::registry::ProviderRegistry;
use crate::provider::driver::test_registry::test_driver_services;

// The variable the stand-in crash monitor reads its socket's path from.
const MONITOR_SOCKET_VARIABLE: &str = "SIDEKICKS_TEST_CRASH_MONITOR_SOCKET";

// The longest a started daemon's test waits for the erase to end the process.
const ERASE_WAIT: Duration = Duration::from_secs(30);

// The crash monitor the daemon starts in these tests: this test binary, run through a script as
// the daemon's own program, serving the socket the mode's argument names; the script fails every
// other mode, the search index's build among them. Run only that way.
#[test]
#[ignore = "the started daemon's crash monitor, run through its script"]
fn crash_monitor_stand_in() {
    let Some(socket_path) = std::env::var_os(MONITOR_SOCKET_VARIABLE).map(PathBuf::from) else {
        return;
    };
    let dumps_folder = socket_path
        .parent()
        .expect("the socket sits in its run folder")
        .join(CRASH_DUMPS_FOLDER_NAME);
    serve_crash_monitor(&socket_path, &dumps_folder).expect("the stand-in monitor serves");
}

// A temporary home the daemon starts on, its run folder at `run_folder_path`, beside the data
// folder as a runtime folder sits, and the script that runs the stand-in monitor.
struct TestHome {
    home: TempDir,
    run_folder: DaemonRunFolder,
    daemon_program: PathBuf,
}

impl TestHome {
    fn new() -> Self {
        let home = tempfile::tempdir().expect("a temporary home");
        let run_folder_path = home.path().join("run");
        Self::with_run_folder(home, run_folder_path)
    }

    fn with_run_folder(home: TempDir, run_folder_path: PathBuf) -> Self {
        let test_path = module_path!()
            .split_once("::")
            .map(|(_crate, path)| path)
            .expect("the module path names its crate");
        let program = std::env::current_exe().expect("the test program names itself");
        let daemon_program = home.path().join("daemon-program");
        let script = format!(
            "#!/bin/sh\n[ \"$1\" = {CRASH_MONITOR_MODE} ] || exit 1\n\
             {MONITOR_SOCKET_VARIABLE}=\"$2\" exec '{}' --exact \
             {test_path}::crash_monitor_stand_in --include-ignored >/dev/null\n",
            program.display()
        );
        replace_file_atomically(
            &daemon_program,
            script.as_bytes(),
            0o755,
            LeftoverSweep::Unswept,
        )
        .expect("the stand-in's script is written");
        Self {
            home,
            run_folder: DaemonRunFolder {
                socket_path: run_folder_path.join("daemon.sock"),
                token_path: run_folder_path.join("daemon.token"),
                status_path: run_folder_path.join("service-status.json"),
                folder_path: run_folder_path,
            },
            daemon_program,
        }
    }

    fn data_folder(&self) -> PathBuf {
        data_folder(self.home.path())
    }

    fn monitor_socket_path(&self) -> PathBuf {
        crash_monitor_socket_path(&self.run_folder.folder_path, std::process::id())
    }

    // Starts the daemon on this home with no providers' environment, its stop `stop`.
    async fn start(&self, stop: CancellationToken) -> Result<DaemonProcess, DaemonStartFailure> {
        let data_folder = self.data_folder();
        create_missing_private_folders(&data_folder).expect("the data folder is made");
        DaemonProcess::start(DaemonStartOptions {
            home_folder: self.home.path().to_path_buf(),
            data_folder_lock: DataFolderLock::take(&data_folder).expect("the data folder is free"),
            run_folder: self.run_folder.clone(),
            daemon_program: self.daemon_program.clone(),
            process_identity: process_identity(std::process::id())
                .expect("this process reads")
                .expect("this process runs"),
            version: this_build_release_version(),
            caller_process_reader: Arc::new(
                ProcessTableReader::for_this_program().expect("the caller reader is built"),
            ),
            stop,
            base_environment: ProviderBaseEnvironment::Given(Arc::from([])),
            service_log_files: open_service_log(&data_folder, io::sink()).files(),
        })
        .await
    }
}

// An erase over a started daemon runs the stop's two steps on the task that owns the process: the
// socket and the crash monitor's socket are gone and the data folder deleted once the erase ends
// the process, and the stop that follows finds nothing left and fails nothing. Killed by an erase
// step that never reaches the process, by a step that does not close what it names, and by a
// stop that closes a part the erase already closed again.
#[tokio::test(flavor = "multi_thread")]
async fn an_erase_over_a_started_daemon_closes_it_and_the_stop_after_fails_nothing() {
    let home = TestHome::new();
    let mut process = home
        .start(CancellationToken::new())
        .await
        .expect("the daemon starts");
    assert!(home.run_folder.socket_path.exists() && home.monitor_socket_path().exists());
    let end_process = process.accept_stop();
    let erase = Arc::new(DataErase::new(DataEraseDeps {
        data_folder: home.data_folder(),
        secret_items: SecretItems::new(SecretItemsStart {
            data_folder: home.data_folder(),
            runs_while_logged_out: false,
            access: TestStoreAccess::new(CredentialStore::in_memory()) as _,
            call_timeout: Duration::from_secs(5),
        })
        .expect("the system gives random bytes"),
        providers: Arc::new(ProviderRegistry::register_from(
            &[],
            &test_driver_services(),
        )),
        stop_work: process.stop_work_step(),
        close_data_folder: process.close_data_folder_step(),
        end_process: Arc::new(move || end_process(DaemonStopIntent::Stop)),
    }));

    erase.begin().await.expect("the erase starts");
    let intent = tokio::time::timeout(ERASE_WAIT, process.wait_for_stop())
        .await
        .expect("the erase ends the process");

    assert_eq!(intent, DaemonStopIntent::Stop);
    assert!(!home.run_folder.socket_path.exists(), "the socket is gone");
    assert!(
        !home.monitor_socket_path().exists(),
        "the crash monitor's socket is gone"
    );
    assert!(!home.data_folder().exists(), "the data folder is deleted");
    process
        .stop(intent)
        .await
        .expect("the stop after the erase fails nothing");
}

// A run folder whose longest socket path is one byte past the system's bound fails the start
// before any step: no folder is made and no monitor started. One byte shorter starts, removing
// the socket an ended service's monitor left, and its stop leaves neither socket. Killed by the
// path check removed, where the start fails later at the crash monitor after making the folder,
// and by the ended service's socket kept.
#[tokio::test(flavor = "multi_thread")]
async fn a_run_folder_too_long_for_its_sockets_fails_the_start_before_any_step() {
    let Err(SocketPathRefused::TooLong { limit, .. }) =
        check_socket_path(&PathBuf::from("/".repeat(4096)))
    else {
        panic!("a path of 4096 bytes is past every system's bound");
    };
    let longest_name = crash_monitor_socket_path(Path::new(""), std::process::id())
        .as_os_str()
        .len()
        .max("daemon.sock".len())
        .max(askpass_socket_path(Path::new("")).as_os_str().len());
    let home = tempfile::tempdir().expect("a temporary home");
    // The folder, a separator and the longest name come to one byte past the bound.
    let padding = (limit - longest_name)
        .checked_sub(home.path().as_os_str().len() + 1)
        .expect("the temporary home is short enough to pad");
    let too_long = home.path().join("r".repeat(padding));
    let fits = home.path().join("r".repeat(padding - 1));
    let refused = TestHome::with_run_folder(home, too_long.clone());

    let failure = refused
        .start(CancellationToken::new())
        .await
        .err()
        .expect("the start fails");

    assert!(
        matches!(
            failure.failures.original(),
            DaemonStartError::SocketPathRefused {
                source: SocketPathRefused::TooLong { .. },
                ..
            }
        ),
        "{:?}",
        failure.failures
    );
    assert!(!too_long.exists(), "no run folder is made");

    let started = TestHome::with_run_folder(refused.home, fits);
    create_missing_private_folders(&started.run_folder.folder_path).expect("the run folder");
    let mut ended =
        std::process::Command::new(std::env::current_exe().expect("the test program names itself"))
            .args(["--exact", "no-such-test"])
            .stdout(std::process::Stdio::null())
            .spawn()
            .expect("a process starts");
    let ended_pid = ended.id();
    ended.wait().expect("the process ends");
    let left_socket = crash_monitor_socket_path(&started.run_folder.folder_path, ended_pid);
    std::fs::write(&left_socket, b"").expect("an ended service's socket is left");
    let process = started
        .start(CancellationToken::new())
        .await
        .expect("a run folder one byte shorter starts");
    assert!(
        !left_socket.exists(),
        "the ended service's socket is removed"
    );
    assert!(started.monitor_socket_path().exists());
    process
        .stop(DaemonStopIntent::Stop)
        .await
        .expect("the stop fails nothing");
    assert!(!started.run_folder.socket_path.exists());
    assert!(!started.monitor_socket_path().exists());
}

// A stop asked for before the daemon is ready fails the start as stopped, and the socket it may
// have bound is gone. Killed by both of the start's stop checks removed; the one before the ready
// line alone is not, since the check after the capture answers first.
#[tokio::test(flavor = "multi_thread")]
async fn a_stop_before_ready_fails_the_start_as_stopped_and_leaves_no_socket() {
    let home = TestHome::new();
    let stop = CancellationToken::new();
    stop.cancel();

    let failure = home.start(stop).await.err().expect("the start fails");

    assert!(
        matches!(failure.failures.original(), DaemonStartError::Stopped(_)),
        "{:?}",
        failure.failures
    );
    assert!(!home.run_folder.socket_path.exists());
    assert!(!home.monitor_socket_path().exists());
}
