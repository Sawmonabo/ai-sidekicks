//! Runtime bindings, each run's legs on its provider: the durable store, the resume recovery
//! rebuilds from a stored binding, and the rebind a driver writes when it moves a session onto
//! another conversation.

pub mod resume;
pub mod store;
#[cfg(any(test, feature = "test-support"))]
pub mod test_store;
pub(crate) mod writer;
