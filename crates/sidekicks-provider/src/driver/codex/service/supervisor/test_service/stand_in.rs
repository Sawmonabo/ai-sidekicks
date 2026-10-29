//! The stand-in Codex service a test program runs as itself: the script a service starts as
//! Codex, which runs one of the test program's own tests, that test's body, which listens and
//! answers as Codex does, and the two kinds of service one daemon starts on it side by side.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use interprocess::local_socket::traits::tokio::Listener as _;
use sidekicks_platforms::{
    LeftoverSweep, bind_socket_listener, replace_file_atomically, replace_socket_link,
};

use super::{
    TestCodexProgram, UnheardEvents, answer_as_codex_service, test_codex_service_dependencies,
};
use crate::driver::child_records::DaemonChildRecords;
use crate::driver::codex::lifecycle::CODEX_SERVICE_STARTUP_TIMEOUT;
use crate::driver::codex::service::home::{CodexHomeKind, CodexServiceHome};
use crate::driver::codex::service::registry::{CodexServiceRegistry, OneHome, home_socket_path};
use crate::driver::daemon_stop::DaemonStopIntent;

/// The address the stand-in listens on, as its `--listen` names it; only its script sets it.
const LISTEN_ADDRESS_NAME: &str = "SIDEKICKS_TEST_LISTEN_ADDRESS";

/// Set for a stand-in that ignores the hang-up, as a service still finishing its replies does;
/// only a test's program sets it.
pub(crate) const HANG_UP_IGNORED_NAME: &str = "SIDEKICKS_TEST_HANG_UP_IGNORED";

/// The Codex home the stand-in serves, as Codex reads it.
pub(crate) const CODEX_HOME_NAME: &str = "CODEX_HOME";

/// The file in the script's folder its last launch's arguments are kept in, one to a line.
pub(crate) const LAUNCH_ARGUMENTS_FILE: &str = "codex-arguments";

/// Listens as Codex does, on a real socket of its own with the path its `--listen` named made a
/// link to it, answering a daemon's start, until the process is ended; returns at once where no
/// script from [`write_codex_stand_in_script`] started it. A test program's stand-in test calls
/// it. Panics where its socket cannot be bound or linked.
pub async fn serve_as_codex_stand_in() {
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
    let listener = bind_socket_listener(&real_socket).expect("the real socket listens");
    replace_socket_link(&link, &real_socket).expect("the link names the real socket");
    while let Ok(stream) = listener.accept().await {
        tokio::spawn(answer_as_codex_service(stream, |_method| {}));
    }
}

/// Writes in `folder` the script a test's services start as Codex, and answers its path: it keeps
/// its arguments, hands the stand-in the address its `--listen` names, ignores the hang-up where
/// its environment sets [`HANG_UP_IGNORED_NAME`], and runs this test program's test
/// `stand_in_test`, which calls [`serve_as_codex_stand_in`]. Panics where it cannot be written.
pub fn write_codex_stand_in_script(folder: &Path, stand_in_test: &str) -> PathBuf {
    let program = std::env::current_exe().expect("the test program names itself");
    let script = folder.join("codex");
    let body = format!(
        "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\n\
         while [ \"$#\" -gt 0 ]; do\n  if [ \"$1\" = --listen ]; then \
         {LISTEN_ADDRESS_NAME}=\"$2\"; export {LISTEN_ADDRESS_NAME}; fi\n  shift\ndone\n\
         if [ -n \"${HANG_UP_IGNORED_NAME}\" ]; then trap '' HUP; fi\n\
         exec '{}' --exact {stand_in_test} --include-ignored >/dev/null 2>&1\n",
        folder.join(LAUNCH_ARGUMENTS_FILE).display(),
        program.display()
    );
    replace_file_atomically(&script, body.as_bytes(), 0o755, LeftoverSweep::Unswept)
        .expect("the script is written");
    script
}

/// A Codex service on an account home and the lasting terminal service on the person's own Codex
/// folder, both started on the stand-in by one daemon whose own children a record holds.
pub struct CodexServicesBeside {
    account: CodexServiceRegistry,
    terminal: CodexServiceRegistry,
    /// The process of the service on the account home, the daemon's own child.
    pub account_process_id: u32,
    /// The process of the lasting service, which outlives the daemon.
    pub lasting_process_id: u32,
}

impl CodexServicesBeside {
    /// Starts both under `folder` on the stand-in `script` runs, the daemon's own children recorded
    /// in `child_records`. Must be called within a multi-thread runtime. Panics where either does
    /// not start a process of its own.
    pub async fn start(
        folder: &Path,
        script: &Path,
        child_records: &Arc<dyn DaemonChildRecords>,
    ) -> Self {
        let start = |name: &str, kind: CodexHomeKind| {
            let codex_home = folder.join(name);
            std::fs::create_dir_all(&codex_home).expect("the home is made");
            let program = TestCodexProgram {
                program: script.to_path_buf(),
                environment: vec![(CODEX_HOME_NAME.to_owned(), codex_home.display().to_string())],
            };
            CodexServiceRegistry::new(
                Arc::new(OneHome(CodexServiceHome {
                    codex_home,
                    provider_account_id: None,
                    kind,
                })),
                test_codex_service_dependencies(
                    folder,
                    Arc::new(program),
                    Arc::new(UnheardEvents),
                    Arc::clone(child_records),
                ),
            )
        };
        let account = start("account", CodexHomeKind::Account);
        let terminal = start(
            "own",
            CodexHomeKind::PersonalFolder {
                is_terminal_reach_on: true,
            },
        );
        let account_process_id = start_process(&account).await;
        let lasting_process_id = start_process(&terminal).await;
        Self {
            account,
            terminal,
            account_process_id,
            lasting_process_id,
        }
    }

    /// Stops both, the lasting service included.
    pub async fn stop(self) {
        self.account.shutdown(DaemonStopIntent::Stop).await;
        self.terminal.shutdown(DaemonStopIntent::Stop).await;
    }
}

// Starts the one service of `registry` and answers its process.
async fn start_process(registry: &CodexServiceRegistry) -> u32 {
    let service = registry.service_for(None).await.expect("the home resolves");
    service
        .ensure_started(CODEX_SERVICE_STARTUP_TIMEOUT)
        .await
        .expect("the service starts");
    service
        .process_identity()
        .expect("the service runs a process of its own")
        .process_id
}
