//! The start a test builds providers on: a database and a home folder, and the providers built on
//! them as the daemon's start builds them.

use std::sync::Arc;

use sidekicks_contracts::session::id::SessionId;
use sidekicks_ipc::caller_process::system_reader::ProcessTableReader;
use sidekicks_platforms::{Spawner, WallClockTimer};
use sidekicks_policy::shell_commands::reading_bound::ShellLineReadingBound;
use sidekicks_provider::driver::child_records::UnrecordedChildren;
use sidekicks_provider::driver::contract::{MockProviderDriver, ProviderDriver};
use sidekicks_provider::driver::test_registry::{NothingServed, registrations_of_first_providers};
use sidekicks_session::attention::changes::attention_changes_after_commits;
use sidekicks_std::scheduler::Scheduler;
use sidekicks_store::credential_store::os::{KEYCHAIN_CALL_TIMEOUT, KeychainTurn};
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::test_file::TestDatabase;
use sidekicks_store::events::log_service::test_fixture::open_log;
use sidekicks_workspace::git::process::{GitLimits, GitRunner};
use sidekicks_workspace::git::worktree::naming::worktrees_folder;
use tempfile::TempDir;
use tokio::runtime::Handle;

use crate::daemon::process::providers::{ProviderStart, Providers, build_providers};
use crate::daemon::schema::schema_parts;

/// The statements the tests' read pool caches.
const READ_STATEMENT_CAPACITY: usize = 16;

/// The most line bytes the tests' bound lets the shell-line reader parse at once.
const SHELL_LINE_LIMIT: usize = 1 << 20;

/// The database and the home folder a test's providers are built on.
pub(crate) struct TestStart {
    database: TestDatabase,
    /// The home folder the providers run under.
    pub(crate) home: TempDir,
}

impl TestStart {
    /// A fresh database and home folder.
    pub(crate) fn new() -> Self {
        Self {
            database: TestDatabase::new(schema_parts()),
            home: tempfile::tempdir().expect("the test makes a home folder"),
        }
    }

    /// The providers of `drivers`, registered as the table's first providers in order and built as
    /// the daemon's start builds them, on this start's database and home; each driver keeps no
    /// private folder.
    pub(crate) async fn build(&self, drivers: Vec<MockProviderDriver>) -> Providers {
        let drivers = drivers
            .into_iter()
            .map(|mut driver| {
                driver.expect_private_file_folders().returning(Vec::new);
                Arc::new(driver) as Arc<dyn ProviderDriver>
            })
            .collect();
        let log = open_log(&self.database, None).await;
        let spawner = Spawner::new(Handle::current()).expect("the spawner thread starts");
        let base_environment: Arc<[(String, String)]> = Arc::from([]);
        build_providers(
            &registrations_of_first_providers(drivers),
            ProviderStart {
                spawner: spawner.clone(),
                data_folder: self.home.path().join("data"),
                home_folder: self.home.path().to_owned(),
                worktrees_folder: worktrees_folder(self.home.path()),
                session_token_path: self.home.path().join("daemon.token"),
                reads: Arc::new(DatabaseReadPool::new(
                    self.database.path(),
                    READ_STATEMENT_CAPACITY,
                )),
                writer: Arc::clone(&log.writer),
                read_damaged_from_sequence: Arc::new(|_: &SessionId| None),
                attachments: Arc::new(NothingServed),
                git: GitRunner::new(
                    spawner,
                    None,
                    Arc::clone(&base_environment),
                    GitLimits::DAEMON,
                ),
                base_environment,
                shell_lines: Arc::new(ShellLineReadingBound::new(SHELL_LINE_LIMIT)),
                scheduler: Arc::new(Scheduler::start(
                    Arc::new(WallClockTimer::new().expect("the test arms a wall clock")),
                    None,
                    tokio::sync::watch::channel(0).1,
                )),
                caller_processes: Arc::new(
                    ProcessTableReader::for_this_program().expect("this program's reader builds"),
                ),
                build_record_readers: Arc::new(attention_changes_after_commits().1),
                child_records: Arc::new(UnrecordedChildren),
                keychain_turn: KeychainTurn::new(KEYCHAIN_CALL_TIMEOUT),
            },
        )
    }
}
