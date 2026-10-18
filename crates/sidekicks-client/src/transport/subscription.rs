//! One subscription's stream: the values its lane carried, held in order until the consumer takes
//! each, whose taking returns that message's credit to the daemon, so a stream nobody reads stops
//! the daemon on its lane and drops nothing; then how it ended.

use std::collections::VecDeque;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::task::{Context, Poll, Waker};

use bytes::Bytes;
use futures::Stream;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::value::RawValue;
use sidekicks_contracts::jsonrpc::framing::frame::LaneId;
use sidekicks_contracts::jsonrpc::streaming::{
    SubscriptionCancel, SubscriptionCancelRequest, SubscriptionEndParams, SubscriptionId,
    SubscriptionNotifyParams,
};
use sidekicks_contracts::wire::attachment::{AttachmentError, parse};

use super::json_rpc::calls::ClientShared;
use super::json_rpc::{JsonRpcClient, RawReply};
use super::link::LinkShared;
use crate::error::{ClientError, LinkFault, ReplyError};

/// One `$/subscription/notify` waiting for its consumer, with the credit its taking returns.
pub(crate) struct QueuedValue {
    /// The lane it arrived on.
    pub(crate) lane: LaneId,
    /// The credit owed back once the consumer takes it.
    pub(crate) credit_due: u32,
    /// The notification's params: the subscription's id and the value.
    pub(crate) params: Option<Box<RawValue>>,
    /// The message's attachments.
    pub(crate) attachments: Vec<Bytes>,
}

/// How a stream stands: still open, ended with what is left to yield, or wholly yielded.
enum Ending {
    Open,
    /// Ended by the daemon, the link or a cancel; the error, if any, is yielded once after the
    /// values left.
    Ended(Option<ClientError>),
    Finished,
}

/// What the link that carries a subscription and its consumer share.
pub(crate) struct SubscriptionShared {
    /// The method that opened it, named in a value's contract failure.
    method: &'static str,
    state: Mutex<StreamState>,
}

/// A stream's values and ending, under one lock.
struct StreamState {
    values: VecDeque<QueuedValue>,
    ending: Ending,
    waker: Option<Waker>,
}

impl SubscriptionShared {
    /// An open stream for a subscription `method` opened.
    pub(crate) fn new(method: &'static str) -> Arc<Self> {
        Arc::new(Self {
            method,
            state: Mutex::new(StreamState {
                values: VecDeque::new(),
                ending: Ending::Open,
                waker: None,
            }),
        })
    }

    /// The method that opened the subscription.
    pub(crate) fn method(&self) -> &'static str {
        self.method
    }

    /// Queues `value` for the consumer; answers it back once the stream has ended, so its credit
    /// can be returned.
    pub(crate) fn push(&self, value: QueuedValue) -> Result<(), QueuedValue> {
        let mut state = self.lock();
        match state.ending {
            Ending::Open => {
                state.values.push_back(value);
                wake(&mut state);
                Ok(())
            }
            Ending::Ended(_) | Ending::Finished => Err(value),
        }
    }

    /// Ends the stream after the values it holds, with `error` when it ended for one; an ended
    /// stream keeps its first ending.
    pub(crate) fn finish(&self, error: Option<ClientError>) {
        let mut state = self.lock();
        if matches!(state.ending, Ending::Open) {
            state.ending = Ending::Ended(error);
            wake(&mut state);
        }
    }

    /// Ends the stream at once, answering whether it was open and the values it still held.
    fn close(&self) -> (bool, VecDeque<QueuedValue>) {
        let mut state = self.lock();
        let was_open = matches!(state.ending, Ending::Open);
        state.ending = Ending::Finished;
        let values = std::mem::take(&mut state.values);
        wake(&mut state);
        (was_open, values)
    }

    fn lock(&self) -> MutexGuard<'_, StreamState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Wakes the consumer waiting on the stream.
fn wake(state: &mut StreamState) {
    if let Some(waker) = state.waker.take() {
        waker.wake();
    }
}

/// One live subscription as its consumer holds it; dropping it while the stream is open stops
/// the routing and sends its `$/subscription/cancel`.
pub(crate) struct SubscriptionHandle {
    subscription_id: SubscriptionId,
    shared: Arc<SubscriptionShared>,
    link: Arc<LinkShared>,
    client: Weak<ClientShared>,
}

impl SubscriptionHandle {
    /// The handle of `subscription_id` on `link`.
    pub(crate) fn new(
        subscription_id: SubscriptionId,
        shared: Arc<SubscriptionShared>,
        link: Arc<LinkShared>,
        client: Weak<ClientShared>,
    ) -> Self {
        Self {
            subscription_id,
            shared,
            link,
            client,
        }
    }

    /// Ends the stream and stops routing its lane, returning its unread values' credit; answers
    /// whether it was still open.
    fn stop(&self) -> bool {
        let (was_open, unread) = self.shared.close();
        self.link.release_subscription(self.subscription_id, unread);
        was_open
    }

    /// Ends an open stream and sends its cancel, whose answer nobody waits for; a failure is
    /// logged.
    fn withdraw(&self) {
        if self.stop()
            && self.link.fault().is_none()
            && let Some(client) = self.client.upgrade()
        {
            client.cancel_subscription_detached(&self.link, self.subscription_id);
        }
    }
}

impl Drop for SubscriptionHandle {
    fn drop(&mut self) {
        self.withdraw();
    }
}

/// A subscribe call's answer before its consumer picks how values are read.
pub(crate) struct OpenedSubscription {
    /// The acknowledgment as the daemon sent it.
    pub(crate) acknowledgment: RawReply,
    /// The subscription it opened.
    pub(crate) handle: SubscriptionHandle,
}

impl OpenedSubscription {
    /// The acknowledgment, and the stream whose values `read` reads.
    pub(crate) fn into_stream<T>(
        self,
        read: fn(QueuedValue) -> Result<T, ReplyError>,
    ) -> (RawReply, Subscription<T>) {
        (
            self.acknowledgment,
            Subscription {
                handle: self.handle,
                read,
            },
        )
    }
}

/// One subscription's values in order, then its end: `None` once the daemon completed it or it
/// was canceled, `Some(Err(…))` then `None` when the daemon refused it (`ClientError::Remote`), the
/// link went down (`ClientError::link_down`), or a value failed its contract (`ClientError::Reply`,
/// after which the client cancels it).
pub struct Subscription<T> {
    handle: SubscriptionHandle,
    read: fn(QueuedValue) -> Result<T, ReplyError>,
}

impl<T> Subscription<T> {
    /// The daemon's id for the subscription.
    pub fn subscription_id(&self) -> SubscriptionId {
        self.handle.subscription_id
    }

    /// Ends the stream and sends `$/subscription/cancel`, which takes no call slot, answering its
    /// `canceled`; fails with the link's fault once the link is down, or as any call fails.
    pub async fn cancel(&self) -> Result<bool, ClientError> {
        self.handle.stop();
        if let Some(fault) = self.handle.link.fault() {
            return Err(ClientError::link_down(fault));
        }
        let Some(client) = self.handle.client.upgrade() else {
            return Err(ClientError::link_down(LinkFault::Closed));
        };
        let request = SubscriptionCancelRequest {
            subscription_id: self.handle.subscription_id,
        };
        let answer = JsonRpcClient::from_shared(client)
            .call_on::<SubscriptionCancel>(&request, &self.handle.link)
            .await;
        // Once the cancel is answered no message for it is still on its way.
        self.handle
            .link
            .forget_released(self.handle.subscription_id);
        Ok(answer?.canceled)
    }
}

impl<T> Stream for Subscription<T> {
    type Item = Result<T, ClientError>;

    fn poll_next(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        let value = {
            let mut guard = this.handle.shared.lock();
            let state = &mut *guard;
            match state.values.pop_front() {
                Some(value) => value,
                None => {
                    return match &mut state.ending {
                        Ending::Open => {
                            state.waker = Some(context.waker().clone());
                            Poll::Pending
                        }
                        Ending::Ended(error) => {
                            let error = error.take();
                            state.ending = Ending::Finished;
                            Poll::Ready(error.map(Err))
                        }
                        Ending::Finished => Poll::Ready(None),
                    };
                }
            }
        };
        this.handle.link.return_credit(value.lane, value.credit_due);
        match (this.read)(value) {
            Ok(value) => Poll::Ready(Some(Ok(value))),
            Err(source) => {
                this.handle.withdraw();
                Poll::Ready(Some(Err(ClientError::Reply {
                    method: this.handle.shared.method().to_owned(),
                    source,
                })))
            }
        }
    }
}

/// Reads a typed value: the notification's params with the message's attachments, then the
/// value's garde rules.
pub(crate) fn read_typed_value<T>(value: QueuedValue) -> Result<T, ReplyError>
where
    T: DeserializeOwned + garde::Validate<Context = ()>,
{
    let json = value.params.as_deref().map_or("null", RawValue::get);
    let params: SubscriptionNotifyParams<T> = parse(json.as_bytes(), value.attachments)?;
    params.value.validate()?;
    Ok(params.value)
}

/// Reads a value unread: the notification's `value` member, with the message's attachments.
pub(crate) fn read_raw_value(value: QueuedValue) -> Result<RawReply, ReplyError> {
    let json = value.params.as_deref().map_or("null", RawValue::get);
    let params: SubscriptionNotifyParams<Box<RawValue>> = serde_json::from_str(json)
        .map_err(|error| ReplyError::Read(AttachmentError::Json(error)))?;
    Ok(RawReply {
        json: params.value,
        attachments: value.attachments,
    })
}

/// The one member a subscribe acknowledgment or a lane's first message is routed by.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubscriptionProbe {
    subscription_id: SubscriptionId,
}

/// The `subscriptionId` member of `json`, its other members ignored; fails where it is absent or
/// no subscription id.
pub(crate) fn probe_subscription_id(json: &RawValue) -> serde_json::Result<SubscriptionId> {
    serde_json::from_str::<SubscriptionProbe>(json.get()).map(|probe| probe.subscription_id)
}

/// How a `$/subscription/end` whose params are `json` ends `subscription`'s stream: `None` once
/// completed, the daemon's error once refused, a contract failure when the params do not read.
pub(crate) fn read_end(subscription: &SubscriptionShared, json: &str) -> Option<ClientError> {
    match serde_json::from_str::<SubscriptionEndParams>(json) {
        Ok(SubscriptionEndParams::Completed { .. }) => None,
        Ok(SubscriptionEndParams::Refused { error, .. }) => Some(ClientError::Remote(error.into())),
        Err(error) => Some(ClientError::Reply {
            method: subscription.method().to_owned(),
            source: ReplyError::Read(AttachmentError::Json(error)),
        }),
    }
}
