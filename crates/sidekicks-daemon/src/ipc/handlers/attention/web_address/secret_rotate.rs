//! `attention.webAddress.secret.rotate`: mints a new signing secret for the saved address and
//! shows it once.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::attention::AttentionWebAddressSecretRotate;
use sidekicks_contracts::method_descriptor::EmptyPayload;
use sidekicks_ipc::registry::{HandlerContext, MethodRegistryBuilder, RegistrationError};
use sidekicks_session::attention::delivery::web_address::sender::WebAddressSender;

/// Registers `attention.webAddress.secret.rotate`, refusing with no address saved.
pub(super) fn register_web_address_secret_rotate(
    builder: &mut MethodRegistryBuilder,
    sender: Arc<WebAddressSender>,
) -> Result<(), RegistrationError> {
    builder.register::<AttentionWebAddressSecretRotate, _>(
        move |_request: EmptyPayload, _context: HandlerContext| {
            let sender = Arc::clone(&sender);
            async move { Ok(sender.rotate_signing_secret().await?) }.boxed()
        },
    )
}
