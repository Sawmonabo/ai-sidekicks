//! The shell commands an agent runs: the sealed channel a command's wrapper and its askpass reach
//! the daemon through, those two program modes, the running set each session keeps, and the checks
//! that read whether a command waits for input.

pub(crate) mod askpass;
pub(crate) mod channel;
pub(crate) mod running_set;
pub(crate) mod waiting_checks;
pub(crate) mod wrapper;

/// The name the test harness gives `test` in the module at `module_path`, which is
/// `module_path!()` as the test's own module reads it, so a test can run this program again on that
/// one test.
#[cfg(test)]
pub(crate) fn harness_test_name(module_path: &str, test: &str) -> String {
    let module = module_path
        .split_once("::")
        .map_or(module_path, |(_, path)| path);
    format!("{module}::{test}")
}
