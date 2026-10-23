//! What the Claude Code driver reads out of a process's deliveries and delivers to the run engine:
//! a call's ask, the rows of its message frames, the blocks it streams, a file change's patch, the
//! choices it holds a run on, the system frames, a turn's end, the requests it holds a run on, the
//! reviewer's blocks, and the stream that turns each frame into the run engine's deliveries in
//! order.

mod ask_action;
pub(super) mod dialogs;
pub(super) mod messages;
mod patches;
pub(super) mod requests;
pub(super) mod reviewer;
pub(super) mod run_engine;
pub(super) mod run_readings;
pub(super) mod stream;
mod streamed_blocks;
pub(super) mod system;
mod turn_end;
