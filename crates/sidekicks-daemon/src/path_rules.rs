//! Path rules: how each operating system spells and compares a path, on POSIX and Windows paths
//! alike, whatever the host.

pub(crate) mod contract;
mod posix;
mod windows;
