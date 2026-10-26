//! Workflow definitions: the document, the items data travels in, its handle, the refusals a save
//! answers with and the parameter check, the definition methods, the builder's settings, drafts and
//! webhook, the versions, and the events a workflow appends before any run exists.

pub mod builder;
#[cfg(feature = "workflow-check-wasm")]
pub mod check;
pub mod document;
pub mod events;
pub mod handle;
pub mod item;
pub mod methods;
pub mod params;
pub mod refusals;
pub mod versions;
