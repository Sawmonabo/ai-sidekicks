//! What a session's processes showed the inspector: kept from each spawn, refreshed by each
//! context read, kept past the process until the session closes or is purged, and answered to the
//! inspector's Memory and Hooks reads without starting a process.

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::Ordering;

use serde_json::{Value, json};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::session::inspector::{
    SessionHookListResponse, SessionMemoryEntry, SessionMemoryEntryKind, SessionMemoryHomeScope,
};

use crate::bounded_poll::poll_until;
use crate::driver::ProviderAccountFolders;
use crate::driver::claude::session::establishment::spawn_sources::claude_account_config_folder;
use crate::driver::claude::session::inspector_reads::{
    ClaudeInspectorReads, ClaudeKeptHookListing, ClaudeKeptMemory,
};
use crate::driver::claude::session::rules::CLAUDE_USER_SETTINGS_FILE;
use crate::driver::claude::session::scripted::channel::{ScriptedAnswer, ScriptedChannel};
use crate::driver::claude::session::scripted::driver::{
    ScriptedDriver, create_params, sandbox_cannot_run,
};
use crate::driver::claude::session::scripted::held_calls::init;
use crate::driver::claude::session::scripted::starts::ScriptedStartRecord;
use crate::driver::claude::session::scripted::{hand_scripted_frame, settle};
use crate::driver::claude::session::transport::declarations::ClaudeInitializeDeclaration;
use crate::driver::contract::params_and_results::SessionProcessState;
use crate::driver::session_control::{
    CloseSessionParams, PurgeSessionParams, SessionAccountPin, SessionCloseCause,
};
use crate::driver::session_inspector::InspectedSession;
use crate::driver::test_registry::new_session_id;
use crate::runtime_binding::test_store::test_provider_account_id;

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
    bring_down(fixture, &start, session_id, reported).await;
    session_id
}

// Ends the process `start` brought up for `session_id` and refuses its relaunch, so the session
// rests `Down`; `reported` counts every relaunch refused so far.
async fn bring_down(
    fixture: &ScriptedDriver,
    start: &ScriptedStartRecord,
    session_id: SessionId,
    reported: usize,
) {
    // No process is scripted for the relaunch, which is refused before any start, so the next
    // create takes its own.
    fixture
        .relaunches
        .is_open_refused
        .store(true, Ordering::SeqCst);
    ScriptedDriver::exit(start);
    assert_eq!(fixture.relaunches.reported(reported).await.len(), reported);
    settle().await;
    assert_eq!(
        fixture.driver.session_process_state(session_id),
        SessionProcessState::Down
    );
}

// The session the inspector reads on the test account in the fixture's work folder, with the
// stored `Auto memory` switch `auto_memory`.
fn inspected(
    fixture: &ScriptedDriver,
    session_id: SessionId,
    auto_memory: Option<bool>,
) -> InspectedSession {
    InspectedSession {
        session_id,
        provider_account_id: test_provider_account_id(),
        account_pin: SessionAccountPin::Pinned,
        runtime_metadata: None,
        working_folder: fixture.work.clone(),
        auto_memory,
    }
}

fn filesystem_path(path: &Path) -> FilesystemPath {
    FilesystemPath::new(path.to_string_lossy().into_owned()).expect("a test path fits")
}

fn memory_entry(path: &str, kind: SessionMemoryEntryKind) -> SessionMemoryEntry {
    SessionMemoryEntry {
        path: filesystem_path(Path::new(path)),
        kind,
    }
}

// Killed by: no listing sent; the listing's reply dropped; the stores not kept; files kept only
// from a first read; files not taken from the read at all; the inspector making a read of its own;
// a listing per read.
#[tokio::test]
async fn a_spawn_keeps_its_stores_and_listing_and_each_read_refreshes_the_files() {
    let fixture = ScriptedDriver::new();
    let store = filesystem_path(Path::new("/memory/store"));
    fixture
        .starts
        .script_initialize(ClaudeInitializeDeclaration {
            memory_stores: vec![store.clone()],
            ..ClaudeInitializeDeclaration::default()
        });
    let channel = Arc::new(ScriptedChannel::default());
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

    assert_eq!(
        listed_command(&reads.kept_hook_listing(session_id).await),
        Some(vec!["audit.sh"])
    );
    let kept = reads.kept_memory(session_id).expect("the spawn is kept");
    assert_eq!(kept.files, Vec::<FilesystemPath>::new());
    assert_eq!(kept.stores, vec![store.clone()]);

    fixture.end_turn(&start, session_id);
    poll_until(
        || reads.kept_memory(session_id),
        |kept| (kept.as_ref()).is_some_and(|kept| kept.files == [filesystem_path(Path::new("b"))]),
    )
    .await;
    settle().await;

    assert_eq!(
        reads.kept_memory(session_id),
        Some(ClaudeKeptMemory {
            files: vec![filesystem_path(Path::new("b"))],
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

// Killed by the forget placed before the close waits for the spawn under way, whose adoption then
// keeps its rows and listing for a closed session.
#[tokio::test(start_paused = true)]
async fn a_close_during_a_spawn_leaves_no_rows() {
    let fixture = ScriptedDriver::new();
    let session_id = new_session_id();
    let channel = Arc::new(ScriptedChannel::default());
    fixture.starts.script_session(Arc::clone(&channel));
    let release = fixture.starts.hold_next_session_start();
    let driver = Arc::clone(&fixture.driver);
    let create =
        tokio::spawn(async move { driver.create_session(create_params(session_id)).await });
    fixture.starts.wait_for_starts(1).await;
    let driver = Arc::clone(&fixture.driver);
    let close = tokio::spawn(async move {
        driver
            .close_session(CloseSessionParams {
                session_id,
                cause: SessionCloseCause::Person,
            })
            .await
    });
    settle().await;

    drop(release);
    create
        .await
        .expect("the create runs")
        .expect("the create succeeds");
    close
        .await
        .expect("the close runs")
        .expect("the close succeeds");

    let reads = inspector_reads(&fixture);
    assert_eq!(reads.kept_memory(session_id), None);
    assert_eq!(
        reads.kept_hook_listing(session_id).await,
        ClaudeKeptHookListing::NoProcess
    );
}

// Killed by: a read starting a process; the kept rows ignored; `listedAtNextStart` for a session
// that had a process; an unreadable listing answered as the next start; the stores or files
// dropped or swapped; the home read from another environment than the last process's.
#[tokio::test(start_paused = true)]
async fn a_gone_process_answers_its_kept_rows_and_starts_nothing() {
    let fixture = ScriptedDriver::new();
    fixture
        .starts
        .script_initialize(ClaudeInitializeDeclaration {
            memory_stores: vec![filesystem_path(Path::new("/memory/store"))],
            ..ClaudeInitializeDeclaration::default()
        });
    let channel = Arc::new(ScriptedChannel::default());
    channel.answer("get_hooks_listing", ScriptedAnswer::Reply(listing_reply()));
    // The turn's end asks two reads; both name `a`.
    for _ in 0..2 {
        channel.answer(
            "get_context_usage",
            ScriptedAnswer::Reply(context_reply("a")),
        );
    }
    let session_id = fixture.create(&channel).await;
    let start = fixture.next_start().await;
    let reads = inspector_reads(&fixture);
    fixture.end_turn(&start, session_id);
    poll_until(
        || reads.kept_memory(session_id),
        |kept| (kept.as_ref()).is_some_and(|kept| kept.files == [filesystem_path(Path::new("a"))]),
    )
    .await;
    settle().await;
    assert_eq!(
        listed_command(&reads.kept_hook_listing(session_id).await),
        Some(vec!["audit.sh"])
    );
    let live = fixture
        .driver
        .composed_parts()
        .expect("the pieces are composed")
        .slots()
        .live_session(session_id)
        .expect("the session is live");
    let home = claude_account_config_folder(&live.spawn_bound_legs.spawn_environment);
    drop(live);
    bring_down(&fixture, &start, session_id, 1).await;

    // A second session whose listing reply was left unscripted, an empty response.
    let unlisted_channel = Arc::new(ScriptedChannel::default());
    let unlisted = fixture.create(&unlisted_channel).await;
    let unlisted_start = fixture.next_start().await;
    assert_eq!(
        reads.kept_hook_listing(unlisted).await,
        ClaudeKeptHookListing::Unread
    );
    bring_down(&fixture, &unlisted_start, unlisted, 2).await;

    let memory = fixture
        .driver
        .read_session_memory(&inspected(&fixture, session_id, None))
        .await
        .expect("the memory reads");
    assert_eq!(
        memory.entries,
        vec![
            memory_entry("a", SessionMemoryEntryKind::File),
            memory_entry("/memory/store", SessionMemoryEntryKind::Folder),
        ]
    );
    assert!(!memory.listed_at_next_start);
    assert_eq!(memory.home_scope, SessionMemoryHomeScope::Account);
    assert_eq!(memory.home, filesystem_path(&home));
    let hooks = fixture
        .driver
        .list_session_hooks(&inspected(&fixture, session_id, None))
        .await
        .expect("the hooks list");
    assert_eq!(
        listed_command(&ClaudeKeptHookListing::Listed(hooks)),
        Some(vec!["audit.sh"])
    );
    assert!(
        fixture
            .driver
            .list_session_hooks(&inspected(&fixture, unlisted, None))
            .await
            .is_err()
    );
    assert!(fixture.starts.take_started().is_empty());
}

// Killed by: the settings walk skipped; the walk reading another home than the account's; a read
// starting a process; a session with no process answered as an error.
#[tokio::test(start_paused = true)]
async fn a_session_with_no_process_since_the_daemon_started_answers_at_next_start() {
    let account_folder = tempfile::tempdir().expect("the test makes an account folder");
    let config_folder = account_folder.path().join("config");
    let fixture = ScriptedDriver::with_account_folders_and_sandbox_check(
        Some(ProviderAccountFolders {
            configuration_folder: config_folder.clone(),
            credential_store_folder: account_folder.path().join("credentials"),
        }),
        sandbox_cannot_run,
    );
    std::fs::create_dir_all(&config_folder).expect("the account's config folder is made");
    std::fs::write(
        config_folder.join(CLAUDE_USER_SETTINGS_FILE),
        json!({"autoMemoryEnabled": false}).to_string(),
    )
    .expect("the account's settings are written");
    let session = inspected(&fixture, new_session_id(), None);

    let memory = fixture
        .driver
        .read_session_memory(&session)
        .await
        .expect("the memory reads");
    assert!(memory.listed_at_next_start);
    assert_eq!(memory.entries, Vec::new());
    assert!(!memory.auto_memory.enabled);
    let hooks = fixture
        .driver
        .list_session_hooks(&session)
        .await
        .expect("the hooks list");
    assert!(matches!(
        hooks,
        SessionHookListResponse::ListedAtNextStart { .. }
    ));
    assert!(fixture.starts.take_started().is_empty());
}

// Killed by: an opening that reads again while one is under way, as a read of its own or one asked
// behind it; an opening that answers before the read is held, when no file is kept yet; an
// opening that sends a listing of its own.
#[tokio::test]
async fn an_opening_joins_a_read_under_way_and_sends_no_listing() {
    let fixture = ScriptedDriver::new();
    let channel = Arc::new(ScriptedChannel::default());
    channel.answer("get_hooks_listing", ScriptedAnswer::Reply(listing_reply()));
    let release = channel.hold_next_control("get_context_usage");
    channel.answer(
        "get_context_usage",
        ScriptedAnswer::Reply(context_reply("a")),
    );
    let session_id = fixture.create(&channel).await;
    let start = fixture.next_start().await;
    // The process's own start, with no run open, asks one read.
    let routes = &fixture
        .driver
        .composed_parts()
        .expect("the pieces are composed")
        .run_start
        .routes;
    hand_scripted_frame(&*start.listener, routes, session_id, &init());
    poll_until(|| sent(&channel, "get_context_usage"), |count| *count == 1).await;
    let session = inspected(&fixture, session_id, None);

    // The opening starts while that read is held, then the read's answer goes.
    let (memory, ()) = tokio::join!(fixture.driver.read_session_memory(&session), async {
        drop(release);
    });
    let memory = memory.expect("the memory reads");
    assert!(
        memory
            .entries
            .contains(&memory_entry("a", SessionMemoryEntryKind::File))
    );
    fixture
        .driver
        .list_session_hooks(&session)
        .await
        .expect("the hooks list");
    settle().await;

    assert_eq!(sent(&channel, "get_context_usage"), 1);
    assert_eq!(sent(&channel, "get_hooks_listing"), 1);
}

// Killed by: a listing under way answered as an error or as the next start; a read that sends its
// own listing.
#[tokio::test]
async fn an_opening_while_the_starts_listing_is_under_way_waits_for_it() {
    let fixture = ScriptedDriver::new();
    let channel = Arc::new(ScriptedChannel::default());
    let release = channel.hold_next_control("get_hooks_listing");
    channel.answer("get_hooks_listing", ScriptedAnswer::Reply(listing_reply()));
    // The create returns once the listing is written, before its answer.
    let session_id = fixture.create(&channel).await;
    let session = inspected(&fixture, session_id, None);

    let (hooks, ()) = tokio::join!(fixture.driver.list_session_hooks(&session), async {
        release.send(()).expect("the listing's answer is held");
    });
    assert_eq!(
        listed_command(&ClaudeKeptHookListing::Listed(
            hooks.expect("the hooks list")
        )),
        Some(vec!["audit.sh"])
    );
    assert_eq!(sent(&channel, "get_hooks_listing"), 1);
}
