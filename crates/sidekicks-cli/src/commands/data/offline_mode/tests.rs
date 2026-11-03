use sidekicks_client::error::ClientError;
use sidekicks_contracts::daemon::mode_outcome::DaemonModeOutcome;
use sidekicks_platforms::{StandInAnswer, StandInProgram, write_stand_in_program};

use super::run_offline_mode;

// Runs a stand-in for the daemon's program that prints `standard_output` and exits with
// `exit_code`, and answers how `run_offline_mode` failed.
async fn run_stand_in(standard_output: String, exit_code: u8) -> anyhow::Error {
    let folder = tempfile::tempdir().expect("a scratch folder is made");
    let program = write_stand_in_program(
        folder.path(),
        "daemon",
        &StandInProgram {
            answers_by_first_argument: Vec::new(),
            otherwise: StandInAnswer {
                standard_output,
                exit_code,
                argument_record: None,
            },
        },
    )
    .expect("the stand-in is written");
    run_offline_mode(&program, Vec::new())
        .await
        .expect_err("the stand-in's run fails")
}

// The mode's own refusal is the service's answer, which the install reads as a move the mode
// put back itself. Killed by reading the printed refusal as anything but `Remote`.
#[tokio::test]
async fn a_mode_that_answers_its_refusal_fails_as_the_services_answer() {
    let refusal = serde_json::to_string(&DaemonModeOutcome::<()>::failed(
        "the keychain is locked".to_owned(),
    ))
    .expect("the refusal is written as JSON");
    let failure = run_stand_in(refusal, 1).await;
    assert!(
        matches!(failure.downcast_ref::<ClientError>(), Some(ClientError::Remote(remote))
            if remote.message == "the keychain is locked"),
        "{failure:?}"
    );
}

// A program that ended with no answer did not put anything back, so its failure must not read as
// the mode's own refusal. Killed by mapping the unread answer to `Remote`, and by a failure that
// drops how the program ended.
#[tokio::test]
async fn a_mode_that_ends_with_no_answer_fails_naming_its_ending() {
    let failure = run_stand_in(String::new(), 3).await;
    assert!(
        !failure
            .chain()
            .any(|cause| matches!(cause.downcast_ref(), Some(ClientError::Remote(_)))),
        "{failure:?}"
    );
    assert!(
        failure.to_string().contains("with exit code 3"),
        "{failure}"
    );
}
