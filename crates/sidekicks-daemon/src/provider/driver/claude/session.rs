//! What the Claude Code driver keeps per session: Claude Code's own settings, plan and conversation
//! files, the standing rules it keeps, the posture its process was started with, the transport to
//! that process and its pending control requests, the commands the daemon answers itself, the
//! figures read once per build, and the errors a session raises.

mod answered_commands;
mod control_requests;
mod conversation_file;
pub(crate) mod errors;
pub(super) mod model_figures;
mod plan_files;
mod posture;
mod reply_reserve;
pub(super) mod rules;
mod settings_file;
pub(crate) mod transport;
