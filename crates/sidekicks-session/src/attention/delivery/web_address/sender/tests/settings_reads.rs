//! The settings file's reads: the switch off drops what waits, the file decides over its
//! announcement, a read that fails during an attempt leaves it to run, and a pass whose read fails
//! is passed again a minute later.

use std::sync::atomic::Ordering;
use std::time::Duration;

use axum::http::StatusCode;
use rstest::rstest;
use sidekicks_platforms::WallClock as _;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::scheduler::armed_instant::ARM_RETRY_DELAY;

use super::{Fixture, requests, result_row};
use crate::attention::delivery::web_address::receiver_double::{Answer, serve_answers};
use crate::attention::delivery::web_address::sender::{RETRY_DELAYS, SEND_RETRY_JOB};

/// When the switch reads off against the messages waiting.
#[derive(Clone, Copy, Debug)]
enum SwitchedOff {
    WhileTheyWait,
    BeforeTheGateWrites,
    AcrossARestart,
}

// The switch off drops every pending delivery and waiting message, uncounted: at its off edge,
// for a delivery the gate writes after the edge, and at a start while it reads off; nothing is
// sent after. Mutations: the drop left to the next due try; the drop counted; a delivery written
// after the edge kept; a copy of the switch held in memory.
#[rstest]
#[case::while_they_wait(SwitchedOff::WhileTheyWait)]
#[case::before_the_gate_writes(SwitchedOff::BeforeTheGateWrites)]
#[case::across_a_restart(SwitchedOff::AcrossARestart)]
#[tokio::test]
async fn the_switch_off_drops_every_waiting_message_uncounted(#[case] when: SwitchedOff) {
    let (port, received) =
        serve_answers(vec![Answer::Status(StatusCode::INTERNAL_SERVER_ERROR)]).await;
    let mut fixture = Fixture::new(port).await;
    fixture.start().await;
    let (_, waiting) = fixture.waiting().await;
    fixture.until_delivery(&waiting, "pending", 1).await;

    let mut dropped = vec![waiting];
    match when {
        SwitchedOff::WhileTheyWait => fixture.switch(false),
        SwitchedOff::BeforeTheGateWrites => {
            fixture.switch(false);
            fixture.until_delivery(&dropped[0], "undelivered", 1).await;
            dropped.push(fixture.waiting().await.1);
        }
        SwitchedOff::AcrossARestart => {
            fixture.stop().await;
            fixture.switch(false);
            fixture.start().await;
        }
    }

    fixture
        .until("every pending delivery is dropped", |fixture| {
            dropped.iter().all(|entry| {
                fixture.delivery(entry).0.as_deref() == Some("undelivered")
                    && fixture.send(entry).is_none()
            })
        })
        .await;
    assert_eq!(
        fixture.outcome(),
        Some(result_row("refused", None, Some(500), 0))
    );
    fixture.switch(true);
    fixture.advance(Duration::from_hours(1));
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(requests(&received), 1, "nothing dropped is sent");
    fixture.stop().await;
}

// The settings file decides the switch even while its announcement reads otherwise: one attempt
// runs and the pass ends. Mutation: the attempt waiting on the announcement's current value, which
// ends it at once and turns the pass again without end.
#[tokio::test]
async fn the_file_decides_the_switch_over_its_announcement() {
    let (port, received) = serve_answers(vec![Answer::Status(StatusCode::OK)]).await;
    let mut fixture = Fixture::new(port).await;
    let mut announced = lock(&fixture.settings.settings).clone();
    announced.notifications.web_address.enabled = false;
    fixture.settings.announce.send_replace(announced);
    let (_, entry) = fixture.waiting().await;
    fixture.start().await;

    fixture.until_delivery(&entry, "delivered", 1).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(requests(&received), 1);
    assert_eq!(
        fixture.settings.reads.load(Ordering::SeqCst),
        2,
        "one pass and its one attempt read the file"
    );
    fixture.stop().await;
}

// A settings read that fails while an attempt is in flight is no change: the post completes once
// and its message is delivered. Mutation: the failed read ending the attempt and failing the pass,
// which leaves the message to a later post.
#[tokio::test]
async fn a_failed_read_during_an_attempt_leaves_it_to_run() {
    let (port, received) =
        serve_answers(vec![Answer::After(Duration::from_secs(2), StatusCode::OK)]).await;
    let mut fixture = Fixture::new(port).await;
    fixture.start().await;
    let (_, entry) = fixture.waiting().await;
    fixture
        .until("the attempt reaches the address", |_| {
            requests(&received) == 1
        })
        .await;
    fixture
        .settings
        .fails_next_read
        .store(true, Ordering::SeqCst);
    // The same settings announced again, which the attempt reads the file for.
    fixture.switch(true);

    fixture.until_delivery(&entry, "delivered", 1).await;
    assert!(
        !fixture.settings.fails_next_read.load(Ordering::SeqCst),
        "the attempt read the file at the announcement"
    );
    assert_eq!(requests(&received), 1);
    fixture.stop().await;
}

// A pass whose settings read fails while a retry 30 minutes out is armed is passed again a minute
// later on the monotonic clock, so a message due now goes then, not at the armed instant.
// Mutation: the pass's retry scheduled only while nothing is armed.
#[tokio::test]
async fn a_failed_pass_is_passed_again_a_minute_later_whatever_is_armed() {
    let (port, received) = serve_answers(vec![
        Answer::Status(StatusCode::INTERNAL_SERVER_ERROR),
        Answer::Status(StatusCode::INTERNAL_SERVER_ERROR),
        Answer::Status(StatusCode::INTERNAL_SERVER_ERROR),
        Answer::Status(StatusCode::OK),
    ])
    .await;
    let mut fixture = Fixture::new(port).await;
    fixture.start().await;
    let (_, retried) = fixture.waiting().await;
    fixture.until_delivery(&retried, "pending", 1).await;
    fixture.advance(RETRY_DELAYS[0]);
    fixture.until_delivery(&retried, "pending", 2).await;
    fixture.advance(RETRY_DELAYS[1]);
    fixture.until_delivery(&retried, "pending", 3).await;
    let armed = fixture.clock.now() + RETRY_DELAYS[2];
    fixture
        .until("the third retry is armed", |fixture| {
            fixture
                .sender()
                .timer
                .instant()
                .is_some_and(|instant| instant >= armed)
        })
        .await;

    fixture
        .settings
        .fails_next_read
        .store(true, Ordering::SeqCst);
    let (_, due_now) = fixture.waiting().await;
    fixture
        .until("the failed pass schedules its retry", |fixture| {
            fixture
                .scheduler
                .waiting_job_names()
                .contains(&SEND_RETRY_JOB)
        })
        .await;
    assert_eq!(
        fixture.delivery(&due_now),
        (Some("pending".to_owned()), Some(0))
    );
    tokio::time::pause();
    tokio::time::advance(ARM_RETRY_DELAY).await;
    tokio::time::resume();

    fixture.until_delivery(&due_now, "delivered", 1).await;
    assert_eq!(requests(&received), 4);
    assert_eq!(
        fixture.delivery(&retried),
        (Some("pending".to_owned()), Some(3)),
        "the armed retry still waits for its instant"
    );
    fixture.stop().await;
}
