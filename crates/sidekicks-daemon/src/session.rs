//! Sessions: creating, changing, naming, converting and searching them, reading a session's record
//! and log, their groups, tags, drafts, staged files, review notes, inbox addresses, directory and
//! working folder, and deleting the provider conversations a session ran on.

pub(crate) mod addresses;
pub(crate) mod auto_title;
pub(crate) mod changes;
pub(crate) mod console_state;
pub(crate) mod conversation_purge;
pub mod directory;
pub(crate) mod draft_store;
pub(crate) mod groups;
pub(crate) mod links;
pub(crate) mod permission_level;
pub(crate) mod plan_holds;
pub(crate) mod projector;
pub(crate) mod records;
pub(crate) mod related;
pub(crate) mod review_note;
pub(crate) mod run;
pub mod search;
pub(crate) mod service;
pub mod spawn_cwd_translator;
pub(crate) mod staged_attachments;
pub(crate) mod tags;
pub(crate) mod working_folder;
