//! The usage record's sightings: a request its provider sees from several sources is priced once,
//! whatever order its sightings arrive in.

use rstest::rstest;
use sidekicks_contracts::event::usage::UsageSighting;
use sidekicks_contracts::event::usage::UsageSightingSource;
use sidekicks_contracts::event::usage::UsageSightingSource::{Export, File, Stream};
use sidekicks_contracts::wire::text::BoundedText;
use sidekicks_provider::account::usage_turns::sightings::release_account_sightings_statement;
use sidekicks_provider::port::usage_sink::{MeteredUsageOwner, UsageSink};
use sidekicks_provider::run::state_entry::RunStateEntry;
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, named_bindings};

use super::{Harness, account};
use crate::run::state_change::{RunStateChange, RunWriteCompanions};
use crate::usage_record::reads::read_tally_seed;

// The key every sighting of a case carries: its two requests, where it has two, are equal in it.
const MATCH_KEY: &str = "thread-1:110:0:0:10:0:0";

// One sighting: its source, for a file line the line's own id of its request, and whether it was
// filed as the session's own spend, with no live turn; `None` for a reading with no sighting, as a
// provider that sees each request once sends.
type Seen = Option<(UsageSightingSource, Option<&'static str>, bool)>;

impl Harness {
    // Records one reading of 110 tokens with `seen` as its sighting, on the lead's run unless the
    // sighting was filed as the session's spend.
    async fn see(&self, seen: Seen) {
        let owner = match seen {
            Some((_, _, true)) => MeteredUsageOwner::Session,
            Some((_, _, false)) | None => MeteredUsageOwner::Run,
        };
        let mut metered = self.metered(owner, None, 100, 10, 0);
        metered.delta.sighting = seen.map(|(source, response_id, _)| UsageSighting {
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

    // The tokens the lead run's count holds when rebuilt from the store, as after a restart.
    fn seeded_run_tokens(&self) -> u64 {
        read_tally_seed(&self.database.reader(), self.session_id, self.lead_run_id)
            .expect("the run's count reads")
            .map_or(0, |tally| tally.token_count)
    }

    // Runs `statement` on the store as its write would.
    fn run(&self, statement: &WriteStatement) {
        let bindings = match &statement.bindings {
            StatementBindings::Named(bindings) => Some(bindings),
            StatementBindings::None | StatementBindings::Positional(_) => None,
        }
        .expect("the statement binds by name");
        self.database
            .reader()
            .execute(&statement.sql, named_bindings(bindings).as_slice())
            .expect("the statement runs");
    }

    // How many sightings the store keeps.
    fn sightings(&self) -> i64 {
        self.database
            .reader()
            .query_row("SELECT count(*) FROM usage_sightings", [], |row| row.get(0))
            .expect("the sightings count")
    }

    // Moves the lead run into the state `entry` names, as the run engine writes it.
    async fn move_lead_run(&self, entry: RunStateEntry) {
        self.engine
            .transition(
                RunStateChange::new(self.lead_run_id, entry),
                RunWriteCompanions::default(),
            )
            .await
            .expect("the lead run moves");
    }

    // The tokens the lead run's count holds.
    async fn run_tokens(&self) -> u64 {
        let slot = self.engine.run_usage_tally(self.lead_run_id);
        slot.lock()
            .await
            .as_ref()
            .map_or(0, |tally| tally.token_count)
    }
}

const S: Seen = Some((Stream, None, false));
const E: Seen = Some((Export, None, false));
const E_ON_SESSION: Seen = Some((Export, None, true));
const F1: Seen = Some((File, Some("resp-1"), false));
const F2: Seen = Some((File, Some("resp-2"), false));

// Every arrival order of a request's stream frame, export record and a file line prices one row,
// a line read again prices none, and two requests equal in their key price two in any interleaving.
// The run counts each request's tokens once, a request filed as the session's spend included once
// a later sighting of it lands on the run, and the count rebuilt from the store holds the same. The
// key holds no session, service, account or time, and the record lives only in the store, so a
// settle, a move to another service or a restart between two sightings decides nothing else.
// Killed by pricing a sighting the record already holds (two or three rows), by marking a record
// from the sighting's own source (row 9 prices one), by leaving out the file key check (a second
// read prices again), by a sighting with none taking a record (two plain readings price one), by
// a sighting passed over counting nothing or always counting (a run past 110 or at 0), and by
// remembering a key once for two requests filed on the session (the run at 110, not 220), and by
// a passed-over sighting's tokens kept only in memory or counted again by a later mark (the
// rebuilt count at 0 or 220 where the live one is 110).
#[rstest]
#[case::stream_export_line(&[S, E, F1], 1, 110)]
#[case::stream_line_export(&[S, F1, E], 1, 110)]
#[case::export_stream_line(&[E, S, F1], 1, 110)]
#[case::export_line_stream(&[E, F1, S], 1, 110)]
#[case::line_stream_export(&[F1, S, E], 1, 110)]
#[case::line_export_stream(&[F1, E, S], 1, 110)]
#[case::stream_then_export(&[S, E], 1, 110)]
#[case::export_then_stream(&[E, S], 1, 110)]
#[case::export_then_line(&[E, F1], 1, 110)]
#[case::line_then_export(&[F1, E], 1, 110)]
#[case::stream_then_line(&[S, F1], 1, 110)]
#[case::line_then_stream(&[F1, S], 1, 110)]
#[case::line_only(&[F1], 1, 110)]
#[case::export_only(&[E], 1, 110)]
#[case::line_read_again_after_all_three(&[S, E, F1, F1], 1, 110)]
#[case::line_read_again_alone(&[F1, F1], 1, 110)]
#[case::line_read_again_after_its_export(&[E, F1, F1], 1, 110)]
#[case::two_requests_stream_and_export(&[S, S, E, E], 2, 220)]
#[case::two_requests_interleaved(&[S, E, S, E], 2, 220)]
#[case::two_requests_all_three(&[E, S, F1, S, E, F2], 2, 220)]
#[case::two_requests_lines_first(&[F1, F2, E, E, S, S], 2, 220)]
#[case::two_requests_crossed(&[S, F1, E, F2, E, S], 2, 220)]
#[case::two_requests_lines_read_again(&[F1, E, F2, E, F1, F2], 2, 220)]
#[case::readings_with_no_sighting(&[None, None], 2, 220)]
#[case::session_first_then_stream_and_line(&[E_ON_SESSION, S, F1], 1, 110)]
#[case::session_only(&[E_ON_SESSION], 1, 0)]
#[case::two_requests_on_the_session_first(&[E_ON_SESSION, E_ON_SESSION, S, S, F1, F2], 2, 220)]
#[tokio::test]
async fn each_request_is_priced_once_whatever_order_its_sightings_arrive_in(
    #[case] arrivals: &[Seen],
    #[case] priced: i64,
    #[case] run_tokens: u64,
) {
    let harness = Harness::new(Some(1_000_000), true).await;

    for seen in arrivals {
        harness.see(*seen).await;
    }

    assert_eq!(harness.priced_rows(), priced);
    assert_eq!(harness.run_tokens().await, run_tokens);
    assert_eq!(harness.seeded_run_tokens(), run_tokens);
}

// An export's three responses, each a request of its own, handed over together take one commit of
// the store's writer, each its own row. Killed by awaiting each reading's write before the next is
// sent (three commits).
#[tokio::test]
async fn a_hand_over_of_several_responses_takes_one_commit() {
    let harness = Harness::new(Some(1_000_000), true).await;
    let hand_over = (0..3)
        .map(|request| {
            let mut metered = harness.metered(MeteredUsageOwner::Run, None, 100 + request, 10, 0);
            metered.delta.sighting = Some(UsageSighting {
                match_key: BoundedText::new(format!("thread-1:request-{request}"))
                    .expect("the key fits"),
                source: Export,
                sighting_key: None,
            });
            metered
        })
        .collect();
    let commits_before = *harness.commits.borrow();

    let recorded = harness.record.record_metered_together(hand_over).await;

    assert!(
        recorded
            .iter()
            .all(|recorded| matches!(recorded, Ok(Some(_))))
    );
    assert_eq!(*harness.commits.borrow() - commits_before, 1);
    assert_eq!(harness.priced_rows(), 3);
}

// An account's removal while the run is interrupted keeps the record the run counts, so once the
// run is continued its count read again after a restart still holds the request a sighting on the
// session priced; a second interrupt keeps the record too, and once the run ends for good it goes.
// Killed by a removal that deletes every sighting of the account or reads an interrupt as the
// run's end (no sightings left, the rebuilt count at 0), by an interrupt that lets the record go
// (no sightings left after the second), and by a final state that keeps the removed account's
// record (two sightings left).
#[tokio::test]
async fn an_accounts_removal_keeps_what_a_live_run_counts_until_the_run_ends() {
    let harness = Harness::new(Some(1_000_000), true).await;
    let interrupted = || RunStateEntry::Interrupted {
        intended_close: None,
        trigger: None,
    };
    harness.see(E_ON_SESSION).await;
    harness.see(S).await;
    harness.move_lead_run(interrupted()).await;

    harness.run(&release_account_sightings_statement(&account()));
    harness
        .database
        .reader()
        .execute("DELETE FROM provider_accounts", [])
        .expect("the account's row is deleted");

    assert_eq!(harness.sightings(), 2);
    harness
        .move_lead_run(RunStateEntry::Running {
            execution_posture: None,
        })
        .await;
    assert_eq!(harness.seeded_run_tokens(), 110);
    harness.move_lead_run(interrupted()).await;
    assert_eq!(harness.sightings(), 2);
    harness
        .move_lead_run(RunStateEntry::Stopped {
            intended_close: None,
            trigger: None,
        })
        .await;
    assert_eq!(harness.sightings(), 0);
}
