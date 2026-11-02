//! The acts on what the service keeps: the export into a folder the person picks, the erase of it
//! all, the whole-session purge, the moves of the daemon's own secrets, and what the modes that act
//! with the service stopped share.

pub(crate) mod erase;
pub(crate) mod export;
pub(crate) mod mode_outcome;
pub(crate) mod purge;
pub(crate) mod secrets_move;
