//! The memory page size macOS and Linux both count their memory figures in.

use std::io;

use nix::unistd::SysconfVar;

/// The system's page size in bytes, `sysconf(_SC_PAGESIZE)`. Fails with the system's error when
/// the read fails, and with `Other` when the system reports none.
pub(crate) fn page_bytes() -> io::Result<u64> {
    let page_bytes = nix::unistd::sysconf(SysconfVar::PAGE_SIZE)?
        .ok_or_else(|| io::Error::other("the system reports no page size"))?;
    u64::try_from(page_bytes).map_err(io::Error::other)
}
