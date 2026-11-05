//! What a session's processes showed the inspector: kept from each spawn, refreshed by each
//! context read, and kept past the process until the session closes or is purged.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::Ordering;

use serde_json::{Value, json};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::inspector::SessionHookListResponse;

use crate::driver::claude::session::inspector_reads::{
    ClaudeInspectorReads, ClaudeKeptHookListing, ClaudeKeptMemory,
};
use crate::driver::claude::session::scripted::channel::{ScriptedAnswer, ScriptedChannel};
use crate::driver::claude::session::scripted::driver::ScriptedDriver;
use crate::driver::claude::session::scripted::settle;
use crate::driver::claude::session::transport::declarations::ClaudeInitializeDeclaration;
use crate::driver::contract::params_and_results::SessionProcessState;
use crate::driver::session_control::{CloseSessionParams, PurgeSessionParams, SessionCloseCause};

// A listing of one hook from the account's settings, under a policy that keeps it running.
fn listing_reply() -> Value {
    json!({
        "hooks": [{"event": "SessionStart", "matcher": "", "source": "userSettings",
                   "type": "command", "commandText": "audit.sh"}],
        "policy": {"disabledByPolicy": false, "managedOnly": false, "pluginOnly": false,
                   "allDisabled": false, "policyHookCount": 0}
    })
}

// A context reply on a 200,000-token window naming one memory file.
fn context_reply(memory_file: &str) -> Value {
    json!({
        "categories": [
            {"id": "memory_files", "name": "Memory files", "tokens": 1_000, "kind": "used"},
            {"id": "free_space", "name": "Free space", "tokens": 199_000, "kind": "free"},
        ],
        "totalTokens": 1_000,
        "maxTokens": 200_000,
        "rawMaxTokens": 200_000,
        "autoCompactThreshold": 100_000,
        "model": "claude-opus-5-5",
        "memoryFiles": [{"path": memory_file, "tokens": 1_000}],
    })
}

fn inspector_reads(fixture: &ScriptedDriver) -> &ClaudeInspectorReads {
    &fixture
        .driver
        .composed_parts()
        .expect("the pieces are composed")
        .establishment
        .inspector_reads
}

// The one hook's command a kept listing holds, or `None` for any other kept value.
fn listed_command(listing: &ClaudeKeptHookListing) -> Option<Vec<&str>> {
    let ClaudeKeptHookListing::Listed(SessionHookListResponse::ByEvent { hooks, .. }) = listing
    else {
        return None;
    };
    Some(
        hooks
            .iter()
            .map(|hook| hook.command_text.as_str())
            .collect(),
    )
}

fn sent(channel: &ScriptedChannel, subtype: &str) -> usize {
    channel
        .control_requests()
        .iter()
        .filter(|request| request["subtype"] == subtype)
        .count()
}

// A session on a fresh process whose relaunch after its exit is refused, so it rests `Down`, with
// its listing kept before the exit.
async fn session_brought_down(fixture: &ScriptedDriver, reported: usize) -> SessionId {
    let channel = Arc::new(ScriptedChannel::default());
    channel.answer("get_hooks_listing", ScriptedAnswer::Reply(listing_reply()));
    let session_id = fixture.create(&channel).await;
    let start = fixture.next_start().await;
    let reads = inspector_reads(fixture);
    assert_eq!(
        listed_command(&reads.kept_hook_listing(session_id).await),
        Some(vec!["audit.sh"])
    );
    // No process is scripted for the relaunch, which is refused before any start, so the next
    // create takes its own.
    fixture
        .relaunches
        .is_open_refused
        .store(true, Ordering::SeqCst);
    ScriptedDriver::exit(&start);
    assert_eq!(fixture.relaunches.reported(reported).await.len(), reported);
    settle().await;
    assert_eq!(
        fixture.driver.session_process_state(session_id),
        SessionProcessState::Down
    );
    session_id
}

// Killed by: no listing sent; the listing's reply dropped; the stores not kept; files kept only
// from a first read; files not taken from the read at all; the inspector making a read of its own;
// a listing per read; a listing under way answered `Unread`, since the create returns once the
// listing is written, before its answer.
#[tokio::test]
async fn a_spawn_keeps_its_stores_and_listing_and_each_read_refreshes_the_files() {
    let fixture = ScriptedDriver::new();
    let store = PathBuf::from("/memory/store");
    fixture
        .starts
        .script_initialize(ClaudeInitializeDeclaration {
            memory_stores: vec![store.clone()],
            ..ClaudeInitializeDeclaration::default()
        });
    let channel = Arc::new(ScriptedChannel::default());
    let release = channel.hold_next_control("get_hooks_listing");
    channel.answer("get_hooks_listing", ScriptedAnswer::Reply(listing_reply()));
    channel.answer(
        "get_context_usage",
        ScriptedAnswer::Reply(context_reply("a")),
    );
    channel.answer(
        "get_context_usage",
        ScriptedAnswer::Reply(context_reply("b")),
    );
    let session_id = fixture.create(&channel).await;
    let start = fixture.next_start().await;
    let reads = inspector_reads(&fixture);

    // The read starts while the listing's answer is held, then the answer goes.
    let (listing, ()) = tokio::join!(reads.kept_hook_listing(session_id), async {
        drop(release);
    });
    assert_eq!(listed_command(&listing), Some(vec!["audit.sh"]));
    let kept = reads.kept_memory(session_id).expect("the spawn is kept");
    assert_eq!(kept.files, Vec::<PathBuf>::new());
    assert_eq!(kept.stores, vec![store.clone()]);

    fixture.end_turn(&start, session_id);
    ScriptedDriver::wait_for(|| {
        reads
            .kept_memory(session_id)
            .is_some_and(|kept| kept.files == [PathBuf::from("b")])
    })
    .await;
    settle().await;

    assert_eq!(
        reads.kept_memory(session_id),
        Some(ClaudeKeptMemory {
            files: vec![PathBuf::from("b")],
            stores: vec![store],
            auto_memory: None,
        })
    );
    assert_eq!(sent(&channel, "get_context_usage"), 2);
    assert_eq!(sent(&channel, "get_hooks_listing"), 1);
}

// Killed by: the rows dropped at the process's end; no forget at close; a forget in
// `purge_session` placed after its early return for no conversations.
#[tokio::test(start_paused = true)]
async fn a_sessions_rows_outlive_its_process_and_go_at_close_or_purge() {
    let fixture = ScriptedDriver::new();
    let closed = session_brought_down(&fixture, 1).await;
    let reads = inspector_reads(&fixture);
    assert!(reads.kept_memory(closed).is_some());
    assert_eq!(
        listed_command(&reads.kept_hook_listing(closed).await),
        Some(vec!["audit.sh"])
    );

    fixture
        .driver
        .close_session(CloseSessionParams {
            session_id: closed,
            cause: SessionCloseCause::Person,
        })
        .await
        .expect("the session closes");
    assert_eq!(reads.kept_memory(closed), None);
    assert_eq!(
        reads.kept_hook_listing(closed).await,
        ClaudeKeptHookListing::NoProcess
    );

    let purged = session_brought_down(&fixture, 2).await;
    assert!(reads.kept_memory(purged).is_some());
    fixture
        .driver
        .purge_session(PurgeSessionParams {
            session_id: purged,
            conversations: Vec::new(),
        })
        .await
        .expect("the purge finishes");
    assert_eq!(reads.kept_memory(purged), None);
    assert_eq!(
        reads.kept_hook_listing(purged).await,
        ClaudeKeptHookListing::NoProcess
    );
}
