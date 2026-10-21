//! What the Claude Code driver keeps per session: its slot, its process and what it writes, Claude
//! Code's own settings, plan and conversation files, the standing rules and permission level it
//! keeps, the posture its process was started with, the transport to that process and its pending
//! control requests, its in-process tool-server calls, the commands the daemon answers itself, the
//! figures read once per build, the settings Claude Code ignores, the purge of its conversations,
//! and the errors a session raises.

pub(super) mod answered_commands;
pub(super) mod arrivals;
mod control_requests;
mod conversation_file;
pub(crate) mod errors;
pub(super) mod frame_observation;
pub(super) mod ignored_settings;
pub(super) mod model_figures;
pub(super) mod permission_level;
pub(super) mod permissions;
mod plan_files;
pub(super) mod posture;
pub(super) mod process;
pub(super) mod purge;
pub(super) mod reply_reserve;
pub(super) mod rules;
pub(super) mod settings_file;
pub(super) mod slots;
pub(super) mod state;
pub(super) mod tool_server_calls;
pub(crate) mod transport;
