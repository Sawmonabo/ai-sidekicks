//! The `agent.toolCall.status.subscribe` subscription: the status line under each of a session's
//! running tool calls, one value per call. A subscriber reads each held line at once and then each
//! call's newest, at most one a second per call, and a `null` once the call closed; its stream
//! finishes once the session closes.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::jsonrpc::streaming::{SubscribeAcknowledgmentResponse, SubscriptionId};
use sidekicks_contracts::tool_call_status::{
    AgentToolCallStatusSubscribe, AgentToolCallStatusSubscribeRequest, ToolCallStatusUpdate,
};
use sidekicks_ipc::registry::{HandlerContext, MethodRegistryBuilder, RegistrationError};
use sidekicks_ipc::stream::feed::Feed;
use sidekicks_ipc::stream::latest_value::KeyedLatestValueFeed;
use sidekicks_session::readings::tool_call_status::ToolCallStatuses;

/// Registers `agent.toolCall.status.subscribe` over `statuses`; a session this daemon holds no row
/// for is refused `session.notFound`, leaving nothing open. Fails the start when it is already
/// registered.
pub(crate) fn register_tool_call_status_subscribe(
    registry: &mut MethodRegistryBuilder,
    statuses: &Arc<ToolCallStatuses>,
) -> Result<(), RegistrationError> {
    let statuses = Arc::clone(statuses);
    registry.register_subscription::<AgentToolCallStatusSubscribe, _>(
        move |request: AgentToolCallStatusSubscribeRequest,
              _context: HandlerContext,
              subscription_id: SubscriptionId| {
            let statuses = Arc::clone(&statuses);
            async move {
                let feed = KeyedLatestValueFeed::open(|outlet| async move {
                    Ok(statuses.follow(request.session_id, outlet).await?)
                })
                .await?;
                let feed: Box<dyn Feed<Emission = ToolCallStatusUpdate>> = Box::new(feed);
                Ok((SubscribeAcknowledgmentResponse { subscription_id }, feed))
            }
            .boxed()
        },
    )
}
