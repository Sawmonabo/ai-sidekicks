//! The hand-over brief's one send into each target: a coordinator keeps a target to one brief and
//! settles what happened, held in memory only, since nothing records a send.
#![expect(dead_code, reason = "the provider switch's hand-over brief")]

use std::collections::HashMap;
use std::error::Error;
use std::sync::{Arc, Mutex};

use futures::FutureExt as _;
use futures::future::{BoxFuture, Shared};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_std::mutex_lock::lock;

use crate::outbound_text::{OutboundText, OutboundTextOrigin};

/// A target a coordinator established, named by its provider session id alone: a resume handle may
/// rotate for one session, which would make one switch look like two. Only the coordinator that
/// made it may deliver to it, compared by identity, since that coordinator's record of the one
/// send is the only duplicate guard.
#[derive(Clone, Debug)]
pub(crate) struct EstablishedBriefTarget(Arc<str>);

impl EstablishedBriefTarget {
    /// The target's provider session id.
    pub(crate) fn provider_session_id(&self) -> &str {
        &self.0
    }
}

/// A delivery addressed to a target this coordinator did not establish, refused before anything
/// is sent.
#[derive(Debug, thiserror::Error)]
#[error(
    "refusing to deliver a brief into provider session `{provider_session_id}`: this coordinator \
     did not establish that target, so it holds no record of what may already have been sent"
)]
pub(crate) struct UnownedBriefTargetError {
    /// The target's provider session id.
    pub(crate) provider_session_id: String,
}

/// The brief turn handed to the gateway: the daemon's own narration, which the driver sends marked
/// as such and encodes its own way, under the daemon's own message id so the provider's record of
/// the conversation can be searched for it.
#[derive(Clone, Debug)]
pub(crate) struct BriefTurn {
    /// The target's provider session id.
    pub(crate) target_provider_session_id: String,
    /// The run the brief is sent into.
    pub(crate) run_id: RunId,
    /// The id the brief is sent under.
    pub(crate) message_id: QueueItemId,
    /// The brief's text.
    pub(crate) brief: OutboundText,
}

/// A send failure, kept whole for the settlement.
pub(crate) type BriefSendError = Arc<dyn Error + Send + Sync>;

/// The target as this coordinator sees it: the one send.
pub(crate) trait BriefTargetGateway: Send + Sync {
    /// Delivers `turn`. An error is uncertain: the turn may have been applied.
    fn send_brief_turn(&self, turn: BriefTurn) -> BoxFuture<'_, Result<(), BriefSendError>>;
}

/// Whether the target acknowledged the brief. An unconfirmed send may or may not have landed, so
/// the switch fails and nothing is sent into that target again.
#[derive(Clone, Debug)]
pub(crate) enum BriefDeliveryDisposition {
    /// The target acknowledged it.
    Delivered,
    /// The send failed.
    Unconfirmed {
        /// Why.
        cause: BriefSendError,
    },
}

/// The one delivery into a target, settled or in flight; every caller awaits the same one.
type SharedDelivery = Shared<BoxFuture<'static, Arc<BriefDeliveryDisposition>>>;

/// Each established target and its one delivery, by provider session id.
#[derive(Default)]
struct DeliveryRecords {
    /// The handle each target was established with.
    targets: HashMap<String, EstablishedBriefTarget>,
    /// The delivery into each target.
    deliveries: HashMap<String, SharedDelivery>,
}

/// Sends at most one brief into each target it established and settles it: every later delivery
/// into that target, overlapping or not, gets the first one's settlement and sends nothing. The
/// record is per coordinator and released with the target.
pub(crate) struct BriefDeliveryCoordinator {
    /// Where the brief is sent.
    gateway: Arc<dyn BriefTargetGateway>,
    /// Never held across an await.
    records: Mutex<DeliveryRecords>,
}

impl BriefDeliveryCoordinator {
    /// A coordinator sending through `gateway`.
    pub(crate) fn new(gateway: Arc<dyn BriefTargetGateway>) -> Self {
        Self {
            gateway,
            records: Mutex::new(DeliveryRecords::default()),
        }
    }

    /// The handle a delivery into provider session `provider_session_id` is addressed to, the same
    /// one on every call for that session. The caller asserts the session is fresh, which this
    /// coordinator cannot check.
    pub(crate) fn establish_target(&self, provider_session_id: &str) -> EstablishedBriefTarget {
        let mut records = lock(&self.records);
        records
            .targets
            .entry(provider_session_id.to_owned())
            .or_insert_with(|| EstablishedBriefTarget(Arc::from(provider_session_id)))
            .clone()
    }

    /// Forgets a target whose provider session ended: its handle stops delivering and its record is
    /// dropped. A delivery in flight still settles for its callers.
    pub(crate) fn release_target(&self, provider_session_id: &str) {
        let mut records = lock(&self.records);
        records.targets.remove(provider_session_id);
        records.deliveries.remove(provider_session_id);
    }

    /// Delivers the composed `brief` into `target`'s run `run_id` under `message_id`, at most once
    /// per target, and settles what happened. An error, before anything is sent, when `target` is
    /// not a handle this coordinator holds.
    pub(crate) async fn deliver(
        &self,
        target: &EstablishedBriefTarget,
        run_id: RunId,
        message_id: QueueItemId,
        brief: String,
    ) -> Result<Arc<BriefDeliveryDisposition>, UnownedBriefTargetError> {
        let provider_session_id = target.provider_session_id();
        let delivery = {
            let mut records = lock(&self.records);
            let is_owned = records
                .targets
                .get(provider_session_id)
                .is_some_and(|established| Arc::ptr_eq(&established.0, &target.0));
            if !is_owned {
                return Err(UnownedBriefTargetError {
                    provider_session_id: provider_session_id.to_owned(),
                });
            }
            // Recorded before the send runs, so an overlapping delivery joins this one.
            records
                .deliveries
                .entry(provider_session_id.to_owned())
                .or_insert_with(|| {
                    send_once(
                        Arc::clone(&self.gateway),
                        BriefTurn {
                            target_provider_session_id: provider_session_id.to_owned(),
                            run_id,
                            message_id,
                            brief: OutboundText {
                                text: brief,
                                origin: OutboundTextOrigin::SystemNarration,
                            },
                        },
                    )
                })
                .clone()
        };
        Ok(delivery.await)
    }
}

/// The one send into a target, shared, so it runs to its end once however many callers await it.
fn send_once(gateway: Arc<dyn BriefTargetGateway>, turn: BriefTurn) -> SharedDelivery {
    async move {
        Arc::new(match gateway.send_brief_turn(turn).await {
            Ok(()) => BriefDeliveryDisposition::Delivered,
            Err(cause) => BriefDeliveryDisposition::Unconfirmed { cause },
        })
    }
    .boxed()
    .shared()
}

#[cfg(test)]
mod tests {
    use std::io;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use futures::FutureExt as _;
    use futures::future::BoxFuture;
    use sidekicks_contracts::run::queue::QueueItemId;
    use sidekicks_contracts::wire::id::mint_uuid_v7;

    use super::{
        BriefDeliveryCoordinator, BriefDeliveryDisposition, BriefSendError, BriefTargetGateway,
        BriefTurn,
    };
    use crate::driver::test_registry::new_run_id;

    /// A target whose every send fails after counting it.
    struct FailingGateway {
        sends: AtomicUsize,
    }

    impl BriefTargetGateway for FailingGateway {
        fn send_brief_turn(&self, _turn: BriefTurn) -> BoxFuture<'_, Result<(), BriefSendError>> {
            self.sends.fetch_add(1, Ordering::SeqCst);
            async { Err(Arc::new(io::Error::other("the target closed")) as BriefSendError) }.boxed()
        }
    }

    fn new_message_id() -> QueueItemId {
        QueueItemId::try_from(mint_uuid_v7()).expect("a minted UUID is a queue item id")
    }

    #[tokio::test]
    async fn a_target_gets_one_brief_however_many_deliveries_reach_it() {
        let gateway = Arc::new(FailingGateway {
            sends: AtomicUsize::new(0),
        });
        let coordinator =
            BriefDeliveryCoordinator::new(Arc::clone(&gateway) as Arc<dyn BriefTargetGateway>);
        let target = coordinator.establish_target("provider-session");
        let (run_id, message_id) = (new_run_id(), new_message_id());
        let brief = || "brief".to_owned();

        let (first, second) = futures::join!(
            coordinator.deliver(&target, run_id.clone(), message_id.clone(), brief()),
            coordinator.deliver(&target, run_id.clone(), message_id.clone(), brief()),
        );
        let later = coordinator
            .deliver(&target, run_id.clone(), message_id.clone(), brief())
            .await
            .expect("the coordinator established the target");
        let first = first.expect("the coordinator established the target");

        assert_eq!(gateway.sends.load(Ordering::SeqCst), 1);
        assert!(Arc::ptr_eq(
            &first,
            &second.expect("the coordinator established the target")
        ));
        assert!(Arc::ptr_eq(&first, &later));
        assert!(matches!(
            *first,
            BriefDeliveryDisposition::Unconfirmed { .. }
        ));

        let other =
            BriefDeliveryCoordinator::new(Arc::clone(&gateway) as Arc<dyn BriefTargetGateway>);
        let foreign = other.establish_target("provider-session");
        assert!(
            coordinator
                .deliver(&foreign, run_id, message_id, brief())
                .await
                .is_err()
        );
        assert_eq!(gateway.sends.load(Ordering::SeqCst), 1);
    }
}
