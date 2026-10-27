//! Artifacts and plans: publishing, ingesting and storing what a run produces, with each payload's
//! media type read from its leading bytes and a picture's size from its header, and the record of
//! each plan an agent finished. It sits over std, store, ipc, workspace, provider and session,
//! and below recovery and the program.

pub mod admission;
pub mod attachment_resolver;
pub mod chat_file_versions;
pub(crate) mod detection;
pub(crate) mod id;
pub mod ingest;
pub mod list;
pub(crate) mod manifest_write;
pub mod payload_store;
pub(crate) mod picture_size;
pub mod plans;
pub mod publish;
pub mod read;
pub(crate) mod refusals;
pub mod schema;
#[cfg(any(test, feature = "test-support"))]
pub mod test_store;
pub mod validation;
