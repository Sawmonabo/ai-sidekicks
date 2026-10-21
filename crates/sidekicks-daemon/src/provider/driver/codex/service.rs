//! The Codex app-server services: one per credential home in the registry, each run by its
//! supervisor, with its command line, its process and the record a later daemon finds it again
//! from, Codex's start lock and managed daemon, the home's socket link, the short commands run
//! beside it, its config warnings, its thread index, its asks and the trust of the terminal
//! service's hooks.

pub(super) mod asks;
mod command;
mod command_line;
mod config_warnings;
pub(super) mod home;
mod managed_daemon;
mod process;
mod record;
pub(super) mod registry;
mod socket_link;
mod start_lock;
pub(super) mod supervisor;
pub(super) mod threads;
mod trust;
