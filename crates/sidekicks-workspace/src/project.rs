//! Projects: their records and the service that writes them, the live list the Projects page
//! streams, the refusals a project's saved rows and pattern meet, and the slug that names each
//! one's worktrees folder.

pub mod list_feed;
pub mod records;
pub mod refusals;
pub mod service;
pub(crate) mod slug;
#[cfg(any(test, feature = "test-support"))]
pub mod test_doubles;
