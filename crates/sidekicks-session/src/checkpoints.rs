//! A session's checkpoints: what each of its turns captured and copied, enough to put a checkout
//! back to a point. Every byte sits in files under the owner's capture folder; these tables hold
//! only names, hashes and paths. The copies themselves sit in one folder, each named for its
//! content's hash, and a file over 10 MiB is shadowed by a clone compared at each capture.

pub mod command_windows;
pub mod copies;
pub mod schema;
pub mod shadows;
pub mod store;
