//! The workflow secrets: their values, held in a keychain under each secret's id, and the
//! resolution at a step's launch of the references its sensitive parameters store. The daemon's
//! table records a secret's place and name; a value leaves the daemon only into the step that
//! resolves it.

pub mod resolution;
pub mod store;
