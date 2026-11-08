use std::path::PathBuf;

use rusqlite::Connection;
use sidekicks_contracts::place::{Place, WindowsPlace};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::provider::settings::{ProviderInstallation, ProviderVersion};
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_platforms::ubuntu_place;
use sidekicks_store::database::statement::{WriteStatement, run_statement};
use sidekicks_store::database::writer::test_file::TestDatabase;

use super::{
    CommandTarget, MarkerAnswer, MarkerEtag, forget_place, read_place_reading, read_place_readings,
    record_check, record_marker,
};
use crate::driver::schema::schema_parts;

fn database() -> (TestDatabase, Connection) {
    let database = TestDatabase::new(schema_parts());
    let connection = database.opener()().expect("the test creates its database");
    (database, connection)
}

// Runs `statement` as the writer runs it, holding it to its expected row count.
fn run(connection: &Connection, statement: &WriteStatement) {
    let ran = run_statement(connection, statement).expect("the reading's statement runs");
    if let Some(expected) = statement.expected_row_count {
        assert_eq!(ran.row_count, expected);
    }
}

fn provider() -> ProviderId {
    ProviderId::new("claude".to_owned()).expect("a provider id")
}

fn instant(text: &str) -> WireInstant {
    WireInstant::try_from(text.to_owned()).expect("an instant")
}

fn version(text: &str) -> ProviderVersion {
    ProviderVersion::new(text.to_owned()).expect("a version")
}

fn installed(raw: &str) -> ProviderInstallation {
    ProviderInstallation::Installed {
        raw_version: version(raw),
        parsed_version: None,
        latest_version: None,
    }
}

fn target(path: &str, identity: &str) -> CommandTarget {
    CommandTarget {
        resolved_path: PathBuf::from(path),
        identity: identity.parse().expect("an identity's text"),
        size: 4096,
        modified_at: jiff::Timestamp::new(1_700_000_000, 123_456_789).expect("a time"),
    }
}

// A second check of one key replaces the first's facts and keeps the marker's answer, and a check
// that finds nothing keeps no version and no file. Killed by the upsert's update dropping the
// marker pair or keeping the old versions or file (the table's checks refuse that write), and by a
// second row for the same key.
#[test]
fn a_second_check_replaces_the_facts_and_keeps_the_markers_answer() {
    let (_database, connection) = database();
    let provider = provider();
    let place = ubuntu_place();
    let answer = MarkerAnswer {
        etag: MarkerEtag::new("\"abc\"".to_owned()).expect("an ETag"),
        build: version("2.1.316"),
    };
    run(
        &connection,
        &record_check(
            &provider,
            Some(&place),
            &installed("2.1.309"),
            Some(&target("/usr/local/bin/claude", "1:2")),
            &instant("2026-11-01T10:00:00.000Z"),
        ),
    );
    run(
        &connection,
        &record_marker(&provider, Some(&place), &answer),
    );
    run(
        &connection,
        &record_check(
            &provider,
            Some(&place),
            &ProviderInstallation::NotInstalled {},
            None,
            &instant("2026-11-01T11:00:00.000Z"),
        ),
    );

    let readings = read_place_readings(&connection, &provider).expect("the readings read");
    assert_eq!(readings.len(), 1);
    let reading = &readings[0];
    assert_eq!(reading.place, Some(place));
    assert_eq!(reading.installation, ProviderInstallation::NotInstalled {});
    assert_eq!(reading.target, None);
    assert_eq!(reading.checked_at, instant("2026-11-01T11:00:00.000Z"));
    assert_eq!(reading.marker, Some(answer));
}

// The one-place key `''` and a WSL place are two rows of one provider, each read by its own key,
// and a place never checked has no reading. Killed by the place dropped from the key, and by the
// one-place key read back as a place.
#[test]
fn each_place_is_its_own_row_and_an_unchecked_place_has_no_reading() {
    let (_database, connection) = database();
    let provider = provider();
    let place = ubuntu_place();
    run(
        &connection,
        &record_check(
            &provider,
            None,
            &installed("2.1.316"),
            Some(&target("/opt/claude", "3:4")),
            &instant("2026-11-01T10:00:00.000Z"),
        ),
    );
    assert_eq!(
        read_place_reading(&connection, &provider, Some(&place)).expect("the reading reads"),
        None
    );
    run(
        &connection,
        &record_check(
            &provider,
            Some(&place),
            &ProviderInstallation::NotInstalled {},
            None,
            &instant("2026-11-01T11:00:00.000Z"),
        ),
    );

    assert_eq!(
        read_place_readings(&connection, &provider)
            .expect("the readings read")
            .len(),
        2
    );
    let one_place = read_place_reading(&connection, &provider, None)
        .expect("the one-place reading reads")
        .expect("the one-place reading is stored");
    assert_eq!(one_place.place, None);
    assert_eq!(one_place.installation, installed("2.1.316"));
    let distribution = read_place_reading(&connection, &provider, Some(&place))
        .expect("the distribution's reading reads")
        .expect("the distribution's reading is stored");
    assert_eq!(distribution.place, Some(place));
    assert_eq!(
        distribution.installation,
        ProviderInstallation::NotInstalled {}
    );
}

// An installed reading reads back its three versions and its file exactly, the time to the
// nanosecond. Killed by a version or a target column bound to the wrong name or read from the
// wrong index.
#[test]
fn an_installed_reading_round_trips_its_versions_and_file() {
    let (_database, connection) = database();
    let provider = provider();
    let installation = ProviderInstallation::Installed {
        raw_version: version("2.1.309 (Claude Code)"),
        parsed_version: Some(version("2.1.309")),
        latest_version: Some(version("2.1.316")),
    };
    let file = target(
        "/home/me/.local/share/claude/versions/2.1.309",
        "64769:340282366920938463463374607431768211455",
    );
    run(
        &connection,
        &record_check(
            &provider,
            Some(&Place::Windows(WindowsPlace::Value)),
            &installation,
            Some(&file),
            &instant("2026-11-01T10:00:00.000Z"),
        ),
    );

    let reading = read_place_reading(
        &connection,
        &provider,
        Some(&Place::Windows(WindowsPlace::Value)),
    )
    .expect("the reading reads")
    .expect("the reading is stored");
    assert_eq!(reading.installation, installation);
    assert_eq!(reading.target, Some(file));
    assert_eq!(reading.marker, None);
}

// Forgetting a distribution removes that place's reading alone. Killed by the place dropped from
// the delete's predicate.
#[test]
fn forgetting_a_place_removes_only_its_reading() {
    let (_database, connection) = database();
    let provider = provider();
    let place = ubuntu_place();
    for place in [None, Some(&place)] {
        run(
            &connection,
            &record_check(
                &provider,
                place,
                &ProviderInstallation::NotInstalled {},
                None,
                &instant("2026-11-01T10:00:00.000Z"),
            ),
        );
    }

    run(&connection, &forget_place(&provider, &place));

    let readings = read_place_readings(&connection, &provider).expect("the readings read");
    assert_eq!(
        readings
            .iter()
            .map(|reading| reading.place.clone())
            .collect::<Vec<_>>(),
        [None]
    );
}
