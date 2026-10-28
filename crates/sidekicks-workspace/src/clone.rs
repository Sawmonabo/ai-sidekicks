//! Cloning a repository into a managed project folder: where the clone lands, git run with its
//! progress streamed and its stop, git's progress lines, the large-file settings, and the askpass
//! broker that brings git's questions to the clone's owner.

pub mod askpass;
pub(crate) mod destination;
pub(crate) mod large_files;
pub(crate) mod progress;
pub(crate) mod streamed_git;
