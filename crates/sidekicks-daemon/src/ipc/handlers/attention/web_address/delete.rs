//! `attention.webAddress.delete`: removes the saved address, its signing secret, its last outcome
//! and every message still to send.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::attention::AttentionWebAddressDelete;
use sidekicks_contracts::method_descriptor::EmptyPayload;
use sidekicks_ipc::registry::{HandlerContext, MethodRegistryBuilder, RegistrationError};
use sidekicks_session::attention::delivery::web_address::sender::WebAddressSender;

/// Registers `attention.webAddress.delete`, which waits for the attempt in flight to end.
pub(super) fn register_web_address_delete(
    builder: &mut MethodRegistryBuilder,
    sender: Arc<WebAddressSender>,
) -> Result<(), RegistrationError> {
    builder.register::<AttentionWebAddressDelete, _>(
        move |_request: EmptyPayload, _context: HandlerContext| {
            let sender = Arc::clone(&sender);
            async move {
                sender.remove_address().await?;
                Ok(EmptyPayload {})
            }
            .boxed()
        },
    )
}
