//! The stand-in Codex service a test program runs as itself: the `codex` script a service starts,
//! which runs one of the test program's own tests, that test's body, which records its launch,
//! listens and answers as Codex does, records each request and ends once the test program that
//! wrote the script ends, what a test reads of those records, the guard that ends every launch a
//! test leaves running, and the two kinds of service one daemon starts on it side by side.

use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use interprocess::local_socket::traits::tokio::Listener as _;
use serde::{Deserialize, Serialize};
use sidekicks_platforms::{
    CAN_BIND_A_SOCKET_LISTENER, CAN_LINK_A_SOCKET, LeftoverSweep, ProcessRecord,
    bind_socket_listener, pin_running_process, replace_file_atomically, replace_socket_link,
    short_socket_folder,
};
use tempfile::TempDir;

use super::{
    TestCodexProgram, UnheardEvents, answer_as_codex_service, codex_folder_environment,
    test_codex_service_dependencies,
};
use crate::driver::child_records::DaemonChildRecords;
use crate::driver::codex::lifecycle::CODEX_SERVICE_STARTUP_TIMEOUT;
use crate::driver::codex::service::home::{CodexHomeKind, CodexServiceHome};
use crate::driver::codex::service::registry::{
    CodexServiceRegistry, OneHome, capability_read_home, home_socket_path,
};
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

// The file a stand-in adds its launch to; only its script sets it.
const LAUNCH_RECORD_NAME: &str = "SIDEKICKS_TEST_LAUNCH_RECORD";

// The process record of the test program that wrote the script, whose end ends every stand-in
// the script starts; only its script sets it.
const OWNER_NAME: &str = "SIDEKICKS_TEST_OWNER";

// The daemon socket whose presence a stand-in records at each connection's first request; only
// its script sets it, and only where a test names one.
const DAEMON_SOCKET_NAME: &str = "SIDEKICKS_TEST_DAEMON_SOCKET";

/// Where a stand-in's script keeps its own standard output, which an executor stand-in answers on,
/// since the test program's own output goes nowhere.
const EXECUTOR_OUTPUT: &str = "/dev/fd/3";

// The address Codex's executor listens on, its standard input and output.
const EXECUTOR_LISTEN_ADDRESS: &str = "stdio";

// The file each stand-in service listening on a socket adds its launch to, one to a line.
const LAUNCHES_FILE: &str = "codex-launches";

// The file a stand-in's requests are recorded in, one line each.
const CONNECTIONS_FILE: &str = "codex-connections";

/// The `codex` script a stand-in service starts through, with the guard over every service it
/// launched: each one still running when the script drops is ended, and the drop fails the test
/// where one cannot be.
pub struct CodexServiceScript {
    path: PathBuf,
    launches: StandInLaunches,
}

impl CodexServiceScript {
    /// The script's path, the program a service starts as Codex.
    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// Writes in `folder` the `codex` script a stand-in service starts through and answers it with
/// the guard over its launches. The script keeps its arguments in [`LAUNCH_ARGUMENTS_FILE`],
/// names the files its launches and requests are recorded in, the writing test program as the
/// stand-in's owner and, where `daemon_socket` is given, the socket whose presence it records,
/// has the program ignore the hang-up where its environment asks, keeps its own standard output as
/// [`EXECUTOR_OUTPUT`] for an executor's answers, and runs this test program's `stand_in_test`,
/// whose own output goes nowhere. Panics where it cannot be written.
pub fn write_codex_service_script(
    folder: &Path,
    stand_in_test: &str,
    daemon_socket: Option<&Path>,
) -> CodexServiceScript {
    let program = std::env::current_exe().expect("the test program names itself");
    let owner =
        serde_json::to_string(&own_process_record()).expect("a process record is written as JSON");
    let path = folder.join("codex");
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
         {LAUNCH_RECORD_NAME}='{}'; export {LAUNCH_RECORD_NAME}\n\
         {OWNER_NAME}='{owner}'; export {OWNER_NAME}\n\
         {CONNECTION_RECORD_NAME}='{}'; export {CONNECTION_RECORD_NAME}\n{daemon_socket}\
         if [ -n \"${HANG_UP_IGNORED_NAME}\" ]; then trap '' HUP; fi\n\
         exec 3>&1\n\
         exec '{}' --exact {stand_in_test} --include-ignored >/dev/null 2>&1\n",
        folder.join(LAUNCH_ARGUMENTS_FILE).display(),
        folder.join(LAUNCHES_FILE).display(),
        folder.join(CONNECTIONS_FILE).display(),
        program.display()
    );
    replace_file_atomically(&path, body.as_bytes(), 0o755, LeftoverSweep::Unswept)
        .expect("the script is written");
    CodexServiceScript {
        path,
        launches: StandInLaunches::in_folder(folder),
    }
}

// This process's record, which a later process pins it by. Panics where it cannot be read.
fn own_process_record() -> ProcessRecord {
    pin_running_process(std::process::id())
        .and_then(|process| process.expect("this process runs").record())
        .expect("this process reads its own record")
        .expect("this process runs")
}

/// Serves as a Codex service where a stand-in's script started this program: on a real socket of
/// its own, with the path its `--listen` names made a link to it, its launch recorded first,
/// answering each connection as a start needs and recording each request in the script's record
/// until the test program that wrote the script ends; or, started as Codex's executor on its
/// standard input and output, as that executor. Returns at once where no script started it or its
/// test program has already ended. Panics where its launch cannot be recorded, its socket cannot
/// listen or its link cannot be made.
pub async fn serve_as_codex_service_stand_in() {
    let Ok(address) = std::env::var(LISTEN_ADDRESS_NAME) else {
        return;
    };
    if address == EXECUTOR_LISTEN_ADDRESS {
        serve_as_executor_stand_in();
        return;
    }
    let owner: ProcessRecord =
        serde_json::from_str(&std::env::var(OWNER_NAME).expect("the owner is named"))
            .expect("the owner's record reads");
    let Some(owner) = owner.pin().expect("the owner's process reads") else {
        return;
    };
    let codex_home = PathBuf::from(std::env::var(CODEX_HOME_NAME).expect("the home is named"));
    record_launch(&codex_home);
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
    // A stand-in outlives the daemon that launched it, so it ends with its test program however
    // that program ends, a kill included; a watch that fails ends it too.
    let owner_end = owner.wait_for_end();
    tokio::pin!(owner_end);
    loop {
        let stream = tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok(stream) => stream,
                Err(_) => return,
            },
            _ = &mut owner_end => return,
        };
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

// Adds this process's launch on `codex_home` to the script's launches, in one write of a whole
// line to a file opened to append, so lines never interleave. Panics where it cannot be recorded.
fn record_launch(codex_home: &Path) {
    let launch = StandInLaunch {
        codex_home: codex_home.to_owned(),
        process: own_process_record(),
    };
    let mut line = serde_json::to_string(&launch).expect("a launch is written as JSON");
    line.push('\n');
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(std::env::var_os(LAUNCH_RECORD_NAME).expect("the launches are named"))
        .and_then(|mut launches| launches.write_all(line.as_bytes()))
        .expect("the launch is recorded");
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

/// One start of a stand-in service listening on a socket, as the stand-in recorded it.
#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct StandInLaunch {
    /// The Codex home it served.
    pub(crate) codex_home: PathBuf,
    /// Its process, pinned through the record, so a later process given its id is never taken
    /// for it.
    pub(crate) process: ProcessRecord,
}

/// The launches a stand-in's script recorded in one folder, and the guard over them: each launch
/// still running when it drops is ended, and the drop fails the test where one cannot be, unless
/// the test already fails.
pub(crate) struct StandInLaunches {
    file: PathBuf,
}

impl StandInLaunches {
    /// The launches of the script in `folder`.
    pub(crate) fn in_folder(folder: &Path) -> Self {
        Self {
            file: folder.join(LAUNCHES_FILE),
        }
    }

    /// Every launch, in order; none while no service was launched. Fails where the record cannot
    /// be read or a line does not read as a launch.
    pub(crate) fn read(&self) -> io::Result<Vec<StandInLaunch>> {
        let lines = match std::fs::read_to_string(&self.file) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            read => read?,
        };
        lines
            .lines()
            .map(|line| serde_json::from_str(line).map_err(io::Error::other))
            .collect()
    }

    // Ends every launch still running, each tried whatever the others met; fails with every
    // error met, once all are tried.
    fn end_running(&self) -> io::Result<()> {
        let errors: Vec<String> = self
            .read()?
            .into_iter()
            .filter_map(|launch| {
                let ended = launch
                    .process
                    .pin()
                    .and_then(|process| process.map_or(Ok(false), |process| process.kill()));
                ended.err().map(|error| error.to_string())
            })
            .collect();
        if errors.is_empty() {
            return Ok(());
        }
        Err(io::Error::other(errors.join("; ")))
    }
}

impl Drop for StandInLaunches {
    fn drop(&mut self) {
        let ended = self.end_running();
        // A test already failing keeps its own failure; otherwise a launch left running fails it.
        if !std::thread::panicking() {
            ended.expect("every stand-in service the test launched ends");
        }
    }
}

/// A `codex` command alone on a daemon's search path, beside a person's own Codex folder, whose
/// every service start runs a test program's stand-in service: a test reads the process each
/// start launched and, connection by connection, what each asked. Ends every service it started
/// that still runs when it drops.
pub struct CodexServiceStandIn {
    codex_home: PathBuf,
    programs_folder: PathBuf,
    capability_read_home: PathBuf,
    // Declared before the folder, so the launches are read before the folder is removed.
    script: CodexServiceScript,
    _folder: TempDir,
}

impl CodexServiceStandIn {
    /// The environment a daemon's providers start in to take this folder as the person's own
    /// Codex folder and the stand-in's command as their `codex`.
    pub fn provider_environment(&self) -> Vec<(String, String)> {
        codex_folder_environment(&self.codex_home, &self.programs_folder)
    }

    /// The process of every service start but the capability read's, in order: the services
    /// launched on the person's own Codex folder, and any launched elsewhere. Panics where the
    /// record cannot be read.
    pub fn launches(&self) -> Vec<u32> {
        self.script
            .launches
            .read()
            .expect("the launches read")
            .into_iter()
            .filter(|launch| launch.codex_home != self.capability_read_home)
            .map(|launch| launch.process.id())
            .collect()
    }

    /// Each connection a service of [`Self::launches`] answered, in the order of its first
    /// request. Panics where the record cannot be read.
    pub fn connections(&self) -> Vec<StandInConnection> {
        let launches = self.launches();
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
            .filter(|connection| launches.contains(&connection.process_id))
            .collect()
    }
}

/// A `codex` command whose service starts run this test program's `stand_in_test`, which serves
/// through [`serve_as_codex_service_stand_in`], recording at each connection's first request
/// whether `daemon_socket` is there, for a daemon on `data_folder`, whose capability read's
/// launch is told apart; `None` where the system links or binds no local socket. Panics where its
/// folders or its command cannot be made.
pub fn stand_in_codex_service(
    stand_in_test: &str,
    daemon_socket: &Path,
    data_folder: &Path,
) -> Option<CodexServiceStandIn> {
    if !CAN_LINK_A_SOCKET || !CAN_BIND_A_SOCKET_LISTENER {
        return None;
    }
    let folder = short_socket_folder().expect("a scratch folder is made");
    let codex_home = folder.path().join("c");
    let programs_folder = folder.path().join("bin");
    std::fs::create_dir(&codex_home).expect("the Codex folder is made");
    std::fs::create_dir(&programs_folder).expect("the programs folder is made");
    let script = write_codex_service_script(&programs_folder, stand_in_test, Some(daemon_socket));
    Some(CodexServiceStandIn {
        codex_home,
        programs_folder,
        capability_read_home: capability_read_home(data_folder),
        script,
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
