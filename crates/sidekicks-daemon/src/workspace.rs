//! Workspaces: projects, repositories, clones, the managed write watch and their events.

pub(crate) mod clone;
pub(crate) mod errors;
pub(crate) mod event_emitter;
pub(crate) mod folder;
pub(crate) mod last_error;
pub(crate) mod managed;
pub(crate) mod project;
pub(crate) mod projector;
pub(crate) mod repo;
pub(crate) mod row_guards;
pub(crate) mod schema;
#[cfg(test)]
pub(crate) mod test_rows;
pub(crate) mod trust_envelope;
