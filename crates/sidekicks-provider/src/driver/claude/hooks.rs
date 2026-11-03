//! The daemon's Claude Code hooks: their registration in `initialize`, and the answers they give,
//! the helper limit, the helpers stopped alone, pauses, the renewal of a held helper's call and the
//! words waiting for a helper.

pub(super) mod callbacks;
pub(super) mod helper_limit;
pub(super) mod helper_steers;
pub(super) mod hold_renewal;
pub(super) mod pause;
pub(super) mod registration;
pub(super) mod stopped_helpers;
