//! Files: the crash-safe write, publishing without replacing, a read held to a ceiling, a copy to
//! a new path, and where a file is really reached.

pub mod atomic_write;
pub mod bounded_read;
pub mod clone_or_copy;
pub(crate) mod publish_without_replacing;
pub mod real_location;
