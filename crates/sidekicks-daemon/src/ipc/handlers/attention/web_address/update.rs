//! `attention.webAddress.update`: saves the web address, showing the signing secret the first
//! save mints.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::attention::{AttentionWebAddressUpdate, AttentionWebAddressUpdateRequest};
use sidekicks_ipc::registry::{HandlerContext, MethodRegistryBuilder, RegistrationError};
use sidekicks_session::attention::delivery::web_address::sender::WebAddressSender;

/// Registers `attention.webAddress.update`, refusing text that is no web address.
pub(super) fn register_web_address_update(
    builder: &mut MethodRegistryBuilder,
    sender: Arc<WebAddressSender>,
) -> Result<(), RegistrationError> {
    builder.register::<AttentionWebAddressUpdate, _>(
        move |request: AttentionWebAddressUpdateRequest, _context: HandlerContext| {
            let sender = Arc::clone(&sender);
            async move { Ok(sender.save_address(&request.address).await?) }.boxed()
        },
    )
}
