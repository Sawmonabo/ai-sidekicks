//! The `terminal.*` methods: a session's shell list, opening, closing and ordering its shells, one
//! shell's output stream, its size, the appearance its program is answered from, its lease and
//! the connection's flow control, and `terminal.write`, admitted in its step before any wait so a
//! connection's writes reach the shell in the order they came.

use std::sync::Arc;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::jsonrpc::streaming::{SubscribeAcknowledgmentResponse, SubscriptionId};
use sidekicks_contracts::method::Method;
use sidekicks_contracts::method_descriptor::NullPayload;
use sidekicks_contracts::terminal::control::{
    TerminalControlTake, TerminalControlTakeRequest, TerminalFlowControlUpdate,
    TerminalFlowControlUpdateRequest, TerminalFlowControlUpdateResponse,
};
use sidekicks_contracts::terminal::{
    TerminalAppearanceReport, TerminalAppearanceReportRequest, TerminalClose, TerminalCloseRequest,
    TerminalListUpdate, TerminalOpen, TerminalOpenRequest, TerminalOutputFrame,
    TerminalOutputSubscribe, TerminalOutputSubscribeRequest, TerminalReorder,
    TerminalReorderRequest, TerminalResize, TerminalResizeRequest, TerminalSubscribe,
    TerminalSubscribeRequest, TerminalWrite, TerminalWriteRequest,
};
use sidekicks_contracts::wire::True;
use sidekicks_ipc::registry::{
    HandlerContext, HandlerError, MethodRegistryBuilder, RegistrationError,
};
use sidekicks_ipc::stream::feed::Feed;
use sidekicks_ipc::stream::latest_value::LatestValueFeed;
use sidekicks_shell::control_lease::{ShellConnection, ShellLeaseCaller};
use sidekicks_shell::input_lookup::ShellInputLookup;
use sidekicks_shell::paste::ShellPastePart;
use sidekicks_shell::table::ShellTable;
use sidekicks_shell::write::{AdmittedShellWrite, ShellWriteInput};

#[cfg(test)]
mod tests;

/// A write's step before any wait: admitted on its shell, or refused once its refusal is read.
enum WriteStep {
    Admitted(AdmittedShellWrite),
    Refused(BoxFuture<'static, HandlerError>),
}

/// Registers every `terminal.*` method but `terminal.write` over `shells`. A request naming a
/// shell refuses a session this daemon does not hold `session.notFound` and a missing shell in a
/// held one `terminal.notFound`, but `terminal.flowControl.update`, which accepts a missing shell
/// with nothing changed. Fails the start when a method is already registered.
pub(crate) fn register_terminal_methods(
    registry: &mut MethodRegistryBuilder,
    shells: Arc<ShellTable>,
) -> Result<(), RegistrationError> {
    let list_shells = Arc::clone(&shells);
    registry.register_subscription::<TerminalSubscribe, _>(
        move |request: TerminalSubscribeRequest,
              _context: HandlerContext,
              subscription_id: SubscriptionId| {
            let shells = Arc::clone(&list_shells);
            async move {
                // The registry writes the acknowledgment before the feed's first read, so the
                // first list never reaches a client ahead of its subscription's id.
                let feed =
                    LatestValueFeed::open(|outlet| shells.follow_list(request.session_id, outlet))
                        .await?;
                let feed: Box<dyn Feed<Emission = TerminalListUpdate>> = Box::new(feed);
                Ok((SubscribeAcknowledgmentResponse { subscription_id }, feed))
            }
            .boxed()
        },
    )?;
    let open_shells = Arc::clone(&shells);
    registry.register::<TerminalOpen, _>(
        move |request: TerminalOpenRequest, _context: HandlerContext| {
            let shells = Arc::clone(&open_shells);
            async move { shells.open(request).await }.boxed()
        },
    )?;
    let close_shells = Arc::clone(&shells);
    registry.register::<TerminalClose, _>(
        move |request: TerminalCloseRequest, context: HandlerContext| {
            let shells = Arc::clone(&close_shells);
            async move {
                let device_id = context.calling_device(TerminalClose::DESCRIPTOR.method)?;
                shells.close(&request, &device_id).await?;
                Ok(NullPayload)
            }
            .boxed()
        },
    )?;
    let reorder_shells = Arc::clone(&shells);
    registry.register::<TerminalReorder, _>(
        move |request: TerminalReorderRequest, _context: HandlerContext| {
            let shells = Arc::clone(&reorder_shells);
            async move {
                shells.reorder(&request).await?;
                Ok(NullPayload)
            }
            .boxed()
        },
    )?;
    let output_shells = Arc::clone(&shells);
    registry.register_subscription::<TerminalOutputSubscribe, _>(
        move |request: TerminalOutputSubscribeRequest,
              context: HandlerContext,
              subscription_id: SubscriptionId| {
            let shells = Arc::clone(&output_shells);
            async move {
                let stream = shells
                    .subscribe_output(&request, subscription_id, context.transport_id)
                    .await?;
                let feed: Box<dyn Feed<Emission = TerminalOutputFrame>> = Box::new(stream);
                Ok((SubscribeAcknowledgmentResponse { subscription_id }, feed))
            }
            .boxed()
        },
    )?;
    let resize_shells = Arc::clone(&shells);
    registry.register::<TerminalResize, _>(
        move |request: TerminalResizeRequest, context: HandlerContext| {
            let shells = Arc::clone(&resize_shells);
            async move {
                let connection = calling_connection::<TerminalResize>(&context)?;
                shells.resize(&request, &connection).await?;
                Ok(NullPayload)
            }
            .boxed()
        },
    )?;
    let appearance_shells = Arc::clone(&shells);
    registry.register::<TerminalAppearanceReport, _>(
        move |request: TerminalAppearanceReportRequest, context: HandlerContext| {
            let shells = Arc::clone(&appearance_shells);
            async move {
                let connection = calling_connection::<TerminalAppearanceReport>(&context)?;
                shells
                    .report_terminal_appearance(request, &connection)
                    .await?;
                Ok(NullPayload)
            }
            .boxed()
        },
    )?;
    let take_shells = Arc::clone(&shells);
    registry.register::<TerminalControlTake, _>(
        move |request: TerminalControlTakeRequest, context: HandlerContext| {
            let shells = Arc::clone(&take_shells);
            async move {
                let caller = ShellLeaseCaller {
                    connection: calling_connection::<TerminalControlTake>(&context)?,
                    output_subscription_id: request.output_subscription_id,
                };
                let lease = shells
                    .lease_for_output_subscription(
                        &request.session_id,
                        &request.terminal_id,
                        &caller,
                    )
                    .await?;
                Ok(lease.take(&caller, request.force == Some(true)).await?)
            }
            .boxed()
        },
    )?;
    registry.register::<TerminalFlowControlUpdate, _>(
        move |request: TerminalFlowControlUpdateRequest, context: HandlerContext| {
            let shells = Arc::clone(&shells);
            async move {
                shells
                    .declare_flow_control(&request, context.transport_id)
                    .await?;
                Ok(TerminalFlowControlUpdateResponse {
                    accepted: True::default(),
                })
            }
            .boxed()
        },
    )
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

/// The connection a call of `M` came on, with its calling device; a connection carrying no device
/// is a fault in the daemon.
fn calling_connection<M: Method>(
    context: &HandlerContext,
) -> Result<ShellConnection, HandlerError> {
    Ok(ShellConnection {
        device_id: context.calling_device(M::DESCRIPTOR.method)?,
        transport_id: context.transport_id,
    })
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
        connection: calling_connection::<TerminalWrite>(context)?,
        output_subscription_id,
    };
    match lookup(session_id, terminal_id) {
        Ok(shell) => Ok(WriteStep::Admitted(shell.admit_write(caller, input)?)),
        Err(refusal) => Ok(WriteStep::Refused(refusal)),
    }
}
