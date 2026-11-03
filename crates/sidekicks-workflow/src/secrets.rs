//! The workflow secrets: their values, held in a keychain under each secret's id, the resolution
//! at a step's launch of the references its sensitive parameters store, and the redaction of a
//! run's resolved values from what it records. The daemon's table records a secret's place and
//! name; a value leaves the daemon only into the step that resolves it.

pub mod redaction;
pub mod resolution;
pub mod store;
