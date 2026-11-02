//! Questions: the record of each question an agent, a tool server or a workflow step asks the
//! person, its turn when its run waits on something else, its answer, its cancellation, the queued
//! messages that answer one its agent does not wait for, and the answer kept while no provider
//! request held its question.

pub(crate) mod answer_text;
pub mod kept_answers;
pub mod projection;
pub(crate) mod resolve;
pub(crate) mod run_end;
pub mod schema;
pub mod service;
pub(crate) mod store;
pub(crate) mod waiting_for_run;
pub(crate) mod waits;
