//! `attention.delivery.list`: what each delivery channel holds and last did.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::attention::AttentionDeliveryList;
use sidekicks_contracts::method_descriptor::EmptyPayload;
use sidekicks_ipc::registry::{HandlerContext, MethodRegistryBuilder, RegistrationError};
use sidekicks_session::attention::delivery::web_address::sender::WebAddressSender;

/// Registers `attention.delivery.list`, read from the keychain's accounts and the outcome rows.
pub(super) fn register_delivery_list(
    builder: &mut MethodRegistryBuilder,
    sender: Arc<WebAddressSender>,
) -> Result<(), RegistrationError> {
    builder.register::<AttentionDeliveryList, _>(
        move |_request: EmptyPayload, _context: HandlerContext| {
            let sender = Arc::clone(&sender);
            async move { Ok(sender.list_deliveries().await?) }.boxed()
        },
    )
}
