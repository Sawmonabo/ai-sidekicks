//! How a reviewer's block is recorded: on the row of its call, refused when none can come, and
//! beside the session's raised cards without touching them.

use std::sync::Arc;

use rstest::rstest;
use serde_json::json;
use sidekicks_contracts::approval::ApprovalCategory;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_provider::driver::contract::MockProviderDriver;

use super::{ANSWER_WAIT, Fixture};
use crate::reviewer_denials::ReviewerDenialError;
use crate::service::tests::from_json;
use crate::store::{InsertedApprovalRequest, insert_request_statement};

impl Fixture {
    /// Raises one card on the fixture's run, its row written as the approval service writes it.
    async fn raise_card(&self) {
        let card = InsertedApprovalRequest {
            approval_request_id: from_json(json!(mint_uuid_v7())),
            session_id: self.session_id,
            run_id: self.run_id,
            requested_by: from_json(json!("agent")),
            category: ApprovalCategory::ToolExecution,
            scope: from_json(json!("Bash")),
            resource_descriptor: from_json(json!({
                "subject": "git push",
                "standingAllowOffered": true,
                "projectScopeOffered": false,
                "editable": true,
            })),
            ask_id: None,
            created_at: WireInstant::now(),
        };
        self.log
            .writer
            .write(vec![insert_request_statement(&card)])
            .await
            .expect("the test raises the card");
    }

    /// Each card's state and its whole row, in raise order.
    fn cards(&self) -> Vec<(String, String)> {
        self.database
            .reader()
            .prepare(
                "SELECT state, json_array(id, session_id, run_id, requested_by, category, scope,
                   resource_descriptor, ask_id, state, created_at, updated_at)
                 FROM approval_requests ORDER BY created_at, id",
            )
            .expect("the test's read prepares")
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .expect("the test reads the cards")
            .collect::<Result<_, _>>()
            .expect("each card reads")
    }

    /// How many answers the cards hold.
    fn answers(&self) -> i64 {
        self.database
            .reader()
            .query_row("SELECT count(*) FROM approval_resolutions", [], |row| {
                row.get(0)
            })
            .expect("the test counts the answers")
    }
}

// Two blocks of one call that arrived before its row wait for it, and its commit records both on
// it, each its own block. Killed by settling one waiter per key, and by a block that does not wait.
#[tokio::test]
async fn blocks_that_came_before_their_row_are_each_recorded_on_it() {
    let fixture = Fixture::new(MockProviderDriver::new(), MockProviderDriver::new()).await;
    let (first, release_first) = fixture
        .take_until_waiting(fixture.block(fixture.run_id, "call-1"))
        .await;
    let (second, release_second) = fixture
        .take_until_waiting(fixture.block(fixture.run_id, "call-1"))
        .await;

    let row = fixture.open_call(fixture.run_id, "call-1").await;
    release_first.send(()).expect("the first block is held");
    release_second.send(()).expect("the second block is held");

    for taken in [first, second] {
        tokio::time::timeout(ANSWER_WAIT, taken)
            .await
            .expect("the block is answered")
            .expect("the block's task ends")
            .expect("the block is recorded");
    }
    assert_eq!(fixture.recorded_rows(), vec![row.clone(), row]);
}

// A row committed while the block's read still runs, after the read found none, wakes the block,
// which is recorded on it. Killed by arming the wait after the read.
#[tokio::test]
async fn a_row_committed_while_the_block_reads_carries_it() {
    let fixture = Fixture::new(MockProviderDriver::new(), MockProviderDriver::new()).await;
    let pause = fixture.denials.row_query_pause.arm();
    let denials = Arc::clone(&fixture.denials);
    let block = fixture.block(fixture.run_id, "call-1");
    let taken = tokio::spawn(async move { denials.take(block).await });
    tokio::time::timeout(ANSWER_WAIT, pause.reached)
        .await
        .expect("the read finds no row")
        .expect("the read is held on the pool's thread");

    let row = fixture.open_call(fixture.run_id, "call-1").await;
    pause.release.send(()).expect("the read is held");

    tokio::time::timeout(ANSWER_WAIT, taken)
        .await
        .expect("the block is answered")
        .expect("the block's task ends")
        .expect("the block is recorded");
    assert_eq!(fixture.recorded_rows(), vec![row]);
}

/// When the block's run ends with no row for it.
#[derive(Clone, Copy, Debug)]
enum RunEnd {
    /// Before the block arrives.
    BeforeTheBlock,
    /// While the block waits.
    WhileItWaits,
}

// A block whose run ends with no row for it is refused and nothing is recorded. Killed by
// dropping the run-end wake, and by a read that waits on an ended run.
#[rstest]
#[case::before_the_block(RunEnd::BeforeTheBlock)]
#[case::while_it_waits(RunEnd::WhileItWaits)]
#[tokio::test]
async fn a_block_whose_run_ends_without_its_row_is_refused(#[case] run_end: RunEnd) {
    let fixture = Fixture::new(MockProviderDriver::new(), MockProviderDriver::new()).await;
    let block = fixture.block(fixture.run_id, "call-1");

    let taken = match run_end {
        RunEnd::BeforeTheBlock => {
            fixture
                .database
                .reader()
                .execute(
                    "UPDATE runs SET state = 'completed' WHERE run_id = ?1",
                    [fixture.run_id.text().as_str()],
                )
                .expect("the test ends the run");
            fixture.take(block).await
        }
        RunEnd::WhileItWaits => {
            let (taken, release) = fixture.take_until_waiting(block).await;
            fixture.end_run(fixture.run_id).await;
            release.send(()).expect("the block is held");
            tokio::time::timeout(ANSWER_WAIT, taken)
                .await
                .expect("the block is answered")
                .expect("the block's task ends")
        }
    };

    assert!(matches!(taken, Err(ReviewerDenialError::NoRow { .. })));
    assert_eq!(fixture.recorded_rows(), Vec::<String>::new());
}

// The daemon's stop refuses a waiting block, and a block taken after it is refused rather than
// left waiting or recorded, whether or not it names a call; nothing is recorded. Killed by a stop
// that drops the waiters unsettled, and by either intake not reading the stop.
#[tokio::test]
async fn the_stop_refuses_every_block_waiting_or_later() {
    let mut fixture = Fixture::new(MockProviderDriver::new(), MockProviderDriver::new()).await;
    let (waiting, release) = fixture
        .take_until_waiting(fixture.block(fixture.run_id, "call-1"))
        .await;

    let attachment = fixture
        .attachment
        .take()
        .expect("the fixture follows the log");
    fixture.denials.stop(attachment);
    release.send(()).expect("the block is held");

    let waited = tokio::time::timeout(ANSWER_WAIT, waiting)
        .await
        .expect("the block is answered")
        .expect("the block's task ends");
    assert!(matches!(waited, Err(ReviewerDenialError::Stopped)));
    let later = fixture.take(fixture.block(fixture.run_id, "call-2")).await;
    assert!(matches!(later, Err(ReviewerDenialError::Stopped)));
    let mut call_less = fixture.block(fixture.run_id, "unused");
    call_less.tool_call_id = None;
    let later_call_less = fixture.take(call_less).await;
    assert!(matches!(later_call_less, Err(ReviewerDenialError::Stopped)));
    assert_eq!(fixture.recorded_rows(), Vec::<String>::new());
}

/// Where an older opening of the blocked call sits.
#[derive(Clone, Copy, Debug)]
enum OlderOpening {
    /// In an earlier run: the block waits for its own run's row.
    InAnEarlierRun,
    /// Earlier in the block's run: the newest opening carries the block.
    InTheSameRun,
}

// A block lands on the newest opening of its call in its own run, never on an older run's row
// with the same call id. Killed by dropping the run filter, and by reading the oldest opening.
#[rstest]
#[case::in_an_earlier_run(OlderOpening::InAnEarlierRun)]
#[case::in_the_same_run(OlderOpening::InTheSameRun)]
#[tokio::test]
async fn a_block_lands_on_the_newest_opening_of_its_call_in_its_run(#[case] older: OlderOpening) {
    let fixture = Fixture::new(MockProviderDriver::new(), MockProviderDriver::new()).await;
    let row = match older {
        OlderOpening::InAnEarlierRun => {
            let block_run = fixture.queue_run().await;
            fixture.open_call(fixture.run_id, "call-1").await;
            let (taken, release) = fixture
                .take_until_waiting(fixture.block(block_run, "call-1"))
                .await;
            let row = fixture.open_call(block_run, "call-1").await;
            release.send(()).expect("the block is held");
            tokio::time::timeout(ANSWER_WAIT, taken)
                .await
                .expect("the block is answered")
                .expect("the block's task ends")
                .expect("the block is recorded");
            row
        }
        OlderOpening::InTheSameRun => {
            fixture.open_call(fixture.run_id, "call-1").await;
            let row = fixture.open_call(fixture.run_id, "call-1").await;
            fixture
                .take(fixture.block(fixture.run_id, "call-1"))
                .await
                .expect("the block is recorded");
            row
        }
    };

    assert_eq!(fixture.recorded_rows(), vec![row]);
}

// A block on a run with a raised card leaves the card as it was: pending, its row unchanged and
// no answer recorded. Killed by a block that settles or answers a pending approval request.
#[tokio::test]
async fn a_block_leaves_a_raised_card_as_it_was() {
    let fixture = Fixture::new(MockProviderDriver::new(), MockProviderDriver::new()).await;
    fixture.raise_card().await;
    let raised = fixture.cards();

    fixture.recorded_block().await;

    assert_eq!(raised.len(), 1);
    assert_eq!(raised[0].0, "pending");
    assert_eq!(fixture.cards(), raised);
    assert_eq!(fixture.answers(), 0);
}
