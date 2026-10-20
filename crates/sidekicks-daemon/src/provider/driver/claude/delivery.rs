//! What the Claude Code driver reads out of a process's deliveries: a call's ask, the rows of its
//! message frames, the blocks it streams and a file change's patch.

mod ask_action;
mod messages;
mod patches;
mod streamed_blocks;
