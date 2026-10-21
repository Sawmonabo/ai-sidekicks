//! What the Claude Code driver reads out of a process's deliveries: a call's ask, the rows of its
//! message frames, the blocks it streams, a file change's patch and the choices it holds a run on.

mod ask_action;
mod dialogs;
mod messages;
mod patches;
mod streamed_blocks;
