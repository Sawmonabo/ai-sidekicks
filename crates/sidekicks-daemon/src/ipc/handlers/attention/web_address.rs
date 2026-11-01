//! The web address's methods: `attention.webAddress.update`, which saves the address;
//! `attention.webAddress.secret.rotate`, which mints a new signing secret; and
//! `attention.webAddress.delete`, which removes the address. Each runs on the sender, which holds
//! the address's keychain and the lock its attempts take.

mod delete;
mod secret_rotate;
mod update;

use std::sync::Arc;

use sidekicks_ipc::registry::{MethodRegistryBuilder, RegistrationError};
use sidekicks_session::attention::delivery::web_address::sender::WebAddressSender;

use crate::ipc::handlers::attention::web_address::delete::register_web_address_delete;
use crate::ipc::handlers::attention::web_address::secret_rotate::register_web_address_secret_rotate;
use crate::ipc::handlers::attention::web_address::update::register_web_address_update;

/// Registers the three web address methods over `sender`. Fails the start when a method is already
/// registered.
pub(super) fn register_web_address_methods(
    builder: &mut MethodRegistryBuilder,
    sender: &Arc<WebAddressSender>,
) -> Result<(), RegistrationError> {
    register_web_address_update(builder, Arc::clone(sender))?;
    register_web_address_secret_rotate(builder, Arc::clone(sender))?;
    register_web_address_delete(builder, Arc::clone(sender))
}
