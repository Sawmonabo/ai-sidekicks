//! Orchestration: the move of a provider's running sessions onto the account made its current one,
//! the acceptance of a switch of one agent's provider binding, what both switches settle with, the
//! setting and clearing of a session's goal, a workflow's form and reply waits asked and answered
//! as the session's questions, and a workflow's approval waits raised and answered as approval
//! cards.

pub(crate) mod account_switch;
pub(crate) mod binding_switch;
pub(crate) mod goal_service;
pub(crate) mod provider_switch;
pub(crate) mod workflow_gate_cards;
pub(crate) mod workflow_wait_questions;
