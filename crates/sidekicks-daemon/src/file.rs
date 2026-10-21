//! Files: the crash-safe write, publishing without replacing, a read held to a ceiling, a copy to
//! a new path, and where a file is really reached.

pub mod atomic_write;
pub(crate) mod bounded_read;
pub(crate) mod clone_or_copy;
pub(crate) mod publish_without_replacing;
pub(crate) mod real_location;
