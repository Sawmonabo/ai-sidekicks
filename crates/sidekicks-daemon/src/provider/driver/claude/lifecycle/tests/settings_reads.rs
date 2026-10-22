//! What Settings and a new session read before any session runs: the starting level, and the
//! Settings rows the installed build offers.

use serde_json::json;
use sidekicks_contracts::agent::definition::binding::ProviderToken;
use sidekicks_contracts::machine::settings::ProviderRowValue;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::declaration::{
    ProviderDeclarationId, ProviderRow, ProviderSettingControl, ProviderValueText,
};
use sidekicks_contracts::session::controls::methods::{PermissionLevel, SessionMode};
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::record::Record;

use super::DriverFixture;
use crate::provider::driver::ProviderAccountFolders;
use crate::provider::driver::claude::session::transport::readings::{
    ClaudeCreationFiguresReading, ClaudeLocalCommandReply, ClaudeReplyReserveReads,
};
use crate::provider::driver::session_control::StartingLevelParams;

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
    rows.iter().find_map(|row| match row {
        ProviderRow::Setting {
            id,
            control: ProviderSettingControl::Choice { value, .. },
            ..
        } if id.as_str() == "advisor" => Some(value.as_ref()?.as_str().to_owned()),
        _ => None,
    })
}

// Killed by offering Reviewed whatever the model's catalog says, or on a catalog that could not be
// read: a person's `auto` starts at Reviewed only on a model Claude Code runs auto mode on; and by
// reading an app-managed account's catalog on the person's own home.
#[tokio::test]
async fn a_new_session_starts_at_reviewed_only_on_a_model_that_runs_auto_mode() {
    let account_folder = std::env::temp_dir().join("sidekicks-account");
    let fixture = DriverFixture::with_account_folders(Some(ProviderAccountFolders {
        configuration_folder: account_folder.join("config"),
        credential_store_folder: account_folder.join("credentials"),
    }));
    let settings = fixture.home.join(".claude");
    std::fs::create_dir_all(&settings).expect("the settings folder is made");
    std::fs::write(
        settings.join("settings.json"),
        json!({"permissions": {"defaultMode": "auto"}}).to_string(),
    )
    .expect("the person's settings are written");
    let read_on = |model: &str, provider_account_id: Option<ProviderAccountId>| {
        fixture.driver.read_starting_level(StartingLevelParams {
            working_folder: fixture.work.clone(),
            model: ProviderToken::new(model.to_owned()).expect("the model fits"),
            provider_account_id,
        })
    };
    let read = |model: &str| read_on(model, None);
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
    drop(fixture.starts.take_catalog_environments());
    let account = ProviderAccountId::new(mint_uuid_v7().to_string()).expect("a UUID is an id");
    let on_account = read_on("opus", Some(account)).await;

    assert_eq!(on_auto_model.level, PermissionLevel::Reviewed);
    assert_eq!(on_auto_model.session_mode, SessionMode::Build);
    assert_eq!(on_other_model.level, PermissionLevel::Ask);
    assert_eq!(unread_catalog.level, PermissionLevel::Ask);
    assert!(on_account.is_ok(), "the level reads on the account");
    let account_config = account_folder.join("config").display().to_string();
    let environments = fixture.starts.take_catalog_environments();
    assert!(
        environments.iter().all(|environment| environment
            .contains(&("CLAUDE_CONFIG_DIR".to_owned(), account_config.clone()))),
        "the account's catalog is read on its own config folder"
    );
    assert_eq!(environments.len(), 1);
}

// Killed by starting a process for each Settings read, where reads of one build share one.
#[tokio::test]
async fn settings_reads_of_one_build_share_one_figures_process() {
    let fixture = DriverFixture::new();
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
#[tokio::test]
async fn the_advisor_row_holds_the_apps_pick_else_the_persons_own_advisor() {
    let fixture = DriverFixture::new();
    let settings = fixture.home.join(".claude");
    std::fs::create_dir_all(&settings).expect("the settings folder is made");
    std::fs::write(
        settings.join("settings.json"),
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
