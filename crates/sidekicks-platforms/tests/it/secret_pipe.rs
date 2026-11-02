//! A secret handed to a child on the pipe it inherits: the child reads it to its end, and it shows
//! in neither the child's environment nor its arguments.

use std::hash::{DefaultHasher, Hash as _, Hasher as _};
use std::io::Write as _;
use std::process::Stdio;
use std::time::Duration;

use sidekicks_platforms::{
    Spawner, secret_pipe, take_inherited_secret, wrap_leading_child_command,
};
use tokio::process::Command;

/// The variable the child reads the descriptor's number from.
const SECRET_VARIABLE: &str = "SIDEKICKS_TEST_SECRET_DESCRIPTOR";

/// The name the test harness gives the stand-in child's test.
const STAND_IN_TEST: &str = "secret_pipe::secret_reading_stand_in";

/// How long the child has to read the secret to its end and exit.
const CHILD_BOUND: Duration = Duration::from_secs(30);

/// The secret the test hands over.
const SECRET: &str = "test-secret-token-3f9a1c7e";

/// The hash a line of the child's output carries for `bytes`, so the secret itself is never
/// printed.
fn secret_hash(bytes: &[u8]) -> u64 {
    let mut hasher = DefaultHasher::new();
    bytes.hash(&mut hasher);
    hasher.finish()
}

// Fails when the secret reaches the child as a variable or an argument, when the write end stays
// open in this process or the child (the child never sees the end and the bound fails it), and on
// macOS when the start forks. Mutations: set the secret itself as the variable; clear
// close-on-exec on the write end too; add a `pre_exec` to the spawn.
#[tokio::test]
async fn a_secret_reaches_the_child_on_its_inherited_pipe_alone() {
    #[cfg(target_os = "macos")]
    crate::fork_count::count_forks();
    let pipe = secret_pipe().expect("macOS and Linux supply the secret pipe");
    let spawner = Spawner::new(tokio::runtime::Handle::current()).expect("the spawner starts");
    let mut command = Command::new(std::env::current_exe().expect("the test program names itself"));
    command
        .args(["--exact", STAND_IN_TEST, "--include-ignored", "--nocapture"])
        .stdout(Stdio::piped());
    let daemon_pid = std::process::id();

    let child = spawner
        .run(move || {
            pipe.spawn_with_secret(command, SECRET_VARIABLE, SECRET.as_bytes(), |command| {
                wrap_leading_child_command(command, daemon_pid).spawn()
            })
        })
        .await
        .expect("the spawner runs the start")
        .expect("the child starts");
    let output = tokio::time::timeout(CHILD_BOUND, Box::into_pin(child.wait_with_output()))
        .await
        .expect("the child reads the secret to its end and exits")
        .expect("the child's output reads");

    assert!(output.status.success(), "the stand-in passes");
    let printed = String::from_utf8(output.stdout).expect("the child prints text");
    let hash_line = format!("hash={}", secret_hash(SECRET.as_bytes()));
    assert!(
        printed.lines().any(|line| line == hash_line),
        "the child read the secret whole: {printed}"
    );
    let shown: Vec<&str> = printed
        .lines()
        .filter(|line| line.starts_with("environment=") || line.starts_with("argument="))
        .collect();
    assert!(
        shown
            .iter()
            .any(|line| line.starts_with(&format!("environment={SECRET_VARIABLE}="))),
        "the child printed its environment"
    );
    assert!(
        shown.iter().all(|line| !line.contains(SECRET)),
        "the secret shows in the child's environment or arguments"
    );
    #[cfg(target_os = "macos")]
    assert_eq!(crate::fork_count::forks(), 1, "the start forked");
}

// The stand-in child: reads the descriptor its variable names to the end, prints the hash of what
// it read, then each variable of its environment and each of its arguments.
#[test]
#[ignore = "the child the secret pipe's test starts, run only by it"]
fn secret_reading_stand_in() {
    let descriptor =
        std::env::var_os(SECRET_VARIABLE).expect("the secret pipe's test names the descriptor");
    let secret = take_inherited_secret(&descriptor).expect("the secret reads to its end");
    let mut printed = std::io::stdout().lock();
    writeln!(printed, "hash={}", secret_hash(&secret)).expect("the hash prints");
    for (name, value) in std::env::vars_os() {
        writeln!(
            printed,
            "environment={}={}",
            name.to_string_lossy(),
            value.to_string_lossy()
        )
        .expect("the variable prints");
    }
    for argument in std::env::args_os() {
        writeln!(printed, "argument={}", argument.to_string_lossy()).expect("the argument prints");
    }
}
