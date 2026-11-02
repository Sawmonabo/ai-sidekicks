use std::fs;
use std::path::Path;

use rstest::rstest;

use super::{
    ClaudeSelfUpdateReading, ClaudeUpdateChannel, ClaudeUpdateOptOut, ClaudeUpdateOptOutVariable,
    ClaudeVariableSource, read_claude_self_update,
};
use crate::driver::claude::mcp::config::ClaudePersonConfigFiles;

// The files one case writes, each `None` where the case has no such file.
struct CaseFiles<'case> {
    shell: &'case [(&'case str, &'case str)],
    user_settings: Option<&'case str>,
    person_config: Option<&'case str>,
    managed_settings: Option<&'case str>,
}

// What the case expects to keep Claude Code from updating itself.
#[derive(Debug)]
enum ExpectedOptOut {
    Nothing,
    Variable(ClaudeUpdateOptOutVariable, ExpectedSource),
    AutoUpdatesOff,
}

#[derive(Debug)]
enum ExpectedSource {
    Managed,
    User,
    Shell,
}

// Writes the case's files under `folder` and reads them.
async fn read_case(folder: &Path, files: &CaseFiles<'_>) -> ClaudeSelfUpdateReading {
    let config_files = ClaudePersonConfigFiles {
        person_config: folder.join(".claude.json"),
        user_settings: folder.join(".claude").join("settings.json"),
    };
    let managed_folder = folder.join("managed");
    fs::create_dir_all(folder.join(".claude")).expect("the config folder is made");
    fs::create_dir_all(&managed_folder).expect("the managed folder is made");
    if let Some(text) = files.user_settings {
        fs::write(&config_files.user_settings, text).expect("the settings file is written");
    }
    if let Some(text) = files.person_config {
        fs::write(&config_files.person_config, text).expect("the config file is written");
    }
    if let Some(text) = files.managed_settings {
        fs::write(managed_folder.join("managed-settings.json"), text)
            .expect("the managed file is written");
    }
    let environment: Vec<(String, String)> = files
        .shell
        .iter()
        .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
        .collect();
    read_claude_self_update(&environment, &config_files, Some(&managed_folder))
        .await
        .expect("the case's files are readable")
}

// Killed by dropping any of the four keys, by reading `DISABLE_UPDATES` or `DISABLE_AUTOUPDATER` as
// on only at `1` (the `true` and upper-case cases) or at any value but an on word (the `0` cases),
// by dropping a settings value written as a JSON number, by reading the shell's value over the
// settings file's, and by skipping the managed `env` block.
#[rstest]
#[case::user_settings_env(
    CaseFiles {
        shell: &[],
        user_settings: Some(r#"{"env": {"DISABLE_AUTOUPDATER": "1"}}"#),
        person_config: None,
        managed_settings: None,
    },
    ExpectedOptOut::Variable(ClaudeUpdateOptOutVariable::BackgroundUpdates, ExpectedSource::User),
)]
#[case::shell_nonessential_traffic(
    CaseFiles {
        shell: &[("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "x")],
        user_settings: None,
        person_config: None,
        managed_settings: None,
    },
    ExpectedOptOut::Variable(
        ClaudeUpdateOptOutVariable::NonessentialTraffic,
        ExpectedSource::Shell,
    ),
)]
#[case::shell_disable_updates(
    CaseFiles {
        shell: &[("DISABLE_UPDATES", "1")],
        user_settings: None,
        person_config: None,
        managed_settings: None,
    },
    ExpectedOptOut::Variable(ClaudeUpdateOptOutVariable::AllUpdates, ExpectedSource::Shell),
)]
#[case::shell_true(
    CaseFiles {
        shell: &[("DISABLE_AUTOUPDATER", "true")],
        user_settings: None,
        person_config: None,
        managed_settings: None,
    },
    ExpectedOptOut::Variable(ClaudeUpdateOptOutVariable::BackgroundUpdates, ExpectedSource::Shell),
)]
#[case::user_settings_upper_case(
    CaseFiles {
        shell: &[],
        user_settings: Some(r#"{"env": {"DISABLE_UPDATES": " ON "}}"#),
        person_config: None,
        managed_settings: None,
    },
    ExpectedOptOut::Variable(ClaudeUpdateOptOutVariable::AllUpdates, ExpectedSource::User),
)]
#[case::user_settings_number_over_shell(
    CaseFiles {
        shell: &[("DISABLE_AUTOUPDATER", "0")],
        user_settings: Some(r#"{"env": {"DISABLE_AUTOUPDATER": 1}}"#),
        person_config: None,
        managed_settings: None,
    },
    ExpectedOptOut::Variable(ClaudeUpdateOptOutVariable::BackgroundUpdates, ExpectedSource::User),
)]
#[case::managed_env(
    CaseFiles {
        shell: &[],
        user_settings: Some(r#"{"env": {"DISABLE_AUTOUPDATER": "0"}}"#),
        person_config: None,
        managed_settings: Some(r#"{"env": {"DISABLE_AUTOUPDATER": "1"}}"#),
    },
    ExpectedOptOut::Variable(
        ClaudeUpdateOptOutVariable::BackgroundUpdates,
        ExpectedSource::Managed,
    ),
)]
#[case::auto_updates_off(
    CaseFiles {
        shell: &[],
        user_settings: None,
        person_config: Some(r#"{"autoUpdates": false}"#),
        managed_settings: None,
    },
    ExpectedOptOut::AutoUpdatesOff,
)]
#[case::zero_and_auto_updates_on(
    CaseFiles {
        shell: &[],
        user_settings: Some(r#"{"env": {"DISABLE_AUTOUPDATER": "0"}}"#),
        person_config: Some(r#"{"autoUpdates": true}"#),
        managed_settings: None,
    },
    ExpectedOptOut::Nothing,
)]
#[case::settings_file_over_shell(
    CaseFiles {
        shell: &[("DISABLE_AUTOUPDATER", "1")],
        user_settings: Some(r#"{"env": {"DISABLE_AUTOUPDATER": "0"}}"#),
        person_config: None,
        managed_settings: None,
    },
    ExpectedOptOut::Nothing,
)]
#[tokio::test]
async fn opt_out_reads_the_variable_claude_code_runs_with(
    #[case] files: CaseFiles<'static>,
    #[case] expected: ExpectedOptOut,
) {
    let folder = tempfile::tempdir().expect("a scratch folder");

    let reading = read_case(folder.path(), &files).await;

    let expected = match expected {
        ExpectedOptOut::Nothing => None,
        ExpectedOptOut::Variable(variable, source) => Some(ClaudeUpdateOptOut::Variable {
            variable,
            source: match source {
                ExpectedSource::Managed => ClaudeVariableSource::ManagedSettings {
                    file: folder.path().join("managed").join("managed-settings.json"),
                },
                ExpectedSource::User => ClaudeVariableSource::UserSettings {
                    file: folder.path().join(".claude").join("settings.json"),
                },
                ExpectedSource::Shell => ClaudeVariableSource::LoginShell,
            },
        }),
        ExpectedOptOut::AutoUpdatesOff => Some(ClaudeUpdateOptOut::AutoUpdatesOff {
            person_config: folder.path().join(".claude.json"),
        }),
    };
    assert_eq!(reading.kept_from_updating, expected);
}

// Killed by reading the person's channel over the managed one, and by letting a word that is no
// channel fall through to a lower layer or read as `Stable`.
#[rstest]
#[case::managed_over_person(
    Some(r#"{"autoUpdatesChannel": "stable"}"#),
    Some(r#"{"autoUpdatesChannel": "latest"}"#),
    ClaudeUpdateChannel::Stable
)]
#[case::unset(None, None, ClaudeUpdateChannel::Latest)]
#[case::unknown_word(
    None,
    Some(r#"{"autoUpdatesChannel": "nightly"}"#),
    ClaudeUpdateChannel::Latest
)]
#[case::managed_unknown_word_over_person(
    Some(r#"{"autoUpdatesChannel": "nightly"}"#),
    Some(r#"{"autoUpdatesChannel": "stable"}"#),
    ClaudeUpdateChannel::Latest
)]
#[tokio::test]
async fn channel_follows_the_managed_layer_first(
    #[case] managed_settings: Option<&'static str>,
    #[case] user_settings: Option<&'static str>,
    #[case] expected: ClaudeUpdateChannel,
) {
    let folder = tempfile::tempdir().expect("a scratch folder");
    let files = CaseFiles {
        shell: &[],
        user_settings,
        person_config: None,
        managed_settings,
    };

    let reading = read_case(folder.path(), &files).await;

    assert_eq!(reading.channel, expected);
}
