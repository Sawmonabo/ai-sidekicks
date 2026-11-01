//! Hand-over: carrying a conversation to another provider, account or session. The canonical
//! transcript folds a run's logged events into ordered turns, rebuilt from the session log on every
//! call; the session transcript hands every run's turns on as it reads them; the transform pipeline
//! makes them portable; the brief renders them as bounded prose and sends it once into the new
//! session.

pub(crate) mod brief;
pub mod canonical_transcript;
pub mod session_transcript;
pub(crate) mod transform_pipeline;
