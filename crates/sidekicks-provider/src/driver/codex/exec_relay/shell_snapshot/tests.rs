use std::process::Command;

use serde_json::{Map, Value, json};
use sidekicks_platforms::Spawner;
use tokio::runtime::Handle;

use super::ShellSnapshots;
use super::wrap::wrap_with_snapshot;
use crate::driver::test_registry::new_session_id;

fn words(argv: &[&str]) -> Vec<String> {
    argv.iter().map(|word| (*word).to_owned()).collect()
}

// A relayed `-lc` start runs Codex's local snapshot form on the capture's own output: the
// profile's exports reach the command through the snapshot, a variable Codex never lets a command
// inherit and the start's own runtime variable do not come from it, and the command's shell runs
// its line with the start's words.
#[tokio::test]
async fn runs_a_login_start_with_the_profiles_exports_from_its_capture() {
    let folder = tempfile::tempdir().expect("a test folder");
    let home = folder.path().join("home");
    std::fs::create_dir(&home).expect("the home is made");
    std::fs::write(
        home.join(".bashrc"),
        "export SNAPSHOT_EXPORTED=from-profile\nexport NODE_REPL_AUTH_TOKEN=from-profile\n\
         export CODEX_THREAD_ID=stale\n",
    )
    .expect("the rc is written");
    let spawner = Spawner::new(Handle::current()).expect("a spawner");
    let snapshots = ShellSnapshots::new(spawner, folder.path());
    snapshots.set_environment(vec![
        ("HOME".to_owned(), home.to_string_lossy().into_owned()),
        ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
    ]);
    let snapshot = snapshots
        .snapshot_for(new_session_id(), "thread-1", "/bin/bash", folder.path())
        .await
        .expect("the snapshot is taken");
    let mut environment = Map::new();
    environment.insert("CODEX_THREAD_ID".to_owned(), json!("thread-1"));
    let line =
        r#"echo "${SNAPSHOT_EXPORTED-unset}:${NODE_REPL_AUTH_TOKEN-unset}:$CODEX_THREAD_ID:$0:$1""#;
    let argv = words(&["/bin/bash", "-lc", line, "first", "second"]);

    let wrapped = wrap_with_snapshot(&argv, &snapshot, &environment).expect("a login start");

    assert_eq!(wrapped[..2], words(&["/bin/bash", "-c"]));
    let output = Command::new(&wrapped[0])
        .args(&wrapped[1..])
        .env_clear()
        .env("CODEX_THREAD_ID", "thread-1")
        .env("PATH", "/usr/bin:/bin")
        .output()
        .expect("the wrapped start runs");
    assert!(output.status.success(), "{output:?}");
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        "from-profile:unset:thread-1:first:second\n"
    );
}

// Any start but a login shell's runs as it is.
#[test]
fn leaves_a_start_that_is_no_login_shell() {
    let environment: Map<String, Value> = Map::new();
    let snapshot = std::path::Path::new("/nonexistent/snapshot.sh");
    for argv in [
        words(&["/bin/sh", "-c", "true"]),
        words(&["/usr/bin/env", "true"]),
    ] {
        assert_eq!(wrap_with_snapshot(&argv, snapshot, &environment), None);
    }
}

// A conversation's first command captures the login shell's functions once; a second asks the
// same file back.
#[tokio::test]
async fn captures_a_login_shells_functions_once() {
    let folder = tempfile::tempdir().expect("a test folder");
    let home = folder.path().join("home");
    std::fs::create_dir(&home).expect("the home is made");
    std::fs::write(home.join(".bashrc"), "greet() { echo seen; }\n").expect("the rc is written");
    let spawner = Spawner::new(Handle::current()).expect("a spawner");
    let snapshots = ShellSnapshots::new(spawner, folder.path());
    snapshots.set_environment(vec![
        ("HOME".to_owned(), home.to_string_lossy().into_owned()),
        ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
    ]);
    let session_id = new_session_id();

    let first = snapshots
        .snapshot_for(session_id, "thread-1", "/bin/bash", folder.path())
        .await
        .expect("the snapshot is taken");
    let second = snapshots
        .snapshot_for(session_id, "thread-1", "/bin/bash", folder.path())
        .await
        .expect("the snapshot is kept");

    assert_eq!(first, second);
    let written = std::fs::read_to_string(&first).expect("the snapshot is readable");
    assert!(written.starts_with("# Snapshot file"), "{written}");
    assert!(written.contains("greet"), "{written}");
    let sourced = Command::new("/bin/bash")
        .args(["-c", &format!(". '{}' && greet", first.display())])
        .env_clear()
        .output()
        .expect("the snapshot sources");
    assert_eq!(String::from_utf8_lossy(&sourced.stdout), "seen\n");
}
