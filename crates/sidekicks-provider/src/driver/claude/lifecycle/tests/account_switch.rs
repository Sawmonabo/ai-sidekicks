//! A session's move onto another account through the switch leg: in place between two store
//! accounts, by a relaunch between turns where a token account is either side, and the hand-back
//! after a login refusal.

use std::path::Path;
use std::pin::pin;
use std::sync::{Arc, Weak};

use futures::poll;

use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::provider::account::record::{ProviderAccountId, ProviderAuthMode};
use sidekicks_contracts::session::id::SessionId;
use tokio::io::AsyncWriteExt as _;
use tokio::sync::watch;

use super::start_params;
use crate::driver::ProviderAccountFolders;
use crate::driver::claude::account::credentials::{
    OAUTH_TOKEN_VARIABLE, SECURE_STORAGE_FOLDER_VARIABLE,
};
use crate::driver::claude::account::{ClaudeAccountLegs, test_account_legs};
use crate::driver::claude::session::control_requests::ClaudeControlRequests;
use crate::driver::claude::session::process::ClaudeOutputReader;
use crate::driver::claude::session::scripted::channel::ScriptedChannel;
use crate::driver::claude::session::scripted::driver::ScriptedDriver;
use crate::driver::claude::session::scripted::starts::ScriptedStartRecord;
use crate::driver::claude::session::scripted::{
    SCRIPTED_PROVIDER_SESSION_ID, binding_id, hand_scripted_frame, settle,
};
use crate::driver::claude::spawn::arguments::ClaudeConversationStart;
use crate::driver::contract::account::{
    FirstRequestAfterMove, ProviderSwitchLegs, SessionAccountMove, SessionToMove,
};
use crate::driver::diagnostics::{DriverDiagnosticKind, RecordedEvents};
use crate::driver::test_registry::new_run_id;
use crate::runtime_binding::test_store::test_provider_account_id;

// A driver with one session open on the default account's store, the account `to` registered as
// `to_mode` says, and the switch leg over its sessions.
struct SwitchFixture {
    fixture: ScriptedDriver,
    channel: Arc<ScriptedChannel>,
    start: ScriptedStartRecord,
    session_id: SessionId,
    legs: ClaudeAccountLegs,
    to: ProviderAccountId,
}

impl SwitchFixture {
    async fn new(to_mode: Option<ProviderAuthMode>) -> Self {
        let fixture = ScriptedDriver::new();
        let to = ProviderAccountId::new("account-to".to_owned()).expect("an account id fits");
        fixture.accounts.register(
            test_provider_account_id(),
            folders(fixture.folder.path(), "from"),
            None,
        );
        fixture
            .accounts
            .register(to.clone(), folders(fixture.folder.path(), "to"), to_mode);
        let channel = Arc::new(ScriptedChannel::default());
        let session_id = fixture.create(&channel).await;
        let start = fixture.next_start().await;
        let parts = fixture.driver.composed_parts().expect("composed");
        let legs = test_account_legs(&fixture.services, Arc::downgrade(&parts.establishment));
        Self {
            fixture,
            channel,
            start,
            session_id,
            legs,
            to,
        }
    }

    fn store(&self, name: &str) -> String {
        folders(self.fixture.folder.path(), name)
            .credential_store_folder
            .to_string_lossy()
            .into_owned()
    }

    async fn start_turn(&self) {
        self.fixture
            .driver
            .start_run(start_params(self.session_id, new_run_id()))
            .await
            .expect("the run starts");
    }

    async fn switch(&self) -> SessionAccountMove {
        let mut moves = self
            .legs
            .move_sessions(
                test_provider_account_id(),
                self.to.clone(),
                vec![SessionToMove {
                    session_id: self.session_id,
                    binding_id: binding_id("resting"),
                }],
            )
            .await;
        assert_eq!(moves.len(), 1);
        match moves.remove(0) {
            Ok(moved) => moved,
            Err((_, error)) => panic!("the move lands: {error:?}"),
        }
    }

    fn admitted(&self) -> ProviderAccountId {
        self.fixture
            .driver
            .composed_parts()
            .expect("composed")
            .slots()
            .live_session(self.session_id)
            .expect("the session is live")
            .admitted_provider_account_id()
    }

    fn frame(&self, start: &ScriptedStartRecord, frame: &Value) {
        let routes = &self
            .fixture
            .driver
            .composed_parts()
            .expect("composed")
            .run_start
            .routes;
        hand_scripted_frame(&*start.listener, routes, self.session_id, frame);
    }

    // The flag settings' `env` of every `apply_flag_settings` sent from `from` on.
    fn sent_environments(&self, from: usize) -> Vec<Value> {
        self.channel
            .control_requests()
            .split_off(from)
            .into_iter()
            .filter(|request| request["subtype"] == "apply_flag_settings")
            .map(|request| request["settings"]["env"].clone())
            .collect()
    }
}

fn folders(root: &Path, name: &str) -> ProviderAccountFolders {
    ProviderAccountFolders {
        configuration_folder: root.join(name).join("home"),
        credential_store_folder: root.join(name).join("store"),
    }
}

fn environment_value<'a>(start: &'a ScriptedStartRecord, name: &str) -> Option<&'a str> {
    start
        .environment
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.as_str())
}

// Between two store accounts an idle and a mid-turn session each get the new store alone, and
// move onto the account at the marker among its frames: the session's own account, its resting
// binding, a running turn's binding and the stream, so a limits report read after the move is the
// new account's. Killed by the move sent with a token, by the session's account left behind, by
// the resting binding left on the old account or moved when the answer is read, ahead of the
// frames queued before it, and by the stream's account left behind.
#[rstest]
#[case::idle(false)]
#[case::mid_turn(true)]
#[tokio::test(start_paused = true)]
async fn a_store_switch_points_the_session_at_the_new_store_in_place(#[case] is_mid_turn: bool) {
    let switch = SwitchFixture::new(None).await;
    if is_mid_turn {
        switch.start_turn().await;
    }
    let sent_before = switch.channel.control_requests().len();

    drop(switch.switch().await);
    assert!(
        switch.fixture.bindings.moves().is_empty(),
        "nothing moves before the session's queue reaches the marker"
    );
    settle().await;

    assert_eq!(
        switch.sent_environments(sent_before),
        [json!({SECURE_STORAGE_FOLDER_VARIABLE: switch.store("to")})]
    );
    assert_eq!(switch.admitted(), switch.to);
    let moves = switch.fixture.bindings.moves();
    assert!(moves.contains(&(binding_id("resting"), switch.to.clone())));
    assert_eq!(
        moves.contains(&(binding_id("lead"), switch.to.clone())),
        is_mid_turn
    );
    assert!(switch.fixture.starts.take_started().is_empty());

    switch.frame(
        &switch.start,
        &json!({
            "type": "rate_limit_event",
            "rate_limit_info": {
                "unifiedWindows": {"five_hour": {"utilization": 0.25, "resetsAt": 1_790_125_200}},
            },
            "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        }),
    );
    settle().await;
    let reported: Vec<ProviderAccountId> = switch
        .fixture
        .usage
        .quota_windows()
        .into_iter()
        .map(|(account, _)| account)
        .collect();
    assert_eq!(reported, std::slice::from_ref(&switch.to));
}

// The session process's output reader, made from its launch's account before an in-place switch,
// names the account the switch moved the process onto in a diagnostic it records after the switch
// is acknowledged. Killed by the reader keeping a copy of the account it was made with, and by the
// launch handed an account of its own rather than the stream's.
#[tokio::test(start_paused = true)]
async fn the_output_reader_names_the_account_the_switch_moved_onto() {
    let switch = SwitchFixture::new(None).await;
    let (mut provider, output) = tokio::io::duplex(4096);
    let reading = tokio::spawn(
        ClaudeOutputReader::new(
            ClaudeControlRequests::new(Arc::new(|_request_id: &str| {})),
            Arc::clone(&switch.start.listener),
            None,
            watch::channel(0).0,
            Weak::new(),
            SCRIPTED_PROVIDER_SESSION_ID.to_owned(),
            switch.start.account.clone(),
        )
        .read(output),
    );

    drop(switch.switch().await);
    settle().await;
    let recorded = RecordedEvents::default();
    let recording = recorded.record_until_dropped();
    provider
        .write_all(b"not a frame\n")
        .await
        .expect("the pipe takes the line");
    drop(provider);
    reading.await.expect("the reader ends with its output");
    drop(recording);

    assert_eq!(
        recorded.field_on(
            DriverDiagnosticKind::UnmappedWireKind.counter_name(),
            "provider_account_id"
        ),
        [switch.to.as_str()]
    );
}

// A token target never reaches the process in place: a busy session starts again only once its
// turn settled, resuming its conversation by id on the new account's store, with no token in its
// environment, which the launcher hands it on its pipe instead, its lead's binding moved before
// the new process starts, so the binding the relaunch records copies the new account. Killed by
// the token sent on `env`, by a relaunch that ends the running turn, by a relaunch on the old
// account or a new conversation, and by the binding moved only once the relaunch landed.
#[tokio::test(start_paused = true)]
async fn a_token_target_relaunches_between_turns_and_resumes_by_id() {
    let switch = SwitchFixture::new(Some(ProviderAuthMode::OauthToken)).await;
    switch.start_turn().await;
    let ClaudeConversationStart::New {
        provider_session_id: conversation,
    } = &switch.start.conversation
    else {
        panic!("the create starts a new conversation");
    };
    let sent_before = switch.channel.control_requests().len();
    switch
        .fixture
        .starts
        .script_session(Arc::new(ScriptedChannel::default()));

    let mut moving = pin!(switch.switch());
    assert!(poll!(&mut moving).is_pending());
    settle().await;
    assert!(
        poll!(&mut moving).is_pending(),
        "the move waits for the turn"
    );
    assert!(switch.fixture.starts.take_started().is_empty());
    switch.fixture.end_turn(&switch.start, switch.session_id);
    let relaunched = switch.fixture.next_start().await;
    assert_eq!(
        switch.fixture.bindings.moves(),
        [(binding_id("resting"), switch.to.clone())],
        "the lead's binding is on the new account before its relaunch starts"
    );
    drop(moving.await);

    assert!(matches!(
        &relaunched.conversation,
        ClaudeConversationStart::Resume { resume_handle } if resume_handle == conversation
    ));
    assert_eq!(
        environment_value(&relaunched, SECURE_STORAGE_FOLDER_VARIABLE),
        Some(switch.store("to").as_str())
    );
    assert_eq!(environment_value(&relaunched, OAUTH_TOKEN_VARIABLE), None);
    assert_eq!(switch.sent_environments(sent_before), Vec::<Value>::new());
    assert_eq!(switch.admitted(), switch.to);
    assert_eq!(
        switch.fixture.bindings.moves(),
        [(binding_id("resting"), switch.to.clone())],
        "the binding the relaunch left is never moved again"
    );
}

// A login refusal on the first request after a store switch sends the previous store and moves
// the session and its bindings back. Killed by no hand-back, and by a hand-back that leaves the
// session's account or a binding on the refused account.
#[tokio::test(start_paused = true)]
async fn a_login_refusal_after_the_move_hands_the_previous_account_back() {
    let switch = SwitchFixture::new(None).await;
    let sent_before = switch.channel.control_requests().len();
    let moved = switch.switch().await;
    settle().await;
    switch.start_turn().await;

    switch.frame(
        &switch.start,
        &json!({
            "type": "system",
            "subtype": "api_retry",
            "attempt": 1,
            "max_retries": 10,
            "retry_delay_ms": 500,
            "error_status": 401,
            "error": "authentication_failed",
            "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        }),
    );

    assert_eq!(
        moved.first_request.await.expect("the hand-back is made"),
        FirstRequestAfterMove::HandedBack
    );
    settle().await;
    assert_eq!(
        switch.sent_environments(sent_before),
        [
            json!({SECURE_STORAGE_FOLDER_VARIABLE: switch.store("to")}),
            json!({SECURE_STORAGE_FOLDER_VARIABLE: switch.store("from")}),
        ]
    );
    assert_eq!(switch.admitted(), test_provider_account_id());
    // Each binding's last move, the marker's and the leg's landing in either order.
    let moves = switch.fixture.bindings.moves();
    for binding in [binding_id("resting"), binding_id("lead")] {
        let last = moves.iter().rev().find(|(moved, _)| *moved == binding);
        assert_eq!(
            last.map(|(_, account)| account),
            Some(&test_provider_account_id()),
            "{binding:?}"
        );
    }
}

// A reply begun before an in-place switch streams its messages on after the move, so the switch
// hears its first request only at the `message_start` of a reply opened after it. Killed by any
// answered `assistant` frame settling the watch.
#[tokio::test(start_paused = true)]
async fn the_first_request_after_a_store_switch_is_heard_at_its_message_start() {
    let switch = SwitchFixture::new(None).await;
    switch.start_turn().await;
    let mut moved = switch.switch().await;
    settle().await;

    switch.frame(
        &switch.start,
        &json!({
            "type": "assistant",
            "session_id": SCRIPTED_PROVIDER_SESSION_ID,
            "message": {
                "id": "message-begun-before",
                "role": "assistant",
                "content": [{"type": "text", "text": "still streaming"}],
            },
        }),
    );
    settle().await;
    assert!(
        poll!(&mut moved.first_request).is_pending(),
        "a reply begun before the move is no request on the new account"
    );

    switch.frame(
        &switch.start,
        &json!({
            "type": "stream_event",
            "session_id": SCRIPTED_PROVIDER_SESSION_ID,
            "event": {"type": "message_start", "message": {"id": "message-after"}},
        }),
    );
    assert_eq!(
        moved.first_request.await.expect("the watch is answered"),
        FirstRequestAfterMove::Ran
    );
}
