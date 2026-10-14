//! The local socket: the gateway, method handlers, protocol negotiation and the errors each method
//! sends.

pub(crate) mod caller_process;
pub(crate) mod domain_error;
pub(crate) mod in_flight_mutations;
pub(crate) mod jsonrpc_error_mapping;
pub(crate) mod protocol_negotiation;
pub(crate) mod registry;
pub(crate) mod stream;
