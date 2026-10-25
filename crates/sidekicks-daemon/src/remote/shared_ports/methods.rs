//! The shared ports' three methods: share a port, stop sharing one, and the live list every
//! linked device reads. Every linked device may change the list, so no call checks which device
//! it came from.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::jsonrpc::streaming::{SubscribeAcknowledgmentResponse, SubscriptionId};
use sidekicks_contracts::preview::port::{
    PreviewPortRefusalDetails, PreviewPortRequest, PreviewPortShareAdd,
    PreviewPortShareAddResponse, PreviewPortShareListFrame, PreviewPortShareRemove,
    PreviewPortShareRemoveResponse, PreviewPortShareSubscribe,
};
use sidekicks_contracts::wire::True;
use sidekicks_contracts::wire::integer::Port;

use crate::database::writer::WriteError;
use crate::ipc::domain_error::DomainError;
use crate::ipc::registry::{
    HandlerContext, HandlerError, MethodRegistryBuilder, RegistrationError,
};
use crate::ipc::stream::feed::Feed;
use crate::ipc::stream::latest_value::LatestValueFeed;
use crate::remote::shared_ports::{SharedPortAddError, SharedPorts};

/// What the shared ports' methods need.
pub(crate) struct SharedPortMethodsDeps {
    /// The shared-ports list.
    pub(crate) shared_ports: Arc<SharedPorts>,
}

/// The refusal of a forward or a web address asked for `port`, which is not shared.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the port tunnel and the web address's ticket refuse an unlisted port with it"
    )
)]
pub(crate) fn port_not_shared(port: Port) -> DomainError {
    DomainError::new(
        format!("port {} is not shared", port.get()),
        RefusalCode::PreviewPortNotShared,
    )
    .with_detail(PreviewPortRefusalDetails { port })
}

/// Registers `preview.portShare.add`, `preview.portShare.remove` and
/// `preview.portShare.subscribe`. A port shared already is refused with
/// `preview.portShare.alreadyExists`; a table that cannot be written fails the call with nothing
/// changed. Fails the start when a method is already registered.
#[expect(
    dead_code,
    reason = "the daemon's start, once Preview's discovery supplies each port's listening state"
)]
pub(crate) fn register_shared_port_methods(
    registry: &mut MethodRegistryBuilder,
    deps: SharedPortMethodsDeps,
) -> Result<(), RegistrationError> {
    let adding = Arc::clone(&deps.shared_ports);
    registry.register::<PreviewPortShareAdd, _>(
        move |request: PreviewPortRequest, _context: HandlerContext| {
            let shared_ports = Arc::clone(&adding);
            async move {
                let added_at = shared_ports.add(request.port).await.map_err(add_failure)?;
                Ok(PreviewPortShareAddResponse {
                    port: request.port,
                    added_at,
                })
            }
            .boxed()
        },
    )?;

    let removing = Arc::clone(&deps.shared_ports);
    registry.register::<PreviewPortShareRemove, _>(
        move |request: PreviewPortRequest, _context: HandlerContext| {
            let shared_ports = Arc::clone(&removing);
            async move {
                shared_ports
                    .remove(request.port)
                    .await
                    .map_err(write_failure)?;
                Ok(PreviewPortShareRemoveResponse {
                    port: request.port,
                    removed: True::default(),
                })
            }
            .boxed()
        },
    )?;

    let following = deps.shared_ports;
    registry.register_subscription::<PreviewPortShareSubscribe, _>(
        move |_params, _context: HandlerContext, subscription_id: SubscriptionId| {
            let shared_ports = Arc::clone(&following);
            async move {
                // The registry writes the acknowledgment before the feed's first read, so the
                // first list never reaches a client ahead of its subscription's id.
                let feed =
                    LatestValueFeed::open(|outlet| async move { Ok(shared_ports.follow(outlet)) })
                        .await?;
                let feed: Box<dyn Feed<Emission = PreviewPortShareListFrame>> = Box::new(feed);
                Ok((SubscribeAcknowledgmentResponse { subscription_id }, feed))
            }
            .boxed()
        },
    )
}

fn add_failure(error: SharedPortAddError) -> HandlerError {
    match error {
        SharedPortAddError::AlreadyShared { port } => DomainError::new(
            format!("port {} is already shared", port.get()),
            RefusalCode::PreviewPortShareAlreadyExists,
        )
        .with_detail(PreviewPortRefusalDetails { port })
        .into(),
        SharedPortAddError::Write(error) => write_failure(error),
    }
}

// A table the daemon cannot write is a fault in the daemon.
fn write_failure(error: WriteError) -> HandlerError {
    HandlerError::Internal(Box::new(error))
}
