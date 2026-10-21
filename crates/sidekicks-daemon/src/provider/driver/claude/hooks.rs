//! The daemon's Claude Code hooks: their registration in `initialize`, and the answers they give,
//! the helper limit and pauses.

pub(super) mod callbacks;
mod helper_limit;
mod pause;
pub(super) mod registration;
