use rstest::rstest;

use super::read_codex_privacy;
use crate::driver::codex::config_read::CodexConfigFileError;
use crate::driver::codex::session::errors::CodexError;

// Killed by the two keys swapped, an unset choice sent as `false` or a table outside the two read,
// and an absent file read as a failure: each composes another command line than the person set.
#[rstest]
#[case::both_set(
    Some("[analytics]\nenabled = false\n\n[feedback]\nenabled = true\n"),
    &["analytics.enabled=false", "feedback.enabled=true"],
)]
#[case::feedback_alone(Some("[feedback]\nenabled = false\n"), &["feedback.enabled=false"])]
#[case::absent_file(None, &[])]
#[case::other_tables_and_keys(
    Some("model = \"o3\"\nenabled = false\n\n[otel]\nenabled = false\n\n[analytics]\nother = 1\n"),
    &[],
)]
#[tokio::test]
async fn the_person_s_choices_compose_as_set(
    #[case] file: Option<&str>,
    #[case] composed: &[&str],
) {
    let personal_home = tempfile::tempdir().expect("a scratch folder is made");
    if let Some(file) = file {
        std::fs::write(personal_home.path().join("config.toml"), file).expect("the file is made");
    }

    let reading = read_codex_privacy(personal_home.path()).await;

    let reading = reading.expect("the file reads");
    assert_eq!(reading.config_overrides(), composed);
}

// Killed by a file that does not parse read as no choices, which drops what the person turned off,
// or by a failure that shows the file's text, leaves out its path or drops the reader's reason.
#[tokio::test]
async fn a_file_that_does_not_parse_fails_naming_its_path_and_never_its_text() {
    let personal_home = tempfile::tempdir().expect("a scratch folder is made");
    let path = personal_home.path().join("config.toml");
    std::fs::write(
        &path,
        "model = \"o3\"\n[analytics\nenabled = \"kept-private\"\n",
    )
    .expect("the file is made");

    let reading = read_codex_privacy(personal_home.path()).await;

    let Err(CodexError::ConfigUnreadable(failure)) = reading else {
        panic!("the read did not fail as an unreadable configuration");
    };
    let CodexConfigFileError::Unparsable { line, message, .. } = &failure else {
        panic!("the failure is not a parse failure: {failure:?}");
    };
    assert_eq!(*line, Some(2));
    assert_ne!(message.as_str(), "");
    let detail = failure.to_string();
    assert!(detail.contains(&path.display().to_string()), "{detail}");
    assert!(detail.contains(message.as_str()), "{detail}");
    assert!(!detail.contains("kept-private"), "{detail}");
}

// Killed by a privacy switch or table of another type read as unset, which starts a managed account
// with Codex's default where the person's own Codex refuses the file, or by a failure that shows
// the value or names another key.
#[rstest]
#[case::switch_as_text("[analytics]\nenabled = \"kept-off\"\n", "analytics.enabled")]
#[case::table_as_number("feedback = 1\n", "feedback")]
#[tokio::test]
async fn a_privacy_switch_of_another_type_fails_naming_its_key(
    #[case] file: &str,
    #[case] mistyped_key: &str,
) {
    let personal_home = tempfile::tempdir().expect("a scratch folder is made");
    std::fs::write(personal_home.path().join("config.toml"), file).expect("the file is made");

    let reading = read_codex_privacy(personal_home.path()).await;

    let Err(CodexError::ConfigUnreadable(CodexConfigFileError::Mistyped { key, .. })) = &reading
    else {
        panic!("the read did not fail on the mistyped key: {reading:?}");
    };
    assert_eq!(key, mistyped_key);
    assert!(!format!("{reading:?}").contains("kept-off"));
}
