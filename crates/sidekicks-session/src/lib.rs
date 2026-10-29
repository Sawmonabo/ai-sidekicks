//! Sessions: creating, changing, naming, converting and searching them, reading a session's record
//! and log, their groups, tags, drafts, staged files, review notes, inbox addresses and directory;
//! the run engine and a session's runs; the transcript; questions, interventions and attention; the
//! queue's store; the driver a run or session resolves to; the live sessions' folders; and
//! deleting the provider conversations a session ran on. It sits over std, store, ipc,
//! workspace, provider and mcp and is taken by approval, queue, artifact, recovery and the program.

pub mod addresses;
pub(crate) mod attention;
pub mod auto_title;
pub mod changes;
pub mod console_state;
pub mod conversation_purge;
pub mod convert;
pub mod create;
pub mod directory;
pub mod draft_store;
pub mod driver_resolution;
pub mod groups;
pub mod idle_sleep;
pub mod interventions;
pub mod links;
pub mod live_folders;
pub mod permission_level;
pub mod plan_holds;
pub(crate) mod projector;
pub mod questions;
pub mod queue_store;
pub mod readings;
pub(crate) mod records;
pub(crate) mod refusals;
pub mod related;
pub mod review_note;
pub mod run;
pub mod search;
pub mod service;
pub mod staged_attachments;
pub mod tags;
pub mod transcript;
pub mod usage_record;
pub mod working_folder;
