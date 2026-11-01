//! `attention.subscribe`: the attention projection, live. The first emission is the projection as
//! the request narrows it, read before the call is answered, and each later one the whole
//! projection again once its scope's change count moves; a slow reader is sent only the newest.
//! This machine's own app following every entry holds back the windowless start while it listens.

use std::sync::Arc;

use futures::FutureExt as _;
use sidekicks_contracts::attention::{
    AttentionProjection, AttentionSubscribe, AttentionSubscribeRequest,
};
use sidekicks_contracts::jsonrpc::streaming::{SubscribeAcknowledgmentResponse, SubscriptionId};
use sidekicks_ipc::registry::{
    HandlerContext, HandlerError, MethodRegistryBuilder, RegistrationError,
};
use sidekicks_ipc::stream::feed::Feed;
use sidekicks_ipc::stream::latest_value::{LatestValueFeed, LatestValueOutlet};
use sidekicks_session::attention::service::AttentionService;

/// Registers `attention.subscribe`, refusing a named session the daemon does not hold with
/// nothing left open.
pub(super) fn register_attention_subscribe(
    builder: &mut MethodRegistryBuilder,
    attention: Arc<AttentionService>,
) -> Result<(), RegistrationError> {
    builder.register_subscription::<AttentionSubscribe, _>(
        move |request: AttentionSubscribeRequest,
              context: HandlerContext,
              subscription_id: SubscriptionId| {
            let attention = Arc::clone(&attention);
            async move {
                // This machine's app following every entry posts the banners itself.
                let is_local_app = request.session_id.is_none()
                    && attention.is_this_machine(context.device_id.as_ref());
                let feed = LatestValueFeed::open(|outlet| {
                    follow_projection(attention, request, is_local_app, outlet)
                })
                .await?;
                let feed: Box<dyn Feed<Emission = AttentionProjection>> = Box::new(feed);
                Ok((SubscribeAcknowledgmentResponse { subscription_id }, feed))
            }
            .boxed()
        },
    )
}

/// Sends the projection `request` asks for through `outlet` now, then again each time its scope's
/// count moves, until the returned detach runs; with `is_local_app`, the windowless start is held
/// back for as long as the follow lives. The first read's failure is the subscribe call's; a later
/// one ends the stream with that failure, and the read pool closing under the daemon's stop ends
/// it finished.
async fn follow_projection(
    attention: Arc<AttentionService>,
    request: AttentionSubscribeRequest,
    is_local_app: bool,
    outlet: LatestValueOutlet<AttentionProjection>,
) -> Result<impl FnOnce() + Send, HandlerError> {
    let hold = is_local_app.then(|| attention.hold_local_subscription());
    // Taken before the first read, so a raise while it reads makes one more read, never a miss.
    let mut count = attention.follow(request.session_id);
    outlet.send(attention.read(&request).await?);
    let following = tokio::spawn(async move {
        // Dropped with the task, at its end or its abort at the detach.
        let _hold = hold;
        while count.changed().await.is_ok() {
            match attention.read(&request).await {
                Ok(projection) => outlet.send(projection),
                Err(failure) if failure.is_pool_closed() => return,
                Err(failure) => {
                    outlet.fail(failure.into());
                    return;
                }
            }
        }
    });
    Ok(move || following.abort())
}

#[cfg(test)]
mod tests {
    use std::error::Error;
    use std::sync::Arc;
    use std::time::Duration;

    use futures::FutureExt as _;
    use futures::future::BoxFuture;
    use serde_json::json;
    use sidekicks_contracts::attention::AttentionSubscribe;
    use sidekicks_contracts::machine::settings::MachineSettings;
    use sidekicks_contracts::method::Method as _;
    use sidekicks_contracts::trust_statement::DeviceId;
    use sidekicks_ipc::call_fixtures::{context, request};
    use sidekicks_ipc::presence::PresenceRegister;
    use sidekicks_ipc::registry::{Dispatch as _, MethodRegistryBuilder, Reply};
    use sidekicks_platforms::WallClockTimer;
    use sidekicks_session::attention::banner_launcher::counting_starter::CountingStarter;
    use sidekicks_session::attention::banner_launcher::{BannerLauncher, WindowlessAppStarter};
    use sidekicks_session::attention::service::{AttentionService, AttentionServiceDependencies};
    use sidekicks_session::attention::test_log::AttentionTestLog;
    use sidekicks_std::scheduler::Scheduler;
    use sidekicks_store::database::schema::session_directory::insert_session_row;
    use sidekicks_workspace::machine_settings::MachineSettingsReader;
    use tokio::sync::watch;

    use super::register_attention_subscribe;

    const MACHINE_DEVICE: &str = "device-machine";
    // Long enough for an aborted follow to be dropped on a loaded machine.
    const WAIT: Duration = Duration::from_secs(10);

    /// The machine's default settings; this test decides no entry, so they are never read.
    struct DefaultSettings;

    impl MachineSettingsReader for DefaultSettings {
        fn read_machine_settings(
            &self,
        ) -> BoxFuture<'_, Result<MachineSettings, Box<dyn Error + Send + Sync>>> {
            async { Ok(MachineSettings::default()) }.boxed()
        }
    }

    fn device(id: &str) -> DeviceId {
        DeviceId::new(id.to_owned()).expect("a test device id")
    }

    // Only this machine's own subscription to every entry holds back the windowless start, and only
    // while it is attached. Killed by the device check dropped (both hold, or neither) and by the
    // hold outliving the detach (no start after it).
    #[tokio::test]
    async fn only_this_machines_whole_subscription_holds_back_the_windowless_start() {
        let log = AttentionTestLog::new().await;
        insert_session_row(
            &log.database.reader(),
            log.session_id.text().as_str(),
            None,
            None,
        );
        let run_id = log.run(None);
        log.append(log.run_state(run_id, "completed", 2, json!({})))
            .await;
        log.decide(&log.entry_of(run_id), Some("pending"), None);
        // A started app exits at once, so only a hold keeps the next start back.
        let starter = Arc::new(CountingStarter::exiting_at_once());
        let launcher = Arc::new(BannerLauncher::new(
            Arc::clone(&starter) as Arc<dyn WindowlessAppStarter>
        ));
        let attention = Arc::new(AttentionService::new(AttentionServiceDependencies {
            writer: Arc::clone(&log.writer),
            pool: Arc::clone(&log.pool),
            changes: log.changes.clone(),
            settings: Arc::new(DefaultSettings),
            presence: Arc::new(PresenceRegister::default()),
            launcher: Arc::clone(&launcher),
            machine_device_id: device(MACHINE_DEVICE),
            scheduler: Arc::new(Scheduler::start(
                Arc::new(WallClockTimer::new().expect("the wall-clock timer is made")),
                None,
                watch::channel(0).1,
            )),
        }));
        let mut builder = MethodRegistryBuilder::new();
        register_attention_subscribe(&mut builder, attention)
            .expect("the subscribe method registers");
        let registry = builder.freeze();
        let subscribe = |device_id: &str| {
            let mut call_context = context(1);
            call_context.device_id = Some(device(device_id));
            registry.dispatch(
                request(AttentionSubscribe::DESCRIPTOR.method, Some(&json!({}))),
                call_context,
            )
        };

        let Ok(Reply::Subscription { feed: phone, .. }) = subscribe("device-phone").await else {
            panic!("another device's whole subscription answers a subscription");
        };
        launcher.request_start();
        assert_eq!(
            starter.starts(),
            1,
            "another device's subscription holds nothing back"
        );
        drop(phone);
        // The first start's exit is ready, so once its task runs no start is in flight.
        tokio::task::yield_now().await;

        let Ok(Reply::Subscription { feed: local, .. }) = subscribe(MACHINE_DEVICE).await else {
            panic!("this machine's whole subscription answers a subscription");
        };
        launcher.request_start();
        assert_eq!(
            starter.starts(),
            1,
            "this machine's subscription holds the start back"
        );

        drop(local);
        // The detach aborts the follow, whose hold drops once the runtime drops the task.
        tokio::time::timeout(WAIT, async {
            while starter.starts() < 2 {
                launcher.request_start();
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the start goes ahead once this machine's subscription detaches");
    }
}
