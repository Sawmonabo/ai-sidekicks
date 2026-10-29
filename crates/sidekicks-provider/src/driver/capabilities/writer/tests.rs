use std::borrow::Cow;
use std::pin::pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use rusqlite::Connection;
use sidekicks_contracts::provider::driver::tools::{IdempotencyClass, ProviderToolMetadata};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_store::database::schema::SchemaPart;
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, named_bindings};
use sidekicks_store::database::writer::test_file::TestDatabase;
use tokio::sync::oneshot;

use super::{
    CapabilitySnapshotChange, DriverCapabilitiesWriterError, NoRecordReaders,
    test_capabilities_writer,
};
use crate::build_record::{BuildRecordReaders, RecordedProviderBuild, record_statements};
use crate::driver::PROVIDERS;
use crate::driver::capabilities::{
    DriverCapabilities, DriverCapabilityFlag, DriverCapabilityFlags,
};
use crate::driver::contract::params_and_results::{DriverCliVersionReport, GetCapabilitiesResult};
use crate::driver::schema::schema_parts;

const SENTINEL: &str = "2000-01-01T00:00:00.000Z";

// Long enough for a declare's read on a loaded machine, so only its held write outlasts it.
const GIVE_UP: Duration = Duration::from_secs(1);

fn provider() -> ProviderId {
    ProviderId::new(PROVIDERS[0].id.to_owned()).expect("a table id is a provider id")
}

fn reading(cli_version: &str) -> GetCapabilitiesResult {
    GetCapabilitiesResult {
        capabilities: DriverCapabilities {
            flags: DriverCapabilityFlags::from_fn(|flag| flag == DriverCapabilityFlag::Resume),
            contract_version: FreeFormText::new("1.0.0".to_owned()).expect("a version"),
        },
        tools: vec![ProviderToolMetadata {
            name: FreeFormText::new("Read".to_owned()).expect("a tool name"),
            idempotency_class: IdempotencyClass::Idempotent,
            description: None,
        }],
        cli_version: DriverCliVersionReport {
            raw_version: cli_version.to_owned(),
            parsed_version: Some(cli_version.to_owned()),
        },
        detection_source: None,
        output_speed_levels: None,
    }
}

// Every capability and tool row's refresh time, read through a connection of the test's own.
fn refreshed_at_of_capability_rows(connection: &Connection) -> Vec<String> {
    let mut statement = connection
        .prepare(
            "SELECT refreshed_at FROM driver_capabilities
             UNION ALL SELECT refreshed_at FROM driver_tools",
        )
        .expect("the test's read prepares");
    statement
        .query_map([], |row| row.get(0))
        .expect("the test's read runs")
        .collect::<rusqlite::Result<_>>()
        .expect("each row reads")
}

#[tokio::test]
async fn a_same_reading_writes_no_capability_row_and_a_new_build_rewrites_only_its_version() {
    let database = TestDatabase::new(schema_parts());
    let writer = test_capabilities_writer(&database, Arc::new(NoRecordReaders)).await;
    let provider = provider();
    let first = writer
        .declare(&provider, &reading("2.0.0"))
        .await
        .expect("the first reading is stored");
    assert_eq!(first.snapshot_change, CapabilitySnapshotChange::Created);
    let connection = database.reader();
    connection
        .execute_batch(&format!(
            "UPDATE driver_capabilities SET refreshed_at = '{SENTINEL}';
             UPDATE driver_tools SET refreshed_at = '{SENTINEL}';"
        ))
        .expect("the test marks every capability row");

    let same = writer
        .declare(&provider, &reading("2.0.0"))
        .await
        .expect("the same reading is declared");
    assert_eq!(same.snapshot_change, CapabilitySnapshotChange::Unchanged);
    assert!(!same.is_cli_version_refreshed);

    let new_build = writer
        .declare(&provider, &reading("2.1.0"))
        .await
        .expect("the new build's reading is declared");
    assert_eq!(
        new_build.snapshot_change,
        CapabilitySnapshotChange::Unchanged
    );
    assert!(new_build.is_cli_version_refreshed);

    let refreshed = refreshed_at_of_capability_rows(&connection);
    assert_ne!(refreshed, [] as [String; 0]);
    assert!(refreshed.iter().all(|at| at == SENTINEL));
    let stored_version: String = connection
        .query_row(
            "SELECT cli_version_raw FROM driver_contract_meta WHERE provider_name = ?",
            [provider.as_str()],
            |row| row.get(0),
        )
        .expect("the parent row reads");
    assert_eq!(stored_version, "2.1.0");
}

#[tokio::test]
async fn a_stored_flag_set_missing_a_flag_fails_the_rebuild() {
    let database = TestDatabase::new(schema_parts());
    let writer = test_capabilities_writer(&database, Arc::new(NoRecordReaders)).await;
    let provider = provider();
    writer
        .declare(&provider, &reading("2.0.0"))
        .await
        .expect("the reading is stored");
    database
        .reader()
        .execute(
            "DELETE FROM driver_capabilities WHERE provider_name = ? AND capability_flag = ?",
            [provider.as_str(), <&str>::from(DriverCapabilityFlag::Steer)],
        )
        .expect("the test removes one flag row");

    let rebuilt = writer.hydrate(&provider, PROVIDERS[0]).await;
    assert!(
        matches!(
            &rebuilt,
            Err(DriverCapabilitiesWriterError::FlagSetMismatch(mismatch))
                if mismatch.missing == [DriverCapabilityFlag::Steer]
                    && mismatch.unexpected.is_empty()
        ),
        "{rebuilt:?}"
    );
}

// A record row: its build, the build it moved from and whether it is retired.
type BuildRow = (String, Option<String>, bool);

// Marks each write to the record with a row, and counts the builds it is told were recorded.
#[derive(Default)]
struct MarkingReaders {
    recorded: AtomicUsize,
}

impl BuildRecordReaders for MarkingReaders {
    fn change_statements(&self) -> Vec<WriteStatement> {
        vec![WriteStatement {
            sql: Cow::Borrowed("INSERT INTO record_changes (marked) VALUES (1)"),
            bindings: StatementBindings::None,
            expected_row_count: Some(1),
        }]
    }

    fn build_recorded(&self) {
        self.recorded.fetch_add(1, Ordering::SeqCst);
    }
}

// The record's rows and how many writes marked a change, each of which told the readers once
// it committed.
fn record_and_changes(connection: &Connection, readers: &MarkingReaders) -> (Vec<BuildRow>, i64) {
    let rows = connection
        .prepare("SELECT version, from_version, retired_at IS NOT NULL FROM provider_builds")
        .expect("the test's read prepares")
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .expect("the test's read runs")
        .collect::<rusqlite::Result<_>>()
        .expect("each row reads");
    let changes = connection
        .query_row("SELECT count(*) FROM record_changes", [], |row| row.get(0))
        .expect("the markers count");
    assert_eq!(
        i64::try_from(readers.recorded.load(Ordering::SeqCst)).expect("a small count"),
        changes,
        "the readers are told of each recorded build once its write committed"
    );
    (rows, changes)
}

// A database whose record writes each mark a row, which `MarkingReaders` writes.
fn marked_database() -> TestDatabase {
    TestDatabase::new(schema_parts().with_part(SchemaPart::new(
        "record_changes",
        "CREATE TABLE record_changes (marked INTEGER NOT NULL) STRICT;",
    )))
}

// Points the stored pair back at `version`, as if the provider's command still ran it.
fn store_version(connection: &Connection, version: &str) {
    connection
        .execute(
            "UPDATE driver_contract_meta SET cli_version_raw = ?1, cli_version_semver = ?1",
            [version],
        )
        .expect("the test moves the stored pair");
}

fn installed(version: &str, from_version: &str, is_retired: bool) -> BuildRow {
    (
        version.to_owned(),
        Some(from_version.to_owned()),
        is_retired,
    )
}

#[tokio::test]
async fn a_new_printed_version_is_recorded_once_with_the_pair_it_moves() {
    let database = marked_database();
    let readers = Arc::new(MarkingReaders::default());
    let writer = test_capabilities_writer(
        &database,
        Arc::clone(&readers) as Arc<dyn BuildRecordReaders>,
    )
    .await;
    let provider = provider();
    let connection = database.reader();
    let declare = |version: &'static str| {
        let writer = &writer;
        let provider = &provider;
        async move {
            writer
                .declare(provider, &reading(version))
                .await
                .expect("the reading is declared");
        }
    };

    // A first declare, an unchanged version, alone or with new capabilities, and a stored row
    // with no version record nothing.
    declare("2.1.293").await;
    declare("2.1.293").await;
    let mut new_capabilities = reading("2.1.293");
    new_capabilities.tools.clear();
    writer
        .declare(&provider, &new_capabilities)
        .await
        .expect("the reading is declared");
    connection
        .execute_batch(
            "UPDATE driver_contract_meta SET cli_version_raw = NULL, cli_version_semver = NULL",
        )
        .expect("the test takes the stored version off");
    declare("2.1.293").await;
    assert_eq!(record_and_changes(&connection, &readers), (vec![], 0));

    declare("2.1.294").await;
    assert_eq!(
        record_and_changes(&connection, &readers),
        (vec![installed("2.1.294", "2.1.293", false)], 1)
    );

    // The same build declared again over the earlier one, listed or retired, is not recorded
    // again.
    store_version(&connection, "2.1.293");
    declare("2.1.294").await;
    assert_eq!(
        record_and_changes(&connection, &readers),
        (vec![installed("2.1.294", "2.1.293", false)], 1)
    );
    connection
        .execute_batch(&format!(
            "UPDATE provider_builds SET retired_at = '{SENTINEL}'"
        ))
        .expect("the test retires the build");
    store_version(&connection, "2.1.293");
    declare("2.1.294").await;
    assert_eq!(
        record_and_changes(&connection, &readers),
        (vec![installed("2.1.294", "2.1.293", true)], 1)
    );

    // An available build that the command then moves to is installed in place, and the
    // provider's earlier build leaves the record.
    connection
        .execute(
            "INSERT INTO provider_builds (provider_name, version, from_version, recorded_at)
             VALUES (?, '2.1.295', NULL, ?)",
            [provider.as_str(), SENTINEL],
        )
        .expect("the test records an available build");
    declare("2.1.295").await;
    assert_eq!(
        record_and_changes(&connection, &readers),
        (vec![installed("2.1.295", "2.1.294", false)], 2)
    );

    // An available build never overwrites the same build installed.
    let available = record_statements(
        &RecordedProviderBuild {
            provider: provider.clone(),
            version: "2.1.295".to_owned(),
            from_version: None,
            recorded_at: WireInstant::now(),
        },
        Vec::new(),
    );
    for statement in available {
        let StatementBindings::Named(values) = &statement.bindings else {
            unreachable!("the record binds by name");
        };
        connection
            .execute(&statement.sql, named_bindings(values).as_slice())
            .expect("the record's statement runs");
    }
    assert_eq!(
        record_and_changes(&connection, &readers).0,
        [installed("2.1.295", "2.1.294", false)]
    );
}

// A declare given up while its write waits behind a held writer keeps the provider's turn until
// that write commits: the readers are told of its recorded build once, at the commit, and the next
// declare, which waits on the turn rather than on the writer, reads the build it recorded. Killed
// by the readers never told for a given-up declare, and by the turn taken with `acquire` in place
// of `run_held`, which lets the next declare read the stored pair before the given-up write
// commits.
#[tokio::test]
async fn a_declare_given_up_while_its_write_waits_keeps_the_turn_until_it_commits() {
    let database = marked_database();
    let readers = Arc::new(MarkingReaders::default());
    let writer = Arc::new(
        test_capabilities_writer(
            &database,
            Arc::clone(&readers) as Arc<dyn BuildRecordReaders>,
        )
        .await,
    );
    let provider = provider();
    writer
        .declare(&provider, &reading("2.1.293"))
        .await
        .expect("the first reading is stored");
    let (held, is_held) = oneshot::channel();
    let (release, released) = oneshot::channel::<()>();
    let database_writer = Arc::clone(&writer.writer);
    let hold = tokio::spawn(async move {
        database_writer
            .hold_while(|| async move {
                held.send(()).expect("the test waits for the hold");
                released.await.expect("the test releases the hold");
            })
            .await;
    });
    is_held.await.expect("the writer is held");

    let given_up =
        tokio::time::timeout(GIVE_UP, writer.declare(&provider, &reading("2.1.294"))).await;
    assert!(
        given_up.is_err(),
        "the declare waits behind the held writer"
    );
    assert_eq!(readers.recorded.load(Ordering::SeqCst), 0);
    let held_alone = writer.declares.queue_handle_count(provider.clone());
    assert_ne!(
        held_alone, 0,
        "the given-up declare keeps the provider's turn"
    );
    let next_writer = Arc::clone(&writer);
    let next_provider = provider.clone();
    let next = tokio::spawn(async move {
        next_writer
            .declare(&next_provider, &reading("2.1.295"))
            .await
    });
    tokio::time::timeout(GIVE_UP, async {
        while writer.declares.queue_handle_count(provider.clone()) == held_alone {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the next declare waits on the provider's turn");
    assert_eq!(readers.recorded.load(Ordering::SeqCst), 0);

    // A second hold, queued behind the given-up write, keeps the next declare's write back while
    // the given-up one's commit is read.
    let (held_again, is_held_again) = oneshot::channel();
    let (release_again, released_again) = oneshot::channel::<()>();
    let mut hold_again = pin!(writer.writer.hold_while(|| async move {
        held_again
            .send(())
            .expect("the test waits for the second hold");
        released_again
            .await
            .expect("the test releases the second hold");
    }));
    assert!(
        futures::poll!(&mut hold_again).is_pending(),
        "the second hold is queued"
    );
    release.send(()).expect("the hold waits for its release");
    hold.await.expect("the hold ends");
    tokio::select! {
        () = &mut hold_again => unreachable!("the second hold ends only once released"),
        started = is_held_again => started.expect("the second hold starts"),
    }
    assert_eq!(
        record_and_changes(&database.reader(), &readers),
        (vec![installed("2.1.294", "2.1.293", false)], 1)
    );

    release_again
        .send(())
        .expect("the second hold waits for its release");
    hold_again.await;
    let next = next
        .await
        .expect("the next declare's task ends")
        .expect("the next reading is declared");
    assert_eq!(next.snapshot_change, CapabilitySnapshotChange::Unchanged);
    writer.writer.flush().await;
    assert_eq!(
        record_and_changes(&database.reader(), &readers),
        (vec![installed("2.1.295", "2.1.294", false)], 2)
    );
}
