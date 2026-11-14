//! An exported response on a thread no session streams: a search its thread's rollout file states
//! charged once while the export arrives, a search copied into a fork's file never, a thread no
//! session will ever hold charged to its account, a held response counted on its session once its
//! thread is listed, its file found wherever Codex keeps it, and a response kept as its launch ends
//! charged to its account once, its file's line passed over.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::unix_time::read_unix_time_ms;

use super::TEST_TURN;
use super::export_usage::{
    ExportingSession, SECOND_TURN, counts, rollout_line, rollout_record, stamped_record,
    turn_context, wire_counts,
};
use super::usage::{answer_region_read, token_usage_frame};
use crate::bounded_poll::poll_until;
use crate::driver::codex::service::supervisor::test_service::ScriptedCodexService;
use crate::driver::codex::session::test_fixture::{TEST_THREAD, turn_completed, turn_started};
use crate::driver::codex::telemetry::exports::tests::refused;
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
    answer_region_read(&mut session.live.scripted).await;
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
