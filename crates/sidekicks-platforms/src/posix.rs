//! What macOS and Linux share behind the interface; what one of them alone does is in its own
//! module.

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(crate) mod allocator;
pub(crate) mod argument_space;
pub(crate) mod askpass;
pub(crate) mod c_string;
pub(crate) mod child_command;
pub(crate) mod child_tree;
pub(crate) mod clone_refusal;
pub(crate) mod command_wrapper;
pub(crate) mod ctrl_c;
pub(crate) mod current_user;
pub(crate) mod disk;
pub(crate) mod entry_identity;
pub(crate) mod error_codes;
pub(crate) mod executable_file;
pub(crate) mod file_facts;
pub(crate) mod file_system;
pub(crate) mod login_shell;
pub(crate) mod memory;
pub(crate) mod null_device;
pub(crate) mod os_text;
pub(crate) mod private_folder;
pub(crate) mod process;
pub(crate) mod real_path;
pub(crate) mod run_folder;
pub(crate) mod secret_pipe;
pub(crate) mod shell_folder_start;
pub(crate) mod shell_start;
pub(crate) mod shell_start_confirmation;
pub(crate) mod socket;
pub(crate) mod spawn;
#[cfg(any(test, feature = "test-support"))]
pub(crate) mod stand_in_program;
pub(crate) mod stop_request;
pub(crate) mod system_locale;
pub(crate) mod terminal;
pub(crate) mod thread_cpu_time;
#[cfg(any(test, feature = "test-support"))]
pub(crate) mod uptime;
pub(crate) mod volume_folder;
pub(crate) mod xdg_data_folders;

#[cfg(test)]
mod tests {
    use std::fs::File;
    use std::io::ErrorKind;
    use std::process::Command;

    use crate::{
        read_command_argument_limit, read_descriptor_path, read_environment_value_limits, real_path,
    };

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

    // The name each test's variables take, with a number after it where there are several.
    const PROBE_NAME: &str = "SIDEKICKS_PROBE";

    // An entry one byte past the per-value bound never starts, and on Linux one that fills it
    // exactly does, into an environment holding nothing else, where the total also leaves room for
    // the program's path and a pointer each for it and the entry (64 KiB pages, or a stack limit of
    // 512 KiB or less, leave none). Fails when the bound reads smaller than the system's (macOS's
    // `read_argument_space`, Linux's `ARGUMENT_PAGES`), or larger on Linux, such as
    // `ARGUMENT_PAGES` doubled.
    #[test]
    fn an_environment_entry_past_the_per_value_bound_does_not_start() {
        let limits = read_environment_value_limits().expect("the limits read");
        // The entry is the name, `=`, the value and the NUL.
        let value_at_bound = "a".repeat(limits.per_value - PROBE_NAME.len() - 2);

        let refusal = Command::new("/usr/bin/true")
            .env_clear()
            .env(PROBE_NAME, format!("{value_at_bound}a"))
            .status()
            .expect_err("the program does not start");
        assert_eq!(refusal.kind(), ErrorKind::ArgumentListTooLong);

        let start_carries = "/usr/bin/true".len() + 1 + 2 * size_of::<usize>();
        let is_room_left = limits
            .total
            .is_none_or(|total| limits.per_value + start_carries <= total);
        if cfg!(target_os = "linux") && is_room_left {
            let status = Command::new("/usr/bin/true")
                .env_clear()
                .env(PROBE_NAME, value_at_bound)
                .status()
                .expect("the program starts");
            assert!(status.success());
        }
    }

    // Entries each under the per-value bound, together past the total, never start. Fails when
    // Linux's `total` reads smaller than `read_argument_space` does; one read larger passes, since
    // the start's own path and pointers make a start that fills the total exactly untestable.
    #[cfg(target_os = "linux")]
    #[test]
    fn an_environment_past_the_total_does_not_start() {
        let limits = read_environment_value_limits().expect("the limits read");
        let total = limits.total.expect("Linux sets a total");
        let value = "a".repeat(limits.per_value / 2);
        // The shortest entry: the name, `_`, one digit, `=`, the value and the NUL.
        let entry_bytes = PROBE_NAME.len() + 4 + value.len();

        let refusal = Command::new("/usr/bin/true")
            .env_clear()
            .envs((0..=total / entry_bytes).map(|index| (format!("{PROBE_NAME}_{index}"), &value)))
            .status()
            .expect_err("the program does not start");
        assert_eq!(refusal.kind(), ErrorKind::ArgumentListTooLong);
    }

    // Fails when the path is read from anything but the open descriptor, or cut at its end, and
    // when a descriptor that names no file, as a pipe's, reads back as a path, as Linux's name for
    // it (`pipe:[<inode>]`) would.
    #[test]
    fn a_descriptor_path_reads_an_open_file_and_refuses_a_pipe() {
        let folder = tempfile::tempdir().expect("a scratch folder");
        let path = folder.path().join("standard output");
        let file = File::create(&path).expect("the file is made");
        let read = read_descriptor_path(&file).expect("the path reads");
        assert_eq!(read, real_path(&path).expect("the file's real path"));

        let (reader, _writer) = std::io::pipe().expect("a pipe is made");
        assert!(read_descriptor_path(&reader).is_err());
    }
}
