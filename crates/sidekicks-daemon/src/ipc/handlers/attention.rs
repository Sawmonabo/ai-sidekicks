//! The attention methods: `attention.subscribe`, the projection of what needs the person, live;
//! `attention.banner.settle`, what this machine's main did with a banner; and
//! `attention.seen.update`, a session or workflow run marked seen.

mod banner_settle;
mod seen_update;
mod subscribe;

use std::sync::Arc;

use sidekicks_ipc::registry::{MethodRegistryBuilder, RegistrationError};
use sidekicks_session::attention::service::AttentionService;

use crate::ipc::handlers::attention::banner_settle::register_banner_settle;
use crate::ipc::handlers::attention::seen_update::register_seen_update;
use crate::ipc::handlers::attention::subscribe::register_attention_subscribe;

/// Registers the three attention methods over `attention`, each refusing by the codes its method
/// lists. Fails the start when a method is already registered.
pub(crate) fn register_attention_methods(
    builder: &mut MethodRegistryBuilder,
    attention: Arc<AttentionService>,
) -> Result<(), RegistrationError> {
    register_attention_subscribe(builder, Arc::clone(&attention))?;
    register_banner_settle(builder, Arc::clone(&attention))?;
    register_seen_update(builder, attention)
}
