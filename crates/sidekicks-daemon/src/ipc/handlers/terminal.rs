//! The `terminal.*` methods served here: `terminal.write`, admitted in its step before any wait so
//! a connection's writes reach the shell in the order they came.

use std::sync::Arc;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::method::Method;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::terminal::{TerminalId, TerminalWrite, TerminalWriteRequest};

use crate::ipc::registry::{
    HandlerContext, HandlerError, MethodRegistryBuilder, RegistrationError,
};
use crate::pty::control_lease::{ShellConnection, ShellLeaseCaller};
use crate::pty::shell::paste::ShellPastePart;
use crate::pty::shell::write::{AdmittedShellWrite, ShellInput, ShellWriteInput};

/// Finds the input of a session's shell at once, or answers the refusal of a write naming no shell,
/// which may wait on a read: `session.notFound` for a session this daemon does not hold and
/// `terminal.notFound` for a shell the session does not have.
pub(crate) type ShellInputLookup = Arc<
    dyn Fn(&SessionId, &TerminalId) -> Result<Arc<ShellInput>, BoxFuture<'static, HandlerError>>
        + Send
        + Sync,
>;

/// A write's step before any wait: admitted on its shell, or refused once its refusal is read.
enum WriteStep {
    Admitted(AdmittedShellWrite),
    Refused(BoxFuture<'static, HandlerError>),
}

/// Registers `terminal.write`, finding each write's shell through `lookup`; a write naming no shell
/// is answered its refusal without holding the writes after it.
pub(crate) fn register_terminal_write(
    registry: &mut MethodRegistryBuilder,
    lookup: ShellInputLookup,
) -> Result<(), RegistrationError> {
    registry.register_ordered::<TerminalWrite, _, _, _>(
        move |context: &HandlerContext, request: &TerminalWriteRequest| {
            admit_write(&lookup, context, request)
        },
        |step: WriteStep| match step {
            WriteStep::Admitted(admitted) => admitted.answered().boxed(),
            WriteStep::Refused(refusal) => async move { Err(refusal.await) }.boxed(),
        },
    )
}

/// The write's step before any wait: finds its shell and admits it there.
fn admit_write(
    lookup: &ShellInputLookup,
    context: &HandlerContext,
    request: &TerminalWriteRequest,
) -> Result<WriteStep, HandlerError> {
    let (session_id, terminal_id, output_subscription_id, input) = match request {
        TerminalWriteRequest::Keys {
            session_id,
            terminal_id,
            output_subscription_id,
            data,
        } => (
            session_id,
            terminal_id,
            *output_subscription_id,
            ShellWriteInput::Keys(data.clone()),
        ),
        TerminalWriteRequest::Paste {
            session_id,
            terminal_id,
            output_subscription_id,
            data,
            paste_id,
            is_last_part,
        } => (
            session_id,
            terminal_id,
            *output_subscription_id,
            ShellWriteInput::Paste(ShellPastePart {
                paste_id: paste_id.clone(),
                output_subscription_id: *output_subscription_id,
                data: data.clone(),
                is_last_part: *is_last_part,
            }),
        ),
    };
    let caller = ShellLeaseCaller {
        connection: ShellConnection {
            device_id: context.calling_device(TerminalWrite::DESCRIPTOR.method)?,
            transport_id: context.transport_id,
        },
        output_subscription_id,
    };
    match lookup(session_id, terminal_id) {
        Ok(shell) => Ok(WriteStep::Admitted(shell.admit_write(caller, input)?)),
        Err(refusal) => Ok(WriteStep::Refused(refusal)),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use futures::FutureExt as _;
    use serde_json::json;
    use serde_json::value::RawValue;
    use sidekicks_contracts::jsonrpc::message::JsonRpcId;
    use sidekicks_contracts::jsonrpc::streaming::SubscriptionId;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::terminal::{TERMINAL_WRITES_WAITING_LIMIT, TerminalId};
    use sidekicks_contracts::trust_statement::DeviceId;

    use super::{ShellInputLookup, register_terminal_write};
    use crate::ipc::call_fixtures::context;
    use crate::ipc::jsonrpc_error_mapping::{CallFailure, map_json_rpc_error};
    use crate::ipc::registry::{Dispatch, MethodRegistryBuilder, Request, TransportId};
    use crate::pty::control_lease::{ShellConnection, ShellControlLease, ShellLeaseCaller};
    use crate::pty::shell::refusals::terminal_not_found;
    use crate::pty::shell::write::{QueueTerminalWrite, ShellInput, ShellInputHooks};

    const SESSION: &str = "0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c9d0e";

    /// A shell whose terminal hands each write's take to `queue_write`, its lease broadcasting
    /// every change at once, and that lease.
    fn shell(
        terminal_id: &str,
        queue_write: QueueTerminalWrite,
    ) -> (Arc<ShellInput>, Arc<ShellControlLease>) {
        let terminal_id = TerminalId::new(terminal_id.to_owned()).expect("a terminal id");
        let lease = Arc::new(ShellControlLease::new(
            SessionId::new(SESSION).expect("a session id"),
            terminal_id.clone(),
            DeviceId::new("device-machine".to_owned()).expect("a device id"),
            Arc::new(|_change| async { Ok(()) }.boxed()),
            Arc::new(|_caller: &ShellLeaseCaller| Ok(())),
        ));
        let input = ShellInput::new(
            terminal_id,
            Arc::clone(&lease),
            ShellInputHooks {
                queue_write,
                queue_answer: Box::new(|_answer| {}),
                is_bracketed_paste_requested: Box::new(|| false),
            },
            tokio::runtime::Handle::current(),
        );
        (input, lease)
    }

    /// The pane of connection `transport` on every shell.
    fn pane(transport: u64) -> String {
        format!("0190f5a2-7c1e-7a3b-8d4e-5f6a7b8c000{transport}")
    }

    /// Typed keys for `terminal_id` through the pane of connection `transport`.
    fn write(terminal_id: &str, transport: u64) -> Request {
        let params = json!({
            "kind": "keys",
            "sessionId": SESSION,
            "terminalId": terminal_id,
            "outputSubscriptionId": pane(transport),
            "data": "a",
        });
        Request {
            method: "terminal.write".to_owned(),
            params: Some(RawValue::from_string(params.to_string()).expect("params are JSON")),
            attachments: Vec::new(),
        }
    }

    #[tokio::test]
    async fn a_connection_s_write_past_the_waiting_limit_on_a_shell_is_refused_and_others_answered()
    {
        // The first shell's program reads nothing, so its writes wait; the second takes at once.
        let (full, full_lease) = shell(
            "terminal-1",
            Box::new(|_bytes| futures::future::pending().boxed()),
        );
        let (free, _free_lease) = shell("terminal-2", Box::new(|_bytes| async { Ok(()) }.boxed()));
        // Two connections of the device hold the first shell, each through its own pane.
        for transport in [1, 2] {
            let caller = ShellLeaseCaller {
                connection: ShellConnection {
                    device_id: DeviceId::new("device".to_owned()).expect("a device id"),
                    transport_id: TransportId(transport),
                },
                output_subscription_id: SubscriptionId::new(&pane(transport))
                    .expect("a subscription id"),
            };
            full_lease
                .take(&caller, false)
                .await
                .expect("the device takes the shell");
        }
        let lookup: ShellInputLookup =
            Arc::new(move |_session, terminal_id| match terminal_id.as_str() {
                "terminal-1" => Ok(Arc::clone(&full)),
                "terminal-2" => Ok(Arc::clone(&free)),
                _ => Err(futures::future::ready(terminal_not_found(terminal_id).into()).boxed()),
            });
        let mut builder = MethodRegistryBuilder::new();
        register_terminal_write(&mut builder, lookup).expect("terminal.write registers");
        let registry = builder.freeze();

        let mut waiting: Vec<_> = (0..TERMINAL_WRITES_WAITING_LIMIT)
            .map(|_| registry.dispatch(write("terminal-1", 1), context(1)))
            .collect();
        let refused = registry
            .dispatch(write("terminal-1", 1), context(1))
            .now_or_never()
            .expect("the refusal is answered in the write's step")
            .err()
            .expect("the write past the limit is refused");
        let response =
            map_json_rpc_error(CallFailure::Dispatch(refused), JsonRpcId::Number(1.into()));
        let response: serde_json::Value =
            serde_json::from_slice(&response.to_vec().expect("an error response writes"))
                .expect("an error response is JSON");
        assert_eq!(response["error"]["code"], -31_000);
        assert_eq!(
            response["error"]["data"]["type"],
            "terminal.write.limitReached"
        );
        assert_eq!(response["error"]["data"]["category"], "resourceExhausted");
        assert_eq!(
            response["error"]["data"]["fields"],
            json!({ "terminalId": "terminal-1", "limit": TERMINAL_WRITES_WAITING_LIMIT })
        );

        registry
            .dispatch(write("terminal-2", 1), context(1))
            .await
            .expect("the same connection's write to another shell is answered");
        assert!(
            registry
                .dispatch(write("terminal-1", 2), context(2))
                .now_or_never()
                .is_none(),
            "another connection's write to the same shell is admitted and waits"
        );

        // A waiting write that ends frees its place.
        drop(waiting.pop());
        assert!(
            registry
                .dispatch(write("terminal-1", 1), context(1))
                .now_or_never()
                .is_none(),
            "a write admitted in the freed place waits on the shell"
        );
    }
}
