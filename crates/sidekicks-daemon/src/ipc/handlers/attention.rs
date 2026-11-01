//! The attention methods: `attention.subscribe`, the projection of what needs the person, live;
//! `attention.banner.settle`, what this machine's main did with a banner;
//! `attention.seen.update`, a session or workflow run marked seen; `attention.delivery.list`, what
//! each delivery channel holds and last did; and the web address's methods.

mod banner_settle;
mod delivery;
mod seen_update;
mod subscribe;
mod web_address;

use std::sync::Arc;

use sidekicks_ipc::registry::{MethodRegistryBuilder, RegistrationError};
use sidekicks_session::attention::delivery::web_address::sender::WebAddressSender;
use sidekicks_session::attention::service::AttentionService;

use crate::ipc::handlers::attention::banner_settle::register_banner_settle;
use crate::ipc::handlers::attention::delivery::register_delivery_methods;
use crate::ipc::handlers::attention::seen_update::register_seen_update;
use crate::ipc::handlers::attention::subscribe::register_attention_subscribe;
use crate::ipc::handlers::attention::web_address::register_web_address_methods;

/// Registers the attention methods over `attention` and the delivery methods over `web_address`,
/// each refusing by the codes its method lists. Fails the start when a method is already
/// registered.
pub(crate) fn register_attention_methods(
    builder: &mut MethodRegistryBuilder,
    attention: Arc<AttentionService>,
    web_address: Arc<WebAddressSender>,
) -> Result<(), RegistrationError> {
    register_attention_subscribe(builder, Arc::clone(&attention))?;
    register_banner_settle(builder, Arc::clone(&attention))?;
    register_seen_update(builder, attention)?;
    register_web_address_methods(builder, &web_address)?;
    register_delivery_methods(builder, web_address)
}
