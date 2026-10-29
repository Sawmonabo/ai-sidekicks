//! The local socket's server side without its handlers: the method registry and its dispatch,
//! protocol negotiation, the record of mutating calls in flight, the caller's process, the
//! presence register of the devices connected, subscriptions' streams, the domain error and the
//! refusals each method sends, and the redaction of what leaves the daemon. It sits over std and
//! store and is taken by workspace, workflow, provider, shell, session, approval, queue, artifact,
//! recovery and the program.

#[cfg(any(test, feature = "test-support"))]
pub mod call_fixtures;
pub mod caller_process;
pub mod domain_error;
pub mod in_flight_mutations;
pub mod jsonrpc_error_mapping;
pub mod presence;
pub mod protocol_negotiation;
pub mod redaction;
pub mod registry;
pub mod session_not_found;
pub mod stream;
pub mod workflow_run_not_found;
