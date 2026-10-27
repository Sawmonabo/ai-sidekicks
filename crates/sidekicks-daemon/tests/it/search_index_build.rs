//! The live index's build, run as the daemon's own program in its `index` mode: a close during
//! the build settles only once the build's process has exited.

use std::path::Path;
use std::time::Duration;

use sidekicks_daemon::database::connection::writer_open::SEARCH_INDEX_FOLDER_NAME;
use sidekicks_daemon::database::schema::session_directory::insert_session_row;
use sidekicks_daemon::database::writer::test_file::TestDatabase;
use sidekicks_daemon::remote::shared_ports::schema::schema_parts;
use sidekicks_daemon::session::search::index::live::test_services::TestDaemonServices;
use sidekicks_daemon::session::search::index::live::{LiveIndex, LiveIndexOptions};
use sidekicks_platforms::{PinnedProcess, pin_child_process};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

use crate::helpers::{daemon_program, spawner};

/// Sessions enough that the build runs for seconds, so the close lands well inside it.
const SESSION_COUNT: usize = 30_000;

/// The bound on each wait, for the build's process and for the close, so a build that never
/// starts or a close that never settles fails the test.
const WAIT_BOUND: Duration = Duration::from_secs(30);

/// How often the process table is read while the test waits for the build's process.
const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(10);

/// Stores `SESSION_COUNT` titled sessions in the test's database, in one transaction.
fn store_titled_sessions(database: &TestDatabase) {
    let mut connection = database.opener()().expect("the test creates its database");
    let transaction = connection
        .transaction()
        .expect("the test's transaction begins");
    for number in 1..=SESSION_COUNT {
        insert_session_row(
            &transaction,
            &format!("session-{number}"),
            Some("Billing fix"),
            None,
        );
    }
    transaction.commit().expect("the test's sessions commit");
}

/// The build's process: a child of this test process whose command line names `index_folder`,
/// since other tests in this binary start the same program. The command lines are read only for
/// this process's children, which keeps each read of the table cheap.
fn find_build_process(system: &mut System, index_folder: &Path) -> Option<Pid> {
    let test_process = Pid::from_u32(std::process::id());
    // Processes only: a thread is listed as a child of its process, and is never the build.
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().without_tasks(),
    );
    let children: Vec<Pid> = system
        .processes()
        .values()
        .filter(|process| process.parent() == Some(test_process))
        .map(sysinfo::Process::pid)
        .collect();
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&children),
        true,
        ProcessRefreshKind::nothing()
            .without_tasks()
            .with_cmd(UpdateKind::Always),
    );
    children.into_iter().find(|child| {
        system.process(*child).is_some_and(|process| {
            process
                .cmd()
                .iter()
                .any(|argument| argument == index_folder.as_os_str())
        })
    })
}

/// Waits for the build's process to appear and pins it, so its exit can be read after the close
/// has ended it.
async fn pin_build_process(index_folder: &Path) -> PinnedProcess {
    // On Linux the process table would otherwise keep each process's `stat` file open.
    sysinfo::set_open_files_limit(0);
    let mut system = System::new();
    loop {
        if let Some(build) = find_build_process(&mut system, index_folder) {
            return pin_child_process(build.as_u32()).expect("the build's process is pinned");
        }
        tokio::time::sleep(PROCESS_POLL_INTERVAL).await;
    }
}

// Fails, by construction, a close that returns once the build's stop is canceled without waiting
// for the build to end: the build's process is then still running, so its record still reads. A
// build dropped and killed with no wait is caught on Linux in practice and races on macOS.
#[tokio::test]
async fn a_close_during_a_build_settles_once_the_build_has_exited() {
    let database = TestDatabase::new(schema_parts());
    store_titled_sessions(&database);
    let services = TestDaemonServices::open(&database).await;
    let folder = tempfile::tempdir().expect("the test makes a temporary folder");
    let index_folder = folder.path().join(SEARCH_INDEX_FOLDER_NAME);
    let live = LiveIndex::start(LiveIndexOptions {
        database_path: database.path(),
        index_folder: index_folder.clone(),
        program: daemon_program(),
        spawner: spawner(),
        reads: services.reads,
        writer: services.writer,
        scheduler: services.scheduler,
    });
    // A build that fails to start fails the live index at once, so its failure ends the wait.
    let build = tokio::time::timeout(WAIT_BOUND, async {
        tokio::select! {
            build = pin_build_process(&index_folder) => build,
            failure = live.when_failed() => panic!("the missing index's build fails: {failure:?}"),
        }
    })
    .await
    .expect("the missing index's build starts");

    tokio::time::timeout(WAIT_BOUND, live.close())
        .await
        .expect("the close settles")
        .expect("the close ends the build");

    // Read with no await after the close, so nothing but the close itself can have ended it.
    assert!(
        build.record().expect("the build's process reads").is_none(),
        "the close settles only once the build's process has exited"
    );
    assert!(
        !index_folder
            .try_exists()
            .expect("the index folder's presence reads"),
        "the close landed during the build, which placed nothing"
    );
}
