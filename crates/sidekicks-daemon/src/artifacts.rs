//! Artifacts: publishing, ingesting and storing what a run produces, with each payload's media
//! type read from its leading bytes and a picture's size from its header.

pub(crate) mod admission;
pub(crate) mod attachment_resolver;
pub(crate) mod chat_file_versions;
pub(crate) mod detection;
pub(crate) mod id;
pub(crate) mod ingest;
pub(crate) mod list;
pub(crate) mod manifest_write;
pub(crate) mod payload_store;
pub(crate) mod picture_size;
pub(crate) mod publish;
pub(crate) mod read;
pub(crate) mod refusals;
pub(crate) mod schema;
#[cfg(test)]
pub(crate) mod test_store;
pub(crate) mod validation;
