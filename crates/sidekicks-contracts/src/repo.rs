//! Repositories: cloning, folders, mounts, workspaces and the git reads.

use crate::typescript::TypeScriptModule;

pub mod clone;
pub mod folders;
pub mod git_reads;
pub mod methods;
pub mod mount;
pub mod workspace;

/// The topic's TypeScript modules.
pub(crate) const TYPESCRIPT_MODULES: &[&TypeScriptModule] = &[
    &clone::TYPESCRIPT_MODULE,
    &folders::TYPESCRIPT_MODULE,
    &git_reads::TYPESCRIPT_MODULE,
    &methods::TYPESCRIPT_MODULE,
    &mount::TYPESCRIPT_MODULE,
    &workspace::TYPESCRIPT_MODULE,
];
