//! An exported response on a thread no session streams: a search its thread's rollout file states
//! charged once while the export arrives, a search copied into a fork's file never, a thread no
//! session will ever hold charged to its account, a held response counted on its session once its
//! thread is listed, its file found wherever Codex keeps it, and a response kept as its launch ends
//! or handed to a session as it closes charged to its account once, its file's line passed over,
//! and written before the daemon's stop ends.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::unix_time::read_unix_time_ms;
use tokio::sync::oneshot;

use super::export_usage::{
    ExportingSession, SECOND_TURN, counts, rollout_line, rollout_record, stamped_record,
    turn_context, wire_counts,
};
use super::usage::{answer_region_read, token_usage_frame};
use super::{TEST_TURN, answer_stopping_request};
use crate::bounded_poll::poll_until;
use crate::driver::codex::run::turn_end_waiters::CodexRecordExit;
use crate::driver::codex::service::supervisor::test_service::ScriptedCodexService;
use crate::driver::codex::session::inbound::CodexSessionInbound;
use crate::driver::codex::session::lifecycle_call::CodexLifecycleCall;
use crate::driver::codex::session::test_fixture::{TEST_THREAD, turn_completed, turn_started};
use crate::driver::codex::telemetry::completed_response::CodexCompletedResponse;
use crate::driver::codex::telemetry::drain::push_exported_responses;
use crate::driver::codex::telemetry::exported_response::{
    CodexExportedResponse, CodexOffStreamPlacement,
};
use crate::driver::codex::telemetry::exports::tests::refused;
use crate::driver::codex::telemetry::rollouts::file::CodexRolloutFile;
use crate::driver::codex::telemetry::sessionless_spend::CodexLaunchCharge;
use crate::driver::daemon_stop::{DaemonStopIntent, daemon_stop_deadline};
use crate::driver::diagnostics::RecordedEvents;
use crate::runtime_binding::test_store::test_provider_account_id;
use crate::usage_delta_accountant::UsageAxisCounts;

/// The thread of a fork below the session's thread, which the listing names.
const LISTED_FORK_THREAD: &str = "fork-2";

/// The fork's own turn.
const FORK_TURN: &str = "fork-turn";

// While the export arrives, a response placed below the session's thread reads on that thread's
// rollout file: the search inside it, which no export carries, is charged once, the search and
// the record copied ahead of the fork's own lines are charged nothing, and the file's record of
// the exported response is passed over; a stop's pass that then reads the same file charges
// nothing more, while it counts the session's own warm-up. Killed by no read as the response is
// placed (no search row), by the read's record priced again (five rows), by a copied search
// charged (two search rows) and by the stop charging the search again (two search rows).
#[tokio::test]
async fn an_off_stream_search_is_charged_once_while_the_export_arrives() {
    let mut session = ExportingSession::start(&[TEST_TURN, SECOND_TURN]).await;
    let now = read_unix_time_ms();
    let fork_meta = json!({"id": LISTED_FORK_THREAD, "forked_from_id": TEST_THREAD});
    let fork_record = json!({
        "thread_id": LISTED_FORK_THREAD,
        "turn_id": FORK_TURN,
        "response_id": "response-fork",
        "usage": {
            "input_tokens": 300, "cached_input_tokens": 0, "output_tokens": 20,
            "reasoning_output_tokens": 0, "total_tokens": 320,
        },
    });
    let search = |search_id: &str, turn_id: &str| {
        json!({
            "type": "web_search_call", "id": search_id, "status": "completed",
            "action": {"type": "search", "query": "steer order"},
            "internal_chat_message_metadata_passthrough": {"turn_id": turn_id},
        })
    };
    let fork_settings = json!({
        "type": "thread_settings_applied", "thread_id": LISTED_FORK_THREAD, "thread_settings": {},
    });
    // The fork's file opens with the session's history copied at the fork, stamped then: its
    // search is the session's, never the fork's.
    session.write_rollout(
        LISTED_FORK_THREAD,
        &[
            rollout_line(now, "session_meta", &fork_meta),
            rollout_line(
                now,
                "session_meta",
                &json!({"id": TEST_THREAD, "source": "cli"}),
            ),
            turn_context(now, TEST_TURN),
            rollout_line(now, "response_item", &search("ws_parent", TEST_TURN)),
            rollout_record(now, TEST_TURN, "response-parent", 40, 4),
            rollout_line(now, "event_msg", &fork_settings),
            turn_context(now, FORK_TURN),
            rollout_line(now, "response_item", &search("ws_fork", FORK_TURN)),
            rollout_line(now, "token_usage_record", &fork_record),
        ],
    );
    session.write_rollout(
        TEST_THREAD,
        &[
            rollout_line(
                now,
                "session_meta",
                &json!({"id": TEST_THREAD, "source": "cli"}),
            ),
            turn_context(now, SECOND_TURN),
            rollout_record(now, SECOND_TURN, "response-warm-up", 2, 0),
        ],
    );

    // Logged well before the files were written, so the stop's pass finds both by their change.
    session
        .export_records(vec![stamped_record(
            LISTED_FORK_THREAD,
            &counts(300, 20),
            now - 10_000,
        )])
        .await;
    let list = session.live.scripted.next_request("thread/list").await;
    session.live.scripted.script.answer(
        &list,
        &json!({
            "data": [{"id": LISTED_FORK_THREAD, "parentThreadId": TEST_THREAD}],
            "nextCursor": null,
        }),
    );
    answer_region_read(&mut session.live.scripted).await;
    assert_eq!(session.usage.rows_once_decided(3).await.len(), 2);
    let searches = |session: &ExportingSession| {
        lock(&session.usage.metered)
            .iter()
            .filter(|metered| metered.delta.request.web_search_requests == Some(1))
            .count()
    };
    assert_eq!(searches(&session), 1);

    // A request turn that sees no export stops the status, and the stop's pass reads both files;
    // the paused clock moves on first, so the turn begins after the export.
    tokio::time::sleep(Duration::from_millis(10)).await;
    session.complete_turn();
    let script = &session.live.scripted.script;
    script.send(&turn_started(SECOND_TURN));
    let second = wire_counts(&counts(3_000, 700));
    let mut reading = token_usage_frame(TEST_THREAD, &second, &second);
    reading["params"]["turnId"] = json!(SECOND_TURN);
    script.send(&reading);
    script.send(&turn_completed(TEST_THREAD, SECOND_TURN, "completed"));
    session.answer_helper_listing().await;

    let mut rows = session.usage.rows_once_decided(5).await;
    rows.sort_unstable();
    assert_eq!(
        rows,
        [
            (None, None),
            (Some(2), Some(0)),
            (Some(300), Some(20)),
            (Some(3_000), Some(700)),
        ]
    );
    assert_eq!(searches(&session), 1);
}

/// The thread of a memory consolidation worker, which Codex holds neither loaded nor stored.
const WORKER_THREAD: &str = "worker-1";

/// The thread of a fork no listing names at first, which a later listing places below the
/// session's thread.
const LATE_LISTED_THREAD: &str = "fork-3";

impl ExportingSession {
    // Registers the session's usage record as its service's repricing intake.
    pub(super) fn register_repricing(&self) {
        let dependencies = self.live.scripted.service.dependencies();
        let repricing = Arc::clone(&self.usage);
        assert!(dependencies.request_held.register(repricing as _).is_ok());
    }

    // Exports one response on `thread_id` observed at `observed_at_ms`, then answers the two
    // walks of its thread, the export's and the next export's retry, with a listing that lacks it.
    async fn export_unlisted(&mut self, thread_id: &str, observed_at_ms: u64) {
        let record = stamped_record(thread_id, &counts(300, 20), observed_at_ms);
        self.export_records(vec![record]).await;
        let unlisted = json!({"data": [], "nextCursor": null});
        let list = self.live.scripted.next_request("thread/list").await;
        self.live.scripted.script.answer(&list, &unlisted);
        self.export_records(Vec::new()).await;
        let list = self.live.scripted.next_request("thread/list").await;
        self.live.scripted.script.answer(&list, &unlisted);
    }
}

// The input and output of each request handed to the repricing as no session's.
fn sessionless(session: &ExportingSession) -> Vec<(Option<u64>, Option<u64>)> {
    lock(&session.usage.sessionless)
        .iter()
        .map(|request| {
            let count = |figure: Option<SafeInt<0>>| figure.map(SafeInt::get);
            (
                count(request.spend.input_tokens),
                count(request.spend.output_tokens),
            )
        })
        .collect()
}

// A response on a thread no listing names, which nothing joins and Codex holds neither loaded nor
// stored, is its account's spend outside any session: handed to the repricing once on the
// service's account, and on no session's receipt; the thread's next response is charged from the
// launch's memory with no walk, lookup or region read, and the first is not charged again. Killed
// by refusing it (nothing handed), by charging a thread with no lookup (no `thread/read`), by a
// placement or region forgotten (a request no one answers, so nothing more is handed) and by a
// charge repeated (three handed).
#[tokio::test]
async fn a_response_no_session_will_ever_hold_is_charged_to_its_account_once() {
    let recorded = RecordedEvents::default();
    let _recording = recorded.record_until_dropped();
    let mut session = ExportingSession::start(&[TEST_TURN]).await;
    session.register_repricing();
    // Observed before the session's turn began, so no turn covers it.
    let before_the_turn = read_unix_time_ms() - 60_000;

    session
        .export_unlisted(WORKER_THREAD, before_the_turn)
        .await;
    let read = session.live.scripted.next_request("thread/read").await;
    session.live.scripted.script.send(&json!({
        "jsonrpc": "2.0",
        "id": read["id"],
        "error": {"code": -32600, "message": format!("thread not loaded: {WORKER_THREAD}")},
    }));
    poll_until(|| sessionless(&session).len(), |handed| *handed >= 1).await;
    session
        .export_records(vec![stamped_record(
            WORKER_THREAD,
            &counts(40, 4),
            before_the_turn,
        )])
        .await;
    poll_until(|| sessionless(&session).len(), |handed| *handed >= 2).await;
    tokio::time::sleep(Duration::from_millis(10)).await;

    assert_eq!(
        sessionless(&session),
        [(Some(300), Some(20)), (Some(40), Some(4))]
    );
    assert!(
        lock(&session.usage.sessionless)
            .iter()
            .all(|request| request.provider_account_id == test_provider_account_id())
    );
    assert!(lock(&session.usage.metered).is_empty());
    assert_eq!(refused(&recorded), 0);
}

// Answers the next two requests, the recorder's region read and the placed thread's lookup, which
// run on separate tasks, in whichever order they come: the lookup names `path`.
async fn answer_region_read_and_lookup(scripted: &mut ScriptedCodexService, path: &Path) {
    for _ in 0..2 {
        let request = scripted.script.next_sent().await;
        let result = match request["method"].as_str() {
            Some("config/read") => json!({"config": {}, "origins": {}}),
            Some("thread/read") => json!({"thread": {"id": LATE_LISTED_THREAD, "path": path}}),
            _ => panic!("an unasked request: {request}"),
        };
        scripted.script.answer(&request, &result);
    }
}

// Writes the rollout file of the late-listed fork, made long before, so Codex keeps it in a day
// folder older than the two around any response and only its lookup finds it: one request,
// `response_id`, of 300 input and 20 output tokens, stamped at `at_ms`. Answers its path.
fn write_late_listed_file(session: &ExportingSession, response_id: &str, at_ms: u64) -> PathBuf {
    let folder = session
        .live
        .scripted
        .service
        .home()
        .codex_home
        .join("sessions/2026/01/02");
    std::fs::create_dir_all(&folder).expect("the day folder is made");
    let path = folder.join(format!(
        "rollout-2026-01-02T10-00-00-{LATE_LISTED_THREAD}.jsonl"
    ));
    let record = json!({
        "thread_id": LATE_LISTED_THREAD,
        "turn_id": "fork-turn",
        "response_id": response_id,
        "usage": {
            "input_tokens": 300, "cached_input_tokens": 0, "output_tokens": 20,
            "reasoning_output_tokens": 0, "total_tokens": 320,
        },
    });
    let settings: Value = json!({
        "type": "thread_settings_applied", "thread_id": LATE_LISTED_THREAD, "thread_settings": {},
    });
    let lines = [
        rollout_line(
            at_ms,
            "session_meta",
            &json!({"id": LATE_LISTED_THREAD, "forked_from_id": TEST_THREAD}),
        ),
        rollout_line(at_ms, "event_msg", &settings),
        turn_context(at_ms, "fork-turn"),
        rollout_line(at_ms, "token_usage_record", &record),
    ];
    std::fs::write(&path, lines.join("\n") + "\n").expect("the rollout file is written");
    path
}

impl ExportingSession {
    // Exports one response of `counts` on the late-listed fork at `observed_at_ms`, answers its
    // walk with a listing that names it below the session's thread, then the recorder's region
    // read and the lookup of its file at `path`, which the placement's read of the file makes.
    async fn export_listed(&mut self, counts: &UsageAxisCounts, observed_at_ms: u64, path: &Path) {
        self.export_records(vec![stamped_record(
            LATE_LISTED_THREAD,
            counts,
            observed_at_ms,
        )])
        .await;
        let list = self.live.scripted.next_request("thread/list").await;
        self.live.scripted.script.answer(
            &list,
            &json!({
                "data": [{"id": LATE_LISTED_THREAD, "parentThreadId": TEST_THREAD}],
                "nextCursor": null,
            }),
        );
        answer_region_read_and_lookup(&mut self.live.scripted, path).await;
    }
}

// A response on a thread no listing names yet, which nothing joins but Codex keeps a file for, is
// held and never charged to the account: once a later response of the thread is listed below the
// session's thread, both go to the session, and the file, in a day folder older than the two
// around that response, is found through Codex's lookup and prices the held response nothing
// more. Killed by charging a thread with a file to its account (a request handed as no
// session's), by a held response left out of its thread's later placement (one row), by a thread
// looked up at its later response though its file was known (an unanswered request) and by the
// file read pricing the held response again (three rows).
#[tokio::test]
async fn a_held_response_counts_once_on_its_session_once_its_thread_is_listed() {
    let recorded = RecordedEvents::default();
    let _recording = recorded.record_until_dropped();
    let mut session = ExportingSession::start(&[TEST_TURN]).await;
    session.register_repricing();
    let now = read_unix_time_ms();
    let path = write_late_listed_file(&session, "response-held", now);

    session
        .export_unlisted(LATE_LISTED_THREAD, now - 60_000)
        .await;
    let read = session.live.scripted.next_request("thread/read").await;
    session.live.scripted.script.answer(
        &read,
        &json!({"thread": {"id": LATE_LISTED_THREAD, "path": path}}),
    );
    tokio::time::sleep(Duration::from_millis(10)).await;
    session.export_listed(&counts(200, 10), now, &path).await;

    let mut rows = session.usage.rows_once_decided(3).await;
    rows.sort_unstable();
    assert_eq!(rows, [(Some(200), Some(10)), (Some(300), Some(20))]);
    assert_eq!(sessionless(&session), []);
    assert_eq!(refused(&recorded), 0);
}

// A response kept as its launch ends, its thread not placed yet, is charged once to its account as
// its spend outside any session; the same response read later from its thread's file, once a
// later response of the thread is listed, is passed over. Killed by a launch that refuses or
// drops what it keeps (nothing handed), by a charge whose sighting the file's line does not meet
// (the line priced as a second row) and by a launch's end that charges twice (two handed).
#[tokio::test]
async fn a_response_kept_as_its_launch_ends_is_charged_once_to_its_account() {
    let recorded = RecordedEvents::default();
    let _recording = recorded.record_until_dropped();
    let mut session = ExportingSession::start(&[TEST_TURN]).await;
    session.register_repricing();
    session
        .export_records(vec![stamped_record(
            LATE_LISTED_THREAD,
            &counts(300, 20),
            read_unix_time_ms(),
        )])
        .await;
    let list = session.live.scripted.next_request("thread/list").await;
    session
        .live
        .scripted
        .script
        .answer(&list, &json!({"data": [], "nextCursor": null}));
    tokio::time::sleep(Duration::from_millis(10)).await;
    assert_eq!(sessionless(&session), [], "the response is kept");

    session.relaunch();
    poll_until(|| sessionless(&session).len(), |handed| *handed >= 1).await;
    // Stamped past the new launch's start, from which its read of the file begins.
    let later = read_unix_time_ms();
    let path = write_late_listed_file(&session, "response-kept", later);
    session.export_listed(&counts(200, 10), later, &path).await;

    assert_eq!(
        session.usage.rows_once_decided(2).await,
        [(Some(200), Some(10))]
    );
    assert_eq!(sessionless(&session), [(Some(300), Some(20))]);
    assert!(
        lock(&session.usage.sessionless)
            .iter()
            .all(|request| request.provider_account_id == test_provider_account_id())
    );
    assert_eq!(refused(&recorded), 0);
}

// A response on the session's turn that no stream states, of 300 input and 20 output tokens at
// `at_ms`, on the test's account.
fn off_stream_response(at_ms: u64) -> CodexExportedResponse {
    CodexExportedResponse {
        response: CodexCompletedResponse {
            conversation_id: TEST_THREAD.to_owned(),
            model_id: FreeFormText::new("gpt-5".to_owned()).expect("the model fits"),
            service_tier: None,
            counts: counts(300, 20),
            observed_at_ms: at_ms,
            provider_account_id: Some(test_provider_account_id()),
        },
        placed: Some(CodexOffStreamPlacement::OnTurn {
            turn_id: TEST_TURN.to_owned(),
        }),
        rollout: None,
    }
}

// Lets the session's record go with `exported` queued behind the let-go, so the session's task
// takes the hand-over once the record is gone; answers what the let-go sends, and answers the
// region read the hand-over's charge then waits on unanswered.
async fn let_go_ahead_of(
    session: &mut ExportingSession,
    exported: Vec<CodexExportedResponse>,
) -> Value {
    let service = &session.live.scripted.service;
    let session_id = session.live.session_id;
    let (reply, let_go) = oneshot::channel();
    let let_go_call = CodexLifecycleCall::LetGo {
        exit: CodexRecordExit::SessionClosed,
        reply,
    };
    let lifecycle = CodexSessionInbound::Lifecycle(let_go_call);
    assert!(service.push_session_item(&session_id, lifecycle).is_ok());
    let hand_over = CodexSessionInbound::ExportedResponses(exported);
    assert!(service.push_session_item(&session_id, hand_over).is_ok());
    tokio::pin!(let_go);
    let script = &mut session.live.scripted.script;
    let mut is_let_go = false;
    let mut region_read = None;
    while !is_let_go || region_read.is_none() {
        tokio::select! {
            gone = &mut let_go, if !is_let_go => {
                gone.expect("the record is let go");
                is_let_go = true;
            }
            sent = script.next_sent(), if region_read.is_none() => {
                if sent["method"] == "config/read" {
                    region_read = Some(sent);
                } else {
                    answer_stopping_request(script, &sent);
                }
            }
        }
    }
    region_read.expect("the hand-over's charge reads its region")
}

// An off-stream response whose hand-over the session's queue accepted, handled once the session's
// record was let go, is charged once to its account as its spend outside any session, at the
// region the session's rows are read at; the thread's rollout file read later, which no session
// takes, passes that response's line over and charges the line after it and the billed search it
// states, with its search. Killed by refusing a hand-over that reaches a record let go (nothing
// handed), by charging it without reading the session's region (no region read), by a charge that
// leaves its sighting off or a line charged past it (four handed), and by a search no session
// takes refused or charged without its count (no search charged).
#[tokio::test]
async fn a_hand_over_a_closing_session_accepted_is_charged_once_to_its_account() {
    let recorded = RecordedEvents::default();
    let _recording = recorded.record_until_dropped();
    let mut session = ExportingSession::start(&[TEST_TURN]).await;
    session.register_repricing();
    let service = Arc::clone(&session.live.scripted.service);
    let session_id = session.live.session_id;
    let now = read_unix_time_ms();

    let region_read = let_go_ahead_of(&mut session, vec![off_stream_response(now)]).await;
    session
        .live
        .scripted
        .script
        .answer(&region_read, &json!({"config": {}, "origins": {}}));
    poll_until(|| sessionless(&session).len(), |handed| *handed >= 1).await;

    let settings = json!({
        "type": "thread_settings_applied", "thread_id": TEST_THREAD, "thread_settings": {},
    });
    let search = json!({
        "type": "web_search_call", "id": "ws_closed", "status": "completed",
        "action": {"type": "search", "query": "steer order"},
        "internal_chat_message_metadata_passthrough": {"turn_id": TEST_TURN},
    });
    let mut file = CodexRolloutFile::default();
    let read: Vec<CodexExportedResponse> = [
        rollout_line(
            now,
            "session_meta",
            &json!({"id": TEST_THREAD, "source": "cli"}),
        ),
        turn_context(now, TEST_TURN),
        rollout_line(now, "event_msg", &settings),
        rollout_record(now, TEST_TURN, "response-closed", 300, 20),
        rollout_record(now, TEST_TURN, "response-after", 40, 4),
        rollout_line(now, "response_item", &search),
    ]
    .iter()
    .filter_map(|line| file.read_line(line.as_bytes(), 0))
    .filter_map(|request| {
        CodexExportedResponse::from_rollout(
            TEST_THREAD,
            request,
            None,
            Some(test_provider_account_id()),
        )
    })
    .collect();
    let charge = CodexLaunchCharge::new(
        service.dependencies().exports.sessionless_spend(),
        service.account_timeline(),
    );
    push_exported_responses(&service, session_id, read, &charge);
    poll_until(|| sessionless(&session).len(), |handed| *handed >= 3).await;

    assert_eq!(
        sessionless(&session),
        [(Some(300), Some(20)), (Some(40), Some(4)), (None, None)]
    );
    let searches: Vec<Option<u64>> = lock(&session.usage.sessionless)
        .iter()
        .map(|request| request.web_search_requests.map(SafeInt::get))
        .collect();
    assert_eq!(searches, [None, None, Some(1)]);
    assert!(lock(&session.usage.metered).is_empty());
    assert_eq!(refused(&recorded), 0);
}

// A charge the session's task makes once the daemon's stop began, of a hand-over its record let go
// can no longer file, is written before the driver's shutdown ends, since the shutdown waits for
// the sessions' tasks before the export tasks their charges are written on. Real time once the
// session is set up, under the stop's own bound. Killed by waiting on the export tasks first
// (nothing written as the shutdown ends).
#[tokio::test]
async fn a_charge_a_session_makes_as_the_daemon_stops_is_written_before_the_stop_ends() {
    let mut session = ExportingSession::start(&[TEST_TURN]).await;
    session.register_repricing();
    // The daemon's driver writes its sessions' charges on its own export tasks, as here.
    let spend = Arc::clone(
        session
            .live
            .scripted
            .service
            .dependencies()
            .exports
            .sessionless_spend(),
    );
    session.live.driver.export_tasks = spend.tasks().clone();
    let hand_over = vec![off_stream_response(read_unix_time_ms())];
    let region_read = let_go_ahead_of(&mut session, hand_over).await;
    tokio::time::resume();
    let parts = Arc::clone(session.live.driver.parts().expect("the driver composes"));

    let shutdown = session
        .live
        .driver
        .shutdown(DaemonStopIntent::Restart, daemon_stop_deadline());
    tokio::pin!(shutdown);
    // The stop leaves the session's slot just before it waits on the driver's tasks.
    tokio::select! {
        () = &mut shutdown => panic!("the stop waits for the session's charge"),
        _left = poll_until(|| parts.slots.held_sessions(), Vec::is_empty) => {}
    }
    session
        .live
        .scripted
        .script
        .answer(&region_read, &json!({"config": {}, "origins": {}}));
    shutdown.await;

    assert_eq!(sessionless(&session), [(Some(300), Some(20))]);
}
