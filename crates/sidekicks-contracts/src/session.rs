//! Sessions: ids, names, directory, drafts, events and cursors, groups, tags, search, cost,
//! controls, goals, restore and recovery.

use crate::typescript::TypeScriptModule;

pub mod controls;
pub mod convert;
pub mod cost;
pub mod directory;
pub mod draft;
pub mod event_cursor;
pub mod events;
pub mod goal;
pub mod groups;
pub mod id;
pub mod inspector;
pub mod links;
pub mod methods;
pub mod name;
pub mod recovery;
pub mod restore;
pub mod search;
pub mod tags;

/// The topic's TypeScript modules, its folders' among them.
pub(crate) const TYPESCRIPT_MODULES: &[&TypeScriptModule] = &[
    &controls::events::TYPESCRIPT_MODULE,
    &controls::methods::TYPESCRIPT_MODULE,
    &convert::TYPESCRIPT_MODULE,
    &cost::TYPESCRIPT_MODULE,
    &directory::TYPESCRIPT_MODULE,
    &draft::TYPESCRIPT_MODULE,
    &events::TYPESCRIPT_MODULE,
    &goal::TYPESCRIPT_MODULE,
    &groups::TYPESCRIPT_MODULE,
    &id::TYPESCRIPT_MODULE,
    &inspector::TYPESCRIPT_MODULE,
    &links::TYPESCRIPT_MODULE,
    &methods::TYPESCRIPT_MODULE,
    &recovery::TYPESCRIPT_MODULE,
    &restore::TYPESCRIPT_MODULE,
    &tags::TYPESCRIPT_MODULE,
];
