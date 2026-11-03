use std::sync::Arc;

use secrecy::SecretString;
use serde_json::Map;
use sidekicks_contracts::provider::account::record::ProviderAccountId;

use crate::driver::ProviderAccountFolders;
use crate::driver::claude::account::test_account_legs;
use crate::driver::claude::session::scripted::channel::ScriptedChannel;
use crate::driver::claude::session::scripted::driver::ScriptedDriver;
use crate::driver::claude::session::scripted::{binding_id, settle};
use crate::driver::claude::spawn::arguments::ClaudeConversationStart;
use crate::driver::contract::account::ProviderTokenStatusLegs;
use crate::runtime_binding::test_store::test_provider_account_id;

// An idle session on the account whose token was re-supplied starts again at once on that account
// under its stored leg's binding, resuming its conversation by id, so its new process signs in
// with the token sealed now; a session on another account keeps its process. Killed by no
// relaunch (no start comes), and by every live session relaunched (a second start, or the other
// session's process replaced).
#[tokio::test(start_paused = true)]
async fn a_resupplied_token_relaunches_each_live_session_on_the_account() {
    let fixture = ScriptedDriver::new();
    let account = test_provider_account_id();
    let other = ProviderAccountId::new("account-other".to_owned()).expect("an account id fits");
    let on_account = fixture.create(&Arc::new(ScriptedChannel::default())).await;
    let ClaudeConversationStart::New {
        provider_session_id: conversation,
    } = fixture.next_start().await.conversation
    else {
        panic!("the create starts a new conversation");
    };
    let on_other = fixture.create(&Arc::new(ScriptedChannel::default())).await;
    fixture.next_start().await;
    let parts = fixture.driver.composed_parts().expect("composed");
    let other_live = parts
        .slots()
        .live_session(on_other)
        .expect("the session is live");
    other_live.move_admitted_account(other.clone());
    fixture.record_session_leg(on_account, account.clone(), &conversation, Map::new());
    fixture.record_session_leg(on_other, other.clone(), "other-conversation", Map::new());
    fixture
        .starts
        .script_session(Arc::new(ScriptedChannel::default()));
    let legs = test_account_legs(&fixture.services, Arc::downgrade(&parts.establishment));
    let folders = ProviderAccountFolders {
        configuration_folder: fixture.folder.path().join("home"),
        credential_store_folder: fixture.folder.path().join("store"),
    };

    legs.hand_resupplied_token(&account, &folders, &SecretString::from("new-setup-token"))
        .await
        .expect("the relaunches are set going");
    let relaunched = fixture.next_start().await;
    settle().await;

    assert!(matches!(
        &relaunched.conversation,
        ClaudeConversationStart::Resume { resume_handle } if *resume_handle == conversation
    ));
    assert_eq!(relaunched.account.read(), Some(account.clone()));
    assert_eq!(
        fixture.bindings.moves(),
        [(binding_id("stored-leg"), account)],
        "only the relaunched session's leg moves"
    );
    assert!(
        fixture.starts.take_started().is_empty(),
        "a second session started again"
    );
    let still_live = parts
        .slots()
        .live_session(on_other)
        .expect("the other session is live");
    assert!(Arc::ptr_eq(&still_live.channel, &other_live.channel));
}
