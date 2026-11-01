//! `attention.banner.settle`: what this machine's main did with a pending banner, recorded once;
//! a settle from any other device is ignored and answered alike.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::attention::{AttentionBannerSettle, AttentionBannerSettleRequest};
use sidekicks_contracts::method_descriptor::EmptyPayload;
use sidekicks_ipc::registry::{HandlerContext, MethodRegistryBuilder, RegistrationError};
use sidekicks_session::attention::service::AttentionService;

/// Registers `attention.banner.settle`, which settles the banner as the calling device's.
pub(super) fn register_banner_settle(
    builder: &mut MethodRegistryBuilder,
    attention: Arc<AttentionService>,
) -> Result<(), RegistrationError> {
    builder.register::<AttentionBannerSettle, _>(
        move |request: AttentionBannerSettleRequest, context: HandlerContext| {
            let attention = Arc::clone(&attention);
            async move {
                attention
                    .settle(&request.entry_id, request.state, context.device_id.as_ref())
                    .await?;
                Ok(EmptyPayload {})
            }
            .boxed()
        },
    )
}
