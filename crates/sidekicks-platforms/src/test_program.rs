//! This test program run again as a child of itself, with only one of its tests: how a test starts
//! a stand-in for another program, its body an ignored test of the same binary.

use crate::terminal::TestProgram;

/// The name the test harness gives `test` in the module at `module_path`, which is
/// `module_path!()` as the test's own module reads it, so a test can run its program again on that
/// one test.
pub fn harness_test_name(module_path: &str, test: &str) -> String {
    let module = module_path
        .split_once("::")
        .map_or(module_path, |(_, path)| path);
    format!("{module}::{test}")
}

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

/// A stand-in for one of the daemon's own modes: this test program, run with only its test
/// `stand_in_test`, whose body does what the mode does, such as `run_shell_start_stand_in` for the
/// `shell` mode a terminal test opens shells through.
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

/// The start of `program` through this test program's stand-in `stand_in_test`, whose body is
/// [`run_terminal_taking_stand_in`](crate::run_terminal_taking_stand_in): the stand-in's own
/// start, then `--`, `program` and its words, which the test harness reads as filters that name no
/// other test.
pub fn terminal_taking_start(stand_in_test: &str, program: &TestProgram) -> TestProgram {
    let mut start = pass_through_start(stand_in_test);
    start.arguments.push("--".to_owned());
    start.arguments.push(program.program.clone());
    start.arguments.extend(program.arguments.iter().cloned());
    start
}
