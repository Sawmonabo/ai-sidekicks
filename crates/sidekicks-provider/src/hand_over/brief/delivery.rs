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

/// A send or lookup failure, kept whole for the settlement.
pub(crate) type BriefSendError = Arc<dyn Error + Send + Sync>;

/// What one send of a brief turn did.
#[derive(Debug)]
pub(crate) enum BriefSendOutcome {
    /// The provider took the turn.
    Sent,
    /// Nothing reached the provider.
    NotSent(BriefSendError),
    /// The turn may have reached the provider: a timeout, a dropped connection or a restart came
    /// between the send and its answer.
    Uncertain(BriefSendError),
}

/// The target as this coordinator sees it: the send, and the lookup that settles an uncertain one.
pub(crate) trait BriefTargetGateway: Send + Sync {
    /// Sends `turn` under its message id.
    fn send_brief_turn(&self, turn: BriefTurn) -> BoxFuture<'_, BriefSendOutcome>;

    /// Whether the provider's own record of the conversation holds `turn`'s message id, resolving
    /// only once nothing can still take the send. An error is a record that cannot be read.
    fn find_brief(&self, turn: &BriefTurn) -> BoxFuture<'_, Result<bool, BriefSendError>>;
}

/// Whether the brief landed. A failed brief fails the switch.
#[derive(Clone, Debug)]
pub(crate) enum BriefDeliveryDisposition {
    /// The provider took the brief.
    Delivered,
    /// Nothing reached the provider, or its record of the conversation could not be read.
    Failed {
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

/// The one brief into a target, shared, so it runs to its end once however many callers await it.
/// An uncertain send is looked up by its id and sent again under the same id only once the record
/// proves it absent, so the provider never holds the brief twice.
fn send_once(gateway: Arc<dyn BriefTargetGateway>, turn: BriefTurn) -> SharedDelivery {
    async move {
        let disposition = loop {
            match gateway.send_brief_turn(turn.clone()).await {
                BriefSendOutcome::Sent => break BriefDeliveryDisposition::Delivered,
                BriefSendOutcome::NotSent(cause) => {
                    break BriefDeliveryDisposition::Failed { cause };
                }
                BriefSendOutcome::Uncertain(_) => match gateway.find_brief(&turn).await {
                    Ok(true) => break BriefDeliveryDisposition::Delivered,
                    Ok(false) => {}
                    Err(cause) => break BriefDeliveryDisposition::Failed { cause },
                },
            }
        };
        Arc::new(disposition)
    }
    .boxed()
    .shared()
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::io;
    use std::sync::{Arc, Mutex};

    use futures::FutureExt as _;
    use futures::future::BoxFuture;
    use sidekicks_contracts::run::queue::QueueItemId;
    use sidekicks_std::mutex_lock::lock;

    use super::{
        BriefDeliveryCoordinator, BriefDeliveryDisposition, BriefSendError, BriefSendOutcome,
        BriefTargetGateway, BriefTurn,
    };
    use crate::driver::test_registry::{new_message_id, new_run_id};

    /// What the scripted gateway was asked, in order, with the message id each call carried.
    #[derive(Debug, PartialEq, Eq)]
    enum GatewayCall {
        Sending(QueueItemId),
        Lookup(QueueItemId),
    }

    /// One scripted answer to a send or a lookup.
    enum Scripted {
        Sent,
        NotSent,
        Uncertain,
        Found,
        Absent,
        Unreadable,
    }

    /// A target answering each call with the next scripted answer, recording every call.
    struct ScriptedGateway {
        script: Mutex<VecDeque<Scripted>>,
        calls: Mutex<Vec<GatewayCall>>,
    }

    impl ScriptedGateway {
        fn new(script: impl IntoIterator<Item = Scripted>) -> Arc<Self> {
            Arc::new(Self {
                script: Mutex::new(script.into_iter().collect()),
                calls: Mutex::new(Vec::new()),
            })
        }

        fn next(&self, call: GatewayCall) -> Scripted {
            lock(&self.calls).push(call);
            lock(&self.script)
                .pop_front()
                .expect("a scripted answer for every call")
        }
    }

    fn cause(message: &str) -> BriefSendError {
        Arc::new(io::Error::other(message.to_owned()))
    }

    impl BriefTargetGateway for ScriptedGateway {
        fn send_brief_turn(&self, turn: BriefTurn) -> BoxFuture<'_, BriefSendOutcome> {
            let outcome = match self.next(GatewayCall::Sending(turn.message_id)) {
                Scripted::Sent => BriefSendOutcome::Sent,
                Scripted::NotSent => BriefSendOutcome::NotSent(cause("nothing reached it")),
                Scripted::Uncertain => BriefSendOutcome::Uncertain(cause("the connection dropped")),
                Scripted::Found | Scripted::Absent | Scripted::Unreadable => {
                    panic!("a lookup's answer scripted for a send")
                }
            };
            async move { outcome }.boxed()
        }

        fn find_brief(&self, turn: &BriefTurn) -> BoxFuture<'_, Result<bool, BriefSendError>> {
            let found = match self.next(GatewayCall::Lookup(turn.message_id)) {
                Scripted::Found => Ok(true),
                Scripted::Absent => Ok(false),
                Scripted::Unreadable => Err(cause("the record cannot be read")),
                Scripted::Sent | Scripted::NotSent | Scripted::Uncertain => {
                    panic!("a send's answer scripted for a lookup")
                }
            };
            async move { found }.boxed()
        }
    }

    /// Delivers one brief through a gateway answering `script`, and answers the settlement with the
    /// calls it made and the id the brief went under.
    async fn settle(
        script: impl IntoIterator<Item = Scripted>,
    ) -> (BriefDeliveryDisposition, Vec<GatewayCall>, QueueItemId) {
        let gateway = ScriptedGateway::new(script);
        let coordinator =
            BriefDeliveryCoordinator::new(Arc::clone(&gateway) as Arc<dyn BriefTargetGateway>);
        let target = coordinator.establish_target("provider-session");
        let message_id = new_message_id();
        let disposition = coordinator
            .deliver(&target, new_run_id(), message_id, "brief".to_owned())
            .await
            .expect("the coordinator established the target");
        let calls = std::mem::take(&mut *lock(&gateway.calls));
        ((*disposition).clone(), calls, message_id)
    }

    #[tokio::test]
    async fn a_target_gets_one_brief_settled_by_its_id() {
        use GatewayCall::{Lookup, Sending};

        let (found, calls, id) = settle([Scripted::Uncertain, Scripted::Found]).await;
        assert!(matches!(found, BriefDeliveryDisposition::Delivered));
        assert_eq!(calls, [Sending(id), Lookup(id)]);

        let (resent, calls, id) =
            settle([Scripted::Uncertain, Scripted::Absent, Scripted::Sent]).await;
        assert!(matches!(resent, BriefDeliveryDisposition::Delivered));
        assert_eq!(calls, [Sending(id), Lookup(id), Sending(id)]);

        let (unreadable, calls, id) = settle([Scripted::Uncertain, Scripted::Unreadable]).await;
        assert!(matches!(
            unreadable,
            BriefDeliveryDisposition::Failed { .. }
        ));
        assert_eq!(calls, [Sending(id), Lookup(id)]);

        let (not_sent, calls, id) = settle([Scripted::NotSent]).await;
        assert!(matches!(not_sent, BriefDeliveryDisposition::Failed { .. }));
        assert_eq!(calls, [Sending(id)]);

        // Overlapping and later deliveries into one target share its one send.
        let gateway = ScriptedGateway::new([Scripted::Uncertain, Scripted::Found]);
        let coordinator =
            BriefDeliveryCoordinator::new(Arc::clone(&gateway) as Arc<dyn BriefTargetGateway>);
        let target = coordinator.establish_target("provider-session");
        let (run_id, message_id) = (new_run_id(), new_message_id());
        let brief = || "brief".to_owned();
        let (first, second) = futures::join!(
            coordinator.deliver(&target, run_id, message_id, brief()),
            coordinator.deliver(&target, run_id, message_id, brief()),
        );
        let later = coordinator
            .deliver(&target, run_id, message_id, brief())
            .await
            .expect("the coordinator established the target");
        let first = first.expect("the coordinator established the target");
        assert!(Arc::ptr_eq(
            &first,
            &second.expect("the coordinator established the target")
        ));
        assert!(Arc::ptr_eq(&first, &later));
        assert!(matches!(*first, BriefDeliveryDisposition::Delivered));

        // A target another coordinator established is refused before anything is sent.
        let other =
            BriefDeliveryCoordinator::new(Arc::clone(&gateway) as Arc<dyn BriefTargetGateway>);
        let foreign = other.establish_target("provider-session");
        assert!(
            coordinator
                .deliver(&foreign, run_id, message_id, brief())
                .await
                .is_err()
        );
        assert_eq!(
            *lock(&gateway.calls),
            [Sending(message_id), Lookup(message_id)]
        );
    }
}
