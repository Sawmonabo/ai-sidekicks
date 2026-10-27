use std::path::Path;
use std::process::{Command, ExitCode, Stdio};
use std::sync::Arc;
use std::time::Duration;

use rstest::rstest;
use sidekicks_ipc::caller_process::system_reader::ProcessTableReader;
use sidekicks_platforms::{harness_test_name, name_program};

use super::{COMMAND_ASKPASS_PROGRAM_NAME, run_command_askpass};
use crate::command::channel::{CommandChannel, DaemonRequest, PartyRecord};

/// The test the started askpass runs as.
const ASKPASS_PROCESS_TEST: &str = "an_askpass_process_asks_its_prompt";

const PROMPT: &str = "Password for 'https://ana@example.com': ";

#[test]
#[ignore = "run only as the askpass process another test starts"]
#[expect(
    clippy::exit,
    reason = "the askpass's own exit status is what git reads, where the harness would exit with \
              its own"
)]
fn an_askpass_process_asks_its_prompt() {
    std::process::exit(i32::from(run_command_askpass() != ExitCode::SUCCESS));
}

/// The files and folders under `folder`, by their paths inside it.
fn entries_under(folder: &Path) -> Vec<String> {
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(folder).expect("the folder lists") {
        let path = entry.expect("an entry").path();
        let name = path
            .strip_prefix(folder)
            .expect("inside the folder")
            .display()
            .to_string();
        if path.is_dir() {
            entries.extend(
                entries_under(&path)
                    .into_iter()
                    .map(|inner| format!("{name}/{inner}")),
            );
        }
        entries.push(name);
    }
    entries.sort();
    entries
}

// Fails when an empty answer, the end of input, is printed and exits 0, which git takes as an
// empty password, when a typed answer is not printed as its one line, or when the askpass leaves
// its answer's request behind. Mutations: in `ask_daemon`, drop `.filter(|text| !text.is_empty())`;
// in `read_request`, keep the request file.
#[rstest]
#[case::end_of_input("", 1, "")]
#[case::typed_answer("hunter2", 0, "hunter2\n")]
#[tokio::test]
async fn the_askpass_exits_as_the_answer_says(
    #[case] answer: &str,
    #[case] exit_code: i32,
    #[case] printed: &str,
) {
    let folder = tempfile::tempdir().expect("a folder");
    let channel = CommandChannel::open(
        folder.path().join("channel"),
        std::process::id(),
        Arc::new(ProcessTableReader::for_this_program().expect("a reader")) as _,
    )
    .expect("the channel opens");
    let mut watch = channel.watch().await.expect("the channel is watched");
    let mut command = Command::new(std::env::current_exe().expect("the test program"));
    name_program(&mut command, COMMAND_ASKPASS_PROGRAM_NAME.as_ref()).expect("the name is set");
    command
        .arg(PROMPT)
        .args([
            "--exact",
            &harness_test_name(module_path!(), ASKPASS_PROCESS_TEST),
            "--ignored",
            "--nocapture",
            "--quiet",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (name, value) in channel.environment() {
        command.env(name, value);
    }
    let askpass = command.spawn().expect("the askpass starts");
    let asking = tokio::time::timeout(Duration::from_secs(20), channel.next_records(&mut watch))
        .await
        .expect("the askpass asks")
        .expect("the watch holds")
        .remove(0);
    assert_eq!(asking.record, PartyRecord::Asking {});
    assert_eq!(asking.first_argument.as_deref(), Some(PROMPT));
    let text = answer.to_owned();
    channel
        .send_request(asking.party, &DaemonRequest::Answer { text })
        .await
        .expect("the answer is written");
    let output = tokio::task::spawn_blocking(move || askpass.wait_with_output())
        .await
        .expect("the wait runs")
        .expect("the askpass ends");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert_eq!(output.status.code(), Some(exit_code), "{stderr}");
    // The test harness says what it runs before the askpass prints, once before the askpass's
    // restart with its key and once after.
    let harness_preamble = "\nrunning 1 test\n".repeat(2);
    assert_eq!(
        stdout.strip_prefix(&harness_preamble),
        Some(printed),
        "{stdout:?}"
    );
    assert_eq!(
        entries_under(folder.path()),
        ["channel", "channel/requests"]
    );
}
