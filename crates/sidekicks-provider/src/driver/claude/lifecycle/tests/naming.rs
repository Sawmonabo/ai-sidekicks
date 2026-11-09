//! A resting session's name: drawn from its first exchange in a one-turn process, whose spend is
//! the session's own, and told to Claude Code once the driver no longer remembers it.

use std::pin::pin;
use std::time::Duration;

use rstest::rstest;
use serde_json::{Map, Value};
use sidekicks_contracts::event::usage::UsageCostSource;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use tokio_util::sync::CancellationToken;

use super::session_controls::{one_turn_reply, opus_spend};
use crate::driver::ProviderAccountFolders;
use crate::driver::claude::session::conversation_home::claude_conversation_home_metadata;
use crate::driver::claude::session::scripted::driver::{ScriptedDriver, sandbox_cannot_run};
use crate::driver::claude::session::scripted::{binding_id, register_claude_price_list};
use crate::driver::claude::spawn::launch::ClaudeLaunchError;
use crate::driver::claude::spawn::launch::one_turn::{ClaudeOneTurnOutcome, ClaudeOneTurnReply};
use crate::driver::daemon_stop::{DaemonStopIntent, daemon_stop_deadline};
use crate::driver::session_control::NameSessionParams;
use crate::driver::test_registry::new_session_id;
use crate::port::usage_sink::MeteredUsageOwner;
use crate::runtime_binding::test_store::test_provider_account_id;

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
    fixture.starts.script_one_turn(ClaudeOneTurnOutcome {
        reply: Ok(ClaudeOneTurnReply {
            text: "Login page fix".to_owned(),
            provider_message_id: None,
            provider_block: None,
            refusal: None,
            compaction_summary: None,
        }),
        spend: None,
    });

    let named = fixture
        .driver
        .name_session(NameSessionParams {
            session_id,
            place: None,
            first_message: "Fix the login page".to_owned(),
            first_reply: "Looking at the form.".to_owned(),
            binding_id: binding_id("naming"),
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

// The one turn answers a title having stated its figure, or is stopped with no result. Killed by
// the one turn's spend left unrecorded (no row), by its rows owned as a run's, by rows recorded on
// the stored leg's binding rather than the request's, and by a stopped pass's spend dropped (no
// row in the second case).
#[rstest]
#[case::named(
    Ok(one_turn_reply("Login page fix")),
    Some((1_000, 500, 0.014)),
    UsageCostSource::ProviderReported
)]
#[case::stopped(
    Err(ClaudeLaunchError::TurnStopped),
    None,
    UsageCostSource::DerivedExact
)]
#[tokio::test]
async fn a_naming_pass_at_rest_records_and_prices_its_one_turn_as_the_session_s_spend(
    #[case] reply: Result<ClaudeOneTurnReply, ClaudeLaunchError>,
    #[case] stated: Option<(u64, u64, f64)>,
    #[case] cost_source: UsageCostSource,
) {
    let scratch = tempfile::tempdir().expect("a scratch folder is made");
    let stop = CancellationToken::new();
    let fixture = ScriptedDriver::new();
    register_claude_price_list(&fixture.services.ports.price_list, &scratch, &stop).await;
    let session_id = new_session_id();
    let account = ProviderAccountId::new("account-1".to_owned()).expect("an account id");
    fixture.record_session_leg(session_id, account, STORED_CONVERSATION, Map::new());
    let is_titled = reply.is_ok();
    fixture.starts.script_one_turn(ClaudeOneTurnOutcome {
        reply,
        spend: Some(opus_spend(&[(1_000, 500)], stated)),
    });

    let named = fixture
        .driver
        .name_session(NameSessionParams {
            session_id,
            place: None,
            first_message: "Fix the login page".to_owned(),
            first_reply: "Looking at the form.".to_owned(),
            binding_id: binding_id("naming"),
            cancel: CancellationToken::new(),
        })
        .await
        .expect("the pass answers");
    stop.cancel();

    assert_eq!(named.is_some(), is_titled);
    assert_the_session_s_naming_spend(&fixture, cost_source);
}

// The caller stops waiting at the cancel, as the session's title pass does, and the one turn
// ends only on the stop that follows. Killed by the spend recorded inside the dropped pass,
// which the cancel drops with it (no row), and by a daemon stop that ends before the record.
#[tokio::test]
async fn a_canceled_naming_pass_s_spend_lands_after_the_cancel() {
    let scratch = tempfile::tempdir().expect("a scratch folder is made");
    let stop = CancellationToken::new();
    let fixture = ScriptedDriver::new();
    register_claude_price_list(&fixture.services.ports.price_list, &scratch, &stop).await;
    let session_id = new_session_id();
    let account = ProviderAccountId::new("account-1".to_owned()).expect("an account id");
    fixture.record_session_leg(session_id, account, STORED_CONVERSATION, Map::new());
    fixture
        .starts
        .script_one_turn_until_stopped(ClaudeOneTurnOutcome {
            reply: Err(ClaudeLaunchError::TurnStopped),
            spend: Some(opus_spend(&[(1_000, 500)], None)),
        });
    let cancel = CancellationToken::new();

    {
        let mut naming = pin!(fixture.driver.name_session(NameSessionParams {
            session_id,
            place: None,
            first_message: "Fix the login page".to_owned(),
            first_reply: "Looking at the form.".to_owned(),
            binding_id: binding_id("naming"),
            cancel: cancel.clone(),
        }));
        while fixture.starts.take_one_turns().is_empty() {
            let polled = tokio::time::timeout(Duration::from_millis(10), naming.as_mut()).await;
            assert!(polled.is_err(), "the pass waits on its one turn");
        }
    }
    cancel.cancel();
    fixture
        .driver
        .shutdown(DaemonStopIntent::Restart, daemon_stop_deadline())
        .await;
    stop.cancel();

    assert_the_session_s_naming_spend(&fixture, UsageCostSource::DerivedExact);
}

// The one turn's 1,000 in and 500 out, recorded on the request's binding as the session's own
// and priced on the account's row from `cost_source`.
fn assert_the_session_s_naming_spend(fixture: &ScriptedDriver, cost_source: UsageCostSource) {
    let metered: Vec<_> = fixture
        .usage
        .metered()
        .into_iter()
        .map(|metered| {
            let axes = metered.delta.axis_deltas;
            (metered.owner, metered.binding_id, axes.input, axes.output)
        })
        .collect();
    assert_eq!(
        metered,
        [(
            MeteredUsageOwner::Session,
            binding_id("naming"),
            Some(1_000),
            Some(500)
        )]
    );
    let row_account = test_provider_account_id().as_str().to_owned();
    assert_eq!(
        fixture.usage.priced_shares(),
        [(cost_source, vec![(row_account, 14_000)])]
    );
}
