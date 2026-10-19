//! One Codex app-server service: its command line, its process and the record a later daemon
//! finds it again from, the short commands run beside it, its config warnings, its thread index
//! and the trust of the terminal service's hooks.

mod command;
mod command_line;
mod config_warnings;
mod process;
mod record;
mod threads;
mod trust;
