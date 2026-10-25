//! What a process started with: its arguments and its environment, as each platform's module reads
//! them.

/// The arguments and environment a process started with, as the system shows them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcessStart {
    /// The process's arguments, its program's name as it was started first.
    pub arguments: Vec<String>,
    /// The environment it started with, one `NAME=value` entry each.
    pub environment: Vec<String>,
}

#[cfg(all(test, unix))]
mod tests {
    use std::process::{Command, Stdio};
    use std::thread;
    use std::time::Duration;

    use crate::{list_user_process_ids, read_process_start};

    // The marker the child carries, and the value it carries it with.
    const PROBE_NAME: &str = "SIDEKICKS_PROBE";
    const PROBE_ENTRY: &str = "SIDEKICKS_PROBE=1";

    // How long the child waits, which bounds the test if it is never killed.
    const CHILD_WAIT: Duration = Duration::from_secs(5);

    // macOS hides the environment of its own programs, so the child is this test program, run
    // again on this one test, which waits when it carries the marker.
    #[test]
    fn process_start_reads_a_child_s_arguments_environment_and_id() {
        if std::env::var_os(PROBE_NAME).is_some() {
            thread::sleep(CHILD_WAIT);
            return;
        }
        let program = std::env::current_exe().expect("the test program is known");
        let test_name = module_path!()
            .split_once("::")
            .map_or(module_path!(), |(_, path)| path);
        let arguments = [
            "--exact".to_owned(),
            format!("{test_name}::process_start_reads_a_child_s_arguments_environment_and_id"),
        ];
        let mut child = Command::new(&program)
            .args(&arguments)
            .env(PROBE_NAME, "1")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("the child starts");
        let child_id = child.id();

        let start = read_process_start(child_id);
        let user_processes = list_user_process_ids();
        child.kill().expect("the child is killed");
        child.wait().expect("the child is reaped");

        let start = start
            .expect("the start reads")
            .expect("the child shows its start");
        let mut expected_arguments = vec![program.to_string_lossy().into_owned()];
        expected_arguments.extend(arguments);
        assert_eq!(start.arguments, expected_arguments);
        assert!(start.environment.iter().any(|entry| entry == PROBE_ENTRY));
        assert!(
            user_processes
                .expect("the user's processes list")
                .contains(&child_id)
        );
    }
}
