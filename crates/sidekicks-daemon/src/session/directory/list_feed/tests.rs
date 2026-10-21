//! The live sessions list's tests: a change behind the paged opening read, a slow subscriber held
//! to one place per session, a purge's removal, and the renewal running only while a session runs.

use std::sync::Arc;
use std::time::Duration;

use rusqlite::{Connection, params};
use serde_json::json;
use sidekicks_contracts::session::directory::{
    SessionActivity, SessionListChange, SessionListEntry,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::FreeFormText;
use tokio::time::timeout;

use crate::database::writer::test_file::{TestDatabase, test_envelope, test_session_id};
use crate::events::log_service::EventLogAppendOptions;
use crate::events::log_service::tests::{TestLog, open_log};
use crate::ipc::stream::feed::{CreditGate, Feed as _};
use crate::session::directory::list_feed::subscriber::SessionListSubscriber;
use crate::session::directory::list_feed::{SessionListFeed, SessionListOpening};
use crate::session::directory::test_rows::insert_session_row;
use crate::uuid_v7::mint_uuid_v7;

// Past the renewal interval, so a paused clock reaches a renewal before the wait ends.
const WAIT: Duration = Duration::from_secs(30);

fn name_of(entry: &SessionListEntry) -> Option<&str> {
    match entry {
        SessionListEntry::Project(project) => project.name.as_ref().map(FreeFormText::as_str),
        SessionListEntry::Chat(chat) => chat.name.as_ref().map(FreeFormText::as_str),
    }
}

fn rename(connection: &Connection, session_id: SessionId, name: &str) {
    connection
        .execute(
            "UPDATE sessions SET name = ?1 WHERE id = ?2",
            params![name, session_id.text().as_str()],
        )
        .expect("the test renames the session's row");
}

// An event of the session's log, so its follower names the session.
async fn append_event(log: &TestLog, session_id: SessionId) {
    let event = serde_json::from_value(json!({
        "type": "agent.toolCall.invoked",
        "payload": { "sessionId": session_id, "runId": mint_uuid_v7().to_string(), "toolName": "Read" },
    }))
    .expect("the test writes an agent.toolCall.invoked event");
    log.service
        .append(
            test_envelope(session_id, &event),
            EventLogAppendOptions::default(),
        )
        .await
        .expect("the event is appended");
}

async fn next_change(
    subscriber: &mut SessionListSubscriber,
    gate: &CreditGate,
) -> SessionListChange {
    timeout(WAIT, subscriber.next(gate))
        .await
        .expect("a change comes")
        .expect("the list reads")
        .expect("the stream goes on")
}

// The first upsert of `session_id`, passing over every other change.
async fn upsert_of(
    subscriber: &mut SessionListSubscriber,
    gate: &CreditGate,
    session_id: SessionId,
) -> SessionListEntry {
    loop {
        if let SessionListChange::Upsert { entry, .. } = next_change(subscriber, gate).await {
            let is_session = match &*entry {
                SessionListEntry::Project(project) => project.session_id == session_id,
                SessionListEntry::Chat(chat) => chat.session_id == session_id,
            };
            if is_session {
                return *entry;
            }
        }
    }
}

// Catches the follower attached only once the list is held, which would miss a change committed
// while the opening read ran, and a second subscription reading the rows again rather than waiting
// for the read under way: the held opening serves the session as read, then its newest entry.
#[tokio::test]
async fn a_change_behind_the_opening_read_follows_it_and_a_second_opening_waits_for_it() {
    let database = TestDatabase::new();
    let log = open_log(&database, None).await;
    let session_id = test_session_id();
    insert_session_row(
        &database.reader(),
        session_id.text().as_str(),
        Some("before"),
        None,
    );
    let feed = SessionListFeed::for_test(&database, &log.followers);
    let paused = feed.opening_read_pause.arm();
    let first = tokio::spawn({
        let feed = Arc::clone(&feed);
        async move { feed.open().await.expect("the list opens") }
    });
    paused.reached.await.expect("the opening read finishes");
    let mut second = tokio::spawn({
        let feed = Arc::clone(&feed);
        async move { feed.open().await.expect("the list opens") }
    });
    rename(&database.reader(), session_id, "after");
    append_event(&log, session_id).await;
    assert!(
        timeout(Duration::from_millis(200), &mut second)
            .await
            .is_err(),
        "a second opening waits for the read under way"
    );
    paused.release.send(()).expect("the opening is held");

    let SessionListOpening {
        sessions,
        mut subscriber,
        ..
    } = first.await.expect("the opening task ends");
    assert_eq!(
        sessions.iter().map(name_of).collect::<Vec<_>>(),
        [Some("before")]
    );
    let gate = CreditGate::with_credit(1);
    let newest = upsert_of(&mut subscriber, &gate, session_id).await;
    assert_eq!(name_of(&newest), Some("after"));
    drop(second.await.expect("the second opening ends"));
}

// Catches a queue of changes in place of one place per session, a change sent before the pages, and
// a purged session that never leaves: a subscriber whose gate stayed shut through three renames
// sends one upsert carrying the last, and a removed row leaves the list with the chats count less.
#[tokio::test]
async fn a_slow_subscriber_sends_the_newest_entry_once_and_a_purge_removes_it() {
    let database = TestDatabase::new();
    let log = open_log(&database, None).await;
    let (renamed, purged, kept) = (test_session_id(), test_session_id(), test_session_id());
    let connection = database.reader();
    for session_id in [renamed, purged, kept] {
        insert_session_row(&connection, session_id.text().as_str(), None, None);
    }
    let feed = SessionListFeed::for_test(&database, &log.followers);
    let slow = feed.open().await.expect("the list opens");
    assert_eq!(slow.chat_count.get(), 3);
    assert!(slow.is_complete, "three rows fit the acknowledgment");
    let mut slow = slow.subscriber;
    let mut watching = feed.open().await.expect("the list opens").subscriber;
    let open_gate = CreditGate::with_credit(1);

    for name in ["one", "two", "three"] {
        rename(&connection, renamed, name);
        append_event(&log, renamed).await;
    }
    // The open subscriber is told in the same pass as the slow one, so once it sees the last name
    // the slow one holds the session's place.
    while name_of(&upsert_of(&mut watching, &open_gate, renamed).await) != Some("three") {}

    let newest = upsert_of(&mut slow, &open_gate, renamed).await;
    assert_eq!(name_of(&newest), Some("three"));
    assert!(
        timeout(Duration::from_millis(300), slow.next(&open_gate))
            .await
            .is_err(),
        "one place per session: nothing more waits"
    );

    connection
        .execute(
            "DELETE FROM sessions WHERE id = ?1",
            params![purged.text().as_str()],
        )
        .expect("the test deletes the purged session's row");
    feed.refresh([purged]);
    match next_change(&mut slow, &open_gate).await {
        SessionListChange::Remove {
            session_id,
            chat_count,
        } => {
            assert_eq!(session_id, purged);
            assert_eq!(chat_count.get(), 2);
        }
        other @ (SessionListChange::Page { .. } | SessionListChange::Upsert { .. }) => {
            panic!("a purged session leaves the list, not {other:?}")
        }
    }
}

// Catches an always-running renewal timer: a running session is sent again each interval, and
// once no session runs no interval sends anything.
#[tokio::test(start_paused = true)]
async fn the_renewal_runs_only_while_a_session_runs() {
    let database = TestDatabase::new();
    let log = open_log(&database, None).await;
    let session_id = test_session_id();
    let connection = database.reader();
    insert_session_row(&connection, session_id.text().as_str(), None, None);
    let run_id = mint_uuid_v7().to_string();
    connection
        .execute(
            "INSERT INTO runs (run_id, session_id, state, run_version) VALUES (?1, ?2, 'running', 0)",
            params![run_id, session_id.text().as_str()],
        )
        .expect("the test stores a running run");
    let feed = SessionListFeed::for_test(&database, &log.followers);
    let opening = feed.open().await.expect("the list opens");
    let mut subscriber = opening.subscriber;
    let gate = CreditGate::with_credit(1);

    let renewed = upsert_of(&mut subscriber, &gate, session_id).await;
    assert_eq!(activity_of(&renewed), SessionActivity::Running);

    connection
        .execute(
            "UPDATE runs SET state = 'completed' WHERE run_id = ?1",
            params![run_id],
        )
        .expect("the test ends the run");
    feed.refresh([session_id]);
    let ended = upsert_of(&mut subscriber, &gate, session_id).await;
    assert_ne!(activity_of(&ended), SessionActivity::Running);
    assert!(
        timeout(Duration::from_secs(60), subscriber.next(&gate))
            .await
            .is_err(),
        "no renewal runs once no session runs"
    );
}

fn activity_of(entry: &SessionListEntry) -> SessionActivity {
    match entry {
        SessionListEntry::Project(project) => project.activity,
        SessionListEntry::Chat(chat) => chat.activity,
    }
}
