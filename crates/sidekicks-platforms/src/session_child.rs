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
    use std::path::Path;
    use std::time::Duration;

    use nix::unistd::{Pid, getpgid, getsid};
    use tokio::io::{AsyncBufReadExt as _, AsyncReadExt as _, BufReader};

    use super::SessionCommand;
    use crate::{real_path, start_session_child};

    // Fails when the session is dropped, which leaves the child in the test's own session, when an
    // added entry or the inherited environment does not reach it, when it starts in another
    // folder, and when the group's end does not reach the child, which leaves its output open.
    #[tokio::test]
    async fn a_session_child_leads_its_own_session_and_ends_with_its_group() {
        let folder = tempfile::tempdir().expect("a scratch folder");
        let mut child = start_session_child(
            &SessionCommand {
                program: "/bin/sh".into(),
                argument_zero: "sh".into(),
                arguments: vec![
                    "-c".to_owned(),
                    "echo \"$$ $PROBE ${HOME:+inherited} $(pwd -P)\"; sleep 30 & exec /bin/sleep 30"
                        .to_owned(),
                ],
                added_environment: vec![("PROBE".to_owned(), "added".to_owned())],
                working_folder: folder.path().to_path_buf(),
            },
            std::process::id(),
        )
        .expect("the child starts");
        let mut output = BufReader::new(child.output_mut());
        let mut line = String::new();
        output
            .read_line(&mut line)
            .await
            .expect("the child's line reads");
        let mut words = line.trim_end().splitn(4, ' ');
        let pid = Pid::from_raw(
            words
                .next()
                .and_then(|word| word.parse().ok())
                .expect("the child prints its id"),
        );
        let session = getsid(Some(pid));
        let group = getpgid(Some(pid));
        let words: Vec<&str> = words.collect();
        drop(output);

        child.end_group().await.expect("the group ends");
        let mut rest = Vec::new();
        let read = tokio::time::timeout(
            Duration::from_secs(5),
            child.output_mut().read_to_end(&mut rest),
        )
        .await;

        assert_eq!(words[..2], ["added", "inherited"]);
        assert_eq!(
            Path::new(words[2]),
            real_path(folder.path()).expect("the scratch folder resolves")
        );
        assert_eq!(session.expect("the child's session reads"), pid);
        assert_eq!(group.expect("the child's group reads"), pid);
        assert!(
            matches!(read, Ok(Ok(_))),
            "the output stays open after the group's end"
        );
    }
}
