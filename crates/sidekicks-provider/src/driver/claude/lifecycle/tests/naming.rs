//! A resting session's name: drawn from its first exchange in a one-turn process, and told to
//! Claude Code once the driver no longer remembers it.

use rstest::rstest;
use serde_json::{Map, Value};
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use tokio_util::sync::CancellationToken;

use crate::driver::ProviderAccountFolders;
use crate::driver::claude::session::conversation_home::claude_conversation_home_metadata;
use crate::driver::claude::session::scripted::driver::{ScriptedDriver, sandbox_cannot_run};
use crate::driver::claude::spawn::launch::one_turn::ClaudeOneTurnReply;
use crate::driver::session_control::NameSessionParams;
use crate::driver::test_registry::new_session_id;

/// The conversation the session's stored leg names.
const STORED_CONVERSATION: &str = "0190a5d2-7c1e-7d3a-9b2f-4c8e6a1f3b5d";

// A fresh driver holds nothing of the session, as after a daemon restart. After a switch from
// the account whose home holds the conversation, the stored leg names the new account and the
// home its recovery data keeps. Killed by reading only the driver's memory, which refuses the
// rename, by composing the account's home as the person's own, where no file of the conversation
// sits, and by looking in the home of the account the leg names now.
#[rstest]
#[case::on_its_own_account(false)]
#[case::after_a_switch(true)]
#[tokio::test]
async fn a_rename_at_rest_after_a_restart_names_the_conversation_its_stored_leg_ran(
    #[case] is_switched: bool,
) {
    let account_folder = tempfile::tempdir().expect("the test makes an account folder");
    let config_folder = account_folder.path().join("config");
    let fixture = ScriptedDriver::with_account_folders_and_sandbox_check(
        Some(ProviderAccountFolders {
            configuration_folder: config_folder.clone(),
            credential_store_folder: account_folder.path().join("credentials"),
        }),
        sandbox_cannot_run,
    );
    let project_folder = config_folder.join("projects").join("work");
    std::fs::create_dir_all(&project_folder).expect("the project folder is made");
    let file = project_folder.join(format!("{STORED_CONVERSATION}.jsonl"));
    std::fs::write(&file, "{\"type\":\"user\"}\n").expect("the conversation is written");
    let session_id = new_session_id();
    let (account, runtime_metadata) = if is_switched {
        let moved_to = ProviderAccountId::new("account-to".to_owned()).expect("an account id");
        let other_home = account_folder.path().join("to");
        fixture.accounts.register(
            moved_to.clone(),
            ProviderAccountFolders {
                configuration_folder: other_home.join("config"),
                credential_store_folder: other_home.join("credentials"),
            },
            None,
        );
        (moved_to, claude_conversation_home_metadata(&config_folder))
    } else {
        let account = ProviderAccountId::new("account-1".to_owned()).expect("an account id");
        (account, Map::new())
    };
    fixture.record_session_leg(session_id, account, STORED_CONVERSATION, runtime_metadata);

    fixture
        .driver
        .tell_session_name(session_id, "Fix the login page".to_owned())
        .await
        .expect("the conversation at rest takes the name");

    let written = std::fs::read_to_string(&file).expect("the conversation reads");
    let last: Value =
        serde_json::from_str(written.lines().last().expect("a line")).expect("the entry is JSON");
    assert_eq!(last["type"], "custom-title");
    assert_eq!(last["customTitle"], "Fix the login page");
    assert_eq!(last["sessionId"], STORED_CONVERSATION);
}

// Killed by a naming pass whose one-turn process asks for a mode of its own, Plan or any other,
// in place of the one a process with no level runs in.
#[tokio::test]
async fn a_naming_pass_at_rest_runs_its_one_turn_in_no_mode_of_its_own() {
    let fixture = ScriptedDriver::new();
    let session_id = new_session_id();
    let account = ProviderAccountId::new("account-1".to_owned()).expect("an account id");
    fixture.record_session_leg(session_id, account, STORED_CONVERSATION, Map::new());
    fixture.starts.script_one_turn(ClaudeOneTurnReply {
        text: "Login page fix".to_owned(),
        provider_message_id: None,
        provider_block: None,
        refusal: None,
        usage: None,
        compaction_summary: None,
    });

    let named = fixture
        .driver
        .name_session(NameSessionParams {
            session_id,
            place: None,
            first_message: "Fix the login page".to_owned(),
            first_reply: "Looking at the form.".to_owned(),
            cancel: CancellationToken::new(),
        })
        .await
        .expect("the pass answers");

    assert!(named.is_some(), "the one turn's reply names the session");
    let modes: Vec<_> = fixture
        .starts
        .take_one_turns()
        .into_iter()
        .map(|one_turn| one_turn.permission_mode)
        .collect();
    assert_eq!(modes, [None]);
}
