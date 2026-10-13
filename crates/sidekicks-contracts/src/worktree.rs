//! Worktrees: setup, lifecycle, copy progress, the kept copies and events.

use crate::typescript::TypeScriptModule;

pub mod copy_progress;
pub mod events;
pub mod lifecycle;
pub mod removed;
pub mod setup;

/// The topic's TypeScript modules.
pub(crate) const TYPESCRIPT_MODULES: &[&TypeScriptModule] = &[
    &copy_progress::TYPESCRIPT_MODULE,
    &events::TYPESCRIPT_MODULE,
    &lifecycle::TYPESCRIPT_MODULE,
    &removed::TYPESCRIPT_MODULE,
    &setup::TYPESCRIPT_MODULE,
];
