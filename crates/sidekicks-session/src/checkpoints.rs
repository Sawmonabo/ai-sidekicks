//! A session's checkpoints: what each of its turns captured and copied, enough to put a checkout
//! back to a point. Every byte sits in files under the owner's capture folder; these tables hold
//! only names, hashes and paths.

pub mod schema;
pub mod store;
