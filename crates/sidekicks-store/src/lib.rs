//! Where the daemon keeps its data: the database and its one writer, the session event log and its
//! projections, the record of damage to the database file, the credential store, the data folder
//! and its hold, the machine's own record, the backup mirror, and the codecs that read a transcript
//! row back whole.

pub mod backup_mirror;
pub mod credential_store;
pub mod data_folder;
pub mod data_folder_lock;
pub mod database;
pub mod events;
pub mod machine;
pub mod transcript_rejoin;
pub mod transcript_whole_patch;
