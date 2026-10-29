//! The askpass mode git and ssh run, by the program's `sidekicks-git-askpass` name, when they need
//! an answer from the person: a user name, a password or token, a key's passphrase, or whether to
//! trust a host's key. It carries the question to the daemon over the socket its environment names,
//! prints the answer the daemon sends back as one line and exits 0; it exits 1, printing nothing,
//! when the daemon refuses or is gone, so git gives up on the question.

use std::env::{self, consts::EXE_SUFFIX};
use std::io::{self, BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use interprocess::local_socket::traits::Stream as _;
use interprocess::local_socket::{GenericFilePath, Stream, ToFsName};

use super::broker::AskpassRequest;

/// The file name git and ssh run the askpass mode by, a link to the daemon's own program.
pub const GIT_ASKPASS_PROGRAM_NAME: &str = "sidekicks-git-askpass";

/// The environment variable naming the broker's socket to the askpass mode.
pub(crate) const ASKPASS_SOCKET_VARIABLE: &str = "SIDEKICKS_ASKPASS_SOCKET";

/// The environment variable naming a question's owner to the askpass mode.
pub(crate) const ASKPASS_OWNER_VARIABLE: &str = "SIDEKICKS_ASKPASS_OWNER";

/// The askpass mode's link in `program_link_folder`, the folder of the daemon's mode links, with
/// the system's program suffix.
pub fn git_askpass_program_path(program_link_folder: &Path) -> PathBuf {
    program_link_folder.join(format!("{GIT_ASKPASS_PROGRAM_NAME}{EXE_SUFFIX}"))
}

/// Runs the askpass mode: the question is git's or ssh's first argument, the socket and owner come
/// from the environment the daemon gave git. Exits 0 having printed the answer, 1 otherwise. Runs
/// before the daemon's runtime, log or allocator timer would start.
pub fn run_git_askpass() -> ExitCode {
    let Some(socket_path) = env::var_os(ASKPASS_SOCKET_VARIABLE) else {
        return ExitCode::FAILURE;
    };
    // No owner, or one that is no daemon's id, has no one to answer.
    let Ok(owner) = env::var(ASKPASS_OWNER_VARIABLE) else {
        return ExitCode::FAILURE;
    };
    let prompt = env::args_os()
        .nth(1)
        .map(|prompt| prompt.to_string_lossy().into_owned())
        .unwrap_or_default();
    ask_broker(
        Path::new(&socket_path),
        &owner,
        &prompt,
        &mut io::stdout().lock(),
    )
}

// Asks the broker at `socket_path` and writes its answer to `output` as one line: 0 once written,
// 1 with nothing written when the owner is empty, the broker refuses, is gone, or the answer cannot
// be written.
fn ask_broker(socket_path: &Path, owner: &str, prompt: &str, output: &mut impl Write) -> ExitCode {
    // An empty owner is no daemon's id, so nothing is asked.
    if owner.is_empty() {
        return ExitCode::FAILURE;
    }
    let Ok(Some(answer)) = read_answer(socket_path, owner, prompt) else {
        // Git reads a refusal and a failure alike: no answer from a program that exits 1.
        return ExitCode::FAILURE;
    };
    match writeln!(output, "{answer}").and_then(|()| output.flush()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(_) => ExitCode::FAILURE,
    }
}

// The broker's answer line without its break, or `None` when it closes without one.
fn read_answer(socket_path: &Path, owner: &str, prompt: &str) -> io::Result<Option<String>> {
    let stream = Stream::connect(socket_path.to_fs_name::<GenericFilePath>()?)?;
    let mut request = serde_json::to_vec(&AskpassRequest {
        owner: owner.to_owned(),
        prompt: prompt.to_owned(),
    })?;
    request.push(b'\n');
    (&stream).write_all(&request)?;
    let mut answer = String::new();
    BufReader::new(&stream).read_line(&mut answer)?;
    Ok(answer.strip_suffix('\n').map(str::to_owned))
}

#[cfg(test)]
mod tests {
    use std::io::{BufRead, BufReader, Write};
    use std::path::PathBuf;
    use std::process::ExitCode;

    use interprocess::local_socket::traits::Listener as _;
    use interprocess::local_socket::{GenericFilePath, ListenerOptions, ToFsName};
    use sidekicks_contracts::repo::clone::AskpassAnswer;
    use tokio::sync::mpsc;

    use super::{ASKPASS_OWNER_VARIABLE, ASKPASS_SOCKET_VARIABLE, ask_broker, read_answer};
    use crate::clone::askpass::broker::{AskpassBroker, AskpassOwner};

    // The socket and owner the daemon gives git, as the mode reads them.
    fn socket_and_owner_of(owner: &AskpassOwner) -> (PathBuf, String) {
        let owner_id = owner.environment_value(ASKPASS_OWNER_VARIABLE);
        (
            PathBuf::from(owner.environment_value(ASKPASS_SOCKET_VARIABLE)),
            owner_id.to_str().expect("an owner id is hex").to_owned(),
        )
    }

    // Runs the mode's core off the runtime, since its socket blocks.
    async fn run_mode(socket_path: PathBuf, owner_id: String) -> (ExitCode, Vec<u8>) {
        tokio::task::spawn_blocking(move || {
            let mut output = Vec::new();
            let exit = ask_broker(&socket_path, &owner_id, "Password: ", &mut output);
            (exit, output)
        })
        .await
        .expect("the mode runs")
    }

    #[tokio::test]
    async fn prints_the_answer_as_one_line_and_exits_0() {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let broker = AskpassBroker::start(scratch.path(), PathBuf::from("askpass-program"))
            .expect("the broker starts");
        let owner = broker
            .register(|_| async { AskpassAnswer::new("hunter2".to_owned()) })
            .expect("the owner registers");
        let (socket_path, owner_id) = socket_and_owner_of(&owner);

        let (exit, output) = run_mode(socket_path, owner_id).await;

        assert_eq!(exit, ExitCode::SUCCESS);
        assert_eq!(output, b"hunter2\n");
        drop(owner);
        broker.close().await.expect("the broker closes");
    }

    #[tokio::test]
    async fn exits_1_printing_nothing_when_the_owner_is_released() {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let broker = AskpassBroker::start(scratch.path(), PathBuf::from("askpass-program"))
            .expect("the broker starts");
        let (questions, mut asked) = mpsc::unbounded_channel();
        let owner = broker
            .register(move |_| {
                questions.send(()).expect("the test waits for the question");
                std::future::pending::<Option<AskpassAnswer>>()
            })
            .expect("the owner registers");
        let (socket_path, owner_id) = socket_and_owner_of(&owner);

        let mode = tokio::spawn(run_mode(socket_path, owner_id));
        asked.recv().await.expect("the question arrives");
        drop(owner);
        let (exit, output) = mode.await.expect("the mode ends");

        assert_eq!(exit, ExitCode::FAILURE);
        assert_eq!(output, b"");
        broker.close().await.expect("the broker closes");
    }

    #[test]
    fn refuses_an_empty_owner_without_asking() {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let socket_path = scratch.path().join("answers.sock");
        let listener = ListenerOptions::new()
            .name(
                socket_path
                    .as_path()
                    .to_fs_name::<GenericFilePath>()
                    .expect("a socket name"),
            )
            .create_sync()
            .expect("the socket listens");
        // Answers the first asker, so a mode that asked would print the answer.
        let answerer = std::thread::spawn(move || {
            let stream = listener.accept().expect("an asker connects");
            let mut request = String::new();
            BufReader::new(&stream)
                .read_line(&mut request)
                .expect("the request reads");
            (&stream)
                .write_all(b"hunter2\n")
                .expect("the answer is sent");
        });

        let mut output = Vec::new();
        let exit = ask_broker(&socket_path, "", "Password: ", &mut output);

        assert_eq!(exit, ExitCode::FAILURE);
        assert_eq!(output, b"");
        // The first asker is the test itself, so the mode never connected.
        assert_eq!(
            read_answer(&socket_path, "owner", "Password: ").expect("the test asks"),
            Some("hunter2".to_owned())
        );
        answerer.join().expect("the answerer ends");
    }
}
