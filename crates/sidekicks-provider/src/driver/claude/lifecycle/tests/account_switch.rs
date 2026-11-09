//! A session's move onto another account through the switch leg: a relaunch between turns onto a
//! store or a token account, and the hand-back after a login refusal.

use std::path::Path;
use std::pin::pin;
use std::sync::Arc;

use futures::poll;

use rstest::rstest;
use serde_json::{Map, Value, json};
use sidekicks_contracts::provider::account::record::{ProviderAccountId, ProviderAuthMode};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::id::mint_uuid_v7;

use super::start_params;
use crate::driver::ProviderAccountFolders;
use crate::driver::claude::account::credentials::{
    OAUTH_TOKEN_VARIABLE, SECURE_STORAGE_FOLDER_VARIABLE,
};
use crate::driver::claude::account::{ClaudeAccountLegs, test_account_legs};
use crate::driver::claude::session::conversation_home::claude_conversation_home_metadata;
use crate::driver::claude::session::restart::ClaudeSessionStanding;
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
use crate::driver::contract::error::DriverError;
use crate::driver::test_registry::new_run_id;
use crate::runtime_binding::store::CreateRuntimeBindingInput;
use crate::runtime_binding::test_store::{
    binding_input, open_store, spawn_config_on, spawned_build, test_provider_account_id,
};

// A driver with one session open on the default account's store, the account `to` registered as
// `to_mode` says, the rows of the session's resting binding and its lead run's binding, each
// holding a member of recovery data another writer kept, and the switch leg over its sessions.
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
        let store = open_store(&fixture.database).await;
        for name in ["resting", "lead"] {
            store
                .create(CreateRuntimeBindingInput {
                    id: binding_id(name),
                    runtime_metadata: kept_by_another_writer(),
                    ..binding_input(
                        spawn_config_on(test_provider_account_id()),
                        spawned_build("1.0.0", "/opt/provider/bin"),
                    )
                })
                .await
                .expect("the binding is recorded");
        }
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
        self.switch_to(&self.to).await.expect("the move lands")
    }

    // The session's move from the default account onto `to`, as the switch leg answers it.
    async fn switch_to(&self, to: &ProviderAccountId) -> Result<SessionAccountMove, DriverError> {
        let mut moves = self
            .legs
            .move_sessions(
                test_provider_account_id(),
                to.clone(),
                vec![SessionToMove {
                    session_id: self.session_id,
                    binding_id: binding_id("resting"),
                }],
                switching_person(),
            )
            .await;
        assert_eq!(moves.len(), 1);
        moves.remove(0).map_err(|(_, error)| error)
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

// The person whose switch the tests make; a Claude Code move names every session it moves.
fn switching_person() -> DeviceId {
    DeviceId::new(mint_uuid_v7().to_string()).expect("a minted UUID is a device id")
}

fn folders(root: &Path, name: &str) -> ProviderAccountFolders {
    ProviderAccountFolders {
        configuration_folder: root.join(name).join("home"),
        credential_store_folder: root.join(name).join("store"),
    }
}

// Recovery data a writer other than the switch kept on a binding.
fn kept_by_another_writer() -> Map<String, Value> {
    Map::from_iter([("contextFixedStartTokens".to_owned(), json!(12_000))])
}

// `kept_by_another_writer` with the member naming `home` as the conversation's.
fn kept_with_home(home: &Path) -> Map<String, Value> {
    let mut runtime_metadata = kept_by_another_writer();
    runtime_metadata.extend(claude_conversation_home_metadata(home));
    runtime_metadata
}

fn environment_value<'a>(environment: &'a [(String, String)], name: &str) -> Option<&'a str> {
    environment
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.as_str())
}

// Every switch, onto a store account or a token account, waits for a busy session's turn, then
// starts its process again on the new account, resuming its conversation by id on the new
// account's store, with no token in its environment, which the launcher hands a token account's
// process on its pipe instead; nothing is sent in place. Its lead's binding moves before the new
// process starts, so the binding the relaunch records copies the new account. The conversation
// stays in the home it was written into: the binding records that home before it moves, and the
// relaunch resumes there on the new account's store. Killed by a store switch sent in place with
// `apply_flag_settings`, by the token sent on `env`, by a relaunch that ends the running turn or
// starts before the turn settled, by a relaunch on the old account or a new conversation, by the
// binding moved only once the relaunch landed, by the home left unrecorded or recorded over the
// recovery data another writer kept, by a relaunch in the new account's own home, and by a
// scratch folder that follows the account rather than the home.
#[rstest]
#[case::store(None)]
#[case::token(Some(ProviderAuthMode::OauthToken))]
#[tokio::test(start_paused = true)]
async fn a_switch_relaunches_between_turns_and_resumes_by_id(
    #[case] to_mode: Option<ProviderAuthMode>,
) {
    let switch = SwitchFixture::new(to_mode).await;
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
        environment_value(&relaunched.environment, SECURE_STORAGE_FOLDER_VARIABLE),
        Some(switch.store("to").as_str())
    );
    assert_eq!(
        environment_value(&relaunched.environment, OAUTH_TOKEN_VARIABLE),
        None
    );
    let conversation_home = folders(switch.fixture.folder.path(), "from").configuration_folder;
    assert_eq!(
        environment_value(&relaunched.environment, "CLAUDE_CONFIG_DIR"),
        Some(conversation_home.to_string_lossy().as_ref())
    );
    assert_eq!(
        environment_value(&relaunched.environment, "CLAUDE_CODE_TMPDIR"),
        environment_value(&switch.start.environment, "CLAUDE_CODE_TMPDIR"),
        "the scratch folder stays with the conversation's home"
    );
    assert_eq!(
        switch.fixture.bindings.recovery_data(),
        [(binding_id("resting"), kept_with_home(&conversation_home))]
    );
    assert_eq!(switch.sent_environments(sent_before), Vec::<Value>::new());
    assert_eq!(switch.admitted(), switch.to);
    assert_eq!(
        switch.fixture.bindings.moves(),
        [(binding_id("resting"), switch.to.clone())],
        "the binding the relaunch left is never moved again"
    );
}

// A second switch asked while the session's turn is held replaces the one waiting: once the turn
// settles the process starts again once, on the second switch's account, and the first switch is
// answered with that account rather than told the provider is unavailable. Killed by the waiting
// move's answer dropped when a later move replaces it, by a relaunch for each switch, and by a
// relaunch on the first switch's account.
#[tokio::test(start_paused = true)]
async fn a_second_switch_during_a_held_turn_replaces_the_waiting_one() {
    let switch = SwitchFixture::new(None).await;
    let newest = ProviderAccountId::new("account-newest".to_owned()).expect("an account id fits");
    switch.fixture.accounts.register(
        newest.clone(),
        folders(switch.fixture.folder.path(), "newest"),
        None,
    );
    switch.start_turn().await;
    switch
        .fixture
        .starts
        .script_session(Arc::new(ScriptedChannel::default()));

    // Each move records the conversation's home, then waits for the turn in the same poll.
    let mut replaced = pin!(switch.switch_to(&switch.to));
    while switch.fixture.bindings.recovery_data().is_empty() {
        assert!(
            poll!(&mut replaced).is_pending(),
            "the move waits for the turn"
        );
        settle().await;
    }
    let mut newer = pin!(switch.switch_to(&newest));
    while switch.fixture.bindings.recovery_data().len() < 2 {
        assert!(
            poll!(&mut newer).is_pending(),
            "the move waits for the turn"
        );
        settle().await;
    }
    assert!(switch.fixture.starts.take_started().is_empty());
    switch.fixture.end_turn(&switch.start, switch.session_id);
    let relaunched = switch.fixture.next_start().await;
    let (replaced, newer) = tokio::join!(replaced, newer);
    settle().await;

    drop(newer.expect("the newer move lands"));
    let Err(replaced) = replaced else {
        panic!("the replaced move reports a landing on its own account");
    };
    assert!(
        std::error::Error::source(&replaced)
            .is_some_and(|cause| cause.to_string().contains(newest.as_str())),
        "the replaced move names the account the session landed on: {replaced:?}"
    );
    assert_eq!(
        environment_value(&relaunched.environment, SECURE_STORAGE_FOLDER_VARIABLE),
        Some(switch.store("newest").as_str())
    );
    assert!(
        switch.fixture.starts.take_started().is_empty(),
        "one relaunch"
    );
    assert_eq!(switch.admitted(), newest);
    assert_eq!(
        switch.fixture.bindings.moves(),
        [(binding_id("resting"), newest.clone())]
    );
}

// A login refusal on the first request of the process a store switch started again moves the
// session back the same way: once that turn settles its process starts again on the previous
// account's store, under the binding the move's relaunch recorded, moved back first. Killed by no
// hand-back, by a hand-back sent in place, and by a hand-back that leaves the session's account
// or its binding on the refused account.
#[tokio::test(start_paused = true)]
async fn a_login_refusal_after_the_move_hands_the_previous_account_back() {
    let switch = SwitchFixture::new(None).await;
    let moved_channel = Arc::new(ScriptedChannel::default());
    switch
        .fixture
        .starts
        .script_session(Arc::clone(&moved_channel));
    let (moved, relaunched) = tokio::join!(switch.switch(), switch.fixture.next_start());
    switch.start_turn().await;
    switch
        .fixture
        .starts
        .script_session(Arc::new(ScriptedChannel::default()));

    switch.frame(
        &relaunched,
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
    settle().await;
    switch.fixture.end_turn(&relaunched, switch.session_id);
    let handed_back = switch.fixture.next_start().await;

    assert_eq!(
        moved.first_request.await.expect("the hand-back is made"),
        FirstRequestAfterMove::HandedBack
    );
    assert_eq!(
        environment_value(&handed_back.environment, SECURE_STORAGE_FOLDER_VARIABLE),
        Some(switch.store("from").as_str())
    );
    assert!(
        [&switch.channel, &moved_channel]
            .iter()
            .flat_map(|channel| channel.control_requests())
            .all(|request| request["settings"]["env"]
                .get(SECURE_STORAGE_FOLDER_VARIABLE)
                .is_none()),
        "no store is sent in place"
    );
    assert_eq!(switch.admitted(), test_provider_account_id());
    let moves = switch.fixture.bindings.moves();
    assert_eq!(moves.len(), 2, "{moves:?}");
    assert_eq!(moves[0], (binding_id("resting"), switch.to.clone()));
    assert_ne!(moves[1].0, binding_id("resting"), "{moves:?}");
    assert_eq!(moves[1].1, test_provider_account_id(), "{moves:?}");
}

// A session whose process ended and whose restart is held moves its binding, after naming the
// home, before its restart's account: a binding that cannot move fails the switch with the held
// restart still on the old account, so the two never part. Killed by moving the held restart's
// account before the binding.
#[tokio::test(start_paused = true)]
async fn a_held_restart_whose_binding_cannot_move_stays_on_the_old_account() {
    let switch = SwitchFixture::new(None).await;
    let parts = switch.fixture.driver.composed_parts().expect("composed");
    let is_live = || {
        matches!(
            parts.restarts.standing(switch.session_id),
            ClaudeSessionStanding::Live(_)
        )
    };
    // The first exit restarts at once; the second waits out its crash window, held.
    switch
        .fixture
        .starts
        .script_session(Arc::new(ScriptedChannel::default()));
    ScriptedDriver::exit(&switch.start);
    let relaunched = switch.fixture.next_start().await;
    while !is_live() {
        settle().await;
    }
    ScriptedDriver::exit(&relaunched);
    let ended = loop {
        if let ClaudeSessionStanding::Held { ended, .. } =
            parts.restarts.standing(switch.session_id)
        {
            break ended;
        }
        tokio::task::yield_now().await;
    };
    switch.fixture.bindings.refuse_moves();

    let moved = switch
        .legs
        .move_sessions(
            test_provider_account_id(),
            switch.to.clone(),
            vec![SessionToMove {
                session_id: switch.session_id,
                binding_id: binding_id("resting"),
            }],
            switching_person(),
        )
        .await;

    assert!(matches!(moved.as_slice(), [Err(_)]), "the switch fails");
    assert_eq!(
        ended.admitted_provider_account_id(),
        test_provider_account_id()
    );
}
