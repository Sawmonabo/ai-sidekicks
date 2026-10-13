//! Session search: the Tantivy index the daemon links, and the one fuzzy matcher, which the
//! renderer also runs as a WebAssembly build without the index.

#[cfg(feature = "index")]
pub mod index;
pub mod ranking;
