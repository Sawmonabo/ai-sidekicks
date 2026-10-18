//! Output into a pipe whose reader went away ends the program as a closed pipe ends git: exit 141,
//! nothing on stderr.

use std::process::{Command, Stdio};

#[test]
fn help_into_a_closed_pipe_exits_141_with_nothing_on_stderr() {
    let (reader, writer) = std::io::pipe().expect("a pipe opens");
    drop(reader);
    let output = Command::new(env!("CARGO_BIN_EXE_sidekicks"))
        .arg("--help")
        .stdout(writer)
        .stderr(Stdio::piped())
        .output()
        .expect("the program runs");
    assert_eq!(output.status.code(), Some(141));
    assert!(
        output.stderr.is_empty(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
