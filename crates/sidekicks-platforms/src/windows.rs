//! The Windows side of the interface.

pub(crate) mod disk;
pub(crate) mod error_codes;
pub(crate) mod login_shell;
pub(crate) mod machine_name;
#[cfg(any(test, feature = "test-support"))]
pub(crate) mod measurement;
pub(crate) mod private_folder;
pub(crate) mod real_path;
pub(crate) mod shell_start;
pub(crate) mod terminal;
