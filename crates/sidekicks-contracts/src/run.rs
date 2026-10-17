//! Runs: ids, state, the queue, control, interventions, events, children, subagents and failure
//! causes.

use crate::typescript::TypeScriptModule;

pub mod children;
pub mod control;
pub mod events;
pub mod failure_cause;
pub mod id;
pub mod intervention;
pub mod provider_choice;
pub mod queue;
pub mod queued;
pub mod state;
pub mod subagent;

/// The topic's TypeScript modules.
pub(crate) const TYPESCRIPT_MODULES: &[&TypeScriptModule] = &[
    &children::TYPESCRIPT_MODULE,
    &control::TYPESCRIPT_MODULE,
    &events::TYPESCRIPT_MODULE,
    &failure_cause::TYPESCRIPT_MODULE,
    &id::TYPESCRIPT_MODULE,
    &intervention::TYPESCRIPT_MODULE,
    &provider_choice::TYPESCRIPT_MODULE,
    &queue::TYPESCRIPT_MODULE,
    &queued::TYPESCRIPT_MODULE,
    &state::TYPESCRIPT_MODULE,
    &subagent::TYPESCRIPT_MODULE,
];
