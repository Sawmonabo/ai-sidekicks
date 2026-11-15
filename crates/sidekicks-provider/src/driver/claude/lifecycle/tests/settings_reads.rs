//! What Settings and a new session read before any session runs: the starting level, and the
//! Settings rows the installed build offers.

use std::collections::HashSet;
use std::sync::Arc;

use rstest::rstest;
use serde_json::json;
use sidekicks_contracts::agent::definition::binding::ProviderToken;
use sidekicks_contracts::machine::settings::ProviderRowValue;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::declaration::{
    ProviderDeclarationId, ProviderRow, ProviderSettingControl, ProviderValueText,
};
use sidekicks_contracts::provider::driver::capabilities::ProviderMode;
use sidekicks_contracts::session::controls::methods::{PermissionLevel, SessionMode};
use sidekicks_contracts::wire::record::Record;
use tokio_util::sync::CancellationToken;

use super::session_controls::FULL_MODEL_ID;
use crate::driver::ProviderAccountFolders;
use crate::driver::claude::pricing::CLAUDE_CLASSIFIER_MODEL;
use crate::driver::claude::session::rules::CLAUDE_USER_SETTINGS_FILE;
use crate::driver::claude::session::scripted::channel::ScriptedChannel;
use crate::driver::claude::session::scripted::driver::{ScriptedDriver, sandbox_cannot_run};
use crate::driver::claude::session::transport::declarations::ClaudeInitializeDeclaration;
use crate::driver::claude::session::transport::readings::{
    ClaudeCreationFiguresReading, ClaudeLocalCommandReply, ClaudeReplyReserveReads,
};
use crate::driver::contract::params_and_results::{ListModelsParams, ListModesParams};
use crate::driver::session_control::StartingLevelParams;
use crate::driver::test_registry::fixed_session_id;
use crate::pricing::test_fixture::started_list;
use crate::runtime_binding::test_store::test_provider_account_id;

// A figures read whose build offers the advisors `opus` and `sonnet`.
fn figures_offering_advisors() -> ClaudeCreationFiguresReading {
    let unlisted = || ClaudeLocalCommandReply {
        is_listed: false,
        text: None,
        outcome: None,
    };
    ClaudeCreationFiguresReading {
        output_style_names: vec!["default".to_owned()],
        output_style: unlisted(),
        advisor: ClaudeLocalCommandReply {
            is_listed: true,
            text: Some("Usage: /advisor <opus|sonnet|off>".to_owned()),
            outcome: None,
        },
        reply_reserve_reads: ClaudeReplyReserveReads::Refused {
            detail: "unread".to_owned(),
        },
        context_reads: Vec::new(),
    }
}

// The advisor row's value in `rows`.
fn advisor_value(rows: &[ProviderRow]) -> Option<String> {
    rows.iter().find_map(|row| {
        let ProviderRow::Setting {
            id,
            control: ProviderSettingControl::Choice { value, .. },
            ..
        } = row
        else {
            return None;
        };
        (id.as_str() == "advisor").then(|| value.as_ref().map(|value| value.as_str().to_owned()))?
    })
}

// Killed by offering Reviewed whatever the model's catalog says, or on a catalog that could not be
// read: an account home's `auto` starts at Reviewed only on a model Claude Code runs auto mode on;
// and by reading the level or the catalog on the person's own `~/.claude` instead of the account's
// own home, where only the account's settings name `auto`.
#[tokio::test(start_paused = true)]
async fn a_new_session_starts_at_reviewed_only_on_a_model_that_runs_auto_mode() {
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
        json!({"permissions": {"defaultMode": "auto"}}).to_string(),
    )
    .expect("the account's settings are written");
    let read = |model: &str| {
        fixture.driver.read_starting_level(StartingLevelParams {
            working_folder: fixture.work.clone(),
            model: ProviderToken::new(model.to_owned()).expect("the model fits"),
            provider_account_id: test_provider_account_id(),
        })
    };
    fixture.starts.script_catalog(json!({"models": [
        {"value": "opus", "displayName": "Opus", "supportsAutoMode": true},
        {"value": "haiku", "displayName": "Haiku", "supportsAutoMode": false},
    ]}));
    let on_auto_model = read("opus").await.expect("the level reads");
    fixture.starts.script_catalog(json!({"models": [
        {"value": "opus", "displayName": "Opus", "supportsAutoMode": true},
    ]}));
    let on_other_model = read("haiku").await.expect("the level reads");
    let unread_catalog = read("opus").await.expect("the level reads");

    assert_eq!(on_auto_model.level, PermissionLevel::Reviewed);
    assert_eq!(on_auto_model.session_mode, SessionMode::Build);
    assert_eq!(on_other_model.level, PermissionLevel::Ask);
    assert_eq!(unread_catalog.level, PermissionLevel::Ask);
    let account_config = config_folder.display().to_string();
    let environments = fixture.starts.take_catalog_environments();
    assert!(
        environments.iter().all(|environment| environment
            .contains(&("CLAUDE_CONFIG_DIR".to_owned(), account_config.clone()))),
        "the account's catalog is read on its own config folder"
    );
    assert_eq!(environments.len(), 3);
}

// Killed by offering Reviewed on the system's word alone, whatever the account's catalog says of
// the model, and by checking the catalog's auto-mode models against anything but the model named;
// every other level stays as this system offers it.
#[rstest]
#[case::model_without_auto_mode("haiku", false)]
#[case::model_with_auto_mode("opus", true)]
#[tokio::test(start_paused = true)]
async fn the_level_list_offers_reviewed_only_on_a_model_the_account_runs_auto_mode_on(
    #[case] model: &str,
    #[case] is_reviewed_offered: bool,
) {
    let account_folder = tempfile::tempdir().expect("the test makes an account folder");
    let fixture = ScriptedDriver::with_account_folders_and_sandbox_check(
        Some(ProviderAccountFolders {
            configuration_folder: account_folder.path().join("config"),
            credential_store_folder: account_folder.path().join("credentials"),
        }),
        sandbox_cannot_run,
    );
    fixture.starts.script_catalog(json!({"models": [
        {"value": "opus", "displayName": "Opus", "supportsAutoMode": true},
        {"value": "haiku", "displayName": "Haiku", "supportsAutoMode": false},
    ]}));
    let mode_ids = |modes: Vec<ProviderMode>| -> Vec<String> {
        modes
            .into_iter()
            .map(|mode| mode.id.as_str().to_owned())
            .collect()
    };

    let listed = fixture
        .driver
        .list_modes(ListModesParams {
            session_id: Some(fixed_session_id()),
            provider_account_id: Some(test_provider_account_id()),
            model: Some(ProviderToken::new(model.to_owned()).expect("the model fits")),
        })
        .await
        .expect("the levels read");
    let on_system = fixture
        .driver
        .list_modes(ListModesParams {
            session_id: None,
            provider_account_id: None,
            model: None,
        })
        .await
        .expect("the system's levels read");

    let reviewed = <&str>::from(PermissionLevel::Reviewed);
    let expected: Vec<String> = mode_ids(on_system)
        .into_iter()
        .filter(|id| is_reviewed_offered || id != reviewed)
        .collect();
    assert_eq!(
        expected.iter().any(|id| id == reviewed),
        is_reviewed_offered
    );
    assert_eq!(mode_ids(listed), expected);
}

// A live session's level list reads the auto-mode models its process declared at its launch, with
// no control-only read of the catalog, until an in-place switch moves the process onto another
// account, whose catalog is then read. Killed by reading the catalog for a live session that has
// not moved, and by taking the launch's catalog for one that has.
#[rstest]
#[case::on_its_launch_account(false)]
#[case::moved_in_place(true)]
#[tokio::test(start_paused = true)]
async fn a_live_sessions_level_list_reads_its_process_while_it_runs_on_its_launch_account(
    #[case] is_moved: bool,
) {
    let fixture = ScriptedDriver::new();
    fixture
        .starts
        .script_initialize(ClaudeInitializeDeclaration {
            auto_mode_models: HashSet::from(["opus".to_owned()]),
            ..ClaudeInitializeDeclaration::default()
        });
    // A catalog read would offer no Reviewed on the model.
    fixture.starts.script_catalog(json!({"models": [
        {"value": "opus", "displayName": "Opus", "supportsAutoMode": false},
    ]}));
    let session_id = fixture.create(&Arc::new(ScriptedChannel::default())).await;
    fixture.starts.take_catalog_environments();
    if is_moved {
        fixture
            .driver
            .composed_parts()
            .expect("the pieces are composed")
            .establishment
            .slots
            .live_session(session_id)
            .expect("the created session is live")
            .move_admitted_account(
                ProviderAccountId::new("moved-to".to_owned()).expect("an account id fits"),
            );
    }

    let listed = fixture
        .driver
        .list_modes(ListModesParams {
            session_id: Some(session_id),
            provider_account_id: None,
            model: Some(ProviderToken::new("opus".to_owned()).expect("the model fits")),
        })
        .await
        .expect("the levels read");

    assert_eq!(
        listed
            .iter()
            .any(|mode| mode.id.as_str() == <&str>::from(PermissionLevel::Reviewed)),
        !is_moved
    );
    assert_eq!(
        fixture.starts.take_catalog_environments().len(),
        usize::from(is_moved)
    );
}

// Killed by removing the capability read's configuration folder only after a read that succeeded.
#[tokio::test(start_paused = true)]
async fn the_capability_read_s_configuration_folder_is_gone_after_a_failed_read() {
    let fixture = ScriptedDriver::new();

    let read = fixture.driver.get_capabilities().await;

    assert!(read.is_err(), "the scripted build reads no capabilities");
    assert!(
        !fixture
            .services
            .data_folder
            .join("claude-capability-read")
            .exists(),
        "the read's folder is removed"
    );
}

// Killed by starting a process for each Settings read, where reads of one build share one.
#[tokio::test(start_paused = true)]
async fn settings_reads_of_one_build_share_one_figures_process() {
    let fixture = ScriptedDriver::new();
    fixture
        .starts
        .script_creation_figures(figures_offering_advisors());

    let first = fixture.driver.read_rows(Record::default()).await;
    let second = fixture.driver.read_rows(Record::default()).await;

    assert!(first.is_ok() && second.is_ok(), "both reads answer");
    assert_eq!(fixture.starts.take_creation_read_count(), 1);
}

// Killed by an advisor row that holds no value where the person's own Claude Code settings name
// an advisor, by one that holds the person's over the app's pick, and by the app's `No advisor`
// pick read as no pick, which shows the person's advisor where new sessions start with none.
#[tokio::test(start_paused = true)]
async fn the_advisor_row_holds_the_apps_pick_else_the_persons_own_advisor() {
    let fixture = ScriptedDriver::new();
    let settings = fixture.home.join(".claude");
    std::fs::create_dir_all(&settings).expect("the settings folder is made");
    std::fs::write(
        settings.join(CLAUDE_USER_SETTINGS_FILE),
        json!({"advisorModel": "opus"}).to_string(),
    )
    .expect("the person's settings are written");
    fixture
        .starts
        .script_creation_figures(figures_offering_advisors());
    let pick =
        |model: Option<&str>| {
            Record::new(
                [(
                    ProviderDeclarationId::new("advisor".to_owned()).expect("the row id fits"),
                    ProviderRowValue::Value(model.map(|model| {
                        ProviderValueText::new(model.to_owned()).expect("the pick fits")
                    })),
                )]
                .into(),
            )
            .expect("one row is a record")
        };

    let persons = fixture.driver.read_rows(Record::default()).await;
    let apps = fixture.driver.read_rows(pick(Some("sonnet"))).await;
    let none = fixture.driver.read_rows(pick(None)).await;

    assert_eq!(
        advisor_value(&persons.expect("the rows read")).as_deref(),
        Some("opus")
    );
    assert_eq!(
        advisor_value(&apps.expect("the rows read")).as_deref(),
        Some("sonnet")
    );
    assert_eq!(advisor_value(&none.expect("the rows read")), None);
}

// The auto-mode classifier's rates beside the two models the list fixture keeps.
const CLASSIFIER_COPY: &[u8] = br#"{"m1": {"input_cost_per_token": 3e-06},
    "seed-only": {"input_cost_per_token": 2e-06},
    "claude-sonnet-5": {"input_cost_per_token": 3e-06, "output_cost_per_token": 1.5e-05}}"#;

// Listing an account's models marks the auto-mode classifier's model in use, so its rates are read
// before the first check a session's export states is priced. Killed by the mark dropped.
#[tokio::test]
async fn listing_the_models_marks_the_classifier_s_model_in_use() {
    let account_folder = tempfile::tempdir().expect("the test makes an account folder");
    let fixture = ScriptedDriver::with_account_folders_and_sandbox_check(
        Some(ProviderAccountFolders {
            configuration_folder: account_folder.path().join("config"),
            credential_store_folder: account_folder.path().join("credentials"),
        }),
        sandbox_cannot_run,
    );
    fixture.starts.script_catalog(json!({"models": [
        {"value": "opus", "displayName": "Opus", "resolvedModel": FULL_MODEL_ID},
    ]}));
    let stop = CancellationToken::new();
    let (price_list, _server) = started_list(
        &account_folder.path().join("price-list"),
        r#"W/"classifier""#,
        CLASSIFIER_COPY,
        &stop,
    )
    .await;
    fixture
        .services
        .ports
        .price_list
        .register(Arc::clone(&price_list))
        .expect("the price list registers once");
    assert!(price_list.table().row(CLAUDE_CLASSIFIER_MODEL).is_none());

    fixture
        .driver
        .list_models(ListModelsParams {
            session_id: None,
            provider_account_id: Some(test_provider_account_id()),
        })
        .await
        .expect("the models read");

    assert!(
        price_list.table().row(CLAUDE_CLASSIFIER_MODEL).is_some(),
        "the classifier's rates are read once the models are listed"
    );
    stop.cancel();
}
