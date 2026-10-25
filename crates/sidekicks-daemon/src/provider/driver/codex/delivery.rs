//! What the Codex driver delivers to and reads back from a conversation's items and asks: each
//! frame's rows, moves and notices, the reviewer's flags and blocks, the helpers' child runs, and
//! what a session's deliveries remember between frames.

mod ask_action;
pub(super) mod asks;
mod children;
pub(super) mod elicitation_form;
mod failure_cause;
pub(super) mod frames;
pub(super) mod memory;
mod notices;
mod patches;
pub(super) mod question_answers;
mod reviewer;
pub(super) mod rows;
