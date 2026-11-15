use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::json;
use sidekicks_contracts::session::controls::methods::PermissionLevel;
use sidekicks_std::mutex_lock::lock;
use tokio_util::task::TaskTracker;

use sidekicks_contracts::turn::ProviderTurnId;

use super::{CODEX_NO_TURN_ID, CodexConversationRewind, REWIND_TARGET_UNKNOWN};
use crate::driver::codex::run::routes::CodexRunBinding;
use crate::driver::codex::run::start::CODEX_TURN_START_TIMEOUT;
use crate::driver::codex::run::start::record::CodexTurnRequest;
use crate::driver::codex::run::turn_end_waiters::CodexTurnEndDeadline;
use crate::driver::codex::session::fork::config_change::CodexConfigForks;
use crate::driver::codex::session::inbound::{CodexSessionCall, CodexSessionInbound};
use crate::driver::codex::session::state::CodexTurnMessage;
use crate::driver::codex::session::test_fixture::{TestCodexSession, turn_reply};
use crate::driver::rewind::{
    RewindConversationParams, RewindConversationResult, RewindTargetPresence,
};
use crate::driver::test_registry::new_run_id;

/// How long the test waits before it counts the rewind and the start as deadlocked.
const DEADLOCK_BOUND: Duration = Duration::from_secs(10);

fn rewind_on(session: &TestCodexSession) -> CodexConversationRewind {
    CodexConversationRewind::new(
        Arc::clone(&session.slots),
        Arc::new(CodexConfigForks::new(
            Arc::clone(&session.slots),
            TaskTracker::new(),
        )),
        Arc::clone(&session.run_start),
        TaskTracker::new(),
    )
}

// A record started fresh holds no message's turn, as after a restart. The ask pages the turns
// newest first with no items and stops at the first turn started before the message's send
// second: a turn id the daemon's log names is found among them, and a message whose known
// turn is not listed, or with none, is found by its id, or its turn opener's, in the items of
// the turns passed, oldest first. Killed by answering cut away for a message no listed turn
// holds, since the listing can lag Codex's own record, whether a turn of it is known or not, for
// a retried message whose logged turn the retry's fork dropped, for a later message of a turn its
// opener's id shows or for a conversation Codex lists no turn of, by a page read past the send,
// by a turn's items asked in full or for a listed known turn, by a cut on a conversation listing
// no turn holding the message sent before no turn, by Codex's refusal of it failing the undo or
// leaving the record without the cut, whether the record lost the cut in a restart or kept the
// turn of a cut whose answer was lost, by a message with no known turn left uncut where the
// listing lagged, and by the message before the point read on the listing that lagged.
#[tokio::test(start_paused = true)]
async fn a_cut_codex_made_before_a_restart_reads_cut_away_and_is_adopted() {
    // Messages sent in one second, 1,700,000,000, as their UUIDv7 ids date them.
    const SENT: i64 = 1_700_000_000;
    const OPENED: &str = "018bcfe5-6800-7000-8000-000000000001";
    const STEERED: &str = "018bcfe5-6800-7000-8000-000000000002";
    const RETRIED: &str = "018bcfe5-6800-7000-8000-000000000003";
    const UNPROJECTED: &str = "018bcfe5-6800-7000-8000-000000000004";
    const FIRST: &str = "018bcfe5-6800-7000-8000-000000000005";
    const LOST: &str = "018bcfe5-6800-7000-8000-000000000006";
    const LATER: &str = "018bcfe5-6800-7000-8000-000000000007";
    const LAGGED: &str = "018bcfe5-6800-7000-8000-000000000008";
    const CUT: &str = "018bcfe5-6800-7000-8000-000000000009";
    const BEFORE: &str = "018bcfe5-6800-7000-8000-00000000000a";
    const REACH: &str = "018bcfe5-6800-7000-8000-00000000000b";
    let mut session = TestCodexSession::start().await;
    let session_id = session.task.record.session_id;
    let binding_id = session.record_binding().await;
    let rewind = rewind_on(&session);
    let asked = Arc::new(Mutex::new(Vec::new()));
    let is_listing_empty = Arc::new(AtomicBool::new(false));
    // Whether Codex's own record holds turn 4, and whether its listing shows it: the listing lags
    // the record until a revert brings it up to date.
    let has_lagging_turn = Arc::new(AtomicBool::new(false));
    let is_lagging_turn_listed = Arc::new(AtomicBool::new(false));
    let turn = |id: &str, started: i64| json!({"id": id, "items": [], "startedAt": started});
    let mut script = session.scripted.script;
    let service_side = tokio::spawn({
        let asked = Arc::clone(&asked);
        let is_listing_empty = Arc::clone(&is_listing_empty);
        let has_lagging_turn = Arc::clone(&has_lagging_turn);
        let is_lagging_turn_listed = Arc::clone(&is_lagging_turn_listed);
        async move {
            loop {
                let sent = script.next_sent().await;
                let params = &sent["params"];
                let reply = match sent["method"].as_str() {
                    Some("thread/turns/list") => {
                        lock(&asked).push(json!([params["itemsView"], params["cursor"]]));
                        if is_listing_empty.load(Ordering::SeqCst) {
                            json!({"data": [], "nextCursor": null})
                        } else if params["cursor"].is_null() {
                            let lagging = is_lagging_turn_listed
                                .load(Ordering::SeqCst)
                                .then(|| turn("turn-4", SENT + 30));
                            let listed: Vec<_> = lagging
                                .into_iter()
                                .chain([
                                    turn("turn-3", SENT + 20),
                                    turn("turn-2", SENT + 10),
                                    turn("turn-1", SENT),
                                    turn("turn-0", SENT - 50),
                                ])
                                .collect();
                            json!({"data": listed, "nextCursor": "older"})
                        } else {
                            let old = json!({"id": "turn-old", "items": []});
                            json!({"data": [old], "nextCursor": null})
                        }
                    }
                    // Codex brings its listing up to its own record, then reads it for the turn:
                    // a cut made before the restart or whose answer was lost left none, no thread
                    // holds the daemon's turn of none, and an unprojected thread still holds it.
                    Some("thread/revert") => {
                        let before = &params["beforeTurnId"];
                        lock(&asked).push(json!(["revert", before]));
                        if has_lagging_turn.load(Ordering::SeqCst) {
                            is_lagging_turn_listed.store(true, Ordering::SeqCst);
                        }
                        if let Some(dropped) = before.as_str().filter(|turn_id| {
                            ["turn-9", "turn-first", "turn-lost", CODEX_NO_TURN_ID]
                                .contains(turn_id)
                        }) {
                            script.send(&json!({"jsonrpc": "2.0", "id": sent["id"], "error": {
                                "code": -32600, "message": format!("turn not found: {dropped}"),
                            }}));
                            continue;
                        }
                        json!({})
                    }
                    Some("thread/items/list") => {
                        lock(&asked).push(json!(["items", params["turnId"], params["cursor"]]));
                        let message = |client_id: &str| {
                            json!({"turnId": params["turnId"], "item": {
                                "type": "userMessage", "id": "i", "clientId": client_id,
                            }})
                        };
                        // Turn 1's items come in two pages, so the cursor goes back as sent.
                        match (params["turnId"].as_str(), params["cursor"].as_str()) {
                            (Some("turn-1"), None) => {
                                json!({"data": [message(OPENED)], "nextCursor": "rest"})
                            }
                            (Some("turn-0"), None) => {
                                json!({"data": [message(STEERED)], "nextCursor": null})
                            }
                            // The faster-model retry's turn, on which its fork sent the
                            // message again after dropping the turn the log names.
                            (Some("turn-2"), None) => {
                                json!({"data": [message(RETRIED)], "nextCursor": null})
                            }
                            (Some("turn-4"), None) => json!({
                                "data": [message(LAGGED), message(BEFORE)], "nextCursor": null,
                            }),
                            _ => json!({"data": [], "nextCursor": null}),
                        }
                    }
                    method => panic!("the service was not asked {method:?}"),
                };
                script.answer(&sent, &reply);
            }
        }
    });
    let params = |message_id: &str, turn_id: Option<&str>| RewindConversationParams {
        session_id,
        binding_id: binding_id.clone(),
        target_message_id: message_id.to_owned(),
        target_turn_opener_id: None,
        target_turn_id: turn_id
            .map(|turn_id| ProviderTurnId::new(turn_id.to_owned()).expect("a turn id")),
    };
    let task = &mut session.task;
    let take_asked = || std::mem::take(&mut *lock(&asked));
    let first_page = json!(["notLoaded", null]);

    let opened = task
        .drive(rewind.read_target(&params(OPENED, Some("turn-1"))))
        .await;
    task.handle_next().await;
    assert_eq!(
        opened.expect("the ask is answered"),
        RewindTargetPresence::Held
    );
    assert_eq!(take_asked(), std::slice::from_ref(&first_page));
    let steered = task.drive(rewind.read_target(&params(STEERED, None))).await;
    task.handle_next().await;
    assert_eq!(
        steered.expect("the ask is answered"),
        RewindTargetPresence::Held
    );
    assert_eq!(
        take_asked(),
        [
            first_page.clone(),
            json!(["items", "turn-1", null]),
            json!(["items", "turn-1", "rest"]),
            json!(["items", "turn-0", null]),
        ]
    );
    assert_eq!(
        task.record.turn_id_by_client_message_id.get(STEERED),
        Some(&"turn-0".to_owned())
    );
    let turn_items = |turn_id: &str| json!(["items", turn_id, null]);
    let retried = task
        .drive(rewind.read_target(&params(RETRIED, Some("turn-8"))))
        .await;
    task.handle_next().await;
    assert_eq!(
        retried.expect("the ask is answered"),
        RewindTargetPresence::Held
    );
    assert_eq!(
        take_asked(),
        [
            first_page.clone(),
            turn_items("turn-1"),
            json!(["items", "turn-1", "rest"]),
            turn_items("turn-0"),
            turn_items("turn-2"),
        ]
    );
    assert_eq!(
        task.record.turn_id_by_client_message_id.get(RETRIED),
        Some(&"turn-2".to_owned())
    );
    // A later message of a turn sent under its opener's id alone is held where that id is.
    let later = task
        .drive(rewind.read_target(&RewindConversationParams {
            target_turn_opener_id: Some(OPENED.to_owned()),
            ..params(LATER, None)
        }))
        .await;
    task.handle_next().await;
    assert_eq!(
        later.expect("the ask is answered"),
        RewindTargetPresence::Held
    );
    assert_eq!(take_asked(), [first_page.clone(), turn_items("turn-1")]);
    assert_eq!(
        task.record.turn_id_by_client_message_id.get(LATER),
        Some(&"turn-1".to_owned())
    );
    let searched = || {
        vec![
            first_page.clone(),
            turn_items("turn-1"),
            json!(["items", "turn-1", "rest"]),
            turn_items("turn-0"),
            turn_items("turn-2"),
            turn_items("turn-3"),
        ]
    };
    // A listing that does not show the message shows no cut, since it can lag Codex's own record.
    let cut = task.drive(rewind.read_target(&params(CUT, None))).await;
    assert_eq!(
        cut.expect("the ask is answered"),
        RewindTargetPresence::Held
    );
    assert_eq!(take_asked(), searched());
    // With a turn known, the cut sent before it decides.
    let unconfirmed = task
        .drive(rewind.read_target(&params(CUT, Some("turn-9"))))
        .await;
    assert_eq!(
        unconfirmed.expect("the ask is answered"),
        RewindTargetPresence::UnconfirmedCut
    );
    assert_eq!(take_asked(), searched());
    let refused = task
        .drive(rewind.rewind(&params(CUT, Some("turn-9"))))
        .await;
    task.handle_next().await;
    assert_eq!(
        refused.expect("the cut is answered"),
        RewindConversationResult::TargetNotHeld {
            fallback_action: Some(REWIND_TARGET_UNKNOWN.to_owned()),
        }
    );
    // The refusal's adoption reads the whole listing once, and nothing reads it again.
    let all_pages = [first_page.clone(), json!(["notLoaded", "older"])];
    let mut expected = searched();
    expected.push(json!(["revert", "turn-9"]));
    expected.extend(searched());
    expected.extend(all_pages);
    assert_eq!(take_asked(), expected);
    let after_refusal = task
        .drive(rewind.read_target(&params(CUT, Some("turn-9"))))
        .await;
    assert_eq!(
        after_refusal.expect("the ask is answered"),
        RewindTargetPresence::CutAway
    );
    assert_eq!(take_asked(), Vec::<serde_json::Value>::new());
    assert_eq!(
        task.record.turn_boundaries,
        ["turn-old", "turn-0", "turn-1", "turn-2", "turn-3"]
    );
    assert!(task.record.cut_client_message_ids.contains(CUT));
    assert_eq!(task.record.cut_client_message_ids.len(), 1);
    let again = task.drive(rewind.read_target(&params(CUT, None))).await;
    assert_eq!(
        again.expect("the ask is answered"),
        RewindTargetPresence::CutAway
    );
    // A conversation whose history Codex has not projected lists no turn, which shows no cut,
    // and its cut goes before the turn the log names, which Codex finds in its own record.
    is_listing_empty.store(true, Ordering::SeqCst);
    let unprojected = task
        .drive(rewind.read_target(&params(UNPROJECTED, Some("turn-1"))))
        .await;
    assert_eq!(
        unprojected.expect("the ask is answered"),
        RewindTargetPresence::Held
    );
    assert_eq!(take_asked(), std::slice::from_ref(&first_page));
    let applied = task
        .drive(rewind.rewind(&params(UNPROJECTED, Some("turn-1"))))
        .await;
    assert_eq!(
        applied.expect("the cut is answered"),
        RewindConversationResult::Applied {
            fork: None,
            cut_message_text: None,
        }
    );
    assert_eq!(
        take_asked(),
        [first_page.clone(), json!(["revert", "turn-1"])]
    );
    assert_eq!(task.record.turn_boundaries, ["turn-old", "turn-0"]);
    // A conversation Codex cut to before its first turn lists none either: the ask reads it
    // held, Codex refuses the cut for a turn its record no longer holds, and the listing read
    // again shows none, so the cut is adopted and the ask after the refusal reads it cut away.
    // The record lost that cut in a restart, the log naming the turn, or kept the turn of a cut
    // whose answer was lost.
    for (message_id, logged_turn, kept_turn) in [
        (FIRST, Some("turn-first"), None),
        (LOST, None, Some("turn-lost")),
    ] {
        if let Some(kept_turn) = kept_turn {
            let record = &mut task.record;
            record.turn_boundaries.push(kept_turn.to_owned());
            record
                .turn_id_by_client_message_id
                .insert(message_id.to_owned(), kept_turn.to_owned());
        }
        let first = task
            .drive(rewind.read_target(&params(message_id, logged_turn)))
            .await;
        assert_eq!(
            first.expect("the ask is answered"),
            RewindTargetPresence::Held
        );
        assert_eq!(take_asked(), std::slice::from_ref(&first_page));
        let refused = task
            .drive(rewind.rewind(&params(message_id, logged_turn)))
            .await;
        task.handle_next().await;
        assert_eq!(
            refused.expect("the cut is answered"),
            RewindConversationResult::TargetNotHeld {
                fallback_action: Some(REWIND_TARGET_UNKNOWN.to_owned()),
            }
        );
        let reverted = json!(["revert", logged_turn.or(kept_turn)]);
        let searched_first = logged_turn.map(|_| first_page.clone());
        let expected: Vec<_> = searched_first
            .into_iter()
            .chain([reverted, first_page.clone()])
            .collect();
        assert_eq!(take_asked(), expected);
        let after_refusal = task
            .drive(rewind.read_target(&params(message_id, logged_turn)))
            .await;
        assert_eq!(
            after_refusal.expect("the ask is answered"),
            RewindTargetPresence::CutAway
        );
        assert_eq!(take_asked(), Vec::<serde_json::Value>::new());
        assert_eq!(task.record.turn_boundaries, Vec::<String>::new());
        assert!(task.record.cut_client_message_ids.contains(message_id));
    }
    // Codex's record holds turn 4, which its listing lags, so the listing shows no turn holding
    // the message and none of its turns is known: the ask reads it held, and the cut goes before
    // a turn no thread holds, whose refusal brings the listing up to Codex's record, so the
    // message is found there and cut before its turn, never adopted as a cut Codex did not make.
    is_listing_empty.store(false, Ordering::SeqCst);
    has_lagging_turn.store(true, Ordering::SeqCst);
    let lagged = task.drive(rewind.read_target(&params(LAGGED, None))).await;
    assert_eq!(
        lagged.expect("the ask is answered"),
        RewindTargetPresence::Held
    );
    assert_eq!(take_asked(), searched());
    let applied = task.drive(rewind.rewind(&params(LAGGED, None))).await;
    assert_eq!(
        applied.expect("the cut is answered"),
        RewindConversationResult::Applied {
            fork: None,
            cut_message_text: None,
        }
    );
    let current = || {
        let mut current = searched();
        current.push(turn_items("turn-4"));
        current
    };
    let mut expected = searched();
    expected.push(json!(["revert", CODEX_NO_TURN_ID]));
    expected.extend(current());
    expected.push(json!(["revert", "turn-4"]));
    assert_eq!(take_asked(), expected);
    // A message the listing does not show because Codex cut it: the refusal brings the listing
    // up to Codex's record and the cut is adopted, and the message before the point, in the turn
    // the listing lagged, is read on that listing, held, so the undo is not refused for it.
    is_lagging_turn_listed.store(false, Ordering::SeqCst);
    let reach = task.drive(rewind.read_target(&params(REACH, None))).await;
    assert_eq!(
        reach.expect("the ask is answered"),
        RewindTargetPresence::Held
    );
    assert_eq!(take_asked(), searched());
    let refused = task.drive(rewind.rewind(&params(REACH, None))).await;
    task.handle_next().await;
    assert_eq!(
        refused.expect("the cut is answered"),
        RewindConversationResult::TargetNotHeld {
            fallback_action: Some(REWIND_TARGET_UNKNOWN.to_owned()),
        }
    );
    let after_refusal = task.drive(rewind.read_target(&params(REACH, None))).await;
    assert_eq!(
        after_refusal.expect("the ask is answered"),
        RewindTargetPresence::CutAway
    );
    let mut expected = searched();
    expected.push(json!(["revert", CODEX_NO_TURN_ID]));
    expected.extend(current());
    expected.extend([first_page.clone(), json!(["notLoaded", "older"])]);
    assert_eq!(take_asked(), expected);
    let before = task.drive(rewind.read_target(&params(BEFORE, None))).await;
    task.handle_next().await;
    assert_eq!(
        before.expect("the ask is answered"),
        RewindTargetPresence::Held
    );
    assert_eq!(take_asked(), current());
    service_side.abort();
}

// Killed by stopping the running turns before the turn starts and the claim are held, which
// lets a turn start between the stop and the revert.
#[tokio::test(start_paused = true)]
async fn a_turn_start_racing_a_rewind_waits_until_the_revert_is_done() {
    let mut session = TestCodexSession::start().await;
    let session_id = session.task.record.session_id;
    let binding_id = session.record_binding().await;
    let run_id = new_run_id();
    session.task.run_routes.bind_run_delivery(
        run_id,
        CodexRunBinding {
            session_id,
            binding_id: binding_id.clone(),
            agent_id: session.daemon_turn_bindings.agent_id,
            step_bound: None,
        },
    );
    session.daemon_turn_bindings.open_on(binding_id.clone());
    let record = &mut session.task.record;
    record.turn_boundaries = vec!["turn-1".to_owned()];
    record
        .turn_id_by_client_message_id
        .insert("message-0".to_owned(), "turn-1".to_owned());
    let rewind = rewind_on(&session);
    let params = RewindConversationParams {
        session_id,
        binding_id: binding_id.clone(),
        target_message_id: "message-0".to_owned(),
        target_turn_opener_id: None,
        target_turn_id: None,
    };
    // The service answers the revert and the turn's start, and keeps the order it was asked.
    let asked = Arc::new(Mutex::new(Vec::new()));
    let mut script = session.scripted.script;
    let service_side = tokio::spawn({
        let asked = Arc::clone(&asked);
        async move {
            loop {
                let sent = script.next_sent().await;
                let method = sent["method"].as_str().map(str::to_owned);
                match method.as_deref() {
                    Some("thread/revert") => script.answer(&sent, &json!({})),
                    Some("turn/start") => script.answer(&sent, &turn_reply("turn-9")),
                    method => panic!("the service was not asked {method:?}"),
                }
                lock(&asked).push(method);
            }
        }
    });
    let (gate, opened) = tokio::sync::oneshot::channel::<()>();
    let run_start = Arc::clone(&session.run_start);
    let inbound = session.task.record.inbound.clone();
    let deadline = CodexTurnEndDeadline::new(CODEX_TURN_START_TIMEOUT);
    let racing_start = async {
        opened.await.expect("the test opens the gate");
        run_start
            .start_turn(
                &inbound,
                run_id,
                binding_id,
                CodexTurnRequest {
                    messages: vec![CodexTurnMessage {
                        text: "Go on.".to_owned(),
                        skills: Vec::new(),
                        attachments: Vec::new(),
                    }],
                    client_message_ids: vec!["message-1".to_owned()],
                    model: None,
                    output_speed: None,
                    output_speed_for_turn: None,
                    output_schema: None,
                    level: Some(PermissionLevel::Ask),
                },
                None,
                &deadline,
            )
            .await
    };
    let mut both = std::pin::pin!(async { tokio::join!(rewind.rewind(&params), racing_start) });
    let task = &mut session.task;

    let (rewound, started) = tokio::time::timeout(DEADLOCK_BOUND, async {
        // The rewind reads its message's turn, then reads the session to stop its turns:
        // the start races it from there.
        let up_to_the_stop = async {
            task.handle_next().await;
            let stop_read = task.next_item().await;
            assert!(matches!(
                stop_read,
                CodexSessionInbound::Call(CodexSessionCall::ReadSession { .. })
            ));
            gate.send(()).expect("the start waits on the gate");
            // The start waits on the session's turn sends, which nothing announces: with the
            // clock paused this sleep ends only once every task is idle, the start's wait among
            // them, so the stop is handled after it.
            tokio::time::sleep(Duration::from_millis(1)).await;
            task.handle(stop_read).await;
        };
        tokio::select! {
            biased;
            _ = &mut both => unreachable!("the rewind waits on its stop's read"),
            () = up_to_the_stop => {}
        }
        task.drive(&mut both).await
    })
    .await
    .expect("the rewind and the start settle");

    assert_eq!(
        rewound.expect("the rewind is answered"),
        RewindConversationResult::Applied {
            fork: None,
            cut_message_text: None,
        }
    );
    started.expect("the run's turn starts once the revert is done");
    assert_eq!(
        *lock(&asked),
        [
            Some("thread/revert".to_owned()),
            Some("turn/start".to_owned())
        ]
    );
    service_side.abort();
}
