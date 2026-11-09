use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;
use tokio::sync::oneshot;

use super::exchanges::{CodexTerminalTurnEnd, reread_turn_end};
use super::{TERMINAL_RECONNECT_WINDOW, TerminalReadings, publish_turn_end};
use crate::driver::codex::service::supervisor::test_service::{
    ScriptedCodexService, start_scripted_terminal_service,
};
use crate::driver::test_registry::RecordedQueue;
use crate::port::session_message_reading_publisher::SessionMessageReading;

/// The conversation a person typed in a terminal.
const THREAD: &str = "typed-thread";

/// The turn a message opened in it.
const TURN: &str = "turn-1";

/// The message that opened the turn.
const MESSAGE: &str = "message-1";

/// How long a test gives the daemon to send a request it must not send.
const QUIET: Duration = Duration::from_millis(200);

/// How long the test waits before it counts a step as stuck.
const DEADLOCK_BOUND: Duration = Duration::from_secs(10);

// Answers the service's check that a terminal holds the conversation, and then its turn list
// with `turn` alone on it, asserting the list is asked newest first with no items.
async fn answer_turn_list(scripted: &mut ScriptedCodexService, turn: &Value) {
    let loaded = scripted.next_request("thread/loaded/list").await;
    scripted
        .script
        .answer(&loaded, &json!({"data": [THREAD], "nextCursor": null}));
    let turns = scripted.next_request("thread/turns/list").await;
    assert_eq!(turns["params"]["threadId"], THREAD);
    assert_eq!(turns["params"]["itemsView"], "notLoaded");
    assert!(turns["params"]["sortDirection"].is_null(), "{turns}");
    scripted
        .script
        .answer(&turns, &json!({"data": [turn], "nextCursor": null}));
}

// Answers the read of the turn's items, newest first, with its reply `text`.
async fn answer_reply(scripted: &mut ScriptedCodexService, text: &str) {
    let items = scripted.next_request("thread/items/list").await;
    assert_eq!(items["params"]["turnId"], TURN);
    assert_eq!(items["params"]["sortDirection"], "desc");
    let reply = json!({"type": "agentMessage", "id": "m-1", "text": text});
    let page = json!({"data": [{"turnId": TURN, "item": reply}], "nextCursor": null});
    scripted.script.answer(&items, &page);
}

// The end the re-read reads for the listed `turn`, the service answering its reply with
// `reply` where the re-read asks for it.
async fn reread_listed_turn(turn: Value, reply: Option<&str>) -> CodexTerminalTurnEnd {
    let mut scripted = start_scripted_terminal_service();
    let service = Arc::clone(&scripted.service);
    let rereading = reread_turn_end(&service, THREAD, TURN);
    let answering = async {
        answer_turn_list(&mut scripted, &turn).await;
        if let Some(reply) = reply {
            answer_reply(&mut scripted, reply).await;
        }
    };
    let (end, ()) =
        tokio::time::timeout(DEADLOCK_BOUND, async { tokio::join!(rereading, answering) })
            .await
            .expect("the re-read settles");
    let asked = scripted.script.next_sent_within(QUIET).await;
    assert!(asked.is_none(), "nothing more is asked: {asked:?}");
    end.expect("the re-read reads")
        .expect("an ended turn is read from the list")
}

// Kills: a mapping that fails every interrupted turn, which reads the person's own stop in their
// terminal as a failure, and a re-read that answers without the turn's reply.
#[tokio::test]
async fn a_turn_the_person_stopped_in_their_terminal_reads_answered() {
    let turn = json!({"id": TURN, "status": "interrupted", "completedAt": 1_767_000_000});

    let end = reread_listed_turn(turn, Some("Stopped halfway.")).await;

    assert_eq!(
        end,
        CodexTerminalTurnEnd::Answered {
            reply: Some("Stopped halfway.".to_owned())
        }
    );
}

// Kills: the mapping that answers any turn without an error message, which reads a turn the
// service's death cut off as finished, and a notice other than the cut-off line.
#[tokio::test]
async fn a_turn_the_services_stop_cut_off_reads_failed() {
    let turn = json!({"id": TURN, "status": "interrupted", "completedAt": null});

    let end = reread_listed_turn(turn, None).await;

    assert_eq!(
        end,
        CodexTerminalTurnEnd::Failed {
            notice: "Codex's service stopped before it answered".to_owned()
        }
    );
}

// Kills: the mapping that answers any turn without an error message, which reads a failed turn
// with no message as answered.
#[tokio::test]
async fn a_turn_that_failed_with_no_message_reads_failed() {
    let turn = json!({"id": TURN, "status": "failed", "error": null, "completedAt": 1_767_000_000});

    let end = reread_listed_turn(turn, None).await;

    assert_eq!(
        end,
        CodexTerminalTurnEnd::Failed {
            notice: "Codex gave no reason".to_owned()
        }
    );
}

// Kills: a re-read that opens a seat to wait for a turn the list does not hold, whose end never
// comes, and an answer other than the cut-off line.
#[tokio::test]
async fn a_turn_the_list_does_not_hold_reads_failed_as_cut_off() {
    let other = json!({"id": "turn-0", "status": "completed", "completedAt": 1_767_000_000});

    let end = reread_listed_turn(other, None).await;

    assert_eq!(
        end,
        CodexTerminalTurnEnd::Failed {
            notice: "Codex's service stopped before it answered".to_owned()
        }
    );
}

// The readings a test records, and where a turn's end publishes them.
fn recorded_readings() -> (Arc<RecordedQueue>, TerminalReadings) {
    let recorded = Arc::new(RecordedQueue::default());
    let readings = Arc::new(PortRegistration::new("session message readings"));
    readings
        .register(Arc::clone(&recorded) as _)
        .expect("the readings register once");
    (recorded, readings)
}

// Publishes the end of the turn whose seat's connection ended before it did, on `scripted`.
fn publish_unread_turn_end(
    scripted: &ScriptedCodexService,
    readings: &TerminalReadings,
) -> tokio::task::JoinHandle<()> {
    let (seat_end, ended) = oneshot::channel();
    drop(seat_end);
    tokio::spawn(publish_turn_end(
        Arc::clone(&scripted.service),
        THREAD.to_owned(),
        TURN.to_owned(),
        MESSAGE.to_owned(),
        ended,
        Arc::clone(readings),
    ))
}

// Kills: a turn end answered before the service is back (the wait closed early or read as not
// reachable), one answered without the re-read, and one answered with a fixed line instead of
// the turn's own reply.
#[tokio::test(start_paused = true)]
async fn an_unread_turn_end_is_read_again_at_the_services_return_within_the_window() {
    let mut scripted = start_scripted_terminal_service();
    let (recorded, readings) = recorded_readings();
    let connection = scripted.publish_reconnecting();

    let publishing = publish_unread_turn_end(&scripted, &readings);
    tokio::task::yield_now().await;
    tokio::time::advance(TERMINAL_RECONNECT_WINDOW / 2).await;
    let while_away = lock(&recorded.readings).clone();
    scripted.publish_up(connection);
    let turn = json!({"id": TURN, "status": "completed", "completedAt": 1_767_000_000});
    answer_turn_list(&mut scripted, &turn).await;
    answer_reply(&mut scripted, "The checks pass.").await;
    tokio::time::timeout(DEADLOCK_BOUND, publishing)
        .await
        .expect("the turn's end is published")
        .expect("the publishing task ends");

    assert!(while_away.is_empty(), "the wait stays open: {while_away:?}");
    assert_eq!(
        *lock(&recorded.readings),
        [SessionMessageReading::Answered {
            message_id: MESSAGE.to_owned(),
            turn_record: MESSAGE.to_owned(),
            answer: Some("The checks pass.".to_owned()),
        }]
    );
}

// Kills: a turn end past the window read as anything but not reachable with the reopen line,
// and a service away past the window that is still asked.
#[tokio::test(start_paused = true)]
async fn an_unread_turn_end_past_the_window_reads_not_reachable_with_the_reopen_line() {
    let mut scripted = start_scripted_terminal_service();
    let (recorded, readings) = recorded_readings();
    let _connection = scripted.publish_reconnecting();

    let publishing = publish_unread_turn_end(&scripted, &readings);
    tokio::task::yield_now().await;
    tokio::time::advance(TERMINAL_RECONNECT_WINDOW).await;
    tokio::time::timeout(DEADLOCK_BOUND, publishing)
        .await
        .expect("the turn's end is published")
        .expect("the publishing task ends");

    assert_eq!(
        *lock(&recorded.readings),
        [SessionMessageReading::NotReachable {
            message_id: MESSAGE.to_owned(),
            reopen: format!("Reopen it in a terminal: codex resume {THREAD}"),
        }]
    );
    let asked = scripted.script.next_sent_within(QUIET).await;
    assert!(asked.is_none(), "nothing reaches the service: {asked:?}");
}
