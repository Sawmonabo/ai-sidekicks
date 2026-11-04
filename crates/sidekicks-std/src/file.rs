//! Files: the crash-safe write and removal, publishing without replacing, a read held to a ceiling,
//! a copy to a new path, a copy that hashes as it goes, an open file's clone to a new path, where a
//! file is really reached, the precision of the times a folder keeps, and the recursive copy of a
//! tree.

pub mod atomic_write;
pub mod bounded_read;
pub mod clone_open_file;
pub mod clone_or_copy;
pub mod hashing_copy;
pub mod publish_without_replacing;
pub mod real_location;
pub mod removal_after_failure;
pub mod time_precision;
pub mod tree_copy;
