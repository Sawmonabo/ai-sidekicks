//! Artifact methods served on the socket: a payload published whole, a file streamed in, a
//! session's list and one artifact's read.

pub(crate) mod ingest;
pub(crate) mod list;
pub(crate) mod publish;
pub(crate) mod read;
