//! What macOS and Linux share behind the interface; what one of them alone does is in its own
//! module.

pub(crate) mod askpass;
pub(crate) mod caller_process;
pub(crate) mod disk;
pub(crate) mod entry_identity;
pub(crate) mod error_codes;
pub(crate) mod file_system;
pub(crate) mod login_shell;
pub(crate) mod private_folder;
pub(crate) mod real_path;
pub(crate) mod shell_start;
pub(crate) mod socket_path;
pub(crate) mod terminal;
#[cfg(any(test, feature = "test-support"))]
pub(crate) mod uptime;

#[cfg(test)]
mod tests {
    use std::io::ErrorKind;
    use std::process::Command;

    use crate::read_command_argument_limit;

    // The bound macOS's and Linux's modules read is never under an argument a program can start
    // with.
    #[test]
    fn a_program_given_one_argument_past_the_limit_does_not_start() {
        let limit = read_command_argument_limit().expect("the limit reads");

        let refusal = Command::new("/usr/bin/true")
            .arg("a".repeat(limit + 1))
            .status()
            .expect_err("the program does not start");

        assert_eq!(refusal.kind(), ErrorKind::ArgumentListTooLong);
    }
}
