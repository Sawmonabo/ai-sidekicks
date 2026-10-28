//! Cloning a repository into a project: the service that starts a clone under the client's key,
//! keeps each clone's card and pulls a clone's large files; the cards; the git runs they follow;
//! the start's key records; where the clone lands, git run with its progress streamed and its
//! stop, git's progress lines, the large-file settings, and the askpass broker that brings git's
//! questions to the clone's card.

pub mod askpass;
pub(crate) mod card;
pub(crate) mod destination;
pub(crate) mod large_files;
pub(crate) mod progress;
pub mod requests;
pub(crate) mod run;
pub mod service;
pub(crate) mod streamed_git;
