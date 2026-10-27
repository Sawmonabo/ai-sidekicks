//! A child that leads a session of its own and whose output the daemon reads: an interactive
//! shell, which opens its terminal and stops itself while its group is not the terminal's
//! foreground one, so a group of its own is not enough. Each platform starts it in its own module.

use std::ffi::OsString;
use std::path::PathBuf;

/// What a session child runs: its standard input and error read and write nothing, and its
/// standard output is the pipe its start answers.
#[derive(Debug)]
pub struct SessionCommand {
    /// The program, an absolute path to an executable file.
    pub program: PathBuf,
    /// The first word of its command line, the name it reads as its own; Windows passes a program
    /// no such word, so it is not read there.
    pub argument_zero: OsString,
    /// The arguments after the program.
    pub arguments: Vec<String>,
    /// The entries set over the daemon's own environment, which the child inherits.
    pub added_environment: Vec<(String, String)>,
    /// The folder the child starts in.
    pub working_folder: PathBuf,
}

#[cfg(all(test, unix))]
mod tests {
    use std::os::unix::process::ExitStatusExt as _;

    use nix::sys::signal::Signal;
    use nix::unistd::{Pid, getpgid, getsid};
    use tokio::io::{AsyncBufReadExt as _, BufReader};

    use super::SessionCommand;
    use crate::start_session_child;

    // Fails when the session is dropped, which leaves the child in the test's own session, when an
    // added entry or the inherited environment does not reach it, and when the group's end or the
    // reap does not reach it, which leaves the wait without an answer.
    #[tokio::test]
    async fn a_session_child_leads_its_own_session_and_ends_with_its_group() {
        let folder = tempfile::tempdir().expect("a scratch folder");
        let mut child = start_session_child(
            &SessionCommand {
                program: "/bin/sh".into(),
                argument_zero: "sh".into(),
                arguments: vec![
                    "-c".to_owned(),
                    "echo \"$$ $PROBE ${HOME:+inherited}\"; exec /bin/sleep 30".to_owned(),
                ],
                added_environment: vec![("PROBE".to_owned(), "added".to_owned())],
                working_folder: folder.path().to_path_buf(),
            },
            std::process::id(),
        )
        .expect("the child starts");
        let mut line = String::new();
        BufReader::new(&mut child.output)
            .read_line(&mut line)
            .await
            .expect("the child's line reads");
        let mut words = line.split_whitespace();
        let pid = Pid::from_raw(
            words
                .next()
                .and_then(|word| word.parse().ok())
                .expect("the child prints its id"),
        );

        let session = getsid(Some(pid));
        let group = getpgid(Some(pid));
        child.end_group().expect("the group ends");
        let status = child.wait().await.expect("the child is reaped");

        assert_eq!(words.collect::<Vec<_>>(), ["added", "inherited"]);
        assert_eq!(session.expect("the child's session reads"), pid);
        assert_eq!(group.expect("the child's group reads"), pid);
        assert_eq!(status.signal(), Some(Signal::SIGKILL as i32));
    }
}
