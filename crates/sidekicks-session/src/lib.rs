//! Sessions: creating, changing, naming, converting and searching them, reading a session's record
//! and log, their groups, tags, drafts, staged files, review notes, inbox addresses and directory;
//! the run engine, a session's runs, its agents and its agent tree, and its limits; the
//! transcript; questions, interventions and attention; the queue's store; the checkpoints an undo
//! puts files back from; what the daemon keeps while sessions talk to each other; the driver a run
//! or session resolves to; the live sessions' folders; and deleting the provider conversations a
//! session ran on. It sits over std, store, ipc, workspace, provider and mcp and is taken by
//! approval, queue, artifact, recovery and the program.

pub mod addresses;
pub mod agent_tree;
pub mod agents;
pub mod attention;
pub mod auto_title;
pub mod budget;
pub mod changes;
pub mod checkpoints;
pub mod console_state;
pub mod conversations;
pub mod convert;
pub mod create;
pub mod directory;
pub mod draft_store;
pub mod driver_resolution;
pub(crate) mod follower_wakes;
pub mod groups;
pub mod idle_sleep;
pub mod interventions;
pub mod links;
pub mod live_folders;
pub mod messaging;
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

/// `text` as an instant, for tests that spell their instants out. Panics on text no instant holds.
#[cfg(test)]
pub(crate) fn instant(text: &str) -> sidekicks_contracts::wire::instant::WireInstant {
    sidekicks_contracts::wire::instant::WireInstant::try_from(text.to_owned())
        .expect("a test instant")
}
