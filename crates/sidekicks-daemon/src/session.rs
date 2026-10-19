//! Sessions: creating, converting and searching them, reading a session's record and log, their
//! groups, tags, drafts, staged files, inbox addresses, directory and working folder.

pub(crate) mod addresses;
pub(crate) mod changes;
pub(crate) mod changes;
pub(crate) mod console_state;
pub(crate) mod directory;
pub(crate) mod draft_store;
pub(crate) mod groups;
pub(crate) mod links;
pub(crate) mod not_found;
pub(crate) mod permission_level;
pub(crate) mod projector;
pub(crate) mod records;
pub(crate) mod related;
pub(crate) mod review_note;
pub(crate) mod run;
pub(crate) mod search;
pub(crate) mod service;
pub mod spawn_cwd_translator;
pub(crate) mod staged_attachments;
pub(crate) mod tags;
pub(crate) mod working_folder;
