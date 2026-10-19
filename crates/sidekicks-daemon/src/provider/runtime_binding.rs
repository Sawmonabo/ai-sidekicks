//! Runtime bindings, each run's legs on its provider: the durable store, the resume recovery
//! rebuilds from a stored binding, and the live binding a run-addressed call names.

pub(crate) mod live_runs;
pub(crate) mod resume;
pub(crate) mod store;
#[cfg(test)]
pub(crate) mod test_store;
