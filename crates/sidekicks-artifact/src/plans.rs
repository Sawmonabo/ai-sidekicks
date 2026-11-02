//! Plans: the record of each plan an agent finished, its artifact, its state word, the end of a
//! provider request held for its verdict, and the verdict that settles it.

pub mod projection;
pub(crate) mod record;
pub mod schema;
pub mod service;
pub mod store;
pub mod verdict;
