use rstest::rstest;

use super::read_codex_privacy;
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
// or by a failure that shows the file's text or leaves out its path.
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

    let Err(CodexError::Transport { detail, cause }) = reading else {
        panic!("the read did not fail as a start's failure");
    };
    assert!(detail.contains(&path.display().to_string()), "{detail}");
    assert!(!detail.contains("kept-private"), "{detail}");
    assert!(cause.is_none());
}
