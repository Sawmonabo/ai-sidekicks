//! A session's transcript as the store reads it back: a row the provider sent in pieces joined
//! into one, and a file change's whole patch stored in parts.

pub mod rejoin;
pub mod whole_patch;
