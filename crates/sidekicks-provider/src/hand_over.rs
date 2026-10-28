//! Hand-over: carrying a conversation to another provider or account. The canonical transcript
//! folds one run's logged events into ordered turns, rebuilt from the session log on every call;
//! the transform pipeline makes them portable; the brief renders them as bounded prose and sends it
//! once into the new session.

pub(crate) mod brief;
pub(crate) mod canonical_transcript;
pub(crate) mod transform_pipeline;
