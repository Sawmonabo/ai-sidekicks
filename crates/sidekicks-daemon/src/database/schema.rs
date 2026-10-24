//! The daemon's whole SQLite schema, created once, in one transaction, on a database that has none
//! of it. Every table is STRICT, so a column refuses a value of the wrong storage class instead of
//! keeping it; JSON columns are TEXT. Every closed set a column holds is written from the enum that
//! declares it. There are no migrations: a table or column a feature needs is added here.

use std::sync::LazyLock;

use crate::approvals::schema::APPROVAL_SCHEMA_SQL;
use crate::artifacts::schema::ARTIFACT_SCHEMA_SQL;
use crate::git::worktree::schema::WORKTREE_SCHEMA_SQL;
use crate::plans::schema::PLAN_SCHEMA_SQL;
use crate::questions::schema::QUESTION_SCHEMA_SQL;
use crate::session::search::index::schema::SEARCH_INDEX_SCHEMA_SQL;
use crate::workflow::schema::WORKFLOW_SCHEMA_SQL;
use crate::workspace::schema::WORKSPACE_SCHEMA_SQL;

mod daemon_configuration;
mod event_log;
mod machine;
mod provider_accounts;
mod provider_drivers;
pub(crate) mod recovery;
mod runs;
mod session_directory;

/// The event log's table, by the name the schema creates it under and the reads that look for it
/// by name use.
pub(crate) const SESSION_EVENTS_TABLE: &str = "session_events";

/// Every table, index and trigger of the daemon's database, in foreign-key order; the search
/// index's triggers follow the tables they watch.
pub static DAEMON_SCHEMA_SQL: LazyLock<String> = LazyLock::new(|| {
    [
        event_log::event_log_schema_sql().as_str(),
        session_directory::session_directory_schema_sql().as_str(),
        &SEARCH_INDEX_SCHEMA_SQL,
        machine::MACHINE_SCHEMA_SQL,
        daemon_configuration::daemon_configuration_schema_sql().as_str(),
        provider_drivers::provider_drivers_schema_sql().as_str(),
        &WORKSPACE_SCHEMA_SQL,
        &WORKTREE_SCHEMA_SQL,
        runs::runs_schema_sql().as_str(),
        recovery::recovery_schema_sql().as_str(),
        provider_accounts::provider_accounts_schema_sql().as_str(),
        &APPROVAL_SCHEMA_SQL,
        &WORKFLOW_SCHEMA_SQL,
        &ARTIFACT_SCHEMA_SQL,
        &PLAN_SCHEMA_SQL,
        &QUESTION_SCHEMA_SQL,
    ]
    .concat()
});

/// The schema's fingerprint, the first 31 bits of the BLAKE3 hash of [`DAEMON_SCHEMA_SQL`]: written
/// into the file's `user_version` with the schema, so an open can tell a file another build made.
pub static DAEMON_SCHEMA_FINGERPRINT: LazyLock<i32> = LazyLock::new(|| {
    let hash = blake3::hash(DAEMON_SCHEMA_SQL.as_bytes());
    let [first, second, third, fourth, ..] = *hash.as_bytes();
    let bits = u32::from_be_bytes([first, second, third, fourth]) >> 1;
    i32::try_from(bits).expect("31 bits fit an i32")
});
