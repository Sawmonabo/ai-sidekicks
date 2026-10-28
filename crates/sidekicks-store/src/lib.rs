//! Where the daemon keeps its data: the database and its one writer, the session event log and its
//! projections, the record of damage to the database file, the credential store, the data folder
//! and its hold, the machine's own record, the backup mirror, and the codecs that read a transcript
//! row back whole. It sits over std and is taken by ipc, workspace, workflow, provider, mcp,
//! session, approval, queue, artifact, recovery and the program.

pub mod backup_mirror;
pub mod credential_store;
pub mod data_folder;
pub mod database;
pub mod events;
pub mod machine;
pub mod transcript;
