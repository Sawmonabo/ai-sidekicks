//! The space macOS and Linux give a program's start for its arguments and environment together.

use std::io;

use nix::unistd::SysconfVar;

/// The bytes a program's start may carry in arguments and environment together, as
/// `sysconf(_SC_ARG_MAX)` reports it. Fails with the system's error when the read fails, and with
/// `Other` when the system sets no limit or one past `usize`.
pub(crate) fn read_argument_space() -> io::Result<usize> {
    let limit = nix::unistd::sysconf(SysconfVar::ARG_MAX)?
        .ok_or_else(|| io::Error::other("the system sets no limit on a program's arguments"))?;
    usize::try_from(limit).map_err(io::Error::other)
}
