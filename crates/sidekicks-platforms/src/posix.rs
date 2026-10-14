//! What macOS and Linux share behind the interface; what one of them alone does is in its own
//! module.

pub(crate) mod disk;
pub(crate) mod error_codes;
pub(crate) mod login_shell;
pub(crate) mod private_folder;
pub(crate) mod real_path;
pub(crate) mod shell_start;
pub(crate) mod terminal;
