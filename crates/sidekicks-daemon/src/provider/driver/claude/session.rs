//! What the Claude Code driver keeps per session: Claude Code's own settings, plan and conversation
//! files, the standing rules it keeps, the posture its process was started with, the transport to
//! that process and the errors a session raises.

mod conversation_file;
pub(crate) mod errors;
mod plan_files;
mod posture;
mod reply_reserve;
mod rules;
mod settings_file;
pub(crate) mod transport;
