//! A session's checkpoints: what each of its turns captured and copied, enough to put a checkout
//! back to a point. Every byte sits in files under the owner's capture folder; these tables hold
//! only names, hashes and paths. The copies themselves sit in one folder, each named for its
//! content's hash, and a file over 10 MiB is shadowed by a clone compared at each capture, in the
//! session's own folder on the file's volume when that is another volume.

pub mod command_windows;
pub mod copies;
pub mod edits;
pub mod resends;
pub mod restore_cuts;
pub mod schema;
pub mod shadows;
pub mod store;
pub mod sweep;
pub mod volume_folders;
