//! The daemon's Claude Code hooks: their registration in `initialize`, and the answers they give,
//! the helper limit, pauses and the words waiting for a helper.

pub(super) mod callbacks;
pub(super) mod helper_limit;
pub(super) mod helper_steers;
pub(super) mod helper_token_limit;
pub(super) mod pause;
pub(super) mod registration;
