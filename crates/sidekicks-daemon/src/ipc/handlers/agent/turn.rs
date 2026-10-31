//! The `agent.turn.*` subscriptions: the tokens a run's current turn has received and the agent's
//! task list, each over the run's latest reading. A subscriber reads the held reading at once and
//! then only the newest after each change; its stream finishes once the run ends.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::jsonrpc::streaming::{SubscribeAcknowledgmentResponse, SubscriptionId};
use sidekicks_contracts::turn::{
    AgentTurnSubscribeRequest, AgentTurnTaskSubscribe, AgentTurnUsageSubscribe, TurnTasksUpdate,
    TurnUsageUpdate,
};
use sidekicks_ipc::registry::{HandlerContext, MethodRegistryBuilder, RegistrationError};
use sidekicks_ipc::stream::feed::Feed;
use sidekicks_ipc::stream::latest_value::LatestValueFeed;
use sidekicks_session::readings::turn::TurnReadings;

/// Registers `agent.turn.usage.subscribe` and `agent.turn.task.subscribe` over `readings`; a
/// session this daemon holds no row for is refused `session.notFound` and a run it holds none for
/// in that session `agent.run.notFound`, each leaving nothing open. Fails the start when one is
/// already registered.
pub(crate) fn register_turn_methods(
    registry: &mut MethodRegistryBuilder,
    readings: &Arc<TurnReadings>,
) -> Result<(), RegistrationError> {
    let usage_readings = Arc::clone(readings);
    registry.register_subscription::<AgentTurnUsageSubscribe, _>(
        move |request: AgentTurnSubscribeRequest,
              _context: HandlerContext,
              subscription_id: SubscriptionId| {
            let readings = Arc::clone(&usage_readings);
            async move {
                let feed = LatestValueFeed::open(|outlet| async move {
                    Ok(readings
                        .follow_usage(request.session_id, request.run_id, outlet)
                        .await?)
                })
                .await?;
                let feed: Box<dyn Feed<Emission = TurnUsageUpdate>> = Box::new(feed);
                Ok((SubscribeAcknowledgmentResponse { subscription_id }, feed))
            }
            .boxed()
        },
    )?;
    let task_readings = Arc::clone(readings);
    registry.register_subscription::<AgentTurnTaskSubscribe, _>(
        move |request: AgentTurnSubscribeRequest,
              _context: HandlerContext,
              subscription_id: SubscriptionId| {
            let readings = Arc::clone(&task_readings);
            async move {
                let feed = LatestValueFeed::open(|outlet| async move {
                    Ok(readings
                        .follow_tasks(request.session_id, request.run_id, outlet)
                        .await?)
                })
                .await?;
                let feed: Box<dyn Feed<Emission = TurnTasksUpdate>> = Box::new(feed);
                Ok((SubscribeAcknowledgmentResponse { subscription_id }, feed))
            }
            .boxed()
        },
    )
}
