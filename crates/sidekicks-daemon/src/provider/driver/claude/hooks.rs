//! The daemon's Claude Code hooks: their registration in `initialize`, and the answers they give,
//! the helper limit and pauses.

pub(super) mod callbacks;
mod helper_limit;
pub(super) mod pause;
pub(super) mod registration;
