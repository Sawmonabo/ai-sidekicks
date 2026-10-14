//! What the socket's tests share: a call's params with one rule, a call's empty params, and the
//! context the gateway stamps on a call.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sidekicks_contracts::trust_statement::DeviceId;
use tokio_util::sync::CancellationToken;

use crate::ipc::registry::{HandlerContext, TransportId};

/// Params, a result or an emission whose one member holds at most four characters.
#[derive(Debug, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Named {
    /// The member the rule holds.
    #[garde(length(max = 4))]
    pub(crate) name: String,
}

/// Params or a result with no member.
#[derive(Debug, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(deny_unknown_fields)]
pub(crate) struct Nothing {}

/// The context of a call on connection `transport`, from a caller the system could not name,
/// recorded as no mutating call.
pub(crate) fn context(transport: u64) -> HandlerContext {
    HandlerContext {
        transport_id: TransportId(transport),
        device_id: DeviceId::new("device".to_owned()).expect("the id is well formed"),
        caller_process_id: None,
        cancellation: CancellationToken::new(),
        recorded_call: None,
    }
}
