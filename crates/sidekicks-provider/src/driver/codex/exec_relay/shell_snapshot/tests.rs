use std::process::Command;
use std::sync::Arc;

use serde_json::{Map, Value, json};
use sidekicks_platforms::Spawner;
use tokio::runtime::Handle;

use super::ShellSnapshots;
use super::wrap::wrap_with_snapshot;
use crate::driver::test_registry::new_session_id;

fn words(argv: &[&str]) -> Vec<String> {
    argv.iter().map(|word| (*word).to_owned()).collect()
}

// A relayed `-lc` start runs Codex's local snapshot form on the capture's own output, under the
// conversation's policy, which inherits nothing: no profile export reaches the command, a key the
// conversation sets keeps the conversation's value, and the command's shell runs its line with the
// start's words. Killed by a snapshot that keeps the profile's exports.
#[tokio::test]
async fn runs_a_login_start_with_the_conversations_environment_alone() {
    let folder = tempfile::tempdir().expect("a test folder");
    let home = folder.path().join("home");
    std::fs::create_dir(&home).expect("the home is made");
    std::fs::write(
        home.join(".bashrc"),
        "export SNAPSHOT_EXPORTED=from-profile\nexport CONVERSATION_SET=from-profile\n\
         greet() { echo hello; }\n",
    )
    .expect("the rc is written");
    let spawner = Spawner::new(Handle::current()).expect("a spawner");
    let snapshots = ShellSnapshots::new(spawner, folder.path(), Arc::default());
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
    environment.insert("CONVERSATION_SET".to_owned(), json!("from-conversation"));
    let line = r#"echo "${SNAPSHOT_EXPORTED-unset}:$CONVERSATION_SET:$(greet):$0:$1""#;
    let argv = words(&["/bin/bash", "-lc", line, "first", "second"]);

    let wrapped = wrap_with_snapshot(&argv, &snapshot, &environment).expect("a login start");

    assert_eq!(wrapped[..2], words(&["/bin/bash", "-c"]));
    let output = Command::new(&wrapped[0])
        .args(&wrapped[1..])
        .env_clear()
        .env("CODEX_THREAD_ID", "thread-1")
        .env("CONVERSATION_SET", "from-conversation")
        .env("PATH", "/usr/bin:/bin")
        .output()
        .expect("the wrapped start runs");
    assert!(output.status.success(), "{output:?}");
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        "unset:from-conversation:hello:first:second\n"
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
    let snapshots = ShellSnapshots::new(spawner, folder.path(), Arc::default());
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

// The first snapshot any relay writes removes what a former daemon run left, and only then: a
// second relay's first snapshot keeps the first relay's. Killed by no removal, and by a removal
// at each relay's first snapshot.
#[tokio::test]
async fn the_first_snapshot_of_a_run_removes_only_what_a_former_run_left() {
    let folder = tempfile::tempdir().expect("a test folder");
    let left = folder
        .path()
        .join("codex-shell-snapshots")
        .join("former-run");
    std::fs::create_dir_all(&left).expect("a former run's folder is made");
    std::fs::write(left.join("old.sh"), "true\n").expect("a former snapshot is written");
    let home = folder.path().join("home");
    std::fs::create_dir(&home).expect("the home is made");
    let spawner = Spawner::new(Handle::current()).expect("a spawner");
    let sweep = Arc::default();
    let environment = vec![
        ("HOME".to_owned(), home.to_string_lossy().into_owned()),
        ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
    ];
    let first_relay = ShellSnapshots::new(spawner.clone(), folder.path(), Arc::clone(&sweep));
    first_relay.set_environment(environment.clone());
    let second_relay = ShellSnapshots::new(spawner, folder.path(), sweep);
    second_relay.set_environment(environment);

    let first = first_relay
        .snapshot_for(new_session_id(), "thread-1", "/bin/bash", folder.path())
        .await
        .expect("the first relay's snapshot is taken");
    let is_left_gone = !left.exists();
    second_relay
        .snapshot_for(new_session_id(), "thread-2", "/bin/bash", folder.path())
        .await
        .expect("the second relay's snapshot is taken");

    assert!(is_left_gone, "the former run's folder is removed");
    assert!(first.exists(), "the first relay's snapshot is kept");
}
