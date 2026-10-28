//! The database schema, composed of named parts, each the tables, indexes and triggers one module
//! owns, and the store's own parts. A module's list holds the lists of the modules it builds on and
//! then its own part, so a part's foreign keys and triggers name only tables an earlier part made;
//! the program closes the daemon's whole list into the one schema it opens its file with. Every
//! table is STRICT, so a column refuses a value of the wrong storage class instead of keeping it;
//! JSON columns are TEXT. Every closed set a column holds is written from the enum that declares
//! it. There are no migrations: a table or column a feature needs is added to its module's part.

use std::borrow::Cow;
use std::sync::Arc;

use crate::machine::schema::MACHINE_SCHEMA_SQL;

mod compaction_calibrations;
mod daemon_configuration;
mod event_log;
mod provider_accounts;
pub mod recovery;
pub mod session_directory;

/// The event log's table, by the name the schema creates it under and the reads that look for it
/// by name use.
pub const SESSION_EVENTS_TABLE: &str = "session_events";

/// One named piece of the database schema: the tables, indexes and triggers one module owns.
#[derive(Clone, Debug)]
pub struct SchemaPart {
    name: &'static str,
    sql: Cow<'static, str>,
}

impl SchemaPart {
    /// The part `name`, whose `sql` creates its objects.
    pub fn new(name: &'static str, sql: impl Into<Cow<'static, str>>) -> Self {
        Self {
            name,
            sql: sql.into(),
        }
    }
}

/// An ordered list of schema parts in which each part appears once, by name.
#[derive(Clone, Debug, Default)]
pub struct SchemaParts {
    parts: Vec<SchemaPart>,
}

impl SchemaParts {
    /// This list with `part` appended, unless a part of its name is already in it.
    #[must_use]
    pub fn with_part(mut self, part: SchemaPart) -> Self {
        if !self.parts.iter().any(|kept| kept.name == part.name) {
            self.parts.push(part);
        }
        self
    }

    /// This list with each of `other`'s parts appended in order, each one this list lacks by name.
    #[must_use]
    pub fn with_parts(self, other: SchemaParts) -> Self {
        other.parts.into_iter().fold(self, Self::with_part)
    }

    /// The schema these parts make: their SQL in order, and its fingerprint.
    pub fn into_schema(self) -> DatabaseSchema {
        let sql: String = self.parts.iter().map(|part| part.sql.as_ref()).collect();
        // The first 31 bits of the SQL's BLAKE3 hash, so the fingerprint is a positive `i32`.
        let hash = blake3::hash(sql.as_bytes());
        let [first, second, third, fourth, ..] = *hash.as_bytes();
        let bits = u32::from_be_bytes([first, second, third, fourth]) >> 1;
        DatabaseSchema {
            sql: Arc::from(sql),
            fingerprint: i32::try_from(bits).expect("31 bits fit an i32"),
        }
    }
}

/// The schema a database is opened with: its whole SQL and its fingerprint, which the open writes
/// into the file's `user_version` with the schema, so a later open can tell a file another build
/// or another schema made.
#[derive(Clone, Debug)]
pub struct DatabaseSchema {
    sql: Arc<str>,
    fingerprint: i32,
}

impl DatabaseSchema {
    /// Every table, index and trigger of the schema, as one script.
    pub fn sql(&self) -> &str {
        &self.sql
    }

    /// The schema's fingerprint, the first 31 bits of the BLAKE3 hash of its SQL.
    pub fn fingerprint(&self) -> i32 {
        self.fingerprint
    }
}

/// The store's own parts: the event log, the session directory, this machine, the daemon's
/// configuration, the recovery's records, the provider accounts and the compaction calibrations,
/// in foreign-key order.
pub fn schema_parts() -> SchemaParts {
    SchemaParts::default()
        .with_part(SchemaPart::new(
            "event_log",
            event_log::event_log_schema_sql(),
        ))
        .with_part(SchemaPart::new(
            "session_directory",
            session_directory::session_directory_schema_sql(),
        ))
        .with_part(SchemaPart::new("machine", MACHINE_SCHEMA_SQL))
        .with_part(SchemaPart::new(
            "daemon_configuration",
            daemon_configuration::daemon_configuration_schema_sql(),
        ))
        .with_part(SchemaPart::new("recovery", recovery::recovery_schema_sql()))
        .with_part(SchemaPart::new(
            "provider_accounts",
            provider_accounts::provider_accounts_schema_sql(),
        ))
        .with_part(SchemaPart::new(
            "compaction_calibrations",
            compaction_calibrations::COMPACTION_CALIBRATIONS_SCHEMA_SQL,
        ))
}
