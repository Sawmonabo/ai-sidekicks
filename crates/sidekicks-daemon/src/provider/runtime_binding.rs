//! Runtime bindings, each run's legs on its provider: the durable store, the resume recovery
//! rebuilds from a stored binding, the live binding a run-addressed call names, and the rebind a
//! driver writes when it moves a session onto another conversation.

pub(crate) mod live_runs;
pub(crate) mod rebinder;
pub(crate) mod resume;
pub(crate) mod store;
#[cfg(test)]
pub(crate) mod test_store;
