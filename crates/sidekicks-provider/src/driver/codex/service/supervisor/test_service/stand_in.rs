//! The stand-in Codex service a test program runs as itself: the `codex` script a service starts,
//! which records each launch and runs one of the test program's own tests, that test's body, which
//! listens and answers as Codex does and records each request, what a test reads of those records,
//! and the two kinds of service one daemon starts on it side by side.

use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use interprocess::local_socket::traits::tokio::Listener as _;
use sidekicks_platforms::{
    CAN_BIND_A_SOCKET_LISTENER, CAN_LINK_A_SOCKET, LeftoverSweep, bind_socket_listener,
    pin_running_process, replace_file_atomically, replace_socket_link, short_socket_folder,
};
use tempfile::TempDir;

use super::{
    TestCodexProgram, UnheardEvents, answer_as_codex_service, codex_folder_environment,
    test_codex_service_dependencies,
};
use crate::driver::child_records::DaemonChildRecords;
use crate::driver::codex::lifecycle::CODEX_SERVICE_STARTUP_TIMEOUT;
use crate::driver::codex::service::home::{CodexHomeKind, CodexServiceHome};
use crate::driver::codex::service::registry::{CodexServiceRegistry, OneHome, home_socket_path};
use crate::driver::daemon_stop::DaemonStopIntent;
use crate::runtime_binding::test_store::test_provider_account_id;

/// The Codex home a stand-in service serves, as Codex reads it.
pub(crate) const CODEX_HOME_NAME: &str = "CODEX_HOME";

/// Set for a stand-in that ignores the hang-up, as a service still finishing its replies does;
/// only a test's program sets it.
pub(crate) const HANG_UP_IGNORED_NAME: &str = "SIDEKICKS_TEST_HANG_UP_IGNORED";

/// The file a stand-in's script keeps its last start's arguments in, one to a line.
pub(crate) const LAUNCH_ARGUMENTS_FILE: &str = "codex-arguments";

// The address a stand-in listens on, as its `--listen` names it; only its script sets it.
const LISTEN_ADDRESS_NAME: &str = "SIDEKICKS_TEST_LISTEN_ADDRESS";

// The file a stand-in records the requests it answers in; only its script sets it.
const CONNECTION_RECORD_NAME: &str = "SIDEKICKS_TEST_CONNECTION_RECORD";

// The daemon socket whose presence a stand-in records at each connection's first request; only
// its script sets it, and only where a test names one.
const DAEMON_SOCKET_NAME: &str = "SIDEKICKS_TEST_DAEMON_SOCKET";

/// Where a stand-in's script keeps its own standard output, which an executor stand-in answers on,
/// since the test program's own output goes nowhere.
const EXECUTOR_OUTPUT: &str = "/dev/fd/3";

// The address Codex's executor listens on, its standard input and output.
const EXECUTOR_LISTEN_ADDRESS: &str = "stdio";

// The file a stand-in's script adds each service start's process to, one to a line.
const LAUNCHES_FILE: &str = "codex-launches";

// The file a stand-in's requests are recorded in, one line each.
const CONNECTIONS_FILE: &str = "codex-connections";

/// Writes in `folder` the `codex` script a stand-in service starts through and answers its path:
/// it keeps its arguments in [`LAUNCH_ARGUMENTS_FILE`], adds each start of a service listening on a
/// socket to its launches, names its record of requests and, where `daemon_socket` is given, the
/// socket whose presence it records, has the program ignore the hang-up where its environment
/// asks, keeps its own standard output as [`EXECUTOR_OUTPUT`] for an executor's answers, and runs
/// this test program's `stand_in_test`, whose own output goes nowhere. Panics where it cannot be
/// written.
pub fn write_codex_service_script(
    folder: &Path,
    stand_in_test: &str,
    daemon_socket: Option<&Path>,
) -> PathBuf {
    let program = std::env::current_exe().expect("the test program names itself");
    let script = folder.join("codex");
    let daemon_socket = daemon_socket.map_or_else(String::new, |socket| {
        format!(
            "{DAEMON_SOCKET_NAME}='{}'; export {DAEMON_SOCKET_NAME}\n",
            socket.display()
        )
    });
    let body = format!(
        "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\n\
         while [ \"$#\" -gt 0 ]; do\n  if [ \"$1\" = --listen ]; then \
         {LISTEN_ADDRESS_NAME}=\"$2\"; export {LISTEN_ADDRESS_NAME}; fi\n  shift\ndone\n\
         case \"${LISTEN_ADDRESS_NAME}\" in unix://*) printf '%s\\n' \"$$\" >> '{}';; esac\n\
         {CONNECTION_RECORD_NAME}='{}'; export {CONNECTION_RECORD_NAME}\n{daemon_socket}\
         if [ -n \"${HANG_UP_IGNORED_NAME}\" ]; then trap '' HUP; fi\n\
         exec 3>&1\n\
         exec '{}' --exact {stand_in_test} --include-ignored >/dev/null 2>&1\n",
        folder.join(LAUNCH_ARGUMENTS_FILE).display(),
        folder.join(LAUNCHES_FILE).display(),
        folder.join(CONNECTIONS_FILE).display(),
        program.display()
    );
    replace_file_atomically(&script, body.as_bytes(), 0o755, LeftoverSweep::Unswept)
        .expect("the script is written");
    script
}

/// Serves as a Codex service where a stand-in's script started this program: on a real socket of
/// its own, with the path its `--listen` names made a link to it, answering each connection as a
/// start needs and recording each request in the script's record; or, started as Codex's executor
/// on its standard input and output, as that executor. Returns at once where no script started
/// it. Panics where its socket cannot listen or its link cannot be made.
pub async fn serve_as_codex_service_stand_in() {
    let Ok(address) = std::env::var(LISTEN_ADDRESS_NAME) else {
        return;
    };
    if address == EXECUTOR_LISTEN_ADDRESS {
        serve_as_executor_stand_in();
        return;
    }
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
    let record =
        PathBuf::from(std::env::var_os(CONNECTION_RECORD_NAME).expect("the record is named"));
    let daemon_socket = std::env::var_os(DAEMON_SOCKET_NAME).map(PathBuf::from);
    let connections = Arc::new(AtomicUsize::new(0));
    while let Ok(stream) = listener.accept().await {
        let mut recording = ConnectionRecording {
            record: record.clone(),
            daemon_socket: daemon_socket.clone(),
            connections: Arc::clone(&connections),
            first_request: None,
        };
        tokio::spawn(answer_as_codex_service(stream, move |method| {
            recording.record(method);
        }));
    }
}

// Answers as Codex's executor on its standard input and the script's kept output: the relay's
// `initialize` with an empty result, every other line left unanswered, until the input ends with
// the relay that started it. Panics where the kept output cannot be written.
fn serve_as_executor_stand_in() {
    let mut output = std::fs::OpenOptions::new()
        .write(true)
        .open(EXECUTOR_OUTPUT)
        .expect("the script kept its output");
    for line in io::stdin().lines() {
        let Ok(line) = line else {
            return;
        };
        let Ok(message) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if message["method"] == "initialize" {
            let answer = serde_json::json!({"id": message["id"], "result": {}});
            writeln!(output, "{answer}").expect("the answer is written");
        }
    }
}

// What a stand-in records of one connection's requests: the connection's place among those that
// asked anything and whether the daemon's socket was there, both taken at its first request.
struct ConnectionRecording {
    record: PathBuf,
    daemon_socket: Option<PathBuf>,
    connections: Arc<AtomicUsize>,
    first_request: Option<(usize, bool)>,
}

impl ConnectionRecording {
    // Appends one line for a request of `method`: this process, the connection, the daemon
    // socket's presence at the connection's first request, and the method. Panics where the
    // record cannot be written.
    fn record(&mut self, method: &str) {
        let (connection, is_daemon_socket_bound) = *self.first_request.get_or_insert_with(|| {
            (
                self.connections.fetch_add(1, Ordering::Relaxed),
                self.daemon_socket.as_deref().is_some_and(Path::exists),
            )
        });
        // One write of a whole line to a file opened to append, so lines never interleave.
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.record)
            .and_then(|mut record| {
                record.write_all(
                    format!(
                        "{}\t{connection}\t{is_daemon_socket_bound}\t{method}\n",
                        std::process::id()
                    )
                    .as_bytes(),
                )
            })
            .expect("the request is recorded");
    }
}

/// One connection a stand-in Codex service answered, as its record keeps it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StandInConnection {
    /// The service process that answered it.
    pub process_id: u32,
    /// Whether the daemon's socket was there when the connection asked its first request.
    pub is_daemon_socket_bound: bool,
    /// The methods it asked, in order.
    pub methods: Vec<String>,
}

/// A `codex` command alone on a daemon's search path, beside a person's own Codex folder, whose
/// every service start runs a test program's stand-in service: a test reads the process each
/// start launched and, connection by connection, what each asked. Ends every service it started
/// that still runs when it drops.
pub struct CodexServiceStandIn {
    codex_home: PathBuf,
    programs_folder: PathBuf,
    _folder: TempDir,
}

impl CodexServiceStandIn {
    /// The environment a daemon's providers start in to take this folder as the person's own
    /// Codex folder and the stand-in's command as their `codex`.
    pub fn provider_environment(&self) -> Vec<(String, String)> {
        codex_folder_environment(&self.codex_home, &self.programs_folder)
    }

    /// The process of every service start, in order: one entry per service launched. Panics where
    /// the record cannot be read.
    pub fn launches(&self) -> Vec<u32> {
        self.read_launches().expect("the launches read")
    }

    /// Each connection a started service answered, in the order of its first request. Panics
    /// where the record cannot be read.
    pub fn connections(&self) -> Vec<StandInConnection> {
        let lines = match std::fs::read_to_string(self.programs_folder.join(CONNECTIONS_FILE)) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => String::new(),
            read => read.expect("the connections read"),
        };
        let mut connections: Vec<((u32, usize), StandInConnection)> = Vec::new();
        for line in lines.lines() {
            let mut fields = line.split('\t');
            let mut field = || {
                fields
                    .next()
                    .expect("a request's line holds its four fields")
            };
            let process_id = field().parse().expect("a process reads");
            let connection = field().parse().expect("a connection reads");
            let is_daemon_socket_bound = field().parse().expect("the socket's presence reads");
            let method = field().to_owned();
            let key = (process_id, connection);
            match connections.iter_mut().find(|(seen, _)| *seen == key) {
                Some((_, seen)) => seen.methods.push(method),
                None => connections.push((
                    key,
                    StandInConnection {
                        process_id,
                        is_daemon_socket_bound,
                        methods: vec![method],
                    },
                )),
            }
        }
        connections
            .into_iter()
            .map(|(_, connection)| connection)
            .collect()
    }

    // The process of every service start, none while no service was launched.
    fn read_launches(&self) -> io::Result<Vec<u32>> {
        let lines = match std::fs::read_to_string(self.programs_folder.join(LAUNCHES_FILE)) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            read => read?,
        };
        lines
            .lines()
            .map(|line| line.parse().map_err(io::Error::other))
            .collect()
    }
}

impl Drop for CodexServiceStandIn {
    // A lasting service outlives the daemon that started it, so one a test left running is ended
    // here; one already gone has nothing to end.
    fn drop(&mut self) {
        let ended = self.read_launches().and_then(|launches| {
            for process_id in launches {
                if let Some(process) = pin_running_process(process_id)? {
                    process.kill()?;
                }
            }
            Ok(())
        });
        // A drop has no caller to fail, so a service left running is logged.
        if let Err(error) = ended {
            tracing::warn!(
                error = &error as &(dyn std::error::Error + 'static),
                "a stand-in Codex service could not be ended"
            );
        }
    }
}

/// A `codex` command whose service starts run this test program's `stand_in_test`, which serves
/// through [`serve_as_codex_service_stand_in`], recording at each connection's first request
/// whether `daemon_socket` is there; `None` where the system links or binds no local socket.
/// Panics where its folders or its command cannot be made.
pub fn stand_in_codex_service(
    stand_in_test: &str,
    daemon_socket: &Path,
) -> Option<CodexServiceStandIn> {
    if !CAN_LINK_A_SOCKET || !CAN_BIND_A_SOCKET_LISTENER {
        return None;
    }
    let folder = short_socket_folder().expect("a scratch folder is made");
    let codex_home = folder.path().join("c");
    let programs_folder = folder.path().join("bin");
    std::fs::create_dir(&codex_home).expect("the Codex folder is made");
    std::fs::create_dir(&programs_folder).expect("the programs folder is made");
    write_codex_service_script(&programs_folder, stand_in_test, Some(daemon_socket));
    Some(CodexServiceStandIn {
        codex_home,
        programs_folder,
        _folder: folder,
    })
}

/// A Codex service on an account home and the lasting terminal service on the person's own Codex
/// folder, both lasting services kept in their records, started on the stand-in by one daemon
/// whose own children `child_records` holds.
pub struct CodexServicesBeside {
    account: CodexServiceRegistry,
    terminal: CodexServiceRegistry,
    /// The process of the service on the account home, which outlives the daemon.
    pub account_process_id: u32,
    /// The process of the lasting terminal service, which outlives the daemon.
    pub lasting_process_id: u32,
}

impl CodexServicesBeside {
    /// Starts both under `folder` on the stand-in `script` runs, any child of the daemon's own
    /// recorded in `child_records`. Must be called within a multi-thread runtime. Panics where
    /// either does not start a process of its own.
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
                Arc::new(OneHome(CodexServiceHome { codex_home, kind })),
                test_codex_service_dependencies(
                    folder,
                    Arc::new(program),
                    Arc::new(UnheardEvents),
                    Arc::clone(child_records),
                ),
            )
        };
        let account = start(
            "account",
            CodexHomeKind::Account(test_provider_account_id()),
        );
        let terminal = start("own", CodexHomeKind::PersonalFolder);
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
    let service = registry
        .service_for(&test_provider_account_id())
        .await
        .expect("the home resolves");
    service
        .ensure_started(CODEX_SERVICE_STARTUP_TIMEOUT)
        .await
        .expect("the service starts");
    service
        .process_identity()
        .expect("the service runs a process of its own")
        .process_id
}
