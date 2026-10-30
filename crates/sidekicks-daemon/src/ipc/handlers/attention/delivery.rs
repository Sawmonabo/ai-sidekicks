//! The delivery channels' methods: `attention.delivery.list`, what each channel holds and last
//! did.

mod list;

use std::sync::Arc;

use sidekicks_ipc::registry::{MethodRegistryBuilder, RegistrationError};
use sidekicks_session::attention::delivery::web_address::sender::WebAddressSender;

use crate::ipc::handlers::attention::delivery::list::register_delivery_list;

/// Registers the delivery channels' methods, which read the delivery secrets' keychain through
/// `web_address`. Fails the start when a method is already registered.
pub(super) fn register_delivery_methods(
    builder: &mut MethodRegistryBuilder,
    web_address: Arc<WebAddressSender>,
) -> Result<(), RegistrationError> {
    register_delivery_list(builder, web_address)
}
