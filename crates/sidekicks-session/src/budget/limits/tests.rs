use rstest::rstest;
use sidekicks_contracts::session::cost::{TokensPerRun, UsdMicros};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};
use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions};

use super::{SessionLimits, effective_tokens_per_run, read_session_limits, write_session_limits};
use crate::budget::schema::schema_parts;

// A database holding the budget table, opened by its writer.
async fn open_budgets() -> (TestDatabase, DatabaseWriter) {
    let database = TestDatabase::new(schema_parts());
    let writer = DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
        .await
        .expect("the writer opens its database");
    (database, writer)
}

async fn write(writer: &DatabaseWriter, session_id: SessionId, limits: SessionLimits) {
    writer
        .write(vec![write_session_limits(
            session_id,
            limits,
            &WireInstant::now(),
        )])
        .await
        .expect("the limits are written");
}

fn tokens(count: u64) -> TokensPerRun {
    TokensPerRun(SafeInt::new(count).expect("the test's limit is a safe integer"))
}

fn limits(spend: Option<u64>, tokens_per_run: Option<u64>) -> SessionLimits {
    SessionLimits {
        spend_limit: spend.map(|spend| UsdMicros(SafeInt::new(spend).expect("a safe integer"))),
        tokens_per_run: tokens_per_run.map(tokens),
    }
}

// Killed by the upsert's `DO UPDATE` dropped: the second write then fails on the key, or, written
// `DO NOTHING`, leaves the first limits in place.
#[tokio::test]
async fn a_write_round_trips_and_a_second_write_replaces_the_row() {
    let (database, writer) = open_budgets().await;
    let session_id = test_session_id();
    let first = limits(Some(2_500_000), Some(40_000));
    write(&writer, session_id, first).await;
    assert_eq!(
        read_session_limits(&database.reader(), session_id).expect("the row reads"),
        Some(first)
    );

    let second = limits(None, Some(1));
    write(&writer, session_id, second).await;
    let reader = database.reader();
    assert_eq!(
        read_session_limits(&reader, session_id).expect("the row reads"),
        Some(second)
    );
    let rows: i64 = reader
        .query_row("SELECT count(*) FROM session_budgets", [], |row| row.get(0))
        .expect("the rows count");
    assert_eq!(rows, 1);
}

// Killed by either CHECK dropped: its refused value is then kept.
#[rstest]
#[case::negative_spend("-1", "NULL", false)]
#[case::zero_tokens("NULL", "0", false)]
#[case::both_unlimited("NULL", "NULL", true)]
#[case::both_at_their_floors("0", "1", true)]
#[tokio::test]
async fn the_limits_hold_their_floors_and_take_unlimited(
    #[case] spend: &str,
    #[case] tokens_per_run: &str,
    #[case] is_kept: bool,
) {
    let (database, _writer) = open_budgets().await;
    let inserted = database.reader().execute(
        &format!(
            "INSERT INTO session_budgets
               (session_id, spend_limit_usd_micros, tokens_per_run, updated_at)
             VALUES ('{}', {spend}, {tokens_per_run}, '{}')",
            test_session_id(),
            WireInstant::now().as_str()
        ),
        [],
    );
    assert_eq!(inserted.is_ok(), is_kept, "{inserted:?}");
}

// Killed by the fallback order swapped: the configuration's value then wins over the row's.
#[tokio::test]
async fn a_session_row_answers_over_the_configuration() {
    let (database, writer) = open_budgets().await;
    let configured = Some(tokens(500_000));
    let [limited, unlimited, unset] = [(); 3].map(|()| test_session_id());
    write(&writer, limited, limits(None, Some(40_000))).await;
    write(&writer, unlimited, limits(Some(0), None)).await;
    let reader = database.reader();
    let effective = |session_id| {
        effective_tokens_per_run(&reader, session_id, configured).expect("the row reads")
    };
    assert_eq!(effective(limited), Some(tokens(40_000)));
    assert_eq!(effective(unlimited), None);
    assert_eq!(effective(unset), configured);
}
