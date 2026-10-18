//! The local socket: the gateway, the method registry and its dispatch, protocol negotiation, the
//! record of mutating calls in flight, subscriptions' streams and the errors each method sends.

#[cfg(test)]
pub(crate) mod call_fixtures;
pub(crate) mod caller_process;
pub(crate) mod domain_error;
pub(crate) mod handlers;
pub(crate) mod in_flight_mutations;
pub(crate) mod jsonrpc_error_mapping;
pub(crate) mod local_gateway;
pub(crate) mod protocol_negotiation;
pub(crate) mod registry;
pub(crate) mod stream;
