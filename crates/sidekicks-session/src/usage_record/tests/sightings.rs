//! The usage record's sightings: a request its provider sees from several sources is priced once,
//! whatever order its sightings arrive in.

use rstest::rstest;
use sidekicks_contracts::event::usage::UsageSighting;
use sidekicks_contracts::event::usage::UsageSightingSource;
use sidekicks_contracts::event::usage::UsageSightingSource::{Export, File, Stream};
use sidekicks_contracts::wire::text::BoundedText;
use sidekicks_provider::port::usage_sink::{MeteredUsageOwner, UsageSink};

use super::Harness;

// The key every sighting of a case carries: its two requests, where it has two, are equal in it.
const MATCH_KEY: &str = "thread-1:110:0:0:10:0:0";

// One sighting: its source and, for a file line, the line's own id of its request; `None` for a
// reading with no sighting, as a provider that sees each request once sends.
type Seen = Option<(UsageSightingSource, Option<&'static str>)>;

impl Harness {
    // Records one reading with `seen` as its sighting.
    async fn see(&self, seen: Seen) {
        let mut metered = self.metered(MeteredUsageOwner::Run, None, 100, 10, 0);
        metered.delta.sighting = seen.map(|(source, response_id)| UsageSighting {
            match_key: BoundedText::new(MATCH_KEY.to_owned()).expect("the key fits"),
            source,
            sighting_key: response_id.and_then(|id| BoundedText::new(id.to_owned())),
        });
        self.record
            .record_metered(metered)
            .await
            .expect("the reading is recorded or passed over");
    }

    // How many rows the session's log priced.
    fn priced_rows(&self) -> i64 {
        self.database
            .reader()
            .query_row(
                "SELECT count(*) FROM session_events WHERE type = 'usage.tokenCount.recorded'",
                [],
                |row| row.get(0),
            )
            .expect("the rows count")
    }
}

const S: Seen = Some((Stream, None));
const E: Seen = Some((Export, None));
const F1: Seen = Some((File, Some("resp-1")));
const F2: Seen = Some((File, Some("resp-2")));

// Every arrival order of a request's stream frame, export record and rollout line prices one row,
// a line read again prices none, and two requests equal in their key price two in any interleaving.
// The key holds no session, service, account or time, and the record lives only in the store, so a
// settle, a move to another service or a restart between two sightings decides nothing else.
// Killed by pricing a sighting the record already holds (two or three rows), by marking a record
// from the sighting's own source (row 9 prices one), by leaving out the file key check (a second
// read prices again), and by a sighting with none taking a record (two plain readings price one).
#[rstest]
#[case::stream_export_line(&[S, E, F1], 1)]
#[case::stream_line_export(&[S, F1, E], 1)]
#[case::export_stream_line(&[E, S, F1], 1)]
#[case::export_line_stream(&[E, F1, S], 1)]
#[case::line_stream_export(&[F1, S, E], 1)]
#[case::line_export_stream(&[F1, E, S], 1)]
#[case::stream_then_export(&[S, E], 1)]
#[case::export_then_stream(&[E, S], 1)]
#[case::export_then_line(&[E, F1], 1)]
#[case::line_then_export(&[F1, E], 1)]
#[case::stream_then_line(&[S, F1], 1)]
#[case::line_then_stream(&[F1, S], 1)]
#[case::line_only(&[F1], 1)]
#[case::export_only(&[E], 1)]
#[case::line_read_again_after_all_three(&[S, E, F1, F1], 1)]
#[case::line_read_again_alone(&[F1, F1], 1)]
#[case::line_read_again_after_its_export(&[E, F1, F1], 1)]
#[case::two_requests_stream_and_export(&[S, S, E, E], 2)]
#[case::two_requests_interleaved(&[S, E, S, E], 2)]
#[case::two_requests_all_three(&[E, S, F1, S, E, F2], 2)]
#[case::two_requests_lines_first(&[F1, F2, E, E, S, S], 2)]
#[case::two_requests_crossed(&[S, F1, E, F2, E, S], 2)]
#[case::two_requests_lines_read_again(&[F1, E, F2, E, F1, F2], 2)]
#[case::readings_with_no_sighting(&[None, None], 2)]
#[tokio::test]
async fn each_request_is_priced_once_whatever_order_its_sightings_arrive_in(
    #[case] arrivals: &[Seen],
    #[case] priced: i64,
) {
    let harness = Harness::new(None, true).await;

    for seen in arrivals {
        harness.see(*seen).await;
    }

    assert_eq!(harness.priced_rows(), priced);
}
