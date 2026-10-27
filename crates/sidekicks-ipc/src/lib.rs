//! The local socket's server side without its handlers: the method registry and its dispatch,
//! protocol negotiation, the record of mutating calls in flight, the caller's process,
//! subscriptions' streams, the domain error and the refusals each method sends, and the redaction
//! of what leaves the daemon. It sits over store and below workspace, policy and workflow.

#[cfg(any(test, feature = "test-support"))]
pub mod call_fixtures;
pub mod caller_process;
pub mod domain_error;
pub mod in_flight_mutations;
pub mod jsonrpc_error_mapping;
pub mod protocol_negotiation;
pub mod redaction;
pub mod registry;
pub mod session_not_found;
pub mod stream;
