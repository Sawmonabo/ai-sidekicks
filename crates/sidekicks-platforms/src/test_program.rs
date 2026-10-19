//! This test program run again as a child of itself, with only one of its tests: how a test starts
//! a stand-in for another program, its body an ignored test of the same binary.

use crate::terminal::TestProgram;

/// The arguments that run only the test `name`, ignored ones included, its output kept.
pub(crate) fn this_test_arguments(name: &str) -> [&str; 4] {
    ["--exact", name, "--include-ignored", "--nocapture"]
}

/// This test program, run with only the test `name`, ignored ones included, its output kept.
#[cfg(test)]
pub(crate) fn this_test_program(name: &str) -> std::process::Command {
    let mut command =
        std::process::Command::new(std::env::current_exe().expect("the test program names itself"));
    command.args(this_test_arguments(name));
    command
}

/// The `shell` mode's stand-in a terminal test opens shells through: this test program, run with
/// only its test `stand_in_test`, whose body calls `run_shell_start_stand_in`, which reads the
/// launch the terminal sends and starts its shell.
pub fn pass_through_start(stand_in_test: &str) -> TestProgram {
    TestProgram {
        program: std::env::current_exe()
            .expect("the test program names itself")
            .to_string_lossy()
            .into_owned(),
        arguments: this_test_arguments(stand_in_test)
            .map(str::to_owned)
            .to_vec(),
    }
}
